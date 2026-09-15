import { heartbeatVisitorLog, leaveVisitorLog, upsertVisitorLog } from './visitorLogClient';

const SESSION_KEY = 'visitorSessionId';

async function postJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  });
  if (!response.ok) throw new Error(`Visitor session failed: ${response.status}`);
  return response.json() as Promise<{ id: string }>;
}

export function startVisitorSession(roomId: string) {
  let sessionId = sessionStorage.getItem(SESSION_KEY);
  let stopped = false;

  const register = async () => {
    try {
      const data = await postJson('/api/session', { roomId, sessionId });
      sessionId = data.id;
      sessionStorage.setItem(SESSION_KEY, data.id);
    } catch {
      // Static hosts like Vercel have no Express API. Firestore still records the visit.
    }
    sessionId = await upsertVisitorLog({ sessionId, roomId });
    sessionStorage.setItem(SESSION_KEY, sessionId);
  };

  register().catch((err) => console.error(err));

  const interval = window.setInterval(() => {
    if (stopped || !sessionId) return;
    postJson('/api/session/heartbeat', { id: sessionId, roomId }).catch(() => {});
    heartbeatVisitorLog(sessionId, roomId).catch(() => {});
  }, 8000);

  const leave = () => {
    if (!sessionId) return;
    const payload = JSON.stringify({ id: sessionId });
    navigator.sendBeacon?.('/api/session/leave', new Blob([payload], { type: 'application/json' }));
    void leaveVisitorLog(sessionId);
  };

  window.addEventListener('pagehide', leave);

  return () => {
    stopped = true;
    window.clearInterval(interval);
    window.removeEventListener('pagehide', leave);
  };
}
