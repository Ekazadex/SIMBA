import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_REGISTRY } from './simulation-engine.mjs';

export const DEFAULT_EPISODE_DIRECTORY = fileURLToPath(new URL('../../ml/data/generated/synthetic_v2/episodes/', import.meta.url));
export const LEGACY_EPISODE_DIRECTORY = fileURLToPath(new URL('../../ml/data/generated/synthetic_v1/episodes/', import.meta.url));
const NODE_IDS = new Set(NODE_REGISTRY.map(({ id }) => id));
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;

function validTime(value) {
  return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

export function validateEpisode(episode) {
  if (!episode || typeof episode !== 'object' || !/^[a-zA-Z0-9_-]+$/.test(episode.episodeId ?? '')) throw new RangeError('Invalid episode ID');
  if (episode.stepSeconds !== 300 || !validTime(episode.startTimeUtc)) throw new RangeError('Invalid episode step or start time');
  if (!['synthetic_v1', 'synthetic_v2'].includes(episode.version)) throw new RangeError('Invalid episode version');
  if (!Array.isArray(episode.nodes) || episode.nodes.length !== NODE_IDS.size ||
      new Set(episode.nodes.map((node) => node.id)).size !== NODE_IDS.size ||
      episode.nodes.some((node) => !NODE_IDS.has(node.id))) throw new RangeError('Invalid episode node registry');
  if (!Array.isArray(episode.frames) || episode.frames.length < 96) throw new RangeError('Invalid episode history (96 steps required)');
  const firstTime = Date.parse(episode.startTimeUtc);
  let firstStep = null;
  for (let index = 0; index < episode.frames.length; index += 1) {
    const frame = episode.frames[index];
    if (index === 0) firstStep = frame?.simTimeSeconds;
    if (!Number.isFinite(firstStep) || !Number.isFinite(frame?.simTimeSeconds) ||
        frame.simTimeSeconds !== firstStep + index * 300 ||
        !validTime(frame.timestampUtc) || Date.parse(frame.timestampUtc) !== firstTime + index * 300_000) {
      throw new RangeError(`Invalid episode timestamp at frame ${index}`);
    }
    if (!Array.isArray(frame.nodes) || frame.nodes.length !== NODE_IDS.size ||
        new Set(frame.nodes.map((node) => node.id)).size !== NODE_IDS.size ||
        frame.nodes.some((node) => !NODE_IDS.has(node.id))) throw new RangeError(`Invalid episode nodes at frame ${index}`);
    for (const node of frame.nodes) {
      if (!Number.isFinite(node.tmaCm) || node.tmaCm < 0) throw new RangeError(`Invalid episode TMA at frame ${index}`);
      if (!Number.isFinite(node.rainRateMmH) || node.rainRateMmH < 0 ||
          !Number.isFinite(node.rainMm5m) || node.rainMm5m < 0 ||
          Math.abs(node.rainRateMmH / 12 - node.rainMm5m) > 0.01) throw new RangeError(`Invalid episode rain at frame ${index}`);
      if (node.rainSource !== 'synthetic' && node.rainSource !== 'synthetic_conditioned_on_daily_rr') throw new RangeError(`Invalid episode rain source at frame ${index}`);
      if (node.tmaSource !== 'synthetic') throw new RangeError(`Invalid episode TMA source at frame ${index}`);
    }
  }
  return episode;
}

export async function listEpisodes(directory = DEFAULT_EPISODE_DIRECTORY) {
  try {
    const files = await readdir(directory);
    return files.filter((file) => /^[a-zA-Z0-9_-]+\.json$/.test(file))
      .map((file) => ({ episodeId: file.slice(0, -5) })).sort((a, b) => a.episodeId.localeCompare(b.episodeId));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadEpisode(episodeId, directory = DEFAULT_EPISODE_DIRECTORY) {
  if (typeof episodeId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(episodeId)) throw new RangeError('Invalid episode ID');
  let text;
  try {
    text = await readFile(join(directory, `${episodeId}.json`), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new RangeError(`Episode not found: ${episodeId}`);
    throw error;
  }
  const episode = validateEpisode(JSON.parse(text));
  if (episode.episodeId !== episodeId) throw new RangeError('Invalid episode ID: filename mismatch');
  return episode;
}
