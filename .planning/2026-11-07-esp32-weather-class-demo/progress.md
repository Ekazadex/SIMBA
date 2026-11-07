# Progress Log

## Session: 2026-11-07

### Current Status
- The ESP32 + selected-weather forecasting model remains in the planning stage. The viewer and legacy-simulation work completed separately is recorded below.

### Actions Taken
- Created an isolated named plan and inspected hardware and forecast integration references and prior handoff.
- Recorded user's ESP32 classroom workflow, data limitations and evaluation gates.

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| Plan format | Six tracked phases | Validator to run | Pending |

### Errors
| Error | Resolution |
|-------|------------|
| None | — |

### SIMBA revamp and simulation progress — 2026-11-07

- Working branch: `naufal_revamp-test`. The changes listed below are in the working tree; they have not been committed, pushed, or deployed as part of this work.
- Simulation viewer now has 2D map, 3D map, and forecast graph views. The 2D map is the default. The current water-level panel remains visible, and selecting a node there selects and highlights it in the graph. Node labels use location names.
- The graph shows current/recent simulation levels separately from the dotted projection up to +30 minutes of simulation time. Legacy scenarios use a private, read-only fork of the same simulation engine for a scenario projection, not an LSTM forecast. Synthetic replay retains its separate model forecast and source labeling. Unavailable forecasts are not replaced with invented values.
- Graphs use the same Recharts monotone curve style as the dashboard, with a light area fill and distinct prediction styling. The simulation graph uses per-node scale references generated from legacy scenarios, with padding and expansion for larger actual or projected values. Regenerate them after changing scenario behavior with `node scripts/generate-ciliwung-graph-scale.mjs`; a test checks that the reference remains current.
- The overview also has a graph view and selectable downstream locations. Pos Depok represents the actual ESP32 input when available; the four downstream levels are fixed visual presets, not individual sensor measurements. Empty node cards no longer show placeholder dashes. Historical sensor data is shown only when identified as ESP32; stale data is labeled as last data. A real ESP32-based forecast is **not implemented** and remains unavailable until a suitable model and data contract are established.
- The legacy demo starts Sukaraja and Cibinong at 58 cm. This is an uncalibrated demonstration baseline inspired by one Pos Ciluar reading, not a verified measurement for either node. Synthetic replay and model data retain their original dataset references. Standalone CupCarbon scripts still have their previous initial baselines until they receive backend updates.
- Legacy scenarios were recalibrated proportionally. At normal speed, approximate durations are light **3 h 59 min**, medium **3 h 17 min**, and heavy **2 h 28 min**. At 150× they take approximately **1 min 36 s**, **1 min 19 s**, and **59 s**, respectively. All finish within four simulated hours; heavier rainfall reaches its configured target sooner. Differences of a few simulated seconds can occur due to time-step size. The 1×, 10×, 25×, 50×, and 150× options remain available.
- Scenario duration, current-state values and projection behavior are for a synthetic demonstration; they are not validated flood warnings or inundation estimates. ESP32 hardware mode remains separate from simulation mode.

### Verification and remaining work

- Most recent `npm run build` passed, with the existing Vite large-chunk warning. The most recent `npm test` passed **84/84**, including simulation duration, 150×, graph, projection, replay, hardware-mode separation, and generated graph-scale checks.
- Earlier desktop and mobile browser checks covered the overview graph and empty/offline state; simulated snapshots were used to check the curve and node changes. Physical ESP32 readings, actual sensor-to-display behavior, and a full physical CupCarbon run have not been verified.
- The aggregate `npm run verify:ciliwung` previously passed its API, frontend, and CupCarbon contract checks but its final regression script expected branch `naufal` and stopped on `naufal_revamp-test`; no branch switch was performed.
- The separate 3D viewer at `D:\Documents\Semester7\Despro2\flood_3d_visual_map` is outside the SIMBA Git repository. It was not modified for the latest duration adjustment; files there are not covered by a SIMBA GitHub backup.
- Pending for the active ESP32/weather plan: confirm the actual sensor cadence and calibration, define the input/horizon contract, evaluate an appropriate sensor-and-weather model against baselines, implement it only when suitable, and test with real hardware. Do not present legacy `/api/predict` fallback values or synthetic replay predictions as a validated hardware forecast.
- Local development: from `D:\Documents\Semester7\Despro2\Website\SIMBA`, run `npm run dev` and open `http://localhost:3000`. The 3D view also requires its separate local viewer service. A server was restarted after the last duration change; its availability depends on the current local session.
