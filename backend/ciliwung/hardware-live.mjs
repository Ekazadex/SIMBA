const DOWNSTREAM_NODES = Object.freeze([
  { id: 'N1', name: 'Pos Depok', cupcarbonNodeId: 5, controlPort: 5105, baselineTmaCm: 60, siagaCm: 180, banjirCm: 280 },
  { id: 'N2', name: 'Ciliwung Stage 1', cupcarbonNodeId: 20, controlPort: 5106, baselineTmaCm: 60, siagaCm: 180, banjirCm: 280 },
  { id: 'N3', name: 'Ciliwung Stage 2', cupcarbonNodeId: 21, controlPort: 5107, baselineTmaCm: 60, siagaCm: 180, banjirCm: 280 },
  { id: 'N4', name: 'Ciliwung Stage 3', cupcarbonNodeId: 22, controlPort: 5108, baselineTmaCm: 60, siagaCm: 180, banjirCm: 280 },
  { id: 'N5', name: 'Pintu Air Manggarai', cupcarbonNodeId: 8, controlPort: 5109, baselineTmaCm: 60, siagaCm: 180, banjirCm: 280 },
]);

export const LIVE_HARDWARE_NODE_IDS = Object.freeze(DOWNSTREAM_NODES.map((node) => node.id));

// These are visual preset limits, not calibrated physical downstream gauges.
export function getDownstreamPresetLimits(nodeId) {
  const node = DOWNSTREAM_NODES.find((entry) => entry.id === nodeId && entry.id !== 'N1');
  return node ? { siaga: node.siagaCm, bahaya: node.banjirCm } : null;
}

// Fixed visual preset values. They are intentionally deterministic and are not
// presented as calibrated downstream gauge measurements.
const FIXED_PRESETS = Object.freeze({
  ringan: Object.freeze({
    label: 'Hujan Ringan',
    areaColor: '#FACC15',
    areaOpacity: 0.24,
    stageRiseM: Object.freeze({ N2: 0.15, N3: 0.25, N4: 0.35, N5: 0.45 }),
  }),
  sedang: Object.freeze({
    label: 'Hujan Sedang',
    areaColor: '#F97316',
    areaOpacity: 0.30,
    stageRiseM: Object.freeze({ N2: 0.60, N3: 1.00, N4: 1.30, N5: 1.60 }),
  }),
  lebat: Object.freeze({
    label: 'Hujan Lebat',
    areaColor: '#2563EB',
    areaOpacity: 0.42,
    stageRiseM: Object.freeze({ N2: 1.40, N3: 1.90, N4: 2.40, N5: 2.80 }),
  }),
});

const DEFAULT_THRESHOLDS = Object.freeze({ thresholdSiaga: 60, thresholdBahaya: 90 });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteLevel(value, field = 'levelCm') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1000) {
    throw new RangeError(`${field} must be a finite value from 0 to 1000 cm`);
  }
  return Number(numeric.toFixed(1));
}

function thresholdValue(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function classifyHardwareReading({ levelCm, thresholdSiaga, thresholdBahaya }) {
  const level = finiteLevel(levelCm);
  const siaga = thresholdValue(thresholdSiaga, DEFAULT_THRESHOLDS.thresholdSiaga);
  const bahaya = thresholdValue(thresholdBahaya, DEFAULT_THRESHOLDS.thresholdBahaya);
  if (bahaya <= siaga) throw new RangeError('thresholdBahaya must be greater than thresholdSiaga');
  if (level >= bahaya) return { condition: 'lebat', alertStatus: 'Bahaya', cupStatus: 'BANJIR_JAKARTA' };
  if (level >= siaga) return { condition: 'sedang', alertStatus: 'Siaga', cupStatus: 'SIAGA' };
  return { condition: 'ringan', alertStatus: 'Normal', cupStatus: 'AMAN' };
}

function classifyDownstreamStatus(node, tmaCm) {
  if (tmaCm >= node.banjirCm) return 'BANJIR_JAKARTA';
  if (tmaCm >= node.siagaCm) return 'SIAGA';
  return 'AMAN';
}

function makeIdleNodes() {
  return DOWNSTREAM_NODES.map((node) => ({
    id: node.id,
    name: node.name,
    cupcarbonNodeId: node.cupcarbonNodeId,
    controlPort: node.controlPort,
    tmaCm: node.baselineTmaCm,
    stageRiseM: 0,
    status: 'AMAN',
    valueType: 'reset',
    source: 'hardware_reset',
    threeDNodeId: node.id,
  }));
}

function makeCupCarbonCommands(snapshot) {
  return snapshot.cupNodes.map((node) => ({
    type: 'node_update',
    mode: 'hardware',
    runId: snapshot.runId,
    nodeId: node.id,
    cupcarbonNodeId: node.cupcarbonNodeId,
    controlPort: node.controlPort,
    tmaCm: node.tmaCm,
    status: node.status,
    valueType: node.valueType,
    source: node.source,
    condition: snapshot.hardware?.condition ?? null,
    profile: snapshot.hardware?.profileLabel ?? null,
    timestampUtc: snapshot.timestampUtc,
  }));
}

function makeIdleSnapshot(now = new Date().toISOString()) {
  const nodes = makeIdleNodes();
  return {
    mode: 'hardware',
    runId: null,
    scenario: null,
    status: 'idle',
    speedMultiplier: 1,
    simTimeSeconds: 0,
    timestampUtc: now,
    pendingReachCount: 0,
    cupcarbon: { status: 'not_verified', activeNodeCount: 0 },
    hardware: { nodeId: 'N1', freshness: 'stale', valueType: 'reset', condition: null, profileLabel: null },
    mapOverlay: { condition: null, areaColor: '#94A3B8', areaOpacity: 0, flooded: false, label: 'Belum ada data live' },
    cupNodes: nodes,
    threeDNodes: nodes,
  };
}

export function buildHardwareSnapshot({
  levelCm,
  thresholdSiaga = DEFAULT_THRESHOLDS.thresholdSiaga,
  thresholdBahaya = DEFAULT_THRESHOLDS.thresholdBahaya,
  runId = 'hardware-live-1',
  measuredAt = new Date().toISOString(),
  simulated = false,
}) {
  const level = finiteLevel(levelCm);
  const classification = classifyHardwareReading({ levelCm: level, thresholdSiaga, thresholdBahaya });
  const preset = FIXED_PRESETS[classification.condition];
  const n1 = DOWNSTREAM_NODES[0];
  const n1StageRiseM = Number(Math.max(0, (level - n1.baselineTmaCm) / 100).toFixed(4));
  const nodes = DOWNSTREAM_NODES.map((node, index) => {
    const derived = index > 0;
    const stageRiseM = derived ? preset.stageRiseM[node.id] : n1StageRiseM;
    const tmaCm = derived ? Number((node.baselineTmaCm + stageRiseM * 100).toFixed(1)) : level;
    const status = derived ? classifyDownstreamStatus(node, tmaCm) : classification.cupStatus;
    return {
      id: node.id,
      name: node.name,
      cupcarbonNodeId: node.cupcarbonNodeId,
      controlPort: node.controlPort,
      tmaCm,
      stageRiseM,
      status,
      valueType: derived ? 'derived_preset' : simulated ? 'simulation' : 'actual_sensor',
      source: derived ? 'fixed_preset' : simulated ? 'Simulator-Engine' : 'esp32',
      threeDNodeId: node.id,
      rainProfile: classification.condition,
    };
  });
  const snapshot = {
    mode: 'hardware',
    runId,
    scenario: classification.condition,
    status: 'running',
    speedMultiplier: 1,
    simTimeSeconds: 0,
    timestampUtc: measuredAt,
    pendingReachCount: 0,
    cupcarbon: { status: 'not_verified', activeNodeCount: 0 },
    hardware: {
      nodeId: 'N1',
      tmaCm: level,
      measuredAt,
      freshness: 'live',
      valueType: simulated ? 'simulation' : 'actual_sensor',
      condition: classification.condition,
      profileLabel: preset.label,
      alertStatus: classification.alertStatus,
      cupStatus: classification.cupStatus,
    },
    mapOverlay: {
      condition: classification.condition,
      areaColor: preset.areaColor,
      areaOpacity: preset.areaOpacity,
      flooded: classification.condition === 'lebat',
      label: `${preset.label} · overlay indikatif`,
    },
    cupNodes: nodes,
    threeDNodes: nodes,
  };
  return clone(snapshot);
}

export function createHardwareLiveBus({ now = () => new Date().toISOString(), sendCupCarbon = () => {} } = {}) {
  const listeners = new Set();
  let enabled = true;
  let runCounter = 0;
  let state = makeIdleSnapshot(now());

  function publish(snapshot) {
    state = clone(snapshot);
    sendCupCarbon(makeCupCarbonCommands(state));
    for (const listener of listeners) listener(clone(state));
    return clone(state);
  }

  return {
    getState() { return clone(state); },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('hardware listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled(value) { enabled = Boolean(value); },
    isEnabled() { return enabled; },
    publishReading(reading = {}) {
      if (!enabled) return null;
      runCounter += 1;
      const timestamp = reading.measuredAt || now();
      return publish(buildHardwareSnapshot({ ...reading, runId: `hardware-live-${runCounter}`, measuredAt: timestamp }));
    },
    reset() {
      return publish(makeIdleSnapshot(now()));
    },
    close() {
      listeners.clear();
      enabled = false;
    },
  };
}

export function hardwareCupCarbonCommands(snapshot) {
  return makeCupCarbonCommands(snapshot);
}

function writeSse(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function registerHardwareLiveRoutes(app, { bus } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new TypeError('an Express-like app is required');
  if (!bus || typeof bus.getState !== 'function' || typeof bus.subscribe !== 'function') throw new TypeError('a hardware live bus is required');

  app.get('/api/ciliwung-hardware/state', (_request, response) => {
    response.json(bus.getState());
  });

  app.get('/api/ciliwung-hardware/stream', (request, response) => {
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no-cache',
    };
    if (typeof response.writeHead === 'function') response.writeHead(200, headers);
    writeSse(response, 'state', bus.getState());
    const unsubscribe = bus.subscribe((snapshot) => {
      try { writeSse(response, 'state', snapshot); }
      catch { unsubscribe(); }
    });
    request?.on?.('close', unsubscribe);
  });

  app.post('/api/ciliwung-hardware/reset', (_request, response) => {
    response.json({ success: true, state: bus.reset() });
  });

  return { bus };
}

export function createCiliwungModeController({ hardwareBus, resetSimulation = async () => {} } = {}) {
  if (!hardwareBus || typeof hardwareBus.reset !== 'function' || typeof hardwareBus.setEnabled !== 'function') {
    throw new TypeError('hardwareBus must expose reset and setEnabled');
  }
  let mode = 'hardware';
  return {
    get mode() { return mode; },
    async switchTo(nextMode) {
      if (nextMode !== 'hardware' && nextMode !== 'simulation') throw new RangeError(`Unsupported Ciliwung mode: ${nextMode}`);
      if (nextMode === 'simulation') {
        hardwareBus.reset();
        hardwareBus.setEnabled(false);
        await resetSimulation();
      } else {
        await resetSimulation();
        hardwareBus.reset();
        hardwareBus.setEnabled(true);
      }
      mode = nextMode;
      return mode;
    },
  };
}
