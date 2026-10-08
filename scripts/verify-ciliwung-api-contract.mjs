import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
const api = fs.readFileSync(path.join(root, 'backend/ciliwung/ciliwung-api.mjs'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'backend/ciliwung/simulation-engine.mjs'), 'utf8');

for (const route of [
  '/api/ciliwung-simulation/scenarios',
  '/api/ciliwung-simulation/state',
  '/api/ciliwung-simulation/stream',
  '/api/ciliwung-simulation/start',
  '/api/ciliwung-simulation/stop',
  '/api/ciliwung-simulation/reset',
  '/api/ciliwung-simulation/speed',
]) assert.ok(api.includes(route), `missing API route ${route}`);
assert.ok(server.includes('createCiliwungEngine'), 'server does not create the Ciliwung engine');
assert.ok(server.includes('createSocket'), 'server does not create the CupCarbon UDP transport');
assert.ok(api.includes('text/event-stream'), 'SSE content type is missing');
assert.ok(!engine.includes('addDoc('), 'Ciliwung engine must not write Firestore per tick');
assert.ok(!api.includes('addDoc('), 'Ciliwung API must not write Firestore per tick');
console.log('Ciliwung API contract verification passed');
