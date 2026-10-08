import assert from 'node:assert/strict';
import test from 'node:test';
import { createCiliwungEngine, NODE_REGISTRY, SCENARIO_PROFILES, SPEED_MULTIPLIERS } from '../backend/ciliwung/simulation-engine.mjs';

test('registry contains the four upstream nodes and five 3D nodes', () => {
  assert.equal(NODE_REGISTRY.length, 9);
  assert.deepEqual(NODE_REGISTRY.filter((node) => node.threeDNodeId).map((node) => node.id), ['N1', 'N2', 'N3', 'N4', 'N5']);
  assert.deepEqual(NODE_REGISTRY.filter((node) => !node.threeDNodeId).map((node) => node.id), ['UP1', 'UP2', 'UP3', 'UP4']);
});

test('scenario profiles are deterministic and expose a configured completion target', () => {
  for (const key of ['ringan', 'sedang', 'lebat']) {
    assert.equal(typeof SCENARIO_PROFILES[key], 'object');
    assert.ok(SCENARIO_PROFILES[key].targetNodeId);
    assert.ok(Number.isFinite(SCENARIO_PROFILES[key].targetThresholdCm));
    assert.equal(SCENARIO_PROFILES[key].localRiseCmPerSecond.length, 9);
  }
});

test('start resets previous state and emits a complete initial snapshot', () => {
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  engine.start('ringan');
  const first = engine.getState();
  assert.equal(first.status, 'running');
  assert.equal(first.scenario, 'ringan');
  assert.equal(first.simTimeSeconds, 0);
  assert.equal(first.cupNodes.length, 9);
  assert.equal(first.threeDNodes.length, 5);
  assert.match(first.runId, /^ciliwung-/);

  engine.start('sedang');
  const restarted = engine.getState();
  assert.equal(restarted.scenario, 'sedang');
  assert.equal(restarted.simTimeSeconds, 0);
  assert.notEqual(restarted.runId, first.runId);
  engine.stop();
});

test('advance applies local rise and delayed downstream propagation', () => {
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  engine.start('sedang');
  const baseline = engine.getState();
  const baselineN1 = baseline.cupNodes.find((node) => node.id === 'N1').tmaCm;
  const baselineN2 = baseline.cupNodes.find((node) => node.id === 'N2').tmaCm;

  engine.advance(10);
  const beforeLag = engine.getState();
  assert.ok(beforeLag.cupNodes.find((node) => node.id === 'N1').tmaCm > baselineN1);
  assert.equal(beforeLag.cupNodes.find((node) => node.id === 'N2').tmaCm, baselineN2);

  engine.advance(40);
  const afterLag = engine.getState();
  assert.ok(afterLag.cupNodes.find((node) => node.id === 'N2').tmaCm > baselineN2);
  assert.equal(afterLag.threeDNodes.find((node) => node.id === 'N1').stageRiseM > 0, true);
  engine.stop();
});

test('auto-completes at the scenario target and freezes the completed state', () => {
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  engine.start('lebat');
  let state = engine.getState();
  for (let i = 0; i < 600 && state.status === 'running'; i += 1) {
    state = engine.advance(1);
  }
  assert.equal(state.status, 'completed');
  assert.equal(state.targetNodeId, SCENARIO_PROFILES.lebat.targetNodeId);
  const completedTime = state.simTimeSeconds;
  const after = engine.advance(10);
  assert.equal(after.simTimeSeconds, completedTime);
  assert.equal(after.status, 'completed');
  engine.reset();
  assert.equal(engine.getState().status, 'idle');
});

test('speed multipliers scale simulation time without changing the node model', () => {
  assert.deepEqual(SPEED_MULTIPLIERS, [1, 10, 25, 50]);
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  engine.start('ringan', 10);
  assert.equal(engine.getState().speedMultiplier, 10);

  engine.advance(1);
  assert.equal(engine.getState().simTimeSeconds, 10);

  engine.setSpeedMultiplier(50);
  engine.advance(1);
  assert.equal(engine.getState().simTimeSeconds, 60);
  assert.equal(engine.getState().cupNodes.length, 9);
  engine.stop();
});

test('invalid speed multipliers are rejected without corrupting the run', () => {
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  assert.throws(() => engine.start('ringan', 5), /unsupported.*speed/i);
  assert.equal(engine.getState().status, 'idle');

  engine.start('ringan', 25);
  assert.throws(() => engine.setSpeedMultiplier(2), /unsupported.*speed/i);
  assert.equal(engine.getState().speedMultiplier, 25);
  engine.stop();
});

test('invalid scenario names are rejected without corrupting the current state', () => {
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  assert.throws(() => engine.start('unknown'), /unknown Ciliwung scenario/i);
  assert.equal(engine.getState().status, 'idle');
});
