import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Map2D } from './CiliwungHardwareLiveView';

type SimulationView = 'simulation' | 'graph' | 'map2d';
type ScenarioId = 'ringan' | 'sedang' | 'lebat';
type SpeedMultiplier = 1 | 10 | 25 | 50;
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

type WeatherContext = {
  source?: string;
  status: 'available' | 'unavailable';
  reason?: string;
  kind?: string;
  location?: { desa?: string; kecamatan?: string; kotkab?: string };
  weatherDesc?: string;
  issuedAt?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  acquiredAt?: string | null;
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

type HistoryPoint = {
  runId: string | null;
  time: number;
  values: Record<string, number>;
  rainRatesMmH: Record<string, number>;
};

type ScenarioPreview = {
  scenarioId: ScenarioId;
  label: string;
  nodeId: string;
  issuedAt: string;
  issueIndex: number;
  currentSyntheticTmaCm: number;
  rainfallDepthMmPerCatchment: Record<string, number>;
  predictedTmaCm: { '30': number; '60': number };
  trajectoryCm: number[];
  method: string;
  modelVersion: string;
  quality: string;
};

type ScenarioPreviewResponse = {
  nodeId: string;
  datasetVersion: string;
  quality: string;
  previews: ScenarioPreview[];
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
const SCENARIO_COLORS: Record<ScenarioId, string> = { ringan: '#38bdf8', sedang: '#f59e0b', lebat: '#fb7185' };
const SPEED_OPTIONS: SpeedMultiplier[] = [1, 10, 25, 50];

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function formatWib(instant?: string, offsetMinutes = 0) {
  const parsed = instant ? Date.parse(instant) : NaN;
  if (!Number.isFinite(parsed)) return '—';
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(parsed + offsetMinutes * 60_000));
  return `${formatted} WIB`;
}

function statusLabel(status: CiliwungNode['status']) {
  if (status === 'BANJIR_JAKARTA') return 'BANJIR';
  return status;
}

function statusClass(status: CiliwungNode['status'], isDark: boolean) {
  if (status === 'BANJIR_JAKARTA') return isDark ? 'text-rose-300 bg-rose-500/15 border-rose-500/30' : 'text-rose-700 bg-rose-50 border-rose-200';
  if (status === 'SIAGA') return isDark ? 'text-amber-300 bg-amber-500/15 border-amber-500/30' : 'text-amber-700 bg-amber-50 border-amber-200';
  return isDark ? 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' : 'text-emerald-700 bg-emerald-50 border-emerald-200';
}

export default function CiliwungSimulationPage({
  theme = 'dark',
  language = 'id',
  onExit,
}: {
  theme?: 'light' | 'dark';
  language?: 'id' | 'en';
  onExit: () => void;
}) {
  const isDark = theme === 'dark';
  const [selectedMode, setSelectedMode] = useState<SimulationMode>('legacy');
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId>('ringan');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState('');
  const [episodeError, setEpisodeError] = useState<string | null>(null);
  const [selectedSpeed, setSelectedSpeed] = useState<SpeedMultiplier>(1);
  const [activeView, setActiveView] = useState<SimulationView>('simulation');
  const [state, setState] = useState<CiliwungState | null>(null);
  const [forecasts, setForecasts] = useState<Record<string, CiliwungForecast>>({});
  const [scenarioPreviews, setScenarioPreviews] = useState<ScenarioPreviewResponse | null>(null);
  const [scenarioPreviewLoading, setScenarioPreviewLoading] = useState(false);
  const [scenarioPreviewError, setScenarioPreviewError] = useState<string | null>(null);
  const [weatherContext, setWeatherContext] = useState<WeatherContext | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [graphNodeId, setGraphNodeId] = useState('N1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastHistoryKey = useRef<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const apiBase = typeof window !== 'undefined' ? window.location.origin : '';
  const threeDUrl = useMemo(() => {
    const streamUrl = `${apiBase}/api/ciliwung-simulation/stream`;
    return `http://127.0.0.1:8765/?mode=backend&ui=20261008-backend&api=${encodeURIComponent(streamUrl)}`;
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
    let active = true;
    fetch(`${apiBase}/api/ciliwung-weather/context`)
      .then(async (response) => {
        if (!response.ok) throw new Error('weather_context_unavailable');
        const payload = await response.json() as WeatherContext;
        if (active) setWeatherContext(payload);
      })
      .catch(() => {
        if (active) setWeatherContext({ status: 'unavailable', reason: 'weather_context_unavailable' });
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
        const point: HistoryPoint = {
          runId: next.runId,
          time: next.simTimeSeconds,
          values: Object.fromEntries(next.cupNodes.map((node) => [node.id, node.tmaCm])),
          rainRatesMmH: Object.fromEntries(next.cupNodes
            .filter((node) => typeof node.rainRateMmH === 'number' && Number.isFinite(node.rainRateMmH))
            .map((node) => [node.id, node.rainRateMmH])),
        };
        setHistory((current) => {
          const key = `${next.runId}:${next.simTimeSeconds}`;
          if (next.status === 'idle') {
            lastHistoryKey.current = null;
            return [];
          }
          if (lastHistoryKey.current === key) return current;
          lastHistoryKey.current = key;
          return [...(current[0]?.runId === next.runId ? current.slice(-119) : []), point];
        });
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
        return response.json() as Promise<{ runId: string; episodeId: string | null; points: HistoryPoint[] }>;
      })
      .then((payload) => {
        if (!active || payload.runId !== runId || !Array.isArray(payload.points)) return;
        const valid = payload.points.every((point) => point.runId === runId && Number.isFinite(point.time)
          && point.values && point.rainRatesMmH);
        if (!valid) return;
        setHistory((current) => {
          const matching = current[0]?.runId === runId ? current : [];
          const byTime = new Map([...payload.points, ...matching].map((point) => [point.time, point]));
          return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-120);
        });
      })
      .catch(() => { /* Live SSE still provides history from the connection onward. */ });
    return () => { active = false; };
  }, [apiBase, state?.runId, state?.mode, state?.status]);

  useEffect(() => {
    if (selectedMode !== 'legacy' || !FORECAST_NODES.has(graphNodeId)) {
      setScenarioPreviews(null);
      setScenarioPreviewError(null);
      setScenarioPreviewLoading(false);
      return;
    }
    let active = true;
    setScenarioPreviews(null);
    setScenarioPreviewError(null);
    setScenarioPreviewLoading(true);
    fetch(`${apiBase}/api/ciliwung-simulation/scenario-previews?nodeId=${encodeURIComponent(graphNodeId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('scenario_preview_unavailable');
        return response.json() as Promise<ScenarioPreviewResponse>;
      })
      .then((payload) => {
        const expected = SCENARIOS.map((scenario) => scenario.id);
        const valid = payload?.nodeId === graphNodeId && Array.isArray(payload.previews)
          && payload.previews.length === expected.length
          && expected.every((scenarioId) => {
            const item = payload.previews.find((preview) => preview.scenarioId === scenarioId);
            return item && (!item.nodeId || item.nodeId === graphNodeId)
              && Number.isFinite(item.currentSyntheticTmaCm)
              && Number.isFinite(item.predictedTmaCm?.['30'])
              && Number.isFinite(item.predictedTmaCm?.['60'])
              && item.trajectoryCm?.length === 12 && item.trajectoryCm.every(Number.isFinite)
              && typeof item.method === 'string' && typeof item.modelVersion === 'string';
          });
        if (!valid) throw new Error('invalid_scenario_preview');
        if (active) setScenarioPreviews(payload);
      })
      .catch((previewError) => {
        if (active) setScenarioPreviewError(previewError instanceof Error ? previewError.message : 'scenario_preview_unavailable');
      })
      .finally(() => {
        if (active) setScenarioPreviewLoading(false);
      });
    return () => { active = false; };
  }, [apiBase, selectedMode, graphNodeId]);

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

  const selectedProfile = SCENARIOS.find((scenario) => scenario.id === selectedScenario) ?? SCENARIOS[0];
  const isRunning = state?.status === 'running';
  const isReplay = state?.mode === 'rain_replay' || state?.mode === 'synthetic_demo' || Boolean(state?.episodeId);
  const currentNode = state?.cupNodes.find((node) => node.id === graphNodeId);
  const candidateForecast = forecasts[graphNodeId];
  const selectedForecast = isReplay && isRunning && candidateForecast?.runId === state?.runId
    && candidateForecast.issuedAt === state?.timestampUtc ? candidateForecast : null;
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
  const alreadyFlooded = forecastAvailable && currentNode != null && Number.isFinite(selectedForecast.thresholdBanjirCm)
    && currentNode.tmaCm >= (selectedForecast.thresholdBanjirCm as number);
  const cupCarbonActive = state?.cupcarbon?.status === 'active';
  const cupCarbonNodeCount = state?.cupcarbon?.activeNodeCount ?? 0;
  const scenarioPreviewItems = selectedMode === 'legacy' && !isReplay && scenarioPreviews?.nodeId === graphNodeId
    ? scenarioPreviews.previews : [];
  const scenarioPreviewAvailable = scenarioPreviewItems.length === SCENARIOS.length;
  const previewUsesLstm = scenarioPreviewAvailable && scenarioPreviewItems.every((preview) => preview.method.startsWith('lstm_'));
  const baseline: HistoryPoint | null = state ? {
    runId: state.runId,
    time: state.simTimeSeconds,
    values: Object.fromEntries(state.cupNodes.map((node) => [node.id, node.tmaCm])),
    rainRatesMmH: Object.fromEntries(state.cupNodes
      .filter((node) => typeof node.rainRateMmH === 'number' && Number.isFinite(node.rainRateMmH))
      .map((node) => [node.id, node.rainRateMmH])),
  } : null;
  const graphHistory = history.length > 0 && history[0].runId === state?.runId ? history : baseline ? [baseline] : [];
  const previewLevels = scenarioPreviewAvailable ? scenarioPreviewItems.flatMap((preview) => [preview.currentSyntheticTmaCm, ...preview.trajectoryCm]) : [];
  const graphMax = Math.max(300, ...graphHistory.map((point) => point.values[graphNodeId] ?? 0),
    ...(forecastAvailable ? selectedForecast.trajectoryCm! : []), ...previewLevels,
    forecastAvailable && Number.isFinite(selectedForecast.thresholdBanjirCm) ? selectedForecast.thresholdBanjirCm! : 0);
  const hasProjection = forecastAvailable || scenarioPreviewAvailable;
  const pastRight = hasProjection ? 520 : 790;
  const graphX = (index: number) => graphHistory.length <= 1 ? pastRight : (index / (graphHistory.length - 1)) * (pastRight - 10) + 10;
  const graphY = (level: number) => 220 - (level / graphMax) * 200;
  const graphPoints = graphHistory.map((point, index) =>
    `${graphX(index).toFixed(1)},${graphY(point.values[graphNodeId] ?? 0).toFixed(1)}`).join(' ');
  const rainValues = graphHistory.map((point) => point.rainRatesMmH[graphNodeId]).filter(Number.isFinite);
  const rainMax = Math.max(1, ...rainValues);
  const rainSegments: string[] = [];
  let rainSegment: string[] = [];
  graphHistory.forEach((point, index) => {
    const value = point.rainRatesMmH[graphNodeId];
    if (Number.isFinite(value)) {
      // Reserve a visible lower band for the independent rainfall scale. A dry
      // 0 mm/h line must not disappear underneath the water-level x-axis.
      rainSegment.push(`${graphX(index).toFixed(1)},${(204 - (value / rainMax) * 72).toFixed(1)}`);
    } else if (rainSegment.length) {
      rainSegments.push(rainSegment.join(' '));
      rainSegment = [];
    }
  });
  if (rainSegment.length) rainSegments.push(rainSegment.join(' '));
  const projectedPoints = forecastAvailable && graphHistory.length ? [
    `${pastRight.toFixed(1)},${graphY(graphHistory[graphHistory.length - 1].values[graphNodeId] ?? 0).toFixed(1)}`,
    ...selectedForecast.trajectoryCm!.map((level, index) =>
      `${(pastRight + (index + 1) * (790 - pastRight) / 12).toFixed(1)},${graphY(level).toFixed(1)}`),
  ].join(' ') : '';
  const scenarioProjectedPoints = scenarioPreviewAvailable ? scenarioPreviewItems.map((preview) => ({
    preview,
    points: [
      `${pastRight.toFixed(1)},${graphY(preview.currentSyntheticTmaCm).toFixed(1)}`,
      ...preview.trajectoryCm.map((level, index) =>
        `${(pastRight + (index + 1) * (790 - pastRight) / 12).toFixed(1)},${graphY(level).toFixed(1)}`),
    ].join(' '),
  })) : [];

  async function request(path: string, body?: Record<string, unknown>) {
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
    lastHistoryKey.current = null;
    setHistory([]);
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
    lastHistoryKey.current = null;
    setHistory([]);
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
      <section className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-5 lg:p-7`}>
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
              <div><span className="block text-[10px] text-slate-500 uppercase">Target</span><strong>{state?.targetNodeId ?? '—'}</strong></div>
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
              <button type="button" onClick={handleStart} disabled={busy || isRunning || (selectedMode === 'rain_replay' && !selectedEpisodeId)} className="flex-1 px-3 py-2 rounded-lg bg-[#3B82F6] hover:bg-blue-500 text-black text-xs font-bold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">{isRunning ? 'Running...' : selectedMode === 'rain_replay' ? 'Start Replay' : 'Start Simulation'}</button>
              <button type="button" onClick={handleStop} disabled={busy || !isRunning} className={`px-3 py-2 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 ${isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-100'}`}>Stop</button>
              <button type="button" onClick={handleReset} disabled={busy} className={`px-3 py-2 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 ${isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-100'}`}>Reset</button>
            </div>
          </div>
        </div>

        {error && <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 p-3 text-xs">{error}</div>}
        {state?.cupcarbon?.warning && !cupCarbonActive && <div className={`mt-4 rounded-xl border p-3 text-xs ${isDark ? 'border-amber-500/20 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>CupCarbon: {state.cupcarbon.warning}</div>}
      </section>

      <div className="flex gap-2">
        <button type="button" onClick={() => setActiveView('simulation')} className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer ${activeView === 'simulation' ? 'bg-[#3B82F6] text-black' : isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>View Simulation</button>
        <button type="button" onClick={() => setActiveView('map2d')} className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer ${activeView === 'map2d' ? 'bg-[#3B82F6] text-black' : isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>View 2D Map</button>
        <button type="button" onClick={() => setActiveView('graph')} className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer ${activeView === 'graph' ? 'bg-[#3B82F6] text-black' : isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>View Graph</button>
      </div>

      <section data-testid="bmkg-weather-context" className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-5`}>
        <h2 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>Live weather context · {weatherContext?.source || 'BMKG unavailable'}</h2>
        {weatherContext?.status === 'available' ? (
          <div className="text-xs text-slate-400 mt-2 space-y-1">
            <p>{weatherContext.location?.desa || 'Area not confirmed'}{weatherContext.location?.kecamatan ? `, ${weatherContext.location.kecamatan}` : ''} · {weatherContext.weatherDesc || 'Condition not supplied'}</p>
            <p>Forecast issued {formatWib(weatherContext.issuedAt || undefined)} · valid {formatWib(weatherContext.validFrom || undefined)} to {formatWib(weatherContext.validTo || undefined)}</p>
            <p>Fetched {formatWib(weatherContext.acquiredAt || undefined)} · source {weatherContext.source} ({weatherContext.kind})</p>
          </div>
        ) : (
          <p className="text-xs text-amber-400 mt-2">Live weather context unavailable: {weatherContext?.reason || 'loading'}.</p>
        )}
        <p className="text-[11px] text-slate-500 mt-3">Forecast context, not observed 5-minute rainfall and not an LSTM input in this synthetic replay. The rain and TMA traces below are synthetic.</p>
      </section>

      <section data-testid="ciliwung-forecast" className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-5 lg:p-7`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="text-[10px] font-mono font-bold tracking-widest text-blue-400">{isReplay && isRunning ? 'SYNTHETIC DEMO · MODEL FORECAST' : selectedMode === 'legacy' ? (scenarioPreviewAvailable ? 'SYNTHETIC V2 · COUNTERFACTUAL SCENARIO ESTIMATES' : 'LEGACY MODE · NO LIVE FORECAST') : 'FORECAST OFF · NO ACTIVE REPLAY'}</span>
            <h2 className={`text-lg font-bold mt-1 ${isDark ? 'text-white' : 'text-slate-900'}`}>Separate predicted TMA · {graphNodeId}</h2>
            <p className="text-xs text-slate-400 mt-1">Current {graphNodeId}: {currentNode ? `${currentNode.tmaCm.toFixed(1)} cm · ${statusLabel(currentNode.status)}` : '—'} (state, not prediction)</p>
          </div>
          <select aria-label="Forecast node" value={graphNodeId} onChange={(event) => setGraphNodeId(event.target.value)} className={`rounded-lg border px-3 py-2 text-xs ${isDark ? 'bg-black/30 border-white/10 text-slate-200' : 'bg-white border-slate-200 text-slate-700'}`}>
            {MAIN_GRAPH_NODES.map((nodeId) => <option key={nodeId} value={nodeId}>{nodeId}</option>)}
          </select>
        </div>
        <p className="text-xs text-slate-400 mt-3">
          {isReplay ? `Episode ${state?.episodeId ?? '—'} · simulation clock · synthetic rain and TMA (not observed 5-minute BMKG data)` : 'Legacy cm/s scenario has no live LSTM forecast; counterfactual synthetic-v2 estimates are shown separately in the TMA graph.'}
        </p>
        {forecastAvailable ? (
          <>
            <div className="text-xs text-slate-400 mt-3 space-y-1">
              <p>Issued {formatWib(selectedForecast.issuedAt)} (simulation time) · Generated {formatWib(selectedForecast.generatedAt)} (wall time)</p>
              <p>Method {selectedForecast.method || '—'} · version {selectedForecast.modelVersion || '—'} · quality {selectedForecast.quality || 'experimental_synthetic_only'}</p>
              {selectedForecast.thresholdBanjirCm === null
                ? <p>No flood threshold defined for {graphNodeId}; +30/+60 levels only.</p>
                : <p>Demo flood threshold {selectedForecast.thresholdBanjirCm ?? '—'} cm · {alreadyFlooded ? 'flood threshold already reached' : 'current stage below flood threshold'}</p>}
              {selectedForecast.inputProvenance?.upstreamFeature === 'self_proxy_no_upstream_gauge'
                && <p>Upstream input: self-proxy at headwater (no upstream gauge).</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
              {([30, 60] as const).map((minutes) => {
                const key = String(minutes) as '30' | '60';
                return (
                  <div key={key} data-testid={`forecast-${key}`} className={`${isDark ? 'bg-indigo-500/10 border-indigo-500/25' : 'bg-indigo-50 border-indigo-200'} rounded-xl border p-4`}>
                    <span className="block text-xs font-bold">+{minutes} min predicted TMA</span>
                    <strong className="block text-2xl mt-2">{selectedForecast.predictedTmaCm![key].toFixed(1)} cm</strong>
                    <span className="block text-[11px] text-slate-400 mt-1">Valid {formatWib(selectedForecast.issuedAt, minutes)}</span>
                    <span className={`block text-xs font-bold mt-3 ${selectedForecast.thresholdBanjirCm === null ? 'text-slate-400' : selectedForecast.crossingWithin![key] ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {selectedForecast.thresholdBanjirCm === null ? 'Flood crossing not evaluated (no flood threshold defined)'
                        : alreadyFlooded ? 'flood threshold already reached'
                          : selectedForecast.crossingWithin![key] ? `threshold crossing within ${minutes} min` : 'threshold crossing not indicated'}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div role="status" className={`${isDark ? 'bg-amber-500/10 border-amber-500/25 text-amber-200' : 'bg-amber-50 border-amber-200 text-amber-700'} rounded-xl border p-4 mt-4 text-xs`}>
            {selectedMode === 'legacy'
              ? scenarioPreviewAvailable ? 'No live forecast is attached to the legacy cm/s state; synthetic-v2 scenario estimates are shown separately below.'
                : scenarioPreviewLoading ? 'Legacy cm/s mode has no live forecast; synthetic scenario estimates are loading below.'
                  : scenarioPreviewError ? `Legacy mode has no live forecast; synthetic scenario preview unavailable: ${scenarioPreviewError}.`
                    : 'Legacy cm/s mode has no live forecast; counterfactual estimates are separate from current state.'
              : `Forecast unavailable: ${selectedForecast?.reason || (isReplay && !FORECAST_NODES.has(graphNodeId) ? 'unmapped_station' : isReplay && isRunning ? 'awaiting forecast or insufficient history' : 'no active synthetic replay')}.`}          </div>
        )}
        <p className="text-[11px] text-slate-500 mt-4">Experimental synthetic-data forecast; not validated for operational flood warning. No calibrated probability is provided.</p>
      </section>

      {activeView === 'map2d' ? (
        <Map2D simulation extraNodes={SIMULATION_UPSTREAM} fallbackLevel={null} config={{}} snapshot={state ? {
          mode: 'hardware', runId: state.runId, status: state.runId && state.status !== 'idle' ? 'running' : 'idle',
          timestampUtc: state.timestampUtc,
          hardware: { nodeId: 'N1', tmaCm: state.threeDNodes.find((node) => node.id === 'N1')?.tmaCm, freshness: state.runId && state.status !== 'idle' ? 'live' : 'stale', condition: state.scenario },
          threeDNodes: state.threeDNodes.map((node) => ({ ...node, valueType: 'simulation' as const, source: 'simulation' })),
          cupNodes: [],
        } : null} />
      ) : activeView === 'simulation' ? (
        <section className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-3 lg:p-5`}>
          <div className={`flex items-center justify-between px-2 pb-3 text-[10px] font-mono uppercase tracking-widest ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
            <span>3D Ciliwung Renderer</span>
            <span>Backend mode · localhost:8765</span>
          </div>
          <iframe title="Ciliwung 3D simulation" src={threeDUrl} className="w-full min-h-[680px] rounded-xl border border-white/10 bg-black" />
        </section>
      ) : (
        <section className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-5 lg:p-7`}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
            <div>
              <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>{isReplay ? 'Synthetic rain replay' : selectedProfile.label} · TMA Graph</h2>
              <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Node {graphNodeId} · Simulation time {formatTime(state?.simTimeSeconds ?? 0)} · {isReplay ? `${graphHistory.length} past five-minute bins from backend replay plus live updates; not Firestore.` : `${graphHistory.length} buffered legacy state samples; this mode has no rainfall series.`}</p>
            </div>
            <select value={graphNodeId} onChange={(event) => setGraphNodeId(event.target.value)} className={`rounded-lg border px-3 py-2 text-xs ${isDark ? 'bg-black/30 border-white/10 text-slate-200' : 'bg-white border-slate-200 text-slate-700'}`}>
              {MAIN_GRAPH_NODES.map((nodeId) => <option key={nodeId} value={nodeId}>{nodeId}</option>)}
            </select>
          </div>
          <div className={`rounded-xl border p-3 ${isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex flex-wrap gap-4 mb-2 text-[11px] text-slate-400">
              {isReplay ? <span>Rain (synthetic, mm/h) · right scale 0–{rainMax.toFixed(1)}</span> : <span>Rainfall trace unavailable in legacy cm/s scenario (not assumed dry)</span>}
              <span>Current TMA (cm) · solid blue</span>
              {forecastAvailable && <span>Replay forecast · dashed indigo, +5 to +60 simulated min</span>}
              {scenarioPreviewAvailable && <span>Counterfactual synthetic-v2 scenario estimates · separate from current state</span>}
              {scenarioPreviewAvailable && scenarioPreviewItems.map((preview) => <span key={preview.scenarioId} style={{ color: SCENARIO_COLORS[preview.scenarioId] }}>{preview.label} · dashed</span>)}
              {isReplay && rainSegments.length === 0 && <span>Rain unavailable (not assumed dry)</span>}
            </div>
            <svg viewBox="0 0 800 240" className="w-full h-64" role="img" aria-label={`Grafik TMA ${graphNodeId}`}>
              {Array.from({ length: 5 }, (_, index) => {
                const y = 220 - index * 50;
                const level = Math.round(graphMax * index / 4);
                return <g key={index}>
                  <line x1="10" y1={y} x2="790" y2={y} stroke="currentColor" opacity={index === 0 ? '.3' : '.12'} />
                  <text x="7" y={y - 3} textAnchor="end" fill="currentColor" opacity=".55" fontSize="9">{level}</text>
                </g>;
              })}
              <line x1="10" y1="20" x2="10" y2="220" stroke="currentColor" opacity=".25" />
              {hasProjection && <line x1={pastRight} y1="20" x2={pastRight} y2="220" stroke="currentColor" strokeDasharray="3 5" opacity=".18" />}
              {forecastAvailable && Number.isFinite(selectedForecast.thresholdBanjirCm) && <line x1="10" y1={graphY(selectedForecast.thresholdBanjirCm!)} x2="790" y2={graphY(selectedForecast.thresholdBanjirCm!)} stroke="#f43f5e" strokeDasharray="6 5" opacity=".6" />}
              {rainSegments.map((points, index) => <polyline key={index} data-testid="synthetic-rain-trace" points={points} fill="none" stroke="#38bdf8" strokeWidth="2" strokeDasharray="3 3" />)}
              {graphPoints && <polyline data-testid="current-tma-trace" points={graphPoints} fill="none" stroke="#3B82F6" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
              {projectedPoints && <polyline data-testid="forecast-tma-trace" points={projectedPoints} fill="none" stroke="#a78bfa" strokeWidth="2.5" strokeDasharray="7 5" strokeLinejoin="round" />}
              {scenarioProjectedPoints.map(({ preview, points }) => <polyline key={preview.scenarioId}
                data-testid="scenario-preview-trace" data-scenario={preview.scenarioId} points={points} fill="none"
                stroke={SCENARIO_COLORS[preview.scenarioId]} strokeWidth={preview.scenarioId === selectedScenario ? 3 : 1.8}
                strokeDasharray={preview.scenarioId === selectedScenario ? '7 5' : '4 5'}
                strokeOpacity={preview.scenarioId === selectedScenario ? '.98' : '.62'} strokeLinejoin="round" />)}
              {graphHistory.length === 1 && graphPoints && <circle cx={pastRight} cy={graphY(graphHistory[0].values[graphNodeId] ?? 0)} r="5" fill="#3B82F6" />}
              {!graphPoints && <text x="400" y="125" textAnchor="middle" fill="currentColor" opacity=".5" fontSize="14">Menunggu state backend...</text>}
            </svg>
            <div className="flex justify-between text-[10px] text-slate-500"><span>Past state · {formatTime(graphHistory[0]?.time ?? 0)}</span><span>{forecastAvailable ? '+60 simulated min (forecast)' : scenarioPreviewAvailable ? '+60 min (synthetic scenario estimate)' : `Latest · ${formatTime(state?.simTimeSeconds ?? 0)}`}</span></div>
          </div>
          {scenarioPreviewLoading && selectedMode === 'legacy' && <p role="status" className="mt-4 text-xs text-slate-400">Calculating three synthetic rainfall scenario estimates with the selected node model…</p>}
          {scenarioPreviewError && selectedMode === 'legacy' && <p role="status" className="mt-4 text-xs text-amber-300">Scenario estimates unavailable: {scenarioPreviewError}</p>}
          {scenarioPreviewAvailable && (
            <section data-testid="scenario-lstm-estimates" className={`mt-5 rounded-xl border p-4 ${isDark ? 'border-indigo-500/25 bg-indigo-500/5' : 'border-indigo-200 bg-indigo-50/60'}`}>
              <div className="mb-3">
                <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>{previewUsesLstm ? 'LSTM scenario estimates' : 'Scenario model estimates'} · {graphNodeId}</h3>
                <p className="mt-1 text-[11px] text-slate-400">Synthetic v2 · 96 five-minute input bins · +30/+60 min estimates. Counterfactual only, separate from current legacy run and not validated for flood warning.</p>
                <p className="mt-1 text-[11px] text-slate-500">Rain totals below are synthetic input assumptions per catchment, not measured rainfall or official BMKG intensity classes. Selected profile: {selectedProfile.label}.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {scenarioPreviewItems.map((preview) => (
                  <article key={preview.scenarioId} data-testid={`scenario-estimate-${preview.scenarioId}`} className={`rounded-lg border p-3 ${preview.scenarioId === selectedScenario ? (isDark ? 'border-blue-400/60 bg-blue-500/10' : 'border-blue-400 bg-white') : (isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-white/80')}`}>
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-bold" style={{ color: SCENARIO_COLORS[preview.scenarioId] }}>{preview.label}</h4>
                      {preview.scenarioId === selectedScenario && <span className="text-[9px] uppercase tracking-wide text-blue-400">selected</span>}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-400">Rain input: {Object.entries(preview.rainfallDepthMmPerCatchment).map(([catchment, depth]) => `${catchment} ${depth} mm`).join(' · ')}</p>
                    <p className="mt-1 text-[10px] text-slate-500">Synthetic issue TMA: {preview.currentSyntheticTmaCm.toFixed(2)} cm · {preview.method} · {preview.modelVersion}</p>
                    <div className="grid grid-cols-2 gap-2 mt-3">
                      <div><span className="block text-[10px] text-slate-500">+30 min</span><strong className="text-base">{preview.predictedTmaCm['30'].toFixed(2)} cm</strong></div>
                      <div><span className="block text-[10px] text-slate-500">+60 min</span><strong className="text-base">{preview.predictedTmaCm['60'].toFixed(2)} cm</strong></div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-5">
            {(state?.threeDNodes ?? []).map((node) => (
              <div key={node.id} className={`${isDark ? 'bg-black/25 border-white/10' : 'bg-slate-50 border-slate-200'} rounded-xl border p-3`}>
                <div className="flex items-center justify-between gap-2"><strong className="text-xs">{node.id}</strong><span className={`px-2 py-0.5 rounded-full border text-[9px] font-bold ${statusClass(node.status, isDark)}`}>{statusLabel(node.status)}</span></div>
                <div className="text-lg font-bold mt-2">{node.tmaCm.toFixed(1)} <span className="text-[10px] font-normal text-slate-500">cm</span></div>
                <div className="text-[10px] text-slate-500">stage +{node.stageRiseM.toFixed(2)} m</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-5`}>
        <div className="flex items-center justify-between mb-4"><h2 className={`font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>Nine-node CupCarbon State</h2><span className="text-[10px] font-mono text-slate-500">local UDP control</span></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(state?.cupNodes ?? []).map((node) => (
            <div key={node.id} className={`${isDark ? 'bg-black/25 border-white/10' : 'bg-slate-50 border-slate-200'} rounded-xl border p-3 flex items-center justify-between gap-3`}>
              <div><strong className="block text-xs">{node.id} · {node.name}</strong><span className="text-[10px] text-slate-500">CupCarbon node {node.cupcarbonNodeId}</span></div>
              <div className="text-right"><strong className="block text-sm">{node.tmaCm.toFixed(1)} cm</strong><span className={`text-[9px] font-bold ${node.status === 'BANJIR_JAKARTA' ? 'text-rose-400' : node.status === 'SIAGA' ? 'text-amber-400' : 'text-emerald-400'}`}>{statusLabel(node.status)}</span></div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
