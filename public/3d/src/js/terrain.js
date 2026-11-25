function elevationAt(terrain, row, column) {
  return terrain.heights[row * terrain.width + column];
}

export function sampleTerrainMeters(terrain, longitude, latitude) {
  const { west, east, north, south } = terrain.bounds;
  const column = Math.max(0, Math.min(terrain.width - 1, (longitude - west) / (east - west) * (terrain.width - 1)));
  const row = Math.max(0, Math.min(terrain.height - 1, (north - latitude) / (north - south) * (terrain.height - 1)));
  const c0 = Math.floor(column);
  const r0 = Math.floor(row);
  const c1 = Math.min(terrain.width - 1, c0 + 1);
  const r1 = Math.min(terrain.height - 1, r0 + 1);
  const tx = column - c0;
  const ty = row - r0;
  const top = elevationAt(terrain, r0, c0) * (1 - tx) + elevationAt(terrain, r0, c1) * tx;
  const bottom = elevationAt(terrain, r1, c0) * (1 - tx) + elevationAt(terrain, r1, c1) * tx;
  return top * (1 - ty) + bottom * ty;
}

export function terrainOrigin(terrain) {
  return {
    longitude: (terrain.bounds.west + terrain.bounds.east) / 2,
    latitude: (terrain.bounds.north + terrain.bounds.south) / 2,
    minimumElevationMeters: terrain.minimumElevationMeters,
  };
}

export function geoToWorld(longitude, latitude, elevationMeters, terrain, verticalExaggeration = terrain.verticalExaggeration ?? 1) {
  const origin = terrainOrigin(terrain);
  const metersPerDegreeLon = 111320 * Math.cos(origin.latitude * Math.PI / 180);
  return {
    x: (longitude - origin.longitude) * metersPerDegreeLon,
    y: (elevationMeters - origin.minimumElevationMeters) * verticalExaggeration,
    z: (origin.latitude - latitude) * 111320,
  };
}

function createChannelCarveDepthField(terrain, centerline, width, height, channelWidthM, channelDepthM, channelBedWidthM, corridorCutoutRadiusM = 0) {
  const depth = new Float32Array(width * height);
  const corridorMask = corridorCutoutRadiusM > 0 ? new Uint8Array(width * height) : null;
  if (!Array.isArray(centerline) || centerline.length < 2) return { depth, corridorMask };
  const midLatitude = (terrain.bounds.north + terrain.bounds.south) / 2;
  const cellWidthM = (terrain.bounds.east - terrain.bounds.west) * 111320 * Math.cos(midLatitude * Math.PI / 180) / (width - 1);
  const cellHeightM = (terrain.bounds.north - terrain.bounds.south) * 111320 / (height - 1);
  const bankHalfWidthM = channelWidthM / 2;
  const bedHalfWidthM = Math.min(bankHalfWidthM, channelBedWidthM / 2);
  const cellDiagonalM = Math.hypot(cellWidthM, cellHeightM);
  const supportRadiusM = bankHalfWidthM + cellDiagonalM * 0.5;
  const searchRadiusM = Math.max(supportRadiusM, corridorCutoutRadiusM);
  const columnRadius = Math.ceil(searchRadiusM / cellWidthM) + 1;
  const rowRadius = Math.ceil(searchRadiusM / cellHeightM) + 1;
  const mapGrid = ([lon, lat]) => ({
    c: (lon - terrain.bounds.west) / (terrain.bounds.east - terrain.bounds.west) * (width - 1),
    r: (terrain.bounds.north - lat) / (terrain.bounds.north - terrain.bounds.south) * (height - 1),
  });

  function profileDepth(distanceM) {
    if (distanceM <= bedHalfWidthM) return channelDepthM;
    if (distanceM <= bankHalfWidthM) {
      const t = (distanceM - bedHalfWidthM) / Math.max(1e-6, bankHalfWidthM - bedHalfWidthM);
      return channelDepthM * (1 - t);
    }
    if (distanceM >= supportRadiusM) return 0;
    const t = (distanceM - bankHalfWidthM) / Math.max(1e-6, supportRadiusM - bankHalfWidthM);
    const antialiasDepthM = Math.min(0.12, channelDepthM * 0.04);
    return antialiasDepthM * (1 - t) * (1 - t);
  }

  function stamp(column, row) {
    const c0 = Math.max(0, Math.floor(column) - columnRadius);
    const c1 = Math.min(width - 1, Math.ceil(column) + columnRadius);
    const r0 = Math.max(0, Math.floor(row) - rowRadius);
    const r1 = Math.min(height - 1, Math.ceil(row) + rowRadius);
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const distanceM = Math.hypot((c - column) * cellWidthM, (r - row) * cellHeightM);
        const index = r * width + c;
        if (corridorMask && distanceM <= corridorCutoutRadiusM) corridorMask[index] = 1;
        const profile = profileDepth(distanceM);
        if (profile > 0) depth[index] = Math.max(depth[index], profile);
      }
    }
  }

  for (let i = 0; i < centerline.length - 1; i += 1) {
    const a = mapGrid(centerline[i]);
    const b = mapGrid(centerline[i + 1]);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.c - a.c), Math.abs(b.r - a.r)) * 2));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      stamp(a.c + (b.c - a.c) * t, a.r + (b.r - a.r) * t);
    }
  }
  return { depth, corridorMask };
}

export function sampleTerrainMeshSurface(mesh, terrain, longitude, latitude) {
  const positions = mesh?.geometry?.getAttribute('position');
  const width = mesh?.userData?.gridWidth;
  const height = mesh?.userData?.gridHeight;
  if (!positions || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new TypeError('mesh must be created by buildTerrainMesh before sampling');
  }
  const bounds = terrain.bounds;
  const column = Math.max(0, Math.min(width - 1, (longitude - bounds.west) / (bounds.east - bounds.west) * (width - 1)));
  const row = Math.max(0, Math.min(height - 1, (bounds.north - latitude) / (bounds.north - bounds.south) * (height - 1)));
  const c0 = Math.min(width - 2, Math.floor(column));
  const r0 = Math.min(height - 2, Math.floor(row));
  const tx = column - c0;
  const ty = row - r0;
  const aIndex = r0 * width + c0;
  const bIndex = aIndex + 1;
  const cIndex = aIndex + width;
  const dIndex = cIndex + 1;
  const pointAt = (index) => ({ x: positions.getX(index), y: positions.getY(index), z: positions.getZ(index) });
  let y;
  let face;
  if (tx + ty <= 1) {
    const a = pointAt(aIndex);
    const b = pointAt(bIndex);
    const c = pointAt(cIndex);
    y = a.y * (1 - tx - ty) + b.y * tx + c.y * ty;
    face = [a, c, b];
  } else {
    const b = pointAt(bIndex);
    const c = pointAt(cIndex);
    const d = pointAt(dIndex);
    y = b.y * (1 - ty) + c.y * (1 - tx) + d.y * (tx + ty - 1);
    face = [b, c, d];
  }
  const [p0, p1, p2] = face;
  const u = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
  const v = { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z };
  let nx = u.y * v.z - u.z * v.y;
  let ny = u.z * v.x - u.x * v.z;
  let nz = u.x * v.y - u.y * v.x;
  const normalLength = Math.hypot(nx, ny, nz) || 1;
  nx /= normalLength;
  ny /= normalLength;
  nz /= normalLength;
  if (ny < 0) { nx *= -1; ny *= -1; nz *= -1; }
  const verticalExaggeration = mesh.userData.verticalExaggeration;
  return {
    worldY: y,
    elevationM: terrain.minimumElevationMeters + y / verticalExaggeration,
    normal: { x: nx, y: ny, z: nz },
  };
}

export function buildTerrainMesh(THREE, terrain, centerline, options = {}) {
  if (!terrain?.heights || terrain.heights.length !== terrain.width * terrain.height) {
    throw new TypeError('terrain must provide a packed elevation array matching width × height');
  }
  const verticalExaggeration = options.verticalExaggeration ?? terrain.verticalExaggeration ?? 1;
  const subdivisions = options.subdivisions ?? 3;
  const stride = Math.max(1, Math.floor(options.stride ?? 1));
  if (!Number.isInteger(subdivisions) || subdivisions < 1 || subdivisions > 4) {
    throw new RangeError('terrain subdivisions must be an integer from 1 to 4');
  }
  const width = stride > 1
    ? Math.max(2, Math.floor((terrain.width - 1) / stride) + 1)
    : (terrain.width - 1) * subdivisions + 1;
  const height = stride > 1
    ? Math.max(2, Math.floor((terrain.height - 1) / stride) + 1)
    : (terrain.height - 1) * subdivisions + 1;
  const channelWidthM = options.channelWidthM ?? 30;
  const channelDepthM = options.channelDepthM ?? 3;
  const channelBedWidthM = options.channelBedWidthM ?? Math.max(1, channelWidthM - 6);
  const corridorCutoutRadiusM = options.corridorCutoutRadiusM ?? 0;
  if (!Number.isFinite(corridorCutoutRadiusM) || corridorCutoutRadiusM < 0) {
    throw new RangeError('corridor cutout radius must be finite and non-negative');
  }
  const { depth: carveDepth, corridorMask } = createChannelCarveDepthField(
    terrain, centerline, width, height, channelWidthM, channelDepthM, channelBedWidthM, corridorCutoutRadiusM,
  );
  const vertexCount = width * height;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  const minElevation = terrain.minimumElevationMeters;
  const range = Math.max(1, terrain.maximumElevationMeters - minElevation);

  for (let row = 0; row < height; row += 1) {
    const latitude = terrain.bounds.north - row / (height - 1) * (terrain.bounds.north - terrain.bounds.south);
    for (let column = 0; column < width; column += 1) {
      const longitude = terrain.bounds.west + column / (width - 1) * (terrain.bounds.east - terrain.bounds.west);
      const sampledElevation = sampleTerrainMeters(terrain, longitude, latitude);
      const vertexIndex = row * width + column;
      const sea = Number.isFinite(options.seaStartLatitude) && latitude >= options.seaStartLatitude;
      const sourceElevation = sea ? (options.seaLevelMeters ?? 0) : sampledElevation;
      const carvedElevation = sourceElevation - (sea ? 0 : carveDepth[vertexIndex]);
      const point = geoToWorld(longitude, latitude, carvedElevation, terrain, verticalExaggeration);
      const positionIndex = vertexIndex * 3;
      positions[positionIndex] = point.x;
      positions[positionIndex + 1] = point.y;
      positions[positionIndex + 2] = point.z;
      if (sea) {
        const shimmer = 0.015 * Math.sin(longitude * 850 + latitude * 910);
        colors[positionIndex] = 0.055 + shimmer;
        colors[positionIndex + 1] = 0.28 + shimmer;
        colors[positionIndex + 2] = 0.37 + shimmer;
      } else {
        const t = Math.max(0, Math.min(1, (carvedElevation - minElevation) / range));
        colors[positionIndex] = 0.27 + 0.23 * t;
        colors[positionIndex + 1] = 0.36 + 0.22 * t;
        colors[positionIndex + 2] = 0.20 + 0.12 * t;
      }
    }
  }

  let indexOffset = 0;
  let corridorCutoutCellCount = 0;
  for (let row = 0; row < height - 1; row += 1) {
    for (let column = 0; column < width - 1; column += 1) {
      const a = row * width + column;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      if (corridorMask && (corridorMask[a] || corridorMask[b] || corridorMask[c] || corridorMask[d])) {
        indices[indexOffset++] = a;
        indices[indexOffset++] = a;
        indices[indexOffset++] = a;
        indices[indexOffset++] = a;
        indices[indexOffset++] = a;
        indices[indexOffset++] = a;
        corridorCutoutCellCount += 1;
        continue;
      }
      indices[indexOffset++] = a;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;
      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'srtm-terrain-with-carved-river-valley';
  mesh.receiveShadow = true;
  mesh.userData.carvedVertexCount = carveDepth.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0);
  mesh.userData.corridorCutoutVertexCount = corridorMask ? corridorMask.reduce((sum, value) => sum + value, 0) : 0;
  mesh.userData.corridorCutoutCellCount = corridorCutoutCellCount;
  mesh.userData.corridorCutoutRadiusM = corridorCutoutRadiusM;
  mesh.userData.maximumCarveDepthM = channelDepthM;
  mesh.userData.verticalExaggeration = verticalExaggeration;
  mesh.userData.subdivisions = subdivisions;
  mesh.userData.gridWidth = width;
  mesh.userData.gridHeight = height;
  mesh.userData.channelWidthM = channelWidthM;
  mesh.userData.channelBedWidthM = channelBedWidthM;
  mesh.userData.sampleSurfaceAt = (longitude, latitude) => sampleTerrainMeshSurface(mesh, terrain, longitude, latitude);
  return mesh;
}
