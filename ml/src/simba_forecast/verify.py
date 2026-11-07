"""Independent integrity checks for produced synthetic-only pipeline artifacts."""
import math
import csv
import hashlib
import json
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from .baselines import persistence, recent_slope
from .bmkg_daily import load_daily_rr
from .config import load_config
from .evaluate import score_sequences
from .generate import FAMILIES, VERSION
from .schema import FEATURES, HISTORY_STEPS, HORIZON_STEPS, NODE_IDS, NODES, STEP_SECONDS, STEPS_PER_DAY, parse_utc
from .splits import fit_train_scaler, validate_splits
from .train import collect_examples, predict_levels
from .windows import make_window, target_for_issue


def verify_wib_timestamp(wib, utc):
    """WIB must denote the same instant and retain its +07:00 display offset."""
    local = datetime.fromisoformat(wib)
    assert local.utcoffset() == timedelta(hours=7), 'not Asia/Jakarta offset'
    assert local == parse_utc(utc), 'WIB and UTC instant differ'


def validate_score(score, *, samples, episode_count, threshold_cm=280):
    """Reject inconsistent horizon counts/confusion and nonfinite scores."""
    assert episode_count > 0
    for minutes in ('30', '60'):
        part = score[minutes]
        assert part['samples'] == samples and part['episodes'] == episode_count, 'sample denominator mismatch'
        if threshold_cm is None:
            for key in ('positive_windows', 'confusion', 'precision', 'recall', 'f1',
                        'false_alarm_windows_per_simulated_day', 'median_useful_lead_minutes',
                        'lead_time_definition'):
                assert part[key] is None, f'undefined threshold: {key}'
            for name in ('mae_cm', 'rmse_cm'):
                value = part[name]
                assert (value is None if samples == 0 else isinstance(value, (int, float))
                        and math.isfinite(value) and value >= 0), name
            continue
        confusion = part['confusion']
        tp, fp, fn, tn = (confusion[k] for k in ('tp', 'fp', 'fn', 'tn'))
        assert all(type(n) is int and n >= 0 for n in (tp, fp, fn, tn)), 'invalid confusion'
        assert tp + fp + fn + tn == samples, 'confusion total mismatch'
        assert tp + fn == part['positive_windows'], 'positive count mismatch'
        expected = {'precision': tp / (tp + fp) if tp + fp else None,
                    'recall': tp / (tp + fn) if tp + fn else None,
                    'f1': (2 * tp / (2 * tp + fp + fn) if tp + fp and tp + fn else None),
                    'false_alarm_windows_per_simulated_day': fp / episode_count}
        for key, target in expected.items():
            actual = part[key]
            assert actual == target if target is None else (isinstance(actual, (int, float))
                    and math.isfinite(actual) and math.isclose(actual, target, abs_tol=1e-10)), key
        for name in ('mae_cm', 'rmse_cm'):
            value = part[name]
            assert (value is None if samples == 0 else
                    isinstance(value, (int, float)) and math.isfinite(value) and value >= 0), name


def verify_pipeline(config_path):
    """Read back every generated row, saved target, trained model and held-out score.

    This checks artifacts and internal consistency, not hydrological realism.
    """
    config_path = Path(config_path)
    if not config_path.is_file():
        raise FileNotFoundError(f'config missing: {config_path}')
    cfg = load_config(config_path)
    import tensorflow as tf
    data, models = cfg['dataset_dir'], cfg['models_dir']
    manifest_bytes = (data / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    report = json.loads(cfg['report_path'].read_text(encoding='utf-8'))
    assert manifest['dataset_version'] == report['dataset_version'] == cfg['dataset_version']
    version = cfg['dataset_version']
    assert version in (VERSION, 'synthetic_v2')
    assert manifest['seed'] == report['seed'] == cfg['seed']
    assert manifest['steps_per_episode'] == STEPS_PER_DAY
    assert manifest['step_seconds'] == STEP_SECONDS
    assert manifest['node_ids'] == list(NODE_IDS)
    assert manifest['node_registry'] == NODES
    if version == 'synthetic_v2':
        from .schema import UPSTREAM
        assert manifest['upstream_feature_node'] == UPSTREAM
        assert manifest['up1_upstream_feature_source'] == 'topology_self_proxy_no_upstream'
    assert manifest['episode_count'] == len(FAMILIES) * cfg['per_family'] >= 100
    assert validate_splits(manifest['splits'])
    ids = [eid for group in manifest['splits'].values() for eid in group]
    items = manifest['episodes']
    assert len(items) == len(ids) and set(ids) == {v['episode_id'] for v in items}
    assert set(manifest['splits']['stress']).isdisjoint(manifest['splits']['train'])
    assert manifest['held_out_demo_episode_id'] in manifest['splits']['test']
    assert report['split_episode_ids'] == manifest['splits']
    assert report['split_episode_counts'] == {k: len(v) for k, v in manifest['splits'].items()}
    assert report['dataset_manifest_sha256'] == hashlib.sha256(manifest_bytes).hexdigest()
    assert 'no measured flood accuracy' in report['scope']

    # Read-only raw provenance check: hashes compare with generation-time records.
    source_hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(cfg['raw_directory'].glob('*.xlsx'))}
    assert len(source_hashes) >= 16 and source_hashes == manifest['bmkg']['source_sha256']
    _, raw_audit = load_daily_rr(cfg['raw_directory'])
    for key in ('excluded_station_files', 'date_rows', 'duplicate_date_rows',
                'missing_code_rows', 'distinct_dates', 'rainy_valid_days', 'conflicts'):
        assert manifest['bmkg'][key] == raw_audit[key], key
    assert manifest['conditioned_episodes'] > 0

    episode_cache = {}
    conditioned = 0
    # CSV writer uses manifest order, frame order, then node order. Check all rows.
    with (data / 'timeseries.csv').open(newline='', encoding='utf-8') as handle:
        rows = iter(csv.DictReader(handle))
        for item in items:
            eid = item['episode_id']
            episode = json.loads((data / 'episodes' / f'{eid}.json').read_text(encoding='utf-8'))
            episode_cache[eid] = episode
            assert episode['episodeId'] == eid and episode['seed'] == item['seed']
            assert episode['family'] == item['family'] and episode['split'] == item['split']
            assert eid in manifest['splits'][item['split']]
            assert episode['stepSeconds'] == STEP_SECONDS and len(episode['frames']) == STEPS_PER_DAY
            daily = episode['conditioningDailyRR']
            if daily:
                conditioned += 1
                assert item['split'] == 'train' and item['family'] in ('local_intense', 'compound')
                assert daily['station_id'] == '96745' and daily['quality'] == 'observed_daily'
                assert daily['rr_mm'] is not None and 3 < daily['rr_mm'] <= 100
                assert daily['source_file'] in source_hashes
            prev = None
            for i, frame in enumerate(episode['frames']):
                instant = parse_utc(frame['timestampUtc'])
                assert frame['simTimeSeconds'] == i * STEP_SECONDS
                if prev is not None:
                    assert (instant - prev).total_seconds() == STEP_SECONDS
                prev = instant
                assert [node['id'] for node in frame['nodes']] == list(NODE_IDS)
                for node in frame['nodes']:
                    row = next(rows)
                    nid = node['id']
                    assert row['episode_id'] == eid and row['split'] == item['split']
                    assert row['dataset_version'] == version and row['generator_version'] == version
                    assert row['seed'] == str(item['seed']) and row['scenario_family'] == item['family']
                    assert row['node_id'] == nid and row['catchment_id'] == nid
                    assert row['timestamp_utc'] == frame['timestampUtc']
                    verify_wib_timestamp(row['timestamp_wib'], frame['timestampUtc'])
                    assert row['sim_time_seconds'] == str(i * STEP_SECONDS)
                    assert float(row['tma_cm']) == node['tmaCm'] >= 0
                    assert float(row['rain_rate_mm_h']) == node['rainRateMmH'] >= 0
                    assert float(row['rain_mm_5m']) == node['rainMm5m']
                    assert abs(node['rainMm5m'] - node['rainRateMmH'] / 12) <= 1e-6
                    assert row['rain_source'] == node['rainSource'] in (
                        'synthetic', 'synthetic_conditioned_on_daily_rr')
                    assert row['tma_source'] == node['tmaSource'] == 'synthetic'
                    assert row['sensor_quality'] == node['sensorQuality'] in (
                        'synthetic_complete', 'synthetic_missing')
                    banjir = NODES[nid]['banjir_cm']
                    assert row['threshold_banjir_cm'] == ('' if banjir is None else str(banjir))
                    assert float(row['threshold_siaga_cm']) == NODES[nid]['siaga_cm']
                    assert all(row[field] == '' for field in (
                        'forecast_provider', 'forecast_issue_time', 'forecast_valid_from',
                        'forecast_valid_to', 'forecast_weather_desc', 'forecast_quality'))
                    if daily and nid == 'N5':
                        assert row['bmkg_station_id'] == '96745'
                        assert float(row['bmkg_rr_daily_mm']) == daily['rr_mm']
                        assert row['bmkg_rr_observed_date'] == daily['date']
                        assert row['bmkg_source_file'] == daily['source_file']
                        assert node['rainSource'] == 'synthetic_conditioned_on_daily_rr'
                    else:
                        assert all(row[field] == '' for field in (
                            'bmkg_station_id', 'bmkg_rr_daily_mm', 'bmkg_rr_observed_date'))
        assert next(rows, None) is None, 'trailing time-series row'
    assert conditioned == manifest['conditioned_episodes']

    eligible, positives, masked = Counter(), Counter(), Counter()
    with (data / 'targets.csv').open(newline='', encoding='utf-8') as handle:
        targets = iter(csv.DictReader(handle))
        for item in items:
            episode = episode_cache[item['episode_id']]
            for node in ('N1', 'N5') if version == 'synthetic_v1' else NODE_IDS:
                for issue in range(STEPS_PER_DAY):
                    expected = target_for_issue(episode, node, issue)
                    row = next(targets)
                    assert row['episode_id'] == item['episode_id']
                    assert row['node_id'] == node and int(row['issue_index']) == issue
                    assert row['split'] == item['split'] and row['issued_at'] == expected['issued_at']
                    assert float(row['current_tma_cm']) == expected['current_tma_cm']
                    assert row['eligible'] == str(expected['eligible'])
                    assert row['already_above_threshold'] == str(expected['already_above_threshold'])
                    assert row['mask_reason'] == expected['mask_reason']
                    if expected['eligible']:
                        if node == 'UP1' and version == 'synthetic_v2':
                            assert row['cross30'] == row['cross60'] == ''
                            assert row['trajectory_cm'] != ''
                            eligible[(item['split'], node)] += 1
                            continue
                        assert json.loads(row['trajectory_cm']) == expected['trajectory_cm']
                        assert float(row['tma_t30_cm']) == expected['trajectory_cm'][5]
                        assert float(row['tma_t60_cm']) == expected['trajectory_cm'][11]
                        assert row['cross30'] == str(expected['cross30'])
                        assert row['cross60'] == str(expected['cross60'])
                        eligible[(item['split'], node)] += 1
                        positives[(item['split'], node, '30')] += expected['cross30']
                        positives[(item['split'], node, '60')] += expected['cross60']
                    else:
                        masked[expected['mask_reason']] += 1
                        assert row['trajectory_cm'] == '' and row['cross60'] == ''
        assert next(targets, None) is None, 'trailing target row'
    for split in manifest['splits']:
        for node in ('N1', 'N5'):
            assert 0 < positives[(split, node, '30')] <= positives[(split, node, '60')]
            assert positives[(split, node, '60')] < eligible[(split, node)]
    assert masked['no_full_future_horizon'] > 0 and masked['missing_past_sensor'] > 0

    # Recompute every reported held-out score with deserialized models/data.
    version_nodes = NODE_IDS if version == 'synthetic_v2' else ('N1', 'N5')
    assert set(report['nodes']) == set(version_nodes)
    for node in version_nodes:
        path = models / f'{node}.keras'
        meta = json.loads((models / f'{node}.json').read_text(encoding='utf-8'))
        assert meta['node_id'] == node and meta['dataset_version'] == version
        assert meta['feature_order'] == list(FEATURES) and meta['fit_partition'] == 'train'
        assert meta['input_steps'] == HISTORY_STEPS and meta['output_steps'] == HORIZON_STEPS
        assert meta['step_seconds'] == STEP_SECONDS
        assert meta['threshold_banjir_cm'] == NODES[node]['banjir_cm']
        assert meta['dataset_manifest_sha256'] == report['dataset_manifest_sha256']
        assert meta['model_sha256'] == hashlib.sha256(path.read_bytes()).hexdigest()
        assert meta['quality'] == 'experimental_synthetic_only'
        model = tf.keras.models.load_model(path, compile=False)
        assert model.output_shape[-1] == HORIZON_STEPS
        xtrain, ytrain, current_train, _ = collect_examples(
            data, manifest, node, 'train', max_per_episode=cfg['train_cap'])
        scaler = fit_train_scaler(xtrain)
        assert np.allclose(meta['mean'], scaler['mean'], atol=1e-8)
        assert np.allclose(meta['std'], scaler['std'], atol=1e-8)
        assert np.isclose(meta['target_delta_scale_cm'],
                          max(float(np.std(ytrain - current_train[:, None])), 1.0), atol=1e-6)
        observed = report['nodes'][node]
        assert observed['samples']['train'] == len(xtrain)
        assert 1 <= observed['epochs_run'] <= cfg['max_epochs']
        for split in ('validation', 'test', 'stress'):
            x, y, current, info = collect_examples(
                data, manifest, node, split,
                max_per_episode=cfg['validation_cap'] if split == 'validation' else None)
            assert observed['samples'][split] == len(y)
            if split in ('test', 'stress'):
                assert len(y) == eligible[(split, node)]
            predicted = {'lstm': predict_levels(model, meta, x, current),
                         'persistence': np.asarray([persistence(row[:, 0]) for row in x]),
                         'slope': np.asarray([recent_slope(row[:, 0]) for row in x])}
            for method, levels in predicted.items():
                actual = score_sequences(y, levels, current,
                                         threshold_cm=NODES[node]['banjir_cm'],
                                         episode_count=len(manifest['splits'][split]))
                saved = observed[split][method]
                validate_score(saved, samples=len(y), episode_count=len(manifest['splits'][split]),
                               threshold_cm=NODES[node]['banjir_cm'])
                for horizon in ('30', '60'):
                    for key in ('samples', 'episodes', 'positive_windows', 'confusion'):
                        assert saved[horizon][key] == actual[horizon][key], (node, split, method, horizon, key)
                    if NODES[node]['banjir_cm'] is not None:
                        assert saved[horizon]['positive_windows'] == (
                            positives[(split, node, horizon)] if split != 'validation'
                            else actual[horizon]['positive_windows'])
                    else:
                        assert saved[horizon]['positive_windows'] is None
                        assert saved[horizon]['confusion'] is None
                    for key in ('mae_cm', 'rmse_cm', 'precision', 'recall', 'f1',
                                'false_alarm_windows_per_simulated_day', 'median_useful_lead_minutes'):
                        lhs, rhs = saved[horizon][key], actual[horizon][key]
                        assert (lhs is None and rhs is None) or (
                            lhs is not None and rhs is not None and
                            np.isclose(lhs, rhs, rtol=1e-5, atol=1e-3)), (node, split, method, horizon, key)
            if split in ('test', 'stress'):
                for family in FAMILIES:
                    mask = np.array([row['family'] == family for row in info], dtype=bool)
                    cohort = observed['cohorts'][split][family]
                    cohort_episodes = sum(eid.startswith(family + '-')
                                          for eid in manifest['splits'][split])
                    assert cohort_episodes > 0 and cohort['episode_count'] == cohort_episodes
                    assert cohort['eligible_windows'] == int(mask.sum())
                    for method, levels in predicted.items():
                        expected_cohort = score_sequences(y[mask], levels[mask], current[mask],
                                                          threshold_cm=NODES[node]['banjir_cm'],
                                                          episode_count=cohort_episodes)
                        saved_cohort = cohort['metrics'][method]
                        validate_score(saved_cohort, samples=int(mask.sum()),
                                       episode_count=cohort_episodes,
                                       threshold_cm=NODES[node]['banjir_cm'])
                        for horizon in ('30', '60'):
                            for key in ('positive_windows', 'confusion'):
                                assert saved_cohort[horizon][key] == expected_cohort[horizon][key]
                            for key in ('mae_cm', 'rmse_cm', 'precision', 'recall', 'f1',
                                        'false_alarm_windows_per_simulated_day', 'median_useful_lead_minutes'):
                                lhs, rhs = saved_cohort[horizon][key], expected_cohort[horizon][key]
                                assert (lhs is None and rhs is None) or (
                                    lhs is not None and rhs is not None and
                                    np.isclose(lhs, rhs, rtol=1e-5, atol=1e-3)), (
                                        node, split, family, method, horizon, key)
        best = min(('persistence', 'slope', 'lstm'),
                   key=lambda method: observed['validation'][method]['60']['mae_cm'])
        assert meta['selected_demo_method'] == observed['selected_demo_method'] == f'{best}_{version}'
    return {'episodes': len(items), 'timeseries_rows': len(items) * STEPS_PER_DAY * len(NODE_IDS),
            'targets_rows': len(items) * STEPS_PER_DAY * (2 if version == 'synthetic_v1' else len(NODE_IDS)),
            'conditioned': conditioned,
            'eligible': {f'{split}/{node}': count for (split, node), count in eligible.items()},
            'positive_60': {f'{split}/{node}': count for (split, node, horizon), count in positives.items()
                            if horizon == '60'}, 'selected_methods': {
                                node: report['nodes'][node]['selected_demo_method'] for node in version_nodes}}
