// Presentation helpers for the Ciliwung hardware graph. No telemetry is modified.
export function validLimits(config, preset) {
  const siaga = preset ? preset.siaga : config?.threshold_siaga;
  const bahaya = preset ? preset.bahaya : config?.threshold_bahaya;
  return typeof siaga === 'number' && typeof bahaya === 'number' && Number.isFinite(siaga) && Number.isFinite(bahaya) && siaga >= 0 && bahaya > siaga ? { siaga, bahaya } : null;
}

export function graphAxisMax(points, forecast, limits) {
  const values = [...points, ...forecast].map(point => point.level).filter(value => Number.isFinite(value) && value >= 0);
  if (limits) values.push(limits.siaga, limits.bahaya);
  return Math.ceil(Math.max(100, ...values) / 20) * 20;
}

// Match the graph's separate history and forecast time scales.
export function graphTimeTicks(start, end, distanceView = false) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const intervals = distanceView ? 8 : 4;
  const width = distanceView ? 600 : 300;
  const ticks = Array.from({ length: intervals + 1 }, (_, index) => ({
    x: 50 + width * index / intervals,
    time: start + (end - start) * index / intervals,
    future: false,
  }));
  if (!distanceView) {
    for (let index = 1; index <= 4; index++) {
      ticks.push({ x: 350 + 300 * index / 4, time: end + 30 * 60_000 * index / 4, future: true });
    }
  }
  return ticks;
}

export function graphCsv(points, node, source, range = '', coverage = '', valueColumn = 'water_level_cm') {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@\t\r]/.test(text) && typeof value !== 'number') text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const distance = valueColumn === 'sensor_distance_cm';
  const rows = [['timestamp_utc', 'node', valueColumn, 'source', 'range', 'coverage', ...(distance ? ['distance_method'] : [])]];
  for (const point of points) {
    if (Number.isFinite(point.time) && Number.isFinite(point.level)) rows.push([new Date(point.time).toISOString(), node, point.level, source, range, coverage, ...(distance ? [point.distanceMethod ?? ''] : [])]);
  }
  return '\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}

export function batchDistances(reading) {
  const batch = Array.isArray(reading?.readings) ? reading.readings : [];
  return batch.flatMap((sample, index) => {
    const distance = sample && typeof sample === 'object' && !Array.isArray(sample) ? sample.distance : undefined;
    return typeof distance === 'number' && Number.isFinite(distance) && distance >= 0 ? [{ index: index + 1, distance }] : [];
  });
}

export function sensorDistance(reading, referenceHeight) {
  const sample = batchDistances(reading).at(-1)?.distance;
  const reported = typeof sample === 'number' ? sample : reading?.distance;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) return { value: reported, method: 'reported' };
  const level = reading?.level ?? reading?.water_level;
  if (typeof referenceHeight === 'number' && Number.isFinite(referenceHeight) && referenceHeight > 0 && typeof level === 'number' && Number.isFinite(level) && level >= 0) {
    return { value: Math.max(0, Math.round((referenceHeight - level) * 10) / 10), method: 'estimated' };
  }
  return null;
}

// Interpolate only screen-space geometry for a short visual transition. The source
// records, selected value and forecast inputs never use these temporary points.
export function interpolateGraphPoints(from, to, progress, samples = 120) {
  if (progress <= 0 || from.length < 2 || to.length < 2) return from;
  if (progress >= 1) return to;
  const sample = (points, fraction) => {
    const at = fraction * (points.length - 1);
    const left = Math.floor(at), right = Math.min(points.length - 1, left + 1), weight = at - left;
    return { x: points[left].x + (points[right].x - points[left].x) * weight, y: points[left].y + (points[right].y - points[left].y) * weight };
  };
  return Array.from({ length: samples }, (_, index) => {
    const fraction = index / (samples - 1), a = sample(from, fraction), b = sample(to, fraction);
    return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress };
  });
}
