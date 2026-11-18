export async function loadSceneAssets(baseUrl = './assets/') {
  const [terrainResponse, heightResponse, riverResponse, nodesResponse, environmentResponse] = await Promise.all([
    fetch(`${baseUrl}terrain/terrain.json`),
    fetch(`${baseUrl}terrain/heightfield.bin`),
    fetch(`${baseUrl}osm/ciliwung_centerline.json`),
    fetch(`${baseUrl}nodes/nodes.json`),
    fetch(`${baseUrl}environment/environment.json`),
  ]);
  for (const [name, response] of Object.entries({
    terrain: terrainResponse,
    heightfield: heightResponse,
    river: riverResponse,
    nodes: nodesResponse,
    environment: environmentResponse,
  })) {
    if (!response.ok) throw new Error(`Could not load ${name} asset: HTTP ${response.status}`);
  }
  const [terrain, heightBuffer, riverAsset, nodeData, environmentData] = await Promise.all([
    terrainResponse.json(),
    heightResponse.arrayBuffer(),
    riverResponse.json(),
    nodesResponse.json(),
    environmentResponse.json(),
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
