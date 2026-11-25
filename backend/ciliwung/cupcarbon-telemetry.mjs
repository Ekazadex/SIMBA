import { createSocket } from 'node:dgram';
import { NODE_REGISTRY } from './simulation-engine.mjs';

export const CUPCARBON_TELEMETRY_HOST = '127.0.0.1';
export const CUPCARBON_TELEMETRY_PORT = 5005;
export const CUPCARBON_STALE_AFTER_MS = 4000;

const VALID_STATUSES = new Set(['AMAN', 'SIAGA', 'BANJIR_JAKARTA']);
const TELEMETRY_NODES = new Map(NODE_REGISTRY.map((node) => [node.telemetryName, node]));

export function parseCupCarbonTelemetry(payload) {
  const text = Buffer.isBuffer(payload)
    ? payload.toString('utf8').trim()
    : String(payload ?? '').trim();
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length !== 3) return null;

  const [nodeName, tmaText, status] = parts;
  const node = TELEMETRY_NODES.get(nodeName);
  const tmaCm = Number(tmaText);
  if (!node || !Number.isFinite(tmaCm) || tmaCm < 0 || tmaCm > 380 || !VALID_STATUSES.has(status)) return null;

  return {
    nodeId: node.id,
    nodeName,
    tmaCm: Number(tmaCm.toFixed(2)),
    status,
  };
}

export function createCupCarbonTelemetryListener(options = {}) {
  const {
    port = CUPCARBON_TELEMETRY_PORT,
    host = CUPCARBON_TELEMETRY_HOST,
    staleAfterMs = CUPCARBON_STALE_AFTER_MS,
    onTelemetry = () => {},
    onStale = () => {},
    onError = () => {},
    socket = createSocket('udp4'),
    now = () => Date.now(),
  } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('telemetry port must be between 0 and 65535');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new RangeError('staleAfterMs must be positive');

  let lastTelemetryAt = null;
  let staleAnnounced = true;
  let staleTimer = null;
  let isListening = false;
  let closed = false;
  let resolveListening;
  let rejectListening;
  const listening = new Promise((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });

  const reportError = (error) => {
    onError(error);
    if (!isListening) rejectListening(error);
  };

  const handleMessage = (message) => {
    const parsed = parseCupCarbonTelemetry(message);
    if (!parsed) return;
    lastTelemetryAt = now();
    staleAnnounced = false;
    onTelemetry({ ...parsed, receivedAt: lastTelemetryAt });
  };

  const checkStale = () => {
    if (lastTelemetryAt === null || staleAnnounced) return;
    if (now() - lastTelemetryAt < staleAfterMs) return;
    staleAnnounced = true;
    onStale({ lastTelemetryAt });
  };

  const handleListening = () => {
    isListening = true;
    staleTimer = setInterval(checkStale, Math.max(10, Math.min(1000, staleAfterMs / 2)));
    staleTimer.unref?.();
    resolveListening(socket.address());
  };

  socket.on('message', handleMessage);
  socket.on('error', reportError);
  socket.once('listening', handleListening);
  socket.bind(port, host);

  return {
    socket,
    listening,
    get lastTelemetryAt() {
      return lastTelemetryAt;
    },
    close() {
      if (closed) return;
      closed = true;
      if (staleTimer !== null) clearInterval(staleTimer);
      socket.removeListener('message', handleMessage);
      socket.removeListener('error', reportError);
      socket.removeListener('listening', handleListening);
      try {
        socket.close();
      } catch {
        // The socket may already be closed or may have failed before binding.
      }
    },
  };
}
