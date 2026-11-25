import * as THREE from '../../vendor/three.module.js';
import { OrbitControls } from '../../vendor/OrbitControls.js';
import { buildTerrainMesh, geoToWorld, sampleTerrainMeters } from './terrain.js?v=20261120-v3';
import { buildRiverCorridorMesh } from './terrain-corridor.js?v=20261120-v3';
import { buildRiverGeometry, extendRiverMouth, resampleRiverPoints, roundRiverCorners } from './river.js';
import { createFloodplainSpill } from './floodplain.js';
import { createSensorPole } from './sensor-node.js';
import { projectSensorStationToBank } from './station-placement.js';
import { buildFlowParticles, buildSeaSurface, buildUrbanEnvironment } from './scene-effects.js?v=20261120-v3';

function metresPerDegree(latitude) {
  return { lon: 111320 * Math.cos(latitude * Math.PI / 180), lat: 111320 };
}

function worldXZToGeo(x, z, terrain) {
  const lon0 = (terrain.bounds.west + terrain.bounds.east) / 2;
  const lat0 = (terrain.bounds.north + terrain.bounds.south) / 2;
  const scale = metresPerDegree(lat0);
  return { longitude: lon0 + x / scale.lon, latitude: lat0 - z / scale.lat };
}

function nearestCenterlineIndex(x, z, points) {
  let bestIndex = 0;
  let bestDistanceSquared = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const dx = points[i].x - x;
    const dz = points[i].z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDistanceSquared) {
      bestDistanceSquared = d2;
      bestIndex = i;
    }
  }
  return { index: bestIndex, distanceM: Math.sqrt(bestDistanceSquared) };
}

function createSensorTargetVisual(THREE, stationId, headPosition, waterY) {
  const group = new THREE.Group();
  group.name = `sensor-target-${stationId}`;
  group.visible = false;

  const beamPositions = new Float32Array([
    headPosition.x, headPosition.y - 0.08, headPosition.z,
    headPosition.x, waterY + 0.12, headPosition.z,
  ]);
  const beamGeometry = new THREE.BufferGeometry();
  beamGeometry.setAttribute('position', new THREE.BufferAttribute(beamPositions, 3));
  const beamMaterial = new THREE.LineBasicMaterial({ color: 0xf3e58b, transparent: true, opacity: 0.82, depthWrite: false });
  const beam = new THREE.Line(beamGeometry, beamMaterial);
  beam.name = 'ultrasonic-measurement-beam';
  beam.renderOrder = 5;

  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xf3e58b, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.07, 8, 24), ringMaterial);
  ring.name = 'water-target-ring';
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(headPosition.x, waterY + 0.12, headPosition.z);
  ring.renderOrder = 6;

  group.add(beam, ring);
  return { group, beam, beamPositions, ring };
}

export function buildSceneApp(canvas, terrain, riverAsset, nodeData, environmentData) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9d2d5);
  scene.fog = new THREE.Fog(0xb9d2d5, 28000, 76000);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  }
  const glContext = renderer.getContext();
  let rendererInfo = '';
  try {
    const dbg = glContext.getExtension('WEBGL_debug_renderer_info');
    rendererInfo = dbg ? String(glContext.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
  } catch {
    rendererInfo = '';
  }
  const isSoftwareGl = /swiftshader|llvmpipe|software|basic render/i.test(rendererInfo);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isSoftwareGl ? 1 : 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 2, 120000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = true;
  controls.minDistance = 18;
  controls.maxDistance = 72000;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xe7f2ed, 0x455248, 1.8));
  const sun = new THREE.DirectionalLight(0xfff1d1, 2.2);
  sun.position.set(-13000, 18000, 8000);
  sun.castShadow = !isSoftwareGl;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -24000;
  sun.shadow.camera.right = 24000;
  sun.shadow.camera.top = 36000;
  sun.shadow.camera.bottom = -36000;
  scene.add(sun);

  const seaStartLatitude = environmentData?.sea?.startLatitude;
  const seaLevelMeters = environmentData?.sea?.elevationM ?? 0;
  const verticalExaggeration = terrain.verticalExaggeration ?? 1.8;
  const seaViewLatitude = seaStartLatitude;
  const seaViewPosition = geoToWorld(environmentData.riverOutlet.longitude, seaViewLatitude, seaLevelMeters, terrain, verticalExaggeration);
  const rawCenterline = riverAsset.coordinates.map(([longitude, latitude]) => {
    const elevation = sampleTerrainMeters(terrain, longitude, latitude);
    return { ...geoToWorld(longitude, latitude, elevation, terrain, verticalExaggeration), longitude, latitude, groundElevationM: elevation };
  });
  const sampledCenterline = roundRiverCorners(
    resampleRiverPoints(rawCenterline, { maxSegmentLengthM: 45, simplifyToleranceM: 6 }),
    { minimumRadiusM: 18, cornerAngleDeg: 75 },
  );
  const renderedCenterlineCoordinates = sampledCenterline.map((point) => [point.longitude, point.latitude]);
  const terrainMesh = buildTerrainMesh(THREE, terrain, renderedCenterlineCoordinates, {
    verticalExaggeration,
    subdivisions: 1,
    stride: 2,
    channelWidthM: 30,
    channelBedWidthM: 20,
    channelDepthM: 3,
    corridorCutoutRadiusM: 25,
    seaStartLatitude,
    seaLevelMeters,
  });
  scene.add(terrainMesh);
  const sea = buildSeaSurface(THREE, terrain, { startLatitude: seaStartLatitude, elevationM: seaLevelMeters });
  scene.add(sea.group);
  const riverPointsOnLandAndShore = sampledCenterline.map((point, i) => {
    const previous = sampledCenterline[Math.max(0, i - 1)];
    const next = sampledCenterline[Math.min(sampledCenterline.length - 1, i + 1)];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length;
    const nz = dx / length;
    const longitude = point.longitude;
    const latitude = point.latitude;
    const inSea = latitude >= seaStartLatitude;
    const elevation = inSea ? seaLevelMeters : sampleTerrainMeters(terrain, longitude, latitude);
    const position = geoToWorld(longitude, latitude, elevation, terrain, verticalExaggeration);
    const apron = 45;
    const leftGeo = worldXZToGeo(position.x + nx * apron, position.z + nz * apron, terrain);
    const rightGeo = worldXZToGeo(position.x - nx * apron, position.z - nz * apron, terrain);
    const leftElevation = inSea ? seaLevelMeters : sampleTerrainMeters(terrain, leftGeo.longitude, leftGeo.latitude);
    const rightElevation = inSea ? seaLevelMeters : sampleTerrainMeters(terrain, rightGeo.longitude, rightGeo.latitude);
    const leftWorld = geoToWorld(leftGeo.longitude, leftGeo.latitude, leftElevation, terrain, verticalExaggeration);
    const rightWorld = geoToWorld(rightGeo.longitude, rightGeo.latitude, rightElevation, terrain, verticalExaggeration);
    return {
      ...point,
      x: position.x,
      z: position.z,
      groundY: position.y,
      bankY: position.y,
      leftGroundY: inSea ? position.y - 0.2 : leftWorld.y,
      rightGroundY: inSea ? position.y - 0.2 : rightWorld.y,
      longitude,
      latitude,
      inSea,
      stageRiseM: 0,
      baseWaterY: position.y - (3 - 1.1) * verticalExaggeration,
    };
  });
  const terrainCorridor = buildRiverCorridorMesh(THREE, terrainMesh, terrain, riverPointsOnLandAndShore, {
    verticalExaggeration,
    channelWidthM: 30,
    channelBedWidthM: 20,
    channelDepthM: 3,
    halfWidthM: 240,
    adaptiveStep: true,
    lateralStepM: 5,
    blendWidthM: 80,
  });
  terrainCorridor.mesh.castShadow = false;
  scene.add(terrainCorridor.mesh);
  const terrainSurfaceAt = (longitude, latitude) => terrainCorridor.sampleSurfaceAt(longitude, latitude)
    ?? terrainMesh.userData.sampleSurfaceAt(longitude, latitude);
  const environment = buildUrbanEnvironment(THREE, environmentData, terrain, renderedCenterlineCoordinates, {
    verticalExaggeration,
    sampleSurfaceAt: terrainSurfaceAt,
  });
  scene.add(environment);
  const riverPoints = extendRiverMouth(riverPointsOnLandAndShore, {
    lengthM: 300,
    maxSegmentLengthM: 30,
    outletY: seaViewPosition.y,
  });
  const firstSeaIndex = riverPoints.findIndex((point) => point.inSea);
  const spillPoints = riverPoints.slice(0, firstSeaIndex < 0 ? riverPoints.length : firstSeaIndex);
  const river = buildRiverGeometry(THREE, riverPoints, {
    channelWidthM: 30,
    bedWidthM: 20,
    channelDepthM: 3,
    baseWaterDepthM: 1.1,
    verticalExaggeration,
    outletWaterY: seaViewPosition.y + 0.08,
    outletTransitionM: 900,
  });
  scene.add(river.group);
  const floodplain = createFloodplainSpill(THREE, spillPoints, terrain, {
    channelWidthM: 30,
    channelDepthM: 3,
    baseWaterDepthM: 1.1,
    verticalExaggeration,
    spreadMetersPerMeter: 40,
    maxSpreadM: 150,
    lateralSteps: 10,
    opacity: 0.58,
  });
  scene.add(floodplain.group);

  const cumulativeDistanceM = new Float32Array(riverPoints.length);
  for (let i = 1; i < riverPoints.length; i += 1) {
    cumulativeDistanceM[i] = cumulativeDistanceM[i - 1] + Math.hypot(riverPoints[i].x - riverPoints[i - 1].x, riverPoints[i].z - riverPoints[i - 1].z);
  }
  const totalRiverLengthM = cumulativeDistanceM[cumulativeDistanceM.length - 1];

  const referenceLatitude = (terrain.bounds.north + terrain.bounds.south) / 2;
  const stations = nodeData.nodes.map((node) => {
    const longitude = Number(node.longitude);
    const latitude = Number(node.latitude);
    const placement = projectSensorStationToBank({ longitude, latitude }, renderedCenterlineCoordinates, {
      channelWidthM: 30,
      mountOffsetM: 12.5,
      maxSnapDistanceM: 120,
      referenceLatitude,
    });
    const displayLongitude = placement.longitude;
    const displayLatitude = placement.latitude;
    const surface = terrainSurfaceAt(displayLongitude, displayLatitude);
    const elevationM = surface.elevationM;
    const position = geoToWorld(displayLongitude, displayLatitude, elevationM, terrain, verticalExaggeration);
    position.y = surface.worldY;
    const nearest = nearestCenterlineIndex(position.x, position.z, riverPoints);
    const riverTargetElevationM = sampleTerrainMeters(terrain, placement.riverLongitude, placement.riverLatitude);
    const riverTarget = geoToWorld(placement.riverLongitude, placement.riverLatitude, riverTargetElevationM, terrain, verticalExaggeration);
    const rawArmDirection = { x: riverTarget.x - position.x, z: riverTarget.z - position.z };
    const armLength = Math.hypot(rawArmDirection.x, rawArmDirection.z) || 1;
    const armDirection = { x: rawArmDirection.x / armLength, z: rawArmDirection.z / armLength };
    const sensorTargetOffsetM = Math.max(0, placement.bankOffsetMeters - 2.95);
    const pole = createSensorPole(THREE, { ...node, position }, armDirection);
    pole.userData.pathIndex = nearest.index;
    pole.userData.riverOffsetMeters = nearest.distanceM;
    pole.userData.sensorTargetOffsetMeters = sensorTargetOffsetM;
    scene.add(pole);
    const sensorHeadHeightM = pole.getObjectByName('ultrasonic-head').position.y;
    const sensorTargetPosition = {
      x: position.x + armDirection.x * 2.95,
      y: position.y + sensorHeadHeightM,
      z: position.z + armDirection.z * 2.95,
    };
    const sensorTargetPathIndex = nearestCenterlineIndex(sensorTargetPosition.x, sensorTargetPosition.z, riverPoints).index;
    const sensorTargetVisual = createSensorTargetVisual(
      THREE,
      node.id,
      sensorTargetPosition,
      river.waterSurfaceYAt(sensorTargetPathIndex, 0),
    );
    scene.add(sensorTargetVisual.group);
    return {
      ...node,
      longitude,
      latitude,
      displayLongitude,
      displayLatitude,
      placement,
      elevationM,
      position,
      surfaceNormal: surface.normal,
      sensorTargetOffsetMeters: sensorTargetOffsetM,
      sensorTargetPosition,
      sensorTargetPathIndex,
      sensorTargetGroup: sensorTargetVisual.group,
      sensorTargetBeam: sensorTargetVisual.beam,
      sensorTargetBeamPositions: sensorTargetVisual.beamPositions,
      sensorTargetRing: sensorTargetVisual.ring,
      pathIndex: nearest.index,
      pathDistanceM: cumulativeDistanceM[nearest.index],
      riverOffsetMeters: nearest.distanceM,
      armDirection,
      pole,
    };
  });

  const environmentalLocations = environment.userData.renderedLocations;
  for (const station of stations) {
    let nearestPropDistance = Infinity;
    for (const item of environmentalLocations) {
      const propPosition = geoToWorld(item.longitude, item.latitude, 0, terrain, verticalExaggeration);
      const dx = propPosition.x - station.position.x;
      const dz = propPosition.z - station.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance < nearestPropDistance) {
        nearestPropDistance = distance;
      }
    }
    station.nearestEnvironmentDistanceM = nearestPropDistance;
    const armShare = 0.7;
    const sideShare = Math.sqrt(1 - armShare ** 2);
    station.cameraDirection = {
      x: station.armDirection.x * armShare - station.armDirection.z * sideShare,
      y: 0.22,
      z: station.armDirection.z * armShare + station.armDirection.x * sideShare,
    };
  }

  const particlePoints = buildFlowParticles(THREE, riverPoints);
  scene.add(particlePoints);

  const verticalSpan = (terrain.maximumElevationMeters - terrain.minimumElevationMeters) * verticalExaggeration;
  const initialTarget = { x: 0, y: verticalSpan * 0.44, z: 0 };
  controls.target.set(initialTarget.x, initialTarget.y, initialTarget.z);
  camera.position.set(13500, 28500, 36000);
  controls.update();

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  function updateSensorTargetVisuals(stageAtPath) {
    for (const station of stations) {
      const index = station.sensorTargetPathIndex;
      const rise = stageAtPath[index] ?? 0;
      const waterY = river.waterSurfaceYAt(index, rise) + 0.12;
      const beamPosition = station.sensorTargetBeam.geometry.attributes.position;
      beamPosition.setY(0, station.sensorTargetPosition.y - 0.08);
      beamPosition.setY(1, waterY);
      beamPosition.needsUpdate = true;
      station.sensorTargetBeam.geometry.computeBoundingSphere();
      station.sensorTargetRing.position.y = waterY;
    }
  }

  function setWaterStages(stageRiseByNode) {
    const ordered = [...stations].sort((a, b) => a.pathIndex - b.pathIndex);
    const stageById = new Map(stations.map((station, i) => [station.id, Math.max(0, stageRiseByNode[i] ?? 0)]));
    const stageAtPath = new Float32Array(riverPoints.length);
    for (let i = 0; i < riverPoints.length; i += 1) {
      let left = ordered[0];
      let right = ordered[ordered.length - 1];
      for (let j = 0; j < ordered.length - 1; j += 1) {
        if (i >= ordered[j].pathIndex && i <= ordered[j + 1].pathIndex) {
          left = ordered[j];
          right = ordered[j + 1];
          break;
        }
        if (i < ordered[0].pathIndex) right = ordered[0];
        else if (i > ordered[ordered.length - 1].pathIndex) left = ordered[ordered.length - 1];
      }
      const leftStage = stageById.get(left.id) ?? 0;
      const rightStage = stageById.get(right.id) ?? leftStage;
      const span = right.pathIndex - left.pathIndex;
      const t = span <= 0 ? 0 : Math.max(0, Math.min(1, (i - left.pathIndex) / span));
      stageAtPath[i] = leftStage + (rightStage - leftStage) * t;
      riverPoints[i].stageRiseM = stageAtPath[i];
    }
    river.setWaterRiseAtPoints(Array.from(stageAtPath));
    updateSensorTargetVisuals(stageAtPath);
    floodplainState = floodplain.setStageRiseAtPoints(Array.from(stageAtPath.slice(0, spillPoints.length)));
    return stageAtPath;
  }

  function updateFlowParticles(simulationSeconds, averageRunoff) {
    const attr = particlePoints.geometry.attributes.position;
    const values = attr.array;
    const opacity = Math.max(0.15, Math.min(0.88, 0.18 + averageRunoff * 0.6));
    particlePoints.material.uniforms.uOpacity.value = opacity;
    const speedMps = 0.58;
    for (let p = 0; p < values.length / 3; p += 1) {
      const distance = (simulationSeconds * speedMps + p / (values.length / 3) * totalRiverLengthM) % totalRiverLengthM;
      let low = 0;
      let high = cumulativeDistanceM.length - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (cumulativeDistanceM[mid] < distance) low = mid + 1;
        else high = mid;
      }
      const index = Math.max(1, low);
      const a = riverPoints[index - 1];
      const b = riverPoints[index];
      const segmentLength = cumulativeDistanceM[index] - cumulativeDistanceM[index - 1] || 1;
      const t = (distance - cumulativeDistanceM[index - 1]) / segmentLength;
      values[p * 3] = a.x + (b.x - a.x) * t;
      const rawStage = (a.stageRiseM ?? 0) + ((b.stageRiseM ?? 0) - (a.stageRiseM ?? 0)) * t;
      const waterYA = river.waterSurfaceYAt(index - 1, rawStage);
      const waterYB = river.waterSurfaceYAt(index, rawStage);
      values[p * 3 + 1] = waterYA + (waterYB - waterYA) * t + 0.15;
      values[p * 3 + 2] = a.z + (b.z - a.z) * t;
    }
    attr.needsUpdate = true;
  }

  function render() {
    controls.update();
    renderer.render(scene, camera);
  }

  let floodplainState = floodplain.state;
  updateSensorTargetVisuals(new Float32Array(riverPoints.length));
  updateFlowParticles(0, 0);

  return {
    scene,
    camera,
    controls,
    renderer,
    terrainMesh,
    terrainBounds: terrain.bounds,
    terrainCorridorMesh: terrainCorridor.mesh,
    terrainSurfaceAt,
    sea,
    seaViewPosition,
    environment,
    river,
    floodplain,
    get floodplainState() { return floodplainState; },
    riverPoints,
    riverLengthM: totalRiverLengthM,
    stations,
    particlePoints,
    setWaterStages,
    updateFlowParticles,
    resize,
    render,
  };
}
