import json
from datetime import datetime, timedelta, timezone

import numpy as np

from simba_forecast.predict_worker import PredictionWorker
from simba_forecast.schema import FEATURES
from simba_forecast.train import build_model


def request(count=96, step=300):
    start = datetime(2026, 6, 1, tzinfo=timezone.utc)
    history = [{'timestampUtc': (start + timedelta(seconds=i * step)).isoformat().replace('+00:00', 'Z'),
                'tmaCm': 70., 'rainRateMmH': 0., 'upstreamTmaCm': 80.,
                'upstreamRainRateMmH': 0.} for i in range(count)]
    return {'requestId': 'r1', 'runId': 'run-1', 'nodeId': 'N1',
            'issuedAt': history[-1]['timestampUtc'], 'history': history}


def test_worker_reports_specific_unavailable_states_and_rejects_noncausal_history(tmp_path):
    worker = PredictionWorker(tmp_path)
    assert worker.handle_request(request(count=95))['error'] == 'insufficient_history'
    assert worker.handle_request({**request(), 'nodeId': 'UP1'})['error'] == 'unmapped_station'
    assert worker.handle_request(request())['error'] == 'model_unavailable'
    stale = request()
    stale['issuedAt'] = '2026-06-03T00:00:00Z'
    assert worker.handle_request(stale)['error'] == 'stale_input'
    future = request()
    future['history'][-1]['timestampUtc'] = '2026-07-01T00:00:00Z'
    assert worker.handle_request(future)['error'] == 'stale_input'
    missing = request()
    missing['history'][0]['rainRateMmH'] = None
    assert worker.handle_request(missing)['error'] == 'invalid_input'


def test_worker_rejects_bad_history_rows_and_known_missing_sensor_flag(tmp_path):
    worker = PredictionWorker(tmp_path)
    invalid = request()
    invalid['history'][3] = None
    assert worker.handle_request(invalid)['error'] == 'invalid_input'
    missing = request()
    missing['history'][12]['sensorQuality'] = 'synthetic_missing'
    assert worker.handle_request(missing)['error'] == 'invalid_input'


def test_loaded_real_keras_artifact_returns_twelve_numbered_levels(tmp_path):
    import tensorflow as tf
    model = build_model(units=8)
    model.save(tmp_path / 'N1.keras')
    (tmp_path / 'N1.json').write_text(json.dumps({
        'dataset_version': 'synthetic_v1', 'model_version': 'synthetic_v1_N1',
        'threshold_banjir_cm': 280, 'input_steps': 96, 'output_steps': 12,
        'feature_order': list(FEATURES), 'fit_partition': 'train',
        'mean': [70., 0., 80., 0.], 'std': [1., 1., 1., 1.],
        'target_delta_scale_cm': 1., 'selected_demo_method': 'lstm_synthetic_v1'
    }))
    worker = PredictionWorker(tmp_path)
    assert worker.available_models == ['N1']
    response = worker.handle_request(request())
    assert response['requestId'] == 'r1' and response['runId'] == 'run-1'
    assert response['method'] == 'lstm_synthetic_v1'
    assert len(response['levelsCm']) == 12 and all(np.isfinite(response['levelsCm']))
    assert response['modelVersion'] == 'synthetic_v1_N1'
