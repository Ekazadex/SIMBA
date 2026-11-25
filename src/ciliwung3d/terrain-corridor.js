import { geoToWorld, sampleTerrainMeshSurface, sampleTerrainMeters } from './terrain.js';

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function worldXZToGeo(x, z, terrain) {
  const latitude0 = (terrain.bounds.north + terrain.bounds.south) / 2;
  const longitude0 = (terrain.bounds.west + terrain.bounds.east) / 2;
  const metersPerDegreeLongitude = 111320 * Math.cos(latitude0 * Math.PI / 180);
  return {
    longitude: longitude0 + x / metersPerDegreeLongitude,
    latitude: latitude0 - z / 111320,
  };
}

function elevationColor(elevationMeters, terrain) {
  const range = Math.max(1, terrain.maximumElevationMeters - terrain.minimumElevationMeters);
  const t = clamp((elevationMeters - terrain.minimumElevationMeters) / range, 0, 1);
  return [0.27 + 0.23 * t, 0.36 + 0.22 * t, 0.20 + 0.12 * t];
}

/**
 * Replace the coarse SRTM triangulation around the channel with a narrow-cell
 * corridor surface. The broad terrain remains SRTM; only the river valley is
 * rebuilt at a resolution that can actually represent its banks and bed.
 */
export function buildRiverCorridorMesh(THREE, terrainMesh, terrain, centerline, options = {}) {
  if (!terrainMesh?.geometry || !Array.isArray(centerline) || centerline.length < 2) {
    throw new TypeError('terrain mesh and at least two river centerline points are required');
  }
  const verticalExaggeration = options.verticalExaggeration ?? terrain.verticalExaggeration ?? 1;
  const channelWidthM = options.channelWidthM ?? 30;
  const channelBedWidthM = options.channelBedWidthM ?? Math.max(1, channelWidthM - 6);
  const channelDepthM = options.channelDepthM ?? 3;
  const halfWidthM = options.halfWidthM ?? 80;
  const lateralStepM = options.lateralStepM ?? 2;
  const blendWidthM = options.blendWidthM ?? 35;
  if (![verticalExaggeration, channelWidthM, channelBedWidthM, channelDepthM, halfWidthM, lateralStepM, blendWidthM].every(Number.isFinite)
    || verticalExaggeration <= 0 || channelWidthM <= 0 || channelBedWidthM <= 0 || channelDepthM <= 0
    || halfWidthM <= channelWidthM / 2 || lateralStepM <= 0 || blendWidthM <= 0) {
    throw new RangeError('river corridor dimensions must be finite and positive, with half-width beyond the channel bank');
  }
  const rows = centerline.length;
  let lateralOffsets;
  if (options.adaptiveStep) {
    const innerLimit = Math.max(channelWidthM * 0.5 + 15, 30);
    const innerStep = 3;
    const outerStep = 15;
    const positive = [0];
    for (let d = innerStep; d <= innerLimit; d += innerStep) positive.push(d);
    for (let d = positive[positive.length - 1] + outerStep; d < halfWidthM; d += outerStep) positive.push(d);
    if (positive[positive.length - 1] < halfWidthM) positive.push(halfWidthM);
    lateralOffsets = [...positive.slice(1).reverse().map((v) => -v), ...positive];
  } else {
    const halfColumns = Math.ceil(halfWidthM / lateralStepM);
    const actualHalf = halfColumns * lateralStepM;
    lateralOffsets = Array.from({ length: halfColumns * 2 + 1 }, (_, c) => -actualHalf + c * lateralStepM);
  }
  const columns = lateralOffsets.length;
  const actualHalfWidthM = Math.abs(lateralOffsets[columns - 1]);
  const bedHalfWidthM = Math.min(channelWidthM / 2, channelBedWidthM / 2);
  const bankHalfWidthM = channelWidthM / 2;
  const vertexCount = rows * columns;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array((rows - 1) * (columns - 1) * 6);
  const rowFrames = new Array(rows);

  for (let row = 0; row < rows; row += 1) {
    const point = centerline[row];
    const previous = centerline[Math.max(0, row - 1)];
    const next = centerline[Math.min(rows - 1, row + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const tangentLength = Math.hypot(dx, dz) || 1;
    const tangent = { x: dx / tangentLength, z: dz / tangentLength };
    const normal = { x: -tangent.z, z: tangent.x };
    const bankY = Number.isFinite(point.bankY) ? point.bankY : point.y;
    rowFrames[row] = { x: point.x, z: point.z, bankY, tangent, normal };

    for (let column = 0; column < columns; column += 1) {
      const offsetM = lateralOffsets[column];
      const distanceM = Math.abs(offsetM);
      const worldX = point.x + normal.x * offsetM;
      const worldZ = point.z + normal.z * offsetM;
      const geo = worldXZToGeo(worldX, worldZ, terrain);
      const coarse = sampleTerrainMeshSurface(terrainMesh, terrain, geo.longitude, geo.latitude);
      let worldY;
      if (distanceM <= bedHalfWidthM) {
        worldY = bankY - channelDepthM * verticalExaggeration;
      } else if (distanceM < bankHalfWidthM) {
        const t = (distanceM - bedHalfWidthM) / Math.max(1e-6, bankHalfWidthM - bedHalfWidthM);
        worldY = bankY - channelDepthM * (1 - t) * verticalExaggeration;
      } else {
        const t = clamp((distanceM - bankHalfWidthM) / blendWidthM, 0, 1);
        const smooth = t * t * (3 - 2 * t);
        worldY = bankY + (coarse.worldY - bankY) * smooth;
      }
      const vertexIndex = row * columns + column;
      const positionIndex = vertexIndex * 3;
      positions[positionIndex] = worldX;
      positions[positionIndex + 1] = worldY;
      positions[positionIndex + 2] = worldZ;
      const elevationMeters = terrain.minimumElevationMeters + worldY / verticalExaggeration;
      const color = elevationColor(elevationMeters, terrain);
      colors[positionIndex] = color[0];
      colors[positionIndex + 1] = color[1];
      colors[positionIndex + 2] = color[2];
    }
  }

  let indexOffset = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices[indexOffset++] = a;
      indices[indexOffset++] = b;
      indices[indexOffset++] = c;
      indices[indexOffset++] = b;
      indices[indexOffset++] = d;
      indices[indexOffset++] = c;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'high-resolution-srtm-river-valley';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.userData.rows = rows;
  mesh.userData.columns = columns;
  mesh.userData.halfWidthM = actualHalfWidthM;
  mesh.userData.lateralStepM = lateralStepM;
  mesh.userData.channelWidthM = channelWidthM;
  mesh.userData.channelBedWidthM = channelBedWidthM;
  mesh.userData.channelDepthM = channelDepthM;
  mesh.userData.blendWidthM = blendWidthM;
  mesh.userData.centerlineFrames = rowFrames;

  let minFrameZ = Infinity;
  let maxFrameZ = -Infinity;
  for (let i = 0; i < rows; i += 1) {
    if (rowFrames[i].z < minFrameZ) minFrameZ = rowFrames[i].z;
    if (rowFrames[i].z > maxFrameZ) maxFrameZ = rowFrames[i].z;
  }
  const bucketCount = 64;
  const bucketSpanZ = Math.max(1, (maxFrameZ - minFrameZ) / bucketCount);
  const zBuckets = Array.from({ length: bucketCount }, () => []);
  for (let row = 1; row < rows; row += 1) {
    const zLow = Math.min(rowFrames[row - 1].z, rowFrames[row].z) - actualHalfWidthM;
    const zHigh = Math.max(rowFrames[row - 1].z, rowFrames[row].z) + actualHalfWidthM;
    const b0 = clamp(Math.floor((zLow - minFrameZ) / bucketSpanZ), 0, bucketCount - 1);
    const b1 = clamp(Math.floor((zHigh - minFrameZ) / bucketSpanZ), 0, bucketCount - 1);
    for (let b = b0; b <= b1; b += 1) zBuckets[b].push(row);
  }

  function sampleSurfaceAt(longitude, latitude) {
    const sourceElevation = sampleTerrainMeters(terrain, longitude, latitude);
    const query = geoToWorld(longitude, latitude, sourceElevation, terrain, verticalExaggeration);
    if (query.z < minFrameZ - actualHalfWidthM || query.z > maxFrameZ + actualHalfWidthM) return null;
    const bucketIndex = clamp(Math.floor((query.z - minFrameZ) / bucketSpanZ), 0, bucketCount - 1);
    const candidateRowsList = zBuckets[bucketIndex];
    if (!candidateRowsList.length) return null;
    let best = { distanceSquared: Infinity, row: 0, t: 0, x: 0, z: 0, tangent: { x: 1, z: 0 } };
    for (let idx = 0; idx < candidateRowsList.length; idx += 1) {
      const row = candidateRowsList[idx];
      const a = rowFrames[row - 1];
      const b = rowFrames[row];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSquared = dx * dx + dz * dz;
      const t = lengthSquared ? clamp(((query.x - a.x) * dx + (query.z - a.z) * dz) / lengthSquared, 0, 1) : 0;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const distanceSquared = (query.x - x) ** 2 + (query.z - z) ** 2;
      if (distanceSquared < best.distanceSquared) {
        const length = Math.sqrt(lengthSquared) || 1;
        best = { distanceSquared, row: row - 1, t, x, z, tangent: { x: dx / length, z: dz / length } };
      }
    }
    if (!Number.isFinite(best.distanceSquared)) return null;
    const signedOffsetM = (query.x - best.x) * -best.tangent.z + (query.z - best.z) * best.tangent.x;
    if (Math.abs(signedOffsetM) > actualHalfWidthM) return null;
    const row = best.row;
    const positionAttribute = geometry.getAttribute('position');
    const barycentric = (i0, i1, i2) => {
      const x0 = positionAttribute.getX(i0), z0 = positionAttribute.getZ(i0);
      const x1 = positionAttribute.getX(i1), z1 = positionAttribute.getZ(i1);
      const x2 = positionAttribute.getX(i2), z2 = positionAttribute.getZ(i2);
      const denominator = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
      if (Math.abs(denominator) < 1e-9) return null;
      const w0 = ((z1 - z2) * (query.x - x2) + (x2 - x1) * (query.z - z2)) / denominator;
      const w1 = ((z2 - z0) * (query.x - x2) + (x0 - x2) * (query.z - z2)) / denominator;
      const w2 = 1 - w0 - w1;
      if (Math.min(w0, w1, w2) < -1e-4) return null;
      return [[i0, w0], [i1, w1], [i2, w2]];
    };
    let weights = null;
    for (let radius = 0; radius <= 3 && !weights; radius += 1) {
      const candidateRows = radius === 0 ? [best.row] : [best.row - radius, best.row + radius];
      for (const candidateRow of candidateRows) {
        if (candidateRow < 0 || candidateRow >= rows - 1 || weights) continue;
        for (let column = 0; column < columns - 1 && !weights; column += 1) {
          const a = candidateRow * columns + column;
          const b = a + 1;
          const c = a + columns;
          const d = c + 1;
          weights = barycentric(a, b, c) ?? barycentric(b, d, c);
        }
      }
    }
    if (!weights) return null;
    let worldY = 0;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    const normalAttribute = geometry.getAttribute('normal');
    for (const [index, weight] of weights) {
      worldY += positions[index * 3 + 1] * weight;
      nx += normalAttribute.getX(index) * weight;
      ny += normalAttribute.getY(index) * weight;
      nz += normalAttribute.getZ(index) * weight;
    }
    const normalLength = Math.hypot(nx, ny, nz) || 1;
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
    if (ny < 0) { nx *= -1; ny *= -1; nz *= -1; }
    return {
      worldY,
      elevationM: terrain.minimumElevationMeters + worldY / verticalExaggeration,
      normal: { x: nx, y: ny, z: nz },
    };
  }

  mesh.userData.sampleSurfaceAt = sampleSurfaceAt;
  return { mesh, sampleSurfaceAt };
}
