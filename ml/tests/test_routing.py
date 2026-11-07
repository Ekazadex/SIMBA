import numpy as np

from simba_forecast.routing import route_levels, REACH_DELAYS_STEPS
from simba_forecast.schema import NODE_IDS, NODES


def test_downstream_only_route_has_explicit_lag_and_no_instantaneous_jump():
    rain = {node: np.zeros(100) for node in NODE_IDS}
    rain['UP1'][5] = 60  # mm/h; 5 mm in this bin
    levels = route_levels(rain, stage_gain_cm_per_mm=10, decay_per_bin=0.97)
    lag = sum(REACH_DELAYS_STEPS)
    assert lag >= 24  # >= two simulated hours UP1 -> N5
    assert all(levels['N5'][:5 + lag] == NODES['N5']['baseline_cm'])
    assert levels['N5'][5 + lag] > NODES['N5']['baseline_cm']
    assert levels['N1'][5] == NODES['N1']['baseline_cm']


def test_downstream_local_rain_cannot_affect_upstream_and_recedes_after_event():
    rain = {node: np.zeros(90) for node in NODE_IDS}
    rain['N5'][5:9] = 80
    levels = route_levels(rain, stage_gain_cm_per_mm=10, decay_per_bin=0.90)
    assert all(levels['N1'] == NODES['N1']['baseline_cm'])
    assert levels['N5'][15] > levels['N5'][40] > levels['N5'][80] >= 60


def test_stage_only_boundary_effect_is_independent_of_rain():
    rain = {node: np.zeros(40) for node in NODE_IDS}
    boundary = {'N1': np.zeros(40)}
    boundary['N1'][9] = 230
    levels = route_levels(rain, boundary_cm=boundary)
    assert levels['N1'][9] == 290
    assert levels['N1'][8] == 60
    assert levels['N5'][9] == 60  # boundary is local, not instantaneous
