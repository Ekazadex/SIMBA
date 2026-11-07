import numpy as np

from simba_forecast.evaluate import score_sequences
from simba_forecast.baselines import persistence, recent_slope


def test_baselines_return_twelve_future_cm_points_and_slope_is_bounded():
    past = np.arange(96, dtype=float) + 100
    assert persistence(past).tolist() == [195.] * 12
    future = recent_slope(past)
    assert len(future) == 12 and future[5] > 195
    assert np.isfinite(future).all()


def test_metrics_have_true_horizon_offsets_confusion_and_null_no_positive():
    actual = np.array([[100] * 5 + [300] * 7,
                       [100] * 12,
                       [100] * 11 + [300],
                       [100] * 12], dtype=float)
    pred = np.array([[100] * 5 + [310] * 7,
                     [100] * 5 + [300] * 7,
                     [100] * 12,
                     [100] * 12], dtype=float)
    result = score_sequences(actual, pred, np.array([90, 90, 90, 90]),
                             threshold_cm=280, episode_count=2)
    assert result['30']['confusion'] == {'tp': 1, 'fp': 1, 'fn': 0, 'tn': 2}
    assert result['60']['confusion'] == {'tp': 1, 'fp': 1, 'fn': 1, 'tn': 1}
    assert result['30']['mae_cm'] == 52.5
    assert result['60']['mae_cm'] == 102.5
    assert result['60']['recall'] == 0.5
    assert result['60']['false_alarm_windows_per_simulated_day'] == 0.5
    assert result['60']['median_useful_lead_minutes'] == 30.0
    dry = score_sequences(np.zeros((2, 12)), np.zeros((2, 12)),
                          np.zeros(2), threshold_cm=280, episode_count=1)
    assert dry['60']['recall'] is None and dry['60']['f1'] is None
