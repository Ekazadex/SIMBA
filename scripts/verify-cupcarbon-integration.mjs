import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cupRoot = path.resolve(root, '../../Flood Detection System Ciliwung/Flood Detection System Ciliwung - CupVisual/scripts');
const files = [
  'puncak.py',
  'katulampa.py',
  'sukaraja.py',
  'cibinong.py',
  'pos_depok.py',
  'ciliwung_stage1.py',
  'ciliwung_stage2.py',
  'ciliwung_stage3.py',
  'pintu_air_manggarai.py',
];
const source = files.map((file) => ({ file, text: fs.readFileSync(path.join(cupRoot, file), 'utf8') }));
const nodeIds = new Set();
const controlPorts = new Set();
for (const { file, text } of source) {
  for (const marker of ['NODE_ID =', 'CONTROL_PORT =', 'control_socket.bind', 'json.loads', 'cup_wait(1)', 'TELEMETRY_PORT']) {
    assert.ok(text.includes(marker), `${file} is missing ${marker}`);
  }
  assert.ok(!text.includes('random.'), `${file} still generates random TMA values`);
  const nodeId = text.match(/NODE_ID = "([^"]+)"/)?.[1];
  const controlPort = text.match(/CONTROL_PORT = (\d+)/)?.[1];
  assert.ok(nodeId && controlPort, `${file} has incomplete node control metadata`);
  assert.equal(nodeIds.has(nodeId), false, `duplicate CupCarbon node id ${nodeId}`);
  assert.equal(controlPorts.has(controlPort), false, `duplicate CupCarbon control port ${controlPort}`);
  nodeIds.add(nodeId);
  controlPorts.add(controlPort);
}
execFileSync('python', ['-m', 'py_compile', ...files.map((file) => path.join(cupRoot, file))], { stdio: 'pipe' });
assert.deepEqual([...nodeIds].sort(), ['N1', 'N2', 'N3', 'N4', 'N5', 'UP1', 'UP2', 'UP3', 'UP4']);
assert.equal(source.length, 9);
console.log('CupCarbon integration verification passed');
