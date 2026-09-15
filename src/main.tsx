import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import Logs from './Logs.tsx';
import './index.css';

const isLogs =
  window.location.pathname.replace(/\/$/, '') === '/logs' ||
  new URLSearchParams(window.location.search).get('view') === 'logs';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isLogs ? <Logs /> : <App />}
  </StrictMode>,
);
