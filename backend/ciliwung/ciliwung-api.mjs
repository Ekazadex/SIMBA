import { listEpisodes as listGeneratedEpisodes, loadEpisode as loadGeneratedEpisode } from './rain-replay.mjs';
import { NODE_REGISTRY } from './simulation-engine.mjs';
import { buildScenarioPreviewHistory, SCENARIO_PREVIEW_PROFILES } from './scenario-preview.mjs';

const FORECAST_NODES = NODE_REGISTRY.map(({ id }) => id);

function safeScenarioProfile(profile) {
  return {
    id: profile.id,
    label: profile.label,
    description: profile.description,
    targetNodeId: profile.targetNodeId,
    targetThresholdCm: profile.targetThresholdCm,
    localRiseCmPerSecond: [...profile.localRiseCmPerSecond],
  };
}

function sendJson(response, statusCode, payload) {
  if (typeof response.status === 'function') return response.status(statusCode).json(payload);
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function writeSse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function registerCiliwungRoutes(app, {
  engine, sendCupCarbon = (_state) => {}, sendForecastCupCarbon = (_command) => {},
  worker = null, listEpisodes = listGeneratedEpisodes, loadEpisode = loadGeneratedEpisode,
}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new TypeError('an Express-like app is required');
  if (!engine || typeof engine.getState !== 'function' || typeof engine.subscribe !== 'function') throw new TypeError('a Ciliwung engine is required');

  const clients = new Set();
  const forecasts = new Map();
  let activeRunId = engine.getState().runId;
  let activeIssuedAt = engine.getState().timestampUtc;
  let activeStatus = engine.getState().status;
  let disposed = false;

  function publishForecast(forecast) {
    if (disposed) return;
    forecasts.set(forecast.nodeId, forecast);
    for (const response of clients) {
      try { writeSse(response, 'forecast', forecast); }
      catch { clients.delete(response); }
    }
    if (forecast.status === 'available') sendForecastCupCarbon({
      type: 'forecast_update', runId: forecast.runId, nodeId: forecast.nodeId,
      issuedAt: forecast.issuedAt, predictedTmaCm: forecast.predictedTmaCm,
      crossingWithin: forecast.crossingWithin, thresholdBanjirCm: forecast.thresholdBanjirCm,
      status: 'available', quality: 'experimental_synthetic_only',
    });
  }

  function retireForecasts() {
    forecasts.clear();
    for (const nodeId of FORECAST_NODES) {
      publishForecast({ runId: null, nodeId, status: 'unavailable', reason: 'no_active_replay' });
      sendForecastCupCarbon({ type: 'forecast_update', runId: null, nodeId, status: 'unavailable' });
    }
  }

  async function predictFrame(state, nodeId) {
    const { runId, timestampUtc: issuedAt } = state;
    const registryNode = NODE_REGISTRY.find((node) => node.id === nodeId);
    const thresholdBanjirCm = registryNode && Number.isFinite(registryNode.thresholds.banjir)
      ? registryNode.thresholds.banjir : null;
    const history = engine.getReplayHistory(nodeId);
    try {
      if (!registryNode) throw new Error('unmapped_station');
      if (history.length !== 96) throw new Error('insufficient_history');
      if (!worker) throw new Error('model_unavailable');
      const result = await worker.predict({ runId, nodeId, issuedAt, history });
      const current = engine.getState();
      if (disposed || current.runId !== runId || current.timestampUtc !== issuedAt || current.status !== 'running') return;
      const levels = result.levelsCm;
      if (result.runId !== runId || result.nodeId !== nodeId ||
          !Array.isArray(levels) || levels.length !== 12 || levels.some((level) => !Number.isFinite(level) || level < 0) ||
          typeof result.method !== 'string' || !result.method || typeof result.modelVersion !== 'string' || !result.modelVersion) {
        throw new Error('invalid_worker_response');
      }
      const currentLevel = current.cupNodes.find((node) => node.id === nodeId).tmaCm;
      publishForecast({
        runId, nodeId, mode: 'synthetic_demo', issuedAt, generatedAt: new Date().toISOString(),
        clockBasis: 'simulation', horizonsMinutes: [30, 60],
        predictedTmaCm: { '30': levels[5], '60': levels[11] },
        crossingWithin: { '30': thresholdBanjirCm === null ? null : levels.slice(0, 6).some((level) => level >= thresholdBanjirCm),
          '60': thresholdBanjirCm === null ? null : levels.some((level) => level >= thresholdBanjirCm) },
        trajectoryCm: [...levels], thresholdBanjirCm,
        alreadyAboveThreshold: thresholdBanjirCm === null ? null : currentLevel >= thresholdBanjirCm,
        inputProvenance: { rain: 'synthetic', tma: 'synthetic', bmkgContext: 'none',
          upstreamFeature: nodeId === 'UP1' ? 'self_proxy_no_upstream_gauge' : 'synthetic_upstream_node' },
        method: result.method, modelVersion: result.modelVersion,
        quality: 'experimental_synthetic_only', status: 'available',
      });
    } catch (error) {
      const current = engine.getState();
      if (!disposed && current.runId === runId && current.timestampUtc === issuedAt && current.status === 'running') {
        publishForecast({ runId, nodeId, issuedAt, status: 'unavailable', reason: error.reason || error.message || 'worker_unavailable' });
      }
    }
  }

  const unsubscribe = engine.subscribe((state, metadata = {}) => {
    if (metadata.sendCupCarbon !== false) sendCupCarbon(state);
    for (const response of clients) {
      try { writeSse(response, 'state', state); }
      catch { clients.delete(response); }
    }
    if (state.runId !== activeRunId || (state.status !== activeStatus && state.status !== 'running')) retireForecasts();
    const newReplayBin = state.scenario === 'rain_replay' && state.status === 'running' &&
      (state.runId !== activeRunId || state.timestampUtc !== activeIssuedAt);
    activeRunId = state.runId;
    activeIssuedAt = state.timestampUtc;
    activeStatus = state.status;
    if (newReplayBin) {
      for (const nodeId of FORECAST_NODES) {
        if (forecasts.get(nodeId)?.status === 'available') {
          sendForecastCupCarbon({ type: 'forecast_update', runId: null, nodeId, status: 'unavailable' });
        }
        publishForecast({ runId: state.runId, nodeId, issuedAt: state.timestampUtc, status: 'unavailable', reason: 'pending' });
        void predictFrame(state, nodeId);
      }
    }
  });

  app.get('/api/ciliwung-simulation/scenarios', (_request, response) => {
    response.json(Object.values(engine.scenarioProfiles).map(safeScenarioProfile));
  });

  app.get('/api/ciliwung-simulation/state', (_request, response) => {
    response.json(engine.getState());
  });

  app.get('/api/ciliwung-simulation/history', (_request, response) => {
    response.json(engine.getChartHistory());
  });

  app.get('/api/ciliwung-simulation/projection', (request, response) => {
    const nodeId = request.query?.nodeId;
    if (!FORECAST_NODES.includes(nodeId)) return sendJson(response, 400, { error: 'unsupported_node' });
    return response.json(engine.getLegacyProjection(nodeId));
  });

  app.get('/api/ciliwung-simulation/scenario-previews', async (request, response) => {
    const nodeId = request.query?.nodeId;
    if (!FORECAST_NODES.includes(nodeId)) return sendJson(response, 400, { error: `Unsupported forecast nodeId; use ${FORECAST_NODES.join(', ')}` });
    if (!worker) return sendJson(response, 503, { error: 'model_unavailable' });
    try {
      const previews = await Promise.all(SCENARIO_PREVIEW_PROFILES.map(async (profile) => {
        const input = buildScenarioPreviewHistory(profile.id, nodeId);
        const runId = `scenario-preview-${profile.id}-${nodeId}`;
        const result = await worker.predict({ runId, nodeId, issuedAt: input.issuedAt, history: input.history });
        if (result.runId !== runId || result.nodeId !== nodeId || !Array.isArray(result.levelsCm)
            || result.levelsCm.length !== 12 || result.levelsCm.some((level) => !Number.isFinite(level) || level < 0)
            || typeof result.method !== 'string' || !result.method
            || typeof result.modelVersion !== 'string' || !result.modelVersion) {
          throw new Error('invalid_worker_response');
        }
        const trajectoryCm = result.levelsCm.map((level) => Number(level.toFixed(3)));
        return {
          scenarioId: input.scenarioId, label: input.label, nodeId,
          issuedAt: input.issuedAt, issueIndex: input.issueIndex,
          currentSyntheticTmaCm: Number(input.currentSyntheticTmaCm.toFixed(2)),
          rainfallDepthMmPerCatchment: input.rainfallDepthMmPerCatchment,
          predictedTmaCm: { '30': Number(result.levelsCm[5].toFixed(2)), '60': Number(result.levelsCm[11].toFixed(2)) },
          trajectoryCm, method: result.method, modelVersion: result.modelVersion,
          quality: 'experimental_synthetic_only',
        };
      }));
      return response.json({
        nodeId, datasetVersion: 'synthetic_v2', stepSeconds: 300,
        historySteps: 96, horizonSteps: 12,
        quality: 'experimental_synthetic_only', previews,
      });
    } catch (error) {
      return sendJson(response, 503, { error: error.reason || error.message || 'model_unavailable' });
    }
  });

  app.get('/api/ciliwung-simulation/episodes', async (_request, response) => {
    try { return response.json(await listEpisodes()); }
    catch (error) { return sendJson(response, 500, { error: error.message }); }
  });

  app.get('/api/ciliwung-forecast/latest', (request, response) => {
    const nodeId = request.query?.nodeId;
    if (!FORECAST_NODES.includes(nodeId)) return sendJson(response, 400, { error: `Unsupported forecast nodeId; use ${FORECAST_NODES.join(', ')}` });
    return response.json(forecasts.get(nodeId) || { nodeId, runId: null, status: 'unavailable', reason: 'no_active_replay' });
  });

  app.get('/api/ciliwung-simulation/stream', (request, response) => {
    const headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no-cache',
    };
    if (typeof response.writeHead === 'function') response.writeHead(200, headers);
    else {
      for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
      response.flushHeaders?.();
    }
    clients.add(response);
    writeSse(response, 'state', engine.getState());
    for (const nodeId of FORECAST_NODES) {
      if (forecasts.has(nodeId)) writeSse(response, 'forecast', forecasts.get(nodeId));
    }
    request.on?.('close', () => {
      clients.delete(response);
    });
  });

  app.post('/api/ciliwung-simulation/start', (request, response) => {
    try {
      const state = engine.start(request.body?.scenario, request.body?.speedMultiplier);
      return response.json({ success: true, state });
    } catch (error) {
      return sendJson(response, 400, { success: false, error: error.message });
    }
  });

  app.post('/api/ciliwung-simulation/replay/start', async (request, response) => {
    try {
      const { episodeId, speedMultiplier } = request.body || {};
      if (typeof episodeId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(episodeId)) throw new RangeError('Invalid episode ID');
      const episode = await loadEpisode(episodeId);
      const state = engine.startReplay(episode, speedMultiplier);
      return response.json({ success: true, state });
    } catch (error) {
      return sendJson(response, error instanceof RangeError ? 400 : 500, { success: false, error: error.message });
    }
  });

  app.post('/api/ciliwung-simulation/speed', (request, response) => {
    try {
      const state = engine.setSpeedMultiplier(request.body?.speedMultiplier);
      return response.json({ success: true, state });
    } catch (error) {
      return sendJson(response, 400, { success: false, error: error.message });
    }
  });

  app.post('/api/ciliwung-simulation/stop', (_request, response) => {
    response.json({ success: true, state: engine.stop() });
  });

  app.post('/api/ciliwung-simulation/reset', (_request, response) => {
    response.json({ success: true, state: engine.reset() });
  });

  return {
    unsubscribe() {
      disposed = true;
      unsubscribe();
      clients.clear();
    },
    clients,
  };
}
