import assert from 'node:assert/strict';
import test from 'node:test';
import { createCiliwungEngine, NODE_REGISTRY, SCENARIO_PROFILES, SPEED_MULTIPLIERS } from '../backend/ciliwung/simulation-engine.mjs';

test('registry exposes all nine semantic stations to the 3D backend without changing CupCarbon IDs', () => {
  assert.equal(NODE_REGISTRY.length, 9);
  assert.deepEqual(NODE_REGISTRY.filter((node) => node.threeDNodeId).map((node) => node.id), ['UP1', 'UP2', 'UP3', 'UP4', 'N1', 'N2', 'N3', 'N4', 'N5']);
  assert.deepEqual(NODE_REGISTRY.filter((node) => !node.threeDNodeId).map((node) => node.id), []);
  assert.deepEqual(NODE_REGISTRY.map((node) => node.cupcarbonNodeId), [1, 2, 3, 4, 5, 20, 21, 22, 8]);
});

test('legacy simulation and CupCarbon commands begin Sukaraja and Cibinong at the chosen 58 cm demo baseline', () => {
  const engine = createCiliwungEngine({ autoStart: false });
  for (const scenario of ['ringan', 'sedang', 'lebat']) {
    const state = engine.start(scenario);
    for (const id of ['UP3', 'UP4']) {
      const node = state.cupNodes.find(item => item.id === id);
      assert.equal(node.tmaCm, 58);
      assert.equal(node.stageRiseM, 0);
      assert.equal(engine.getCupCarbonCommands().find(item => item.nodeId === id).tmaCm, 58);
    }
  }
  const reset = engine.reset();
  assert.equal(reset.cupNodes.find(node => node.id === 'UP3').tmaCm, 58);
  assert.equal(reset.cupNodes.find(node => node.id === 'UP4').tmaCm, 58);
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
  assert.equal(first.threeDNodes.length, 9);
  assert.match(first.runId, /^ciliwung-/);

  engine.start('sedang');
  const restarted = engine.getState();
  assert.equal(restarted.scenario, 'sedang');
  assert.equal(restarted.simTimeSeconds, 0);
  assert.notEqual(restarted.runId, first.runId);
  engine.stop();
});

test('legacy scenario chart history retains the latest run snapshots until reset', () => {
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  const first = engine.start('sedang');
  engine.advance(1);
  engine.advance(2);
  engine.stop();

  const history = engine.getChartHistory();
  assert.equal(history.runId, first.runId);
  assert.equal(history.episodeId, null);
  assert.deepEqual(history.points.map((point) => point.time), [0, 1, 3]);
  assert.ok(history.points.every((point) => Object.keys(point.rainRatesMmH).length === 0));

  engine.reset();
  assert.deepEqual(engine.getChartHistory(), { runId: null, episodeId: null, points: [] });
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
  engine.start('lebat', 50);
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
  assert.deepEqual(SPEED_MULTIPLIERS, [1, 10, 25, 50, 150]);
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  engine.start('ringan', 10);
  assert.equal(engine.getState().speedMultiplier, 10);

  engine.advance(1);
  assert.equal(engine.getState().simTimeSeconds, 10);

  engine.setSpeedMultiplier(50);
  engine.advance(1);
  assert.equal(engine.getState().simTimeSeconds, 60);
  engine.setSpeedMultiplier(150);
  engine.advance(1);
  assert.equal(engine.getState().simTimeSeconds, 210);
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

test('CupCarbon telemetry marks the connection active and stale without sending a loopback update', () => {
  const engine = createCiliwungEngine({ intervalMs: 10, autoStart: false });
  const events = [];
  engine.subscribe((state, metadata) => events.push({ state, metadata }));

  engine.start('ringan');
  const active = engine.markCupCarbonTelemetry({ nodeId: 'N5', tmaCm: 61, status: 'AMAN' }, 1234);
  assert.equal(active.cupcarbon.status, 'active');
  assert.equal(active.cupcarbon.warning, '');
  assert.equal(active.cupcarbon.lastSeenAt, 1234);
  assert.equal(active.cupcarbon.activeNodeCount, 1);
  assert.equal(events.at(-1).metadata.sendCupCarbon, false);

  engine.reset();
  assert.equal(engine.getState().cupcarbon.status, 'active');

  const stale = engine.markCupCarbonOffline();
  assert.equal(stale.cupcarbon.status, 'not_verified');
  assert.equal(stale.cupcarbon.activeNodeCount, 0);
  assert.match(stale.cupcarbon.warning, /telemetry/i);
  assert.equal(stale.status, 'idle');
});


test('legacy projection forks the running engine without changing state or sending updates', () => {
  for (const speed of [1, 25, 150]) {
    const engine = createCiliwungEngine({ autoStart: false });
    let publishes = 0;
    engine.subscribe(() => { publishes += 1; });
    engine.start('sedang', speed);
    for (let i = 0; i < 20; i++) engine.advance(0.5);
    const before = engine.getState();
    const count = publishes;
    const projection = engine.getLegacyProjection('N1');
    assert.equal(projection.status, 'available');
    assert.equal(projection.method, 'legacy_simulation_projection');
    assert.equal(projection.runId, before.runId);
    assert.equal(projection.issuedSimTimeSeconds, before.simTimeSeconds);
    assert.equal(projection.points[0].tmaCm, before.cupNodes.find(node => node.id === 'N1').tmaCm);
    assert.deepEqual(engine.getState(), before);
    assert.equal(publishes, count, 'the projection must not publish simulation or CupCarbon updates');
    const expected = projection.points[20];
    for (let i = 0; i < 20; i++) engine.advance(0.5);
    const actual = engine.getState();
    assert.equal(actual.simTimeSeconds - before.simTimeSeconds, expected.afterSeconds);
    assert.equal(actual.cupNodes.find(node => node.id === 'N1').tmaCm, expected.tmaCm);
    assert.equal(projection.scenarioCompletes, false);
    assert.equal(projection.points.at(-1).afterSeconds, 2100, 'provide a rolling 30-minute horizon and five minutes of buffer');
    assert.ok(projection.points.some(point => point.afterSeconds === 1800), 'the +30 minute point must be available at every speed');
    engine.stop();
    assert.equal(engine.getLegacyProjection('N1').status, 'unavailable');
  }
});


test('legacy scenarios end within four hours and heavier rain reaches its target sooner', () => {
  const completionTimes = {};
  for (const scenario of ['ringan', 'sedang', 'lebat']) {
    completionTimes[scenario] = {};
    for (const speed of [1, 10, 25, 50, 150]) {
      const engine = createCiliwungEngine({ autoStart: false });
      engine.start(scenario, speed);
      let state = engine.getState();
      while (state.status === 'running' && state.simTimeSeconds < 24 * 3600) state = engine.advance(0.5);
      assert.equal(state.status, 'completed', `${scenario} at ${speed}x must reach its target`);
      assert.ok(state.simTimeSeconds <= 4 * 3600, `${scenario} at ${speed}x exceeded four hours`);
      completionTimes[scenario][speed] = state.simTimeSeconds;
      const target = state.cupNodes.find(node => node.id === state.targetNodeId);
      assert.ok(target.tmaCm >= state.targetThresholdCm);
      engine.stop();
    }
  }
  for (const speed of [1, 10, 25, 50, 150]) {
    assert.ok(completionTimes.lebat[speed] < completionTimes.sedang[speed]);
    assert.ok(completionTimes.sedang[speed] < completionTimes.ringan[speed]);
  }
  assert.ok(completionTimes.ringan[1] >= 3 * 3600 + 58 * 60, 'light rain should be close to four simulated hours');
  for (const [scenario, expectedSeconds] of [['ringan', 96], ['sedang', 79], ['lebat', 59]]) {
    assert.ok(Math.abs(completionTimes[scenario][150] / 150 - expectedSeconds) <= 3, `${scenario} should finish near its requested time at 150x`);
  }
  for (let index = 0; index < NODE_REGISTRY.length; index++) {
    assert.ok(SCENARIO_PROFILES.ringan.localRiseCmPerSecond[index] <= SCENARIO_PROFILES.sedang.localRiseCmPerSecond[index]);
    assert.ok(SCENARIO_PROFILES.sedang.localRiseCmPerSecond[index] <= SCENARIO_PROFILES.lebat.localRiseCmPerSecond[index]);
  }
});
