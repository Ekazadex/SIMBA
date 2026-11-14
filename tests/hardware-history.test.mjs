import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/hardware-history.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'firestore-fixture', setup(plugin) {
  plugin.onResolve({ filter: /^firebase\/firestore$/ }, () => ({ path: 'firestore', namespace: 'mock' }));
  plugin.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ loader: 'js', contents: `
    export const Timestamp = { fromMillis: value => ({ kind: 'timestamp', value }) };
    export const collection = (...args) => ({kind:'collection', args});
    export const where = (...args) => ({kind:'where', args});
    export const orderBy = (...args) => ({kind:'orderBy', args});
    export const limit = value => ({kind:'limit', value});
    export const startAfter = value => ({kind:'cursor', value});
    export const query = (...args) => args;
    export const getDocs = args => globalThis.__historyFixture(args);
  ` }));
} }] });
const module = { exports: {} }; new Function('module', 'exports', bundle.outputFiles[0].text)(module, module.exports);
const { loadHardwareHistory24h } = module.exports;

function doc(id, time, level = 25, source = 'Hardware-ESP32') { return { id, data: () => ({ timestamp: time, water_level: level, source }) }; }

test('queries all supported timestamp types with pagination, deduplicates IDs and normalizes readings', async () => {
  const now = Date.now(); let millisecondPages = 0;
  globalThis.__historyFixture = async args => {
    const bounds = args.filter(x => x.kind === 'where');
    const from = bounds[0].args[2];
    const cursor = args.find(x => x.kind === 'cursor');
    let docs = [];
    if (typeof from === 'number' && from > 1e10) {
      millisecondPages++;
      docs = cursor ? [doc('last', now - 1000)] : Array.from({ length: 500 }, (_, i) => doc(`p${i}`, now - 2000 - i));
    } else if (typeof from === 'number') docs = [doc('seconds', Math.floor((now - 5000) / 1000))];
    else if (typeof from === 'object') docs = [doc('firestore', { toMillis: () => now - 4000 })];
    else docs = [doc('string', new Date(now - 3000).toISOString()), doc('bad-source', new Date(now - 3000).toISOString(), 99, 'Simulator')];
    return { docs, size: docs.length };
  };
  try {
    const result = await loadHardwareHistory24h({}, 180);
    assert.equal(millisecondPages, 2);
    assert.equal(result.readings.length, 504);
    assert.equal(result.failed, false); assert.equal(result.truncated, false);
    assert.ok(result.readings.every(item => item.source === 'Hardware-ESP32'));
    assert.ok(result.readings.every((item, i, all) => i === 0 || all[i - 1].timestamp <= item.timestamp));
  } finally { delete globalThis.__historyFixture; }
});

test('reports a failed query as partial instead of claiming complete history', async () => {
  globalThis.__historyFixture = async args => {
    const from = args.find(x => x.kind === 'where').args[2];
    if (typeof from === 'string') throw new Error('index unavailable');
    return { docs: [], size: 0 };
  };
  try { const result = await loadHardwareHistory24h({}, 180); assert.equal(result.failed, true); assert.equal(result.readings.length, 0); }
  finally { delete globalThis.__historyFixture; }
});

test('reports a bounded full query as potentially truncated', async () => {
  const now = Date.now();
  globalThis.__historyFixture = async args => {
    const from = args.find(x => x.kind === 'where').args[2];
    if (typeof from !== 'number' || from < 1e10) return { docs: [], size: 0 };
    const docs = Array.from({ length: 500 }, (_, i) => doc(`${args.find(x => x.kind === 'cursor')?.value.id ?? 'first'}-${i}`, now - i));
    return { docs, size: docs.length };
  };
  try { const result = await loadHardwareHistory24h({}, 180); assert.equal(result.truncated, true); assert.equal(result.readings.length, 6000); }
  finally { delete globalThis.__historyFixture; }
});

test('24-hour history preserves recorded packet distance when a water level is already present', async () => {
  const now = Date.now();
  globalThis.__historyFixture = async args => {
    const from = args.find(x => x.kind === 'where').args[2];
    const docs = typeof from === 'number' && from > 1e10 ? [{ id: 'packet', data: () => ({ timestamp: now - 1000, source: 'Hardware-ESP32', water_level: 28, readings: [{ distance: 155 }, { distance: 154 }] }) }] : [];
    return { docs, size: docs.length };
  };
  try { const result = await loadHardwareHistory24h({}, 182); assert.equal(result.readings[0].distance, 154); }
  finally { delete globalThis.__historyFixture; }
});
