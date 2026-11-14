"""Train a presentation-only model on independent synthetic 20-second episodes."""
import json
import os
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('TF_ENABLE_ONEDNN_OPTS', '0')
os.environ.setdefault('TF_NUM_INTEROP_THREADS', '1')
os.environ.setdefault('TF_NUM_INTRAOP_THREADS', '1')
from pathlib import Path
import numpy as np
import tensorflow as tf

ROOT = Path(__file__).resolve().parent
tf.keras.utils.set_random_seed(20261113)
rng = np.random.default_rng(20261113)

def episodes(count):
    x, y, current = [], [], []
    for _ in range(count):
        # Random piecewise linear profiles and plateaus; each example is an independent episode.
        knots = [0]
        while knots[-1] < 101:
            knots.append(min(101, knots[-1] + int(rng.integers(8, 60))))
        levels = [rng.uniform(20, 180)]
        constant = rng.random() < 0.3
        for a, b in zip(knots, knots[1:]):
            slope = 0 if constant else rng.choice([0, 0, -1, 1]) * rng.uniform(0, 3)
            levels.append(np.clip(levels[-1] + slope * (b - a), 0, 350))
        series = np.clip(np.interp(np.arange(102), knots, levels) + rng.normal(0, 0.2 if constant else 0.5, 102), 0, 350)
        current.append(series[11])
        window = series[:12].copy()
        available = int(rng.integers(1, 13))
        window[:12 - available] = window[12 - available]
        x.append(window / 200)
        y.append((series[12:] - series[11]) / 100)
    return np.asarray(x, np.float32)[..., None], np.asarray(y, np.float32), np.asarray(current, np.float32)

x_train, y_train, c_train = episodes(2400)
x_val, y_val, c_val = episodes(400)
x_test, y_test, c_test = episodes(400)
model = tf.keras.Sequential([tf.keras.layers.Input((12, 1)), tf.keras.layers.LSTM(32), tf.keras.layers.Dense(64, activation='relu'), tf.keras.layers.Dense(90)])
model.compile(optimizer='adam', loss='huber')
history = model.fit(x_train, y_train, validation_data=(x_val, y_val), epochs=12, batch_size=64, verbose=0, callbacks=[tf.keras.callbacks.EarlyStopping(patience=3, restore_best_weights=True)])
prediction = model.predict(x_test, verbose=0) * 100 + c_test[:, None]
actual = y_test * 100 + c_test[:, None]
mae = lambda p, i: float(np.mean(np.abs(actual[:, i] - p[:, i])))
persistence = np.repeat(c_test[:, None], 90, axis=1)
folder = ROOT / 'models' / 'hardware_20s_demo'
folder.mkdir(parents=True, exist_ok=True)
model.save(folder / 'N1.keras')
report = {'scope': 'synthetic presentation only; no measured-data validation', 'step_seconds': 20, 'input_steps': 12, 'early_history': 'repeat earliest available sample; randomized during training', 'output_steps': 90, 'train_episodes': 2400, 'validation_episodes': 400, 'test_episodes': 400, 'epochs': len(history.history['loss']), 'test_mae_cm': {'20s': mae(prediction, 0), '10m': mae(prediction, 29), '30m': mae(prediction, 89)}, 'persistence_mae_cm': {'20s': mae(persistence, 0), '10m': mae(persistence, 29), '30m': mae(persistence, 89)}}
(folder / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report), flush=True)
