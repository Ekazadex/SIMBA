import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateEpisode } from '../backend/ciliwung/rain-replay.mjs';
import { NODE_REGISTRY } from '../backend/ciliwung/simulation-engine.mjs';

const ML_ROOT = fileURLToPath(new URL('../ml/', import.meta.url));
const DATA = join(ML_ROOT, 'data', 'generated', 'synthetic_v1');
const MODELS = join(ML_ROOT, 'models');
const REPORT = join(ML_ROOT, 'reports', 'synthetic_v1.json');
const BMKG = fileURLToPath(new URL('../../../DATABMKG/', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function countLines(path) {
  let lines = 0;
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const _line of reader) lines += 1;
  return lines;
}

async function verify() {
  const manifestBytes = await readFile(join(DATA, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.dataset_version, 'synthetic_v1');
  assert.equal(manifest.step_seconds, 300);
  assert.equal(manifest.steps_per_episode, 288);
  const ids = NODE_REGISTRY.map((node) => node.id);
  assert.deepEqual(manifest.node_ids, ids, 'nine semantic node IDs must match the current engine registry');
  assert.ok(manifest.episode_count >= 100, 'expected many independent synthetic episodes');
  assert.match(manifest.scope, /synthetic.*not validated.*operational/i);
  const partitions = ['train', 'validation', 'test', 'stress'];
  const flatIds = partitions.flatMap((name) => {
    assert.ok(Array.isArray(manifest.splits?.[name]) && manifest.splits[name].length > 0, `${name} needs episodes`);
    return manifest.splits[name];
  });
  assert.equal(flatIds.length, manifest.episode_count);
  assert.equal(new Set(flatIds).size, flatIds.length, 'episode split leakage');
  assert.ok(manifest.splits.test.includes(manifest.held_out_demo_episode_id), 'replay demo must be a withheld test episode');
  assert.ok(Array.isArray(manifest.episodes) && manifest.episodes.length === flatIds.length);
  assert.equal(manifest.bmkg?.source_interpretation?.includes('reporting-date accumulation interval unverified'), true);
  const sourceHashes = manifest.bmkg?.source_sha256;
  assert.ok(sourceHashes && Object.keys(sourceHashes).length > 0, 'BMKG provenance missing');
  for (const [filename, expected] of Object.entries(sourceHashes)) {
    assert.match(filename, /^laporan_iklim_harian-[a-zA-Z0-9_-]+\.xlsx$/);
    assert.equal(sha256(await readFile(join(BMKG, filename))), expected, `${filename} changed since data generation`);
  }
  const episodeFiles = (await readdir(join(DATA, 'episodes'))).filter((name) => name.endsWith('.json'));
  assert.equal(episodeFiles.length, manifest.episode_count);
  for (const episodeId of flatIds) {
    const episode = validateEpisode(await readJson(join(DATA, 'episodes', `${episodeId}.json`)));
    assert.equal(episode.episodeId, episodeId);
    assert.equal(episode.frames.length, manifest.steps_per_episode);
    assert.ok(episode.frames.every((frame) => frame.nodes.every((node) => node.tmaSource === 'synthetic')));
  }
  const expectedCsvLines = 1 + manifest.episode_count * manifest.steps_per_episode * ids.length;
  assert.equal(await countLines(join(DATA, 'timeseries.csv')), expectedCsvLines, 'CSV coverage differs from episode files');
  const targetHeader = (await readFile(join(DATA, 'targets.csv'), 'utf8')).split(/\r?\n/, 1)[0];
  assert.match(targetHeader, /trajectory_cm/);
  assert.match(targetHeader, /cross30/);
  assert.match(targetHeader, /cross60/);

  const report = await readJson(REPORT);
  assert.equal(report.dataset_version, manifest.dataset_version);
  assert.equal(report.dataset_manifest_sha256, sha256(manifestBytes));
  assert.deepEqual(report.split_episode_ids, manifest.splits);
  assert.match(report.scope, /synthetic.*no measured/i);
  for (const nodeId of ['N1', 'N5']) {
    const model = join(MODELS, `${nodeId}.keras`);
    const metadata = await readJson(join(MODELS, `${nodeId}.json`));
    assert.ok((await stat(model)).size > 0, `${nodeId} model is empty`);
    assert.equal(metadata.model_sha256, sha256(await readFile(model)), `${nodeId} model hash mismatch`);
    assert.equal(metadata.dataset_manifest_sha256, sha256(manifestBytes));
    assert.equal(metadata.fit_partition, 'train');
    assert.equal(metadata.quality, 'experimental_synthetic_only');
    assert.equal(metadata.node_id, nodeId);
    assert.equal(metadata.input_steps, 96);
    assert.equal(metadata.output_steps, 12);
    assert.deepEqual(metadata.feature_order, ['tmaCm', 'rainRateMmH', 'upstreamTmaCm', 'upstreamRainRateMmH']);
    const nodeReport = report.nodes?.[nodeId];
    assert.ok(nodeReport?.samples?.train > 0);
    assert.ok(nodeReport.samples.test > 0 && nodeReport.samples.stress > 0);
    assert.equal(nodeReport.selected_demo_method, metadata.selected_demo_method);
    for (const partition of ['validation', 'test', 'stress']) {
      const methods = nodeReport[partition];
      for (const method of ['lstm', 'persistence', 'slope']) {
        for (const horizon of ['30', '60']) {
          assert.ok(methods?.[method]?.[horizon]?.samples > 0, `${nodeId}/${partition}/${method}/${horizon} missing`);
          assert.ok(Number.isFinite(methods[method][horizon].mae_cm), `${nodeId}/${partition}/${method}/${horizon} lacks MAE`);
        }
      }
    }
    console.log(`${nodeId}: selected ${metadata.selected_demo_method}; LSTM comparison test +30 MAE ${nodeReport.test.lstm['30'].mae_cm}, +60 MAE ${nodeReport.test.lstm['60'].mae_cm}`);
  }
  console.log(`Verified ${manifest.episode_count} independent episodes and ${expectedCsvLines - 1} labelled rows; synthetic-only.`);
  console.log('SIMBA forecast artifact verification passed');
}

verify().catch((error) => {
  console.error('SIMBA forecast artifact verification failed:', error);
  process.exitCode = 1;
});
