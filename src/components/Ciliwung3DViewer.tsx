import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Ciliwung3DController, Ciliwung3DNodeInput, Ciliwung3DStationMeta } from '../ciliwung3d/index';

export interface Ciliwung3DViewerProps {
  mode: 'hardware' | 'simulation';
  nodes: Ciliwung3DNodeInput[];
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  isLive?: boolean;
  isSimulatedHardware?: boolean;
  visible?: boolean;
  language?: 'id' | 'en';
  heightClassName?: string;
}

function statusBadgeClass(status?: string) {
  if (status === 'BANJIR_JAKARTA' || status === 'Bahaya') {
    return 'bg-rose-500/20 text-rose-200 border-rose-400/40';
  }
  if (status === 'SIAGA' || status === 'Siaga') {
    return 'bg-amber-500/20 text-amber-200 border-amber-400/40';
  }
  return 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40';
}

function formatStatus(status?: string) {
  if (!status) return 'AMAN';
  if (status === 'BANJIR_JAKARTA') return 'BANJIR';
  return status.toUpperCase();
}

export default function Ciliwung3DViewer({
  mode,
  nodes,
  selectedNodeId,
  onSelectNode,
  isLive = false,
  isSimulatedHardware = false,
  visible = true,
  language = 'id',
  heightClassName = 'h-[clamp(420px,62vh,660px)]',
}: Ciliwung3DViewerProps) {
  const en = language === 'en';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<Ciliwung3DController | null>(null);
  const nodesRef = useRef<Ciliwung3DNodeInput[]>(nodes);
  const visibleRef = useRef<boolean>(visible);
  const enRef = useRef<boolean>(en);
  const lastExternalSelectedRef = useRef<string | undefined>(selectedNodeId);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stations, setStations] = useState<Ciliwung3DStationMeta[]>([]);
  const [activeStationId, setActiveStationId] = useState<string>(selectedNodeId || 'N1');
  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  nodesRef.current = nodes;
  visibleRef.current = visible;
  enRef.current = en;

  const showToast = (msg: string) => {
    setToastText(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastText(null), 2400);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let rafId = 0;
    let resizeObserver: ResizeObserver | null = null;
    let controller: Ciliwung3DController | null = null;

    setStatus('loading');
    setErrorMessage(null);

    const initTimer = window.setTimeout(async () => {
      try {
        const mod = await import('../ciliwung3d/index.js');
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;

        controller = mod.buildCiliwung3DScene(canvas, {
          mode,
          initialNodeId: lastExternalSelectedRef.current || 'N1',
        });

        if (cancelled) {
          controller.dispose();
          return;
        }

        controllerRef.current = controller;
        setStations(controller.stationsMeta);
        const initialId =
          controller.stationsMeta.find((s) => s.id === (lastExternalSelectedRef.current || 'N1'))?.id ??
          controller.stationsMeta[0]?.id ??
          'N1';
        setActiveStationId(initialId);

        if (nodesRef.current.length > 0) {
          controller.applyNodeLevels(nodesRef.current);
        }

        if (containerRef.current && typeof ResizeObserver !== 'undefined') {
          let resizeRafId = 0;
          resizeObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry || !controllerRef.current) return;
            const { width, height } = entry.contentRect;
            if (width > 10 && height > 10) {
              if (resizeRafId) window.cancelAnimationFrame(resizeRafId);
              resizeRafId = window.requestAnimationFrame(() => {
                resizeRafId = 0;
                if (!cancelled && controllerRef.current) {
                  controllerRef.current.resize(width, height);
                }
              });
            }
          });
          resizeObserver.observe(containerRef.current);
        }

        const startedAt = performance.now();
        controller.renderFrame(0, 0.25);
        setStatus('ready');

        const animate = (nowMs: number) => {
          if (cancelled || !controllerRef.current) return;
          rafId = window.requestAnimationFrame(animate);
          if (!visibleRef.current) return;
          const elapsedSec = (nowMs - startedAt) / 1000;
          const avgStage =
            nodesRef.current.length > 0
              ? nodesRef.current.reduce((acc, item) => acc + (Number(item.stageRiseM) || 0), 0) /
                nodesRef.current.length
              : 0.2;
          controllerRef.current.renderFrame(elapsedSec, Math.min(1, Math.max(0.2, avgStage * 0.45 + 0.2)));
        };
        rafId = window.requestAnimationFrame(animate);
      } catch (err) {
        if (cancelled) return;
        console.error('[Ciliwung3DViewer]', err);
        setErrorMessage(
          err instanceof Error
            ? err.message
            : enRef.current
              ? 'Failed to initialize 3D WebGL scene.'
              : 'Gagal menginisialisasi visualisasi 3D WebGL.'
        );
        setStatus('error');
      }
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(initTimer);
      if (rafId) window.cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      if (controllerRef.current) {
        controllerRef.current.dispose();
        controllerRef.current = null;
      } else if (controller) {
        controller.dispose();
      }
    };
  }, [mode]);

  // Resize cleanly whenever tab becomes visible
  useEffect(() => {
    if (!visible || !controllerRef.current || !containerRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (!controllerRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width > 10 && rect.height > 10) {
        controllerRef.current.resize(rect.width, rect.height);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible]);

  // Apply real-time water level / floodplain spill updates
  useEffect(() => {
    if (!controllerRef.current) return;
    controllerRef.current.applyNodeLevels(nodes);
  }, [nodes]);

  // Sync camera when parent selects a different node
  useEffect(() => {
    if (!selectedNodeId || selectedNodeId === lastExternalSelectedRef.current) return;
    lastExternalSelectedRef.current = selectedNodeId;
    if (!controllerRef.current) return;
    const resolved = controllerRef.current.selectNodeById(selectedNodeId, { fly: true });
    if (resolved) setActiveStationId(resolved);
  }, [selectedNodeId]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const activeMeta = stations.find((s) => s.id === activeStationId) ?? stations[0] ?? null;
  const activeLive = activeMeta ? nodeMap.get(activeMeta.id) : undefined;

  const handleSelectStation = (stationId: string) => {
    setActiveStationId(stationId);
    lastExternalSelectedRef.current = stationId;
    controllerRef.current?.selectNodeById(stationId, { fly: true });
    onSelectNode?.(stationId);
    const meta = stations.find((s) => s.id === stationId);
    if (meta) {
      showToast(en ? `Flying to ${meta.name}` : `Terbang ke ${meta.name}`);
    }
  };

  const handleFlySea = () => {
    controllerRef.current?.flyToSea();
    showToast(en ? 'Ciliwung Estuary & Java Sea' : 'Muara Ciliwung & Laut Jawa');
  };

  const handleFlyOverview = () => {
    controllerRef.current?.flyToOverview();
    showToast(en ? 'Full Ciliwung Watershed Overview' : 'Tampilan Menyeluruh DAS Ciliwung');
  };

  const handleResetView = () => {
    controllerRef.current?.resetView();
    showToast(en ? 'Camera reset to active station' : 'Kamera kembali ke stasiun aktif');
  };

  const topBannerText =
    mode === 'hardware'
      ? isSimulatedHardware
        ? en
          ? 'CONTROLLED SIMULATION · NOT ESP32 SENSOR'
          : 'SIMULASI PENGATURAN · BUKAN DATA ESP32'
        : isLive
          ? en
            ? 'LIVE HARDWARE ACTIVE · DEPOK TO JAVA SEA · ESP32 N1'
            : 'LIVE HARDWARE AKTIF · DEPOK KE LAUT JAWA · ESP32 N1'
          : en
            ? 'STANDBY · DEPOK TO JAVA SEA · ESP32 N1'
            : 'MENUNGGU DATA · DEPOK KE LAUT JAWA · ESP32 N1'
      : isLive
        ? en
          ? 'SIMULATION ACTIVE · PUNCAK (UP1) TO JAVA SEA · 9 NODES'
          : 'SIMULASI AKTIF · PUNCAK (UP1) KE LAUT JAWA · 9 NODE'
        : en
          ? '9-NODE WATERSHED 3D · PUNCAK (UP1) TO JAVA SEA'
          : 'VISUALISASI 3D DAS CILIWUNG · PUNCAK (UP1) KE LAUT JAWA';

  return (
    <div
      ref={containerRef}
      className={`relative w-full ${heightClassName} overflow-hidden bg-[#b9d2d5] select-none`}
    >
      <canvas ref={canvasRef} className="block h-full w-full outline-none cursor-grab active:cursor-grabbing" />

      {/* Top center status pill matching Naufal's HUD */}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-[#122624]/85 px-3.5 py-1.5 text-[10px] font-bold tracking-[0.08em] text-[#e7f4f0] shadow-lg backdrop-blur-md">
          <span
            className={`h-2 w-2 rounded-full ${
              isLive ? 'bg-emerald-400 animate-pulse' : 'bg-amber-300'
            }`}
          />
          <span>{topBannerText}</span>
        </div>
      </div>

      {/* Loading overlay (brief ~0.4s while building SRTM + OSM geometry) */}
      {status === 'loading' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#dde7e4]/90 text-[#142522] backdrop-blur-xs">
          <div className="h-7 w-7 animate-spin rounded-full border-3 border-[#1f5e53]/25 border-t-[#1f5e53]" />
          <p className="text-xs font-semibold tracking-wide">
            {en ? 'Building Ciliwung 3D SRTM & OSM terrain…' : 'Menyiapkan medan 3D SRTM & OSM Ciliwung…'}
          </p>
        </div>
      )}

      {/* Explicit error fallback */}
      {status === 'error' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[#141f1d]/95 p-6 text-center text-slate-100">
          <p className="text-sm font-bold text-rose-300">
            {en ? '3D WebGL Renderer Unavailable' : 'Visualisasi 3D WebGL Tidak Tersedia'}
          </p>
          <p className="max-w-md text-xs text-slate-300">{errorMessage}</p>
        </div>
      )}

      {/* Floating station detail drawer */}
      {status === 'ready' && showDetails && activeMeta && (
        <div className="absolute bottom-14 left-3 z-20 w-[min(290px,calc(100%-24px))] rounded-2xl border border-white/15 bg-[#10211f]/90 p-3.5 text-slate-100 shadow-2xl backdrop-blur-md">
          <div className="flex items-start justify-between gap-2 border-b border-white/10 pb-2.5">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-emerald-300">
                {activeMeta.id} · {activeMeta.elevationM.toFixed(0)} m SRTM
              </p>
              <h4 className="text-sm font-bold text-white">{activeMeta.name}</h4>
            </div>
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${statusBadgeClass(activeLive?.status)}`}
            >
              {formatStatus(activeLive?.status)}
            </span>
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-white/5 px-2.5 py-2">
              <span className="block text-[10px] text-slate-400">TMA</span>
              <strong className="font-mono text-sm text-white">
                {typeof activeLive?.tmaCm === 'number' && Number.isFinite(activeLive.tmaCm)
                  ? `${activeLive.tmaCm.toFixed(1)} cm`
                  : '—'}
              </strong>
            </div>
            <div className="rounded-lg bg-white/5 px-2.5 py-2">
              <span className="block text-[10px] text-slate-400">
                {en ? 'Stage Rise' : 'Kenaikan Air'}
              </span>
              <strong className="font-mono text-sm text-sky-300">
                +{((Number(activeLive?.stageRiseM) || 0)).toFixed(2)} m
              </strong>
            </div>
          </div>

          <div className="mt-3 max-h-40 space-y-1 overflow-y-auto pr-0.5">
            {stations.map((station) => {
              const live = nodeMap.get(station.id);
              const isSelected = station.id === activeMeta.id;
              return (
                <button
                  key={station.id}
                  type="button"
                  onClick={() => handleSelectStation(station.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-emerald-500/25 text-white font-bold border border-emerald-400/40'
                      : 'bg-white/5 text-slate-200 hover:bg-white/10 border border-transparent'
                  }`}
                >
                  <span className="truncate">
                    {station.id} · {station.name}
                  </span>
                  <span className="ml-2 shrink-0 font-mono text-[10px] text-sky-200">
                    {typeof live?.tmaCm === 'number' && Number.isFinite(live.tmaCm)
                      ? `${live.tmaCm.toFixed(0)} cm`
                      : `+${(Number(live?.stageRiseM) || 0).toFixed(2)}m`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Toast feedback */}
      {toastText && (
        <div className="pointer-events-none absolute bottom-14 right-3 z-20 rounded-lg border border-white/15 bg-[#10211f]/90 px-3 py-1.5 text-[11px] font-medium text-emerald-100 shadow-lg backdrop-blur">
          {toastText}
        </div>
      )}

      {/* Bottom HUD controls */}
      {status === 'ready' && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-center justify-between gap-2">
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className={`rounded-xl border px-3 py-1.5 text-[11px] font-bold shadow-md backdrop-blur-md transition-colors cursor-pointer ${
                showDetails
                  ? 'border-emerald-400/50 bg-[#153530]/95 text-emerald-100'
                  : 'border-white/15 bg-[#122624]/85 text-[#eef6f3] hover:bg-[#1a3733]/95'
              }`}
            >
              {showDetails
                ? en
                  ? 'Close Details'
                  : 'Tutup Detail'
                : en
                  ? 'Station Details'
                  : 'Detail Stasiun'}
            </button>
            <button
              type="button"
              onClick={handleFlySea}
              className="rounded-xl border border-white/15 bg-[#122624]/85 px-3 py-1.5 text-[11px] font-bold text-[#eef6f3] shadow-md backdrop-blur-md transition-colors hover:bg-[#1a3733]/95 cursor-pointer"
            >
              {en ? 'Java Sea Outlet' : 'Muara Laut Jawa'}
            </button>
            <button
              type="button"
              onClick={handleFlyOverview}
              className="rounded-xl border border-white/15 bg-[#122624]/85 px-3 py-1.5 text-[11px] font-bold text-[#eef6f3] shadow-md backdrop-blur-md transition-colors hover:bg-[#1a3733]/95 cursor-pointer"
            >
              {en ? 'Full Watershed' : 'Peta Penuh'}
            </button>
            <button
              type="button"
              onClick={handleResetView}
              className="rounded-xl border border-white/15 bg-[#122624]/85 px-3 py-1.5 text-[11px] font-bold text-[#eef6f3] shadow-md backdrop-blur-md transition-colors hover:bg-[#1a3733]/95 cursor-pointer"
            >
              {en ? 'Reset Camera' : 'Fokus Stasiun'}
            </button>
          </div>
          <div className="hidden sm:block rounded-lg border border-white/10 bg-[#122624]/75 px-2.5 py-1 text-[10px] font-medium text-[#dcece8] backdrop-blur-md">
            {en ? 'Drag: orbit · Scroll: zoom · Right-drag: pan' : 'Geser: orbit · Scroll: zoom · Klik kanan: pan'}
          </div>
        </div>
      )}
    </div>
  );
}
