import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'src/components/SCADADashboard.tsx'), 'utf8');
const page = fs.readFileSync(path.join(root, 'src/components/CiliwungSimulationPage.tsx'), 'utf8');
const viewer = fs.readFileSync(path.resolve(root, '../../flood_3d_visual_map/src/js/app.js'), 'utf8');
const adapter = fs.readFileSync(path.resolve(root, '../../flood_3d_visual_map/src/js/backend-simulation.js'), 'utf8');

for (const marker of [
  "'dashboard' | 'admin' | 'simulation'",
  'CiliwungSimulationPage',
  "activeTab === 'admin'",
  "setActiveTab('simulation')",
]) assert.ok(app.includes(marker), `missing App integration marker: ${marker}`);
for (const marker of ['onEnterSimulation', 'Masuk Mode Simulasi']) assert.ok(dashboard.includes(marker), `missing dashboard marker: ${marker}`);
for (const marker of ['View Simulation', 'View Graph', 'Start Simulation', 'Exit Simulation', 'EventSource', '/api/ciliwung-simulation/start']) {
  assert.ok(page.includes(marker), `missing simulation page marker: ${marker}`);
}
assert.ok(!page.includes('firebase/firestore'), 'simulation page must not read Firestore directly');
assert.ok(page.includes('mode=backend'), 'simulation page does not request 3D backend mode');
for (const marker of ['backend-simulation.js', 'applyBackendSnapshot', '!state.backendMode']) {
  assert.ok(viewer.includes(marker) || adapter.includes(marker), `missing 3D backend marker: ${marker}`);
}
console.log('Ciliwung frontend contract verification passed');
