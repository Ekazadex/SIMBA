import assert from 'node:assert/strict';
import test from 'node:test';
import { createCiliwungEngine, NODE_REGISTRY } from '../backend/ciliwung/simulation-engine.mjs';
import { registerCiliwungRoutes } from '../backend/ciliwung/ciliwung-api.mjs';
import { sendForecastCupCarbon } from '../backend/ciliwung/forecast-udp.mjs';
import { readFile } from 'node:fs/promises';

const epoch = Date.parse('2026-08-01T00:00:00Z');
function episode(id = 'test-episode') {
  return { episodeId: id, version: 'synthetic_v1', stepSeconds: 300, startTimeUtc: new Date(epoch).toISOString(),
    nodes: NODE_REGISTRY.map(({ id: nodeId }) => ({ id: nodeId })),
    frames: Array.from({ length: 99 }, (_, i) => ({ simTimeSeconds: i * 300,
      timestampUtc: new Date(epoch + i * 300_000).toISOString(),
      nodes: NODE_REGISTRY.map(({ id: nodeId }) => ({ id: nodeId, tmaCm: 100 + i,
        rainRateMmH: 12, rainMm5m: 1, rainSource: 'synthetic', tmaSource: 'synthetic' })) })) };
}
function appHarness(worker, load = async (id) => episode(id)) {
  const routes = new Map();
  const app = { get(path, handler) { routes.set(`GET ${path}`, handler); }, post(path, handler) { routes.set(`POST ${path}`, handler); } };
  const engine = createCiliwungEngine({ autoStart: false });
  const udp = [];
  const states = [];
  const api = registerCiliwungRoutes(app, { engine, worker, loadEpisode: load,
    listEpisodes: async () => [{ episodeId: 'test-episode' }],
    sendCupCarbon: (state) => states.push(state), sendForecastCupCarbon: (command) => udp.push(command) });
  function response() { return { statusCode: 200, body: null, chunks: [],
    status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; },
    writeHead() {}, write(value) { this.chunks.push(value); } }; }
  async function call(method, path, { body, query } = {}) {
    const res = response();
    await routes.get(`${method} ${path}`)({ body, query }, res);
    return res;
  }
  return { routes, engine, udp, states, api, call, response };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('list and start replay route preserve legacy current state and forecast separately on SSE/latest', async () => {
  const requests = [];
  const h = appHarness({ predict: async (req) => { requests.push(req); return { runId: req.runId, nodeId: req.nodeId,
    levelsCm: Array.from({ length: 12 }, (_, i) => i === 1 ? 281 : 170 + i), method: 'lstm_synthetic_v1', modelVersion: 'v1' }; } });
  try {
    assert.deepEqual((await h.call('GET', '/api/ciliwung-simulation/episodes')).body, [{ episodeId: 'test-episode' }]);
    const stream = h.response();
    h.routes.get('GET /api/ciliwung-simulation/stream')({ on() {} }, stream);
    const started = await h.call('POST', '/api/ciliwung-simulation/replay/start', { body: { episodeId: 'test-episode', speedMultiplier: 50 } });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.state.scenario, 'rain_replay');
    const replayHistory = (await h.call('GET', '/api/ciliwung-simulation/history')).body;
    assert.equal(replayHistory.runId, started.body.state.runId);
    assert.equal(replayHistory.points.length, 96);
    assert.equal(replayHistory.points.at(-1).timestampUtc, started.body.state.timestampUtc);
    assert.equal(replayHistory.points.some((point) => point.time > started.body.state.simTimeSeconds), false);
    await settle();
    assert.equal(requests.length, 9);
    assert.ok(requests.every(({ history }) => history.length === 96 && history.at(-1).timestampUtc === started.body.state.timestampUtc));
    const latest = (await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: 'N1' } })).body;
    assert.equal(latest.runId, started.body.state.runId);
    assert.equal(latest.predictedTmaCm['30'], 175);
    assert.equal(latest.predictedTmaCm['60'], 181);
    assert.equal(latest.crossingWithin['30'], true);
    assert.equal(latest.crossingWithin['60'], true);
    assert.equal(latest.trajectoryCm.length, 12);
    assert.equal(latest.thresholdBanjirCm, 280);
    assert.equal(latest.mode, 'synthetic_demo');
    assert.equal(latest.quality, 'experimental_synthetic_only');
    assert.equal(latest.clockBasis, 'simulation');
    assert.ok(latest.generatedAt);
    assert.ok(stream.chunks.some((part) => part.startsWith('event: forecast\ndata: ')));
    assert.equal(h.engine.getState().cupNodes.find((n) => n.id === 'N1').tmaCm, 195);
    assert.equal(h.states.at(-1).cupNodes.some((n) => n.predictedTmaCm !== undefined), false);
    assert.equal(h.udp.filter((c) => c.status === 'available').length, 9);
    assert.equal(h.udp.find((c) => c.nodeId === 'N1' && c.status === 'available').predictedTmaCm['30'], 175);
    assert.equal((await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: 'N2' } })).statusCode, 200);
    assert.equal((await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: 'INVALID' } })).statusCode, 400);
  } finally { h.api.unsubscribe(); }
});

test('forecast UDP reaches all nine mapped station ports, keeps current packets separate, and permits only UP1 null crossing', () => {
  const sent = [];
  const socket = { send(payload, port, address) { sent.push({ command: JSON.parse(payload), port, address }); } };
  for (const node of NODE_REGISTRY) {
    const headwater = node.id === 'UP1';
    sendForecastCupCarbon(socket, { type: 'forecast_update', runId: 'r1', nodeId: node.id, issuedAt: '2026-08-01T00:00:00Z',
      predictedTmaCm: { '30': 175, '60': 181 }, crossingWithin: { '30': headwater ? null : false, '60': headwater ? null : true },
      thresholdBanjirCm: headwater ? null : 280, status: 'available', quality: 'experimental_synthetic_only' });
  }
  assert.deepEqual(sent.map(({ port }) => port), NODE_REGISTRY.map(({ controlPort }) => controlPort));
  assert.ok(sent.every(({ address, command }) => address === '127.0.0.1' && command.type === 'forecast_update' && command.tmaCm === undefined));
  assert.deepEqual(sent[0].command.crossingWithin, { '30': null, '60': null });
  assert.equal(sent[0].command.thresholdBanjirCm, null);
  assert.equal(sent[5].command.thresholdBanjirCm, 280);
  sendForecastCupCarbon(socket, { type: 'forecast_update', runId: null, nodeId: 'N5', status: 'unavailable' });
  assert.deepEqual(sent.at(-1).command, { type: 'forecast_update', runId: null, nodeId: 'N5', status: 'unavailable' });
  assert.throws(() => sendForecastCupCarbon(socket, { type: 'forecast_update', nodeId: 'NOPE', status: 'available' }), /unsupported/i);
  assert.throws(() => sendForecastCupCarbon(socket, { type: 'forecast_update', runId: 'r1', nodeId: 'UP2', issuedAt: '2026-08-01T00:00:00Z',
    predictedTmaCm: { '30': 175, '60': 181 }, crossingWithin: { '30': null, '60': null }, thresholdBanjirCm: 280,
    status: 'available', quality: 'experimental_synthetic_only' }), /unsupported/i);
});

test('stop, reset and new run retire forecasts, send clear commands and fence late worker responses', async () => {
  const pending = [];
  const h = appHarness({ predict: (req) => new Promise((resolve) => pending.push({ req, resolve })) });
  try {
    const started = await h.call('POST', '/api/ciliwung-simulation/replay/start', { body: { episodeId: 'test-episode' } });
    assert.equal(pending.length, 9);
    await h.call('POST', '/api/ciliwung-simulation/reset');
    for (const { req, resolve } of pending) resolve({ runId: req.runId, nodeId: req.nodeId, levelsCm: Array(12).fill(300), method: 'lstm_synthetic_v1', modelVersion: 'v1' });
    await settle();
    assert.equal((await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: 'N1' } })).body.status, 'unavailable');
    assert.equal(h.udp.filter((c) => c.status === 'available').length, 0);
    assert.ok(h.udp.some((c) => c.nodeId === 'N1' && c.status === 'unavailable' && c.runId === null));
    const restarted = await h.call('POST', '/api/ciliwung-simulation/replay/start', { body: { episodeId: 'test-episode' } });
    assert.notEqual(restarted.body.state.runId, started.body.state.runId);
    await h.call('POST', '/api/ciliwung-simulation/stop');
    assert.equal((await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: 'N5' } })).body.status, 'unavailable');
    assert.equal(h.engine.getState().cupNodes.length, 9);
  } finally { h.api.unsubscribe(); }
});

test('invalid episode request and failed worker return reasoned unavailable, never heuristic numbers', async () => {
  const h = appHarness({ predict: async () => { throw new Error('model_unavailable'); } });
  try {
    const invalid = await h.call('POST', '/api/ciliwung-simulation/replay/start', { body: { episodeId: '../escape' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(h.engine.getState().status, 'idle');
    await h.call('POST', '/api/ciliwung-simulation/replay/start', { body: { episodeId: 'test-episode' } });
    await settle();
    const forecast = (await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: 'N1' } })).body;
    assert.equal(forecast.status, 'unavailable');
    assert.equal(forecast.reason, 'model_unavailable');
    assert.equal(forecast.predictedTmaCm, undefined);
    assert.equal(h.udp.filter((c) => c.status === 'available').length, 0);
  } finally { h.api.unsubscribe(); }
});

test('all nine keyed forecasts publish levels while UP1 has no invented flood threshold', async () => {
  const requests = [];
  const h = appHarness({ predict: async (request) => {
    requests.push(request);
    return { runId: request.runId, nodeId: request.nodeId, levelsCm: Array(12).fill(310),
      method: 'lstm_synthetic_v2', modelVersion: 'synthetic_v2' };
  } });
  try {
    const { body: { state } } = await h.call('POST', '/api/ciliwung-simulation/replay/start', { body: { episodeId: 'test-episode' } });
    await settle();
    assert.deepEqual(new Set(requests.map((request) => request.nodeId)), new Set(NODE_REGISTRY.map((node) => node.id)));
    for (const { id } of NODE_REGISTRY) {
      const response = await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: id } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.status, 'available');
      assert.equal(response.body.runId, state.runId);
      assert.equal(response.body.trajectoryCm.length, 12);
    }
    const headwater = (await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: 'UP1' } })).body;
    assert.equal(headwater.thresholdBanjirCm, null);
    assert.deepEqual(headwater.crossingWithin, { '30': null, '60': null });
    assert.equal(headwater.alreadyAboveThreshold, null);
    const downstream = (await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: 'UP2' } })).body;
    assert.deepEqual(downstream.crossingWithin, { '30': true, '60': true });
    assert.equal(h.states.at(-1).cupNodes.some((node) => node.predictedTmaCm !== undefined), false);
    assert.equal(h.udp.filter((command) => command.status === 'available').length, 9);
    await h.call('POST', '/api/ciliwung-simulation/reset');
    for (const { id } of NODE_REGISTRY) {
      assert.equal((await h.call('GET', '/api/ciliwung-forecast/latest', { query: { nodeId: id } })).body.status, 'unavailable');
      assert.ok(h.udp.some((command) => command.nodeId === id && command.status === 'unavailable' && command.runId === null));
    }
  } finally { h.api.unsubscribe(); }
});

test('authoritative server wires forecast worker, UDP and weather context alongside unchanged node_update', async () => {
  const source = await readFile(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(source, /createForecastWorker\(/);
  assert.match(source, /sendForecastCupCarbon\(cupCarbonSocket, command\)/);
  assert.match(source, /app\.get\('\/api\/ciliwung-weather\/context', createWeatherContextHandler\(\)\)/);
  assert.match(source, /type: 'node_update'/);
});
