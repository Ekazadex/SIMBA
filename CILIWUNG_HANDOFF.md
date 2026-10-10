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
- Latest local commit: `16c3273 fix: render scenario graph baseline and node selection`
- `origin/naufal` was verified at `1934ada`; local branch is one commit ahead because the graph fix has not been pushed.

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

- `npm test` — 12 tests passed
- `npm run build` — passed; Vite emits only the existing large-bundle warning
- `npm run verify:ciliwung` — API, frontend, CupCarbon integration, and regression checks passed
- 3D project tests previously passed: 43 tests
- CupCarbon Python scripts previously passed syntax compilation
- Live speed API test passed: 10x, then 50x, then reset to 1x
- Live heavy scenario at 50x completed at N5 threshold

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

## Known limitations / next work

1. Website `cupcarbon.status` is currently `not_verified` by design. The backend sends UDP commands but does not yet implement a CupCarbon heartbeat/telemetry listener that changes the Website warning to Active. Do not claim automatic detection until this is implemented and tested.
2. The local processes may be stopped when a Hermes session or background process is closed. Always check ports before telling the user the Website is available.
3. Companion 3D and CupCarbon folders are not separate Git repositories. Preserve backups before broad edits and report that their changes are not covered by the SIMBA branch.
4. Do not run `npm audit fix --force` without user approval. Existing dependency advisories and the Vite bundle-size warning are known.

## Collaboration style

Use Indonesian by default. Be direct and evidence-grounded. Read current files and live state before editing. Do not push to `main`. Do not claim a server, CupCarbon run, or UI behavior is active without a live check or an inspected artifact.