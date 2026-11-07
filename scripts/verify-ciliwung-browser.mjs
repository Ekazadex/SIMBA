import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WEBSITE = 'http://127.0.0.1:3000';
const VIEWER = 'http://127.0.0.1:8765';
const SCRATCH = process.env.HERMES_SCRATCH || join(homedir(), 'AppData', 'Local', 'hermes', 'cache', 'scratch');
const CHROME = process.env.CHROME_PATH || join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');

async function eventually(check, label, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let error;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (cause) { error = cause; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} did not pass${error ? `: ${error.message}` : ''}`);
}

async function openCDP(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
  });
  return {
    errors,
    close() { socket.close(); },
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timed out: ${method}`));
          }
        }, 20000).unref();
      });
    },
    async eval(expression) {
      const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    },
    async screenshot(path) {
      const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await fs.writeFile(path, Buffer.from(result.data, 'base64'));
      return path;
    },
  };
}

async function main() {
  assert.equal((await fs.stat(CHROME)).isFile(), true, `Chrome missing: ${CHROME}`);
  for (const url of [WEBSITE, VIEWER]) {
    const response = await fetch(url);
    assert.equal(response.status, 200, `${url} must respond before browser verification`);
  }
  const manifest = JSON.parse(await fs.readFile(new URL('../ml/data/generated/synthetic_v2/manifest.json', import.meta.url), 'utf8'));
  const episodeId = manifest.held_out_demo_episode_id;
  assert.ok(manifest.splits.test.includes(episodeId), 'browser must replay an episode withheld from training');
  await fs.mkdir(SCRATCH, { recursive: true });
  const profile = await fs.mkdtemp(join(SCRATCH, 'simba-browser-profile-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--enable-webgl',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-allow-origins=*',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000',
  ], { stdio: 'ignore' });
  let cdp;
  let started = false;
  try {
    const port = await eventually(async () => {
      const text = await fs.readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      return Number(text.split(/\r?\n/)[0]) || null;
    }, 'Chrome remote debugger');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page');
    assert.ok(page?.webSocketDebuggerUrl);
    cdp = await openCDP(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: WEBSITE });
    await eventually(() => cdp.eval('document.readyState === "complete" && !!document.querySelector("#root")'), 'SIMBA root');
    await eventually(() => cdp.eval('Array.from(document.querySelectorAll("button")).some(b => /Masuk Mode Simulasi|Enter Simulation Mode/.test(b.textContent || ""))'), 'simulation entry button', 60000);
    await cdp.eval('Array.from(document.querySelectorAll("button")).find(b => /Masuk Mode Simulasi|Enter Simulation Mode/.test(b.textContent || ""))?.click()');
    await eventually(() => cdp.eval('!!document.querySelector("[data-testid=ciliwung-forecast]")'), 'simulation page');
    await eventually(() => cdp.eval('!!document.querySelector("[data-testid=bmkg-weather-context]") && document.querySelector("[data-testid=bmkg-weather-context]").textContent.includes("not an LSTM input")'), 'weather provenance card');
    const previewResponse = await fetch(`${WEBSITE}/api/ciliwung-simulation/scenario-previews?nodeId=N1`);
    assert.equal(previewResponse.status, 200, 'scenario-preview endpoint must be available');
    const scenarioPreviews = await previewResponse.json();
    assert.deepEqual(scenarioPreviews.previews.map((item) => item.scenarioId), ['ringan', 'sedang', 'lebat']);
    assert.ok(scenarioPreviews.previews.every((item) => item.method === 'lstm_synthetic_v2' && item.modelVersion === 'synthetic_v2_N1'));
    assert.ok(Math.abs(scenarioPreviews.previews[0].predictedTmaCm['30'] - 86.57) < 0.1);
    assert.ok(Math.abs(scenarioPreviews.previews[1].predictedTmaCm['60'] - 252.07) < 0.1);
    await cdp.eval('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("View Graph"))?.click()');
    await eventually(() => cdp.eval('!!document.querySelector("[data-testid=scenario-lstm-estimates]") && document.querySelectorAll("[data-testid=scenario-preview-trace]").length === 3'), 'three synthetic rainfall scenario previews on the graph', 120000);
    const previewText = await cdp.eval('document.querySelector("[data-testid=scenario-lstm-estimates]")?.textContent || ""');
    assert.match(previewText, /LSTM scenario estimates.*N1/s);
    assert.match(previewText, /not validated for flood warning/i);
    await cdp.eval(`document.querySelector('svg[aria-label="Grafik TMA N1"]')?.scrollIntoView({block:"center"})`);
    const scenarioGraphScreenshot = join(SCRATCH, 'simba-rain-scenario-estimates.png');
    await cdp.screenshot(scenarioGraphScreenshot);

    const legacyStart = await fetch(`${WEBSITE}/api/ciliwung-simulation/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'sedang', speedMultiplier: 50 }),
    });
    assert.equal(legacyStart.status, 200);
    const { state: legacyState } = await legacyStart.json();
    started = true;
    const legacyHistory = await eventually(async () => {
      const history = await (await fetch(`${WEBSITE}/api/ciliwung-simulation/history`)).json();
      return history.runId === legacyState.runId && history.points?.length >= 4 ? history : null;
    }, 'buffered history for live legacy scenario graph', 40000);
    assert.equal(legacyHistory.episodeId, null);
    await eventually(() => cdp.eval('(() => { const graph = document.querySelector("svg[aria-label=\\\"Grafik TMA N1\\\"]"); const trace = graph?.querySelector("[data-testid=current-tma-trace]"); return !!trace && trace.getAttribute("points").split(" ").length >= 3 && document.querySelector("[data-testid=scenario-lstm-estimates]")?.textContent.includes("Hujan Sedang"); })()'), 'hydrated legacy graph with scenario estimates');
    await cdp.eval(`document.querySelector('svg[aria-label="Grafik TMA N1"]')?.scrollIntoView({block:"center"})`);
    const legacyGraphScreenshot = join(SCRATCH, 'simba-legacy-history-and-scenario-estimates.png');
    await cdp.screenshot(legacyGraphScreenshot);
    const resetLegacy = await fetch(`${WEBSITE}/api/ciliwung-simulation/reset`, { method: 'POST' });
    assert.equal(resetLegacy.status, 200);
    started = false;

    const episodeList = await (await fetch(`${WEBSITE}/api/ciliwung-simulation/episodes`)).json();
    assert.ok(episodeList.some((item) => item.episodeId === episodeId), 'held-out episode missing from API');
    const replay = await fetch(`${WEBSITE}/api/ciliwung-simulation/replay/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId, speedMultiplier: 50 }),
    });
    assert.equal(replay.status, 200);
    started = true;
    const { state } = await replay.json();
    assert.equal(state.mode, 'synthetic_demo');
    const nodeIds = ['UP1', 'UP2', 'UP3', 'UP4', 'N1', 'N2', 'N3', 'N4', 'N5'];
    const allForecasts = await eventually(async () => {
      const current = await (await fetch(`${WEBSITE}/api/ciliwung-simulation/state`)).json();
      if (current.runId !== state.runId || current.status !== 'running') return null;
      const forecasts = await Promise.all(nodeIds.map(async (nodeId) =>
        (await fetch(`${WEBSITE}/api/ciliwung-forecast/latest?nodeId=${nodeId}`)).json()));
      return forecasts.every((item) => item.status === 'available' && item.runId === state.runId
        && item.issuedAt === current.timestampUtc) ? forecasts : null;
    }, 'all nine node-specific forecasts for one replay bin', 120000);
    const forecast = allForecasts.find((item) => item.nodeId === 'N1');
    assert.equal(forecast.trajectoryCm.length, 12);
    assert.equal(forecast.inputProvenance.rain, 'synthetic');
    assert.deepEqual(allForecasts.map((item) => item.nodeId), nodeIds);
    const headwaterForecast = allForecasts.find((item) => item.nodeId === 'UP1');
    assert.equal(headwaterForecast.thresholdBanjirCm, null);
    assert.deepEqual(headwaterForecast.crossingWithin, { '30': null, '60': null });
    await eventually(() => cdp.eval('!!document.querySelector("[data-testid=forecast-30]") && !!document.querySelector("[data-testid=forecast-60]")'), '30/60 forecast cards', 25000);
    const panel = await cdp.eval('document.querySelector("[data-testid=ciliwung-forecast]")?.textContent || ""');
    assert.match(panel, /SYNTHETIC DEMO/);
    assert.match(panel, /not validated for operational flood warning/i);
    await fetch(`${WEBSITE}/api/ciliwung-simulation/speed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speedMultiplier: 1 }),
    });
    const selectedNodeReports = [];
    for (const nodeId of nodeIds) {
      await cdp.eval(`(() => { const select = document.querySelector('[data-testid="ciliwung-forecast"] select[aria-label="Forecast node"]'); select.value = '${nodeId}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await eventually(() => cdp.eval(`(() => { const panel = document.querySelector('[data-testid="ciliwung-forecast"]'); const text = panel?.textContent || ''; return text.includes('Separate predicted TMA · ${nodeId}') && text.includes('version synthetic_v2_${nodeId}'); })()`), `${nodeId} forecast visible in UI`, 30000);
      const visiblePanel = await cdp.eval('document.querySelector("[data-testid=ciliwung-forecast]")?.textContent || ""');
      if (nodeId === 'UP1') {
        assert.match(visiblePanel, /No flood threshold defined for UP1/);
        assert.match(visiblePanel, /Flood crossing not evaluated \(no flood threshold defined\)/);
      }
      selectedNodeReports.push(nodeId);
    }
    await cdp.eval(`(() => { const select = document.querySelector('[data-testid="ciliwung-forecast"] select[aria-label="Forecast node"]'); select.value = 'N1'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await eventually(() => cdp.eval('document.querySelector("[data-testid=ciliwung-forecast]")?.textContent.includes("version synthetic_v2_N1")'), 'N1 UI restored');
    await fetch(`${WEBSITE}/api/ciliwung-simulation/speed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speedMultiplier: 50 }),
    });
    await cdp.eval('document.querySelector("[data-testid=ciliwung-forecast]").scrollIntoView({block:"center"})');
    const forecastScreenshot = join(SCRATCH, 'simba-synthetic-forecast-live.png');
    await cdp.screenshot(forecastScreenshot);
    await cdp.eval('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("View Graph"))?.click()');
    await eventually(() => cdp.eval('!!document.querySelector("[data-testid=forecast-tma-trace]") && !!document.querySelector("[data-testid=current-tma-trace]")'), 'observed versus predicted traces');
    await cdp.eval(`document.querySelector('svg[aria-label^="Grafik TMA"]')?.scrollIntoView({block:"center"})`);
    const graphScreenshot = join(SCRATCH, 'simba-synthetic-graph-live.png');
    await cdp.screenshot(graphScreenshot);
    await cdp.send('Page.navigate', { url: `${VIEWER}/?mode=backend` });
    await eventually(() => cdp.eval('document.readyState === "complete" && !!document.querySelector("#scene")'), 'live 3D page');
    await eventually(() => cdp.eval('document.querySelector("#loading")?.hidden === true && document.querySelector("#selected-chip")?.textContent === "N1" && document.querySelector("#forecast-results")?.hidden === false && /lstm_synthetic_v2/.test(document.querySelector("#forecast-method")?.textContent || "")'), 'live 3D N1 forecast overlay', 90000);
    const viewerClock = await cdp.eval('document.querySelector("#backend-sim-time")?.textContent');
    assert.match(viewerClock, /^\d{2}:\d{2}:\d{2}$/, '3D clock must show backend simulation time');
    const viewerScreenshot = join(SCRATCH, 'simba-synthetic-3d-live.png');
    await cdp.screenshot(viewerScreenshot);
    const rainRise = await eventually(async () => {
      const history = await (await fetch(`${WEBSITE}/api/ciliwung-simulation/history`)).json();
      if (history.runId !== state.runId || !Array.isArray(history.points) || !history.points.length) return null;
      const last = history.points.at(-1);
      const first = history.points[0];
      return last.rainRatesMmH?.N1 > 0 && last.values?.N1 > first.values?.N1 + 40
        ? { rainRateMmH: last.rainRatesMmH.N1, tmaCm: last.values.N1, initialTmaCm: first.values.N1, timestampUtc: last.timestampUtc }
        : null;
    }, 'synthetic N1 rainfall with rising current TMA', 150000);
    await cdp.send('Page.navigate', { url: WEBSITE });
    await eventually(() => cdp.eval('Array.from(document.querySelectorAll("button")).some(b => /Masuk Mode Simulasi|Enter Simulation Mode/.test(b.textContent || ""))'), 'simulation reentry', 60000);
    await cdp.eval('Array.from(document.querySelectorAll("button")).find(b => /Masuk Mode Simulasi|Enter Simulation Mode/.test(b.textContent || ""))?.click()');
    await eventually(() => cdp.eval('!!document.querySelector("[data-testid=ciliwung-forecast]")'), 'simulation reentry view');
    await cdp.eval('Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("View Graph"))?.click()');
    await eventually(() => cdp.eval('!!document.querySelector("[data-testid=synthetic-rain-trace]") && !!document.querySelector("[data-testid=current-tma-trace]")'), 'live synthetic rain and TMA graph');
    await cdp.eval(`document.querySelector('svg[aria-label^="Grafik TMA"]')?.scrollIntoView({block:"center"})`);
    const rainRiseScreenshot = join(SCRATCH, 'simba-synthetic-rain-rise-live.png');
    await cdp.screenshot(rainRiseScreenshot);
    assert.equal(cdp.errors.length, 0, `browser exceptions: ${cdp.errors.join(' | ')}`);
    console.log(JSON.stringify({ episodeId, runId: state.runId, modelMethod: forecast.method,
      scenarioEstimates: scenarioPreviews.previews, scenarioGraphScreenshot,
      legacyRunId: legacyState.runId, legacyHistoryPoints: legacyHistory.points.length, legacyGraphScreenshot,
      allNodeForecasts: allForecasts.map(({ nodeId, method, modelVersion, thresholdBanjirCm, crossingWithin }) =>
        ({ nodeId, method, modelVersion, thresholdBanjirCm, crossingWithin })), selectedNodeReports,
      forecastScreenshot, graphScreenshot, viewerScreenshot, viewerClock, rainRise, rainRiseScreenshot,
      cupcarbon: state.cupcarbon, browserErrors: cdp.errors }, null, 2));
    console.log('SIMBA browser forecast verification passed');
  } finally {
    if (started) {
      await fetch(`${WEBSITE}/api/ciliwung-simulation/reset`, { method: 'POST' }).catch(() => {});
    }
    cdp?.close();
    chrome.kill();
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
