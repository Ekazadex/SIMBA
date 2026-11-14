import assert from 'node:assert/strict';
import test from 'node:test';
import { validLimits, graphAxisMax, graphTimeTicks, graphCsv, batchDistances, sensorDistance, interpolateGraphPoints } from '../src/hardware-graph.mjs';
import { getDownstreamPresetLimits, buildHardwareSnapshot } from '../backend/ciliwung/hardware-live.mjs';

test('uses valid configured limits and the classifier\'s downstream preset limits', () => {
  assert.deepEqual(validLimits({ threshold_siaga: 0, threshold_bahaya: 200 }, null), { siaga: 0, bahaya: 200 });
  for (const config of [{}, { threshold_siaga: 40, threshold_bahaya: 40 }, { threshold_siaga: NaN, threshold_bahaya: 90 }, { threshold_siaga: -1, threshold_bahaya: 90 }]) assert.equal(validLimits(config, null), null);
  const limits = getDownstreamPresetLimits('N2');
  assert.deepEqual(limits, { siaga: 180, bahaya: 280 });
  const node = buildHardwareSnapshot({ levelCm: 95 }).threeDNodes.find(item => item.id === 'N2');
  assert.equal(node.status, node.tmaCm >= limits.bahaya ? 'BANJIR_JAKARTA' : node.tmaCm >= limits.siaga ? 'SIAGA' : 'AMAN');
  assert.equal(getDownstreamPresetLimits('N1'), null);
});

test('scale includes observed and forecast values and valid limits, with safe empty baseline', () => {
  assert.equal(graphAxisMax([], [], null), 100);
  assert.equal(graphAxisMax([{ level: 12 }], [], { siaga: 40, bahaya: 300 }), 300);
  assert.equal(graphAxisMax([{ level: 400 }], [{ level: 439 }], null), 440);
  assert.equal(graphAxisMax([{ level: NaN }, { level: -10 }], [], null), 100);
});

test('time ticks match the separate history and forecast scales and the full-width distance scale', () => {
  const last = Date.UTC(2026, 10, 14, 11, 40);
  const start = last - 30 * 60_000;
  const elevation = graphTimeTicks(start, last);
  assert.equal(elevation.length, 9);
  assert.deepEqual(elevation[0], { x: 50, time: start, future: false });
  assert.deepEqual(elevation[2], { x: 200, time: last - 15 * 60_000, future: false });
  assert.deepEqual(elevation[4], { x: 350, time: last, future: false });
  assert.deepEqual(elevation[5], { x: 425, time: last + 7.5 * 60_000, future: true });
  assert.deepEqual(elevation[8], { x: 650, time: last + 30 * 60_000, future: true });
  const distance = graphTimeTicks(start, last, true);
  assert.equal(distance.length, 9);
  assert.deepEqual(distance[4], { x: 350, time: last - 15 * 60_000, future: false });
  assert.deepEqual(distance[8], { x: 650, time: last, future: false });
  assert.deepEqual(graphTimeTicks(last, last), []);
});

test('CSV exports only supplied valid history, escapes fields and neutralizes spreadsheet formulas', () => {
  const csv = graphCsv([{ time: 1000, level: 14.5 }, { time: NaN, level: 9 }], '=N1', 'sensor,"raw"');
  assert.match(csv, /"'=N1"/);
  assert.match(csv, /"sensor,""raw"""/);
  assert.match(csv, /1970-01-01T00:00:01.000Z/);
  assert.equal(csv.split('\r\n').length, 2);
});

test('raw batch contains only measured, nonnegative distances and retains sample positions', () => {
  assert.deepEqual(batchDistances({ readings: [{ distance: 1.25 }, { water_level: 10 }, { distance: -1 }, { distance: 0 }] }), [{ index: 1, distance: 1.25 }, { index: 4, distance: 0 }]);
  assert.deepEqual(batchDistances({ batch_data: [['12:00', 42]] }), []);
});

test('sensor distance prefers reported samples and labels reference-based estimates', () => {
  assert.deepEqual(sensorDistance({ distance: 165, readings: [{ distance: 153 }, { distance: 152 }] }, 182), { value: 152, method: 'reported' });
  assert.deepEqual(sensorDistance({ distance: 0, water_level: 20 }, 182), { value: 0, method: 'reported' });
  assert.deepEqual(sensorDistance({ water_level: 28 }, 182), { value: 154, method: 'estimated' });
  assert.equal(sensorDistance({ water_level: 28 }, undefined), null);
  assert.equal(sensorDistance({ distance: -1, water_level: 28 }, 0), null);
});

test('distance CSV exports distance values and their method with an accurate column name', () => {
  const csv = graphCsv([{ time: 1000, level: 154, distanceMethod: 'estimated' }], 'N1', 'ESP32 sensor', '30m', 'loaded readings only', 'sensor_distance_cm');
  assert.match(csv, /sensor_distance_cm/);
  assert.match(csv, /distance_method/);
  assert.match(csv, /"154".*"estimated"/);
  assert.doesNotMatch(csv, /water_level_cm/);
});

test('visual interpolation moves between differently sized curves without changing either dataset', () => {
  const from = [{ x: 0, y: 10 }, { x: 100, y: 20 }];
  const to = [{ x: 0, y: 30 }, { x: 50, y: 50 }, { x: 100, y: 40 }];
  assert.equal(interpolateGraphPoints(from, to, 0), from);
  assert.equal(interpolateGraphPoints(from, to, 1), to);
  const middle = interpolateGraphPoints(from, to, 0.5, 3);
  assert.deepEqual(middle, [{ x: 0, y: 20 }, { x: 50, y: 32.5 }, { x: 100, y: 30 }]);
  assert.deepEqual(from, [{ x: 0, y: 10 }, { x: 100, y: 20 }]);
  assert.deepEqual(to, [{ x: 0, y: 30 }, { x: 50, y: 50 }, { x: 100, y: 40 }]);
});
