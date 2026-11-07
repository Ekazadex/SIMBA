import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_HARDWARE_NODE_IDS,
  buildHardwareSnapshot,
  classifyHardwareReading,
  createHardwareLiveBus,
  registerHardwareLiveRoutes,
  createCiliwungModeController,
} from '../backend/ciliwung/hardware-live.mjs';

test('classifies the fixed hardware profile from the configured thresholds', () => {
  assert.deepEqual(classifyHardwareReading({ levelCm: 50, thresholdSiaga: 60, thresholdBahaya: 90 }), {
    condition: 'ringan',
    alertStatus: 'Normal',
    cupStatus: 'AMAN',
  });
  assert.deepEqual(classifyHardwareReading({ levelCm: 60, thresholdSiaga: 60, thresholdBahaya: 90 }), {
    condition: 'sedang',
    alertStatus: 'Siaga',
    cupStatus: 'SIAGA',
  });
  assert.deepEqual(classifyHardwareReading({ levelCm: 90, thresholdSiaga: 60, thresholdBahaya: 90 }), {
    condition: 'lebat',
    alertStatus: 'Bahaya',
    cupStatus: 'BANJIR_JAKARTA',
  });
});

test('builds a downstream-only snapshot with one actual sensor and fixed derived stages', () => {
  const snapshot = buildHardwareSnapshot({
    levelCm: 95,
    thresholdSiaga: 60,
    thresholdBahaya: 90,
    runId: 'hardware-test-1',
    measuredAt: '2026-10-30T10:00:00.000Z',
  });

  assert.deepEqual(snapshot.threeDNodes.map((node) => node.id), LIVE_HARDWARE_NODE_IDS);
  assert.equal(snapshot.mode, 'hardware');
  assert.equal(snapshot.status, 'running');
  assert.equal(snapshot.hardware.nodeId, 'N1');
  assert.equal(snapshot.hardware.valueType, 'actual_sensor');
  assert.equal(snapshot.hardware.condition, 'lebat');
  assert.equal(snapshot.mapOverlay.areaColor, '#2563EB');
  assert.equal(snapshot.threeDNodes[0].tmaCm, 95);
  assert.equal(snapshot.threeDNodes[0].valueType, 'actual_sensor');
  assert.equal(snapshot.threeDNodes[4].valueType, 'derived_preset');
  assert.equal(snapshot.threeDNodes[4].source, 'fixed_preset');
});

test('hardware bus fans one snapshot to SSE subscribers and CupCarbon, then resets cleanly', () => {
  const published = [];
  const cupCommands = [];
  const bus = createHardwareLiveBus({
    now: () => '2026-10-30T10:00:00.000Z',
    sendCupCarbon: (commands) => cupCommands.push(commands),
  });
  const unsubscribe = bus.subscribe((snapshot) => published.push(snapshot));

  const snapshot = bus.publishReading({ levelCm: 60, thresholdSiaga: 60, thresholdBahaya: 90 });
  assert.deepEqual(published.at(-1), snapshot);
  assert.equal(cupCommands.at(-1).length, LIVE_HARDWARE_NODE_IDS.length);
  assert.equal(cupCommands.at(-1)[0].valueType, 'actual_sensor');
  assert.equal(cupCommands.at(-1)[1].valueType, 'derived_preset');

  const reset = bus.reset();
  assert.equal(reset.mode, 'hardware');
  assert.equal(reset.status, 'idle');
  assert.deepEqual(reset.threeDNodes.map((node) => node.id), LIVE_HARDWARE_NODE_IDS);
  assert.equal(cupCommands.at(-1).every((command) => command.status === 'AMAN'), true);

  unsubscribe();
  bus.close();
});

test('disabled hardware bus ignores telemetry until hardware mode is reactivated', () => {
  const published = [];
  const bus = createHardwareLiveBus({ sendCupCarbon: () => {} });
  bus.subscribe((snapshot) => published.push(snapshot));
  bus.setEnabled(false);

  assert.equal(bus.publishReading({ levelCm: 100, thresholdSiaga: 60, thresholdBahaya: 90 }), null);
  assert.equal(published.length, 0);

  bus.setEnabled(true);
  assert.equal(bus.publishReading({ levelCm: 100, thresholdSiaga: 60, thresholdBahaya: 90 }).mode, 'hardware');
  assert.equal(published.length, 1);
  bus.close();
});

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
    chunks: [],
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    write(value) { this.chunks.push(value); },
    json(value) { this.body = value; return this; },
  };
}

test('hardware SSE/state/reset routes expose the same bus state and reset event', async () => {
  const app = makeApp();
  const bus = createHardwareLiveBus({ sendCupCarbon: () => {} });
  registerHardwareLiveRoutes(app, { bus });

  const stateResponse = makeResponse();
  app.routes.get('GET /api/ciliwung-hardware/state')({}, stateResponse);
  assert.equal(stateResponse.body.mode, 'hardware');
  assert.equal(stateResponse.body.status, 'idle');

  const listeners = {};
  const streamResponse = makeResponse();
  app.routes.get('GET /api/ciliwung-hardware/stream')({ on(event, callback) { listeners[event] = callback; } }, streamResponse);
  assert.match(streamResponse.chunks[0], /^event: state\ndata: /);

  bus.publishReading({ levelCm: 95, thresholdSiaga: 60, thresholdBahaya: 90 });
  assert.match(streamResponse.chunks.at(-1), /"mode":"hardware"/);
  listeners.close();

  const resetResponse = makeResponse();
  await app.routes.get('POST /api/ciliwung-hardware/reset')({}, resetResponse);
  assert.equal(resetResponse.body.success, true);
  assert.equal(resetResponse.body.state.status, 'idle');
  bus.close();
});

test('mode controller resets the old state before enabling the destination mode', async () => {
  const bus = createHardwareLiveBus({ sendCupCarbon: () => {} });
  const calls = [];
  const controller = createCiliwungModeController({
    hardwareBus: bus,
    resetSimulation: async () => calls.push('simulation-reset'),
  });

  await controller.switchTo('simulation');
  assert.equal(bus.isEnabled(), false);
  assert.deepEqual(calls, ['simulation-reset']);

  await controller.switchTo('hardware');
  assert.equal(bus.isEnabled(), true);
  assert.deepEqual(calls, ['simulation-reset', 'simulation-reset']);
  bus.close();
});
