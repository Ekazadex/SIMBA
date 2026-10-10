import assert from 'node:assert/strict';
import test from 'node:test';
import { createSocket } from 'node:dgram';
import { parseCupCarbonTelemetry, createCupCarbonTelemetryListener } from '../backend/ciliwung/cupcarbon-telemetry.mjs';

test('parses a telemetry datagram emitted by the active CupCarbon scripts', () => {
  assert.deepEqual(
    parseCupCarbonTelemetry('N5 Pintu Air Manggarai, 281.25, BANJIR_JAKARTA'),
    {
      nodeId: 'N5',
      nodeName: 'N5 Pintu Air Manggarai',
      tmaCm: 281.25,
      status: 'BANJIR_JAKARTA',
    },
  );
});

test('rejects unknown nodes and malformed telemetry without throwing', () => {
  for (const payload of [
    'Unknown Node,60,AMAN',
    'N5 Pintu Air Manggarai,not-a-number,AMAN',
    'N5 Pintu Air Manggarai,60,UNKNOWN',
    'N5 Pintu Air Manggarai,60',
    'N5 Pintu Air Manggarai,60,AMAN,extra',
  ]) {
    assert.equal(parseCupCarbonTelemetry(payload), null);
  }
});

test('UDP listener reports a valid node and marks the stream stale after silence', async () => {
  const telemetry = [];
  const stale = [];
  let resolveTelemetry;
  const telemetrySeen = new Promise((resolve) => { resolveTelemetry = resolve; });
  const listener = createCupCarbonTelemetryListener({
    port: 0,
    staleAfterMs: 40,
    onTelemetry: (entry) => {
      telemetry.push(entry);
      resolveTelemetry();
    },
    onStale: (entry) => stale.push(entry),
  });
  const sender = createSocket('udp4');
  try {
    const address = await listener.listening;
    sender.send(Buffer.from('N1 Pos Depok, 61.5, AMAN'), address.port, '127.0.0.1');
    await telemetrySeen;
    assert.equal(telemetry[0].nodeId, 'N1');
    assert.equal(telemetry[0].tmaCm, 61.5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastTelemetryAt > 0, true);
  } finally {
    sender.close();
    listener.close();
  }
});
