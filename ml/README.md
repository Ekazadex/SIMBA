# SIMBA synthetic flood forecasting (v1)

**Synthetic-data LSTM demonstration; not validated for operational flood warning.** The models and metrics below describe only generated events under an uncalibrated conceptual routing rule. Do not use them as a real-world flood warning or call synthetic 5-minute rainfall a BMKG measurement.

## Reproduce from the SIMBA directory

Use CPython 3.13 on native Windows. The exercised interpreter is `ml/.venv/Scripts/python.exe` (3.13.5, CPU-only TensorFlow 2.21.0). For a *new isolated* environment, use `uv venv --python 3.13 ml/.venv` and `uv pip install --python ml/.venv/Scripts/python.exe -r ml/requirements.txt`; the pre-existing exercised `.venv` has `include-system-site-packages = true` and resolves some dependencies from the user's Python site, so it is **not itself isolated**. Direct dependencies are version-pinned in `requirements.txt`, but their transitive wheels and platform are not hash-locked. The raw workbooks must exist at the configured read-only `../../../../DATABMKG` path relative to `ml/config/synthetic_v1.json`.

Run in a Bash/Git-Bash shell at `Website/SIMBA`:

```bash
PYTHONPATH=ml/src ml/.venv/Scripts/python.exe -m simba_forecast.generate --config ml/config/synthetic_v1.json
PYTHONPATH=ml/src ml/.venv/Scripts/python.exe -m simba_forecast.train --config ml/config/synthetic_v1.json
ml/.venv/Scripts/python.exe -m pytest ml/tests -q
ml/.venv/Scripts/python.exe ml/scripts/verify_pipeline.py
ml/.venv/Scripts/python.exe ml/scripts/smoke_worker.py
```

On Windows `cmd.exe`, use `set PYTHONPATH=ml/src` before the two `-m` commands. `pytest.ini` provides the path for pytest; the two verification scripts insert it themselves. For a resident process, run `ml/.venv/Scripts/python.exe ml/src/simba_forecast/predict_worker.py --models-dir ml/models` and send one UTF-8 JSON request per line; stdout has one ready line then exactly one JSON response per request, with diagnostics on stderr. `smoke_worker.py` uses a **test** episode and verifies both nodes and a cold-start failure through a real child process.

Outputs:

- `ml/data/generated/synthetic_v1/manifest.json`, `timeseries.csv`, `targets.csv`, `episodes/<episode-id>.json` (128 scenarios; 288 five-minute bins × 9 semantic nodes each).
- `ml/models/N1.keras`, `N1.json`, `N5.keras`, `N5.json` (model weights plus fitted training-only scaler, feature order, thresholds, version, source-manifest/model hashes, and validation-selected demo method).
- `ml/reports/synthetic_v1.json` (unrounded validation, test, stress and family-cohort metrics, confusion matrices and denominators) and `ml/reports/synthetic_v1.md` (readable summary).

The config fixes seed `20261010`, 16 episodes/family, 5 maximum epochs, 18 training windows/episode and 12 validation windows/episode; both held-out partitions use **all** eligible windows. The generator is seeded and byte-repeatable with the same raw workbooks and toolchain. TensorFlow floating-point/training artifacts may not be byte-identical across CPU versions. Re-running generation with different raw files makes existing model hashes invalid; retrain and reverify together. Do not change history or horizon lengths without a new dataset/model version and tests.

## Data and model boundaries

Eight families (`dry`, `light`, `local_intense`, `upstream_delayed`, `compound`, `receding`, `false_positive`, `stage_only`) are assigned by *episode*, 80 train / 16 validation / 16 test / 16 stress. Stress events use shifted gain/drainage, longer double-peaked storms, wider onset, greater sensor noise and some masked sensor bins; the generator itself remains a synthetic approximation. There is no real rainfall–stage pairing. The reserved held-out replay is `compound-012`, listed in the manifest's test split.

The BMKG reader deduplicates Kemayoran WMO `96745` *daily* RR, excludes another station, keeps first duplicate with a conflict audit, preserves missing `8888`/`9999` as missing, and records input-file SHA-256. A subset of valid daily totals conditions **only the downstream N5 magnitude** in 20 training episodes; pulse timing/shape, upstream forcing, every five-minute value and all TMA are generated. The daily reporting-date accumulation interval was **not verified**, so episode timestamps are independent of the BMKG dates. No public BMKG forecast is retroactively used as an observed rainfall feature. Source/provenance columns and missingness flags are retained. The raw workbooks are never written by this code.

Conceptual routing uses local storage `S[t+1] = decay*S[t] + 0.85*(rain_rate_mm_h/12)` in mm, 5-minute bins, node-specific baseline stage plus `stage_gain_cm_per_mm*S`, and strictly downstream delayed stages with per-reach attenuation `0.82`. Eight reach delays are `3,4,5,6,7,8,9,10` bins; scenario gain is 7.0–8.7 cm/mm outside stress (stress 5.3–11.7), decay 0.955–0.973 per bin outside stress (stress 0.928–0.982); stage-only uses an explicit local boundary pulse. This is **not** calibrated hydraulics, a physical Katulampa→Manggarai travel-time estimate, nor mapped inundation. Existing demo thresholds are 280 cm flood and 180 cm siaga for N1/N5, not BPBD gauge datums; UP1 has no flood threshold.

Each causal example reads the latest **96** observed/generated past bins through and including issue time (`[batch,96,4]`: target TMA cm, target rain mm/h, upstream TMA cm, upstream rain mm/h) and predicts the **next 12** TMA samples. +30 is future sample 6, +60 future sample 12; crossing is *any* predicted trajectory sample at/above 280 cm within the horizon, unless already above at issue time. The final 12 bins, pre-existing flooding and incomplete past/future windows are masked. Scaling and target-delta scale are computed from capped **train episodes only**, never validation/test/stress. Missing rain is not replaced with zero. The worker requires a contiguous, exactly 5-minute input history ending at `issuedAt`; cold, invalid, stale, unmapped and absent-model paths return reason codes. Wall-clock freshness and replay run fencing belong to the server integration, not this offline worker.

The deployment method is chosen solely by **lowest capped-validation +60-minute stage MAE** among LSTM, persistence and bounded recent-slope baselines; the `.keras` artifacts are still persisted for both nodes even if a baseline wins. The worker returns the selected method's **12 absolute TMA values**, not a probability or confidence score. The server must compute +30/+60 level and crossing from the same response, keep present TMA separate, and label `synthetic_demo` explicitly.

See `reports/synthetic_v1.md` for actual measured-on-synthetic metrics and caveats. Positive-window counts/false-alarm rates use overlapping windows, not independent flood events. Calibration on real paired gauge/rainfall events and a prospective chronological holdout are prerequisites for operational claims.
