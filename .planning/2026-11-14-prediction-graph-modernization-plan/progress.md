# Progress Log

## Session: 2026-11-14

### Current Status
- **Phase:** 1 complete; Phases 2–9 are future implementation and verification.
- **Started:** 2026-11-14

### Actions Taken
- Read the requested planning skill, examined existing graph and screenshot implementation, threshold classifier, sensor normalization, forecast code, tests and verifier side effects.
- Created an isolated named plan and restored the previously active shared plan pointer. Explicit task selector is `PLAN_ID=2026-11-14-prediction-graph-modernization-plan`, root `D:\Documents\Semester7\Despro2\Website\SIMBA`.
- Wrote acceptance criteria, nine phases, data and UX design checks, deterministic testing, browser scenarios, related-code review and reporting criteria.
- No product files changed; existing modifications were present before this planning task.

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| Planning skill structural validation | Nine valid phases | Valid (9 phases) | Passed |
| Product tests, build and browser testing | Execute during future implementation baseline and final verification | Not run for this planning-only request | Pending |

### Errors
| Error | Resolution |
|-------|------------|
| Unpinned plan lookup was ambiguous because unrelated plans exist | Created a named plan, restored prior shared pointer, use explicit task selector. |
| `apply_patch` rejected delete/add of the same findings path | Wrote newly initialized findings file directly; no product file changed. |
| Listing both present and absent lockfiles exited 1 | Confirmed local node_modules and package-lock exist; absence of alternative lockfiles is not a product failure. |

## Implementation session
- User requested execution. Focused baseline: 15/15 tests passed. `npm run build` passed (existing large-chunk warning).
- Corrected planning assumption: model returns 90 predictions at 20-second spacing, a 30-minute horizon.
- Browser executable is available. Existing browser verifier is unsafe for a live service; isolated fixture strategy is required.
- Implemented screenshot-inspired graph presentation, node-aware limits from shared hardware preset definitions, selected-window CSV, truthful latest/30-minute controls and raw packet visualization with sample indices.
- Added on-demand 24-hour history queries for supported Firestore timestamp types, bounded pagination, cancellation of stale requests and partial-coverage messaging. No live Firestore writes.
- Corrected the legacy SCADA range label to describe its actual loaded-history scope and clarified its bounded log export.
- Intermediate checks: focused existing graph/hardware/forecast tests pass; TypeScript passes. Full tests and browser verification remain pending.
- Added automated coverage for configured versus preset thresholds, graph scale, CSV escaping/formula protection, actual raw samples, supported Firestore timestamp formats, pagination, failed queries and capped results.
- Full `npm test`: 103/103 passed; `npm run build`, API contract and frontend contract checks passed. Build retains the pre-existing large-chunk warning.
- Isolated desktop/mobile screenshots were captured from a mocked fixture. Initial narrow screenshot needed a true emulated viewport; added a horizontally scrollable minimum-width graph to keep axis labels readable.
- Browser fixture uses local sample data only. No hardware, Firestore or simulation mutation was performed.
- Browser fixture first asserted a `data-testid` on the actual SVG path, but Recharts does not retain that test attribute in rendered DOM. Switched the browser assertion to verify rendered SVG paths; component tests still exercise the React trace.
- True 360px emulated Chrome fixture passed: no page-wide horizontal overflow, actual SVG rendered, raw samples/node switching, light theme, recent-range selection and slider worked, with no browser exceptions. The chart itself scrolls sideways; a visible hint was added.
- Full verifier cannot be used unchanged: `verify-ciliwung-regression.mjs` asserts branch `naufal`, while this checkout is `naufal_revamp-test`. Run equivalent safe checks individually and state the difference.
- `git diff --check` found trailing whitespace introduced in a graph-domain line; removed it before final verification.
- Expanded browser matrix initially failed because the isolated fixture assigned the same display name to every downstream node; corrected the fixture rather than product code.
- The English heading assertion used mixed-case `innerText`, which Chromium reports as uppercase due to CSS. Updated the assertion to compare case-insensitively.
- Browser fixture had a rendering race: the graph container appeared before its SVG path. Wait for the actual plotted path before measuring the viewport.
- Diagnosed intermittent isolated browser startup: Chrome remained in `document.readyState=loading` on the local fixture; extended the readiness timeout and kept results separate from product failures.
- Extended browser walk found that returning to N1 after a downstream node could unexpectedly restore the previously selected raw batch view. The graph now resets to elevation when the location or simulation mode changes; added a regression assertion.
- The browser accessibility tree exposes the graph as role `image` (Chromium's name for `role=img`) with its correct English accessible name; the initial `img`-role assertion was a fixture error. Keyboard arrow input on the history slider passed.
- Final isolated browser fixture passed at 360 px, 768 px and 1440 px, both themes and languages, node labels N1–N5, packet view, recent and 24-hour controls, historical slider, pointer selection and forecast-anchor checks. Tests used mock data and did not exercise the real map/3D page or live Firestore/ESP32.
- Final product checks: `npm test` 105/105, `npm run build`, API/frontend contracts, CupCarbon integration and seven 3D backend contract tests passed; `git diff --check` passed. Build reports its existing large-chunk warning.
- `npm run verify:ciliwung` was not run unchanged because its regression script asserts a different branch; relevant API, frontend, CupCarbon, website test suite and 3D backend checks were run individually. Full real-device/browser-integration and screen-reader-user testing remain unverified.

## Follow-up: appearance and animation
- Added a current-value/status display, grouped controls and a compact expandable graph explanation. Kept downstream preset limitations visible outside the collapsed text.
- Added a brief series reveal on location/range changes, batch/forecast fades, control and location-card transitions, and selected-point movement. Animation changes presentation only; no sensor or forecast values are interpolated or stored.
- Checked in isolated Chrome that the series animation is running after a location change, and is disabled under `prefers-reduced-motion`. The mobile, tablet, desktop, node, slider and language fixture checks passed again.
- Focused graph tests: 13/13 passed; production build and diff whitespace check passed. The build continues to report its existing large-chunk warning. Live hardware/Firestore remain unverified.
- The first morph-browser run confirmed intermediate curve shapes, then failed because the fixture cycles through five nodes rather than toggling N1/N2. Adjusted the fixture reset sequence; no application error occurred.

## Follow-up: curve morphing
- Replaced the previous reveal/redraw animation with interpolation between the currently displayed line and the next line. A location, range or telemetry change keeps the existing SVG path and moves it smoothly over 500 ms; interrupted transitions continue from the current visible shape.
- Interpolation occurs only in screen coordinates. Recorded observations, export data, selected values and prediction inputs remain unchanged. Reduced-motion preference skips the transition.
- Added interpolation tests for differently sized series and checked actual browser path geometry before, during and after changing nodes, including reduced motion. `npm test`: 106/106 passed; build and diff whitespace checks passed. Browser verification used fixtures, not live ESP32/Firestore.
- The isolated full-component browser fixture did not reach its graph button on the first attempt; investigating fixture startup. Automated component tests and production build passed.
- The first full-component fixture had an incomplete Leaflet mock (`map` was missing), causing React to unmount before the graph opened. The application uses the real Leaflet library; the fixture is being corrected.

## Follow-up: remove selection block and populate downstream cards
- Removed the selected-reading text, visible history slider and old-data forecast warning shown in the user's screenshot. The graph remains selectable via pointer and keyboard, with an accessible selected value and a return-to-latest action when needed. Synthetic-forecast context remains under the graph explanation.
- When the hardware stream has no current snapshot, or its snapshot is older than the latest ESP32 reading, node cards derive downstream preset values from that reading and the configured thresholds. Old data is labeled accordingly; no physical downstream sensors are implied.
- Tests cover stale and missing snapshots, newer stored readings, all five cards, removed UI and keyboard selection. All 108 tests passed before the final accessibility-role adjustment; 18 affected graph/hardware tests and the production build passed afterward. The isolated full-component browser fixture also confirmed all five cards and removal of the slider, using simulated data.

## Follow-up: graph layout
- Removed the monitoring heading, the graph's expandable explanation, and the two requested downstream description lines. The node cards still identify their downstream values as visual presets.
- Moved the latest/30-minute/24-hour buttons below the graph and above the history coverage text; kept export in the upper controls.
- Focused graph tests (11/11), production build and whitespace check passed. A fixture-backed browser check verified control ordering, the removed text, node cards and keyboard selection. Live ESP32/Firestore were not exercised.

## Follow-up: sensor distance toggle
- Moved Elevasi air below the graph beside the new Jarak sensor control, with range controls left and CSV export above. Raw-packet view remains accessible and either lower metric button returns to the history graph.
- N1 sensor-distance graph uses recorded packet distances when available; otherwise it estimates from the currently configured reference height and labels the estimate. It uses its own axis/reference line, omits elevation thresholds/forecast and exports the displayed metric with its method. Downstream nodes and simulation do not claim physical sensor distances.
- 24-hour loading preserves recorded distance, while live snapshot merging retains recorded distance at matching timestamps. Old distance cannot be labeled live merely because a newer elevation exists.
- Full suite passed 115/115 before the final stale-distance adjustment; after that adjustment, 27 targeted tests and the production build passed. The isolated browser fixture checked layout, N1/downstream availability, chart modes, raw-batch return and actual distance CSV contents. Live ESP32/Firestore were not exercised.

## Follow-up: detailed graph time axis
- Replaced sparse endpoint labels with nine chronological ticks. Elevation uses five history ticks and four future-time ticks mapped to the separate 30-minute prediction scale; sensor distance uses nine ticks across history.
- The 24-hour view displays local time and date on separate lines, including across midnight. Labels and vertical grid lines use the same time-to-coordinate mapping as the graph.
- Focused graph tests passed 25/25, including separate history/forecast and distance scale checks; production build passed. An isolated browser fixture checked labels and non-overlap at desktop and 360 px; no live ESP32/Firestore testing was performed.
- A browser-verification tool call contained malformed orchestration syntax and did not execute; corrected the invocation. No project files were affected.

## Follow-up: hide location panel
- Added a Sembunyikan lokasi / Tampilkan lokasi toggle in the graph navigation. The panel starts open; hiding it removes its layout space so the chart expands, while preserving the selected location.
- The toggle exposes its state to assistive technology and remains available to reopen the panel. The panel stays hidden or visible when navigating between views during the current session; a fresh mount starts open.
- All 18 focused graph UI tests and the production build passed. An isolated browser fixture verified actual graph width increases on desktop, panel visibility/restoration and node retention, plus hiding on a 360 px viewport without page overflow. No live ESP32/Firestore testing was performed.

## Follow-up: remove raw batch control
- Removed the Batch mentah control and its dedicated display from the prediction graph. Packet samples continue to supply the sensor-distance graph when available.
- Focused graph tests passed 26/26, including switching between elevation and distance with packet data; production build and whitespace check passed.

## Follow-up: sensor-distance button availability
- Removed the disabled condition on Jarak sensor. When a downstream node is selected, the control switches the graph to the physical sensor location at Pos Depok (N1), rather than mislabeling a derived downstream preset as a sensor reading.
- In simulation mode, the control shows a clearly labeled simulated distance calculated from the configured reference and simulated N1 level. A missing reference produces an unavailable state, and physical readings are not mixed into the simulated calculation.
- `npm test` passed 121/121, production build passed, and an isolated browser fixture verified the downstream-to-N1 click, simulation labeling, graph controls and CSV. Live hardware and Firestore were not exercised.

## Follow-up: white border during drag
- Prevented mouse dragging on the graph from focusing/selecting SVG text and removed the browser default outline; retained a visible focus indicator for keyboard navigation.
- Focused graph tests passed 20/20, production build and whitespace check passed. An isolated browser fixture verified mouse drag still changes the selected point without an outline or selected text, keyboard focus remains visible, and mobile horizontal touch scrolling still works. No live ESP32/Firestore testing was performed.

## Follow-up: selected point time
- Added a time label beside a selected historical point, with the date in the 24-hour view; its position stays within the chart and follows the selected point for elevation and sensor distance.
- Focused graph tests passed 20/20, including exact selected times in both metrics and the 24-hour view; production build and whitespace check passed. An isolated Chrome fixture verified the visible label, keyboard selection, mouse drag and mobile scrolling. Live ESP32/Firestore were not exercised.

## Follow-up: selected point guide
- Added a vertical guide through the selected point for both graph metrics, including the latest reading. The marker and guide move together without interfering with pointer selection.
- Focused graph tests passed 20/20 and production build passed. An isolated Chrome fixture checked alignment after selection and drag, keyboard focus and mobile scrolling. Live ESP32/Firestore were not exercised.
