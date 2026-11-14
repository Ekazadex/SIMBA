export function normalizeReading(data, referenceHeight = 300) {
  if (!data) return null;
  if (typeof data.water_level === 'number' && Number.isFinite(data.water_level)) return data;
  const readings = Array.isArray(data.readings) ? data.readings : [];
  const sample = [...readings].reverse().find((item) => item && typeof item.distance === 'number' && Number.isFinite(item.distance) && item.distance >= 0);
  const reference = Number(referenceHeight);
  if (!sample || !Number.isFinite(reference) || reference <= 0) return null;
  return { ...data, distance: Math.round(sample.distance * 10) / 10, water_level: Math.max(0, Math.round((reference - sample.distance) * 10) / 10) };
}
