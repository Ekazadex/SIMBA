import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Compass, Eye, EyeOff, Maximize2, RotateCcw, SlidersHorizontal, Waves } from 'lucide-react';

export type ThreeDStationStatus = 'AMAN' | 'SIAGA' | 'BANJIR_JAKARTA';

export interface ThreeDStationNode {
  id: string;
  name: string;
  tmaCm: number;
  stageRiseM?: number;
  status: ThreeDStationStatus;
  valueType?: 'actual_sensor' | 'derived_preset' | 'reset' | 'simulation';
  source?: string;
  rainRateMmH?: number | null;
}

export interface ThreeDForecastSummary {
  status?: string;
  predictedTmaCm?: { '30'?: number; '60'?: number };
  crossingWithin?: { '30'?: boolean | null; '60'?: boolean | null };
}

interface Ciliwung3DMapProps {
  mode: 'hardware' | 'simulation';
  nodes: ThreeDStationNode[];
  forecasts?: Record<string, ThreeDForecastSummary>;
  theme?: 'light' | 'dark';
  language?: 'id' | 'en';
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string) => void;
  isLive?: boolean;
  heightClassName?: string;
}

interface StationMeta {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

const ALL_STATIONS: StationMeta[] = [
  { id: 'UP1', name: 'Puncak', lat: -6.691768, lng: 106.9635388 },
  { id: 'UP2', name: 'Katulampa', lat: -6.6336889, lng: 106.834688 },
  { id: 'UP3', name: 'Sukaraja', lat: -6.5601124, lng: 106.809813 },
  { id: 'UP4', name: 'Cibinong', lat: -6.4650414, lng: 106.8180795 },
  { id: 'N1', name: 'Pos Depok', lat: -6.4005985, lng: 106.831685 },
  { id: 'N2', name: 'Stage 1', lat: -6.3499224, lng: 106.8385996 },
  { id: 'N3', name: 'Stage 2', lat: -6.3000107, lng: 106.8524555 },
  { id: 'N4', name: 'Stage 3', lat: -6.25, lng: 106.8631031 },
  { id: 'N5', name: 'Manggarai', lat: -6.2078464, lng: 106.8483991 },
];

type CameraPresetId = 'corridor' | 'upstream' | 'depok' | 'manggarai';

// Pre-allocated math helpers outside animation loop (zero per-frame GC)
const _colorTmp = new THREE.Color();
const _colorNormalWater = new THREE.Color(0x0ea5e9);
const _colorSiagaWater = new THREE.Color(0xf97316);
const _colorFloodWater = new THREE.Color(0x2563eb);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function statusHexColor(status?: ThreeDStationStatus, active = true): number {
  if (!active) return 0x64748b;
  if (status === 'BANJIR_JAKARTA') return 0x2563eb;
  if (status === 'SIAGA') return 0xf97316;
  return 0x22c55e;
}

function statusCssColor(status?: ThreeDStationStatus, active = true): string {
  if (!active) return '#64748B';
  if (status === 'BANJIR_JAKARTA') return '#3B82F6';
  if (status === 'SIAGA') return '#F97316';
  return '#22C55E';
}

function latLngToScene(
  lng: number,
  lat: number,
  bounds: { minLng: number; maxLng: number; minLat: number; maxLat: number }
) {
  const centerLng = (bounds.minLng + bounds.maxLng) / 2;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const span = Math.max(bounds.maxLng - bounds.minLng, bounds.maxLat - bounds.minLat, 0.05);
  const scale = 54 / span;
  const x = (lng - centerLng) * scale * 0.94;
  const z = -(lat - centerLat) * scale;
  return { x, z };
}

function detectSoftwareWebGL(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (!debugInfo) return false;
    const rawRenderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
    return /swiftshader|llvmpipe|software|mesa offscreen|angle.*basic render/i.test(rawRenderer);
  } catch {
    return false;
  }
}

function drawBadgeTexture(
  canvas: HTMLCanvasElement,
  id: string,
  name: string,
  tmaText: string,
  accentColor: string,
  isDark: boolean,
  selected: boolean
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = isDark ? 'rgba(13, 13, 18, 0.92)' : 'rgba(255, 255, 255, 0.96)';
  ctx.strokeStyle = selected ? '#38BDF8' : accentColor;
  ctx.lineWidth = selected ? 6 : 4;

  const r = 18;
  ctx.beginPath();
  ctx.moveTo(r + 4, 4);
  ctx.lineTo(w - r - 4, 4);
  ctx.quadraticCurveTo(w - 4, 4, w - 4, r + 4);
  ctx.lineTo(w - 4, h - r - 4);
  ctx.quadraticCurveTo(w - 4, h - 4, w - r - 4, h - 4);
  ctx.lineTo(r + 4, h - 4);
  ctx.quadraticCurveTo(4, h - 4, 4, h - r - 4);
  ctx.lineTo(4, r + 4);
  ctx.quadraticCurveTo(4, 4, r + 4, 4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(28, h / 2, 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = isDark ? '#F8FAFC' : '#0F172A';
  ctx.font = '700 23px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${id} · ${name}`, 48, 30);

  ctx.fillStyle = accentColor;
  ctx.font = '700 25px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(tmaText, 48, 64);
}

export default function Ciliwung3DMap({
  mode,
  nodes,
  forecasts = {},
  theme = 'dark',
  language = 'id',
  selectedNodeId = null,
  onSelectNode,
  isLive = true,
  heightClassName = 'h-[clamp(360px,62vh,640px)]',
}: Ciliwung3DMapProps) {
  const isDark = theme === 'dark';
  const en = language === 'en';

  const mountRef = useRef<HTMLDivElement | null>(null);
  const [centerline, setCenterline] = useState<Array<[number, number]>>([]);
  const [dockOpen, setDockOpen] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [activePreset, setActivePreset] = useState<CameraPresetId>('corridor');
  const [internalSelectedId, setInternalSelectedId] = useState<string>('N1');
  const [renderFailed, setRenderFailed] = useState(false);

  const effectiveSelectedId = selectedNodeId ?? internalSelectedId;

  const visibleStations = useMemo(() => {
    return mode === 'hardware'
      ? ALL_STATIONS.filter((s) => s.id.startsWith('N'))
      : ALL_STATIONS;
  }, [mode]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;
  const showLabelsRef = useRef(showLabels);
  showLabelsRef.current = showLabels;
  const selectedIdRef = useRef(effectiveSelectedId);
  selectedIdRef.current = effectiveSelectedId;
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

  const cameraTargetRef = useRef<{
    active: boolean;
    pos: THREE.Vector3;
    lookAt: THREE.Vector3;
  }>({
    active: false,
    pos: new THREE.Vector3(24, 15, 22),
    lookAt: new THREE.Vector3(0, 0.8, 0),
  });

  const stationPositionsRef = useRef<Record<string, THREE.Vector3>>({});

  useEffect(() => {
    let active = true;
    fetch('/assets/map/ciliwung_centerline.json')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('centerline'))))
      .then((data) => {
        if (active && Array.isArray(data?.coordinates) && data.coordinates.length > 4) {
          setCenterline(data.coordinates);
        }
      })
      .catch(() => {
        if (active) {
          setCenterline(ALL_STATIONS.map((s) => [s.lng, s.lat]));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const applyPreset = (preset: CameraPresetId) => {
    setActivePreset(preset);
    const stations = stationPositionsRef.current;
    if (preset === 'corridor') {
      cameraTargetRef.current = {
        active: true,
        pos: mode === 'hardware' ? new THREE.Vector3(22, 13.5, 20) : new THREE.Vector3(26, 16, 24),
        lookAt: new THREE.Vector3(0, 0.6, 0),
      };
    } else if (preset === 'upstream') {
      const target = stations.UP1 ?? stations.UP2 ?? stations.N1 ?? new THREE.Vector3(0, 0.6, 16);
      cameraTargetRef.current = {
        active: true,
        pos: new THREE.Vector3(target.x + 11, 8.5, target.z + 11),
        lookAt: target.clone(),
      };
    } else if (preset === 'depok') {
      const target = stations.N1 ?? new THREE.Vector3(0, 0.6, 8);
      cameraTargetRef.current = {
        active: true,
        pos: new THREE.Vector3(target.x + 9.5, 7.2, target.z + 9.5),
        lookAt: target.clone(),
      };
    } else if (preset === 'manggarai') {
      const target = stations.N5 ?? new THREE.Vector3(0, 0.6, -16);
      cameraTargetRef.current = {
        active: true,
        pos: new THREE.Vector3(target.x + 9.5, 7.2, target.z + 9.5),
        lookAt: target.clone(),
      };
    }
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return undefined;

    const rawPoints: Array<[number, number]> =
      centerline.length > 4 ? centerline : ALL_STATIONS.map((s) => [s.lng, s.lat]);

    // Corridor strictly between Pos Depok (N1) and Pintu Air Manggarai (N5) in hardware mode,
    // or Puncak (UP1) to Manggarai (N5) in 9-node simulation mode.
    const filteredCoords =
      mode === 'hardware'
        ? rawPoints.filter(([, lat]) => lat >= -6.405 && lat <= -6.204)
        : rawPoints.filter(([, lat]) => lat >= -6.695 && lat <= -6.204);

    const riverCoords =
      filteredCoords.length >= 4
        ? filteredCoords
        : visibleStations.map((s) => [s.lng, s.lat] as [number, number]);

    const bounds = riverCoords.reduce(
      (acc, [lng, lat]) => ({
        minLng: Math.min(acc.minLng, lng),
        maxLng: Math.max(acc.maxLng, lng),
        minLat: Math.min(acc.minLat, lat),
        maxLat: Math.max(acc.maxLat, lat),
      }),
      { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity }
    );

    // Flat river channel elevation (zero mountain slope — matches real corridor look)
    const curvePoints = riverCoords
      .filter((_, idx) => idx % Math.max(1, Math.floor(riverCoords.length / 64)) === 0 || idx === riverCoords.length - 1)
      .map(([lng, lat]) => {
        const { x, z } = latLngToScene(lng, lat, bounds);
        return new THREE.Vector3(x, 0.0, z);
      });

    const riverCurve = new THREE.CatmullRomCurve3(curvePoints);
    const sampledRiver = riverCurve.getPoints(120);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      setRenderFailed(true);
      return undefined;
    }

    const softwareGl = detectSoftwareWebGL(renderer);
    renderer.setPixelRatio(softwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = isDarkRef.current ? 1.02 : 1.06;
    renderer.shadowMap.enabled = !softwareGl;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const width = container.clientWidth || 640;
    const height = container.clientHeight || 420;
    renderer.setSize(width, height);
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const skyHex = isDarkRef.current ? 0x0e1726 : 0xdff0fc;
    scene.background = new THREE.Color(skyHex);
    scene.fog = new THREE.FogExp2(skyHex, 0.0072);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;

    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 260);
    if (mode === 'hardware') {
      camera.position.set(22, 13.5, 20);
    } else {
      camera.position.set(26, 16, 24);
    }

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !softwareGl;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.minDistance = 7;
    controls.maxDistance = 85;
    controls.target.set(0, 0.6, 0);

    controls.addEventListener('start', () => {
      cameraTargetRef.current.active = false;
    });

    const hemiLight = new THREE.HemisphereLight(
      isDarkRef.current ? 0x93c5fd : 0xffffff,
      isDarkRef.current ? 0x1b3a24 : 0x7cb342,
      isDarkRef.current ? 0.78 : 0.9
    );
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfffbeb, isDarkRef.current ? 1.35 : 1.55);
    dirLight.position.set(28, 42, 22);
    if (!softwareGl) {
      dirLight.castShadow = true;
      dirLight.shadow.mapSize.set(1024, 1024);
      dirLight.shadow.camera.near = 4;
      dirLight.shadow.camera.far = 120;
      const d = 42;
      dirLight.shadow.camera.left = -d;
      dirLight.shadow.camera.right = d;
      dirLight.shadow.camera.top = d;
      dirLight.shadow.camera.bottom = -d;
      dirLight.shadow.bias = -0.0004;
      dirLight.shadow.normalBias = 0.02;
    }
    scene.add(dirLight);

    // Wide Flat Floodplain Terrain with gently carved Ciliwung river channel
    const terrainSizeX = 120;
    const terrainSizeZ = 120;
    const segX = 104;
    const segZ = 104;
    const terrainGeo = new THREE.PlaneGeometry(terrainSizeX, terrainSizeZ, segX, segZ);
    terrainGeo.rotateX(-Math.PI / 2);

    const posAttr = terrainGeo.attributes.position as THREE.BufferAttribute;
    const colors: number[] = [];

    const meadowCol = new THREE.Color(isDarkRef.current ? 0x26482b : 0xb3e376);
    const bankCol = new THREE.Color(isDarkRef.current ? 0x1c3622 : 0x92c855);
    const bedCol = new THREE.Color(isDarkRef.current ? 0x0d1f2e : 0x5c8999);
    const tmpCol = new THREE.Color();

    const nearestRiverInfo = (x: number, z: number) => {
      let bestDistSq = Infinity;
      let bestPt = sampledRiver[0];
      for (let i = 0; i < sampledRiver.length; i += 1) {
        const p = sampledRiver[i];
        const dx = p.x - x;
        const dz = p.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestPt = p;
        }
      }
      return { pt: bestPt, dist: Math.sqrt(bestDistSq) };
    };

    const channelWidth = 1.65;
    for (let i = 0; i < posAttr.count; i += 1) {
      const vx = posAttr.getX(i);
      const vz = posAttr.getZ(i);
      const { dist } = nearestRiverInfo(vx, vz);

      let y = 0.0;
      if (dist <= channelWidth) {
        const t = dist / channelWidth;
        y = -0.36 * (1 - t * t);
        tmpCol.copy(bedCol).lerp(bankCol, t * 0.85);
      } else if (dist <= channelWidth + 1.4) {
        const t = (dist - channelWidth) / 1.4;
        y = 0.0;
        tmpCol.copy(bankCol).lerp(meadowCol, t);
      } else {
        y = 0.0;
        tmpCol.copy(meadowCol);
      }

      posAttr.setY(i, y);
      colors.push(tmpCol.r, tmpCol.g, tmpCol.b);
    }
    terrainGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();

    const terrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
      flatShading: false,
    });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    terrainMesh.receiveShadow = !softwareGl;
    scene.add(terrainMesh);

    // Dynamic water ribbon along sampledRiver
    const ribbonCount = sampledRiver.length;
    const waterGeo = new THREE.BufferGeometry();
    const waterVerts = new Float32Array(ribbonCount * 2 * 3);
    const waterCols = new Float32Array(ribbonCount * 2 * 3);
    const waterUvs = new Float32Array(ribbonCount * 2 * 2);
    const waterIndices: number[] = [];

    for (let i = 0; i < ribbonCount - 1; i += 1) {
      const a = i * 2;
      const b = a + 1;
      const c = (i + 1) * 2;
      const d = c + 1;
      waterIndices.push(a, c, b, b, c, d);
    }
    waterGeo.setAttribute('position', new THREE.BufferAttribute(waterVerts, 3));
    waterGeo.setAttribute('color', new THREE.BufferAttribute(waterCols, 3));
    waterGeo.setAttribute('uv', new THREE.BufferAttribute(waterUvs, 2));
    waterGeo.setIndex(waterIndices);

    const waterMat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.16,
      metalness: 0.06,
      transparent: true,
      opacity: 0.88,
      clearcoat: 0.7,
      clearcoatRoughness: 0.14,
      side: THREE.DoubleSide,
    });
    const waterMesh = new THREE.Mesh(waterGeo, waterMat);
    scene.add(waterMesh);

    // Station locations mapped onto the flat river channel
    interface StationRig {
      meta: StationMeta;
      group: THREE.Group;
      beaconMat: THREE.MeshStandardMaterial;
      sprite: THREE.Sprite;
      badgeCanvas: HTMLCanvasElement;
      badgeTex: THREE.CanvasTexture;
      riverSampleIndex: number;
      hitMesh: THREE.Mesh;
    }

    const stationRigs: StationRig[] = [];
    const clickTargets: THREE.Object3D[] = [];
    const nextPositions: Record<string, THREE.Vector3> = {};
    const stationXZ: Array<{ x: number; z: number }> = [];

    const concreteMat = new THREE.MeshStandardMaterial({
      color: isDarkRef.current ? 0x475569 : 0x64748b,
      roughness: 0.85,
      metalness: 0.1,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: isDarkRef.current ? 0xcbd5e1 : 0x475569,
      roughness: 0.35,
      metalness: 0.72,
    });
    const solarMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      roughness: 0.22,
      metalness: 0.65,
    });

    visibleStations.forEach((meta) => {
      const { x, z } = latLngToScene(meta.lng, meta.lat, bounds);
      let nearestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < sampledRiver.length; i += 1) {
        const d = (sampledRiver[i].x - x) ** 2 + (sampledRiver[i].z - z) ** 2;
        if (d < bestDist) {
          bestDist = d;
          nearestIdx = i;
        }
      }
      const riverPt = sampledRiver[nearestIdx];
      nextPositions[meta.id] = new THREE.Vector3(riverPt.x, 0.9, riverPt.z);
      stationXZ.push({ x: riverPt.x, z: riverPt.z });

      const group = new THREE.Group();
      group.position.set(riverPt.x, 0.0, riverPt.z);
      group.userData = { nodeId: meta.id };

      // 1. Concrete foundation pier seated flush on left bank (y = 0)
      const baseMesh = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.55, 1.3), concreteMat);
      baseMesh.position.set(-1.55, 0.275, 0);
      baseMesh.castShadow = !softwareGl;
      group.add(baseMesh);

      // 2. Vertical RTU Mast Column
      const poleMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 2.35, 10), steelMat);
      poleMesh.position.set(-1.55, 1.5, 0);
      poleMesh.castShadow = !softwareGl;
      group.add(poleMesh);

      // 3. Cantilever boom arm spanning over the river channel
      const boomMesh = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.13, 0.15), steelMat);
      boomMesh.position.set(-0.68, 2.25, 0);
      boomMesh.castShadow = !softwareGl;
      group.add(boomMesh);

      // 4. JSN-SR04T ultrasonic sensor housing at boom tip
      const probeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.26, 12), concreteMat);
      probeMesh.position.set(0.12, 2.08, 0);
      group.add(probeMesh);

      // 5. Solar panel tilted atop mast
      const panelMesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.52), solarMat);
      panelMesh.position.set(-1.55, 2.72, 0);
      panelMesh.rotation.x = 0.35;
      group.add(panelMesh);

      // 6. Status beacon dome
      const beaconMat = new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        emissive: 0x22c55e,
        emissiveIntensity: 0.75,
        roughness: 0.2,
        metalness: 0.3,
      });
      const beaconMesh = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), beaconMat);
      beaconMesh.position.set(0.12, 2.48, 0);
      group.add(beaconMesh);

      // Click hit box
      const hitMesh = new THREE.Mesh(
        new THREE.BoxGeometry(3.0, 3.6, 3.0),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      hitMesh.position.set(-0.65, 1.7, 0);
      hitMesh.userData = { nodeId: meta.id };
      group.add(hitMesh);
      clickTargets.push(hitMesh);

      const badgeCanvas = document.createElement('canvas');
      badgeCanvas.width = 430;
      badgeCanvas.height = 96;
      const badgeTex = new THREE.CanvasTexture(badgeCanvas);
      badgeTex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: badgeTex, transparent: true, depthTest: false })
      );
      sprite.position.set(-0.45, 3.65, 0);
      sprite.scale.set(4.6, 1.03, 1);
      sprite.userData = { nodeId: meta.id };
      group.add(sprite);
      clickTargets.push(sprite);

      scene.add(group);
      stationRigs.push({
        meta,
        group,
        beaconMat,
        sprite,
        badgeCanvas,
        badgeTex,
        riverSampleIndex: nearestIdx,
        hitMesh,
      });
    });

    stationPositionsRef.current = nextPositions;

    // Scatter flat-floodplain Pine Trees and Urban City Buildings via InstancedMesh
    const rand = mulberry32(mode === 'hardware' ? 12041 : 99123);
    const treePlacements: Array<{ x: number; z: number; scale: number; rot: number; tint: THREE.Color }> = [];
    const buildingPlacements: Array<{
      x: number;
      z: number;
      w: number;
      h: number;
      d: number;
      rot: number;
      tint: THREE.Color;
    }> = [];

    const tooCloseToRiverOrStation = (x: number, z: number, minRiverDist: number) => {
      const { dist } = nearestRiverInfo(x, z);
      if (dist < minRiverDist) return true;
      for (let i = 0; i < stationXZ.length; i += 1) {
        const dx = stationXZ[i].x - x;
        const dz = stationXZ[i].z - z;
        if (dx * dx + dz * dz < 11.5) return true;
      }
      return false;
    };

    // Place urban buildings along both riverbanks (N1 Depok -> N5 Manggarai character, matching screenshot 1)
    let attempts = 0;
    while (buildingPlacements.length < 150 && attempts < 1800) {
      attempts += 1;
      const idx = Math.floor(rand() * sampledRiver.length);
      const rp = sampledRiver[idx];
      // In simulation mode, cluster denser buildings in middle-to-downstream (z <= 12);
      // in hardware mode, urban blocks run all along Depok -> Manggarai banks
      if (mode === 'simulation' && rp.z > 14 && rand() < 0.72) continue;

      const side = rand() < 0.5 ? -1 : 1;
      const bankOffset = 3.2 + rand() * 14.5;
      const jitterZ = (rand() - 0.5) * 4.5;
      const bx = rp.x + side * bankOffset + (rand() - 0.5) * 2.5;
      const bz = rp.z + jitterZ;
      if (Math.abs(bx) > 46 || Math.abs(bz) > 46) continue;
      if (tooCloseToRiverOrStation(bx, bz, 3.1)) continue;

      let overlaps = false;
      for (let j = 0; j < buildingPlacements.length; j += 1) {
        const b = buildingPlacements[j];
        if ((b.x - bx) ** 2 + (b.z - bz) ** 2 < 5.6) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const palette = isDarkRef.current
        ? [0x3b4859, 0x475569, 0x334155, 0x52525b]
        : [0xe2e8f0, 0xdbe3ec, 0xe7e5e4, 0xd6dce5];
      buildingPlacements.push({
        x: bx,
        z: bz,
        w: 1.15 + rand() * 1.15,
        h: 1.2 + rand() * 2.9,
        d: 1.15 + rand() * 1.15,
        rot: (rand() - 0.5) * 0.25,
        tint: new THREE.Color(palette[Math.floor(rand() * palette.length)]),
      });
    }

    // Place layered conical pine trees across green parkland & riverside banks
    attempts = 0;
    while (treePlacements.length < 185 && attempts < 2200) {
      attempts += 1;
      const tx = (rand() - 0.5) * 86;
      const tz = (rand() - 0.5) * 86;
      if (tooCloseToRiverOrStation(tx, tz, 2.95)) continue;

      let hitsBuilding = false;
      for (let j = 0; j < buildingPlacements.length; j += 1) {
        const b = buildingPlacements[j];
        if ((b.x - tx) ** 2 + (b.z - tz) ** 2 < 4.5) {
          hitsBuilding = true;
          break;
        }
      }
      if (hitsBuilding) continue;

      const foliagePalette = isDarkRef.current
        ? [0x2e7d32, 0x256d2c, 0x388e3c]
        : [0x2e8b43, 0x3ba34d, 0x43b556, 0x2f7d3d];
      treePlacements.push({
        x: tx,
        z: tz,
        scale: 0.85 + rand() * 0.5,
        rot: rand() * Math.PI * 2,
        tint: new THREE.Color(foliagePalette[Math.floor(rand() * foliagePalette.length)]),
      });
    }

    const dummy = new THREE.Object3D();

    // Instanced Urban Buildings (body + rooftop cap)
    const bldgGeo = new THREE.BoxGeometry(1, 1, 1);
    const bldgMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.08,
    });
    const bldgInst = new THREE.InstancedMesh(bldgGeo, bldgMat, Math.max(1, buildingPlacements.length));
    bldgInst.castShadow = !softwareGl;
    bldgInst.receiveShadow = !softwareGl;
    bldgInst.frustumCulled = false;

    const roofGeo = new THREE.BoxGeometry(0.78, 0.14, 0.78);
    const roofMat = new THREE.MeshStandardMaterial({
      color: isDarkRef.current ? 0x1e293b : 0x94a3b8,
      roughness: 0.6,
      metalness: 0.25,
    });
    const roofInst = new THREE.InstancedMesh(roofGeo, roofMat, Math.max(1, buildingPlacements.length));
    roofInst.frustumCulled = false;

    buildingPlacements.forEach((b, idx) => {
      dummy.position.set(b.x, b.h * 0.5, b.z);
      dummy.rotation.set(0, b.rot, 0);
      dummy.scale.set(b.w, b.h, b.d);
      dummy.updateMatrix();
      bldgInst.setMatrixAt(idx, dummy.matrix);
      bldgInst.setColorAt(idx, b.tint);

      dummy.position.set(b.x, b.h + 0.07, b.z);
      dummy.scale.set(b.w, 1, b.d);
      dummy.updateMatrix();
      roofInst.setMatrixAt(idx, dummy.matrix);
    });
    bldgInst.count = buildingPlacements.length;
    roofInst.count = buildingPlacements.length;
    bldgInst.instanceMatrix.needsUpdate = true;
    if (bldgInst.instanceColor) bldgInst.instanceColor.needsUpdate = true;
    roofInst.instanceMatrix.needsUpdate = true;
    bldgInst.computeBoundingSphere();
    roofInst.computeBoundingSphere();
    scene.add(bldgInst);
    scene.add(roofInst);

    // Instanced Multi-Part Pine Trees (trunk + lower canopy + upper crown)
    const trunkGeo = new THREE.CylinderGeometry(0.09, 0.14, 0.65, 7);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: isDarkRef.current ? 0x5c3a21 : 0x795548,
      roughness: 0.9,
      metalness: 0.04,
    });
    const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.max(1, treePlacements.length));
    trunkInst.frustumCulled = false;

    const coneLowGeo = new THREE.ConeGeometry(0.68, 1.45, 8);
    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.02,
    });
    const coneLowInst = new THREE.InstancedMesh(coneLowGeo, foliageMat, Math.max(1, treePlacements.length));
    coneLowInst.castShadow = !softwareGl;
    coneLowInst.frustumCulled = false;

    const coneTopGeo = new THREE.ConeGeometry(0.48, 1.15, 8);
    const coneTopInst = new THREE.InstancedMesh(coneTopGeo, foliageMat, Math.max(1, treePlacements.length));
    coneTopInst.castShadow = !softwareGl;
    coneTopInst.frustumCulled = false;

    treePlacements.forEach((t, idx) => {
      dummy.position.set(t.x, 0.325 * t.scale, t.z);
      dummy.rotation.set(0, t.rot, 0);
      dummy.scale.setScalar(t.scale);
      dummy.updateMatrix();
      trunkInst.setMatrixAt(idx, dummy.matrix);

      dummy.position.set(t.x, 1.25 * t.scale, t.z);
      dummy.updateMatrix();
      coneLowInst.setMatrixAt(idx, dummy.matrix);
      coneLowInst.setColorAt(idx, t.tint);

      dummy.position.set(t.x, 1.92 * t.scale, t.z);
      dummy.updateMatrix();
      coneTopInst.setMatrixAt(idx, dummy.matrix);
      coneTopInst.setColorAt(idx, t.tint);
    });
    trunkInst.count = treePlacements.length;
    coneLowInst.count = treePlacements.length;
    coneTopInst.count = treePlacements.length;
    trunkInst.instanceMatrix.needsUpdate = true;
    coneLowInst.instanceMatrix.needsUpdate = true;
    coneTopInst.instanceMatrix.needsUpdate = true;
    if (coneLowInst.instanceColor) coneLowInst.instanceColor.needsUpdate = true;
    if (coneTopInst.instanceColor) coneTopInst.instanceColor.needsUpdate = true;
    trunkInst.computeBoundingSphere();
    coneLowInst.computeBoundingSphere();
    coneTopInst.computeBoundingSphere();
    scene.add(trunkInst);
    scene.add(coneLowInst);
    scene.add(coneTopInst);

    // Raycasting for clicking a station in 3D
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownPos = { x: 0, y: 0 };

    const handlePointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };
    const handlePointerUp = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (moved > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(clickTargets, false);
      if (hits.length > 0) {
        const id = hits[0].object.userData?.nodeId;
        if (typeof id === 'string') {
          setInternalSelectedId(id);
          onSelectNode?.(id);
        }
      }
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);

    let resizeRafId = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeRafId) window.cancelAnimationFrame(resizeRafId);
      resizeRafId = window.requestAnimationFrame(() => {
        resizeRafId = 0;
        if (disposed || !container) return;
        const w = container.clientWidth || 640;
        const h = container.clientHeight || 420;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      });
    });
    resizeObserver.observe(container);

    let rafId = 0;
    let disposed = false;
    const lastBadgeKeys = new Map<string, string>();
    const clock = new THREE.Clock();

    const sampleElevBoost = new Float32Array(ribbonCount);
    const sampleStatuses: ThreeDStationStatus[] = new Array(ribbonCount).fill('AMAN');
    const sampleHasVal: boolean[] = new Array(ribbonCount).fill(false);

    const updateWaterAndStations = (elapsed: number) => {
      const nodeMap = new Map<string, ThreeDStationNode>(
        nodesRef.current.map((n): [string, ThreeDStationNode] => [n.id, n])
      );
      const activeLive = isLiveRef.current;

      stationRigs.forEach((rig) => {
        const nodeData = nodeMap.get(rig.meta.id);
        const hasVal = Boolean(nodeData && nodeData.valueType !== 'reset' && Number.isFinite(nodeData.tmaCm));
        const status: ThreeDStationStatus = hasVal && nodeData ? nodeData.status : 'AMAN';
        const hex = statusHexColor(status, activeLive && hasVal);
        rig.beaconMat.color.setHex(hex);
        rig.beaconMat.emissive.setHex(hex);
        rig.beaconMat.emissiveIntensity = rig.meta.id === selectedIdRef.current ? 1.25 : 0.75;

        rig.sprite.visible = showLabelsRef.current;
        const tmaText =
          hasVal && nodeData
            ? `${nodeData.tmaCm.toFixed(1)} cm · ${status === 'BANJIR_JAKARTA' ? 'BANJIR' : status}`
            : en
              ? 'Awaiting data'
              : 'Menunggu data';
        const badgeKey = `${tmaText}|${status}|${isDarkRef.current}|${rig.meta.id === selectedIdRef.current}|${activeLive}`;
        if (lastBadgeKeys.get(rig.meta.id) !== badgeKey) {
          lastBadgeKeys.set(rig.meta.id, badgeKey);
          drawBadgeTexture(
            rig.badgeCanvas,
            rig.meta.id,
            rig.meta.name,
            tmaText,
            statusCssColor(status, activeLive && hasVal),
            isDarkRef.current,
            rig.meta.id === selectedIdRef.current
          );
          rig.badgeTex.needsUpdate = true;
        }
      });

      for (let i = 0; i < ribbonCount; i += 1) {
        let closestRig = stationRigs[0];
        let minDelta = Infinity;
        for (let r = 0; r < stationRigs.length; r += 1) {
          const rig = stationRigs[r];
          const delta = Math.abs(rig.riverSampleIndex - i);
          if (delta < minDelta) {
            minDelta = delta;
            closestRig = rig;
          }
        }
        const nodeData = closestRig ? nodeMap.get(closestRig.meta.id) : undefined;
        const hasVal = Boolean(nodeData && nodeData.valueType !== 'reset' && Number.isFinite(nodeData.tmaCm));
        const tmaCm = hasVal && nodeData ? nodeData.tmaCm : 35;
        const stageM = nodeData?.stageRiseM ?? Math.max(0, (tmaCm - 60) / 100);
        const boost = Math.min(1.25, Math.max(0.06, (tmaCm / 260) * 0.8 + stageM * 0.16));
        sampleElevBoost[i] = boost;
        sampleHasVal[i] = hasVal;
        sampleStatuses[i] = hasVal && nodeData ? nodeData.status : 'AMAN';
      }

      const vAttr = waterGeo.attributes.position as THREE.BufferAttribute;
      const cAttr = waterGeo.attributes.color as THREE.BufferAttribute;
      const uAttr = waterGeo.attributes.uv as THREE.BufferAttribute;

      for (let i = 0; i < ribbonCount; i += 1) {
        const p = sampledRiver[i];
        const next = sampledRiver[Math.min(ribbonCount - 1, i + 1)];
        const prev = sampledRiver[Math.max(0, i - 1)];
        const tx = next.x - prev.x;
        const tz = next.z - prev.z;
        const len = Math.hypot(tx, tz) || 1;
        const nx = -tz / len;
        const nz = tx / len;

        const ripple = Math.sin(i * 0.45 - elapsed * 2.8) * 0.02;
        const halfWidth = 0.92 + sampleElevBoost[i] * 0.85;
        const wy = -0.14 + sampleElevBoost[i] * 0.36 + ripple;

        const idxL = i * 2;
        const idxR = idxL + 1;
        vAttr.setXYZ(idxL, p.x + nx * halfWidth, wy, p.z + nz * halfWidth);
        vAttr.setXYZ(idxR, p.x - nx * halfWidth, wy, p.z - nz * halfWidth);

        if (!activeLive || !sampleHasVal[i]) {
          _colorTmp.copy(_colorNormalWater);
        } else if (sampleStatuses[i] === 'BANJIR_JAKARTA') {
          _colorTmp.copy(_colorFloodWater);
        } else if (sampleStatuses[i] === 'SIAGA') {
          _colorTmp.copy(_colorSiagaWater);
        } else {
          _colorTmp.copy(_colorNormalWater);
        }

        cAttr.setXYZ(idxL, _colorTmp.r, _colorTmp.g, _colorTmp.b);
        cAttr.setXYZ(idxR, _colorTmp.r, _colorTmp.g, _colorTmp.b);

        uAttr.setXY(idxL, 0, i / (ribbonCount - 1));
        uAttr.setXY(idxR, 1, i / (ribbonCount - 1));
      }
      vAttr.needsUpdate = true;
      cAttr.needsUpdate = true;
      uAttr.needsUpdate = true;
      waterGeo.computeVertexNormals();
    };

    if (!softwareGl) {
      renderer.compile(scene, camera);
    }

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      if (typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          if (disposed) {
            if (sync) gl.deleteSync(sync);
            return;
          }
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            rafId = window.setTimeout(poll, 5) as unknown as number;
          } else {
            if (sync) gl.deleteSync(sync);
            rafId = window.setTimeout(cb, 80) as unknown as number;
          }
        };
        rafId = window.setTimeout(poll, 5) as unknown as number;
      } else {
        rafId = window.setTimeout(cb, 80) as unknown as number;
      }
    }

    const tick = () => {
      if (disposed) return;
      const dt = Math.min(0.05, clock.getDelta());
      const elapsed = clock.elapsedTime;

      if (cameraTargetRef.current.active) {
        camera.position.x = THREE.MathUtils.damp(camera.position.x, cameraTargetRef.current.pos.x, 5.5, dt);
        camera.position.y = THREE.MathUtils.damp(camera.position.y, cameraTargetRef.current.pos.y, 5.5, dt);
        camera.position.z = THREE.MathUtils.damp(camera.position.z, cameraTargetRef.current.pos.z, 5.5, dt);
        controls.target.x = THREE.MathUtils.damp(controls.target.x, cameraTargetRef.current.lookAt.x, 5.5, dt);
        controls.target.y = THREE.MathUtils.damp(controls.target.y, cameraTargetRef.current.lookAt.y, 5.5, dt);
        controls.target.z = THREE.MathUtils.damp(controls.target.z, cameraTargetRef.current.lookAt.z, 5.5, dt);
        if (camera.position.distanceTo(cameraTargetRef.current.pos) < 0.08) {
          cameraTargetRef.current.active = false;
        }
      }

      controls.update();
      updateWaterAndStations(elapsed);
      renderer.render(scene, camera);

      if (softwareGl) {
        afterDraw(tick);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      window.clearTimeout(rafId);
      cancelAnimationFrame(rafId);
      if (resizeRafId) window.cancelAnimationFrame(resizeRafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      controls.dispose();
      stationRigs.forEach((rig) => {
        rig.badgeTex.dispose();
      });
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          mesh.geometry?.dispose();
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat?.dispose();
        }
      });
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (container) container.innerHTML = '';
    };
  }, [mode, centerline, theme, en, visibleStations]);

  const selectedNodeData = nodes.find((n) => n.id === effectiveSelectedId);
  const selectedForecast = effectiveSelectedId ? forecasts[effectiveSelectedId] : undefined;

  if (renderFailed) {
    return (
      <div
        className={`flex ${heightClassName} items-center justify-center rounded-2xl border p-6 text-center text-xs ${
          isDark ? 'border-white/10 bg-[#0A0D14] text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600'
        }`}
      >
        {en
          ? '3D WebGL renderer is unavailable in this browser context. Please use the 2D Map or Forecast Graph view.'
          : 'Renderer 3D WebGL tidak tersedia di browser ini. Silakan gunakan tampilan Peta 2D atau Grafik Prediksi.'}
      </div>
    );
  }

  return (
    <div
      className={`relative w-full overflow-hidden rounded-2xl border ${
        isDark ? 'border-white/10 bg-[#0E1726]' : 'border-slate-200 bg-[#DFF0FC]'
      } ${heightClassName}`}
    >
      {/* Isolated WebGL mount */}
      <div ref={mountRef} className="h-full w-full cursor-grab active:cursor-grabbing" />

      {/* Top-Left Compact Mode & Selected Node Card (no backdrop-blur over WebGL) */}
      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[300px] flex-col gap-2">
        <div
          className={`pointer-events-auto rounded-xl border px-3 py-2 shadow-lg ${
            isDark ? 'border-white/10 bg-[#0D0D11]/95 text-slate-200' : 'border-slate-200 bg-white/95 text-slate-800'
          }`}
        >
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.18em] text-[#3B82F6]">
            <Waves className="h-3.5 w-3.5" />
            <span>{mode === 'hardware' ? 'Ciliwung 3D · N1 Depok → N5 Manggarai' : 'Ciliwung 3D · 9-Node Basin (UP1 → N5)'}</span>
          </div>
          {selectedNodeData ? (
            <div className="mt-1.5 flex items-baseline justify-between gap-3">
              <div>
                <p className="text-xs font-bold">
                  {selectedNodeData.id} · {selectedNodeData.name}
                </p>
                <p className="text-[10px] opacity-75">
                  {selectedNodeData.valueType === 'actual_sensor'
                    ? en
                      ? 'Actual ESP32'
                      : 'Sensor ESP32 Real'
                    : selectedNodeData.valueType === 'simulation'
                      ? en
                        ? 'Simulation'
                        : 'Simulasi'
                      : selectedNodeData.valueType === 'derived_preset'
                        ? en
                          ? 'Downstream Preset'
                          : 'Preset Hilir'
                        : en
                          ? 'Standby'
                          : 'Standby'}
                </p>
              </div>
              <div className="text-right">
                <span className="text-sm font-bold font-mono">{selectedNodeData.tmaCm.toFixed(1)} cm</span>
                <span
                  className="block text-[9px] font-mono font-bold"
                  style={{ color: statusCssColor(selectedNodeData.status, isLive) }}
                >
                  {selectedNodeData.status === 'BANJIR_JAKARTA' ? 'BANJIR' : selectedNodeData.status}
                </span>
              </div>
            </div>
          ) : (
            <p className="mt-1 text-[11px] opacity-75">
              {en ? 'Click any monitoring pylon in 3D to inspect telemetry.' : 'Klik tiang pos pantau di peta 3D untuk melihat detail TMA.'}
            </p>
          )}
          {selectedForecast?.status === 'available' && selectedForecast.predictedTmaCm && (
            <div className="mt-1.5 flex items-center justify-between border-t border-slate-500/20 pt-1.5 text-[10px] font-mono text-violet-400">
              <span>LSTM/Hydro +30m: {selectedForecast.predictedTmaCm['30']?.toFixed(1)} cm</span>
              <span>+60m: {selectedForecast.predictedTmaCm['60']?.toFixed(1)} cm</span>
            </div>
          )}
        </div>
      </div>

      {/* Top-Right Legend */}
      <div
        className={`pointer-events-none absolute right-3 top-3 hidden sm:flex items-center gap-2.5 rounded-xl border px-3 py-1.5 text-[10px] font-mono shadow-md ${
          isDark ? 'border-white/10 bg-[#0D0D11]/95 text-slate-300' : 'border-slate-200 bg-white/95 text-slate-700'
        }`}
      >
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-[#22C55E]" />
          AMAN
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-[#F97316]" />
          SIAGA
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-[#2563EB]" />
          BANJIR
        </span>
      </div>

      {/* Collapsible Bottom Control Dock */}
      <div className="absolute bottom-3 left-3 right-3 flex flex-col items-center gap-2 pointer-events-none">
        {dockOpen ? (
          <div
            className={`pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-[11px] font-mono shadow-xl ${
              isDark ? 'border-white/10 bg-[#0D0D11]/95 text-slate-200' : 'border-slate-200 bg-white/95 text-slate-700'
            }`}
          >
            <button
              type="button"
              onClick={() => applyPreset('corridor')}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                activePreset === 'corridor' ? 'bg-[#3B82F6] text-black font-bold' : 'hover:bg-slate-500/15'
              }`}
            >
              <Maximize2 className="h-3 w-3" />
              <span>{en ? 'Full View' : 'Koridor'}</span>
            </button>
            {mode === 'simulation' && (
              <button
                type="button"
                onClick={() => applyPreset('upstream')}
                className={`flex items-center gap-1 rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                  activePreset === 'upstream' ? 'bg-[#3B82F6] text-black font-bold' : 'hover:bg-slate-500/15'
                }`}
              >
                <Compass className="h-3 w-3" />
                <span>{en ? 'Upstream' : 'Hulu UP1'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => applyPreset('depok')}
              className={`rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                activePreset === 'depok' ? 'bg-[#3B82F6] text-black font-bold' : 'hover:bg-slate-500/15'
              }`}
            >
              N1 · Depok
            </button>
            <button
              type="button"
              onClick={() => applyPreset('manggarai')}
              className={`rounded-lg px-2.5 py-1 transition-colors cursor-pointer ${
                activePreset === 'manggarai' ? 'bg-[#3B82F6] text-black font-bold' : 'hover:bg-slate-500/15'
              }`}
            >
              N5 · Manggarai
            </button>
            <span className="mx-0.5 h-4 w-px bg-slate-500/30" />
            <button
              type="button"
              onClick={() => setShowLabels((v) => !v)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-slate-500/15 cursor-pointer"
              title={en ? 'Toggle station labels' : 'Tampilkan / sembunyikan label'}
            >
              {showLabels ? <Eye className="h-3.5 w-3.5 text-sky-400" /> : <EyeOff className="h-3.5 w-3.5 text-slate-400" />}
              <span className="hidden sm:inline">{en ? 'Labels' : 'Label'}</span>
            </button>
            <button
              type="button"
              onClick={() => applyPreset('corridor')}
              className="flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-slate-500/15 cursor-pointer"
              title={en ? 'Reset camera view' : 'Reset kamera'}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setDockOpen(false)}
              className="rounded-lg px-2 py-1 text-[10px] opacity-70 hover:opacity-100 cursor-pointer"
              title={en ? 'Collapse controls' : 'Sembunyikan kontrol'}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDockOpen(true)}
            className={`pointer-events-auto flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[11px] font-mono shadow-lg cursor-pointer ${
              isDark ? 'border-white/10 bg-[#0D0D11]/95 text-slate-200' : 'border-slate-200 bg-white/95 text-slate-700'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-[#3B82F6]" />
            <span>{en ? '3D Controls' : 'Kontrol 3D'}</span>
          </button>
        )}
      </div>
    </div>
  );
}
