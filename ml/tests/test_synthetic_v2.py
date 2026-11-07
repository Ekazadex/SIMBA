"""Nine-node synthetic_v2 contract tests (no real-world flood claims)."""
import csv
import json
from copy import deepcopy

import numpy as np

from simba_forecast.evaluate import score_sequences
from simba_forecast.verify import validate_score
from simba_forecast.generate import generate_episode
from simba_forecast.schema import NODE_IDS, UPSTREAM
from simba_forecast.windows import make_window, target_for_issue, write_targets

def test_v2_config_and_generator_write_versioned_nine_node_data(tmp_path):
    from simba_forecast.config import load_config
    from simba_forecast.generate import write_dataset
    (tmp_path / 'daily').mkdir()
    config_path = tmp_path / 'synthetic_v2.json'
    config_path.write_text(json.dumps({
        'dataset_version': 'synthetic_v2', 'seed': 37, 'per_family': 16,
        'raw_directory': 'daily', 'dataset_dir': 'data/synthetic_v2',
        'models_dir': 'models/synthetic_v2', 'report_path': 'reports/synthetic_v2.json',
        'max_epochs': 1, 'train_cap': 5, 'validation_cap': 3,
    }))
    cfg = load_config(config_path)
    # The fixture has no workbooks; exercise synthetic-only mode. The real CLI
    # run below uses and audits the read-only BMKG source from the v2 config.
    write_dataset(cfg['dataset_dir'], None, seed=cfg['seed'],
                  per_family=cfg['per_family'], version=cfg['dataset_version'])
    manifest = json.loads((cfg['dataset_dir'] / 'manifest.json').read_text())
    assert manifest['dataset_version'] == 'synthetic_v2'
    assert manifest['generator_version'] == 'synthetic_v2'
    assert manifest['upstream_feature_node'] == UPSTREAM
    assert manifest['up1_upstream_feature_source'] == 'topology_self_proxy_no_upstream'
    assert {split: len(ids) for split, ids in manifest['splits'].items()} == {
        'train': 80, 'validation': 16, 'test': 16, 'stress': 16}
    assert manifest['held_out_demo_episode_id'] in manifest['splits']['test']
    with (cfg['dataset_dir'] / 'targets.csv').open(newline='', encoding='utf-8') as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 128 * 288 * 9
    assert {row['node_id'] for row in rows} == set(NODE_IDS)
    assert all(row['cross60'] == '' for row in rows if row['node_id'] == 'UP1')
    episode = json.loads((cfg['dataset_dir'] / 'episodes/compound-012.json').read_text())
    assert episode['version'] == 'synthetic_v2'
    assert all(len(frame['nodes']) == 9 for frame in episode['frames'])
    assert {row['dataset_version'] for row in csv.DictReader(
        (cfg['dataset_dir'] / 'timeseries.csv').open(newline='', encoding='utf-8'))} == {'synthetic_v2'}
    assert {row['generator_version'] for row in csv.DictReader(
        (cfg['dataset_dir'] / 'timeseries.csv').open(newline='', encoding='utf-8'))} == {'synthetic_v2'}


def test_topology_and_nine_causal_target_rows_with_thresholdless_up1(tmp_path):
    assert UPSTREAM == dict(zip(NODE_IDS, NODE_IDS[:1] + NODE_IDS[:-1]))
    episode = generate_episode('compound-012', 401, 'compound', 'test', version='synthetic_v2')
    issue = 120
    for node in NODE_IDS:
        window = make_window(episode, node, issue)
        assert len(window) == 96
        assert window[0]['timestampUtc'] == episode['frames'][issue - 95]['timestampUtc']
        assert window[-1]['timestampUtc'] == episode['frames'][issue]['timestampUtc']
        upstream = UPSTREAM[node]
        assert window[-1]['upstreamTmaCm'] == next(n['tmaCm'] for n in episode['frames'][issue]['nodes'] if n['id'] == upstream)
        if node == 'UP1':
            assert window[-1]['upstreamFeatureSource'] == 'topology_self_proxy_no_upstream'
    up1 = target_for_issue(episode, 'UP1', issue)
    assert up1['eligible'] and len(up1['trajectory_cm']) == 12
    assert up1['cross30'] is up1['cross60'] is None
    assert up1['already_above_threshold'] is False
    altered = deepcopy(episode)
    altered['frames'][issue + 1]['nodes'][0]['tmaCm'] = 12345
    assert make_window(altered, 'UP1', issue) == make_window(episode, 'UP1', issue)
    write_targets([episode], tmp_path / 'targets.csv')
    with (tmp_path / 'targets.csv').open(newline='', encoding='utf-8') as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 288 * 9
    assert {row['node_id'] for row in rows} == set(NODE_IDS)
    assert rows[issue]['node_id'] == 'UP1' and rows[issue]['cross60'] == ''


def test_thresholdless_up1_has_regression_errors_but_no_alert_classification():
    actual = np.array([[100.] * 12, [300.] * 12])
    pred = np.array([[105.] * 12, [295.] * 12])
    score = score_sequences(actual, pred, np.array([100., 300.]),
                            threshold_cm=None, episode_count=1)
    validate_score(score, samples=2, episode_count=1, threshold_cm=None)
    for horizon in ('30', '60'):
        assert score[horizon]['mae_cm'] == 5.
        assert score[horizon]['rmse_cm'] == 5.
        assert score[horizon]['samples'] == 2
        assert all(score[horizon][key] is None for key in (
            'positive_windows', 'confusion', 'precision', 'recall', 'f1',
            'false_alarm_windows_per_simulated_day', 'median_useful_lead_minutes'))


def test_v2_training_fits_nine_independent_models_and_selects_on_validation(tmp_path):
    import hashlib
    import tensorflow as tf
    from simba_forecast.train import train_models

    data = tmp_path / 'data'
    (data / 'episodes').mkdir(parents=True)
    splits = {'train': ['compound-000', 'upstream_delayed-000'],
              'validation': ['compound-010'], 'test': ['compound-012'],
              'stress': ['upstream_delayed-014']}
    episodes = []
    for idx, (split, ids) in enumerate(splits.items()):
        for eid in ids:
            ep = generate_episode(eid, 101 + idx, eid.rsplit('-', 1)[0],
                                  split, version='synthetic_v2')
            (data / 'episodes' / f'{eid}.json').write_text(json.dumps(ep))
            episodes.append(ep)
    write_targets(episodes, data / 'targets.csv')
    (data / 'manifest.json').write_text(json.dumps({
        'dataset_version': 'synthetic_v2', 'splits': splits,
    }))
    models = tmp_path / 'models'
    report = train_models(data, models, tmp_path / 'report.json', seed=7,
                          max_epochs=1, train_cap=3, validation_cap=2)
    assert set(report['nodes']) == set(NODE_IDS)
    assert report['dataset_version'] == 'synthetic_v2'
    assert (tmp_path / 'report.md').is_file()
    assert all(f'| {node} | test |' in (tmp_path / 'report.md').read_text() for node in NODE_IDS)
    for node in NODE_IDS:
        path = models / f'{node}.keras'
        meta = json.loads((models / f'{node}.json').read_text())
        assert tf.keras.models.load_model(path, compile=False).output_shape[-1] == 12
        assert meta['model_sha256'] == hashlib.sha256(path.read_bytes()).hexdigest()
        assert meta['node_id'] == node and meta['dataset_version'] == 'synthetic_v2'
        assert meta['threshold_banjir_cm'] == (None if node == 'UP1' else 280)
        assert meta['fit_partition'] == 'train'
        scores = report['nodes'][node]
        best = min(('persistence', 'slope', 'lstm'),
                   key=lambda method: scores['validation'][method]['60']['mae_cm'])
        assert scores['selected_demo_method'] == meta['selected_demo_method'] == f'{best}_synthetic_v2'
        assert scores['test'][best]['60']['samples'] > 0
        assert scores['stress'][best]['60']['samples'] > 0
        if node == 'UP1':
            assert scores['test'][best]['60']['confusion'] is None


def test_v2_worker_requires_complete_valid_nine_model_bundle_and_null_up1_crossing(tmp_path):
    import hashlib
    import shutil
    from datetime import datetime, timedelta, timezone
    from simba_forecast.predict_worker import PredictionWorker
    from simba_forecast.schema import FEATURES
    from simba_forecast.train import build_model

    models = tmp_path / 'synthetic_v2'
    models.mkdir()
    build_model(units=4).save(models / 'UP1.keras')
    for node in NODE_IDS:
        if node != 'UP1':
            shutil.copyfile(models / 'UP1.keras', models / f'{node}.keras')
        path = models / f'{node}.keras'
        (models / f'{node}.json').write_text(json.dumps({
            'dataset_version': 'synthetic_v2', 'model_version': f'synthetic_v2_{node}',
            'node_id': node, 'threshold_banjir_cm': None if node == 'UP1' else 280,
            'input_steps': 96, 'output_steps': 12, 'step_seconds': 300,
            'feature_order': list(FEATURES), 'fit_partition': 'train',
            'mean': [100., 0., 100., 0.], 'std': [1., 1., 1., 1.],
            'target_delta_scale_cm': 1., 'selected_demo_method': 'persistence_synthetic_v2',
            'model_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        }))
    first = datetime(2026, 6, 1, tzinfo=timezone.utc)
    history = [{'timestampUtc': (first + timedelta(minutes=5 * i)).isoformat().replace('+00:00', 'Z'),
                'tmaCm': 300., 'rainRateMmH': 0., 'upstreamTmaCm': 300.,
                'upstreamRainRateMmH': 0.} for i in range(96)]
    worker = PredictionWorker(models)
    assert worker.available_models == list(NODE_IDS)
    for node in NODE_IDS:
        response = worker.handle_request({'requestId': node, 'runId': 'replay',
            'nodeId': node, 'issuedAt': history[-1]['timestampUtc'], 'history': history})
        assert response['nodeId'] == node and response['modelVersion'] == f'synthetic_v2_{node}'
        assert response['method'] == 'persistence_synthetic_v2'
        assert response['levelsCm'] == [300.] * 12
        assert response['thresholdBanjirCm'] == (None if node == 'UP1' else 280)
        assert response['crossing'] is (None if node == 'UP1' else True)
    del worker
    original = (models / 'UP2.json').read_text()
    tampered = json.loads(original)
    tampered['model_sha256'] = '0' * 64
    (models / 'UP2.json').write_text(json.dumps(tampered))
    assert PredictionWorker(models).available_models == []
    (models / 'UP2.json').write_text(original)
    (models / 'N5.json').unlink()
    incomplete = PredictionWorker(models)
    assert incomplete.available_models == []
    assert incomplete.handle_request({'requestId': 'r', 'runId': 'replay',
        'nodeId': 'UP1', 'issuedAt': history[-1]['timestampUtc'],
        'history': history})['error'] == 'model_unavailable'


def test_v2_readable_report_is_derived_from_all_nine_scored_nodes():
    from simba_forecast.reporting import render_report
    nodes = {}
    for node in NODE_IDS:
        threshold = None if node == 'UP1' else 280
        measured = score_sequences(np.array([[101.] * 12]), np.array([[100.] * 12]),
                                   np.array([100.]), threshold_cm=threshold, episode_count=1)
        nodes[node] = {'threshold_banjir_cm': threshold,
                       'selected_demo_method': 'persistence_synthetic_v2',
                       'samples': {'train': 2, 'validation': 1, 'test': 1, 'stress': 1},
                       'validation': {'persistence': measured, 'slope': measured, 'lstm': measured},
                       'test': {'persistence': measured, 'slope': measured, 'lstm': measured},
                       'stress': {'persistence': measured, 'slope': measured, 'lstm': measured}}
    report = {'dataset_version': 'synthetic_v2', 'seed': 37,
              'split_episode_counts': {'train': 80, 'validation': 16, 'test': 16, 'stress': 16},
              'nodes': nodes}
    manifest = {'episode_count': 128, 'conditioned_episodes': 20,
                'held_out_demo_episode_id': 'compound-012'}
    text = render_report(report, manifest)
    assert all(f'| {node} | test |' in text for node in NODE_IDS)
    assert 'UP1' in text and 'no defined flood threshold' in text
    assert 'self-proxy' in text and 'not validated for operational flood warning' in text
    assert 'BMKG' in text and 'not measured five-minute' in text
    assert '1.000' in text and 'persistence_synthetic_v2' in text
