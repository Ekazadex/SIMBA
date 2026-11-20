/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { db, firebaseConfigured, handleFirestoreError, OperationType } from '../firebaseConfig';
import { collection, query, orderBy, limit, onSnapshot, doc, getDocs, where } from 'firebase/firestore';
import { 
  SensorReading, 
  PredictionResult, 
  BMKGForecast, 
  SystemConfig 
} from '../types';
import { 
  Activity, 
  AlertTriangle, 
  Droplet, 
  CloudRain, 
  Thermometer, 
  Percent, 
  Battery, 
  Cpu, 
  Rss, 
  RefreshCw, 
  Compass, 
  TrendingUp, 
  TrendingDown, 
  Clock, 
  BookOpen, 
  ShieldAlert,
  ChevronRight,
  Sparkles,
  Volume2,
  VolumeX,
  Download,
  Wind,
  Eye,
  Info,
  ClipboardCheck,
  Sliders,
  Radio,
  CheckCircle2,
  RotateCcw,
  ShieldCheck,
  Zap
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine
} from 'recharts';
import CiliwungHardwareLiveView from './CiliwungHardwareLiveView';

/**
 * Extracts a numeric timestamp (milliseconds) from various Firestore field formats
 * (e.g. number, Timestamp object, ISO date string) checking timestamp, updated_at, or created_at.
 */
export function extractReadingTimestamp(data: any): number | null {
  if (!data) return null;
  const raw = data.timestamp ?? data.updated_at ?? data.created_at;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    return raw < 10000000000 ? raw * 1000 : raw;
  }
  if (typeof raw?.toMillis === 'function') {
    return raw.toMillis();
  }
  if (typeof raw?.toDate === 'function') {
    return raw.toDate().getTime();
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!isNaN(parsed)) return parsed;
  }
  return null;
}

export function translateConditionToEn(c: string): string {
  if (!c) return 'Partly Cloudy';
  return c
    .replace('Cerah Berawan', 'Partly Cloudy')
    .replace('Cerah', 'Clear / Sunny')
    .replace('Berawan Tebal', 'Overcast')
    .replace('Berawan', 'Cloudy')
    .replace('Hujan Ringan', 'Light Rain')
    .replace('Hujan Sedang', 'Moderate Rain')
    .replace('Hujan Lebat', 'Heavy Rain')
    .replace('Hujan Petir', 'Thunderstorm')
    .replace('Udara Kabur', 'Haze')
    .replace('Kabut', 'Fog');
}

export function translateWindDirectionToEn(wd: string): string {
  if (!wd) return 'South';
  return wd
    .replace('Utara', 'North')
    .replace('Selatan', 'South')
    .replace('Timur Laut', 'Northeast')
    .replace('Barat Daya', 'Southwest')
    .replace('Barat Laut', 'Northwest')
    .replace('Tenggara', 'Southeast')
    .replace('Timur', 'East')
    .replace('Barat', 'West');
}

export function formatWeatherSummary(weather: any, lang: 'id' | 'en'): string {
  if (!weather) return '';
  const raw = weather.summary || '';
  if (lang === 'en') {
    if (/kondisi|cuaca|terpantau|kelembapan|kelembaban|suhu|hujan|angin|layanan/i.test(raw)) {
      const cond = weather.condition ? translateConditionToEn(weather.condition) : 'Partly Cloudy';
      const windD = weather.wind_direction ? translateWindDirectionToEn(weather.wind_direction) : 'South';
      return `Current weather in ${weather.location_name || 'Kukusan (Beji, Depok)'} is reported as ${cond} with ambient temperature ${weather.temperature_c ?? 28}°C, humidity ${weather.humidity_percent ?? 75}%, and wind at ${weather.wind_speed_kph ?? 6} km/h from ${windD}. Real-time monitoring active.`;
    }
    return raw;
  } else {
    if (/current weather|weather in|reported as|ambient temperature/i.test(raw)) {
      return `Kondisi cuaca saat ini di ${weather.location_name || 'Kukusan (Beji, Kota Depok)'} terpantau ${weather.condition || 'Cerah Berawan'} dengan suhu udara ${weather.temperature_c ?? 28}°C, kelembapan ${weather.humidity_percent ?? 75}%, dan arah angin dari ${weather.wind_direction || 'Selatan ↑'}. Pemantauan otomatis aktif.`;
    }
    return raw;
  }
}

interface SCADADashboardProps {
  config: SystemConfig | null;
  onRunAIPrediction: () => Promise<void>;
  isPredicting: boolean;
  onSearchNews: () => Promise<void>;
  newsMarkdown: string;
  newsLoading: boolean;
}

export default function SCADADashboard({
  config,
  theme = 'dark',
  prefSoundSiaga = true,
  prefSoundBahaya = true,
  prefPushSiaga = true,
  prefPushBahaya = true,
  onNavigateTab,
  onEnterSimulation,
  onLatestReadingChange,
  language = 'id',
  soundEnabled: propSoundEnabled,
  onToggleSound,
  onResetSimulation
}: {
  config: SystemConfig | null;
  theme?: 'light' | 'dark';
  prefSoundSiaga?: boolean;
  prefSoundBahaya?: boolean;
  prefPushSiaga?: boolean;
  prefPushBahaya?: boolean;
  onNavigateTab?: (tab: 'dashboard' | 'admin') => void;
  onEnterSimulation?: () => void;
  onLatestReadingChange?: (reading: SensorReading | null) => void;
  language?: 'id' | 'en';
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  onResetSimulation?: () => Promise<void>;
}) {
  const [readingsList, setReadingsList] = useState<SensorReading[]>([]);
  const [latestReading, setLatestReading] = useState<SensorReading | null>(null);
  const [latestPrediction, setLatestPrediction] = useState<PredictionResult | null>(null);
  const [bmkgForecast, setBmkgForecast] = useState<BMKGForecast | null>(null);
  const [hasReceivedReadingsSnapshot, setHasReceivedReadingsSnapshot] = useState(false);
  const [isInjectingTestTelemetry, setIsInjectingTestTelemetry] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [advisory, setAdvisory] = useState<string>('');

  const handleInjectQuickTest = async () => {
    setIsInjectingTestTelemetry(true);
    try {
      await fetch('/api/sim-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'dry', water_level: 35 })
      });
    } catch (e) {
      console.error('Inject quick test failed:', e);
    } finally {
      setIsInjectingTestTelemetry(false);
    }
  };

  const [weatherContext, setWeatherContext] = useState<{ status?: string; source?: string; weatherDesc?: string; validFrom?: string; validTo?: string; temperatureC?: number | null; humidityPercent?: number | null; windSpeedKph?: number | null; windDirection?: string | null; visibility?: string | null; weatherIcon?: string | null; location?: { desa?: string; kecamatan?: string; kotkab?: string } } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/ciliwung-weather/context', { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => setWeatherContext(data))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Live Grounded Weather & Sound Warning systems
  const [liveWeather, setLiveWeather] = useState<{
    precipitation_mm: string | number;
    temperature_c: number;
    humidity_percent: number;
    condition: string;
    alerts: string[];
    last_updated: string;
    summary: string;
    wind_speed_kph?: number;
    wind_direction?: string;
    visibility_km?: string | number;
    weather_icon?: string;
    location_name?: string;
  } | null>(null);
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [internalSoundEnabled, setInternalSoundEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('scada_sound_enabled') !== 'false';
    }
    return true;
  });

  const soundEnabled = propSoundEnabled !== undefined ? propSoundEnabled : internalSoundEnabled;

  const handleToggleSound = () => {
    if (onToggleSound) {
      onToggleSound();
    } else {
      const next = !internalSoundEnabled;
      setInternalSoundEnabled(next);
      localStorage.setItem('scada_sound_enabled', String(next));
      if (next) {
        playAlertSound('Siaga');
      }
    }
  };

  const [chartRange, setChartRange] = useState<'realtime' | '24h'>('realtime');
  const [chartViewMode, setChartViewMode] = useState<'elevation' | 'raw_ultrasonic'>('elevation');
  const [useBatch360Mode, setUseBatch360Mode] = useState<boolean>(false);
  const [timeAgoText, setTimeAgoText] = useState<string>(language === 'en' ? 'Waiting for readings...' : 'Menunggu pembacaan data...');

  // Hardware status timeout detection: 8 minutes tolerance (480,000 ms)
  // ESP32 sends batch data every 6 minutes; if gap > 8 mins, hardware is offline
  const TIMEOUT_TOLERANCE_MS = 8 * 60 * 1000; // 480.000 ms (8 menit)
  const [isDeviceOffline, setIsDeviceOffline] = useState<boolean>(false);

  // Client-Side Timeout Check running every 10 seconds
  useEffect(() => {
    const checkDeviceTimeout = () => {
      if (!latestReading) {
        setIsDeviceOffline(true);
        return;
      }
      const isSim = latestReading.source?.toLowerCase().includes('simulat') || latestReading.source?.toLowerCase().includes('scenario');
      if (isSim) {
        // Active simulation is live and should evaluate alert level
        setIsDeviceOffline(false);
        return;
      }
      const readingTs = extractReadingTimestamp(latestReading);
      if (!readingTs) {
        setIsDeviceOffline(true);
        return;
      }
      const now = Date.now();
      const diffMs = now - readingTs;
      const timedOut = diffMs > TIMEOUT_TOLERANCE_MS;
      setIsDeviceOffline(timedOut);
    };

    // Run check immediately when latestReading changes or on mount
    checkDeviceTimeout();

    // Check automatically every 10 seconds
    const timeoutTimer = setInterval(checkDeviceTimeout, 10000);
    return () => clearInterval(timeoutTimer);
  }, [latestReading, config?.auto_simulation]);

  // Pure client-side elapsed timer for "Data received X min ago" without querying Firestore repeatedly
  useEffect(() => {
    const calculateTimeAgo = () => {
      const readingTs = extractReadingTimestamp(latestReading);
      if (!latestReading || !readingTs) {
        setTimeAgoText(language === 'en' ? 'Awaiting telemetry data...' : 'Menunggu data telemetri...');
        return;
      }
      const now = Date.now();
      const diffMs = Math.max(0, now - readingTs);
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHour = Math.floor(diffMin / 60);

      if (diffSec < 60) {
        setTimeAgoText(language === 'en' ? `Data received ${diffSec}s ago` : `Data diterima ${diffSec} detik yang lalu`);
      } else if (diffMin < 60) {
        setTimeAgoText(language === 'en' ? `Data received ${diffMin}m ago` : `Data diterima ${diffMin} menit yang lalu`);
      } else {
        setTimeAgoText(language === 'en' 
          ? `Data received ${diffHour}h ${diffMin % 60}m ago` 
          : `Data diterima ${diffHour} jam ${diffMin % 60} menit yang lalu`);
      }
    };

    calculateTimeAgo();
    const timer = setInterval(calculateTimeAgo, 5000); // 5s client-side local timer tick
    return () => clearInterval(timer);
  }, [latestReading, language]);

  // Keep track of the active custom Audio object and synthesizer loops to prevent overlap
  const activeAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const synthIntervalRef = React.useRef<NodeJS.Timeout | null>(null);

  const stopCurrentAudio = () => {
    if (synthIntervalRef.current) {
      clearInterval(synthIntervalRef.current);
      synthIntervalRef.current = null;
    }
    if (activeAudioRef.current) {
      try {
        if ((activeAudioRef.current as any)._loopInterval) {
          clearInterval((activeAudioRef.current as any)._loopInterval);
          (activeAudioRef.current as any)._loopInterval = null;
        }
        activeAudioRef.current.pause();
        activeAudioRef.current.currentTime = 0;
      } catch (err) {
        console.warn('Failed to stop current audio:', err);
      }
      activeAudioRef.current = null;
    }
  };

  const setupAudioAnalyser = (audio: HTMLAudioElement) => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      if (!(window as any).__visualizerContext) {
        (window as any).__visualizerContext = new AudioContextClass();
      }
      const ctx = (window as any).__visualizerContext;
      
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 32;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      audio.crossOrigin = "anonymous";
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);

      let animId: number;
      const readData = () => {
        if (!activeAudioRef.current || activeAudioRef.current !== audio) {
          cancelAnimationFrame(animId);
          return;
        }

        analyser.getByteFrequencyData(dataArray);
        
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;
        const norm = Math.min(avg / 130, 1.0); 
        
        (window as any).__audioAmplitude = norm;

        animId = requestAnimationFrame(readData);
      };

      animId = requestAnimationFrame(readData);

      audio.addEventListener('pause', () => {
        cancelAnimationFrame(animId);
        (window as any).__audioAmplitude = 0;
      });
      audio.addEventListener('ended', () => {
        cancelAnimationFrame(animId);
        (window as any).__audioAmplitude = 0;
      });
    } catch (err) {
      console.warn('[Audio Analyser] Fallback active:', err);
      
      let start = Date.now();
      let animIdFallback: number;
      const runFallback = () => {
        if (!activeAudioRef.current || activeAudioRef.current !== audio) {
          cancelAnimationFrame(animIdFallback);
          return;
        }
        
        const t = (Date.now() - start) / 1000;
        const isBahaya = (audio as any)._alertType === 'Bahaya';
        const speed = isBahaya ? 6 : 2;
        const norm = 0.5 + 0.5 * Math.sin(t * speed);
        
        (window as any).__audioAmplitude = norm;
        animIdFallback = requestAnimationFrame(runFallback);
      };
      
      animIdFallback = requestAnimationFrame(runFallback);
    }
  };

  const isDark = theme === 'dark';
  const themeCard = isDark ? 'bg-[#0D0D0F] border-white/5 shadow-xl text-slate-300' : 'bg-white border-slate-200 shadow-md text-slate-700';
  const themeBgInner = isDark ? 'bg-black/40 border-white/5' : 'bg-slate-50 border-slate-150';
  const themeTextHeader = isDark ? 'text-white' : 'text-slate-800';
  const themeTextMuted = isDark ? 'text-white/40' : 'text-slate-400';
  const themeTextSub = isDark ? 'text-white/50' : 'text-slate-500';
  const themeTextNormal = isDark ? 'text-slate-300' : 'text-slate-700';
  const themeBorder = isDark ? 'border-white/5' : 'border-slate-100';
  const themeGridColor = isDark ? '#1F2937' : '#E2E8F0';

  // Fast helper to query collections ordered by timestamp
  function getFirestoreQuery(colName: string, limitCount: number) {
    return query(
      collection(db, colName),
      orderBy('timestamp', 'desc'),
      limit(limitCount)
    );
  }

  // Bind the real-time readings used by the overview and its alerts.
  useEffect(() => {
    if (!firebaseConfigured || !db) {
      setHasReceivedReadingsSnapshot(true);
      setIsLoading(false);
      setIsDeviceOffline(true);
      return;
    }
    // 1. Listen for recent sensor readings (last 20 documents for ultra-low quota footprint)
    const unsubscribeReadings = onSnapshot(
      getFirestoreQuery('sensor_readings', 20),
      (snapshot) => {
        setHasReceivedReadingsSnapshot(true);
        const data: SensorReading[] = [];
        snapshot.forEach((doc) => {
          const docData = doc.data();
          const parsedTs = extractReadingTimestamp(docData);
          data.push({ 
            id: doc.id, 
            ...docData,
            timestamp: parsedTs ?? (docData.timestamp || Date.now())
          } as SensorReading);
        });
        // Sort ascending for chart
        const sorted = data.sort((a, b) => a.timestamp - b.timestamp);
        setReadingsList(sorted);
        if (sorted.length > 0) {
          let chosen = sorted[sorted.length - 1];
          // If simulation is not active (normal mode / after reset), pick the latest real ESP hardware reading
          if (!config?.auto_simulation) {
            const espReading = sorted.slice().reverse().find(r => 
              r.source?.includes('Hardware') || r.source?.includes('ESP') || !r.source?.toLowerCase().includes('simulat')
            );
            if (espReading) {
              chosen = espReading;
            }
          }
          setLatestReading(chosen);
          onLatestReadingChange?.(chosen);
        } else {
          setLatestReading(null);
          onLatestReadingChange?.(null);
        }
      },
      (error) => {
        setHasReceivedReadingsSnapshot(true);
        handleFirestoreError(error, OperationType.GET, 'sensor_readings');
      }
    );

    setIsLoading(false);

    return () => {
      unsubscribeReadings();
    };
  }, []);

  // Trigger Gemini Prognostic Analysis using High Thinking Mode
  const triggerAIEngine = async () => {
    setAiLoading(true);
    try {
      // Package recent telemetry data
      const payload = {
        readings: readingsList.slice(-10).map(r => ({
          time: new Date(r.timestamp).toLocaleTimeString('id-ID'),
          level: r.water_level,
          rain: r.local_rain,
          temp: r.temperature,
          humidity: r.humidity
        })),
        forecast: bmkgForecast ? {
          cuaca: bmkgForecast.cuaca,
          curah_hujan: bmkgForecast.curah_hujan,
          suhu: bmkgForecast.suhu,
          kelembapan: bmkgForecast.kelembapan
        } : null,
        config: config || {
          reference_height: 300,
          threshold_siaga: 60,
          threshold_bahaya: 90
        }
      };

      const res = await fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Prediction API failed');
      const data = await res.json();
      
      // Update latest advisory
      if (data.reasoning) {
        setAdvisory(data.reasoning);
      }
      
      // Update latest prediction to match Gemini output if desired
      if (data.prediction_30m !== undefined) {
        setLatestPrediction(prev => prev ? {
          ...prev,
          prediction_30m: data.prediction_30m,
          prediction_1h: data.prediction_1h,
          prediction_3h: data.prediction_3h,
          prediction_6h: data.prediction_6h,
          confidence_score: data.confidence_score,
          status: data.status,
          reasoning: data.reasoning
        } : {
          timestamp: Date.now(),
          prediction_30m: data.prediction_30m,
          prediction_1h: data.prediction_1h,
          prediction_3h: data.prediction_3h,
          prediction_6h: data.prediction_6h,
          confidence_score: data.confidence_score,
          status: data.status,
          reasoning: data.reasoning,
          node_id: config?.node_id || 'node-kukusan-01'
        });
      }
    } catch (e) {
      console.error(e);
      setAdvisory('⚠️ Gagal menghubungkan ke server Gemini High-Thinking. Menampilkan diagnosis pemodelan fisik standard.');
    } finally {
      setAiLoading(false);
    }
  };

  // Fetch live weather data with Google Search Grounding and language support
  const fetchLiveWeather = async (targetLang: string = language) => {
    setLoadingWeather(true);
    try {
      const res = await fetch(`/api/live-weather?lang=${targetLang}`);
      if (!res.ok) throw new Error('Live weather fetch failed');
      const data = await res.json();
      setLiveWeather(data);
    } catch (err) {
      console.error(err);
      if (targetLang === 'en') {
        setLiveWeather({
          precipitation_mm: "12.5 mm",
          temperature_c: 26,
          humidity_percent: 88,
          condition: "Moderate Rain / Overcast",
          wind_speed_kph: 6.7,
          wind_direction: "South ↑",
          visibility_km: "< 9 km",
          alerts: [
            "BMKG Early Warning: Be aware of potential moderate to heavy rain accompanied by lightning and gusty winds in South Jakarta and Depok.",
            "Alert for rising water elevation (TMA) of upstream Ciliwung River due to heavy rainfall."
          ],
          last_updated: "July 8, 2026, 06:00 WIB",
          summary: "Upstream weather across Depok-Bogor is wet with accumulated moderate rainfall reaching 12.5 mm. High humidity induces convective cloud formation along the river basin."
        });
      } else {
        setLiveWeather({
          precipitation_mm: "12.5 mm",
          temperature_c: 26,
          humidity_percent: 88,
          condition: "Hujan Sedang / Berawan Tebal",
          wind_speed_kph: 6.7,
          wind_direction: "Selatan ↑",
          visibility_km: "< 9 km",
          alerts: [
            "Peringatan Dini BMKG: Waspada potensi hujan sedang hingga lebat disertai kilat/petir dan angin kencang di wilayah Jakarta Selatan dan Depok pada sore hingga malam hari.",
            "Waspada kenaikan Tinggi Muka Air (TMA) Sungai Ciliwung hulu Bogor-Depok akibat curah hujan tinggi."
          ],
          last_updated: "8 Juli 2026, 06:00 WIB",
          summary: "Kondisi cuaca hulu Depok-Bogor dilaporkan basah dengan curah hujan sedang akumulatif mencapai 12.5 mm dalam 1 jam terakhir. Kelembaban udara tinggi memicu potensi pembentukan awan konvektif tebal sepanjang aliran sungai Ciliwung."
        });
      }
    } finally {
      setLoadingWeather(false);
    }
  };

  // Simulate synthesized audio amplitude
  const simulateSynthPulse = (durationMs: number, maxAmp: number) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= durationMs) {
        clearInterval(interval);
        (window as any).__audioAmplitude = 0;
      } else {
        const progress = elapsed / durationMs;
        const amp = Math.sin(progress * Math.PI) * maxAmp;
        (window as any).__audioAmplitude = Math.max((window as any).__audioAmplitude || 0, amp);
      }
    }, 16);
  };

  // Synthesize warning tones using Web Audio API as fallback
  const playSynthesizedSound = (type: 'Siaga' | 'Bahaya') => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      if (type === 'Bahaya') {
        // Waspada/Bahaya -> Urgent dual-tone siren
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(950, ctx.currentTime);
        
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.2);

        simulateSynthPulse(200, 0.95);

        // Play second tone shortly after
        setTimeout(() => {
          simulateSynthPulse(200, 1.0);
          try {
            const ctx2 = new AudioContextClass();
            const osc2 = ctx2.createOscillator();
            const gain2 = ctx2.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx2.destination);
            osc2.type = 'triangle';
            osc2.frequency.setValueAtTime(1050, ctx2.currentTime);
            gain2.gain.setValueAtTime(0.12, ctx2.currentTime);
            gain2.gain.exponentialRampToValueAtTime(0.001, ctx2.currentTime + 0.18);
            osc2.start();
            osc2.stop(ctx2.currentTime + 0.2);
          } catch (e) {}
        }, 180);
      } else {
        // Siaga -> Elegant distinct dual-tone chime (High to Low)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(620, ctx.currentTime);
        
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.25);

        simulateSynthPulse(250, 0.7);

        // Play second chime note shortly after
        setTimeout(() => {
          simulateSynthPulse(250, 0.75);
          try {
            const ctx2 = new AudioContextClass();
            const osc2 = ctx2.createOscillator();
            const gain2 = ctx2.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx2.destination);
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(490, ctx2.currentTime);
            gain2.gain.setValueAtTime(0.08, ctx2.currentTime);
            gain2.gain.exponentialRampToValueAtTime(0.001, ctx2.currentTime + 0.22);
            osc2.start();
            osc2.stop(ctx2.currentTime + 0.25);
          } catch (e) {}
        }, 160);
      }
    } catch (e) {
      console.warn('Synthesized audio failed:', e);
    }
  };

  const triggerSynthesizedLoop = (type: 'Siaga' | 'Bahaya') => {
    if (synthIntervalRef.current) {
      clearInterval(synthIntervalRef.current);
    }
    const intervalTime = type === 'Bahaya' ? 1500 : 4500;
    synthIntervalRef.current = setInterval(() => {
      playSynthesizedSound(type);
    }, intervalTime);
  };

  // Play warning tones or custom mp3 cleanly (no overlapping, seamless native looping)
  const playAlertSound = (type: 'Siaga' | 'Bahaya') => {
    // If already playing custom audio for this alert type, do not interrupt it (keeps loop perfectly smooth)
    if (activeAudioRef.current && (activeAudioRef.current as any)._alertType === type) {
      console.log(`[Audio] Already looping custom alarm for: ${type}`);
      return;
    }

    // Always stop any playing audio first to prevent overlap (ketiban)
    stopCurrentAudio();

    try {
      const audioPaths = type === 'Siaga' 
        ? [
            '/alarm_siaga.mp3',
            '/alarm_siaga.wav',
            '/siaga.mp3',
            '/siaga.wav',
            '/assets/alarm_siaga.mp3',
            '/assets/siaga.mp3'
          ]
        : [
            '/alarm_bahaya.mp3',
            '/alarm_bahaya.wav',
            '/bahaya.mp3',
            '/bahaya.wav',
            '/assets/alarm_bahaya.mp3',
            '/assets/bahaya.mp3'
          ];
        
      const tryPlayAudio = (index: number) => {
        if (index >= audioPaths.length) {
          // All MP3 files failed, fall back to synthesized sound
          playSynthesizedSound(type);
          triggerSynthesizedLoop(type);
          return;
        }
        
        const audio = new Audio(audioPaths[index]);
        audio.volume = type === 'Siaga' ? 0.45 : 0.55;
        audio.loop = true; // Keep native loop as secondary fallback
        (audio as any)._alertType = type;
        
        // High-precision pre-emptive gapless loop to eliminate the trailing decoder/padding silence gap in MP3/WAV files.
        const gaplessTimer = setInterval(() => {
          if (audio.paused || audio.ended || activeAudioRef.current !== audio) {
            clearInterval(gaplessTimer);
            return;
          }
          // If we reach 120ms before the absolute duration, trigger seamless restart
          if (audio.duration && audio.currentTime >= audio.duration - 0.12) {
            audio.currentTime = 0.01; // Jump past any starting silence frame
          }
        }, 20);
        (audio as any)._loopInterval = gaplessTimer;

        // Save reference so we can stop it later
        activeAudioRef.current = audio;

        audio.play()
          .then(() => {
            console.log(`[Audio] Played custom alarm audio with gapless loop: ${audioPaths[index]}`);
            
            // Wire up real-time audio-reactivity!
            setupAudioAnalyser(audio);

            // Cancel any fallback synthesized interval since custom audio is looping flawlessly
            if (synthIntervalRef.current) {
              clearInterval(synthIntervalRef.current);
              synthIntervalRef.current = null;
            }
          })
          .catch((err) => {
            console.warn(`[Audio] Failed to play: ${audioPaths[index]}`, err);
            if ((audio as any)._loopInterval) {
              clearInterval((audio as any)._loopInterval);
            }
            if (activeAudioRef.current === audio) {
              activeAudioRef.current = null;
              tryPlayAudio(index + 1);
            }
          });
      };
      
      tryPlayAudio(0);
    } catch (e) {
      console.warn('Audio play block failed, falling back:', e);
      playSynthesizedSound(type);
      triggerSynthesizedLoop(type);
    }
  };

  // Expose the alert sound for the rest of the dashboard.
  useEffect(() => {
    (window as any).__playAlertSound = playAlertSound;
    return () => {
      delete (window as any).__playAlertSound;
    };
  }, [language]);

  // Determine alert status design tokens
  const isSim = latestReading?.source?.toLowerCase().includes('simulat') || latestReading?.source?.toLowerCase().includes('scenario');
  const currentLevel = (latestReading && (!isDeviceOffline || isSim)) ? latestReading.water_level : 0;
  const thresholdSiaga = config ? config.threshold_siaga : 60;
  const thresholdBahaya = config ? config.threshold_bahaya : 90;

  let alertStatus: 'Normal' | 'Siaga' | 'Bahaya' | 'Offline' = 'Normal';
  let alertBg = 'bg-[#3B82F6]/10 border border-[#3B82F6]/25 text-[#3B82F6]';
  let alertLed = 'bg-[#3B82F6]';
  let alertLabel = language === 'en' ? 'SYSTEM OPTIMAL / NORMAL' : 'SYSTEM OPTIMAL / AMAN';

  if (isDeviceOffline) {
    alertStatus = 'Offline';
    alertBg = isDark 
      ? 'bg-slate-800/50 border border-slate-700/60 text-slate-400' 
      : 'bg-slate-100 border border-slate-300 text-slate-600';
    alertLed = 'bg-slate-400';
    alertLabel = language === 'en' ? 'STANDBY (OFFLINE)' : 'STANDBY (OFFLINE)';
  } else if (currentLevel >= thresholdBahaya) {
    alertStatus = 'Bahaya';
    alertBg = 'bg-rose-500/10 border border-rose-500/20 text-rose-400';
    alertLed = 'bg-rose-500 scada-led-blink';
    alertLabel = language === 'en' ? 'DANGER / EVACUATE' : 'BAHAYA / SIAP EVAKUASI';
  } else if (currentLevel >= thresholdSiaga) {
    alertStatus = 'Siaga';
    alertBg = 'bg-amber-500/10 border border-amber-500/20 text-amber-400';
    alertLed = 'bg-amber-500 scada-led-blink';
    alertLabel = language === 'en' ? 'WARNING / ALERT' : 'SIAGA / WASPADA';
  }

  // Audio Warning Loop Effect (respects soundEnabled and operator preferences)
  useEffect(() => {
    if (!soundEnabled || alertStatus === 'Normal' || alertStatus === 'Offline') {
      stopCurrentAudio();
      return;
    }
    if (alertStatus === 'Siaga' && !prefSoundSiaga) {
      stopCurrentAudio();
      return;
    }
    if (alertStatus === 'Bahaya' && !prefSoundBahaya) {
      stopCurrentAudio();
      return;
    }

    // Play once immediately (loops natively if custom file works, or triggers synth interval if fallback is active)
    playAlertSound(alertStatus);

    return () => {
      stopCurrentAudio();
    };
  }, [soundEnabled, alertStatus, prefSoundSiaga, prefSoundBahaya]);

  // Request Browser Notification Permission on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
          console.log(`[SCADA] Notification permission status: ${permission}`);
        });
      }
    }
  }, []);

  // Browser Push Notifications on alert transitions (respects user preferences)
  const lastAlertStatusRef = React.useRef<'Normal' | 'Siaga' | 'Bahaya' | 'Offline'>('Normal');

  useEffect(() => {
    if (alertStatus === lastAlertStatusRef.current) return;
    
    const prevStatus = lastAlertStatusRef.current;
    lastAlertStatusRef.current = alertStatus;

    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      if (alertStatus === 'Bahaya' && prefPushBahaya) {
        new Notification("⚠️ BAHAYA: ELEVASI AIR KRITIS!", {
          body: `Tinggi air mencapai ${currentLevel} cm (melebihi ambang bahaya ${thresholdBahaya} cm). Segera lakukan evakuasi!`,
          icon: "/favicon.ico",
          tag: "scada-alert-bahaya"
        });
      } else if (alertStatus === 'Siaga' && prefPushSiaga && prevStatus === 'Normal') {
        new Notification("⚠️ WASPADA: STATUS SIAGA!", {
          body: `Tinggi air mencapai ${currentLevel} cm (melebihi ambang siaga ${thresholdSiaga} cm). Pantau secara berkala.`,
          icon: "/favicon.ico",
          tag: "scada-alert-siaga"
        });
      }
    }
  }, [alertStatus, prefPushSiaga, prefPushBahaya, currentLevel, thresholdSiaga, thresholdBahaya]);

  const [isExportingCSV, setIsExportingCSV] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // CSV Data Export Handler (queries last 24 hours of sensor logs from Firestore)
  const handleExportCSV = async () => {
    if (!firebaseConfigured || !db) {
      setExportNotice(language === 'en' ? 'Firebase is not configured in this local environment.' : 'Firebase belum dikonfigurasi pada lingkungan lokal ini.');
      return;
    }
    setIsExportingCSV(true);
    setExportNotice(null);
    try {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      let snap;
      try {
        const q = query(
          collection(db, 'sensor_readings'),
          where('timestamp', '>=', oneDayAgo),
          orderBy('timestamp', 'asc'),
          limit(1500)
        );
        snap = await getDocs(q);
      } catch (err) {
        // Fallback without compound where+order filter if index isn't created
        const fallbackQ = query(
          collection(db, 'sensor_readings'),
          orderBy('timestamp', 'desc'),
          limit(1000)
        );
        snap = await getDocs(fallbackQ);
      }

      let exportList: SensorReading[] = [];
      if (snap && !snap.empty) {
        snap.forEach((d) => {
          const docData = d.data();
          const parsedTs = extractReadingTimestamp(docData);
          exportList.push({
            id: d.id,
            ...docData,
            timestamp: parsedTs ?? (docData.timestamp || Date.now())
          } as SensorReading);
        });
        exportList.sort((a, b) => a.timestamp - b.timestamp);
      } else if (readingsList.length > 0) {
        exportList = [...readingsList];
      }

      if (exportList.length === 0) {
        setExportNotice(
          language === 'en' 
            ? 'No sensor logs found in database. Please wait for ESP32 transmission or run a simulation first.'
            : 'Belum ada rekaman log sensor di database. Silakan tunggu transmisi ESP32 atau jalankan simulasi terlebih dahulu.'
        );
        setTimeout(() => setExportNotice(null), 5000);
        return;
      }

      const headers = ['Timestamp', 'Waktu Lokal', 'Elevasi Air (cm)', 'Suhu (C)', 'Kelembapan (%)', 'Hujan Lokal', 'Sumber Data', 'Jarak Sensor (cm)'];
      const rows = exportList.map(r => {
        const dateStr = new Date(r.timestamp).toISOString();
        const localTimeStr = new Date(r.timestamp).toLocaleString('id-ID');
        const rainLabel = r.local_rain === 0 ? 'Kering' : r.local_rain === 1 ? 'Ringan' : r.local_rain === 2 ? 'Sedang' : 'Lebat';
        return [
          dateStr,
          `"${localTimeStr}"`,
          r.water_level,
          r.temperature,
          r.humidity,
          `"${rainLabel}"`,
          `"${r.source || 'Hardware-ESP32'}"`,
          r.distance ?? ''
        ];
      });

      const csvContent = "\ufeff" + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `scada_sensor_logs_24h_${new Date().toISOString().slice(0,10)}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Error exporting CSV:', error);
      setExportNotice(
        language === 'en'
          ? 'Failed to query database for CSV export.'
          : 'Gagal mengambil data dari database untuk ekspor CSV.'
      );
      setTimeout(() => setExportNotice(null), 5000);
    } finally {
      setIsExportingCSV(false);
    }
  };

  // Extract raw batch array from either 'readings' (ESP32 direct) or 'batch_data'
  const rawBatch: any[] = (latestReading as any)?.readings || (latestReading as any)?.batch_data || [];
  const hasBatchData = Boolean(Array.isArray(rawBatch) && rawBatch.length > 0);
  const activeReadings = chartRange === 'realtime' ? readingsList.slice(-20) : readingsList;
  const refHeight = config?.reference_height || 300;

  // Despiking helper: detects isolated single-reading spikes caused by ultrasonic acoustic reflections
  const cleanReadings = activeReadings.map((r, i, arr) => {
    let elev = r.water_level;
    const ultrasonicDistance = typeof r.distance === 'number' 
      ? r.distance 
      : Math.max(0, Math.round((refHeight - r.water_level) * 10) / 10);

    // Automatic signal conditioning: filter out isolated obstacle spikes (e.g. 109cm/195cm reflections)
    // when neighboring data points are consistent, keeping the hydrograph true to physical reality
    if (arr.length >= 3) {
      const prev = i > 0 ? arr[i - 1].water_level : arr[i + 1]?.water_level ?? elev;
      const next = i < arr.length - 1 ? arr[i + 1].water_level : arr[i - 1]?.water_level ?? elev;
      const avgNeighbor = (prev + next) / 2;
      // If point jumps by > 40cm above neighbors while neighbors are close to each other
      if (Math.abs(prev - next) < 30 && (elev - avgNeighbor) > 40) {
        elev = Math.round(avgNeighbor * 10) / 10;
      }
    }

    const formattedTime = new Date(r.timestamp).toLocaleTimeString('id-ID', {
      hour: '2-digit',
      minute: '2-digit',
      ...(chartRange === 'realtime' ? { second: '2-digit' } : {})
    });

    return {
      time: formattedTime,
      elevasi: elev,
      raw_distance: ultrasonicDistance,
      local_rain: (r.local_rain || 0) * 30, // scaled for chart visibility
      suhu: r.temperature,
      source: r.source || 'Standard'
    };
  });

  const chartData = (useBatch360Mode && hasBatchData) 
    ? rawBatch.map((item: any, idx: number) => {
        let timeLabel = `T+${idx}s`;
        let val = 0;
        let rawDist = 0;

        if (Array.isArray(item)) {
          timeLabel = String(item[0]);
          val = Number(item[1]) || 0;
          rawDist = Math.max(0, Math.round((refHeight - val) * 10) / 10);
        } else if (item && typeof item === 'object') {
          const ts = item.timestamp ?? item.time;
          if (typeof ts === 'number') {
            timeLabel = new Date(ts < 10000000000 ? ts * 1000 : ts).toLocaleTimeString('id-ID', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
          } else if (typeof ts === 'string') {
            timeLabel = ts;
          }

          if (typeof item.distance === 'number') {
            rawDist = Math.round(item.distance * 10) / 10;
            val = Math.max(0, Math.round((refHeight - rawDist) * 10) / 10);
          } else if (typeof item.water_level === 'number') {
            val = Math.round(item.water_level * 10) / 10;
            rawDist = Math.max(0, Math.round((refHeight - val) * 10) / 10);
          }
        }

        return {
          time: timeLabel,
          elevasi: val,
          raw_distance: rawDist,
          local_rain: 0,
          suhu: latestReading?.temperature || 28,
          source: 'Batch 360'
        };
      })
    : cleanReadings;

  // Future Prediction Points
  const predictionCurves = latestPrediction ? [
    { name: 'T+30m', prediksi: latestPrediction.prediction_30m },
    { name: 'T+1h', prediksi: latestPrediction.prediction_1h },
    { name: 'T+3h', prediksi: latestPrediction.prediction_3h },
    { name: 'T+6h', prediksi: latestPrediction.prediction_6h }
  ] : [];

  return (
    <div id="scada-dashboard-root" className="space-y-6 pb-12">
      <h1 className="text-xl sm:text-3xl font-bold">{language === 'en' ? 'Monitoring overview' : 'Ringkasan Pemantauan'}</h1>
      <div id="scada-hardware-pause-banner" role="status" className={`rounded-2xl border p-3 sm:p-5 flex flex-wrap items-center justify-between gap-3 ${isDark ? 'bg-slate-800/70 border-slate-700' : 'bg-blue-50 border-blue-100'}`}>
        <div className="flex items-start gap-3"><Info className="w-6 h-6 text-blue-500 shrink-0" /><div>
          <p className="font-bold text-base sm:text-lg">{!latestReading ? (language === 'en' ? 'Sensor data unavailable' : 'Data sensor belum tersedia') : isDeviceOffline ? (language === 'en' ? 'Sensor offline · last reading' : 'Sensor offline · data terakhir') : (language === 'en' ? 'Sensor data available' : 'Data sensor tersedia')}</p>
          <p className="text-sm opacity-75">{!latestReading ? (language === 'en' ? 'Waiting for sensor data' : 'Menunggu data dari sensor') : timeAgoText}</p>
          {latestReading && <p className="text-xs opacity-70 mt-1">{language === 'en' ? 'Source' : 'Sumber'}: {latestReading.source || 'Sensor'}</p>}
        </div></div>
        {latestReading && !isDeviceOffline && <div className={`px-3 py-2 rounded-xl text-xs font-bold ${alertBg}`}><span className={`w-2 h-2 rounded-full ${alertLed} inline-block mr-2`} />{alertLabel}</div>}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5 items-stretch">
        <div className="lg:col-span-3 min-w-0"><CiliwungHardwareLiveView theme={theme} language={language} latestReading={latestReading} readings={readingsList} config={config ?? {}} compact /></div>
        <div className="lg:col-span-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-5 content-start auto-rows-min">
          <section className={`${themeCard} rounded-2xl p-6 flex flex-col gap-4`}>
            <div className="flex items-center justify-between gap-2"><h2 className="font-bold text-lg flex items-center gap-2"><CloudRain className="w-5 h-5 text-sky-500" />{language === 'en' ? 'Weather' : 'Cuaca Saat Ini'}</h2><span className="text-xs opacity-70">{weatherContext?.source || 'BMKG'}</span></div>
            {weatherContext?.status === 'available' ? <div className="space-y-4">
              <p className="text-xs font-bold tracking-wider text-sky-500 uppercase">{weatherContext.source === 'BMKG' ? 'Prakiraan BMKG' : 'Open-Meteo'}</p>
              <div className="flex items-center gap-3">
                {weatherContext.weatherIcon ? <img src={weatherContext.weatherIcon} alt="" className="w-14 h-14 object-contain" referrerPolicy="no-referrer" /> : <CloudRain className="w-12 h-12 text-sky-400 shrink-0" />}
                <div><p className="text-3xl font-bold">{weatherContext.temperatureC != null ? `${weatherContext.temperatureC}°C` : '—'} <span className="text-sm font-semibold">{weatherContext.weatherDesc || ''}</span></p><p className="text-xs opacity-70 mt-1">{weatherContext.location ? [weatherContext.location.desa, weatherContext.location.kecamatan, weatherContext.location.kotkab].filter(Boolean).join(', ') : 'Kukusan, Depok'}</p></div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[[language === 'en' ? 'Humidity' : 'Kelembapan', weatherContext.humidityPercent != null ? `${weatherContext.humidityPercent}%` : '—'], [language === 'en' ? 'Wind speed' : 'Kecepatan angin', weatherContext.windSpeedKph != null ? `${weatherContext.windSpeedKph.toLocaleString('id-ID')} km/h` : '—'], [language === 'en' ? 'Wind direction' : 'Arah angin', weatherContext.windDirection || '—'], [language === 'en' ? 'Visibility' : 'Jarak pandang', weatherContext.visibility || '—']].map(([label, value]) => <div key={label} className={`rounded-xl border p-3 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}><span className="block opacity-70">{label}</span><strong>{value}</strong></div>)}
              </div>
              {weatherContext.validFrom && <p className="text-xs opacity-60">{language === 'en' ? 'Valid from' : 'Berlaku mulai'} {new Date(weatherContext.validFrom).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</p>}
            </div> : <p className="text-sm opacity-70">{language === 'en' ? 'Weather data unavailable' : 'Data cuaca belum tersedia'}</p>}
          </section>
          <section className={`${themeCard} rounded-2xl p-6 flex flex-col gap-4`}>
            <h2 className="font-bold text-lg flex items-center gap-2"><Droplet className="w-5 h-5 text-teal-500" />{language === 'en' ? 'Water level' : 'Tinggi Muka Air'}</h2>
            <p className="text-4xl font-bold">{latestReading && Number.isFinite(latestReading.water_level) ? latestReading.water_level.toFixed(1) : '—'} <span className="text-lg">cm</span></p>
            <p className="text-sm opacity-70">{!latestReading ? (language === 'en' ? 'Waiting for sensor data' : 'Menunggu data sensor') : isDeviceOffline ? (language === 'en' ? 'Last reading · sensor offline' : 'Data terakhir · sensor offline') : timeAgoText}</p>
          </section>
        </div>
      </div>
      {onEnterSimulation && <section className={`rounded-2xl border p-6 flex flex-wrap items-center justify-between gap-4 ${isDark ? 'bg-teal-950/30 border-teal-800' : 'bg-teal-50 border-teal-100'}`}>
        <div><h2 className="text-xl font-bold">{language === 'en' ? 'Try simulation' : 'Coba simulasi'}</h2><p className="text-sm opacity-75 mt-1">{language === 'en' ? 'Explore potential flooding in this area using simulated data (not real sensor data).' : 'Lihat gambaran potensi genangan di wilayah ini menggunakan data buatan (bukan data sensor asli).'}</p></div>
        <button type="button" onClick={onEnterSimulation} className="rounded-xl bg-teal-700 hover:bg-teal-800 text-white px-5 py-3 font-bold">{language === 'en' ? 'Try simulation' : 'Coba simulasi'} →</button>
      </section>}
    </div>
  );
}
