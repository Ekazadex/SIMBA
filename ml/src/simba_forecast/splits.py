"""Frozen episode group splits and strictly training-only transformations."""
import numpy as np
from .schema import FEATURES, finite


def validate_splits(splits):
    if set(splits) != {'train', 'validation', 'test', 'stress'}:
        raise ValueError('all four frozen episode partitions required')
    all_ids = [eid for group in splits.values() for eid in group]
    if any(not values for values in splits.values()) or len(set(all_ids)) != len(all_ids):
        raise ValueError('empty or overlapping episode split')
    return True


def features_from_history(history):
    return np.asarray([[finite(row.get(name), name, 0 if 'Rain' in name or 'rain' in name else 0)
                        for name in FEATURES] for row in history], dtype=np.float32)


def fit_train_scaler(train_features):
    x = np.asarray(train_features, dtype=np.float64)
    if x.ndim != 3 or x.shape[-1] != len(FEATURES) or not np.isfinite(x).all():
        raise ValueError('nonempty [sample,time,feature] training tensor required')
    flattened = x.reshape(-1, len(FEATURES))
    means = flattened.mean(axis=0)
    stds = flattened.std(axis=0)
    return {'feature_order': list(FEATURES), 'mean': means.tolist(),
            'std': np.maximum(stds, 1e-6).tolist(), 'fit_partition': 'train'}


def apply_scaler(x, scaler):
    if scaler['feature_order'] != list(FEATURES) or scaler['fit_partition'] != 'train':
        raise ValueError('model/scaler schema mismatch')
    return ((np.asarray(x, dtype=np.float32) - np.asarray(scaler['mean'], dtype=np.float32))
            / np.asarray(scaler['std'], dtype=np.float32)).astype(np.float32)
