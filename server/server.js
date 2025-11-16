const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs').promises;
const { constants } = require('fs');
const path = require('path');
const { execFile, exec } = require('child_process');
const { randomUUID } = require('crypto');
const util = require('util');

// [NEW] 1. JWT 라이브러리 임포트
const jwt = require('jsonwebtoken');

// [MODIFIED] execFilePromise 대신 execPromise 사용 (Shell 명령어 실행용)
const execFilePromise = util.promisify(execFile);
const execPromise = util.promisify(exec); // [NEW] exec Promise 버전 사용


// --- 서버 설정 ---
const app = express();
const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "https://comedu-codingcontest.netlify.app/"],
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// --- 미들웨어 ---
app.use(cors());
app.use(express.json());

// ... (채점 경로, Docker 설정) ...
const SANDBOX_DIR = path.join(__dirname, 'sandbox');
const DOCKER_IMAGE_NAME = 'c-judge-env';
const CONTAINER_APP_PATH = '/app';

// --- [MODIFIED] 관리자 설정 및 JWT 비밀 키 ---
const config = {
  adminUser: '관리자용 아이디 설정',
  adminPass: '관리자용 비밀번호 설정',
  participantPass: '참가자용 비밀번호 설정',
  // [NEW] 2. JWT 비밀 키 (실제 서비스에서는 .env 파일로 숨겨야 함)
  JWT_SECRET: process.env.JWT_SECRET || 'your-very-secret-key-for-contest-123!',
  JWT_EXPIRES_IN: '3h' // 토큰 유효 시간
};

// --- [NEW] 서버가 대회 상태를 기억하도록 변수 추가 ---
let globalContestStatus = 'Waiting';


// --- [MODIFIED] 데이터베이스 초기화 (4a) ---
async function initDatabase(db) {
  console.log('[DB] Initializing database (v4a)...');

  // [FIX] 외래 키(Foreign Key) 제약 조건 및 ON DELETE CASCADE를 활성화합니다.
  await db.exec('PRAGMA foreign_keys = ON;');

  // [FIX] logs 테이블 정의가 누락되어 추가합니다.
  await db.exec(`
  CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    input TEXT,
    output TEXT
  );

  CREATE TABLE IF NOT EXISTS test_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    problemId TEXT,
    input TEXT,
    output TEXT,
    FOREIGN KEY (problemId) REFERENCES problems(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    score INTEGER DEFAULT 0,
    currentProblem INTEGER DEFAULT 1,
    isLoggedIn INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS firstBloods (
    problemId TEXT PRIMARY KEY,
    username TEXT
  );

  CREATE TABLE IF NOT EXISTS globalAlerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT,
    type TEXT
  );

  CREATE TABLE IF NOT EXISTS finalRankings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rank INTEGER,
    name TEXT,
    score INTEGER
  );
`);

  await db.run("INSERT INTO logs (message) VALUES (?)", "[LOG] Server started and database initialized.");
  console.log('[DB] Database ready.');
}


// --- [MODIFIED] Socket.io 연결 로직 (상태 즉시 전송) ---
io.on('connection', (socket) => {
  console.log(`[Socket] User connected: ${socket.id}`);

  // [NEW] 1. 새로 접속한 클라이언트에게 현재 대회 상태를 즉시 전송
  socket.emit('contestStatusUpdate', globalContestStatus);

  // [MODIFIED] 2. 관리자가 상태를 변경하면, 서버 변수를 업데이트하고 방송
  socket.on('admin:setContestStatus', (status) => {
    console.log(`[Socket] Admin changed status to: ${status}`);

    // 유효한 상태일 때만 서버 상태 업데이트
    if (status === 'InProgress' || status === 'Waiting' || status === 'Finished') {
      globalContestStatus = status;
    }
    // 모든 클라이언트에게 변경된 상태를 방송
    io.emit('contestStatusUpdate', globalContestStatus);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] User disconnected: ${socket.id}`);
  });
});

// --- [NEW] 3. JWT 인증 미들웨어 ---
const checkAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header missing or invalid' });
    }

    const token = authHeader.split(' ')[1];
    // 토큰 검증
    const decoded = jwt.verify(token, config.JWT_SECRET);

    // 검증된 사용자 정보를 req 객체에 추가
    req.user = decoded; // (e.g., { name: 'admin', role: 'admin', iat: ..., exp: ... })
    next();
  } catch (error) {
    // 토큰 만료 또는 서명 불일치
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// [NEW] 4. 관리자 전용 미들웨어
const checkAdmin = (req, res, next) => {
  // (checkAuth가 먼저 실행되었다고 가정)
  if (req.user && req.user.role === 'admin') {
    next(); // 관리자 맞음
  } else {
    res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
};


// --- API Routes ---
async function startServer() {
  const db = await open({
    filename: './contest.db',
    driver: sqlite3.Database
  });
  await initDatabase(db);
  await fs.mkdir(SANDBOX_DIR, { recursive: true }).catch(e => console.error(`[Sandbox] Failed to create host directory: ${e.message}`));

  // --- 1. Auth ---
  // [MODIFIED] 5. 로그인 API (JWT 토큰 발급)
  app.post('/api/login', async (req, res) => {
    const { username, password, role } = req.body;
    await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] Login attempt: ${username} as ${role}`);

    if (role === 'admin' && username === config.adminUser && password === config.adminPass) {
      await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] Admin '${username}' logged in.`);

      // [NEW] 관리자용 JWT 토큰 생성
      const payload = { name: username, role: 'admin' };
      const token = jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: config.JWT_EXPIRES_IN
      });

      io.emit('dashboardUpdate');
      // [NEW] 토큰 반환
      res.json({ name: '관리자', role: 'admin', token: token });

    } else if (role === 'participant' && username && password === config.participantPass) {
      // (참가자 로그인 로직은 토큰 없이 기존대로 유지 - 참가자 API는 보호되지 않음)
      const existingUser = await db.get("SELECT * FROM users WHERE name = ?", username);
      if (!existingUser) {
        // ... (신규 참가자) ...
        await db.run("INSERT INTO users (name, score, currentProblem, isLoggedIn) VALUES (?, 0, 1, true)", username);
        await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] Participant '${username}' registered and logged in.`);
        io.emit('dashboardUpdate');
        res.json({ name: username, role: 'participant' });
      } else if (existingUser.isLoggedIn) {
        // ... (중복 로그인) ...
        await db.run("INSERT INTO logs (message) VALUES (?)", `[WARNING] Blocked concurrent login attempt for '${username}'.`);
        res.status(409).json({ error: 'ALREADY_LOGGED_IN', message: '이 사용자는 이미 다른 곳에서 접속 중입니다.' });
      } else {
        // ... (재로그인) ...
        await db.run("UPDATE users SET isLoggedIn = true WHERE name = ?", username);
        await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] Participant '${username}' re-logged in.`);
        io.emit('dashboardUpdate');
        res.json({ name: username, role: 'participant' });
      }
    } else {
      res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '로그인 실패. 이름과 비밀번호를 확인하세요.' });
    }
  });

  // (로그아웃은 클라이언트에서 토큰을 삭제하므로 서버 변경 없음)
  app.post('/api/logout', async (req, res) => {
    const { username } = req.body;
    await db.run("UPDATE users SET isLoggedIn = false WHERE name = ?", username);
    await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] Participant '${username}' logged out.`);
    io.emit('dashboardUpdate');
    res.json({ success: true });
  });

  // --- 2. Participant (보호되지 않는 API) ---
  app.get('/api/problems', async (req, res) => {
    const problems = await db.all("SELECT id, title, description, input, output FROM problems ORDER BY id");
    res.json(problems);
  });
  app.get('/api/status/:username', async (req, res) => {
    const { username } = req.params;
    const user = await db.get("SELECT * FROM users WHERE name = ?", username);
    res.json(user || null);
  });

  // [MODIFIED] 3. 코드 제출 (Docker 샌드박스 + 파일 리다이렉션 FIX)
  app.post('/api/submit', async (req, res) => {
    const { username, problemId, code } = req.body;
    console.log(`[Judge] Submission received for ${username}, problem ${problemId}`);

    // 1. 유저/문제 유효성 검사 (변경 없음)
    const user = await db.get("SELECT * FROM users WHERE name = ?", username);
    if (!user) return res.status(404).json({ success: false, message: '사용자 없음' });
    const problemNum = parseInt(problemId.replace('p', ''));
    if (isNaN(problemNum) || user.currentProblem > problemNum) {
      return res.json({ success: false, message: '이미 해결한 문제입니다.' });
    }
    if (user.currentProblem !== problemNum) {
      return res.json({ success: false, message: '순서대로 문제를 풀어야 합니다.' });
    }

    // 2. 테스트 케이스 로드 (변경 없음)
    const testCases = await db.all("SELECT * FROM test_cases WHERE problemId = ?", problemId);
    if (!testCases || testCases.length === 0) {
      return res.status(404).json({ success: false, message: '채점 기준(테스트 케이스)이 없습니다.' });
    }

    // 3. [MODIFIED] 호스트에 임시 샌드박스 디렉터리 생성
    const uniqueId = randomUUID();
    const hostTempDir = path.join(SANDBOX_DIR, uniqueId);
    await fs.mkdir(hostTempDir, { recursive: true });
    const hostSourcePath = path.join(hostTempDir, 'main.c');
    const hostExePath = path.join(hostTempDir, 'main.out');

    let isCorrect = false;
    let message = '';

    try {
      // 4. C 코드 파일 생성 (호스트에)
      await fs.writeFile(hostSourcePath, code);

      // 5. [MODIFIED] Docker로 컴파일 (execPromise 사용 및 경로에 큰따옴표 추가)
      const compileCommand = `docker run --rm -v "${hostTempDir}":${CONTAINER_APP_PATH} --workdir ${CONTAINER_APP_PATH} --network=none ${DOCKER_IMAGE_NAME} sh -c "gcc main.c -o main.out && chmod +x main.out"`;

      try {
        console.log(`[Judge] Compiling and setting permissions via Docker...`);
        await execPromise(compileCommand, { timeout: 5000 });
      } catch (compileErr) {
        console.log(`[Judge] Compile Error: ${compileErr.stderr || compileErr.message}`);
        message = '컴파일 에러';
        throw new Error('CompileError');
      }

      // 7. [MODIFIED] Docker로 모든 테스트 케이스 순회 실행 (파일 리다이렉션 사용)
      let passedCount = 0;
      for (const [index, testCase] of testCases.entries()) {

        const hasInput = testCase.input && testCase.input.length > 0;
        const inputFileName = 'input.txt';
        const hostInputPath = path.join(hostTempDir, inputFileName);

        if (hasInput) {
          // [NEW] 7.1. 입력 데이터를 input.txt 파일로 저장
          await fs.writeFile(hostInputPath, testCase.input);
        } else {
          // 입력이 없으면 파일이 없는 것을 보장
          try { await fs.unlink(hostInputPath); } catch { }
        }

        // [MODIFIED] 7.2. 실행 명령어 구성 (stdin 파이프(-i) 대신 리다이렉션 사용)
        // 실행 명령: ./main.out < input.txt  (입력이 있을 때)
        // 실행 명령: ./main.out             (입력이 없을 때)
        const runExecution = hasInput
          ? `sh -c "./main.out < ${inputFileName}"`
          : `./main.out`;

        const runCommand = `docker run --rm -v "${hostTempDir}":${CONTAINER_APP_PATH} --workdir ${CONTAINER_APP_PATH} --read-only --network=none --memory=64m ${DOCKER_IMAGE_NAME} ${runExecution}`;

        try {
          console.log(`[Judge] Running TC #${index + 1} via Docker (Method: File Redirect)...`);

          // execPromise 사용. input 옵션은 사용하지 않음 (리다이렉션 사용)
          const { stdout } = await execPromise(runCommand, {
            timeout: 2000,
            // input: undefined // Node.js input 옵션은 제거
          });

          // 8. 출력 비교
          const userOutput = stdout.trim().replace(/\r\n/g, '\n');
          const expectedOutput = testCase.output.trim().replace(/\r\n/g, '\n');

          if (userOutput === expectedOutput) {
            passedCount++;
          } else {
            console.log(`[Judge] Wrong Answer (TC #${index + 1})`);
            console.log(`       Expected: ${JSON.stringify(expectedOutput)}`);
            console.log(`       Received: ${JSON.stringify(userOutput)}`);
            message = `틀렸습니다 (TC ${index + 1}/${testCases.length} 실패)`;
            throw new Error('WrongAnswer');
          }
        } catch (runErr) {
          console.error(`[Judge] Execution Failed (TC #${index + 1}): `, runErr.stderr || runErr.message);

          if (runErr.code === 'ETIMEDOUT' || (runErr.stderr && runErr.stderr.includes('killed'))) {
            message = `런타임 에러 (시간 초과) - TC ${index + 1}`;
          } else {
            message = `런타임 에러 - TC ${index + 1}`;
          }
          throw new Error('RuntimeError');
        }
      }

      isCorrect = true;
      message = `정답입니다! (${passedCount}/${testCases.length} 통과)`;

    } catch (error) {
      if (!message) {
        console.error('[Judge] Unknown Server Error:', error);
        message = '채점 중 서버 오류가 발생했습니다.';
      }
    } finally {
      // 9. [중요] 호스트 임시 디렉터리 삭제
      await fs.rm(hostTempDir, { recursive: true, force: true }).catch(err => console.error(`[Cleanup] Failed to delete ${hostTempDir}: ${err.message}`));
    }

    // 10. 결과 처리 (변경 없음)
    if (isCorrect) {
      const points = 100;
      await db.run("UPDATE users SET score = score + ?, currentProblem = currentProblem + 1 WHERE name = ?", points, username);
      const firstBlood = await db.get("SELECT * FROM firstBloods WHERE problemId = ?", problemId);
      if (!firstBlood) {
        const fbMessage = `[FIRST BLOOD] ${user.name}님이 ${problemId} 문제를 처음으로 풀었습니다!`;
        await db.run("INSERT INTO firstBloods (problemId, username) VALUES (?, ?)", problemId, user.name);
        await db.run("INSERT INTO logs (message) VALUES (?)", fbMessage);
        const alert = { id: Date.now(), message: fbMessage, type: 'firstblood' };
        await db.run("INSERT INTO globalAlerts (message, type) VALUES (?, 'firstblood')", fbMessage);
        io.emit('newAlert', alert);
      }
      const userAfterSolve = await db.get("SELECT * FROM users WHERE name = ?", username);
      await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] ${username} solved ${problemId} (+${points} points). Total: ${userAfterSolve.score}`);

    } else {
      await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] ${username} failed ${problemId} (${message}).`);
    }

    io.emit('dashboardUpdate');
    res.json({ success: isCorrect, message });
  });

  app.get('/api/alerts', async (req, res) => {
    const alerts = await db.all("SELECT * FROM globalAlerts ORDER BY id");
    res.json(alerts);
  });
  app.get('/api/rankings', async (req, res) => {
    const rankings = await db.all("SELECT * FROM finalRankings ORDER BY rank ASC");
    res.json(rankings);
  });

  // --- 3. Admin (보호되는 API) ---
  // [NEW] 6. 미들웨어 적용: checkAuth -> checkAdmin

  // (관리자용) 대시보드 데이터
  app.get('/api/dashboard', checkAuth, checkAdmin, async (req, res) => {
    const users = await db.all("SELECT * FROM users ORDER BY score DESC, name ASC");
    const logsResult = await db.all("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 10");
    const problemCount = await db.get("SELECT COUNT(*) as totalProblems FROM problems");
    res.json({
      users: users,
      logs: logsResult.map(l => l.message).reverse(),
      totalProblems: problemCount.totalProblems,
    });
  });

  // (관리자용) 최종 순위표 계산 및 저장 API 추가
  app.post('/api/rankings/finalize', checkAuth, checkAdmin, async (req, res) => {
    try {
      // 1. 기존 랭킹 데이터 초기화
      await db.run("DELETE FROM finalRankings");

      // 2. 현재 users 테이블의 점수를 기준으로 순위 계산 후 finalRankings 테이블에 저장
      await db.run(`
            INSERT INTO finalRankings (rank, name, score) 
            SELECT ROW_NUMBER() OVER (ORDER BY score DESC, name ASC) as rank, name, score 
            FROM users
        `);

      await db.run("INSERT INTO logs (message) VALUES (?)", "[LOG] Admin finalized and saved the final rankings.");

      res.json({ success: true, message: "Final rankings saved." });
    } catch (e) {
      console.error('[API] Failed to finalize rankings:', e);
      res.status(500).json({ error: 'Failed to finalize rankings' });
    }
  });
  // -----------------------------------------------------

  // (관리자용) 문제 상세 정보 API
  app.get('/api/problems/:problemId', checkAuth, checkAdmin, async (req, res) => {
    const { problemId } = req.params;
    const problem = await db.get("SELECT * FROM problems WHERE id = ?", problemId);
    if (!problem) {
      return res.status(404).json({ error: 'Problem not found' });
    }
    const testCases = await db.all("SELECT id, input, output FROM test_cases WHERE problemId = ? ORDER BY id", problemId);
    res.json({ problem, testCases });
  });

  // (관리자용) 문제 추가
  app.post('/api/problems', checkAuth, checkAdmin, async (req, res) => {
    const { title, description, input, output, testCases } = req.body;
    const problemCount = await db.get("SELECT COUNT(*) as count FROM problems");
    const newId = `p${problemCount.count + 1}`;
    try {
      await db.run(`BEGIN TRANSACTION`);
      await db.run(
        `INSERT INTO problems (id, title, description, input, output) VALUES (?, ?, ?, ?, ?)`,
        newId, title, description, input, output
      );
      if (testCases && testCases.length > 0) {
        const stmt = await db.prepare(`INSERT INTO test_cases (problemId, input, output) VALUES (?, ?, ?)`);
        for (const tc of testCases) {
          await stmt.run(newId, tc.input || '', tc.output || ''); // input이 비어있으면 ''로 저장
        }
        await stmt.finalize();
      }
      await db.run(`COMMIT`);
      await db.run(`INSERT INTO logs (message) VALUES (?)`, `[LOG] Admin added problem ${newId}`);
      io.emit('problemListUpdate');
      res.status(201).json({ id: newId, title, description, input, output });
    } catch (e) {
      await db.run(`ROLLBACK`);
      console.error('[API] Failed to add problem:', e);
      res.status(500).json({ error: 'Failed to add problem' });
    }
  });

  // (관리자용) 문제 수정
  app.put('/api/problems/:problemId', checkAuth, checkAdmin, async (req, res) => {
    const { problemId } = req.params;
    const { title, description, input, output, testCases } = req.body;
    try {
      await db.run(`BEGIN TRANSACTION`);
      const result = await db.run(`UPDATE problems SET title = ?, description = ?, input = ?, output = ? WHERE id = ?`, title, description, input, output, problemId);
      if (result.changes === 0) throw new Error('Problem not found');
      await db.run(`DELETE FROM test_cases WHERE problemId = ?`, problemId);
      if (testCases && testCases.length > 0) {
        const stmt = await db.prepare("INSERT INTO test_cases (problemId, input, output) VALUES (?, ?, ?)");
        for (const tc of testCases) {
          await stmt.run(problemId, tc.input || '', tc.output || ''); // input이 비어있으면 ''로 저장
        }
        await stmt.finalize();
      }
      await db.run(`COMMIT`);
      await db.run(`INSERT INTO logs (message) VALUES (?)`, `[LOG] Admin updated problem ${problemId}`);
      io.emit('problemListUpdate');
      res.json({ id: problemId, title, description, input, output });
    } catch (e) {
      await db.run(`ROLLBACK`);
      console.error(`[API] Failed to update problem:`, e);
      if (e.message === 'Problem not found') res.status(404).json({ error: 'Problem not found' });
      else res.status(500).json({ error: 'Failed to update problem' });
    }
  });

  // (관리자용) 문제 삭제
  app.delete('/api/problems/:problemId', checkAuth, checkAdmin, async (req, res) => {
    const { problemId } = req.params;
    await db.run("DELETE FROM problems WHERE id = ?", problemId); // ON DELETE CASCADE로 test_cases도 자동 삭제됨
    await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] Admin deleted problem ${problemId}`);
    io.emit('problemListUpdate');
    res.json({ success: true });
  });

  // (관리자용) 유저 킥
  app.delete('/api/users/:username', checkAuth, checkAdmin, async (req, res) => {
    const { username } = req.params;
    await db.run("DELETE FROM users WHERE name = ?", username);
    await db.run("INSERT INTO logs (message) VALUES (?)", `[LOG] Admin kicked participant '${username}'.`);
    io.emit('dashboardUpdate');
    io.emit('userKicked', username);
    res.json({ success: true });
  });

  // (관리자용) 대회 리셋
  app.post('/api/contest/reset', checkAuth, checkAdmin, async (req, res) => {
    // [MODIFIED] 1. 최종 순위표 저장 로직을 제거하고, 테이블 초기화만 수행합니다.
    // 순위표 저장: /api/rankings/finalize에서 처리하도록 분리됨
    await db.run("DELETE FROM finalRankings");

    await db.run("DELETE FROM users");
    await db.run("DELETE FROM logs");
    await db.run("DELETE FROM firstBloods");
    await db.run("DELETE FROM globalAlerts");
    await db.run("INSERT INTO logs (message) VALUES (?)", "[LOG] Contest data has been reset by admin.");

    // [NEW] 4. 서버 상태 변수 업데이트
    globalContestStatus = 'Waiting';
    io.emit('contestStatusUpdate', globalContestStatus);
    io.emit('dashboardUpdate');
    // [MODIFIED] 5. 업데이트된 변수값을 방송

    // [NEW] 6. 모든 참가자 강제 로그아웃
    io.emit('forceLogout');
    res.json({ success: true });
  });

  // --- 서버 시작 ---
  server.listen(PORT, () => {
    console.log(`🚀 Contest server (v-final / JWT Auth & Docker) is running on http://localhost:${PORT}`);
    console.log(`[Sandbox] Host directory: ${SANDBOX_DIR}`);
    console.log(`[Sandbox] Docker Image: ${DOCKER_IMAGE_NAME}`);
  });
}

// --- 서버 실행 ---
startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);

});
