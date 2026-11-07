import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCiliwungEngine, NODE_REGISTRY } from '../backend/ciliwung/simulation-engine.mjs';
import { listEpisodes, loadEpisode, validateEpisode, DEFAULT_EPISODE_DIRECTORY } from '../backend/ciliwung/rain-replay.mjs';

const START = Date.parse('2026-08-01T00:00:00.000Z');
function episode(count = 99, version = 'synthetic_v1') {
  return {
    episodeId: 'held-out-001', version, seed: 17,
    stepSeconds: 300, startTimeUtc: new Date(START).toISOString(),
    nodes: NODE_REGISTRY.map(({ id }) => ({ id })).reverse(),
    frames: Array.from({ length: count }, (_, i) => ({
      simTimeSeconds: i * 300,
      timestampUtc: new Date(START + i * 300_000).toISOString(),
      nodes: NODE_REGISTRY.map(({ id }, index) => ({
        id, tmaCm: 80 + index + i, rainRateMmH: 12, rainMm5m: 1,
        rainSource: 'synthetic', tmaSource: 'synthetic',
      })).reverse(),
    })),
  };
}

test('replay pre-rolls 96 samples and only publishes nine actual keyed levels on a new bin', () => {
  const engine = createCiliwungEngine({ autoStart: false });
  const events = [];
  engine.subscribe((state) => events.push(state));
  const first = engine.startReplay(episode(), 50);
  assert.equal(first.scenario, 'rain_replay');
  assert.equal(first.mode, 'synthetic_demo');
  assert.equal(first.episodeId, 'held-out-001');
  assert.equal(first.simTimeSeconds, 95 * 300);
  assert.equal(first.cupNodes.find((n) => n.id === 'N1').tmaCm, 80 + 4 + 95);
  assert.equal(first.cupNodes.find((n) => n.id === 'N1').rainMm5m, 1);
  assert.equal(engine.getReplayHistory('N1').length, 96);
  assert.equal(engine.getReplayHistory('N1').at(-1).timestampUtc, new Date(START + 95 * 300_000).toISOString());
  const count = events.length;
  engine.advance(3);
  assert.equal(events.length, count);
  assert.equal(engine.getState().cupNodes.find((n) => n.id === 'N1').tmaCm, first.cupNodes.find((n) => n.id === 'N1').tmaCm);
  engine.advance(3);
  assert.equal(events.length, count + 1);
  assert.equal(engine.getState().simTimeSeconds, 96 * 300);
  assert.equal(engine.getReplayHistory('N1').at(-1).tmaCm, 80 + 4 + 96);
  assert.equal(engine.getReplayHistory('N1').length, 96);
});

test('replay chart history returns only past 96 five-minute bins and starts shortly before synthetic rain', () => {
  const sample = episode(150);
  sample.frames.forEach((frame, index) => {
    if (index < 120) frame.nodes.forEach((node) => { node.rainRateMmH = 0; node.rainMm5m = 0; });
  });
  const engine = createCiliwungEngine({ autoStart: false });
  const state = engine.startReplay(sample);
  assert.equal(state.simTimeSeconds, 114 * 300);
  const chart = engine.getReplayChartHistory();
  assert.equal(chart.runId, state.runId);
  assert.equal(chart.points.length, 96);
  assert.equal(chart.points.at(-1).timestampUtc, state.timestampUtc);
  assert.equal(chart.points.at(-1).time, 114 * 300);
  assert.equal(chart.points.at(-1).rainRatesMmH.N1, 0);
  assert.equal(chart.points.some((point) => point.time > state.simTimeSeconds), false);
  assert.equal(engine.getReplayHistory('N1').at(-1).timestampUtc, state.timestampUtc);
  engine.reset();
  assert.deepEqual(engine.getReplayChartHistory().points, []);
});

test('all nine replay nodes have causal histories, with an explicit self-proxy only at headwater UP1', () => {
  const engine = createCiliwungEngine({ autoStart: false });
  const state = engine.startReplay(episode());
  for (const node of NODE_REGISTRY) {
    const history = engine.getReplayHistory(node.id);
    assert.equal(history.length, 96, `${node.id} should be forecastable`);
    assert.equal(history.at(-1).timestampUtc, state.timestampUtc);
  }
  const headwater = engine.getReplayHistory('UP1').at(-1);
  assert.equal(headwater.upstreamTmaCm, headwater.tmaCm);
  assert.equal(headwater.upstreamRainRateMmH, headwater.rainRateMmH);
  const n2 = engine.getReplayHistory('N2').at(-1);
  assert.equal(n2.upstreamTmaCm, state.cupNodes.find((node) => node.id === 'N1').tmaCm);
});

test('a noisy replay level below baseline preserves current TMA but never sends a negative 3D visual rise', () => {
  const sample = episode();
  sample.frames[95].nodes.find((node) => node.id === 'N1').tmaCm = 59.8;
  const engine = createCiliwungEngine({ autoStart: false });
  const state = engine.startReplay(sample);
  const n1 = state.threeDNodes.find((node) => node.id === 'N1');
  assert.equal(n1.tmaCm, 59.8);
  assert.equal(n1.stageRiseM, 0);
});

test('synthetic replay retains its original UP3 and UP4 visual reference levels', () => {
  const sample = episode();
  for (const [id, baseline] of [['UP3', 100], ['UP4', 150]]) {
    sample.frames[95].nodes.find(node => node.id === id).tmaCm = baseline;
    sample.frames[96].nodes.find(node => node.id === id).tmaCm = baseline + 10;
  }
  const engine = createCiliwungEngine({ autoStart: false });
  let state = engine.startReplay(sample);
  for (const id of ['UP3', 'UP4']) assert.equal(state.threeDNodes.find(node => node.id === id).stageRiseM, 0);
  state = engine.advance(300);
  for (const id of ['UP3', 'UP4']) assert.equal(state.threeDNodes.find(node => node.id === id).stageRiseM, 0.1);
});

test('replay completion, stop/reset and restart use unique run IDs and preserve hardware telemetry', () => {
  const engine = createCiliwungEngine({ autoStart: false });
  engine.markCupCarbonTelemetry({ nodeId: 'N5' }, 1234);
  const first = engine.startReplay(episode(97));
  engine.advance(300);
  assert.equal(engine.getState().status, 'completed');
  assert.equal(engine.getState().simTimeSeconds, 96 * 300);
  const second = engine.startReplay(episode());
  assert.notEqual(first.runId, second.runId);
  assert.equal(second.cupcarbon.lastSeenAt, 1234);
  const presentN1 = second.cupNodes.find((node) => node.id === 'N1').tmaCm;
  engine.stop();
  assert.equal(engine.getState().cupNodes.find((node) => node.id === 'N1').tmaCm, presentN1);
  assert.equal(engine.getReplayHistory('N1').length, 0);
  engine.reset();
  assert.equal(engine.getState().runId, null);
  assert.equal(engine.getState().cupcarbon.status, 'active');
});

test('missing synthetic sensor samples suppress model input rather than becoming invented observations', () => {
  const engine = createCiliwungEngine({ autoStart: false });
  const bad = episode();
  bad.frames[40].nodes.find((n) => n.id === 'N1').sensorQuality = 'synthetic_missing';
  engine.startReplay(bad);
  assert.deepEqual(engine.getReplayHistory('N1'), []);
  assert.equal(engine.getReplayHistory('N5').length, 96);
});

test('synthetic_v2 episodes validate and the default replay directory follows the v2 model dataset', async () => {
  assert.match(DEFAULT_EPISODE_DIRECTORY.replaceAll(String.fromCharCode(92), '/'), /ml\/data\/generated\/synthetic_v2\/episodes\/$/);
  const sample = episode(99, 'synthetic_v2');
  assert.equal(validateEpisode(sample).version, 'synthetic_v2');
  const engine = createCiliwungEngine({ autoStart: false });
  assert.equal(engine.startReplay(sample).datasetVersion, 'synthetic_v2');
  const dir = await mkdtemp(join(tmpdir(), 'simba-v2-episodes-'));
  try {
    await writeFile(join(dir, `${sample.episodeId}.json`), JSON.stringify(sample));
    assert.equal((await loadEpisode(sample.episodeId, dir)).version, 'synthetic_v2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('episodes list reads on demand, prevents traversal, rejects missing/stale source data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simba-episodes-'));
  try {
    await writeFile(join(dir, 'held-out-001.json'), JSON.stringify(episode()));
    assert.equal((await listEpisodes(dir))[0].episodeId, 'held-out-001');
    const loaded = await loadEpisode('held-out-001', dir);
    assert.equal(loaded.frames.length, 99);
    await assert.rejects(loadEpisode('../escape', dir), /invalid.*episode/i);
    await assert.rejects(loadEpisode('unknown', dir), /not found/i);
    const bad = episode();
    bad.frames[96].nodes.find((n) => n.id === 'N1').rainRateMmH = null;
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ ...bad, episodeId: 'bad' }));
    await assert.rejects(loadEpisode('bad', dir), /invalid.*rain/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
