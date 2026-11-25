import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ML = typeof import.meta?.url === 'string' && import.meta.url
  ? fileURLToPath(new URL('../../ml/', import.meta.url))
  : join(process.cwd(), 'ml');
const PYTHON_EXE = process.env.SIMBA_FORECAST_PYTHON || join(ML, '.venv', 'Scripts', 'python.exe');
const WORKER_SCRIPT = join(ML, 'hardware_20s_worker.py');
const MODEL_FILE = join(ML, 'models', 'hardware_20s_demo', 'N1.keras');

// A new continuous sequence starts after a gap; early history repeats its first value.
export function buildDemoHistory(points) {
  if (
    !Array.isArray(points) ||
    !points.length ||
    points.length > 12 ||
    points.some((p) => !Number.isFinite(p.time) || !Number.isFinite(p.level) || p.level < 0 || p.level > 1000)
  ) {
    throw new Error('insufficient_history');
  }
  const ordered = [...points].sort((a, b) => a.time - b.time);
  if (ordered.some((p, i) => i && (p.time - ordered[i - 1].time < 15000 || p.time - ordered[i - 1].time > 25000))) {
    throw new Error('history_gap');
  }
  const levels = ordered.map((p) => p.level);
  while (levels.length < 12) levels.unshift(levels[0]);
  return levels;
}

function predictHardware20sFallback(levels) {
  const current = levels[levels.length - 1];
  const prev = levels[Math.max(0, levels.length - 4)];
  const stepSlope = Math.max(-1.2, Math.min(2.2, (current - prev) / 3));
  const levelsCm = [];
  let val = current;
  let velocity = stepSlope;
  for (let i = 1; i <= 90; i += 1) {
    // Exponentially damp trend velocity over the 30-minute (90 x 20s) horizon
    velocity *= 0.965;
    val = Math.max(0, Math.min(400, val + velocity));
    levelsCm.push(Number(val.toFixed(2)));
  }
  return levelsCm;
}

export function createHardware20sWorker() {
  const hasPythonModel = existsSync(PYTHON_EXE) && existsSync(WORKER_SCRIPT) && existsSync(MODEL_FILE);
  let child = null;
  let buffer = '';
  let ready = false;
  const pending = new Map();

  const fail = () => {
    const old = child;
    child = null;
    ready = false;
    buffer = '';
    if (old) old.kill();
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('model_unavailable'));
    }
    pending.clear();
  };

  function send(p) {
    if (!p.sent && child && ready) {
      p.sent = true;
      child.stdin.write(JSON.stringify({ id: p.id, levels: p.levels }) + '\n');
    }
  }

  function start() {
    if (child) return;
    child = spawn(PYTHON_EXE, ['-u', WORKER_SCRIPT], { cwd: ML, windowsHide: true });
    const proc = child;
    proc.on('error', () => {
      if (proc === child) fail();
    });
    proc.on('exit', () => {
      if (proc === child) fail();
    });
    proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
    proc.stdout.on('data', (chunk) => {
      if (proc !== child) return;
      buffer += chunk.toString();
      let pos;
      while ((pos = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail();
          return;
        }
        if (message.ready) {
          ready = true;
          for (const p of pending.values()) send(p);
          continue;
        }
        const p = pending.get(message.id);
        if (!p) continue;
        clearTimeout(p.timer);
        pending.delete(message.id);
        if (!Array.isArray(message.levelsCm) || message.levelsCm.length !== 90 || message.levelsCm.some((v) => !Number.isFinite(v) || v < 0)) {
          p.reject(new Error('model_unavailable'));
        } else {
          p.resolve({ levelsCm: message.levelsCm, method: 'lstm_hardware_20s_synthetic' });
        }
      }
    });
  }

  return {
    predict(levels) {
      if (!hasPythonModel) {
        return Promise.resolve({
          levelsCm: predictHardware20sFallback(levels),
          method: 'hydrological_20s_fallback',
        });
      }
      return new Promise((resolve, reject) => {
        if (pending.size >= 8) return reject(new Error('worker_busy'));
        const id = randomUUID();
        const p = {
          id,
          levels,
          resolve,
          reject,
          sent: false,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error('worker_timeout'));
          }, 90000),
        };
        pending.set(id, p);
        try {
          start();
          send(p);
        } catch {
          fail();
        }
      });
    },
    close() {
      fail();
    },
  };
}

export function registerHardwareDemoForecast(app, worker) {
  app.post('/api/ciliwung-hardware/demo-forecast', async (req, res) => {
    let history;
    try {
      history = buildDemoHistory(req.body?.history);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const result = await worker.predict(history);
      const levelsCm = Array.isArray(result) ? result : result.levelsCm;
      const method = Array.isArray(result) ? 'lstm_hardware_20s_synthetic' : result.method;
      return res.json({ levelsCm, method, stepSeconds: 20 });
    } catch {
      return res.status(503).json({ error: 'model_unavailable' });
    }
  });
}
