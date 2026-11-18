export const REQUIRED_NODE_IDS = Object.freeze(['UP1', 'UP2', 'UP3', 'UP4', 'N1', 'N2', 'N3', 'N4', 'N5']);

function normalizedNodeIds(nodeIds) {
  const ids = nodeIds ?? REQUIRED_NODE_IDS;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new TypeError('nodeIds must be a non-empty string array');
  }
  return ids;
}

export function backendSnapshotToStages(snapshot, nodeIds = REQUIRED_NODE_IDS) {
  const requiredNodeIds = normalizedNodeIds(nodeIds);
  if (!snapshot || !Array.isArray(snapshot.threeDNodes)) {
    throw new TypeError('backend snapshot must contain threeDNodes');
  }
  const byId = new Map(snapshot.threeDNodes.map((node) => [node.id, node]));
  const missing = requiredNodeIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new RangeError(`backend snapshot is missing ${requiredNodeIds.join(' through ')} nodes: ${missing.join(', ')}`);
  return requiredNodeIds.map((id) => {
    const value = byId.get(id).stageRiseM;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`invalid stageRiseM for ${id}`);
    return value;
  });
}

export function applyBackendSnapshot(sceneApp, snapshot, nodeIds = REQUIRED_NODE_IDS) {
  if (!sceneApp || typeof sceneApp.setWaterStages !== 'function' || typeof sceneApp.updateFlowParticles !== 'function') {
    throw new TypeError('sceneApp must expose setWaterStages and updateFlowParticles');
  }
  const stages = backendSnapshotToStages(snapshot, nodeIds);
  const averageRunoff = stages.reduce((sum, value) => sum + value, 0) / stages.length;
  sceneApp.setWaterStages(stages);
  sceneApp.updateFlowParticles(Number(snapshot.simTimeSeconds) || 0, averageRunoff);
  return stages;
}

function validateForecast(value) {
  if (!value || (value.status !== 'available' && value.status !== 'unavailable') ||
      (value.mode !== 'synthetic_demo' && !(value.status === 'unavailable' && value.mode == null))) {
    throw new TypeError('unsupported backend forecast');
  }
  // The backend's pending/unavailable SSE deliberately omits mode, but keeps
  // runId, nodeId and the simulation issue time for safe replacement ordering.
  if (value.status === 'unavailable') {
    if (!Number.isFinite(Date.parse(value.issuedAt))) throw new TypeError('backend forecast needs a simulation issue time');
    return;
  }
  if (value.clockBasis !== 'simulation' || !Number.isFinite(Date.parse(value.issuedAt))) {
    throw new TypeError('backend forecast needs a simulation issue time');
  }
  for (const horizon of ['30', '60']) {
    const level = value.predictedTmaCm?.[horizon];
    const crossing = value.crossingWithin?.[horizon];
    const noThreshold = value.nodeId === 'UP1';
    if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 ||
        (noThreshold ? value.thresholdBanjirCm !== null || crossing !== null
          : typeof value.thresholdBanjirCm !== 'number' || !Number.isFinite(value.thresholdBanjirCm) || value.thresholdBanjirCm <= 0 || typeof crossing !== 'boolean')) {
      throw new TypeError(`invalid +${horizon} backend forecast`);
    }
  }
}

export function createBackendSimulationClient({ eventSourceFactory = (url) => new EventSource(url), onSnapshot = () => {}, onForecast, onError = () => {}, nodeIds = REQUIRED_NODE_IDS } = {}) {
  const requiredNodeIds = normalizedNodeIds(nodeIds);
  let source = null;
  let runId = null;
  let running = false;
  const forecasts = new Map();

  function connect(url) {
    if (typeof url !== 'string' || url.length === 0) throw new TypeError('backend stream URL is required');
    close();
    source = eventSourceFactory(url);
    if (!source || typeof source.addEventListener !== 'function') throw new TypeError('eventSourceFactory must return an EventSource-like object');
    const connectedSource = source;
    source.addEventListener('state', (event) => {
      if (source !== connectedSource) return;
      try {
        const snapshot = JSON.parse(event.data);
        backendSnapshotToStages(snapshot, requiredNodeIds);
        if (snapshot.runId !== runId || snapshot.status !== 'running') forecasts.clear();
        runId = snapshot.runId;
        running = snapshot.status === 'running';
        onSnapshot(snapshot);
      } catch (error) {
        onError(error);
      }
    });
    if (typeof onForecast === 'function') {
      source.addEventListener('forecast', (event) => {
        if (source !== connectedSource) return;
        try {
          const value = JSON.parse(event.data);
          if (!running || !runId || value.runId !== runId || !requiredNodeIds.includes(value.nodeId)) return;
          validateForecast(value);
          const previous = forecasts.get(value.nodeId);
          if (previous && Date.parse(value.issuedAt) < Date.parse(previous.issuedAt)) return;
          forecasts.set(value.nodeId, value);
          onForecast(value);
        } catch (error) {
          onError(error);
        }
      });
    }
    source.onerror = (error) => {
      if (source !== connectedSource) return;
      runId = null;
      running = false;
      forecasts.clear();
      if (typeof onForecast === 'function') onForecast(null);
      onError(error instanceof Error ? error : new Error('backend simulation stream disconnected'));
    };
    return source;
  }

  function close() {
    const hadForecast = forecasts.size > 0;
    if (source && typeof source.close === 'function') source.close();
    source = null;
    runId = null;
    running = false;
    forecasts.clear();
    if (hadForecast && typeof onForecast === 'function') onForecast(null);
  }

  return { connect, close, get source() { return source; }, getForecast(nodeId) { return forecasts.get(nodeId) ?? null; } };
}
