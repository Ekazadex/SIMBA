import numpy as np
import pytest

from simba_forecast.splits import validate_splits, fit_train_scaler, features_from_history


def test_split_ids_are_event_disjoint_and_reject_overlap():
    splits = {'train': ['a'], 'validation': ['b'], 'test': ['c'], 'stress': ['d']}
    validate_splits(splits)
    splits['test'].append('a')
    with pytest.raises(ValueError, match='overlap'):
        validate_splits(splits)


def test_scaler_is_fit_only_on_supplied_train_features_not_validation_outliers():
    train = np.array([[[10., 2., 30., 3.]], [[30., 4., 50., 5.]]])
    validation = np.array([[[900000., 0., 900000., 0.]]])
    scaler = fit_train_scaler(train)
    assert scaler['mean'] == [20., 3., 40., 4.]
    assert np.allclose(scaler['std'], [10., 1., 10., 1.])
    assert abs((validation[0, 0, 0] - scaler['mean'][0]) / scaler['std'][0]) > 100


def test_history_features_have_named_order_and_reject_missing_as_zero():
    history = [{'tmaCm': 10, 'rainRateMmH': 0,
                'upstreamTmaCm': 20, 'upstreamRainRateMmH': 3}]
    assert features_from_history(history).tolist() == [[10., 0., 20., 3.]]
    history[0]['rainRateMmH'] = None
    with pytest.raises(ValueError):
        features_from_history(history)
