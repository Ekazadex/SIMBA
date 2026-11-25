import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NODE_REGISTRY } from './simulation-engine.mjs';

const NODE_IDS = NODE_REGISTRY.map(({ id }) => id);
const ROOT = typeof import.meta?.url === 'string' && import.meta.url
  ? fileURLToPath(new URL('../../ml/', import.meta.url))
  : join(process.cwd(), 'ml');
const SCRIPT = join(ROOT, 'src', 'simba_forecast', 'predict_worker.py');
const MODEL_DIR = process.env.SIMBA_FORECAST_MODELS_DIR || join(ROOT, 'models', 'synthetic_v2');
const PYTHON = process.env.SIMBA_FORECAST_PYTHON || join(ROOT, '.venv', 'Scripts', 'python.exe');

function failure(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

function validateRequest(request) {
  if (!NODE_IDS.includes(request?.nodeId)) throw failure('unmapped_station');
  if (!Array.isArray(request.history) || request.history.length !== 96) throw failure('insufficient_history');
  if (typeof request.runId !== 'string' || !request.runId || !Number.isFinite(Date.parse(request.issuedAt))) {
    throw failure('stale_input');
  }
  const end = Date.parse(request.issuedAt);
  for (let i = 0; i < 96; i += 1) {
    const row = request.history[i];
    if (
      !row ||
      !Number.isFinite(Date.parse(row.timestampUtc)) ||
      Date.parse(row.timestampUtc) !== end - (95 - i) * 300_000 ||
      !['tmaCm', 'rainRateMmH', 'upstreamTmaCm', 'upstreamRainRateMmH'].every(
        (field) => Number.isFinite(row[field]) && row[field] >= 0
      )
    ) {
      throw failure('stale_input');
    }
  }
}

function defaultAvailable() {
  if (!existsSync(PYTHON) || !existsSync(SCRIPT) || !existsSync(MODEL_DIR)) return false;
  return NODE_IDS.every(
    (nodeId) => existsSync(join(MODEL_DIR, `${nodeId}.keras`)) && existsSync(join(MODEL_DIR, `${nodeId}.json`))
  );
}

function spawnLocalWorker() {
  return spawn(PYTHON, ['-u', SCRIPT, '--models-dir', MODEL_DIR], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// Deterministic hydrological storage-routing fallback when TensorFlow/Keras weights are absent (e.g. cloud preview).
function predictHydrologicalFallback(request) {
  const { history, nodeId, runId, issuedAt } = request;
  const last = history[history.length - 1];
  const prev6 = history[history.length - 7] || history[0];
  const prev12 = history[history.length - 13] || history[0];

  const localDeltaPerBin = (last.tmaCm - prev6.tmaCm) / 6;
  const recentRainMean =
    history.slice(-6).reduce((sum, row) => sum + row.rainRateMmH, 0) / 6;
  const upstreamDelta = last.upstreamTmaCm - prev12.upstreamTmaCm;
  const upstreamRainMean =
    history.slice(-8).reduce((sum, row) => sum + row.upstreamRainRateMmH, 0) / 8;

  const isHeadwater = nodeId === 'UP1';
  const upstreamContribution = isHeadwater ? 0 : upstreamDelta * 0.045 + upstreamRainMean * 0.14;
  const localRainContribution = recentRainMean * 0.22;

  const levelsCm = [];
  let current = last.tmaCm;
  let momentum = Math.max(-4, Math.min(8, localDeltaPerBin));

  for (let step = 1; step <= 12; step += 1) {
    const decay = Math.pow(0.91, step);
    const arrivalPulse = isHeadwater ? 0 : upstreamContribution * Math.exp(-((step - 5) ** 2) / 14);
    const localPulse = localRainContribution * Math.pow(0.88, step - 1);
    current = Math.max(0, current + momentum * decay + arrivalPulse * 0.25 + localPulse * 0.22);
    levelsCm.push(Number(current.toFixed(3)));
    momentum *= 0.92;
  }

  return {
    type: 'forecast',
    requestId: randomUUID(),
    runId,
    nodeId,
    issuedAt,
    levelsCm,
    method: 'hydrological_routing_fallback',
    modelVersion: 'synthetic_v2_js_fallback',
  };
}

/** One local JSONL worker with automatic hydrological fallback when local Keras runtime is unavailable. */
export function createForecastWorker({
  spawnWorker = spawnLocalWorker,
  available = spawnWorker === spawnLocalWorker ? defaultAvailable() : true,
  timeoutMs = 10_000,
  startupTimeoutMs = 90_000,
  maxPending = 36,
  restartDelayMs = 250,
} = {}) {
  let child = null;
  let ready = false;
  let models = [];
  let buffer = '';
  let closed = false;
  let retryAt = 0;
  let restartTimer = null;
  const pending = new Map();

  function armTimer(entry, durationMs) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      rejectEntry(entry, failure('worker_timeout'));
      if (!ready && child) failProcess(failure('worker_unavailable'), child);
    }, durationMs);
  }

  function rejectEntry(entry, error) {
    clearTimeout(entry.timer);
    pending.delete(entry.requestId);
    entry.reject(error);
  }

  function failProcess(error, current) {
    if (child !== current) return;
    child = null;
    ready = false;
    models = [];
    retryAt = Date.now() + restartDelayMs;
    for (const entry of [...pending.values()]) rejectEntry(entry, error);
    try {
      current.kill();
    } catch {
      /* already exited */
    }
  }

  function processLine(line, current) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failProcess(failure('invalid_worker_response'), current);
      return;
    }
    if (message.type === 'ready') {
      if (
        !Array.isArray(message.models) ||
        message.models.some((id) => !NODE_IDS.includes(id)) ||
        new Set(message.models).size !== message.models.length
      ) {
        failProcess(failure('invalid_worker_response'), current);
        return;
      }
      ready = true;
      models = message.models;
      for (const entry of [...pending.values()]) sendEntry(entry);
      return;
    }
    if (typeof message.requestId !== 'string' || !pending.has(message.requestId)) return;
    const entry = pending.get(message.requestId);
    if (message.runId !== entry.request.runId || message.nodeId !== entry.request.nodeId) {
      rejectEntry(entry, failure('invalid_worker_response'));
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(entry.requestId);
    if (message.error || !Array.isArray(message.levelsCm) || message.levelsCm.length !== 12) {
      entry.reject(failure(message.reason || message.error || 'worker_unavailable'));
      return;
    }
    entry.resolve(message);
  }

  function startProcess() {
    if (closed || child) return;
    const current = spawnWorker();
    child = current;
    ready = false;
    models = [];
    buffer = '';
    current.stdout.setEncoding('utf8');
    current.stdout.on('data', (chunk) => {
      if (child !== current) return;
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) processLine(line, current);
        newline = buffer.indexOf('\n');
      }
    });
    current.stderr?.on?.('data', () => {});
    current.on('error', () => failProcess(failure('worker_unavailable'), current));
    current.on('exit', () => failProcess(failure('worker_unavailable'), current));
  }

  function sendEntry(entry) {
    if (entry.sent || !ready || !child) return;
    if (!models.includes(entry.request.nodeId)) {
      rejectEntry(entry, failure('model_missing'));
      return;
    }
    entry.sent = true;
    armTimer(entry, timeoutMs);
    child.stdin.write(`${JSON.stringify({ requestId: entry.requestId, ...entry.request })}\n`);
  }

  async function predict(request) {
    if (closed) throw failure('worker_closed');
    validateRequest(request);

    if (!available) {
      return predictHydrologicalFallback(request);
    }

    if (pending.size >= maxPending) throw failure('worker_busy');
    if (!child && Date.now() < retryAt) {
      await new Promise((resolve) => {
        restartTimer = setTimeout(resolve, Math.max(0, retryAt - Date.now()));
      });
      if (closed) throw failure('worker_closed');
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const entry = { requestId, request, resolve, reject, sent: false, timer: null };
      pending.set(requestId, entry);
      armTimer(entry, ready ? timeoutMs : startupTimeoutMs);
      startProcess();
      sendEntry(entry);
    });
  }

  function close() {
    closed = true;
    clearTimeout(restartTimer);
    for (const entry of [...pending.values()]) rejectEntry(entry, failure('worker_closed'));
    if (child) {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      child = null;
    }
  }

  return {
    predict,
    close,
    get available() {
      return true;
    },
    get usingFallback() {
      return !available;
    },
  };
}
