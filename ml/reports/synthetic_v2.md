# Synthetic v2 nine-node held-out evaluation

**Synthetic-data LSTM demonstration; not validated for operational flood warning.** The nine LSTMs are trained independently; the deployed demo method for each node is selected by minimum validation +60-minute TMA MAE among LSTM, persistence, and slope. Selection does not use test or stress outcomes.

- Seed `20261010`; 128 independent 24-hour episodes (80 train, 16 validation, 16 test, 16 shifted stress); held-out replay `compound-012`.
- 20 train episodes condition an invented N5 storm on BMKG observed **daily** RR magnitude. All 5-minute rain and TMA are synthetic, not measured five-minute BMKG inputs; unknown daily rain is never filled with zero.
- Inputs: 96 strictly past five-minute bins × 4 features; targets: next 12 TMA values. UP1 has no upstream gauge: its upstream columns are an explicit **self-proxy**, `UP1` (not an independent measurement). The remaining nodes use the immediately preceding node in topology.
- UP1 has **no defined flood threshold**. Its +30/+60 TMA regression scores exist, but crossing, confusion, F1, and false alarms are undefined/null, not safe/zero. The 280-cm BANJIR thresholds of the other eight nodes are simulator demo values, not calibrated station thresholds.
- +30/+60 MAE and RMSE are centimetres at steps 6 and 12, respectively. Classification uses any predicted/actual threshold crossing up to that horizon; counts are overlapping issue windows, not independent flood events. Full precision, recall, confusion, false-alarm rates and family cohorts are in JSON.

## Validation-selected demo methods

| Node | Threshold | Selected method | Train windows | Test windows | Stress windows |
|---|---:|---|---:|---:|---:|
| UP1 | none | lstm_synthetic_v2 | 1440 | 2896 | 2896 |
| UP2 | 280 | slope_synthetic_v2 | 1440 | 2700 | 2670 |
| UP3 | 280 | lstm_synthetic_v2 | 1440 | 2700 | 2670 |
| UP4 | 280 | lstm_synthetic_v2 | 1440 | 2628 | 2599 |
| N1 | 280 | lstm_synthetic_v2 | 1440 | 2679 | 2459 |
| N2 | 280 | lstm_synthetic_v2 | 1440 | 2742 | 2568 |
| N3 | 280 | lstm_synthetic_v2 | 1440 | 2784 | 2785 |
| N4 | 280 | lstm_synthetic_v2 | 1440 | 2814 | 2855 |
| N5 | 280 | slope_synthetic_v2 | 1440 | 2658 | 2473 |

## All three methods on validation and held-out partitions

| Node | Split | Method | Windows | +30 MAE/RMSE cm | +30 F1 | +60 MAE/RMSE cm | +60 F1 | +60 TP/FP/FN/TN |
|---|---|---|---:|---:|---:|---:|---:|---:|
| UP1 | validation | lstm | 192 | 3.417/15.409 | — | 7.902/39.034 | — | — |
| UP1 | validation | persistence | 192 | 5.061/21.109 | — | 11.753/50.311 | — | — |
| UP1 | validation | slope | 192 | 3.326/15.119 | — | 9.000/40.137 | — | — |
| UP1 | test | lstm | 2896 | 2.479/10.475 | — | 4.342/21.257 | — | — |
| UP1 | test | persistence | 2896 | 4.632/18.699 | — | 8.890/36.105 | — | — |
| UP1 | test | slope | 2896 | 2.448/10.392 | — | 5.771/24.651 | — | — |
| UP1 | stress | lstm | 2896 | 3.676/12.371 | — | 5.616/21.887 | — | — |
| UP1 | stress | persistence | 2896 | 5.135/14.983 | — | 9.360/29.388 | — | — |
| UP1 | stress | slope | 2896 | 2.807/5.827 | — | 5.929/15.506 | — | — |
| UP2 | validation | lstm | 192 | 6.545/18.800 | 0.833 | 29.195/84.101 | 0.864 | 19/0/6/167 |
| UP2 | validation | persistence | 192 | 20.190/56.160 | — | 43.495/119.682 | — | 0/0/25/167 |
| UP2 | validation | slope | 192 | 12.226/37.379 | 0.667 | 28.452/86.428 | 0.718 | 14/0/11/167 |
| UP2 | test | lstm | 2700 | 1.639/5.804 | 0.898 | 6.709/26.615 | 0.835 | 38/5/10/2647 |
| UP2 | test | persistence | 2700 | 4.725/19.007 | — | 10.247/42.107 | — | 0/0/48/2652 |
| UP2 | test | slope | 2700 | 2.402/11.086 | 0.703 | 6.398/28.345 | 0.737 | 28/0/20/2652 |
| UP2 | stress | lstm | 2670 | 2.068/4.683 | 0.842 | 4.442/10.957 | 0.873 | 48/14/0/2608 |
| UP2 | stress | persistence | 2670 | 4.656/13.737 | — | 8.801/28.648 | — | 0/0/48/2622 |
| UP2 | stress | slope | 2670 | 2.780/5.402 | 0.870 | 5.851/13.830 | 0.899 | 40/1/8/2621 |
| UP3 | validation | lstm | 192 | 10.200/28.357 | 0.696 | 25.134/71.142 | 0.880 | 22/0/6/164 |
| UP3 | validation | persistence | 192 | 18.563/50.205 | — | 40.997/109.863 | — | 0/0/28/164 |
| UP3 | validation | slope | 192 | 11.087/32.278 | 0.636 | 27.056/77.764 | 0.667 | 14/0/14/164 |
| UP3 | test | lstm | 2700 | 2.863/7.237 | 0.780 | 5.925/19.206 | 0.826 | 38/6/10/2646 |
| UP3 | test | persistence | 2700 | 3.910/15.580 | — | 8.422/34.524 | — | 0/0/48/2652 |
| UP3 | test | slope | 2700 | 1.979/8.418 | 0.800 | 5.211/22.198 | 0.737 | 28/0/20/2652 |
| UP3 | stress | lstm | 2670 | 2.963/5.997 | 0.800 | 5.332/12.682 | 0.762 | 48/30/0/2592 |
| UP3 | stress | persistence | 2670 | 3.933/11.241 | — | 7.281/23.433 | — | 0/0/48/2622 |
| UP3 | stress | slope | 2670 | 2.564/4.377 | 0.917 | 5.183/11.141 | 0.889 | 40/2/8/2620 |
| UP4 | validation | lstm | 192 | 6.821/13.367 | 0.786 | 21.387/45.591 | 0.756 | 17/2/9/164 |
| UP4 | validation | persistence | 192 | 14.635/41.620 | — | 37.409/98.884 | — | 0/0/26/166 |
| UP4 | validation | slope | 192 | 9.709/26.981 | 0.667 | 27.887/72.743 | 0.556 | 10/0/16/166 |
| UP4 | test | lstm | 2628 | 3.249/4.923 | 0.800 | 8.381/16.284 | 0.769 | 35/8/13/2572 |
| UP4 | test | persistence | 2628 | 3.145/14.041 | — | 7.227/33.443 | — | 0/0/48/2580 |
| UP4 | test | slope | 2628 | 1.797/8.331 | 0.737 | 4.993/23.551 | 0.609 | 21/0/27/2580 |
| UP4 | stress | lstm | 2599 | 3.320/5.193 | 0.754 | 7.288/10.621 | 0.870 | 47/13/1/2538 |
| UP4 | stress | persistence | 2599 | 3.098/9.903 | — | 5.914/21.780 | — | 0/0/48/2551 |
| UP4 | stress | slope | 2599 | 2.425/4.494 | 0.857 | 4.833/11.662 | 0.785 | 31/0/17/2551 |
| N1 | validation | lstm | 192 | 9.811/19.150 | 0.875 | 18.645/40.435 | 0.870 | 30/0/9/153 |
| N1 | validation | persistence | 192 | 24.066/53.111 | — | 49.307/110.492 | — | 0/0/39/153 |
| N1 | validation | slope | 192 | 12.601/30.416 | 0.759 | 29.577/72.113 | 0.762 | 24/0/15/153 |
| N1 | test | lstm | 2679 | 6.877/14.725 | 0.810 | 9.956/25.036 | 0.832 | 62/15/10/2592 |
| N1 | test | persistence | 2679 | 6.502/20.852 | — | 13.312/43.729 | — | 0/0/72/2607 |
| N1 | test | slope | 2679 | 2.975/10.539 | 0.857 | 7.995/27.622 | 0.800 | 48/0/24/2607 |
| N1 | stress | lstm | 2459 | 6.124/13.696 | 0.785 | 8.529/22.635 | 0.753 | 58/24/14/2363 |
| N1 | stress | persistence | 2459 | 6.078/16.372 | — | 11.322/31.952 | — | 0/0/72/2387 |
| N1 | stress | slope | 2459 | 3.110/5.725 | 0.958 | 6.962/15.395 | 0.892 | 58/0/14/2387 |
| N2 | validation | lstm | 192 | 5.966/15.059 | 0.833 | 13.655/37.537 | 0.837 | 18/0/7/167 |
| N2 | validation | persistence | 192 | 16.665/42.678 | — | 34.083/86.585 | — | 0/0/25/167 |
| N2 | validation | slope | 192 | 8.477/22.331 | 0.600 | 19.081/51.699 | 0.718 | 14/0/11/167 |
| N2 | test | lstm | 2742 | 2.717/7.195 | 0.826 | 4.022/14.418 | 0.851 | 37/2/11/2692 |
| N2 | test | persistence | 2742 | 4.315/16.191 | — | 8.877/34.103 | — | 0/0/48/2694 |
| N2 | test | slope | 2742 | 1.914/7.894 | 0.800 | 4.979/20.630 | 0.800 | 32/0/16/2694 |
| N2 | stress | lstm | 2568 | 2.710/5.681 | 0.698 | 3.957/10.499 | 0.707 | 29/5/19/2515 |
| N2 | stress | persistence | 2568 | 3.991/11.314 | — | 7.353/22.794 | — | 0/0/48/2520 |
| N2 | stress | slope | 2568 | 2.383/3.835 | 0.939 | 4.699/9.554 | 0.946 | 44/1/4/2519 |
| N3 | validation | lstm | 192 | 3.117/8.225 | 0.929 | 9.881/26.128 | 0.864 | 19/0/6/167 |
| N3 | validation | persistence | 192 | 13.842/36.103 | — | 25.869/68.646 | — | 0/0/25/167 |
| N3 | validation | slope | 192 | 5.906/16.290 | 0.762 | 13.340/37.510 | 0.810 | 17/0/8/167 |
| N3 | test | lstm | 2784 | 1.275/3.718 | 0.857 | 3.811/12.242 | 0.738 | 31/17/5/2731 |
| N3 | test | persistence | 2784 | 4.109/14.602 | — | 8.276/29.909 | — | 0/0/36/2748 |
| N3 | test | slope | 2784 | 1.853/7.012 | 0.636 | 4.810/18.256 | 0.658 | 26/17/10/2731 |
| N3 | stress | lstm | 2785 | 2.608/7.321 | 0.222 | 3.865/10.877 | 0.400 | 12/0/36/2737 |
| N3 | stress | persistence | 2785 | 3.858/10.204 | — | 6.930/20.048 | — | 0/0/48/2737 |
| N3 | stress | slope | 2785 | 2.298/3.521 | 0.939 | 4.493/8.482 | 0.931 | 47/6/1/2731 |
| N4 | validation | lstm | 192 | 2.045/5.984 | 0.947 | 5.972/17.011 | 0.824 | 14/1/5/172 |
| N4 | validation | persistence | 192 | 11.497/30.047 | — | 20.444/54.270 | — | 0/0/19/173 |
| N4 | validation | slope | 192 | 4.301/11.790 | 0.889 | 9.472/26.213 | 0.727 | 12/2/7/171 |
| N4 | test | lstm | 2814 | 1.593/4.548 | 0.865 | 3.643/10.968 | 0.861 | 31/5/5/2773 |
| N4 | test | persistence | 2814 | 4.766/13.510 | — | 9.401/27.039 | — | 0/0/36/2778 |
| N4 | test | slope | 2814 | 2.115/6.206 | 0.833 | 5.617/16.680 | 0.744 | 29/13/7/2765 |
| N4 | stress | lstm | 2855 | 2.524/5.108 | 0.889 | 3.522/7.948 | 0.909 | 20/0/4/2831 |
| N4 | stress | persistence | 2855 | 4.672/9.975 | — | 8.506/19.393 | — | 0/0/24/2831 |
| N4 | stress | slope | 2855 | 2.554/3.793 | 0.667 | 5.328/9.428 | 0.608 | 24/31/0/2800 |
| N5 | validation | lstm | 192 | 8.074/18.813 | 0.800 | 20.891/44.600 | 0.655 | 19/1/19/153 |
| N5 | validation | persistence | 192 | 16.682/34.014 | — | 29.998/61.618 | — | 0/0/38/154 |
| N5 | validation | slope | 192 | 5.304/12.405 | 0.850 | 12.887/28.186 | 0.917 | 33/1/5/153 |
| N5 | test | lstm | 2658 | 4.911/12.254 | 0.676 | 13.315/29.199 | 0.524 | 33/21/39/2565 |
| N5 | test | persistence | 2658 | 7.905/18.054 | — | 15.569/35.333 | — | 0/0/72/2586 |
| N5 | test | slope | 2658 | 2.943/6.945 | 0.912 | 8.002/18.823 | 0.822 | 60/14/12/2572 |
| N5 | stress | lstm | 2473 | 4.917/10.910 | 0.758 | 11.484/23.812 | 0.615 | 32/12/28/2401 |
| N5 | stress | persistence | 2473 | 7.502/15.171 | — | 14.200/29.661 | — | 0/0/60/2413 |
| N5 | stress | slope | 2473 | 3.206/4.898 | 0.983 | 7.173/12.811 | 0.867 | 52/8/8/2405 |

## Limits

Episodes have independent seeds and disjoint splits but share one uncalibrated generator architecture. Stress alters simulated storm shape, gain, decay, noise and sensor availability, not real-world hydraulic conditions. Zero or undefined F1/precision must not be interpreted as verified flood-warning skill. Before operational claims: acquire real paired gauge/rainfall observations, station-calibrated thresholds and prospective chronological holdouts.
