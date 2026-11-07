# Synthetic v1 held-out evaluation

**Synthetic-data LSTM demonstration; not validated for operational flood warning.** These are scores on generated 24-hour episodes with conceptual, uncalibrated routing, **not** observations of actual Ciliwung floods. Unrounded machine-readable measurements, 30/60-minute precision/recall/F1, confusion matrices, median useful lead time and per-family cohorts are in [`synthetic_v1.json`](synthetic_v1.json).

## Data/provenance

- Seed `20261010`; 128 independent 288-bin, nine-node episodes; 331,776 time-series rows, 73,728 target rows. Episode split: 80 train / 16 validation / 16 test / 16 shifted stress; no ID overlaps. The held-out replay is `compound-012` in test.
- Kemayoran workbook audit: 17 `.xlsx` inputs, one South Sulawesi file excluded; 426 Kemayoran date rows, 424 distinct dates, two duplicated dates, 22 missing-code rows, 218 **deduplicated** rainy valid days. The raw workbooks' hashes are recorded; **20 train episodes** use a valid *daily* RR magnitude as a constraint on an invented N5 pulse. There are no measured five-minute rain or TMA rows in this dataset. The reporting-date accumulation interval is unverified.
- 96 past five-minute steps → 12 future TMA samples. +30/+60 correspond to steps 6/12. Exclude pre-existing floods and windows with inadequate horizon or missing sensor-quality flags. Flood threshold for N1/N5 is the demo's 280 cm, not a measured BPBD gauge datum. Missing RR is not treated as zero.
- The 5-epoch cap ran all 5 epochs for both 32-unit LSTMs, with 1,440 sampled training windows and 192 sampled validation windows **per node**. Early stopping monitors capped validation. The held-out test and stress scores below use all eligible windows; train-only scaler/target scale is saved per node.

## Actual metrics

MAE/RMSE are **cm at the exact horizon**, not an average over the trajectory. F1 is from *any threshold crossing within that horizon*. `—` means undefined because a baseline issued no positive alerts; do not read it as high skill. `CM60` is `TP/FP/FN/TN`; +30 confusion and both horizons' precision/recall/false alarms/median lead are in JSON. All alert denominators are **overlapping issue windows**, not independent flood episodes. False alarms/day divides false-alarm windows by 16 episodes for a full holdout, not by distinct warning events.

| Node | Split | Method | Windows | +30 MAE/RMSE | +30 F1 | +60 MAE/RMSE | +60 F1 | CM60 (TP/FP/FN/TN) | +60 false-alarm windows/day |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| N1 | validation | LSTM | 192 | 7.911 / 17.067 | .848 | 17.397 / 38.174 | .870 | 30/0/9/153 | 0 |
| N1 | validation | persistence | 192 | 24.066 / 53.111 | — | 49.307 / 110.492 | — | 0/0/39/153 | 0 |
| N1 | validation | slope | 192 | 12.601 / 30.416 | .759 | 29.577 / 72.113 | .762 | 24/0/15/153 | 0 |
| N1 | test | LSTM | 2679 | 4.139 / 9.264 | .868 | 9.911 / 22.573 | .853 | 61/10/11/2597 | .625 |
| N1 | test | persistence | 2679 | 6.502 / 20.852 | — | 13.312 / 43.729 | — | 0/0/72/2607 | 0 |
| N1 | test | slope | 2679 | 2.975 / 10.539 | .857 | 7.995 / 27.622 | .800 | 48/0/24/2607 | 0 |
| N1 | stress | LSTM | 2459 | 4.349 / 10.474 | .810 | 9.570 / 23.456 | .776 | 66/32/6/2355 | 2.000 |
| N1 | stress | persistence | 2459 | 6.078 / 16.372 | — | 11.322 / 31.952 | — | 0/0/72/2387 | 0 |
| N1 | stress | slope | 2459 | 3.110 / 5.725 | .958 | 6.962 / 15.395 | .892 | 58/0/14/2387 | 0 |
| N5 | validation | LSTM | 192 | 10.592 / 22.512 | .833 | 24.977 / 54.813 | .678 | 20/1/18/153 | .0625 |
| N5 | validation | persistence | 192 | 16.682 / 34.014 | — | 29.998 / 61.618 | — | 0/0/38/154 | 0 |
| N5 | validation | slope | 192 | 5.304 / 12.405 | .850 | 12.887 / 28.186 | .917 | 33/1/5/153 | .0625 |
| N5 | test | LSTM | 2658 | 5.664 / 12.572 | .584 | 11.951 / 29.255 | .522 | 36/30/36/2556 | 1.875 |
| N5 | test | persistence | 2658 | 7.905 / 18.054 | — | 15.569 / 35.333 | — | 0/0/72/2586 | 0 |
| N5 | test | slope | 2658 | 2.943 / 6.945 | .912 | 8.002 / 18.823 | .822 | 60/14/12/2572 | .875 |
| N5 | stress | LSTM | 2473 | 5.030 / 9.633 | .778 | 10.233 / 22.136 | .661 | 36/13/24/2400 | .8125 |
| N5 | stress | persistence | 2473 | 7.502 / 15.171 | — | 14.200 / 29.661 | — | 0/0/60/2413 | 0 |
| N5 | stress | slope | 2473 | 3.206 / 4.898 | .983 | 7.173 / 12.811 | .867 | 52/8/8/2405 | .500 |

**Validation-only demo selection:** `N1 → lstm_synthetic_v1`; `N5 → slope_synthetic_v1`. The selection objective was lowest **+60 validation MAE**, not test or stress performance. In particular, the N1 LSTM **loses to the slope baseline on held-out test and stress +60 MAE** and has more stress false-alarm windows. N5 LSTM likewise loses to slope on both holdouts. Do not market either as a demonstrated AI improvement; the `.keras` files remain experimental comparisons, and N5 worker dispatch uses the slope baseline.

Limitations: train/test/stress share the same *generator architecture* even though episodes, seeds and parameter ranges differ; storm physics and sensor noise are invented. Synthetic metric precision/recall and lead time cannot estimate real-world reliability. The median lead definition is issue-to-first-*actual synthetic* crossing for correctly alerted overlapping windows, not a unique-event lead-time distribution. Before an operational warning claim, obtain calibrated station datums/thresholds and genuinely paired five-minute rainfall/TMA observations across floods and non-floods; evaluate on chronologically unseen real events with outage, false-alarm and lead-time audits, and review access/security.
