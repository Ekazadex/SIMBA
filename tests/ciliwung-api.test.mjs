import assert from 'node:assert/strict';
import test from 'node:test';
import { createCiliwungEngine } from '../backend/ciliwung/simulation-engine.mjs';
import { registerCiliwungRoutes } from '../backend/ciliwung/ciliwung-api.mjs';

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
      ? ['/api/ciliwung-simulation/scenarios', '/api/ciliwung-simulation/state', '/api/ciliwung-simulation/stream']
      : ['/api/ciliwung-simulation/start', '/api/ciliwung-simulation/stop', '/api/ciliwung-simulation/reset']) {
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
