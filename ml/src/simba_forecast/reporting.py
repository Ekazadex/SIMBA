"""Readable, data-derived synthetic v2 scorecard (JSON remains authoritative)."""

from .schema import NODE_IDS, UPSTREAM


def _number(value):
    return '—' if value is None else f'{value:.3f}'


def render_report(report, manifest):
    """Summarize *saved* validation and held-out scores without reinterpreting them."""
    if report['dataset_version'] != 'synthetic_v2' or set(report['nodes']) != set(NODE_IDS):
        raise ValueError('complete synthetic_v2 report required')
    counts = report['split_episode_counts']
    lines = [
        '# Synthetic v2 nine-node held-out evaluation',
        '',
        '**Synthetic-data LSTM demonstration; not validated for operational flood warning.** '
        'The nine LSTMs are trained independently; the deployed demo method for each node '
        'is selected by minimum validation +60-minute TMA MAE among LSTM, persistence, and slope. '
        'Selection does not use test or stress outcomes.',
        '',
        f"- Seed `{report['seed']}`; {manifest.get('episode_count', sum(counts.values()))} independent 24-hour episodes "
        f"({counts['train']} train, {counts['validation']} validation, "
        f"{counts['test']} test, {counts['stress']} shifted stress); "
        f"held-out replay `{manifest.get('held_out_demo_episode_id', report.get('held_out_demo_episode_id', 'unspecified'))}`.",
        f"- {manifest.get('conditioned_episodes', 0)} train episodes condition an invented N5 storm "
        'on BMKG observed **daily** RR magnitude. All 5-minute rain and TMA are synthetic, '
        'not measured five-minute BMKG inputs; unknown daily rain is never filled with zero.',
        '- Inputs: 96 strictly past five-minute bins × 4 features; targets: next 12 TMA values. '
        'UP1 has no upstream gauge: its upstream columns are an explicit **self-proxy**, '
        f"`{UPSTREAM['UP1']}` (not an independent measurement). The remaining nodes use "
        'the immediately preceding node in topology.',
        '- UP1 has **no defined flood threshold**. Its +30/+60 TMA regression scores exist, '
        'but crossing, confusion, F1, and false alarms are undefined/null, not safe/zero. '
        'The 280-cm BANJIR thresholds of the other eight nodes are simulator demo values, '
        'not calibrated station thresholds.',
        '- +30/+60 MAE and RMSE are centimetres at steps 6 and 12, respectively. '
        'Classification uses any predicted/actual threshold crossing up to that horizon; '
        'counts are overlapping issue windows, not independent flood events. '
        'Full precision, recall, confusion, false-alarm rates and family cohorts are in JSON.',
        '',
        '## Validation-selected demo methods',
        '',
        '| Node | Threshold | Selected method | Train windows | Test windows | Stress windows |',
        '|---|---:|---|---:|---:|---:|',
    ]
    for node in NODE_IDS:
        entry = report['nodes'][node]
        threshold = entry['threshold_banjir_cm']
        lines.append(f"| {node} | {threshold if threshold is not None else 'none'} | "
                     f"{entry['selected_demo_method']} | {entry['samples']['train']} | "
                     f"{entry['samples']['test']} | {entry['samples']['stress']} |")
    lines += [
        '', '## All three methods on validation and held-out partitions', '',
        '| Node | Split | Method | Windows | +30 MAE/RMSE cm | +30 F1 | '
        '+60 MAE/RMSE cm | +60 F1 | +60 TP/FP/FN/TN |',
        '|---|---|---|---:|---:|---:|---:|---:|---:|',
    ]
    for node in NODE_IDS:
        for split in ('validation', 'test', 'stress'):
            for method in ('lstm', 'persistence', 'slope'):
                measured = report['nodes'][node][split][method]
                h30, h60 = measured['30'], measured['60']
                confusion = h60['confusion']
                matrix = ('—' if confusion is None else '/'.join(
                    str(confusion[key]) for key in ('tp', 'fp', 'fn', 'tn')))
                lines.append(f"| {node} | {split} | {method} | {h60['samples']} | "
                             f"{_number(h30['mae_cm'])}/{_number(h30['rmse_cm'])} | "
                             f"{_number(h30['f1'])} | "
                             f"{_number(h60['mae_cm'])}/{_number(h60['rmse_cm'])} | "
                             f"{_number(h60['f1'])} | {matrix} |")
    lines += [
        '', '## Limits', '',
        'Episodes have independent seeds and disjoint splits but share one uncalibrated '
        'generator architecture. Stress alters simulated storm shape, gain, decay, noise '
        'and sensor availability, not real-world hydraulic conditions. Zero or undefined '
        'F1/precision must not be interpreted as verified flood-warning skill. '
        'Before operational claims: acquire real paired gauge/rainfall observations, '
        'station-calibrated thresholds and prospective chronological holdouts.', '',
    ]
    return '\n'.join(lines)
