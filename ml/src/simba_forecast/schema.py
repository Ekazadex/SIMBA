"""Frozen simulator registry snapshot; not physical BPBD station thresholds."""
from datetime import datetime, timezone
import math

# Website/SIMBA/backend/ciliwung/simulation-engine.mjs NODE_REGISTRY at v1.
NODES = {
    'UP1': {'baseline_cm': 40, 'siaga_cm': 70, 'banjir_cm': None},
    'UP2': {'baseline_cm': 60, 'siaga_cm': 180, 'banjir_cm': 280},
    'UP3': {'baseline_cm': 100, 'siaga_cm': 180, 'banjir_cm': 280},
    'UP4': {'baseline_cm': 150, 'siaga_cm': 180, 'banjir_cm': 280},
    'N1': {'baseline_cm': 60, 'siaga_cm': 180, 'banjir_cm': 280},
    'N2': {'baseline_cm': 60, 'siaga_cm': 180, 'banjir_cm': 280},
    'N3': {'baseline_cm': 60, 'siaga_cm': 180, 'banjir_cm': 280},
    'N4': {'baseline_cm': 60, 'siaga_cm': 180, 'banjir_cm': 280},
    'N5': {'baseline_cm': 60, 'siaga_cm': 180, 'banjir_cm': 280},
}
NODE_IDS = tuple(NODES)
STEP_SECONDS = 300
STEPS_PER_DAY = 288
HISTORY_STEPS = 96
HORIZON_STEPS = 12
FEATURES = ('tmaCm', 'rainRateMmH', 'upstreamTmaCm', 'upstreamRainRateMmH')
UPSTREAM = {node: NODE_IDS[max(0, index - 1)] for index, node in enumerate(NODE_IDS)}


def parse_utc(text):
    if not isinstance(text, str):
        raise ValueError('timestamp must be a UTC ISO string')
    try:
        value = datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError as exc:
        raise ValueError('invalid timestamp') from exc
    if value.tzinfo is None or value.utcoffset().total_seconds() != 0:
        raise ValueError('timestamp must specify UTC')
    return value.astimezone(timezone.utc)


def finite(value, name, minimum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{name} must be a finite number, not missing or NaN')
    if minimum is not None and value < minimum:
        raise ValueError(f'{name} must be >= {minimum}')
    return float(value)


def validate_frame(frame):
    if not isinstance(frame, dict) or frame.get('id') not in NODES:
        raise ValueError('unmapped node ID')
    finite(frame.get('tmaCm'), 'tmaCm', 0)
    rate = finite(frame.get('rainRateMmH'), 'rainRateMmH', 0)
    mm = finite(frame.get('rainMm5m'), 'rainMm5m', 0)
    if abs(mm - rate / 12) > 1e-5:
        raise ValueError('5-minute rain depth must equal mm/h divided by 12')
    if frame.get('rainSource') not in ('synthetic', 'synthetic_conditioned_on_daily_rr'):
        raise ValueError('five-minute rain cannot be mislabelled observed')
    if frame.get('tmaSource') != 'synthetic':
        raise ValueError('synthetic TMA must be labelled synthetic')
    return frame
