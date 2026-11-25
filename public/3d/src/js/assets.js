async function fetchAssetWithTimeout(url, label, timeoutMs = 20000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      signal: controller ? controller.signal : undefined,
    });
    if (!response.ok) throw new Error(`Gagal memuat ${label}: HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Timeout memuat ${label} (> ${Math.round(timeoutMs / 1000)} detik)`);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function loadSceneAssets(baseUrl = './assets/', options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  let completed = 0;
  const track = async (url, label, parse) => {
    const res = await fetchAssetWithTimeout(url, label);
    const data = await parse(res);
    completed += 1;
    onProgress(completed, 5, label);
    return data;
  };

  // Wave 1 (3 small/medium files) then Wave 2 (2 larger files) to avoid HTTP/1.1 6-connection saturation with SSE
  const [terrain, riverAsset, nodeData] = await Promise.all([
    track(`${baseUrl}terrain/terrain.json`, 'terrain', (r) => r.json()),
    track(`${baseUrl}osm/ciliwung_centerline.json`, 'sungai OSM', (r) => r.json()),
    track(`${baseUrl}nodes/nodes.json`, 'stasiun', (r) => r.json()),
  ]);
  const [heightBuffer, environmentData] = await Promise.all([
    track(`${baseUrl}terrain/heightfield.bin`, 'elevasi SRTM', (r) => r.arrayBuffer()),
    track(`${baseUrl}environment/environment.json`, 'bangunan & pohon', (r) => r.json()),
  ]);
  const bytes = new DataView(heightBuffer);
  const heights = new Int16Array(heightBuffer.byteLength / 2);
  for (let i = 0; i < heights.length; i += 1) heights[i] = bytes.getInt16(i * 2, true);
  if (heights.length !== terrain.width * terrain.height) {
    throw new Error(`Heightfield has ${heights.length} cells, expected ${terrain.width * terrain.height}`);
  }
  terrain.heights = heights;
  terrain.minimumElevationMeters = terrain.sourceElevationRangeM[0];
  terrain.maximumElevationMeters = terrain.sourceElevationRangeM[1];
  if (!Array.isArray(riverAsset.coordinates) || riverAsset.coordinates.length < 500) {
    throw new Error('OSM Ciliwung centerline is missing or unexpectedly short');
  }
  const expectedIds = ['UP1', 'UP2', 'UP3', 'UP4', 'N1', 'N2', 'N3', 'N4', 'N5'];
  if (!Array.isArray(nodeData.nodes) || nodeData.nodes.map((node) => node.id).join(',') !== expectedIds.join(',')) {
    throw new Error('Nine ordered, semantic water sensor nodes are required (UP1 through N5)');
  }
  for (const node of nodeData.nodes) {
    const lon = Number(node.longitude);
    const lat = Number(node.latitude);
    if (!(lon > terrain.bounds.west && lon < terrain.bounds.east && lat > terrain.bounds.south && lat < terrain.bounds.north)) {
      throw new RangeError(`${node.id} lies outside the SRTM terrain; cannot edge-clamp source coordinates`);
    }
  }
  if (!Array.isArray(environmentData.buildings) || !Array.isArray(environmentData.trees) || !environmentData.sea?.startLatitude) {
    throw new Error('OSM environment or downstream sea asset is incomplete');
  }
  terrain.seaStartLatitude = environmentData.sea.startLatitude;
  return { terrain, riverAsset, nodeData, environmentData };
}
