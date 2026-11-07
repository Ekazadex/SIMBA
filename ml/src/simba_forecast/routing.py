"""Conceptual delayed/storage-based stage generator; not calibrated hydraulics."""
from __future__ import annotations

import numpy as np
from .schema import NODE_IDS, NODES

# Bin delays correspond to 15,20,25,30,35,40,45,50 min per reach.
# The existing 500-ms display/demo engine has *different* delays.
REACH_DELAYS_STEPS = (3, 4, 5, 6, 7, 8, 9, 10)
REACH_ATTENUATION = 0.82
CAPTURE_FRACTION = 0.85


def route_levels(rain_rate_mm_h, *, stage_gain_cm_per_mm=8.0,
                 decay_per_bin=0.963, boundary_cm=None, initial_storage_mm=None):
    """S[t+1] = decay*S[t]+capture*(rate/12); stage = baseline+gain*S.

    Source stages move only from upstream nodes to downstream nodes with
    cumulative reach delay and reach-by-reach attenuation. All time in bins.
    """
    if not 0 < decay_per_bin < 1 or stage_gain_cm_per_mm <= 0:
        raise ValueError('invalid storage or gain coefficient')
    if set(rain_rate_mm_h) != set(NODE_IDS):
        raise ValueError('nine named catchments required')
    count = len(rain_rate_mm_h[NODE_IDS[0]])
    storage = {}
    for node in NODE_IDS:
        rates = np.asarray(rain_rate_mm_h[node], dtype=np.float64)
        if len(rates) != count or not np.isfinite(rates).all() or (rates < 0).any():
            raise ValueError('aligned nonnegative finite rainfall required')
        s = float((initial_storage_mm or {}).get(node, 0))
        if not np.isfinite(s) or s < 0:
            raise ValueError('initial storage must be nonnegative')
        local = np.empty(count, dtype=np.float64)
        for t, rate in enumerate(rates):
            s = decay_per_bin * s + CAPTURE_FRACTION * rate / 12.0
            local[t] = stage_gain_cm_per_mm * s
        storage[node] = local
    levels = {}
    for dest_idx, node in enumerate(NODE_IDS):
        level = np.full(count, NODES[node]['baseline_cm'], dtype=np.float64)
        for source_idx in range(dest_idx + 1):
            lag = sum(REACH_DELAYS_STEPS[source_idx:dest_idx])
            attenuation = REACH_ATTENUATION ** (dest_idx - source_idx)
            if lag == 0:
                level += storage[NODE_IDS[source_idx]] * attenuation
            elif lag < count:
                level[lag:] += storage[NODE_IDS[source_idx]][:-lag] * attenuation
        if boundary_cm and node in boundary_cm:
            effect = np.asarray(boundary_cm[node], dtype=np.float64)
            if len(effect) != count or not np.isfinite(effect).all():
                raise ValueError('boundary must be aligned and finite')
            level += effect
        levels[node] = np.maximum(0, level)
    return levels
