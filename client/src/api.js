// 서버 주소
const API_BASE_URL = 'http://localhost:8080/api';

// --- API Helper Functions ---
const request = async (url, options) => {
  try {
    const response = await fetch(`${API_BASE_URL}${url}`, options);
    const data = await response.json();

    // response.ok (200-299)가 아니면 data를 에러 객체로 반환
    if (!response.ok) {
      // 서버가 보낸 에러 메시지 (e.g., { error: 'ALREADY_LOGGED_IN', ... })
      return data;
    }
    return data;
  } catch (err) {
    console.error(`API Error: ${options.method || 'GET'} ${url}`, err);
    // 네트워크 에러 또는 JSON 파싱 에러
    return { error: 'NETWORK_ERROR', message: err.message };
  }
};

const get = (url) => request(url, {});
const post = (url, body) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const put = (url, body) => request(url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const del = (url) => request(url, { method: 'DELETE' });

// --- React 코드에서 사용할 수 있도록 mockApi 이름으로 export ---
export const mockApi = {
  // --- Auth ---
  login: (username, password, role) => {
    return post('/login', { username, password, role });
  },
  logout: (username) => {
    return post('/logout', { username });
  },

  // --- Participant ---
  getProblems: () => {
    return get('/problems');
  },
  getParticipantStatus: (username) => {
    return get(`/status/${username}`);
  },
  submitCode: (username, problemId, code) => {
    return post('/submit', { username, problemId, code });
  },
  getGlobalAlerts: () => {
    return get('/alerts');
  },

  // --- Admin ---
  getDashboardData: () => {
    return get('/dashboard');
  },
  addProblem: (problemData) => {
    return post('/problems', problemData);
  },
  updateProblem: (problemId, problemData) => {
    return put(`/problems/${problemId}`, problemData);
  },
  deleteProblem: (problemId) => {
    return del(`/problems/${problemId}`);
  },
  kickParticipant: (username) => {
    return del(`/users/${username}`);
  },
  resetContestData: () => {
    return post('/contest/reset', {});
  },
  getFinalRankings: () => {
    return get('/rankings');
  },
};