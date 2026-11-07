"""Held-out, window-denominated metrics; no claimed field accuracy."""
import numpy as np


def score_sequences(actual, predicted, current, *, threshold_cm, episode_count):
    y = np.asarray(actual, dtype=np.float64)
    p = np.asarray(predicted, dtype=np.float64)
    c = np.asarray(current, dtype=np.float64)
    if (y.ndim != 2 or y.shape[1] != 12 or y.shape != p.shape
            or c.shape != (y.shape[0],) or not np.isfinite(y).all()
            or not np.isfinite(p).all() or not np.isfinite(c).all()
            or (threshold_cm is not None and (c >= threshold_cm).any()) or episode_count <= 0):
        raise ValueError('12-step finite eligible future trajectories required')
    result = {}
    for minutes, bins in ((30, 6), (60, 12)):
        errors = y[:, bins - 1] - p[:, bins - 1]
        if threshold_cm is None:
            result[str(minutes)] = {
                'samples': len(y), 'episodes': episode_count,
                'positive_windows': None,
                'mae_cm': float(np.mean(np.abs(errors))) if len(y) else None,
                'rmse_cm': float(np.sqrt(np.mean(errors ** 2))) if len(y) else None,
                'confusion': None, 'precision': None, 'recall': None, 'f1': None,
                'false_alarm_windows_per_simulated_day': None,
                'median_useful_lead_minutes': None,
                'lead_time_definition': None,
                'denominator_note': 'no defined flood threshold; regression only',
            }
            continue
        positive = (y[:, :bins] >= threshold_cm).any(axis=1)
        alarm = (p[:, :bins] >= threshold_cm).any(axis=1)
        tp = int((positive & alarm).sum())
        fp = int((~positive & alarm).sum())
        fn = int((positive & ~alarm).sum())
        tn = int((~positive & ~alarm).sum())
        precision = tp / (tp + fp) if tp + fp else None
        recall = tp / (tp + fn) if tp + fn else None
        f1 = (2 * tp / (2 * tp + fp + fn)
              if tp + fp and tp + fn else None)
        useful = [float((np.argmax(y[k, :bins] >= threshold_cm) + 1) * 5)
                  for k in np.flatnonzero(positive & alarm)]
        result[str(minutes)] = {
            'samples': len(y), 'episodes': episode_count,
            'positive_windows': int(positive.sum()),
            'mae_cm': float(np.mean(np.abs(errors))) if len(y) else None,
            'rmse_cm': float(np.sqrt(np.mean(errors ** 2))) if len(y) else None,
            'confusion': {'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn},
            'precision': precision, 'recall': recall, 'f1': f1,
            'false_alarm_windows_per_simulated_day': fp / episode_count,
            'median_useful_lead_minutes': float(np.median(useful)) if useful else None,
            'lead_time_definition': 'actual issue-to-first-crossing for correctly alerted windows',
            'denominator_note': 'overlapping issue windows, not independent flood events'
        }
    return result
