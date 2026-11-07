// BMKG village predictions are issued forecasts, never gauge observations or 5-minute rainfall.
// Live BMKG metadata (2026-10-11): Kukusan is 32.76.06.1002; 1006 is Beji Timur.
const DEFAULT_ADM4 = '32.76.06.1002';
const ALLOWED_ADM4 = new Set(['32.76.06.1005', DEFAULT_ADM4, '32.76.06.1006']);
const BMKG_PERIOD_MS = 3 * 60 * 60 * 1000;

function parseUtc(value) {
  if (typeof value !== 'string') return NaN;
  const explicitUtc = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  return Date.parse(explicitUtc);
}

export function parseBmkgForecastContext(payload, { adm4 = DEFAULT_ADM4, asOf = new Date().toISOString(), acquiredAt = new Date().toISOString() } = {}) {
  if (payload?.lokasi?.adm4 !== adm4) throw new RangeError('BMKG adm4 mismatch');
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) throw new RangeError('Invalid as-of timestamp');
  const rows = payload?.data?.flatMap((entry) => Array.isArray(entry.cuaca) ? entry.cuaca.flat() : []) || [];
  const candidates = rows.filter((row) => Number.isFinite(parseUtc(row.analysis_date)) &&
    Number.isFinite(Date.parse(row.datetime)) && typeof row.weather_desc === 'string');
  if (!candidates.length) return { source: 'BMKG', adm4, status: 'unavailable', reason: 'invalid_payload', acquiredAt };
  if (candidates.every((row) => parseUtc(row.analysis_date) > cutoff)) {
    return { source: 'BMKG', adm4, status: 'unavailable', reason: 'future_issued', acquiredAt };
  }
  // Only a forecast available at the as-of instant may be shown. Never backfill a historical example.
  const eligible = candidates.filter((row) => parseUtc(row.analysis_date) <= cutoff);
  const valid = eligible.filter((row) => Date.parse(row.datetime) <= cutoff && cutoff < Date.parse(row.datetime) + BMKG_PERIOD_MS);
  const upcoming = eligible.filter((row) => Date.parse(row.datetime) > cutoff);
  const row = valid.sort((a, b) => parseUtc(b.analysis_date) - parseUtc(a.analysis_date))[0] ||
    upcoming.sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime))[0];
  if (!row) return { source: 'BMKG', adm4, status: 'unavailable', reason: 'out_of_window', acquiredAt };
  const tp = typeof row.tp === 'number' && Number.isFinite(row.tp) && row.tp >= 0 ? row.tp : null;
  return {
    source: 'BMKG', kind: 'forecast_context', status: 'available', adm4,
    location: payload.lokasi, issuedAt: new Date(parseUtc(row.analysis_date)).toISOString(),
    validFrom: new Date(row.datetime).toISOString(),
    validTo: new Date(Date.parse(row.datetime) + BMKG_PERIOD_MS).toISOString(),
    acquiredAt, weatherDesc: row.weather_desc,
    forecastPrecipitationMm: tp, missingFields: { tp: tp === null },
  };
}

export function parseOpenMeteoContext(payload, { acquiredAt = new Date().toISOString() } = {}) {
  const current = payload?.current;
  if (!current || typeof current.time !== 'string') throw new RangeError('Invalid Open-Meteo current payload');
  const date = Date.parse(`${current.time}:00+07:00`.replace(/:00:00\+07:00$/, ':00+07:00'));
  const precipitation = typeof current.precipitation === 'number' && Number.isFinite(current.precipitation) && current.precipitation >= 0
    ? current.precipitation : null;
  return {
    source: 'Open-Meteo', kind: 'fallback_weather_context', status: 'available', adm4: DEFAULT_ADM4,
    acquiredAt, validFrom: Number.isFinite(date) ? new Date(date).toISOString() : null,
    validTo: Number.isFinite(date) && Number.isFinite(current.interval) ? new Date(date + current.interval * 1000).toISOString() : null,
    issuedAt: null, weatherCode: current.weather_code ?? null,
    forecastPrecipitationMm: precipitation, missingFields: { precipitation: precipitation === null },
  };
}

export function createWeatherContextHandler({ fetchImpl = fetch, now = () => new Date() } = {}) {
  return async (request, response) => {
    const adm4 = request.query?.adm4 || DEFAULT_ADM4;
    if (!ALLOWED_ADM4.has(adm4)) return response.status(400).json({ status: 'unavailable', reason: 'unsupported_adm4' });
    const acquiredAt = now().toISOString();
    try {
      const result = await fetchImpl(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${adm4}`, { signal: AbortSignal.timeout(6000) });
      if (!result.ok) throw new Error('BMKG unavailable');
      const context = parseBmkgForecastContext(await result.json(), { adm4, asOf: acquiredAt, acquiredAt });
      if (context.status === 'available') return response.json(context);
    } catch { /* Explicitly separate fallback provider, never call its data BMKG. */ }
    try {
      const result = await fetchImpl('https://api.open-meteo.com/v1/forecast?latitude=-6.4025&longitude=106.7942&current=temperature_2m,relative_humidity_2m,precipitation,weather_code&timezone=Asia/Jakarta', { signal: AbortSignal.timeout(6000) });
      if (!result.ok) throw new Error('Open-Meteo unavailable');
      return response.json(parseOpenMeteoContext(await result.json(), { acquiredAt }));
    } catch {
      return response.status(503).json({ status: 'unavailable', reason: 'weather_sources_unavailable', acquiredAt });
    }
  };
}
