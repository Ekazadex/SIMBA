import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { loadCiliwung3DAssets } from '../lib/ciliwung3d/assets-loader';
import { buildSceneApp } from '../lib/ciliwung3d/scene.js';
import { createCameraNavigator } from '../lib/ciliwung3d/navigation.js';

export interface Ciliwung3DNodeInput {
  id: string;
  name?: string;
  tmaCm?: number;
  stageRiseM?: number;
  status?: string;
  valueType?: string;
}

interface CiliwungOfficial3DViewProps {
  mode: 'hardware' | 'simulation';
  nodes: Ciliwung3DNodeInput[];
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  isLive?: boolean;
  isSimulatedHardware?: boolean;
  simTimeSeconds?: number;
  theme?: 'light' | 'dark';
  language?: 'id' | 'en';
  heightClassName?: string;
}

const HARDWARE_NODE_IDS = new Set(['N1', 'N2', 'N3', 'N4', 'N5']);

function formatStatusLabel(status?: string, en = false) {
  if (!status || status === 'AMAN') return en ? 'SAFE' : 'AMAN';
  if (status === 'BANJIR_JAKARTA') return en ? 'FLOOD' : 'BANJIR';
  if (status === 'SIAGA') return en ? 'ALERT' : 'SIAGA';
  return status;
}

function statusBadgeClass(status?: string) {
  if (status === 'BANJIR_JAKARTA') return 'bg-rose-500/20 text-rose-300 border-rose-500/40';
  if (status === 'SIAGA') return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
  return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
}

export default function CiliwungOfficial3DView({
  mode,
  nodes,
  selectedNodeId,
  onSelectNode,
  isLive = false,
  isSimulatedHardware = false,
  simTimeSeconds = 0,
  language = 'id',
  heightClassName = 'h-[clamp(400px,62vh,640px)]',
}: CiliwungOfficial3DViewProps) {
  const en = language === 'en';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneAppRef = useRef<any>(null);
  const navigatorRef = useRef<ReturnType<typeof createCameraNavigator> | null>(null);
  const stageRisesRef = useRef<number[]>([]);
  const simTimeRef = useRef<number>(simTimeSeconds);
  const lastFocusedNodeRef = useRef<string | null>(null);
  const initialSelectionRef = useRef<string>(selectedNodeId || 'N1');

  const [phase, setPhase] = useState<'loading' | 'building' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [activeStationId, setActiveStationId] = useState<string>(selectedNodeId || 'N1');
  const [stationMeta, setStationMeta] = useState<
    Array<{ id: string; name: string; elevationM: number; latitude: number; longitude: number }>
  >([]);
  const [showDetails, setShowDetails] = useState(false);

  simTimeRef.current = simTimeSeconds;

  const nodeMap = useMemo(() => {
    const map = new Map<string, Ciliwung3DNodeInput>();
    for (const n of nodes) {
      map.set(n.id, n);
    }
    return map;
  }, [nodes]);

  const applyStationHighlight = useCallback((stationId: string) => {
    const app = sceneAppRef.current;
    if (!app?.stations) return;
    for (const station of app.stations) {
      const isSelected = station.id === stationId;
      if (station.selectionRing) station.selectionRing.visible = isSelected;
      if (station.sensorTargetGroup) station.sensorTargetGroup.visible = isSelected;
    }
  }, []);

  const flyToStation = useCallback(
    (stationId: string, opts?: { initial?: boolean }) => {
      const app = sceneAppRef.current;
      const nav = navigatorRef.current;
      if (!app?.stations || !nav) return;
      const station = app.stations.find((s: any) => s.id === stationId) ?? app.stations[0];
      if (!station) return;
      setActiveStationId(station.id);
      applyStationHighlight(station.id);
      lastFocusedNodeRef.current = station.id;

      if (opts?.initial && mode === 'hardware') {
        nav.flyTo(station.position, {
          distance: 280,
          durationMs: 700,
          targetHeight: 5,
          direction: { x: 0.38, y: 0.08, z: 0.92 },
        });
      } else {
        nav.flyTo(station.sensorTargetPosition ?? station.position, {
          distance: mode === 'hardware' ? 95 : 44,
          durationMs: opts?.initial ? 900 : 1200,
          targetHeight: 1.5,
          direction: station.cameraDirection,
        });
      }
    },
    [applyStationHighlight, mode]
  );

  const flyToSea = useCallback(() => {
    const app = sceneAppRef.current;
    const nav = navigatorRef.current;
    if (!app?.seaViewPosition || !nav) return;
    nav.flyTo(app.seaViewPosition, {
      distance: 1200,
      durationMs: 1600,
      targetHeight: 0,
      direction: { x: 0.2, y: 0.04, z: 1 },
    });
  }, []);

  // Initialize Three.js scene natively (no nested iframe!)
  useEffect(() => {
    let cancelled = false;
    let rafId = 0;
    let resizeObserver: ResizeObserver | null = null;
    let localSceneApp: any = null;

    const init = async () => {
      setPhase('loading');
      setErrorMessage(null);

      try {
        const assets = await loadCiliwung3DAssets();
        if (cancelled) return;

        setPhase('building');
        // Yield one micro-frame so the "building" label paints smoothly before synchronous geometry build
        await new Promise((resolve) => window.setTimeout(resolve, 16));
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const scopedNodes =
          mode === 'hardware'
            ? assets.nodeData.nodes.filter((n) => HARDWARE_NODE_IDS.has(n.id))
            : assets.nodeData.nodes;

        const app = buildSceneApp(
          canvas,
          assets.terrain,
          assets.riverAsset,
          { ...assets.nodeData, nodes: scopedNodes },
          assets.environmentData
        );

        if (cancelled) {
          app.dispose?.();
          return;
        }

        // Build selection highlight rings around each sensor pole
        for (const station of app.stations) {
          const ringMat = new THREE.MeshBasicMaterial({
            color: 0xe7c95d,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9,
          });
          const ring = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.0, 40), ringMat);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(station.position.x, station.position.y + 0.14, station.position.z);
          ring.visible = false;
          app.scene.add(ring);
          station.selectionRing = ring;
        }

        const nav = createCameraNavigator({
          camera: app.camera,
          controls: app.controls,
        });

        localSceneApp = app;
        sceneAppRef.current = app;
        navigatorRef.current = nav;

        setStationMeta(
          app.stations.map((s: any) => ({
            id: s.id,
            name: s.name,
            elevationM: Number.isFinite(s.elevationM) ? s.elevationM : 0,
            latitude: s.latitude,
            longitude: s.longitude,
          }))
        );

        // Apply initial water stages from current props
        const initialStages = app.stations.map((s: any) => {
          const match = nodeMap.get(s.id);
          return Math.max(0, Number(match?.stageRiseM ?? 0) || 0);
        });
        stageRisesRef.current = initialStages;
        app.setWaterStages(initialStages);

        // Initial camera focus
        const initialId =
          app.stations.some((s: any) => s.id === initialSelectionRef.current)
            ? initialSelectionRef.current
            : app.stations.some((s: any) => s.id === 'N1')
              ? 'N1'
              : app.stations[0]?.id;

        if (initialId) {
          setActiveStationId(initialId);
          for (const station of app.stations) {
            const isSelected = station.id === initialId;
            if (station.selectionRing) station.selectionRing.visible = isSelected;
            if (station.sensorTargetGroup) station.sensorTargetGroup.visible = isSelected;
          }
          lastFocusedNodeRef.current = initialId;
          const targetStation = app.stations.find((s: any) => s.id === initialId) ?? app.stations[0];
          if (targetStation) {
            if (mode === 'hardware') {
              nav.flyTo(targetStation.position, {
                distance: 280,
                durationMs: 700,
                targetHeight: 5,
                direction: { x: 0.38, y: 0.08, z: 0.92 },
              });
            } else {
              nav.flyTo(targetStation.sensorTargetPosition ?? targetStation.position, {
                distance: 44,
                durationMs: 900,
                targetHeight: 1.5,
                direction: targetStation.cameraDirection,
              });
            }
          }
        }

        // Resize observer keeps aspect ratio crisp inside responsive containers
        let resizeRafId = 0;
        if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
          resizeObserver = new ResizeObserver(() => {
            if (resizeRafId) window.cancelAnimationFrame(resizeRafId);
            resizeRafId = window.requestAnimationFrame(() => {
              resizeRafId = 0;
              if (!cancelled) app.resize();
            });
          });
          resizeObserver.observe(containerRef.current);
        }

        app.resize();
        app.render();
        setPhase('ready');

        const startWallMs = performance.now();
        const animate = () => {
          if (cancelled) return;
          nav.update();
          const elapsedSec = (performance.now() - startWallMs) / 1000;
          const rises = stageRisesRef.current;
          const avgRise = rises.length ? rises.reduce((sum, v) => sum + v, 0) / rises.length : 0;
          const runoff = Math.max(0.15, Math.min(1, 0.22 + avgRise / 3.2));
          app.updateFlowParticles(simTimeRef.current + elapsedSec * 12, runoff);
          app.render();
          rafId = window.requestAnimationFrame(animate);
        };
        rafId = window.requestAnimationFrame(animate);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMessage(msg || (en ? 'Failed to load 3D visualization.' : 'Gagal memuat visualisasi 3D.'));
        setPhase('error');
      }
    };

    init();

    return () => {
      cancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      if (localSceneApp) {
        localSceneApp.dispose?.();
      }
      sceneAppRef.current = null;
      navigatorRef.current = null;
    };
    // Rebuild only when mode or manual retry changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, retryToken]);

  // Update 3D water levels whenever live hardware or simulation nodes update
  useEffect(() => {
    const app = sceneAppRef.current;
    if (!app?.stations || phase !== 'ready') return;
    const rises = app.stations.map((station: any) => {
      const match = nodeMap.get(station.id);
      if (!match || match.valueType === 'reset') return 0;
      const val = Number(match.stageRiseM ?? 0);
      return Number.isFinite(val) ? Math.max(0, val) : 0;
    });
    stageRisesRef.current = rises;
    app.setWaterStages(rises);
  }, [nodeMap, phase]);

  // Smoothly fly camera when parent updates selectedNodeId
  useEffect(() => {
    if (!selectedNodeId || phase !== 'ready') return;
    initialSelectionRef.current = selectedNodeId;
    if (selectedNodeId === lastFocusedNodeRef.current) return;
    const app = sceneAppRef.current;
    if (!app?.stations?.some((s: any) => s.id === selectedNodeId)) return;
    flyToStation(selectedNodeId);
  }, [selectedNodeId, phase, flyToStation]);

  const activeMeta = stationMeta.find((s) => s.id === activeStationId) ?? stationMeta[0];
  const activeTelemetry = activeMeta ? nodeMap.get(activeMeta.id) : undefined;

  const bannerText =
    mode === 'hardware'
      ? isSimulatedHardware
        ? en
          ? 'CONTROLLED SIMULATION · DEPOK TO JAVA SEA · NOT ESP32'
          : 'SIMULASI PENGATURAN · DEPOK KE LAUT JAWA · BUKAN ESP32'
        : isLive
          ? en
            ? 'LIVE HARDWARE ACTIVE · DEPOK TO JAVA SEA · ESP32 N1'
            : 'LIVE HARDWARE AKTIF · DEPOK KE LAUT JAWA · ESP32 N1'
          : en
            ? 'LAST READING · DEPOK TO JAVA SEA · ESP32 N1'
            : 'DATA TERAKHIR · DEPOK KE LAUT JAWA · ESP32 N1'
      : isLive
        ? en
          ? 'SIMULATION ACTIVE · PUNCAK TO JAVA SEA · 9 NODES'
          : 'MODE SIMULASI AKTIF · PUNCAK KE LAUT JAWA · 9 NODE'
        : en
          ? 'SIMULATION STANDBY · PUNCAK TO JAVA SEA · 9 NODES'
          : 'SIMULASI SIAGA · PUNCAK KE LAUT JAWA · 9 NODE';

  const bannerDotColor =
    mode === 'hardware'
      ? isSimulatedHardware
        ? 'bg-amber-400'
        : isLive
          ? 'bg-emerald-400 animate-pulse'
          : 'bg-sky-400'
      : isLive
        ? 'bg-blue-400 animate-pulse'
        : 'bg-slate-400';

  const handleStationPick = (stationId: string) => {
    flyToStation(stationId);
    onSelectNode?.(stationId);
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full overflow-hidden rounded-xl bg-[#b9d2d5] select-none ${heightClassName}`}
    >
      <canvas ref={canvasRef} className="block h-full w-full cursor-grab active:cursor-grabbing" />

      {/* Top status banner */}
      {phase === 'ready' && (
        <div className="pointer-events-none absolute inset-x-0 top-2.5 sm:top-3 z-10 flex justify-center px-2.5 sm:px-3">
          <div className="inline-flex max-w-full items-center justify-center gap-1.5 sm:gap-2 rounded-xl sm:rounded-full border border-white/15 bg-slate-950/80 px-2.5 py-1.5 sm:px-3.5 sm:py-1.5 text-[9px] sm:text-[10px] font-mono font-semibold uppercase tracking-[0.06em] sm:tracking-[0.14em] text-slate-100 shadow-lg backdrop-blur-md text-center leading-snug">
            <span className={`h-2 w-2 shrink-0 rounded-full ${bannerDotColor}`} />
            <span className="min-w-0 break-words">{bannerText}</span>
          </div>
        </div>
      )}

      {/* Bottom-left action bar */}
      {phase === 'ready' && (
        <div className="absolute bottom-2.5 left-2.5 right-2.5 sm:bottom-3 sm:left-3 sm:right-auto z-10 flex flex-wrap items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="rounded-lg border border-white/15 bg-slate-950/80 px-2.5 py-1.5 sm:px-3 text-[10px] sm:text-[11px] font-semibold text-white shadow-md backdrop-blur-md transition hover:bg-slate-900 cursor-pointer whitespace-nowrap"
          >
            {showDetails
              ? en
                ? 'Hide details'
                : 'Tutup detail'
              : en
                ? 'Station details'
                : 'Detail stasiun'}
          </button>
          <button
            type="button"
            onClick={() => activeMeta && flyToStation(activeMeta.id)}
            className="rounded-lg border border-white/15 bg-slate-950/80 px-2.5 py-1.5 sm:px-3 text-[10px] sm:text-[11px] font-semibold text-white shadow-md backdrop-blur-md transition hover:bg-slate-900 cursor-pointer whitespace-nowrap"
          >
            {en ? `Focus ${activeMeta?.id ?? 'N1'}` : `Fokus ${activeMeta?.id ?? 'N1'}`}
          </button>
          <button
            type="button"
            onClick={flyToSea}
            className="rounded-lg border border-sky-400/30 bg-slate-950/80 px-2.5 py-1.5 sm:px-3 text-[10px] sm:text-[11px] font-semibold text-sky-200 shadow-md backdrop-blur-md transition hover:bg-slate-900 cursor-pointer whitespace-nowrap"
          >
            {en ? 'Java Sea Outlet' : 'Muara Laut Jawa'}
          </button>
        </div>
      )}

      {/* Station details popover */}
      {phase === 'ready' && showDetails && activeMeta && (
        <div className="absolute bottom-14 left-3 z-10 w-[min(320px,calc(100%-1.5rem))] rounded-xl border border-white/15 bg-slate-950/88 p-3.5 text-xs text-slate-100 shadow-2xl backdrop-blur-md">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-wider text-sky-400">
                {activeMeta.id} · {activeMeta.elevationM.toFixed(0)} {en ? 'm asl' : 'm mdpl'}
              </div>
              <div className="mt-0.5 text-sm font-bold text-white">{activeMeta.name}</div>
            </div>
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${statusBadgeClass(
                activeTelemetry?.status
              )}`}
            >
              {formatStatusLabel(activeTelemetry?.status, en)}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-white/10 bg-white/5 p-2.5">
            <div>
              <span className="block text-[10px] text-slate-400">{en ? 'Water level' : 'Tinggi Muka Air'}</span>
              <strong className="text-sm font-mono text-white">
                {typeof activeTelemetry?.tmaCm === 'number' && Number.isFinite(activeTelemetry.tmaCm)
                  ? `${activeTelemetry.tmaCm.toFixed(1)} cm`
                  : '—'}
              </strong>
            </div>
            <div>
              <span className="block text-[10px] text-slate-400">{en ? 'Stage rise' : 'Kenaikan 3D'}</span>
              <strong className="text-sm font-mono text-sky-300">
                +{(Number(activeTelemetry?.stageRiseM ?? 0) || 0).toFixed(2)} m
              </strong>
            </div>
          </div>

          <div className="mt-3">
            <span className="block text-[10px] font-mono uppercase tracking-wider text-slate-400 mb-1.5">
              {en ? 'Jump to station' : 'Pilih lokasi stasiun'}
            </span>
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              {stationMeta.map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => handleStationPick(st.id)}
                  className={`rounded-md border px-2 py-1 text-[10px] font-semibold transition cursor-pointer ${
                    st.id === activeMeta.id
                      ? 'border-sky-400 bg-sky-500/25 text-white'
                      : 'border-white/10 bg-white/5 text-slate-300 hover:border-sky-400/50'
                  }`}
                >
                  {st.id}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Bottom-right navigation hint */}
      {phase === 'ready' && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 hidden sm:block rounded-lg border border-white/10 bg-slate-950/65 px-2.5 py-1 text-[10px] text-slate-200 backdrop-blur">
          {en ? 'Drag: orbit · Scroll: zoom · Right-drag: pan' : 'Seret: putar · Gulir: zoom · Klik kanan: geser'}
        </div>
      )}

      {/* Loading overlay */}
      {(phase === 'loading' || phase === 'building') && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#dfe8df]/95 px-6 text-center text-slate-800 backdrop-blur-sm">
          <div className="h-8 w-8 animate-spin rounded-full border-3 border-emerald-700/20 border-t-emerald-700" />
          <div className="text-xs font-semibold tracking-wide">
            {phase === 'loading'
              ? en
                ? 'Loading SRTM elevation & Ciliwung corridor...'
                : 'Memuat data elevasi SRTM & koridor Ciliwung...'
              : en
                ? 'Building 3D terrain, river & stations...'
                : 'Membangun medan 3D, sungai & stasiun...'}
          </div>
        </div>
      )}

      {/* Error overlay */}
      {phase === 'error' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-slate-950/90 px-6 text-center text-slate-100">
          <p className="text-sm font-bold text-rose-300">
            {en ? 'Failed to initialize 3D view' : 'Gagal memuat visualisasi 3D'}
          </p>
          <p className="max-w-md text-xs text-slate-400">{errorMessage}</p>
          <button
            type="button"
            onClick={() => setRetryToken((v) => v + 1)}
            className="rounded-lg bg-blue-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-blue-400 cursor-pointer"
          >
            {en ? 'Retry 3D View' : 'Muat Ulang 3D'}
          </button>
        </div>
      )}
    </div>
  );
}
