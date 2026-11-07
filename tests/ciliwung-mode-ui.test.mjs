import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('App fences hardware and simulation modes through the backend mode endpoint', () => {
  assert.match(appSource, /api\/ciliwung-mode/);
  assert.match(appSource, /switchCiliwungMode\('simulation'\)/);
  assert.match(appSource, /switchCiliwungMode\('hardware'\)/);
  assert.match(appSource, /handleEnterSimulation/);
  assert.match(appSource, /handleExitSimulation/);
});
