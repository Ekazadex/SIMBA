import numpy as np

from simba_forecast.train import build_model, predict_levels
from simba_forecast.splits import fit_train_scaler


def test_tiny_real_keras_lstm_fit_save_reload_produces_twelve_finite_cm(tmp_path):
    import tensorflow as tf
    tf.keras.utils.set_random_seed(19)
    rng = np.random.default_rng(19)
    x = rng.random((20, 96, 4), dtype=np.float32)
    targets = rng.normal(0, .1, size=(20, 12)).astype(np.float32)
    model = build_model(units=8)
    model.fit(x, targets, epochs=1, batch_size=10, verbose=0)
    path = tmp_path / 'N1.keras'
    model.save(path)
    loaded = tf.keras.models.load_model(path)
    scaler = fit_train_scaler(x)
    scaler['target_delta_scale_cm'] = 10.0
    levels = predict_levels(loaded, scaler, x[:1], np.array([75.0]))
    assert levels.shape == (1, 12)
    assert np.isfinite(levels).all()
    assert np.allclose(model.predict(x[:1], verbose=0), loaded.predict(x[:1], verbose=0))
