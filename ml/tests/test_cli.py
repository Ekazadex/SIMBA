"""CLI configuration is reproducible and anchored to its file, not the shell."""
import json
from pathlib import Path

import pytest

from simba_forecast.config import load_config
from simba_forecast import generate, train


def fixture_config(tmp_path):
    directory = tmp_path / 'config'
    directory.mkdir()
    path = directory / 'synthetic_v1.json'
    path.write_text(json.dumps({
        'dataset_version': 'synthetic_v1', 'seed': 23, 'per_family': 16,
        'raw_directory': '../daily', 'dataset_dir': '../generated/synthetic_v1',
        'models_dir': '../models/synthetic_v1', 'report_path': '../reports/synthetic_v1.json',
        'max_epochs': 2, 'train_cap': 8, 'validation_cap': 5,
    }), encoding='utf-8')
    (tmp_path / 'daily').mkdir()
    return path


def test_config_resolves_paths_from_config_location(tmp_path, monkeypatch):
    path = fixture_config(tmp_path)
    monkeypatch.chdir(tmp_path.parent)
    config = load_config(path)
    assert config['raw_directory'] == (tmp_path / 'daily').resolve()
    assert config['dataset_dir'] == (tmp_path / 'generated/synthetic_v1').resolve()
    assert config['seed'] == 23 and config['per_family'] == 16


def test_cli_calls_generator_and_training_with_explicit_budget(tmp_path, monkeypatch):
    path = fixture_config(tmp_path)
    calls = []
    monkeypatch.setattr(generate, 'write_dataset', lambda *args, **kwargs: calls.append(('generate', args, kwargs)))
    monkeypatch.setattr(train, 'train_models', lambda *args, **kwargs: (calls.append(('train', args, kwargs)) or {'nodes': {'N1': {}, 'N5': {}}}))
    generate.main(['--config', str(path)])
    train.main(['--config', str(path)])
    assert calls == [
        ('generate', ((tmp_path / 'generated/synthetic_v1').resolve(),
                      (tmp_path / 'daily').resolve()), {'seed': 23, 'per_family': 16}),
        ('train', ((tmp_path / 'generated/synthetic_v1').resolve(),
                   (tmp_path / 'models/synthetic_v1').resolve(),
                   (tmp_path / 'reports/synthetic_v1.json').resolve()),
         {'seed': 23, 'max_epochs': 2, 'train_cap': 8, 'validation_cap': 5}),
    ]


def test_rejects_invalid_budget_and_unavailable_raw_source(tmp_path):
    path = fixture_config(tmp_path)
    doc = json.loads(path.read_text())
    doc['max_epochs'] = 0
    path.write_text(json.dumps(doc))
    with pytest.raises(ValueError, match='max_epochs'):
        load_config(path)
    doc['max_epochs'] = 2
    path.write_text(json.dumps(doc))
    (tmp_path / 'daily').rmdir()
    with pytest.raises(FileNotFoundError, match='raw_directory'):
        load_config(path)
