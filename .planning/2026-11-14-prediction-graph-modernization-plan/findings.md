# Findings & Decisions

## Requirements
- Produce a comprehensive implementation and verification plan; this request does not authorize implementing the product change.
- Adapt the screenshot's SCADA chart to the Ciliwung prediction graph while reviewing and improving surrounding functionality where needed; preserve trustworthy data semantics.

## Research Findings
- Screenshot matches `src/components/SCADADashboard.tsx` chart: Recharts AreaChart, gradient, grid, tooltip, threshold reference lines, mode/range controls, CSV export.
- Target `src/components/CiliwungHardwareLiveView.tsx` GraphView uses SVG and Recharts Curve, 30-minute historical view, node selection, pointer/slider selection, forecast and stale-data states.
- Firestore listener reads up to 120 sensor documents; current SCADA 24-hour chart selects all loaded documents, not an explicit 24-hour query. Its CSV query has 1500/1000 caps and fallback; completeness cannot be assumed.
- N1 history is filtered to ESP32; N2–N5 are reconstructed or derived presets, not measured downstream data. Current forecast is a synthetic demonstration model, not a validated field forecast.
- Workspace has multiple pre-existing modified/untracked product files; baseline them and preserve edits. Prior active planning pointer was restored after creating this task's named plan.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Start with existing graph and compare screenshot, not wholesale replacement | Preserve interactions while allowing evidence-driven improvements. |
| Treat missing data, threshold provenance, visual accessibility, and correctness as first-class requirements | A working render alone is insufficient. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Multiple unrelated existing plans made unpinned resolution ambiguous | Created an isolated named plan; use explicit PLAN_ID and PWF_PLAN_ROOT; restored prior shared active pointer. |
| Initial apply_patch could not delete and add the same path in one patch | Use a direct replacement of the newly initialized findings file. |

## Resources
- `src/components/CiliwungHardwareLiveView.tsx`, `src/components/SCADADashboard.tsx`
- `tests/ciliwung-hardware-graph-ui.test.mjs`, `tests/ciliwung-forecast-ui.test.mjs`

## Additional Findings (14 November)
- `backend/ciliwung/hardware-live.mjs` classifies N2–N5 with fixed visual thresholds of 180/280 cm, while N1 uses configured limits. The downstream values are presets, not validated real-site limits. The constants are currently internal to that module.
- The graph lays out 30 minutes of future time, but current demo predictions are spaced 20 seconds apart; the forecast may be visually compressed. Historical selection must anchor forecast timestamps to the selected reading and preserve time coordinates.
- The history filter and maximum axis derive from different arrays. Thresholds and current displayed/forecast data must influence sensible y bounds without misleading clipping or flattening.
- The overview CSV queries `timestamp >= oneDayAgo` with ascending order and a limit of 1500; a fallback reads up to 1000 latest entries. It does not prove 24-hour completeness. Avoid presenting this as a complete selected-graph export.
- `src/components/ciliwung-graph-scale.json` is generated for the separate simulation graph; do not treat it as authoritative hardware threshold configuration.
- Existing regression scripts include `verify:ciliwung` and browser and forecast verifiers; inspect prerequisites before running because some may require live services or affect running systems.
- `scripts/verify-ciliwung-browser.mjs` hard-codes localhost:3000/8765 and sends simulation start/reset/speed POSTs; do not run against an existing instance. Isolate or adapt the verifier first.
- `scripts/verify-ciliwung-regression.mjs` requires branch `naufal`, invokes tests in the separate 3D project, writes then removes a fixed output path and may invoke npx. Inspect branch, side effects and pre-existing output before running; if unsafe, run equivalent safe checks individually and report the difference.
- `normalizeReading` takes the latest valid distance from a packet when water_level is absent, uses reference height and rounds to 0.1 cm. Timestamp parsing supports numeric seconds/ms, Firestore timestamps and strings. Mixed Firestore timestamp types may require distinct compatible queries; completeness must be proven rather than assumed.
- Local `node_modules` and `package-lock.json` exist. A listing that included absent alternative lockfiles exited 1; this is not a product test failure.

## Implementation baseline
- 15 focused graph, hardware, forecast and normalization tests pass; `npm run build` passes with an existing Vite large-chunk warning.
- Correction to earlier planning observation: the worker returns 90 predictions at 20-second intervals, covering 30 minutes. The existing 30-minute future section is suitable for the full model horizon; verify historical selection and time positioning rather than assuming compression.
- A lookup attempted nonexistent `src/firebase.ts`; Firestore is imported elsewhere. No configuration or credentials were read or changed.

## Completion and verification notes
- The graph is implemented and tested against deterministic fixtures. The 24-hour loader queries milliseconds, seconds, Firestore timestamps and ISO UTC strings in separate bounded streams. Unknown formats, missing data, failed streams and limits prevent a completeness guarantee; the UI and CSV say so.
- Downstream thresholds are shared with the preset classifier and explicitly labeled illustrative. The current synthetic 90-step forecast covers 30 minutes and its responses are fenced against stale selection changes.
- Screenshot-chart corrections include truthful range/batch labels, estimated distance, dynamic scale, explicit display despiking, and safer bounded CSV export.
- Browser QA was isolated and fixture-backed; it did not prove actual Firestore permissions, physical ESP32 output, production performance, a full assistive-technology session, or interactive map/3D rendering.
