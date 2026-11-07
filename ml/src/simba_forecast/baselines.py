"""Deterministic, non-trained 12-step trajectory baselines."""
import numpy as np
from .schema import HORIZON_STEPS


def persistence(past_tma_cm):
    past = np.asarray(past_tma_cm, dtype=float)
    if len(past) < 1 or not np.isfinite(past).all():
        raise ValueError('valid stage history required')
    return np.repeat(past[-1], HORIZON_STEPS)


def recent_slope(past_tma_cm):
    past = np.asarray(past_tma_cm, dtype=float)
    if len(past) < 7 or not np.isfinite(past).all():
        raise ValueError('seven valid stage bins required')
    # A deliberately simple, bounded short-term rule, not a calibrated flood model.
    slope = float(np.clip((past[-1] - past[-7]) / 6, -12, 12))
    return np.maximum(0, past[-1] + np.arange(1, HORIZON_STEPS + 1) * slope)
