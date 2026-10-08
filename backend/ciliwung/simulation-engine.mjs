const DEFAULT_INTERVAL_MS = 500;
export const SPEED_MULTIPLIERS = Object.freeze([1, 10, 25, 50]);
const DEFAULT_SPEED_MULTIPLIER = SPEED_MULTIPLIERS[0];
const EPSILON = 1e-9;

export const NODE_REGISTRY = Object.freeze([
  { id: 'UP1', name: 'Puncak', cupcarbonNodeId: 1, script: 'puncak.py', threeDNodeId: null, baselineTmaCm: 40, thresholds: { siaga: 70, banjir: Infinity }, controlPort: 5101 },
  { id: 'UP2', name: 'Katulampa', cupcarbonNodeId: 2, script: 'katulampa.py', threeDNodeId: null, baselineTmaCm: 60, thresholds: { siaga: 180, banjir: 280 }, controlPort: 5102 },
  { id: 'UP3', name: 'Sukaraja', cupcarbonNodeId: 3, script: 'sukaraja.py', threeDNodeId: null, baselineTmaCm: 100, thresholds: { siaga: 180, banjir: 280 }, controlPort: 5103 },
  { id: 'UP4', name: 'Cibinong', cupcarbonNodeId: 4, script: 'cibinong.py', threeDNodeId: null, baselineTmaCm: 150, thresholds: { siaga: 180, banjir: 280 }, controlPort: 5104 },
  { id: 'N1', name: 'Pos Depok', cupcarbonNodeId: 5, script: 'pos_depok.py', threeDNodeId: 'N1', baselineTmaCm: 60, thresholds: { siaga: 180, banjir: 280 }, controlPort: 5105 },
  { id: 'N2', name: 'Ciliwung Stage 1', cupcarbonNodeId: 20, script: 'ciliwung_stage1.py', threeDNodeId: 'N2', baselineTmaCm: 60, thresholds: { siaga: 180, banjir: 280 }, controlPort: 5106 },
  { id: 'N3', name: 'Ciliwung Stage 2', cupcarbonNodeId: 21, script: 'ciliwung_stage2.py', threeDNodeId: 'N3', baselineTmaCm: 60, thresholds: { siaga: 180, banjir: 280 }, controlPort: 5107 },
  { id: 'N4', name: 'Ciliwung Stage 3', cupcarbonNodeId: 22, script: 'ciliwung_stage3.py', threeDNodeId: 'N4', baselineTmaCm: 60, thresholds: { siaga: 180, banjir: 280 }, controlPort: 5108 },
  { id: 'N5', name: 'Pintu Air Manggarai', cupcarbonNodeId: 8, script: 'pintu_air_manggarai.py', threeDNodeId: 'N5', baselineTmaCm: 60, thresholds: { siaga: 180, banjir: 280 }, controlPort: 5109 },
]);

const REACH_DELAY_SECONDS = Object.freeze([20, 25, 30, 35, 40, 45, 50, 55]);
const REACH_ATTENUATION = Object.freeze([0.92, 0.90, 0.88, 0.86, 0.84, 0.82, 0.80, 0.78]);

export const SCENARIO_PROFILES = Object.freeze({
  ringan: Object.freeze({
    id: 'ringan',
    label: 'Hujan Ringan',
    description: 'Hujan ringan di hulu. Scenario selesai ketika Puncak masuk status SIAGA.',
    localRiseCmPerSecond: Object.freeze([0.08, 0, 0, 0, 0, 0, 0, 0, 0]),
    targetNodeId: 'UP1',
    targetThresholdCm: 70,
  }),
  sedang: Object.freeze({
    id: 'sedang',
    label: 'Hujan Sedang',
    description: 'Hujan sedang dengan kontribusi lokal pada koridor utama. Scenario selesai ketika Stage 2 masuk status SIAGA.',
    localRiseCmPerSecond: Object.freeze([0.28, 0, 0, 0, 0.08, 0, 0.06, 0.05, 0.04]),
    targetNodeId: 'N3',
    targetThresholdCm: 180,
  }),
  lebat: Object.freeze({
    id: 'lebat',
    label: 'Hujan Lebat',
    description: 'Hujan lebat dengan rambatan sampai hilir. Scenario selesai ketika Manggarai mencapai BANJIR_JAKARTA.',
    localRiseCmPerSecond: Object.freeze([0.55, 0, 0, 0, 0.30, 0.25, 0.22, 0.20, 0.40]),
    targetNodeId: 'N5',
    targetThresholdCm: 280,
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function classifyStatus(node, tmaCm) {
  if (tmaCm >= node.thresholds.banjir) return 'BANJIR_JAKARTA';
  if (tmaCm >= node.thresholds.siaga) return 'SIAGA';
  return 'AMAN';
}

function buildNodes(storageRiseCm) {
  return NODE_REGISTRY.map((node, index) => {
    const tmaCm = node.baselineTmaCm + storageRiseCm[index];
    return {
      id: node.id,
      name: node.name,
      cupcarbonNodeId: node.cupcarbonNodeId,
      threeDNodeId: node.threeDNodeId,
      tmaCm: Number(tmaCm.toFixed(2)),
      stageRiseM: Number((storageRiseCm[index] / 100).toFixed(4)),
      status: classifyStatus(node, tmaCm),
      controlPort: node.controlPort,
    };
  });
}

function makeInitialState() {
  const storageRiseCm = Array(NODE_REGISTRY.length).fill(0);
  const cupNodes = buildNodes(storageRiseCm);
  return {
    runId: null,
    scenario: null,
    status: 'idle',
    speedMultiplier: DEFAULT_SPEED_MULTIPLIER,
    simTimeSeconds: 0,
    targetNodeId: null,
    targetThresholdCm: null,
    cupcarbon: {
      status: 'not_verified',
      warning: 'CupCarbon belum diverifikasi aktif. Backend tetap menjalankan scenario.',
    },
    cupNodes,
    threeDNodes: cupNodes.filter((node) => node.threeDNodeId),
    pendingReachCount: 0,
    updatedAt: Date.now(),
  };
}

function validateScenario(scenario) {
  if (!Object.hasOwn(SCENARIO_PROFILES, scenario)) {
    throw new RangeError(`Unknown Ciliwung scenario: ${scenario}`);
  }
  return SCENARIO_PROFILES[scenario];
}

function validateSpeedMultiplier(speedMultiplier = DEFAULT_SPEED_MULTIPLIER) {
  const numericSpeed = Number(speedMultiplier);
  if (!SPEED_MULTIPLIERS.includes(numericSpeed)) {
    throw new RangeError(`Unsupported Ciliwung speed multiplier: ${speedMultiplier}`);
  }
  return numericSpeed;
}

export function createCiliwungEngine(options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const autoStart = options.autoStart ?? true;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be positive');

  let state = makeInitialState();
  let storageRiseCm = Array(NODE_REGISTRY.length).fill(0);
  let pendingEvents = [];
  let timer = null;
  let runCounter = 0;
  const listeners = new Set();

  function publish() {
    state = {
      ...state,
      cupNodes: buildNodes(storageRiseCm),
      threeDNodes: buildNodes(storageRiseCm).filter((node) => node.threeDNodeId),
      pendingReachCount: pendingEvents.length,
      updatedAt: Date.now(),
    };
    const snapshot = clone(state);
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  }

  function clearTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function setRunningTimer() {
    clearTimer();
    if (autoStart && state.status === 'running') {
      timer = setInterval(() => advance(intervalMs / 1000), intervalMs);
    }
  }

  function completeIfTargetReached(nodes) {
    const target = nodes.find((node) => node.id === state.targetNodeId);
    if (!target || target.tmaCm + EPSILON < state.targetThresholdCm) return false;
    state = { ...state, status: 'completed' };
    clearTimer();
    pendingEvents = [];
    return true;
  }

  function start(scenario, requestedSpeedMultiplier = DEFAULT_SPEED_MULTIPLIER) {
    const profile = validateScenario(scenario);
    const speedMultiplier = validateSpeedMultiplier(requestedSpeedMultiplier);
    clearTimer();
    storageRiseCm = Array(NODE_REGISTRY.length).fill(0);
    pendingEvents = [];
    runCounter += 1;
    state = {
      ...makeInitialState(),
      runId: `ciliwung-${Date.now()}-${runCounter}`,
      scenario: profile.id,
      status: 'running',
      speedMultiplier,
      targetNodeId: profile.targetNodeId,
      targetThresholdCm: profile.targetThresholdCm,
    };
    const snapshot = publish();
    setRunningTimer();
    return snapshot;
  }

  function schedulePropagation(event) {
    const nextIndex = event.nodeIndex + 1;
    if (nextIndex >= NODE_REGISTRY.length) return;
    pendingEvents.push({
      nodeIndex: nextIndex,
      arrivalTimeSeconds: event.arrivalTimeSeconds + REACH_DELAY_SECONDS[event.nodeIndex],
      incrementCm: event.incrementCm * REACH_ATTENUATION[event.nodeIndex],
    });
  }

  function advance(dtSeconds) {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) throw new RangeError('dtSeconds must be positive');
    if (state.status !== 'running') return clone(state);

    const profile = SCENARIO_PROFILES[state.scenario];
    const effectiveDtSeconds = dtSeconds * state.speedMultiplier;
    const startTime = state.simTimeSeconds;
    const endTime = startTime + effectiveDtSeconds;

    for (let nodeIndex = 0; nodeIndex < NODE_REGISTRY.length; nodeIndex += 1) {
      const localIncrement = profile.localRiseCmPerSecond[nodeIndex] * effectiveDtSeconds;
      if (localIncrement > 0) {
        pendingEvents.push({ nodeIndex, arrivalTimeSeconds: startTime, incrementCm: localIncrement });
      }
    }

    pendingEvents.sort((a, b) => a.arrivalTimeSeconds - b.arrivalTimeSeconds || a.nodeIndex - b.nodeIndex);
    const futureEvents = [];
    const dueEvents = [];
    for (const event of pendingEvents) {
      if (event.arrivalTimeSeconds <= endTime + EPSILON) dueEvents.push(event);
      else futureEvents.push(event);
    }
    pendingEvents = futureEvents;

    while (dueEvents.length > 0) {
      dueEvents.sort((a, b) => a.arrivalTimeSeconds - b.arrivalTimeSeconds || a.nodeIndex - b.nodeIndex);
      const event = dueEvents.shift();
      storageRiseCm[event.nodeIndex] += Math.max(0, event.incrementCm);
      const downstream = event.nodeIndex + 1 < NODE_REGISTRY.length
        ? {
            nodeIndex: event.nodeIndex,
            arrivalTimeSeconds: event.arrivalTimeSeconds,
            incrementCm: event.incrementCm,
          }
        : null;
      if (downstream) {
        const nextIndex = downstream.nodeIndex + 1;
        const propagated = {
          nodeIndex: nextIndex,
          arrivalTimeSeconds: downstream.arrivalTimeSeconds + REACH_DELAY_SECONDS[downstream.nodeIndex],
          incrementCm: downstream.incrementCm * REACH_ATTENUATION[downstream.nodeIndex],
        };
        if (propagated.arrivalTimeSeconds <= endTime + EPSILON) dueEvents.push(propagated);
        else pendingEvents.push(propagated);
      }
    }

    state = { ...state, simTimeSeconds: endTime };
    const nodes = buildNodes(storageRiseCm);
    state = {
      ...state,
      cupNodes: nodes,
      threeDNodes: nodes.filter((node) => node.threeDNodeId),
    };
    completeIfTargetReached(nodes);
    return publish();
  }

  function setSpeedMultiplier(requestedSpeedMultiplier) {
    const speedMultiplier = validateSpeedMultiplier(requestedSpeedMultiplier);
    state = { ...state, speedMultiplier };
    return publish();
  }

  function stop() {
    clearTimer();
    if (state.status === 'running') state = { ...state, status: 'stopped' };
    return publish();
  }

  function reset() {
    clearTimer();
    storageRiseCm = Array(NODE_REGISTRY.length).fill(0);
    pendingEvents = [];
    state = makeInitialState();
    return publish();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    listener(clone(state));
    return () => listeners.delete(listener);
  }

  function getState() {
    return clone(state);
  }

  function getCupCarbonCommands() {
    return state.cupNodes.map((node) => ({
      type: 'node_update',
      runId: state.runId,
      nodeId: node.id,
      cupcarbonNodeId: node.cupcarbonNodeId,
      tmaCm: node.tmaCm,
      status: node.status,
      simTimeSeconds: state.simTimeSeconds,
    }));
  }

  return {
    start,
    advance,
    setSpeedMultiplier,
    stop,
    reset,
    subscribe,
    getState,
    getCupCarbonCommands,
    get scenarioProfiles() { return clone(SCENARIO_PROFILES); },
    get nodeRegistry() { return clone(NODE_REGISTRY); },
  };
}
