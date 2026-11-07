# Findings & Decisions

## Requirements
- Classroom demonstration must use live ESP32 in the hardware dashboard; not the Simulation Mode page.
- Select plausible rain conditions for a controlled demonstration and calculate a forecast from current sensor history plus the weather input. Keep UI clean without additional explanatory wording.

## Research Findings
- `server.ts` registers the hardware bus, mode controller and existing forecast worker; Firebase missing disables hardware persistence. Inspect actual runtime and data route before implementation.
- `backend/ciliwung/hardware-live.mjs` supplies live state, SSE and reset. Existing simulation forecast and scenario previews have separate state; historical preview outputs must not be presented as predictions from live sensor values.
- `Week11/.../Desain Proyek.ipynb`: Open-Meteo historical weather, synthetic water level, 24 hourly single-feature history to predict next hour; no forecast rain input. Notebook fits scaler before split. Local re-evaluation: 7,006 synthetic test windows MAE 2.79 cm, RMSE 7.84 cm; persistence MAE 3.40 cm, RMSE 8.12 cm. This is not real-world validation.
- Prior synthetic_v2 model and worker exist, but suitability for accelerated live hardware and scenario inputs must be checked with the actual model contract, not assumed.
- Map heat bands are illustrative and not validated flood extent; N2-N5 are preset-derived in hardware flow.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Independent scenario/episode split and train-only scaling | Prevent leakage. |
| Maintain provisional demo time separately from real weather time | Seconds cannot be relabelled as real forecast hours without a validated model. |
| No synthetic backfill as sensor measurements | Preserve the distinction between demonstration and actual ESP32 readings. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| ESP32 cadence, calibration and demo duration not yet known | Inspect equipment and capture representative data during implementation. |

## Resources
- `CILIWUNG_HANDOFF.md`, `backend/ciliwung/hardware-live.mjs`, `server.ts`, `ml/README.md`, Week11 notebook and dataset.
