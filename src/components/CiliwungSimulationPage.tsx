import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  Map as MapIcon,
  LineChart as LineChartIcon,
  Info,
  Play,
  Square,
  RotateCcw,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  Activity,
} from 'lucide-react';
import { Map2D } from './CiliwungHardwareLiveView';
import CiliwungOfficial3DView from './CiliwungOfficial3DView';
import { runLstmForecast } from '../ml/lstmEngine';
import { unlockAlertAudio } from '../utils/alarmAudio';
import { getApiBaseUrl } from '../utils/apiBase';

type ScenarioId = 'ringan' | 'sedang' | 'lebat';
type SpeedMultiplier = 1 | 10 | 25 | 50 | 150;
type SimulationTab = 'map' | 'graph';
type MapLayer = 'map3d' | 'map2d';
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
  runId: string;
  time: number;
  values: Record<string, number>;
};

const NODE_THRESHOLDS_CM: Record<string, { siaga: number; bahaya: number | null }> = {
  UP1: { siaga: 70, bahaya: null },
  UP2: { siaga: 180, bahaya: 280 },
  UP3: { siaga: 180, bahaya: 280 },
  UP4: { siaga: 180, bahaya: 280 },
  N1: { siaga: 180, bahaya: 280 },
  N2: { siaga: 180, bahaya: 280 },
  N3: { siaga: 180, bahaya: 280 },
  N4: { siaga: 180, bahaya: 280 },
  N5: { siaga: 180, bahaya: 280 },
};

const SIMULATION_UPSTREAM = [
  { id: 'UP1', label: 'UP1 · Puncak', lat: -6.691768, lng: 106.9635388 },
  { id: 'UP2', label: 'UP2 · Katulampa', lat: -6.6336889, lng: 106.834688 },
  { id: 'UP3', label: 'UP3 · Sukaraja', lat: -6.5601124, lng: 106.809813 },
  { id: 'UP4', label: 'UP4 · Cibinong', lat: -6.4650414, lng: 106.8180795 },
];

const SCENARIOS: Array<{ id: ScenarioId; labelId: string; labelEn: string; descriptionId: string; descriptionEn: string }> = [
  {
    id: 'ringan',
    labelId: 'Hujan Ringan',
    labelEn: 'Light Rain',
    descriptionId: 'Skenario berakhir saat pos hulu Puncak (UP1) mencapai SIAGA.',
    descriptionEn: 'Scenario completes when Puncak (UP1) reaches ALERT.',
  },
  {
    id: 'sedang',
    labelId: 'Hujan Sedang',
    labelEn: 'Moderate Rain',
    descriptionId: 'Skenario berakhir saat Ciliwung Stage 2 (N3) mencapai SIAGA.',
    descriptionEn: 'Scenario completes when Stage 2 (N3) reaches ALERT.',
  },
  {
    id: 'lebat',
    labelId: 'Hujan Lebat',
    labelEn: 'Heavy Rain',
    descriptionId: 'Skenario berakhir saat Pintu Air Manggarai (N5) mencapai BANJIR.',
    descriptionEn: 'Scenario completes when Manggarai (N5) reaches FLOOD.',
  },
];

const SPEED_OPTIONS: SpeedMultiplier[] = [1, 10, 25, 50, 150];

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function statusLabel(status: CiliwungNode['status'], en = false) {
  if (status === 'BANJIR_JAKARTA') return en ? 'FLOOD' : 'BANJIR';
  if (status === 'SIAGA') return en ? 'ALERT' : 'SIAGA';
  return en ? 'SAFE' : 'AMAN';
}

function simStatusLabel(status: CiliwungState['status'] | undefined, en = false) {
  if (status === 'running') return en ? 'RUNNING' : 'BERJALAN';
  if (status === 'completed') return en ? 'COMPLETED' : 'SELESAI';
  if (status === 'stopped') return en ? 'STOPPED' : 'BERHENTI';
  return en ? 'IDLE' : 'STANDBY';
}

export default function CiliwungSimulationPage({
  theme = 'dark',
  language = 'id',
  onExit,
  onAlertStatusChange,
}: {
  theme?: 'light' | 'dark';
  language?: 'id' | 'en';
  onExit: () => void;
  onAlertStatusChange?: (status: 'Normal' | 'Siaga' | 'Bahaya') => void;
}) {
  const isDark = theme === 'dark';
  const en = language === 'en';
  const [selectedMode, setSelectedMode] = useState<SimulationMode>('legacy');
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId>('ringan');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState('');
  const [episodeError, setEpisodeError] = useState<string | null>(null);
  const [selectedSpeed, setSelectedSpeed] = useState<SpeedMultiplier>(1);
  const [simTab, setSimTab] = useState<SimulationTab>('map');
  const [mapLayer, setMapLayer] = useState<MapLayer>('map3d');
  const [showScenarioDetails, setShowScenarioDetails] = useState(false);
  const [state, setState] = useState<CiliwungState | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [graphNodeId, setGraphNodeId] = useState('N1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!onAlertStatusChange) return;
    if (!state?.runId || (state.status !== 'running' && state.status !== 'completed')) {
      onAlertStatusChange('Normal');
      return;
    }
    const nodes = [
      ...(Array.isArray(state.cupNodes) ? state.cupNodes : []),
      ...(Array.isArray(state.threeDNodes) ? state.threeDNodes : []),
    ];
    const hasBahaya = nodes.some((n) => n.status === 'BANJIR_JAKARTA');
    const hasSiaga = nodes.some((n) => n.status === 'SIAGA');
    onAlertStatusChange(hasBahaya ? 'Bahaya' : hasSiaga ? 'Siaga' : 'Normal');
  }, [state, onAlertStatusChange]);

  useEffect(() => {
    return () => {
      onAlertStatusChange?.('Normal');
    };
  }, [onAlertStatusChange]);

  const apiBase = getApiBaseUrl();

  const handleSelectNode = (nodeId: string) => {
    setGraphNodeId(nodeId);
  };

  useEffect(() => {
    let active = true;
    fetch(`${apiBase}/api/ciliwung-simulation/episodes`)
      .then(async (response) => {
        if (!response.ok) throw new Error('episodes_unavailable');
        return response.json() as Promise<Episode[]>;
      })
      .then((list) => {
        if (!active || !Array.isArray(list)) return;
        setEpisodes(list);
        if (list.length > 0) setSelectedEpisodeId((cur) => cur || list[0].episodeId);
      })
      .catch(() => {
        if (active) setEpisodeError(en ? 'Failed to load synthetic episodes.' : 'Gagal memuat daftar episode sintetis.');
      });
    return () => {
      active = false;
    };
  }, [apiBase, en]);

  useEffect(() => {
    const stream = new EventSource(`${apiBase}/api/ciliwung-simulation/stream`);
    eventSourceRef.current = stream;
    const handleState = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as CiliwungState;
        setState(next);
        setError(null);
        if (next.runId && next.status !== 'idle' && Array.isArray(next.cupNodes)) {
          const point: HistoryPoint = {
            runId: next.runId,
            time: next.simTimeSeconds,
            values: Object.fromEntries(
              next.cupNodes.filter((node) => Number.isFinite(node.tmaCm)).map((node) => [node.id, node.tmaCm])
            ),
          };
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
        setError(en ? 'Invalid simulation state from backend.' : 'State simulasi dari backend tidak valid.');
      }
    };

    stream.addEventListener('state', handleState as EventListener);
    stream.onerror = () =>
      setError(en ? 'Simulation stream disconnected. Keep the backend running.' : 'Stream simulasi terputus. Pastikan backend Website tetap berjalan.');

    return () => {
      stream.close();
      eventSourceRef.current = null;
    };
  }, [apiBase, en]);

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
        const valid = payload.points.filter(
          (point) => point.runId === runId && Number.isFinite(point.time) && point.values && typeof point.values === 'object'
        );
        setHistory((current) => {
          const live = current.filter((point) => point.runId === runId);
          const byTime = new Map([...valid, ...live].map((point) => [point.time, point]));
          return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-120);
        });
      })
      .catch(() => {
        /* SSE continues to supply live points. */
      });
    return () => {
      active = false;
    };
  }, [apiBase, state?.runId, state?.mode, state?.status]);

  const availableNodes = state?.cupNodes ?? [];
  useEffect(() => {
    if (availableNodes.length && !availableNodes.some((node) => node.id === graphNodeId)) {
      setGraphNodeId(availableNodes[0].id);
    }
  }, [availableNodes, graphNodeId]);

  const selectedProfile = SCENARIOS.find((scenario) => scenario.id === selectedScenario) ?? SCENARIOS[0];
  const isRunning = state?.status === 'running';
  const isReplay = state?.mode === 'rain_replay' || state?.mode === 'synthetic_demo' || Boolean(state?.episodeId);

  const cupCarbonActive = state?.cupcarbon?.status === 'active';
  const cupCarbonNodeCount = state?.cupcarbon?.activeNodeCount ?? 0;
  const currentNode = availableNodes.find((node) => node.id === graphNodeId);
  const currentTime = state?.simTimeSeconds ?? 0;

  const currentLevel =
    state?.runId && state.status !== 'idle' && currentNode && Number.isFinite(currentNode.tmaCm) ? currentNode.tmaCm : null;

  const nodeThreshold = NODE_THRESHOLDS_CM[graphNodeId] ?? { siaga: 180, bahaya: 280 };

  const currentHistory = useMemo(() => {
    if (currentLevel === null || !state?.runId) return [];
    const matching = history
      .filter(
        (point) =>
          point.runId === state.runId &&
          point.time < currentTime &&
          Number.isFinite(point.values[graphNodeId])
      )
      .slice(-23);
    return [
      ...matching,
      { runId: state.runId, time: currentTime, values: { [graphNodeId]: currentLevel } },
    ];
  }, [history, state?.runId, currentTime, graphNodeId, currentLevel]);

  // Run trained model_lstm_banjir.h5 multi-horizon forecast (T+30m, T+1h, T+3h, T+6h) on selected simulation node
  const simLstmForecast = useMemo(() => {
    if (currentLevel === null) return null;
    const series = currentHistory
      .map((pt) => pt.values[graphNodeId])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (series.length === 0) return null;
    return runLstmForecast(series, {
      thresholdSiaga: nodeThreshold.siaga,
      thresholdBahaya: nodeThreshold.bahaya ?? 9999,
      maxReferenceHeight: nodeThreshold.bahaya ? nodeThreshold.bahaya + 120 : 260,
    });
  }, [currentHistory, graphNodeId, currentLevel, nodeThreshold.siaga, nodeThreshold.bahaya]);

  const localizedSimLstmStatus = simLstmForecast
    ? simLstmForecast.status === 'Bahaya'
      ? (en ? 'DANGER' : 'BAHAYA')
      : simLstmForecast.status === 'Siaga'
        ? (en ? 'ALERT' : 'SIAGA')
        : (en ? 'SAFE' : 'AMAN')
    : 'STANDBY';

  const lastHistoricalTimeLabel =
    currentHistory.length > 0 ? formatTime(currentHistory[currentHistory.length - 1].time) : undefined;

  const unifiedSimChartData = useMemo(() => {
    if (currentHistory.length === 0) return [];
    const base = currentHistory.map((pt, idx) => {
      const val = Math.round(pt.values[graphNodeId] * 10) / 10;
      return {
        time: formatTime(pt.time),
        elevasi: val as number | null,
        prediksi: idx === currentHistory.length - 1 ? val : (null as number | null),
      };
    });
    if (!simLstmForecast) return base;
    return [
      ...base,
      { time: 'T+30m', elevasi: null, prediksi: simLstmForecast.prediction_30m },
      { time: en ? 'T+1h' : 'T+1j', elevasi: null, prediksi: simLstmForecast.prediction_1h },
      { time: en ? 'T+3h' : 'T+3j', elevasi: null, prediksi: simLstmForecast.prediction_3h },
      { time: en ? 'T+6h' : 'T+6j', elevasi: null, prediksi: simLstmForecast.prediction_6h },
    ];
  }, [currentHistory, graphNodeId, simLstmForecast, en]);

  const simAxisMax = useMemo(() => {
    const values = unifiedSimChartData.flatMap((d) => [
      typeof d.elevasi === 'number' ? d.elevasi : 0,
      typeof d.prediksi === 'number' ? d.prediksi : 0,
    ]);
    const thresholdCeiling = nodeThreshold.bahaya ? nodeThreshold.bahaya + 30 : nodeThreshold.siaga + 70;
    const peak = Math.max(thresholdCeiling, ...values.map((v) => v + 20));
    return Math.ceil(peak / 20) * 20;
  }, [unifiedSimChartData, nodeThreshold.siaga, nodeThreshold.bahaya]);

  const themeBorder = isDark ? 'border-white/5' : 'border-slate-200';
  const themeTextMuted = isDark ? 'text-zinc-500' : 'text-slate-400';
  const themeGridColor = isDark ? '#18181B' : '#e2e8f0';

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
      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || (en ? 'Simulation request failed.' : 'Permintaan simulasi gagal.'));
      }
      return payload;
    } catch (requestError) {
      const message = requestError instanceof Error
        ? requestError.message
        : (en ? 'Simulation request failed.' : 'Permintaan simulasi gagal.');
      setError(message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    unlockAlertAudio();
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
    if (payload) setSelectedSpeed(1);
  }

  async function handleExit() {
    if (isRunning) await request('/api/ciliwung-simulation/stop');
    eventSourceRef.current?.close();
    onExit();
  }

  const map2dSnapshot = useMemo(
    () =>
      state
        ? {
            mode: 'hardware' as const,
            runId: state.runId,
            status: (state.runId && state.status !== 'idle' ? 'running' : 'idle') as 'idle' | 'running',
            timestampUtc: state.timestampUtc,
            hardware: {
              nodeId: 'N1' as const,
              tmaCm: state.threeDNodes.find((node) => node.id === 'N1')?.tmaCm,
              freshness: (state.runId && state.status !== 'idle' ? 'live' : 'stale') as 'live' | 'stale',
              condition: (state.scenario === 'ringan' || state.scenario === 'sedang' || state.scenario === 'lebat'
                ? state.scenario
                : 'sedang') as 'ringan' | 'sedang' | 'lebat',
            },
            threeDNodes: state.threeDNodes.map((node) => ({
              ...node,
              valueType: 'simulation' as const,
              source: 'simulation',
            })),
            cupNodes: [],
          }
        : null,
    [state]
  );

  return (
    <div id="simulation-page-root" className={`${isDark ? 'text-slate-200' : 'text-slate-700'} flex flex-col gap-4 pb-6`}>
      {/* COMPACT SCENARIO & RUNTIME CONTROL BAR */}
      <section
        id="simulation-control-bar"
        className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border px-4 py-3.5 sm:px-5 flex flex-col gap-3`}
      >
        {/* Top Row: Compact Title + Status Telemetry + Back Button */}
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-amber-400 animate-ping' : 'bg-[#3B82F6]'}`} />
              <h1 className={`text-sm sm:text-base font-bold truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {en ? 'Ciliwung 9-Node Simulation' : 'Simulasi 9-Node DAS Ciliwung'}
              </h1>
            </div>

            {/* Live Compact Telemetry Chips */}
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono tabular-nums">
              <span
                className={`px-2 py-0.5 rounded-md border uppercase font-bold ${
                  state?.status === 'completed'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : state?.status === 'running'
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                      : isDark
                        ? 'border-white/10 bg-white/[0.03] text-slate-400'
                        : 'border-slate-200 bg-slate-100 text-slate-600'
                }`}
              >
                {simStatusLabel(state?.status, en)} · {formatTime(state?.simTimeSeconds ?? 0)}
              </span>

              <span
                className={`px-2 py-0.5 rounded-md border ${
                  cupCarbonActive
                    ? isDark
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : isDark
                      ? 'border-white/10 bg-white/[0.03] text-slate-400'
                      : 'border-slate-200 bg-slate-50 text-slate-500'
                }`}
              >
                CupCarbon {cupCarbonNodeCount}/9 · {cupCarbonActive ? (en ? 'ACTIVE' : 'AKTIF') : 'STANDBY'}
              </span>

              {state?.targetNodeId && (
                <span className={`hidden md:inline-flex px-2 py-0.5 rounded-md border ${isDark ? 'border-white/10 bg-white/[0.03] text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                  Target: {state.cupNodes.find((node) => node.id === state.targetNodeId)?.name ?? state.targetNodeId}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowScenarioDetails((prev) => !prev)}
              aria-expanded={showScenarioDetails}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer ${
                showScenarioDetails
                  ? 'border-[#3B82F6]/40 bg-[#3B82F6]/10 text-[#3B82F6]'
                  : isDark
                    ? 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-300'
                    : 'border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700'
              }`}
              title={en ? 'Toggle scenario explanation' : 'Tampilkan atau sembunyikan detail skenario'}
            >
              <Info className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{en ? 'Details' : 'Detail'}</span>
              {showScenarioDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>

            <button
              type="button"
              onClick={handleExit}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold transition-all cursor-pointer ${
                isDark
                  ? 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-300'
                  : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
              }`}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{en ? 'Live Hardware' : 'Hardware Live'}</span>
            </button>
          </div>
        </div>

        {/* Second Row: Inline Controls (Mode + Scenario/Episode + Speed + Run Controls) */}
        <div className={`pt-2.5 border-t ${isDark ? 'border-white/5' : 'border-slate-100'} flex flex-col xl:flex-row xl:items-center justify-between gap-2.5`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-wrap min-w-0">
            {/* Mode Switch */}
            <div
              className={`grid grid-cols-2 sm:inline-flex p-0.5 rounded-lg border text-[11px] font-bold ${
                isDark ? 'border-white/10 bg-black/40' : 'border-slate-200 bg-slate-100'
              }`}
            >
              <button
                type="button"
                disabled={busy || isRunning}
                onClick={() => setSelectedMode('legacy')}
                className={`px-2.5 py-1.5 rounded-md transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap ${
                  selectedMode === 'legacy'
                    ? 'bg-[#3B82F6] text-black shadow-sm'
                    : isDark
                      ? 'text-slate-400 hover:text-white'
                      : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {en ? 'Routing' : 'Skenario'}
              </button>
              <button
                type="button"
                disabled={busy || isRunning}
                onClick={() => setSelectedMode('rain_replay')}
                className={`px-2.5 py-1.5 rounded-md transition-all disabled:opacity-50 cursor-pointer whitespace-nowrap ${
                  selectedMode === 'rain_replay'
                    ? 'bg-[#3B82F6] text-black shadow-sm'
                    : isDark
                      ? 'text-slate-400 hover:text-white'
                      : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {en ? 'Replay 24h' : 'Replay 24J'}
              </button>
            </div>

            {/* Scenario Pills OR Synthetic Replay Episode Selector */}
            {selectedMode === 'legacy' ? (
              <div
                className={`grid grid-cols-3 sm:inline-flex p-0.5 rounded-lg border text-[11px] font-bold ${
                  isDark ? 'border-white/10 bg-black/40' : 'border-slate-200 bg-slate-100'
                }`}
                role="group"
                aria-label={en ? 'Rainfall scenario' : 'Pilihan skenario hujan'}
              >
                {SCENARIOS.map((scenario) => (
                  <button
                    key={scenario.id}
                    type="button"
                    onClick={() => setSelectedScenario(scenario.id)}
                    disabled={busy || isRunning}
                    title={en ? scenario.descriptionEn : scenario.descriptionId}
                    className={`px-2 sm:px-3 py-1.5 rounded-md text-[10.5px] sm:text-[11px] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${
                      selectedScenario === scenario.id
                        ? isDark
                          ? 'bg-white/15 text-white border border-[#3B82F6]/60'
                          : 'bg-white text-slate-900 border border-[#3B82F6]/60 shadow-sm'
                        : isDark
                          ? 'text-slate-400 hover:text-slate-200'
                          : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {en ? scenario.labelEn : scenario.labelId}
                  </button>
                ))}
              </div>
            ) : (
              <select
                id="synthetic-episode"
                aria-label="Synthetic episode"
                value={selectedEpisodeId}
                onChange={(event) => setSelectedEpisodeId(event.target.value)}
                disabled={busy || isRunning || episodes.length === 0}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium min-w-[200px] sm:max-w-xs outline-none ${
                  isDark ? 'bg-black/40 border-white/10 text-white' : 'bg-white border-slate-200 text-slate-800'
                }`}
              >
                {episodes.length === 0 && <option value="">{en ? 'No episodes available' : 'Tidak ada episode tersedia'}</option>}
                {episodes.map((episode) => (
                  <option key={episode.episodeId} value={episode.episodeId}>
                    {episode.label || episode.name || episode.episodeId}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Right Runtime Action Group: Speed + Start / Stop / Reset */}
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className={`text-[10px] font-mono uppercase ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                {en ? 'Speed' : 'Kecepatan'}
              </span>
              <select
                aria-label="Simulation speed"
                value={isRunning ? state?.speedMultiplier ?? selectedSpeed : selectedSpeed}
                onChange={handleSpeedChange}
                disabled={busy}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-mono font-bold outline-none ${
                  isDark ? 'border-white/10 bg-black/40 text-white' : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                {SPEED_OPTIONS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}x
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5 flex-1 sm:flex-initial">
              <button
                type="button"
                onClick={handleStart}
                disabled={busy || isRunning || (selectedMode === 'rain_replay' && !selectedEpisodeId)}
                className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#3B82F6] hover:bg-blue-400 text-black text-xs font-bold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>
                  {isRunning
                    ? en
                      ? 'Running...'
                      : 'Berjalan...'
                    : selectedMode === 'rain_replay'
                      ? en
                        ? 'Start Replay'
                        : 'Mulai Replay'
                      : en
                        ? 'Start'
                        : 'Mulai'}
                </span>
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={busy || !isRunning}
                className={`inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 whitespace-nowrap ${
                  isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-100'
                }`}
              >
                <Square className="w-3 h-3" />
                <span>{en ? 'Stop' : 'Hentikan'}</span>
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={busy}
                className={`inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 whitespace-nowrap ${
                  isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-100'
                }`}
                title="Reset"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Reset</span>
              </button>
            </div>
          </div>
        </div>

        {/* Optional Collapsible Scenario Explanation */}
        {showScenarioDetails && (
          <div
            className={`rounded-xl border p-3.5 text-xs leading-relaxed ${
              isDark ? 'border-white/10 bg-black/30 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-600'
            }`}
          >
            <p className="mb-2">
              {en
                ? 'Deterministic propagation across 9 stations (Puncak UP1 → Manggarai N5) synchronized live across 3D visualization, 2D corridor map, and multi-horizon LSTM forecasts (T+30m, 1h, 3h, 6h).'
                : 'Propagasi hidrologi deterministik lintas 9 stasiun (Puncak UP1 → Manggarai N5) yang tersinkronisasi antara peta 3D, peta 2D, dan kurva prediksi LSTM multi-horizon (T+30m, 1 Jam, 3 Jam, 6 Jam).'}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {SCENARIOS.map((sc) => (
                <div
                  key={sc.id}
                  className={`rounded-lg border px-3 py-2 ${
                    selectedScenario === sc.id && selectedMode === 'legacy'
                      ? 'border-[#3B82F6]/50 bg-[#3B82F6]/10'
                      : isDark
                        ? 'border-white/5 bg-white/[0.02]'
                        : 'border-slate-200 bg-white'
                  }`}
                >
                  <strong className={`block text-[11px] ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    {en ? sc.labelEn : sc.labelId}
                  </strong>
                  <span className="text-[11px] opacity-80">{en ? sc.descriptionEn : sc.descriptionId}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(error || episodeError) && (
          <div
            role="alert"
            className={`rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs ${
              isDark ? 'text-rose-300' : 'text-rose-700'
            }`}
          >
            {error || episodeError}
          </div>
        )}
      </section>

      {/* 2 CLEAN TOP-LEVEL SIMULATION TABS (VISUALISASI PETA 3D/2D & GRAFIK PREDIKSI LSTM) */}
      <div
        id="simulation-subtabs"
        role="tablist"
        aria-label={en ? 'Simulation tabs' : 'Tab tampilan simulasi'}
        className={`grid grid-cols-2 gap-1.5 sm:gap-2 p-1.5 rounded-2xl border ${
          isDark ? 'bg-[#0D0D0F] border-white/10' : 'bg-white border-slate-200 shadow-sm'
        }`}
      >
        <button
          id="btn-sim-tab-map"
          type="button"
          role="tab"
          aria-selected={simTab === 'map'}
          onClick={() => setSimTab('map')}
          className={`flex items-center justify-center sm:justify-between gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            simTab === 'map'
              ? 'bg-[#3B82F6] text-black shadow-sm'
              : isDark
                ? 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
          }`}
        >
          <span className="flex items-center gap-2 min-w-0">
            <MapIcon className="w-4 h-4 shrink-0" />
            <span className="truncate">{en ? 'Map Visualization (3D / 2D)' : 'Visualisasi Peta (3D / 2D)'}</span>
          </span>
          <span
            className={`hidden md:inline-flex font-mono text-[10px] font-bold px-2 py-0.5 rounded-md uppercase shrink-0 ${
              simTab === 'map' ? 'bg-black/15 text-black' : isDark ? 'bg-white/[0.05] text-sky-400' : 'bg-slate-100 text-sky-700'
            }`}
          >
            {mapLayer === 'map3d' ? (en ? '3D Mode' : 'Mode 3D') : (en ? '2D Mode' : 'Mode 2D')}
          </span>
        </button>

        <button
          id="btn-sim-tab-graph"
          type="button"
          role="tab"
          aria-selected={simTab === 'graph'}
          onClick={() => setSimTab('graph')}
          className={`flex items-center justify-center sm:justify-between gap-2 px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            simTab === 'graph'
              ? 'bg-[#3B82F6] text-black shadow-sm'
              : isDark
                ? 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
          }`}
        >
          <span className="flex items-center gap-2 min-w-0">
            <LineChartIcon className="w-4 h-4 shrink-0" />
            <span className="truncate">{en ? 'Charts & LSTM Forecast' : 'Grafik & Prediksi LSTM'}</span>
          </span>
          <span
            className={`hidden md:inline-flex font-mono text-[10px] font-bold px-2 py-0.5 rounded-md tabular-nums shrink-0 ${
              simTab === 'graph' ? 'bg-black/15 text-black' : isDark ? 'bg-white/[0.05] text-violet-400' : 'bg-slate-100 text-violet-700'
            }`}
          >
            {simLstmForecast
              ? `${graphNodeId} · ${en ? '6h' : '6J'}: ${simLstmForecast.prediction_6h.toFixed(1)} cm`
              : currentNode
                ? `${currentNode.id} · ${Number.isFinite(currentNode.tmaCm) ? currentNode.tmaCm.toFixed(1) : '—'} cm`
                : graphNodeId}
          </span>
        </button>
      </div>

      {/* MAIN VIEWPORT-FITTED CONTENT GRID (2FR VIEWER + 1FR 9-NODE LIST) */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(270px,1fr)] gap-4 lg:gap-5 items-stretch">
        <div className="min-w-0 flex flex-col">
          {/* TAB 1: MAP VISUALIZATION (WITH INLINE 3D / 2D LAYER SWITCH) */}
          {simTab === 'map' && (
            <section
              className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-3.5 lg:p-4 flex flex-1 flex-col gap-3`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <div className="min-w-0">
                  <span className={`block text-[10px] font-mono uppercase tracking-[0.14em] font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                    {mapLayer === 'map3d'
                      ? en
                        ? 'Ciliwung 3D Flood Explorer (UP1 Puncak → Java Sea)'
                        : 'Visualisasi 3D DAS Ciliwung (UP1 Puncak → Laut Jawa)'
                      : en
                        ? 'Ciliwung 2D Corridor Map (9 Monitoring Nodes)'
                        : 'Peta Koridor 2D DAS Ciliwung (9 Stasiun Pantau)'}
                  </span>
                  <span className={`text-[10px] font-mono ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    {selectedMode === 'legacy'
                      ? (en ? selectedProfile.labelEn : selectedProfile.labelId)
                      : en
                        ? 'Synthetic Replay'
                        : 'Replay Sintetis'}{' '}
                    · {state?.runId ? `run ${state.runId.slice(0, 8)}` : (en ? 'idle' : 'standby')}
                  </span>
                </div>

                {/* Compact Inline 3D | 2D Switcher */}
                <div
                  role="group"
                  aria-label={en ? 'Map projection' : 'Tampilan peta'}
                  className={`inline-flex p-0.5 rounded-lg border text-[11px] font-mono font-bold shrink-0 ${
                    isDark ? 'border-white/10 bg-black/40' : 'border-slate-200 bg-slate-100'
                  }`}
                >
                  <button
                    type="button"
                    aria-pressed={mapLayer === 'map3d'}
                    onClick={() => setMapLayer('map3d')}
                    className={`px-3 py-1 rounded-md transition-colors cursor-pointer ${
                      mapLayer === 'map3d'
                        ? 'bg-[#3B82F6] text-black'
                        : isDark
                          ? 'text-slate-400 hover:text-white'
                          : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {en ? '3D View' : 'Peta 3D'}
                  </button>
                  <button
                    type="button"
                    aria-pressed={mapLayer === 'map2d'}
                    onClick={() => setMapLayer('map2d')}
                    className={`px-3 py-1 rounded-md transition-colors cursor-pointer ${
                      mapLayer === 'map2d'
                        ? 'bg-[#3B82F6] text-black'
                        : isDark
                          ? 'text-slate-400 hover:text-white'
                          : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {en ? '2D Map' : 'Peta 2D'}
                  </button>
                </div>
              </div>

              {mapLayer === 'map3d' ? (
                <div
                  className={`relative flex-1 w-full overflow-hidden rounded-xl border ${
                    isDark ? 'border-white/10 bg-[#101916]' : 'border-slate-200 bg-[#b9d2d5]'
                  }`}
                >
                  <CiliwungOfficial3DView
                    mode="simulation"
                    nodes={state?.threeDNodes ?? []}
                    selectedNodeId={graphNodeId}
                    onSelectNode={setGraphNodeId}
                    isLive={isRunning || state?.status === 'completed'}
                    simTimeSeconds={state?.simTimeSeconds ?? 0}
                    theme={theme}
                    language={language}
                    heightClassName="h-[clamp(400px,56vh,560px)] lg:h-full lg:min-h-[510px]"
                  />
                </div>
              ) : (
                <div className="relative flex-1 min-h-[420px] lg:min-h-[510px] flex flex-col">
                  <Map2D
                    compact
                    fillHeight
                    simulation
                    extraNodes={SIMULATION_UPSTREAM}
                    fallbackLevel={null}
                    config={{}}
                    snapshot={map2dSnapshot}
                    language={language}
                  />
                </div>
              )}
            </section>
          )}

          {/* TAB 2: UNIFIED SIMULATION TELEMETRY & TRAINED LSTM 4-HORIZON FORECAST (MATCHING DASHBOARD) */}
          {simTab === 'graph' && (
            <section
              id="simulation-lstm-panel"
              className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-4 sm:p-5 lg:p-6 flex flex-1 flex-col justify-between gap-5 overflow-hidden`}
            >
              {/* Header & Legend Row */}
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2.5">
                  <div className="min-w-0">
                    <span className={`block text-[10px] font-bold uppercase tracking-[0.2em] ${themeTextMuted} font-mono`}>
                      {en
                        ? 'Unified Simulation Curve & Trained LSTM Forecast'
                        : 'Kurva Elevasi Simulasi & Prediksi LSTM Terpadu'}
                    </span>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                      <h2 className={`text-lg sm:text-xl font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {currentNode ? `${currentNode.id} · ${currentNode.name}` : en ? 'Waiting for node' : 'Menunggu node'}
                      </h2>
                      <span className={`text-[11px] font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        {isReplay
                          ? en
                            ? 'Synthetic Replay'
                            : 'Replay Sintetis'
                          : selectedMode === 'legacy'
                            ? `${en ? 'Routing' : 'Propagasi'} · ${en ? selectedProfile.labelEn : selectedProfile.labelId}`
                            : en
                              ? 'Synthetic Replay'
                              : 'Replay Sintetis'}
                        {currentLevel !== null ? ` · ${en ? 'Now' : 'Saat ini'}: ${currentLevel.toFixed(1)} cm` : ''}
                      </span>
                    </div>
                  </div>

                  {/* Unified Legend Strip (Matching Dashboard) */}
                  <div className="flex items-center gap-3 flex-wrap pt-0.5">
                    <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                      <span className="w-2.5 h-0.5 bg-[#3B82F6] inline-block" /> {en ? 'Actual (h)' : 'Aktual (h)'}
                    </span>
                    <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                      <span className="w-3 h-0.5 border-t-2 border-dashed border-violet-400 inline-block" /> {en ? 'LSTM Forecast' : 'Prediksi LSTM'}
                    </span>
                    <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                      <span className="w-2.5 h-0.5 border-t border-dashed border-amber-500 inline-block" /> {en ? 'Alert' : 'Siaga'} ({nodeThreshold.siaga})
                    </span>
                    {nodeThreshold.bahaya !== null && (
                      <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                        <span className="w-2.5 h-0.5 border-t border-dashed border-rose-500 inline-block" /> {en ? 'Danger' : 'Bahaya'} ({nodeThreshold.bahaya})
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Interactive Recharts AreaChart (Single Source of Truth) */}
              <div className="w-full h-[270px] sm:h-[300px]">
                {unifiedSimChartData.length === 0 ? (
                  <div
                    role="status"
                    className={`w-full h-full flex flex-col items-center justify-center p-6 text-center rounded-xl border border-dashed ${
                      isDark ? 'bg-black/30 border-white/10' : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="w-11 h-11 rounded-xl bg-[#3B82F6]/10 border border-[#3B82F6]/25 flex items-center justify-center text-[#3B82F6] mb-3">
                      <Activity className="w-5 h-5" />
                    </div>
                    <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#3B82F6] mb-1.5">
                      {en ? 'Simulation Standby — Ready to Plot' : 'Simulasi Standby — Siap Memplot Kurva'}
                    </span>
                    <p className={`text-xs max-w-md mb-4 font-sans leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                      {en
                        ? 'Start the simulation to plot live hydrological propagation and multi-horizon LSTM projections (T+30m, 1h, 3h, 6h) for any of the 9 stations.'
                        : 'Mulai simulasi untuk menampilkan kurva propagasi air dan proyeksi multi-horizon LSTM (T+30m, 1 Jam, 3 Jam, 6 Jam) di seluruh 9 pos pantau.'}
                    </p>
                    <button
                      type="button"
                      onClick={handleStart}
                      disabled={busy || isRunning || (selectedMode === 'rain_replay' && !selectedEpisodeId)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#3B82F6] hover:bg-blue-400 text-black text-xs font-bold cursor-pointer disabled:opacity-50"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>{en ? 'Start Simulation Now' : 'Mulai Simulasi Sekarang'}</span>
                    </button>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%" debounce={50}>
                    <AreaChart data={unifiedSimChartData} margin={{ top: 10, right: 18, left: -16, bottom: 0 }}>
                      <defs>
                        <linearGradient id="simColorLevel" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="simColorPrediksi" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#A78BFA" stopOpacity={0.24} />
                          <stop offset="95%" stopColor="#A78BFA" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={themeGridColor} />
                      <XAxis dataKey="time" stroke="#52525B" style={{ fontSize: 10, fontFamily: 'monospace' }} />
                      <YAxis domain={[0, simAxisMax]} stroke="#52525B" style={{ fontSize: 10, fontFamily: 'monospace' }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: isDark ? '#0D0D0F' : '#ffffff',
                          borderColor: isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0',
                          borderRadius: '8px',
                        }}
                        labelStyle={{
                          color: isDark ? '#94a3b8' : '#475569',
                          fontWeight: 'bold',
                          fontSize: 10,
                          fontFamily: 'monospace',
                        }}
                        itemStyle={{ color: isDark ? '#fff' : '#0f172a', fontSize: 11 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="elevasi"
                        name={en ? 'Simulation Elevation (cm)' : 'Elevasi Simulasi (cm)'}
                        stroke="#3B82F6"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#simColorLevel)"
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                      {simLstmForecast && (
                        <Area
                          type="monotone"
                          dataKey="prediksi"
                          name={en ? 'LSTM Forecast (cm)' : 'Prediksi LSTM (cm)'}
                          stroke="#A78BFA"
                          strokeWidth={2}
                          strokeDasharray="5 4"
                          fillOpacity={1}
                          fill="url(#simColorPrediksi)"
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      )}
                      {simLstmForecast && lastHistoricalTimeLabel && (
                        <ReferenceLine
                          x={lastHistoricalTimeLabel}
                          stroke={isDark ? 'rgba(167,139,250,0.45)' : 'rgba(124,58,237,0.35)'}
                          strokeDasharray="3 3"
                          label={{
                            value: en ? 'NOW' : 'SAAT INI',
                            fill: '#A78BFA',
                            fontSize: 9,
                            position: 'insideTopRight',
                            fontFamily: 'monospace',
                          }}
                        />
                      )}
                      <ReferenceLine
                        y={nodeThreshold.siaga}
                        stroke="#f59e0b"
                        strokeDasharray="4 4"
                        strokeWidth={1.2}
                        label={{
                          value: en ? 'ALERT' : 'SIAGA',
                          fill: '#f59e0b',
                          fontSize: 8,
                          position: 'right',
                          fontFamily: 'monospace',
                        }}
                      />
                      {nodeThreshold.bahaya !== null && (
                        <ReferenceLine
                          y={nodeThreshold.bahaya}
                          stroke="#f43f5e"
                          strokeDasharray="4 4"
                          strokeWidth={1.2}
                          label={{
                            value: en ? 'DANGER' : 'BAHAYA',
                            fill: '#f43f5e',
                            fontSize: 8,
                            position: 'right',
                            fontFamily: 'monospace',
                          }}
                        />
                      )}
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Trained LSTM 4-Horizon Breakdown (T+30m, T+1h, T+3h, T+6h — Matching Dashboard) */}
              <div className={`pt-4 border-t ${themeBorder} flex flex-col gap-3.5`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-col min-w-0">
                    <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeTextMuted} font-mono`}>
                      {en ? 'Trained LSTM Multi-Horizon Projections' : 'Proyeksi Multi-Horizon LSTM (Model Terlatih)'}
                    </span>
                    <span className="font-mono text-[10px] text-[#3B82F6] mt-0.5 tabular-nums truncate">
                      {simLstmForecast
                        ? `${simLstmForecast.modelMeta.sourceFile} · ${simLstmForecast.modelMeta.architecture} · ${simLstmForecast.modelMeta.totalParams.toLocaleString(en ? 'en-US' : 'id-ID')} params · MAE ${simLstmForecast.modelMeta.maeCm} cm`
                        : en
                          ? 'model_lstm_banjir.h5 · Start simulation to compute horizons...'
                          : 'model_lstm_banjir.h5 · Mulai simulasi untuk menghitung proyeksi...'}
                    </span>
                  </div>

                  {simLstmForecast && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums">
                      <span className={themeTextMuted}>
                        {en ? 'Window' : 'Jendela'} {simLstmForecast.inputCount}/24 · {simLstmForecast.inferenceMs.toFixed(1)} ms
                      </span>
                      <span
                        className={`font-bold uppercase tracking-wider ${
                          simLstmForecast.status === 'Bahaya'
                            ? 'text-rose-400'
                            : simLstmForecast.status === 'Siaga'
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                        }`}
                      >
                        {en ? `6h Outlook: ${localizedSimLstmStatus}` : `Proyeksi 6J: ${localizedSimLstmStatus}`}
                      </span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                  {[
                    {
                      label: 'Horizon T+30m',
                      value: simLstmForecast?.prediction_30m,
                      conf: simLstmForecast?.confidence_30m,
                      accentText: 'text-[#3B82F6]',
                    },
                    {
                      label: en ? 'Horizon T+1 Hour' : 'Horizon T+1 Jam',
                      value: simLstmForecast?.prediction_1h,
                      conf: simLstmForecast?.confidence_1h,
                      accentText: 'text-[#3B82F6]',
                    },
                    {
                      label: en ? 'Horizon T+3 Hours' : 'Horizon T+3 Jam',
                      value: simLstmForecast?.prediction_3h,
                      conf: simLstmForecast?.confidence_3h,
                      accentText: 'text-violet-400',
                    },
                    {
                      label: en ? 'Horizon T+6 Hours' : 'Horizon T+6 Jam',
                      value: simLstmForecast?.prediction_6h,
                      conf: simLstmForecast?.confidence_6h,
                      accentText: 'text-amber-400',
                    },
                  ].map((card) => {
                    const delta =
                      simLstmForecast && typeof card.value === 'number'
                        ? Math.round((card.value - simLstmForecast.currentLevel) * 10) / 10
                        : null;
                    const deltaColor =
                      delta === null
                        ? themeTextMuted
                        : delta > 0.5
                          ? 'text-amber-400'
                          : delta < -0.5
                            ? 'text-emerald-400'
                            : themeTextMuted;

                    return (
                      <div
                        key={card.label}
                        className={`rounded-xl border p-3.5 flex flex-col justify-between ${
                          isDark ? 'bg-white/[0.02] border-white/[0.06]' : 'bg-slate-50/80 border-slate-200/80'
                        }`}
                      >
                        <div className={`flex justify-between items-center ${themeTextMuted} font-mono text-[9.5px] uppercase tracking-wider gap-1`}>
                          <span className="truncate">{card.label}</span>
                          <Clock className={`w-3.5 h-3.5 shrink-0 ${card.accentText}`} />
                        </div>
                        <div className="my-2 flex items-baseline justify-between gap-1.5 flex-wrap">
                          <span className={`text-2xl sm:text-[26px] font-sans font-light tracking-tight tabular-nums ${isDark ? 'text-white' : 'text-slate-900'}`}>
                            {typeof card.value === 'number' ? card.value.toFixed(1) : '--'}
                            <span className="text-[11px] font-normal text-slate-400 ml-1">cm</span>
                          </span>
                          {delta !== null && (
                            <span className={`font-mono text-[10px] tabular-nums ${deltaColor}`}>
                              {delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)} cm
                            </span>
                          )}
                        </div>
                        <div className={`text-[10px] font-mono tabular-nums flex items-center justify-between pt-2 border-t ${themeBorder}`}>
                          <span className={themeTextMuted}>{en ? 'Confidence' : 'Keyakinan'}</span>
                          <span className={`font-semibold ${card.accentText}`}>
                            {typeof card.conf === 'number' ? `${card.conf}%` : '--%'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          )}
        </div>

        {/* COMPACT 9-NODE WATER LEVEL SELECTOR SIDEBAR */}
        <aside
          data-testid="simulation-node-levels"
          className={`${isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200 shadow-sm'} rounded-2xl border p-4 flex flex-col gap-2.5`}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {en ? 'Water Levels (9 Nodes)' : 'Tinggi Muka Air (9 Node)'}
              </h2>
              <p className="text-[11px] text-blue-400 mt-0.5">
                {simTab === 'map'
                  ? en
                    ? 'Click a node to focus camera'
                    : 'Klik node untuk fokus peta'
                  : en
                    ? 'Click a node to switch forecast'
                    : 'Klik node untuk ganti grafik'}
              </p>
            </div>
            <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-md ${isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
              UP1 → N5
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-1.5 content-start">
            {(state?.cupNodes ?? []).length ? (
              (state?.cupNodes ?? []).map((node) => (
                <button
                  key={node.id}
                  type="button"
                  aria-pressed={graphNodeId === node.id}
                  onClick={() => handleSelectNode(node.id)}
                  data-testid={`simulation-node-${node.id}`}
                  className={`w-full rounded-xl border px-3 py-1.5 flex items-center justify-between gap-2 text-left transition-colors cursor-pointer ${
                    graphNodeId === node.id
                      ? isDark
                        ? 'border-blue-400 bg-blue-500/20 ring-1 ring-blue-400/50'
                        : 'border-blue-500 bg-blue-50 ring-1 ring-blue-400'
                      : isDark
                        ? 'bg-white/[0.03] border-white/10 hover:border-blue-400/50'
                        : 'bg-slate-50 border-slate-200 hover:border-blue-400/50'
                  }`}
                >
                  <span className="min-w-0">
                    <strong className={`block text-xs truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>
                      {node.id} · {node.name}
                    </strong>
                    <span
                      className={`text-[10px] font-mono font-semibold ${
                        node.status === 'BANJIR_JAKARTA'
                          ? 'text-rose-400'
                          : node.status === 'SIAGA'
                            ? 'text-amber-400'
                            : 'text-emerald-400/90'
                      }`}
                    >
                      {statusLabel(node.status, en)}
                    </span>
                  </span>
                  <strong className={`text-xs sm:text-sm font-mono tabular-nums whitespace-nowrap ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    {Number.isFinite(node.tmaCm) ? node.tmaCm.toFixed(1) : '—'} cm
                  </strong>
                </button>
              ))
            ) : (
              <p className="text-xs opacity-70 py-4 text-center">{en ? 'Waiting for simulation data' : 'Menunggu data simulasi'}</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
