import json

from simba_forecast.generate import generate_episode
from simba_forecast.windows import write_targets
from simba_forecast.train import train_models


def test_two_station_training_emits_loadable_artifacts_and_heldout_baselines(tmp_path):
    import tensorflow as tf
    data = tmp_path / 'data'
    (data / 'episodes').mkdir(parents=True)
    splits = {'train': ['compound-000', 'local_intense-000'],
              'validation': ['compound-010'], 'test': ['compound-012'],
              'stress': ['local_intense-014']}
    episodes = []
    for idx, (split, ids) in enumerate(splits.items()):
        for j, eid in enumerate(ids):
            family = eid.rsplit('-', 1)[0]
            ep = generate_episode(eid, 100 + idx * 5 + j, family, split)
            (data / 'episodes' / f'{eid}.json').write_text(json.dumps(ep))
            episodes.append(ep)
    write_targets(episodes, data / 'targets.csv')
    manifest = {'dataset_version': 'synthetic_v1', 'splits': splits,
                'episode_count': len(episodes), 'held_out_demo_episode_id': 'compound-012'}
    (data / 'manifest.json').write_text(json.dumps(manifest))
    report = train_models(data, tmp_path / 'models', tmp_path / 'report.json',
                          seed=42, max_epochs=1, train_cap=10, validation_cap=6)
    assert set(report['nodes']) == {'N1', 'N5'}
    for node in ('N1', 'N5'):
        loaded = tf.keras.models.load_model(tmp_path / 'models' / f'{node}.keras')
        assert loaded.output_shape[-1] == 12
        meta = json.loads((tmp_path / 'models' / f'{node}.json').read_text())
        assert meta['fit_partition'] == 'train'
        assert set(report['nodes'][node]['test']) == {'lstm', 'persistence', 'slope'}
        assert report['nodes'][node]['test']['lstm']['30']['samples'] > 0
        assert report['nodes'][node]['stress']['lstm']['60']['samples'] > 0
