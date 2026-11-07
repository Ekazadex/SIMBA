import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NODE_REGISTRY } from './simulation-engine.mjs';

const NODE_IDS = NODE_REGISTRY.map(({ id }) => id);
const ROOT = fileURLToPath(new URL('../../ml/', import.meta.url));
const SCRIPT = join(ROOT, 'src', 'simba_forecast', 'predict_worker.py');
const MODEL_DIR = process.env.SIMBA_FORECAST_MODELS_DIR || join(ROOT, 'models', 'synthetic_v2');
const PYTHON = process.env.SIMBA_FORECAST_PYTHON || join(ROOT, '.venv', 'Scripts', 'python.exe');
function failure(reason) { const error = new Error(reason); error.reason = reason; return error; }

function validateRequest(request) {
  if (!NODE_IDS.includes(request?.nodeId)) throw failure('unmapped_station');
  if (!Array.isArray(request.history) || request.history.length !== 96) throw failure('insufficient_history');
  if (typeof request.runId !== 'string' || !request.runId || !Number.isFinite(Date.parse(request.issuedAt))) throw failure('stale_input');
  const end = Date.parse(request.issuedAt);
  for (let i = 0; i < 96; i += 1) {
    const row = request.history[i];
    if (!row || !Number.isFinite(Date.parse(row.timestampUtc)) ||
        Date.parse(row.timestampUtc) !== end - (95 - i) * 300_000 ||
        !['tmaCm', 'rainRateMmH', 'upstreamTmaCm', 'upstreamRainRateMmH'].every((field) => Number.isFinite(row[field]) && row[field] >= 0)) {
      throw failure('stale_input');
    }
  }
}

function defaultAvailable() {
  if (!existsSync(PYTHON) || !existsSync(SCRIPT) || !existsSync(MODEL_DIR)) return false;
  return NODE_IDS.every((nodeId) => existsSync(join(MODEL_DIR, `${nodeId}.keras`)) &&
    existsSync(join(MODEL_DIR, `${nodeId}.json`)));
}
function spawnLocalWorker() {
  return spawn(PYTHON, ['-u', SCRIPT, '--models-dir', MODEL_DIR], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

/** One local JSONL worker; injected spawnWorker is a child-process-shaped test seam. */
export function createForecastWorker({
  spawnWorker = spawnLocalWorker,
  available = spawnWorker === spawnLocalWorker ? defaultAvailable() : true,
  timeoutMs = 10_000, startupTimeoutMs = 90_000, maxPending = 36, restartDelayMs = 250,
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
    try { current.kill(); } catch { /* already exited */ }
  }
  function processLine(line, current) {
    let message;
    try { message = JSON.parse(line); } catch { failProcess(failure('invalid_worker_response'), current); return; }
    if (message.type === 'ready') {
      if (!Array.isArray(message.models) || message.models.some((id) => !NODE_IDS.includes(id)) ||
          new Set(message.models).size !== message.models.length) {
        failProcess(failure('invalid_worker_response'), current); return;
      }
      ready = true;
      models = message.models;
      for (const entry of [...pending.values()]) sendEntry(entry);
      return;
    }
    if (typeof message.requestId !== 'string' || !pending.has(message.requestId)) return;
    const entry = pending.get(message.requestId);
    if (message.runId !== entry.request.runId || message.nodeId !== entry.request.nodeId) {
      rejectEntry(entry, failure('invalid_worker_response')); return;
    }
    if (message.error) { rejectEntry(entry, failure(String(message.error))); return; }
    if (!Array.isArray(message.levelsCm) || message.levelsCm.length !== 12 ||
        message.levelsCm.some((level) => !Number.isFinite(level) || level < 0) ||
        typeof message.method !== 'string' || !message.method ||
        typeof message.modelVersion !== 'string' || !message.modelVersion) {
      rejectEntry(entry, failure('invalid_worker_response')); return;
    }
    clearTimeout(entry.timer);
    pending.delete(entry.requestId);
    entry.resolve(message);
  }
  function start() {
    if (closed || child || !available || !pending.size) return;
    if (Date.now() < retryAt) {
      if (!restartTimer) restartTimer = setTimeout(() => { restartTimer = null; start(); }, retryAt - Date.now());
      return;
    }
    let process;
    try { process = spawnWorker(); }
    catch { for (const entry of [...pending.values()]) rejectEntry(entry, failure('worker_unavailable')); return; }
    child = process;
    buffer = '';
    ready = false;
    process.stdout.on('data', (chunk) => {
      if (child !== process) return;
      buffer += chunk.toString();
      if (buffer.length > 1_000_000) { failProcess(failure('invalid_worker_response'), process); return; }
      let index;
      while ((index = buffer.indexOf('\n')) !== -1 && child === process) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) processLine(line, process);
      }
    });
    process.on('error', () => failProcess(failure('worker_unavailable'), process));
    process.on('exit', () => failProcess(failure('worker_unavailable'), process));
    process.stderr?.on('data', (chunk) => globalThis.process.stderr.write(chunk));
  }
  function sendEntry(entry) {
    if (!pending.has(entry.requestId) || entry.sent) return;
    if (!models.includes(entry.request.nodeId)) { rejectEntry(entry, failure('model_unavailable')); return; }
    entry.sent = true;
    armTimer(entry, timeoutMs);
    try {
      child.stdin.write(`${JSON.stringify({ requestId: entry.requestId, ...entry.request })}\n`);
    } catch { failProcess(failure('worker_unavailable'), child); }
  }
  function predict(request) {
    try { validateRequest(request); } catch (error) { return Promise.reject(error); }
    if (!available) return Promise.reject(failure('model_unavailable'));
    if (closed) return Promise.reject(failure('worker_unavailable'));
    if (pending.size >= maxPending) return Promise.reject(failure('worker_busy'));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const entry = { requestId, request, resolve, reject, sent: false, timer: null };
      pending.set(requestId, entry);
      armTimer(entry, ready ? timeoutMs : startupTimeoutMs);
      start();
      if (ready) sendEntry(entry);
    });
  }
  function close() {
    closed = true;
    clearTimeout(restartTimer);
    if (child) failProcess(failure('worker_unavailable'), child);
    for (const entry of [...pending.values()]) rejectEntry(entry, failure('worker_unavailable'));
  }
  return { predict, close };
}
