import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoHistory, registerHardwareDemoForecast } from '../backend/ciliwung/hardware-demo-forecast.mjs';

const points = Array.from({ length: 12 }, (_, i) => ({ time: 1700000000000 + i * 20000, level: i }));
test('uses up to 12 20-second readings and pads early history explicitly', () => {
  const history = buildDemoHistory(points);
  assert.equal(history.length, 12);
  assert.equal(history[0], 0);
  assert.equal(history.at(-1), 11);
  assert.deepEqual(buildDemoHistory(points.slice(0, 1)), Array(12).fill(0));
  assert.throws(() => buildDemoHistory([]), /insufficient_history/);
  assert.throws(() => buildDemoHistory(points.filter((_, i) => i !== 5)), /history_gap/);
});

test('endpoint supplies readings to the worker and returns 20-second output', async () => {
  let handler;
  registerHardwareDemoForecast({ post: (_path, fn) => { handler = fn; } }, { predict: async levels => {
    assert.equal(levels.length, 12); assert.equal(levels.at(-1), 11);
    return Array.from({ length: 90 }, (_, i) => i + 50);
  } });
  const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(data) { this.data = data; return this; } });
  const ok = response(); await handler({ body: { history: points } }, ok);
  assert.equal(ok.data.levelsCm.length, 90);
  assert.equal(ok.data.stepSeconds, 20);
  assert.equal(ok.data.method, 'lstm_hardware_20s_synthetic');
  const failed = response(); await handler({ body: { history: [] } }, failed);
  assert.equal(failed.statusCode, 400);
});
