import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import Home from './Home.tsx';
import Logs from './Logs.tsx';
import './index.css';

const params = new URLSearchParams(window.location.search);
const path = window.location.pathname.replace(/\/$/, '') || '/';
const isLogs = path === '/logs' || params.get('view') === 'logs';
const roomId = params.get('room')?.trim();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLogs ? <Logs /> : roomId ? <App /> : <Home />}
  </StrictMode>,
);
