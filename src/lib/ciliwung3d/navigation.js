export function geoToMap(longitude, latitude, bounds, width, height) {
  return {
    x: (longitude - bounds.west) / (bounds.east - bounds.west) * (width - 1),
    y: (bounds.north - latitude) / (bounds.north - bounds.south) * (height - 1),
  };
}

export function mapToGeo(x, y, bounds, width, height) {
  const nx = width <= 1 ? 0 : x / (width - 1);
  const ny = height <= 1 ? 0 : y / (height - 1);
  return {
    longitude: bounds.west + nx * (bounds.east - bounds.west),
    latitude: bounds.north - ny * (bounds.north - bounds.south),
  };
}

export function geoToWorld(longitude, latitude, elevationMeters, origin, verticalExaggeration = 1) {
  const latitudeOrigin = origin.latitude;
  const metersPerDegreeLon = 111320 * Math.cos(latitudeOrigin * Math.PI / 180);
  return {
    x: (longitude - origin.longitude) * metersPerDegreeLon,
    y: (elevationMeters - origin.minimumElevationMeters) * verticalExaggeration,
    z: (origin.latitude - latitude) * 111320,
  };
}

export function worldToGeo(x, z, origin) {
  const metersPerDegreeLon = 111320 * Math.cos(origin.latitude * Math.PI / 180);
  return {
    longitude: origin.longitude + x / metersPerDegreeLon,
    latitude: origin.latitude - z / 111320,
  };
}

export function createCameraNavigator({ camera, controls, now = () => performance.now() }) {
  let flight = null;
  const vec = (source) => ({ x: source.x, y: source.y, z: source.z });
  const apply = (target, cameraPosition) => {
    controls.target.set(target.x, target.y, target.z);
    camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    controls.update();
  };

  /**
   * @param {{ x: number, y: number, z: number }} position
   * @param {{ distance?: number, durationMs?: number, targetHeight?: number, direction?: { x?: number, y?: number, z?: number } | null }} [options]
   */
  function flyTo(position, { distance = 180, durationMs = 1400, targetHeight = 1.2, direction = null } = {}) {
    const startTarget = vec(controls.target);
    const startCamera = vec(camera.position);
    const dir = direction
      ? { x: direction.x ?? 0, y: direction.y ?? 0, z: direction.z ?? 0 }
      : {
          x: startCamera.x - startTarget.x,
          y: startCamera.y - startTarget.y,
          z: startCamera.z - startTarget.z,
        };
    let length = Math.hypot(dir.x, dir.y, dir.z);
    if (length < 1e-6) {
      dir.x = 0.35;
      dir.y = 0.62;
      dir.z = 0.70;
      length = Math.hypot(dir.x, dir.y, dir.z);
    }
    dir.x /= length;
    dir.y /= length;
    dir.z /= length;
    const target = { x: position.x, y: position.y + targetHeight, z: position.z };
    const cameraPosition = {
      x: target.x + dir.x * distance,
      y: target.y + Math.max(Math.min(45, distance * 0.55), dir.y * distance),
      z: target.z + dir.z * distance,
    };
    flight = { startTarget, startCamera, target, cameraPosition, startTime: now(), durationMs };
  }

  function update() {
    if (!flight) return false;
    const t = Math.min(1, (now() - flight.startTime) / flight.durationMs);
    const eased = t * t * (3 - 2 * t);
    const mix = (a, b) => a + (b - a) * eased;
    const target = {
      x: mix(flight.startTarget.x, flight.target.x),
      y: mix(flight.startTarget.y, flight.target.y),
      z: mix(flight.startTarget.z, flight.target.z),
    };
    const position = {
      x: mix(flight.startCamera.x, flight.cameraPosition.x),
      y: mix(flight.startCamera.y, flight.cameraPosition.y),
      z: mix(flight.startCamera.z, flight.cameraPosition.z),
    };
    apply(target, position);
    if (t >= 1) flight = null;
    return true;
  }

  return { flyTo, update, get flying() { return flight !== null; } };
}
