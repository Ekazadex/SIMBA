import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createForecastWorker } from '../backend/ciliwung/forecast-worker.mjs';
import { NODE_REGISTRY } from '../backend/ciliwung/simulation-engine.mjs';

function fixture() {
  const processes = [];
  const spawnWorker = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 0);
    child.requests = [];
    let buffer = '';
    child.stdin.on('data', (data) => {
      buffer += data.toString();
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        child.requests.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    child.reply = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
    processes.push(child);
    return child;
  };
  return { spawnWorker, processes };
}
const history = Array.from({ length: 96 }, (_, i) => ({
  timestampUtc: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 300_000).toISOString(),
  tmaCm: 100 + i, rainRateMmH: 12, upstreamTmaCm: 80 + i, upstreamRainRateMmH: 6,
}));
const request = { runId: 'run-one', nodeId: 'N1', issuedAt: history.at(-1).timestampUtc, history };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('ready handshake starts one process and sends exactly causal 96-record JSONL requests', async () => {
  const fake = fixture();
  const worker = createForecastWorker({ spawnWorker: fake.spawnWorker, timeoutMs: 1000 });
  try {
    const first = worker.predict(request);
    assert.equal(fake.processes.length, 1);
    assert.equal(fake.processes[0].requests.length, 0);
    fake.processes[0].reply({ type: 'ready', models: ['N1', 'N5'] });
    await tick();
    assert.equal(fake.processes[0].requests.length, 1);
    const wire = fake.processes[0].requests[0];
    assert.equal(wire.history.length, 96);
    assert.equal(wire.runId, 'run-one');
    assert.equal(wire.nodeId, 'N1');
    assert.equal(wire.issuedAt, history.at(-1).timestampUtc);
    assert.equal(typeof wire.requestId, 'string');
    fake.processes[0].reply({ requestId: wire.requestId, runId: wire.runId, nodeId: wire.nodeId,
      levelsCm: Array.from({ length: 12 }, (_, i) => 200 + i), method: 'lstm_synthetic_v1', modelVersion: 'v1' });
    assert.equal((await first).levelsCm[5], 205);
    const second = worker.predict({ ...request, runId: 'run-two' });
    assert.equal(fake.processes.length, 1);
    const next = fake.processes[0].requests[1];
    fake.processes[0].reply({ requestId: next.requestId, runId: next.runId, nodeId: next.nodeId,
      levelsCm: Array(12).fill(150), method: 'lstm_synthetic_v1', modelVersion: 'v1' });
    await second;
  } finally { worker.close(); }
});

test('cold worker startup can exceed the warm inference timeout without discarding the first forecast', async () => {
  const fake = fixture();
  const worker = createForecastWorker({ spawnWorker: fake.spawnWorker, timeoutMs: 25, startupTimeoutMs: 250 });
  try {
    const result = worker.predict(request);
    await new Promise((resolve) => setTimeout(resolve, 75));
    fake.processes[0].reply({ type: 'ready', models: ['N1', 'N5'] });
    await tick();
    const wire = fake.processes[0].requests[0];
    assert.ok(wire, 'first request must survive model startup');
    fake.processes[0].reply({ requestId: wire.requestId, runId: wire.runId, nodeId: wire.nodeId,
      levelsCm: Array(12).fill(150), method: 'lstm_synthetic_v1', modelVersion: 'v1' });
    assert.equal((await result).levelsCm[0], 150);
  } finally { worker.close(); }
});

test('one resident v2 worker accepts all nine mapped nodes and rejects unknown IDs', async () => {
  const fake = fixture();
  const worker = createForecastWorker({ spawnWorker: fake.spawnWorker, timeoutMs: 1000 });
  const ids = NODE_REGISTRY.map((node) => node.id);
  try {
    const results = ids.map((nodeId) => worker.predict({ ...request, nodeId }));
    assert.equal(fake.processes.length, 1);
    fake.processes[0].reply({ type: 'ready', models: ids });
    await tick();
    assert.deepEqual(fake.processes[0].requests.map((item) => item.nodeId), ids);
    for (const wire of fake.processes[0].requests) {
      fake.processes[0].reply({ requestId: wire.requestId, runId: wire.runId, nodeId: wire.nodeId,
        levelsCm: Array(12).fill(150), method: 'lstm_synthetic_v2', modelVersion: 'synthetic_v2' });
    }
    assert.deepEqual((await Promise.all(results)).map((item) => item.nodeId), ids);
    await assert.rejects(worker.predict({ ...request, nodeId: 'INVALID' }), /unmapped_station/);
  } finally { worker.close(); }
});

test('invalid input never reaches worker, absent models and unavailable worker are explicit', async () => {
  const fake = fixture();
  const worker = createForecastWorker({ spawnWorker: fake.spawnWorker, timeoutMs: 100 });
  try {
    await assert.rejects(worker.predict({ ...request, history: history.slice(1) }), /insufficient_history/i);
    await assert.rejects(worker.predict({ ...request, history: [...history.slice(0, 95), { ...history[95], rainRateMmH: null }] }), /stale_input/i);
    assert.equal(fake.processes.length, 0);
    const pending = worker.predict(request);
    fake.processes[0].reply({ type: 'ready', models: ['N5'] });
    await assert.rejects(pending, /model_unavailable/i);
  } finally { worker.close(); }
  const unavailable = createForecastWorker({ available: false });
  await assert.rejects(unavailable.predict(request), /model_unavailable/i);
  unavailable.close();
});

test('malformed response, timeout, bounded queue and worker crash fail safely; restart is supervised', async () => {
  const fake = fixture();
  const worker = createForecastWorker({ spawnWorker: fake.spawnWorker, timeoutMs: 30, restartDelayMs: 1, maxPending: 1 });
  try {
    const pending = worker.predict(request);
    await assert.rejects(worker.predict(request), /worker_busy/i);
    fake.processes[0].reply({ type: 'ready', models: ['N1', 'N5'] });
    await tick();
    const wire = fake.processes[0].requests[0];
    fake.processes[0].reply({ requestId: wire.requestId, runId: 'wrong-run', nodeId: wire.nodeId,
      levelsCm: Array(12).fill(100), method: 'lstm_synthetic_v1', modelVersion: 'v1' });
    await assert.rejects(pending, /invalid_worker_response/i);
    const timeout = worker.predict(request);
    await assert.rejects(timeout, /worker_timeout/i);
    fake.processes[0].emit('exit', 1);
    const recovered = worker.predict(request);
    await new Promise((resolve) => setTimeout(resolve, 10)); // obey restart backoff
    assert.equal(fake.processes.length, 2);
    fake.processes[1].reply({ type: 'ready', models: ['N1', 'N5'] });
    await tick();
    fake.processes[1].emit('exit', 1);
    await assert.rejects(recovered, /worker_unavailable/i);
  } finally { worker.close(); }
});
