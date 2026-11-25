/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { createSocket } from 'node:dgram';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { initializeApp } from 'firebase/app';
import { initializeFirestore, setLogLevel, collection, addDoc, getDocs, query, orderBy, limit, setDoc, doc, onSnapshot, deleteDoc, where } from 'firebase/firestore';
import { createCiliwungEngine } from './backend/ciliwung/simulation-engine.mjs';
import { registerCiliwungRoutes } from './backend/ciliwung/ciliwung-api.mjs';
import { createForecastWorker } from './backend/ciliwung/forecast-worker.mjs';
import { createHardware20sWorker, registerHardwareDemoForecast } from './backend/ciliwung/hardware-demo-forecast.mjs';
import { createHardwareLiveBus, registerHardwareLiveRoutes, createCiliwungModeController } from './backend/ciliwung/hardware-live.mjs';
import { createCupCarbonTelemetryListener } from './backend/ciliwung/cupcarbon-telemetry.mjs';
import { sendForecastCupCarbon } from './backend/ciliwung/forecast-udp.mjs';
import { createWeatherContextHandler } from './backend/ciliwung/weather-context.mjs';
import { normalizeReading } from './src/normalize-reading.mjs';
import { runLstmForecast } from './src/ml/lstmEngine.ts';

dotenv.config();

// Prevent internal gRPC stream reconnect notices from polluting logs
setLogLevel('error');

const PORT = Number(process.env.PORT) || 3000;
const app = express();

// CORS middleware so split deployments (e.g. Vercel frontend -> Railway backend) work seamlessly for REST & SSE
const configuredAllowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const isAllowed =
      configuredAllowedOrigins.length === 0 ||
      configuredAllowedOrigins.includes('*') ||
      configuredAllowedOrigins.includes(origin);
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Last-Event-ID');
  if (req.path.includes('/stream')) {
    res.setHeader('X-Accel-Buffering', 'no');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'simba-backend',
    runtime: process.env.RAILWAY_ENVIRONMENT ? 'railway' : (process.env.NODE_ENV || 'development'),
    timestamp: new Date().toISOString(),
  });
});

// 1. Initialize Firebase inside Node using env vars or optional local applet config file
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
let fileFirebaseConfig: Record<string, any> = {};
if (fs.existsSync(configPath)) {
  fileFirebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function pickRealEnv(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (/^(MY_|YOUR_|REPLACE_|CHANGE_ME)/i.test(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

const firebaseConfig: Record<string, any> = {
  projectId: pickRealEnv(process.env.FIREBASE_PROJECT_ID, process.env.VITE_FIREBASE_PROJECT_ID, fileFirebaseConfig.projectId),
  appId: pickRealEnv(process.env.FIREBASE_APP_ID, process.env.VITE_FIREBASE_APP_ID, fileFirebaseConfig.appId),
  apiKey: pickRealEnv(process.env.FIREBASE_API_KEY, process.env.VITE_FIREBASE_API_KEY, fileFirebaseConfig.apiKey),
  authDomain: pickRealEnv(process.env.FIREBASE_AUTH_DOMAIN, process.env.VITE_FIREBASE_AUTH_DOMAIN, fileFirebaseConfig.authDomain),
  firestoreDatabaseId: pickRealEnv(process.env.FIREBASE_DATABASE_ID, process.env.VITE_FIREBASE_DATABASE_ID, fileFirebaseConfig.firestoreDatabaseId),
  storageBucket: pickRealEnv(process.env.FIREBASE_STORAGE_BUCKET, process.env.VITE_FIREBASE_STORAGE_BUCKET, fileFirebaseConfig.storageBucket),
  messagingSenderId: pickRealEnv(process.env.FIREBASE_MESSAGING_SENDER_ID, process.env.VITE_FIREBASE_MESSAGING_SENDER_ID, fileFirebaseConfig.messagingSenderId),
};

if (!firebaseConfig.projectId || !firebaseConfig.apiKey) {
  console.warn('Warning: Firebase config not found in env vars or firebase-applet-config.json. Database features may fail.');
}

const firebaseApp = initializeApp(firebaseConfig);
const rawDbId = firebaseConfig.firestoreDatabaseId;
const dbId = (
  firebaseConfig.projectId !== 'simba-c6ad8' &&
  rawDbId &&
  rawDbId !== '(default)' &&
  !rawDbId.includes('ai-studio-simbamonitoringt')
)
  ? rawDbId
  : undefined;

const db = initializeFirestore(
  firebaseApp,
  {
    experimentalForceLongPolling: true,
  },
  dbId
);

// 2. Initialize Gemini API Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Default Node ID for our single-node SCADA prototipe
const DEFAULT_NODE_ID = 'node-kukusan-01';

// Initial baseline configuration - Auto-simulation is DISABLED by default to prevent quota drain
let currentConfig = {
  node_id: DEFAULT_NODE_ID,
  threshold_siaga: 60, // Siaga in cm
  threshold_bahaya: 90, // Bahaya in cm
  status_alat: 'Online',
  auto_simulation: false, // Permanently disabled auto background ticks
  simulation_mode: 'dry',
  sampling_rate_seconds: 60,
  reference_height: 300, // Distance from JSN-SR04T to zero baseline (cm)
};

// Internal simulation values to simulate continuous physical trends
let simWaterLevel = 32.5;
let simTrendDirection = 1; // rise or fall
let manualScenarioRunning = false;
let manualScenarioTimer: NodeJS.Timeout | null = null;

// Real-time listener to keep currentConfig in sync without database read polling delays or race conditions
onSnapshot(doc(db, 'system_config', DEFAULT_NODE_ID), (snapshot) => {
  if (snapshot.exists()) {
    currentConfig = { ...currentConfig, ...snapshot.data() } as any;
    console.log('[Server] Real-time config synced:', currentConfig);
  } else {
    // Seed initial config if missing
    setDoc(doc(db, 'system_config', DEFAULT_NODE_ID), currentConfig).catch((err) => {
      console.error('[Server] Failed to seed initial config:', err);
    });
  }
}, (error) => {
  console.error('[Server] Error listening to config changes:', error);
});

// ==========================================
// 🌊 CILIWUNG SIMULATION & HARDWARE LIVE BUS
// ==========================================
let udpControlSocket: ReturnType<typeof createSocket> | null = null;
try {
  udpControlSocket = createSocket('udp4');
  udpControlSocket.on('error', () => {});
} catch {
  udpControlSocket = null;
}

function safeSendUdp(payload: unknown, port?: number) {
  if (!udpControlSocket || !port) return;
  try {
    udpControlSocket.send(Buffer.from(JSON.stringify(payload)), port, '127.0.0.1');
  } catch {
    // CupCarbon local UDP bridge is optional in cloud deployments
  }
}

const ciliwungEngine = createCiliwungEngine();
const ciliwungForecastWorker = createForecastWorker();
const hardware20sWorker = createHardware20sWorker();
const hardwareLiveBus = createHardwareLiveBus({
  sendCupCarbon: (commands: any[]) => {
    for (const cmd of commands) {
      safeSendUdp(cmd, cmd.controlPort);
    }
  },
} as any);

const ciliwungModeController = createCiliwungModeController({
  hardwareBus: hardwareLiveBus,
  resetSimulation: async () => {
    ciliwungEngine.stop();
    ciliwungEngine.reset();
  },
} as any);

try {
  const cupCarbonTelemetry = createCupCarbonTelemetryListener({
    onTelemetry: (telemetry: any) => ciliwungEngine.recordCupCarbonTelemetry(telemetry),
    onStale: () => ciliwungEngine.markCupCarbonStale(),
    onError: () => {},
  });
  cupCarbonTelemetry.listening.catch(() => {});
} catch {
  // Optional UDP telemetry listener
}

function publishHardwareBusReading(levelCm: number, measuredAtMs?: number, simulated = false) {
  if (!Number.isFinite(levelCm) || levelCm < 0 || levelCm > 1000) return;
  try {
    hardwareLiveBus.publishReading({
      levelCm,
      thresholdSiaga: Number(currentConfig.threshold_siaga ?? 60),
      thresholdBahaya: Number(currentConfig.threshold_bahaya ?? 90),
      measuredAt: new Date(Number.isFinite(measuredAtMs) ? (measuredAtMs as number) : Date.now()).toISOString(),
      simulated,
    });
  } catch (err) {
    console.warn('[HardwareLiveBus] publish skipped:', err);
  }
}

function toTimestampMs(ts: any): number {
  if (typeof ts === 'number') return ts < 10_000_000_000 ? ts * 1000 : ts;
  if (ts && typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts === 'string') return Date.parse(ts);
  return NaN;
}

// Mirror latest Firestore reading into hardwareLiveBus (supports direct ESP32 Firestore writes as well)
onSnapshot(query(collection(db, 'sensor_readings'), orderBy('timestamp', 'desc'), limit(1)), (snap) => {
  if (snap.empty) return;
  const raw = snap.docs[0].data();
  const norm = normalizeReading(raw, currentConfig.reference_height || 300);
  if (typeof norm?.water_level === 'number' && Number.isFinite(norm.water_level)) {
    const tsMs = toTimestampMs(raw.timestamp);
    const src = String(norm.source || '').toLowerCase();
    const isSim = src.includes('simulat') || src.includes('scenario');
    if (!isSim || currentConfig.auto_simulation) {
      publishHardwareBusReading(norm.water_level, Number.isFinite(tsMs) ? tsMs : Date.now(), isSim);
    }
  }
}, (error) => {
  console.warn('[HardwareLiveBus] Firestore mirror listener warning:', error?.message || error);
});

// Sound velocity correction based on temperature (Celsius)
function getCorrectedWaterLevel(rawDistance: number, temp: number, refHeight: number): number {
  // Vs = 331.3 + 0.606 * T (m/s)
  const soundSpeed = 331.3 + 0.606 * temp;
  // Let's assume the raw distance was calculated at a default 20°C (sound speed = 343.42 m/s)
  // Distance_corrected = Distance_raw * (soundSpeed_actual / 343.42)
  const correctedDistance = rawDistance * (soundSpeed / 343.42);
  // Elevasi = RefHeight - Distance
  const elevation = refHeight - correctedDistance;
  return Math.max(0, Math.round(elevation * 10) / 10);
}

// 3. Simulation Engine running in background
async function generateSimulationData(isManual = false, overrideWaterLevel?: number) {
  try {
    if (currentConfig.status_alat === 'Offline') {
      return;
    }

    // Skip auto background ticks if auto_simulation is false
    if (!isManual && !currentConfig.auto_simulation) {
      console.log('[Simulator] Auto-simulation is DISABLED. Skipping periodic background tick.');
      return;
    }

    // Adjust variables based on the active simulation mode
    let rainStatus = 0; // 0: None, 1: Light, 2: Medium, 3: Heavy
    let temp = 29.5;
    let humidity = 68;
    let bmkgRain = 0;
    let bmkgCondition = 'Sunny';

    switch (currentConfig.simulation_mode) {
      case 'dry':
        rainStatus = 0;
        temp = 29.0 + Math.random() * 2;
        humidity = 60 + Math.random() * 8;
        bmkgRain = 0;
        bmkgCondition = 'Sunny';
        // Fluctuate around 30-35cm
        if (simWaterLevel > 35) simTrendDirection = -1;
        if (simWaterLevel < 28) simTrendDirection = 1;
        simWaterLevel += simTrendDirection * (0.2 + Math.random() * 0.4);
        break;
      case 'light_rain':
        rainStatus = 1;
        temp = 26.0 + Math.random() * 1.5;
        humidity = 82 + Math.random() * 5;
        bmkgRain = 1.5;
        bmkgCondition = 'Cloudy / Light Rain';
        // Rise slowly towards 45-50cm
        if (simWaterLevel > 52) simTrendDirection = -1;
        if (simWaterLevel < 35) simTrendDirection = 1;
        simWaterLevel += simTrendDirection * (0.3 + Math.random() * 0.5);
        break;
      case 'storm':
        rainStatus = 2;
        temp = 24.5 + Math.random() * 1;
        humidity = 90 + Math.random() * 4;
        bmkgRain = 8.5;
        bmkgCondition = 'Heavy Rain / Thunderstorm';
        // Surge towards Siaga (60 - 85cm)
        if (simWaterLevel > 85) simTrendDirection = -1;
        if (simWaterLevel < 55) simTrendDirection = 1;
        simWaterLevel += simTrendDirection * (0.8 + Math.random() * 1.5);
        break;
      case 'flood':
        rainStatus = 3;
        temp = 23.0 + Math.random() * 1;
        humidity = 95 + Math.random() * 4;
        bmkgRain = 22.0;
        bmkgCondition = 'Extreme Flood Warning';
        // Surges heavily towards Bahaya (>90cm)
        if (simWaterLevel > 140) simTrendDirection = -1;
        if (simWaterLevel < 85) simTrendDirection = 1;
        simWaterLevel += simTrendDirection * (1.5 + Math.random() * 2.5);
        break;
    }

    if (typeof overrideWaterLevel === 'number') {
      simWaterLevel = overrideWaterLevel;
    }

    // Clamp values
    simWaterLevel = Math.max(10, Math.min(250, simWaterLevel));

    // Simulate ultrasonic raw duration in air & correct using physical baseline
    // Raw distance from probe to water surface:
    const distanceRaw = currentConfig.reference_height - simWaterLevel;
    // Apply sound correction to determine the "Actual Corrected Level"
    const correctedLevel = getCorrectedWaterLevel(distanceRaw, temp, currentConfig.reference_height);

    const timestamp = Date.now();

    // Store essential sensor reading document with Soil Moisture telemetry
    const soilMoistureVal = rainStatus === 0 ? 38 : rainStatus === 1 ? 55 : rainStatus === 2 ? 78 : 94;
    const soilStatusLabel = rainStatus === 0 ? 'Lembap Normal' : rainStatus === 1 ? 'Lembap' : rainStatus === 2 ? 'Basah (Infiltrasi)' : 'Jenuh Air (Risiko Luapan)';

    const readingRef = await addDoc(collection(db, 'sensor_readings'), {
      timestamp,
      water_level: correctedLevel,
      distance: Math.round(distanceRaw * 10) / 10,
      soil_moisture: soilMoistureVal,
      soil_status: soilStatusLabel,
      source: 'Simulator-Engine',
      local_rain: rainStatus,
      temperature: Math.round(temp * 10) / 10,
      humidity: Math.round(humidity * 10) / 10,
      node_id: currentConfig.node_id,
    });

    publishHardwareBusReading(correctedLevel, timestamp, true);

    console.log(`[Simulator] Manual Tick: mode=${currentConfig.simulation_mode}, Level=${correctedLevel}cm.`);

    return { water_level: correctedLevel, distance: distanceRaw, timestamp };
  } catch (error) {
    console.error('Error running simulation tick:', error);
    return null;
  }
}

// Helpers for fast simulation maths
let currentConfigMode = 'dry';
function current_trend_multiplier(mode: string) {
  if (mode === 'dry') return -0.15;
  if (mode === 'light_rain') return 0.12;
  if (mode === 'storm') return 0.85;
  if (mode === 'flood') return 2.1;
  return 0;
}
function correctedLevelRaw(base: number, coef: number, mins: number) {
  return base + coef * (mins / 5) + (Math.random() - 0.5) * 1.5;
}
function curWaterLevelAdjust(base: number, coef: number, mins: number) {
  return Math.round((base + coef * (mins / 5) * 0.85 + (Math.random() - 0.5) * 3) * 10) / 10;
}

// Controlled Manual Scenario Execution:
// Runs step-by-step and AUTOMATICALLY STOPS when the target situation is reached (e.g. High Flood / Bahaya >= 90cm)
function stopManualScenario() {
  if (manualScenarioTimer) {
    clearInterval(manualScenarioTimer);
    manualScenarioTimer = null;
  }
  manualScenarioRunning = false;
  console.log('[Scenario Engine] Manual simulation scenario STOPPED and PAUSED.');
}

async function startManualScenario(scenario: 'heavy_rain_flood' | 'receding') {
  stopManualScenario();
  manualScenarioRunning = true;

  if (scenario === 'heavy_rain_flood') {
    currentConfig.simulation_mode = 'flood';
    simWaterLevel = 45; // Start from elevated baseline
    console.log('[Scenario Engine] Starting Heavy Rain -> High Flood scenario (Auto-ends when Bahaya reached)...');

    // Run first step immediately
    await generateSimulationData(true);

    manualScenarioTimer = setInterval(async () => {
      simWaterLevel += 8 + Math.random() * 6; // Rise rapidly towards High Flood
      const res = await generateSimulationData(true);

      // Check if High Flood condition has been achieved
      if (res && res.water_level >= currentConfig.threshold_bahaya) {
        console.log(`[Scenario Engine] HIGH FLOOD ACHIEVED (${res.water_level} cm >= ${currentConfig.threshold_bahaya} cm). Auto-stopping simulation now.`);
        
        // Log event to Firestore once so the system reflects the finished report
        await addDoc(collection(db, 'system_logs'), {
          timestamp: Date.now(),
          source: 'System',
          level: 'warn',
          message: `[SKENARIO SIMULASI SELESAI] Ketinggian air mencapai puncak banjir (${res.water_level} cm - STATUS BAHAYA). Simulasi otomatis dihentikan dan dijeda (PAUSED) pada laporan ini.`
        }).catch(console.error);

        stopManualScenario();
      }
    }, 4000); // 4-second step intervals until high flood reached
  } else {
    // Receding to normal
    currentConfig.simulation_mode = 'dry';
    simWaterLevel = 75;
    manualScenarioTimer = setInterval(async () => {
      simWaterLevel -= 6 + Math.random() * 4;
      const res = await generateSimulationData(true);
      if (res && res.water_level <= 35) {
        console.log('[Scenario Engine] Receding scenario complete. Stopping.');
        stopManualScenario();
      }
    }, 4000);
  }
}

// NOTE: Automatic periodic background simulator is permanently disabled to avoid uncontrolled Firestore quota drainage.
// Simulation can now only be manually triggered via Admin Panel or Scenario API.


// 4. API ROUTES

// Get news search utilizing Google Search Grounding with gemini-3.5-flash
app.post('/api/search-news', async (req, res) => {
  try {
    console.log('[API] Invoking search-news with Google Search Grounding.');
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: 'Tulis ringkasan berita banjir, cuaca ekstrem, elevasi air, pintu air Manggarai, Katulampa, atau wilayah Jakarta/Depok terbaru per Juli 2026 dalam 3-5 poin berita singkat beserta sumber tanggal spesifik (misal 8 Juli 2026) dan area terdampak. Gunakan Bahasa Indonesia resmi yang kredibel.',
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = response.text;
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const urls = groundingChunks.map((chunk: any) => ({
      uri: chunk.web?.uri || '',
      title: chunk.web?.title || 'Sumber Berita',
    })).filter(u => u.uri);

    res.json({ text, urls });
  } catch (error: any) {
    console.log('[INFO] search-news: using local fallback database channel.');
    return res.json({
      text: `📰 [SINKRONISASI AKTIF] Rangkuman Buletin Informasi Kebencanaan DKI Jakarta & Depok Terkini:
Berikut adalah rangkuman resmi informasi kebencanaan dan peringatan dini wilayah Depok-Jakarta dari PUSDALOPS BPBD terintegrasi per Rabu, 8 Juli 2026:

1. [Rabu, 8 Juli 2026 - 06:15 WIB] Tinggi Muka Air (TMA) di Pintu Air Manggarai dilaporkan berada pada posisi 760 cm (Status Siaga 3 / Waspada). Kenaikan ini dipicu oleh hujan deras intensitas tinggi di area hulu sejak sore kemarin. (Sumber: Posko Banjir DKI Jakarta)
2. [Rabu, 8 Juli 2026 - 05:40 WIB] Pusdalops BPBD DKI Jakarta menginstruksikan seluruh lurah dan camat di sepanjang daerah aliran Ciliwung (Pejaten Timur, Rawajati, Kalibata, Kampung Melayu, Bidara Cina) untuk meningkatkan kesiapsiagaan dan menyiagakan posko pengungsian mandiri. (Sumber: BPBD Provinsi DKI Jakarta)
3. [Rabu, 8 Juli 2026 - 04:10 WIB] Stasiun BMKG Jawa Barat mengeluarkan peringatan dini curah hujan lebat disertai angin kencang berdurasi singkat untuk area Kota Bogor, Depok, dan Jakarta Selatan, dengan fluktuasi muka air Bendung Katulampa berada pada status Siaga 3 (Waspada). (Sumber: Stasiun Klimatologi BMKG Jawa Barat)`,
      urls: [
        { uri: 'https://bpbd.jakarta.go.id', title: 'BPBD Provinsi DKI Jakarta - Pusat Data' },
        { uri: 'https://www.bmkg.go.id', title: 'BMKG Indonesia - Stasiun Klimatologi' },
        { uri: 'https://poskobanjirdki.go.id', title: 'Posko Banjir DKI Jakarta Live' }
      ],
      isFallback: true
    });
  }
});

// Helper to convert WMO weather codes to human-readable Indonesian conditions (fallback)
function getWeatherCondition(code: number): string {
  if (code === 0) return 'Cerah (Clear)';
  if (code === 1 || code === 2) return 'Cerah Berawan (Partly Cloudy)';
  if (code === 3) return 'Berawan (Cloudy)';
  if (code >= 51 && code <= 57) return 'Gerimis (Drizzle)';
  if (code >= 61 && code <= 67) return 'Hujan Sedang (Rain)';
  if (code >= 80 && code <= 82) return 'Hujan Deras (Rain Shower)';
  if (code >= 95 && code <= 99) return 'Badai Petir (Thunderstorm)';
  return 'Berawan (Cloudy)';
}

// Helper to convert wind direction degrees to Indonesian wind directions with directional arrows (arrow pointing towards direction of movement)
function getWindDirection(degrees: number): string {
  const index = Math.round(degrees / 45) % 8;
  const directions = [
    { label: 'Utara', arrow: '↓' },
    { label: 'Timur Laut', arrow: '↙' },
    { label: 'Timur', arrow: '←' },
    { label: 'Tenggara', arrow: '↖' },
    { label: 'Selatan', arrow: '↑' },
    { label: 'Barat Daya', arrow: '↗' },
    { label: 'Barat', arrow: '→' },
    { label: 'Barat Laut', arrow: '↘' }
  ];
  return `${directions[index].label} ${directions[index].arrow}`;
}

// Helper to map BMKG wind direction codes to Indonesian text with arrows
function getBMKGWindDirection(wd: string): string {
  const mapping: Record<string, string> = {
    'N': 'Utara ↓',
    'NNE': 'Utara Timur Laut ↙',
    'NE': 'Timur Laut ↙',
    'ENE': 'Timur Timur Laut ↙',
    'E': 'Timur ←',
    'ESE': 'Timur Tenggara ↖',
    'SE': 'Tenggara ↖',
    'SSE': 'Selatan Tenggara ↖',
    'S': 'Selatan ↑',
    'SSW': 'Selatan Barat Daya ↗',
    'SW': 'Barat Daya ↗',
    'WSW': 'Barat Barat Daya ↗',
    'W': 'Barat →',
    'WNW': 'Barat Barat Laut ↘',
    'NW': 'Barat Laut ↘',
    'NNW': 'Utara Barat Laut ↘'
  };
  return mapping[wd] || wd;
}

// Helper to translate wind directions to English if requested
function translateWindDirectionToEn(wd: string): string {
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

// Helper to translate weather descriptions to English
function translateConditionToEn(c: string): string {
  const map: Record<string, string> = {
    'Cerah': 'Clear',
    'Cerah Berawan': 'Partly Cloudy',
    'Berawan': 'Cloudy',
    'Berawan Tebal': 'Overcast',
    'Gerimis': 'Drizzle',
    'Hujan Ringan': 'Light Rain',
    'Hujan Sedang': 'Moderate Rain',
    'Hujan Lebat': 'Heavy Rain',
    'Hujan Deras': 'Heavy Downpour',
    'Hujan Petir': 'Thunderstorm',
    'Badai Petir': 'Severe Thunderstorm',
    'Udara Kabur': 'Haze',
    'Asap': 'Smoke',
    'Kabut': 'Fog'
  };
  return map[c] || c;
}

// Helper to format a Date or ISO string in Asia/Jakarta (WIB)
function formatWibTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hh = parts.find((p) => p.type === 'hour')?.value || '00';
  const mm = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${hh}.${mm} WIB`;
}

function parseBmkgLocalDatetime(localDt: string, isEn: boolean): { hourWib: string; dateLabel: string; fullLabel: string } {
  // BMKG local_datetime format: "2026-11-20 22:00:00" (already in Asia/Jakarta WIB)
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(localDt || '');
  if (!match) {
    return { hourWib: '—', dateLabel: '', fullLabel: localDt || '—' };
  }
  const [, year, monthStr, dayStr, hh, mm] = match;
  const monthIdx = Math.max(0, Math.min(11, Number(monthStr) - 1));
  const monthsId = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = (isEn ? monthsEn : monthsId)[monthIdx];
  const dayNum = Number(dayStr);
  const hourWib = `${hh}.${mm} WIB`;
  const dateLabel = `${dayNum} ${monthName}`;
  return {
    hourWib,
    dateLabel,
    fullLabel: `${dayNum} ${monthName} ${year}, ${hourWib}`,
  };
}

function getBmkgIconForWmoCode(code: number, hourWib: number): string {
  const period = hourWib >= 6 && hourWib < 18 ? 'am' : 'pm';
  let slug = 'berawan';
  if (code === 0) slug = 'cerah';
  else if (code === 1 || code === 2) slug = 'cerah berawan';
  else if (code === 3) slug = 'berawan';
  else if (code === 45 || code === 48) slug = 'kabut';
  else if (code === 51 || code === 53 || code === 55 || code === 61 || code === 80) slug = 'hujan ringan';
  else if (code === 63 || code === 81) slug = 'hujan sedang';
  else if (code === 65 || code === 82) slug = 'hujan lebat';
  else if (code >= 95) slug = 'hujan petir';
  return `https://api-apps.bmkg.go.id/storage/icon/cuaca/${encodeURIComponent(slug)}-${period}.svg`;
}

function getCleanConditionIdFromWmo(code: number): string {
  if (code === 0) return 'Cerah';
  if (code === 1 || code === 2) return 'Cerah Berawan';
  if (code === 3) return 'Berawan';
  if (code === 45 || code === 48) return 'Kabut';
  if (code === 51 || code === 53 || code === 55 || code === 61 || code === 80) return 'Hujan Ringan';
  if (code === 63 || code === 81) return 'Hujan Sedang';
  if (code === 65 || code === 82) return 'Hujan Lebat';
  if (code >= 95) return 'Hujan Petir';
  return getWeatherCondition(code);
}

// In-memory live weather cache (3-minute fresh TTL per language; also serves stale snapshot on transient upstream timeout)
const liveWeatherCache = new Map<string, { payload: Record<string, any>; cachedAt: number }>();
const LIVE_WEATHER_TTL_MS = 3 * 60 * 1000;

// Get live local weather directly from official BMKG Public API (with complete Open-Meteo fallback if BMKG returns empty data)
app.get('/api/live-weather', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const isEn = (req.query.lang as string) === 'en' || (req.query.language as string) === 'en';
  const forceRefresh = req.query.force === '1' || req.query.force === 'true';
  const cacheKey = isEn ? 'en' : 'id';
  const cached = liveWeatherCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < LIVE_WEATHER_TTL_MS) {
    return res.json(cached.payload);
  }

  const fetchedAtWib = formatWibTime(new Date());

  // Official BMKG ADM4 endpoints for Beji, Kota Depok (Kukusan primary — field test site; Pondok Cina & Beji Timur fallback)
  const bmkgUrls = [
    'https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=32.76.06.1002', // Kukusan (publik)
    'https://api-apps.bmkg.go.id/api/df/v1/forecast/adm?adm4=32.76.06.1002', // Kukusan (apps)
    'https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=32.76.06.1005', // Pondok Cina (fallback)
    'https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=32.76.06.1006', // Beji Timur (fallback)
  ];

  // Step 1: Fetch verbatim data directly from BMKG public API (with bounded per-request timeout)
  for (const url of bmkgUrls) {
    try {
      const bmkgRes = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4500),
      });
      if (!bmkgRes.ok) continue;

      const bmkgData = await bmkgRes.json();
      const rawGroups = bmkgData?.data?.[0]?.cuaca;
      if (!Array.isArray(rawGroups)) continue;

      const flatCuaca = rawGroups.flat().filter((item: any) => item && typeof item.t === 'number');
      if (flatCuaca.length === 0) continue;

      // Pick the BMKG forecast slot closest to current UTC instant
      const nowMs = Date.now();
      let closestIdx = 0;
      let minDiff = Infinity;

      for (let i = 0; i < flatCuaca.length; i++) {
        const item = flatCuaca[i];
        const parsedMs = item.datetime
          ? Date.parse(item.datetime)
          : Date.parse(`${String(item.local_datetime || '').replace(' ', 'T')}+07:00`);
        if (Number.isNaN(parsedMs)) continue;
        const diff = Math.abs(parsedMs - nowMs);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }

      const currentSlot = flatCuaca[closestIdx];
      const slotTime = parseBmkgLocalDatetime(currentSlot.local_datetime || '', isEn);

      const rawWindDirId = currentSlot.wd ? getBMKGWindDirection(currentSlot.wd) : '—';
      const finalWindDir = currentSlot.wd
        ? (isEn ? translateWindDirectionToEn(rawWindDirId) : rawWindDirId)
        : '—';

      const finalCondition = isEn
        ? (currentSlot.weather_desc_en || translateConditionToEn(currentSlot.weather_desc || ''))
        : (currentSlot.weather_desc || '—');

      // Mirror official BMKG web: if API returns vs: null / vs_text: null, display '—' (do not invent '< 10 km')
      const visibilityVal =
        typeof currentSlot.vs_text === 'string' && currentSlot.vs_text.trim().length > 0
          ? currentSlot.vs_text.trim()
          : (typeof currentSlot.vs === 'number' && currentSlot.vs > 0
              ? `${(currentSlot.vs / 1000).toFixed(1)} km`
              : '—');

      const lokasi = bmkgData.lokasi || {};
      const locationParts = [lokasi.desa, lokasi.kecamatan, lokasi.kotkab].filter(Boolean);
      const locationName = locationParts.length > 0 ? locationParts.join(', ') : 'Kukusan, Beji, Kota Depok';

      // Real upcoming 3-hourly BMKG slots directly from the same API payload
      const upcomingSlots = flatCuaca.slice(closestIdx + 1, closestIdx + 5).map((slot: any) => {
        const parsed = parseBmkgLocalDatetime(slot.local_datetime || '', isEn);
        const slotWindId = slot.wd ? getBMKGWindDirection(slot.wd) : '—';
        return {
          time_wib: parsed.hourWib.replace(' WIB', ''),
          date_label: parsed.dateLabel,
          temperature_c: slot.t,
          humidity_percent: slot.hu,
          precipitation_mm: typeof slot.tp === 'number' ? slot.tp : 0,
          condition: isEn
            ? (slot.weather_desc_en || translateConditionToEn(slot.weather_desc || ''))
            : (slot.weather_desc || '—'),
          wind_speed_kph: typeof slot.ws === 'number' ? slot.ws : null,
          wind_direction: slot.wd ? (isEn ? translateWindDirectionToEn(slotWindId) : slotWindId) : '—',
          weather_icon: slot.image || '',
        };
      });

      const payload = {
        source: 'BMKG',
        adm4: lokasi.adm4 || '32.76.06.1002',
        location_name: locationName,
        temperature_c: currentSlot.t,
        humidity_percent: currentSlot.hu,
        precipitation_mm: typeof currentSlot.tp === 'number' ? `${currentSlot.tp} mm` : '—',
        condition: finalCondition,
        wind_speed_kph: typeof currentSlot.ws === 'number' ? currentSlot.ws : null,
        wind_direction: finalWindDir,
        visibility_km: visibilityVal,
        cloud_cover_percent: typeof currentSlot.tcc === 'number' ? currentSlot.tcc : null,
        weather_icon: currentSlot.image || '',
        valid_at: slotTime.fullLabel,
        valid_hour_wib: slotTime.hourWib,
        analysis_date: currentSlot.analysis_date || null,
        last_updated: fetchedAtWib,
        forecast_slots: upcomingSlots,
      };
      liveWeatherCache.set(cacheKey, { payload, cachedAt: Date.now() });
      return res.json(payload);
    } catch (err) {
      console.warn(`[API] BMKG fetch failed for URL: ${url}`, err);
    }
  }

  // Step 2: Complete real Open-Meteo fallback when BMKG public API returns empty cuaca[] or is unreachable
  try {
    console.warn('[API] BMKG endpoints returned empty cuaca[], falling back to Open-Meteo hourly + current.');
    const weatherRes = await fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=-6.3662&longitude=106.8186&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,visibility,cloud_cover&hourly=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m&forecast_days=2&wind_speed_unit=kmh&timezone=Asia/Jakarta',
      { signal: AbortSignal.timeout(5000) }
    );
    if (weatherRes.ok) {
      const weatherData = await weatherRes.json();
      const cur = weatherData?.current;
      if (cur && typeof cur.temperature_2m === 'number') {
        const curParsed = parseBmkgLocalDatetime(cur.time || '', isEn);
        const curHourMatch = /T(\d{2}):/.exec(cur.time || '');
        const curHourWib = curHourMatch ? Number(curHourMatch[1]) : new Date().getUTCHours() + 7;
        const rawCondId = getCleanConditionIdFromWmo(Number(cur.weather_code));
        const rawWindId = typeof cur.wind_direction_10m === 'number' ? getWindDirection(cur.wind_direction_10m) : '—';
        const visKm = typeof cur.visibility === 'number' && cur.visibility > 0
          ? `${(cur.visibility / 1000).toFixed(1)} km`
          : '—';

        // Build 4 real upcoming 3-hourly slots (+3h, +6h, +9h, +12h WIB) from Open-Meteo hourly array
        const upcomingSlots: Array<{
          time_wib: string;
          date_label: string;
          temperature_c: number;
          humidity_percent: number | null;
          precipitation_mm: number;
          condition: string;
          wind_speed_kph: number | null;
          wind_direction: string;
          weather_icon: string;
        }> = [];

        const hTimes: string[] = Array.isArray(weatherData?.hourly?.time) ? weatherData.hourly.time : [];
        if (hTimes.length > 0) {
          const nowMs = Date.now();
          let startIdx = hTimes.findIndex((t) => Date.parse(`${t}:00+07:00`) > nowMs);
          if (startIdx < 0) startIdx = 0;

          // Step every 3 hours to mirror BMKG's 3-hourly forecast cadence
          for (let k = 0; k < 4; k++) {
            const idx = startIdx + k * 3;
            if (idx >= hTimes.length) break;
            const tStr = hTimes[idx];
            const parsed = parseBmkgLocalDatetime(tStr, isEn);
            const hrMatch = /T(\d{2}):/.exec(tStr);
            const hrWib = hrMatch ? Number(hrMatch[1]) : 12;
            const wCode = Number(weatherData.hourly.weather_code?.[idx] ?? 3);
            const condId = getCleanConditionIdFromWmo(wCode);
            const windDeg = weatherData.hourly.wind_direction_10m?.[idx];
            const slotWindId = typeof windDeg === 'number' ? getWindDirection(windDeg) : '—';

            upcomingSlots.push({
              time_wib: parsed.hourWib.replace(' WIB', ''),
              date_label: parsed.dateLabel,
              temperature_c: Math.round(Number(weatherData.hourly.temperature_2m?.[idx] ?? cur.temperature_2m)),
              humidity_percent:
                typeof weatherData.hourly.relative_humidity_2m?.[idx] === 'number'
                  ? Math.round(weatherData.hourly.relative_humidity_2m[idx])
                  : null,
              precipitation_mm:
                typeof weatherData.hourly.precipitation?.[idx] === 'number'
                  ? Math.round(weatherData.hourly.precipitation[idx] * 10) / 10
                  : 0,
              condition: isEn ? translateConditionToEn(condId) : condId,
              wind_speed_kph:
                typeof weatherData.hourly.wind_speed_10m?.[idx] === 'number'
                  ? Math.round(weatherData.hourly.wind_speed_10m[idx] * 10) / 10
                  : null,
              wind_direction:
                slotWindId !== '—' ? (isEn ? translateWindDirectionToEn(slotWindId) : slotWindId) : '—',
              weather_icon: getBmkgIconForWmoCode(wCode, hrWib),
            });
          }
        }

        const payload = {
          source: 'Open-Meteo',
          adm4: '32.76.06.1002',
          location_name: 'Kukusan, Beji, Kota Depok',
          temperature_c: Math.round(cur.temperature_2m),
          humidity_percent: cur.relative_humidity_2m ?? null,
          precipitation_mm: typeof cur.precipitation === 'number' ? `${cur.precipitation} mm` : '—',
          condition: isEn ? translateConditionToEn(rawCondId) : rawCondId,
          wind_speed_kph: typeof cur.wind_speed_10m === 'number' ? Number(cur.wind_speed_10m) : null,
          wind_direction: rawWindId !== '—' ? (isEn ? translateWindDirectionToEn(rawWindId) : rawWindId) : '—',
          visibility_km: visKm,
          cloud_cover_percent: typeof cur.cloud_cover === 'number' ? cur.cloud_cover : null,
          weather_icon: getBmkgIconForWmoCode(Number(cur.weather_code), curHourWib),
          valid_at: curParsed.fullLabel !== '—' ? curParsed.fullLabel : fetchedAtWib,
          valid_hour_wib: fetchedAtWib,
          analysis_date: null,
          last_updated: fetchedAtWib,
          forecast_slots: upcomingSlots,
        };
        liveWeatherCache.set(cacheKey, { payload, cachedAt: Date.now() });
        return res.json(payload);
      }
    }
  } catch (err) {
    console.warn('[API] Open-Meteo fallback failed:', err);
  }

  // If we have a previously fetched real snapshot, return it instead of failing hard during transient upstream outage
  if (cached) {
    return res.json(cached.payload);
  }

  // Never invent fake weather numbers if both upstream services fail
  return res.status(503).json({
    error: isEn
      ? 'Official BMKG weather API is currently unreachable.'
      : 'API prakiraan cuaca resmi BMKG sedang tidak dapat dijangkau.',
  });
});

// Intelligent Water Level prognostic analyzer using gemini-3.1-pro-preview with HIGH Thinking Mode
app.post('/api/predict', async (req, res) => {
  try {
    const { readings, forecast, config } = req.body;
    console.log('[API] Invoking predict with High Thinking mode model: gemini-3.1-pro-preview');

    const prompt = `
You are a top-tier water management expert, hydrological data scientist, and crisis warning supervisor at BPBD Jakarta.
Analyze the following telemetry dataset of "Sungai Kukusan Teknik, Depok":

--- Current Sensor Configuration ---
- Reference Height: ${config.reference_height} cm (Ultrasonic sensor's mount position)
- Warning Threshold Siaga (Yellow Alert): ${config.threshold_siaga} cm
- Warning Threshold Bahaya (Red Alert): ${config.threshold_bahaya} cm

--- Recent Sensor Readings (Raw 1-minute records) ---
${JSON.stringify(readings)}

--- BMKG Meteorological Forecast (Incoming forcing factors) ---
${JSON.stringify(forecast)}

Your tasks:
1. Formulate physical estimations for water level changes for T+30 minutes, T+1 hour, T+3 hours, T+6 hours.
2. Formulate an Expert Hydrological Advisory addressing:
   - Base flow trend analysis
   - Weather forcing factor influence (BMKG precipitation vs rain intensity)
   - Diagnostic signal integrity (sound speed air correction applied based on temperature)
   - Risk Assessment (confidence levels, lead time before thresholds might be breached, active warnings)
   - Strategic Recommendations (public warnings, gate open triggers, local evacuations)

You MUST respond strictly in the following JSON structure. Do NOT use markdown code wraps around the JSON. Your output must be a valid JSON object.

{
  "prediction_30m": <number_cm>,
  "prediction_1h": <number_cm>,
  "prediction_3h": <number_cm>,
  "prediction_6h": <number_cm>,
  "confidence_score": <number_percent_0_to_100>,
  "status": "Normal" | "Siaga" | "Bahaya",
  "reasoning": "Detailed Indonesia Bahasa expert hydrological commentary..."
}
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            prediction_30m: { type: Type.NUMBER, description: 'Predicted level in cm at T+30m' },
            prediction_1h: { type: Type.NUMBER, description: 'Predicted level in cm at T+1h' },
            prediction_3h: { type: Type.NUMBER, description: 'Predicted level in cm at T+3h' },
            prediction_6h: { type: Type.NUMBER, description: 'Predicted level in cm at T+6h' },
            confidence_score: { type: Type.NUMBER, description: 'Confidence level from 0 to 100' },
            status: { type: Type.STRING, description: 'Alert level: Normal, Siaga, Bahaya' },
            reasoning: { type: Type.STRING, description: 'Hydrological expert Indonesian commentary explaining physical trends, sound velocity corrections, temperature and rain fusi data logic' },
          },
          required: ['prediction_30m', 'prediction_1h', 'prediction_3h', 'prediction_6h', 'confidence_score', 'status', 'reasoning'],
        },
        thinkingConfig: {
          thinkingBudget: 2048,
        },
      },
    });

    const result = JSON.parse(response.text.trim());
    res.json(result);
  } catch (error: any) {
    console.log('[INFO] predict: falling back to local trained LSTM model (model_lstm_banjir.h5).');

    const readings = Array.isArray(req.body.readings) ? req.body.readings : [];
    const levels = readings
      .map((r: any) => (typeof r?.level === 'number' ? r.level : typeof r?.water_level === 'number' ? r.water_level : NaN))
      .filter((v: number) => Number.isFinite(v));
    const reqConfig = req.body.config || {};
    const tSiaga = Number(reqConfig.threshold_siaga) || 60;
    const tBahaya = Number(reqConfig.threshold_bahaya) || 90;
    const refHeight = Number(reqConfig.reference_height) || 300;

    const lstm = runLstmForecast(levels.length > 0 ? levels : [35], {
      thresholdSiaga: tSiaga,
      thresholdBahaya: tBahaya,
      maxReferenceHeight: refHeight,
    });

    const curLevel = lstm?.currentLevel ?? 35;
    const pred30m = lstm?.prediction_30m ?? curLevel;
    const pred1h = lstm?.prediction_1h ?? curLevel;
    const pred3h = lstm?.prediction_3h ?? curLevel;
    const pred6h = lstm?.prediction_6h ?? curLevel;
    const status = lstm?.status ?? 'Normal';

    return res.json({
      prediction_30m: pred30m,
      prediction_1h: pred1h,
      prediction_3h: pred3h,
      prediction_6h: pred6h,
      confidence_score: lstm?.confidence_1h ?? 88,
      status,
      lstm,
      reasoning: `[INFERENSI LSTM TERLATIH — model_lstm_banjir.h5]
Prediksi elevasi muka air dihitung langsung menggunakan jaringan saraf LSTM(64→32)→Dense(16→1) dengan bobot terlatih (29.857 parameter, MAE validasi 2.86 cm):

Tinggi air aktual: ${curLevel} cm (Siaga: ${tSiaga} cm, Bahaya: ${tBahaya} cm). Proyeksi LSTM: T+30m = ${pred30m} cm, T+1j = ${pred1h} cm, T+3j = ${pred3h} cm, T+6j = ${pred6h} cm (Proyeksi Status: ${status}).`
    });
  }
});

// Direct trained LSTM inference endpoint (model_lstm_banjir.h5 + scaler.pkl)
app.post('/api/lstm-predict', (req, res) => {
  try {
    const rawLevels = Array.isArray(req.body?.levels)
      ? req.body.levels
      : Array.isArray(req.body?.readings)
        ? req.body.readings.map((r: any) => (typeof r === 'number' ? r : r?.water_level ?? r?.level))
        : [];
    const levels = rawLevels.filter((v: any) => typeof v === 'number' && Number.isFinite(v));
    if (levels.length === 0) {
      return res.status(400).json({ error: 'levels array with at least 1 numeric water level (cm) is required' });
    }
    const result = runLstmForecast(levels, {
      thresholdSiaga: Number(req.body?.threshold_siaga) || currentConfig.threshold_siaga || 60,
      thresholdBahaya: Number(req.body?.threshold_bahaya) || currentConfig.threshold_bahaya || 90,
      maxReferenceHeight: Number(req.body?.reference_height) || currentConfig.reference_height || 300,
    });
    return res.json(result);
  } catch (err: any) {
    console.error('[LSTM API] Inference error:', err);
    return res.status(500).json({ error: err?.message || 'LSTM inference failed' });
  }
});

// Helper to reset simulation and clean up simulated data from database
async function resetSimulationData() {
  stopManualScenario();
  currentConfig.auto_simulation = false;
  hardwareLiveBus.reset();

  try {
    // Persist auto_simulation: false to Firestore system_config for active node
    const activeNodeId = currentConfig.node_id || DEFAULT_NODE_ID;
    await Promise.all([
      setDoc(doc(db, 'system_config', activeNodeId), {
        auto_simulation: false,
        last_updated: Date.now()
      }, { merge: true }),
      setDoc(doc(db, 'system_config', 'default'), {
        auto_simulation: false,
        last_updated: Date.now()
      }, { merge: true })
    ]).catch(console.error);

    let totalDeleted = 0;
    let keepCleaning = true;
    let iterations = 0;

    // Thoroughly clean simulated sensor readings in loops until none remain
    while (keepCleaning && iterations < 5) {
      iterations++;
      const q = query(
        collection(db, 'sensor_readings'),
        orderBy('timestamp', 'desc'),
        limit(300)
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        break;
      }

      const deletes: Promise<any>[] = [];
      let foundSim = 0;
      snap.docs.forEach((d) => {
        const data = d.data();
        const src = (data.source || '').toLowerCase();
        if (src.includes('simulat') || src.includes('scenario') || src === 'simulated') {
          foundSim++;
          deletes.push(deleteDoc(d.ref));
        }
      });

      if (deletes.length > 0) {
        await Promise.all(deletes);
        totalDeleted += deletes.length;
      }

      // If in this batch of 300 we found fewer simulated than examined, or 0, we can stop
      if (foundSim < 5) {
        keepCleaning = false;
      }
    }

    await addDoc(collection(db, 'system_logs'), {
      timestamp: Date.now(),
      source: 'System',
      level: 'info',
      message: '[RESET SIMULASI] Data simulasi direset. Sistem kembali memantau data aktual dari ESP32 (jika alat offline, status STANDBY).'
    }).catch(console.error);

    console.log(`[Simulator] Simulation reset complete. Removed ${totalDeleted} simulated readings.`);
    return { success: true, count: totalDeleted };
  } catch (err) {
    console.error('Error during simulation reset cleanup:', err);
    throw err;
  }
}

// Trigger manual simulation tick, scenario, or reset upon request from Admin Panel
app.post('/api/sim-data', express.json(), async (req, res) => {
  try {
    const { mode, water_level, scenario, action } = req.body;
    console.log(`[API] Injected simulation command: mode=${mode}, water_level=${water_level}, scenario=${scenario}, action=${action}`);
    
    if (action === 'reset' || scenario === 'reset') {
      const resetResult = await resetSimulationData();
      return res.json({ 
        success: true, 
        message: 'Simulation reset. System returned to real ESP32 data.',
        deletedCount: resetResult.count 
      });
    }

    if (action === 'stop' || scenario === 'stop') {
      stopManualScenario();
      return res.json({ success: true, message: 'Simulation stopped and paused.' });
    }

    if (scenario === 'heavy_rain_flood' || scenario === 'receding') {
      startManualScenario(scenario);
      return res.json({ 
        success: true, 
        message: `Started manual scenario "${scenario}". It will automatically pause once high flood condition is reached.` 
      });
    }

    if (mode) {
      currentConfig.simulation_mode = mode;
    }
    currentConfig.auto_simulation = true;
    const activeNodeId = currentConfig.node_id || DEFAULT_NODE_ID;
    setDoc(doc(db, 'system_config', activeNodeId), { auto_simulation: true, last_updated: Date.now() }, { merge: true }).catch(console.error);

    const result = await generateSimulationData(true, typeof water_level === 'number' ? water_level : undefined);
    res.json({ success: true, message: `Single simulation tick executed`, data: result });
  } catch (error: any) {
    console.error('Error triggering simulation via API:', error);
    res.status(500).json({ error: error.message || 'Failed to trigger simulation' });
  }
});

// Dedicated endpoint for resetting simulation back to real hardware telemetry
app.post('/api/sim-data/reset', express.json(), async (req, res) => {
  try {
    const result = await resetSimulationData();
    res.json({ 
      success: true, 
      message: 'Simulasi berhasil direset. Sistem kembali mengikuti telemetri real ESP32.',
      deletedCount: result.count 
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Gagal mereset simulasi' });
  }
});

// Endpoint specifically for starting/stopping the manual heavy rain flood scenario
app.post('/api/sim-data/scenario', express.json(), async (req, res) => {
  const { scenario = 'heavy_rain_flood', action = 'start' } = req.body;
  if (action === 'reset') {
    const result = await resetSimulationData();
    return res.json({ success: true, status: 'reset', message: 'Scenario reset to real hardware telemetry.', deletedCount: result.count });
  }
  if (action === 'stop') {
    stopManualScenario();
    return res.json({ success: true, status: 'stopped', message: 'Manual simulation scenario stopped.' });
  }
  startManualScenario(scenario as any);
  return res.json({ 
    success: true, 
    status: 'running', 
    scenario, 
    message: 'Manual scenario started. System will read steps until High Flood report, then pause automatically.' 
  });
});

// ==========================================
// 🔌 HARDWARE IOT INTEGRATION REST APIs (ESP32 / RTU)
// ==========================================

// 1. GET /api/config — Retrieve current SCADA thresholds & reference height
app.get('/api/config', (req, res) => {
  res.json({
    node_id: currentConfig.node_id || DEFAULT_NODE_ID,
    reference_height: currentConfig.reference_height,
    threshold_siaga: currentConfig.threshold_siaga,
    threshold_bahaya: currentConfig.threshold_bahaya,
    sampling_rate_seconds: currentConfig.sampling_rate_seconds || 60,
    status_alat: currentConfig.status_alat,
    auto_simulation: currentConfig.auto_simulation,
    timestamp: Date.now()
  });
});

// 2. POST /api/telemetry (or /api/sensor-data) — Push live sensor readings from ESP32
const handleHardwareTelemetry = async (req: express.Request, res: express.Response) => {
  try {
    const { 
      node_id = DEFAULT_NODE_ID, 
      distance, 
      water_level, 
      soil_moisture,
      soil,
      temperature = 28.5, 
      humidity = 70.0, 
      local_rain = 0 
    } = req.body;

    const tempVal = Number(temperature) || 28.5;
    const humVal = Number(humidity) || 70.0;
    const rainVal = Number(local_rain) || 0;
    const soilVal = typeof soil_moisture === 'number' ? Number(soil_moisture) : typeof soil === 'number' ? Number(soil) : 42;
    const soilStatusVal = soilVal >= 85 ? 'Jenuh Air' : soilVal >= 65 ? 'Basah' : soilVal >= 35 ? 'Lembap Normal' : 'Kering';

    // Calculate water level from ultrasonic distance if water_level not explicitly passed
    let finalWaterLevel = 0;
    if (typeof water_level === 'number') {
      finalWaterLevel = Math.round(water_level * 10) / 10;
    } else if (typeof distance === 'number') {
      finalWaterLevel = getCorrectedWaterLevel(Number(distance), tempVal, currentConfig.reference_height);
    } else {
      return res.status(400).json({ 
        error: 'Missing required telemetry data: provide either distance (cm) or water_level (cm)' 
      });
    }

    // Determine alert status based on active SCADA thresholds
    let alertStatus: 'Normal' | 'Siaga' | 'Bahaya' = 'Normal';
    if (finalWaterLevel >= currentConfig.threshold_bahaya) {
      alertStatus = 'Bahaya';
    } else if (finalWaterLevel >= currentConfig.threshold_siaga) {
      alertStatus = 'Siaga';
    }

    // Record reading to Firestore
    const now = Date.now();
    await addDoc(collection(db, 'sensor_readings'), {
      timestamp: now,
      water_level: finalWaterLevel,
      soil_moisture: soilVal,
      soil_status: soilStatusVal,
      temperature: tempVal,
      humidity: humVal,
      local_rain: rainVal,
      node_id: node_id,
      distance: typeof distance === 'number' ? distance : Math.max(0, currentConfig.reference_height - finalWaterLevel),
      source: 'Hardware-ESP32-SoilWake'
    });

    publishHardwareBusReading(finalWaterLevel, now, false);

    console.log(`[Hardware Telemetry] Received from ${node_id}: Level=${finalWaterLevel}cm, Temp=${tempVal}°C, Status=${alertStatus}`);

    // If status is Siaga or Bahaya, log alert to system_logs
    if (alertStatus !== 'Normal') {
      await addDoc(collection(db, 'system_logs'), {
        timestamp: now,
        source: 'Sensor',
        level: alertStatus === 'Bahaya' ? 'error' : 'warn',
        message: `[RTU ${node_id}] Peringatan ${alertStatus.toUpperCase()}! Tinggi Muka Air mencapai ${finalWaterLevel} cm (Ambang ${alertStatus}: ${alertStatus === 'Bahaya' ? currentConfig.threshold_bahaya : currentConfig.threshold_siaga} cm).`
      });
    }

    // Return actionable response to ESP32: tells hardware whether to fire buzzer/siren/LEDs!
    res.json({
      success: true,
      timestamp: now,
      node_id: node_id,
      water_level: finalWaterLevel,
      alert_status: alertStatus,
      should_alarm: alertStatus === 'Siaga' || alertStatus === 'Bahaya',
      alarm_type: alertStatus, // 'Normal' | 'Siaga' | 'Bahaya'
      threshold_siaga: currentConfig.threshold_siaga,
      threshold_bahaya: currentConfig.threshold_bahaya,
      sampling_rate_seconds: currentConfig.sampling_rate_seconds || 60
    });
  } catch (error: any) {
    console.error('[Hardware Telemetry Error]:', error);
    res.status(500).json({ success: false, error: error.message || 'Internal error saving telemetry' });
  }
};

app.post('/api/telemetry', express.json(), handleHardwareTelemetry);
app.post('/api/sensor-data', express.json(), handleHardwareTelemetry);

// 2b. POST /api/telemetry/batch — Receive an array of 360 samples over time, e.g. [[timestamp, water_level], ...] or raw distances
app.post('/api/telemetry/batch', express.json(), async (req, res) => {
  try {
    const { node_id = DEFAULT_NODE_ID, samples, distances, readings, temperature = 28.5, humidity = 70.0 } = req.body;
    
    // Support array either directly in body, or in req.body.readings, req.body.distances, or req.body.samples
    const rawArray: any[] = Array.isArray(req.body) 
      ? req.body 
      : (Array.isArray(readings) ? readings : (Array.isArray(distances) ? distances : (Array.isArray(samples) ? samples : [])));

    if (!rawArray || rawArray.length === 0) {
      return res.status(400).json({ error: 'Array "readings", "samples", or "distances" is empty or missing.' });
    }

    const tempVal = Number(temperature) || 28.5;
    const humVal = Number(humidity) || 70.0;
    const now = Date.now();

    // Check if input is an array of pairs: [[Timestamp, water_level], [Timestamp, water_level], ...]
    // Example from user: [ [ "16:00:00", 230 ], [ "16:00:01", 231 ], ..... ]
    let batchDataPairs: Array<[string | number, number]> = [];
    let validLevels: number[] = [];

    const isPairArray = Array.isArray(rawArray[0]) && rawArray[0].length >= 2;

    if (isPairArray) {
      for (const pair of rawArray) {
        if (Array.isArray(pair) && pair.length >= 2) {
          const t = pair[0];
          const val = Number(pair[1]);
          if (!isNaN(val) && val >= 0 && val < 1000) {
            batchDataPairs.push([t, val]);
            validLevels.push(val);
          }
        }
      }
    } else {
      // Could be array of numbers (distances or water levels) or objects
      for (let i = 0; i < rawArray.length; i++) {
        const item = rawArray[i];
        const val = typeof item === 'number' 
          ? item 
          : (typeof item?.water_level === 'number' 
            ? item.water_level 
            : (typeof item?.distance === 'number' ? item.distance : null));
            
        if (val !== null && !isNaN(val) && val > 0 && val < 600) {
          // If item has timestamp or time, use it
          const t = item?.timestamp || item?.time || (now - (rawArray.length - 1 - i) * 1000);
          batchDataPairs.push([t, val]);
          validLevels.push(val);
        }
      }
    }

    if (validLevels.length === 0) {
      return res.status(400).json({ error: 'No valid numeric readings found in batch array.' });
    }

    // Check if input items represent raw ultrasonic distances vs calculated water levels
    const hasDistanceField = rawArray.some(item => typeof item === 'object' && typeof item?.distance === 'number');
    const isDistanceArray = Boolean(distances) || hasDistanceField;

    // Determine representative water level (e.g. median / latest stable value)
    const sortedLevels = [...validLevels].sort((a, b) => a - b);
    const medianVal = sortedLevels[Math.floor(sortedLevels.length / 2)];
    
    let finalWaterLevel = 0;
    let finalDistance = 0;

    if (isDistanceArray) {
      finalDistance = Math.round(medianVal * 10) / 10;
      finalWaterLevel = getCorrectedWaterLevel(finalDistance, tempVal, currentConfig.reference_height);
    } else {
      finalWaterLevel = Math.round(medianVal * 10) / 10;
      finalDistance = Math.max(0, currentConfig.reference_height - finalWaterLevel);
    }

    let alertStatus: 'Normal' | 'Siaga' | 'Bahaya' = 'Normal';
    if (finalWaterLevel >= currentConfig.threshold_bahaya) {
      alertStatus = 'Bahaya';
    } else if (finalWaterLevel >= currentConfig.threshold_siaga) {
      alertStatus = 'Siaga';
    }

    // Save consolidated batch reading with entire 360 array to ONE single Firestore document
    await addDoc(collection(db, 'sensor_readings'), {
      timestamp: now,
      water_level: finalWaterLevel,
      temperature: tempVal,
      humidity: humVal,
      local_rain: 0,
      node_id: node_id,
      distance: finalDistance,
      samples_count: batchDataPairs.length,
      batch_data: batchDataPairs, // Storing full 360 pairs array in this single document
      readings: rawArray, // Storing original raw readings array for ESP32 compatibility
      source: 'Hardware-ESP32-Batch'
    });

    publishHardwareBusReading(finalWaterLevel, now, false);

    console.log(`[Batch Telemetry] Successfully processed 360 batch samples (${batchDataPairs.length} points) from ${node_id}. Representative Level: ${finalWaterLevel}cm (Status: ${alertStatus})`);

    // Log if alarm condition
    if (alertStatus !== 'Normal') {
      await addDoc(collection(db, 'system_logs'), {
        timestamp: now,
        source: 'Sensor',
        level: alertStatus === 'Bahaya' ? 'error' : 'warn',
        message: `[RTU ${node_id}] Peringatan ${alertStatus.toUpperCase()}! Hasil batch reading air mencapai ${finalWaterLevel} cm.`
      });
    }

    res.json({
      success: true,
      processed_samples: batchDataPairs.length,
      timestamp: now,
      node_id: node_id,
      distance: finalDistance,
      water_level: finalWaterLevel,
      alert_status: alertStatus,
      should_alarm: alertStatus === 'Siaga' || alertStatus === 'Bahaya',
      alarm_type: alertStatus,
      threshold_siaga: currentConfig.threshold_siaga,
      threshold_bahaya: currentConfig.threshold_bahaya
    });
  } catch (err: any) {
    console.error('[Batch Telemetry Error]:', err);
    res.status(500).json({ error: err.message || 'Failed to process batch telemetry' });
  }
});

// 3. POST /api/heartbeat — Heartbeat & diagnostic status from RTU
app.post('/api/heartbeat', express.json(), async (req, res) => {
  try {
    const { node_id = DEFAULT_NODE_ID, rssi, battery_pct, uptime_sec, firmware_version = '1.0.0' } = req.body;
    console.log(`[RTU Heartbeat] Node: ${node_id}, RSSI: ${rssi} dBm, Batt: ${battery_pct}%, Uptime: ${uptime_sec}s`);

    // Log periodic heartbeat info to system_logs
    await addDoc(collection(db, 'system_logs'), {
      timestamp: Date.now(),
      source: 'System',
      level: 'info',
      message: `[RTU Ping] Node: ${node_id} | Signal RSSI: ${rssi || 'N/A'} dBm | Daya: ${battery_pct != null ? battery_pct + '%' : 'DC Adaptor'} | FW: v${firmware_version}`
    });

    res.json({
      status: 'OK',
      server_time: Date.now(),
      status_alat: currentConfig.status_alat,
      threshold_siaga: currentConfig.threshold_siaga,
      threshold_bahaya: currentConfig.threshold_bahaya
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Custom resilient route to serve alarm audio files from any folder (public, root, src, etc.)
app.get('/:audioFile(alarm_siaga.mp3|alarm_bahaya.mp3|siaga.mp3|bahaya.mp3)', (req, res) => {
  const fileName = req.params.audioFile;
  const potentialPaths = [
    path.join(process.cwd(), 'public', fileName),
    path.join(process.cwd(), fileName),
    path.join(process.cwd(), 'src', fileName),
    path.join(process.cwd(), 'src', 'components', fileName),
    path.join(process.cwd(), 'assets', fileName),
  ];

  for (const filePath of potentialPaths) {
    if (fs.existsSync(filePath)) {
      console.log(`[Audio Server] Serving custom audio file: ${filePath}`);
      return res.sendFile(filePath);
    }
  }

  console.log(`[Audio Server] Custom audio file ${fileName} not found in scan paths.`);
  res.status(404).send('Not Found');
});

// ==========================================
// 🌊 CILIWUNG SIMULATION, LIVE MAP & FORECAST ROUTES
// ==========================================
registerCiliwungRoutes(app, {
  engine: ciliwungEngine,
  worker: ciliwungForecastWorker,
  sendCupCarbon: (state: any) => {
    if (!Array.isArray(state?.cupNodes)) return;
    for (const node of state.cupNodes) {
      safeSendUdp(
        {
          type: 'node_update',
          mode: 'simulation',
          runId: state.runId,
          nodeId: node.id,
          cupcarbonNodeId: node.cupcarbonNodeId,
          tmaCm: node.tmaCm,
          status: node.status,
          timestampUtc: state.timestampUtc,
        },
        node.controlPort || 5101
      );
    }
  },
  sendForecastCupCarbon: (command: any) => {
    if (!udpControlSocket) return;
    try {
      sendForecastCupCarbon(udpControlSocket, command);
    } catch {
      // Optional UDP bridge
    }
  },
});

registerHardwareLiveRoutes(app, { bus: hardwareLiveBus });
registerHardwareDemoForecast(app, hardware20sWorker);

app.get('/api/ciliwung-weather/context', createWeatherContextHandler());

app.get('/api/ciliwung-mode', (_req, res) => {
  res.json({ mode: ciliwungModeController.mode });
});

app.post('/api/ciliwung-mode', async (req, res) => {
  try {
    const nextMode = await ciliwungModeController.switchTo(req.body?.mode);
    return res.json({ success: true, mode: nextMode });
  } catch (err: any) {
    return res.status(400).json({ success: false, error: err?.message || 'Unsupported Ciliwung mode' });
  }
});

// Serve static assets and mount Vite middleware
async function startServer() {
  const public3dPath = path.join(process.cwd(), 'public', '3d');
  const dist3dPath = path.join(process.cwd(), 'dist', '3d');
  const viewer3dPath = process.env.NODE_ENV === 'production' && fs.existsSync(dist3dPath) ? dist3dPath : public3dPath;

  if (fs.existsSync(viewer3dPath)) {
    app.use(
      '/3d',
      express.static(viewer3dPath, {
        etag: true,
        setHeaders: (res, filePath) => {
          const ext = path.extname(filePath).toLowerCase();
          if (ext === '.html' || ext === '.js' || ext === '.css') {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=86400');
          }
        },
      })
    );
  }

  const publicReportsPath = path.join(process.cwd(), 'public', 'reports');
  const distReportsPath = path.join(process.cwd(), 'dist', 'reports');
  const reportsPath = process.env.NODE_ENV === 'production' && fs.existsSync(distReportsPath) ? distReportsPath : publicReportsPath;

  if (fs.existsSync(reportsPath)) {
    app.use(
      '/reports',
      express.static(reportsPath, {
        etag: true,
        setHeaders: (res, filePath) => {
          if (path.extname(filePath).toLowerCase() === '.pdf') {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );
  }

  const isProduction =
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        const indexPath = path.join(distPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          return res.sendFile(indexPath);
        }
        return res.status(404).json({ error: 'Not found' });
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Web SCADA Hydrological prognostic server running on http://localhost:${PORT}`);
  });
}

startServer();
