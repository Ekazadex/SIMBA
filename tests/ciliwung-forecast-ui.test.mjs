import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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

function mount({ episodes = [], latest = { status: 'unavailable', reason: 'insufficient_history' }, weather = { status: 'unavailable', reason: 'not_loaded' }, history = { runId: null, points: [] }, scenarioPreviews = null } = {}) {
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
    const payload = routeUrl.includes('/episodes') ? episodes : routeUrl.includes('/api/ciliwung-simulation/history') ? history : routeUrl.includes('/scenario-previews') ? scenarioPreviews : routeUrl.includes('/api/ciliwung-weather/context') ? weather : routeUrl.includes('/latest') ? latest : { success: true };
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
    tree = SimulationPage({ theme: 'dark', language: 'en', onExit() {} });
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
  const cupNodes = ['UP1', 'UP2', 'UP3', 'UP4', 'N1', 'N2', 'N3', 'N4', 'N5'].map((id) => ({
    id, name: id, cupcarbonNodeId: 1, threeDNodeId: id.startsWith('N') ? id : null,
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

test('BMKG live forecast context is shown with location and issue time but never as measured replay rainfall', async () => {
  const ui = mount({ weather: {
    source: 'BMKG', kind: 'forecast_context', status: 'available',
    location: { desa: 'Kukusan', kecamatan: 'Beji' },
    issuedAt: '2026-08-01T00:00:00Z', validFrom: '2026-08-01T03:00:00Z',
    validTo: '2026-08-01T06:00:00Z', weatherDesc: 'Hujan Ringan',
    acquiredAt: '2026-08-01T02:00:00Z',
  } });
  try {
    ui.render();
    await tick();
    const tree = ui.render();
    const card = descendants(tree, (node) => node.props?.['data-testid'] === 'bmkg-weather-context')[0];
    assert.ok(card);
    assert.match(text(card), /BMKG.*Kukusan.*Hujan Ringan/s);
    assert.match(text(card), /issued.*07:00.*valid.*10:00/i);
    assert.match(text(card), /not.*observed.*5-minute.*not.*LSTM input/i);
    assert.equal(ui.calls.filter((call) => call.url.includes('/api/ciliwung-weather/context')).length, 1);
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

test('matching forecast SSE shows distinct 30/60 simulation-time predictions with provenance; a new run hides old predictions', async () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    ui.streams[0].emit('forecast', sampleForecast);
    let tree = ui.render();
    const panel = descendants(tree, (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    assert.ok(panel, 'a separate forecast panel exists');
    assert.match(text(panel), /SYNTHETIC DEMO/);
    assert.match(text(panel), /N1/);
    assert.match(text(panel), /lstm_synthetic_v1.*v1/i);
    assert.match(text(panel), /12:15.*WIB/);
    assert.match(text(panel), /experimental.*not validated/i);
    const halfHour = descendants(panel, (node) => node.props?.['data-testid'] === 'forecast-30')[0];
    const hour = descendants(panel, (node) => node.props?.['data-testid'] === 'forecast-60')[0];
    assert.match(text(halfHour), /205\.0 cm.*12:45.*not indicated/i);
    assert.match(text(hour), /265\.0 cm.*13:15.*within 60 min/i);
    ui.streams[0].emit('state', snapshot({ runId: 'run-2', episodeId: 'storm-3' }));
    tree = ui.render();
    assert.doesNotMatch(text(descendants(tree, (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0]), /265\.0 cm/);
  } finally { ui.restore(); }
});

test('a later five-minute state bin hides an earlier forecast from the same run', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    ui.streams[0].emit('forecast', sampleForecast);
    let panel = descendants(ui.render(), (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    assert.match(text(panel), /205\.0 cm/);
    ui.streams[0].emit('state', snapshot({ simTimeSeconds: 600, timestampUtc: '2026-08-01T05:20:00Z', tma: 174 }));
    panel = descendants(ui.render(), (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    assert.doesNotMatch(text(panel), /205\.0 cm/);
    assert.match(text(panel), /Forecast unavailable/);
    ui.streams[0].emit('forecast', { ...sampleForecast, issuedAt: '2026-08-01T05:20:00Z', predictedTmaCm: { '30': 207, '60': 269 } });
    panel = descendants(ui.render(), (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    assert.match(text(panel), /207\.0 cm/);
  } finally { ui.restore(); }
});

test('replay page hydrates 96 causal historical bins so rain and level trends are visible immediately', async () => {
  const points = Array.from({ length: 96 }, (_, i) => ({
    runId: 'run-1', time: i * 300, timestampUtc: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 300_000).toISOString(),
    values: { N1: 60 + i / 10 }, rainRatesMmH: { N1: i >= 90 ? 24 : 0 },
  }));
  const ui = mount({ history: { runId: 'run-1', episodeId: 'storm-2', points } });
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot({ simTimeSeconds: 95 * 300 }));
    ui.render();
    await new Promise((resolve) => setImmediate(resolve));
    const graphButton = byText(ui.render(), 'button', 'View Graph');
    graphButton.props.onClick();
    const tree = ui.render();
    assert.match(text(tree), /96 past five-minute bins from backend replay.*not Firestore/i);
    const graph = descendants(tree, (node) => node.type === 'svg' && node.props?.['aria-label'] === 'Grafik TMA N1')[0];
    const current = descendants(graph, (node) => node.props?.['data-testid'] === 'current-tma-trace')[0];
    const rain = descendants(graph, (node) => node.props?.['data-testid'] === 'synthetic-rain-trace')[0];
    assert.ok(current?.props.points.split(' ').length >= 96);
    assert.ok(rain?.props.points.split(' ').length >= 96);
    assert.equal(ui.calls.filter((call) => call.url.endsWith('/api/ciliwung-simulation/history')).length, 1);
  } finally { ui.restore(); }
});

test('legacy scenario graph hydrates buffered state history instead of promising replay-only rain bins', async () => {
  const points = [0, 1, 2].map((time) => ({
    runId: 'legacy-run', time, values: { N1: 202 + time }, rainRatesMmH: {},
  }));
  const ui = mount({ history: { runId: 'legacy-run', episodeId: null, points } });
  try {
    ui.render();
    const legacyState = { ...snapshot({ runId: 'legacy-run', mode: 'legacy', episodeId: null, status: 'completed', simTimeSeconds: 2 }), scenario: 'sedang' };
    legacyState.cupNodes.forEach((node) => { delete node.rainRateMmH; delete node.rainMm5m; });
    ui.streams[0].emit('state', legacyState);
    ui.render();
    await new Promise((resolve) => setImmediate(resolve));
    byText(ui.render(), 'button', 'View Graph').props.onClick();
    const tree = ui.render();
    const graph = descendants(tree, (node) => node.type === 'svg' && node.props?.['aria-label'] === 'Grafik TMA N1')[0];
    const current = descendants(graph, (node) => node.props?.['data-testid'] === 'current-tma-trace')[0];
    assert.ok(current?.props.points.split(' ').length >= 3);
    assert.match(text(tree), /buffered legacy state samples/i);
    assert.doesNotMatch(text(tree), /Initial 96 past five-minute bins from backend replay/i);
    assert.equal(descendants(graph, (node) => node.props?.['data-testid'] === 'synthetic-rain-trace').length, 0);
    assert.equal(ui.calls.filter((call) => call.url.endsWith('/api/ciliwung-simulation/history')).length, 1);
  } finally { ui.restore(); }
});

test('legacy graph overlays three separate synthetic-v2 model scenario previews for the selected node', async () => {
  const previews = [
    { scenarioId: 'ringan', label: 'Hujan Ringan', currentSyntheticTmaCm: 73.56, rainfallDepthMmPerCatchment: { UP1: 8, N5: 7 }, predictedTmaCm: { '30': 86.57, '60': 101.9 }, trajectoryCm: [76.45, 79.32, 85.25, 82.65, 86.34, 86.57, 95.44, 97.5, 95.58, 94.31, 97.16, 101.9], method: 'lstm_synthetic_v2', modelVersion: 'synthetic_v2_N1' },
    { scenarioId: 'sedang', label: 'Hujan Sedang', currentSyntheticTmaCm: 152.6, rainfallDepthMmPerCatchment: { UP1: 20, UP2: 15, N1: 8, N5: 10 }, predictedTmaCm: { '30': 205.8, '60': 252.1 }, trajectoryCm: [169.9, 177.6, 187.7, 178.1, 201.8, 205.8, 218.7, 241.9, 251.2, 255.6, 256.8, 252.1], method: 'lstm_synthetic_v2', modelVersion: 'synthetic_v2_N1' },
    { scenarioId: 'lebat', label: 'Hujan Lebat', currentSyntheticTmaCm: 248.7, rainfallDepthMmPerCatchment: { UP2: 35, UP4: 20, N1: 12, N5: 18 }, predictedTmaCm: { '30': 338.8, '60': 421.9 }, trajectoryCm: [260.2, 295.9, 287.2, 298.8, 322.3, 338.8, 339.5, 379.6, 394.6, 418.2, 419.8, 421.9], method: 'lstm_synthetic_v2', modelVersion: 'synthetic_v2_N1' },
  ];
  const points = [0, 1, 2].map((time) => ({ runId: 'legacy-run', time, values: { N1: 200 + time }, rainRatesMmH: {} }));
  const ui = mount({
    history: { runId: 'legacy-run', episodeId: null, points },
    scenarioPreviews: { nodeId: 'N1', datasetVersion: 'synthetic_v2', quality: 'experimental_synthetic_only', previews },
  });
  try {
    ui.render();
    await tick();
    let tree = ui.render();
    byText(tree, 'button', 'Hujan Sedang').props.onClick();
    const legacyState = { ...snapshot({ runId: 'legacy-run', mode: 'legacy', episodeId: null, status: 'completed', simTimeSeconds: 2 }), scenario: 'sedang' };
    legacyState.cupNodes.forEach((node) => { delete node.rainRateMmH; delete node.rainMm5m; });
    ui.streams[0].emit('state', legacyState);
    ui.render();
    await new Promise((resolve) => setImmediate(resolve));
    tree = ui.render();
    byText(tree, 'button', 'View Graph').props.onClick();
    tree = ui.render();

    const chart = descendants(tree, (node) => node.type === 'svg' && node.props?.['aria-label'] === 'Grafik TMA N1')[0];
    const current = descendants(chart, (node) => node.props?.['data-testid'] === 'current-tma-trace')[0];
    const previewTraces = descendants(chart, (node) => node.props?.['data-testid'] === 'scenario-preview-trace');
    assert.ok(current?.props.points.split(' ').length >= 3);
    assert.equal(previewTraces.length, 3);
    assert.deepEqual(previewTraces.map((node) => node.props['data-scenario']), ['ringan', 'sedang', 'lebat']);
    assert.equal(previewTraces.find((node) => node.props['data-scenario'] === 'sedang').props.strokeWidth, 3);
    const panel = descendants(tree, (node) => node.props?.['data-testid'] === 'scenario-lstm-estimates')[0];
    assert.ok(panel);
    assert.match(text(panel), /LSTM scenario estimates.*N1/s);
    assert.match(text(panel), /Hujan Ringan.*86\.57 cm.*101\.90 cm/s);
    assert.match(text(panel), /Hujan Sedang.*205\.80 cm.*252\.10 cm/s);
    assert.match(text(panel), /Hujan Lebat.*338\.80 cm.*421\.90 cm/s);
    assert.match(text(panel), /separate from current legacy run/i);
    assert.equal(ui.calls.filter((call) => call.url.endsWith('/api/ciliwung-simulation/scenario-previews?nodeId=N1')).length, 1);
  } finally { ui.restore(); }
});

test('graph keeps observed replay TMA, synthetic rain and twelve projected levels as distinct traces', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot({ simTimeSeconds: 300, tma: 170, rain: 24 }));
    ui.streams[0].emit('state', snapshot({ simTimeSeconds: 600, tma: 172, rain: 36 }));
    ui.streams[0].emit('forecast', sampleForecast);
    byText(ui.render(), 'button', 'View Graph').props.onClick();
    let tree = ui.render();
    const chart = descendants(tree, (node) => node.type === 'svg' && node.props?.['aria-label'] === 'Grafik TMA N1')[0];
    assert.ok(chart);
    const current = descendants(chart, (node) => node.props?.['data-testid'] === 'current-tma-trace')[0];
    const rain = descendants(chart, (node) => node.props?.['data-testid'] === 'synthetic-rain-trace')[0];
    const future = descendants(chart, (node) => node.props?.['data-testid'] === 'forecast-tma-trace')[0];
    assert.ok(current?.props.points && rain?.props.points && future?.props.points);
    assert.notEqual(current.props.points, future.props.points);
    assert.match(future.props.strokeDasharray, /\d/);
    assert.match(text(tree), /Rain.*Current TMA.*Replay forecast/s);
    assert.equal(descendants(tree, (node) => node.type === 'select' && node.props?.value === 'N1')
      .some((select) => descendants(select, (node) => node.type === 'option').length === 9), true);
    ui.streams[0].emit('state', snapshot({ status: 'stopped', simTimeSeconds: 600 }));
    tree = ui.render();
    assert.equal(descendants(tree, (node) => node.props?.['data-testid'] === 'forecast-tma-trace').length, 0);
  } finally { ui.restore(); }
});

test('forecast events stay keyed by node; temporarily unavailable N2 never erases the N1 forecast', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    ui.streams[0].emit('forecast', sampleForecast);
    ui.streams[0].emit('forecast', { ...sampleForecast, nodeId: 'N5', predictedTmaCm: { '30': 301, '60': 322 } });
    ui.streams[0].emit('forecast', { runId: 'run-1', nodeId: 'N2', issuedAt: sampleForecast.issuedAt, status: 'unavailable', reason: 'model_unavailable' });
    let tree = ui.render();
    const panel = () => descendants(tree, (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    const selectNode = (nodeId) => {
      descendants(panel(), (node) => node.type === 'select' && node.props?.['aria-label'] === 'Forecast node')[0]
        .props.onChange({ target: { value: nodeId } });
      tree = ui.render();
    };
    assert.match(text(panel()), /205\.0 cm/);
    selectNode('N5');
    assert.match(text(panel()), /301\.0 cm/);
    selectNode('N2');
    assert.match(text(panel()), /Forecast unavailable: model_unavailable/);
    assert.doesNotMatch(text(panel()), /301\.0 cm|205\.0 cm/);
    selectNode('N1');
    assert.match(text(panel()), /205\.0 cm/);
  } finally { ui.restore(); }
});

test('headwater UP1 presents forecasted levels but never claims flood-safe without a defined threshold', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    ui.streams[0].emit('forecast', { ...sampleForecast, nodeId: 'UP1', method: 'lstm_synthetic_v2',
      thresholdBanjirCm: null, crossingWithin: { '30': null, '60': null },
      inputProvenance: { upstreamFeature: 'self_proxy_no_upstream_gauge' } });
    let tree = ui.render();
    descendants(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === 'Forecast node')[0]
      .props.onChange({ target: { value: 'UP1' } });
    tree = ui.render();
    const panel = descendants(tree, (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    assert.match(text(panel), /UP1.*205\.0 cm.*265\.0 cm/s);
    assert.match(text(panel), /no flood threshold defined/i);
    assert.match(text(panel), /upstream.*self.proxy/i);
    assert.doesNotMatch(text(panel), /current stage below flood threshold|threshold crossing not indicated|flood threshold already reached/i);
  } finally { ui.restore(); }
});

test('a mapped node other than UP1 rejects missing flood classification instead of implying safety', () => {
  const ui = mount();
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    ui.streams[0].emit('forecast', { ...sampleForecast, nodeId: 'N2', thresholdBanjirCm: null,
      crossingWithin: { '30': null, '60': null } });
    let tree = ui.render();
    descendants(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === 'Forecast node')[0]
      .props.onChange({ target: { value: 'N2' } });
    tree = ui.render();
    const panel = descendants(tree, (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    assert.match(text(panel), /Forecast unavailable/);
    assert.equal(descendants(panel, (node) => node.props?.['data-testid'] === 'forecast-30').length, 0);
  } finally { ui.restore(); }
});

test('an N3 forecast selection requests its endpoint and renders +30/+60 when available', async () => {
  const ui = mount({ latest: { ...sampleForecast, nodeId: 'N3', method: 'slope_synthetic_v2', predictedTmaCm: { '30': 206, '60': 270 } } });
  try {
    ui.render();
    ui.streams[0].emit('state', snapshot());
    let tree = ui.render();
    descendants(tree, (node) => node.type === 'select' && node.props?.['aria-label'] === 'Forecast node')[0]
      .props.onChange({ target: { value: 'N3' } });
    ui.render();
    await tick();
    tree = ui.render();
    const panel = descendants(tree, (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    assert.match(text(panel), /N3.*206\.0 cm.*270\.0 cm/s);
    assert.equal(ui.calls.filter((call) => call.url.includes('/api/ciliwung-forecast/latest?nodeId=N3')).length, 1);
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
    byText(tree, 'button', 'View Graph').props.onClick();
    tree = ui.render();
    assert.match(text(tree), /Hujan Sedang · TMA Graph/);
    assert.doesNotMatch(text(tree), /Hujan Ringan · TMA Graph/);
  } finally { ui.restore(); }
});

test('legacy profile still uses scenario start and never presents a synthetic forecast as active', async () => {
  const ui = mount();
  try {
    let tree = ui.render();
    const panel = descendants(tree, (node) => node.props?.['data-testid'] === 'ciliwung-forecast')[0];
    assert.doesNotMatch(text(panel), /SYNTHETIC DEMO/);
    assert.match(text(panel), /legacy.*no live forecast/i);
    byText(tree, 'button', 'Hujan Sedang').props.onClick();
    tree = ui.render();
    await byText(tree, 'button', 'Start Simulation').props.onClick();
    assert.deepEqual(ui.calls.find((call) => call.url.endsWith('/api/ciliwung-simulation/start'))?.body,
      { scenario: 'sedang', speedMultiplier: 1 });
    assert.equal(ui.calls.some((call) => call.url.endsWith('/replay/start')), false);
  } finally { ui.restore(); }
});
