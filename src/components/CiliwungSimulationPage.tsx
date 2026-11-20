import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Map2D } from './CiliwungHardwareLiveView';
import { Curve } from 'recharts';
import graphScale from './ciliwung-graph-scale.json';

type SimulationView = 'map3d' | 'graph' | 'map2d';
type ScenarioId = 'ringan' | 'sedang' | 'lebat';
type SpeedMultiplier = 1 | 10 | 25 | 50 | 150;
type SimulationMode = 'legacy' | 'rain_replay';
type Episode = { episodeId: string; label?: string; name?: string };

type CiliwungNode = {
  id: string;
  name: string;
  cupcarbonNodeId: number;
  threeDNodeId: string | null;
  tmaCm: number;
  stageRiseM: number;
  status: 'AMAN' | 'SIAGA' | 'BANJIR_JAKARTA';
  rainRateMmH?: number | null;
  rainMm5m?: number | null;
  rainSource?: string;
  tmaSource?: string;
};

type CiliwungForecast = {
  runId: string | null;
  nodeId: string;
  mode?: string;
  status: 'available' | 'unavailable';
  reason?: string;
  issuedAt?: string;
  generatedAt?: string;
  clockBasis?: string;
  predictedTmaCm?: { '30': number; '60': number };
  crossingWithin?: { '30': boolean | null; '60': boolean | null };
  trajectoryCm?: number[];
  thresholdBanjirCm?: number | null;
  inputProvenance?: { upstreamFeature?: string; rain?: string; tma?: string; bmkgContext?: string };
  method?: string;
  modelVersion?: string;
  quality?: string;
};

type CiliwungState = {
  runId: string | null;
  mode?: 'legacy' | 'rain_replay' | 'synthetic_demo' | string;
  episodeId?: string | null;
  scenario: ScenarioId | null;
  status: 'idle' | 'running' | 'stopped' | 'completed';
  speedMultiplier: SpeedMultiplier;
  simTimeSeconds: number;
  timestampUtc?: string;
  targetNodeId: string | null;
  targetThresholdCm: number | null;
  cupcarbon: { status: string; warning: string; lastSeenAt: number | null; activeNodeCount: number };
  cupNodes: CiliwungNode[];
  threeDNodes: CiliwungNode[];
  pendingReachCount: number;
  updatedAt: number;
};

type LegacyProjection = {
  status: 'available';
  method: 'legacy_simulation_projection';
  runId: string;
  nodeId: string;
  issuedSimTimeSeconds: number;
  speedMultiplier: SpeedMultiplier;
  points: Array<{ afterSeconds: number; tmaCm: number }>;
  scenarioCompletes: boolean;
};

type HistoryPoint = {
  runId: string;
  time: number;
  values: Record<string, number>;
};

const SIMULATION_UPSTREAM = [
  { id: 'UP1', label: 'UP1 · Puncak', lat: -6.691768, lng: 106.9635388 },
  { id: 'UP2', label: 'UP2 · Katulampa', lat: -6.6336889, lng: 106.834688 },
  { id: 'UP3', label: 'UP3 · Sukaraja', lat: -6.5601124, lng: 106.809813 },
  { id: 'UP4', label: 'UP4 · Cibinong', lat: -6.4650414, lng: 106.8180795 },
];

const SCENARIOS: Array<{ id: ScenarioId; label: string; description: string }> = [
  { id: 'ringan', label: 'Hujan Ringan', description: 'Scenario berakhir saat Puncak mencapai SIAGA.' },
  { id: 'sedang', label: 'Hujan Sedang', description: 'Scenario berakhir saat Stage 2 mencapai SIAGA.' },
  { id: 'lebat', label: 'Hujan Lebat', description: 'Scenario berakhir saat Manggarai mencapai BANJIR_JAKARTA.' },
];

const MAIN_GRAPH_NODES = ['UP1', 'UP2', 'UP3', 'UP4', 'N1', 'N2', 'N3', 'N4', 'N5'];
const FORECAST_NODES = new Set(MAIN_GRAPH_NODES);
const SPEED_OPTIONS: SpeedMultiplier[] = [1, 10, 25, 50, 150];

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function statusLabel(status: CiliwungNode['status']) {
  if (status === 'BANJIR_JAKARTA') return 'BANJIR';
  return status;
}

export default function CiliwungSimulationPage({
  theme = 'dark',
  language = 'id',
  onExit,
  backendAvailable = true,
  onRetryConnection,
}: {
  theme?: 'light' | 'dark';
  language?: 'id' | 'en';
  onExit: () => void;
  backendAvailable?: boolean;
  onRetryConnection?: () => void;
}) {
  const isDark = theme === 'dark';
  const [selectedMode, setSelectedMode] = useState<SimulationMode>('legacy');
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId>('ringan');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState('');
  const [episodeError, setEpisodeError] = useState<string | null>(null);
  const [selectedSpeed, setSelectedSpeed] = useState<SpeedMultiplier>(1);
  const [activeView, setActiveView] = useState<SimulationView>('map2d');
  const [state, setState] = useState<CiliwungState | null>(null);
  const [forecasts, setForecasts] = useState<Record<string, CiliwungForecast>>({});
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [legacyProjection, setLegacyProjection] = useState<LegacyProjection | null>(null);
  const [projectionError, setProjectionError] = useState(false);
  const [graphNodeId, setGraphNodeId] = useState('N1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const projectionRequestRef = useRef<symbol | null>(null);

  useEffect(() => () => { projectionRequestRef.current = null; }, []);

  const apiBase = typeof window !== 'undefined' ? window.location.origin : '';
  const threeDUrl = useMemo(() => {
    const streamUrl = `${apiBase}/api/ciliwung-simulation/stream`;
    return `/3d/?mode=backend&ui=20261107-location-names&embed=dashboard&api=${encodeURIComponent(streamUrl)}`;
  }, [apiBase]);

  useEffect(() => {
    let active = true;
    fetch(`${apiBase}/api/ciliwung-simulation/episodes`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Daftar episode tidak tersedia.');
        const payload = await response.json();
        const entries = Array.isArray(payload) ? payload : payload?.episodes;
        if (!Array.isArray(entries)) throw new Error('Format daftar episode tidak valid.');
        if (active) {
          const available = entries.filter((episode: Episode) => typeof episode?.episodeId === 'string');
          setEpisodes(available);
          setSelectedEpisodeId((current) => current || available[0]?.episodeId || '');
        }
      })
      .catch((fetchError) => {
        if (active) setEpisodeError(fetchError instanceof Error ? fetchError.message : 'Daftar episode tidak tersedia.');
      });
    return () => { active = false; };
  }, [apiBase]);

  useEffect(() => {
    const stream = new EventSource(`${apiBase}/api/ciliwung-simulation/stream`);
    eventSourceRef.current = stream;
    const handleState = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as CiliwungState;
        setState(next);
        if (next.runId && next.status !== 'idle' && Number.isFinite(next.simTimeSeconds)) {
          const point: HistoryPoint = { runId: next.runId, time: next.simTimeSeconds,
            values: Object.fromEntries(next.cupNodes.filter((node) => Number.isFinite(node.tmaCm)).map((node) => [node.id, node.tmaCm])) };
          setHistory((current) => {
            const matching = current.filter((item) => item.runId === point.runId && item.time < point.time);
            return [...matching, point].slice(-120);
          });
        } else {
          setHistory([]);
        }
        if (next.runId && next.status !== 'idle') {
          if (next.status === 'running') setSelectedSpeed(next.speedMultiplier);
          if (next.mode === 'rain_replay' || next.mode === 'synthetic_demo' || next.episodeId) {
            setSelectedMode('rain_replay');
            if (next.episodeId) setSelectedEpisodeId(next.episodeId);
          } else {
            setSelectedMode('legacy');
            if (SCENARIOS.some((scenario) => scenario.id === next.scenario)) setSelectedScenario(next.scenario!);
          }
        }
      } catch {
        setError('State simulasi dari backend tidak valid.');
      }
    };
    stream.addEventListener('state', handleState as EventListener);
    stream.addEventListener('forecast', ((event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as CiliwungForecast | null;
        if (next && typeof next.nodeId === 'string') {
          setForecasts((current) => ({ ...current, [next.nodeId]: next }));
        } else {
          setForecasts({});
        }
      } catch {
        setError('Forecast dari backend tidak valid.');
      }
    }) as EventListener);
    stream.onerror = () => setError('Stream simulasi terputus. Pastikan backend Website tetap berjalan.');
    return () => {
      stream.close();
      eventSourceRef.current = null;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!state?.runId || state.status === 'idle') return;
    const runId = state.runId;
    let active = true;
    fetch(`${apiBase}/api/ciliwung-simulation/history`)
      .then(async (response) => {
        if (!response.ok) throw new Error('simulation_history_unavailable');
        return response.json() as Promise<{ runId: string; points: HistoryPoint[] }>;
      })
      .then((payload) => {
        if (!active || payload.runId !== runId || !Array.isArray(payload.points)) return;
        const valid = payload.points.filter((point) => point.runId === runId && Number.isFinite(point.time)
          && point.values && typeof point.values === 'object');
        setHistory((current) => {
          const live = current.filter((point) => point.runId === runId);
          const byTime = new Map([...valid, ...live].map((point) => [point.time, point]));
          return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-120);
        });
      })
      .catch(() => { /* SSE continues to supply the current run's live points. */ });
    return () => { active = false; };
  }, [apiBase, state?.runId, state?.mode, state?.status]);

  useEffect(() => {
    const replay = state?.mode === 'rain_replay' || state?.mode === 'synthetic_demo' || Boolean(state?.episodeId);
    if (!replay || state?.status !== 'running' || !state.runId || !FORECAST_NODES.has(graphNodeId)) return;
    let active = true;
    fetch(`${apiBase}/api/ciliwung-forecast/latest?nodeId=${encodeURIComponent(graphNodeId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('forecast_unavailable');
        const payload = await response.json();
        const next = (payload?.forecast ?? payload) as CiliwungForecast;
        if (active && next && typeof next.nodeId === 'string') {
          setForecasts((current) => {
            const previous = current[next.nodeId];
            return previous?.runId === next.runId && previous.status === 'available' && next.status === 'unavailable'
              ? current : { ...current, [next.nodeId]: next };
          });
        }
      })
      .catch(() => {
        if (active) setForecasts((current) => ({ ...current, [graphNodeId]: { runId: state.runId, nodeId: graphNodeId, status: 'unavailable', reason: 'forecast_unavailable' } }));
      });
    return () => { active = false; };
  }, [apiBase, state?.runId, state?.mode, state?.episodeId, state?.status, graphNodeId]);

  const availableNodes = state?.cupNodes ?? [];
  useEffect(() => {
    if (availableNodes.length && !availableNodes.some((node) => node.id === graphNodeId)) {
      setGraphNodeId(availableNodes[0].id);
    }
  }, [state?.cupNodes, graphNodeId]);

  const selectedProfile = SCENARIOS.find((scenario) => scenario.id === selectedScenario) ?? SCENARIOS[0];
  const isRunning = state?.status === 'running';
  const isReplay = state?.mode === 'rain_replay' || state?.mode === 'synthetic_demo' || Boolean(state?.episodeId);
  const candidateForecast = forecasts[graphNodeId];
  const selectedForecast = isReplay && isRunning && candidateForecast?.runId === state?.runId
    && (candidateForecast.issuedAt === state?.timestampUtc || (candidateForecast.status === 'unavailable' && !candidateForecast.issuedAt)) ? candidateForecast : null;
  const thresholdCompatible = selectedForecast?.thresholdBanjirCm === null
    ? graphNodeId === 'UP1' && ([30, 60] as const).every((minutes) => selectedForecast.crossingWithin?.[minutes] === null)
    : graphNodeId !== 'UP1' && Number.isFinite(selectedForecast?.thresholdBanjirCm)
      && ([30, 60] as const).every((minutes) => typeof selectedForecast?.crossingWithin?.[minutes] === 'boolean');
  const forecastAvailable = selectedForecast?.status === 'available'
    && Number.isFinite(selectedForecast.predictedTmaCm?.['30'])
    && Number.isFinite(selectedForecast.predictedTmaCm?.['60'])
    && selectedForecast.trajectoryCm?.length === 12
    && selectedForecast.trajectoryCm.every(Number.isFinite)
    && thresholdCompatible;
  const cupCarbonActive = state?.cupcarbon?.status === 'active';
  const cupCarbonNodeCount = state?.cupcarbon?.activeNodeCount ?? 0;
  const currentNode = availableNodes.find((node) => node.id === graphNodeId);
  const currentTime = state?.simTimeSeconds ?? 0;
  const projectionOffset = legacyProjection ? currentTime - legacyProjection.issuedSimTimeSeconds : -1;
  const projectionPoint = isRunning && !isReplay && legacyProjection?.runId === state?.runId
    && legacyProjection.nodeId === graphNodeId && legacyProjection.speedMultiplier === state?.speedMultiplier
    ? legacyProjection.points.find((point) => Math.abs(point.afterSeconds - projectionOffset) < 0.001
      && Number.isFinite(currentNode?.tmaCm) && Math.abs(point.tmaCm - currentNode!.tmaCm) < 0.011) : undefined;

  const projectionRemaining = legacyProjection
    ? legacyProjection.points[legacyProjection.points.length - 1].afterSeconds - projectionOffset : 0;
  const projectionHasFuture = Boolean(projectionPoint && legacyProjection && projectionRemaining > 0
    && (projectionRemaining >= 1800 || legacyProjection.scenarioCompletes));
  useEffect(() => {
    if (activeView !== 'graph' || !isRunning || isReplay || !state?.runId || !currentNode
      || projectionHasFuture || projectionRequestRef.current) return;
    const requestId = Symbol('projection_request');
    projectionRequestRef.current = requestId;
    setProjectionError(false);
    fetch(`${apiBase}/api/ciliwung-simulation/projection?nodeId=${encodeURIComponent(graphNodeId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('projection_unavailable');
        return response.json() as Promise<LegacyProjection>;
      })
      .then((result) => {
        if (projectionRequestRef.current !== requestId) return;
        projectionRequestRef.current = null;
        if (result?.status !== 'available' || result.method !== 'legacy_simulation_projection'
          || result.runId !== state.runId || result.nodeId !== graphNodeId
          || !Number.isFinite(result.issuedSimTimeSeconds) || !Array.isArray(result.points)
          || result.points.length < 2 || !result.points.every((point, index) =>
            Number.isFinite(point.afterSeconds) && Number.isFinite(point.tmaCm) && point.tmaCm >= 0
            && (index === 0 ? point.afterSeconds === 0 : point.afterSeconds > result.points[index - 1].afterSeconds))) {
          setProjectionError(true);
          return;
        }
        setLegacyProjection(result);
      })
      .catch(() => {
        if (projectionRequestRef.current === requestId) {
          projectionRequestRef.current = null;
          setProjectionError(true);
        }
      });
  }, [activeView, apiBase, graphNodeId, isReplay, isRunning, state?.runId, state?.simTimeSeconds, state?.speedMultiplier, legacyProjection, projectionHasFuture]);
  const currentLevel = state?.runId && state.status !== 'idle' && currentNode && Number.isFinite(currentNode.tmaCm)
    ? currentNode.tmaCm : null;
  const currentHistory = currentLevel === null ? [] : [
    ...history.filter((point) => point.runId === state?.runId && point.time < currentTime
      && point.time >= currentTime - 1800 && Number.isFinite(point.values[graphNodeId])),
    { runId: state!.runId!, time: currentTime, values: { [graphNodeId]: currentLevel } },
  ];
  const projectedFuture = projectionHasFuture && legacyProjection ? legacyProjection.points
    .filter((point) => point.afterSeconds > projectionOffset && point.afterSeconds - projectionOffset <= 1800)
    .filter((point, index, points) => index === points.length - 1 || index === 0
      || Math.floor((point.afterSeconds - projectionOffset) / 30) > Math.floor((points[index - 1].afterSeconds - projectionOffset) / 30))
    .map((point) => ({ afterSeconds: point.afterSeconds - projectionOffset, tmaCm: point.tmaCm })) : [];
  const prediction = forecastAvailable && currentLevel !== null
    ? selectedForecast.trajectoryCm!.slice(0, 6).map((tmaCm, index) => ({ afterSeconds: (index + 1) * 300, tmaCm }))
    : projectedFuture;
  const projectionEndsEarly = Boolean(projectionPoint && legacyProjection?.scenarioCompletes && prediction.length
    && prediction[prediction.length - 1].afterSeconds < 1800);
  const graphLevels = [...currentHistory.map((point) => point.values[graphNodeId]), ...prediction.map((point) => point.tmaCm)];
  // The reference is generated from all legacy scenarios, not a live prediction.
  const reference = (graphScale.maxTmaCmByNode as Record<string, number>)[graphNodeId];
  const graphMax = Math.max(20, Math.ceil((Math.max(Number.isFinite(reference) ? reference : 0, 0, ...graphLevels) * 1.1 - 1e-9) / 20) * 20);
  const graphY = (level: number) => 190 - (level / graphMax) * 180;
  const livePoints = currentHistory.map((point) => ({
    x: 360 - (currentTime - point.time) / 1800 * 352, y: graphY(point.values[graphNodeId]),
  }));
  const predictedPoints = prediction.length && currentLevel !== null ? [
    { x: 360, y: graphY(currentLevel) },
    ...prediction.map((point) => ({ x: 360 + point.afterSeconds * 352 / 1800, y: graphY(point.tmaCm) })),
  ] : [];

  async function request(path: string, body?: Record<string, unknown>) {
    if (!backendAvailable) {
      setError(language === 'en' ? 'Simulation backend unavailable.' : 'Backend simulasi belum terhubung.');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json();
      if (!response.ok || payload.success === false) throw new Error(payload.error || 'Permintaan simulasi gagal.');
      return payload;
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Permintaan simulasi gagal.';
      setError(message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    if (selectedMode === 'rain_replay') {
      if (!selectedEpisodeId) return;
      await request('/api/ciliwung-simulation/replay/start', { episodeId: selectedEpisodeId, speedMultiplier: selectedSpeed });
    } else {
      await request('/api/ciliwung-simulation/start', { scenario: selectedScenario, speedMultiplier: selectedSpeed });
    }
  }

  async function handleSpeedChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const nextSpeed = Number(event.target.value) as SpeedMultiplier;
    setSelectedSpeed(nextSpeed);
    if (isRunning) {
      const payload = await request('/api/ciliwung-simulation/speed', { speedMultiplier: nextSpeed });
      if (!payload) setSelectedSpeed(state?.speedMultiplier ?? 1);
    }
  }

  async function handleStop() {
    await request('/api/ciliwung-simulation/stop');
  }

  async function handleReset() {
    const payload = await request('/api/ciliwung-simulation/reset');
    if (payload) {
      setSelectedSpeed(1);
    }
  }

  async function handleExit() {
    if (isRunning) await request('/api/ciliwung-simulation/stop');
    eventSourceRef.current?.close();
    onExit();
  }

  return (
    <div className={`min-h-[calc(100vh-5rem)] ${isDark ? 'text-slate-200' : 'text-slate-700'} flex flex-col gap-6`}>
      {!backendAvailable && <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-500">{language === 'en' ? 'Simulation backend is offline. Simulation controls are unavailable.' : 'Backend simulasi belum terhubung. Kontrol simulasi belum dapat digunakan.'} <button type="button" onClick={onRetryConnection} className="ml-2 underline font-bold">{language === 'en' ? 'Retry' : 'Coba lagi'}</button></div>}
      <section className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-3 sm:p-5 lg:p-7`}>
        <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-5">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.25em] text-[#3B82F6] mb-2">
              <span className="w-2 h-2 rounded-full bg-[#3B82F6] animate-pulse" />
              Ciliwung Simulation Mode
            </div>
            <h1 className={`text-2xl lg:text-3xl font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {language === 'en' ? 'Scenario Simulation' : 'Simulasi Skenario'}
            </h1>
            <p className={`text-sm mt-2 max-w-2xl ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {language === 'en' ? 'The backend controls the 3D renderer and the nine CupCarbon nodes from one deterministic state.' : 'Backend mengontrol renderer 3D dan sembilan node CupCarbon dari satu state deterministik.'}
            </p>
          </div>
          <button type="button" onClick={handleExit} className={`px-4 py-2 rounded-xl border text-xs font-bold transition-all cursor-pointer ${isDark ? 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-300' : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'}`}>
            {language === 'en' ? 'Exit Simulation' : 'Keluar Simulation'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)] gap-5 mt-6">
          <div className="flex flex-col gap-3">
            <div className="flex gap-2 text-xs font-bold">
              <button type="button" disabled={busy || isRunning} onClick={() => setSelectedMode('legacy')} className={`rounded-lg border px-3 py-2 disabled:opacity-50 ${selectedMode === 'legacy' ? 'border-blue-500 bg-blue-500/15' : 'border-white/10'}`}>Legacy scenarios</button>
              <button type="button" disabled={busy || isRunning} onClick={() => setSelectedMode('rain_replay')} className={`rounded-lg border px-3 py-2 disabled:opacity-50 ${selectedMode === 'rain_replay' ? 'border-blue-500 bg-blue-500/15' : 'border-white/10'}`}>Synthetic replay</button>
            </div>
            {selectedMode === 'rain_replay' && (
              <div className={`rounded-xl border p-4 text-xs ${isDark ? 'border-blue-500/30 bg-blue-500/10' : 'border-blue-200 bg-blue-50'}`}>
                <strong className="block mb-2">SYNTHETIC DEMO · Rain replay</strong>
                <label className="block mb-2" htmlFor="synthetic-episode">Episode (synthetic rainfall and TMA)</label>
                <select id="synthetic-episode" aria-label="Synthetic episode" value={selectedEpisodeId} onChange={(event) => setSelectedEpisodeId(event.target.value)} disabled={busy || isRunning || episodes.length === 0} className={`w-full rounded-lg border px-3 py-2 ${isDark ? 'bg-black/40 border-white/10' : 'bg-white border-slate-200'}`}>
                  {episodes.length === 0 && <option value="">No episodes available</option>}
                  {episodes.map((episode) => <option key={episode.episodeId} value={episode.episodeId}>{episode.label || episode.name || episode.episodeId}</option>)}
                </select>
                {episodeError && <p role="alert" className="mt-2 text-rose-400">{episodeError}</p>}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.id}
                  type="button"
                  onClick={() => setSelectedScenario(scenario.id)}
                  disabled={busy || isRunning || selectedMode === 'rain_replay'}
                  className={`text-left rounded-xl border p-4 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${selectedScenario === scenario.id ? 'border-[#3B82F6] bg-[#3B82F6]/15 shadow-md' : isDark ? 'border-white/10 bg-black/20 hover:bg-white/5' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}
                >
                  <span className={`block text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>{scenario.label}</span>
                  <span className={`block text-[11px] leading-relaxed mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{scenario.description}</span>
                </button>
              ))}
            </div>
            <div className={`rounded-xl border p-4 text-xs ${isDark ? 'border-white/10 bg-black/20 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
              <strong className={isDark ? 'text-white' : 'text-slate-800'}>{selectedProfile.label}</strong> · {selectedProfile.description}
            </div>
          </div>

          <div className={`${isDark ? 'bg-black/30 border-white/10' : 'bg-slate-50 border-slate-200'} rounded-xl border p-4 flex flex-col gap-3`}>
            <div className="flex justify-between items-center text-[10px] font-mono uppercase tracking-widest">
              <span className={isDark ? 'text-slate-500' : 'text-slate-400'}>Simulation status</span>
              <span className={state?.status === 'completed' ? 'text-emerald-400' : state?.status === 'running' ? 'text-amber-400' : 'text-slate-400'}>{state?.status ?? 'idle'}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><span className="block text-[10px] text-slate-500 uppercase">Time</span><strong>{formatTime(state?.simTimeSeconds ?? 0)}</strong></div>
              <div><span className="block text-[10px] text-slate-500 uppercase">Target</span><strong>{state?.cupNodes.find((node) => node.id === state.targetNodeId)?.name ?? '—'}</strong></div>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
              <div>
                <span className="block text-[10px] text-slate-500 uppercase">Simulation speed</span>
                <span className="text-[11px] text-slate-400">Accelerates scenario time only</span>
              </div>
              <select
                aria-label="Simulation speed"
                value={isRunning ? (state?.speedMultiplier ?? selectedSpeed) : selectedSpeed}
                onChange={handleSpeedChange}
                disabled={busy}
                className={`rounded-lg border px-3 py-2 text-xs font-bold outline-none ${isDark ? 'border-white/10 bg-black/40 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
              >
                {SPEED_OPTIONS.map((speed) => <option key={speed} value={speed}>{speed}x</option>)}
              </select>
            </div>
            <div className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-slate-200 bg-white'}`}>
              <div>
                <span className="block text-[10px] text-slate-500 uppercase">CupCarbon connection</span>
                <span className="text-[11px] text-slate-400">{cupCarbonNodeCount}/9 node telemetry</span>
              </div>
              <span className={`rounded-full border px-2 py-1 text-[9px] font-bold ${cupCarbonActive ? (isDark ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700') : (isDark ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-700')}`}>
                {cupCarbonActive ? 'ACTIVE' : 'NOT VERIFIED'}
              </span>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={handleStart} disabled={!backendAvailable || busy || isRunning || (selectedMode === 'rain_replay' && !selectedEpisodeId)} className="flex-1 px-3 py-2 rounded-lg bg-[#3B82F6] hover:bg-blue-500 text-black text-xs font-bold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">{isRunning ? 'Running...' : selectedMode === 'rain_replay' ? 'Start Replay' : 'Start Simulation'}</button>
              <button type="button" onClick={handleStop} disabled={!backendAvailable || busy || !isRunning} className={`px-3 py-2 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 ${isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-100'}`}>Stop</button>
              <button type="button" onClick={handleReset} disabled={!backendAvailable || busy} className={`px-3 py-2 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 ${isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-100'}`}>Reset</button>
            </div>
          </div>
        </div>

        {error && <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 p-3 text-xs">{error}</div>}
        {state?.cupcarbon?.warning && !cupCarbonActive && <div className={`mt-4 rounded-xl border p-3 text-xs ${isDark ? 'border-amber-500/20 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>CupCarbon: {state.cupcarbon.warning}</div>}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] gap-5 items-stretch">
        <div className="min-w-0 flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label={language === 'en' ? 'Simulation viewer' : 'Tampilan simulasi'}>
        {([
          ['map2d', language === 'en' ? '2D Map' : 'Peta 2D'],
          ['map3d', language === 'en' ? '3D Map' : 'Peta 3D'],
          ['graph', language === 'en' ? 'Forecast Graph' : 'Grafik Prediksi'],
        ] as const).map(([view, label]) => (
          <button key={view} type="button" aria-pressed={activeView === view} onClick={() => setActiveView(view)} className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer ${activeView === view ? 'bg-[#3B82F6] text-black' : isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>{label}</button>
        ))}
      </div>

      {activeView === 'map2d' ? (
        <Map2D compact fillHeight simulation extraNodes={SIMULATION_UPSTREAM} fallbackLevel={null} config={{}} snapshot={state ? {
          mode: 'hardware', runId: state.runId, status: state.runId && state.status !== 'idle' ? 'running' : 'idle',
          timestampUtc: state.timestampUtc,
          hardware: { nodeId: 'N1', tmaCm: state.threeDNodes.find((node) => node.id === 'N1')?.tmaCm, freshness: state.runId && state.status !== 'idle' ? 'live' : 'stale', condition: state.scenario },
          threeDNodes: state.threeDNodes.map((node) => ({ ...node, valueType: 'simulation' as const, source: 'simulation' })),
          cupNodes: [],
        } : null} />
      ) : activeView === 'map3d' ? (
        <section className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-3 lg:p-5 flex flex-1 flex-col`}>
          <div className={`flex items-center justify-between px-2 pb-3 text-[10px] font-mono uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <span>3D Ciliwung Renderer</span>
            <span>Mode simulasi 3D</span>
          </div>
          <iframe title="Ciliwung 3D simulation" src={threeDUrl} className="w-full h-[clamp(360px,65vh,760px)] lg:h-auto lg:flex-1 min-h-[360px] rounded-xl border border-white/10 bg-black" />
        </section>
      ) : (
        <section data-testid="forecast-graph" className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-5 sm:p-7 flex flex-1 flex-col`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-blue-400">{language === 'en' ? 'WATER LEVEL FORECAST' : 'PREDIKSI TINGGI AIR'}</p>
              <h2 className={`mt-1 text-xl font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>{currentNode ? currentNode.name : (language === 'en' ? 'Waiting for node' : 'Menunggu node')}</h2>
              <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {isReplay ? (language === 'en' ? 'Synthetic replay forecast' : 'Prediksi replay sintetis') : selectedMode === 'legacy'
                  ? `${language === 'en' ? 'Legacy simulation' : 'Simulasi legacy'} · ${selectedProfile.label}`
                  : (language === 'en' ? 'Synthetic replay' : 'Replay sintetis')}
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${isDark ? 'bg-blue-500/10 text-blue-300' : 'bg-blue-50 text-blue-700'}`}>{prediction.length && Math.abs(prediction[prediction.length - 1].afterSeconds - 1800) < 0.001 ? `${language === 'en' ? 'Estimate' : 'Estimasi'} +30 ${language === 'en' ? 'min' : 'menit'} · ${prediction[prediction.length - 1].tmaCm.toFixed(1)} cm` : 'cm'}</span>
          </div>

          {graphLevels.length ? (
            <div className="mt-7 flex flex-1 flex-col justify-center" role="img" aria-label={`${language === 'en' ? 'Water level forecast' : 'Grafik prediksi tinggi air'} ${currentNode?.name ?? ''}`}>
              <div className="flex gap-3">
                <div aria-hidden="true" className="flex h-56 sm:h-72 flex-col justify-between py-2 text-right text-xs text-slate-500">
                  {[4, 3, 2, 1, 0].map((step) => <span key={step}>{graphMax * step / 4}</span>)}
                </div>
                <svg viewBox="0 0 720 200" className="min-w-0 flex-1 h-56 sm:h-72" preserveAspectRatio="none" aria-hidden="true">
                  <defs><linearGradient id="simulation-graph-area" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity=".15" /><stop offset="95%" stopColor="#3B82F6" stopOpacity="0" /></linearGradient></defs>
                  {[10, 55, 100, 145, 190].map((y) => <line key={y} x1="8" y1={y} x2="712" y2={y} stroke="currentColor" strokeDasharray="3 3" opacity=".18" />)}
                  {[8, 184, 360, 536, 712].map((x) => <line key={x} x1={x} y1="10" x2={x} y2="190" stroke="currentColor" strokeDasharray="3 3" opacity=".18" />)}
                  {currentHistory.length > 1 && <><Curve type="monotoneX" points={livePoints} baseLine={190} fill="url(#simulation-graph-area)" stroke="none" /><Curve data-testid="current-tma-trace" type="monotoneX" points={livePoints}
                    fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /></>}
                  {currentLevel !== null && <circle data-testid="current-tma-point" cx="360" cy={graphY(currentLevel)} r="4" fill="#3B82F6" />}
                  {predictedPoints.length > 0 && <Curve data-testid="forecast-tma-trace" type="monotoneX" points={predictedPoints} fill="none" stroke="#a78bfa" strokeWidth="2.5" strokeDasharray="1 7" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
                  {prediction.length > 0 && <circle cx={360 + prediction[prediction.length - 1].afterSeconds * 352 / 1800} cy={graphY(prediction[prediction.length - 1].tmaCm)} r="3" fill="#a78bfa" />}
                </svg>
              </div>
              <div className="ml-9 flex justify-between gap-2 text-xs text-slate-500"><span>−30 {language === 'en' ? 'min' : 'menit'}</span><span>{language === 'en' ? 'Now' : 'Saat ini'} · {formatTime(currentTime)}</span><span>+30 {language === 'en' ? 'min' : 'menit'}</span></div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400"><span><span className="text-blue-400">━━</span> {language === 'en' ? 'Simulation state' : 'Kondisi simulasi'}</span><span><span className="text-violet-400">┄┄</span> {language === 'en' ? 'Forecast' : 'Prediksi'}</span><span>{language === 'en' ? 'Simulation time (mm:ss)' : 'Waktu simulasi (mm:ss)'}</span></div>
            </div>
          ) : (
            <div role="status" className={`mt-6 flex min-h-56 items-center justify-center rounded-xl border text-center text-sm ${isDark ? 'border-white/10 text-slate-400' : 'border-slate-200 text-slate-500'}`}>
              {language === 'en' ? 'Start the simulation to see the graph.' : 'Mulai simulasi untuk melihat grafik.'}
            </div>
          )}
          {currentLevel !== null && prediction.length === 0 && <p role="status" className="mt-3 text-xs text-amber-500">{isReplay
            ? !isRunning ? (language === 'en' ? 'Replay is not running; forecast unavailable.' : 'Replay berhenti; prediksi tidak tersedia.')
              : selectedForecast?.reason ? `${language === 'en' ? 'Forecast unavailable' : 'Prediksi tidak tersedia'}: ${selectedForecast.reason}`
                : (language === 'en' ? 'Waiting for the current forecast…' : 'Menunggu prediksi untuk kondisi saat ini…')
            : !isRunning ? (language === 'en' ? 'Simulation is not running.' : 'Simulasi tidak berjalan.')
              : projectionError ? (language === 'en' ? 'Scenario projection unavailable.' : 'Proyeksi skenario tidak tersedia.')
                : (language === 'en' ? 'Calculating scenario projection…' : 'Menghitung proyeksi skenario…')}</p>}
          {!isReplay && prediction.length > 0 && <p className="mt-3 text-xs text-slate-500">{language === 'en' ? 'Projection from the current simulation, not an LSTM forecast.' : 'Proyeksi dari simulasi saat ini, bukan prediksi LSTM.'}{projectionEndsEarly && ` ${language === 'en' ? 'Scenario ends at' : 'Skenario selesai pada'} +${formatTime(prediction[prediction.length - 1].afterSeconds)} ${language === 'en' ? '(mm:ss); no later projection.' : '(mm:ss); tidak ada proyeksi setelahnya.'}`}</p>}
          <p className="mt-3 text-xs text-slate-500">{language === 'en' ? 'Synthetic demonstration; not validated for operational flood warnings.' : 'Demonstrasi sintetis; belum tervalidasi untuk peringatan banjir operasional.'}</p>
        </section>
      )}
        </div>
        <aside data-testid="simulation-node-levels" className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-5 flex flex-col gap-3`}>
          <div><h2 className="text-lg font-bold">{language === 'en' ? 'Water levels' : 'Tinggi Muka Air'}</h2><p className="text-xs opacity-70 mt-1">{language === 'en' ? 'Current simulation state · not sensor readings' : 'Kondisi simulasi saat ini · bukan data sensor'}</p>{activeView === 'graph' && <p className="text-xs text-blue-400 mt-2">{language === 'en' ? 'Select a node to view its forecast' : 'Pilih node untuk melihat grafik'}</p>}</div>
          <div className="grid grid-cols-1 gap-1.5 content-start">
          {(state?.cupNodes ?? []).length ? (state?.cupNodes ?? []).map(node => <button key={node.id} type="button" disabled={activeView !== 'graph'}
            aria-pressed={activeView === 'graph' ? graphNodeId === node.id : undefined}
            onClick={() => setGraphNodeId(node.id)} data-testid={`simulation-node-${node.id}`}
            className={`w-full rounded-xl border px-3 py-2 flex items-center justify-between gap-2 text-left transition-colors ${activeView === 'graph' && graphNodeId === node.id ? (isDark ? 'border-blue-400 bg-blue-500/20 ring-1 ring-blue-400/50' : 'border-blue-500 bg-blue-50 ring-1 ring-blue-400') : (isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200')} ${activeView === 'graph' ? 'cursor-pointer hover:border-blue-400/70' : 'cursor-default'}`}>
            <span className="min-w-0"><strong className="block text-xs">{node.name}</strong><span className="text-xs opacity-70">{statusLabel(node.status)}</span></span>
            <strong className="text-sm whitespace-nowrap">{Number.isFinite(node.tmaCm) ? node.tmaCm.toFixed(1) : '—'} cm</strong>
          </button>) : <p className="text-sm opacity-70">{language === 'en' ? 'Waiting for simulation data' : 'Menunggu data simulasi'}</p>}
          </div>
        </aside>
      </div>



    </div>
  );
}
