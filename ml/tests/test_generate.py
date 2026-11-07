import json

from simba_forecast.generate import generate_episode, write_dataset
from simba_forecast.schema import NODE_IDS, STEPS_PER_DAY


def test_episode_is_seeded_complete_and_never_calls_daily_rr_5min_truth():
    daily = {'date': '2025-01-10', 'rr_mm': 32.0, 'quality': 'observed_daily',
             'station_id': '96745', 'source_file': 'fixture.xlsx', 'source_row': 9}
    first = generate_episode('local_intense-000', 37, 'local_intense', 'train', daily)
    second = generate_episode('local_intense-000', 37, 'local_intense', 'train', daily)
    assert first == second
    assert first != generate_episode('local_intense-000', 38, 'local_intense', 'train', daily)
    assert first['stepSeconds'] == 300 and len(first['frames']) == STEPS_PER_DAY
    assert [x['id'] for x in first['nodes']] == list(NODE_IDS)
    assert [x['id'] for x in first['frames'][0]['nodes']] == list(NODE_IDS)
    n5 = [next(n for n in f['nodes'] if n['id'] == 'N5') for f in first['frames']]
    assert abs(sum(n['rainMm5m'] for n in n5) - 32) < 0.001
    assert all(abs(n['rainMm5m'] - n['rainRateMmH'] / 12) < 1e-6 for n in n5)
    assert all(n['rainSource'] == 'synthetic_conditioned_on_daily_rr' for n in n5)
    assert all(n['tmaSource'] == 'synthetic' for n in n5)
    assert all(f['simTimeSeconds'] == i * 300 for i, f in enumerate(first['frames']))
    assert first['conditioningDailyRR']['source_file'] == 'fixture.xlsx'


def test_upstream_delayed_flood_and_dry_recession_families_are_distinct():
    flood = generate_episode('upstream_delayed-000', 4, 'upstream_delayed', 'test')
    dry = generate_episode('dry-000', 4, 'dry', 'test')
    recede = generate_episode('receding-000', 4, 'receding', 'test')
    node = lambda episode, frame, id: next(n for n in episode['frames'][frame]['nodes'] if n['id'] == id)
    assert max(node(flood, i, 'N1')['tmaCm'] for i in range(288)) >= 280
    assert max(node(dry, i, 'N1')['tmaCm'] for i in range(288)) < 280
    assert node(recede, 1, 'N5')['tmaCm'] > node(recede, 250, 'N5')['tmaCm']


def test_stress_sensor_outage_has_missing_windows_but_keeps_evaluable_pre_outage():
    from simba_forecast.windows import make_window
    ep = generate_episode('dry-014', 4, 'dry', 'stress')
    assert make_window(ep, 'N1', 180) is not None
    assert make_window(ep, 'N1', 230) is None
    assert any(n['sensorQuality'] == 'synthetic_missing' for f in ep['frames']
               for n in f['nodes'] if n['id'] == 'N1')


def test_small_dataset_manifest_and_csv_include_sources_and_disjoint_splits(tmp_path):
    result = write_dataset(tmp_path / 'generated', None, seed=83, per_family=16)
    manifest = json.loads((result / 'manifest.json').read_text())
    assert manifest['episode_count'] == 128
    assert all(len(manifest['splits'][split]) > 0 for split in ('train', 'validation', 'test', 'stress'))
    assert len(set(sum(manifest['splits'].values(), []))) == 128
    assert len(list((result / 'episodes').glob('*.json'))) == 128
    with (result / 'timeseries.csv').open(encoding='utf8') as handle:
        assert 'synthetic' in handle.read(5000)
    assert (result / 'targets.csv').exists()
    assert 'trajectory_cm' in (result / 'targets.csv').open(encoding='utf8').readline()
    assert manifest['bmkg']['status'] == 'not_provided'
