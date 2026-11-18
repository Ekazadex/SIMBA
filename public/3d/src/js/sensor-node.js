export function createSensorPole(THREE, node, armDirection = { x: 1, z: 0 }) {
  const group = new THREE.Group();
  group.name = `sensor-${node.id}`;
  group.userData.nodeId = node.id;
  group.userData.nodeName = node.name;
  const mastHeightIncreaseM = 1.0;
  const mastHeightM = 3.0 + mastHeightIncreaseM;
  group.userData.dimensions = { mastHeightM, armLengthM: 3.0, enclosureWidthM: 0.48, enclosureHeightM: 0.36, enclosureDepthM: 0.38 };

  const steel = new THREE.MeshStandardMaterial({ color: 0x657078, metalness: 0.72, roughness: 0.34 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x30383c, metalness: 0.58, roughness: 0.42 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x898c83, roughness: 0.94 });
  const enclosureMaterial = new THREE.MeshStandardMaterial({ color: 0x171b1e, roughness: 0.72, metalness: 0.12 });
  const transducerMaterial = new THREE.MeshStandardMaterial({ color: 0xb7c1bf, metalness: 0.68, roughness: 0.28 });
  const indicatorMaterial = new THREE.MeshStandardMaterial({ color: 0x63df9b, emissive: 0x1c6b42, emissiveIntensity: 0.65 });

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.18, 14), concrete);
  base.name = 'concrete-base';
  base.position.y = 0.09;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, mastHeightM, 12), steel);
  mast.name = 'steel-mast';
  mast.position.y = mastHeightM / 2;
  mast.castShadow = true;
  mast.receiveShadow = true;
  group.add(mast);

  const horizontal = new THREE.Vector3(armDirection.x ?? 1, 0, armDirection.z ?? 0);
  if (horizontal.lengthSq() < 1e-8) horizontal.set(1, 0, 0);
  horizontal.normalize();
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.042, 3.0, 10), darkSteel);
  arm.name = 'single-arm';
  arm.position.set(horizontal.x * 1.5, 2.72 + mastHeightIncreaseM, horizontal.z * 1.5);
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), horizontal);
  arm.castShadow = true;
  arm.receiveShadow = true;
  group.add(arm);

  const enclosure = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.36, 0.38), enclosureMaterial);
  enclosure.name = 'sensor-enclosure';
  enclosure.position.set(horizontal.x * 2.95, 2.58 + mastHeightIncreaseM, horizontal.z * 2.95);
  enclosure.castShadow = true;
  enclosure.receiveShadow = true;
  group.add(enclosure);

  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.16, 0.055), darkSteel);
  bracket.name = 'enclosure-bracket';
  bracket.position.set(horizontal.x * 2.95, 2.74 + mastHeightIncreaseM, horizontal.z * 2.95);
  bracket.castShadow = true;
  group.add(bracket);

  const sensorHead = new THREE.Group();
  sensorHead.name = 'ultrasonic-head';
  sensorHead.userData.aim = 'downward';
  sensorHead.position.set(horizontal.x * 2.95, 2.43 + mastHeightIncreaseM, horizontal.z * 2.95);
  const transducerBody = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.065, 16), darkSteel);
  transducerBody.position.y = -0.03;
  transducerBody.castShadow = true;
  sensorHead.add(transducerBody);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.012, 16), transducerMaterial);
  face.position.y = -0.069;
  sensorHead.add(face);
  group.add(sensorHead);

  const led = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), indicatorMaterial);
  led.name = 'status-indicator';
  led.position.set(horizontal.x * 3.12, 2.60 + mastHeightIncreaseM, horizontal.z * 3.12);
  group.add(led);

  const position = node.position ?? {
    x: node.sceneX ?? 0,
    y: node.sceneY ?? node.groundY ?? 0,
    z: node.sceneZ ?? 0,
  };
  group.position.set(position.x, position.y, position.z);
  group.traverse((object) => {
    if (object.isMesh) {
      object.userData.sensorStationId = node.id;
    }
  });
  return group;
}
