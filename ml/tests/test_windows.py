from copy import deepcopy

import numpy as np

from simba_forecast.generate import generate_episode
from simba_forecast.windows import make_window, target_for_issue, write_targets


def test_causal_96_step_history_and_exact_sixth_and_twelfth_future_targets(tmp_path):
    ep = generate_episode('compound-012', 400, 'compound', 'test')
    issue = 120
    for delta, future in ((6, 301.0), (12, 401.0)):
        node = next(n for n in ep['frames'][issue + delta]['nodes'] if n['id'] == 'N1')
        node['tmaCm'] = future
    window = make_window(ep, 'N1', issue)
    target = target_for_issue(ep, 'N1', issue)
    assert len(window) == 96 and len(target['trajectory_cm']) == 12
    assert window[-1]['timestampUtc'] == ep['frames'][issue]['timestampUtc']
    assert window[0]['timestampUtc'] == ep['frames'][issue - 95]['timestampUtc']
    assert target['tma_t30_cm'] == 301 and target['tma_t60_cm'] == 401
    assert target['cross30'] is True and target['cross60'] is True
    altered = deepcopy(ep)
    altered['frames'][issue + 1]['nodes'][4]['rainRateMmH'] = 99999
    assert make_window(altered, 'N1', issue) == window  # no future rain or TMA


def test_rejects_incomplete_or_missing_history_and_masks_final_horizon():
    ep = generate_episode('dry-012', 17, 'dry', 'test')
    assert make_window(ep, 'N1', 94) is None
    assert target_for_issue(ep, 'N1', 286)['eligible'] is False
    ep['frames'][100]['nodes'][4]['sensorQuality'] = 'synthetic_missing'
    assert make_window(ep, 'N1', 105) is None
    assert target_for_issue(ep, 'N1', 98)['eligible'] is False


def test_prewarn_crossing_excludes_existing_flood_and_target_table_is_independent(tmp_path):
    ep = generate_episode('stage_only-012', 129, 'stage_only', 'test')
    node = next(n for n in ep['frames'][150]['nodes'] if n['id'] == 'N1')
    node['tmaCm'] = 300
    target = target_for_issue(ep, 'N1', 150)
    assert target['already_above_threshold'] is True
    assert target['eligible'] is False
    write_targets([ep], tmp_path / 'targets.csv')
    text = (tmp_path / 'targets.csv').read_text()
    assert 'stage_only-012' in text and 'trajectory_cm' in text
