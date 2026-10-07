import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
assert.equal(branch, 'naufal', `expected branch naufal, got ${branch}`);
execFileSync(process.execPath, ['--test', 'tests/ciliwung-simulation-engine.test.mjs', 'tests/ciliwung-api.test.mjs'], { cwd: root, stdio: 'pipe' });
execFileSync(process.execPath, ['--test', 'tests/ciliwung-backend-simulation.test.mjs'], {
  cwd: path.resolve(root, '../../flood_3d_visual_map'),
  stdio: 'pipe',
});
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
execSync(`${npx} --yes esbuild server.ts --loader:.ts=ts --outfile=../.hermes-ciliwung-server-check.js`, {
  cwd: root,
  stdio: 'pipe',
});
fs.rmSync(path.resolve(root, '../.hermes-ciliwung-server-check.js'), { force: true });
console.log('Ciliwung regression verification passed');
