"""Independent 24-hour, nine-node *synthetic* scenarios, optionally conditioned on daily RR."""
from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

import numpy as np

from .bmkg_daily import load_daily_rr
from .routing import CAPTURE_FRACTION, REACH_ATTENUATION, REACH_DELAYS_STEPS, route_levels
from .schema import NODE_IDS, NODES, STEPS_PER_DAY, STEP_SECONDS, UPSTREAM

VERSION = 'synthetic_v1'
FAMILIES = ('dry', 'light', 'local_intense', 'upstream_delayed',
            'compound', 'receding', 'false_positive', 'stage_only')
WIB = timezone(timedelta(hours=7))
CSV_FIELDS = ('dataset_version', 'generator_version', 'seed', 'episode_id',
              'run_id', 'scenario_family', 'split', 'timestamp_utc',
              'timestamp_wib', 'sim_time_seconds', 'node_id', 'catchment_id',
              'station_role', 'rain_rate_mm_h', 'rain_mm_5m', 'rain_source',
              'tma_cm', 'tma_source', 'sensor_quality', 'threshold_siaga_cm',
              'threshold_banjir_cm', 'current_status', 'bmkg_station_id',
              'bmkg_rr_daily_mm', 'bmkg_rr_observed_date', 'bmkg_rr_quality',
              'bmkg_source_file', 'bmkg_source_row', 'forecast_provider',
              'forecast_issue_time', 'forecast_valid_from', 'forecast_valid_to',
              'forecast_weather_desc', 'forecast_quality')


def _pulse(rng, onset, length, total_mm, *, two_peaks=False):
    """Synthesized within-day pulse: distributed depth mm -> 5-min rate mm/h."""
    x = np.arange(STEPS_PER_DAY)
    width = max(3, length / 4)
    shape = np.exp(-0.5 * ((x - onset - length * 0.45) / width) ** 2)
    if two_peaks:
        shape += 0.85 * np.exp(-0.5 * ((x - onset - length * 0.85) / max(2, width * 0.6)) ** 2)
    # Restrict pulse to a finite dry-gap interval. Only this shape is synthetic.
    shape[(x < onset) | (x >= onset + length + 10)] = 0
    shape *= rng.uniform(0.95, 1.05)  # seeded event variation
    return shape * (12 * total_mm / shape.sum()) if shape.sum() else np.zeros_like(shape)


def generate_episode(episode_id, seed, family, regime, daily_record=None, index=0,
                     *, version=VERSION):
    if family not in FAMILIES or regime not in ('train', 'validation', 'test', 'stress'):
        raise ValueError('unknown family or split')
    if daily_record is not None and (daily_record.get('rr_mm') is None or daily_record['rr_mm'] < 0):
        raise ValueError('missing daily rainfall may not be replaced with zero')
    rng = np.random.default_rng(seed)
    onset = int(rng.integers(112, 172)) if regime != 'stress' else int(rng.integers(95, 190))
    length = int(rng.integers(30, 52)) if regime != 'stress' else int(rng.integers(48, 77))
    two_peaks = regime == 'stress' or bool(seed % 5 == 0)
    gain = float(rng.uniform(7.0, 8.7)) if regime != 'stress' else float(rng.uniform(5.3, 11.7))
    decay = float(rng.uniform(0.955, 0.973)) if regime != 'stress' else float(rng.uniform(0.928, 0.982))
    noise = 0.22 if regime != 'stress' else 0.9
    rain = {node: np.zeros(STEPS_PER_DAY, dtype=float) for node in NODE_IDS}

    def storm(node, mm, time=onset):
        rain[node] += _pulse(rng, time, length, float(mm), two_peaks=two_peaks)

    if family == 'light':
        storm('UP1', rng.uniform(5, 11))
        storm('N5', rng.uniform(5, 10), onset + 18)
    elif family == 'local_intense':
        storm('N5', daily_record['rr_mm'] if daily_record else rng.uniform(65, 110))
        storm('N4', rng.uniform(28, 46), onset + 12)
    elif family == 'upstream_delayed':
        storm('UP1', rng.uniform(100, 148))
        storm('UP2', rng.uniform(65, 86), onset + 6)
    elif family == 'compound':
        storm('UP2', rng.uniform(85, 118))
        storm('UP4', rng.uniform(54, 85), onset + 8)
        storm('N1', rng.uniform(26, 51), onset + 10)
        storm('N5', daily_record['rr_mm'] if daily_record else rng.uniform(49, 80), onset + 14)
    elif family == 'false_positive':
        gain = float(rng.uniform(0.7, 1.5))
        storm('N5', rng.uniform(28, 60))
    initial = {}
    if family == 'receding':
        initial = {'UP4': float(rng.uniform(28, 42)),
                   'N5': float(rng.uniform(39, 53))}
    boundary = None
    if family == 'stage_only':
        x = np.arange(STEPS_PER_DAY)
        boundary = {'N1': 260 * np.exp(-0.5 * ((x - onset) / 13) ** 2),
                    'N5': 250 * np.exp(-0.5 * ((x - onset - 7) / 16) ** 2)}
    levels = route_levels(rain, stage_gain_cm_per_mm=gain,
                          decay_per_bin=decay, initial_storage_mm=initial,
                          boundary_cm=boundary)
    for node in NODE_IDS:
        levels[node] = np.maximum(0, levels[node] + rng.normal(0, noise, STEPS_PER_DAY))
    # An episode's clock is synthetic and is deliberately NOT the BMKG reporting date.
    start = datetime(2026, 6, 1, tzinfo=timezone.utc) + timedelta(days=index)
    frames = []
    for t in range(STEPS_PER_DAY):
        nodes = []
        for node in NODE_IDS:
            depth = round(float(rain[node][t] / 12), 7)
            rate = round(float(rain[node][t]), 7)
            cm = round(float(levels[node][t]), 4)
            quality = ('synthetic_missing' if regime == 'stress' and node in ('N1', 'N5')
                       and seed % 4 == 0 and 226 <= t < 229 else 'synthetic_complete')
            nodes.append({'id': node, 'tmaCm': cm, 'rainRateMmH': rate,
                          'rainMm5m': depth,
                          'rainSource': ('synthetic_conditioned_on_daily_rr'
                                         if node == 'N5' and daily_record else 'synthetic'),
                          'tmaSource': 'synthetic', 'sensorQuality': quality})
        timestamp = start + timedelta(seconds=t * STEP_SECONDS)
        frames.append({'simTimeSeconds': t * STEP_SECONDS,
                       'timestampUtc': timestamp.isoformat().replace('+00:00', 'Z'),
                       'nodes': nodes})
    return {'episodeId': episode_id, 'version': version, 'seed': int(seed),
            'stepSeconds': STEP_SECONDS, 'startTimeUtc': frames[0]['timestampUtc'],
            'family': family, 'split': regime,
            'nodes': [{'id': n, 'baselineTmaCm': NODES[n]['baseline_cm'],
                       'thresholdSiagaCm': NODES[n]['siaga_cm'],
                       'thresholdBanjirCm': NODES[n]['banjir_cm']} for n in NODE_IDS],
            'parameters': {'stage_gain_cm_per_mm': round(gain, 6),
                           'drainage_decay_per_bin': round(decay, 6),
                           'capture_fraction': CAPTURE_FRACTION,
                           'reach_delays_bins': REACH_DELAYS_STEPS,
                           'reach_attenuation_per_reach': REACH_ATTENUATION,
                           'noise_std_cm': noise, 'two_peaks': two_peaks,
                           'initial_storage_mm': initial,
                           'boundary_effect': 'local Gaussian stage rise, not rainfall' if boundary else None},
            'conditioningDailyRR': daily_record, 'frames': frames}


def write_dataset(output, raw_directory=None, *, seed=20261010, per_family=16, version=VERSION):
    if version not in (VERSION, 'synthetic_v2'):
        raise ValueError('unsupported synthetic dataset version')
    if per_family < 16:
        raise ValueError('per_family >=16 required for frozen split with test and stress')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    episodes_dir = output / 'episodes'
    episodes_dir.mkdir(exist_ok=True)
    records, audit = load_daily_rr(raw_directory) if raw_directory else ([], {'status': 'not_provided'})
    rainy = [r for r in records if r['rr_mm'] is not None and 3 < r['rr_mm'] <= 100]
    files = ({p.name: hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(Path(raw_directory).glob('*.xlsx'))} if raw_directory else {})
    bmkg = dict(audit)
    bmkg['source_sha256'] = files
    bmkg['conditioning_policy'] = ('Daily RR magnitude only for downstream N5; invented within-day pulse/date '
                                  'alignment, never measured 5-minute rain; unavailable values excluded')
    bmkg['source_interpretation'] = 'BMKG daily RR observed; reporting-date accumulation interval unverified'
    splits = {'train': [], 'validation': [], 'test': [], 'stress': []}
    summary = []
    conditioned_count = 0
    with (output / 'timeseries.csv').open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for family_idx, family in enumerate(FAMILIES):
            for j in range(per_family):
                regime = ('train' if j < per_family - 6 else 'validation'
                          if j < per_family - 4 else 'test'
                          if j < per_family - 2 else 'stress')
                episode_id = f'{family}-{j:03d}'
                episode_seed = int(seed + family_idx * 100003 + j * 1009)
                daily = None
                if rainy and regime == 'train' and family in ('local_intense', 'compound'):
                    daily = rainy[conditioned_count % len(rainy)]
                    conditioned_count += 1
                episode = generate_episode(episode_id, episode_seed, family, regime,
                                           daily, index=family_idx * per_family + j, version=version)
                (episodes_dir / f'{episode_id}.json').write_text(
                    json.dumps(episode, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
                splits[regime].append(episode_id)
                summary.append({'episode_id': episode_id, 'seed': episode_seed,
                                'split': regime, 'family': family,
                                'conditioning_daily_date': daily['date'] if daily else None,
                                'conditioning_source_file': daily['source_file'] if daily else None})
                for frame in episode['frames']:
                    stamp = datetime.fromisoformat(frame['timestampUtc'].replace('Z', '+00:00'))
                    for node in frame['nodes']:
                        registry = NODES[node['id']]
                        cm = node['tmaCm']
                        status = ('BANJIR_JAKARTA' if registry['banjir_cm'] is not None
                                  and cm >= registry['banjir_cm'] else 'SIAGA'
                                  if cm >= registry['siaga_cm'] else 'AMAN')
                        row = {'dataset_version': version, 'generator_version': version,
                               'seed': episode_seed, 'episode_id': episode_id,
                               'run_id': '', 'scenario_family': family, 'split': regime,
                               'timestamp_utc': frame['timestampUtc'],
                               'timestamp_wib': stamp.astimezone(WIB).isoformat(),
                               'sim_time_seconds': frame['simTimeSeconds'],
                               'node_id': node['id'], 'catchment_id': node['id'],
                               'station_role': 'upstream' if node['id'].startswith('UP') else 'mainstem',
                               'rain_rate_mm_h': node['rainRateMmH'],
                               'rain_mm_5m': node['rainMm5m'],
                               'rain_source': node['rainSource'], 'tma_cm': cm,
                               'tma_source': 'synthetic', 'sensor_quality': node['sensorQuality'],
                               'threshold_siaga_cm': registry['siaga_cm'],
                               'threshold_banjir_cm': registry['banjir_cm'],
                               'current_status': status,
                               'bmkg_station_id': daily['station_id'] if daily and node['id'] == 'N5' else '',
                               'bmkg_rr_daily_mm': daily['rr_mm'] if daily and node['id'] == 'N5' else '',
                               'bmkg_rr_observed_date': daily['date'] if daily and node['id'] == 'N5' else '',
                               'bmkg_rr_quality': daily['quality'] if daily and node['id'] == 'N5' else '',
                               'bmkg_source_file': daily['source_file'] if daily and node['id'] == 'N5' else '',
                               'bmkg_source_row': daily['source_row'] if daily and node['id'] == 'N5' else '',
                               'forecast_provider': '', 'forecast_issue_time': '',
                               'forecast_valid_from': '', 'forecast_valid_to': '',
                               'forecast_weather_desc': '', 'forecast_quality': ''}
                        writer.writerow(row)
    manifest = {'dataset_version': version, 'generator_version': version,
                'seed': seed, 'episode_count': len(summary),
                'steps_per_episode': STEPS_PER_DAY, 'step_seconds': STEP_SECONDS,
                'node_ids': NODE_IDS, 'node_registry': NODES, 'splits': splits,
                'episodes': summary, 'conditioned_episodes': conditioned_count,
                'held_out_demo_episode_id': 'compound-%03d' % (per_family - 4),
                'bmkg': bmkg,
                'scope': 'Synthetic-data LSTM demonstration; not validated for operational flood warning',
                'assumptions': 'Uncalibrated storage, local boundary effects and delayed downstream-only propagation. Stress set varies lag-independent storm shape, drainage, gain, noise and sensor quality. Dataset timestamps do not encode BMKG rain-day observation windows.'}
    if version == 'synthetic_v2':
        manifest['upstream_feature_node'] = UPSTREAM
        manifest['up1_upstream_feature_source'] = 'topology_self_proxy_no_upstream'
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    from .windows import write_targets
    write_targets((json.loads((episodes_dir / (item['episode_id'] + '.json')).read_text(encoding='utf-8'))
                   for item in summary), output / 'targets.csv')
    return output


def main(argv=None):
    """Regenerate the complete frozen synthetic dataset from a config file."""
    import argparse
    from .config import load_config

    parser = argparse.ArgumentParser(description='Generate labelled synthetic flood episodes')
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args(argv)
    config = load_config(args.config)
    kwargs = {'seed': config['seed'], 'per_family': config['per_family']}
    if config['dataset_version'] != VERSION:
        kwargs['version'] = config['dataset_version']
    result = write_dataset(config['dataset_dir'], config['raw_directory'], **kwargs)
    print(f'Synthetic dataset written: {result}')


if __name__ == '__main__':
    main()
