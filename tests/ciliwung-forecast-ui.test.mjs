import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createCiliwungEngine } from '../backend/ciliwung/simulation-engine.mjs';

const simulationPath = new URL('../src/components/CiliwungSimulationPage.tsx', import.meta.url);
const scadaPath = new URL('../src/components/SCADADashboard.tsx', import.meta.url);

// Execute the real TSX with a small hook renderer, without adding a DOM test dependency.
const bundle = await build({
  entryPoints: [fileURLToPath(simulationPath)],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  tsconfigRaw: { compilerOptions: { jsx: 'react' } },
  plugins: [{
    name: 'hooks-for-ui-contract',
    setup(plugin) {
      plugin.onResolve({ filter: /^\.\/CiliwungHardwareLiveView$/ }, () => ({ path: 'map', namespace: 'test-map' }));
      plugin.onLoad({ filter: /.*/, namespace: 'test-map' }, () => ({ contents: 'export const Map2D = () => null', loader: 'js' }));
      plugin.onResolve({ filter: /^recharts$/ }, () => ({ path: 'chart', namespace: 'test-chart' }));
      plugin.onLoad({ filter: /.*/, namespace: 'test-chart' }, () => ({ contents: "export const Curve = 'curve'", loader: 'js' }));
      plugin.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'test-hooks' }));
      plugin.onLoad({ filter: /.*/, namespace: 'test-hooks' }, () => ({
        contents: `
          export const useState = (...args) => globalThis.__simbaUiHooks.useState(...args);
          export const useEffect = (...args) => globalThis.__simbaUiHooks.useEffect(...args);
          export const useMemo = (...args) => globalThis.__simbaUiHooks.useMemo(...args);
          export const useRef = (...args) => globalThis.__simbaUiHooks.useRef(...args);
          export default { createElement: (...args) => globalThis.__simbaUiHooks.createElement(...args) };
        `,
        loader: 'js',
      }));
    },
  }],
});
const module = { exports: {} };
new Function('module', 'exports', bundle.outputFiles[0].text)(module, module.exports);
const SimulationPage = module.exports.default;

function mount({ language = 'en', episodes = [], latest = { status: 'unavailable', reason: 'insufficient_history' }, weather = { status: 'unavailable', reason: 'not_loaded' }, history = { runId: null, points: [] }, scenarioPreviews = null, projection = null } = {}) {
  const saved = { window: globalThis.window, fetch: globalThis.fetch, EventSource: globalThis.EventSource, hooks: globalThis.__simbaUiHooks };
  const calls = [];
  const streams = [];
  const slots = [];
  const effects = [];
  let slot = 0;
  let tree;
  globalThis.window = { location: { origin: 'http://localhost:3000' } };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
    const routeUrl = String(url);
    const payload = routeUrl.includes('/episodes') ? episodes : routeUrl.includes('/api/ciliwung-simulation/history') ? history : routeUrl.includes('/scenario-previews') ? scenarioPreviews : routeUrl.includes('/api/ciliwung-simulation/projection') ? projection : routeUrl.includes('/api/ciliwung-weather/context') ? weather : routeUrl.includes('/latest') ? latest : { success: true };
    return { ok: true, json: async () => payload };
  };
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.listeners = new Map(); streams.push(this); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    emit(name, data) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  };
  globalThis.__simbaUiHooks = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat() } }; },
    useState(initial) {
      const index = slot++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = slot++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory) { slot++; return factory(); },
    useEffect(effect, deps) {
      const index = slot++;
      const previous = slots[index];
      if (!previous || !deps || deps.some((value, position) => !Object.is(value, previous.deps?.[position]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  function render() {
    slot = 0;
    tree = SimulationPage({ theme: 'dark', language, onExit() {} });
    effects.splice(0).forEach((run) => run());
    return tree;
  }
  return { render, calls, streams, restore() {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
    globalThis.EventSource = saved.EventSource;
    globalThis.__simbaUiHooks = saved.hooks;
  } };
}

function descendants(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const child of node.props?.children ?? []) descendants(child, predicate, found);
  return found;
}
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return (node.props?.children ?? []).map(text).join('');
}
function byText(tree, tag, label) {
  return descendants(tree, (node) => node.type === tag && text(node).includes(label))[0];
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function snapshot({ runId = 'run-1', mode = 'rain_replay', episodeId = 'storm-2', status = 'running', simTimeSeconds = 300, timestampUtc = '2026-08-01T05:15:00Z', rain = 24, tma = 170 } = {}) {
  const names = { UP1: 'Puncak', UP2: 'Katulampa', UP3: 'Sukaraja', UP4: 'Cibinong', N1: 'Pos Depok', N2: 'Ciliwung Stage 1', N3: 'Ciliwung Stage 2', N4: 'Ciliwung Stage 3', N5: 'Pintu Air Manggarai' };
  const cupNodes = Object.keys(names).map((id) => ({
    id, name: names[id], cupcarbonNodeId: 1, threeDNodeId: id.startsWith('N') ? id : null,
    tmaCm: tma, stageRiseM: 0.1, status: 'AMAN', rainRateMmH: rain, rainMm5m: rain / 12, rainSource: 'synthetic',
  }));
  return { runId, mode, episodeId, scenario: null, status, speedMultiplier: 1, simTimeSeconds, timestampUtc,
    targetNodeId: null, targetThresholdCm: null, cupNodes, threeDNodes: cupNodes.filter((node) => node.threeDNodeId),
    cupcarbon: { status: 'not_verified', warning: '', lastSeenAt: null, activeNodeCount: 0 }, pendingReachCount: 0, updatedAt: 0 };
}

const sampleForecast = {
  runId: 'run-1', nodeId: 'N1', mode: 'synthetic_demo', issuedAt: '2026-08-01T05:15:00Z',
  generatedAt: '2026-10-10T00:00:00Z', clockBasis: 'simulation',
  predictedTmaCm: { '30': 205, '60': 265 }, crossingWithin: { '30': false, '60': true },
  trajectoryCm: [175, 180, 185, 190, 198, 205, 220, 230, 240, 250, 255, 265],
  thresholdBanjirCm: 260, method: 'lstm_synthetic_v1', modelVersion: 'v1',
  quality: 'experimental_synthetic_only', status: 'available',
};

test('simulation overview displays live simulation levels for all nodes without the weather card', async () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot({ tma: 170 }));
    const tree = ui.render();
    const panel = descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-levels')[0];
    assert.ok(panel);
    for (const name of ['Puncak', 'Katulampa', 'Sukaraja', 'Cibinong', 'Pos Depok', 'Ciliwung Stage 1', 'Ciliwung Stage 2', 'Ciliwung Stage 3', 'Pintu Air Manggarai']) assert.ok(text(panel).includes(name));
    assert.doesNotMatch(text(panel), /\b(?:UP[1-4]|N[1-5])\b/);
    assert.match(text(panel), /170\.0 cm/);
    assert.match(text(panel), /not sensor readings/);
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'bmkg-weather-context').length, 0);
    assert.equal(ui.calls.filter(call => call.url.includes('/api/ciliwung-weather/context')).length, 0);
  } finally { ui.restore(); }
});

test('150x can be selected and sent when starting heavy rain', async () => {
  const ui = mount();
  try {
    let tree = ui.render();
    const select = descendants(tree, node => node.type === 'select' && node.props?.['aria-label'] === 'Simulation speed')[0];
    assert.ok(descendants(select, node => node.type === 'option' && node.props.value === 150)[0]);
    await select.props.onChange({ target: { value: '150' } });
    tree = ui.render();
    byText(tree, 'button', 'Hujan Lebat').props.onClick();
    tree = ui.render();
    await byText(tree, 'button', 'Start Simulation').props.onClick();
    assert.deepEqual(ui.calls.find(call => call.url.endsWith('/api/ciliwung-simulation/start'))?.body,
      { scenario: 'lebat', speedMultiplier: 150 });
  } finally { ui.restore(); }
});

test('graph uses the selected node scenario maximum as its scale and expands for higher forecast values', async () => {
  const ui = mount();
  try {
    ui.render();
    await new Promise(resolve => setImmediate(resolve));
    const state = snapshot({ tma: 80 });
    ui.streams[0].emit('state', state);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    let tree = ui.render();
    let point = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    assert.equal(point.props.cy, 190 - 80 / 220 * 180);
    descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-N2')[0].props.onClick();
    tree = ui.render();
    point = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    assert.equal(point.props.cy, 190 - 80 / 260 * 180);
    ui.streams[0].emit('forecast', { ...sampleForecast, nodeId: 'N2', trajectoryCm: [250, 280, 310, 340, 370, 400, 410, 420, 430, 440, 450, 460] });
    tree = ui.render();
    point = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    assert.equal(point.props.cy, 190 - 80 / 440 * 180);
    const prediction = descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace')[0];
    assert.ok(prediction.props.points.every(({ y }) => y >= 10 && y <= 190));
  } finally { ui.restore(); }
});


test('viewer switches from default 2D to 3D and graph while current node levels remain independent', () => {
  const ui = mount({ language: 'id' });
  try {
    let tree = ui.render();
    const pressed = (label) => byText(tree, 'button', label).props['aria-pressed'];
    assert.equal(pressed('Peta 2D'), true);
    assert.equal(descendants(tree, node => node.type === 'iframe').length, 0);
    ui.streams[0].emit('state', snapshot({ tma: 170 }));
    tree = ui.render();
    byText(tree, 'button', 'Peta 3D').props.onClick();
    tree = ui.render();
    assert.equal(pressed('Peta 3D'), true);
    assert.equal(descendants(tree, node => node.type === 'iframe').length, 1);
    assert.match(text(descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-levels')[0]), /170\.0 cm/);
    ui.streams[0].emit('forecast', sampleForecast);
    byText(tree, 'button', 'Grafik Prediksi').props.onClick();
    tree = ui.render();
    assert.equal(pressed('Grafik Prediksi'), true);
    assert.equal(descendants(tree, node => node.type === 'iframe').length, 0);
    assert.match(text(tree), /belum tervalidasi untuk peringatan banjir operasional/i);
    assert.match(text(descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-levels')[0]), /170\.0 cm/);
    ui.streams[0].emit('state', snapshot({ tma: 180 }));
    tree = ui.render();
    assert.match(text(descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-levels')[0]), /180\.0 cm/);
    byText(tree, 'button', 'Peta 2D').props.onClick();
    assert.equal(byText(ui.render(), 'button', 'Peta 2D').props['aria-pressed'], true);
  } finally { ui.restore(); }
});

test('graph reports waiting, backend unavailability and stopped replay without inventing predictions', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    let tree = ui.render();
    assert.match(text(tree), /Waiting for the current forecast/);
    ui.streams[0].emit('forecast', { runId: 'run-1', nodeId: 'N1', issuedAt: sampleForecast.issuedAt, status: 'unavailable', reason: 'insufficient_history' });
    tree = ui.render();
    assert.match(text(tree), /Forecast unavailable: insufficient_history/);
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
    ui.streams[0].emit('forecast', sampleForecast);
    tree = ui.render();
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 1);
    ui.streams[0].emit('state', snapshot({ status: 'stopped' }));
    tree = ui.render();
    assert.match(text(tree), /Replay is not running/i);
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
  } finally { ui.restore(); }
});

test('node cards select and highlight the graph node only in graph view', () => {
  const ui = mount();
  try {
    let tree = ui.render();
    ui.streams[0].emit('state', snapshot());
    tree = ui.render();
    const node = (id) => descendants(tree, item => item.props?.['data-testid'] === `simulation-node-${id}`)[0];
    assert.equal(node('N1').props.disabled, true);
    assert.equal(node('N1').props['aria-pressed'], undefined);
    byText(tree, 'button', 'Forecast Graph').props.onClick();
    tree = ui.render();
    assert.equal(node('N1').props['aria-pressed'], true);
    assert.equal(node('N2').props['aria-pressed'], false);
    node('N2').props.onClick();
    tree = ui.render();
    assert.equal(node('N1').props['aria-pressed'], false);
    assert.equal(node('N2').props['aria-pressed'], true);
    assert.match(text(descendants(tree, item => item.props?.['data-testid'] === 'forecast-graph')[0]), /Ciliwung Stage 1/);
    assert.match(text(node('N2')), /170\.0 cm/);
    byText(tree, 'button', '2D Map').props.onClick();
    tree = ui.render();
    assert.equal(node('N2').props['aria-pressed'], undefined);
    assert.equal(node('N2').props.disabled, true);
  } finally { ui.restore(); }
});

test('episode selector starts the selected synthetic replay without replacing legacy scenario start', async () => {
  const ui = mount({ episodes: [{ episodeId: 'storm-1' }, { episodeId: 'storm-2' }] });
  try {
    let tree = ui.render();
    await tick();
    tree = ui.render();
    assert.ok(byText(tree, 'button', 'Synthetic replay'));
    byText(tree, 'button', 'Synthetic replay').props.onClick();
    tree = ui.render();
    const selector = descendants(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === 'Synthetic episode')[0];
    assert.ok(selector);
    selector.props.onChange({ target: { value: 'storm-2' } });
    tree = ui.render();
    await byText(tree, 'button', 'Start Replay').props.onClick();
    assert.deepEqual(ui.calls.find((call) => call.url.endsWith('/replay/start'))?.body,
      { episodeId: 'storm-2', speedMultiplier: 1 });
    assert.ok(byText(tree, 'button', 'Hujan Ringan'));
  } finally { ui.restore(); }
});

test('forecast graph hides a prediction when the simulation run or issue time changes', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    ui.streams[0].emit('forecast', sampleForecast);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    const trace = () => descendants(ui.render(), node => node.props?.['data-testid'] === 'forecast-tma-trace');
    assert.equal(trace().length, 1);
    ui.streams[0].emit('state', snapshot({ simTimeSeconds: 600, timestampUtc: '2026-08-01T05:20:00Z' }));
    assert.equal(trace().length, 0);
    ui.streams[0].emit('state', snapshot({ runId: 'run-2' }));
    assert.equal(trace().length, 0);
  } finally { ui.restore(); }
});

test('legacy graph follows current simulation and does not attach an unrelated preview', async () => {
  const ui = mount({ scenarioPreviews: { nodeId: 'N1', previews: [{ scenarioId: 'sedang', currentSyntheticTmaCm: 98, trajectoryCm: Array(12).fill(107) }] } });
  try {
    ui.render();
    const idle = snapshot({ runId: null, mode: 'legacy', episodeId: null, status: 'idle', simTimeSeconds: 0 });
    ui.streams[0].emit('state', idle);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    let tree = ui.render();
    assert.match(text(tree), /Start the simulation to see the graph/);
    assert.equal(descendants(tree, node => node.type === 'polyline').length, 0);
    const running = { ...snapshot({ runId: 'legacy', mode: 'legacy', episodeId: null, simTimeSeconds: 10, tma: 70 }), scenario: 'sedang' };
    ui.streams[0].emit('state', running);
    ui.render();
    ui.streams[0].emit('state', { ...running, simTimeSeconds: 20, cupNodes: running.cupNodes.map(node => ({ ...node, tmaCm: 72.3 })) });
    tree = ui.render();
    const current = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    const line = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-trace')[0];
    const panel = descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-levels')[0];
    assert.match(text(panel), /72\.3 cm/);
    assert.equal(current.props.cy, 190 - 72.3 / 220 * 180);
    assert.deepEqual(line.props.points.at(-1), { x: 360, y: current.props.cy });
    assert.match(text(tree), /Calculating scenario projection/);
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'scenario-preview-trace').length, 0);
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
    assert.equal(ui.calls.some(call => call.url.includes('/scenario-previews')), false);
    ui.streams[0].emit('state', { ...running, status: 'stopped', simTimeSeconds: 20 });
    tree = ui.render();
    assert.ok(descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0]);
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
  } finally { ui.restore(); }
});

test('legacy projection follows the actual run, joins the current point, and retires on stop', async () => {
  const engine = createCiliwungEngine({ autoStart: false });
  engine.start('sedang');
  for (let i = 0; i < 80; i++) engine.advance(0.5);
  const first = engine.getState();
  const projection = engine.getLegacyProjection('N1');
  const ui = mount({ projection });
  try {
    ui.render();
    ui.streams[0].emit('state', first);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    ui.render();
    await new Promise(resolve => setImmediate(resolve));
    let tree = ui.render();
    let current = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    let forecast = descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace')[0];
    assert.ok(forecast);
    assert.deepEqual(forecast.props.points[0], { x: 360, y: current.props.cy });
    assert.match(text(tree), /Projection from the current simulation, not an LSTM forecast/);
    assert.doesNotMatch(text(tree), /Scenario ends at/);
    assert.match(text(tree), /Estimate \+30 min/);
    const count = ui.calls.filter(call => call.url.includes('/api/ciliwung-simulation/projection')).length;
    const next = engine.advance(0.5);
    ui.streams[0].emit('state', next);
    tree = ui.render();
    current = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    forecast = descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace')[0];
    assert.ok(forecast, 'matching later state reuses the projection');
    assert.deepEqual(forecast.props.points[0], { x: 360, y: current.props.cy });
    const next30 = projection.points.find(point => point.afterSeconds === 1800.5);
    assert.ok(next30);
    assert.match(text(tree), new RegExp(`Estimate \\+30 min · ${next30.tmaCm.toFixed(1)} cm`));
    assert.equal(forecast.props.points.at(-1).x, 712);
    assert.equal(ui.calls.filter(call => call.url.includes('/api/ciliwung-simulation/projection')).length, count);
    ui.streams[0].emit('state', engine.stop());
    tree = ui.render();
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
  } finally { ui.restore(); engine.stop(); }
});

test('a slow projection response stays usable when the simulation advances during the request', async () => {
  const engine = createCiliwungEngine({ autoStart: false });
  engine.start('sedang');
  const first = engine.getState();
  const prediction = engine.getLegacyProjection('N1');
  let resolveProjection;
  const projection = new Promise(resolve => { resolveProjection = resolve; });
  const ui = mount({ projection });
  try {
    ui.render();
    ui.streams[0].emit('state', first);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    ui.render();
    ui.streams[0].emit('state', engine.advance(0.5));
    ui.render();
    assert.equal(ui.calls.filter(call => call.url.includes('/api/ciliwung-simulation/projection')).length, 1);
    resolveProjection(prediction);
    await new Promise(resolve => setImmediate(resolve));
    const tree = ui.render();
    const current = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    const forecast = descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace')[0];
    assert.ok(forecast);
    assert.deepEqual(forecast.props.points[0], { x: 360, y: current.props.cy });
  } finally { ui.restore(); engine.stop(); }
});

test('legacy projection stops at scenario completion rather than fabricating a 30-minute estimate', async () => {
  const engine = createCiliwungEngine({ autoStart: false });
  engine.start('lebat', 50);
  while (engine.getState().status === 'running' && engine.getState().simTimeSeconds < 8300) engine.advance(0.5);
  const current = engine.getState();
  const projection = engine.getLegacyProjection('N1');
  assert.equal(projection.scenarioCompletes, true);
  const ui = mount({ projection });
  try {
    ui.render();
    ui.streams[0].emit('state', current);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    ui.render();
    await new Promise(resolve => setImmediate(resolve));
    const tree = ui.render();
    assert.ok(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace')[0]);
    assert.match(text(tree), /Scenario ends at/);
    assert.doesNotMatch(text(tree), /Estimate \+30 min/);
  } finally { ui.restore(); engine.stop(); }
});

test('legacy projection is hidden if the run, speed, node, or current value no longer match', async () => {
  const engine = createCiliwungEngine({ autoStart: false });
  engine.start('sedang');
  const initial = engine.getState();
  const projection = engine.getLegacyProjection('N1');
  const ui = mount({ projection });
  try {
    ui.render();
    ui.streams[0].emit('state', initial);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    ui.render();
    await new Promise(resolve => setImmediate(resolve));
    let tree = ui.render();
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 1);
    const changed = { ...initial, cupNodes: initial.cupNodes.map(node => node.id === 'N1' ? { ...node, tmaCm: node.tmaCm + 5 } : node) };
    ui.streams[0].emit('state', changed);
    tree = ui.render();
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
    ui.streams[0].emit('state', { ...initial, speedMultiplier: 10 });
    tree = ui.render();
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
    ui.streams[0].emit('state', { ...initial, runId: 'different-run' });
    tree = ui.render();
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
  } finally { ui.restore(); engine.stop(); }
});

test('reconnecting loads matching backend history without overwriting newer live state', async () => {
  const points = [
    { runId: 'run-1', time: 0, values: { N1: 100 } },
    { runId: 'run-1', time: 300, values: { N1: 120 } },
    { runId: 'other-run', time: 100, values: { N1: 999 } },
  ];
  const ui = mount({ history: { runId: 'run-1', points } });
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot({ simTimeSeconds: 300, tma: 170 }));
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    ui.render();
    await new Promise(resolve => setImmediate(resolve));
    const tree = ui.render();
    const line = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-trace')[0];
    const current = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    assert.equal(line.props.points.length, 2);
    assert.deepEqual(line.props.points.at(-1), { x: 360, y: current.props.cy });
    assert.match(text(tree), /170\.0 cm/);
    assert.ok(!text(tree).includes('999 cm'));
  } finally { ui.restore(); }
});

test('switching a node moves the current point to that node and never reuses another node forecast', () => {
  const ui = mount();
  try {
    ui.render();
    const state = snapshot({ tma: 70 });
    state.cupNodes.find(node => node.id === 'N2').tmaCm = 100;
    ui.streams[0].emit('state', state);
    ui.streams[0].emit('forecast', sampleForecast);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    let tree = ui.render();
    const oldPoint = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 1);
    descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-N2')[0].props.onClick();
    tree = ui.render();
    const newPoint = descendants(tree, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    assert.notEqual(newPoint.props.cy, oldPoint.props.cy);
    assert.equal(newPoint.props.cy, 190 - 100 / 260 * 180);
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
    assert.match(text(descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-N2')[0]), /100\.0 cm/);
  } finally { ui.restore(); }
});

test('replay prediction begins at the current simulation point and ends at +30 minutes', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot({ tma: 172 }));
    ui.streams[0].emit('forecast', sampleForecast);
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    let tree = ui.render();
    const chart = descendants(tree, node => node.props?.['role'] === 'img' && node.props?.['aria-label'] === 'Water level forecast Pos Depok')[0];
    const traces = descendants(chart, node => node.props?.['data-testid'] === 'forecast-tma-trace');
    assert.equal(traces.length, 1);
    assert.equal(traces[0].props['data-testid'], 'forecast-tma-trace');
    assert.equal(traces[0].props.strokeDasharray, '1 7');
    assert.equal(traces[0].props.type, 'monotoneX');
    assert.equal(traces[0].props.points.length, 7);
    assert.equal(traces[0].props.points.at(-1).x, 712);
    const current = descendants(chart, node => node.props?.['data-testid'] === 'current-tma-point')[0];
    assert.deepEqual(traces[0].props.points[0], { x: 360, y: current.props.cy });
    assert.match(text(tree), /Estimate \+30 min · 205\.0 cm/);
    assert.match(text(tree), /Synthetic replay forecast/);
    ui.streams[0].emit('state', snapshot({ status: 'stopped' }));
    tree = ui.render();
    assert.equal(descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
  } finally { ui.restore(); }
});

test('forecast graph retains per-node forecasts and rejects missing thresholds', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    ui.streams[0].emit('forecast', sampleForecast);
    ui.streams[0].emit('forecast', { ...sampleForecast, nodeId: 'N2', thresholdBanjirCm: null, crossingWithin: { '30': null, '60': null } });
    byText(ui.render(), 'button', 'Forecast Graph').props.onClick();
    let tree = ui.render();
    const trace = () => descendants(tree, node => node.props?.['data-testid'] === 'forecast-tma-trace');
    assert.equal(trace().length, 1);
    descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-N2')[0].props.onClick();
    tree = ui.render();
    assert.equal(trace().length, 0);
    descendants(tree, node => node.props?.['data-testid'] === 'simulation-node-N1')[0].props.onClick();
    tree = ui.render();
    assert.equal(trace().length, 1);
  } finally { ui.restore(); }
});

test('single-node legacy prediction panel states provenance without claiming LSTM or invented per-horizon confidence', async () => {
  const source = await readFile(scadaPath, 'utf8');
  assert.match(source, /fetch\('\/api\/predict'/, 'single-node endpoint remains unchanged');
  assert.match(source, /Single-node advisory.*Gemini.*heuristic/i);
  assert.doesNotMatch(source, /Processed LSTM/i);
  assert.doesNotMatch(source, /Math\.round\(latestPrediction\.confidence_score\s*\*/);
});

test('legacy graph restores the backend-selected rainfall profile after a page reconnect', () => {
  const ui = mount();
  try {
    ui.render();
    const state = { ...snapshot({ runId: 'legacy-selected-sedang', mode: 'legacy', episodeId: null, status: 'completed', simTimeSeconds: 10 }), scenario: 'sedang' };
    ui.streams[0].emit('state', state);
    let tree = ui.render();
    byText(tree, 'button', 'Forecast Graph').props.onClick();
    tree = ui.render();
    assert.match(text(tree), /Legacy simulation · Hujan Sedang/);
    assert.doesNotMatch(text(tree), /Legacy simulation · Hujan Ringan/);
  } finally { ui.restore(); }
});

test('legacy profile still uses scenario start and never presents a synthetic forecast as active', async () => {
  const ui = mount();
  try {
    let tree = ui.render();
    assert.equal(descendants(tree, (node) => node.props?.['data-testid'] === 'ciliwung-forecast').length, 0);
    byText(tree, 'button', 'Hujan Sedang').props.onClick();
    tree = ui.render();
    await byText(tree, 'button', 'Start Simulation').props.onClick();
    assert.deepEqual(ui.calls.find((call) => call.url.endsWith('/api/ciliwung-simulation/start'))?.body,
      { scenario: 'sedang', speedMultiplier: 1 });
    assert.equal(ui.calls.some((call) => call.url.endsWith('/replay/start')), false);
  } finally { ui.restore(); }
});
