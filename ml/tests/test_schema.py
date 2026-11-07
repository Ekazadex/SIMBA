import math
from datetime import datetime

import pytest

from simba_forecast.schema import NODES, validate_frame, parse_utc


def test_registry_matches_authoritative_demo_baselines_without_invented_up1_flood_cutoff():
    assert list(NODES) == ['UP1', 'UP2', 'UP3', 'UP4', 'N1', 'N2', 'N3', 'N4', 'N5']
    assert [NODES[x]['baseline_cm'] for x in NODES] == [40, 60, 100, 150, 60, 60, 60, 60, 60]
    assert NODES['UP1']['banjir_cm'] is None
    assert NODES['N1']['banjir_cm'] == NODES['N5']['banjir_cm'] == 280


def test_schema_rejects_nonfinite_and_wrong_units_in_rain_frame():
    frame = {'id': 'N1', 'tmaCm': 130.0, 'rainRateMmH': 24.0, 'rainMm5m': 2.0,
             'rainSource': 'synthetic', 'tmaSource': 'synthetic'}
    validate_frame(frame)
    with pytest.raises(ValueError):
        validate_frame({**frame, 'rainMm5m': 24.0})
    with pytest.raises(ValueError):
        validate_frame({**frame, 'tmaCm': math.nan})
    with pytest.raises(ValueError):
        validate_frame({**frame, 'id': 'X'})
    with pytest.raises(ValueError):
        validate_frame({**frame, 'rainRateMmH': None})


def test_timestamp_must_be_utc_instant_not_naive_or_future_issued_context():
    assert parse_utc('2026-01-01T00:00:00Z') == datetime.fromisoformat('2026-01-01T00:00:00+00:00')
    with pytest.raises(ValueError):
        parse_utc('2026-01-01T00:00:00')
