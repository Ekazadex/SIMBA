import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildHardwareSnapshot } from '../backend/ciliwung/hardware-live.mjs';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/CiliwungHardwareLiveView.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'transform', jsxFactory: 'React.createElement',
  tsconfigRaw: { compilerOptions: { jsx: 'react' } },
  plugins: [{ name: 'hardware-ui-mocks', setup(plugin) {
    plugin.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'mock' }));
    plugin.onResolve({ filter: /^recharts$/ }, () => ({ path: 'chart', namespace: 'mock' }));
    plugin.onResolve({ filter: /^(leaflet|@maplibre\/maplibre-gl-leaflet|maplibre-gl|maplibre-gl\/dist\/maplibre-gl-worker\.mjs\?worker&url|.*\.css)$/ }, () => ({ path: 'map', namespace: 'mock' }));
    plugin.onLoad({ filter: /react/, namespace: 'mock' }, () => ({ loader: 'js', contents: `
      export const useState = (...args) => globalThis.__hardwareHooks.useState(...args);
      export const useEffect = (...args) => globalThis.__hardwareHooks.useEffect(...args);
      export const useMemo = (...args) => globalThis.__hardwareHooks.useMemo(...args);
      export const useRef = (...args) => globalThis.__hardwareHooks.useRef(...args);
      export default { createElement: (...args) => globalThis.__hardwareHooks.createElement(...args) };
    ` }));
    plugin.onLoad({ filter: /map/, namespace: 'mock' }, () => ({ loader: 'js', contents: 'export const setWorkerUrl = () => {}; export const maplibreGL = () => {}; export default {};' }));
    plugin.onLoad({ filter: /chart/, namespace: 'mock' }, () => ({ loader: 'js', contents: "export const Curve = 'curve';" }));
  } }],
});
const module = { exports: {} };
new Function('module', 'exports', bundle.outputFiles[0].text)(module, module.exports);

function mount(props = {}) {
  const saved = { window: globalThis.window, EventSource: globalThis.EventSource, hooks: globalThis.__hardwareHooks };
  const slots = [], effects = [], streams = [];
  let index = 0;
  globalThis.window = { location: { origin: 'http://localhost:3000' }, setInterval: () => 1, clearInterval() {} };
  globalThis.EventSource = class {
    constructor() { this.listeners = {}; streams.push(this); }
    addEventListener(name, cb) { this.listeners[name] = cb; }
    emit(data) { this.listeners.state({ data: JSON.stringify(data) }); }
    close() {}
  };
  globalThis.__hardwareHooks = {
    createElement(type, elementProps, ...children) {
      const allProps = { ...elementProps, children: children.flat() };
      if (typeof type === 'function') return type.name === 'GraphView' ? type(allProps) : { type: type.name, props: allProps };
      return { type, props: allProps };
    },
    useState(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial; return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }]; },
    useEffect(effect, deps) { const slot = index++; const previous = slots[slot]; if (!previous || deps?.some((d, i) => !Object.is(d, previous.deps?.[i]))) effects.push(() => { previous?.cleanup?.(); slots[slot] = { deps, cleanup: effect() }; }); },
    useMemo(factory) { index++; return factory(); },
    useRef(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; },
  };
  return {
    streams,
    render() { index = 0; const tree = module.exports.default({ compact: true, ...props }); effects.splice(0).forEach((effect) => effect()); return tree; },
    restore() { globalThis.window = saved.window; globalThis.EventSource = saved.EventSource; globalThis.__hardwareHooks = saved.hooks; },
  };
}
function find(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.['data-testid'] === id) return node;
  for (const child of node.props?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); return (node.props?.children ?? []).map(text).join(''); }

test('overview graph shows measured ESP32 history and clearly distinguishes derived locations without inventing predictions', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', readings: [
    { source: 'Hardware-ESP32', water_level: 68, timestamp: now - 360000 },
    { source: 'Simulator-Engine', water_level: 999, timestamp: now - 180000 },
  ] });
  try {
    let tree = ui.render();
    assert.ok(find(tree, 'hardware-view-map2d'));
    assert.equal(find(tree, 'hardware-graph'), null);
    find(tree, 'hardware-view-graph').props.onClick();
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /Pembacaan sensor ESP32/);
    assert.match(text(find(tree, 'hardware-graph')), /Prediksi berbasis data sensor belum tersedia/);
    assert.doesNotMatch(text(find(tree, 'hardware-node-levels')), /999/);
    ui.streams[0].emit(buildHardwareSnapshot({ levelCm: 72, measuredAt: new Date(now).toISOString() }));
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-node-N1')), /72\.0 cm/);
    assert.ok(find(tree, 'hardware-history-trace'));
    assert.equal(find(tree, 'hardware-history-trace').props.type, 'monotoneX');
    find(tree, 'hardware-node-N2').props.onClick();
    tree = ui.render();
    assert.equal(find(tree, 'hardware-node-N2').props['aria-pressed'], true);
    assert.match(text(find(tree, 'hardware-graph')), /Turunan preset visual · bukan pembacaan sensor/);
    assert.match(text(find(tree, 'hardware-node-N2')), /bukan sensor/);
    assert.equal(find(tree, 'hardware-history-trace'), null, 'N1 history must not leak to the selected downstream node');
    ui.streams[0].emit(buildHardwareSnapshot({ levelCm: 95, measuredAt: new Date(now + 1000).toISOString() }));
    tree = ui.render();
    assert.ok(find(tree, 'hardware-history-trace'), 'a new preset snapshot updates the selected node history');
    assert.equal(find(tree, 'forecast-tma-trace'), null);
  } finally { ui.restore(); }
});

test('old sensor readings are marked as last data instead of live', () => {
  const ui = mount({ language: 'id', readings: [{ source: 'Hardware-ESP32', water_level: 51, timestamp: Date.now() - 9 * 60_000 }] });
  try {
    let tree = ui.render();
    find(tree, 'hardware-view-graph').props.onClick();
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /data terakhir, offline/);
    assert.match(text(find(tree, 'hardware-node-N1')), /51\.0 cm/);
    assert.match(text(find(tree, 'hardware-node-N1')), /data terakhir/);
  } finally { ui.restore(); }
});

test('overview graph waits for sensor data and does not present reset values as measurements', () => {
  const ui = mount({ language: 'en' });
  try {
    let tree = ui.render();
    find(tree, 'hardware-view-graph').props.onClick();
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /Waiting for ESP32 data/);
    assert.match(text(find(tree, 'hardware-graph')), /forecast is not yet available/);
    assert.doesNotMatch(text(find(tree, 'hardware-node-levels')), /—/);
    assert.doesNotMatch(text(find(tree, 'hardware-node-levels')), /60\.0 cm/);
  } finally { ui.restore(); }
});
