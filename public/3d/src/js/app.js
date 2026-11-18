import * as THREE from '../../vendor/three.module.js';
import { loadSceneAssets } from './assets.js';
import { buildSceneApp } from './scene.js';
import { createCameraNavigator } from './navigation.js';
import { createMapPanController } from './map-pan.js';
import { createHydrologyState, resetHydrology, stepHydrology } from './hydrology.js';
import { createBackendSimulationClient, applyBackendSnapshot, REQUIRED_NODE_IDS } from './backend-simulation.js';
import { standaloneStageRises } from './standalone-stages.js';

const MAP_BOUNDS = { west: 106.75, east: 106.99, south: -6.72, north: -6.08 };
const HYDROLOGY_CONFIG = {
  nodeIds: ['N1', 'N2', 'N3', 'N4', 'N5'],
  // Short scenario-time delays keep the downstream cascade observable during a demo.
  reachLagSeconds: [240, 210, 180, 150],
  attenuation: [0.78, 0.82, 0.85, 0.88],
  runoffCoefficient: 0.35,
  stageMetersPerRunoffMillimeter: 0.07,
  recessionTimeSeconds: 1200,
};

const queryParams = new URLSearchParams(window.location.search);
const HARDWARE_MODE = queryParams.get('mode') === 'hardware';
const BACKEND_MODE = HARDWARE_MODE || queryParams.get('mode') === 'backend';
const HARDWARE_NODE_IDS = Object.freeze(['N1', 'N2', 'N3', 'N4', 'N5']);
const requestedNodeIds = queryParams.get('nodes')
  ? queryParams.get('nodes').split(',').map((id) => id.trim()).filter(Boolean)
  : [];
const BACKEND_NODE_IDS = HARDWARE_MODE
  ? (requestedNodeIds.filter((id) => HARDWARE_NODE_IDS.includes(id)).length > 0
    ? requestedNodeIds.filter((id) => HARDWARE_NODE_IDS.includes(id))
    : HARDWARE_NODE_IDS)
  : (requestedNodeIds.length > 0 ? requestedNodeIds : REQUIRED_NODE_IDS);
const BACKEND_STREAM_URL = queryParams.get('api') || (HARDWARE_MODE
  ? '/api/ciliwung-hardware/stream'
  : '/api/ciliwung-simulation/stream');

const $ = (selector) => document.querySelector(selector);
const canvas = $('#scene');
const loading = $('#loading');
const loadingText = $('#loading-text');
const errorBanner = $('#error-banner');
const hud = $('#hud');
const timeLabel = $('#sim-time');
const backendTimeLabel = $('#backend-sim-time');
const playButton = $('#play-button');
const state = {
  running: false,
  speed: Number($('#speed-select').value),
  rainfall: [0, 0, 0, 0, 0],
  selectedIndex: 0,
  hydrology: null,
  snapshot: null,
  scene: null,
  navigator: null,
  mapPan: null,
  backendMode: BACKEND_MODE,
  backendClient: null,
  lastFrameMs: null,
  toastTimer: 0,
};

function showError(error) {
  console.error('[ciliwung-app]', error);
  loading.hidden = true;
  errorBanner.hidden = false;
  errorBanner.textContent = `Aplikasi tidak dapat dimuat: ${error?.message ?? error}. Jalankan melalui server lokal, bukan dengan membuka file langsung.`;
}

function formatClock(seconds) {
  const totalMinutes = Math.floor(seconds / 60);
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => el.classList.remove('visible'), 2400);
}

function setSelectedNode(index, { fly = true } = {}) {
  if (!state.scene || !Number.isInteger(index) || index < 0 || index >= state.scene.stations.length) return;
  state.selectedIndex = index;
  const station = state.scene.stations[index];
  $('#selected-name').textContent = station.name;
  $('#selected-elevation').textContent = `${station.elevationM.toFixed(0)} m · SRTM`;
  document.querySelectorAll('.station-row').forEach((el, i) => el.classList.toggle('active', i === index));
  document.querySelectorAll('.map-marker').forEach((el, i) => {
    el.classList.toggle('active', i === index);
    el.setAttribute('aria-pressed', String(i === index));
  });
  state.scene.stations.forEach((item, i) => { item.selectionRing.visible = i === index; });
  state.scene.stations.forEach((item, i) => { if (item.sensorTargetGroup) item.sensorTargetGroup.visible = i === index; });
  renderReadings();
  renderForecast();
  if (fly) {
    state.navigator.flyTo(station.sensorTargetPosition, {
      distance: 24,
      durationMs: 1450,
      targetHeight: 0,
      direction: station.cameraDirection,
    });
    toast(`Terbang ke ${station.name}. Orbit dan zoom tetap aktif.`);
  }
}

function renderReadings() {
  if (!state.snapshot || !state.scene) return;
  const readingNodes = state.snapshot.threeDNodes ?? state.snapshot.nodes ?? [];
  const readingsById = state.backendMode ? new Map(readingNodes.map((node) => [node.id, node])) : null;
  const standaloneById = !readingsById ? new Map(readingNodes.map((node) => [node.id, node])) : null;
  state.scene.stations.forEach((station) => {
    const reading = (readingsById ?? standaloneById).get(station.id) ?? { stageRiseM: 0 };
    station.stageRiseM = Number(reading.stageRiseM) || 0;
    const row = document.querySelector(`[data-station-row="${station.id}"]`);
    if (row) row.querySelector('.station-meta').textContent = `+${station.stageRiseM.toFixed(2)} m`;
  });
  const selected = state.scene.stations[state.selectedIndex];
  $('#selected-stage').textContent = `+${selected.stageRiseM.toFixed(2)} m`;
  if (state.backendMode) {
    const currentTma = state.snapshot.status === 'idle' ? null : readingsById.get(selected.id)?.tmaCm;
    $('#selected-tma').textContent = Number.isFinite(currentTma)
      ? `${currentTma.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} cm`
      : '—';
  }
  const clock = formatClock(Number(state.backendMode ? state.snapshot.simTimeSeconds : state.snapshot.timeSeconds) || 0);
  timeLabel.textContent = clock;
  if (state.backendMode) {
    const measuredAt = state.snapshot.hardware?.measuredAt;
    backendTimeLabel.textContent = HARDWARE_MODE
      ? (measuredAt && Number.isFinite(Date.parse(measuredAt)) ? new Date(measuredAt).toLocaleTimeString('id-ID') : 'Menunggu data')
      : clock;
  }
}

function renderForecast() {
  if (!state.backendMode || HARDWARE_MODE || !state.scene) return;
  const panel = $('#forecast-panel');
  panel.hidden = false;
  const station = state.scene.stations[state.selectedIndex];
  const nodeId = station.id;
  $('#forecast-node').textContent = station.name;
  const forecast = state.backendClient?.getForecast(nodeId);
  const available = forecast?.status === 'available';
  $('#forecast-unavailable').hidden = available;
  $('#forecast-results').hidden = !available;
  if (!available) {
    for (const minutes of [30, 60]) {
      $(`#forecast-${minutes}-level`).textContent = '—';
      $(`#forecast-${minutes}-crossing`).textContent = '—';
    }
    $('#forecast-issue').textContent = '—';
    $('#forecast-method').textContent = '—';
    const reasons = {
      pending: 'model sedang menghitung',
      no_active_replay: 'replay belum aktif',
      insufficient_history: 'riwayat data belum cukup',
      stale_input: 'data masukan kedaluwarsa',
      unmapped_station: 'node ini belum memiliki model',
      model_unavailable: 'model belum tersedia',
    };
    const detail = reasons[forecast?.reason] ?? (forecast?.reason ? String(forecast.reason).replaceAll('_', ' ') : 'belum ada prediksi aktif');
    $('#forecast-unavailable').textContent = `Prediksi tidak tersedia untuk ${station.name}: ${detail}.`;
    return;
  }
  const current = state.snapshot?.threeDNodes?.find((node) => node.id === nodeId);
  const alreadyAbove = Number.isFinite(current?.tmaCm) && Number.isFinite(forecast.thresholdBanjirCm)
    && current.tmaCm >= forecast.thresholdBanjirCm;
  const thresholdDefined = Number.isFinite(forecast.thresholdBanjirCm);
  for (const minutes of [30, 60]) {
    $(`#forecast-${minutes}-level`).textContent = `${forecast.predictedTmaCm[minutes].toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} cm`;
    $(`#forecast-${minutes}-crossing`).textContent = !thresholdDefined
      ? 'Tidak ada ambang banjir yang didefinisikan'
      : alreadyAbove
      ? 'Ambang banjir sudah tercapai saat ini'
      : forecast.crossingWithin[minutes] ? 'Ambang banjir terindikasi tercapai' : 'Ambang banjir belum terindikasi';
  }
  $('#forecast-issue').textContent = `Diterbitkan ${new Date(forecast.issuedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} WIB (waktu simulasi)`;
  $('#forecast-method').textContent = `Metode ${forecast.method ?? 'tidak diketahui'} · model ${forecast.modelVersion ?? 'tidak diketahui'} · eksperimental`;
}

function buildRainControls(stations) {
  const holder = $('#rain-controls');
  holder.replaceChildren();
  stations.filter((station) => HYDROLOGY_CONFIG.nodeIds.includes(station.id)).forEach((station, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'rain-row';
    const label = document.createElement('label');
    label.htmlFor = `rain-${station.id}`;
    label.textContent = station.name;
    const output = document.createElement('output');
    output.htmlFor = `rain-${station.id}`;
    output.id = `rain-value-${station.id}`;
    output.textContent = '0';
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `rain-${station.id}`;
    input.min = '0';
    input.max = '120';
    input.step = '5';
    input.value = '0';
    input.setAttribute('aria-label', `Curah hujan wilayah ${station.name}, milimeter per jam`);
    input.addEventListener('input', () => {
      state.rainfall[index] = Number(input.value);
      output.textContent = input.value;
      if (Number(input.value) > 0 && !state.running) toast('Atur slider node lain bila perlu, lalu mulai simulasi untuk melihat rambatan.');
    });
    wrapper.append(label, output, input);
    holder.append(wrapper);
  });
}

function setRainfall(values) {
  state.rainfall = HYDROLOGY_CONFIG.nodeIds.map((_, index) => Math.max(0, Math.min(120, Number(values[index]) || 0)));
  state.rainfall.forEach((value, index) => {
    const id = HYDROLOGY_CONFIG.nodeIds[index];
    const input = $(`#rain-${id}`);
    input.value = String(value);
    $(`#rain-value-${id}`).textContent = String(value);
  });
}

function buildStationList(stations) {
  const list = $('#station-list');
  list.replaceChildren();
  stations.forEach((station, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'station-row';
    button.dataset.stationRow = station.id;
    button.innerHTML = `<span class="station-title"></span><span class="station-meta">+0.00 m</span>`;
    button.querySelector('.station-title').textContent = station.name;
    button.setAttribute('aria-label', `Terbang ke ${station.name}, elevasi ${station.elevationM.toFixed(0)} meter`);
    button.addEventListener('click', () => setSelectedNode(index));
    list.append(button);
  });
}

function buildMapMarkers(stations, mapMetadata) {
  const holder = $('#map-markers');
  holder.replaceChildren();
  const bounds = mapMetadata.bounds ?? MAP_BOUNDS;
  stations.forEach((station, index) => {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'map-marker';
    marker.style.left = `${((station.displayLongitude ?? station.longitude) - bounds.west) / (bounds.east - bounds.west) * 100}%`;
    marker.style.top = `${(bounds.north - (station.displayLatitude ?? station.latitude)) / (bounds.north - bounds.south) * 100}%`;
    marker.setAttribute('aria-label', `Navigasi peta ke ${station.name}`);
    marker.title = station.name;
    marker.addEventListener('click', () => setSelectedNode(index));
    holder.append(marker);
  });
}

function buildSelectionRings(sceneApp) {
  sceneApp.stations.forEach((station, index) => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.0, 40),
      new THREE.MeshBasicMaterial({ color: 0xe5ff91, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthWrite: false }),
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

function installBackendMode() {
  document.body.classList.add('backend-simulation-mode');
  $('#backend-sim-clock').hidden = false;
  if (HARDWARE_MODE) $('#backend-sim-clock span').textContent = 'Waktu data';
  $('#current-tma-reading').hidden = false;
  const controlPanel = document.querySelector('.control-panel');
  if (controlPanel) {
    controlPanel.hidden = true;
    controlPanel.style.setProperty('display', 'none', 'important');
  }
  const banner = $('#backend-mode-banner');
  if (banner) {
    banner.hidden = false;
    banner.textContent = HARDWARE_MODE
      ? 'LIVE HARDWARE AKTIF · DEPOT KE LAUT JAWA · ESP32 N1'
      : 'MODE BACKEND AKTIF · DATA DARI SIMBA CILIWUNG';
  }
  [playButton, $('#reset-button'), $('#speed-select')].forEach((control) => {
    if (control) {
      control.disabled = true;
      control.setAttribute('aria-disabled', 'true');
    }
  });
  document.querySelectorAll('#rain-controls input, [data-preset]').forEach((control) => {
    control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
  });

  state.backendClient = createBackendSimulationClient({
    nodeIds: BACKEND_NODE_IDS,
    onSnapshot: (snapshot) => {
      if (!state.scene) return;
      state.snapshot = snapshot;
      if (HARDWARE_MODE && banner) {
        banner.textContent = snapshot.status !== 'running'
          ? 'MENUNGGU DATA · DEPOK KE LAUT JAWA'
          : snapshot.hardware?.valueType === 'simulation'
            ? 'SIMULASI PENGATURAN · BUKAN DATA ESP32'
            : 'LIVE HARDWARE AKTIF · DEPOK KE LAUT JAWA · ESP32 N1';
      }
      applyBackendSnapshot(state.scene, snapshot, BACKEND_NODE_IDS);
      renderReadings();
      renderForecast();
      if (snapshot.status === 'completed') {
        toast(`Scenario ${snapshot.scenario} selesai pada ${snapshot.targetNodeId}.`);
      }
    },
    onForecast: () => renderForecast(),
    onError: (error) => {
      console.warn('[ciliwung-backend-stream]', error);
      toast('Stream backend simulasi terputus. Pastikan server Website aktif.');
    },
  });
  state.backendClient.connect(BACKEND_STREAM_URL);
  renderForecast();
}

function installInteractions() {
  $('#sea-view-button').addEventListener('click', () => {
    state.navigator.flyTo(state.scene.seaViewPosition, {
      distance: 1200,
      durationMs: 1650,
      targetHeight: 0,
      direction: { x: 0.2, y: 0.04, z: 1 }
    });
    toast('Muara Ciliwung dan Laut Jawa · garis pantai disederhanakan untuk visualisasi.');
  });
  playButton.addEventListener('click', () => {
    state.running = !state.running;
    playButton.textContent = state.running ? '❚❚ Jeda simulasi' : '▶ Lanjutkan simulasi';
  });
  $('#reset-button').addEventListener('click', () => {
    resetHydrology(state.hydrology);
    state.snapshot = {
      timeSeconds: 0,
      nodes: HYDROLOGY_CONFIG.nodeIds.map((id) => ({ id, stageRiseM: 0, runoffIndex: 0, inflowRunoffMm: 0 })),
      pendingReachCount: 0,
    };
    state.scene.setWaterStages(standaloneStageRises(state.snapshot.nodes, state.scene.stations.map((station) => station.id)));
    state.running = false;
    state.lastFrameMs = null;
    playButton.textContent = '▶ Mulai simulasi';
    renderReadings();
    toast('Simulasi direset. Hujan tetap sesuai pengaturan terakhir.');
  });
  $('#speed-select').addEventListener('change', (event) => { state.speed = Number(event.target.value); });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.preset;
      if (preset === 'upstream') setRainfall([80, 0, 0, 0, 0]);
      else if (preset === 'basin') setRainfall([55, 55, 55, 55, 55]);
      else setRainfall([0, 0, 0, 0, 0]);
      toast(preset === 'upstream' ? 'Hujan 80 mm/jam di hulu N1 saja. Mulai simulasi untuk mengikuti alirannya.' : preset === 'basin' ? 'Hujan 55 mm/jam dipasang di semua wilayah.' : 'Semua wilayah dikeringkan. Tekan Reset untuk menghapus simpanan limpasan.');
    });
  });
}

async function start() {
  try {
    loadingText.textContent = 'Memuat data peta dan elevasi lokal…';
    const [assets, mapResponse] = await Promise.all([
      loadSceneAssets('./assets/'),
      fetch('./assets/map/metadata.json'),
    ]);
    if (!mapResponse.ok) throw new Error(`Could not load map metadata: HTTP ${mapResponse.status}`);
    const mapMetadata = await mapResponse.json();
    loadingText.textContent = 'Membangun terrain dan saluran 3D…';
    const scopedNodeData = BACKEND_MODE && queryParams.get('nodes')
      ? { ...assets.nodeData, nodes: assets.nodeData.nodes.filter((node) => BACKEND_NODE_IDS.includes(node.id)) }
      : assets.nodeData;
    // Keep the complete mapped river and terrain. Hardware mode restricts station access, not geometry.
    const scopedRiverAsset = assets.riverAsset;
    state.scene = buildSceneApp(canvas, assets.terrain, scopedRiverAsset, scopedNodeData, assets.environmentData);
    buildSelectionRings(state.scene);
    state.navigator = createCameraNavigator({ camera: state.scene.camera, controls: state.scene.controls });
    buildRainControls(state.scene.stations);
    buildStationList(state.scene.stations);
    buildMapMarkers(state.scene.stations, mapMetadata);
    state.hydrology = createHydrologyState(HYDROLOGY_CONFIG);
    state.snapshot = {
      timeSeconds: 0,
      pendingReachCount: 0,
      nodes: HYDROLOGY_CONFIG.nodeIds.map((id) => ({ id, runoffIndex: 0, inflowRunoffMm: 0, stageRiseM: 0 })),
    };
    installInteractions();
    const initialStationIndex = Math.max(0, state.scene.stations.findIndex((station) => station.id === 'N1'));
    setSelectedNode(initialStationIndex, { fly: false });
    const firstStation = state.scene.stations[initialStationIndex];
    if (HARDWARE_MODE) {
      state.navigator.flyTo(firstStation.sensorTargetPosition, {
        distance: 280,
        durationMs: 700,
        targetHeight: 5,
        direction: { x: 0.38, y: 0.08, z: 0.92 },
      });
    } else {
      state.navigator.flyTo(firstStation.sensorTargetPosition, {
        distance: 24,
        durationMs: 950,
        targetHeight: 0,
        direction: firstStation.cameraDirection,
      });
    }
    hud.hidden = false;
    loading.hidden = true;
    state.mapPan = createMapPanController({
      viewport: $('#map-wrap'),
      content: $('#map-content'),
      image: $('#area-map'),
      mapPanel: $('.map-panel'),
      statusPanel: $('.status-panel'),
      fitButton: $('#map-fit-button'),
    });
    window.addEventListener('embed-focus-map', () => state.mapPan?.focusMarkers());
    document.documentElement.dataset.appReady = 'true';
    window.__CILIWUNG_APP__ = {
      scene: state.scene,
      hydrology: state.hydrology,
      backendMode: state.backendMode,
      mapPan: state.mapPan,
      get snapshot() { return state.snapshot; },
      setRainfall,
      selectNode: setSelectedNode,
      closeBackend() { state.backendClient?.close(); },
      start() { state.running = true; playButton.textContent = '❚❚ Jeda simulasi'; },
      stop() { state.running = false; playButton.textContent = '▶ Lanjutkan simulasi'; },
      step(seconds) {
        state.snapshot = stepHydrology(state.hydrology, state.rainfall, seconds, HYDROLOGY_CONFIG);
        state.scene.setWaterStages(standaloneStageRises(state.snapshot.nodes, state.scene.stations.map((station) => station.id)));
        state.scene.updateFlowParticles(state.snapshot.timeSeconds, state.snapshot.nodes.reduce((sum, node) => sum + node.runoffIndex, 0) / 5);
        renderReadings();
        return state.snapshot;
      },
      selfTest: () => ({
        ready: document.documentElement.dataset.appReady === 'true',
        terrainVertexCount: state.scene.terrainMesh.geometry.getAttribute('position').count,
        riverPointCount: state.scene.riverPoints.length,
        channelMeshes: state.scene.river.group.children.map((child) => child.name),
        freeboardM: state.scene.river.freeboardM,
        flowParticleShape: state.scene.particlePoints.userData.shape,
        seaMeshNames: state.scene.sea.group.children.map((child) => child.name),
        seaViewPosition: state.scene.seaViewPosition,
        environmentCounts: {
          buildings: state.scene.environment.userData.buildingCount,
          trees: state.scene.environment.userData.treeCount,
          buildingMaxRiverDistanceM: state.scene.environment.userData.buildingMaxRiverDistanceM,
        },
        floodplainState: state.scene.floodplainState,
        sensorNodeIds: state.scene.stations.map((station) => station.id),
        sensorModels: state.scene.stations.map((station) => ({
          id: station.id,
          componentNames: station.pole.children.map((child) => child.name),
          mastHeightM: station.pole.userData.dimensions.mastHeightM,
          armLengthM: station.pole.userData.dimensions.armLengthM,
          enclosureWidthM: station.pole.userData.dimensions.enclosureWidthM,
          enclosureColor: station.pole.getObjectByName('sensor-enclosure').material.color.getHex(),
        })),
        sensorPlacements: state.scene.stations.map((station) => ({
          id: station.id,
          movedToBank: station.placement.movedToBank,
          riverOffsetMeters: station.riverOffsetMeters,
          sourceLongitude: station.longitude,
          sourceLatitude: station.latitude,
          displayLongitude: station.displayLongitude,
          displayLatitude: station.displayLatitude,
          nearestEnvironmentDistanceM: station.nearestEnvironmentDistanceM,
        })),
        mapMarkerCount: document.querySelectorAll('.map-marker').length,
        mapLoaded: $('#area-map').complete && $('#area-map').naturalWidth > 0,
      }),
    };
    if (state.backendMode) installBackendMode();
    let reportEvery = 0;
    let lastFrameMs = null;
    function animate(now) {
      requestAnimationFrame(animate);
      const dtReal = lastFrameMs === null ? 0 : Math.max(0, Math.min(0.1, (now - lastFrameMs) / 1000));
      lastFrameMs = now;
      state.navigator.update();
      if (state.running && !state.backendMode && dtReal > 0) {
        state.snapshot = stepHydrology(state.hydrology, state.rainfall, dtReal * state.speed, HYDROLOGY_CONFIG);
        state.scene.setWaterStages(standaloneStageRises(state.snapshot.nodes, state.scene.stations.map((station) => station.id)));
        state.scene.updateFlowParticles(state.snapshot.timeSeconds, state.snapshot.nodes.reduce((sum, node) => sum + node.runoffIndex, 0) / 5);
        reportEvery += dtReal;
        if (reportEvery >= 0.18) {
          renderReadings();
          reportEvery = 0;
        }
      }
      if (HARDWARE_MODE && state.snapshot?.status === 'running') {
        const nodes = state.snapshot.threeDNodes ?? [];
        const averageRise = nodes.length ? nodes.reduce((sum, node) => sum + (Number(node.stageRiseM) || 0), 0) / nodes.length : 0;
        state.scene.updateFlowParticles(now / 1000, averageRise);
      }
      state.scene.render();
    }
    requestAnimationFrame(animate);
    window.addEventListener('resize', () => {
      state.scene.resize();
      state.mapPan?.resize();
    });
  } catch (error) {
    showError(error);
  }
}

start();
