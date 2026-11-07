"""Causal history construction and independently serialized future labels."""
from __future__ import annotations

import csv
import json

from .schema import HISTORY_STEPS, HORIZON_STEPS, NODE_IDS, NODES, UPSTREAM

TARGET_FIELDS = ('episode_id', 'split', 'node_id', 'issue_index', 'issued_at',
                 'eligible', 'mask_reason', 'already_above_threshold',
                 'current_tma_cm', 'tma_t30_cm', 'tma_t60_cm', 'cross30',
                 'cross60', 'trajectory_cm')


def _node(frame, node_id):
    return next(node for node in frame['nodes'] if node['id'] == node_id)


def make_window(episode, node_id, issue_index):
    """Only [issue-95, issue] available; None if history cannot be observed."""
    if node_id not in UPSTREAM or issue_index < HISTORY_STEPS - 1 or issue_index >= len(episode['frames']):
        return None
    history = []
    for frame in episode['frames'][issue_index - HISTORY_STEPS + 1:issue_index + 1]:
        target = _node(frame, node_id)
        upstream = _node(frame, UPSTREAM[node_id])
        if (target['sensorQuality'] != 'synthetic_complete'
                or upstream['sensorQuality'] != 'synthetic_complete'):
            return None
        history.append({'timestampUtc': frame['timestampUtc'],
                        'tmaCm': target['tmaCm'], 'rainRateMmH': target['rainRateMmH'],
                        'upstreamTmaCm': upstream['tmaCm'],
                        'upstreamRainRateMmH': upstream['rainRateMmH'],
                        'upstreamFeatureSource': ('topology_self_proxy_no_upstream' if node_id == 'UP1'
                                                  else f'synthetic_upstream_{UPSTREAM[node_id]}')})
    return history


def target_for_issue(episode, node_id, issue_index):
    frames = episode['frames']
    threshold = NODES[node_id]['banjir_cm']
    issued_at = frames[issue_index]['timestampUtc']
    current = _node(frames[issue_index], node_id)['tmaCm']
    result = {'episode_id': episode['episodeId'], 'split': episode['split'],
              'node_id': node_id, 'issue_index': issue_index,
              'issued_at': issued_at, 'current_tma_cm': current,
              'eligible': False, 'already_above_threshold': threshold is not None and current >= threshold,
              'mask_reason': '', 'tma_t30_cm': None, 'tma_t60_cm': None,
              'cross30': None, 'cross60': None, 'trajectory_cm': None}
    if issue_index + HORIZON_STEPS >= len(frames):
        result['mask_reason'] = 'no_full_future_horizon'
    elif issue_index < HISTORY_STEPS - 1:
        result['mask_reason'] = 'insufficient_history'
    elif result['already_above_threshold']:
        result['mask_reason'] = 'already_above_threshold'
    elif make_window(episode, node_id, issue_index) is None:
        result['mask_reason'] = 'missing_past_sensor'
    else:
        future = [_node(f, node_id) for f in frames[issue_index + 1:issue_index + HORIZON_STEPS + 1]]
        if any(node['sensorQuality'] != 'synthetic_complete' for node in future):
            result['mask_reason'] = 'missing_future_sensor'
        else:
            values = [node['tmaCm'] for node in future]
            result.update({'eligible': True, 'trajectory_cm': values,
                           'tma_t30_cm': values[5], 'tma_t60_cm': values[11],
                           'cross30': any(v >= threshold for v in values[:6]) if threshold is not None else None,
                           'cross60': any(v >= threshold for v in values) if threshold is not None else None})
    return result


def write_targets(episodes, path):
    with open(path, 'w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=TARGET_FIELDS)
        writer.writeheader()
        for episode in episodes:
            for node_id in (NODE_IDS if episode['version'] == 'synthetic_v2' else ('N1', 'N5')):
                for issue in range(len(episode['frames'])):
                    row = target_for_issue(episode, node_id, issue)
                    row['trajectory_cm'] = (json.dumps(row['trajectory_cm'], separators=(',', ':'))
                                            if row['trajectory_cm'] is not None else '')
                    writer.writerow(row)
