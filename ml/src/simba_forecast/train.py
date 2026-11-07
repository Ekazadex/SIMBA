"""Bounded, per-node 12-step LSTM training; exclusively synthetic demonstration."""
import os
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('TF_ENABLE_ONEDNN_OPTS', '0')

import numpy as np

import csv
import json
from collections import defaultdict
from pathlib import Path

from .schema import FEATURES, HISTORY_STEPS, HORIZON_STEPS, NODE_IDS
from .splits import apply_scaler, features_from_history
from .windows import make_window


def collect_examples(dataset_dir, manifest, node_id, partition, *, max_per_episode=None):
    """Read saved targets, then build features strictly from <= issue timestamps."""
    supported = NODE_IDS if manifest.get('dataset_version') == 'synthetic_v2' else ('N1', 'N5')
    if node_id not in supported or partition not in manifest['splits']:
        raise ValueError('unmapped node or partition')
    dataset_dir = Path(dataset_dir)
    allowed = set(manifest['splits'][partition])
    by_episode = defaultdict(list)
    with (dataset_dir / 'targets.csv').open(newline='', encoding='utf-8') as handle:
        for row in csv.DictReader(handle):
            if row['node_id'] == node_id and row['episode_id'] in allowed and row['eligible'] == 'True':
                by_episode[row['episode_id']].append(row)
    x, y, current, info = [], [], [], []
    for eid in sorted(allowed):
        episode = json.loads((dataset_dir / 'episodes' / f'{eid}.json').read_text(encoding='utf-8'))
        rows = by_episode[eid]
        if max_per_episode and len(rows) > max_per_episode:
            # Positives represented in the training budget; no holdout sampling.
            positives = [r for r in rows if r['cross60'] == 'True']
            rng = np.random.default_rng(episode['seed'] + 41)
            selected = list(rng.choice(positives, size=min(len(positives), max_per_episode // 2),
                                       replace=False)) if positives else []
            other = [r for r in rows if r not in selected]
            selected.extend(rng.choice(other, size=max_per_episode - len(selected), replace=False))
            rows = sorted(selected, key=lambda r: int(r['issue_index']))
        for row in rows:
            issue = int(row['issue_index'])
            history = make_window(episode, node_id, issue)
            if history is None or history[-1]['timestampUtc'] != row['issued_at']:
                raise ValueError('saved target and causal history mismatch')
            x.append(features_from_history(history))
            y.append(json.loads(row['trajectory_cm']))
            current.append(float(row['current_tma_cm']))
            info.append({'episode_id': eid, 'family': episode['family'],
                         'issue_index': issue, 'issued_at': row['issued_at']})
    return (np.asarray(x, dtype=np.float32).reshape(-1, HISTORY_STEPS, len(FEATURES)),
            np.asarray(y, dtype=np.float32).reshape(-1, HORIZON_STEPS),
            np.asarray(current, dtype=np.float32), info)


def build_model(units=32):
    import tensorflow as tf
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(HISTORY_STEPS, len(FEATURES))),
        tf.keras.layers.LSTM(units),
        tf.keras.layers.Dense(24, activation='relu'),
        tf.keras.layers.Dense(HORIZON_STEPS),
    ])
    model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=0.001),
                  loss=tf.keras.losses.Huber())
    return model


def predict_levels(model, scaler, raw_features, current_cm):
    scaled = apply_scaler(raw_features, scaler)
    predictions = model.predict(scaled, batch_size=128, verbose=0)
    current = np.asarray(current_cm, dtype=np.float32).reshape(-1, 1)
    levels = current + predictions * scaler['target_delta_scale_cm']
    return np.maximum(0, levels).astype(np.float32)


def train_models(dataset_dir, models_dir, report_path, *, seed=20261010,
                 max_epochs=5, train_cap=18, validation_cap=12):
    """Fit on frozen train events; select deployment method from validation only."""
    import hashlib
    from datetime import datetime, timezone
    import tensorflow as tf
    from .baselines import persistence, recent_slope
    from .evaluate import score_sequences
    from .generate import FAMILIES, VERSION
    from .schema import NODES
    from .splits import fit_train_scaler, validate_splits

    data = Path(dataset_dir)
    models = Path(models_dir)
    report_path = Path(report_path)
    manifest_bytes = (data / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    version = manifest.get('dataset_version')
    if version not in (VERSION, 'synthetic_v2'):
        raise ValueError('unsupported dataset version')
    validate_splits(manifest['splits'])
    if max_epochs < 1 or train_cap < 1 or validation_cap < 1:
        raise ValueError('bounded training budget must be positive')
    models.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {'dataset_version': version, 'scope': 'synthetic-only, no measured flood accuracy',
              'seed': seed, 'epoch_cap': max_epochs, 'train_window_cap_per_episode': train_cap,
              'validation_window_cap_per_episode': validation_cap,
              'generated_at_utc': datetime.now(timezone.utc).isoformat(),
              'dataset_manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
              'split_episode_counts': {k: len(v) for k, v in manifest['splits'].items()},
              'split_episode_ids': manifest['splits'], 'nodes': {}}
    node_ids = NODE_IDS if version == 'synthetic_v2' else ('N1', 'N5')
    for index, node in enumerate(node_ids):
        tf.keras.utils.set_random_seed(seed + index)
        training = collect_examples(data, manifest, node, 'train', max_per_episode=train_cap)
        validation = collect_examples(data, manifest, node, 'validation', max_per_episode=validation_cap)
        x_train, y_train, current_train, _ = training
        x_val, y_val, current_val, _ = validation
        if not len(x_train) or not len(x_val):
            raise ValueError(f'No eligible training/validation windows for {node}')
        scaler = fit_train_scaler(x_train)
        delta_scale = max(float(np.std(y_train - current_train[:, None])), 1.0)
        scaler['target_delta_scale_cm'] = delta_scale
        model = build_model(units=32)
        target_train = (y_train - current_train[:, None]) / delta_scale
        target_val = (y_val - current_val[:, None]) / delta_scale
        history = model.fit(
            apply_scaler(x_train, scaler), target_train,
            validation_data=(apply_scaler(x_val, scaler), target_val),
            epochs=max_epochs, batch_size=64, verbose=0, shuffle=True,
            callbacks=[tf.keras.callbacks.EarlyStopping(
                monitor='val_loss', patience=2, restore_best_weights=True)])
        path = models / f'{node}.keras'
        model.save(path)
        reloaded = tf.keras.models.load_model(path, compile=False)
        if not np.allclose(model.predict(apply_scaler(x_val[:1], scaler), verbose=0),
                           reloaded.predict(apply_scaler(x_val[:1], scaler), verbose=0), atol=1e-5):
            raise RuntimeError('Keras save/load smoke comparison failed')
        partition_scores = {}
        cohorts = {}
        sample_counts = {}
        for partition in ('validation', 'test', 'stress'):
            x, y, current, info = (validation if partition == 'validation'
                                   else collect_examples(data, manifest, node, partition))
            sample_counts[partition] = len(y)
            if not len(y):
                raise ValueError(f'No held-out windows for {node}/{partition}')
            predictions = {
                'lstm': predict_levels(reloaded, scaler, x, current),
                'persistence': np.asarray([persistence(row[:, 0]) for row in x]),
                'slope': np.asarray([recent_slope(row[:, 0]) for row in x]),
            }
            partition_scores[partition] = {name: score_sequences(
                y, p, current, threshold_cm=NODES[node]['banjir_cm'],
                episode_count=len(manifest['splits'][partition]))
                for name, p in predictions.items()}
            if partition in ('test', 'stress'):
                cohorts[partition] = {}
                for family in FAMILIES:
                    mask = np.array([v['family'] == family for v in info], dtype=bool)
                    cohorts[partition][family] = {
                        'episode_count': sum(eid.startswith(family + '-')
                                             for eid in manifest['splits'][partition]),
                        'eligible_windows': int(mask.sum()),
                        'metrics': {name: score_sequences(y[mask], p[mask], current[mask],
                            threshold_cm=NODES[node]['banjir_cm'],
                            episode_count=max(1, sum(eid.startswith(family + '-')
                                                 for eid in manifest['splits'][partition])))
                            for name, p in predictions.items()}}
        # Deployment choice is locked before looking at test/stress results.
        val_scores = partition_scores['validation']
        best = min(('persistence', 'slope', 'lstm'),
                   key=lambda name: val_scores[name]['60']['mae_cm'])
        selection = f'{best}_{version}'
        meta = {**scaler, 'dataset_version': version,
                'model_version': f'{version}_{node}', 'node_id': node,
                'input_steps': HISTORY_STEPS, 'output_steps': HORIZON_STEPS,
                'step_seconds': 300, 'threshold_banjir_cm': NODES[node]['banjir_cm'],
                'threshold_siaga_cm': NODES[node]['siaga_cm'],
                'dataset_manifest_sha256': report['dataset_manifest_sha256'],
                'model_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'selected_demo_method': selection,
                'selection_rule': 'lowest validation +60m MAE among LSTM/persistence/slope; no test tuning',
                'quality': 'experimental_synthetic_only',
                'missing_policy': 'drop complete 96+12 windows with synthetic_missing sensor flag',
                'training_seed': seed + index}
        (models / f'{node}.json').write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
        report['nodes'][node] = {'threshold_banjir_cm': NODES[node]['banjir_cm'],
                                 'samples': {'train': len(x_train), **sample_counts},
                                 'epochs_run': len(history.history['loss']),
                                 'training_loss': [float(v) for v in history.history['loss']],
                                 'validation_loss': [float(v) for v in history.history['val_loss']],
                                 'selected_demo_method': selection,
                                 'validation': partition_scores['validation'],
                                 'test': partition_scores['test'],
                                 'stress': partition_scores['stress'],
                                 'cohorts': cohorts}
    report_path.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    if version == 'synthetic_v2':
        from .reporting import render_report
        report_path.with_suffix('.md').write_text(render_report(report, manifest), encoding='utf-8')
    return report


def main(argv=None):
    """Train configured nodes and compare against both baselines on held-out episodes."""
    import argparse
    from .config import load_config

    parser = argparse.ArgumentParser(description='Fit synthetic-only per-node LSTMs')
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args(argv)
    config = load_config(args.config)
    report = train_models(config['dataset_dir'], config['models_dir'], config['report_path'],
                          seed=config['seed'], max_epochs=config['max_epochs'],
                          train_cap=config['train_cap'], validation_cap=config['validation_cap'])
    print(f"Synthetic-only report written: {config['report_path']} "
          f"(nodes: {', '.join(report.get('nodes', {}))})")


if __name__ == '__main__':
    main()
