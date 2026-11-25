import { geoToWorld, sampleTerrainMeters } from './terrain.js';

const METERS_PER_DEGREE = 111320;

function segmentDistance(a, b) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function distanceFromSegment(point, start, end) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const denominator = dx * dx + dz * dz;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / denominator));
  return Math.hypot(point.x - start.x - dx * t, point.z - start.z - dz * t);
}

function simplifyRiverPoints(points, toleranceM) {
  if (points.length <= 2 || toleranceM <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [startIndex, endIndex] = stack.pop();
    let farthestIndex = -1;
    let farthestDistance = toleranceM;
    for (let i = startIndex + 1; i < endIndex; i += 1) {
      const distance = distanceFromSegment(points[i], points[startIndex], points[endIndex]);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = i;
      }
    }
    if (farthestIndex >= 0) {
      keep[farthestIndex] = 1;
      stack.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function interpolatePoint(a, b, t) {
  const point = { ...a };
  for (const key of Object.keys(a)) {
    if (Number.isFinite(a[key]) && Number.isFinite(b[key])) point[key] = a[key] + (b[key] - a[key]) * t;
  }
  if (t >= 1) return { ...b };
  return point;
}

export function resampleRiverPoints(inputPoints, options = {}) {
  if (!Array.isArray(inputPoints) || inputPoints.length < 2) throw new TypeError('river resampling needs at least two points');
  const maxSegmentLengthM = options.maxSegmentLengthM ?? 30;
  const simplifyToleranceM = options.simplifyToleranceM ?? 5;
  if (!(maxSegmentLengthM > 0) || !(simplifyToleranceM >= 0)) throw new RangeError('river resampling distances must be non-negative and maxSegmentLengthM positive');
  const clean = [inputPoints[0]];
  for (const point of inputPoints.slice(1)) {
    if (segmentDistance(clean.at(-1), point) > 0.05) clean.push(point);
    else clean[clean.length - 1] = point;
  }
  if (clean.length < 2) throw new RangeError('river resampling requires two distinct points');
  const simplified = simplifyRiverPoints(clean, simplifyToleranceM);
  const result = [simplified[0]];
  for (let i = 0; i < simplified.length - 1; i += 1) {
    const a = simplified[i];
    const b = simplified[i + 1];
    const count = Math.max(1, Math.ceil(segmentDistance(a, b) / maxSegmentLengthM));
    for (let j = 1; j <= count; j += 1) result.push(interpolatePoint(a, b, j / count));
  }
  return result;
}

export function roundRiverCorners(inputPoints, options = {}) {
  if (!Array.isArray(inputPoints) || inputPoints.length < 2) throw new TypeError('river corner rounding needs at least two points');
  const minimumRadiusM = options.minimumRadiusM ?? 18;
  const cornerAngleDeg = options.cornerAngleDeg ?? 75;
  const maxCutFraction = options.maxCutFraction ?? 0.4;
  if (!(minimumRadiusM > 0) || !(cornerAngleDeg > 0 && cornerAngleDeg < 180) || !(maxCutFraction > 0 && maxCutFraction < 0.5)) {
    throw new RangeError('river corner rounding parameters are outside their valid ranges');
  }
  const result = [inputPoints[0]];
  for (let i = 1; i < inputPoints.length - 1; i += 1) {
    const previous = inputPoints[i - 1];
    const current = inputPoints[i];
    const next = inputPoints[i + 1];
    const incomingLength = segmentDistance(previous, current);
    const outgoingLength = segmentDistance(current, next);
    if (incomingLength < 0.05 || outgoingLength < 0.05) continue;
    const incomingX = (current.x - previous.x) / incomingLength;
    const incomingZ = (current.z - previous.z) / incomingLength;
    const outgoingX = (next.x - current.x) / outgoingLength;
    const outgoingZ = (next.z - current.z) / outgoingLength;
    const turnDegrees = Math.abs(Math.atan2(incomingX * outgoingZ - incomingZ * outgoingX, incomingX * outgoingX + incomingZ * outgoingZ)) * 180 / Math.PI;
    if (turnDegrees < cornerAngleDeg) {
      result.push(current);
      continue;
    }
    const cutIn = Math.min(minimumRadiusM, incomingLength * maxCutFraction);
    const cutOut = Math.min(minimumRadiusM, outgoingLength * maxCutFraction);
    const before = interpolatePoint(previous, current, 1 - cutIn / incomingLength);
    const after = interpolatePoint(current, next, cutOut / outgoingLength);
    if (segmentDistance(result.at(-1), before) > 0.05) result.push(before);
    if (segmentDistance(result.at(-1), after) > 0.05) result.push(after);
  }
  const last = inputPoints.at(-1);
  if (segmentDistance(result.at(-1), last) > 0.05) result.push(last);
  return result;
}

export function extendRiverMouth(inputPoints, options = {}) {
  if (!Array.isArray(inputPoints) || inputPoints.length < 2) throw new TypeError('river mouth extension needs at least two points');
  const lengthM = options.lengthM ?? 300;
  const maxSegmentLengthM = options.maxSegmentLengthM ?? 30;
  if (!(lengthM > 0 && maxSegmentLengthM > 0)) throw new RangeError('river mouth extension distances must be positive');
  const end = inputPoints.at(-1);
  let priorIndex = inputPoints.length - 2;
  while (priorIndex >= 0 && segmentDistance(inputPoints[priorIndex], end) <= 0.05) priorIndex -= 1;
  if (priorIndex < 0) throw new RangeError('river mouth extension needs a non-zero terminal direction');
  const prior = inputPoints[priorIndex];
  const dx = end.x - prior.x;
  const dz = end.z - prior.z;
  const length = Math.hypot(dx, dz);
  const count = Math.ceil(lengthM / maxSegmentLengthM);
  const latitudeScale = METERS_PER_DEGREE;
  const longitudeScale = METERS_PER_DEGREE * Math.cos((end.latitude ?? 0) * Math.PI / 180);
  const result = [...inputPoints];
  for (let i = 1; i <= count; i += 1) {
    const distance = lengthM * i / count;
    const x = end.x + dx / length * distance;
    const z = end.z + dz / length * distance;
    const longitude = Number.isFinite(end.longitude) ? end.longitude + (x - end.x) / longitudeScale : end.longitude;
    const latitude = Number.isFinite(end.latitude) ? end.latitude - (z - end.z) / latitudeScale : end.latitude;
    const point = { ...end, x, z, longitude, latitude, inSea: true };
    if (Number.isFinite(options.outletY)) {
      point.y = options.outletY;
      point.groundY = options.outletY;
      point.bankY = options.outletY;
      point.leftGroundY = options.outletY - 0.2;
      point.rightGroundY = options.outletY - 0.2;
      point.baseWaterY = options.outletY + (options.waterSurfaceOffsetM ?? 0.08);
    }
    result.push(point);
  }
  return result;
}

export function computeRiverFrames(points, miterLimit = 1.75) {
  if (!Array.isArray(points) || points.length < 2) throw new TypeError('river frame construction needs at least two points');
  if (!(miterLimit >= 1)) throw new RangeError('miterLimit must be at least 1');
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    let incomingX = point.x - previous.x;
    let incomingZ = point.z - previous.z;
    let outgoingX = next.x - point.x;
    let outgoingZ = next.z - point.z;
    let incomingLength = Math.hypot(incomingX, incomingZ);
    let outgoingLength = Math.hypot(outgoingX, outgoingZ);
    if (incomingLength < 1e-6) {
      incomingX = outgoingX;
      incomingZ = outgoingZ;
      incomingLength = outgoingLength;
    }
    if (outgoingLength < 1e-6) {
      outgoingX = incomingX;
      outgoingZ = incomingZ;
      outgoingLength = incomingLength;
    }
    incomingX /= incomingLength || 1;
    incomingZ /= incomingLength || 1;
    outgoingX /= outgoingLength || 1;
    outgoingZ /= outgoingLength || 1;
    const incomingNormalX = -incomingZ;
    const incomingNormalZ = incomingX;
    const outgoingNormalX = -outgoingZ;
    const outgoingNormalZ = outgoingX;
    let nx = incomingNormalX + outgoingNormalX;
    let nz = incomingNormalZ + outgoingNormalZ;
    const normalLength = Math.hypot(nx, nz);
    if (normalLength < 1e-6) {
      nx = outgoingNormalX;
      nz = outgoingNormalZ;
    } else {
      nx /= normalLength;
      nz /= normalLength;
    }
    const denominator = nx * outgoingNormalX + nz * outgoingNormalZ;
    const rawScale = denominator > 1e-6 ? 1 / denominator : miterLimit;
    return { nx, nz, miterScale: Math.max(1, Math.min(miterLimit, rawScale)) };
  });
}

function createStrip(THREE, firstEdge, secondEdge, material, name) {
  const positions = [];
  const indices = [];
  for (let i = 0; i < firstEdge.length; i += 1) {
    const a = firstEdge[i];
    const b = secondEdge[i];
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    if (i < firstEdge.length - 1) {
      const k = i * 2;
      indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = name !== 'water-surface';
  mesh.receiveShadow = true;
  return mesh;
}

function edgeAt(centerline, normalOffset, yAt, useMiter = true) {
  return centerline.map((point, index) => {
    const frame = point.frame;
    const offset = normalOffset * (useMiter ? frame.miterScale : 1);
    return {
      x: point.x + frame.nx * offset,
      y: yAt(point, index),
      z: point.z + frame.nz * offset,
    };
  });
}

export function buildRiverGeometry(THREE, inputPoints, options = {}) {
  if (!Array.isArray(inputPoints) || inputPoints.length < 2) throw new TypeError('river centerline needs at least two points');
  const channelWidthM = options.channelWidthM ?? 30;
  const channelDepthM = options.channelDepthM ?? 3;
  const channelBedWidthM = options.bedWidthM ?? Math.max(1, channelWidthM - 6);
  const baseWaterDepthM = options.baseWaterDepthM ?? 1.2;
  const apronHalfWidthM = options.apronHalfWidthM ?? channelWidthM / 2;
  const verticalExaggeration = options.verticalExaggeration ?? 1;
  const halfWidth = channelWidthM / 2;
  const bedHalfWidth = channelBedWidthM / 2;
  if (!(channelBedWidthM > 0 && channelBedWidthM < channelWidthM)) throw new RangeError('channel bed width must be positive and narrower than the bank crest');
  const freeboardM = Math.max(0, channelDepthM - baseWaterDepthM);
  const outletWaterY = options.outletWaterY;
  const outletTransitionM = options.outletTransitionM ?? 900;
  if (!(outletTransitionM > 0)) throw new RangeError('outletTransitionM must be positive');
  const cumulativeDistanceM = new Float64Array(inputPoints.length);
  for (let i = 1; i < inputPoints.length; i += 1) {
    cumulativeDistanceM[i] = cumulativeDistanceM[i - 1] + segmentDistance(inputPoints[i - 1], inputPoints[i]);
  }
  const shorelineIndex = inputPoints.findIndex((point) => point.inSea);
  const shorelineDistanceM = shorelineIndex >= 0 ? cumulativeDistanceM[shorelineIndex] : cumulativeDistanceM.at(-1);
  const bankYAt = (point) => point.bankY ?? point.groundY;
  const frames = computeRiverFrames(inputPoints, options.miterLimit ?? 1.75);
  const points = inputPoints.map((point, index) => ({ ...point, frame: frames[index] }));
  const bedYAt = (point) => bankYAt(point) - channelDepthM * verticalExaggeration;
  function waterYAt(point, i, rise = point.stageRiseM ?? 0) {
    const naturalY = bedYAt(point) + baseWaterDepthM * verticalExaggeration + Math.min(freeboardM, Math.max(0, rise)) * verticalExaggeration;
    if (!Number.isFinite(outletWaterY)) return naturalY;
    if (shorelineIndex >= 0 && i < shorelineIndex && rise >= freeboardM) return naturalY;
    let blend = 0;
    if (shorelineIndex >= 0 && i >= shorelineIndex) blend = 1;
    else {
      const distanceToShoreM = shorelineDistanceM - cumulativeDistanceM[i];
      const linear = Math.max(0, Math.min(1, 1 - distanceToShoreM / outletTransitionM));
      blend = linear * linear * (3 - 2 * linear);
    }
    const targetY = Math.max(naturalY, outletWaterY);
    return naturalY + (targetY - naturalY) * blend;
  }
  const floorLeft = edgeAt(points, -bedHalfWidth, bedYAt);
  const floorRight = edgeAt(points, bedHalfWidth, bedYAt);
  const bankLeft = edgeAt(points, -halfWidth, bankYAt);
  const bankRight = edgeAt(points, halfWidth, bankYAt);
  const waterLeft = edgeAt(points, -halfWidth, waterYAt);
  const waterRight = edgeAt(points, halfWidth, waterYAt);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: options.floorColor ?? 0x323d3b,
    roughness: 0.96,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: options.wallColor ?? 0x9cad78,
    roughness: 0.92,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const waterMaterial = new THREE.MeshPhysicalMaterial({
    color: options.waterColor ?? 0x168ec3,
    transparent: true,
    opacity: 0.9,
    roughness: 0.2,
    metalness: 0.03,
    clearcoat: 0.75,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const group = new THREE.Group();
  group.name = 'ciliwung-3d-channel';
  group.userData.assumptions = { channelWidthM, channelBedWidthM, channelDepthM, baseWaterDepthM, verticalExaggeration };
  const bedStrip = createStrip(THREE, floorLeft, floorRight, floorMaterial, 'channel-bed');
  const leftWallStrip = createStrip(THREE, floorLeft, bankLeft, wallMaterial, 'left-bank-wall');
  const rightWallStrip = createStrip(THREE, bankRight, floorRight, wallMaterial, 'right-bank-wall');
  bedStrip.castShadow = false;
  leftWallStrip.castShadow = false;
  rightWallStrip.castShadow = false;
  group.add(bedStrip, leftWallStrip, rightWallStrip);
  if (apronHalfWidthM > halfWidth + 0.05) {
    const apronLeft = edgeAt(points, -apronHalfWidthM, (point) => point.leftGroundY ?? bankYAt(point), false);
    const apronRight = edgeAt(points, apronHalfWidthM, (point) => point.rightGroundY ?? bankYAt(point), false);
    const apronMaterial = new THREE.MeshStandardMaterial({ color: options.apronColor ?? 0x9cae78, roughness: 0.96, side: THREE.DoubleSide });
    group.add(createStrip(THREE, bankLeft, apronLeft, apronMaterial, 'left-bank-apron'));
    group.add(createStrip(THREE, bankRight, apronRight, apronMaterial, 'right-bank-apron'));
  }
  const waterSurface = createStrip(THREE, waterLeft, waterRight, waterMaterial, 'water-surface');
  const leftWaterFace = createStrip(THREE, floorLeft, waterLeft, waterMaterial, 'water-side-left');
  const rightWaterFace = createStrip(THREE, floorRight, waterRight, waterMaterial, 'water-side-right');
  group.add(waterSurface, leftWaterFace, rightWaterFace);

  function setWaterRiseAtPoints(stageRiseMeters) {
    if (!Array.isArray(stageRiseMeters) || stageRiseMeters.length !== points.length) {
      throw new TypeError('stageRiseMeters must have one value per river sample');
    }
    const clampedRiseMeters = new Array(points.length);
    const overflowMeters = new Array(points.length);
    for (let i = 0; i < points.length; i += 1) {
      const rawRise = Math.max(0, Number(stageRiseMeters[i]) || 0);
      const rise = Math.min(freeboardM, rawRise);
      const overflow = Math.max(0, rawRise - freeboardM);
      const waterY = waterYAt(points[i], i, rise);
      const surface = waterSurface.geometry.attributes.position.array;
      const leftFace = leftWaterFace.geometry.attributes.position.array;
      const rightFace = rightWaterFace.geometry.attributes.position.array;
      surface[i * 6 + 1] = waterY;
      surface[i * 6 + 4] = waterY;
      leftFace[i * 6 + 4] = waterY;
      rightFace[i * 6 + 4] = waterY;
      clampedRiseMeters[i] = rise;
      overflowMeters[i] = overflow;
    }
    waterSurface.geometry.attributes.position.needsUpdate = true;
    leftWaterFace.geometry.attributes.position.needsUpdate = true;
    rightWaterFace.geometry.attributes.position.needsUpdate = true;
    waterSurface.geometry.computeVertexNormals();
    leftWaterFace.geometry.computeVertexNormals();
    rightWaterFace.geometry.computeVertexNormals();
    return { clampedRiseMeters, overflowMeters, maxOverflowM: Math.max(0, ...overflowMeters) };
  }

  group.userData.freeboardM = freeboardM;
  group.userData.outletTransitionM = Number.isFinite(outletWaterY) ? outletTransitionM : 0;
  group.userData.setWaterRiseAtPoints = setWaterRiseAtPoints;
  return { group, waterSurface, setWaterRiseAtPoints, waterSurfaceYAt: (index, rise) => waterYAt(points[index], index, rise), centerline: points, freeboardM, channelWidthM, channelBedWidthM, outletTransitionM: Number.isFinite(outletWaterY) ? outletTransitionM : 0 };
}
