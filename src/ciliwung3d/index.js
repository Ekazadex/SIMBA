import * as THREE from 'three';
import { getEmbeddedCiliwungAssets } from './loadEmbeddedAssets.js';
import { buildSceneApp } from './scene.js';
import { createCameraNavigator } from './navigation.js';

const HARDWARE_NODE_IDS = ['N1', 'N2', 'N3', 'N4', 'N5'];
const SIMULATION_NODE_IDS = ['UP1', 'UP2', 'UP3', 'UP4', 'N1', 'N2', 'N3', 'N4', 'N5'];

function attachSelectionRings(sceneApp) {
  sceneApp.stations.forEach((station, index) => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.0, 40),
      new THREE.MeshBasicMaterial({
        color: 0xe5ff91,
        transparent: true,
        opacity: 0.88,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.name = `selection-${station.id}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(station.position.x, station.position.y + 0.35, station.position.z);
    mesh.visible = index === 0;
    mesh.renderOrder = 4;
    station.selectionRing = mesh;
    sceneApp.scene.add(mesh);
  });
}

export function buildCiliwung3DScene(canvas, { mode = 'hardware', initialNodeId = 'N1' } = {}) {
  const { terrain, riverAsset, nodeData, environmentData } = getEmbeddedCiliwungAssets();
  const allowedIds = mode === 'hardware' ? HARDWARE_NODE_IDS : SIMULATION_NODE_IDS;
  const filteredNodeData = {
    ...nodeData,
    nodes: nodeData.nodes.filter((node) => allowedIds.includes(node.id)),
  };

  const sceneApp = buildSceneApp(canvas, terrain, riverAsset, filteredNodeData, environmentData);
  attachSelectionRings(sceneApp);
  const navigator = createCameraNavigator({
    camera: sceneApp.camera,
    controls: sceneApp.controls,
  });

  let selectedId = null;

  function focusStationImmediately(station) {
    const dir = station.cameraDirection || { x: 0.55, y: 0.28, z: 0.78 };
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const distance = 28;
    const target = station.sensorTargetPosition || station.position;
    sceneApp.controls.target.set(target.x, target.y, target.z);
    sceneApp.camera.position.set(
      target.x + (dir.x / len) * distance,
      target.y + Math.max(14, (dir.y / len) * distance),
      target.z + (dir.z / len) * distance,
    );
    sceneApp.controls.update();
  }

  function selectNodeById(nodeId, { fly = true, immediate = false } = {}) {
    const index = sceneApp.stations.findIndex((s) => s.id === nodeId);
    const resolvedIndex = index >= 0 ? index : 0;
    const station = sceneApp.stations[resolvedIndex];
    if (!station) return null;
    selectedId = station.id;
    sceneApp.stations.forEach((item, i) => {
      if (item.selectionRing) item.selectionRing.visible = i === resolvedIndex;
      if (item.sensorTargetGroup) item.sensorTargetGroup.visible = i === resolvedIndex;
    });
    if (immediate) {
      focusStationImmediately(station);
    } else if (fly) {
      navigator.flyTo(station.sensorTargetPosition || station.position, {
        distance: 24,
        durationMs: 1350,
        targetHeight: 0,
        direction: station.cameraDirection,
      });
    }
    return station.id;
  }

  function flyToSea() {
    navigator.flyTo(sceneApp.seaViewPosition, {
      distance: 1200,
      durationMs: 1600,
      targetHeight: 0,
      direction: { x: 0.2, y: 0.04, z: 1 },
    });
  }

  function resetView() {
    const targetId = selectedId || initialNodeId || 'N1';
    selectNodeById(targetId, { fly: true });
  }

  function flyToOverview() {
    navigator.flyTo(sceneApp.initialTarget, {
      distance: 36000,
      durationMs: 1500,
      targetHeight: 0,
      direction: { x: 0.34, y: 0.62, z: 0.72 },
    });
  }

  function applyNodeLevels(nodes) {
    const map = new Map((nodes || []).map((n) => [n.id, n]));
    const stageRises = sceneApp.stations.map((station) => {
      const entry = map.get(station.id);
      const rawStage = Number(entry?.stageRiseM);
      if (Number.isFinite(rawStage) && rawStage >= 0) return rawStage;
      const tmaCm = Number(entry?.tmaCm);
      if (Number.isFinite(tmaCm) && tmaCm > 0) return Math.max(0, tmaCm / 100);
      return 0;
    });
    sceneApp.setWaterStages(stageRises);
    return stageRises;
  }

  // Place camera immediately at initial station so the user sees the river, trees, buildings, and sensor pole right away
  const defaultStationId = sceneApp.stations.some((s) => s.id === initialNodeId)
    ? initialNodeId
    : sceneApp.stations[0]?.id;
  if (defaultStationId) {
    selectNodeById(defaultStationId, { fly: false, immediate: true });
  }

  const stationsMeta = sceneApp.stations.map((station) => ({
    id: station.id,
    name: station.name,
    elevationM: station.elevationM,
    longitude: station.displayLongitude ?? station.longitude,
    latitude: station.displayLatitude ?? station.latitude,
  }));

  return {
    sceneApp,
    navigator,
    stationsMeta,
    selectNodeById,
    flyToSea,
    flyToOverview,
    resetView,
    applyNodeLevels,
    resize: (width, height) => sceneApp.resize(width, height),
    renderFrame: (elapsedSeconds, averageRunoff) => {
      navigator.update();
      sceneApp.updateFlowParticles(elapsedSeconds, averageRunoff);
      sceneApp.render();
    },
    dispose: () => sceneApp.dispose(),
  };
}
