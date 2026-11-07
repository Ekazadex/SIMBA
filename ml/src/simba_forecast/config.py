"""Versioned pipeline configuration, with paths anchored to the config file."""
import json
from pathlib import Path


REQUIRED_PATHS = ('raw_directory', 'dataset_dir', 'models_dir', 'report_path')
POSITIVE = ('seed', 'max_epochs', 'train_cap', 'validation_cap')


def load_config(path):
    path = Path(path).resolve()
    config = json.loads(path.read_text(encoding='utf-8'))
    if config.get('dataset_version') not in ('synthetic_v1', 'synthetic_v2'):
        raise ValueError('dataset_version must be synthetic_v1 or synthetic_v2')
    for name in POSITIVE:
        if type(config.get(name)) is not int or config[name] < 1:
            raise ValueError(f'{name} must be a positive integer')
    if type(config.get('per_family')) is not int or config['per_family'] < 16:
        raise ValueError('per_family must be at least 16')
    for name in REQUIRED_PATHS:
        value = config.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f'{name} must be a nonempty path')
        config[name] = (path.parent / value).resolve()
    if not config['raw_directory'].is_dir():
        raise FileNotFoundError(f"raw_directory does not exist: {config['raw_directory']}")
    return config
