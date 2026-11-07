"""Independent artifact oracle catches inconsistent score denominators and tampering."""
import copy
import numpy as np
import pytest

from simba_forecast.evaluate import score_sequences
from simba_forecast.verify import validate_score, verify_pipeline, verify_wib_timestamp


def test_wib_timestamp_check_uses_same_instant_not_utc_label():
    verify_wib_timestamp('2026-06-01T07:00:00+07:00', '2026-06-01T00:00:00Z')
    with pytest.raises(AssertionError):
        verify_wib_timestamp('2026-06-01T07:05:00+07:00', '2026-06-01T00:00:00Z')
    with pytest.raises(AssertionError):
        verify_wib_timestamp('2026-06-01T00:00:00+00:00', '2026-06-01T00:00:00Z')


def test_pipeline_oracle_rejects_missing_artifacts(tmp_path):
    with pytest.raises(FileNotFoundError, match='config|dataset|report|artifact'):
        verify_pipeline(tmp_path / 'missing.json')


def test_score_oracle_checks_30_60_denominators_and_confusion():
    actual = np.array([[100] * 5 + [300] * 7, [100] * 12], dtype=float)
    predicted = np.array([[100] * 5 + [310] * 7, [100] * 12], dtype=float)
    score = score_sequences(actual, predicted, np.array([90., 90.]),
                            threshold_cm=280, episode_count=1)
    validate_score(score, samples=2, episode_count=1)
    bad = copy.deepcopy(score)
    bad['30']['confusion']['tp'] = 0
    with pytest.raises(AssertionError, match='confusion|positive'):
        validate_score(bad, samples=2, episode_count=1)
    bad = copy.deepcopy(score)
    bad['60']['mae_cm'] = float('nan')
    with pytest.raises(AssertionError, match='mae'):
        validate_score(bad, samples=2, episode_count=1)
