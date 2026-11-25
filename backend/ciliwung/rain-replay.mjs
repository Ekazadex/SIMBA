import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { NODE_REGISTRY } from './simulation-engine.mjs';

const NODE_IDS = new Set(NODE_REGISTRY.map(({ id }) => id));
const NODE_ORDER = NODE_REGISTRY.map(({ id }) => id);
const DEFAULT_EPISODE_DIRECTORY = typeof import.meta?.url === 'string' && import.meta.url
  ? fileURLToPath(new URL('../../ml/data/generated/synthetic_v2/episodes/', import.meta.url))
  : join(process.cwd(), 'ml', 'data', 'generated', 'synthetic_v2', 'episodes');

const STEP_SECONDS = 300;
const DAY_STEPS = 288;
const REACH_DELAYS_BINS = [3, 4, 5, 6, 7, 8, 9, 10];
const REACH_ATTENUATION = 0.82;

const BUILTIN_EPISODE_SPECS = {
  'compound-012': {
    label: 'Compound Upstream + Local (compound-012)',
    startTimeUtc: '2026-06-12T00:00:00Z',
    gain: 8.2,
    decay: 0.964,
    storms: [
      { nodeId: 'UP1', depthMm: 26, onsetIndex: 108, length: 34 },
      { nodeId: 'UP2', depthMm: 22, onsetIndex: 118, length: 32 },
      { nodeId: 'N1', depthMm: 14, onsetIndex: 132, length: 28 },
      { nodeId: 'N5', depthMm: 18, onsetIndex: 144, length: 32 },
    ],
  },
  'upstream_delayed-004': {
    label: 'Upstream Delayed Surge (upstream_delayed-004)',
    startTimeUtc: '2026-06-04T00:00:00Z',
    gain: 8.5,
    decay: 0.968,
    storms: [
      { nodeId: 'UP1', depthMm: 34, onsetIndex: 102, length: 36 },
      { nodeId: 'UP2', depthMm: 28, onsetIndex: 112, length: 32 },
    ],
  },
  'local_intense-007': {
    label: 'Local Intense Depok-Jakarta (local_intense-007)',
    startTimeUtc: '2026-06-07T00:00:00Z',
    gain: 7.9,
    decay: 0.958,
    storms: [
      { nodeId: 'N1', depthMm: 24, onsetIndex: 120, length: 24 },
      { nodeId: 'N3', depthMm: 20, onsetIndex: 128, length: 24 },
      { nodeId: 'N5', depthMm: 25, onsetIndex: 136, length: 26 },
    ],
  },
  'ringan_hulu-001': {
    label: 'Light Upstream Rain (ringan_hulu-001)',
    startTimeUtc: '2026-06-01T00:00:00Z',
    gain: 7.4,
    decay: 0.955,
    storms: [
      { nodeId: 'UP1', depthMm: 9, onsetIndex: 115, length: 30 },
      { nodeId: 'UP2', depthMm: 6, onsetIndex: 125, length: 26 },
    ],
  },
  'false_positive-003': {
    label: 'Short Peak Non-Flood (false_positive-003)',
    startTimeUtc: '2026-06-03T00:00:00Z',
    gain: 7.0,
    decay: 0.945,
    storms: [
      { nodeId: 'UP1', depthMm: 14, onsetIndex: 120, length: 18 },
      { nodeId: 'N1', depthMm: 9, onsetIndex: 130, length: 18 },
    ],
  },
};

function generateBuiltinEpisode(episodeId) {
  const spec = BUILTIN_EPISODE_SPECS[episodeId];
  if (!spec) return null;

  const rainByNode = Object.fromEntries(NODE_ORDER.map((id) => [id, Array(DAY_STEPS).fill(0)]));
  for (const storm of spec.storms) {
    const width = storm.length / 4;
    const shape = Array.from({ length: DAY_STEPS }, (_, idx) => {
      if (idx < storm.onsetIndex || idx >= storm.onsetIndex + storm.length + 10) return 0;
      return Math.exp(-0.5 * ((idx - storm.onsetIndex - storm.length * 0.45) / width) ** 2);
    });
    const sum = shape.reduce((acc, v) => acc + v, 0) || 1;
    for (let i = 0; i < DAY_STEPS; i += 1) {
      rainByNode[storm.nodeId][i] += (shape[i] * 12 * storm.depthMm) / sum;
    }
  }

  const storage = {};
  for (const id of NODE_ORDER) {
    let s = 0;
    storage[id] = rainByNode[id].map((rate) => {
      s = spec.decay * s + (0.85 * rate) / 12;
      return spec.gain * s;
    });
  }

  const startMs = Date.parse(spec.startTimeUtc);
  const frames = [];
  for (let i = 0; i < DAY_STEPS; i += 1) {
    const nodes = NODE_REGISTRY.map((reg, dstIdx) => {
      const base = reg.syntheticBaselineTmaCm ?? reg.baselineTmaCm;
      let tma = base;
      for (let srcIdx = 0; srcIdx <= dstIdx; srcIdx += 1) {
        const lag = REACH_DELAYS_BINS.slice(srcIdx, dstIdx).reduce((a, b) => a + b, 0);
        if (i >= lag) {
          tma += storage[NODE_ORDER[srcIdx]][i - lag] * REACH_ATTENUATION ** (dstIdx - srcIdx);
        }
      }
      const rainRateMmH = Number(rainByNode[reg.id][i].toFixed(4));
      const rainMm5m = Number((rainRateMmH / 12).toFixed(4));
      return {
        id: reg.id,
        tmaCm: Number(Math.max(0, tma).toFixed(3)),
        rainRateMmH,
        rainMm5m,
        rainSource: 'synthetic',
        tmaSource: 'synthetic',
      };
    });
    frames.push({
      simTimeSeconds: i * STEP_SECONDS,
      timestampUtc: new Date(startMs + i * STEP_SECONDS * 1000).toISOString().replace('.000Z', 'Z'),
      nodes,
    });
  }

  return {
    version: 'synthetic_v2',
    episodeId,
    startTimeUtc: spec.startTimeUtc,
    nodes: NODE_REGISTRY.map((n) => ({ id: n.id, name: n.name })),
    frames,
  };
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateEpisode(episode) {
  if (!episode || typeof episode !== 'object') throw new RangeError('Invalid episode payload');
  if (!['synthetic_v1', 'synthetic_v2'].includes(episode.version)) throw new RangeError('Invalid episode version');
  if (
    !Array.isArray(episode.nodes) ||
    episode.nodes.length !== NODE_IDS.size ||
    new Set(episode.nodes.map((node) => node.id)).size !== NODE_IDS.size ||
    episode.nodes.some((node) => !NODE_IDS.has(node.id))
  ) {
    throw new RangeError('Invalid episode node registry');
  }
  if (!Array.isArray(episode.frames) || episode.frames.length < 96) {
    throw new RangeError('Invalid episode history (96 steps required)');
  }
  const firstTime = Date.parse(episode.startTimeUtc);
  let firstStep = null;
  for (let index = 0; index < episode.frames.length; index += 1) {
    const frame = episode.frames[index];
    if (index === 0) firstStep = frame?.simTimeSeconds;
    if (
      !Number.isFinite(firstStep) ||
      !Number.isFinite(frame?.simTimeSeconds) ||
      frame.simTimeSeconds !== firstStep + index * 300 ||
      !validTime(frame.timestampUtc) ||
      Date.parse(frame.timestampUtc) !== firstTime + index * 300_000
    ) {
      throw new RangeError(`Invalid episode timestamp at frame ${index}`);
    }
    if (
      !Array.isArray(frame.nodes) ||
      frame.nodes.length !== NODE_IDS.size ||
      new Set(frame.nodes.map((node) => node.id)).size !== NODE_IDS.size ||
      frame.nodes.some((node) => !NODE_IDS.has(node.id))
    ) {
      throw new RangeError(`Invalid episode nodes at frame ${index}`);
    }
    for (const node of frame.nodes) {
      if (!Number.isFinite(node.tmaCm) || node.tmaCm < 0) throw new RangeError(`Invalid episode TMA at frame ${index}`);
      if (
        !Number.isFinite(node.rainRateMmH) ||
        node.rainRateMmH < 0 ||
        !Number.isFinite(node.rainMm5m) ||
        node.rainMm5m < 0 ||
        Math.abs(node.rainRateMmH / 12 - node.rainMm5m) > 0.01
      ) {
        throw new RangeError(`Invalid episode rain at frame ${index}`);
      }
      if (node.rainSource !== 'synthetic' && node.rainSource !== 'synthetic_conditioned_on_daily_rr') {
        throw new RangeError(`Invalid episode rain source at frame ${index}`);
      }
      if (node.tmaSource !== 'synthetic') throw new RangeError(`Invalid episode TMA source at frame ${index}`);
    }
  }
  return episode;
}

export async function listEpisodes(directory = DEFAULT_EPISODE_DIRECTORY) {
  try {
    const files = await readdir(directory);
    const diskEpisodes = files
      .filter((file) => /^[a-zA-Z0-9_-]+\.json$/.test(file))
      .map((file) => ({ episodeId: file.slice(0, -5) }))
      .sort((a, b) => a.episodeId.localeCompare(b.episodeId));
    if (diskEpisodes.length > 0) return diskEpisodes;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return Object.entries(BUILTIN_EPISODE_SPECS).map(([episodeId, spec]) => ({
    episodeId,
    label: spec.label,
  }));
}

export async function loadEpisode(episodeId, directory = DEFAULT_EPISODE_DIRECTORY) {
  if (typeof episodeId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(episodeId)) {
    throw new RangeError('Invalid episode ID');
  }
  try {
    const text = await readFile(join(directory, `${episodeId}.json`), 'utf8');
    const episode = validateEpisode(JSON.parse(text));
    if (episode.episodeId !== episodeId) throw new RangeError('Invalid episode ID: filename mismatch');
    return episode;
  } catch (error) {
    if (error.code === 'ENOENT') {
      const builtin = generateBuiltinEpisode(episodeId);
      if (builtin) return validateEpisode(builtin);
      throw new RangeError(`Episode not found: ${episodeId}`);
    }
    throw error;
  }
}
