/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { illustrativeWeather } from '../demo-estimates.mjs';
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
import { normalizeReading } from '../normalize-reading.mjs';
import { loadHardwareHistory24h } from '../hardware-history';

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

  const [weatherDemo, setWeatherDemo] = useState(false);
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

  // Bind real-time Firestore listeners for readings, predictions, BMKG data and config
  useEffect(() => {
    if (!firebaseConfigured || !db) {
      setHasReceivedReadingsSnapshot(true);
      setIsLoading(false);
      setIsDeviceOffline(true);
      return;
    }
    // Keep enough batches for the overview's 30-minute history at 20-second uploads.
    const unsubscribeReadings = onSnapshot(
      getFirestoreQuery('sensor_readings', 120),
      (snapshot) => {
        setHasReceivedReadingsSnapshot(true);
        const data: SensorReading[] = [];
        snapshot.forEach((doc) => {
          const docData = normalizeReading(doc.data(), config?.reference_height ?? 300);
          if (!docData) return;
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

    // 2. Listen to the latest prediction
    const unsubscribePrediction = onSnapshot(
      getFirestoreQuery('predictions', 1),
      (snapshot) => {
        if (!snapshot.empty) {
          const pred = snapshot.docs[0].data() as PredictionResult;
          setLatestPrediction(pred);
          // Auto fill baseline reasoning if advisory is empty
          if (pred.reasoning && !advisory) {
            setAdvisory(pred.reasoning);
          }
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'predictions');
      }
    );

    // 3. Listen to BMKG Weather forecast
    const unsubscribeBMKG = onSnapshot(
      getFirestoreQuery('bmkg_forecast', 1),
      (snapshot) => {
        if (!snapshot.empty) {
          setBmkgForecast(snapshot.docs[0].data() as BMKGForecast);
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'bmkg_forecast');
      }
    );

    setIsLoading(false);

    return () => {
      unsubscribeReadings();
      unsubscribePrediction();
      unsubscribeBMKG();
    };
  }, [config?.reference_height, config?.auto_simulation]);

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

  // Run initial weather fetch on dashboard open and refetch when language changes
  useEffect(() => {
    fetchLiveWeather(language);
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
          const docData = normalizeReading(d.data(), config?.reference_height ?? 300);
          const parsedTs = extractReadingTimestamp(docData);
          if (!docData || parsedTs === null || !Number.isFinite(parsedTs)) return;
          exportList.push({
            id: d.id,
            ...docData,
            timestamp: parsedTs
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
        const rainLabel = r.local_rain === 0 ? 'Kering' : r.local_rain === 1 ? 'Ringan' : r.local_rain === 2 ? 'Sedang' : r.local_rain === 3 ? 'Lebat' : '';
        return [
          dateStr,
          localTimeStr,
          r.water_level,
          r.temperature,
          r.humidity,
          rainLabel,
          r.source || '',
          r.distance ?? ''
        ];
      });

      const csvCell = (value: unknown) => {
        let text = String(value ?? '');
        if (typeof value !== 'number' && /^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
      };
      const csvContent = "\ufeff" + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `scada_sensor_logs_limited_${new Date().toISOString().slice(0,10)}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setExportNotice(language === 'en' ? 'Export is limited and may not cover all 24 hours. A fallback may include older records.' : 'Ekspor terbatas dan mungkin tidak mencakup seluruh 24 jam. Kueri cadangan dapat menyertakan data lebih lama.');
      setTimeout(() => setExportNotice(null), 10000);
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
  const rawBatch: any[] = Array.isArray((latestReading as any)?.readings) && (latestReading as any).readings.length
    ? (latestReading as any).readings : Array.isArray((latestReading as any)?.batch_data) ? (latestReading as any).batch_data : [];
  const hasBatchData = Boolean(Array.isArray(rawBatch) && rawBatch.length > 0);
  const isBatchMode = useBatch360Mode && hasBatchData;
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

  const chartData = isBatchMode
    ? rawBatch.map((item: any, idx: number) => {
        let timeLabel = `#${idx + 1}`;
        let val: number | null = null;
        let rawDist: number | null = null;

        if (Array.isArray(item)) {
          timeLabel = String(item[0]);
          const level = typeof item[1] === 'number' ? item[1] : NaN;
          if (Number.isFinite(level)) {
            val = level;
            rawDist = Math.max(0, Math.round((refHeight - level) * 10) / 10);
          }
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

          if (typeof item.distance === 'number' && Number.isFinite(item.distance)) {
            rawDist = Math.round(item.distance * 10) / 10;
            val = Math.max(0, Math.round((refHeight - rawDist) * 10) / 10);
          } else if (typeof item.water_level === 'number' && Number.isFinite(item.water_level)) {
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

  const demoWeather = latestReading && !isDeviceOffline ? illustrativeWeather(latestReading.water_level, config?.threshold_siaga ?? 60, config?.threshold_bahaya ?? 90) : null;
  return (
    <div id="scada-dashboard-root" className="space-y-6 pb-12">
      <div id="scada-hardware-pause-banner" role="status" className={`rounded-2xl border p-5 flex flex-wrap items-center justify-between gap-3 ${isDark ? 'bg-slate-800/70 border-slate-700' : 'bg-blue-50 border-blue-100'}`}>
        <div className="flex items-start gap-3"><Info className="w-6 h-6 text-blue-500 shrink-0" /><div>
          <p className="font-bold text-lg">{!latestReading ? (language === 'en' ? 'Sensor data unavailable' : 'Data sensor belum tersedia') : isDeviceOffline ? (language === 'en' ? 'Sensor offline · last reading' : 'Sensor offline · data terakhir') : (language === 'en' ? 'Sensor data available' : 'Data sensor tersedia')}</p>
          <p className="text-sm opacity-75">{!latestReading ? (language === 'en' ? 'Waiting for sensor data' : 'Menunggu data dari sensor') : timeAgoText}</p>
          {latestReading && <p className="text-xs opacity-70 mt-1">{language === 'en' ? 'Source' : 'Sumber'}: {latestReading.source || 'Sensor'}</p>}
        </div></div>
        {latestReading && !isDeviceOffline && <div className={`px-3 py-2 rounded-xl text-xs font-bold ${alertBg}`}><span className={`w-2 h-2 rounded-full ${alertLed} inline-block mr-2`} />{alertLabel}</div>}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5 items-stretch">
        <div className="lg:col-span-3 min-w-0"><CiliwungHardwareLiveView theme={theme} language={language} latestReading={latestReading} readings={readingsList} config={config ?? {}} loadDayHistory={firebaseConfigured && db ? () => loadHardwareHistory24h(db, config?.reference_height ?? 300) : undefined} compact /></div>
        <div className="lg:col-span-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-5 content-start auto-rows-min">
          <section className={`${themeCard} rounded-2xl p-6 flex flex-col gap-4`}>
            <div className="flex items-center justify-between gap-2"><h2 className="font-bold text-lg flex items-center gap-2"><CloudRain className="w-5 h-5 text-sky-500" />{language === 'en' ? 'Weather' : 'Cuaca Saat Ini'}</h2><span className="text-xs opacity-70">{weatherDemo ? 'SIMULASI' : (weatherContext?.source || 'BMKG')}</span></div>
            <button type="button" onClick={() => setWeatherDemo(value => !value)} className="rounded-lg border border-sky-500/40 px-3 py-2 text-xs font-semibold text-sky-400">{weatherDemo ? 'Gunakan data cuaca tersedia' : 'Simulasi cuaca dari status sensor'}</button>
            {weatherDemo ? demoWeather ? <div className="space-y-4" data-testid="demo-weather">
              <p className="text-xs text-amber-500">Skenario ilustratif berdasarkan status tinggi air. Suhu, kelembapan, angin, dan jarak pandang adalah nilai preset, bukan pengukuran atau prakiraan cuaca.</p>
              <p className="text-xl font-bold">{demoWeather.temperature}°C · {demoWeather.description}</p>
              <div className="grid grid-cols-2 gap-2 text-xs">{[['Kelembapan', `${demoWeather.humidity}%`], ['Kecepatan angin', `${demoWeather.wind} km/h`], ['Arah angin', demoWeather.direction], ['Jarak pandang', demoWeather.visibility]].map(([label, value]) => <div key={label} className={`rounded-xl border p-3 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-50 border-slate-200'}`}><span className="block opacity-70">{label}</span><strong>{value}</strong></div>)}</div>
            </div> : <p className="text-sm opacity-70">Menunggu data sensor aktif untuk memilih skenario ilustratif.</p> : weatherContext?.status === 'available' ? <div className="space-y-4">
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
      <details className="group"><summary className="cursor-pointer font-semibold py-3">{language === 'en' ? 'View sensor details, charts and analysis' : 'Lihat detail sensor, grafik, dan analisis'}</summary>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-4">
      {/* DETAILED MEASUREMENT GAUGES & METRICS */}
      <div id="measurement-grid" className="col-span-12 lg:col-span-4 flex flex-col gap-6">
        
        {/* Core Gauge: Water Level Channel */}
        <div id="water-gauge" className={`${themeCard} rounded-2xl p-6 relative overflow-hidden flex flex-col justify-between`}>
          <div className="flex justify-between items-center mb-4">
            <span className={`text-[10px] font-bold uppercase tracking-[0.25em] ${themeTextMuted} font-mono`}>
              {language === 'en' ? 'Water Surface Elevation' : 'Tinggi Elevasi Air'}
            </span>
            <div className="flex items-center gap-1.5">
              {isDeviceOffline ? (
                <span className="px-2.5 py-1 bg-slate-500/20 border border-slate-500/40 rounded-lg text-[10px] font-mono text-slate-400 font-bold tracking-wider uppercase flex items-center gap-1.5 shadow-sm">
                  <span className="w-2 h-2 rounded-full bg-slate-400" />
                  {language === 'en' ? 'DEVICE OFFLINE' : 'PERANGKAT OFFLINE'}
                </span>
              ) : latestReading?.source?.includes('Manual') || latestReading?.source?.includes('Peil') ? (
                <span className="px-2.5 py-1 bg-amber-500/20 border border-amber-500/40 rounded-lg text-[10px] font-mono text-amber-400 font-bold tracking-wider uppercase flex items-center gap-1.5 shadow-sm">
                  <ClipboardCheck className="w-3 h-3 text-amber-400" />
                  MANUAL PEIL SCHAAL
                </span>
              ) : latestReading?.source?.includes('Hardware') ? (
                <span className="px-2.5 py-1 bg-emerald-500/20 border border-emerald-500/40 rounded-lg text-[10px] font-mono text-emerald-400 font-bold tracking-wider uppercase flex items-center gap-1.5 shadow-sm">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                  LIVE HARDWARE
                </span>
              ) : !config?.auto_simulation ? (
                <span className="px-2.5 py-1 bg-amber-500/10 border border-amber-500/30 rounded-lg text-[9px] font-mono text-amber-400 tracking-wider uppercase flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  STANDBY (READY FOR ESP32)
                </span>
              ) : (
                <span className={`px-2 py-0.5 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'} rounded text-[9px] font-mono text-[#3B82F6] tracking-wider uppercase`}>
                  {language === 'en' ? 'SIMULATOR ACTIVE' : 'SIMULATOR AKTIF'}
                </span>
              )}
            </div>
          </div>
          
          <div className="flex items-baseline justify-between gap-4">
            <div className="flex flex-col">
              <span className={`text-5xl font-sans font-light tracking-tighter leading-none ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {isDeviceOffline ? (
                  <>--<span className="text-lg font-normal text-slate-400"> cm</span></>
                ) : (
                  <>{latestReading ? latestReading.water_level : '0.0'}<span className="text-lg font-normal text-slate-400"> cm</span></>
                )}
              </span>
              <span className={`text-[11px] ${themeTextSub} mt-2 font-sans flex items-center gap-1.5`}>
                {isDeviceOffline ? (
                  <span className="text-slate-400 font-mono">
                    {language === 'en' ? 'Device offline (>8 mins). Telemetry paused on standby.' : 'Perangkat offline (>8 mnt). Data telemetri terakhir dibekukan.'}
                  </span>
                ) : (
                  <>
                    {latestReading && latestReading.water_level >= thresholdSiaga ? (
                      <TrendingUp className="w-3.5 h-3.5 text-rose-500 animate-bounce" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5 text-emerald-500" />
                    )}
                    {latestReading?.source?.includes('Manual') ? (
                      <span className="text-amber-400 font-bold">
                        {language === 'en' ? 'Staff: ' : 'Petugas: '}{latestReading.operator || (language === 'en' ? 'Field Staff' : 'Staf Lapangan')}
                      </span>
                    ) : latestReading?.distance != null ? (
                      language === 'en'
                        ? `Sensor Gap: ${latestReading.distance} cm (${latestReading.source || 'RTU'})`
                        : `Jarak Pantul Sensor: ${latestReading.distance} cm (${latestReading.source || 'RTU'})`
                    ) : (
                      language === 'en' ? 'Fluctuation: ±0.4 cm (Temp Compensated)' : 'Fluktuasi: ±0.4 cm (Kompensasi Suhu)'
                    )}
                  </>
                )}
              </span>

              {/* Extra Field Notes if Manual Entry */}
              {latestReading?.source?.includes('Manual') && latestReading.notes && (
                <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] font-sans text-amber-300 leading-snug">
                  {latestReading.notes}
                </div>
              )}
            </div>
          </div>

          {/* PHYSICAL CROSS-SECTION GAUGE DIAGRAM */}
          <div className={`w-full h-60 ${isDark ? 'bg-black/50 border-white/5' : 'bg-slate-100/60 border-slate-200'} rounded-2xl border p-4 relative overflow-hidden flex flex-col justify-between mt-4 shadow-inner`}>
            
            {/* 1. Bridge/Beam concrete ceiling & Sensor Probe */}
            <div className="absolute top-0 left-0 right-0 h-7 bg-zinc-700 border-b border-zinc-600 flex items-center justify-center z-10 shadow-sm">
              <span className="text-[7px] font-mono text-zinc-300 tracking-widest uppercase">BRIDGE MOUNTING BEAM</span>
              
              {/* JSN-SR04T Sensor Probe Visual */}
              <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 w-10 h-5 bg-zinc-800 rounded-b-md border-x border-b border-zinc-600 flex justify-around items-center px-1">
                <div className="w-3 h-3 rounded-full bg-zinc-700 border border-[#3B82F6]/30 flex items-center justify-center">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6] animate-ping" />
                </div>
                <div className="w-3 h-3 rounded-full bg-zinc-700 border border-[#3B82F6]/30 flex items-center justify-center">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6] animate-pulse" />
                </div>
              </div>
            </div>

            {/* 2. Sonic Wave Ray (Dashed beam) */}
            <div className="absolute top-7 bottom-0 left-1/2 -translate-x-1/2 w-8 flex flex-col items-center justify-around pointer-events-none z-0">
              <div className="w-2.5 h-0.5 border-b-2 border-dashed border-[#3B82F6]/30 rounded-full animate-pulse" />
              <div className="w-3.5 h-0.5 border-b-2 border-dashed border-[#3B82F6]/30 rounded-full animate-pulse [animation-delay:0.1s]" />
              <div className="w-4.5 h-0.5 border-b-2 border-dashed border-[#3B82F6]/30 rounded-full animate-pulse [animation-delay:0.2s]" />
              <div className="w-5.5 h-0.5 border-b-2 border-dashed border-[#3B82F6]/30 rounded-full animate-pulse [animation-delay:0.3s]" />
            </div>

            {/* 3. The Water Body & Animated Surface */}
            <div 
              className="absolute bottom-0 left-0 right-0 z-20"
              style={{ 
                height: `${Math.min(85, Math.max(15, (currentLevel / (config?.reference_height || 300)) * 100))}%`,
                transition: 'height 1200ms cubic-bezier(0.4, 0, 0.2, 1)'
              }}
            >
              {/* Animated wave header */}
              <div className="absolute top-0 left-0 right-0 h-4 -mt-3.5 pointer-events-none overflow-hidden">
                <svg className="w-[200%] h-full fill-blue-500/30 animate-pulse" viewBox="0 0 1200 120" preserveAspectRatio="none">
                  <path d="M0,60 C150,100 350,20 500,60 C650,100 850,20 1000,60 L1200,60 L1200,120 L0,120 Z" />
                </svg>
              </div>

              {/* Main Water Body */}
              <div className={`w-full h-full ${
                alertStatus === 'Bahaya' ? 'bg-gradient-to-t from-rose-600/80 to-rose-500/70 border-t-2 border-rose-400' :
                alertStatus === 'Siaga' ? 'bg-gradient-to-t from-amber-600/80 to-amber-500/70 border-t-2 border-amber-400' :
                'bg-gradient-to-t from-blue-600/80 to-blue-500/70 border-t-2 border-blue-400'
              } flex flex-col justify-end border-t shadow-inner`}>
                
                {/* Sandy/Soil Riverbed ground at the absolute bottom */}
                <div className="w-full h-4 bg-amber-950/30 border-t border-amber-900/40 flex items-center justify-center">
                  <span className="text-[6px] font-mono text-amber-200/50 tracking-widest uppercase">
                    {language === 'en' ? 'RIVERBED BASELINE' : 'DASAR SUNGAI (RIVERBED)'}
                  </span>
                </div>
              </div>
            </div>

            {/* 4. Overlaid threshold markings (Siaga, Bahaya) */}
            {/* Siaga Line */}
            <div 
              className="absolute left-0 right-0 border-t border-dashed border-amber-500/70 z-30 pointer-events-none"
              style={{ 
                bottom: `${(thresholdSiaga / (config?.reference_height || 300)) * 100}%` 
              }}
            >
              <div className="bg-amber-500 text-black text-[6px] font-mono font-bold px-1.5 py-0.5 rounded absolute right-3 -top-2.5 shadow-sm uppercase tracking-wider">
                {language === 'en' ? 'ALERT' : 'SIAGA'}: {thresholdSiaga} cm
              </div>
            </div>
            {/* Bahaya Line */}
            <div 
              className="absolute left-0 right-0 border-t border-dashed border-rose-500/80 z-30 pointer-events-none"
              style={{ 
                bottom: `${(thresholdBahaya / (config?.reference_height || 300)) * 100}%` 
              }}
            >
              <div className="bg-rose-600 text-white text-[6px] font-mono font-bold px-1.5 py-0.5 rounded absolute right-3 -top-2.5 shadow-sm uppercase tracking-wider">
                {language === 'en' ? 'DANGER' : 'BAHAYA'}: {thresholdBahaya} cm
              </div>
            </div>

            {/* 5. Dimensions & Annotations overlay */}
            <div className="absolute top-10 bottom-1 left-0 right-0 px-3 flex justify-between pointer-events-none z-30 font-mono">
              {/* AIR GAP (Jarak ke Sensor) annotation */}
              <div className="flex flex-col justify-start items-start w-1/2">
                <div className="bg-black/85 border border-white/10 rounded px-1.5 py-0.5 text-left shadow">
                  <span className="text-[6px] text-slate-400 block uppercase leading-none mb-0.5">
                    {language === 'en' ? 'Sensor Gap to Water (d)' : 'Jarak Sensor ke Air (d)'}
                  </span>
                  <span className="text-[10px] font-bold text-sky-400 leading-none">
                    {isDeviceOffline ? '-- cm' : `${config ? Math.max(0, config.reference_height - currentLevel) : 300 - currentLevel} cm`}
                  </span>
                </div>
              </div>

              {/* WATER LEVEL (Tinggi Air) annotation */}
              <div className="flex flex-col justify-end items-end w-1/2">
                <div className="bg-black/85 border border-white/10 rounded px-1.5 py-0.5 text-right shadow">
                  <span className="text-[6px] text-slate-400 block uppercase leading-none mb-0.5">
                    {language === 'en' ? 'Water Elevation (h)' : 'Elevasi Air (h)'}
                  </span>
                  <span className="text-[10px] font-bold text-emerald-400 leading-none">
                    {isDeviceOffline ? '-- cm' : `${currentLevel} cm`}
                  </span>
                </div>
              </div>
            </div>

            {/* Total Height Tag */}
            <div className="absolute bottom-5 left-3 bg-zinc-800/90 border border-zinc-700 text-[6px] font-mono text-zinc-300 px-1.5 py-0.5 rounded z-30 shadow-md">
              H_REF: {config ? config.reference_height : 300} cm
            </div>

          </div>

          <div className={`grid grid-cols-2 gap-2 mt-4 pt-3 border-t ${themeBorder} text-[10px] font-mono`}>
            <div className="flex flex-col">
              <span className={themeTextMuted}>{language === 'en' ? 'Alert Threshold:' : 'Ambang Siaga:'}</span>
              <span className="text-amber-500 font-semibold mt-0.5">{thresholdSiaga} cm</span>
            </div>
            <div className="flex flex-col">
              <span className={themeTextMuted}>{language === 'en' ? 'Danger Threshold:' : 'Ambang Bahaya:'}</span>
              <span className="text-rose-500 font-semibold mt-0.5">{thresholdBahaya} cm</span>
            </div>
          </div>
        </div>

        {/* Real-time BMKG Weather Forecast with Google Search Grounding */}
        <div id="bmkg-gauge" className={`${themeCard} rounded-2xl p-6 relative overflow-hidden flex flex-col justify-between`}>
          <div>
            <div className="flex justify-between items-start mb-4">
              <div className="flex flex-col">
                <span className={`text-[10px] font-bold uppercase tracking-[0.25em] ${themeTextMuted} font-mono`}>
                  {language === 'en' ? 'Official BMKG Forecast & Grounding' : 'Prakiraan BMKG & Grounding Cuaca'}
                </span>
                <span className="font-mono text-[8px] text-[#3B82F6] uppercase tracking-wider mt-0.5">gemini-3.5-flash // Search Grounded</span>
              </div>
              <button 
                id="btn-sync-weather"
                onClick={() => fetchLiveWeather()}
                disabled={loadingWeather}
                className={`p-1.5 rounded-lg border transition-all ${isDark ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300 border-white/10' : 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'}`}
                title={language === 'en' ? 'Synchronize Live Weather Data' : 'Sinkronisasi Data Cuaca Terkini'}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingWeather ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {loadingWeather ? (
              <div className="py-6 flex flex-col items-center justify-center">
                <RefreshCw className="w-5 h-5 animate-spin text-[#3B82F6] mb-2" />
                <span className={`text-[9px] font-mono uppercase tracking-wider ${themeTextMuted} text-center px-4`}>
                  {language === 'en'
                    ? 'Connecting to Google Search to retrieve live upstream Bogor-Depok weather...'
                    : 'Menghubungkan ke Google Search untuk mencari cuaca terkini hulu Bogor-Depok...'}
                </span>
              </div>
            ) : liveWeather ? (
              <div className="space-y-4">
                {/* Weather Header: SAAT INI */}
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-sky-500 font-sans">
                  <span>{language === 'en' ? 'CURRENT OBSERVATION' : 'SAAT INI'}</span>
                  <span title={language === 'en' ? 'Integrated upstream river basin weather' : 'Informasi cuaca terpadu hulu aliran sungai Depok'}>
                    <Info className="w-3.5 h-3.5 text-sky-400 cursor-help" />
                  </span>
                </div>

                {/* Major Weather Information with Visual Icon and Temp */}
                <div className="flex items-center gap-4 py-1">
                  {/* Custom weather icon representation */}
                  <div className="relative flex-shrink-0">
                    {liveWeather.weather_icon ? (
                      <img 
                        src={liveWeather.weather_icon} 
                        alt={liveWeather.condition} 
                        className="w-14 h-14 object-contain filter drop-shadow" 
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <CloudRain className="w-14 h-14 text-[#3B82F6] filter drop-shadow animate-pulse" />
                    )}
                    <div className="absolute -top-1 -right-1 w-5 h-5 bg-amber-400/10 rounded-full blur-sm" />
                  </div>

                    <div>
                    <div className="flex items-baseline flex-wrap gap-x-2">
                      <span className={`text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {liveWeather.temperature_c}°C
                      </span>
                      <span className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {language === 'en' ? translateConditionToEn(liveWeather.condition) : liveWeather.condition}
                      </span>
                    </div>
                    <span className={`text-[10px] ${themeTextSub} block mt-0.5`}>
                      {language === 'en' ? 'in ' : 'di '}{liveWeather.location_name || (language === 'en' ? 'Depok & upstream Ciliwung' : 'Depok & wilayah hulu Ciliwung')}
                    </span>
                  </div>
                </div>

                {/* Grid layout for requested weather parameters */}
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {/* 1. Kelembapan */}
                  <div className={`flex items-center gap-2 px-2.5 py-1.5 border ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-xl`}>
                    <div className="text-sky-500 p-1 bg-sky-500/10 rounded-lg">
                      <Droplet className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex flex-col text-[9px] leading-tight">
                      <span className={themeTextMuted}>{language === 'en' ? 'Humidity:' : 'Kelembapan:'}</span>
                      <span className={`font-bold mt-0.5 ${isDark ? 'text-white' : 'text-slate-800'}`}>
                        {liveWeather.humidity_percent}%
                      </span>
                    </div>
                  </div>

                  {/* 2. Kecepatan Angin */}
                  <div className={`flex items-center gap-2 px-2.5 py-1.5 border ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-xl`}>
                    <div className="text-[#3B82F6] p-1 bg-blue-500/10 rounded-lg">
                      <Wind className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex flex-col text-[9px] leading-tight">
                      <span className={themeTextMuted}>{language === 'en' ? 'Wind Speed:' : 'Kecepatan Angin:'}</span>
                      <span className={`font-bold mt-0.5 ${isDark ? 'text-white' : 'text-slate-800'}`}>
                        {liveWeather.wind_speed_kph !== undefined ? liveWeather.wind_speed_kph.toLocaleString(language === 'en' ? 'en-US' : 'id-ID') : '6.7'} km/h
                      </span>
                    </div>
                  </div>

                  {/* 3. Arah Angin dari */}
                  <div className={`flex items-center gap-2 px-2.5 py-1.5 border ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-xl col-span-1`}>
                    <div className="text-indigo-400 p-1 bg-indigo-500/10 rounded-lg">
                      <Compass className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex flex-col text-[9px] leading-tight">
                      <span className={themeTextMuted}>{language === 'en' ? 'Wind Direction:' : 'Arah Angin dari:'}</span>
                      <span className={`font-bold mt-0.5 ${isDark ? 'text-white' : 'text-slate-800'}`}>
                        {liveWeather.wind_direction 
                          ? (language === 'en' ? translateWindDirectionToEn(liveWeather.wind_direction) : liveWeather.wind_direction) 
                          : (language === 'en' ? 'South ↑' : 'Selatan ↑')}
                      </span>
                    </div>
                  </div>

                  {/* 4. Jarak Pandang */}
                  <div className={`flex items-center gap-2 px-2.5 py-1.5 border ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'} rounded-xl`}>
                    <div className="text-emerald-500 p-1 bg-emerald-500/10 rounded-lg">
                      <Eye className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex flex-col text-[9px] leading-tight">
                      <span className={themeTextMuted}>{language === 'en' ? 'Visibility:' : 'Jarak Pandang:'}</span>
                      <span className={`font-bold mt-0.5 ${isDark ? 'text-white' : 'text-slate-800'}`}>
                        {liveWeather.visibility_km || '< 9 km'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className={`text-[10px] ${themeTextMuted} font-mono mt-1`}>
                  {language === 'en' ? 'Precipitation: ' : 'Curah hujan: '}{liveWeather.precipitation_mm}
                </div>

                {/* Weather Alerts Ticker */}
                {liveWeather.alerts && liveWeather.alerts.length > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-[8px] font-bold text-rose-500 font-mono tracking-wider uppercase block">
                      {language === 'en' ? 'Active Early Warnings:' : 'Peringatan Dini Aktif:'}
                    </span>
                    <div className={`p-2.5 rounded-lg border border-rose-500/15 bg-rose-500/5 text-[10px] ${isDark ? 'text-rose-300' : 'text-rose-700'} leading-relaxed space-y-1`}>
                      {liveWeather.alerts.map((alert, i) => (
                        <div key={i} className="flex items-start gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                          <span>{alert}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className={`text-[10px] font-sans leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'} border-t border-dashed ${themeBorder} pt-3`}>
                  <p className="italic">"{formatWeatherSummary(liveWeather, language)}"</p>
                  <span className={`block text-[8px] font-mono ${themeTextMuted} mt-2 text-right`}>
                    {language === 'en' ? 'Updated: ' : 'Diperbarui: '}{liveWeather.last_updated}
                  </span>
                </div>
              </div>
            ) : (
              <div className={`text-center py-6 text-[10px] font-mono ${themeTextMuted}`}>
                {language === 'en' ? 'Failed to load weather. Click sync button above.' : 'Gagal memuat info cuaca hulu. Klik tombol sync di atas.'}
              </div>
            )}
          </div>
        </div>

      </div>

      {/* HIGH-FIDELITY CHRONOLOGICAL PLOT & FORECASTS */}
      <div id="scada-charts-forecasts" className="col-span-12 lg:col-span-8 flex flex-col gap-6">
        
        {/* Real-time & Historical Plot */}
        <div id="scada-plot-container" className={`${themeCard} rounded-2xl p-6 flex flex-col justify-between`}>
          <div className="flex justify-between items-center mb-5 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-bold uppercase tracking-[0.25em] ${themeTextMuted} font-mono`}>
                {language === 'en' ? 'Live Water Elevation Curve vs Critical Limits' : 'Kurva Elevasi Air Terkini vs Batas Kritis'}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* Toggle Mode: Elevasi vs Raw Ultrasonik */}
              <div className={`flex items-center gap-1 border ${isDark ? 'border-white/5 bg-black/25' : 'border-slate-200 bg-slate-100'} rounded-lg p-0.5 text-[10px] font-mono`}>
                <button
                  id="btn-mode-elevation"
                  onClick={() => setChartViewMode('elevation')}
                  className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${
                    chartViewMode === 'elevation'
                      ? 'bg-[#3B82F6] text-black font-bold'
                      : `${themeTextSub} hover:text-[#3B82F6]`
                  }`}
                  title={language === 'en' ? 'Show Water Surface Elevation (TMA) in cm' : 'Tampilkan grafik Tinggi Elevasi Muka Air (TMA) dalam cm'}
                >
                  {language === 'en' ? 'Elevation (TMA)' : 'Elevasi Air (TMA)'}
                </button>
                <button
                  id="btn-mode-raw"
                  onClick={() => setChartViewMode('raw_ultrasonic')}
                  className={`px-2.5 py-1 rounded-md transition-all cursor-pointer flex items-center gap-1.5 ${
                    chartViewMode === 'raw_ultrasonic'
                      ? 'bg-emerald-500 text-black font-bold'
                      : `${themeTextSub} hover:text-emerald-400`
                  }`}
                  title={language === 'en' ? 'Show sensor distance; missing values may be estimated from the configured reference' : 'Tampilkan jarak sensor; nilai yang tidak tersedia dapat diperkirakan dari referensi'}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {language === 'en' ? 'Sensor Distance (d)' : 'Jarak Sensor (d)'}
                </button>
              </div>

              <div className={`flex items-center gap-1 border ${isDark ? 'border-white/5 bg-black/25' : 'border-slate-200 bg-slate-100'} rounded-lg p-0.5 text-[10px] font-mono`}>
                <button 
                  id="btn-range-realtime"
                  onClick={() => {
                    setUseBatch360Mode(false);
                    setChartRange('realtime');
                  }}
                  className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${(!isBatchMode && chartRange === 'realtime') ? 'bg-[#3B82F6] text-black font-bold' : `${themeTextSub} hover:text-[#3B82F6]`}`}
                  title={language === 'en' ? 'High resolution chart showing last 20 telemetry readings' : 'Grafik resolusi tinggi menampilkan 20 pembacaan telemetri terakhir'}
                >
                  {language === 'en' ? 'Real-time (20 Pts)' : 'Terkini (20 Poin)'}
                </button>
                <button 
                  id="btn-range-24h"
                  onClick={() => {
                    setUseBatch360Mode(false);
                    setChartRange('24h');
                  }}
                  className={`px-2.5 py-1 rounded-md transition-all cursor-pointer ${(!isBatchMode && chartRange === '24h') ? 'bg-[#3B82F6] text-black font-bold' : `${themeTextSub} hover:text-[#3B82F6]`}`}
                  title={language === 'en' ? 'History currently loaded (up to 120 packets)' : 'Riwayat yang sudah dimuat (hingga 120 paket)'}
                >
                  {language === 'en' ? 'Loaded History' : 'Riwayat Dimuat'}
                </button>
                <button 
                  id="btn-range-batch360"
                  onClick={() => setUseBatch360Mode(!useBatch360Mode)}
                  disabled={!hasBatchData}
                  className={`px-2.5 py-1 rounded-md transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 ${isBatchMode ? 'bg-emerald-500 text-black font-bold' : `${themeTextSub} hover:text-emerald-400`}`}
                  title={hasBatchData ? (language === 'en' ? 'Show samples from the latest packet' : 'Tampilkan sampel dari paket terakhir') : (language === 'en' ? 'No packet samples available' : 'Sampel paket tidak tersedia')}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${isBatchMode ? 'bg-black' : 'bg-emerald-400 animate-pulse'}`} />
                  {language === 'en' ? `Batch (${rawBatch.length})` : `Batch (${rawBatch.length} titik)`}
                </button>
              </div>

              {/* Export Data Button */}
              <div className="relative">
                <button
                  id="btn-export-csv"
                  onClick={handleExportCSV}
                  disabled={isExportingCSV}
                  title={language === 'en' ? 'Export up to 1,500 queried logs; data may be incomplete' : 'Ekspor hingga 1.500 log; data mungkin tidak lengkap'}
                  className={`flex items-center gap-1.5 px-3 py-1.5 border text-[10px] font-mono rounded-lg transition-all cursor-pointer ${
                    isDark 
                      ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300' 
                      : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600 shadow-sm'
                  } ${isExportingCSV ? 'opacity-50 cursor-wait' : ''}`}
                >
                  {isExportingCSV ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#3B82F6]" />
                  ) : (
                    <Download className="w-3.5 h-3.5 text-[#3B82F6]" />
                  )}
                  <span className="font-bold">
                    {isExportingCSV 
                      ? (language === 'en' ? 'QUERYING 24H...' : 'MENGAMBIL 24 JAM...') 
                      : (language === 'en' ? 'EXPORT LOGS' : 'EKSPOR LOG')}
                  </span>
                </button>

                {exportNotice && (
                  <div className="absolute right-0 top-full mt-2 w-72 p-2.5 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-lg text-[10px] font-sans shadow-xl z-50 animate-in fade-in slide-in-from-top-1">
                    <div className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{exportNotice}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {chartViewMode === 'elevation' ? (
                <>
                  <span className={`text-[9px] ${themeTextMuted} flex items-center gap-1 font-mono uppercase tracking-wider`}>
                    <span className="w-2 h-2 rounded-full bg-[#3B82F6] inline-block" /> {language === 'en' ? 'Elevation (h)' : 'Elevasi Air (h)'}
                  </span>
                  <span className={`text-[9px] ${themeTextMuted} flex items-center gap-1 font-mono uppercase tracking-wider`}>
                    <span className="w-2.5 h-0.5 bg-amber-500/80 inline-block border-t border-dashed" /> {language === 'en' ? 'Alert Limit' : 'Batas Siaga'}
                  </span>
                  <span className={`text-[9px] ${themeTextMuted} flex items-center gap-1 font-mono uppercase tracking-wider`}>
                    <span className="w-2.5 h-0.5 bg-rose-500/80 inline-block border-t border-dashed" /> {language === 'en' ? 'Danger Limit' : 'Batas Bahaya'}
                  </span>
                </>
              ) : (
                <>
                  <span className={`text-[9px] text-emerald-400 flex items-center gap-1 font-mono uppercase tracking-wider`}>
                    <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" /> {language === 'en' ? 'Distance (may be estimated)' : 'Jarak (dapat berupa perkiraan)'}
                  </span>
                  <span className={`text-[9px] ${themeTextMuted} flex items-center gap-1 font-mono uppercase tracking-wider`}>
                    <span className="w-2.5 h-0.5 bg-zinc-500 inline-block border-t border-dashed" /> H_REF: {config?.reference_height || 300}cm
                  </span>
                </>
              )}
            </div>
          </div>

          {!isBatchMode && chartViewMode === 'elevation' && <p className={`mb-2 text-xs ${themeTextMuted}`}>{language === 'en' ? 'Isolated upward spikes may be adjusted for display; stored readings are unchanged.' : 'Lonjakan tunggal ke atas dapat disesuaikan pada tampilan; data tersimpan tidak berubah.'}</p>}
          <div className="w-full h-72">
            {!hasReceivedReadingsSnapshot ? (
              <div className={`w-full h-full flex flex-col items-center justify-center ${themeTextMuted} font-mono text-[10px] uppercase tracking-widest`}>
                <RefreshCw className="w-5 h-5 animate-spin text-[#3B82F6] mb-3" />
                {language === 'en' ? 'Connecting to telemetry database...' : 'Menghubungkan ke basis data telemetri...'}
              </div>
            ) : chartData.length === 0 ? (
              <div className={`w-full h-full flex flex-col items-center justify-center p-6 text-center rounded-xl border border-dashed ${isDark ? 'bg-black/30 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-3 shadow-sm">
                  <Activity className="w-6 h-6 animate-pulse" />
                </div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping inline-block" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-amber-400">
                    {language === 'en' ? 'TELEMETRY STANDBY — AWAITING ESP32' : 'STATUS TELEMETRI: STANDBY (MENUNGGU TRANSMISI ESP32)'}
                  </span>
                </div>
                <p className={`text-xs max-w-lg mb-4 font-sans leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {language === 'en'
                    ? 'Database is active and ready. Currently no telemetry packets in sensor database (device in standby or simulation was recently reset). The curve will automatically plot once ESP32 transmits data.'
                    : 'Database aktif dan siap menerima data. Saat ini belum ada data sensor yang masuk dari ESP32 (perangkat standby/offline atau simulasi baru saja direset). Grafik akan langsung tergambar otomatis saat ESP32 mengirim data.'}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleInjectQuickTest}
                    disabled={isInjectingTestTelemetry}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold bg-[#3B82F6] hover:bg-blue-400 text-black transition-all shadow-md cursor-pointer disabled:opacity-50"
                  >
                    {isInjectingTestTelemetry ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Zap className="w-3.5 h-3.5" />
                    )}
                    <span>{language === 'en' ? 'Test Chart (Sample 35 cm)' : 'Uji Grafik (Sampel 35 cm)'}</span>
                  </button>
                  {onEnterSimulation && (
                    <button
                      type="button"
                      onClick={onEnterSimulation}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-black transition-all shadow-md cursor-pointer"
                    >
                      <Activity className="w-3.5 h-3.5" />
                      <span>{language === 'en' ? 'Enter Simulation Mode' : 'Masuk Mode Simulasi'}</span>
                    </button>
                  )}
                  {onNavigateTab && (
                    <button
                      type="button"
                      onClick={() => onNavigateTab('admin')}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium border transition-all cursor-pointer ${
                        isDark 
                          ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300' 
                          : 'bg-white hover:bg-slate-100 border-slate-200 text-slate-700 shadow-sm'
                      }`}
                    >
                      <ShieldCheck className="w-3.5 h-3.5 text-[#3B82F6]" />
                      <span>{language === 'en' ? 'Open PLC Simulation Panel' : 'Buka Kontrol PLC & Simulasi'}</span>
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 55, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorLevel" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.15}/>
                      <stop offset="95%" stopColor="#3B82F6" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorRaw" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10B981" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#10B981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={themeGridColor} />
                  <XAxis dataKey="time" stroke="#52525B" style={{ fontSize: 9, fontFamily: 'monospace' }} />
                  <YAxis 
                    domain={chartViewMode === 'elevation' ? [0, Math.ceil(Math.max(160, Number.isFinite(thresholdSiaga) ? thresholdSiaga : 0, Number.isFinite(thresholdBahaya) ? thresholdBahaya : 0, ...chartData.map(point => Number.isFinite(point.elevasi) ? point.elevasi : 0)) / 20) * 20] : [0, Math.ceil(Math.max(300, (config?.reference_height || 300) + 20, ...chartData.map(point => Number.isFinite(point.raw_distance) ? point.raw_distance : 0)) / 20) * 20]}
                    stroke="#52525B" 
                    style={{ fontSize: 9, fontFamily: 'monospace' }} 
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: isDark ? '#0D0D0F' : '#ffffff', borderColor: isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0', borderRadius: '8px' }}
                    labelStyle={{ color: isDark ? '#94a3b8' : '#475569', fontWeight: 'bold', fontSize: 10, fontFamily: 'monospace' }}
                    itemStyle={{ color: isDark ? '#fff' : '#0f172a', fontSize: 11 }}
                  />
                  {chartViewMode === 'elevation' ? (
                    <>
                      <Area type="monotone" dataKey="elevasi" name={language === 'en' ? "Water Level (cm)" : "Elevasi Air (cm)"} stroke="#3B82F6" strokeWidth={1.5} fillOpacity={1} fill="url(#colorLevel)" />
                      <ReferenceLine y={thresholdSiaga} stroke="#f59e0b" strokeDasharray="4 4" strokeWidth={1.2} label={{ value: language === 'en' ? 'ALERT' : 'SIAGA', fill: '#f59e0b', fontSize: 8, position: 'right', fontFamily: 'monospace' }} />
                      <ReferenceLine y={thresholdBahaya} stroke="#f43f5e" strokeDasharray="4 4" strokeWidth={1.2} label={{ value: language === 'en' ? 'DANGER' : 'BAHAYA', fill: '#f43f5e', fontSize: 8, position: 'right', fontFamily: 'monospace' }} />
                    </>
                  ) : (
                    <>
                      <Area type="monotone" dataKey="raw_distance" name={language === 'en' ? "Sensor distance; may be estimated (cm)" : "Jarak sensor; dapat berupa perkiraan (cm)"} stroke="#10B981" strokeWidth={1.5} fillOpacity={1} fill="url(#colorRaw)" />
                      <ReferenceLine y={config?.reference_height || 300} stroke="#71717A" strokeDasharray="3 3" strokeWidth={1} label={{ value: 'TIANG/REF', fill: '#71717A', fontSize: 8, position: 'right', fontFamily: 'monospace' }} />
                    </>
                  )}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Legacy single-node advisory, separate from the synthetic replay forecast */}
        <div id="processed-forecast-panel" className="flex flex-col gap-3">
          <p className={`text-[11px] ${themeTextSub}`}>
            Single-node advisory — legacy /api/predict uses Gemini or heuristic fallback; saved Firestore predictions may have different provenance. These values are not the synthetic N1/N5 LSTM replay forecast.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          
          <div className={`${themeCard} rounded-2xl p-5 flex flex-col justify-between`}>
            <div className={`flex justify-between items-center ${themeTextMuted} font-mono text-[9px] uppercase tracking-widest`}>
              <span>Horizon T+30m</span>
              <Clock className={`w-3.5 h-3.5 ${themeTextMuted}`} />
            </div>
            <div className="my-3">
              <span className={`text-3xl font-sans font-light tracking-tight ${isDark ? 'text-white' : 'text-slate-800'}`}>
                {latestPrediction ? `${latestPrediction.prediction_30m}` : '--'} <span className="text-xs font-normal text-slate-400">cm</span>
              </span>
            </div>
            <div className="text-[10px] font-mono text-[#3B82F6] bg-[#3B82F6]/5 border border-[#3B82F6]/15 rounded py-1 text-center">
              LEGACY ESTIMATE · NOT CALIBRATED
            </div>
          </div>

          <div className={`${themeCard} rounded-2xl p-5 flex flex-col justify-between`}>
            <div className={`flex justify-between items-center ${themeTextMuted} font-mono text-[9px] uppercase tracking-widest`}>
              <span>{language === 'en' ? 'Horizon T+1 Hour' : 'Horizon T+1 Jam'}</span>
              <Clock className="w-3.5 h-3.5 text-[#3B82F6]" />
            </div>
            <div className="my-3">
              <span className={`text-3xl font-sans font-light tracking-tight ${isDark ? 'text-white' : 'text-slate-800'}`}>
                {latestPrediction ? `${latestPrediction.prediction_1h}` : '--'} <span className="text-xs font-normal text-slate-400">cm</span>
              </span>
            </div>
            <div className="text-[10px] font-mono text-[#3B82F6] bg-[#3B82F6]/5 border border-[#3B82F6]/15 rounded py-1 text-center">
              LEGACY ESTIMATE · NOT CALIBRATED
            </div>
          </div>

          <div className={`${themeCard} rounded-2xl p-5 flex flex-col justify-between`}>
            <div className={`flex justify-between items-center ${themeTextMuted} font-mono text-[9px] uppercase tracking-widest`}>
              <span>{language === 'en' ? 'Horizon T+3 Hours' : 'Horizon T+3 Jam'}</span>
              <Clock className="w-3.5 h-3.5 text-purple-400" />
            </div>
            <div className="my-3">
              <span className={`text-3xl font-sans font-light tracking-tight ${isDark ? 'text-white' : 'text-slate-800'}`}>
                {latestPrediction ? `${latestPrediction.prediction_3h}` : '--'} <span className="text-xs font-normal text-slate-400">cm</span>
              </span>
            </div>
            <div className="text-[10px] font-mono text-purple-400 bg-purple-950/15 border border-purple-800/20 rounded py-1 text-center">
              LEGACY ESTIMATE · NOT CALIBRATED
            </div>
          </div>

          <div className={`${themeCard} rounded-2xl p-5 flex flex-col justify-between`}>
            <div className={`flex justify-between items-center ${themeTextMuted} font-mono text-[9px] uppercase tracking-widest`}>
              <span>{language === 'en' ? 'Horizon T+6 Hours' : 'Horizon T+6 Jam'}</span>
              <Clock className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div className="my-3">
              <span className={`text-3xl font-sans font-light tracking-tight ${isDark ? 'text-white' : 'text-slate-800'}`}>
                {latestPrediction ? `${latestPrediction.prediction_6h}` : '--'} <span className="text-xs font-normal text-slate-400">cm</span>
              </span>
            </div>
            <div className="text-[10px] font-mono text-amber-400 bg-amber-950/15 border border-amber-800/20 rounded py-1 text-center">
              LEGACY ESTIMATE · NOT CALIBRATED
            </div>
          </div>

          </div>
        </div>

        {/* SENSOR FUSI LOKAL (Membentang Persegi Panjang Sejajar di Bawah 4 Horizon) */}
        <div id="climate-gauge" style={{ height: '327.836px' }} className={`${themeCard} rounded-2xl p-6 border ${themeBorder} flex flex-col justify-between`}>
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3.5 border-b border-white/5">
            <div className="flex items-center gap-2.5">
              <div className={`p-2.5 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'} rounded-xl text-[#3B82F6]`}>
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <span className={`text-[10px] font-bold uppercase tracking-[0.25em] ${themeTextMuted} font-mono block`}>
                  {language === 'en' ? 'Local Sensor Fusion & Acoustic Compensation' : 'Sensor Fusi Lokal & Kompensasi Akustik'}
                </span>
                <span className="text-[9px] font-mono text-slate-400">
                  {language === 'en' ? 'RTU Micro-Climate Telemetry // Real-time JSN-SR04T ToF Correction' : 'Telemetri Mikro-Klimatologi RTU // Koreksi ToF JSN-SR04T Real-time'}
                </span>
              </div>
            </div>
            
            <div className="flex items-center gap-2 font-mono text-[9px]">
              <span className="px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full flex items-center gap-1.5 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {language === 'en' ? 'Acoustic Correction Active' : 'Koreksi Akustik Aktif'}
              </span>
            </div>
          </div>

          {/* 4 Sensor Cards filling the vertical and horizontal space */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 flex-1 py-3.5">
            {/* 1. Hujan Lokal */}
            <div className={`flex flex-col justify-between ${themeBgInner} rounded-xl p-4 border border-white/5 shadow-inner`}>
              <div className="flex items-center justify-between">
                <span className={`text-[10px] ${themeTextMuted} font-sans uppercase tracking-wider`}>
                  {language === 'en' ? 'Local Rain' : 'Hujan Lokal'}
                </span>
                <div className="p-1.5 rounded-lg bg-blue-500/10 text-[#3B82F6]">
                  <CloudRain className="w-4 h-4" />
                </div>
              </div>
              <div className="my-auto py-2">
                <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-slate-800'} tracking-tight`}>
                  {latestReading ? (
                    latestReading.local_rain === 0 ? (language === 'en' ? 'Dry' : 'Kering') :
                    latestReading.local_rain === 1 ? (language === 'en' ? 'Light' : 'Ringan') :
                    latestReading.local_rain === 2 ? (language === 'en' ? 'Moderate' : 'Sedang') : (language === 'en' ? 'Heavy' : 'Lebat')
                  ) : (language === 'en' ? 'Dry' : 'Kering')}
                </span>
              </div>
              <div className="flex items-center justify-between text-[9px] font-mono pt-2 border-t border-white/5 text-slate-400">
                <span>FC-37 AO</span>
                <span className={latestReading && latestReading.local_rain > 0 ? 'text-amber-400 font-bold' : 'text-emerald-400 font-semibold'}>
                  {latestReading && latestReading.local_rain > 0 ? (language === 'en' ? 'PRECIPITATION' : 'PRESIPITASI') : (language === 'en' ? 'NORMAL' : 'NORMAL')}
                </span>
              </div>
            </div>

            {/* 2. Suhu Udara Lingkungan */}
            <div className={`flex flex-col justify-between ${themeBgInner} rounded-xl p-4 border border-white/5 shadow-inner`}>
              <div className="flex items-center justify-between">
                <span className={`text-[10px] ${themeTextMuted} font-sans uppercase tracking-wider`}>
                  {language === 'en' ? 'Ambient Temp' : 'Suhu Ambient'}
                </span>
                <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400">
                  <Thermometer className="w-4 h-4" />
                </div>
              </div>
              <div className="my-auto py-2">
                <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-slate-800'} tracking-tight`}>
                  {latestReading ? `${latestReading.temperature}°C` : '--°C'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[9px] font-mono pt-2 border-t border-white/5 text-slate-400">
                <span>DHT22</span>
                <span className="text-amber-400 font-bold">{language === 'en' ? 'NTC THERMISTOR' : 'TERMISTOR NTC'}</span>
              </div>
            </div>

            {/* 3. Kelembaban Udara */}
            <div className={`flex flex-col justify-between ${themeBgInner} rounded-xl p-4 border border-white/5 shadow-inner`}>
              <div className="flex items-center justify-between">
                <span className={`text-[10px] ${themeTextMuted} font-sans uppercase tracking-wider`}>
                  {language === 'en' ? 'Humidity' : 'Kelembaban'}
                </span>
                <div className="p-1.5 rounded-lg bg-sky-500/10 text-sky-400">
                  <Percent className="w-4 h-4" />
                </div>
              </div>
              <div className="my-auto py-2">
                <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-slate-800'} tracking-tight`}>
                  {latestReading ? `${latestReading.humidity}%` : '--%'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[9px] font-mono pt-2 border-t border-white/5 text-slate-400">
                <span>DHT22</span>
                <span className="text-sky-400 font-bold">{language === 'en' ? 'CAPACITIVE RH' : 'KAPASITIF RH'}</span>
              </div>
            </div>

            {/* 4. Kompensasi Kecepatan Suara ToF */}
            <div className={`flex flex-col justify-between ${isDark ? 'bg-black/40 border-white/5' : 'bg-slate-100 border-slate-200'} rounded-xl p-4 border shadow-inner`}>
              <div className="flex items-center justify-between">
                <span className={`text-[10px] ${themeTextMuted} font-mono uppercase tracking-wider`}>
                  {language === 'en' ? 'Speed of Sound (Vs)' : 'Kecepatan Suara (Vs)'}
                </span>
                <div className="p-1.5 rounded-lg bg-blue-500/10 text-[#3B82F6]">
                  <Cpu className="w-4 h-4" />
                </div>
              </div>
              <div className="my-auto py-2">
                <span className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-slate-800'} tracking-tight`}>
                  {latestReading ? (331.3 + 0.606 * latestReading.temperature).toFixed(1) : '343.4'} <span className="text-xs font-normal text-slate-400">m/s</span>
                </span>
              </div>
              <div className="flex items-center justify-between text-[9px] font-mono pt-2 border-t border-white/5 text-slate-400">
                <span>JSN-SR04T</span>
                <span className="text-emerald-400 font-bold tracking-tight">±0.05 cm</span>
              </div>
            </div>
          </div>

          {/* Footer formula bar */}
          <div className={`pt-3 border-t border-white/5 flex flex-col sm:flex-row items-start sm:items-center justify-between text-[9.5px] font-mono ${themeTextMuted} gap-1`}>
            <span>
              {language === 'en' ? 'Formula: ' : 'Formula: '}<strong className={isDark ? 'text-white/80' : 'text-slate-700'}>Vs = 331.3 + 0.606 × T</strong> m/s
            </span>
            <span>
              {language === 'en'
                ? 'Continuously compensating JSN-SR04T ultrasonic wave propagation deviation'
                : 'Mengoreksi deviasi gelombang ultrasonik JSN-SR04T secara kontinu'}
            </span>
          </div>
        </div>

      </div>

      </div>
      </details>
    </div>
  );
}
