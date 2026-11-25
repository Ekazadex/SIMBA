const METERS_PER_DEGREE = 111320;

function metricPoint(longitude, latitude, longitudeScale) {
  return { x: longitude * longitudeScale, z: -latitude * METERS_PER_DEGREE };
}

export function projectSensorStationToBank(station, riverCoordinates, options = {}) {
  if (!Number.isFinite(station?.longitude) || !Number.isFinite(station?.latitude)) {
    throw new TypeError('station must contain finite longitude and latitude');
  }
  if (!Array.isArray(riverCoordinates) || riverCoordinates.length < 2) {
    throw new TypeError('riverCoordinates must contain at least two longitude/latitude points');
  }
  const channelWidthM = options.channelWidthM ?? 30;
  const bankClearanceM = options.bankClearanceM ?? 0.5;
  const mountOffsetM = options.mountOffsetM;
  if (!Number.isFinite(channelWidthM) || channelWidthM <= 0 || !Number.isFinite(bankClearanceM) || bankClearanceM < 0
    || (mountOffsetM !== undefined && (!Number.isFinite(mountOffsetM) || mountOffsetM <= 0 || mountOffsetM >= channelWidthM))) {
    throw new RangeError('channel width must be positive, bank clearance non-negative, and optional mount offset inside the channel width');
  }
  const referenceLatitude = options.referenceLatitude ?? station.latitude;
  const longitudeScale = METERS_PER_DEGREE * Math.cos(referenceLatitude * Math.PI / 180);
  const sourcePoint = metricPoint(station.longitude, station.latitude, longitudeScale);
  let best = null;

  for (let i = 0; i < riverCoordinates.length - 1; i += 1) {
    const [lonA, latA] = riverCoordinates[i];
    const [lonB, latB] = riverCoordinates[i + 1];
    const a = metricPoint(lonA, latA, longitudeScale);
    const b = metricPoint(lonB, latB, longitudeScale);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared < 1e-8) continue;
    const t = Math.max(0, Math.min(1, ((sourcePoint.x - a.x) * dx + (sourcePoint.z - a.z) * dz) / lengthSquared));
    const center = { x: a.x + dx * t, z: a.z + dz * t };
    const deltaX = sourcePoint.x - center.x;
    const deltaZ = sourcePoint.z - center.z;
    const distance = Math.hypot(deltaX, deltaZ);
    if (best && distance >= best.distanceMeters) continue;
    const length = Math.sqrt(lengthSquared);
    best = {
      distanceMeters: distance,
      center,
      normal: { x: -dz / length, z: dx / length },
      segmentIndex: i,
      signedOffsetMeters: deltaX * (-dz / length) + deltaZ * (dx / length),
    };
  }
  if (!best) throw new Error('river centerline contains no non-zero segment');

  const bankOffsetMeters = mountOffsetM ?? channelWidthM / 2 + bankClearanceM;
  const maxSnapDistanceM = options.maxSnapDistanceM ?? 120;
  if (!Number.isFinite(maxSnapDistanceM) || maxSnapDistanceM < bankOffsetMeters) {
    throw new RangeError('maximum bank snap distance must be finite and at least the bank offset');
  }
  const movedToBank = best.distanceMeters <= maxSnapDistanceM;
  const side = best.signedOffsetMeters < 0 ? -1 : 1;
  const placement = movedToBank
    ? { x: best.center.x + best.normal.x * bankOffsetMeters * side, z: best.center.z + best.normal.z * bankOffsetMeters * side }
    : sourcePoint;
  return {
    sourceLongitude: station.longitude,
    sourceLatitude: station.latitude,
    longitude: placement.x / longitudeScale,
    latitude: -placement.z / METERS_PER_DEGREE,
    riverLongitude: best.center.x / longitudeScale,
    riverLatitude: -best.center.z / METERS_PER_DEGREE,
    riverDistanceMeters: best.distanceMeters,
    bankOffsetMeters: movedToBank ? bankOffsetMeters : best.distanceMeters,
    movedToBank,
    bankSide: side,
    nearestSegmentIndex: best.segmentIndex,
  };
}
