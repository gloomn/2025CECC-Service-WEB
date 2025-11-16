import React, { useState, useContext, createContext, useEffect, useRef } from 'react';
import { io } from "socket.io-client";
// CodeMirror는 window.CodeMirror 객체를 통해 전역으로 접근한다고 가정합니다.

// --- [MODIFIED] API 정의 (JWT 토큰 주입) ---
const API_BASE_URL = 'http://localhost:8080/api';

// [NEW] 1. AuthContext에서 토큰을 가져오는 함수 (나중에 정의됨)
let getAuthToken = () => null;

const request = async (url, options) => {
  try {
    // [FIX] options.headers가 없을 경우를 대비해 항상 초기화
    if (!options.headers) {
      options.headers = {};
    }

    // [NEW] 2. 모든 요청에 토큰 추가
    const token = getAuthToken();
    if (token) {
      // options.headers는 이제 항상 존재함
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    // [FIX] options.headers가 보장된 이후에 Content-Type 확인
    if ((options.method === 'POST' || options.method === 'PUT') && !options.headers['Content-Type']) {
      options.headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${API_BASE_URL}${url}`, options);

    if (response.status === 401) {
      console.error("Authentication Error: Token is invalid or expired.");
    }

    const data = await response.json();
    if (!response.ok) return data;
    return data;
  } catch (err) {
    console.error(`API Error: ${options.method || 'GET'} ${url}`, err);
    return { error: 'NETWORK_ERROR', message: err.message };
  }
};

const get = (url) => request(url, {});
const post = (url, body) => request(url, { method: 'POST', body: JSON.stringify(body) });
const put = (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body) });
const del = (url) => request(url, { method: 'DELETE' });

export const mockApi = {
  // [MODIFIED] 3. login은 이제 { ... token: '...' }을 반환할 수 있음
  login: (username, password, role) => post('/login', { username, password, role }),
  logout: (username) => post('/logout', { username }),
  getProblems: () => get('/problems'),
  getProblemDetails: (problemId) => get(`/problems/${problemId}`),
  getParticipantStatus: (username) => get(`/status/${username}`),
  submitCode: (username, problemId, code) => post('/submit', { username, problemId, code }),
  getGlobalAlerts: () => get('/alerts'),
  getDashboardData: () => get('/dashboard'),
  addProblem: (problemData) => post('/problems', problemData),
  updateProblem: (problemId, problemData) => put(`/problems/${problemId}`, problemData),
  deleteProblem: (problemId) => del(`/problems/${problemId}`),
  kickParticipant: (username) => del(`/users/${username}`),
  resetContestData: () => post('/contest/reset', {}),
  getFinalRankings: () => get('/rankings'),
  // [NEW] 최종 순위표 저장 API 추가 (대회 종료 시 호출)
  saveFinalRankings: () => post('/rankings/finalize', {}),
};
// --- API 정의 끝 ---

const socket = io("http://localhost:8080");

// --- [MODIFIED] 4. Auth Context (JWT 저장) ---
const AuthContext = createContext();
const useAuth = () => useContext(AuthContext);

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRole, setLastRole] = useState(null);
  const [adminToken, setAdminToken] = useState(null);

  // [NEW] 5. mockApi가 사용할 수 있도록 getAuthToken 함수를 실제 구현으로 덮어씀
  getAuthToken = () => {
    return adminToken;
  };

  // [MODIFIED] 6. login 함수가 토큰을 저장하도록 변경
  const login = (name, role, token = null) => {
    setUser({ name, role });
    if (role === 'admin' && token) {
      setAdminToken(token);
      console.log("Admin token stored.");
    }
    setLastRole(null);
  };

  // [MODIFIED] 7. logout 함수가 토큰을 삭제하도록 변경
  const logout = (role) => {
    setLastRole(role);
    setUser(null);
    if (role === 'admin') {
      setAdminToken(null);
      console.log("Admin token cleared.");
    }
  };

  useEffect(() => {
    setLoading(false);
  }, []);

  const value = {
    user,
    isAuthenticated: !!user,
    isAdmin: user?.role === 'admin',
    isParticipant: user?.role === 'participant',
    login,
    logout,
    lastRole,
    setLastRole,
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
};

// --- [MODIFIED] ContestProvider (endContest와 resetContest 분리) ---
const ContestContext = createContext();
const useContest = () => useContext(ContestContext);
const ContestProvider = ({ children }) => {
  const [contestStatus, setContestStatus] = useState('Waiting');
  useEffect(() => {
    socket.on('contestStatusUpdate', (newStatus) => {
      console.log(`[Socket] Received status: ${newStatus}`);
      setContestStatus(newStatus)
    });
    return () => { socket.off('contestStatusUpdate'); };
  }, []);

  // [MODIFIED] 대회 종료 함수: 상태를 Finished로 변경
  const endContest = () => {
    if (contestStatus !== 'Finished') {
      // 1. 서버에 상태 변경 요청
      socket.emit('admin:setContestStatus', 'Finished');

      // 2. 최종 순위표를 확정하고 저장하는 API 호출
      mockApi.saveFinalRankings()
        .then(result => {
          if (result && !result.error) {
            console.log("[API] Final rankings saved successfully.");
          } else {
            console.error("[API] Failed to save final rankings. Ensure admin token is valid.", result);
          }
        })
        .catch(err => console.error("Failed to call saveFinalRankings API:", err));
    }
  };

  // [MODIFIED] 대회 초기화 함수: 서버 API를 호출하고, 서버가 'Waiting' 상태를 브로드캐스트
  const resetContest = async () => {
    if (window.confirm("대회를 초기화하면 참가자 기록 및 순위표가 모두 삭제됩니다. 계속하시겠습니까? (상태는 '대기 중'으로 전환됩니다)")) {
      await mockApi.resetContestData();
      // 서버에서 'Waiting' 상태를 브로드캐스트하고, forceLogout 이벤트를 전송합니다.
    }
  };

  const value = { contestStatus, setContestStatus, endContest, resetContest };
  return <ContestContext.Provider value={value}>{children}</ContestContext.Provider>;
};


// --- Common Components (Header만 변경) ---
const Header = () => {
  const { isAuthenticated, user, logout } = useAuth();

  const titleText = "{ 2025 Computer Education Coding Contest }";
  const [displayedTitle, setDisplayedTitle] = useState("");

  // [MODIFIED] 애니메이션 단계 초기값 유지
  const [phase, setPhase] = useState('typing');

  const fullLength = useRef(titleText.length);

  const handleLogout = async () => {
    if (user) {
      if (user.role === 'participant') await mockApi.logout(user.name);
      logout(user.role);
    }
  };

  // [CRITICAL FIX] 타이핑 및 삭제 애니메이션 로직
  useEffect(() => {
    // 1. [NEW/FIX] 로그인 상태가 변경될 때마다 이 로직이 실행됩니다.

    // 로그인 했을 경우: 애니메이션 중지 및 제목 전체 표시
    if (isAuthenticated) {
      setDisplayedTitle(titleText);
      setPhase('complete'); // 완료 상태로 설정
      return;
    }

    // 로그아웃 했을 경우: 애니메이션 재시작을 위해 상태 초기화
    if (!isAuthenticated && displayedTitle === titleText && phase === 'complete') {
      // 'complete' 상태에서 로그아웃된 경우, 애니메이션을 'typing'으로 재시작
      setDisplayedTitle('');
      setPhase('typing');
      return; // 즉시 재실행을 유도하여 애니메이션 시작
    }

    let timeoutId;
    let speed = 100;

    if (phase === 'typing') {
      // 1. 타이핑 단계
      if (displayedTitle.length < fullLength.current) {
        timeoutId = setTimeout(() => {
          setDisplayedTitle(titleText.substring(0, displayedTitle.length + 1));
        }, speed);
      } else {
        // 타이핑 완료 후 멈춤
        speed = 2000;
        timeoutId = setTimeout(() => setPhase('deleting'), speed);
      }
    } else if (phase === 'deleting') {
      // 2. 삭제 단계
      speed = 50;
      if (displayedTitle.length > 0) {
        timeoutId = setTimeout(() => {
          setDisplayedTitle(titleText.substring(0, displayedTitle.length - 1));
        }, speed);
      } else {
        // 삭제 완료 후 멈춤
        speed = 500;
        timeoutId = setTimeout(() => setPhase('typing'), speed);
      }
    }

    // [FIX] useEffect 의존성 배열에 isAuthenticated를 추가했습니다.
    return () => clearTimeout(timeoutId);
  }, [displayedTitle, phase, titleText, isAuthenticated]);


  return (
    <header className="bg-gradient-to-r from-gray-900 via-gray-800 to-gray-900 text-white py-2 shadow-2xl sticky top-0 z-10">
      <div className="container mx-auto flex justify-between items-center">

        <div className="flex items-center space-x-4">
          <img
            src="./dotcomlogo.png"
            alt="Dotcom Logo"
            className="h-16 w-16 transform hover:scale-105 transition duration-300"
          />
          {/* 타이틀 색상을 파란색에서 흰색(text-white)으로 변경하여 배경과 대비되도록 했습니다. */}
          <h1 className="text-2xl font-extrabold tracking-wider text-white hover:text-blue-300 transition duration-300 font-mono">
            {displayedTitle}
            {/* [MODIFIED] 로그인되지 않았고, 삭제 중이 아닐 때만 커서 표시 */}
            {(!isAuthenticated && phase !== 'deleting') && (
              <span className="border-r-2 border-white animate-pulse ml-1 inline-block h-6 align-middle"></span>
            )}
          </h1>
        </div>

        {isAuthenticated && (
          <div className="flex items-center space-x-4 group">
            <span className="text-base font-medium text-gray-200 group-hover:text-blue-400 transition duration-300">
              {user.name} ({user.role === 'admin' ? '관리자' : '참가자'})님
            </span>
            <Button onClick={handleLogout} variant="secondary">로그아웃</Button>
          </div>
        )}
      </div>
    </header>
  );
};

const Footer = () => (
  <footer className="bg-gray-800 text-gray-400 p-4 mt-8">
    <div className="container mx-auto text-center text-sm">&copy; {new Date().getFullYear()} Lee Ki Joon. All Rights Reserved.</div>
  </footer>
);
const Button = ({ children, onClick, type = 'button', variant = 'primary', className = '', disabled = false }) => {
  const baseStyle = 'px-4 py-2 rounded-md font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed';
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500',
    secondary: 'bg-gray-600 text-white hover:bg-gray-700 focus:ring-gray-500',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
    success: 'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500',
    warning: 'bg-yellow-600 text-white hover:bg-yellow-700 focus:ring-yellow-500',
  };
  return <button type={type} onClick={onClick} disabled={disabled} className={`${baseStyle} ${variants[variant]} ${className}`}>{children}</button>;
};
const AlertDisplay = ({ alerts }) => {
  const [shownAlertIds, setShownAlertIds] = useState(new Set());
  const [visibleAlert, setVisibleAlert] = useState(null);
  const timerRef = useRef(null);
  useEffect(() => {
    if (alerts.length > 0) {
      const latestAlert = alerts[alerts.length - 1];
      // [FIXED] shownAlertIds를 의존성 배열에 추가
      if (!latestAlert || shownAlertIds.has(latestAlert.id)) return;
      setShownAlertIds(prev => new Set(prev).add(latestAlert.id));
      setVisibleAlert(latestAlert);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { setVisibleAlert(null); timerRef.current = null; }, 5000);
    }
  }, [alerts, shownAlertIds]);
  return (
    <div className="absolute top-4 right-4 z-50 w-full max-w-sm">
      {visibleAlert && (
        <div key={visibleAlert.id} className="bg-yellow-400 border-l-4 border-yellow-700 text-yellow-800 p-4 rounded-lg shadow-lg animate-bounce" role="alert">
          <p className="font-bold">✨ First Blood! ✨</p>
          <p>{visibleAlert.message.replace('[FIRST BLOOD] ', '')}</p>
        </div>
      )}
    </div>
  );
};

// --- Participant Pages ---
const ParticipantLogin = ({ onLoginSuccess, onBackToSelector }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const user = await mockApi.login(username, password, 'participant');
    setLoading(false);
    if (user && !user.error) {
      login(user.name, user.role, null);
      onLoginSuccess();
    } else if (user && user.error === 'ALREADY_LOGGED_IN') {
      setError(user.message);
    } else {
      setError('로그인 실패. 이름과 공용 비밀번호를 확인하세요.');
    }
  };
  return (
    <div className="w-full max-w-sm p-8 bg-white rounded-lg shadow-md">
      <h2 className="text-2xl font-bold text-center mb-6">참가자 로그인</h2>
      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <label htmlFor="username" className="block text-sm font-medium text-gray-700">이름</label>
          <input id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" required />
        </div>
        <div className="mb-6">
          <label htmlFor="password" className="block text-sm font-medium text-gray-700">공용 비밀번호</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" required />
        </div>
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>{loading ? '로그인 중...' : '대기실 입장'}</Button>
      </form>
      <button onClick={onBackToSelector} className="text-sm text-gray-600 hover:text-blue-500 w-full text-center mt-4">역할 선택으로 돌아가기</button>
    </div>
  );
};

const Waiting = () => (
  <div className="text-center p-8 bg-white rounded-lg shadow-md">
    <h2 className="text-2xl font-bold mb-4">대회 대기 중...</h2>
    <p className="text-gray-600">관리자가 대회를 시작할 때까지 잠시 기다려주세요.</p>
    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mt-6"></div>
  </div>
);

// --- CodeMirror 초기화 유틸리티 함수 (Contest 컴포넌트 위에 배치) ---
function initializeCodeMirror(textareaElement, defaultCode, onCodeChange) {
  if (typeof window.CodeMirror === 'undefined') {
    console.error("CodeMirror is not loaded. Please include the necessary CSS and JS files.");
    return null;
  }

  const editor = window.CodeMirror.fromTextArea(textareaElement, {
    mode: "text/x-csrc",
    theme: "darcula",
    lineNumbers: true,
    tabSize: 4,
    indentUnit: 4,
    smartIndent: true,
    lineWrapping: true,
    extraKeys: {
      "Ctrl-Space": "autocomplete",
      "Ctrl-Q": (cm) => { alert("코드 포맷팅 기능은 아직 구현되지 않았습니다."); }
    },
    autoCloseBrackets: true
  });

  // CodeMirror 인스턴스에 초기 코드 설정
  editor.setValue(defaultCode);

  // 코드 변경 시 React State 업데이트를 위한 이벤트 리스너 추가
  editor.on("change", (cm) => {
    onCodeChange(cm.getValue());
  });

  // 편집기 초기화 후 refresh 호출 (필수)
  setTimeout(() => {
    editor.refresh();
    // CodeMirror 에디터가 화면 높이에 꽉 차도록 설정 (Tailwind CSS를 덮어씀)
    const container = editor.getWrapperElement().closest('.flex-grow');
    if (container) {
      editor.setSize(null, container.clientHeight);
    }
    // 창 크기 변경 시 에디터 크기 조절
    const resizeHandler = () => {
      if (container) {
        editor.setSize(null, container.clientHeight);
      }
    };
    window.addEventListener('resize', resizeHandler);
    editor.on('beforeRemove', () => {
      window.removeEventListener('resize', resizeHandler);
    });

  }, 100);

  return editor;
}
// --- CodeMirror 초기화 유틸리티 함수 끝 ---


// --- [MODIFIED] 2. Contest 컴포넌트 (CodeMirror 적용) ---
const Contest = ({ problems, initialProblemIndex, onAllProblemsDone }) => {
  const { user } = useAuth();
  const [currentProblemIndex, setCurrentProblemIndex] = useState(initialProblemIndex);
  const [code, setCode] = useState('');
  const [submissionStatus, setSubmissionStatus] = useState('');
  const [loading, setLoading] = useState(false);

  // [NEW] CodeMirror 관련 Ref
  const codeAreaRef = useRef(null); // CodeMirror가 바인딩될 textarea DOM 요소
  const editorInstanceRef = useRef(null); // CodeMirror 인스턴스 자체

  const defaultCode = `#include <stdio.h>\n\nint main() {\n    // 여기에 코드를 작성하세요\n    \n    return 0;\n}`;

  useEffect(() => {
    setCode(''); // 새 문제로 넘어갈 때 코드 초기화

    // 새 문제가 로드되거나 처음 컴포넌트가 마운트될 때 CodeMirror 초기화
    if (codeAreaRef.current) {
      // 기존 인스턴스 제거 (문제가 변경될 때 재초기화 방지)
      if (editorInstanceRef.current) {
        editorInstanceRef.current.toTextArea(); // CodeMirror 인스턴스를 textarea로 되돌림
        editorInstanceRef.current = null;
      }

      // CodeMirror 초기화 및 인스턴스 저장
      editorInstanceRef.current = initializeCodeMirror(
        codeAreaRef.current,
        defaultCode,
        setCode // CodeMirror의 change 이벤트를 React state와 연결
      );
    }

  }, [currentProblemIndex, defaultCode]); // 문제 인덱스가 바뀔 때마다 실행

  // Code State가 변경될 때마다 CodeMirror의 내용도 업데이트 (CodeMirror의 비동기적 특성상 필요)
  useEffect(() => {
    if (editorInstanceRef.current && code !== editorInstanceRef.current.getValue()) {
      // 커서 위치 변경 없이 내용만 업데이트
      editorInstanceRef.current.setValue(code);
    }
  }, [code]);


  const handleSubmit = async () => {
    if (loading) return;
    setLoading(true);
    setSubmissionStatus('채점 중...');
    const currentProblem = problems[currentProblemIndex];
    // CodeMirror는 항상 코드를 반환하므로, code state의 값을 사용합니다.
    const codeToSubmit = code.trim() === '' ? defaultCode : code;

    const result = await mockApi.submitCode(user.name, currentProblem.id, codeToSubmit);
    setSubmissionStatus(result.message);
    if (result.success) {
      setTimeout(() => {
        if (currentProblemIndex < problems.length - 1) {
          setCurrentProblemIndex(currentProblemIndex + 1);
          setSubmissionStatus('');
          setLoading(false);
        } else {
          onAllProblemsDone();
          setLoading(false);
        }
      }, 1500);
    } else {
      setLoading(false);
    }
  };

  const currentProblem = problems[currentProblemIndex];
  if (!currentProblem) return <div>문제 로딩 중...</div>;

  return (
    <div className="container mx-auto p-4 h-full">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-full">
        <div className="bg-white p-6 rounded-lg shadow-md overflow-y-auto">
          <h2 className="text-2xl font-bold mb-4">문제 {currentProblemIndex + 1} / {problems.length}: {currentProblem.title}</h2>
          <h3 className="text-lg font-semibold mt-4 mb-2">문제 설명</h3>
          <p className="text-gray-700 whitespace-pre-wrap">{currentProblem.description}</p>
          <h3 className="text-lg font-semibold mt-4 mb-2">입력</h3>
          {/* 수정된 부분: whitespace-pre-wrap 추가 */}
          <p className="text-gray-700 bg-gray-100 p-2 rounded whitespace-pre-wrap">{currentProblem.input}</p>
          <h3 className="text-lg font-semibold mt-4 mb-2">출력</h3>
          {/* 수정된 부분: whitespace-pre-wrap 추가 */}
          <p className="text-gray-700 bg-gray-100 p-2 rounded whitespace-pre-wrap">{currentProblem.output}</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow-md flex flex-col">
          <h2 className="text-xl font-bold mb-4">C 코드 에디터</h2>
          <div className="flex-grow border border-gray-300 rounded-md overflow-hidden">
            {/* [MODIFIED] CodeMirror가 바인딩될 textarea */}
            <textarea
              id={`codeArea${currentProblem.id}`}
              ref={codeAreaRef}
              defaultValue={defaultCode}
              // CodeMirror가 로드된 후에는 이 textarea는 숨겨지거나 CodeMirror DOM 구조로 대체됩니다.
              className="w-full h-full p-2 border-gray-300 rounded-md font-mono text-sm bg-gray-900 text-white resize-none"
              style={{ minHeight: '400px' }}
            ></textarea>
          </div>
          <div className="mt-4 flex justify-between items-center">
            <Button onClick={handleSubmit} disabled={loading}>{loading ? '처리 중...' : '제출하기'}</Button>
            {submissionStatus && <p className={`text-sm font-semibold ${submissionStatus.includes('정답') ? 'text-green-600' : 'text-red-600'}`}>{submissionStatus}</p>}
          </div>
        </div>
      </div>
    </div>
  );
};


const AllDone = () => (
  <div className="text-center p-8 bg-white rounded-lg shadow-md">
    <h2 className="text-2xl font-bold mb-4 text-green-600">수고하셨습니다!</h2>
    <p className="text-gray-600">모든 문제 풀이를 완료했습니다. 결과는 대회 종료 후 바로 공개됩니다.</p>
    <p className="text-red-600">화면을 그대로 유지해주세요!!.</p>
  </div>
);
const ContestEndScreen = () => {
  // [NEW] ContestStatus를 가져옵니다.
  const { contestStatus } = useContest();

  const [rankings, setRankings] = useState([]);
  const [loading, setLoading] = useState(true);

  // [CRITICAL FIX] useEffect 의존성 배열에 contestStatus를 추가
  useEffect(() => {
    const fetchRankings = async () => {
      setLoading(true);

      // 상태가 Finished일 때만 로딩을 시도합니다.
      if (contestStatus === 'Finished') {
        const data = await mockApi.getFinalRankings();
        setRankings(data);
      }

      setLoading(false);
    };

    // 대회 종료 상태 변경(소켓 이벤트 수신) 직후에 순위표를 다시 불러옵니다.
    fetchRankings();

    // 상태가 Finished로 바뀔 때마다 이펙트를 재실행합니다.
  }, [contestStatus]);

  return (
    <div className="text-center p-8 bg-white rounded-lg shadow-md w-full max-w-lg">
      <h2 className="text-2xl font-bold mb-4 text-red-600">대회가 종료되었습니다.</h2>
      <p className="text-gray-600 mb-6">참여해주셔서 감사합니다.</p>
      <h3 className="text-xl font-bold mb-4">최종 순위표</h3>
      {loading ? (<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>) : (
        <div className="overflow-x-auto border rounded-lg">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">순위</th>
                <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">이름</th>
                <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">점수</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {rankings.map((user, index) => (
                <tr key={user.name}>
                  <td className="px-4 py-2 text-sm font-medium text-center">{index + 1}</td>
                  <td className="px-4 py-2 text-sm text-center">{user.name}</td>
                  <td className="px-4 py-2 text-sm font-bold text-center">{user.score}점</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};


// --- Admin Pages ---
// [MODIFIED] AdminLogin
const AdminLogin = ({ onLoginSuccess, onBackToSelector }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    // [MODIFIED] 8. 서버가 이제 { ... token: '...' }을 반환함
    const user = await mockApi.login(username, password, 'admin');
    setLoading(false);

    if (user && user.token) {
      // [MODIFIED] 9. login 함수에 토큰을 전달
      login(user.name, user.role, user.token);
      onLoginSuccess();
    } else {
      setError('아이디 또는 비밀번호가 올바르지 않습니다.');
    }
  };

  return (
    <div className="w-full max-w-sm p-8 bg-white rounded-lg shadow-md">
      <h2 className="text-2xl font-bold text-center mb-6">관리자 로그인</h2>
      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <label htmlFor="admin-username" className="block text-sm font-medium text-gray-700">아이디</label>
          <input id="admin-username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" required />
        </div>
        <div className="mb-6">
          <label htmlFor="admin-password" className="block text-sm font-medium text-gray-700">비밀번호</label>
          <input id="admin-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" required />
        </div>
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>{loading ? '로그인 중...' : '로그인'}</Button>
      </form>
      <button onClick={onBackToSelector} className="text-sm text-gray-600 hover:text-blue-500 w-full text-center mt-4">역할 선택으로 돌아가기</button>
    </div>
  );
};

const Dashboard = () => {
  const { contestStatus, endContest, resetContest } = useContest();
  const [data, setData] = useState({ users: [], logs: [], totalProblems: 0 });
  const logContainerRef = useRef(null);
  const fetchData = async () => {
    const dashboardData = await mockApi.getDashboardData();
    // API가 401 (토큰 만료 등)을 반환하면 dashboardData에 error가 있을 것임
    if (dashboardData && !dashboardData.error) {
      setData(dashboardData);
    }
  };
  useEffect(() => {
    fetchData();
    socket.on('dashboardUpdate', fetchData);
    return () => { socket.off('dashboardUpdate'); };
  }, []);
  useEffect(() => {
    if (logContainerRef.current) { logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight; }
  }, [data.logs]);
  const handleStartContest = () => { socket.emit('admin:setContestStatus', 'InProgress'); };
  const getStatusText = () => {
    if (contestStatus === 'Waiting') return { text: '대기 중', color: 'text-yellow-600' };
    if (contestStatus === 'InProgress') return { text: '진행 중', color: 'text-green-600' };
    if (contestStatus === 'Finished') return { text: '종료됨', color: 'text-red-600' };
  };
  const status = getStatusText();
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">관리자 대시보드</h2>
      <div className="mb-6 p-4 bg-white rounded-lg shadow">
        <h3 className="font-semibold mb-2">대회 관리</h3>
        <div className="flex items-center space-x-4">
          {/* [MODIFIED] 대회 시작 버튼은 Waiting 상태일 때만 활성화 */}
          <Button variant="success" onClick={handleStartContest} disabled={contestStatus !== 'Waiting'}>대회 시작</Button>
          {/* [MODIFIED] 대회 종료 버튼은 InProgress 상태일 때만 활성화 */}
          <Button variant="danger" onClick={endContest} disabled={contestStatus !== 'InProgress'}>대회 종료</Button>

          {/* [MODIFIED] 대회 초기화 버튼은 Finished 상태일 때만 활성화 */}
          <Button variant="warning" onClick={resetContest} disabled={contestStatus !== 'Finished'}>대회 초기화</Button>

          <span className="font-bold">현재 상태: <span className={status.color}>{status.text}</span></span>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <h3 className="font-semibold mb-4">참가자 현황 (실시간)</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">이름</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">현재 문제</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">점수</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {data.users.map((user) => (
                  <tr key={user.name}>
                    <td className="px-4 py-2 text-sm">{user.name}</td>
                    <td className="px-4 py-2 text-sm">{user.currentProblem > data.totalProblems ? <span className="font-bold text-green-600">종료</span> : `${user.currentProblem}번`}</td>
                    <td className="px-4 py-2 text-sm font-bold">{user.score}점</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <h3 className="font-semibold mb-4">서버 로그 (실시간)</h3>
          <div ref={logContainerRef} className="bg-gray-900 text-gray-200 font-mono text-xs rounded p-2 h-64 overflow-y-auto">
            {data.logs.map((log, index) => <p key={index}>{log}</p>)}
          </div>
        </div>
      </div>
    </div>
  );
};

const ProblemEditor = ({ problem, onSave, onCancel }) => {
  const [formData, setFormData] = useState({
    title: '', description: '', input: '', output: ''
  });
  const [testCases, setTestCases] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const defaultState = { title: '', description: '', input: '', output: '' };
    const defaultTestCases = [{ id: `temp${Date.now()}`, input: '', output: '' }];

    if (problem) {
      setFormData(defaultState);
      setTestCases([]);
      setLoading(true);
      const fetchDetails = async () => {
        const fullData = await mockApi.getProblemDetails(problem.id);
        if (fullData && fullData.problem) {
          setFormData({
            title: fullData.problem.title,
            description: fullData.problem.description,
            input: fullData.problem.input,
            output: fullData.problem.output,
          });
          setTestCases(fullData.testCases.length > 0 ? fullData.testCases : defaultTestCases);
        } else {
          setFormData(defaultState);
          setTestCases(defaultTestCases);
        }
        setLoading(false);
      };
      fetchDetails();
    } else {
      setFormData(defaultState);
      setTestCases(defaultTestCases);
    }
  }, [problem]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleTestCaseChange = (index, field, value) => {
    const newTestCases = [...testCases];
    newTestCases[index][field] = value;
    setTestCases(newTestCases);
  };

  const addTestCase = () => {
    setTestCases([...testCases, { id: `temp${Date.now()}`, input: '', output: '' }]);
  };

  const removeTestCase = (index) => {
    if (testCases.length <= 1) return;
    const newTestCases = testCases.filter((_, i) => i !== index);
    setTestCases(newTestCases);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    const submissionData = {
      ...formData,
      testCases: testCases
    };
    if (problem) {
      await mockApi.updateProblem(problem.id, submissionData);
    } else {
      await mockApi.addProblem(submissionData);
    }
    setLoading(false);
    onSave();
  };

  if (loading && !formData.title) {
    return <div className="p-6 text-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
      <p>문제 정보 로딩 중...</p>
    </div>
  }

  return (
    <div className="p-6 bg-white rounded-lg shadow-md">
      <h3 className="text-xl font-bold mb-4">{problem ? '문제 수정' : '새 문제 추가'}</h3>
      <form onSubmit={handleSubmit}>
        {/* --- 문제 기본 정보 --- */}
        <div className="mb-4">
          <label htmlFor="title" className="block text-sm font-medium text-gray-700">제목</label>
          <input type="text" name="title" id="title" value={formData.title} onChange={handleChange} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" required />
        </div>
        <div className="mb-4">
          <label htmlFor="description" className="block text-sm font-medium text-gray-700">문제 설명 (참가자용)</label>
          <textarea name="description" id="description" rows="5" value={formData.description} onChange={handleChange} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" required />
        </div>
        <div className="mb-4">
          <label htmlFor="input" className="block text-sm font-medium text-gray-700">입력 설명 (참가자용)</label>
          <textarea name="input" id="input" rows="2" value={formData.input} onChange={handleChange} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" required />
        </div>
        <div className="mb-4">
          <label htmlFor="output" className="block text-sm font-medium text-gray-700">출력 설명 (참가자용)</label>
          <textarea name="output" id="output" rows="2" value={formData.output} onChange={handleChange} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" required />
        </div>

        <hr className="my-6" />

        {/* --- 다중 테스트 케이스 UI --- */}
        <h4 className="text-lg font-semibold mb-2">채점용 테스트 케이스</h4>
        <div className="space-y-4">
          {testCases.map((tc, index) => (
            <div key={tc.id} className="border p-4 rounded-md bg-gray-50 relative">
              <span className="font-bold text-gray-600">TC #{index + 1}</span>
              {testCases.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeTestCase(index)}
                  className="absolute top-2 right-2 text-red-500 hover:text-red-700 font-bold"
                  aria-label="Remove Test Case"
                >&times;</button>
              )}
              <div className="mt-2">
                <label htmlFor={`test_input_${index}`} className="block text-sm font-medium text-gray-700">입력 (Input) <span className="text-xs text-gray-500">(선택 사항)</span></label>
                <textarea
                  id={`test_input_${index}`}
                  rows="3"
                  value={tc.input}
                  onChange={(e) => handleTestCaseChange(index, 'input', e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm"
                // [FIX] 'required' 속성 제거
                />
              </div>
              <div className="mt-2">
                <label htmlFor={`test_output_${index}`} className="block text-sm font-medium text-gray-700">출력 (Output) <span className="text-xs text-red-600">(필수)</span></label>
                <textarea
                  id={`test_output_${index}`}
                  rows="3"
                  value={tc.output}
                  onChange={(e) => handleTestCaseChange(index, 'output', e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm"
                  required // 출력은 필수
                />
              </div>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={addTestCase}
          className="mt-4 text-sm py-1 px-3"
        >
          + 테스트 케이스 추가
        </Button>

        <div className="flex justify-end space-x-2 mt-6">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={loading}>취소</Button>
          <Button type="submit" variant="primary" disabled={loading}>
            {loading ? '저장 중...' : '저장하기'}
          </Button>
        </div>
      </form>
    </div>
  );
};

const ProblemList = () => {
  const [problems, setProblems] = useState([]);
  const [editingProblem, setEditingProblem] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchProblems = async () => {
    setLoading(true);
    const data = await mockApi.getProblems();
    if (data && !data.error) {
      setProblems(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchProblems();
    socket.on('problemListUpdate', fetchProblems);
    return () => { socket.off('problemListUpdate'); };
  }, []);

  const handleSave = () => {
    setEditingProblem(null);
    fetchProblems();
  };

  const handleDelete = async (problemId) => {
    setLoading(true);
    await mockApi.deleteProblem(problemId);
    // fetchProblems(); // Socket이 처리
  };

  if (editingProblem) {
    return (
      <div className="p-6">
        <ProblemEditor
          problem={Object.keys(editingProblem).length > 0 ? editingProblem : null}
          onSave={handleSave}
          onCancel={() => setEditingProblem(null)}
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-2xl font-bold">문제 관리</h2>
        <Button onClick={() => setEditingProblem({})}>새 문제 추가</Button>
      </div>
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">제목</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">관리</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              <tr><td colSpan="3" className="text-center p-4">로딩 중...</td></tr>
            ) : (
              problems.map((prob) => (
                <tr key={prob.id}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{prob.id}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{prob.title}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    <button onClick={() => setEditingProblem(prob)} className="text-blue-600 hover:text-blue-900">수정</button>
                    <button onClick={() => handleDelete(prob.id)} className="text-red-600 hover:text-red-900">삭제</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const UserManagement = () => {
  const [users, setUsers] = useState([]);
  const [totalProblems, setTotalProblems] = useState(0);
  const fetchUsers = async () => {
    const data = await mockApi.getDashboardData();
    if (data && !data.error) {
      setUsers(data.users);
      setTotalProblems(data.totalProblems);
    }
  };
  useEffect(() => {
    fetchUsers();
    socket.on('dashboardUpdate', fetchUsers);
    return () => { socket.off('dashboardUpdate'); };
  }, []);
  const handleKick = async (username) => {
    await mockApi.kickParticipant(username);
    // fetchProblems(); // Socket이 처리
  };
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">참가자 관리</h2>
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">이름</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">현재 문제</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">점수</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">관리</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {users.map((user) => (
              <tr key={user.name}>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{user.name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{user.currentProblem > totalProblems ? <span className="font-bold text-green-600">종료</span> : `${user.currentProblem}번`}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{user.score}</td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <Button variant="danger" className="text-xs py-1 px-2" onClick={() => handleKick(user.name)}>Kick</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// --- 6. Admin Panel Container (변경 없음) ---
const AdminApp = () => {
  const [page, setPage] = useState('dashboard');
  const renderPage = () => {
    switch (page) {
      case 'dashboard': return <Dashboard />;
      case 'problems': return <ProblemList />;
      case 'users': return <UserManagement />;
      default: return <Dashboard />;
    }
  };
  return (
    <div className="flex">
      <nav className="w-64 bg-gray-900 text-white min-h-screen p-4">
        <h2 className="text-lg font-semibold mb-6">관리자 메뉴</h2>
        <ul>
          <li className={`mb-2 p-2 rounded hover:bg-gray-700 cursor-pointer ${page === 'dashboard' ? 'bg-gray-700' : ''}`} onClick={() => setPage('dashboard')}>대시보드</li>
          <li className={`mb-2 p-2 rounded hover:bg-gray-700 cursor-pointer ${page === 'problems' ? 'bg-gray-700' : ''}`} onClick={() => setPage('problems')}>문제 관리</li>
          <li className={`mb-2 p-2 rounded hover:bg-gray-700 cursor-pointer ${page === 'users' ? 'bg-gray-700' : ''}`} onClick={() => setPage('users')}>참가자 관리</li>
        </ul>
      </nav>
      <main className="flex-1 bg-gray-100 min-h-screen">{renderPage()}</main>
    </div>
  );
};

// --- [MODIFIED] 7. Participant Panel Container ---
const ParticipantApp = ({ onBackToSelector }) => {
  const { isAuthenticated, user, logout } = useAuth();
  const { contestStatus } = useContest();
  const [page, setPage] = useState('Waiting');
  const [appData, setAppData] = useState({ problems: [], status: null, loading: true });
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    if (isAuthenticated && contestStatus === 'InProgress' && page === 'Waiting') {
      setPage('Contest');
    }
    // [MODIFIED] 대회가 Finished에서 Waiting으로 바뀌면 참가자 화면도 Waiting으로 전환됨
    if (contestStatus === 'Waiting' && isAuthenticated) {
      setPage('Waiting');
    }
    if (contestStatus === 'Finished' && isAuthenticated) {
      setPage('Finished');
    }
  }, [contestStatus, page, isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated && user) {
      setAppData({ problems: [], status: null, loading: true });
      Promise.all([
        mockApi.getProblems(),
        mockApi.getParticipantStatus(user.name)
      ]).then(([problems, status]) => {
        if (problems && !problems.error) {
          setAppData({ problems, status, loading: false });
        }
      });
    }
  }, [isAuthenticated, user]);

  useEffect(() => {
    if (isAuthenticated) {
      const newAlertHandler = (newAlert) => setAlerts((prev) => [...prev, newAlert]);
      const userKickedHandler = (kickedUsername) => {
        if (user && user.name === kickedUsername) {
          console.log('[Socket] You have been kicked.');
          logout('participant');
        }
      };

      // [MODIFIED] 대회 초기화 시 강제 로그아웃 리스너
      const forceLogoutHandler = () => {
        console.log('[Socket] Contest reset. Forcing logout.');
        // 참가자 역할로 로그아웃 (Auth Context 초기화)
        logout('participant');
      };

      socket.on('newAlert', newAlertHandler);
      socket.on('userKicked', userKickedHandler);
      socket.on('forceLogout', forceLogoutHandler); // [MODIFIED] 리스너 재추가

      return () => {
        socket.off('newAlert', newAlertHandler);
        socket.off('userKicked', userKickedHandler);
        socket.off('forceLogout', forceLogoutHandler); // [MODIFIED] 리스너 제거
      };
    }
  }, [isAuthenticated, user, logout]);

  // --- Render Logic (변경 없음) ---
  // 로그인 페이지로 돌아가야 하는 경우 (인증 정보가 사라짐)
  if (!isAuthenticated) {
    return (
      <main className="container mx-auto mt-8 p-4 flex-grow flex items-center justify-center">
        <ParticipantLogin onLoginSuccess={() => { }} onBackToSelector={onBackToSelector} />
      </main>
    );
  }

  // 대회 종료 시 순위표 표시
  if (contestStatus === 'Finished' || page === 'Finished') {
    return (
      <main className="container mx-auto mt-8 p-4 flex-grow flex items-center justify-center">
        <ContestEndScreen />
      </main>
    );
  }

  // 대회 대기 중 (초기화 후 상태 포함)
  if (contestStatus === 'Waiting') {
    return (
      <main className="container mx-auto mt-8 p-4 flex-grow flex items-center justify-center">
        <Waiting />
      </main>
    );
  }

  // 대회 진행 중
  if (contestStatus === 'InProgress') {
    if (appData.loading) {
      return (
        <main className="container mx-auto mt-8 p-4 flex-grow flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p>참가자 정보를 불러오는 중...</p>
          </div>
        </main>
      );
    }
    const { problems, status } = appData;
    if (!status) { logout('participant'); return null; }
    const initialIndex = status.currentProblem - 1;
    if (page === 'AllDone' || initialIndex >= problems.length) {
      return (
        <main className="container mx-auto mt-8 p-4 flex-grow flex items-center justify-center">
          <AllDone />
        </main>
      );
    }
    return (
      <main className="container mx-auto mt-8 p-4 flex-grow relative">
        <AlertDisplay alerts={alerts} />
        <Contest problems={problems} initialProblemIndex={initialIndex} onAllProblemsDone={() => setPage('AllDone')} />
      </main>
    );
  }
  return null;
};

// --- 8. Role Selection (변경 없음) ---
const RoleSelector = ({ onSelectRole }) => (
  <div className="w-full max-w-sm p-8 bg-white rounded-lg shadow-md">
    <h2 className="text-2xl font-bold text-center mb-6">접속 역할 선택</h2>
    <div className="flex flex-col space-y-4">
      <Button onClick={() => onSelectRole('participant')} className="w-full">참가자로 접속</Button>
      <Button onClick={() => onSelectRole('admin')} variant="secondary" className="w-full">관리자로 접속</Button>
    </div>
  </div>
);

// --- 9. Main App (변경 없음) ---
const AppBody = () => {
  const { isAuthenticated, isAdmin, isParticipant, lastRole, setLastRole } = useAuth();
  const [loginPage, setLoginPage] = useState('selector');
  useEffect(() => {
    if (!isAuthenticated && lastRole === 'admin') { setLoginPage('admin_login'); setLastRole(null); }
    else if (!isAuthenticated && lastRole === 'participant') { setLoginPage('participant_login'); setLastRole(null); }
  }, [isAuthenticated, lastRole, setLastRole]);
  const renderContent = () => {
    if (isAuthenticated) {
      if (isAdmin) return <AdminApp />;
      if (isParticipant) return <ParticipantApp onBackToSelector={() => setLoginPage('selector')} />;
    }
    return (
      <main className="container mx-auto mt-8 p-4 flex-grow flex items-center justify-center">
        {loginPage === 'selector' && <RoleSelector onSelectRole={(role) => setLoginPage(role === 'admin' ? 'admin_login' : 'participant_login')} />}
        {loginPage === 'participant_login' && <ParticipantApp onBackToSelector={() => setLoginPage('selector')} />}
        {loginPage === 'admin_login' && <AdminLogin onLoginSuccess={() => { }} onBackToSelector={() => setLoginPage('selector')} />}
      </main>
    );
  };
  return (
    <div className="flex flex-col min-h-screen bg-gray-100">
      <Header />
      {renderContent()}
      {!isAuthenticated && <Footer />}
    </div>
  );
};

// --- 10. Root Component (변경 없음) ---
export default function App() {
  return (
    <AuthProvider>
      <ContestProvider>
        <AppBody />
      </ContestProvider>
    </AuthProvider>
  );
}