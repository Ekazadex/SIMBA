import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet';
import { setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

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
  const numeric = typeof timestamp === 'number' ? (timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp) : Date.parse(timestamp);
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

export function Map2D({ snapshot, fallbackLevel, config, simulation = false, extraNodes = [] }: { snapshot: HardwareSnapshot | null; fallbackLevel: number | null; config: ThresholdConfig; simulation?: boolean; extraNodes?: Array<{ id: string; label: string; lat: number; lng: number }> }) {
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
    return () => {
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
      }).bindTooltip(`${point.label} · ${node ? (node.valueType === 'simulation' ? 'simulasi' : node.valueType === 'derived_preset' ? 'turunan preset' : node.valueType === 'actual_sensor' ? 'sensor aktual' : 'reset') : 'menunggu data'}${node && node.valueType !== 'reset' ? ` · ${node.tmaCm.toFixed(1)} cm · ${node.status} · ${isLive ? 'LIVE' : 'STALE'} · ${formatReadingTime(snapshot?.hardware?.measuredAt ?? snapshot?.timestampUtc)}` : ''}`, { direction: 'top' }).addTo(nodeLayer);
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
    <div className="space-y-3" data-testid="hardware-map2d">
      <div className="relative h-[min(72vh,760px)] min-h-[560px] w-full overflow-hidden rounded-2xl border border-slate-500/30 bg-slate-900 shadow-xl">
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs opacity-75">
        <span>{simulation ? 'Data simulasi' : 'N1 Pos Depok'}: {level == null ? '—' : `${level.toFixed(1)} cm`} · {isLive ? (simulation ? 'AKTIF' : 'LIVE') : (simulation ? 'TIDAK AKTIF' : 'STALE')}</span>
        <span>Pita warna mengikuti jalur sungai berdasarkan status stasiun terdekat. Lebarnya hanya ilustrasi, bukan luas atau kedalaman banjir.</span>
      </div>
    </div>
  );
}

function GraphView({ history, fallbackLevel }: { history: number[]; fallbackLevel: number | null }) {
  const values = history.length > 0 ? history : (fallbackLevel == null ? [] : [fallbackLevel]);
  const max = Math.max(100, ...values, 1);
  const points = values.map((value, index) => `${(index / Math.max(1, values.length - 1)) * 600},${220 - (value / max) * 180}`).join(' ');
  return (
    <div data-testid="hardware-graph" className="space-y-3">
      <div>
        <h3 className="font-bold text-sm">Grafik TMA aktual · N1 Pos Depok</h3>
        <p className="text-xs opacity-70">Garis ini berasal dari pembacaan ESP32, bukan nilai derived downstream.</p>
      </div>
      <div className="rounded-2xl border border-slate-500/20 bg-slate-950/70 p-3">
        {values.length > 0 ? (
          <svg viewBox="0 0 620 250" className="block w-full" role="img" aria-label="Grafik tinggi muka air aktual Pos Depok">
            <line x1="10" y1="220" x2="610" y2="220" stroke="#64748B" strokeOpacity="0.5" />
            <line x1="10" y1="40" x2="610" y2="40" stroke="#64748B" strokeOpacity="0.25" strokeDasharray="5 5" />
            <polyline points={points} transform="translate(10 0)" fill="none" stroke="#38BDF8" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
            <text x="14" y="36" fill="#CBD5E1" fontSize="11">{max.toFixed(0)} cm</text>
            <text x="14" y="240" fill="#CBD5E1" fontSize="11">0 cm</text>
          </svg>
        ) : <p className="p-8 text-center text-sm opacity-70">Menunggu pembacaan ESP32…</p>}
      </div>
    </div>
  );
}

export default function CiliwungHardwareLiveView({
  theme = 'dark',
  latestReading = null,
  config = {},
  onEnterSimulation,
}: {
  theme?: 'light' | 'dark';
  latestReading?: LatestReading | null;
  config?: ThresholdConfig;
  onEnterSimulation?: () => void;
}) {
  const isDark = theme === 'dark';
  const [activeView, setActiveView] = useState<HardwareView>('map2d');
  const [snapshot, setSnapshot] = useState<HardwareSnapshot | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const fallbackLevel = typeof latestReading?.water_level === 'number' ? latestReading.water_level : null;
  const latestTimestamp = snapshot?.hardware?.measuredAt ?? latestReading?.timestamp;
  const isLive = snapshot?.hardware?.freshness === 'live' && snapshot.status === 'running';
  const apiBase = typeof window !== 'undefined' ? window.location.origin : '';
  const threeDUrl = useMemo(() => `${'http://127.0.0.1:8765/?mode=hardware&nodes=N1,N2,N3,N4,N5&viewerVersion=20261031-hardware-camera&api='}${encodeURIComponent(`${apiBase}/api/ciliwung-hardware/stream`)}`, [apiBase]);

  useEffect(() => {
    const stream = new EventSource(`${apiBase}/api/ciliwung-hardware/stream`);
    const handleState = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as HardwareSnapshot;
        setSnapshot(next);
        if (typeof next.hardware?.tmaCm === 'number' && next.status === 'running') {
          setHistory((current) => [...current, next.hardware!.tmaCm!].slice(-48));
        }
        setStreamError(null);
      } catch {
        setStreamError('State live hardware tidak valid.');
      }
    };
    stream.addEventListener('state', handleState as EventListener);
    stream.onerror = () => setStreamError('Stream hardware belum tersedia atau terputus.');
    return () => stream.close();
  }, [apiBase]);

  return (
    <section data-testid="ciliwung-hardware-live-view" className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} col-span-12 w-full mt-6 rounded-2xl border p-5`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
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

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Tampilan live hardware">
        <button type="button" data-testid="hardware-view-map2d" onClick={() => setActiveView('map2d')} className={`rounded-lg px-3 py-2 text-xs font-bold ${activeView === 'map2d' ? 'bg-[#38BDF8] text-slate-950' : 'bg-slate-500/10'}`}>2D Map</button>
        <button type="button" data-testid="hardware-view-graph" onClick={() => setActiveView('graph')} className={`rounded-lg px-3 py-2 text-xs font-bold ${activeView === 'graph' ? 'bg-[#38BDF8] text-slate-950' : 'bg-slate-500/10'}`}>Grafik</button>
        <button type="button" data-testid="hardware-view-3d" onClick={() => setActiveView('map3d')} className={`rounded-lg px-3 py-2 text-xs font-bold ${activeView === 'map3d' ? 'bg-[#38BDF8] text-slate-950' : 'bg-slate-500/10'}`}>3D Map</button>
        {onEnterSimulation && <button type="button" onClick={onEnterSimulation} className="ml-auto rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-slate-950">Masuk Simulation</button>}
      </div>

      {streamError && <p role="status" className="mt-3 text-xs text-amber-400">{streamError}</p>}
      {!isLive && <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300">Map tetap menampilkan pembacaan terakhir jika tersedia. Warna live akan aktif setelah event ESP32 baru diterima.</p>}

      <div className="mt-4">
        {activeView === 'map2d' && <Map2D snapshot={snapshot} fallbackLevel={fallbackLevel} config={config} />}
        {activeView === 'graph' && <GraphView history={history} fallbackLevel={fallbackLevel} />}
        {activeView === 'map3d' && (
          <div data-testid="hardware-map3d" className="space-y-2">
            <p className="text-xs opacity-70">3D downstream dari Depok sampai laut. Tidak ada pilihan navigasi node sebelum Depok.</p>
            <iframe title="Ciliwung live 3D downstream map" src={threeDUrl} className="h-[560px] w-full rounded-2xl border border-slate-500/20 bg-slate-950" />
          </div>
        )}
      </div>
    </section>
  );
}