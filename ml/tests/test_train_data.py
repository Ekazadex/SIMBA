import json

from simba_forecast.generate import generate_episode
from simba_forecast.windows import write_targets
from simba_forecast.train import collect_examples


def test_training_loader_reads_saved_labels_by_held_out_episode_not_future_as_feature(tmp_path):
    ids = ['compound-000', 'compound-010', 'compound-012', 'compound-014']
    partitions = ['train', 'validation', 'test', 'stress']
    (tmp_path / 'episodes').mkdir()
    episodes = [generate_episode(eid, 8 + i, 'compound', partition)
                for i, (eid, partition) in enumerate(zip(ids, partitions))]
    for episode in episodes:
        (tmp_path / 'episodes' / (episode['episodeId'] + '.json')).write_text(json.dumps(episode))
    write_targets(episodes, tmp_path / 'targets.csv')
    manifest = {'splits': dict(zip(partitions, ([x] for x in ids)))}
    x, y, current, info = collect_examples(tmp_path, manifest, 'N1', 'test')
    assert x.shape[1:] == (96, 4) and y.shape[1:] == (12,)
    assert {v['episode_id'] for v in info} == {'compound-012'}
    assert all(x[:, -1, 0] == current)
    issue = info[0]['issue_index']
    test = episodes[2]
    expected = next(n['tmaCm'] for n in test['frames'][issue + 6]['nodes'] if n['id'] == 'N1')
    assert y[0, 5] == expected
    assert len(x) > 0
