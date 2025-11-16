import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Tailwind CSS를 포함시킵니다.
import App from './App'; // 우리가 작업한 메인 앱 컴포넌트

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
