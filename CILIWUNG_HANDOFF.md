# Ciliwung Simulation — Hermes Handoff

## Resume instruction

Read this file before changing the Ciliwung simulation. Inspect the current filesystem, git status, and live process state again before claiming anything is running. Continue from the existing implementation instead of creating a second backend.

## Workspace and repositories

- Main backend/frontend repository: `D:/Documents/Semester7/Despro2/Website/SIMBA`
- 3D renderer, not a separate Git repository: `D:/Documents/Semester7/Despro2/flood_3d_visual_map`
- CupCarbon project, not a separate Git repository: `D:/Documents/Semester7/Despro2/Flood Detection System Ciliwung/Flood Detection System Ciliwung - CupVisual`
- Backend owner: `Website/SIMBA/server.ts`
- Active Git branch: `naufal`
- `main` must not be changed or pushed unless the user explicitly asks.
- Latest verified committed baseline when this forecast work began: `9c8503d IMPLEMENTASI 3D SIMULATION` on `naufal` (checked October 11, 2026); older handoff commit counts are historical.
- The synthetic forecast changes and locally generated model/data files are currently **uncommitted**; re-run `git status` before any further edits. Nothing has been pushed or merged by this work.

## User's goal

Build a Ciliwung flood-scenario mode in the SIMBA website. The Website backend is authoritative and drives both the browser 3D renderer and the nine CupCarbon nodes.

Scenarios:

- `ringan` — Hujan Ringan
- `sedang` — Hujan Sedang
- `lebat` — Hujan Lebat

Website Simulation Mode is separate from the hardware dashboard and has `View Simulation` and `View Graph` tabs.

## Architecture already implemented

- Deterministic in-memory engine: `backend/ciliwung/simulation-engine.mjs`
- REST/SSE API: `backend/ciliwung/ciliwung-api.mjs`
- Website page: `src/components/CiliwungSimulationPage.tsx`
- 3D backend adapter: `../../flood_3d_visual_map/src/js/backend-simulation.js`
- 3D backend mode query: `?mode=backend&api=...`
- CupCarbon commands: UDP to `127.0.0.1` ports `5101` through `5109`
- CupCarbon telemetry/logger: UDP port `5005`
- Website CupCarbon telemetry listener: parses the nine active script datagrams, marks `cupcarbon.status` as `active`, counts nodes seen, and falls back to `not_verified` after 4 seconds without telemetry.
- Active simulation state is in RAM and streamed through SSE. It must not write Firestore on every timestep.
- Hardware ESP32 telemetry and simulation state are separate. Simulation reset must not delete or overwrite hardware telemetry.

Node registry:

- `UP1` Puncak → CupCarbon node 1, port 5101
- `UP2` Katulampa → CupCarbon node 2, port 5102
- `UP3` Sukaraja → CupCarbon node 3, port 5103
- `UP4` Cibinong → CupCarbon node 4, port 5104
- `N1` Pos Depok → CupCarbon node 5, 3D N1, port 5105
- `N2` Ciliwung Stage 1 → CupCarbon node 20, 3D N2, port 5106
- `N3` Ciliwung Stage 2 → CupCarbon node 21, 3D N3, port 5107
- `N4` Ciliwung Stage 3 → CupCarbon node 22, 3D N4, port 5108
- `N5` Pintu Air Manggarai → CupCarbon node 8, 3D N5, port 5109

## Implemented UI behavior

- Simulation page is entered from the dashboard through Simulation Mode.
- Scenario cards select Ringan/Sedang/Lebat.
- Simulation speed selector is in the Simulation Status card: `1x`, `10x`, `25x`, `50x`.
- Speed changes only simulation time, not ESP32 telemetry or hardware sampling.
- View Graph defaults to `N1` and allows `N1`–`N5` selection.
- Graph title shows the selected scenario and node.
- Graph renders a baseline point before the first timestep and live history after Start.
- Backend/local 3D mode hides the old local rainfall control sidebar.
- Simulation Status shows CupCarbon connection state and the number of nodes that have reported telemetry.

Speed API:

- `POST /api/ciliwung-simulation/start` with `{ "scenario": "ringan|sedang|lebat", "speedMultiplier": 1|10|25|50 }`
- `POST /api/ciliwung-simulation/speed` with `{ "speedMultiplier": 1|10|25|50 }`

Other API routes:

- `GET /api/ciliwung-simulation/scenarios`
- `GET /api/ciliwung-simulation/state`
- `GET /api/ciliwung-simulation/stream`
- `POST /api/ciliwung-simulation/stop`
- `POST /api/ciliwung-simulation/reset`

## Verification already completed

From `Website/SIMBA`:

- `npm test` — 17 tests passed
- `npm run build` — passed; Vite emits only the existing large-bundle warning
- `npm run verify:ciliwung` — API, frontend, CupCarbon integration, and regression checks passed
- 3D project tests previously passed: 43 tests
- CupCarbon Python scripts previously passed syntax compilation
- Live speed API test passed: 10x, then 50x, then reset to 1x
- Live heavy scenario at 50x completed at N5 threshold
- Live UDP telemetry probe passed: zero-to-active transition, all nine node reports, stale fallback, simulation start, and stop.

## Local runtime commands

Website backend:

```bash
cd /d/Documents/Semester7/Despro2/Website/SIMBA
npm run dev
```

Website URL: `http://127.0.0.1:3000`

3D static server:

```bash
cd /d/Documents/Semester7/Despro2/flood_3d_visual_map
python -m http.server 8765
```

3D URL: `http://127.0.0.1:8765`

CupCarbon launcher:

```text
D:/Documents/Semester7/Despro2/Flood Detection System Ciliwung/Flood Detection System Ciliwung - CupVisual/RUN_CUPVISUAL.bat
```

The local CupCarbon project was verified running with `IoT Simulation` active and UDP bindings on `5005` and `5101`–`5109`. The configured local Python executable that exists on this machine is `C:/Python313/python.exe` (Python 3.13.5); `C:/Python312/python.exe` also exists.

## Synthetic rain forecast extension (October 11, 2026)

- Authoritative instructions: `CILIWUNG_SIMULATION.md` and `ml/README.md`. Source plan: `D:/Documents/Semester7/Despro2/.hermes/plans/2026-10-10_182353-simba-bmkg-synthetic-lstm-flood-forecast.md`; acceptance ledgers: `.unlazy/simba-lstm-forecast/` in the workspace root.
- The Website backend now also replays seeded synthetic rain/TMA episodes, emits separate `forecast` SSE events, and serves `/api/ciliwung-simulation/episodes`, `/api/ciliwung-simulation/history` (96 causal past bins), `/api/ciliwung-simulation/replay/start`, `/api/ciliwung-forecast/latest`, and `/api/ciliwung-weather/context`. The old `state` SSE, current-level UDP, hardware routes, and legacy profile endpoints remain separate. The live BMKG village forecast is **context only**, not the five-minute model input. Actual live provider metadata resolved `32.76.06.1002` to Kukusan and `32.76.06.1006` to Beji Timur; previous code comments were corrected.
- Reproducible generated data: `ml/data/generated/synthetic_v1/` with 128 independent scenarios and held-out `compound-012`. Model artifacts: `ml/models/N1.keras`, `N5.keras` plus metadata; report `ml/reports/synthetic_v1.json`/`.md`. Both LSTMs are trained, but validation chose an LSTM at N1 and the slope baseline at N5. Synthetic test +60 MAE for N1 LSTM was 9.91 cm versus slope 7.99 cm, so no robust LSTM superiority is claimed; see the report for full denominators, +30, stress and event-family metrics.
- Website Simulation Mode shows provider/issued/valid weather context, synthetic replay selection, current TMA versus separate 30/60-minute forecast, and a provenance-labelled graph. The companion 3D view handles current state plus a distinct projected display; CupCarbon N1/N5 display current TMA **and** predicted demo levels without changing `cup_mark()` or telemetry. The CupVisual project is outside Website Git and backed up under `.unlazy/simba-lstm-forecast/backups/` before changes.
- Final acceptance on October 11, 2026: Website `npm test` 47/47, production build and legacy verifier passed; ML pytest 32/32 (28 third-party deprecation warnings), `verify_pipeline.py` and resident worker smoke passed; 3D suite 52/52 plus standalone browser verification passed; CupCarbon Python suite 15/15 and all nine IoT UDP nodes active. `node scripts/verify-ciliwung-browser.mjs` exited 0 against live localhost:3000/8765 and generated Website/graph/3D/rain-rise screenshots in Hermes scratch with zero browser exceptions. At the measured synthetic rain-rise point, N1 rain was 8.415414 mm/h and present TMA 107.4157 cm versus 59.9141 cm before the pulse; this is an internal demo, not a field observation. Fresh CupVisual GUI after restarting IoT showed one combined N1/N5 label with current TMA plus DEMO +30/+60, then reset removed forecasts while keeping 9/9 telemetry. All 23 scoped `.unlazy/simba-lstm-forecast` gates were met on the same date. The Python worker has a separate 30-second cold-start grace and 10-second warm prediction timeout after a measured ~10-second startup caused an initial live-browser failure. Recheck ports after resuming; localhost processes do not persist independently of their process lifetime.
- Limits: no paired 5-minute real rain/river-gauge dataset, no real flood validation, no hydraulic inundation result, no public deployment or authenticated operational warning. The existing Firestore rules are permissive and server may listen beyond localhost, so keep this local and review security before external access.

## Known limitations / next work

1. CupCarbon status is now verified from local UDP telemetry, not from process discovery. A valid datagram marks the state active, while silence for 4 seconds returns it to `not_verified`; this does not prove that the CupCarbon GUI process itself is healthy.
2. The local processes may be stopped when a Hermes session or background process is closed. Always check ports before telling the user the Website is available.
3. Companion 3D and CupCarbon folders are not separate Git repositories. Preserve backups before broad edits and report that their changes are not covered by the SIMBA branch.
4. Do not run `npm audit fix --force` without user approval. Existing dependency advisories and the Vite bundle-size warning are known.

## Nine-node expansion (October 14, 2026)

- Default replay/API now reads the versioned `ml/data/generated/synthetic_v2/episodes/` dataset. The loader accepts both `synthetic_v1` and `synthetic_v2`; `synthetic_v1` N1/N5 models remain loadable by the worker CLI, while v2 uses the nine-model bundle.
- v2 artifacts: 128 independent episodes, 331,776 five-minute timeseries rows and 331,776 per-node target rows; nine `.keras` models/metadata files; held-out episode `compound-012`; full JSON/Markdown evaluation under `ml/reports/synthetic_v2.*`.
- Validation-selected methods: UP1 LSTM, UP2 slope, UP3 LSTM, UP4 LSTM, N1 LSTM, N2 LSTM, N3 LSTM, N4 LSTM, N5 slope. UP1 threshold/crossing remains null. Every reported score is against generated data only.
- Website/backend now exposes all nine node forecasts and verifies one held-out replay in a headless browser: all nine API outputs arrived for one issue time, all nine UI selections rendered v2 methods, the 3D overlay remained separate from current water, and reset readback showed idle state plus nine cleared forecasts. Current 53 Website tests, build, and `npm run verify:ciliwung` passed.
- 3D viewer uses the actual 2,708-point sourced route and expanded SRTM extent; browser verified 9/9 station placements. Its 58-test suite and geodata/browser checks pass. Upstream roads/building context is absent and intentionally not invented; scene/channel/coast are illustrative, not survey-grade.
- CupCarbon forecast parsers/scripts cover all nine nodes; 25 Python tests and syntax compilation pass. The exact CupVisual project was also run in CupCarbon Klaines 8.2: `N=9`, all nine current-TMA/forecast labels displayed, UP1 showed no flood threshold, reset cleared forecasts, and IoT Simulation was stopped afterward. This verifies the local demo flow, not real sensor deployment.
- ML verification: pytest 38/38; independent v2 and v1 pipeline checks and worker smokes passed. v1 data/models remain unchanged. Local Website/3D servers were stopped after browser verification/reset. Changes remain uncommitted and unpushed on `naufal`.

## Dashboard graph repair and rainfall scenario previews (October 14, 2026)

- The legacy chart previously rendered only the current-state dot after reconnect because `/api/ciliwung-simulation/history` returned replay history only. The engine now retains the latest 120 snapshots for each legacy run; the history endpoint returns replay's 96 causal five-minute bins or the legacy run's buffered state samples. UI subtitles distinguish the two modes and explicitly say legacy rainfall is unavailable, not zero.
- Added `/api/ciliwung-simulation/scenario-previews?nodeId=...`. It creates three deterministic synthetic rain/TMA input windows using the v2 routing assumptions and obtains the forecast from the existing resident model worker. The three curves/cards are counterfactual and separate from live legacy TMA/CupCarbon/3D state. For nodes where the v2 validation-selected method is slope or persistence, UI reports that method instead of calling it LSTM.
- N1 (`lstm_synthetic_v2`, `synthetic_v2_N1`) exact worker outputs: ringan issue 73.56 cm, +30 86.57 cm, +60 101.90 cm; sedang issue 152.58 cm, +30 205.75 cm, +60 252.07 cm; lebat issue 248.68 cm, +30 338.78 cm, +60 421.88 cm. Synthetic catchment event-depth assumptions are in `CILIWUNG_SIMULATION.md`; the case labels are not official BMKG intensity thresholds. These synthetic issue stages are not the screenshot's current legacy N1 value (202.1 cm), so do not present them as forecasts from that live state.
- Verification: Website `npm test` 60/60, `npm run build` passed (existing bundle-size warning), scenario-preview endpoint returned HTTP 200 and matching exact N1 results, and `node scripts/verify-ciliwung-browser.mjs` passed with no browser errors. Browser proof showed all three scenario trajectories/cards and 26 buffered live legacy samples in `simba-legacy-history-and-scenario-estimates.png`; scenario-only screenshot is `simba-rain-scenario-estimates.png`, both under Hermes scratch. The browser check reset state afterward.
- After updating the backend, the previous `npm run dev` process was restarted, which cleared its in-memory legacy run. Current updated Website and 3D viewer are responding at ports 3000 and 8765. Refresh the dashboard before testing; start a new legacy scenario to see its captured history. No telemetry/field-data claim is made.

## Collaboration style

Use Indonesian by default. Be direct and evidence-grounded. Read current files and live state before editing. Do not push to `main`. Do not claim a server, CupCarbon run, or UI behavior is active without a live check or an inspected artifact.
## Live 2D basemap update

The hardware 2D map uses Leaflet and online OpenStreetMap tiles by default, not the 3D overview image. Configure `VITE_MAP_TILE_URL` and `VITE_MAP_ATTRIBUTION` together for another properly licensed provider and rebuild. Standard OSM tiles are intended for a low-traffic prototype; follow https://operations.osmfoundation.org/policies/tiles/ and select appropriate hosting for production. Network access is required; tile failures are shown on the map. Sensor-area gradients are illustrative preset/status indicators, not measured or modelled inundation boundaries; they disappear when live data is stale. N2–N5 remain preset-derived. ESP32/Firebase physical validation remains necessary.

## Basemap landmark icons

The live and simulation 2D maps now use the OpenFreeMap Positron vector basemap through MapLibre and Leaflet. Its style is loaded online and symbol icon images are removed while text labels are retained; sensor markers are separate Leaflet layers. OpenFreeMap/OpenMapTiles/OSM attribution is shown. The earlier raster tile configuration no longer controls this basemap.
