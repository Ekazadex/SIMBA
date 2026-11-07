import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBmkgForecastContext, parseOpenMeteoContext, createWeatherContextHandler } from '../backend/ciliwung/weather-context.mjs';

// Live BMKG location metadata on 2026-10-11: 1002=Kukusan, 1006=Beji Timur.
const adm4 = '32.76.06.1002';
const issue = '2026-08-01T00:00:00';
function payload(tp) {
  return { lokasi: { adm4, desa: 'Kukusan', kecamatan: 'Beji', kotkab: 'Depok' },
    data: [{ cuaca: [[{ datetime: '2026-08-01T03:00:00Z', local_datetime: '2026-08-01 10:00:00',
      analysis_date: issue, weather_desc: 'Hujan Ringan', t: 27, hu: 80,
      ...(tp === undefined ? {} : { tp }) }]] }] };
}

test('BMKG as-issued village forecast is categorical context, not an observed 5-minute rainfall series', () => {
  const context = parseBmkgForecastContext(payload(), { adm4, asOf: '2026-08-01T04:00:00Z', acquiredAt: '2026-08-01T01:00:00Z' });
  assert.equal(context.source, 'BMKG');
  assert.equal(context.adm4, adm4);
  assert.equal(context.issuedAt, '2026-08-01T00:00:00.000Z');
  assert.equal(context.validFrom, '2026-08-01T03:00:00.000Z');
  assert.equal(context.validTo, '2026-08-01T06:00:00.000Z');
  assert.equal(context.acquiredAt, '2026-08-01T01:00:00Z');
  assert.equal(context.weatherDesc, 'Hujan Ringan');
  assert.equal(context.forecastPrecipitationMm, null);
  assert.equal(context.missingFields.tp, true);
  assert.equal(context.kind, 'forecast_context');
  assert.equal(context.observedRainRateMmH, undefined);
  assert.equal(parseBmkgForecastContext(payload(0), { adm4, asOf: '2026-08-01T04:00:00Z' }).forecastPrecipitationMm, 0);
});

test('later-issued forecast is rejected when queried at an earlier as-of time', () => {
  const result = parseBmkgForecastContext(payload(2), { adm4, asOf: '2026-07-31T23:00:00Z' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'future_issued');
  assert.equal(result.forecastPrecipitationMm, undefined);
  assert.throws(() => parseBmkgForecastContext(payload(3), { adm4: '31.71.03.1001', asOf: '2026-08-01T04:00:00Z' }), /adm4/i);
});

test('Open-Meteo fallback carries different provider, acquisition time and unknown precipitation', () => {
  const result = parseOpenMeteoContext({ current: { time: '2026-08-01T10:00', temperature_2m: 26,
    relative_humidity_2m: 80, weather_code: 3 } }, { acquiredAt: '2026-08-01T03:30:00Z' });
  assert.equal(result.source, 'Open-Meteo');
  assert.equal(result.forecastPrecipitationMm, null);
  assert.equal(result.missingFields.precipitation, true);
  assert.equal(result.acquiredAt, '2026-08-01T03:30:00Z');
  assert.equal(result.kind, 'fallback_weather_context');
});

test('default weather context requests Kukusan rather than adjacent Beji Timur', async () => {
  const fetches = [];
  const handler = createWeatherContextHandler({
    fetchImpl: async (url) => {
      fetches.push(url);
      return { ok: true, json: async () => payload(0.1) };
    },
    now: () => new Date('2026-08-01T04:00:00Z'),
  });
  const response = { body: null, json(body) { this.body = body; return this; } };
  await handler({ query: {} }, response);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0], /adm4=32\.76\.06\.1002$/);
  assert.equal(response.body.location.desa, 'Kukusan');
});

test('context handler fetches BMKG separately from live-weather and labels fallback', async () => {
  const fetches = [];
  const handler = createWeatherContextHandler({ fetchImpl: async (url) => {
    fetches.push(url);
    if (url.includes('bmkg')) throw new Error('unreachable');
    return { ok: true, json: async () => ({ current: { time: '2026-08-01T10:00', temperature_2m: 26 } }) };
  }, now: () => new Date('2026-08-01T03:30:00Z') });
  const response = { body: null, json(body) { this.body = body; return this; } };
  await handler({ query: { adm4 } }, response);
  assert.equal(response.body.source, 'Open-Meteo');
  assert.equal(response.body.forecastPrecipitationMm, null);
  assert.equal(fetches.length, 2);
});
