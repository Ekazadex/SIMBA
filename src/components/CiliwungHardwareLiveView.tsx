import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Curve } from 'recharts';

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
  timestamp?: number | string | null;
  source?: string | null;
};
type HistoryPoint = { time: number; level: number };
type ThresholdConfig = {
  threshold_siaga?: number;
  threshold_bahaya?: number;
};

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
  return typeof timestamp === 'number' ? (timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp) : Date.parse(timestamp);
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

function GraphView({ history, name, derived, language, stale }: { history: HistoryPoint[]; name: string; derived: boolean; language: 'id' | 'en'; stale: boolean }) {
  const en = language === 'en';
  const last = history.at(-1);
  const max = Math.max(100, ...history.map((point) => point.level), 1);
  const maxAxis = Math.ceil(max / 20) * 20;
  const points = last ? history.filter((point) => point.time >= last.time - 30 * 60_000)
    .map((point) => ({ x: 350 + (point.time - last.time) / (30 * 60_000) * 300, y: 220 - (point.level / maxAxis) * 180 })) : [];
  return (
    <div data-testid="hardware-graph" className="min-w-0 flex-1 space-y-4 rounded-2xl border border-slate-500/20 p-4 sm:p-6">
      <div>
        <p className="text-xs font-bold uppercase text-sky-400">{en ? 'Water level' : 'Tinggi muka air'}</p>
        <h3 className="mt-1 text-xl font-bold">{name}</h3>
        <p className="mt-1 text-xs opacity-70">{derived ? (en ? 'Derived visual preset · not a sensor reading' : 'Turunan preset visual · bukan pembacaan sensor') : (en ? 'ESP32 sensor reading' : 'Pembacaan sensor ESP32')}{last && stale ? (en ? ' · last data, offline' : ' · data terakhir, offline') : ''}</p>
      </div>
      <div className="min-h-[260px] sm:min-h-[340px] flex items-center">
        {last ? (
          <svg viewBox="0 0 670 260" className="block w-full" role="img" aria-label={`${en ? 'Water level history' : 'Riwayat tinggi muka air'} ${name}`}>
            <defs><linearGradient id="hardware-graph-area" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity=".15" /><stop offset="95%" stopColor="#3B82F6" stopOpacity="0" /></linearGradient></defs>
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => <g key={ratio}><line x1="50" y1={220 - ratio * 180} x2="650" y2={220 - ratio * 180} stroke="#64748B" strokeOpacity="0.3" strokeDasharray="3 3" /><text x="0" y={224 - ratio * 180} fill="#94A3B8" fontSize="12">{(maxAxis * ratio).toFixed(0)}</text></g>)}
            {[50, 200, 350, 500, 650].map((x) => <line key={x} x1={x} y1="40" x2={x} y2="220" stroke="#64748B" strokeOpacity="0.3" strokeDasharray="3 3" />)}
            <text x="0" y="20" fill="#94A3B8" fontSize="12">cm</text>
            {points.length > 1 && <><Curve type="monotoneX" points={points} baseLine={220} fill="url(#hardware-graph-area)" stroke="none" /><Curve data-testid="hardware-history-trace" type="monotoneX" points={points} fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /></>}
            <circle cx="350" cy={220 - (last.level / maxAxis) * 180} r="4" fill="#3B82F6" />
            <text x="50" y="244" fill="#94A3B8" fontSize="12">−30 {en ? 'min' : 'menit'}</text>
            <text x="350" y="244" textAnchor="middle" fill="#94A3B8" fontSize="12">{formatReadingTime(last.time)}</text>
            <text x="650" y="244" textAnchor="end" fill="#94A3B8" fontSize="12">+30 {en ? 'min' : 'menit'}</text>
          </svg>
        ) : <p className="w-full p-8 text-center text-sm opacity-70">{en ? 'Waiting for ESP32 data…' : 'Menunggu data ESP32…'}</p>}
      </div>
      <p className="text-xs text-amber-500" role="status">{en ? 'Sensor-based forecast is not yet available.' : 'Prediksi berbasis data sensor belum tersedia.'}</p>
    </div>
  );
}

export default function CiliwungHardwareLiveView({
  theme = 'dark',
  language = 'id',
  latestReading = null,
  readings = [],
  config = {},
  onEnterSimulation,
  compact = false,
}: {
  theme?: 'light' | 'dark';
  language?: 'id' | 'en';
  latestReading?: LatestReading | null;
  readings?: LatestReading[];
  config?: ThresholdConfig;
  onEnterSimulation?: () => void;
  compact?: boolean;
}) {
  const isDark = theme === 'dark';
  const [activeView, setActiveView] = useState<HardwareView>('map2d');
  const [snapshot, setSnapshot] = useState<HardwareSnapshot | null>(null);
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({});
  const [graphNodeId, setGraphNodeId] = useState('N1');
  const [now, setNow] = useState(() => Date.now());
  const [streamError, setStreamError] = useState<string | null>(null);
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
        const time = readingTime(next.hardware?.measuredAt);
        if (next.status === 'running' && Number.isFinite(time)) {
          setHistory((current) => {
            const updated = { ...current };
            for (const node of next.threeDNodes ?? []) {
              if (!['actual_sensor', 'derived_preset'].includes(node.valueType) || !Number.isFinite(node.tmaCm)) continue;
              const previous = current[node.id] ?? [];
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

  const espHistory = readings.filter((reading) => /^Hardware-ESP32(?:-Batch)?$/i.test(reading.source ?? '') && Number.isFinite(reading.water_level) && Number.isFinite(readingTime(reading.timestamp)))
    .map((reading) => ({ time: readingTime(reading.timestamp), level: reading.water_level as number })).sort((a, b) => a.time - b.time);
  const selectedHistory = [...(graphNodeId === 'N1' ? espHistory : []), ...(history[graphNodeId] ?? [])]
    .filter((point, index, all) => all.findIndex((other) => other.time === point.time) === index)
    .sort((a, b) => a.time - b.time).slice(-48);
  const currentNodes = snapshot?.status === 'running' ? snapshot.threeDNodes : [];
  const latestEsp = espHistory.at(-1);
  const lastTime = selectedHistory.at(-1)?.time;
  const graphStale = Boolean(streamError) || !lastTime || now - lastTime > 8 * 60_000;

  return (
    <section data-testid="ciliwung-hardware-live-view" className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} col-span-12 w-full rounded-2xl border p-4`}>
      {!compact && <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.22em] text-[#38BDF8]">
            <span className={`h-2 w-2 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
            Live Ciliwung Viewer
          </div>
          <h2 className={`mt-2 text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>Monitoring Depok → Laut Jawa</h2>
          <p className="mt-1 text-xs opacity-70">Sumber utama: ESP32 N1 Pos Depok · status: {isLive ? 'TERHUBUNG' : 'MENUNGGU / STALE'}</p>
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
        {!compact && onEnterSimulation && <button type="button" onClick={onEnterSimulation} className="ml-auto rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-slate-950">Masuk Simulation</button>}
      </div>

      {streamError && <p role="status" className="mt-3 text-xs text-amber-400">{streamError}</p>}
      {!compact && !isLive && <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">Map tetap menampilkan pembacaan terakhir jika tersedia. Warna live akan aktif setelah event ESP32 baru diterima.</p>}

      <div className="mt-4">
        {activeView === 'map2d' && <Map2D snapshot={snapshot} fallbackLevel={fallbackLevel} config={config} compact={compact} />}
        {activeView === 'graph' && <div className="flex flex-col gap-4 xl:flex-row">
          <GraphView history={selectedHistory} name={GRAPH_NODES.find((node) => node.id === graphNodeId)?.name ?? ''} derived={graphNodeId !== 'N1'} language={language} stale={graphStale} />
          <section data-testid="hardware-node-levels" className="w-full rounded-2xl border border-slate-500/20 p-4 xl:w-64 xl:shrink-0">
            <h3 className="font-bold">{language === 'en' ? 'Water levels' : 'Tinggi Muka Air'}</h3>
            <p className="mt-1 text-xs opacity-70">{language === 'en' ? 'Select a location' : 'Pilih lokasi grafik'}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">{GRAPH_NODES.map((node) => {
              const data = currentNodes.find((entry) => entry.id === node.id && entry.valueType !== 'reset');
              const level = data?.tmaCm ?? (node.id === 'N1' ? latestEsp?.level : undefined);
              return <button type="button" key={node.id} data-testid={`hardware-node-${node.id}`} aria-pressed={graphNodeId === node.id} onClick={() => setGraphNodeId(node.id)} className={`rounded-xl border p-3 text-left ${graphNodeId === node.id ? 'border-blue-500 bg-blue-500/15' : 'border-slate-500/20 bg-slate-500/5'}`}>
                <span className="flex items-center justify-between gap-2 text-xs font-bold"><span>{node.name}</span>{typeof level === 'number' && Number.isFinite(level) && <span>{level.toFixed(1)} cm</span>}</span>
                <span className="mt-1 block text-[11px] opacity-70">{node.id === 'N1' ? 'ESP32' : (language === 'en' ? 'Visual preset · not sensor' : 'Preset visual · bukan sensor')}{typeof level === 'number' && (Boolean(streamError) || now - (readingTime(snapshot?.hardware?.measuredAt) || latestEsp?.time || 0) > 8 * 60_000) ? (language === 'en' ? ' · last data' : ' · data terakhir') : ''}</span>
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
