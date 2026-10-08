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

function writeSse(response, state) {
  response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

export function registerCiliwungRoutes(app, { engine, sendCupCarbon = (_state) => {} }) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') throw new TypeError('an Express-like app is required');
  if (!engine || typeof engine.getState !== 'function' || typeof engine.subscribe !== 'function') throw new TypeError('a Ciliwung engine is required');

  const clients = new Set();
  const unsubscribe = engine.subscribe((state) => {
    sendCupCarbon(state);
    for (const response of clients) {
      try {
        writeSse(response, state);
      } catch {
        clients.delete(response);
      }
    }
  });

  app.get('/api/ciliwung-simulation/scenarios', (_request, response) => {
    response.json(Object.values(engine.scenarioProfiles).map(safeScenarioProfile));
  });

  app.get('/api/ciliwung-simulation/state', (_request, response) => {
    response.json(engine.getState());
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
    writeSse(response, engine.getState());
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
      unsubscribe();
      clients.clear();
    },
    clients,
  };
}
