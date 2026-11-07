"""Persistent JSONL forecast worker. stdout is JSON protocol only; stderr is diagnostics."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('TF_ENABLE_ONEDNN_OPTS', '0')
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from simba_forecast.baselines import persistence, recent_slope
    from simba_forecast.schema import FEATURES, HISTORY_STEPS, HORIZON_STEPS, NODE_IDS, NODES, STEP_SECONDS, finite, parse_utc
    from simba_forecast.splits import features_from_history
    from simba_forecast.train import predict_levels
else:
    from .baselines import persistence, recent_slope
    from .schema import FEATURES, HISTORY_STEPS, HORIZON_STEPS, NODE_IDS, NODES, STEP_SECONDS, finite, parse_utc
    from .splits import features_from_history
    from .train import predict_levels


class PredictionWorker:
    def __init__(self, models_dir):
        self.models_dir = Path(models_dir)
        self.models = {}
        self.dataset_version = ('synthetic_v2' if self.models_dir.name == 'synthetic_v2'
                                else 'synthetic_v1')
        nodes = NODE_IDS if self.dataset_version == 'synthetic_v2' else ('N1', 'N5')
        pending = {}
        for node_id in nodes:
            path = self.models_dir / f'{node_id}.keras'
            meta_path = self.models_dir / f'{node_id}.json'
            if not path.is_file() or not meta_path.is_file():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding='utf-8'))
                if (meta.get('dataset_version') != self.dataset_version
                        or meta.get('input_steps') != HISTORY_STEPS
                        or meta.get('output_steps') != HORIZON_STEPS
                        or meta.get('feature_order') != list(FEATURES)
                        or meta.get('fit_partition') != 'train'
                        or meta.get('threshold_banjir_cm') != NODES[node_id]['banjir_cm']
                        or meta.get('selected_demo_method') not in
                        tuple(f'{method}_{self.dataset_version}' for method in
                              ('lstm', 'persistence', 'slope'))):
                    raise ValueError('model manifest/schema mismatch')
                if self.dataset_version == 'synthetic_v2' and (
                        meta.get('node_id') != node_id
                        or meta.get('model_version') != f'synthetic_v2_{node_id}'
                        or meta.get('step_seconds') != STEP_SECONDS
                        or not meta.get('model_sha256')):
                    raise ValueError('incomplete v2 model metadata')
                if meta.get('model_sha256') and hashlib.sha256(path.read_bytes()).hexdigest() != meta['model_sha256']:
                    raise ValueError('model artifact sha256 mismatch')
                finite(meta.get('target_delta_scale_cm'), 'target_delta_scale_cm', 1e-6)
                for field in ('mean', 'std'):
                    if len(meta[field]) != len(FEATURES):
                        raise ValueError('scaler length mismatch')
                    for value in meta[field]:
                        finite(value, field, 1e-6 if field == 'std' else None)
                pending[node_id] = (path, meta)
            except Exception as exc:
                print(f'Could not load {node_id} model: {exc}', file=sys.stderr, flush=True)
        # A v2 bundle is atomic. Never serve a subset of nine models after a
        # missing, corrupted or mismatched artifact (legacy v1 remains partial).
        if self.dataset_version == 'synthetic_v2' and len(pending) != len(NODE_IDS):
            pending.clear()
        if pending:
            import tensorflow as tf
            try:
                for node_id, (path, meta) in pending.items():
                    model = tf.keras.models.load_model(path, compile=False)
                    if model.output_shape[-1] != HORIZON_STEPS or model.input_shape[1:] != (HISTORY_STEPS, len(FEATURES)):
                        raise ValueError('model input/output shape mismatch')
                    self.models[node_id] = (model, meta)
            except Exception as exc:
                print(f'Could not load model bundle: {exc}', file=sys.stderr, flush=True)
                if self.dataset_version == 'synthetic_v2':
                    self.models.clear()
        self.available_models = list(self.models)

    def handle_request(self, request):
        ids = {key: request.get(key) if isinstance(request, dict) else None
               for key in ('requestId', 'runId', 'nodeId')}
        try:
            if any(not isinstance(ids[k], str) or not ids[k] for k in ('requestId', 'runId')):
                raise ValueError('invalid_input')
            node_id = ids['nodeId']
            if node_id not in (NODE_IDS if self.dataset_version == 'synthetic_v2' else ('N1', 'N5')):
                raise ValueError('unmapped_station')
            history = request.get('history')
            if not isinstance(history, list) or len(history) != HISTORY_STEPS:
                raise ValueError('insufficient_history')
            if any(not isinstance(row, dict) or row.get('sensorQuality') not in
                   (None, 'synthetic_complete') for row in history):
                raise ValueError('invalid_input')
            try:
                cutoff = parse_utc(request.get('issuedAt'))
                instants = [parse_utc(row.get('timestampUtc')) for row in history]
                if (instants[-1] != cutoff or any((b - a).total_seconds() != STEP_SECONDS
                    for a, b in zip(instants[:-1], instants[1:]))):
                    raise ValueError('stale_input')
            except (KeyError, TypeError) as exc:
                raise ValueError('invalid_input') from exc
            x = features_from_history(history).reshape(1, HISTORY_STEPS, len(FEATURES))
            if node_id not in self.models:
                raise ValueError('model_unavailable')
            model, meta = self.models[node_id]
            method = meta['selected_demo_method']
            if method == f'lstm_{self.dataset_version}':
                levels = predict_levels(model, meta, x, [history[-1]['tmaCm']])[0]
            elif method == f'slope_{self.dataset_version}':
                levels = recent_slope(x[0, :, 0])
            else:
                levels = persistence(x[0, :, 0])
            if len(levels) != HORIZON_STEPS or not __import__('numpy').isfinite(levels).all():
                raise ValueError('model_unavailable')
            result = {**ids, 'modelVersion': meta['model_version'],
                      'levelsCm': [round(float(v), 4) for v in levels],
                      'method': method}
            if self.dataset_version == 'synthetic_v2':
                threshold = meta['threshold_banjir_cm']
                result['thresholdBanjirCm'] = threshold
                result['crossing'] = (None if threshold is None
                                      else bool((levels >= threshold).any()))
            return result
        except ValueError as exc:
            reason = str(exc)
            if reason not in ('insufficient_history', 'stale_input', 'unmapped_station',
                              'model_unavailable', 'invalid_input'):
                reason = 'invalid_input'
            return {**ids, 'error': reason}
        except Exception as exc:
            print(f'Inference failed: {exc}', file=sys.stderr, flush=True)
            return {**ids, 'error': 'model_unavailable'}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Resident synthetic forecast JSONL worker')
    parser.add_argument('--models-dir', type=Path,
                        default=Path(__file__).resolve().parents[2] / 'models')
    args = parser.parse_args(argv)
    worker = PredictionWorker(args.models_dir)
    print(json.dumps({'type': 'ready', 'models': worker.available_models}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            answer = worker.handle_request(request)
        except Exception as exc:
            print(f'Invalid JSONL request: {exc}', file=sys.stderr, flush=True)
            answer = {'requestId': None, 'runId': None, 'nodeId': None, 'error': 'invalid_input'}
        print(json.dumps(answer, allow_nan=False, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    main()
