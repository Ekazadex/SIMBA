import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWaterLevel, projectDownstreamLevel, illustrativeWeather } from '../src/demo-estimates.mjs';

test('projects recent trend within a bounded rate and requires sufficient history', () => {
  assert.deepEqual(projectWaterLevel([{ time: 0, level: 10 }]), []);
  const rise = projectWaterLevel([{ time: 0, level: 10 }, { time: 60000, level: 12 }]);
  assert.equal(rise.at(-1).level, 42);
  const fall = projectWaterLevel([{ time: 0, level: 40 }, { time: 60000, level: 39 }]);
  assert.equal(fall.at(-1).level, 9);
});

test('recent direction wins over older changes and isolated spikes', () => {
  const history = [100, 80, 60, 20, 21, 120, 23, 24, 25, 26].map((level, i) => ({ time: i * 30000, level }));
  const rise = projectWaterLevel(history);
  assert.ok(rise.at(-1).level > rise[0].level);
  const falling = [30, 29, 28, 27, 26, 25, 24].map((level, i) => ({ time: i * 30000, level }));
  const fall = projectWaterLevel(falling);
  assert.ok(fall.at(-1).level < fall[0].level);
  const flat = projectWaterLevel(falling.map(p => ({ ...p, level: 70 })));
  assert.equal(flat.at(-1).level, 70);
});

test('downstream illustration starts at the preset and follows Depok trend', () => {
  const rise = projectWaterLevel([{ time: 0, level: 20 }, { time: 60000, level: 21 }]);
  const downstream = projectDownstreamLevel(rise, 85);
  assert.equal(downstream[0].level, 85);
  assert.equal(downstream.at(-1).level, 115);
  assert.equal(downstream.at(-1).time, rise.at(-1).time);
  assert.deepEqual(projectDownstreamLevel(rise, undefined), []);
});

test('weather scenarios track configured water-level categories and reject invalid inputs', () => {
  assert.equal(illustrativeWeather(19, 20, 50).humidity, 70);
  assert.equal(illustrativeWeather(25, 20, 50).humidity, 82);
  assert.equal(illustrativeWeather(60, 20, 50).humidity, 90);
  assert.equal(illustrativeWeather(NaN, 20, 50), null);
});
