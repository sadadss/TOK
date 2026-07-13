'use strict';

const DEFAULT_EVENT_ID = 'demo';

function normalizeEventId(value) {
  const normalized = String(value || DEFAULT_EVENT_ID)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || DEFAULT_EVENT_ID;
}

function parseRoleRequest(value) {
  if (typeof value === 'string') return { role: value, eventId: DEFAULT_EVENT_ID };
  return {
    role: String(value?.role || ''),
    eventId: normalizeEventId(value?.eventId),
  };
}

function configuredOrigins(value = '') {
  return String(value).split(',').map((origin) => origin.trim()).filter(Boolean);
}

function isAllowedOrigin(origin, extraOrigins = []) {
  if (!origin) return true;
  if (extraOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) return true;
    return url.protocol === 'https:' && (
      url.hostname === 'web.rla-latam.com'
      || url.hostname === 'rla-latam.com'
      || url.hostname === 'www.rla-latam.com'
      || url.hostname === 'traduccion-vivo-backend.onrender.com'
    );
  } catch (_error) {
    return false;
  }
}

function createByteRateGuard({ maxChunkBytes = 64 * 1024, maxBytesPerSecond = 256 * 1024 } = {}) {
  let windowStartedAt = 0;
  let bytesInWindow = 0;

  return function accepts(chunk, now = Date.now()) {
    const bytes = Number(chunk?.byteLength ?? chunk?.length ?? 0);
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > maxChunkBytes) return false;
    if (!windowStartedAt || now - windowStartedAt >= 1000) {
      windowStartedAt = now;
      bytesInWindow = 0;
    }
    bytesInWindow += bytes;
    return bytesInWindow <= maxBytesPerSecond;
  };
}

function claimSpeaker(activeSpeakers, eventId, socketId, isConnected = () => true) {
  const current = activeSpeakers.get(eventId);
  if (current && current !== socketId && isConnected(current)) return false;
  activeSpeakers.set(eventId, socketId);
  return true;
}

function releaseSpeaker(activeSpeakers, eventId, socketId) {
  if (activeSpeakers.get(eventId) !== socketId) return false;
  activeSpeakers.delete(eventId);
  return true;
}

function withTimeout(promise, timeoutMs, label = 'operación') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} excedió ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  DEFAULT_EVENT_ID,
  claimSpeaker,
  configuredOrigins,
  createByteRateGuard,
  isAllowedOrigin,
  normalizeEventId,
  parseRoleRequest,
  releaseSpeaker,
  withTimeout,
};
