/// <reference types="vite/client" />

function splitUrls(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

export function getRtcConfig(): RTCConfiguration {
  const iceServers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  const urls = splitUrls(import.meta.env.VITE_TURN_URLS);
  const username = import.meta.env.VITE_TURN_USERNAME?.trim();
  const credential = import.meta.env.VITE_TURN_CREDENTIAL?.trim();
  if (urls.length > 0 && username && credential) {
    iceServers.push({ urls, username, credential });
  }

  return { iceServers };
}
