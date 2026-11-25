import { geoToWorld, sampleTerrainMeters } from './terrain.js';

const METERS_PER_DEGREE = 111320;

export function buildFlowParticles(THREE, points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) throw new TypeError('flow particles need at least two river points');
  const count = options.count ?? 110;
  if (!Number.isInteger(count) || count < 1) throw new RangeError('particle count must be a positive integer');
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const point = points[Math.floor(i / count * (points.length - 1))];
    positions[i * 3] = point.x;
    positions[i * 3 + 1] = point.groundY + 1;
    positions[i * 3 + 2] = point.z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(options.color ?? 0xc5f7f0) },
      uOpacity: { value: options.opacity ?? 0.82 },
    },
    vertexShader: `
      varying float vParticleAlpha;
      void main() {
        vParticleAlpha = 1.0;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        gl_PointSize = ${Number(options.pointSize ?? 4.2).toFixed(2)};
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vParticleAlpha;
      void main() {
        vec2 centeredPoint = gl_PointCoord - vec2(0.5);
        float radius = length(centeredPoint);
        if (radius > 0.5) discard;
        float edgeAlpha = 1.0 - smoothstep(0.34, 0.5, radius);
        gl_FragColor = vec4(uColor, uOpacity * vParticleAlpha * edgeAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const particles = new THREE.Points(geometry, material);
  particles.name = 'moving-water-particles';
  particles.renderOrder = 3;
  particles.userData.shape = 'circle';
  return particles;
}

export function buildSeaSurface(THREE, terrain, options = {}) {
  const startLatitude = options.startLatitude;
  const elevationM = options.elevationM ?? 0;
  if (!Number.isFinite(startLatitude) || startLatitude >= terrain.bounds.north || startLatitude <= terrain.bounds.south) {
    throw new RangeError('sea start latitude must lie inside the terrain bounds and south of its northern edge');
  }
  const { west, east, north } = terrain.bounds;
  const corners = [
    geoToWorld(west, north, elevationM, terrain, terrain.verticalExaggeration),
    geoToWorld(east, north, elevationM, terrain, terrain.verticalExaggeration),
    geoToWorld(east, startLatitude, elevationM, terrain, terrain.verticalExaggeration),
    geoToWorld(west, startLatitude, elevationM, terrain, terrain.verticalExaggeration),
  ];
  const positions = new Float32Array(corners.flatMap((p) => [p.x, p.y + 0.04, p.z]));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: options.color ?? 0x087a9e,
    roughness: 0.36,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
  const surface = new THREE.Mesh(geometry, material);
  surface.name = 'sea-surface';
  surface.receiveShadow = true;

  const shorelinePoints = [
    geoToWorld(west, startLatitude, elevationM, terrain, terrain.verticalExaggeration),
    geoToWorld(east, startLatitude, elevationM, terrain, terrain.verticalExaggeration),
  ];
  const shorelineGeometry = new THREE.BufferGeometry().setFromPoints(
    shorelinePoints.map((p) => new THREE.Vector3(p.x, p.y + 0.1, p.z)),
  );
  const shoreline = new THREE.Line(shorelineGeometry, new THREE.LineBasicMaterial({ color: 0xa6e8e4, transparent: true, opacity: 0.85 }));
  shoreline.name = 'sea-shoreline';

  const group = new THREE.Group();
  group.name = 'illustrative-downstream-sea';
  group.add(surface, shoreline);
  group.userData.illustrative = true;
  group.userData.startLatitude = startLatitude;
  group.userData.elevationM = elevationM;
  return { group, surface, shoreline, startLatitude, userData: group.userData };
}

function distancePointToSegmentMeters(longitude, latitude, a, b, longitudeScale) {
  const px = longitude * longitudeScale;
  const py = latitude * METERS_PER_DEGREE;
  const ax = a[0] * longitudeScale;
  const ay = a[1] * METERS_PER_DEGREE;
  const bx = b[0] * longitudeScale;
  const by = b[1] * METERS_PER_DEGREE;
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denominator));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function createRiverDistanceIndex(centerline, longitudeScale, searchRadiusM) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < centerline.length; i += 1) {
    const lat = centerline[i][1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const bucketCount = 64;
  const latSpan = Math.max(1e-6, (maxLat - minLat) / bucketCount);
  const marginLat = (searchRadiusM + 80) / METERS_PER_DEGREE;
  const buckets = Array.from({ length: bucketCount }, () => []);
  for (let i = 0; i < centerline.length - 1; i += 1) {
    const low = Math.min(centerline[i][1], centerline[i + 1][1]) - marginLat;
    const high = Math.max(centerline[i][1], centerline[i + 1][1]) + marginLat;
    const b0 = Math.max(0, Math.min(bucketCount - 1, Math.floor((low - minLat) / latSpan)));
    const b1 = Math.max(0, Math.min(bucketCount - 1, Math.floor((high - minLat) / latSpan)));
    for (let b = b0; b <= b1; b += 1) buckets[b].push(i);
  }
  return (longitude, latitude) => {
    if (latitude < minLat - marginLat || latitude > maxLat + marginLat) return Infinity;
    const b = Math.max(0, Math.min(bucketCount - 1, Math.floor((latitude - minLat) / latSpan)));
    const segs = buckets[b];
    let nearest = Infinity;
    for (let k = 0; k < segs.length; k += 1) {
      const i = segs[k];
      const d = distancePointToSegmentMeters(longitude, latitude, centerline[i], centerline[i + 1], longitudeScale);
      if (d < nearest) nearest = d;
    }
    return nearest;
  };
}

export function buildUrbanEnvironment(THREE, data, terrain, centerline, options = {}) {
  if (!Array.isArray(data?.buildings) || !Array.isArray(data?.trees)) {
    throw new TypeError('environment data must contain building footprints and tree points');
  }
  const verticalExaggeration = options.verticalExaggeration ?? terrain.verticalExaggeration ?? 1;
  const minimumRiverClearanceM = options.minimumRiverClearanceM ?? 28;
  const maximumBuildingRiverDistanceM = options.maximumBuildingRiverDistanceM ?? 250;
  const maxBuildings = options.maxBuildings ?? 6000;
  const maxTrees = options.maxTrees ?? 3000;
  const referenceLatitude = (terrain.bounds.south + terrain.bounds.north) / 2;
  const longitudeScale = METERS_PER_DEGREE * Math.cos(referenceLatitude * Math.PI / 180);
  const seaStartLatitude = data.sea?.startLatitude ?? terrain.bounds.north + 1;
  const group = new THREE.Group();
  group.name = 'osm-built-and-natural-environment';
  const insideTerrain = (item) => Number.isFinite(item.longitude) && Number.isFinite(item.latitude)
    && item.longitude >= terrain.bounds.west && item.longitude <= terrain.bounds.east
    && item.latitude >= terrain.bounds.south && item.latitude < Math.min(terrain.bounds.north, seaStartLatitude);
  const queryRiverDistance = createRiverDistanceIndex(centerline, longitudeScale, Math.max(maximumBuildingRiverDistanceM, minimumRiverClearanceM));
  const riverDistanceCache = new WeakMap();
  const riverDistance = (item) => {
    let distance = riverDistanceCache.get(item);
    if (distance === undefined) {
      distance = queryRiverDistance(item.longitude, item.latitude);
      riverDistanceCache.set(item, distance);
    }
    return distance;
  };
  const offChannel = (item) => riverDistance(item) >= minimumRiverClearanceM;

  const sampleGround = (longitude, latitude) => {
    const raw = geoToWorld(longitude, latitude, sampleTerrainMeters(terrain, longitude, latitude), terrain, verticalExaggeration);
    const rendered = options.sampleSurfaceAt?.(longitude, latitude);
    const sourceNormal = rendered?.normal ?? { x: 0, y: 1, z: 0 };
    let nx = Number(sourceNormal.x) || 0;
    let ny = Number(sourceNormal.y) || 0;
    let nz = Number(sourceNormal.z) || 0;
    const normalLength = Math.hypot(nx, ny, nz) || 1;
    nx /= normalLength;
    ny /= normalLength;
    nz /= normalLength;
    if (ny < 0) { nx *= -1; ny *= -1; nz *= -1; }
    return { x: raw.x, y: Number.isFinite(rendered?.worldY) ? rendered.worldY : raw.y, z: raw.z, normal: { x: nx, y: ny, z: nz } };
  };
  const maxBuildingTerrainFitErrorM = options.maxBuildingTerrainFitErrorM ?? 2.5;
  const footprintFitError = (building, widthM, depthM, base) => {
    if (base.normal.y < 0.35) return Infinity;
    let maximumError = 0;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const corner = sampleGround(
          building.longitude + sx * widthM / 2 / longitudeScale,
          building.latitude - sz * depthM / 2 / METERS_PER_DEGREE,
        );
        const dx = corner.x - base.x;
        const dz = corner.z - base.z;
        const planeY = base.y - (base.normal.x * dx + base.normal.z * dz) / base.normal.y;
        maximumError = Math.max(maximumError, Math.abs(corner.y - planeY));
      }
    }
    return maximumError;
  };

  const buildingCandidates = data.buildings
    .filter((item) => insideTerrain(item) && offChannel(item) && riverDistance(item) <= maximumBuildingRiverDistanceM)
    .slice(0, maxBuildings);
  const buildings = [];
  let excludedSteepBuildingCount = 0;
  for (const building of buildingCandidates) {
    const widthM = Math.max(3, Math.min(60, Number(building.widthM) || 8));
    const depthM = Math.max(3, Math.min(60, Number(building.depthM) || 8));
    const base = sampleGround(building.longitude, building.latitude);
    if (footprintFitError(building, widthM, depthM, base) > maxBuildingTerrainFitErrorM) {
      excludedSteepBuildingCount += 1;
      continue;
    }
    buildings.push({ ...building, _base: base, _widthM: widthM, _depthM: depthM });
  }
  if (buildings.length) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const mesh = new THREE.InstancedMesh(geometry, material, buildings.length);
    mesh.name = 'osm-building-footprints';
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    buildings.forEach((building, index) => {
      const base = building._base;
      const normal = new THREE.Vector3(base.normal.x, base.normal.y, base.normal.z);
      const width = building._widthM;
      const depth = building._depthM;
      const height = Math.max(3, Math.min(25, Number(building.heightM) || 6)) * verticalExaggeration;
      quaternion.setFromUnitVectors(worldUp, normal);
      position.set(base.x + normal.x * height / 2, base.y + normal.y * height / 2, base.z + normal.z * height / 2);
      scale.set(width, height, depth);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      const baseColor = building.kind === 'commercial' ? 0xbdb4a2 : building.kind === 'industrial' ? 0xaaa99f : 0xc7c1b0;
      color.setHex(baseColor).offsetHSL(0, 0, ((index * 37) % 9 - 4) * 0.012);
      mesh.setColorAt(index, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const treeCandidates = data.trees.filter((item) => insideTerrain(item) && offChannel(item));
  const localLanduseTrees = treeCandidates.filter((item) => item.landuseProxy);
  const mappedTreePoints = treeCandidates.filter((item) => !item.landuseProxy);
  const trees = [...localLanduseTrees, ...mappedTreePoints].slice(0, maxTrees);
  if (trees.length) {
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.18, 0.24, 1, 5),
      new THREE.MeshStandardMaterial({ color: 0x614a32, roughness: 1 }),
      trees.length,
    );
    trunk.name = 'osm-tree-trunks';
    const canopy = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 6),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 }),
      trees.length,
    );
    canopy.name = 'osm-tree-canopies';
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    trees.forEach((tree, index) => {
      const base = sampleGround(tree.longitude, tree.latitude);
      const height = Math.max(4, Math.min(22, Number(tree.heightM) || 10)) * verticalExaggeration;
      const trunkHeight = height * 0.36;
      const crownHeight = height * 0.64;
      const crownRadius = height * 0.22;
      position.set(base.x, base.y + trunkHeight / 2, base.z);
      scale.set(height * 0.035, trunkHeight, height * 0.035);
      matrix.compose(position, quaternion, scale);
      trunk.setMatrixAt(index, matrix);
      position.set(base.x, base.y + trunkHeight + crownHeight / 2, base.z);
      scale.set(crownRadius, crownHeight, crownRadius);
      matrix.compose(position, quaternion, scale);
      canopy.setMatrixAt(index, matrix);
      color.setHex([0x3d754a, 0x4b8050, 0x568955][index % 3]);
      canopy.setColorAt(index, color);
    });
    trunk.instanceMatrix.needsUpdate = true;
    canopy.instanceMatrix.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    trunk.castShadow = true;
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    group.add(trunk, canopy);
  }
  group.userData.buildingCount = buildings.length;
  group.userData.excludedSteepBuildingCount = excludedSteepBuildingCount;
  group.userData.maxBuildingTerrainFitErrorM = maxBuildingTerrainFitErrorM;
  group.userData.treeCount = trees.length;
  group.userData.minimumRiverClearanceM = minimumRiverClearanceM;
  group.userData.buildingMaxRiverDistanceM = maximumBuildingRiverDistanceM;
  group.userData.buildingsAreFootprintProxies = true;
  group.userData.renderedLocations = [...buildings, ...trees].map((item) => ({ longitude: item.longitude, latitude: item.latitude, kind: item.kind ?? 'tree' }));
  return group;
}
