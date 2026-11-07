# Task Plan: ESP32 and weather forecasting classroom demonstration

## Goal
Create a hardware-dashboard proof of concept that accepts live ESP32 water-level measurements and a selected weather scenario, computes a short-horizon combined forecast, and demonstrates its response clearly without claiming real-world flood validation.

## Next Step
Inspect actual ESP32 telemetry units, measurement cadence and Firebase configuration; record a short sample and agree on classroom demonstration duration before choosing the final time contract.

## Current Phase
Phase 1 - Discovery and demonstration contract

## Phases

### Phase 1: Discovery and demonstration contract
- [ ] Inspect current server.ts telemetry path, hardware-live.mjs, forecast worker, hardware dashboard and 2D/3D/CupCarbon consumers; document exact units, timestamps, sampling, thresholds and current mode transitions.
- [ ] Confirm hardware availability, calibration and water-level versus sensor-distance conversion, range, mounting geometry, demo duration and network/Firebase availability; capture sample records without exposing credentials.
- [ ] Decide a practical time contract: sample interval, number of history bins, forecast horizon, warm-up time and classroom reset procedure. Proposed starting point: 5-second bins, 12-bin history and 60-second demo horizon, adjustable after hardware inspection. These are demonstration times, not physical hours or BMKG time intervals.
- [ ] Define units and conversion for rain scenarios; do not equate weather labels with official BMKG thresholds or pretend an accelerated scenario is an actual forecast.
- **Status:** pending

### Phase 2: Data and controlled experiments
- [ ] Audit Week11 friend model and existing synthetic_v2 model and reusable generators; preserve existing models. Document their input shapes, cadence, target, scaler, licensing/provenance and suitability; do not claim either supports new inputs without testing.
- [ ] Design seeded independent synthetic episodes with plausible varied starting levels, sensor noise, rain patterns, delays, recession and missing readings. Include counterfactual pairs with identical history and different future rain plus identical rain and different sensor readings. Encode explicit scenario assumptions, not calibrated hydrology.
- [ ] Optionally derive documented rain scenario ranges from historical weather where sources and permissions are confirmed; historical Open-Meteo values are not automatically BMKG forecasts. Separate historical observation and live BMKG weather context from selected classroom scenario.
- [ ] Split by whole independent episode before fitting preprocessing; fit scaler only on training data; use deterministic seeds and held-out event types/seeds. Avoid overlap/leakage across splits, and store dataset provenance.
- **Status:** pending

### Phase 3: Model training and evaluation
- [ ] Define an explicit multi-input contract: recent measured levels and timestamps on the demo clock, selected known future rain trajectory, fixed horizon(s), units, data-quality flags and missing-data behavior. Ensure every future rain value is available at inference.
- [ ] Train a compact combined LSTM plus a same-cadence sensor-only model, persistence and trend baselines using the same held-out episodes. Friend's 24-hour model is an additional comparison only if its shape/cadence are respected; do not pass seconds to an hourly model.
- [ ] Report MAE and RMSE in cm, baseline-relative improvement, sample counts and event-level/worst-case errors; evaluate counterfactual rain sensitivity and sensor sensitivity, out-of-range/stale/missing data, and repeated runs. Select based on evidence, not LSTM preference.
- [ ] If the model fails to beat baselines or does not respond meaningfully to inputs, record failure and revise dataset/model or use an explicitly named baseline; do not claim trained fusion or fabricate results.
- [ ] Save reproducible model/scaler artifacts, metadata, feature order, versions, checksums, model selection and test reports; never load untrusted pickle artifacts.
- **Status:** pending

### Phase 4: Hardware dashboard integration
- [ ] Extend the existing hardware bus/forecast worker after inspecting their interfaces; use live ESP32 N1 readings and a separate chosen demonstration weather profile. Preserve hardware/simulation isolation, Firestore telemetry and current CupCarbon paths.
- [ ] Maintain bounded time-aligned ring buffer; define duplicate/out-of-order readings, units, interpolation rules, start-up/warm-up and forecast cadence. Never invent historical sensor readings. On missing/stale data, worker failure or insufficient history, show unavailable and clear old forecasts.
- [ ] Add weather scenario selector and compact current/predicted display and graph on the hardware dashboard, with no extra explanatory copy clutter. Respect user request for a clean UI; retain source, scenario, timestamps and provenance in API and documentation.
- [ ] Keep measured current value separate from forecast, downstream derived values and overlay. Drive forecast visuals only from actual computed forecast; show illustrative maps without implying measured or validated inundation. Preserve mode switching/reset and don't overwrite historical ESP32 data.
- [ ] Use bounded worker queue/timeouts, lifecycle cleanup, error reporting and stable model version; no secrets in source, no automatic deploy or changes to main.
- **Status:** pending

### Phase 5: Verification and rehearsal
- [ ] Test feature ordering, units, history binning, no leakage, warm-up, scenarios, responsiveness, worker failures, stale/disconnected telemetry, reset/reconnect and mode separation with automated meaningful tests.
- [ ] Run relevant backend/frontend tests and build, then browser-test desktop/mobile, current versus forecast graph, scenario selection, 2D/3D behavior and stale/error conditions.
- [ ] Perform end-to-end ESP32 + Firebase rehearsal: move water level, check actual event/timestamp from sensor to dashboard, collect enough genuine samples, change rain scenario while holding input steady, observe computed output, disconnect/reconnect and reset. Record measured latency and evidence. If hardware unavailable, mark this gate pending.
- [ ] Verify safety of demonstration equipment and connection based on actual setup; prepare a reliable offline/network contingency without presenting replayed readings as live.
- **Status:** pending

### Phase 6: Documentation and delivery
- [ ] Prepare concise setup/run steps, classroom sequence, troubleshooting, model and scenario assumptions, experiment metrics, limitations and future path to real paired sensor/BMKG validation in project documentation, without cluttering the product UI.
- [ ] Report exactly which gates passed and which require real hardware; do not push or deploy without instruction.
- **Status:** pending

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Hardware dashboard is the demonstration entry point | User will use the ESP32, not Simulation Mode. |
| Sensor plus selected weather are model inputs | Both must affect calculated output; keep selected weather distinct from actual BMKG. |
| Proposed seconds-based demo cadence is provisional | A short classroom demo cannot automatically establish an hourly physical prediction. |
| Compare combined model to sensor-only and simple baselines | Adding rainfall or an LSTM must be justified by held-out evidence. |
| Minimal product text; provenance retained in documentation and API | User wants a clean interface without misleading data or unnecessary explanatory text. |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| None | — |
