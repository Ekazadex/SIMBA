import heightfieldUrl from './data/heightfield.bin?url';

export interface CiliwungLoadedAssets {
  terrain: {
    width: number;
    height: number;
    bounds: { west: number; east: number; south: number; north: number };
    sourceElevationRangeM: [number, number];
    verticalExaggeration?: number;
    heights: Int16Array;
    minimumElevationMeters: number;
    maximumElevationMeters: number;
    seaStartLatitude: number;
  };
  riverAsset: {
    coordinates: Array<[number, number]>;
  };
  nodeData: {
    nodes: Array<{
      id: string;
      name: string;
      longitude: number;
      latitude: number;
      [key: string]: unknown;
    }>;
  };
  environmentData: {
    buildings: Array<Record<string, unknown>>;
    trees: Array<Record<string, unknown>>;
    sea: { startLatitude: number; elevationM?: number };
    riverOutlet: { longitude: number; latitude: number };
  };
}

let cachedAssetsPromise: Promise<CiliwungLoadedAssets> | null = null;

async function fetchHeightfieldBuffer(): Promise<ArrayBuffer> {
  const candidates = [heightfieldUrl, '/3d/assets/terrain/heightfield.bin'];
  let lastError: unknown = null;
  for (const url of candidates) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} saat memuat heightfield`);
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        throw new Error('Heightfield mengembalikan HTML alih-alih data biner');
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 100000) {
        throw new Error(`Ukuran heightfield tidak valid (${buffer.byteLength} bytes)`);
      }
      return buffer;
    } catch (err) {
      lastError = err;
    } finally {
      if (timer != null) window.clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Gagal memuat data elevasi SRTM');
}

export function loadCiliwung3DAssets(): Promise<CiliwungLoadedAssets> {
  if (cachedAssetsPromise) return cachedAssetsPromise;

  cachedAssetsPromise = (async () => {
    const [terrainMod, riverMod, nodesMod, envMod, heightBuffer] = await Promise.all([
      import('./data/terrain.json'),
      import('./data/ciliwung_centerline.json'),
      import('./data/nodes.json'),
      import('./data/environment.json'),
      fetchHeightfieldBuffer(),
    ]);

    const terrainRaw = (terrainMod.default ?? terrainMod) as any;
    const riverAsset = (riverMod.default ?? riverMod) as any;
    const nodeData = (nodesMod.default ?? nodesMod) as any;
    const environmentData = (envMod.default ?? envMod) as any;

    const bytes = new DataView(heightBuffer);
    const heights = new Int16Array(heightBuffer.byteLength / 2);
    for (let i = 0; i < heights.length; i += 1) {
      heights[i] = bytes.getInt16(i * 2, true);
    }
    if (heights.length !== terrainRaw.width * terrainRaw.height) {
      throw new Error(`Heightfield mismatch: ${heights.length} vs ${terrainRaw.width * terrainRaw.height}`);
    }

    const terrain = {
      ...terrainRaw,
      heights,
      minimumElevationMeters: terrainRaw.sourceElevationRangeM[0],
      maximumElevationMeters: terrainRaw.sourceElevationRangeM[1],
      seaStartLatitude: environmentData.sea.startLatitude,
    };

    return { terrain, riverAsset, nodeData, environmentData };
  })().catch((error) => {
    cachedAssetsPromise = null;
    throw error;
  });

  return cachedAssetsPromise;
}
