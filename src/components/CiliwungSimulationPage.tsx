import React, { useEffect, useMemo, useRef, useState } from 'react';

type SimulationView = 'simulation' | 'graph';
type ScenarioId = 'ringan' | 'sedang' | 'lebat';

type CiliwungNode = {
  id: string;
  name: string;
  cupcarbonNodeId: number;
  threeDNodeId: string | null;
  tmaCm: number;
  stageRiseM: number;
  status: 'AMAN' | 'SIAGA' | 'BANJIR_JAKARTA';
};

type CiliwungState = {
  runId: string | null;
  scenario: ScenarioId | null;
  status: 'idle' | 'running' | 'stopped' | 'completed';
  simTimeSeconds: number;
  targetNodeId: string | null;
  targetThresholdCm: number | null;
  cupcarbon: { status: string; warning: string };
  cupNodes: CiliwungNode[];
  threeDNodes: CiliwungNode[];
  pendingReachCount: number;
  updatedAt: number;
};

type HistoryPoint = {
  time: number;
  values: Record<string, number>;
};

const SCENARIOS: Array<{ id: ScenarioId; label: string; description: string }> = [
  { id: 'ringan', label: 'Hujan Ringan', description: 'Scenario berakhir saat Puncak mencapai SIAGA.' },
  { id: 'sedang', label: 'Hujan Sedang', description: 'Scenario berakhir saat Stage 2 mencapai SIAGA.' },
  { id: 'lebat', label: 'Hujan Lebat', description: 'Scenario berakhir saat Manggarai mencapai BANJIR_JAKARTA.' },
];

const MAIN_GRAPH_NODES = ['N1', 'N2', 'N3', 'N4', 'N5'];

function formatTime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
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
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId>('ringan');
  const [activeView, setActiveView] = useState<SimulationView>('simulation');
  const [state, setState] = useState<CiliwungState | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [graphNodeId, setGraphNodeId] = useState('N1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastHistoryTime = useRef<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const apiBase = typeof window !== 'undefined' ? window.location.origin : '';
  const threeDUrl = useMemo(() => {
    const streamUrl = `${apiBase}/api/ciliwung-simulation/stream`;
    return `http://127.0.0.1:8765/?mode=backend&ui=20261008-backend&api=${encodeURIComponent(streamUrl)}`;
  }, [apiBase]);

  useEffect(() => {
    const stream = new EventSource(`${apiBase}/api/ciliwung-simulation/stream`);
    eventSourceRef.current = stream;
    const handleState = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as CiliwungState;
        setState(next);
        if (lastHistoryTime.current !== next.simTimeSeconds) {
          lastHistoryTime.current = next.simTimeSeconds;
          setHistory((current) => [
            ...current.slice(-119),
            {
              time: next.simTimeSeconds,
              values: Object.fromEntries(next.cupNodes.map((node) => [node.id, node.tmaCm])),
            },
          ]);
        }
      } catch {
        setError('State simulasi dari backend tidak valid.');
      }
    };
    stream.addEventListener('state', handleState as EventListener);
    stream.onerror = () => setError('Stream simulasi terputus. Pastikan backend Website tetap berjalan.');
    return () => {
      stream.close();
      eventSourceRef.current = null;
    };
  }, [apiBase]);

  const selectedProfile = SCENARIOS.find((scenario) => scenario.id === selectedScenario) ?? SCENARIOS[0];
  const isRunning = state?.status === 'running';
  const graphMax = Math.max(300, ...history.map((point) => point.values[graphNodeId] ?? 0));
  const graphPoints = history.map((point, index) => {
    const x = history.length <= 1 ? 0 : (index / (history.length - 1)) * 780 + 10;
    const value = point.values[graphNodeId] ?? 0;
    const y = 220 - (value / graphMax) * 200;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

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
    const payload = await request('/api/ciliwung-simulation/start', { scenario: selectedScenario });
    if (payload) setHistory([]);
  }

  async function handleStop() {
    await request('/api/ciliwung-simulation/stop');
  }

  async function handleReset() {
    const payload = await request('/api/ciliwung-simulation/reset');
    if (payload) {
      setHistory([]);
      lastHistoryTime.current = null;
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.id}
                  type="button"
                  onClick={() => setSelectedScenario(scenario.id)}
                  disabled={busy || isRunning}
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
            <div className="flex gap-2">
              <button type="button" onClick={handleStart} disabled={busy || isRunning} className="flex-1 px-3 py-2 rounded-lg bg-[#3B82F6] hover:bg-blue-500 text-black text-xs font-bold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">{isRunning ? 'Running...' : 'Start Simulation'}</button>
              <button type="button" onClick={handleStop} disabled={busy || !isRunning} className={`px-3 py-2 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 ${isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-100'}`}>Stop</button>
              <button type="button" onClick={handleReset} disabled={busy} className={`px-3 py-2 rounded-lg border text-xs font-bold cursor-pointer disabled:opacity-50 ${isDark ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white hover:bg-slate-100'}`}>Reset</button>
            </div>
          </div>
        </div>

        {error && <div className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 p-3 text-xs">{error}</div>}
        {state?.cupcarbon?.warning && <div className={`mt-4 rounded-xl border p-3 text-xs ${isDark ? 'border-amber-500/20 bg-amber-500/10 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>CupCarbon: {state.cupcarbon.warning}</div>}
      </section>

      <div className="flex gap-2">
        <button type="button" onClick={() => setActiveView('simulation')} className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer ${activeView === 'simulation' ? 'bg-[#3B82F6] text-black' : isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>View Simulation</button>
        <button type="button" onClick={() => setActiveView('graph')} className={`px-4 py-2 rounded-xl text-xs font-bold cursor-pointer ${activeView === 'graph' ? 'bg-[#3B82F6] text-black' : isDark ? 'bg-white/5 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>View Graph</button>
      </div>

      {activeView === 'simulation' ? (
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
              <h2 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>TMA Scenario Graph</h2>
              <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Data berasal dari state backend, bukan query Firestore setiap timestep.</p>
            </div>
            <select value={graphNodeId} onChange={(event) => setGraphNodeId(event.target.value)} className={`rounded-lg border px-3 py-2 text-xs ${isDark ? 'bg-black/30 border-white/10 text-slate-200' : 'bg-white border-slate-200 text-slate-700'}`}>
              {MAIN_GRAPH_NODES.map((nodeId) => <option key={nodeId} value={nodeId}>{nodeId}</option>)}
            </select>
          </div>
          <div className={`rounded-xl border p-3 ${isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-slate-50'}`}>
            <svg viewBox="0 0 800 240" className="w-full h-64" role="img" aria-label={`Grafik TMA ${graphNodeId}`}>
              <line x1="10" y1="220" x2="790" y2="220" stroke="currentColor" opacity=".25" />
              <line x1="10" y1="20" x2="10" y2="220" stroke="currentColor" opacity=".25" />
              {graphPoints && <polyline points={graphPoints} fill="none" stroke="#3B82F6" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />}
              {!graphPoints && <text x="400" y="125" textAnchor="middle" fill="currentColor" opacity=".5" fontSize="14">Tekan Start Simulation untuk mengisi graph</text>}
            </svg>
          </div>
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
