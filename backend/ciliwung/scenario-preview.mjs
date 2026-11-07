import { NODE_REGISTRY } from './simulation-engine.mjs';

const STEP_SECONDS = 300;
const DAY_STEPS = 288;
const HISTORY_STEPS = 96;
const ISSUE_INDEX = 160;
const STAGE_GAIN_CM_PER_MM = 8.0;
const STORAGE_DECAY_PER_BIN = 0.963;
const CAPTURE_FRACTION = 0.85;
const REACH_DELAYS_BINS = [3, 4, 5, 6, 7, 8, 9, 10];
const REACH_ATTENUATION = 0.82;
const NODE_IDS = NODE_REGISTRY.map(({ id }) => id);
const NODE_INDEX = new Map(NODE_IDS.map((id, index) => [id, index]));
const PREVIEW_START_MS = Date.parse('2026-06-01T00:00:00Z');

// These are explicit synthetic event totals per catchment, not BMKG categories.
export const SCENARIO_PREVIEW_PROFILES = Object.freeze([
  Object.freeze({
    id: 'ringan', label: 'Hujan Ringan',
    rainfallDepthMmPerCatchment: Object.freeze({ UP1: 8, N5: 7 }),
    storms: Object.freeze([{ nodeId: 'UP1', depthMm: 8, onsetIndex: 120 }, { nodeId: 'N5', depthMm: 7, onsetIndex: 138 }]),
  }),
  Object.freeze({
    id: 'sedang', label: 'Hujan Sedang',
    rainfallDepthMmPerCatchment: Object.freeze({ UP1: 20, UP2: 15, N1: 8, N5: 10 }),
    storms: Object.freeze([
      { nodeId: 'UP1', depthMm: 20, onsetIndex: 120 }, { nodeId: 'UP2', depthMm: 15, onsetIndex: 126 },
      { nodeId: 'N1', depthMm: 8, onsetIndex: 130 }, { nodeId: 'N5', depthMm: 10, onsetIndex: 138 },
    ]),
  }),
  Object.freeze({
    id: 'lebat', label: 'Hujan Lebat',
    rainfallDepthMmPerCatchment: Object.freeze({ UP2: 35, UP4: 20, N1: 12, N5: 18 }),
    storms: Object.freeze([
      { nodeId: 'UP2', depthMm: 35, onsetIndex: 120 }, { nodeId: 'UP4', depthMm: 20, onsetIndex: 128 },
      { nodeId: 'N1', depthMm: 12, onsetIndex: 130 }, { nodeId: 'N5', depthMm: 18, onsetIndex: 134 },
    ]),
  }),
]);

function pulseRate(depthMm, onsetIndex, length = 36) {
  const width = length / 4;
  const shape = Array.from({ length: DAY_STEPS }, (_, index) => {
    if (index < onsetIndex || index >= onsetIndex + length + 10) return 0;
    return Math.exp(-0.5 * (((index - onsetIndex - length * 0.45) / width) ** 2));
  });
  const sum = shape.reduce((total, value) => total + value, 0);
  if (sum <= 0) throw new RangeError('Synthetic storm pulse is empty');
  return shape.map((value) => value * 12 * depthMm / sum);
}

function makeRainSeries(profile) {
  const rain = Object.fromEntries(NODE_IDS.map((nodeId) => [nodeId, Array(DAY_STEPS).fill(0)]));
  for (const storm of profile.storms) {
    const series = pulseRate(storm.depthMm, storm.onsetIndex);
    for (let index = 0; index < DAY_STEPS; index += 1) rain[storm.nodeId][index] += series[index];
  }
  return rain;
}

function routeSyntheticLevels(rain) {
  const storage = {};
  for (const nodeId of NODE_IDS) {
    const series = [];
    let state = 0;
    for (const rate of rain[nodeId]) {
      state = STORAGE_DECAY_PER_BIN * state + CAPTURE_FRACTION * rate / 12;
      series.push(STAGE_GAIN_CM_PER_MM * state);
    }
    storage[nodeId] = series;
  }

  const levels = {};
  for (const destinationId of NODE_IDS) {
    const destinationIndex = NODE_INDEX.get(destinationId);
    const registryNode = NODE_REGISTRY[destinationIndex];
    const series = Array(DAY_STEPS).fill(registryNode.baselineTmaCm);
    for (let sourceIndex = 0; sourceIndex <= destinationIndex; sourceIndex += 1) {
      const lag = REACH_DELAYS_BINS.slice(sourceIndex, destinationIndex).reduce((sum, value) => sum + value, 0);
      const attenuation = REACH_ATTENUATION ** (destinationIndex - sourceIndex);
      for (let index = lag; index < DAY_STEPS; index += 1) {
        series[index] += storage[NODE_IDS[sourceIndex]][index - lag] * attenuation;
      }
    }
    levels[destinationId] = series.map((value) => Math.max(0, value));
  }
  return levels;
}

function timestampAt(index) {
  return new Date(PREVIEW_START_MS + index * STEP_SECONDS * 1000).toISOString().replace('.000Z', 'Z');
}

export function buildScenarioPreviewHistory(scenarioId, nodeId) {
  const profile = SCENARIO_PREVIEW_PROFILES.find((candidate) => candidate.id === scenarioId);
  if (!profile) throw new RangeError(`Unsupported rainfall scenario: ${scenarioId}`);
  const targetIndex = NODE_INDEX.get(nodeId);
  if (targetIndex === undefined) throw new RangeError(`Unsupported forecast nodeId: ${nodeId}`);

  const rain = makeRainSeries(profile);
  const levels = routeSyntheticLevels(rain);
  const upstreamNodeId = NODE_IDS[Math.max(0, targetIndex - 1)];
  const firstIndex = ISSUE_INDEX - HISTORY_STEPS + 1;
  const history = Array.from({ length: HISTORY_STEPS }, (_, offset) => {
    const index = firstIndex + offset;
    return {
      timestampUtc: timestampAt(index),
      tmaCm: levels[nodeId][index],
      rainRateMmH: rain[nodeId][index],
      upstreamTmaCm: levels[upstreamNodeId][index],
      upstreamRainRateMmH: rain[upstreamNodeId][index],
    };
  });

  return {
    scenarioId: profile.id,
    label: profile.label,
    nodeId,
    issueIndex: ISSUE_INDEX,
    issuedAt: history.at(-1).timestampUtc,
    currentSyntheticTmaCm: history.at(-1).tmaCm,
    rainfallDepthMmPerCatchment: { ...profile.rainfallDepthMmPerCatchment },
    history,
  };
}
