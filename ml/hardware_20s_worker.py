"""JSON-lines resident worker for the synthetic 20-second presentation model."""
import json
import os
import sys
from pathlib import Path
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('TF_ENABLE_ONEDNN_OPTS', '0')
os.environ.setdefault('TF_NUM_INTEROP_THREADS', '1')
os.environ.setdefault('TF_NUM_INTRAOP_THREADS', '1')
import numpy as np
import tensorflow as tf
model = tf.keras.models.load_model(Path(__file__).resolve().parent / 'models' / 'hardware_20s_demo' / 'N1.keras', compile=False)
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
        levels = np.asarray(req['levels'], dtype=np.float32)
        if levels.shape != (12,) or not np.isfinite(levels).all():
            raise ValueError('invalid_history')
        output = np.maximum(0, model(levels.reshape(1, 12, 1) / 200, training=False).numpy()[0] * 100 + levels[-1])
        print(json.dumps({'id': req['id'], 'levelsCm': output.tolist()}, allow_nan=False), flush=True)
    except Exception:
        print(json.dumps({'id': req.get('id'), 'error': 'model_unavailable'}), flush=True)
