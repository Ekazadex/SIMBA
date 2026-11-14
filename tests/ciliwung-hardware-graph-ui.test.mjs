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

function mount(props = {}, options = {}) {
  const saved = { window: globalThis.window, EventSource: globalThis.EventSource, hooks: globalThis.__hardwareHooks, fetch: globalThis.fetch };
  const slots = [], effects = [], streams = [];
  const timers = new Map(); let nextTimer = 0;
  let index = 0;
  globalThis.window = { location: { origin: 'http://localhost:3000' }, setInterval: () => 1, clearInterval() {}, setTimeout: options.timers ? fn => { const id = ++nextTimer; timers.set(id, fn); return id; } : () => 1, clearTimeout(id) { timers.delete(id); } };
  if (options.fetch) globalThis.fetch = options.fetch;
  globalThis.EventSource = class {
    constructor() { this.listeners = {}; streams.push(this); }
    addEventListener(name, cb) { this.listeners[name] = cb; }
    emit(data) { this.listeners.state({ data: JSON.stringify(data) }); }
    close() {}
  };
  globalThis.__hardwareHooks = {
    createElement(type, elementProps, ...children) {
      const allProps = { ...elementProps, children: children.flat() };
      if (typeof type === 'function') return ['GraphView', 'AnimatedHistory'].includes(type.name) ? type(allProps) : { type: type.name, props: allProps };
      return { type, props: allProps };
    },
    useState(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial; return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }]; },
    useEffect(effect, deps) { const slot = index++; const previous = slots[slot]; if (!previous || deps?.some((d, i) => !Object.is(d, previous.deps?.[i]))) effects.push(() => { previous?.cleanup?.(); slots[slot] = { deps, cleanup: effect() }; }); },
    useMemo(factory) { index++; return factory(); },
    useRef(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; },
  };
  return {
    streams,
    flushTimers() { const queued = [...timers.values()]; timers.clear(); queued.forEach(fn => fn()); },
    render() { index = 0; const tree = module.exports.default({ compact: true, ...props }); effects.splice(0).forEach((effect) => effect()); return tree; },
    restore() { globalThis.window = saved.window; globalThis.EventSource = saved.EventSource; globalThis.__hardwareHooks = saved.hooks; globalThis.fetch = saved.fetch; },
  };
}
function find(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.props?.['data-testid'] === id) return node;
  for (const child of node.props?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}
function text(node) { if (node == null || typeof node === 'boolean') return ''; if (typeof node !== 'object') return String(node); return (node.props?.children ?? []).map(text).join(''); }
function assertSelectedGuide(tree) {
  const guide = find(tree, 'graph-selected-guide');
  const point = find(tree, 'graph-selected-point');
  assert.ok(guide && point);
  assert.equal(guide.props.x1, point.props.cx);
  assert.equal(guide.props.x2, point.props.cx);
  assert.equal(guide.props.pointerEvents, 'none');
}
const selectedClock = timestamp => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp));
const selectedDate = timestamp => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit' }).format(new Date(timestamp));

test('overview graph shows measured ESP32 history and clearly distinguishes derived locations without inventing predictions', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', readings: [
    { source: 'Hardware-ESP32', water_level: 68, timestamp: now - 120000 },
    { source: 'Simulator-Engine', water_level: 999, timestamp: now - 180000 },
  ] });
  try {
    let tree = ui.render();
    assert.ok(find(tree, 'hardware-view-map2d'));
    assert.equal(find(tree, 'hardware-graph'), null);
    find(tree, 'hardware-view-graph').props.onClick();
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /Pembacaan sensor ESP32/);
    assert.match(text(find(tree, 'hardware-graph')), /Prediksi demo/);
    assert.doesNotMatch(text(find(tree, 'hardware-node-levels')), /999/);
    ui.streams[0].emit(buildHardwareSnapshot({ levelCm: 72, measuredAt: new Date(now).toISOString() }));
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-node-N1')), /72\.0 cm/);
    assert.ok(find(tree, 'hardware-history-trace'));
    assert.equal(find(tree, 'hardware-history-trace').props.type, 'monotoneX');
    find(tree, 'hardware-node-N2').props.onClick();
    tree = ui.render();
    assert.equal(find(tree, 'hardware-node-N2').props['aria-pressed'], true);
    assert.doesNotMatch(text(find(tree, 'hardware-graph')), /Turunan preset visual · bukan pembacaan sensor/);
    assert.match(text(find(tree, 'hardware-node-N2')), /bukan sensor/);
    assert.ok(find(tree, 'hardware-history-trace'), 'downstream history is reconstructed from N1');
    assert.doesNotMatch(text(find(tree, 'hardware-graph')), /Riwayat direkonstruksi/);
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

test('selecting an earlier reading recalculates the forecast without later readings', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', readings: [
    { source: 'Hardware-ESP32', water_level: 10, timestamp: now - 120000 },
    { source: 'Hardware-ESP32', water_level: 12, timestamp: now - 60000 },
    { source: 'Hardware-ESP32', water_level: 2, timestamp: now },
  ] });
  try {
    let tree = ui.render();
    find(tree, 'hardware-view-graph').props.onClick();
    tree = ui.render();
    find(tree, 'history-graph').props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} });
    tree = ui.render();
    assertSelectedGuide(tree);
    assert.match(text(find(tree, 'selected-graph-value')), /12\.0 cm.*RIWAYAT/);
    assert.equal(find(tree, 'history-graph').props.role, 'slider');
    assert.equal(find(tree, 'history-graph').props['aria-valuenow'], 1);
    assert.match(find(tree, 'history-graph').props['aria-valuetext'], /12\.0 cm/);
    assert.equal(text(find(tree, 'graph-selected-tooltip-text')), `${selectedClock(now - 60000)} WIB`);
    assert.equal(find(tree, 'trend-forecast-trace'), null, 'insufficient input must not invent a forecast');
    find(tree, 'history-graph').props.onKeyDown({ key: 'End', preventDefault() {} });
    tree = ui.render();
    assert.match(text(find(tree, 'selected-graph-value')), /2\.0 cm.*LIVE/);
    assertSelectedGuide(tree);
    assert.equal(find(tree, 'graph-selected-tooltip'), null);
  } finally { ui.restore(); }
});

test('sensor graph retains more than 48 batches across the 30 minute window', () => {
  const now = Date.now();
  const readings = Array.from({ length: 90 }, (_, i) => ({ source: 'Hardware-ESP32-SoilWake', water_level: 10, timestamp: now - (89 - i) * 20000 }));
  const ui = mount({ language: 'id', readings });
  try {
    let tree = ui.render();
    find(tree, 'hardware-view-graph').props.onClick();
    tree = ui.render();
    assert.equal(find(tree, 'hardware-history-trace').props.points.length, 90);
  } finally { ui.restore(); }
});

test('overview graph waits for sensor data and does not present reset values as measurements', () => {
  const ui = mount({ language: 'en' });
  try {
    let tree = ui.render();
    find(tree, 'hardware-view-graph').props.onClick();
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /Waiting for ESP32 data/);
    assert.equal(find(tree, 'graph-time-slider'), null);
    assert.doesNotMatch(text(find(tree, 'hardware-graph')), /Forecast unavailable while data is stale/);
    assert.doesNotMatch(text(find(tree, 'hardware-node-levels')), /—/);
    assert.doesNotMatch(text(find(tree, 'hardware-node-levels')), /60\.0 cm/);
  } finally { ui.restore(); }
});

test('graph uses configured N1 limits and distinct downstream preset limits', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', config: { threshold_siaga: 20, threshold_bahaya: 50 }, readings: [{ source: 'Hardware-ESP32', water_level: 35, timestamp: now }] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /Siaga 20 cm/);
    assert.match(text(find(tree, 'hardware-graph')), /Bahaya 50 cm/);
    assert.ok(find(tree, 'graph-siaga-limit')); assert.ok(find(tree, 'graph-bahaya-limit'));
    find(tree, 'hardware-node-N2').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /Siaga 180 cm/);
    assert.match(text(find(tree, 'hardware-graph')), /Bahaya 280 cm/);
    assert.match(text(find(tree, 'hardware-graph')), /preset visual/);
  } finally { ui.restore(); }
});

test('packet readings still support sensor-distance view without a batch button', () => {
  const now = Date.now();
  const reading = { source: 'Hardware-ESP32', timestamp: now, water_level: 20, readings: [{ distance: 100 }, { distance: 101 }] };
  const ui = mount({ language: 'en', readings: [reading] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    assert.doesNotMatch(text(find(tree, 'hardware-graph')), /Raw batch|Batch mentah/);
    find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'selected-graph-value')), /101\.0 cm/);
    find(tree, 'graph-metric-elevation').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'selected-graph-value')), /20\.0 cm/);
  } finally { ui.restore(); }
});

test('24-hour selection loads older readings and reports partial coverage', async () => {
  const now = Date.now();
  const ui = mount({ language: 'id', readings: [{ source: 'Hardware-ESP32', water_level: 31, timestamp: now }], loadDayHistory: async () => ({ readings: [{ source: 'Hardware-ESP32', water_level: 12, timestamp: now - 60 * 60_000 }], failed: true, truncated: false }) });
  const button = (node, label) => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'button' && text(node) === label) return node;
    for (const child of node.props?.children ?? []) { const found = button(child, label); if (found) return found; }
    return null;
  };
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    button(tree, '24 jam').props.onClick();
    tree = ui.render(); assert.match(text(find(tree, 'hardware-graph')), /Memuat riwayat/);
    await Promise.resolve(); await Promise.resolve();
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /Sebagian kueri gagal/);
    assert.match(text(find(tree, 'hardware-graph')), /2 pembacaan/);
    find(tree, 'history-graph').props.onKeyDown({ key: 'Home', preventDefault() {} });
    tree = ui.render(); assert.match(text(find(tree, 'selected-graph-value')), /12\.0 cm.*RIWAYAT/);
    assert.equal(text(find(tree, 'graph-selected-tooltip-text')), `${selectedDate(now - 60 * 60_000)} ${selectedClock(now - 60 * 60_000)} WIB`);
  } finally { ui.restore(); }
});

test('late forecast responses cannot replace a historical selection or use later readings', async () => {
  const now = Date.now(); const requests = [];
  const ui = mount({ language: 'id', readings: [
    { source: 'Hardware-ESP32', water_level: 10, timestamp: now - 40_000 },
    { source: 'Hardware-ESP32', water_level: 20, timestamp: now - 20_000 },
    { source: 'Hardware-ESP32', water_level: 30, timestamp: now },
  ] }, { timers: true, fetch: (_url, options) => new Promise(resolve => requests.push({ resolve, options })) });
  const response = value => ({ ok: true, json: async () => ({ levelsCm: Array(90).fill(value), stepSeconds: 20 }) });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render(); ui.flushTimers();
    assert.equal(requests.length, 1);
    find(tree, 'history-graph').props.onKeyDown({ key: 'Home', preventDefault() {} }); tree = ui.render(); ui.flushTimers();
    assert.equal(requests.length, 2); assert.equal(requests[0].options.signal.aborted, true);
    const history = JSON.parse(requests[1].options.body).history;
    assert.deepEqual(history.map(point => point.level), [10]);
    requests[1].resolve(response(11));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    tree = ui.render();
    const before = find(tree, 'trend-forecast-trace').props.points;
    const startX = Number(before.split(' ')[0].split(',')[0]);
    assert.equal(startX, find(tree, 'graph-selected-point').props.cx);
    requests[0].resolve(response(900));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    tree = ui.render(); assert.equal(find(tree, 'trend-forecast-trace').props.points, before);
  } finally { ui.restore(); }
});

test('downstream cards show stale derived presets from the last ESP32 reading when the stream has no snapshot', () => {
  const ui = mount({ language: 'id', config: { threshold_siaga: 60, threshold_bahaya: 90 }, readings: [{ source: 'Hardware-ESP32', water_level: 28, timestamp: Date.now() - 9 * 60_000 }] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    for (const [id, level] of [['N1', '28.0'], ['N2', '75.0'], ['N3', '85.0'], ['N4', '95.0'], ['N5', '105.0']]) {
      const card = text(find(tree, `hardware-node-${id}`));
      assert.match(card, new RegExp(`${level.replace('.', '\\.')} cm`));
      assert.match(card, /data terakhir/);
      if (id !== 'N1') assert.match(card, /Preset visual · bukan sensor/);
    }
    assert.equal(find(tree, 'graph-time-slider'), null);
    assert.equal(find(tree, 'graph-selection'), null);
    assert.doesNotMatch(text(find(tree, 'hardware-graph')), /Geser titik atau penggeser|Prediksi tidak tersedia saat data sudah lama/);
  } finally { ui.restore(); }
});

test('a newer stored ESP32 reading updates downstream cards instead of showing an older snapshot', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', config: { threshold_siaga: 60, threshold_bahaya: 90 }, readings: [{ source: 'Hardware-ESP32', water_level: 28, timestamp: now }] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); ui.render();
    ui.streams[0].emit(buildHardwareSnapshot({ levelCm: 95, measuredAt: new Date(now - 60_000).toISOString() }));
    tree = ui.render();
    assert.match(text(find(tree, 'hardware-node-N1')), /28\.0 cm/);
    assert.match(text(find(tree, 'hardware-node-N2')), /75\.0 cm/);
  } finally { ui.restore(); }
});

test('sensor-distance view uses N1 readings, its own scale and reference without elevation forecast or limits', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', config: { threshold_siaga: 60, threshold_bahaya: 90, reference_height: 182 }, readings: [
    { source: 'Hardware-ESP32', water_level: 25, distance: 157, timestamp: now - 20_000 },
    { source: 'Hardware-ESP32', water_level: 28, distance: 154, timestamp: now },
  ] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'graph-metric-elevation').props['aria-pressed'], true);
    find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'graph-metric-distance').props['aria-pressed'], true);
    assert.match(text(find(tree, 'selected-graph-value')), /154\.0 cm/);
    assert.match(text(find(tree, 'hardware-graph')), /Jarak sensor Pos Depok \(N1\) dapat berupa nilai tercatat atau perkiraan/);
    assert.ok(find(tree, 'graph-reference-limit'));
    assert.equal(find(tree, 'graph-siaga-limit'), null);
    assert.equal(find(tree, 'trend-forecast-trace'), null);
    assert.match(find(tree, 'history-graph').props['aria-label'], /Riwayat jarak sensor/);
    assert.equal(find(tree, 'graph-selected-point').props.cx, 650);
    find(tree, 'history-graph').props.onKeyDown({ key: 'Home', preventDefault() {} }); tree = ui.render();
    assert.match(text(find(tree, 'selected-graph-value')), /157\.0 cm.*RIWAYAT/);
    assertSelectedGuide(tree);
    assert.equal(text(find(tree, 'graph-selected-tooltip-text')), `${selectedClock(now - 20_000)} WIB`);
    find(tree, 'graph-metric-elevation').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'selected-graph-value')), /28\.0 cm.*LIVE/);
    assert.ok(find(tree, 'graph-siaga-limit'));
  } finally { ui.restore(); }
});

test('sensor distance can be opened from a downstream node and is shown for N1', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', config: { reference_height: 182 }, readings: [{ source: 'Hardware-ESP32', water_level: 28, timestamp: now }] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'selected-graph-value')), /154\.0 cm.*perkiraan/);
    find(tree, 'hardware-node-N2').props.onClick(); tree = ui.render();
    assert.notEqual(find(tree, 'graph-metric-distance').props.disabled, true);
    assert.equal(find(tree, 'graph-metric-elevation').props['aria-pressed'], true);
    find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'hardware-node-N1').props['aria-pressed'], true);
    assert.equal(find(tree, 'graph-metric-distance').props['aria-pressed'], true);
    assert.match(text(find(tree, 'selected-graph-value')), /154\.0 cm.*perkiraan/);
  } finally { ui.restore(); }
});

test('without distance or a reference the distance view reports unavailable rather than inventing a value', () => {
  const ui = mount({ language: 'id', readings: [{ source: 'Hardware-ESP32', water_level: 28, timestamp: Date.now() }] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'hardware-graph')), /Jarak sensor belum tersedia/);
    assert.equal(find(tree, 'selected-graph-value'), null);
  } finally { ui.restore(); }
});

test('matching live snapshot keeps the packet distance instead of replacing it with an estimate', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', config: { threshold_siaga: 60, threshold_bahaya: 90, reference_height: 182 }, readings: [{ source: 'Hardware-ESP32', water_level: 28, distance: 160, timestamp: now }] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); ui.render();
    ui.streams[0].emit(buildHardwareSnapshot({ levelCm: 28, measuredAt: new Date(now).toISOString() }));
    tree = ui.render(); find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'selected-graph-value')), /160\.0 cm/);
    assert.doesNotMatch(text(find(tree, 'selected-graph-value')), /perkiraan/);
  } finally { ui.restore(); }
});

test('an old last distance is not labeled live merely because a newer water level exists', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', readings: [
    { source: 'Hardware-ESP32', water_level: 25, distance: 157, timestamp: now - 9 * 60_000 },
    { source: 'Hardware-ESP32', water_level: 28, timestamp: now },
  ] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.match(text(find(tree, 'selected-graph-value')), /157\.0 cm.*DATA TERAKHIR/);
    assert.match(text(find(tree, 'hardware-graph')), /jarak terakhir/);
    assert.doesNotMatch(text(find(tree, 'hardware-graph')), /data terakhir, offline/);
  } finally { ui.restore(); }
});

test('graph renders detailed chronological labels for history, forecast and sensor distance', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', config: { reference_height: 182 }, readings: [
    { source: 'Hardware-ESP32', water_level: 25, distance: 157, timestamp: now - 1_800_000 },
    { source: 'Hardware-ESP32', water_level: 28, distance: 154, timestamp: now },
  ] });
  const collect = (node, id) => {
    if (!node || typeof node !== 'object') return [];
    return [...(node.props?.['data-testid'] === id ? [node] : []), ...(node.props?.children ?? []).flatMap(child => collect(child, id))];
  };
  const format = timestamp => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp));
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    let historyTicks = collect(tree, 'history-time-tick');
    const futureTicks = collect(tree, 'forecast-time-tick');
    assert.equal(historyTicks.length, 5); assert.equal(futureTicks.length, 4);
    assert.equal(text(historyTicks[0]), format(now - 1_800_000));
    assert.equal(text(historyTicks[4]), format(now));
    assert.equal(text(futureTicks[3]), format(now + 1_800_000));
    find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    historyTicks = collect(tree, 'history-time-tick');
    assert.equal(historyTicks.length, 9); assert.equal(collect(tree, 'forecast-time-tick').length, 0);
    assert.equal(text(historyTicks[8]), format(now));
  } finally { ui.restore(); }
});

test('location panel starts open, can be hidden and restored without changing the selected node', () => {
  const ui = mount({ language: 'id', readings: [{ source: 'Hardware-ESP32', water_level: 28, timestamp: Date.now() }] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'hardware-node-levels').props.hidden, false);
    assert.equal(find(tree, 'toggle-node-panel').props['aria-expanded'], true);
    find(tree, 'hardware-node-N3').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'hardware-node-N3').props['aria-pressed'], true);
    find(tree, 'toggle-node-panel').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'hardware-node-levels').props.hidden, true);
    assert.equal(find(tree, 'toggle-node-panel').props['aria-expanded'], false);
    assert.match(text(find(tree, 'toggle-node-panel')), /Tampilkan lokasi/);
    assert.match(text(find(tree, 'hardware-graph')), /Ciliwung Stage 2/);
    find(tree, 'toggle-node-panel').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'hardware-node-levels').props.hidden, false);
    assert.equal(find(tree, 'hardware-node-N3').props['aria-pressed'], true);
  } finally { ui.restore(); }
});

test('simulation distance is calculated from simulated N1, including when selected from a downstream node', () => {
  const now = Date.now();
  const ui = mount({ language: 'id', config: { reference_height: 182, threshold_siaga: 60, threshold_bahaya: 90 }, readings: [{ source: 'Hardware-ESP32', water_level: 10, distance: 999, timestamp: now - 20_000 }] });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); ui.render();
    ui.streams[0].emit(buildHardwareSnapshot({ levelCm: 28, measuredAt: new Date(now).toISOString(), simulated: true }));
    tree = ui.render();
    find(tree, 'hardware-node-N3').props.onClick(); tree = ui.render();
    assert.notEqual(find(tree, 'graph-metric-distance').props.disabled, true);
    find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'hardware-node-N1').props['aria-pressed'], true);
    assert.equal(find(tree, 'graph-metric-distance').props['aria-pressed'], true);
    assert.match(text(find(tree, 'selected-graph-value')), /154\.0 cm.*perkiraan/);
    assert.match(text(find(tree, 'hardware-graph')), /Jarak simulasi.*bukan pembacaan sensor/);
    assert.doesNotMatch(text(find(tree, 'hardware-graph')), /999\.0 cm/);
  } finally { ui.restore(); }
});

test('simulation distance without a configured reference is shown as unavailable', () => {
  const now = Date.now();
  const ui = mount({ language: 'id' });
  try {
    let tree = ui.render(); find(tree, 'hardware-view-graph').props.onClick(); ui.render();
    ui.streams[0].emit(buildHardwareSnapshot({ levelCm: 28, measuredAt: new Date(now).toISOString(), simulated: true }));
    tree = ui.render(); find(tree, 'graph-metric-distance').props.onClick(); tree = ui.render();
    assert.equal(find(tree, 'graph-metric-distance').props['aria-pressed'], true);
    assert.match(text(find(tree, 'hardware-graph')), /Jarak sensor belum tersedia/);
    assert.equal(find(tree, 'selected-graph-value'), null);
  } finally { ui.restore(); }
});
