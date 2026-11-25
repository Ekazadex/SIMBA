import terrainMeta from './data/terrain.json';
import riverAsset from './data/ciliwung_centerline.json';
import nodeData from './data/nodes.json';
import environmentData from './data/environment.json';
import { HEIGHTFIELD_WIDTH, HEIGHTFIELD_HEIGHT, HEIGHTFIELD_BASE64 } from './data/heightfield.js';

let cachedAssets = null;

function decodeInt16Base64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const heights = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < heights.length; i += 1) {
    heights[i] = view.getInt16(i * 2, true);
  }
  return heights;
}

export function getEmbeddedCiliwungAssets() {
  if (cachedAssets) return cachedAssets;
  const heights = decodeInt16Base64(HEIGHTFIELD_BASE64);
  const terrain = {
    ...terrainMeta,
    width: HEIGHTFIELD_WIDTH,
    height: HEIGHTFIELD_HEIGHT,
    heights,
    minimumElevationMeters: terrainMeta.sourceElevationRangeM[0],
    maximumElevationMeters: terrainMeta.sourceElevationRangeM[1],
    seaStartLatitude: environmentData.sea.startLatitude,
  };
  cachedAssets = { terrain, riverAsset, nodeData, environmentData };
  return cachedAssets;
}
