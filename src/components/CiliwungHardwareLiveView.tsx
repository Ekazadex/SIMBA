import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Curve } from 'recharts';
import { buildHardwareSnapshot, getDownstreamPresetLimits } from '../../backend/ciliwung/hardware-live.mjs';
import { validLimits, graphAxisMax, graphTimeTicks, graphCsv, sensorDistance, interpolateGraphPoints } from '../hardware-graph.mjs';
import { projectDownstreamLevel } from '../demo-estimates.mjs';

setWorkerUrl(workerUrl);

type HardwareView = 'map2d' | 'graph' | 'map3d';
type HardwareStatus = 'AMAN' | 'SIAGA' | 'BANJIR_JAKARTA';
type HardwareNode = {
  id: string;
  name: string;
  tmaCm: number;
  stageRiseM: number;
  status: HardwareStatus;
  valueType: 'actual_sensor' | 'derived_preset' | 'reset' | 'simulation';
  source: string;
};
type HardwareSnapshot = {
  mode: 'hardware';
  runId: string | null;
  status: 'idle' | 'running';
  timestampUtc?: string;
  hardware?: {
    nodeId: 'N1';
    tmaCm?: number;
    measuredAt?: string;
    freshness: 'live' | 'stale';
    valueType?: 'actual_sensor' | 'simulation' | 'reset';
    condition: 'ringan' | 'sedang' | 'lebat' | null;
    profileLabel?: string | null;
    alertStatus?: string;
  };
  mapOverlay?: {
    condition: string | null;
    areaColor: string;
    areaOpacity: number;
    flooded: boolean;
    label: string;
  };
  threeDNodes: HardwareNode[];
  cupNodes: HardwareNode[];
};
type LatestReading = {
  water_level?: number | null;
  distance?: number | null;
  timestamp?: number | string | null;
  source?: string | null;
  readings?: unknown[];
};
type HistoryPoint = { time: number; level: number; distance?: number; distanceMethod?: 'reported' | 'estimated' };
type ThresholdConfig = {
  threshold_siaga?: number;
  threshold_bahaya?: number;
  reference_height?: number;
};
type DayHistoryResult = { readings: LatestReading[]; failed: boolean; truncated: boolean };

const REAL_MAP_NODES: Array<{ id: string; label: string; lat: number; lng: number }> = [
  { id: 'N1', label: 'N1 · Depok', lat: -6.4005985, lng: 106.8316850 },
  { id: 'N2', label: 'N2 · Stage 1', lat: -6.3499224, lng: 106.8385996 },
  { id: 'N3', label: 'N3 · Stage 2', lat: -6.3000107, lng: 106.8524555 },
  { id: 'N4', label: 'N4 · Stage 3', lat: -6.2500000, lng: 106.8631031 },
  { id: 'N5', label: 'N5 · Manggarai', lat: -6.2078464, lng: 106.8483991 },
  { id: 'SEA', label: 'Laut Jawa', lat: -6.1178014, lng: 106.8285612 },
];
const GRAPH_NODES = [
  { id: 'N1', name: 'Pos Depok' }, { id: 'N2', name: 'Ciliwung Stage 1' },
  { id: 'N3', name: 'Ciliwung Stage 2' }, { id: 'N4', name: 'Ciliwung Stage 3' },
  { id: 'N5', name: 'Pintu Air Manggarai' },
];

function readingTime(timestamp?: number | string | null) {
  if (timestamp == null) return NaN;
  const time = typeof timestamp === 'number' ? (timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp) : Date.parse(timestamp);
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? time : NaN;
}

function statusColor(status: HardwareStatus) {
  if (status === 'BANJIR_JAKARTA') return '#2563EB';
  if (status === 'SIAGA') return '#F97316';
  return '#22C55E';
}

function conditionLabel(condition: string | null | undefined) {
  if (condition === 'lebat') return 'Hujan Lebat';
  if (condition === 'sedang') return 'Hujan Sedang';
  if (condition === 'ringan') return 'Hujan Ringan';
  return 'Belum ada preset';
}

function localFallbackCondition(level: number, config: ThresholdConfig) {
  const siaga = Number(config.threshold_siaga ?? 60);
  const bahaya = Number(config.threshold_bahaya ?? 90);
  if (level >= bahaya) return 'lebat';
  if (level >= siaga) return 'sedang';
  return 'ringan';
}

function formatReadingTime(timestamp?: number | string | null) {
  if (timestamp == null) return '—';
  const numeric = readingTime(timestamp);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(numeric));
}

function formatReadingDateTime(timestamp: number) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestamp));
}

const graphDateTickFormatter = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit' });
const graphClockTickFormatter = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });

function areaStyle(node: HardwareNode | undefined, condition: string | null) {
  if (node?.status === 'BANJIR_JAKARTA') return { color: '#2563EB', radius: 950, opacity: 0.30 };
  if (node?.status === 'SIAGA') return { color: '#F97316', radius: 650, opacity: 0.26 };
  if (condition === 'lebat') return { color: '#2563EB', radius: 700, opacity: 0.20 };
  if (condition === 'sedang') return { color: '#F97316', radius: 450, opacity: 0.18 };
  return { color: '#FACC15', radius: 260, opacity: 0.14 };
}

export function Map2D({ snapshot, fallbackLevel, config, simulation = false, extraNodes = [], compact = false, fillHeight = false }: { snapshot: HardwareSnapshot | null; fallbackLevel: number | null; config: ThresholdConfig; simulation?: boolean; extraNodes?: Array<{ id: string; label: string; lat: number; lng: number }>; compact?: boolean; fillHeight?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const overlayLayerRef = useRef<L.LayerGroup | null>(null);
  const nodeLayerRef = useRef<L.LayerGroup | null>(null);
  const hasFittedRef = useRef(false);
  const [mapReady, setMapReady] = useState(false);
  const [tileState, setTileState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [showHeat, setShowHeat] = useState(true);
  const [river, setRiver] = useState<Array<[number, number]>>([]);
  const [riverError, setRiverError] = useState(false);
  useEffect(() => {
    let active = true;
    fetch('/assets/map/ciliwung_centerline.json').then((r) => { if (!r.ok) throw new Error('river'); return r.json(); }).then((data) => { if (active) setRiver(data.coordinates); }).catch(() => { if (active) setRiverError(true); });
    return () => { active = false; };
  }, []);
  const level = snapshot?.hardware?.tmaCm ?? fallbackLevel;
  const condition = snapshot?.mapOverlay?.condition ?? (level == null ? null : localFallbackCondition(level, config));
  const isLive = snapshot?.hardware?.freshness === 'live' && snapshot.status === 'running';

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = L.map(containerRef.current, { zoomControl: false, preferCanvas: true, attributionControl: false });
    try {
    L.control.zoom({ position: 'topright' }).addTo(map);
    mapRef.current = map;
    // Vector styles allow icons to be removed without hiding road or place names.
    fetch('https://tiles.openfreemap.org/styles/positron')
      .then((response) => { if (!response.ok) throw new Error('map style'); return response.json(); })
      .then((style: StyleSpecification) => {
        if (mapRef.current !== map) return;
        style.layers = style.layers.filter((layer) => {
          if (layer.type !== 'symbol') return true;
          const layout = layer.layout;
          if (!layout || !('icon-image' in layout)) return true;
          if (!('text-field' in layout)) return false;
          delete layout['icon-image'];
          return true;
        });
        const base = maplibreGL({ style, attributionControl: false }).addTo(map);
        const gl = base.getMaplibreMap();
        gl.once('load', () => setTileState('ready'));
        gl.on('error', () => setTileState((state) => state === 'ready' ? state : 'error'));
        L.control.attribution({ position: 'bottomright' }).addAttribution('OpenFreeMap &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>').addTo(map);
      })
      .catch(() => { if (mapRef.current === map) setTileState('error'); });
    overlayLayerRef.current = L.layerGroup().addTo(map);
    nodeLayerRef.current = L.layerGroup().addTo(map);
    setMapReady(true);
    } catch (error) {
      containerRef.current?.setAttribute('data-map-error', String(error));
      console.error('[ciliwung-map]', error);
    }
    const resizeObserver = typeof ResizeObserver !== 'undefined' && containerRef.current ? new ResizeObserver(() => map.invalidateSize()) : null;
    if (resizeObserver && containerRef.current) resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      overlayLayerRef.current = null;
      nodeLayerRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const overlayLayer = overlayLayerRef.current;
    const nodeLayer = nodeLayerRef.current;
    if (!mapReady || !map || !overlayLayer || !nodeLayer) return;
    overlayLayer.clearLayers();
    nodeLayer.clearLayers();

    const mapPoints = [...extraNodes, ...REAL_MAP_NODES];
    const route = mapPoints.map((point) => [point.lat, point.lng] as L.LatLngExpression);
    const nodeMap = new Map((snapshot?.threeDNodes ?? []).map((node) => [node.id, node]));
    mapPoints.slice(0, -1).forEach((point) => {
      const node = nodeMap.get(point.id);
      const style = areaStyle(node, condition);
      const markerColor = node ? statusColor(node.status) : '#64748B';
      L.circleMarker([point.lat, point.lng], {
        radius: point.id === 'N1' ? 8 : 6,
        color: '#0F172A',
        weight: 2,
        fillColor: markerColor,
        fillOpacity: 1,
      }).bindTooltip(`${simulation ? point.label.replace(/^(?:UP|N)\d+ · /, '') : point.label} · ${node ? (node.valueType === 'simulation' ? 'simulasi' : node.valueType === 'derived_preset' ? 'turunan preset' : node.valueType === 'actual_sensor' ? 'sensor aktual' : 'reset') : 'menunggu data'}${node && node.valueType !== 'reset' ? ` · ${node.tmaCm.toFixed(1)} cm · ${node.status} · ${isLive ? 'LIVE' : 'STALE'} · ${formatReadingTime(snapshot?.hardware?.measuredAt ?? snapshot?.timestampUtc)}` : ''}`, { direction: 'top' }).addTo(nodeLayer);
    });

    // Draw metre-wide bands around the mapped river, coloured by the nearest
    // station's current status. These are illustrative corridors, not flood extents.
    if (isLive && showHeat && river.length > 1) {
      const stations = mapPoints.slice(0, -1).filter((point) => {
        const node = nodeMap.get(point.id);
        return node && node.valueType !== 'reset';
      });
      const nearestRiverIndex = (point: { lat: number; lng: number }) => river.reduce((best, xy, i) => {
        const dist = (xy[0] - point.lng) ** 2 + (xy[1] - point.lat) ** 2;
        return dist < best.dist ? { index: i, dist } : best;
      }, { index: 0, dist: Infinity }).index;
      if (stations.length) {
        const stationIndexes = stations.map((point) => ({ point, index: nearestRiverIndex(point) }));
        const start = simulation ? 0 : Math.min(...stationIndexes.map((s) => s.index));
        const canvas = L.canvas({ padding: 0.5 });
        for (let i = start; i < river.length - 1; i++) {
          const a = river[i], b = river[i + 1];
          const nearest = stationIndexes.reduce((best, current) => Math.abs(current.index - i) < Math.abs(best.index - i) ? current : best);
          const node = nodeMap.get(nearest.point.id)!;
          const style = areaStyle(node, condition);
          const latScale = 111320;
          const lngScale = latScale * Math.cos((a[1] + b[1]) * Math.PI / 360);
          const dx = (b[0] - a[0]) * lngScale, dy = (b[1] - a[1]) * latScale;
          const length = Math.hypot(dx, dy);
          if (!length) continue;
          for (const [factor, opacity] of [[1, 0.10], [0.65, 0.15], [0.32, 0.23]]) {
            const ox = -dy / length * style.radius * factor / lngScale;
            const oy = dx / length * style.radius * factor / latScale;
            L.polygon([[a[1]+oy,a[0]+ox], [b[1]+oy,b[0]+ox], [b[1]-oy,b[0]-ox], [a[1]-oy,a[0]-ox]], {
              renderer: canvas, stroke: false, fillColor: style.color, fillOpacity: opacity, interactive: false,
            }).addTo(overlayLayer);
          }
        }
      }
    }

    if (!hasFittedRef.current) {
      map.fitBounds(L.latLngBounds(route), { padding: [38, 38] });
      hasFittedRef.current = true;
    }
    window.setTimeout(() => map.invalidateSize(), 0);
  }, [snapshot, condition, isLive, mapReady, showHeat, extraNodes, river, simulation]);

  return (
    <div className={fillHeight ? "flex flex-col flex-1 min-h-[560px]" : "space-y-3"} data-testid="hardware-map2d">
      <div className={`relative ${fillHeight ? "h-[min(72vh,760px)] lg:h-auto lg:flex-1" : "h-[min(72vh,760px)]"} min-h-[560px] w-full overflow-hidden rounded-2xl border border-slate-500/30 bg-slate-900 shadow-xl`}>
        <div ref={containerRef} className="absolute inset-0 z-0" aria-label="Peta interaktif OpenStreetMap koridor Ciliwung" />
        <div className="pointer-events-none absolute bottom-3 left-3 z-[1000] rounded-xl border border-slate-900/20 bg-slate-950/90 px-4 py-3 text-[11px] text-slate-200 shadow-lg backdrop-blur">
          <div className="mb-2 font-bold uppercase tracking-wider text-slate-300">Area indikatif · bukan batas banjir</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />Normal</span>
            <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-yellow-400" />Air naik</span>
            <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-orange-500" />Siaga</span>
            <span><i className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-blue-600" />Banjir</span>
          </div>
        </div>
        {riverError && <div role="status" className="absolute left-3 top-24 z-[1000] rounded-lg bg-slate-950/90 px-3 py-2 text-xs text-white">Data sungai tidak tersedia; area indikatif disembunyikan.</div>}
        {tileState !== 'ready' && <div role="status" className="absolute right-3 top-16 z-[1000] rounded-lg bg-slate-950/90 px-3 py-2 text-xs text-white">{tileState === 'error' ? 'Peta tidak tersedia. Periksa koneksi internet.' : 'Memuat peta…'}</div>}
        <button type="button" onClick={() => setShowHeat(!showHeat)} aria-pressed={showHeat} className="absolute left-3 top-3 z-[1000] rounded-lg bg-slate-950/90 px-3 py-2 text-xs text-white">{showHeat ? 'Sembunyikan area' : 'Tampilkan area'}</button>
      </div>
      {!compact && <div className="flex flex-wrap items-center justify-between gap-2 text-xs opacity-75">
        <span>{simulation ? 'Data simulasi' : 'N1 Pos Depok'}: {level == null ? '—' : `${level.toFixed(1)} cm`} · {isLive ? (simulation ? 'AKTIF' : 'LIVE') : (simulation ? 'TIDAK AKTIF' : 'STALE')}</span>
        <span>Pita warna mengikuti jalur sungai berdasarkan status stasiun terdekat. Lebarnya hanya ilustrasi, bukan luas atau kedalaman banjir.</span>
      </div>}
    </div>
  );
}

type GraphPoint = { x: number; y: number };

function AnimatedHistory({ points, distance = false }: { points: GraphPoint[]; distance?: boolean }) {
  const [displayPoints, setDisplayPoints] = useState(points);
  const current = useRef(points);
  const signature = JSON.stringify(points);
  const previousSignature = useRef(signature);
  useEffect(() => {
    if (signature === previousSignature.current) return;
    previousSignature.current = signature;
    const previous = current.current;
    const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || typeof window.requestAnimationFrame !== 'function' || previous.length < 2 || points.length < 2) {
      current.current = points;
      setDisplayPoints(points);
      return;
    }
    let frame = 0;
    let start: number | null = null;
    const animate = (time: number) => {
      if (start === null) start = time;
      const progress = Math.min(1, (time - start) / 500);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = interpolateGraphPoints(previous, points, eased) as GraphPoint[];
      current.current = next;
      setDisplayPoints(next);
      if (progress < 1) frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [signature]);
  return <g className="hardware-graph-series"><Curve type="monotoneX" points={displayPoints} baseLine={220} fill={distance ? 'url(#hardware-graph-distance-area)' : 'url(#hardware-graph-area)'} stroke="none" /><Curve data-testid="hardware-history-trace" type="monotoneX" points={displayPoints} fill="none" stroke={distance ? '#10B981' : '#3B82F6'} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /></g>;
}

export function GraphView({ history, forecast, name, nodeId, config, derived, simulated, language, stale, selectedTime, onSelectTime, onSelectSensorNode, forecastStatus, theme, loadDay, dayStatus }: { history: HistoryPoint[]; forecast: HistoryPoint[]; name: string; nodeId: string; config: ThresholdConfig; derived: boolean; simulated: boolean; language: 'id' | 'en'; stale: boolean; selectedTime: number | null; onSelectTime: (time: number | null) => void; onSelectSensorNode: () => void; forecastStatus: string; theme: 'light' | 'dark'; loadDay?: () => void; dayStatus: string }) {
  const en = language === 'en';
  const [range, setRange] = useState<'30m' | 'recent' | '24h'>('30m');
  const [metric, setMetric] = useState<'elevation' | 'distance'>('elevation');
  useEffect(() => {
    if (nodeId !== 'N1') setMetric('elevation');
    if (simulated) setRange('30m');
  }, [nodeId, simulated]);
  const showDistance = metric === 'distance' && nodeId === 'N1';
  const referenceHeight = typeof config.reference_height === 'number' && Number.isFinite(config.reference_height) && config.reference_height > 0 ? config.reference_height : null;
  const lastAvailable = history.at(-1);
  const cutoff = range === '24h' ? Date.now() - 24 * 60 * 60_000 : (lastAvailable?.time ?? 0) - 30 * 60_000;
  const windowHistory = history.filter(point => point.time >= cutoff && (range !== '24h' || point.time <= Date.now()));
  const rangeHistory = range === 'recent' ? windowHistory.slice(-20) : windowHistory;
  const visibleHistory: HistoryPoint[] = showDistance ? rangeHistory.flatMap(point => {
    const distance = sensorDistance(simulated ? { level: point.level } : point, referenceHeight);
    return distance ? [{ time: point.time, level: distance.value, distanceMethod: distance.method as HistoryPoint['distanceMethod'] }] : [];
  }) : rangeHistory;
  const last = visibleHistory.at(-1);
  const displayStale = stale || Boolean(showDistance && last && Date.now() - last.time > 8 * 60_000);
  const selected = selectedTime == null ? last : visibleHistory.find(point => point.time === selectedTime) ?? last;
  const historical = Boolean(selected && last && selected.time !== last.time);
  const limits = validLimits(config, derived ? getDownstreamPresetLimits(nodeId) : null);
  const maxAxis = showDistance ? Math.ceil(Math.max(100, referenceHeight ?? 0, ...visibleHistory.map(point => point.level)) / 20) * 20 : graphAxisMax(visibleHistory, forecast, limits);
  const startTime = range === 'recent' && visibleHistory.length > 1 ? visibleHistory[0].time : (last?.time ?? 0) - (range === '24h' ? 24 * 60 : 30) * 60_000;
  const historySpan = Math.max(1, (last?.time ?? 0) - startTime);
  const timeTicks = last ? graphTimeTicks(startTime, last.time, showDistance) : [];
  const historyRight = showDistance ? 650 : 350;
  const historyWidth = historyRight - 50;
  const xForTime = (time: number) => historyRight + (time - (last?.time ?? 0)) / historySpan * historyWidth;
  const futureX = (time: number) => time <= (last?.time ?? 0) ? xForTime(time) : 350 + (time - (last?.time ?? 0)) / 1_800_000 * 300;
  const yForLevel = (level: number) => 220 - level / maxAxis * 180;
  const selectedX = selected ? xForTime(selected.time) : 0;
  const selectedY = selected ? yForLevel(selected.level) : 0;
  const timeLabelWidth = range === '24h' ? 132 : 92;
  const timeLabelX = Math.max(50, Math.min(650 - timeLabelWidth, selectedX - timeLabelWidth / 2));
  const timeLabelY = selectedY < 75 ? selectedY + 12 : selectedY - 34;
  const points = visibleHistory.map(point => ({ x: xForTime(point.time), y: yForLevel(point.level) }));
  const selectPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!last || !visibleHistory.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 670;
    const time = last.time + (Math.max(50, Math.min(historyRight, x)) - historyRight) / historyWidth * historySpan;
    const nearest = visibleHistory.reduce((best, point) => Math.abs(point.time - time) < Math.abs(best.time - time) ? point : best);
    onSelectTime(nearest.time === last.time ? null : nearest.time);
  };
  const selectKeyboard = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (!last || !selected || !visibleHistory.length) return;
    const currentIndex = visibleHistory.findIndex(point => point.time === selected.time);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? visibleHistory.length - 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? Math.max(0, currentIndex - 1)
      : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? Math.min(visibleHistory.length - 1, currentIndex + 1) : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const point = visibleHistory[nextIndex];
    onSelectTime(point.time === last.time ? null : point.time);
  };
  const exportVisible = () => {
    if (!visibleHistory.length) return;
    const source = derived ? 'derived visual preset' : simulated ? 'simulation' : 'ESP32 sensor';
    const coverage = range === '24h' ? (dayStatus === 'partial' || dayStatus === 'error' ? 'partial query; coverage unverified' : 'coverage unverified') : 'loaded readings only';
    const url = URL.createObjectURL(new Blob([graphCsv(visibleHistory, nodeId, source, range, coverage, showDistance ? 'sensor_distance_cm' : 'water_level_cm')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `ciliwung_${nodeId}_${showDistance ? 'distance_' : ''}${range}_history.csv`; link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div data-testid="hardware-graph" className={`min-w-0 flex-1 space-y-4 rounded-2xl border p-4 sm:p-6 ${theme === 'dark' ? 'border-white/5 bg-[#0D0D0F]' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-sky-500">{showDistance ? (simulated ? (en ? 'Sensor distance · simulation' : 'Jarak sensor · simulasi') : (en ? 'Sensor distance' : 'Jarak sensor')) : (en ? 'Water elevation and critical limits' : 'Elevasi air dan batas kritis')}</p>
          <h3 className="mt-1 text-xl font-bold">{name}</h3>
          {selected && <div data-testid="selected-graph-value" className="mt-2 flex flex-wrap items-baseline gap-2"><span className="text-2xl font-semibold tabular-nums tracking-tight">{selected.level.toFixed(1)} <span className="text-sm font-normal opacity-70">cm</span></span>{showDistance && selected.distanceMethod === 'estimated' && <span className="text-xs opacity-70">{en ? 'estimated' : 'perkiraan'}</span>}<span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${historical || displayStale ? 'bg-slate-500/15 text-slate-500' : 'bg-emerald-500/15 text-emerald-500'}`}>{historical ? (en ? 'HISTORY' : 'RIWAYAT') : displayStale ? (en ? 'LAST DATA' : 'DATA TERAKHIR') : 'LIVE'}</span>{historical && <button type="button" className="text-xs text-sky-500 underline" onClick={() => onSelectTime(null)}>{en ? 'Return to latest' : 'Kembali ke data terbaru'}</button>}</div>}
          {!derived && <p className="mt-1 text-xs opacity-75">{simulated ? (en ? 'Simulated reading · not ESP32' : 'Data simulasi · bukan ESP32') : (en ? 'ESP32 sensor reading' : 'Pembacaan sensor ESP32')}{last && displayStale ? (stale ? (en ? ' · last data, offline' : ' · data terakhir, offline') : (en ? ' · last distance' : ' · jarak terakhir')) : ''}</p>}
        </div>
        <button type="button" onClick={exportVisible} disabled={!visibleHistory.length || (range === '24h' && dayStatus === 'loading')} className="hardware-graph-control inline-flex items-center gap-2 rounded-lg border border-slate-500/25 bg-slate-500/10 px-3 py-2.5 text-xs font-medium hover:border-sky-500/50 hover:bg-slate-500/20 disabled:cursor-not-allowed disabled:opacity-50">
          <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-sky-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" /></svg>
          {en ? 'Export Data' : 'Ekspor Data'}
        </button>
      </div>
      {showDistance ? <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs"><span><span className="text-emerald-500">━━</span> {en ? 'Sensor distance' : 'Jarak sensor'}</span>{referenceHeight !== null && <span><span className="text-slate-500">┄┄</span> {en ? 'Reference' : 'Referensi'} {referenceHeight} cm</span>}</div> : <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs"><span><span className="text-blue-500">━━</span> {en ? 'History' : 'Riwayat'}</span><span><span className="text-violet-500">┄┄</span> {en ? 'Demo forecast' : 'Prediksi demo'}</span>{limits && <><span><span className="text-amber-500">┄┄</span> Siaga {limits.siaga} cm</span><span><span className="text-rose-500">┄┄</span> Bahaya {limits.bahaya} cm</span></>}</div>}
      {showDistance ? <p className="text-xs opacity-75">{simulated ? (en ? 'Simulated distance calculated from the current reference height; not a sensor reading.' : 'Jarak simulasi dihitung dari tinggi referensi saat ini; bukan pembacaan sensor.') : (en ? 'Pos Depok (N1) sensor distance may be recorded or estimated from the current reference height.' : 'Jarak sensor Pos Depok (N1) dapat berupa nilai tercatat atau perkiraan dari tinggi referensi saat ini.')}</p> : (derived || !limits) && <p className="text-xs opacity-75">{!limits ? (en ? 'Valid alert limits are unavailable.' : 'Batas siaga yang valid tidak tersedia.') : (en ? 'Downstream limits are visual presets, not calibrated site limits.' : 'Ambang hilir adalah preset visual, bukan batas lokasi terkalibrasi.')}</p>}
      {!showDistance && forecastStatus === 'error' && !stale && <p role="status" className="text-xs text-amber-500">{en ? 'Demonstration forecast is unavailable.' : 'Prediksi demonstrasi tidak tersedia.'}</p>}
      <p className="text-xs opacity-75 sm:hidden">{showDistance ? (en ? 'Swipe to see the full chart.' : 'Geser untuk melihat seluruh grafik.') : (en ? 'Swipe the chart sideways to see the forecast.' : 'Geser grafik ke samping untuk melihat prediksi.')}</p>
      {range === '24h' && <p role="status" className={`text-xs ${theme === 'dark' ? 'text-amber-400' : 'text-amber-700'}`}>{dayStatus === 'loading' ? (en ? 'Loading 24-hour history…' : 'Memuat riwayat 24 jam…') : dayStatus === 'error' ? (en ? 'History query failed; only already loaded data is shown. Select 24 hours to retry.' : 'Gagal mengambil riwayat; hanya data yang sudah dimuat ditampilkan. Pilih 24 jam untuk mencoba lagi.') : (en ? '24-hour results may be incomplete: unsupported timestamp formats or missing records cannot be detected.' : 'Hasil 24 jam mungkin tidak lengkap: format waktu yang tidak didukung atau data hilang tidak dapat dideteksi.')}{dayStatus === 'partial' && (en ? ' Some queries failed or reached the limit.' : ' Sebagian kueri gagal atau mencapai batas.')}</p>}
      <div className="min-h-[220px] sm:min-h-[300px] flex items-center overflow-x-auto">
        {last ? <svg data-testid="history-graph" viewBox="0 0 670 260" className="hardware-history-graph block w-full min-w-[540px] touch-pan-x cursor-crosshair" role="slider" tabIndex={0} aria-label={`${showDistance ? (en ? 'Sensor distance history.' : 'Riwayat jarak sensor.') : (en ? 'Water level history.' : 'Riwayat tinggi muka air.')} ${en ? 'Use arrow keys to select a reading.' : 'Gunakan tombol panah untuk memilih pembacaan.'} ${name}`} aria-valuemin={0} aria-valuemax={visibleHistory.length - 1} aria-valuenow={Math.max(0, visibleHistory.findIndex(point => point.time === selected?.time))} aria-valuetext={selected ? `${formatReadingDateTime(selected.time)}, ${selected.level.toFixed(1)} cm${showDistance && selected.distanceMethod === 'estimated' ? (en ? ', estimated' : ', perkiraan') : ''}` : undefined} onKeyDown={selectKeyboard} onPointerDown={event => { if (event.pointerType !== 'touch') { event.preventDefault(); if (document.activeElement === event.currentTarget) event.currentTarget.blur(); } event.currentTarget.setPointerCapture(event.pointerId); selectPointer(event); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) selectPointer(event); }}>
          <defs><linearGradient id="hardware-graph-area" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity=".15" /><stop offset="95%" stopColor="#3B82F6" stopOpacity="0" /></linearGradient><linearGradient id="hardware-graph-distance-area" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity=".18" /><stop offset="95%" stopColor="#10B981" stopOpacity="0" /></linearGradient></defs>
          {[0, 0.25, 0.5, 0.75, 1].map(ratio => <g key={ratio}><line x1="50" y1={220-ratio*180} x2="650" y2={220-ratio*180} stroke="#64748B" strokeOpacity="0.3" strokeDasharray="3 3" /><text x="0" y={224-ratio*180} fill={theme === 'dark' ? '#CBD5E1' : '#475569'} fontSize="12">{(maxAxis*ratio).toFixed(0)}</text></g>)}
          {timeTicks.map(tick => <line key={tick.x} x1={tick.x} y1="40" x2={tick.x} y2="220" stroke="#64748B" strokeOpacity="0.3" strokeDasharray="3 3" />)}
          {!showDistance && <line x1="350" x2="350" y1="40" y2="220" stroke="#64748B" strokeOpacity="0.8" />}
          <text x="0" y="20" fill={theme === 'dark' ? '#CBD5E1' : '#475569'} fontSize="12">cm</text>
          {showDistance ? referenceHeight !== null && <line data-testid="graph-reference-limit" x1="50" x2="650" y1={yForLevel(referenceHeight)} y2={yForLevel(referenceHeight)} stroke="#71717a" strokeDasharray="4 4" /> : limits && <><line data-testid="graph-siaga-limit" x1="50" x2="650" y1={yForLevel(limits.siaga)} y2={yForLevel(limits.siaga)} stroke="#f59e0b" strokeDasharray="5 4" /><line data-testid="graph-bahaya-limit" x1="50" x2="650" y1={yForLevel(limits.bahaya)} y2={yForLevel(limits.bahaya)} stroke="#f43f5e" strokeDasharray="3 3" /></>}
          {selected && <line data-testid="graph-selected-guide" x1={selectedX} x2={selectedX} y1="40" y2="220" stroke={theme === 'dark' ? '#CBD5E1' : '#475569'} strokeOpacity="0.8" strokeWidth="1" pointerEvents="none" aria-hidden="true" />}
          {points.length > 1 && <AnimatedHistory points={points} distance={showDistance} />}
          {!showDistance && (!stale || historical) && forecast.length > 1 && <polyline className="hardware-graph-panel-enter" data-testid="trend-forecast-trace" points={forecast.map(p => `${futureX(p.time)},${yForLevel(p.level)}`).join(' ')} fill="none" stroke={theme === 'dark' ? '#a78bfa' : '#7c3aed'} strokeWidth="2" strokeDasharray="6 5" />}
          {selected && <circle data-testid="graph-selected-point" cx={selectedX} cy={selectedY} r="7" fill={showDistance ? '#10B981' : '#38BDF8'} stroke="white" strokeWidth="2" />}
          {selected && historical && <g data-testid="graph-selected-tooltip" aria-hidden="true" pointerEvents="none">
            <rect x={timeLabelX} y={timeLabelY} width={timeLabelWidth} height="24" rx="6" fill={theme === 'dark' ? '#1e293b' : '#ffffff'} stroke={theme === 'dark' ? '#64748b' : '#94a3b8'} />
            <text data-testid="graph-selected-tooltip-text" x={timeLabelX + timeLabelWidth / 2} y={timeLabelY + 16} textAnchor="middle" fontSize="11" fill={theme === 'dark' ? '#f1f5f9' : '#0f172a'}>{range === '24h' ? `${graphDateTickFormatter.format(new Date(selected.time))} ` : ''}{formatReadingTime(selected.time)} WIB</text>
          </g>}
          {timeTicks.map((tick, index) => <text key={tick.x} data-testid={tick.future ? 'forecast-time-tick' : 'history-time-tick'} x={tick.x} y={range === '24h' ? '238' : '244'} textAnchor={index === 0 ? 'start' : index === timeTicks.length - 1 ? 'end' : 'middle'} fill={tick.future ? (theme === 'dark' ? '#C4B5FD' : '#6D28D9') : (theme === 'dark' ? '#CBD5E1' : '#475569')} fontSize="10">{range === '24h' ? <><tspan x={tick.x}>{graphClockTickFormatter.format(new Date(tick.time))}</tspan><tspan x={tick.x} dy="11" fontSize="8">{graphDateTickFormatter.format(new Date(tick.time))}</tspan></> : formatReadingTime(tick.time)}</text>)}
        </svg> : <p className="w-full p-8 text-center text-sm opacity-70">{showDistance ? (en ? 'Sensor distance is unavailable. Check the readings and reference height.' : 'Jarak sensor belum tersedia. Periksa data dan tinggi referensi.') : (en ? 'Waiting for ESP32 data…' : 'Menunggu data ESP32…')}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div data-testid="graph-time-controls" className="flex flex-wrap items-center gap-1.5">
          <button type="button" aria-pressed={range === 'recent'} onClick={() => { setRange('recent'); onSelectTime(null); }} className={`hardware-graph-control rounded-lg px-3 py-2 ${range === 'recent' ? 'bg-blue-500 font-bold text-white' : 'bg-slate-500/10'}`}>{en ? 'Latest 20' : 'Terkini 20'}</button>
          <button type="button" aria-pressed={range === '30m'} onClick={() => { setRange('30m'); onSelectTime(null); }} className={`hardware-graph-control rounded-lg px-3 py-2 ${range === '30m' ? 'bg-blue-500 font-bold text-white' : 'bg-slate-500/10'}`}>30 min</button>
          {loadDay && !simulated && <button type="button" aria-pressed={range === '24h'} onClick={() => { setRange('24h'); onSelectTime(null); loadDay(); }} className={`hardware-graph-control rounded-lg px-3 py-2 ${range === '24h' ? 'bg-blue-500 font-bold text-white' : 'bg-slate-500/10'}`}>24 {en ? 'hours' : 'jam'}</button>}
        </div>
        <div data-testid="graph-metric-controls" className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" data-testid="graph-metric-elevation" aria-pressed={!showDistance} onClick={() => { setMetric('elevation'); onSelectTime(null); }} className={`hardware-graph-control rounded-lg px-3 py-2 ${!showDistance ? 'bg-blue-500 font-bold text-white' : 'bg-slate-500/10'}`}>{en ? 'Water level' : 'Elevasi air'}</button>
          <button type="button" data-testid="graph-metric-distance" title={derived ? (en ? 'Open sensor distance for Pos Depok (N1).' : 'Buka jarak sensor Pos Depok (N1).') : (en ? 'Show sensor-to-water distance.' : 'Tampilkan jarak sensor ke air.')} aria-pressed={showDistance} onClick={() => { setMetric('distance'); onSelectTime(null); if (derived) onSelectSensorNode(); }} className={`hardware-graph-control rounded-lg px-3 py-2 ${showDistance ? 'bg-emerald-600 font-bold text-white' : 'bg-slate-500/10'}`}>{en ? 'Sensor distance' : 'Jarak sensor'}</button>
        </div>
      </div>
      {last && <p className="text-xs opacity-70">{en ? 'Available history shown' : 'Riwayat tersedia yang ditampilkan'}: {visibleHistory.length} {en ? 'readings' : 'pembacaan'} · {range === '24h' ? formatReadingDateTime(visibleHistory[0].time) : formatReadingTime(visibleHistory[0].time)}–{range === '24h' ? formatReadingDateTime(last.time) : formatReadingTime(last.time)} WIB</p>}
    </div>
  );
}

export default function CiliwungHardwareLiveView({
  theme = 'dark',
  language = 'id',
  latestReading = null,
  readings = [],
  config = {},
  loadDayHistory,
  onEnterSimulation,
  compact = false,
}: {
  theme?: 'light' | 'dark';
  language?: 'id' | 'en';
  latestReading?: LatestReading | null;
  readings?: LatestReading[];
  config?: ThresholdConfig;
  loadDayHistory?: () => Promise<DayHistoryResult>;
  onEnterSimulation?: () => void;
  compact?: boolean;
}) {
  const isDark = theme === 'dark';
  const [activeView, setActiveView] = useState<HardwareView>('map2d');
  const [snapshot, setSnapshot] = useState<HardwareSnapshot | null>(null);
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const historySourceRef = useRef<string | undefined>(undefined);
  const [graphNodeId, setGraphNodeId] = useState('N1');
  const [showNodePanel, setShowNodePanel] = useState(true);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [demoForecast, setDemoForecast] = useState<{ key: string; levels: number[] } | null>(null);
  const [forecastStatus, setForecastStatus] = useState('insufficient');
  const [now, setNow] = useState(() => Date.now());
  const [streamError, setStreamError] = useState<string | null>(null);
  const [dayHistory, setDayHistory] = useState<LatestReading[]>([]);
  const [dayStatus, setDayStatus] = useState('idle');
  const dayRequest = useRef(0);
  useEffect(() => {
    dayRequest.current++;
    setDayHistory([]);
    setDayStatus('idle');
    return () => { dayRequest.current++; };
  }, [config.reference_height]);
  const loadDay = loadDayHistory ? () => {
    const request = ++dayRequest.current;
    setDayStatus('loading');
    loadDayHistory().then(result => {
      if (request !== dayRequest.current) return;
      setDayHistory(result.readings);
      setDayStatus(result.failed || result.truncated ? 'partial' : 'ready');
    }).catch(() => {
      if (request !== dayRequest.current) return;
      setDayStatus('error');
    });
  } : undefined;
  const fallbackLevel = typeof latestReading?.water_level === 'number' ? latestReading.water_level : null;
  const latestTimestamp = snapshot?.hardware?.measuredAt ?? latestReading?.timestamp;
  const isLive = snapshot?.hardware?.freshness === 'live' && snapshot.status === 'running';
  const apiBase = typeof window !== 'undefined' ? window.location.origin : '';
  const threeDUrl = useMemo(() => `${'http://127.0.0.1:8765/?mode=hardware&nodes=N1,N2,N3,N4,N5&viewerVersion=20261107-responsive&embed=dashboard&api='}${encodeURIComponent(`${apiBase}/api/ciliwung-hardware/stream`)}`, [apiBase]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const stream = new EventSource(`${apiBase}/api/ciliwung-hardware/stream`);
    const handleState = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as HardwareSnapshot;
        setSnapshot(next);
        const sourceChanged = historySourceRef.current !== next.hardware?.valueType;
        historySourceRef.current = next.hardware?.valueType;
        const time = readingTime(next.hardware?.measuredAt);
        if (next.status === 'running' && Number.isFinite(time)) {
          setHistory((current) => {
            const updated = sourceChanged ? {} : { ...current };
            for (const node of next.threeDNodes ?? []) {
              if (!['actual_sensor', 'simulation', 'derived_preset'].includes(node.valueType) || !Number.isFinite(node.tmaCm)) continue;
              const previous = updated[node.id] ?? [];
              updated[node.id] = [...previous.filter((point) => point.time !== time), { time, level: node.tmaCm }].sort((a, b) => a.time - b.time).slice(-48);
            }
            return updated;
          });
        } else if (next.status === 'idle') setHistory({});
        setStreamError(null);
      } catch {
        setStreamError('State live hardware tidak valid.');
      }
    };
    stream.addEventListener('state', handleState as EventListener);
    stream.onerror = () => setStreamError('Stream hardware belum tersedia atau terputus.');
    return () => stream.close();
  }, [apiBase]);

  const espHistory = useMemo(() => [...new Map([...dayHistory, ...readings].filter((reading) => /^Hardware-ESP32(?:-|$)/i.test(reading.source ?? '') && typeof reading.water_level === 'number' && Number.isFinite(reading.water_level) && reading.water_level >= 0 && reading.water_level <= 1000 && Number.isFinite(readingTime(reading.timestamp)))
    .map((reading) => {
      const reportedDistance = sensorDistance(reading, undefined);
      return [readingTime(reading.timestamp), { time: readingTime(reading.timestamp), level: reading.water_level as number, ...(reportedDistance ? { distance: reportedDistance.value } : {}) }];
    })).values()].sort((a, b) => a.time - b.time), [dayHistory, readings]);
  const simulated = snapshot?.hardware?.valueType === 'simulation';
  const reconstructed = useMemo(() => graphNodeId !== 'N1' && !simulated ? espHistory.flatMap((point) => {
    try {
      const derived = (buildHardwareSnapshot as any)({ levelCm: point.level, thresholdSiaga: config.threshold_siaga ?? 60, thresholdBahaya: config.threshold_bahaya ?? 90 }).threeDNodes.find((node: HardwareNode) => node.id === graphNodeId);
      return derived ? [{ time: point.time, level: derived.tmaCm }] : [];
    } catch { return []; }
  }) : [], [graphNodeId, simulated, espHistory, config.threshold_siaga, config.threshold_bahaya]);
  const combinedHistory = new Map<number, HistoryPoint>();
  for (const point of [...(graphNodeId === 'N1' && !simulated ? espHistory : reconstructed), ...(history[graphNodeId] ?? [])]) {
    combinedHistory.set(point.time, { ...combinedHistory.get(point.time), ...point });
  }
  const selectedHistory = [...combinedHistory.values()].sort((a, b) => a.time - b.time);
  const latestEsp = espHistory.at(-1);
  const snapshotTime = readingTime(snapshot?.hardware?.measuredAt ?? snapshot?.timestampUtc);
  const fallbackNodes = useMemo(() => {
    if (!latestEsp || simulated || (snapshot?.status === 'running' && Number.isFinite(snapshotTime) && snapshotTime >= latestEsp.time)) return null;
    try {
      return (buildHardwareSnapshot as any)({ levelCm: latestEsp.level, thresholdSiaga: config.threshold_siaga ?? 60, thresholdBahaya: config.threshold_bahaya ?? 90, measuredAt: new Date(latestEsp.time).toISOString() }).threeDNodes as HardwareNode[];
    } catch { return null; }
  }, [latestEsp?.time, latestEsp?.level, simulated, snapshot?.status, snapshotTime, config.threshold_siaga, config.threshold_bahaya]);
  const currentNodes = fallbackNodes ?? (snapshot?.status === 'running' ? snapshot.threeDNodes : []);
  const nodeTime = fallbackNodes ? latestEsp?.time : (Number.isFinite(snapshotTime) ? snapshotTime : latestEsp?.time);
  const lastTime = selectedHistory.at(-1)?.time;
  const graphStale = Boolean(streamError) || !lastTime || now - lastTime > 8 * 60_000;
  const projectionHistory = [...new Map([...espHistory, ...(simulated ? [] : history.N1 ?? [])].map(point => [point.time, point])).values()];
  const selectedPoint = selectedHistory.find(point => point.time === selectedTime) ?? selectedHistory.at(-1);
  const recentInput = projectionHistory.filter(point => selectedPoint && point.time <= selectedPoint.time).sort((a, b) => a.time - b.time).slice(-12);
  let start = recentInput.length - 1;
  while (start > 0 && recentInput[start].time - recentInput[start - 1].time >= 15000 && recentInput[start].time - recentInput[start - 1].time <= 25000) start--;
  const forecastInput = recentInput.slice(Math.max(start, 0)).map(({ time, level }) => ({ time, level }));
  const inputKey = JSON.stringify(forecastInput);
  useEffect(() => {
    const input: HistoryPoint[] = JSON.parse(inputKey);
    if (simulated || !input.length) { setDemoForecast(null); setForecastStatus('insufficient'); return; }
    const controller = new AbortController();
    setDemoForecast(null); setForecastStatus('loading');
    const timer = window.setTimeout(() => {
      fetch(`${apiBase}/api/ciliwung-hardware/demo-forecast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ history: input }), signal: controller.signal })
        .then(async response => { if (!response.ok) throw new Error('forecast unavailable'); return response.json(); })
        .then(data => {
          if (!Array.isArray(data.levelsCm) || data.levelsCm.length !== 90 || data.stepSeconds !== 20 || data.levelsCm.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('invalid forecast');
          if (!controller.signal.aborted) { setDemoForecast({ key: inputKey, levels: data.levelsCm }); setForecastStatus('ready'); }
        })
        .catch(() => { if (!controller.signal.aborted) setForecastStatus('error'); });
    }, 400);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [inputKey, apiBase, simulated]);
  const rawProjection = selectedPoint && demoForecast?.key === inputKey ? [{ time: selectedPoint.time, level: forecastInput.at(-1)!.level }, ...demoForecast.levels.map((level, i) => ({ time: selectedPoint.time + (i + 1) * 20000, level }))] : [];
  const forecast = graphNodeId === 'N1' ? rawProjection : projectDownstreamLevel(rawProjection, selectedPoint?.level);

  return (
    <section data-testid="ciliwung-hardware-live-view" className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} col-span-12 w-full rounded-2xl border p-4`}>
      {!compact && <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.22em] text-[#38BDF8]">
            <span className={`h-2 w-2 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
            Live Ciliwung Viewer
          </div>
          <h2 className={`mt-2 text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>Monitoring Depok → Laut Jawa</h2>
          <p className="mt-1 text-xs opacity-70">Sumber utama: {snapshot?.hardware?.valueType === 'simulation' ? 'Simulasi Pengaturan' : 'ESP32 N1 Pos Depok'} · status: {isLive ? 'TERHUBUNG' : 'MENUNGGU / STALE'}</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-lg border border-slate-500/20 px-2 py-1">N1 · {fallbackLevel == null ? '—' : `${fallbackLevel.toFixed(1)} cm`}</span>
          <span className="rounded-lg border border-slate-500/20 px-2 py-1">{formatReadingTime(latestTimestamp)}</span>
        </div>
      </div>

      }
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Tampilan live hardware">
        <button type="button" data-testid="hardware-view-map2d" onClick={() => setActiveView('map2d')} className={`rounded-lg px-3 py-2 text-xs font-bold ${activeView === 'map2d' ? 'bg-[#38BDF8] text-slate-950' : 'bg-slate-500/10'}`}>2D Map</button>
        <button type="button" data-testid="hardware-view-3d" onClick={() => setActiveView('map3d')} className={`rounded-lg px-3 py-2 text-xs font-bold ${activeView === 'map3d' ? 'bg-[#38BDF8] text-slate-950' : 'bg-slate-500/10'}`}>3D Map</button>
        <button type="button" data-testid="hardware-view-graph" aria-pressed={activeView === 'graph'} onClick={() => setActiveView('graph')} className={`rounded-lg px-3 py-2 text-xs font-bold ${activeView === 'graph' ? 'bg-[#38BDF8] text-slate-950' : 'bg-slate-500/10'}`}>{language === 'en' ? 'Forecast Graph' : 'Grafik Prediksi'}</button>
        {activeView === 'graph' && <button type="button" data-testid="toggle-node-panel" aria-expanded={showNodePanel} aria-controls="hardware-node-panel" onClick={() => setShowNodePanel(value => !value)} className="hardware-graph-control ml-auto rounded-lg border border-slate-500/30 px-3 py-2 text-xs font-semibold hover:bg-slate-500/10">{showNodePanel ? (language === 'en' ? 'Hide locations' : 'Sembunyikan lokasi') : (language === 'en' ? 'Show locations' : 'Tampilkan lokasi')}</button>}
        {!compact && onEnterSimulation && <button type="button" onClick={onEnterSimulation} className="ml-auto rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-slate-950">Masuk Simulation</button>}
      </div>

      {streamError && <p role="status" className="mt-3 text-xs text-amber-400">{streamError}</p>}
      {!compact && !isLive && <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">Map tetap menampilkan pembacaan terakhir jika tersedia. Warna live akan aktif setelah event ESP32 baru diterima.</p>}

      <div className="mt-4">
        {activeView === 'map2d' && <Map2D snapshot={snapshot} fallbackLevel={fallbackLevel} config={config} compact={compact} />}
        {activeView === 'graph' && <div className="flex flex-col gap-4 xl:flex-row">
          <GraphView history={selectedHistory} forecast={forecast} name={GRAPH_NODES.find((node) => node.id === graphNodeId)?.name ?? ''} nodeId={graphNodeId} config={config} theme={theme} loadDay={loadDay} dayStatus={dayStatus} derived={graphNodeId !== 'N1'} simulated={simulated} language={language} stale={graphStale} selectedTime={selectedTime} onSelectTime={setSelectedTime} onSelectSensorNode={() => setGraphNodeId('N1')} forecastStatus={forecastStatus} />
          <section id="hardware-node-panel" data-testid="hardware-node-levels" hidden={!showNodePanel} className="w-full rounded-2xl border border-slate-500/20 p-4 xl:w-64 xl:shrink-0">
            <h3 className="font-bold">{language === 'en' ? 'Water levels' : 'Tinggi Muka Air'}</h3>
            <p className="mt-1 text-xs opacity-70">{language === 'en' ? 'Select a location' : 'Pilih lokasi grafik'}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">{GRAPH_NODES.map((node) => {
              const data = currentNodes.find((entry) => entry.id === node.id && entry.valueType !== 'reset');
              const level = data?.tmaCm ?? (node.id === 'N1' ? latestEsp?.level : undefined);
              return <button type="button" key={node.id} data-testid={`hardware-node-${node.id}`} aria-pressed={graphNodeId === node.id} onClick={() => { setGraphNodeId(node.id); setSelectedTime(null); }} className={`hardware-node-card rounded-xl border p-3 text-left hover:border-blue-400/70 ${graphNodeId === node.id ? 'border-blue-500 bg-blue-500/15' : 'border-slate-500/20 bg-slate-500/5'}`}>
                <span className="flex items-center justify-between gap-2 text-xs font-bold"><span>{node.name}</span>{typeof level === 'number' && Number.isFinite(level) && <span>{level.toFixed(1)} cm</span>}</span>
                <span className="mt-1 block text-[11px] opacity-70">{node.id === 'N1' ? (snapshot?.hardware?.valueType === 'simulation' ? 'Simulasi' : 'ESP32') : (language === 'en' ? 'Visual preset · not sensor' : 'Preset visual · bukan sensor')}{typeof level === 'number' && (Boolean(streamError) || !nodeTime || now - nodeTime > 8 * 60_000) ? (language === 'en' ? ' · last data' : ' · data terakhir') : ''}</span>
              </button>;
            })}</div>
          </section>
        </div>}
        {activeView === 'map3d' && (
          <div data-testid="hardware-map3d" className="space-y-2">
            <p className="text-xs opacity-70">3D downstream dari Depok sampai laut. Tidak ada pilihan navigasi node sebelum Depok.</p>
            <iframe title="Ciliwung live 3D downstream map" src={threeDUrl} allowFullScreen className="h-[clamp(360px,65vh,760px)] w-full rounded-2xl border border-slate-500/20 bg-slate-950" />
          </div>
        )}
      </div>
    </section>
  );
}
