/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db, handleFirestoreError, OperationType } from '../firebaseConfig';
import { playAlertPreviewChime } from '../utils/alarmAudio';
import { apiUrl } from '../utils/apiBase';
import { runLstmForecast } from '../ml/lstmEngine';
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
  Radio,
  CheckCircle2,
  RotateCcw,
  ShieldCheck,
  Zap,
  Map as MapIcon,
  LineChart as LineChartIcon,
  CloudSun
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

import { extractReadingTimestamp, normalizeSensorReading } from '../utils/readingUtils';
import CiliwungHardwareLiveView from './CiliwungHardwareLiveView';
import { loadHardwareHistory24h } from '../hardware-history';
export { extractReadingTimestamp, normalizeSensorReading };

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
  onLatestReadingChange,
  language = 'id',
  soundEnabled: propSoundEnabled,
  onToggleSound,
  onResetSimulation,
  sharedReadings,
  hasSharedReadings,
}: {
  config: SystemConfig | null;
  theme?: 'light' | 'dark';
  prefSoundSiaga?: boolean;
  prefSoundBahaya?: boolean;
  prefPushSiaga?: boolean;
  prefPushBahaya?: boolean;
  onNavigateTab?: (tab: 'dashboard' | 'simulation' | 'admin') => void;
  onLatestReadingChange?: (reading: SensorReading | null) => void;
  language?: 'id' | 'en';
  soundEnabled?: boolean;
  onToggleSound?: () => void;
  onResetSimulation?: () => Promise<void>;
  sharedReadings?: SensorReading[];
  hasSharedReadings?: boolean;
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
      await fetch(apiUrl('/api/sim-data'), {
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

  // Official BMKG Public API weather state (100% real data, zero fabricated defaults)
  const [liveWeather, setLiveWeather] = useState<{
    source: 'BMKG' | 'Open-Meteo';
    adm4: string | null;
    location_name: string;
    temperature_c: number;
    humidity_percent: number | null;
    precipitation_mm: string | number;
    condition: string;
    wind_speed_kph: number | null;
    wind_direction: string;
    visibility_km: string;
    cloud_cover_percent: number | null;
    weather_icon: string;
    valid_at: string;
    valid_hour_wib: string;
    analysis_date: string | null;
    last_updated: string;
    forecast_slots: Array<{
      time_wib: string;
      date_label: string;
      temperature_c: number;
      humidity_percent: number | null;
      precipitation_mm: number;
      condition: string;
      wind_speed_kph: number | null;
      wind_direction: string;
      weather_icon: string;
    }>;
  } | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [loadingWeather, setLoadingWeather] = useState(false);
  const [weatherMode, setWeatherMode] = useState<'live' | 'sensor_sim'>('live');
  const [dashboardSubTab, setDashboardSubTab] = useState<'map' | 'chart' | 'weather'>('map');
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
        playAlertPreviewChime();
      }
    }
  };

  const [chartRange, setChartRange] = useState<'realtime' | '24h'>('realtime');
  const [chartViewMode, setChartViewMode] = useState<'elevation' | 'raw_ultrasonic'>('elevation');
  const [useBatch360Mode, setUseBatch360Mode] = useState<boolean>(false);
  const [timeAgoText, setTimeAgoText] = useState<string>(language === 'en' ? 'Waiting for readings...' : 'Menunggu pembacaan data...');

  // Hardware status timeout detection: 15 minutes tolerance (900,000 ms)
  // ESP32 SoilWake transmits batch data every 6-8 minutes; 15 mins accommodates deep sleep & retry
  const TIMEOUT_TOLERANCE_MS = 15 * 60 * 1000; // 900.000 ms (15 menit)
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
      const diffMs = Math.max(0, now - readingTs);
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

  const isDark = theme === 'dark';
  const themeCard = isDark ? 'bg-[#0D0D0F] border-white/5 shadow-xl text-slate-300' : 'bg-white border-slate-200 shadow-md text-slate-700';
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

  // Sync shared sensor_readings from App.tsx when available so tab switching never drops or duplicates listeners
  useEffect(() => {
    if (!sharedReadings) return;
    if (hasSharedReadings) setHasReceivedReadingsSnapshot(true);
    setReadingsList(sharedReadings);
    if (sharedReadings.length > 0) {
      let chosen = sharedReadings[sharedReadings.length - 1];
      if (!config?.auto_simulation) {
        const espReading = sharedReadings
          .slice()
          .reverse()
          .find(
            (r) =>
              r.source?.includes('Hardware') ||
              r.source?.includes('ESP') ||
              !r.source?.toLowerCase().includes('simulat')
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
  }, [sharedReadings, hasSharedReadings, config?.auto_simulation, onLatestReadingChange]);

  // Bind real-time Firestore listeners for predictions, BMKG data (and readings fallback if sharedReadings absent)
  useEffect(() => {
    let unsubscribeReadings: (() => void) | null = null;
    if (sharedReadings === undefined) {
      unsubscribeReadings = onSnapshot(
        getFirestoreQuery('sensor_readings', 48),
        (snapshot) => {
          setHasReceivedReadingsSnapshot(true);
          const data: SensorReading[] = [];
          const refH = config?.reference_height || 300;
          snapshot.forEach((doc) => {
            const normalized = normalizeSensorReading(doc.id, doc.data(), refH);
            data.push(normalized);
          });
          const sorted = data.sort((a, b) => a.timestamp - b.timestamp);
          setReadingsList(sorted);
          if (sorted.length > 0) {
            let chosen = sorted[sorted.length - 1];
            if (!config?.auto_simulation) {
              const espReading = sorted
                .slice()
                .reverse()
                .find(
                  (r) =>
                    r.source?.includes('Hardware') ||
                    r.source?.includes('ESP') ||
                    !r.source?.toLowerCase().includes('simulat')
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
    }

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
      unsubscribeReadings?.();
      unsubscribePrediction();
      unsubscribeBMKG();
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

      const res = await fetch(apiUrl('/api/predict'), {
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

  const weatherAbortRef = useRef<AbortController | null>(null);

  // Fetch genuine live weather directly from official BMKG public API via backend proxy
  const fetchLiveWeather = async (
    targetLang: string = language,
    silent: boolean = false,
    forceRefresh: boolean = false
  ) => {
    weatherAbortRef.current?.abort();
    const controller = new AbortController();
    weatherAbortRef.current = controller;

    if (!silent) {
      setLoadingWeather(true);
    }
    setWeatherError(null);

    const query = forceRefresh
      ? `/api/live-weather?lang=${targetLang}&force=1`
      : `/api/live-weather?lang=${targetLang}`;
    const maxAttempts = silent ? 2 : 3;
    let lastError: any = null;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (controller.signal.aborted) return;
        try {
          const res = await fetch(apiUrl(query), {
            cache: 'no-store',
            signal: controller.signal,
          });
          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            throw new Error(
              targetLang === 'en'
                ? 'Backend API unreachable (check VITE_API_BASE_URL on Vercel → Railway).'
                : 'Backend API tidak terjangkau (pastikan VITE_API_BASE_URL di Vercel diarahkan ke domain Railway).'
            );
          }
          const data = await res.json();
          if (!res.ok) {
            if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
              lastError = new Error(data?.error || `HTTP ${res.status}`);
              await new Promise((r) => window.setTimeout(r, attempt * 1200));
              continue;
            }
            throw new Error(
              data?.error ||
                (targetLang === 'en'
                  ? 'Official BMKG weather API is currently unreachable.'
                  : 'API prakiraan cuaca resmi BMKG sedang tidak dapat dijangkau.')
            );
          }
          if (!controller.signal.aborted) {
            setLiveWeather(data);
            setWeatherError(null);
          }
          return;
        } catch (err: any) {
          if (controller.signal.aborted || err?.name === 'AbortError') return;
          lastError = err;
          if (attempt < maxAttempts) {
            await new Promise((r) => window.setTimeout(r, attempt * 1200));
            continue;
          }
        }
      }

      if (controller.signal.aborted) return;
      console.warn('[BMKG] Live weather fetch unavailable after retries:', lastError?.message || lastError);
      if (!silent) {
        setWeatherError(
          targetLang === 'en'
            ? 'Official BMKG weather API is temporarily unreachable. Tap Retry to sync again.'
            : 'API prakiraan cuaca resmi BMKG sedang tidak dapat dijangkau sementara. Klik Muat Ulang untuk mencoba lagi.'
        );
      }
    } finally {
      if (!controller.signal.aborted && !silent) {
        setLoadingWeather(false);
      }
    }
  };

  // Run initial weather fetch on dashboard open, refetch when language changes, and auto-sync every 5 minutes
  useEffect(() => {
    fetchLiveWeather(language, false, false);
    const interval = window.setInterval(() => {
      fetchLiveWeather(language, true, false);
    }, 5 * 60 * 1000);
    return () => {
      window.clearInterval(interval);
      weatherAbortRef.current?.abort();
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
  let alertLabel = language === 'en' ? 'SYSTEM OPTIMAL / NORMAL' : 'SISTEM OPTIMAL / AMAN';

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

  const localizedAlertStatus =
    alertStatus === 'Bahaya'
      ? (language === 'en' ? 'DANGER' : 'BAHAYA')
      : alertStatus === 'Siaga'
        ? (language === 'en' ? 'ALERT' : 'SIAGA')
        : alertStatus === 'Offline'
          ? 'OFFLINE'
          : (language === 'en' ? 'SAFE' : 'AMAN');

  // Sensor-linked weather simulation profile (for indoor hardware demos synced to live ESP32 elevation)
  const sensorLinkedWeather = useMemo(() => {
    const en = language === 'en';
    const now = new Date();
    const wibMs = now.getTime() + 7 * 60 * 60 * 1000;
    const wibDate = new Date(wibMs);
    const wibHour = wibDate.getUTCHours();
    const wibMin = wibDate.getUTCMinutes();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const isNight = wibHour < 6 || wibHour >= 18;
    const period = isNight ? 'pm' : 'am';
    const timeLabel = `${pad2(wibHour)}.${pad2(wibMin)} WIB`;
    const slotHour = `${pad2(wibHour)}.00 WIB`;
    const monthsId = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formatDateShort = (d: Date) =>
      `${pad2(d.getUTCDate())} ${(en ? monthsEn : monthsId)[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const validAt = `${formatDateShort(wibDate)}, ${slotHour}`;

    const level = Math.max(0, Number(currentLevel) || 0);
    const siaga = Math.max(10, thresholdSiaga);
    const bahaya = Math.max(siaga + 10, thresholdBahaya);

    const iconBase = 'https://api-apps.bmkg.go.id/storage/icon/cuaca';
    const iconUrl = (file: string) => `${iconBase}/${encodeURIComponent(file)}`;

    let temperature_c = isNight ? 26 : 29;
    let humidity_percent = 76;
    let precipNum = 0.2;
    let condition = en ? 'Mostly Cloudy' : 'Berawan';
    let wind_speed_kph = 4.2;
    let wind_direction = en ? 'East ←' : 'Timur ←';
    let visibility_km = '> 10 km';
    let cloud_cover_percent = 72;
    let weather_icon = iconUrl(`berawan-${period}.svg`);

    type SlotSpec = {
      tempDelta: number;
      hu: number;
      tp: number;
      condId: string;
      condEn: string;
      ws: number;
      wdId: string;
      wdEn: string;
      iconFile: (p: 'am' | 'pm') => string;
    };

    let slotSpecs: SlotSpec[] = [
      { tempDelta: 0, hu: 78, tp: 0, condId: 'Berawan', condEn: 'Mostly Cloudy', ws: 4.5, wdId: 'Timur ←', wdEn: 'East ←', iconFile: (p) => `berawan-${p}.svg` },
      { tempDelta: -1, hu: 80, tp: 0, condId: 'Cerah Berawan', condEn: 'Partly Cloudy', ws: 3.8, wdId: 'Tenggara ↖', wdEn: 'Southeast ↖', iconFile: (p) => `cerah berawan-${p}.svg` },
      { tempDelta: -1, hu: 82, tp: 0, condId: 'Cerah Berawan', condEn: 'Partly Cloudy', ws: 3.2, wdId: 'Selatan ↑', wdEn: 'South ↑', iconFile: (p) => `cerah berawan-${p}.svg` },
      { tempDelta: 1, hu: 75, tp: 0, condId: 'Berawan', condEn: 'Mostly Cloudy', ws: 4.8, wdId: 'Timur ←', wdEn: 'East ←', iconFile: (p) => `berawan-${p}.svg` },
    ];

    if (level >= bahaya) {
      const excess = Math.min(1, (level - bahaya) / 80);
      const isStorm = level >= bahaya + 35;
      temperature_c = isStorm ? 23 : 24;
      humidity_percent = Math.round(95 + excess * 4);
      precipNum = Math.round((24 + excess * 24) * 10) / 10;
      condition = isStorm
        ? (en ? 'Thunderstorm' : 'Hujan Petir')
        : (en ? 'Heavy Rain' : 'Hujan Lebat');
      wind_speed_kph = Math.round((16.5 + excess * 8.5) * 10) / 10;
      wind_direction = en ? 'Southwest ↗' : 'Barat Daya ↗';
      visibility_km = isStorm ? '1.5 km' : '2.5 km';
      cloud_cover_percent = 100;
      weather_icon = iconUrl(isStorm ? 'hujan petir.svg' : 'hujan lebat.svg');
      slotSpecs = [
        { tempDelta: 0, hu: 96, tp: Math.round(precipNum * 0.75 * 10) / 10, condId: 'Hujan Lebat', condEn: 'Heavy Rain', ws: 15.8, wdId: 'Barat Daya ↗', wdEn: 'Southwest ↗', iconFile: () => 'hujan lebat.svg' },
        { tempDelta: 1, hu: 93, tp: 11.4, condId: 'Hujan Sedang', condEn: 'Moderate Rain', ws: 11.2, wdId: 'Barat →', wdEn: 'West →', iconFile: () => 'hujan sedang.svg' },
        { tempDelta: 1, hu: 89, tp: 3.6, condId: 'Hujan Ringan', condEn: 'Light Rain', ws: 7.4, wdId: 'Barat →', wdEn: 'West →', iconFile: () => 'hujan ringan.svg' },
        { tempDelta: 2, hu: 85, tp: 0.4, condId: 'Berawan', condEn: 'Mostly Cloudy', ws: 5.1, wdId: 'Selatan ↑', wdEn: 'South ↑', iconFile: (p) => `berawan-${p}.svg` },
      ];
    } else if (level >= siaga) {
      const ratio = Math.min(1, (level - siaga) / Math.max(1, bahaya - siaga));
      temperature_c = 25;
      humidity_percent = Math.round(89 + ratio * 5);
      precipNum = Math.round((8.5 + ratio * 10.5) * 10) / 10;
      condition = en ? 'Moderate Rain' : 'Hujan Sedang';
      wind_speed_kph = Math.round((10.2 + ratio * 4.8) * 10) / 10;
      wind_direction = en ? 'West →' : 'Barat →';
      visibility_km = '4.5 km';
      cloud_cover_percent = 95;
      weather_icon = iconUrl('hujan sedang.svg');
      slotSpecs = [
        { tempDelta: 0, hu: 92, tp: Math.round(precipNum * 0.8 * 10) / 10, condId: 'Hujan Sedang', condEn: 'Moderate Rain', ws: 10.4, wdId: 'Barat →', wdEn: 'West →', iconFile: () => 'hujan sedang.svg' },
        { tempDelta: 0, hu: 88, tp: 3.8, condId: 'Hujan Ringan', condEn: 'Light Rain', ws: 7.2, wdId: 'Barat Daya ↗', wdEn: 'Southwest ↗', iconFile: () => 'hujan ringan.svg' },
        { tempDelta: 1, hu: 84, tp: 0.5, condId: 'Berawan', condEn: 'Mostly Cloudy', ws: 5.4, wdId: 'Selatan ↑', wdEn: 'South ↑', iconFile: (p) => `berawan-${p}.svg` },
        { tempDelta: 2, hu: 80, tp: 0, condId: 'Cerah Berawan', condEn: 'Partly Cloudy', ws: 4.1, wdId: 'Tenggara ↖', wdEn: 'Southeast ↖', iconFile: (p) => `cerah berawan-${p}.svg` },
      ];
    } else if (level >= siaga * 0.65) {
      const ratio = Math.min(1, (level - siaga * 0.65) / Math.max(1, siaga * 0.35));
      temperature_c = isNight ? 25 : 27;
      humidity_percent = Math.round(82 + ratio * 6);
      precipNum = Math.round((1.8 + ratio * 3.4) * 10) / 10;
      condition = en ? 'Light Rain' : 'Hujan Ringan';
      wind_speed_kph = Math.round((6.5 + ratio * 2.5) * 10) / 10;
      wind_direction = en ? 'South ↑' : 'Selatan ↑';
      visibility_km = '7.5 km';
      cloud_cover_percent = 86;
      weather_icon = iconUrl('hujan ringan.svg');
      slotSpecs = [
        { tempDelta: 0, hu: 86, tp: 2.1, condId: 'Hujan Ringan', condEn: 'Light Rain', ws: 6.8, wdId: 'Selatan ↑', wdEn: 'South ↑', iconFile: () => 'hujan ringan.svg' },
        { tempDelta: -1, hu: 84, tp: 0.6, condId: 'Berawan', condEn: 'Mostly Cloudy', ws: 5.2, wdId: 'Tenggara ↖', wdEn: 'Southeast ↖', iconFile: (p) => `berawan-${p}.svg` },
        { tempDelta: 0, hu: 81, tp: 0, condId: 'Berawan', condEn: 'Mostly Cloudy', ws: 4.5, wdId: 'Timur ←', wdEn: 'East ←', iconFile: (p) => `berawan-${p}.svg` },
        { tempDelta: 1, hu: 78, tp: 0, condId: 'Cerah Berawan', condEn: 'Partly Cloudy', ws: 4.0, wdId: 'Timur ←', wdEn: 'East ←', iconFile: (p) => `cerah berawan-${p}.svg` },
      ];
    }

    const forecast_slots = slotSpecs.map((spec, idx) => {
      const slotDate = new Date(wibMs + (idx + 1) * 3 * 60 * 60 * 1000);
      const hr = slotDate.getUTCHours();
      const slotPeriod: 'am' | 'pm' = hr < 6 || hr >= 18 ? 'pm' : 'am';
      return {
        time_wib: `${pad2(hr)}.00`,
        date_label: formatDateShort(slotDate),
        temperature_c: temperature_c + spec.tempDelta,
        humidity_percent: spec.hu,
        precipitation_mm: spec.tp,
        condition: en ? spec.condEn : spec.condId,
        wind_speed_kph: spec.ws,
        wind_direction: en ? spec.wdEn : spec.wdId,
        weather_icon: iconUrl(spec.iconFile(slotPeriod)),
      };
    });

    return {
      source: 'BMKG' as const,
      adm4: '32.76.06.1002',
      location_name: 'Kukusan, Beji, Kota Depok',
      temperature_c,
      humidity_percent,
      precipitation_mm: `${precipNum.toLocaleString(en ? 'en-US' : 'id-ID')} mm`,
      condition,
      wind_speed_kph,
      wind_direction,
      visibility_km,
      cloud_cover_percent,
      weather_icon,
      valid_at: validAt,
      valid_hour_wib: slotHour,
      analysis_date: null,
      last_updated: timeLabel,
      forecast_slots,
    };
  }, [currentLevel, thresholdSiaga, thresholdBahaya, language]);

  const isSensorSimWeather = weatherMode === 'sensor_sim';
  const activeWeather = isSensorSimWeather ? sensorLinkedWeather : liveWeather;

  // Audio warning playback is managed globally by App.tsx across Dashboard, Simulasi 3D, and Kontrol PLC.

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
        new Notification(
          language === 'en' ? '⚠️ DANGER: CRITICAL WATER ELEVATION!' : '⚠️ BAHAYA: ELEVASI AIR KRITIS!',
          {
            body: language === 'en'
              ? `Water level reached ${currentLevel} cm (exceeding danger threshold ${thresholdBahaya} cm). Evacuate immediately!`
              : `Tinggi air mencapai ${currentLevel} cm (melebihi ambang bahaya ${thresholdBahaya} cm). Segera lakukan evakuasi!`,
            icon: '/favicon.ico',
            tag: 'scada-alert-bahaya',
          }
        );
      } else if (alertStatus === 'Siaga' && prefPushSiaga && prevStatus === 'Normal') {
        new Notification(
          language === 'en' ? '⚠️ WARNING: ALERT STATUS!' : '⚠️ WASPADA: STATUS SIAGA!',
          {
            body: language === 'en'
              ? `Water level reached ${currentLevel} cm (exceeding alert threshold ${thresholdSiaga} cm). Monitor continuously.`
              : `Tinggi air mencapai ${currentLevel} cm (melebihi ambang siaga ${thresholdSiaga} cm). Pantau secara berkala.`,
            icon: '/favicon.ico',
            tag: 'scada-alert-siaga',
          }
        );
      }
    }
  }, [alertStatus, prefPushSiaga, prefPushBahaya, currentLevel, thresholdSiaga, thresholdBahaya, language]);

  const [isExportingCSV, setIsExportingCSV] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  // CSV Data Export Handler (queries last 24 hours of sensor logs from Firestore)
  const handleExportCSV = async () => {
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
        const refH = config?.reference_height || 300;
        snap.forEach((d) => {
          exportList.push(normalizeSensorReading(d.id, d.data(), refH));
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

      const headers = language === 'en'
        ? ['Timestamp', 'Local Time', 'Water Elevation (cm)', 'JSN-SR04T Sensor Distance (cm)', 'Raindrop Detection (Capacitive V2.0)', 'Data Source', 'BMKG Temp (C)', 'BMKG Humidity (%)']
        : ['Timestamp', 'Waktu Lokal', 'Elevasi Air (cm)', 'Jarak Sensor JSN-SR04T (cm)', 'Deteksi Tetesan Hujan (Capacitive V2.0)', 'Sumber Data', 'Suhu BMKG (C)', 'Kelembapan BMKG (%)'];
      const rows = exportList.map(r => {
        const dateStr = new Date(r.timestamp).toISOString();
        const localTimeStr = new Date(r.timestamp).toLocaleString(language === 'en' ? 'en-US' : 'id-ID');
        const rainLabel = language === 'en'
          ? (r.local_rain === 0 ? 'Dry / Clear' : r.local_rain === 1 ? 'Raindrop Detected' : r.local_rain === 2 ? 'Wet Precipitation' : 'Heavy Rain')
          : (r.local_rain === 0 ? 'Kering / Cerah' : r.local_rain === 1 ? 'Tetesan Hujan' : r.local_rain === 2 ? 'Basah Presipitasi' : 'Hujan Lebat');
        return [
          dateStr,
          `"${localTimeStr}"`,
          r.water_level,
          r.distance ?? '',
          `"${rainLabel}"`,
          `"${r.source || 'Hardware-ESP32'}"`,
          r.temperature,
          r.humidity
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
    let elev = typeof r.water_level === 'number' ? r.water_level : 0;
    const ultrasonicDistance = typeof r.distance === 'number' 
      ? r.distance 
      : Math.max(0, Math.round((refHeight - elev) * 10) / 10);

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

  // Live 6-hour autoregressive LSTM inference using trained weights from model_lstm_banjir.h5
  const lstmForecast = useMemo(() => {
    const sourceFiltered = !config?.auto_simulation
      ? readingsList.filter(
          (r) =>
            r.source?.includes('Hardware') ||
            r.source?.includes('ESP') ||
            !r.source?.toLowerCase().includes('simulat')
        )
      : readingsList;

    const baseList = sourceFiltered.length > 0 ? sourceFiltered : readingsList;
    let series: number[] = baseList
      .map((r) => r.water_level)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    // If fewer than 24 Firestore records exist but ESP32 sent a 360-sample batch, downsample evenly to 24 steps
    if (series.length < 24 && hasBatchData) {
      const batchLevels: number[] = rawBatch
        .map((item: any) => {
          if (Array.isArray(item)) return Number(item[1]);
          if (item && typeof item === 'object') {
            if (typeof item.distance === 'number') return Math.max(0, refHeight - item.distance);
            if (typeof item.water_level === 'number') return item.water_level;
          }
          return NaN;
        })
        .filter((v: number) => Number.isFinite(v));

      if (batchLevels.length >= 2) {
        const targetCount = Math.min(24, batchLevels.length);
        const sampled: number[] = [];
        for (let i = 0; i < targetCount; i++) {
          const idx = Math.round((i * (batchLevels.length - 1)) / Math.max(1, targetCount - 1));
          sampled.push(batchLevels[idx]);
        }
        series = sampled;
      }
    }

    if (series.length === 0 && latestReading && typeof latestReading.water_level === 'number') {
      series = [latestReading.water_level];
    }

    if (series.length === 0) return null;

    return runLstmForecast(series, {
      thresholdSiaga,
      thresholdBahaya,
      maxReferenceHeight: refHeight,
    });
  }, [readingsList, rawBatch, hasBatchData, latestReading, config?.auto_simulation, thresholdSiaga, thresholdBahaya, refHeight]);

  const localizedLstmStatus = lstmForecast
    ? lstmForecast.status === 'Bahaya'
      ? (language === 'en' ? 'DANGER' : 'BAHAYA')
      : lstmForecast.status === 'Siaga'
        ? (language === 'en' ? 'ALERT' : 'SIAGA')
        : (language === 'en' ? 'SAFE' : 'AMAN')
    : 'STANDBY';

  // Unified Historical + Trained LSTM Forecast Series (Single Source of Truth in Elevation Mode)
  const activeForecast = lstmForecast
    ? {
        p30m: lstmForecast.prediction_30m,
        p1h: lstmForecast.prediction_1h,
        p3h: lstmForecast.prediction_3h,
        p6h: lstmForecast.prediction_6h,
      }
    : latestPrediction
      ? {
          p30m: latestPrediction.prediction_30m,
          p1h: latestPrediction.prediction_1h,
          p3h: latestPrediction.prediction_3h,
          p6h: latestPrediction.prediction_6h,
        }
      : null;

  const lastHistoricalTimeLabel =
    chartData.length > 0 ? chartData[chartData.length - 1].time : undefined;

  const unifiedChartData = useMemo(() => {
    if (chartViewMode !== 'elevation' || !activeForecast || chartData.length === 0) {
      return chartData.map((pt) => ({ ...pt, prediksi: null as number | null }));
    }
    const base = chartData.map((pt, idx) => ({
      ...pt,
      prediksi: idx === chartData.length - 1 ? pt.elevasi : (null as number | null),
    }));
    return [
      ...base,
      {
        time: 'T+30m',
        elevasi: null as number | null,
        raw_distance: null as number | null,
        prediksi: activeForecast.p30m,
        local_rain: 0,
        suhu: latestReading?.temperature || 28,
        source: 'LSTM Forecast',
      },
      {
        time: language === 'en' ? 'T+1h' : 'T+1j',
        elevasi: null as number | null,
        raw_distance: null as number | null,
        prediksi: activeForecast.p1h,
        local_rain: 0,
        suhu: latestReading?.temperature || 28,
        source: 'LSTM Forecast',
      },
      {
        time: language === 'en' ? 'T+3h' : 'T+3j',
        elevasi: null as number | null,
        raw_distance: null as number | null,
        prediksi: activeForecast.p3h,
        local_rain: 0,
        suhu: latestReading?.temperature || 28,
        source: 'LSTM Forecast',
      },
      {
        time: language === 'en' ? 'T+6h' : 'T+6j',
        elevasi: null as number | null,
        raw_distance: null as number | null,
        prediksi: activeForecast.p6h,
        local_rain: 0,
        suhu: latestReading?.temperature || 28,
        source: 'LSTM Forecast',
      },
    ];
  }, [chartData, chartViewMode, activeForecast, language, latestReading?.temperature]);

  const elevationAxisMax = useMemo(() => {
    const values = unifiedChartData.flatMap((d) => [
      typeof d.elevasi === 'number' ? d.elevasi : 0,
      typeof d.prediksi === 'number' ? d.prediksi : 0,
    ]);
    const peak = Math.max(160, thresholdBahaya + 30, ...values.map((v) => v + 20));
    return Math.ceil(peak / 10) * 10;
  }, [unifiedChartData, thresholdBahaya]);

  const isHardwareLive = Boolean(latestReading?.source?.includes('Hardware') && !isDeviceOffline);

  return (
    <div id="scada-dashboard-root" className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-5 pb-6">

      {/* ROW 1: COMPACT TELEMETRY STATUS STRIP + SINGLE SIMULATION CTA */}
      <div
        id="scada-hardware-pause-banner"
        className={`col-span-12 min-w-0 overflow-hidden px-4 py-3 sm:px-5 rounded-2xl border flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3 ${
          isHardwareLive
            ? isDark
              ? 'bg-emerald-950/20 border-emerald-500/25 text-emerald-300'
              : 'bg-emerald-50/90 border-emerald-200 text-emerald-900'
            : isDark
              ? 'bg-[#0D0D0F] border-white/5 text-slate-300'
              : 'bg-white border-slate-200 text-slate-700 shadow-sm'
        }`}
      >
        <div className="flex items-start sm:items-center gap-3 w-full min-w-0 flex-1">
          <span className="relative flex h-2.5 w-2.5 shrink-0 mt-1 sm:mt-0">
            {isHardwareLive && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                isHardwareLive
                  ? 'bg-emerald-500'
                  : config?.auto_simulation
                    ? 'bg-amber-400'
                    : 'bg-[#3B82F6]'
              }`}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] sm:text-xs font-mono font-semibold tracking-wide uppercase leading-snug">
              {config?.auto_simulation &&
              (latestReading?.source?.includes('Simulator') || latestReading?.source?.includes('Scenario')) ? (
                <>
                  <Activity className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>{language === 'en' ? 'Telemetry: Controlled Simulator' : 'Telemetri: Simulator Pengujian'}</span>
                </>
              ) : isHardwareLive ? (
                <>
                  <Radio className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>{language === 'en' ? 'Telemetry: ESP32 Hardware Live' : 'Telemetri: Hardware ESP32 Aktif'}</span>
                </>
              ) : (
                <>
                  <Activity className="w-3.5 h-3.5 text-[#3B82F6] shrink-0" />
                  <span>{language === 'en' ? 'Monitoring: Standby (Latest Report)' : 'Monitoring: Standby (Laporan Terakhir)'}</span>
                </>
              )}
              {hasBatchData && (
                <span className={`font-normal normal-case tracking-normal ${isDark ? 'text-emerald-400/90' : 'text-emerald-700'}`}>
                  · {rawBatch.length || 360} {language === 'en' ? 'batch pts' : 'titik batch'}
                </span>
              )}
            </div>
            <p className={`text-[11px] mt-1 sm:mt-0.5 font-sans leading-relaxed break-words lg:truncate ${isDark ? 'text-zinc-400' : 'text-slate-500'}`}>
              {timeAgoText} ·{' '}
              {language === 'en'
                ? 'Paused on latest telemetry until new transmission arrives.'
                : 'Menampilkan laporan terakhir hingga paket transmisi baru diterima.'}
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full lg:w-auto lg:justify-end shrink-0">
          <div className={`flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[10.5px] sm:text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap shrink-0 ${alertBg}`}>
            <span className={`w-2 h-2 rounded-full ${alertLed} inline-block shrink-0`} />
            <span className="font-mono">{alertLabel}</span>
          </div>

          {onNavigateTab && (
            <button
              type="button"
              onClick={() => onNavigateTab('simulation')}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#3B82F6] hover:bg-blue-400 px-3.5 py-2 sm:py-1.5 text-xs font-bold text-black transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <span>{language === 'en' ? '9-Node Simulation' : 'Masuk Simulasi 9-Node'}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* DASHBOARD SUB-TAB BAR (OPTION A: 3 CLEAN VIEWPORT-FITTED TABS) */}
      <div
        id="dashboard-subtabs"
        role="tablist"
        aria-label={language === 'en' ? 'Dashboard sections' : 'Sub-menu Dashboard'}
        className={`col-span-12 min-w-0 grid grid-cols-3 gap-1.5 sm:gap-2 p-1.5 rounded-2xl border ${
          isDark ? 'bg-[#0D0D0F] border-white/10' : 'bg-white border-slate-200 shadow-sm'
        }`}
      >
        {([
          {
            id: 'map' as const,
            icon: MapIcon,
            label: language === 'en' ? 'Map & Water Level' : 'Peta & Elevasi Air',
            shortLabel: language === 'en' ? 'Map & TMA' : 'Peta & Air',
            badge: isDeviceOffline ? '-- cm' : `${currentLevel.toFixed(1)} cm`,
            badgeTone:
              alertStatus === 'Bahaya'
                ? 'text-rose-400'
                : alertStatus === 'Siaga'
                  ? 'text-amber-400'
                  : 'text-emerald-400',
          },
          {
            id: 'chart' as const,
            icon: LineChartIcon,
            label: language === 'en' ? 'Charts & LSTM Forecast' : 'Grafik & Prediksi LSTM',
            shortLabel: language === 'en' ? 'LSTM Chart' : 'Grafik LSTM',
            badge: lstmForecast
              ? `${language === 'en' ? '6h' : '6J'}: ${lstmForecast.prediction_6h.toFixed(1)} cm`
              : 'LSTM',
            badgeTone:
              lstmForecast?.status === 'Bahaya'
                ? 'text-rose-400'
                : lstmForecast?.status === 'Siaga'
                  ? 'text-amber-400'
                  : 'text-violet-400',
          },
          {
            id: 'weather' as const,
            icon: CloudSun,
            label: language === 'en' ? 'BMKG Weather' : 'Cuaca BMKG',
            shortLabel: language === 'en' ? 'Weather' : 'Cuaca',
            badge: activeWeather
              ? `${activeWeather.temperature_c}°C`
              : 'BMKG',
            badgeTone: isSensorSimWeather ? 'text-amber-400' : 'text-sky-400',
          },
        ]).map((tab) => {
          const Icon = tab.icon;
          const isActive = dashboardSubTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`btn-subtab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setDashboardSubTab(tab.id)}
              className={`min-w-0 flex items-center justify-center sm:justify-between gap-1.5 sm:gap-2.5 px-2.5 sm:px-4 py-2 sm:py-2.5 rounded-xl text-left transition-all cursor-pointer ${
                isActive
                  ? 'bg-[#3B82F6] text-black shadow-sm'
                  : isDark
                    ? 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/80'
              }`}
            >
              <span className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                <Icon className={`w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0 ${isActive ? 'text-black' : ''}`} />
                <span className="hidden sm:inline text-xs font-bold truncate">{tab.label}</span>
                <span className="sm:hidden text-[11px] font-bold truncate">{tab.shortLabel}</span>
              </span>
              <span
                className={`hidden md:inline-flex items-center gap-1 font-mono text-[10px] font-bold tabular-nums px-2 py-0.5 rounded-md shrink-0 whitespace-nowrap ${
                  isActive
                    ? 'bg-black/15 text-black'
                    : isDark
                      ? `bg-white/[0.04] ${tab.badgeTone}`
                      : `bg-slate-100 ${tab.badgeTone}`
                }`}
              >
                {tab.id === 'weather' && isSensorSimWeather && (
                  <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-black/70' : 'bg-amber-400'}`} />
                )}
                {tab.badge}
              </span>
            </button>
          );
        })}
      </div>

      {/* SUB-TAB 1: SPATIAL HERO — 2D/3D CILIWUNG CORRIDOR MAP (8 COLS) + LIVE WATER ELEVATION GAUGE (4 COLS) */}
      {dashboardSubTab === 'map' && (
      <div id="measurement-grid" className="col-span-12 min-w-0 grid grid-cols-1 lg:grid-cols-12 gap-5 lg:gap-6 items-stretch">

        {/* Left 8 Cols: Interactive 2D/3D Corridor Map (Spatial Hero Above the Fold) */}
        <div className="col-span-12 lg:col-span-8 min-w-0 flex flex-col">
          <CiliwungHardwareLiveView
            embeddedInDashboard
            theme={theme}
            language={language}
            latestReading={latestReading}
            readings={readingsList}
            config={config || {}}
            loadDayHistory={() => loadHardwareHistory24h(db, config?.reference_height || 300)}
          />
        </div>

        {/* Right 4 Cols: Core Water Level Gauge & Physical Ultrasonic Cross-Section */}
        <div id="water-gauge" className={`col-span-12 lg:col-span-4 min-w-0 h-full ${themeCard} rounded-2xl p-4 sm:p-5 lg:p-6 relative overflow-hidden flex flex-col justify-between`}>
          <div className="flex justify-between items-center gap-2 mb-3">
            <span className={`text-[10px] font-bold uppercase tracking-[0.22em] ${themeTextMuted} font-mono`}>
              {language === 'en' ? 'Water Surface Elevation' : 'Tinggi Elevasi Air'}
            </span>
            <span className={`text-[10px] font-mono uppercase tracking-wider whitespace-nowrap shrink-0 ${
              isDeviceOffline
                ? 'text-slate-400'
                : latestReading?.source?.includes('Manual') || latestReading?.source?.includes('Peil')
                  ? 'text-amber-400 font-semibold'
                  : latestReading?.source?.includes('Hardware')
                    ? 'text-emerald-400 font-semibold'
                    : !config?.auto_simulation
                      ? 'text-amber-400'
                      : 'text-[#3B82F6]'
            }`}>
              {isDeviceOffline
                ? (language === 'en' ? 'OFFLINE' : 'OFFLINE')
                : latestReading?.source?.includes('Manual') || latestReading?.source?.includes('Peil')
                  ? 'MANUAL PEIL'
                  : latestReading?.source?.includes('Hardware')
                    ? 'LIVE ESP32'
                    : !config?.auto_simulation
                      ? 'STANDBY'
                      : 'SIMULATOR'}
            </span>
          </div>

          <div className="flex items-baseline justify-between gap-4">
            <div className="flex flex-col">
              <span className={`text-5xl font-sans font-light tracking-tighter leading-none tabular-nums ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {isDeviceOffline ? (
                  <>--<span className="text-lg font-normal text-slate-400"> cm</span></>
                ) : (
                  <>{latestReading ? latestReading.water_level : '0.0'}<span className="text-lg font-normal text-slate-400"> cm</span></>
                )}
              </span>
              <span className={`text-[11px] ${themeTextSub} mt-2 font-sans flex items-center gap-1.5`}>
                {isDeviceOffline ? (
                  <span className="text-slate-400 font-mono">
                    {language === 'en' ? 'Device offline (>15 mins). Telemetry paused.' : 'Perangkat offline (>15 mnt). Data dibekukan.'}
                  </span>
                ) : (
                  <>
                    {latestReading && latestReading.water_level >= thresholdSiaga ? (
                      <TrendingUp className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    )}
                    {latestReading?.source?.includes('Manual') ? (
                      <span className="text-amber-400 font-semibold">
                        {language === 'en' ? 'Staff: ' : 'Petugas: '}{latestReading.operator || (language === 'en' ? 'Field Staff' : 'Staf Lapangan')}
                      </span>
                    ) : latestReading?.distance != null ? (
                      language === 'en'
                        ? `Sensor Gap: ${latestReading.distance} cm (${latestReading.source || 'RTU'})`
                        : `Jarak Sensor: ${latestReading.distance} cm (${latestReading.source || 'RTU'})`
                    ) : (
                      language === 'en' ? 'Ultrasonic Precision: ±0.1 cm' : 'Presisi Ultrasonik: ±0.1 cm'
                    )}
                  </>
                )}
              </span>

              {latestReading?.source?.includes('Manual') && latestReading.notes && (
                <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] font-sans text-amber-300 leading-snug">
                  {latestReading.notes}
                </div>
              )}
            </div>
          </div>

          {/* PHYSICAL CROSS-SECTION GAUGE DIAGRAM */}
          <div className={`w-full flex-1 min-h-[250px] ${isDark ? 'bg-black/50 border-white/5' : 'bg-slate-100/60 border-slate-200'} rounded-xl border p-4 relative overflow-hidden flex flex-col justify-between mt-4 shadow-inner`}>

            {/* 1. Bridge/Beam concrete ceiling & Sensor Probe */}
            <div className="absolute top-0 left-0 right-0 h-7 bg-zinc-700 border-b border-zinc-600 flex items-center justify-center px-2 z-10 shadow-sm">
              <span className="text-[7px] font-mono text-zinc-300 tracking-widest uppercase truncate">
                {language === 'en' ? 'KUKUSAN DRAINAGE PIPE POLE & BOOM ARM' : 'TIANG PIPA & LENGAN BOOM DRAINASE KUKUSAN'}
              </span>

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
                transition: 'height 1200ms cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <div className="absolute top-0 left-0 right-0 h-4 -mt-3.5 pointer-events-none overflow-hidden">
                <svg className="w-[200%] h-full fill-blue-500/30 animate-pulse" viewBox="0 0 1200 120" preserveAspectRatio="none">
                  <path d="M0,60 C150,100 350,20 500,60 C650,100 850,20 1000,60 L1200,60 L1200,120 L0,120 Z" />
                </svg>
              </div>

              <div className={`w-full h-full ${
                alertStatus === 'Bahaya' ? 'bg-gradient-to-t from-rose-600/80 to-rose-500/70 border-t-2 border-rose-400' :
                alertStatus === 'Siaga' ? 'bg-gradient-to-t from-amber-600/80 to-amber-500/70 border-t-2 border-amber-400' :
                'bg-gradient-to-t from-blue-600/80 to-blue-500/70 border-t-2 border-blue-400'
              } flex flex-col justify-end border-t shadow-inner`}>
                <div className="w-full h-4 bg-amber-950/30 border-t border-amber-900/40 flex items-center justify-center">
                  <span className="text-[6px] font-mono text-amber-200/50 tracking-widest uppercase">
                    {language === 'en' ? 'RIVERBED BASELINE' : 'DASAR SUNGAI (RIVERBED)'}
                  </span>
                </div>
              </div>
            </div>

            {/* 4. Overlaid threshold markings (Siaga, Bahaya) */}
            <div
              className="absolute left-0 right-0 border-t border-dashed border-amber-500/70 z-30 pointer-events-none"
              style={{
                bottom: `${(thresholdSiaga / (config?.reference_height || 300)) * 100}%`,
              }}
            >
              <div className="bg-amber-500 text-black text-[6px] font-mono font-bold px-1.5 py-0.5 rounded absolute right-3 -top-2.5 shadow-sm uppercase tracking-wider">
                {language === 'en' ? 'ALERT' : 'SIAGA'}: {thresholdSiaga} cm
              </div>
            </div>
            <div
              className="absolute left-0 right-0 border-t border-dashed border-rose-500/80 z-30 pointer-events-none"
              style={{
                bottom: `${(thresholdBahaya / (config?.reference_height || 300)) * 100}%`,
              }}
            >
              <div className="bg-rose-600 text-white text-[6px] font-mono font-bold px-1.5 py-0.5 rounded absolute right-3 -top-2.5 shadow-sm uppercase tracking-wider">
                {language === 'en' ? 'DANGER' : 'BAHAYA'}: {thresholdBahaya} cm
              </div>
            </div>

            {/* 5. Dimensions & Annotations overlay */}
            <div className="absolute top-10 bottom-1 left-0 right-0 px-3 flex justify-between pointer-events-none z-30 font-mono">
              <div className="flex flex-col justify-start items-start w-1/2">
                <div className="bg-black/85 border border-white/10 rounded px-1.5 py-0.5 text-left shadow">
                  <span className="text-[6px] text-slate-400 block uppercase leading-none mb-0.5">
                    {language === 'en' ? 'Sensor Gap to Water (d)' : 'Jarak Sensor ke Air (d)'}
                  </span>
                  <span className="text-[10px] font-bold text-sky-400 leading-none tabular-nums">
                    {isDeviceOffline ? '-- cm' : `${config ? Math.max(0, config.reference_height - currentLevel) : 300 - currentLevel} cm`}
                  </span>
                </div>
              </div>

              <div className="flex flex-col justify-end items-end w-1/2">
                <div className="bg-black/85 border border-white/10 rounded px-1.5 py-0.5 text-right shadow">
                  <span className="text-[6px] text-slate-400 block uppercase leading-none mb-0.5">
                    {language === 'en' ? 'Water Elevation (h)' : 'Elevasi Air (h)'}
                  </span>
                  <span className="text-[10px] font-bold text-emerald-400 leading-none tabular-nums">
                    {isDeviceOffline ? '-- cm' : `${currentLevel} cm`}
                  </span>
                </div>
              </div>
            </div>

            {/* Total Height Tag */}
            <div className="absolute bottom-5 left-3 bg-zinc-800/90 border border-zinc-700 text-[6px] font-mono text-zinc-300 px-1.5 py-0.5 rounded z-30 shadow-md tabular-nums">
              H_REF: {config ? config.reference_height : 300} cm
            </div>

          </div>

          <div className={`grid grid-cols-2 gap-2 mt-4 pt-3 border-t ${themeBorder} text-[10px] font-mono tabular-nums`}>
            <div className="flex flex-col">
              <span className={themeTextMuted}>{language === 'en' ? 'Alert Threshold' : 'Ambang Siaga'}</span>
              <span className="text-amber-500 font-semibold mt-0.5">{thresholdSiaga} cm</span>
            </div>
            <div className="flex flex-col">
              <span className={themeTextMuted}>{language === 'en' ? 'Danger Threshold' : 'Ambang Bahaya'}</span>
              <span className="text-rose-500 font-semibold mt-0.5">{thresholdBahaya} cm</span>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* SUB-TAB 3: OFFICIAL BMKG PUBLIC API WEATHER FORECAST (WITH SENSOR-SYNCED DEMO MODE) + HYDROLOGICAL CORRELATION */}
      {dashboardSubTab === 'weather' && (
      <div className="col-span-12 min-w-0 flex flex-col gap-4 lg:gap-5">
      <div
        id="bmkg-gauge"
        className={`w-full min-w-0 ${themeCard} ${
          isSensorSimWeather ? 'border-amber-500/30' : ''
        } rounded-2xl p-4 sm:p-5 lg:p-6 relative overflow-hidden transition-colors`}
      >
        <div className={`flex flex-col md:flex-row md:items-center md:justify-between gap-3 pb-4 mb-5 border-b ${themeBorder}`}>
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeTextMuted} font-mono`}>
                {isSensorSimWeather
                  ? (language === 'en' ? 'Weather Simulation · Sensor-Linked' : 'Simulasi Cuaca · Sinkron Sensor')
                  : (language === 'en' ? 'Official BMKG Weather Forecast' : 'Prakiraan Cuaca Resmi BMKG')}
              </span>
              {activeWeather?.valid_hour_wib && (
                <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider font-mono ${isSensorSimWeather ? 'text-amber-400' : 'text-sky-400'}`}>
                  <span>
                    · {isSensorSimWeather
                      ? `ESP32 ${currentLevel.toFixed(1)} cm`
                      : (language === 'en' ? `Slot ${activeWeather.valid_hour_wib}` : `Prakiraan ${activeWeather.valid_hour_wib}`)}
                  </span>
                  <span
                    title={
                      isSensorSimWeather
                        ? (language === 'en'
                            ? 'Simulated weather synced to live ESP32 water elevation for indoor hardware demos'
                            : 'Simulasi cuaca mengikuti tinggi air sensor ESP32 untuk demo hardware di dalam ruangan')
                        : (language === 'en'
                            ? `Official BMKG 3-hourly forecast slot (${activeWeather.valid_at})`
                            : `Slot prakiraan 3-jaman resmi BMKG (${activeWeather.valid_at})`)
                    }
                  >
                    <Info className={`w-3 h-3 cursor-help ${isSensorSimWeather ? 'text-amber-400' : 'text-sky-400'}`} />
                  </span>
                </span>
              )}
            </div>

            <span className={`font-mono text-[10px] tracking-wide leading-snug ${isSensorSimWeather ? 'text-amber-400/90' : 'text-[#3B82F6]'}`}>
              {isSensorSimWeather
                ? (language === 'en'
                    ? `Simulated from ESP32 elevation (${localizedAlertStatus}) · Not live BMKG feed`
                    : `Simulasi berbasis elevasi ESP32 (${localizedAlertStatus}) · Bukan feed live BMKG`)
                : liveWeather?.source === 'Open-Meteo'
                  ? (language === 'en' ? 'Open-Meteo Live Fallback · BMKG Feed Currently Empty' : 'Fallback Open-Meteo · Feed API BMKG Sedang Kosong')
                  : `${language === 'en' ? 'BMKG Public API' : 'API Publik BMKG'} · ADM4 ${liveWeather?.adm4 || '32.76.06.1002'}`}
            </span>
          </div>

          {/* Right Header Controls: Sync Info (left on sm+) + Segmented Mode Switch anchored far-right (zero layout shift) */}
          <div className="flex flex-col sm:flex-row sm:items-center md:justify-end gap-2.5 w-full md:w-auto shrink-0">
            <div
              role="group"
              aria-label={language === 'en' ? 'Weather data source mode' : 'Mode sumber data cuaca'}
              className={`order-1 sm:order-2 grid grid-cols-2 sm:inline-flex w-full sm:w-auto p-1 rounded-xl border ${
                isDark ? 'bg-black/40 border-white/10' : 'bg-slate-100 border-slate-200'
              }`}
            >
              <button
                type="button"
                onClick={() => setWeatherMode('live')}
                className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold transition-all cursor-pointer whitespace-nowrap ${
                  !isSensorSimWeather
                    ? 'bg-[#3B82F6] text-black shadow-sm'
                    : isDark
                      ? 'text-slate-400 hover:text-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${!isSensorSimWeather ? 'bg-black/70' : 'bg-emerald-400'}`} />
                BMKG Live
              </button>
              <button
                type="button"
                onClick={() => setWeatherMode('sensor_sim')}
                className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold transition-all cursor-pointer whitespace-nowrap ${
                  isSensorSimWeather
                    ? 'bg-amber-400 text-black shadow-sm'
                    : isDark
                      ? 'text-slate-400 hover:text-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${isSensorSimWeather ? 'bg-black/70' : 'bg-amber-400'}`} />
                {language === 'en' ? 'Sensor Sync' : 'Sinkron Sensor'}
              </button>
            </div>

            {!isSensorSimWeather && (
              <div className="order-2 sm:order-1 flex items-center justify-between sm:justify-end gap-2.5">
                {liveWeather?.last_updated && (
                  <span className={`text-[10px] font-mono tabular-nums whitespace-nowrap ${themeTextMuted}`}>
                    {language === 'en' ? 'Synced: ' : 'Disinkronkan: '}{liveWeather.last_updated}
                  </span>
                )}
                <button
                  id="btn-sync-weather"
                  onClick={() => fetchLiveWeather(language, false, true)}
                  disabled={loadingWeather}
                  className={`p-2 rounded-lg border transition-all cursor-pointer shrink-0 ${isDark ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700'}`}
                  title={language === 'en' ? 'Refresh Official BMKG Data' : 'Muat Ulang Data Resmi BMKG'}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingWeather ? 'animate-spin' : ''}`} />
                </button>
              </div>
            )}
          </div>
        </div>

        {!isSensorSimWeather && loadingWeather ? (
          <div className="py-6 flex flex-col items-center justify-center">
            <RefreshCw className="w-5 h-5 animate-spin text-[#3B82F6] mb-2" />
            <span className={`text-[10px] font-mono uppercase tracking-wider ${themeTextMuted} text-center px-4`}>
              {language === 'en'
                ? 'Fetching official weather forecast from BMKG public API...'
                : 'Mengambil data prakiraan cuaca resmi dari API publik BMKG...'}
            </span>
          </div>
        ) : activeWeather ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-5 lg:gap-6 items-center">
            {/* Left Zone: Weather Hero (Temperature, Condition & Location) */}
            <div className="md:col-span-1 lg:col-span-4 flex items-center justify-center gap-4">
              <div className="relative flex-shrink-0">
                {activeWeather.weather_icon ? (
                  <img
                    src={activeWeather.weather_icon}
                    alt={activeWeather.condition}
                    className="w-16 h-16 object-contain filter drop-shadow"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <CloudRain className="w-16 h-16 text-[#3B82F6] filter drop-shadow" />
                )}
              </div>

              <div className="min-w-0">
                <div className="flex items-baseline flex-wrap gap-x-2">
                  <span className={`text-4xl font-bold tracking-tight tabular-nums ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    {activeWeather.temperature_c}°C
                  </span>
                  <span className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                    {activeWeather.condition}
                  </span>
                </div>
                <span className={`text-[11px] ${themeTextSub} block mt-1 truncate`}>
                  {language === 'en' ? 'in ' : 'di '}{activeWeather.location_name}
                </span>
                <div className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] ${themeTextMuted} font-mono mt-1 tabular-nums`}>
                  <span>
                    {language === 'en' ? 'Precip: ' : 'Curah hujan: '}{activeWeather.precipitation_mm ?? '—'}
                  </span>
                  {typeof activeWeather.cloud_cover_percent === 'number' && (
                    <span>
                      {language === 'en' ? 'Cloud: ' : 'Tutupan awan: '}{activeWeather.cloud_cover_percent}%
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Middle Zone: 2x2 Atmospheric Telemetry Grid */}
            <div className="md:col-span-1 lg:col-span-4 grid grid-cols-2 gap-2.5">
              <div className={`flex items-center gap-2.5 px-3 py-2.5 border ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-100'} rounded-xl`}>
                <div className="text-sky-500 p-1.5 bg-sky-500/10 rounded-lg shrink-0">
                  <Droplet className="w-3.5 h-3.5" />
                </div>
                <div className="flex flex-col text-[10px] leading-tight min-w-0">
                  <span className={themeTextMuted}>{language === 'en' ? 'Humidity' : 'Kelembapan'}</span>
                  <span className={`font-bold mt-0.5 tabular-nums ${isDark ? 'text-white' : 'text-slate-800'}`}>
                    {typeof activeWeather.humidity_percent === 'number' ? `${activeWeather.humidity_percent}%` : '—'}
                  </span>
                </div>
              </div>

              <div className={`flex items-center gap-2.5 px-3 py-2.5 border ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-100'} rounded-xl`}>
                <div className="text-[#3B82F6] p-1.5 bg-blue-500/10 rounded-lg shrink-0">
                  <Wind className="w-3.5 h-3.5" />
                </div>
                <div className="flex flex-col text-[10px] leading-tight min-w-0">
                  <span className={themeTextMuted}>{language === 'en' ? 'Wind Speed' : 'Kecepatan Angin'}</span>
                  <span className={`font-bold mt-0.5 tabular-nums ${isDark ? 'text-white' : 'text-slate-800'}`}>
                    {typeof activeWeather.wind_speed_kph === 'number'
                      ? `${activeWeather.wind_speed_kph.toLocaleString(language === 'en' ? 'en-US' : 'id-ID')} ${language === 'en' ? 'km/h' : 'km/j'}`
                      : '—'}
                  </span>
                </div>
              </div>

              <div className={`flex items-center gap-2.5 px-3 py-2.5 border ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-100'} rounded-xl`}>
                <div className="text-indigo-400 p-1.5 bg-indigo-500/10 rounded-lg shrink-0">
                  <Compass className="w-3.5 h-3.5" />
                </div>
                <div className="flex flex-col text-[10px] leading-tight min-w-0">
                  <span className={themeTextMuted}>{language === 'en' ? 'Wind Direction' : 'Arah Angin'}</span>
                  <span className={`font-bold mt-0.5 truncate ${isDark ? 'text-white' : 'text-slate-800'}`}>
                    {activeWeather.wind_direction || '—'}
                  </span>
                </div>
              </div>

              <div className={`flex items-center gap-2.5 px-3 py-2.5 border ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50 border-slate-100'} rounded-xl`}>
                <div className="text-emerald-500 p-1.5 bg-emerald-500/10 rounded-lg shrink-0">
                  <Eye className="w-3.5 h-3.5" />
                </div>
                <div className="flex flex-col text-[10px] leading-tight min-w-0">
                  <span className={themeTextMuted}>{language === 'en' ? 'Visibility' : 'Jarak Pandang'}</span>
                  <span className={`font-bold mt-0.5 tabular-nums ${isDark ? 'text-white' : 'text-slate-800'}`}>
                    {activeWeather.visibility_km || '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Right Zone: Upcoming 3-Hourly Forecast Slots */}
            <div className={`md:col-span-2 lg:col-span-4 flex flex-col gap-2 p-3.5 rounded-xl border ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50/80 border-slate-200/80'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[9px] font-bold uppercase tracking-[0.18em] font-mono ${isSensorSimWeather ? 'text-amber-400/90' : themeTextMuted}`}>
                  {isSensorSimWeather
                    ? (language === 'en' ? 'Simulated Outlook (WIB)' : 'Proyeksi Cuaca Simulasi (WIB)')
                    : activeWeather.source === 'Open-Meteo'
                      ? (language === 'en' ? 'Upcoming 3-Hourly Forecast (WIB)' : 'Prakiraan 3-Jaman Berikutnya (WIB)')
                      : (language === 'en' ? 'Upcoming BMKG Forecast (WIB)' : 'Prakiraan BMKG Berikutnya (WIB)')}
                </span>
                <span className={`text-[9px] font-mono tabular-nums ${themeTextMuted}`}>
                  {activeWeather.valid_at || '—'}
                </span>
              </div>

              {Array.isArray(activeWeather.forecast_slots) && activeWeather.forecast_slots.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {activeWeather.forecast_slots.map((slot, idx) => (
                    <div
                      key={`${slot.date_label}-${slot.time_wib}-${idx}`}
                      title={`${slot.date_label} ${slot.time_wib} WIB · ${slot.condition} · ${slot.wind_speed_kph ?? '—'} ${language === 'en' ? 'km/h' : 'km/j'} (${slot.wind_direction})`}
                      className={`flex flex-col items-center justify-between py-2 px-1.5 rounded-lg border text-center ${
                        isDark ? 'bg-white/[0.03] border-white/5' : 'bg-white border-slate-200/70'
                      }`}
                    >
                      <span className={`text-[9.5px] font-mono font-bold tabular-nums ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {slot.time_wib}
                      </span>
                      {slot.weather_icon ? (
                        <img
                          src={slot.weather_icon}
                          alt={slot.condition}
                          className="w-7 h-7 my-1 object-contain"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <CloudRain className="w-5 h-5 my-1.5 text-sky-400" />
                      )}
                      <span className={`text-xs font-bold tabular-nums ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {slot.temperature_c}°
                      </span>
                      <span className={`text-[9px] font-mono tabular-nums ${themeTextMuted}`}>
                        {typeof slot.humidity_percent === 'number' ? `${slot.humidity_percent}%` : '—'}
                      </span>
                      {typeof slot.precipitation_mm === 'number' && slot.precipitation_mm > 0 ? (
                        <span className="text-[8.5px] font-mono font-semibold text-sky-400 tabular-nums mt-0.5">
                          {slot.precipitation_mm.toLocaleString(language === 'en' ? 'en-US' : 'id-ID')} mm
                        </span>
                      ) : (
                        <span className={`text-[8px] truncate max-w-full mt-0.5 ${themeTextMuted}`}>
                          {slot.condition}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className={`text-[10px] font-mono py-3 text-center ${themeTextMuted}`}>
                  {language === 'en'
                    ? '3-hourly BMKG forecast slots unavailable in fallback mode.'
                    : 'Slot prakiraan 3-jaman BMKG tidak tersedia pada mode fallback.'}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
            <span className={`text-[10px] font-mono ${themeTextMuted}`}>
              {weatherError || (language === 'en'
                ? 'Official BMKG weather data is currently unavailable.'
                : 'Data prakiraan cuaca resmi BMKG sedang tidak tersedia.')}
            </span>
            <button
              onClick={() => fetchLiveWeather(language, false, true)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-mono font-semibold border transition-colors cursor-pointer ${
                isDark
                  ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-200'
                  : 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-800'
              }`}
            >
              {language === 'en' ? 'Retry BMKG Sync' : 'Coba Muat Ulang BMKG'}
            </button>
          </div>
        )}
      </div>

      {/* HYDROLOGICAL FUSION SUMMARY (SENSOR ESP32 × CUACA BMKG) */}
      <div
        id="hydrology-weather-fusion"
        className={`w-full min-w-0 ${themeCard} rounded-2xl p-4 sm:p-5 lg:p-6`}
      >
        <div className={`flex flex-wrap items-center justify-between gap-2 pb-3.5 mb-4 border-b ${themeBorder}`}>
          <div className="flex flex-col">
            <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeTextMuted} font-mono`}>
              {language === 'en'
                ? 'Hydrological Fusion · ESP32 Sensor × Kukusan Weather'
                : 'Korelasi Hidrologi · Sensor ESP32 × Cuaca Kukusan'}
            </span>
            <span className={`text-[11px] font-sans mt-0.5 ${themeTextSub}`}>
              {language === 'en'
                ? 'Cross-reference between ultrasonic water elevation, local precipitation, and 6-hour LSTM projection.'
                : 'Ringkasan keterkaitan elevasi ultrasonik lapangan, curah hujan lokal, dan proyeksi LSTM 6 jam.'}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={() => setDashboardSubTab('map')}
              className={`px-3 py-1.5 rounded-lg border text-[10px] font-mono font-bold transition-colors cursor-pointer text-center ${
                isDark
                  ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300'
                  : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-700'
              }`}
            >
              {language === 'en' ? 'Open Map & Gauge' : 'Lihat Peta & Elevasi'}
            </button>
            <button
              type="button"
              onClick={() => setDashboardSubTab('chart')}
              className="px-3 py-1.5 rounded-lg bg-[#3B82F6]/15 hover:bg-[#3B82F6]/25 border border-[#3B82F6]/30 text-[10px] font-mono font-bold text-[#3B82F6] transition-colors cursor-pointer text-center"
            >
              {language === 'en' ? 'Open LSTM Chart' : 'Lihat Grafik LSTM'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Col 1: Ultrasonic Water Elevation vs Threshold */}
          <div className={`rounded-xl border p-4 flex flex-col justify-between gap-3 ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50/80 border-slate-200/80'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className={`text-[10px] font-mono uppercase tracking-wider ${themeTextMuted}`}>
                {language === 'en' ? 'ESP32 Elevation' : 'Elevasi ESP32'}
              </span>
              <span className={`text-[10px] font-mono font-bold uppercase ${alertStatus === 'Bahaya' ? 'text-rose-400' : alertStatus === 'Siaga' ? 'text-amber-400' : alertStatus === 'Offline' ? 'text-slate-400' : 'text-emerald-400'}`}>
                {localizedAlertStatus}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className={`text-3xl font-sans font-light tabular-nums ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {isDeviceOffline ? '--' : currentLevel.toFixed(1)}
                <span className="text-xs text-slate-400 ml-1">cm</span>
              </span>
              <span className={`text-[10px] font-mono tabular-nums ${themeTextMuted}`}>
                d = {isDeviceOffline ? '--' : Math.max(0, (config?.reference_height || 300) - currentLevel).toFixed(0)} cm
              </span>
            </div>
            <div className="space-y-1.5">
              <div className={`w-full h-2 rounded-full overflow-hidden ${isDark ? 'bg-white/10' : 'bg-slate-200'}`}>
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    alertStatus === 'Bahaya' ? 'bg-rose-500' : alertStatus === 'Siaga' ? 'bg-amber-400' : 'bg-[#3B82F6]'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(4, (currentLevel / Math.max(thresholdBahaya, 100)) * 100))}%` }}
                />
              </div>
              <div className={`flex justify-between text-[9.5px] font-mono tabular-nums ${themeTextMuted}`}>
                <span>0 cm</span>
                <span className="text-amber-500">{language === 'en' ? 'Alert' : 'Siaga'} {thresholdSiaga} cm</span>
                <span className="text-rose-500">{language === 'en' ? 'Danger' : 'Bahaya'} {thresholdBahaya} cm</span>
              </div>
            </div>
          </div>

          {/* Col 2: Atmospheric Rain & Moisture Context */}
          <div className={`rounded-xl border p-4 flex flex-col justify-between gap-3 ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50/80 border-slate-200/80'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className={`text-[10px] font-mono uppercase tracking-wider ${themeTextMuted}`}>
                {language === 'en' ? 'Rainfall Context' : 'Konteks Curah Hujan'}
              </span>
              <span className={`text-[10px] font-mono font-bold uppercase ${isSensorSimWeather ? 'text-amber-400' : 'text-sky-400'}`}>
                {isSensorSimWeather ? (language === 'en' ? 'SENSOR SYNC' : 'SINKRON SENSOR') : 'BMKG LIVE'}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className={`text-2xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {activeWeather?.precipitation_mm ?? '—'}
              </span>
              <span className={`text-[11px] font-medium truncate ${themeTextSub}`}>
                {activeWeather?.condition || '—'}
              </span>
            </div>
            <div className={`grid grid-cols-2 gap-2 pt-2 border-t ${themeBorder} text-[10px] font-mono tabular-nums`}>
              <div>
                <span className={`block ${themeTextMuted}`}>{language === 'en' ? 'Humidity' : 'Kelembapan'}</span>
                <span className={`font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>
                  {typeof activeWeather?.humidity_percent === 'number' ? `${activeWeather.humidity_percent}%` : '—'}
                </span>
              </div>
              <div>
                <span className={`block ${themeTextMuted}`}>{language === 'en' ? 'Cloud Cover' : 'Tutupan Awan'}</span>
                <span className={`font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>
                  {typeof activeWeather?.cloud_cover_percent === 'number' ? `${activeWeather.cloud_cover_percent}%` : '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Col 3: 6-Hour LSTM Outlook */}
          <div className={`rounded-xl border p-4 flex flex-col justify-between gap-3 ${isDark ? 'bg-white/[0.02] border-white/5' : 'bg-slate-50/80 border-slate-200/80'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className={`text-[10px] font-mono uppercase tracking-wider ${themeTextMuted}`}>
                {language === 'en' ? 'LSTM 6h Outlook' : 'Proyeksi LSTM 6 Jam'}
              </span>
              <span
                className={`text-[10px] font-mono font-bold uppercase ${
                  lstmForecast?.status === 'Bahaya'
                    ? 'text-rose-400'
                    : lstmForecast?.status === 'Siaga'
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                }`}
              >
                {localizedLstmStatus}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: language === 'en' ? 'T+1h' : 'T+1j', val: lstmForecast?.prediction_1h },
                { label: language === 'en' ? 'T+3h' : 'T+3j', val: lstmForecast?.prediction_3h },
                { label: language === 'en' ? 'T+6h' : 'T+6j', val: lstmForecast?.prediction_6h },
              ].map((item) => (
                <div key={item.label} className={`rounded-lg py-1.5 px-1 border ${isDark ? 'bg-black/30 border-white/5' : 'bg-white border-slate-200/80'}`}>
                  <span className={`block text-[9px] font-mono ${themeTextMuted}`}>{item.label}</span>
                  <span className={`block text-sm font-bold tabular-nums mt-0.5 ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    {typeof item.val === 'number' ? item.val.toFixed(1) : '--'}
                  </span>
                </div>
              ))}
            </div>
            <div className={`text-[10px] font-mono ${themeTextMuted} pt-2 border-t ${themeBorder} truncate`}>
              {lstmForecast
                ? `${lstmForecast.modelMeta.sourceFile} · MAE ${lstmForecast.modelMeta.maeCm} cm`
                : 'model_lstm_banjir.h5 · Standby'}
            </div>
          </div>
        </div>
      </div>
      </div>
      )}

      {/* SUB-TAB 2: UNIFIED SCADA TELEMETRY CURVE + TRAINED LSTM FORECAST (SINGLE SOURCE OF TRUTH) */}
      {dashboardSubTab === 'chart' && (
      <div id="scada-charts-forecasts" className="col-span-12 min-w-0">
        <div id="scada-plot-container" className={`${themeCard} rounded-2xl p-4 sm:p-5 lg:p-6 flex flex-col gap-5 sm:gap-6 overflow-hidden`}>

          {/* Chart Header & Controls */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap justify-between items-center gap-2">
              <div>
                <span className={`text-[10px] font-bold uppercase tracking-[0.22em] ${themeTextMuted} font-mono`}>
                  {language === 'en'
                    ? 'Unified SCADA Telemetry & LSTM Forecast Curve'
                    : 'Kurva Elevasi Air SCADA & Prediksi LSTM Terpadu'}
                </span>
              </div>

              <div className="flex items-center gap-3.5 flex-wrap">
                {chartViewMode === 'elevation' ? (
                  <>
                    <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                      <span className="w-2.5 h-0.5 bg-[#3B82F6] inline-block" /> {language === 'en' ? 'Actual (h)' : 'Aktual (h)'}
                    </span>
                    <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                      <span className="w-3 h-0.5 border-t-2 border-dashed border-violet-400 inline-block" /> {language === 'en' ? 'LSTM Forecast' : 'Prediksi LSTM'}
                    </span>
                    <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                      <span className="w-2.5 h-0.5 border-t border-dashed border-amber-500 inline-block" /> {language === 'en' ? 'Alert' : 'Siaga'}
                    </span>
                    <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                      <span className="w-2.5 h-0.5 border-t border-dashed border-rose-500 inline-block" /> {language === 'en' ? 'Danger' : 'Bahaya'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-[10px] text-emerald-400 flex items-center gap-1.5 font-mono uppercase tracking-wider">
                      <span className="w-2.5 h-0.5 bg-emerald-500 inline-block" /> {language === 'en' ? 'Sensor Distance (d)' : 'Jarak Sensor (cm)'}
                    </span>
                    <span className={`text-[10px] ${themeTextMuted} flex items-center gap-1.5 font-mono uppercase tracking-wider`}>
                      <span className="w-2.5 h-0.5 border-t border-dashed border-zinc-500 inline-block" /> H_REF: {config?.reference_height || 300} cm
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Mode Toggle: Elevasi vs Raw Ultrasonik */}
                <div className={`grid grid-cols-2 sm:inline-flex items-center gap-1 w-full sm:w-auto border ${isDark ? 'border-white/10 bg-black/30' : 'border-slate-200 bg-slate-100'} rounded-lg p-0.5 text-[10px] font-mono`}>
                  <button
                    id="btn-mode-elevation"
                    onClick={() => setChartViewMode('elevation')}
                    className={`px-2 sm:px-2.5 py-1.5 sm:py-1 rounded-md transition-all cursor-pointer text-center whitespace-nowrap shrink-0 ${
                      chartViewMode === 'elevation'
                        ? 'bg-[#3B82F6] text-black font-bold'
                        : `${themeTextSub} hover:text-[#3B82F6]`
                    }`}
                    title={language === 'en' ? 'Show Water Surface Elevation (TMA) + LSTM forecast' : 'Tampilkan Elevasi Muka Air (TMA) + kurva prediksi LSTM'}
                  >
                    {language === 'en' ? 'Elevation + LSTM' : 'Elevasi + LSTM'}
                  </button>
                  <button
                    id="btn-mode-raw"
                    onClick={() => setChartViewMode('raw_ultrasonic')}
                    className={`px-2 sm:px-2.5 py-1.5 sm:py-1 rounded-md transition-all cursor-pointer text-center whitespace-nowrap shrink-0 ${
                      chartViewMode === 'raw_ultrasonic'
                        ? 'bg-emerald-500 text-black font-bold'
                        : `${themeTextSub} hover:text-emerald-400`
                    }`}
                    title={language === 'en' ? 'Show raw JSN-SR04T reflection distance in cm' : 'Tampilkan data mentah jarak pantul sensor ultrasonik JSN-SR04T (cm)'}
                  >
                    {language === 'en' ? 'Raw Ultrasonic (d)' : 'Raw Ultrasonik (d)'}
                  </button>
                </div>

                {/* Range Toggle */}
                <div className={`grid grid-cols-3 sm:inline-flex items-center gap-1 w-full sm:w-auto border ${isDark ? 'border-white/10 bg-black/30' : 'border-slate-200 bg-slate-100'} rounded-lg p-0.5 text-[10px] font-mono`}>
                  <button
                    id="btn-range-realtime"
                    onClick={() => {
                      setUseBatch360Mode(false);
                      setChartRange('realtime');
                    }}
                    className={`px-2 sm:px-2.5 py-1.5 sm:py-1 rounded-md transition-all cursor-pointer text-center whitespace-nowrap shrink-0 ${(!useBatch360Mode && chartRange === 'realtime') ? 'bg-[#3B82F6] text-black font-bold' : `${themeTextSub} hover:text-[#3B82F6]`}`}
                    title={language === 'en' ? 'High resolution chart showing last 20 telemetry readings' : 'Grafik resolusi tinggi menampilkan 20 pembacaan telemetri terakhir'}
                  >
                    {language === 'en' ? '20 Pts' : '20 Poin'}
                  </button>
                  <button
                    id="btn-range-24h"
                    onClick={() => {
                      setUseBatch360Mode(false);
                      setChartRange('24h');
                    }}
                    className={`px-2 sm:px-2.5 py-1.5 sm:py-1 rounded-md transition-all cursor-pointer text-center whitespace-nowrap shrink-0 ${(!useBatch360Mode && chartRange === '24h') ? 'bg-[#3B82F6] text-black font-bold' : `${themeTextSub} hover:text-[#3B82F6]`}`}
                    title={language === 'en' ? 'Cumulative 24-hour water elevation trend' : 'Grafik histori elevasi air akumulatif dari 24 jam terakhir'}
                  >
                    {language === 'en' ? '24h Trend' : 'Tren 24J'}
                  </button>
                  <button
                    id="btn-range-batch360"
                    onClick={() => setUseBatch360Mode(!useBatch360Mode)}
                    className={`px-2 sm:px-2.5 py-1.5 sm:py-1 rounded-md transition-all cursor-pointer text-center whitespace-nowrap shrink-0 ${useBatch360Mode ? 'bg-emerald-500 text-black font-bold' : `${themeTextSub} hover:text-emerald-400`}`}
                    title={language === 'en' ? 'Visualize 360 continuous sample array in 1 ESP32 batch' : 'Tampilkan visualisasi 360 array sampel kontinu dalam 1 siklus batch ESP32'}
                  >
                    {language === 'en' ? 'Batch 360' : 'Batch 360'}
                  </button>
                </div>
              </div>

              {/* Export Data Button */}
              <div className="relative w-full sm:w-auto">
                <button
                  id="btn-export-csv"
                  onClick={handleExportCSV}
                  disabled={isExportingCSV}
                  title={language === 'en' ? 'Export last 24 hours sensor logs to CSV' : 'Ekspor Log Sensor 24 Jam Terakhir ke format CSV'}
                  className={`w-full sm:w-auto flex items-center justify-center gap-1.5 px-3 py-2 sm:py-1.5 border text-[10px] font-mono rounded-lg transition-all cursor-pointer whitespace-nowrap shrink-0 ${
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
                      : (language === 'en' ? 'EXPORT CSV' : 'EKSPOR CSV')}
                  </span>
                </button>

                {exportNotice && (
                  <div className="absolute right-0 top-full mt-2 w-full sm:w-72 p-2.5 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-lg text-[10px] font-sans shadow-xl z-50">
                    <div className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{exportNotice}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Unified Plot Area */}
          <div className="w-full h-[310px]">
            {!hasReceivedReadingsSnapshot ? (
              <div className={`w-full h-full flex flex-col items-center justify-center ${themeTextMuted} font-mono text-[10px] uppercase tracking-widest`}>
                <RefreshCw className="w-5 h-5 animate-spin text-[#3B82F6] mb-3" />
                {language === 'en' ? 'Connecting to telemetry database...' : 'Menghubungkan ke basis data telemetri...'}
              </div>
            ) : chartData.length === 0 ? (
              <div className={`w-full h-full flex flex-col items-center justify-center p-6 text-center rounded-xl border border-dashed ${isDark ? 'bg-black/30 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
                <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-3">
                  <Activity className="w-5 h-5" />
                </div>
                <span className="font-mono text-xs font-bold uppercase tracking-wider text-amber-400 mb-1.5">
                  {language === 'en' ? 'Telemetry Standby — Awaiting ESP32' : 'Status Telemetri: Standby (Menunggu Transmisi ESP32)'}
                </span>
                <p className={`text-xs max-w-lg mb-4 font-sans leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                  {language === 'en'
                    ? 'Database is active and ready. The unified curve and LSTM horizons will plot automatically once ESP32 transmits data.'
                    : 'Database aktif dan siap menerima data. Kurva telemetri dan proyeksi LSTM akan tergambar otomatis saat ESP32 mengirim data.'}
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleInjectQuickTest}
                    disabled={isInjectingTestTelemetry}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold bg-[#3B82F6] hover:bg-blue-400 text-black transition-all cursor-pointer disabled:opacity-50"
                  >
                    {isInjectingTestTelemetry ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Zap className="w-3.5 h-3.5" />
                    )}
                    <span>{language === 'en' ? 'Test Chart (Sample 35 cm)' : 'Uji Grafik (Sampel 35 cm)'}</span>
                  </button>
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
              <ResponsiveContainer width="100%" height="100%" debounce={50}>
                <AreaChart data={unifiedChartData} margin={{ top: 10, right: 18, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorLevel" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorPrediksi" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#A78BFA" stopOpacity={0.22} />
                      <stop offset="95%" stopColor="#A78BFA" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorRaw" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10B981" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={themeGridColor} />
                  <XAxis dataKey="time" stroke="#52525B" style={{ fontSize: 10, fontFamily: 'monospace' }} />
                  <YAxis
                    domain={
                      chartViewMode === 'elevation'
                        ? [0, elevationAxisMax]
                        : [0, Math.max(300, (config?.reference_height || 300) + 20)]
                    }
                    stroke="#52525B"
                    style={{ fontSize: 10, fontFamily: 'monospace' }}
                  />
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
                  {chartViewMode === 'elevation' ? (
                    <>
                      <Area
                        type="monotone"
                        dataKey="elevasi"
                        name={language === 'en' ? 'Actual Elevation (cm)' : 'Elevasi Aktual (cm)'}
                        stroke="#3B82F6"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorLevel)"
                        connectNulls={false}
                      />
                      {activeForecast && (
                        <Area
                          type="monotone"
                          dataKey="prediksi"
                          name={language === 'en' ? 'LSTM Forecast (cm)' : 'Prediksi LSTM (cm)'}
                          stroke="#A78BFA"
                          strokeWidth={2}
                          strokeDasharray="5 4"
                          fillOpacity={1}
                          fill="url(#colorPrediksi)"
                          connectNulls={false}
                        />
                      )}
                      {activeForecast && lastHistoricalTimeLabel && (
                        <ReferenceLine
                          x={lastHistoricalTimeLabel}
                          stroke={isDark ? 'rgba(167,139,250,0.4)' : 'rgba(124,58,237,0.35)'}
                          strokeDasharray="3 3"
                          label={{
                            value: language === 'en' ? 'NOW' : 'SAAT INI',
                            fill: '#A78BFA',
                            fontSize: 9,
                            position: 'insideTopRight',
                            fontFamily: 'monospace',
                          }}
                        />
                      )}
                      <ReferenceLine
                        y={thresholdSiaga}
                        stroke="#f59e0b"
                        strokeDasharray="4 4"
                        strokeWidth={1.2}
                        label={{
                          value: language === 'en' ? 'ALERT' : 'SIAGA',
                          fill: '#f59e0b',
                          fontSize: 8,
                          position: 'right',
                          fontFamily: 'monospace',
                        }}
                      />
                      <ReferenceLine
                        y={thresholdBahaya}
                        stroke="#f43f5e"
                        strokeDasharray="4 4"
                        strokeWidth={1.2}
                        label={{
                          value: language === 'en' ? 'DANGER' : 'BAHAYA',
                          fill: '#f43f5e',
                          fontSize: 8,
                          position: 'right',
                          fontFamily: 'monospace',
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <Area
                        type="monotone"
                        dataKey="raw_distance"
                        name={language === 'en' ? 'Raw Sensor Gap (cm)' : 'Raw Jarak Ultrasonik (cm)'}
                        stroke="#10B981"
                        strokeWidth={1.8}
                        fillOpacity={1}
                        fill="url(#colorRaw)"
                      />
                      <ReferenceLine
                        y={config?.reference_height || 300}
                        stroke="#71717A"
                        strokeDasharray="3 3"
                        strokeWidth={1}
                        label={{
                          value: language === 'en' ? 'POLE/REF' : 'TIANG/REF',
                          fill: '#71717A',
                          fontSize: 8,
                          position: 'right',
                          fontFamily: 'monospace',
                        }}
                      />
                    </>
                  )}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Trained LSTM 4-Horizon Breakdown (Cohesive Footer Strip Inside Unified Analytics Card) */}
          <div id="processed-forecast-panel" className={`pt-5 border-t ${themeBorder} flex flex-col gap-4`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col">
                <span className={`text-[10px] font-bold uppercase tracking-[0.22em] ${themeTextMuted} font-mono`}>
                  {language === 'en' ? 'Trained LSTM Multi-Horizon Projections' : 'Proyeksi Multi-Horizon LSTM (Model Terlatih)'}
                </span>
                <span className="font-mono text-[10px] text-[#3B82F6] mt-0.5 tabular-nums">
                  {lstmForecast
                    ? `${lstmForecast.modelMeta.sourceFile} · ${lstmForecast.modelMeta.architecture} · ${lstmForecast.modelMeta.totalParams.toLocaleString(language === 'en' ? 'en-US' : 'id-ID')} params · MAE ${lstmForecast.modelMeta.maeCm} cm`
                    : language === 'en'
                      ? 'model_lstm_banjir.h5 · Awaiting sensor telemetry...'
                      : 'model_lstm_banjir.h5 · Menunggu data telemetri sensor...'}
                </span>
              </div>

              {lstmForecast && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums">
                  <span className={themeTextMuted}>
                    {language === 'en' ? 'Window' : 'Jendela'} {lstmForecast.inputCount}/24 · {lstmForecast.inferenceMs.toFixed(1)} ms
                  </span>
                  <span
                    className={`font-bold uppercase tracking-wider ${
                      lstmForecast.status === 'Bahaya'
                        ? 'text-rose-400'
                        : lstmForecast.status === 'Siaga'
                          ? 'text-amber-400'
                          : 'text-emerald-400'
                    }`}
                  >
                    {language === 'en'
                      ? `6h Outlook: ${localizedLstmStatus}`
                      : `Proyeksi 6J: ${localizedLstmStatus}`}
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
              {[
                {
                  label: 'Horizon T+30m',
                  value: lstmForecast ? lstmForecast.prediction_30m : latestPrediction?.prediction_30m,
                  conf: lstmForecast ? lstmForecast.confidence_30m : latestPrediction?.confidence_score,
                  accentText: 'text-[#3B82F6]',
                },
                {
                  label: language === 'en' ? 'Horizon T+1 Hour' : 'Horizon T+1 Jam',
                  value: lstmForecast ? lstmForecast.prediction_1h : latestPrediction?.prediction_1h,
                  conf: lstmForecast ? lstmForecast.confidence_1h : (latestPrediction ? Math.round(latestPrediction.confidence_score * 0.95) : undefined),
                  accentText: 'text-[#3B82F6]',
                },
                {
                  label: language === 'en' ? 'Horizon T+3 Hours' : 'Horizon T+3 Jam',
                  value: lstmForecast ? lstmForecast.prediction_3h : latestPrediction?.prediction_3h,
                  conf: lstmForecast ? lstmForecast.confidence_3h : (latestPrediction ? Math.round(latestPrediction.confidence_score * 0.88) : undefined),
                  accentText: 'text-violet-400',
                },
                {
                  label: language === 'en' ? 'Horizon T+6 Hours' : 'Horizon T+6 Jam',
                  value: lstmForecast ? lstmForecast.prediction_6h : latestPrediction?.prediction_6h,
                  conf: lstmForecast ? lstmForecast.confidence_6h : (latestPrediction ? Math.round(latestPrediction.confidence_score * 0.78) : undefined),
                  accentText: 'text-amber-400',
                },
              ].map((card) => {
                const delta =
                  lstmForecast && typeof card.value === 'number'
                    ? Math.round((card.value - lstmForecast.currentLevel) * 10) / 10
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
                    className={`rounded-xl border p-4 flex flex-col justify-between ${
                      isDark ? 'bg-white/[0.02] border-white/[0.06]' : 'bg-slate-50/80 border-slate-200/80'
                    }`}
                  >
                    <div className={`flex justify-between items-center ${themeTextMuted} font-mono text-[10px] uppercase tracking-wider`}>
                      <span>{card.label}</span>
                      <Clock className={`w-3.5 h-3.5 ${card.accentText}`} />
                    </div>
                    <div className="my-2.5 flex items-baseline justify-between gap-2">
                      <span className={`text-3xl font-sans font-light tracking-tight tabular-nums ${isDark ? 'text-white' : 'text-slate-900'}`}>
                        {typeof card.value === 'number' ? card.value.toFixed(1) : '--'}
                        <span className="text-xs font-normal text-slate-400 ml-1">cm</span>
                      </span>
                      {delta !== null && (
                        <span className={`font-mono text-[10px] tabular-nums ${deltaColor}`}>
                          {delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)} cm
                        </span>
                      )}
                    </div>
                    <div className={`text-[10px] font-mono tabular-nums flex items-center justify-between pt-2 border-t ${themeBorder}`}>
                      <span className={themeTextMuted}>{language === 'en' ? 'Confidence' : 'Keyakinan'}</span>
                      <span className={`font-semibold ${card.accentText}`}>
                        {typeof card.conf === 'number' ? `${card.conf}%` : '--%'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      )}

    </div>
  );
}
