const EPSILON = 1e-9;

function validateConfig(config) {
  if (!config || !Array.isArray(config.nodeIds) || config.nodeIds.length < 2) {
    throw new TypeError('config.nodeIds must contain at least two ordered stations');
  }
  const edges = config.nodeIds.length - 1;
  if (!Array.isArray(config.reachLagSeconds) || config.reachLagSeconds.length !== edges) {
    throw new TypeError('reachLagSeconds must contain one value per downstream reach');
  }
  if (!Array.isArray(config.attenuation) || config.attenuation.length !== edges) {
    throw new TypeError('attenuation must contain one value per downstream reach');
  }
  if (config.reachLagSeconds.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('reach travel times must be finite positive seconds');
  }
  if (config.attenuation.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RangeError('reach attenuation must be between zero and one');
  }
  for (const [key, value] of Object.entries({
    runoffCoefficient: config.runoffCoefficient,
    stageMetersPerRunoffMillimeter: config.stageMetersPerRunoffMillimeter,
    recessionTimeSeconds: config.recessionTimeSeconds,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be finite and non-negative`);
  }
  if (config.recessionTimeSeconds === 0) throw new RangeError('recessionTimeSeconds must be greater than zero');
}

export function createHydrologyState(config) {
  validateConfig(config);
  const count = config.nodeIds.length;
  return {
    timeSeconds: 0,
    storageRunoffMm: Array(count).fill(0),
    pendingEvents: [],
    latestInflows: Array(count).fill(0),
  };
}

export function resetHydrology(state) {
  if (!state || !Array.isArray(state.storageRunoffMm)) throw new TypeError('invalid hydrology state');
  state.timeSeconds = 0;
  state.storageRunoffMm.fill(0);
  state.pendingEvents.length = 0;
  state.latestInflows.fill(0);
  return state;
}

/**
 * Advance the conceptual five-reach runoff cascade.
 * Rainfall is in mm/hour. The internal storage is runoff-equivalent mm, not
 * measured river discharge. Stage conversion and reach attenuation are demo
 * parameters and must be calibrated before any real-world interpretation.
 */
export function stepHydrology(state, rainfallMmPerHour, dtSeconds, config) {
  validateConfig(config);
  if (!state || state.storageRunoffMm?.length !== config.nodeIds.length) {
    throw new TypeError('state does not match the configured station chain');
  }
  if (!Array.isArray(rainfallMmPerHour) || rainfallMmPerHour.length !== config.nodeIds.length) {
    throw new TypeError('rainfallMmPerHour must have one value per station catchment');
  }
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) throw new RangeError('dtSeconds must be positive');
  for (const rain of rainfallMmPerHour) {
    if (!Number.isFinite(rain)) throw new TypeError('rainfall inputs must be finite numbers');
  }

  const start = state.timeSeconds;
  const end = start + dtSeconds;
  const decay = Math.exp(-dtSeconds / config.recessionTimeSeconds);
  for (let i = 0; i < state.storageRunoffMm.length; i += 1) {
    state.storageRunoffMm[i] *= decay;
    state.latestInflows[i] = 0;
  }

  const due = [];
  const future = [];
  for (const event of state.pendingEvents) {
    if (event.arrivalTimeSeconds < end - EPSILON) due.push(event);
    else future.push(event);
  }
  state.pendingEvents = future;

  rainfallMmPerHour.forEach((rain, nodeIndex) => {
    const pulse = Math.max(0, rain) * dtSeconds / 3600 * config.runoffCoefficient;
    if (pulse > 0) due.push({ nodeIndex, arrivalTimeSeconds: start, runoffMm: pulse });
  });
  due.sort((a, b) => a.arrivalTimeSeconds - b.arrivalTimeSeconds || a.nodeIndex - b.nodeIndex);

  while (due.length > 0) {
    const event = due.shift();
    state.storageRunoffMm[event.nodeIndex] += event.runoffMm;
    state.latestInflows[event.nodeIndex] += event.runoffMm;

    const nextIndex = event.nodeIndex + 1;
    if (nextIndex < config.nodeIds.length) {
      const downstream = {
        nodeIndex: nextIndex,
        arrivalTimeSeconds: event.arrivalTimeSeconds + config.reachLagSeconds[event.nodeIndex],
        runoffMm: event.runoffMm * config.attenuation[event.nodeIndex],
      };
      if (downstream.arrivalTimeSeconds < end - EPSILON) {
        due.push(downstream);
        due.sort((a, b) => a.arrivalTimeSeconds - b.arrivalTimeSeconds || a.nodeIndex - b.nodeIndex);
      } else {
        state.pendingEvents.push(downstream);
      }
    }
  }

  state.timeSeconds = end;
  return {
    timeSeconds: state.timeSeconds,
    nodes: config.nodeIds.map((id, index) => ({
      id,
      runoffIndex: state.storageRunoffMm[index],
      inflowRunoffMm: state.latestInflows[index],
      stageRiseM: state.storageRunoffMm[index] * config.stageMetersPerRunoffMillimeter,
    })),
    pendingReachCount: state.pendingEvents.length,
  };
}

export function validateRainfallNetwork(config) {
  validateConfig(config);
  return config.nodeIds.length === 5 && config.reachLagSeconds.length === 4;
}
