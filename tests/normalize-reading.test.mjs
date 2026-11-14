import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReading } from '../src/normalize-reading.mjs';

test('uses the latest ESP32 distance and configured sensor reference for water level', () => {
  const data = { source: 'Hardware-ESP32-SoilWake', readings: [{ distance: 161.9 }, { distance: 162.3 }] };
  assert.equal(normalizeReading(data, 300).water_level, 137.7);
  assert.equal(normalizeReading(data, 280).water_level, 117.7);
  assert.equal(normalizeReading({ readings: [] }, 300), null);
  assert.equal(normalizeReading({ water_level: 42 }, 300).water_level, 42);
});
