import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ML = fileURLToPath(new URL('../../ml/', import.meta.url));

// A new continuous sequence starts after a gap; early history repeats its first value.
export function buildDemoHistory(points) {
  if (!Array.isArray(points) || !points.length || points.length > 12 || points.some(p => !Number.isFinite(p.time) || !Number.isFinite(p.level) || p.level < 0 || p.level > 1000)) throw new Error('insufficient_history');
  const ordered = [...points].sort((a, b) => a.time - b.time);
  if (ordered.some((p, i) => i && (p.time - ordered[i - 1].time < 15000 || p.time - ordered[i - 1].time > 25000))) throw new Error('history_gap');
  const levels = ordered.map(p => p.level);
  while (levels.length < 12) levels.unshift(levels[0]);
  return levels;
}

export function createHardware20sWorker() {
  let child, buffer = '', ready = false;
  const pending = new Map();
  const fail = () => { const old = child; child = null; ready = false; buffer = ''; if (old) old.kill(); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('model_unavailable')); } pending.clear(); };
  function send(p) { if (!p.sent && child && ready) { p.sent = true; child.stdin.write(JSON.stringify({ id: p.id, levels: p.levels }) + '\n'); } }
  function start() {
    if (child) return;
    child = spawn(join(ML, '.venv', 'Scripts', 'python.exe'), ['-u', join(ML, 'hardware_20s_worker.py')], { cwd: ML, windowsHide: true });
    const proc = child;
    proc.on('error', () => { if (proc === child) fail(); });
    proc.on('exit', () => { if (proc === child) fail(); });
    proc.stderr.on('data', chunk => process.stderr.write(chunk));
    proc.stdout.on('data', chunk => {
      if (proc !== child) return;
      buffer += chunk.toString();
      let pos;
      while ((pos = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
        let message; try { message = JSON.parse(line); } catch { fail(); return; }
        if (message.ready) { ready = true; for (const p of pending.values()) send(p); continue; }
        const p = pending.get(message.id); if (!p) continue;
        clearTimeout(p.timer); pending.delete(message.id);
        if (!Array.isArray(message.levelsCm) || message.levelsCm.length !== 90 || message.levelsCm.some(v => !Number.isFinite(v) || v < 0)) p.reject(new Error('model_unavailable'));
        else p.resolve(message.levelsCm);
      }
    });
  }
  return {
    predict(levels) { return new Promise((resolve, reject) => {
      if (pending.size >= 8) return reject(new Error('worker_busy'));
      const id = randomUUID();
      const p = { id, levels, resolve, reject, sent: false, timer: setTimeout(() => { pending.delete(id); reject(new Error('worker_timeout')); }, 90000) };
      pending.set(id, p);
      try { start(); send(p); } catch { fail(); }
    }); },
    close() { fail(); },
  };
}

export function registerHardwareDemoForecast(app, worker) {
  app.post('/api/ciliwung-hardware/demo-forecast', async (req, res) => {
    let history;
    try { history = buildDemoHistory(req.body?.history); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const levelsCm = await worker.predict(history);
      return res.json({ levelsCm, method: 'lstm_hardware_20s_synthetic', stepSeconds: 20 });
    } catch { return res.status(503).json({ error: 'model_unavailable' }); }
  });
}
