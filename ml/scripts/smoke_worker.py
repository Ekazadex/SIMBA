"""Exercise the real resident JSONL process against a held-out synthetic episode."""
import json
from pathlib import Path
import subprocess
import sys
import argparse

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT / 'src'))
from simba_forecast.config import load_config
from simba_forecast.schema import NODE_IDS
from simba_forecast.windows import make_window, target_for_issue


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ML_ROOT / 'config/synthetic_v1.json')
    args = parser.parse_args(argv)
    cfg = load_config(args.config)
    manifest = json.loads((cfg['dataset_dir'] / 'manifest.json').read_text(encoding='utf-8'))
    report = json.loads(cfg['report_path'].read_text(encoding='utf-8'))
    eid = manifest['held_out_demo_episode_id']
    assert eid in manifest['splits']['test']
    episode = json.loads((cfg['dataset_dir'] / 'episodes' / f'{eid}.json').read_text(encoding='utf-8'))
    requests = []
    nodes = NODE_IDS if cfg['dataset_version'] == 'synthetic_v2' else ('N1', 'N5')
    for node in nodes:
        issue = next(i for i in range(95, 276) if target_for_issue(episode, node, i)['eligible'])
        history = make_window(episode, node, issue)
        if history is None or len(history) != 96:
            raise AssertionError('held-out issue lacks a complete causal history')
        assert history[-1]['timestampUtc'] == episode['frames'][issue]['timestampUtc']
        requests.append({'requestId': f'smoke-{node}', 'runId': 'held-out-smoke',
                         'nodeId': node, 'issuedAt': history[-1]['timestampUtc'],
                         'history': history})
    cold = {**requests[0], 'requestId': 'cold', 'history': requests[0]['history'][:95]}
    command = [sys.executable, '-u', str(ML_ROOT / 'src/simba_forecast/predict_worker.py'),
               '--models-dir', str(cfg['models_dir'])]
    completed = subprocess.run(command, input='\n'.join(json.dumps(r) for r in [*requests, cold]) + '\n',
                               text=True, capture_output=True, timeout=180, check=True)
    messages = [json.loads(line) for line in completed.stdout.splitlines()]
    assert len(messages) == len(requests) + 2 and messages[0] == {'type': 'ready', 'models': list(nodes)}
    levels = {}
    for request, response in zip(requests, messages[1:1 + len(requests)]):
        node = request['nodeId']
        assert response['requestId'] == request['requestId'] and response['runId'] == request['runId']
        assert response['nodeId'] == node and 'error' not in response
        assert response['method'] == report['nodes'][node]['selected_demo_method']
        assert len(response['levelsCm']) == 12
        assert all(isinstance(x, (float, int)) and 0 <= x < 100000 for x in response['levelsCm'])
        levels[node] = {'method': response['method'], 't30_cm': response['levelsCm'][5],
                        't60_cm': response['levelsCm'][11]}
    assert messages[-1].get('requestId') == 'cold' and messages[-1].get('error') == 'insufficient_history'
    print('WORKER VERIFIED ' + json.dumps({'held_out_episode': eid, 'responses': levels, 'cold_start': messages[-1]}, sort_keys=True))


if __name__ == '__main__':
    main()
