import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const componentPath = new URL('../src/components/CiliwungHardwareLiveView.tsx', import.meta.url);

test('hardware live UI contract exposes 2D default, graph, 3D, fixed map legend, and hardware stream', async () => {
  const source = await readFile(componentPath, 'utf8');
  assert.match(source, /useState<HardwareView>\('map2d'\)/);
  assert.match(source, /hardware-view-map2d/);
  assert.match(source, /hardware-view-graph/);
  assert.match(source, /hardware-view-3d/);
  assert.match(source, /api\/ciliwung-hardware\/stream/);
  assert.match(source, /mode=hardware/);
  assert.match(source, /leaflet/);
  assert.doesNotMatch(source, /L\.polyline\(route/);
  assert.match(source, /L\.polygon/);
  assert.match(source, /ciliwung_centerline\.json/);
  assert.match(source, /maplibreGL/);
  assert.match(source, /delete layout\['icon-image'\]/);
  assert.doesNotMatch(source, /area_overview\.png/);
  assert.match(source, /isLive && showHeat && river/);
  assert.match(source, /menunggu data/);
  assert.match(source, /openstreetmap\.org\/copyright/);
  assert.match(source, /Hujan Ringan/);
  assert.match(source, /Hujan Sedang/);
  assert.match(source, /Hujan Lebat/);
  assert.match(source, /BANJIR/);
  assert.match(source, /perkiraan|indikatif/i);
});

test('hardware live UI does not expose upstream navigation IDs', async () => {
  const source = await readFile(componentPath, 'utf8');
  assert.doesNotMatch(source, /UP1|UP2|UP3|UP4/);
  assert.match(source, /N1/);
  assert.match(source, /N5/);
});
