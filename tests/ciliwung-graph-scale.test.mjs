import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createCiliwungEngine } from '../backend/ciliwung/simulation-engine.mjs';
import { calculateGraphScaleReference } from '../scripts/generate-ciliwung-graph-scale.mjs';

test('per-node graph references match the current scenarios without affecting another run', async () => {
  const engine = createCiliwungEngine({ autoStart: false });
  engine.start('ringan', 50);
  engine.advance(1);
  const before = engine.getState();
  const saved = JSON.parse(await readFile(new URL('../src/components/ciliwung-graph-scale.json', import.meta.url), 'utf8'));
  assert.deepEqual(saved, calculateGraphScaleReference(), 'run node scripts/generate-ciliwung-graph-scale.mjs after changing the simulation');
  assert.equal(Object.keys(saved.maxTmaCmByNode).length, 9);
  assert.ok(saved.maxTmaCmByNode.N1 > 180);
  assert.ok(saved.maxTmaCmByNode.N5 >= 280);
  assert.deepEqual(engine.getState(), before);
  engine.stop();
});
