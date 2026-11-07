import assert from 'node:assert/strict';
import test from 'node:test';
import { createCiliwungEngine } from '../backend/ciliwung/simulation-engine.mjs';
import { registerCiliwungRoutes } from '../backend/ciliwung/ciliwung-api.mjs';
import { buildScenarioPreviewHistory } from '../backend/ciliwung/scenario-preview.mjs';

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    chunks: [],
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    flushHeaders() {},
  };
}

test('registers the complete Ciliwung REST and SSE contract', () => {
  const app = makeApp();
  const engine = createCiliwungEngine({ autoStart: false });
  const api = registerCiliwungRoutes(app, { engine, sendCupCarbon: () => {} });
  assert.ok(api.unsubscribe);
  for (const method of ['GET', 'POST']) {
    for (const path of method === 'GET'
      ? ['/api/ciliwung-simulation/scenarios', '/api/ciliwung-simulation/state', '/api/ciliwung-simulation/history', '/api/ciliwung-simulation/projection', '/api/ciliwung-simulation/scenario-previews', '/api/ciliwung-simulation/stream']
      : ['/api/ciliwung-simulation/start', '/api/ciliwung-simulation/stop', '/api/ciliwung-simulation/reset', '/api/ciliwung-simulation/speed']) {
      assert.equal(typeof app.routes.get(`${method} ${path}`), 'function');
    }
  }
  api.unsubscribe();
});

test('start returns a reset running state and sends no Firestore dependency', async () => {
  const app = makeApp();
  const engine = createCiliwungEngine({ autoStart: false });
  let sendCount = 0;
  registerCiliwungRoutes(app, { engine, sendCupCarbon: () => { sendCount += 1; } });
  const response = makeResponse();
  await app.routes.get('POST /api/ciliwung-simulation/start')({ body: { scenario: 'sedang' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.state.status, 'running');
  assert.equal(response.body.state.scenario, 'sedang');
  assert.ok(sendCount >= 1);
});

test('speed endpoint updates the authoritative simulation speed', async () => {
  const app = makeApp();
  const engine = createCiliwungEngine({ autoStart: false });
  registerCiliwungRoutes(app, { engine, sendCupCarbon: () => {} });

  const startResponse = makeResponse();
  await app.routes.get('POST /api/ciliwung-simulation/start')({ body: { scenario: 'sedang', speedMultiplier: 25 } }, startResponse);
  assert.equal(startResponse.body.state.speedMultiplier, 25);

  const speedResponse = makeResponse();
  await app.routes.get('POST /api/ciliwung-simulation/speed')({ body: { speedMultiplier: 150 } }, speedResponse);
  assert.equal(speedResponse.body.success, true);
  assert.equal(speedResponse.body.state.speedMultiplier, 150);
});

test('scenario-preview endpoint returns three causal synthetic histories and each node forecast', async () => {
  const app = makeApp();
  const engine = createCiliwungEngine({ autoStart: false });
  const requests = [];
  const worker = { async predict(request) {
    requests.push(request);
    const base = 100 + requests.length * 10;
    return { runId: request.runId, nodeId: request.nodeId,
      levelsCm: Array.from({ length: 12 }, (_, index) => base + index),
      method: 'lstm_synthetic_v2', modelVersion: `synthetic_v2_${request.nodeId}` };
  } };
  registerCiliwungRoutes(app, { engine, worker, sendCupCarbon: () => {} });
  const response = makeResponse();
  await app.routes.get('GET /api/ciliwung-simulation/scenario-previews')({ query: { nodeId: 'N1' } }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.previews.map((preview) => preview.scenarioId), ['ringan', 'sedang', 'lebat']);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.nodeId === 'N1' && request.history.length === 96));
  for (const request of requests) {
    const stamps = request.history.map((row) => Date.parse(row.timestampUtc));
    assert.ok(stamps.every((stamp, index) => index === 0 || stamp - stamps[index - 1] === 300_000));
    assert.ok(request.history.every((row) => ['tmaCm', 'rainRateMmH', 'upstreamTmaCm', 'upstreamRainRateMmH']
      .every((field) => Number.isFinite(row[field]) && row[field] >= 0)));
  }
  assert.equal(response.body.previews[0].rainfallDepthMmPerCatchment.UP1, 8);
  assert.equal(response.body.previews[1].rainfallDepthMmPerCatchment.UP2, 15);
  assert.equal(response.body.previews[2].rainfallDepthMmPerCatchment.N5, 18);
  assert.equal(response.body.previews[0].predictedTmaCm['30'], 115);
  assert.equal(response.body.previews[2].predictedTmaCm['60'], 141);
});

test('synthetic scenario preview preserves the dataset reference values for UP3 and UP4', () => {
  assert.equal(buildScenarioPreviewHistory('ringan', 'UP3').history[0].tmaCm, 100);
  assert.equal(buildScenarioPreviewHistory('ringan', 'UP4').history[0].tmaCm, 150);
});

test('scenario-preview endpoint rejects an unmapped station', async () => {
  const app = makeApp();
  registerCiliwungRoutes(app, { engine: createCiliwungEngine({ autoStart: false }), worker: { predict: async () => null } });
  const response = makeResponse();
  await app.routes.get('GET /api/ciliwung-simulation/scenario-previews')({ query: { nodeId: 'fake-node' } }, response);
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /unsupported.*nodeId/i);
});

test('history endpoint returns buffered legacy scenario samples for a completed run', async () => {
  const app = makeApp();
  const engine = createCiliwungEngine({ autoStart: false });
  registerCiliwungRoutes(app, { engine, sendCupCarbon: () => {} });
  const started = makeResponse();
  await app.routes.get('POST /api/ciliwung-simulation/start')({ body: { scenario: 'sedang' } }, started);
  engine.advance(1);
  engine.advance(2);
  engine.stop();

  const response = makeResponse();
  app.routes.get('GET /api/ciliwung-simulation/history')({}, response);
  assert.equal(response.body.runId, started.body.state.runId);
  assert.equal(response.body.episodeId, null);
  assert.deepEqual(response.body.points.map((point) => point.time), [0, 1, 3]);
});

test('CupCarbon telemetry updates SSE state without echoing a control datagram', () => {
  const app = makeApp();
  const engine = createCiliwungEngine({ autoStart: false });
  let sendCount = 0;
  registerCiliwungRoutes(app, { engine, sendCupCarbon: () => { sendCount += 1; } });
  const initialSendCount = sendCount;

  const state = engine.markCupCarbonTelemetry({ nodeId: 'N1', tmaCm: 61, status: 'AMAN' }, 1234);
  assert.equal(state.cupcarbon.status, 'active');
  assert.equal(sendCount, initialSendCount);
});

test('stream sends an initial event and removes the client on close', () => {
  const app = makeApp();
  const engine = createCiliwungEngine({ autoStart: false });
  registerCiliwungRoutes(app, { engine, sendCupCarbon: () => {} });
  const listeners = {};
  const request = { on(event, callback) { listeners[event] = callback; } };
  const response = makeResponse();
  app.routes.get('GET /api/ciliwung-simulation/stream')(request, response);
  assert.equal(response.headers['Content-Type'], 'text/event-stream');
  assert.match(response.chunks[0], /^event: state\ndata: /);
  listeners.close();
  engine.start('ringan');
  assert.equal(response.chunks.length, 1);
});


test('legacy projection route is read-only and does not emit forecast or CupCarbon commands', () => {
  const app = makeApp();
  const engine = createCiliwungEngine({ autoStart: false });
  let currentCommands = 0;
  let forecastCommands = 0;
  const api = registerCiliwungRoutes(app, { engine,
    sendCupCarbon: () => { currentCommands += 1; }, sendForecastCupCarbon: () => { forecastCommands += 1; } });
  const route = app.routes.get('GET /api/ciliwung-simulation/projection');
  let response = makeResponse();
  route({ query: { nodeId: 'N1' } }, response);
  assert.equal(response.body.status, 'unavailable');
  engine.start('ringan', 10);
  engine.advance(1);
  const state = engine.getState();
  const before = [currentCommands, forecastCommands];
  response = makeResponse();
  route({ query: { nodeId: 'N1' } }, response);
  assert.equal(response.body.status, 'available');
  assert.equal(response.body.points[0].tmaCm, state.cupNodes.find(node => node.id === 'N1').tmaCm);
  assert.deepEqual(engine.getState(), state);
  assert.deepEqual([currentCommands, forecastCommands], before);
  response = makeResponse();
  route({ query: { nodeId: 'UNKNOWN' } }, response);
  assert.equal(response.statusCode, 400);
  engine.stop();
  response = makeResponse();
  route({ query: { nodeId: 'N1' } }, response);
  assert.equal(response.body.status, 'unavailable');
  api.unsubscribe();
});
