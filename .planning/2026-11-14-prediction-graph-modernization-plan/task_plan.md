# Task Plan: Ciliwung Prediction Graph Modernization

## Goal
Create a legible, accurate, screenshot-inspired graph and useful data controls for Ciliwung monitoring, with verified sensor/forecast provenance, reliable interactions, honest data coverage, and no regressions across connected views.

## Next Step
If a live read-only smoke test is needed, verify the 24-hour Firestore query and physical ESP32 display against the actual environment.

## Current Phase
Implementation and isolated verification complete; live cross-view verification remains pending.

## Scope and product decisions
- Target the overview hardware graph in `src/components/CiliwungHardwareLiveView.tsx`; compare it with the existing screenshot chart in `SCADADashboard.tsx`. Inspect the simulation graph and related views for shared dependencies and consistency; change them where evidence shows a relevant defect or shared behavior must be coordinated.
- Deliver a coherent improvement, not just a skin. Repair discovered issues within the graph/data/export paths when needed for correct behavior, including problems that predate this task. Separate genuinely unrelated issues with evidence rather than silently ignoring related defects.
- Match the screenshot's dark card, clear heading, legend, blue shaded history, grid, threshold lines and sensible controls; support existing light mode and Indonesian/English. Keep the graph readable and responsive rather than replicating tiny low-contrast screenshot text or clipped labels.
- Preserve current real-time subscription, hardware/simulation separation, N1–N5 selection, history inspection, selected-time forecast, stale/error behavior and map views, unless an existing behavior is shown to be incorrect, in which case fix it and document the change.
- This plan is for later execution; do not present its pending tests as passed or assume error-free delivery. Use actual configured thresholds, data and runtime observations rather than example values.

## Completion criteria
- History is ordered by actual timestamps, accurately positioned, correctly labeled and synchronized with selected node and selected reading; duplicates, missing values and delayed arrivals cannot fabricate data.
- Prediction starts at the selected time and uses only eligible earlier observations. Its horizon and spacing are accurate and legible; it is clearly separate from measured/derived history and labeled as a synthetic demonstration, not a real-world forecast.
- Each shown limit has verified source, unit, applicability, and label. N1 uses valid configured limits; N2–N5 use their own explicitly identified demonstration preset limits only if exposed through a consistent shared contract. Missing or invalid limits are handled transparently, not guessed or duplicated.
- Controls honestly represent available records, ranges, batch samples, and exports. Coverage, truncation, no data, errors and unavailability are visible. Raw distance is offered only where real raw measurements exist; reconstructed values are labeled as such or unavailable.
- Existing relevant automated checks and build pass or any pre-existing/external blocker is isolated and reported; browser verification covers the matrix below. No live telemetry injection, reset, restart, or production write is needed for tests.

## Phases

### Phase 1: Requirements & Discovery
- [x] Identify screenshot implementation, target graph, existing data flow and working-tree state.
- [x] Record known limitations and separate the planning request from implementation.
- [x] Define acceptance gates, implementation stages, regression strategy and safe test fixtures.
- **Status:** complete

### Phase 2: Establish Baseline and Map Contracts
- [ ] Re-read this plan and `findings.md`; check `git status --short`, diff, untracked files and applicable repository instructions. Preserve existing user changes; avoid checkout/reset/clean. Capture narrow before-change diffs or a safe external snapshot if required.
- [ ] Trace Firestore listener → normalization and reference height → backend hardware stream → N1 and N2–N5 history → selected point → `/api/ciliwung-hardware/demo-forecast` → SVG and map/3D/CupCarbon consumers. Record timestamp units, source fields, ranges, storage and threshold ownership.
- [ ] Inspect test and browser-verifier prerequisites before running. Run baseline `node --test tests/ciliwung-hardware-graph-ui.test.mjs tests/hardware-demo-forecast.test.mjs tests/hardware-live.test.mjs tests/normalize-reading.test.mjs`, then `npm run build` if dependencies exist. Log failures, duration, environment and pre-existing causes; do not label an unrun test as passed.
- [ ] Verify browser tooling and determine a safe fixture/mocked API approach. Do not start or restart the user's backend/CupCarbon or write Firebase data merely for testing.
- [ ] Existing `scripts/verify-ciliwung-browser.mjs` targets fixed localhost ports and posts start, reset and speed changes: never run it against a live instance; adapt or isolate it. `verify-ciliwung-regression.mjs` assumes branch `naufal`, runs another project's tests and writes/removes a fixed output path; check prerequisites and output ownership before running. Use equivalent safe checks and report differences if it cannot run safely.
- **Status:** complete

### Phase 3: Design Graph and Data Contract
- [ ] Define explicit point shape: real timestamp in milliseconds, value/unit, sensor/derived/simulation provenance, sample-vs-packet scope and optional raw value; distinguish missing, invalid and zero. Normalize without mutating persisted records.
- [ ] Decide documented graph window(s), axes and prediction horizon based on actual data. Retain the verified 90-point, 20-second-step forecast over its 30-minute horizon; any zoom or separate view must preserve chronological spacing, selection and a clear present/forecast boundary. Historical forecast must anchor to the selected timestamp.
- [ ] Define limits by node: N1 valid configured Siaga/Bahaya (validate finite values and ordering); downstream preset thresholds must come from a shared source that also drives classification, labeled as visual demonstration thresholds, never verified physical-site limits. Missing/inapplicable limits produce an explicit unavailable state.
- [ ] Include visible values, forecast and relevant limits in scale calculation without clipping, while guarding negative/huge/invalid numbers, flat series, single point, threshold above data and usable label spacing. Document behavior when including limits makes the signal hard to read.
- [ ] Decide reusable chart/presentation components only after mapping dependencies; avoid copying threshold/data logic into multiple components. Maintain IDs and accessibility semantics where consumed by tests or integrations.
- **Status:** complete

### Phase 4: Implement Graph Presentation and Correctness
- [ ] Implement responsive header, meaningful legend, readable axes and grid, blue shaded history, clear future trace and limit lines. Use distinct patterns and labels as well as color; support mobile, light/dark, ID/EN and keyboard/screen-reader interaction.
- [ ] Maintain/improve pointer capture, touch behavior, slider and return-to-latest, selected-time indication, node switching and no-data/loading/offline/error states. Ensure graph resizes and pointer-to-time mapping remain correct.
- [ ] Verify history/forecast coordinate math, selection when older data ages out or node changes, event cleanup, tooltip timestamps and selected value. Address identified correctness defects with focused tests.
- [ ] Ensure presentation changes do not alter normal readings, database state, alerts, map/3D or CupCarbon behavior. Fix any related dependency defects discovered by tracing; record intentional user-visible behavior changes.
- **Status:** complete

### Phase 5: Implement Honest Data Controls
- [ ] Design latest/30-minute/24-hour selections against actual storage. For 24 hours use a bounded time query and pagination as needed; correctly handle timestamp representations, ordering, stable boundaries, mixed sources, late arrival, empty/error/partial results and readable performance. Show actual coverage and any cap; do not call limited data a full day. Do not increase persistent subscriptions/cost without justification.
- [ ] Verify Firestore storage types and query behavior: numeric seconds, numeric milliseconds, string and Firestore timestamps may not compare together in one range query. Handle compatible sources separately where necessary, deduplicate using stable IDs, and surface unverifiable coverage instead of asserting completeness.
- [ ] Design raw ultrasonic and batch views against actual ESP32 packet shapes, sample count and timestamp availability. Show actual count (including 20-point hardware packets versus 360-point legacy data); do not invent exact sample times or label computed reference-minus-level as measured raw distance. Explain unavailable views for N2–N5 and absent fields.
- [ ] Define export scope in UI and filename: selected node, range, time zone, units, source, measurement versus derived and completeness. CSV fields must escape commas/quotes/newlines, handle missing data, protect spreadsheet consumers, and exclude or explicitly identify forecast. Validate whether legacy export needs a targeted fix or shared implementation; no silently truncated 24-hour export.
- [ ] Keep graph and export source/range alignment explicit, with graceful loading/cancellation, retries and no hidden production writes. Avoid offering controls that claim functionality unsupported by the observed data contract; implement useful accurate alternatives with a clear explanation.
- **Status:** complete

### Phase 6: Automated Unit and Integration Verification
- [ ] Add meaningful tests for N1 versus derived nodes, applicable threshold values and invalid/missing configuration; test scale at boundaries, values above limits, flat/single/empty series, invalid/duplicate/out-of-order timestamps, large numbers and missing data.
- [ ] Test selection via slider and pointer coordinate conversion; live return; node changes; aged-out history; stale-to-live and live-to-stale; stream disconnect/reconnect; selected-time forecast anchored to the past and computed only from preceding eligible readings; failed, slow and out-of-order forecast responses.
- [ ] Test 20-second prediction spacing and actual displayed horizon, time zone/day boundary, timestamp units, data gaps, exact cutoff and 120-record cap. Verify downstream history is explicitly reconstructed with current calibration.
- [ ] Test mode/range availability, raw-vs-derived distance, 20/360 batches, missing timestamps, 24-hour paging/limit/error/partial coverage and CSV escaping, source/range alignment and empty/export-failure handling using isolated deterministic fixtures.
- [ ] Run focused graph, forecast, normalization and hardware tests; run `npm test`, `npm run build`, and `npm run verify:ciliwung` after inspecting their prerequisites and side effects. Add browser automation only if existing tooling supports it safely. Capture results and compare pre-change baseline; investigate each new failure.
- **Status:** complete

### Phase 7: Browser and Cross-View Verification
- Isolated fixture checks are complete and documented in progress.md. Live map/3D interaction, real Firestore/ESP32 and a full assistive-technology session remain unverified; these are not implied by the automated tests.
- [ ] Using isolated fixture-backed services or mocks, verify 360px, tablet and desktop; dark/light and ID/EN; check text contrast, axis/legend clipping, long labels, resize and no horizontal overflow. Compare against screenshot without making claims based solely on DOM tests.
- [ ] Walk N1–N5, map/graph/3D switch, slider, mouse/touch/pointer, keyboard/focus, screen-reader names and no-data/one-point/offline/reconnect states. Compare selected timestamp/value and forecast against fixture expectations, including a historically selected point.
- [ ] Exercise real-time updates and slow/stale forecast responses, rapidly changing nodes and controls, query failure and partial 24-hour data; ensure old responses cannot overwrite the current selection. Check browser console and request lifecycle; avoid excessive network/query repetition.
- [ ] Compare screenshot and target at equal representative values; visually check scales, thresholds and time spacing. Use real hardware only for optional read-only smoke testing when available, record availability; never present fixture results as live-device validation.
- **Status:** in_progress

### Phase 8: Review and Regression Closure
- [ ] Review complete diff, including modifications to existing user work. Check exports, semantic labels, accessibility, performance, data privacy, cleanup and unrelated side effects. Confirm simulation graph/3D and hardware contracts if affected.
- [ ] Re-run only checks impacted by fixes; document actual command outcomes, screenshots/fixtures used, unmet conditions and known limitations. Ensure no secrets, generated scratch files or unrelated changes are included.
- [ ] Trace every acceptance criterion to test or manual evidence, and explicitly state any unavailable hardware, services, permissions or unverified behaviors. Never claim zero risk or complete coverage.
- **Status:** complete

### Phase 9: Delivery
- [ ] Summarize the change, intentional fixes, tests and meaningful residual risks; distinguish actual sensor verification from simulated testing.
- [ ] Update this plan, findings and progress with evidence and the final diff state. Do not deploy or send external messages as part of this task.
- **Status:** complete

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Preserve the existing graph's data and interactions as a baseline, while allowing fixes to related defects | Avoid superficial redesign and preserve useful behavior. |
| Build controls against real source and coverage contracts | Current labels and limits do not guarantee complete 24-hour data or 360 samples. |
| Separate forecast and source provenance in visuals and exports | Downstream presets and synthetic demonstrations are not physical measurements or validated forecasts. |
| Use deterministic isolated tests first | Live telemetry and connected systems must not be changed as a side effect of testing. |
| Record a baseline before interpreting failures | Existing uncommitted changes and environment dependencies can produce pre-existing failures. |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| Existing plans made unpinned plan resolution ambiguous | Initialized a distinct named plan, restored previous shared active pointer, and use explicit plan path and task pin. |
| A patch attempted to delete and add the same planning file | Switched to writing the newly initialized file directly; no product code was affected. |


