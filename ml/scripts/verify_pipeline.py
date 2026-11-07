"""Independent read-back of the actual synthetic-only dataset, models and metrics."""
import argparse
import json
from pathlib import Path
import sys

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT / 'src'))
from simba_forecast.config import load_config
from simba_forecast.verify import verify_pipeline


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ML_ROOT / 'config/synthetic_v1.json')
    parser.add_argument('--models-dir', type=Path)
    args = parser.parse_args(argv)
    config = args.config.resolve()
    cfg = load_config(config)
    models = args.models_dir.resolve() if args.models_dir else cfg['models_dir']
    result = verify_pipeline(config)
    print('ML PIPELINE VERIFIED ' + json.dumps(result, sort_keys=True))
    if models != cfg['models_dir']:
        raise ValueError('worker smoke model directory must match its selected config')
    if cfg['dataset_version'] != 'synthetic_v2':
        return
    from simba_forecast.predict_worker import PredictionWorker
    from simba_forecast.schema import NODE_IDS
    manifest = json.loads((cfg['dataset_dir'] / 'manifest.json').read_text(encoding='utf-8'))
    episode_id = manifest['held_out_demo_episode_id']
    episode = json.loads((cfg['dataset_dir'] / 'episodes' / f'{episode_id}.json').read_text(encoding='utf-8'))
    worker = PredictionWorker(models)
    assert worker.available_models == list(NODE_IDS)
    results = {}
    for node in NODE_IDS:
        history = []
        for frame in episode['frames'][-96:]:
            target = next(value for value in frame['nodes'] if value['id'] == node)
            upstream_id = manifest['upstream_feature_node'][node]
            upstream = next(value for value in frame['nodes'] if value['id'] == upstream_id)
            history.append({'timestampUtc': frame['timestampUtc'], 'tmaCm': target['tmaCm'],
                            'rainRateMmH': target['rainRateMmH'], 'upstreamTmaCm': upstream['tmaCm'],
                            'upstreamRainRateMmH': upstream['rainRateMmH']})
        response = worker.handle_request({'requestId': node, 'runId': 'verify-heldout',
            'nodeId': node, 'issuedAt': history[-1]['timestampUtc'], 'history': history})
        assert response.get('nodeId') == node and len(response.get('levelsCm', [])) == 12
        expected_threshold = None if node == 'UP1' else 280
        assert response['thresholdBanjirCm'] == expected_threshold
        assert response['crossing'] is None if node == 'UP1' else isinstance(response['crossing'], bool)
        results[node] = {'method': response['method'], 'crossing': response['crossing']}
    print('WORKER SYNTHETIC_V2 VERIFIED ' + json.dumps({'episode': episode_id, 'nodes': results}, sort_keys=True))


if __name__ == '__main__':
    main()
