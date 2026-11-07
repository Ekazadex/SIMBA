# Ciliwung Simulation Integration

## Components

- `server.ts` exposes the Ciliwung simulation API and SSE stream on the SIMBA server.
- `backend/ciliwung/simulation-engine.mjs` is the deterministic nine-node source of truth.
- `backend/ciliwung/cupcarbon-telemetry.mjs` listens for and validates the telemetry datagrams emitted by the nine CupCarbon scripts.
- `src/components/CiliwungSimulationPage.tsx` is the isolated Simulation Mode page.
- `flood_3d_visual_map/src/js/backend-simulation.js` adapts backend N1–N5 state to the Three.js renderer.
- CupCarbon's nine active scripts listen on UDP control ports `5101` through `5109` and continue sending telemetry to UDP port `5005`.

## Local run

1. Install Website dependencies:

   ```bash
   npm install
   ```

2. Start SIMBA from `Website/SIMBA`:

   ```bash
   npm run dev
   ```

   The server listens on `http://127.0.0.1:3000`.

3. Start the 3D static server from `flood_3d_visual_map`:

   ```bash
   python -m http.server 8765
   ```

4. Open CupCarbon manually, open the CupVisual project, and start IoT Simulation when CupCarbon output is needed. The Website and 3D scenario still run if CupCarbon is not active. The page shows `NOT VERIFIED` until valid UDP telemetry arrives, then shows `ACTIVE` with the number of reporting nodes.

5. Open the SIMBA Website. When the hardware dashboard is offline, choose **Masuk Mode Simulasi**, select a scenario, and press **Start Simulation**.

## API

```text
GET  /api/ciliwung-simulation/scenarios
GET  /api/ciliwung-simulation/state
GET  /api/ciliwung-simulation/stream
POST /api/ciliwung-simulation/start   {"scenario":"ringan|sedang|lebat", "speedMultiplier":1|10|25|50}
POST /api/ciliwung-simulation/speed   {"speedMultiplier":1|10|25|50}
POST /api/ciliwung-simulation/stop
POST /api/ciliwung-simulation/reset

GET  /api/ciliwung-simulation/episodes
GET  /api/ciliwung-simulation/history
GET  /api/ciliwung-simulation/scenario-previews?nodeId=UP1|UP2|UP3|UP4|N1|N2|N3|N4|N5
POST /api/ciliwung-simulation/replay/start   {"episodeId":"compound-012", "speedMultiplier":1|10|25|50}
GET  /api/ciliwung-forecast/latest?nodeId=UP1|UP2|UP3|UP4|N1|N2|N3|N4|N5
GET  /api/ciliwung-weather/context?adm4=<supported-Depok-code>
```

### Synthetic rain + nine-node forecast mode

This is a **synthetic-data LSTM demonstration, not a validated flood-warning service**. The Website defaults to `synthetic_v2`, while the previous `synthetic_v1` dataset, report, and N1/N5 model artifacts remain preserved. v2 contains 128 independent 24-hour episodes, 288 five-minute bins, and all nine node targets per bin, with separate train/validation/test/stress episode splits; `compound-012` is reserved as a held-out demo. The nine IDs are UP1–UP4 followed by N1–N5. The code uses UP1 itself as a clearly declared upstream-feature self-proxy because there is no upstream gauge above Puncak. Some synthetic N5 rainfall magnitudes are conditioned on observed *daily* Kemayoran BMKG `RR` in 20 training episodes. No synthetic intraday timestamp, upstream rainfall, or TMA is described as a BMKG measurement. The live village forecast context is displayed separately with provider, issued/valid time, and location; it is **not** a training input or observed 5-minute rain gauge.

The v2 artifacts are in `ml/models/synthetic_v2/` and the full metrics in `ml/reports/synthetic_v2.json` and `.md`. Every node has a trained Keras LSTM, but the deployed demo method is selected separately for each station using validation +60-minute MAE against persistence and recent-slope baselines. Current selections are UP1=LSTM, UP2=slope, UP3=LSTM, UP4=LSTM, N1=LSTM, N2=LSTM, N3=LSTM, N4=LSTM, and N5=slope. The test metrics are generated-data comparisons only, not field accuracy. UP1 has **no defined flood threshold**, so its TMA forecasts are shown but threshold crossing/confusion/precision/recall remain null and no safe/unsafe flood judgment is displayed. The other 280-cm thresholds are simulator demo values, not gauge-calibrated BPBD thresholds.

### Legacy graph and rainfall scenario previews

Legacy **Hujan Ringan/Sedang/Lebat** profiles are centimeter-per-second visual ramps, not rainfall-driven histories. The graph now hydrates a recent backend buffer for those runs (up to 120 state samples) and keeps the legacy current-TMA trace separate from counterfactual model estimates. Synthetic replay retains its 96 past five-minute bins and generated rain trace. Legacy profiles do not supply rainfall, so the graph marks it unavailable instead of treating missing rain as zero.

`GET /api/ciliwung-simulation/scenario-previews?nodeId=N1` runs the selected station's v2 demonstration method for three deterministic **synthetic** rainfall inputs. The preview assumes 96 generated five-minute history bins, then estimates +30 and +60 minutes. Catchment totals are input assumptions, not BMKG measurements or official rainfall-intensity categories. The estimates are displayed separately from the legacy run's current state and do not drive CupCarbon or 3D live-water state. A node whose validation-selected method is slope or persistence is labelled with that method, not LSTM.

For selected node **N1**, the verified LSTM preview results are:

| Synthetic case | Rainfall totals per catchment | Synthetic issue TMA | +30 min | +60 min |
|---|---|---:|---:|---:|
| Hujan Ringan | UP1 8 mm, N5 7 mm | 73.56 cm | 86.57 cm | 101.90 cm |
| Hujan Sedang | UP1 20 mm, UP2 15 mm, N1 8 mm, N5 10 mm | 152.58 cm | 205.75 cm | 252.07 cm |
| Hujan Lebat | UP2 35 mm, UP4 20 mm, N1 12 mm, N5 18 mm | 248.68 cm | 338.78 cm | 421.88 cm |

These are model outputs for synthetic inputs, not a prediction for the legacy run's current TMA (202.1 cm in the supplied screenshot) and not operational warning thresholds. Compare the `Synthetic issue TMA` column before interpreting future levels.

Inputs are the latest 96 causal five-minute bins with four features; each model emits the next 12 TMA values, from which +30/+60 levels are read. Current simulator stage remains the authoritative `state` SSE and `node_update` UDP payload. Forecasts are separate node-keyed SSE and UDP events, fenced by run and issue time. Website Simulation Mode offers all nine nodes in the forecast/graph selector. The 3D viewer renders all nine sourced locations; its synthetic forecast overlay is separate from current water geometry. CupCarbon labels carry forecasts separately from present TMA/mark/telemetry for all nine scripts; parsers and Python tests pass. Final local verification also opened the exact CupVisual project in CupCarbon Klaines 8.2, started IoT Simulation, observed `N=9` and all nine combined current-TMA/forecast labels, confirmed UP1 showed no flood threshold, reset forecasts without changing present-level handling, and stopped the simulation. This verifies the local demo path only, not a real sensor deployment. Forecast data must never call `cup_mark()` or overwrite current telemetry. Missing model/history or stale data produces an explicit unavailable reason, never a made-up confidence percentage.

To run locally, start SIMBA and the standalone 3D static server, open **Masuk Mode Simulasi**, choose **Synthetic replay**, select a v2 episode, and press **Start Replay**. The replay API defaults to `ml/data/generated/synthetic_v2/episodes/`; the v1 directory remains available to the Python loader and its worker compatibility checks. `GET /api/ciliwung-simulation/history` returns the current run's last 96 causal five-minute bins for replay or up to 120 buffered state samples for a legacy run, with subsequent updates delivered over SSE. The resident worker loads all nine v2 model artifacts on first request, with a 90-second cold-start allowance and separate 10-second warm inference timeout. Restart the backend after generating models; absent or invalid v2 bundles fail closed.

The active state is kept in backend memory. The simulation does not write Firestore on every timestep. Firestore is optional for this mode. If `firebase-applet-config.json` or the equivalent `VITE_FIREBASE_*` environment values are absent, the hardware persistence features remain disabled while the Ciliwung simulation API still runs.

CupCarbon telemetry uses the existing local UDP format `<node name>,<tma cm>,<status>` on port `5005`. The listener accepts the nine registered node names and statuses `AMAN`, `SIAGA`, or `BANJIR_JAKARTA`. If no valid telemetry is received for 4 seconds, the connection state returns to `not_verified`.

## Scenario completion targets

| Scenario | Target | Threshold |
|---|---|---:|
| Hujan Ringan | UP1 Puncak | 70 cm |
| Hujan Sedang | N3 Ciliwung Stage 2 | 180 cm |
| Hujan Lebat | N5 Pintu Air Manggarai | 280 cm |

These are demo profiles. They are deterministic conceptual visualisation parameters, not calibrated flood forecasts.

## Verification

From `Website/SIMBA`:

```bash
npm test
npm run build
npm run verify:ciliwung
```

The verification command checks the API contract, Website integration, CupCarbon script syntax/control markers, backend tests, and the 3D adapter regression test.

For the new mode, also run from `Website/SIMBA`:

```bash
ml/.venv/Scripts/python.exe -m pytest ml/tests -q
ml/.venv/Scripts/python.exe ml/scripts/verify_pipeline.py --config ml/config/synthetic_v2.json
ml/.venv/Scripts/python.exe ml/scripts/verify_pipeline.py --config ml/config/synthetic_v1.json
ml/.venv/Scripts/python.exe ml/scripts/smoke_worker.py --config ml/config/synthetic_v2.json
ml/.venv/Scripts/python.exe ml/scripts/smoke_worker.py --config ml/config/synthetic_v1.json
```

Run `npm test`, `npm run build`, and `npm run verify:ciliwung` after Website integration, then `node --test tests/*.test.mjs` from `flood_3d_visual_map`, and `python -m unittest discover -s cupcarbon_water_twin/tests -p 'test_*.py'` from the workspace root. With both local servers running, `node scripts/verify-ciliwung-browser.mjs` checks N1 LSTM estimates for all three synthetic rainfall profiles, captures multiple legacy state samples for the graph, then replays held-out v2 episode `compound-012` and checks all nine node-specific API forecasts and UI selections. It verifies UP1's null threshold, renders the separate 3D overlay, checks positive synthetic rain with rising current TMA, and resets the run. Browser screenshots are saved under Hermes scratch. The standalone 3D project has its own `node scripts/verify-browser.mjs` check for all nine station views and geospatial alignment. The CupCarbon GUI check used the recorded `RUN_CUPVISUAL.bat` launcher and recent CupVisual project, observed active telemetry from nine scripts and the forecast text for all nine nodes; the simulation was reset and stopped after verification. This is local demo evidence, not field-sensor validation.

**Safety:** The website remains a local prototype. The existing server may listen beyond loopback and `firestore.rules` currently permits broad reads/writes; do not expose it publicly without authentication, network binding review, and restrictive database rules. No synthetic benchmark is evidence of field warning accuracy. A browser URL at `127.0.0.1` requires this computer and its backend/3D services to stay running.
