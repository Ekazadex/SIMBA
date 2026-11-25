// Demonstration only: estimate a bounded trend from the most recent 3 minutes.
export function projectWaterLevel(history) {
  const valid = history.filter(p => Number.isFinite(p.time) && Number.isFinite(p.level)).sort((a, b) => a.time - b.time);
  const last = valid.at(-1);
  if (!last) return [];
  const recent = valid.filter(p => p.time >= last.time - 3 * 60_000);
  if (recent.length < 2 || last.time - recent[0].time < 60_000) return [];
  // Median pairwise slopes reduce the effect of isolated sensor spikes.
  const slopes = [];
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const minutes = (recent[j].time - recent[i].time) / 60_000;
      if (minutes >= 0.5) slopes.push((recent[j].level - recent[i].level) / minutes);
    }
  }
  if (!slopes.length) return [];
  slopes.sort((a, b) => a - b);
  const middle = Math.floor(slopes.length / 2);
  const slope = slopes.length % 2 ? slopes[middle] : (slopes[middle - 1] + slopes[middle]) / 2;
  const rate = Math.max(-1, Math.min(1, slope));
  return Array.from({ length: 7 }, (_, i) => ({ time: last.time + i * 5 * 60_000, level: Math.max(0, Math.min(1000, last.level + rate * i * 5)) }));
}

// Downstream values are visual presets, so this is an illustrative offset only.
export function projectDownstreamLevel(projection, currentLevel) {
  if (!projection.length || !Number.isFinite(currentLevel)) return [];
  const start = projection[0].level;
  return projection.map(point => ({ ...point, level: Math.max(0, Math.min(1000, currentLevel + point.level - start)) }));
}

// These are illustrative scenarios, not weather measurements or forecasts.
export function illustrativeWeather(level, siaga = 60, bahaya = 90) {
  if (!Number.isFinite(level) || !Number.isFinite(siaga) || !Number.isFinite(bahaya) || bahaya <= siaga) return null;
  if (level >= bahaya) return { description: 'Skenario hujan lebat', temperature: 25, humidity: 90, wind: 18, direction: 'Barat', visibility: '2 km' };
  if (level >= siaga) return { description: 'Skenario hujan sedang', temperature: 27, humidity: 82, wind: 10, direction: 'Barat Daya', visibility: '5 km' };
  return { description: 'Skenario cerah berawan', temperature: 30, humidity: 70, wind: 5, direction: 'Timur', visibility: '10 km' };
}
