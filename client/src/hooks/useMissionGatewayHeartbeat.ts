import { useEffect } from 'react';

const CHAT_HOST = 'mission-ai-chat-test-mckee.onrender.com';
const GATEWAY_HEALTH = 'https://mission-ai-gateway-mckee.onrender.com/health';
const HEARTBEAT_MS = 4 * 60 * 1000;

/** Keep both free Render services warm only while the Mission AI page is open. */
export default function useMissionGatewayHeartbeat(hostname = window.location.hostname) {
  useEffect(() => {
    if (hostname !== CHAT_HOST) return;
    let inFlight = false;
    const ping = () => {
      if (inFlight || !navigator.onLine) return;
      inFlight = true;
      void Promise.allSettled([
        fetch('/health', { cache: 'no-store', credentials: 'same-origin' }),
        fetch(GATEWAY_HEALTH, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }),
      ]).finally(() => {
        inFlight = false;
      });
    };
    ping();
    const timer = window.setInterval(ping, HEARTBEAT_MS);
    window.addEventListener('focus', ping);
    window.addEventListener('pageshow', ping);
    window.addEventListener('online', ping);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', ping);
      window.removeEventListener('pageshow', ping);
      window.removeEventListener('online', ping);
    };
  }, [hostname]);
}
