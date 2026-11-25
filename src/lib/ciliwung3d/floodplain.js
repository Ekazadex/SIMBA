import { computeRiverFrames } from './river.js';
import { geoToWorld, sampleTerrainMeters, terrainOrigin } from './terrain.js';

function pointToGeo(x, z, terrain) {
  const origin = terrainOrigin(terrain);
  const lonScale = 111320 * Math.cos(origin.latitude * Math.PI / 180);
  return {
    longitude: origin.longitude + x / lonScale,
    latitude: origin.latitude - z / 111320,
  };
}

function makeSideMesh(THREE, points, side, steps, material, name) {
  const stride = steps + 1;
  const positions = new Float32Array(points.length * stride * 3);
  const indices = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let j = 0; j < steps; j += 1) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFloodDepth', new THREE.BufferAttribute(new Float32Array(positions.length / 3), 1));
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.visible = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = 2;
  mesh.userData.side = side;
  return mesh;
}

export function createFloodplainSpill(THREE, points, terrain, options = {}) {
  if (!Array.isArray(points) || points.length < 2) throw new TypeError('floodplain spill needs at least two river points');
  const channelWidthM = options.channelWidthM ?? 30;
  const channelDepthM = options.channelDepthM ?? 3;
  const baseWaterDepthM = options.baseWaterDepthM ?? 1.1;
  const verticalExaggeration = options.verticalExaggeration ?? terrain.verticalExaggeration ?? 1;
  const spreadMetersPerMeter = options.spreadMetersPerMeter ?? 60;
  const maxSpreadM = options.maxSpreadM ?? 180;
  const steps = options.lateralSteps ?? 6;
  if (!(channelWidthM > 0 && channelDepthM > baseWaterDepthM && baseWaterDepthM >= 0 && verticalExaggeration > 0 && spreadMetersPerMeter > 0 && maxSpreadM > 0)) {
    throw new RangeError('floodplain dimensions and spread parameters must be positive and physically ordered');
  }
  if (!Number.isInteger(steps) || steps < 2 || steps > 16) throw new RangeError('lateralSteps must be an integer from 2 through 16');
  const freeboardM = channelDepthM - baseWaterDepthM;
  const halfWidth = channelWidthM / 2;
  const frames = computeRiverFrames(points, options.miterLimit ?? 1.75);
  const material = new THREE.MeshStandardMaterial({
    color: options.waterColor ?? 0x258dae,
    transparent: true,
    opacity: options.opacity ?? 0.58,
    roughness: 0.28,
    metalness: 0.01,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFloodDepth;\nvarying float vFloodDepth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFloodDepth = aFloodDepth;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFloodDepth;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vFloodDepth < 0.0) discard;');
  };
  material.customProgramCacheKey = () => 'terrain-clipped-overbank-water-v1';
  const leftMesh = makeSideMesh(THREE, points, -1, steps, material, 'floodplain-spill-left');
  const rightMesh = makeSideMesh(THREE, points, 1, steps, material, 'floodplain-spill-right');
  const group = new THREE.Group();
  group.name = 'conceptual-overbank-spill';
  group.userData.assumptions = { channelWidthM, channelDepthM, baseWaterDepthM, freeboardM, spreadMetersPerMeter, maxSpreadM };
  group.add(leftMesh, rightMesh);

  function updateSide(mesh, side, stageRiseMeters) {
    const positions = mesh.geometry.attributes.position.array;
    const floodDepths = mesh.geometry.attributes.aFloodDepth.array;
    let wetVertices = 0;
    let maximumOverflow = 0;
    let maximumSpread = 0;
    const stride = steps + 1;
    for (let i = 0; i < points.length; i += 1) {
      const rawStage = Math.max(0, Number(stageRiseMeters[i]) || 0);
      const overflow = Math.max(0, rawStage - freeboardM);
      const spread = Math.min(maxSpreadM, overflow * spreadMetersPerMeter);
      const bankY = points[i].bankY ?? points[i].groundY ?? 0;
      const waterY = bankY + overflow * verticalExaggeration;
      maximumOverflow = Math.max(maximumOverflow, overflow);
      maximumSpread = Math.max(maximumSpread, spread);
      for (let step = 0; step <= steps; step += 1) {
        const fraction = step / steps;
        const offset = (halfWidth + spread * fraction) * frames[i].miterScale;
        const x = points[i].x + frames[i].nx * offset * side;
        const z = points[i].z + frames[i].nz * offset * side;
        const geo = pointToGeo(x, z, terrain);
        const elevation = sampleTerrainMeters(terrain, geo.longitude, geo.latitude);
        const groundY = geoToWorld(geo.longitude, geo.latitude, elevation, terrain, verticalExaggeration).y;
        const floodDepth = waterY - groundY;
        const wet = overflow > 0 && floodDepth > 0;
        const surfaceY = waterY + 0.06 * verticalExaggeration;
        const index = (i * stride + step) * 3;
        positions[index] = x;
        positions[index + 1] = surfaceY;
        positions[index + 2] = z;
        floodDepths[index / 3] = floodDepth;
        if (wet) wetVertices += 1;
      }
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.aFloodDepth.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingSphere();
    mesh.visible = maximumOverflow > 0 && wetVertices > 0;
    mesh.userData.wetVertexCount = wetVertices;
    return { maximumOverflow, maximumSpread, wetVertices };
  }

  function setStageRiseAtPoints(stageRiseMeters) {
    if (!Array.isArray(stageRiseMeters) || stageRiseMeters.length !== points.length) {
      throw new TypeError('stageRiseMeters must have one value per river sample');
    }
    const left = updateSide(leftMesh, -1, stageRiseMeters);
    const right = updateSide(rightMesh, 1, stageRiseMeters);
    return {
      maxOverflowM: Math.max(left.maximumOverflow, right.maximumOverflow),
      maxSpreadM: Math.max(left.maximumSpread, right.maximumSpread),
      wetVertexCount: left.wetVertices + right.wetVertices,
    };
  }

  const state = setStageRiseAtPoints(new Array(points.length).fill(0));
  return { group, leftMesh, rightMesh, setStageRiseAtPoints, freeboardM, state };
}
