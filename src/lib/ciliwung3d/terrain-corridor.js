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
  // Prepend an upstream headwaters valley cap (240m behind row 0) so the SRTM terrain cutout behind UP1 Puncak never reveals sky
  const headCapCount = 8;
  const headCapStepM = 30;
  const headCapLengthM = headCapCount * headCapStepM;
  const startPoint = centerline[0];
  const nextPoint = centerline[Math.min(centerline.length - 1, 1)];
  let initDx = nextPoint.x - startPoint.x;
  let initDz = nextPoint.z - startPoint.z;
  const initLen = Math.hypot(initDx, initDz) || 1;
  initDx /= initLen;
  initDz /= initLen;

  const extendedCenterline = new Array(headCapCount + centerline.length);
  for (let k = 0; k < headCapCount; k += 1) {
    const distBehind = (headCapCount - k) * headCapStepM;
    const x = startPoint.x - initDx * distBehind;
    const z = startPoint.z - initDz * distBehind;
    const geo = worldXZToGeo(x, z, terrain);
    const coarseCenter = sampleTerrainMeshSurface(terrainMesh, terrain, geo.longitude, geo.latitude);
    const blendToCoarse = clamp(distBehind / 150, 0, 1);
    const smooth = blendToCoarse * blendToCoarse * (3 - 2 * blendToCoarse);
    const startBankY = Number.isFinite(startPoint.bankY) ? startPoint.bankY : startPoint.y;
    const bankY = startBankY + (coarseCenter.worldY - startBankY) * smooth;
    extendedCenterline[k] = {
      x,
      z,
      y: bankY,
      bankY,
      _headCapDistBehind: distBehind,
    };
  }
  for (let i = 0; i < centerline.length; i += 1) {
    extendedCenterline[headCapCount + i] = centerline[i];
  }

  const rows = extendedCenterline.length;
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

  // Precompute local frames and smoothed valley normals so wide outer skirts never fold across sharp river bends
  const rawTangents = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const previous = extendedCenterline[Math.max(0, row - 1)];
    const next = extendedCenterline[Math.min(rows - 1, row + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const tangentLength = Math.hypot(dx, dz) || 1;
    rawTangents[row] = { x: dx / tangentLength, z: dz / tangentLength };
  }
  const smoothWindow = 10;
  const smoothNormals = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    let sx = 0;
    let sz = 0;
    const r0 = Math.max(0, row - smoothWindow);
    const r1 = Math.min(rows - 1, row + smoothWindow);
    for (let r = r0; r <= r1; r += 1) {
      sx += rawTangents[r].x;
      sz += rawTangents[r].z;
    }
    const len = Math.hypot(sx, sz) || 1;
    smoothNormals[row] = { x: -sz / len, z: sx / len };
  }

  for (let row = 0; row < rows; row += 1) {
    const point = extendedCenterline[row];
    const tangent = rawTangents[row];
    const localNormal = { x: -tangent.z, z: tangent.x };
    const outerNormal = smoothNormals[row];
    const bankY = Number.isFinite(point.bankY) ? point.bankY : point.y;
    const distBehind = point._headCapDistBehind ?? 0;
    // Taper carved depth smoothly to 0 over 90m behind headwaters so the spring valley closes naturally
    const headDepthFactor = distBehind > 0 ? Math.max(0, 1 - distBehind / 90) : 1;
    const headTerrainBlend = distBehind > 0 ? clamp(distBehind / 140, 0, 1) : 0;
    const headSmoothBlend = headTerrainBlend * headTerrainBlend * (3 - 2 * headTerrainBlend);
    const localChannelDepthM = channelDepthM * headDepthFactor;
    rowFrames[row] = { x: point.x, z: point.z, bankY, tangent, normal: localNormal };

    for (let column = 0; column < columns; column += 1) {
      const offsetM = lateralOffsets[column];
      const distanceM = Math.abs(offsetM);
      // Keep exact local normal inside the river banks, smoothly blend to valley-smoothed normal outside banks
      const normalBlend = distanceM <= bankHalfWidthM
        ? 0
        : clamp((distanceM - bankHalfWidthM) / Math.max(25, blendWidthM * 0.75), 0, 1);
      const nb = normalBlend * normalBlend * (3 - 2 * normalBlend);
      let nx = localNormal.x * (1 - nb) + outerNormal.x * nb;
      let nz = localNormal.z * (1 - nb) + outerNormal.z * nb;
      const nLen = Math.hypot(nx, nz) || 1;
      nx /= nLen;
      nz /= nLen;

      const worldX = point.x + nx * offsetM;
      const worldZ = point.z + nz * offsetM;
      const geo = worldXZToGeo(worldX, worldZ, terrain);
      const coarse = sampleTerrainMeshSurface(terrainMesh, terrain, geo.longitude, geo.latitude);
      let worldY;
      if (distanceM <= bedHalfWidthM) {
        const carvedY = bankY - localChannelDepthM * verticalExaggeration;
        worldY = carvedY + (coarse.worldY - carvedY) * headSmoothBlend;
      } else if (distanceM < bankHalfWidthM) {
        const t = (distanceM - bedHalfWidthM) / Math.max(1e-6, bankHalfWidthM - bedHalfWidthM);
        const carvedY = bankY - localChannelDepthM * (1 - t) * verticalExaggeration;
        worldY = carvedY + (coarse.worldY - carvedY) * headSmoothBlend;
      } else {
        const t = clamp((distanceM - bankHalfWidthM) / blendWidthM, 0, 1);
        const smooth = t * t * (3 - 2 * t);
        const blendedY = bankY + (coarse.worldY - bankY) * smooth;
        worldY = blendedY + (coarse.worldY - blendedY) * headSmoothBlend;
        // Gently tuck the outermost skirt edge slightly beneath terrainMesh so no floating seam appears
        if (actualHalfWidthM - distanceM < 18) {
          const edgeT = clamp(1 - (actualHalfWidthM - distanceM) / 18, 0, 1);
          worldY -= 0.18 * edgeT;
        }
      }
      // Also tuck the very upstream end of the head cap gently beneath terrainMesh
      if (headCapLengthM - distBehind < 24 && distBehind > 0) {
        const capEdgeT = clamp(1 - (headCapLengthM - distBehind) / 24, 0, 1);
        worldY -= 0.18 * capEdgeT;
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

  // Build Z spatial index of centerline segments so outer skirts never cross over a neighboring meander's channel
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

  // Also index tighter channel-only buckets for fast intrusion checks
  const channelClearanceM = bankHalfWidthM + 4;
  const channelClearanceSq = channelClearanceM * channelClearanceM;
  const channelBuckets = Array.from({ length: bucketCount }, () => []);
  for (let row = 1; row < rows; row += 1) {
    const zLow = Math.min(rowFrames[row - 1].z, rowFrames[row].z) - channelClearanceM;
    const zHigh = Math.max(rowFrames[row - 1].z, rowFrames[row].z) + channelClearanceM;
    const b0 = clamp(Math.floor((zLow - minFrameZ) / bucketSpanZ), 0, bucketCount - 1);
    const b1 = clamp(Math.floor((zHigh - minFrameZ) / bucketSpanZ), 0, bucketCount - 1);
    for (let b = b0; b <= b1; b += 1) channelBuckets[b].push(row);
  }

  // Flag outer skirt vertices that intrude into another river bend's channel
  const intrudesChannel = new Uint8Array(vertexCount);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const distanceM = Math.abs(lateralOffsets[column]);
      if (distanceM <= bankHalfWidthM + 2) continue;
      const vIdx = row * columns + column;
      const vx = positions[vIdx * 3];
      const vz = positions[vIdx * 3 + 2];
      const bIdx = clamp(Math.floor((vz - minFrameZ) / bucketSpanZ), 0, bucketCount - 1);
      const segs = channelBuckets[bIdx];
      for (let s = 0; s < segs.length; s += 1) {
        const segRow = segs[s];
        // Ignore segments belonging to this vertex's own immediate river section
        if (Math.abs(segRow - row) <= 3) continue;
        const a = rowFrames[segRow - 1];
        const b = rowFrames[segRow];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lenSq = dx * dx + dz * dz;
        const t = lenSq ? clamp(((vx - a.x) * dx + (vz - a.z) * dz) / lenSq, 0, 1) : 0;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const dSq = (vx - px) * (vx - px) + (vz - pz) * (vz - pz);
        if (dSq < channelClearanceSq) {
          intrudesChannel[vIdx] = 1;
          break;
        }
      }
    }
  }

  // Emit triangles while skipping inverted bend triangles or outer skirts crossing another river reach
  const triValid = (i0, i1, i2) => {
    if (intrudesChannel[i0] || intrudesChannel[i1] || intrudesChannel[i2]) return false;
    const ax = positions[i0 * 3];
    const az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3];
    const bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3];
    const cz = positions[i2 * 3 + 2];
    // Right-handed Y component of (b - a) x (c - a) = (bz - az)*(cx - ax) - (bx - ax)*(cz - az)
    return (bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 1e-4;
  };

  let indexOffset = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      if (triValid(a, b, c)) {
        indices[indexOffset++] = a;
        indices[indexOffset++] = b;
        indices[indexOffset++] = c;
      } else {
        indices[indexOffset++] = a;
        indices[indexOffset++] = a;
        indices[indexOffset++] = a;
      }
      if (triValid(b, d, c)) {
        indices[indexOffset++] = b;
        indices[indexOffset++] = d;
        indices[indexOffset++] = c;
      } else {
        indices[indexOffset++] = b;
        indices[indexOffset++] = b;
        indices[indexOffset++] = b;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  // Ensure every vertex normal points upward so no shading seams turn dark
  const normalAttr = geometry.getAttribute('normal');
  for (let i = 0; i < normalAttr.count; i += 1) {
    if (normalAttr.getY(i) < 0) {
      normalAttr.setXYZ(i, -normalAttr.getX(i), -normalAttr.getY(i), -normalAttr.getZ(i));
    }
  }
  normalAttr.needsUpdate = true;
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    side: THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'high-resolution-srtm-river-valley';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.userData.rows = rows;
  mesh.userData.columns = columns;
  mesh.userData.halfWidthM = actualHalfWidthM;
  mesh.userData.lateralStepM = lateralStepM;
  mesh.userData.channelWidthM = channelWidthM;
  mesh.userData.channelBedWidthM = channelBedWidthM;
  mesh.userData.channelDepthM = channelDepthM;
  mesh.userData.blendWidthM = blendWidthM;
  mesh.userData.centerlineFrames = rowFrames;

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
