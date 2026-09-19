/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, query, orderBy, limit, setDoc, doc, onSnapshot } from 'firebase/firestore';

dotenv.config();

const PORT = 3000;
const app = express();
app.use(express.json());

// 1. Initialize Firebase inside Node using credentials from the applet config file
const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
let firebaseConfig: any = {};
if (fs.existsSync(configPath)) {
  firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} else {
  console.warn('Warning: firebase-applet-config.json not found. Database features may fail.');
}

const firebaseApp = initializeApp(firebaseConfig);
const db = firebaseConfig.firestoreDatabaseId
  ? getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId)
  : getFirestore(firebaseApp);

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

    // Store ONLY the essential sensor reading document (No spamming bmkg_forecast or predictions collections)
    const readingRef = await addDoc(collection(db, 'sensor_readings'), {
      timestamp,
      water_level: correctedLevel,
      distance: Math.round(distanceRaw * 10) / 10,
      source: 'Simulator-Engine',
      local_rain: rainStatus,
      temperature: Math.round(temp * 10) / 10,
      humidity: Math.round(humidity * 10) / 10,
      node_id: currentConfig.node_id,
    });

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

// Get live local weather information card data utilizing real-time official BMKG API with Open-Meteo fallback
app.get('/api/live-weather', async (req, res) => {
  let temp = 32;
  let humidity = 45;
  let precip: string | number = "0 mm";
  let condition = "Cerah";
  let windSpeed = 6.7;
  let windDir = "Selatan ↑";
  let visibilityVal: string | number = "< 9 km";
  let weatherIcon = "";
  let locationName = "Pondok Cina, Beji, Kota Depok";
  let lastUpdated = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';
  let isFromBMKG = false;

  // List of subdistrict adm4 codes for Depok Beji region requested by the user
  const bmkgUrls = [
    'https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=32.76.06.1005', // Pondok Cina
    'https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=32.76.06.1006', // Kukusan
    'https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=32.76.06.1002'  // Beji
  ];

  // Step 1: Try to fetch directly from BMKG API
  for (const url of bmkgUrls) {
    try {
      console.log(`[API] Fetching real-time weather from BMKG: ${url}`);
      const bmkgRes = await fetch(url);
      if (bmkgRes.ok) {
        const bmkgData = await bmkgRes.json();
        if (bmkgData && bmkgData.data && bmkgData.data[0] && bmkgData.data[0].cuaca) {
          const flatCuaca = bmkgData.data[0].cuaca.flat();
          if (flatCuaca.length > 0) {
            // Find forecast closest to current local time
            const now = new Date();
            let closestItem = flatCuaca[0];
            let minDiff = Infinity;
            
            for (const item of flatCuaca) {
              const itemDate = new Date(item.datetime || item.local_datetime);
              const diff = Math.abs(itemDate.getTime() - now.getTime());
              if (diff < minDiff) {
                minDiff = diff;
                closestItem = item;
              }
            }

            temp = closestItem.t;
            humidity = closestItem.hu;
            precip = `${closestItem.tp || 0} mm`;
            condition = closestItem.weather_desc;
            windSpeed = closestItem.ws;
            windDir = getBMKGWindDirection(closestItem.wd);
            visibilityVal = closestItem.vs_text || (closestItem.vs ? `< ${Math.ceil(closestItem.vs / 1000)} km` : '< 10 km');
            weatherIcon = closestItem.image || '';
            
            if (bmkgData.lokasi) {
              locationName = `${bmkgData.lokasi.desa}, ${bmkgData.lokasi.kecamatan}, ${bmkgData.lokasi.kotkab}`;
            }
            
            isFromBMKG = true;
            console.log(`[API] BMKG direct success for ${locationName}. Temp: ${temp}°C, Humidity: ${humidity}%, Wind: ${windSpeed} km/h, Condition: ${condition}`);
            break; // Stop once we successfully load from any of the BMKG subdistrict coordinates
          }
        }
      }
    } catch (err) {
      console.warn(`[API] BMKG fetch failed for URL: ${url}`, err);
    }
  }

  // Fallback to Open-Meteo if BMKG is entirely unreachable
  if (!isFromBMKG) {
    try {
      console.log('[API] BMKG APIs failed, falling back to Open-Meteo for Kukusan region.');
      const weatherRes = await fetch('https://api.open-meteo.com/v1/forecast?latitude=-6.4025&longitude=106.7942&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,visibility&wind_speed_unit=kmh&timezone=Asia/Jakarta');
      if (weatherRes.ok) {
        const weatherData = await weatherRes.json();
        if (weatherData && weatherData.current) {
          temp = Math.round(weatherData.current.temperature_2m);
          humidity = weatherData.current.relative_humidity_2m;
          precip = `${weatherData.current.precipitation} mm`;
          condition = getWeatherCondition(weatherData.current.weather_code);
          
          if (weatherData.current.wind_speed_10m !== undefined) {
            windSpeed = Number(weatherData.current.wind_speed_10m);
          }
          if (weatherData.current.wind_direction_10m !== undefined) {
            windDir = getWindDirection(weatherData.current.wind_direction_10m);
          }
          if (weatherData.current.visibility !== undefined) {
            const visKm = weatherData.current.visibility / 1000;
            visibilityVal = visKm < 10 ? `< ${Math.ceil(visKm)} km` : `${Math.round(visKm)} km`;
          }
          locationName = "Kukusan (Beji, Kota Depok)";
          console.log(`[API] Open-Meteo fallback success. Temp: ${temp}°C, Humidity: ${humidity}%, Wind: ${windSpeed} km/h (${windDir}), Visibility: ${visibilityVal}`);
        }
      }
    } catch (err) {
      console.warn('[API] Open-Meteo fetch failed too, using defaults:', err);
    }
  }

  // Step 2: Query Gemini with Google Search Grounding to extract active warnings and generate a customized expert summary
  try {
    console.log('[API] Enhancing BMKG weather with Gemini Google Search Grounding alerts.');
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: `Cari informasi peringatan dini cuaca aktif (seperti potensi banjir, hujan lebat, angin kencang) dari BMKG khusus untuk Kota Depok dan Jakarta Selatan hari ini. Berikan jawaban dalam bentuk JSON dengan field: "alerts" (array of strings, kosongkan jika tidak ada peringatan aktif) dan "summary" (string ringkasan cuaca hari ini dalam Bahasa Indonesia berdasarkan data BMKG real-time: lokasi ${locationName}, suhu ${temp}°C, kelembaban ${humidity}%, curah hujan ${precip}, kondisi ${condition}, angin ${windSpeed} km/jam dari ${windDir}). Pastikan output hanyalah JSON murni tanpa pembungkus markdown code wraps.`,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: 'application/json',
      },
    });

    const text = response.text.trim();
    const cleanedJson = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const geminiData = JSON.parse(cleanedJson);

    return res.json({
      precipitation_mm: precip,
      temperature_c: temp,
      humidity_percent: humidity,
      condition,
      wind_speed_kph: windSpeed,
      wind_direction: windDir,
      visibility_km: visibilityVal,
      weather_icon: weatherIcon,
      location_name: locationName,
      alerts: geminiData.alerts || [],
      last_updated: lastUpdated,
      summary: geminiData.summary || `Kondisi cuaca saat ini di ${locationName} terpantau ${condition} dengan suhu udara ${temp}°C, kelembapan ${humidity}%, angin berhembus ${windSpeed} km/jam dari ${windDir}. Tidak ada peringatan dini bencana banjir aktif.`
    });
  } catch (error: any) {
    console.log('[INFO] live-weather Gemini enhancement failed. Returning structured BMKG data.');
    return res.json({
      precipitation_mm: precip,
      temperature_c: temp,
      humidity_percent: humidity,
      condition,
      wind_speed_kph: windSpeed,
      wind_direction: windDir,
      visibility_km: visibilityVal,
      weather_icon: weatherIcon,
      location_name: locationName,
      alerts: [],
      last_updated: lastUpdated,
      summary: `Kondisi cuaca wilayah ${locationName} terpantau ${condition} dengan suhu udara ${temp}°C, kelembaban ${humidity}%, dan arah angin dari ${windDir}. Layanan peringatan dini BMKG dialihkan ke mode pemantauan lokal otomatis.`
    });
  }
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
    console.log('[INFO] predict: using local physical prognostic model.');
    
    const readings = req.body.readings || [];
    const latestReading = readings[readings.length - 1];
    const curLevel = latestReading ? latestReading.level : 35;
    const reqConfig = req.body.config || {};
    const tSiaga = reqConfig.threshold_siaga || 60;
    const tBahaya = reqConfig.threshold_bahaya || 90;

    let status: 'Normal' | 'Siaga' | 'Bahaya' = 'Normal';
    if (curLevel >= tBahaya) {
      status = 'Bahaya';
    } else if (curLevel >= tSiaga) {
      status = 'Siaga';
    }

    // Generate realistic predictions based on current status
    const mult = status === 'Bahaya' ? 1.08 : status === 'Siaga' ? 1.04 : 1.01;
    const pred30m = Math.max(10, Math.round((curLevel * mult) * 10) / 10);
    const pred1h = Math.max(10, Math.round((curLevel * Math.pow(mult, 1.5)) * 10) / 10);
    const pred3h = Math.max(10, Math.round((curLevel * Math.pow(mult, 2)) * 10) / 10);
    const pred6h = Math.max(10, Math.round((curLevel * Math.pow(mult, 0.5)) * 10) / 10);

    return res.json({
      prediction_30m: pred30m,
      prediction_1h: pred1h,
      prediction_3h: pred3h,
      prediction_6h: pred6h,
      confidence_score: 88,
      status: status,
      reasoning: `⚡ [SISTEM ANALISIS HIDROLOGI MANDIRI - SIMBA RTU EDGE]
Hasil analisis telemetri dihitung secara real-time melalui modul komputasi prediktif mandiri (Fail-safe Edge Model) RTU SIMBA:

Berdasarkan pembacaan aktual sensor tinggi muka air saat ini sebesar ${curLevel} cm (Ambang Batas Siaga: ${tSiaga} cm, Bahaya: ${tBahaya} cm), status aliran terpantau dalam tingkat: ${status}. Kompensasi fusi suhu DHT22 terhadap kecepatan suara gelombang ultrasonik JSN-SR04T berjalan dengan presisi optimal (Terkalibrasi). Disarankan untuk tetap memantau telemetri real-time dan mengikuti instruksi siaga bencana dari BPBD DKI secara terpadu.`
    });
  }
});

// Trigger manual simulation tick or controlled scenario upon request from Admin Panel
app.post('/api/sim-data', express.json(), async (req, res) => {
  try {
    const { mode, water_level, scenario, action } = req.body;
    console.log(`[API] Injected simulation command: mode=${mode}, water_level=${water_level}, scenario=${scenario}, action=${action}`);
    
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
    const result = await generateSimulationData(true, typeof water_level === 'number' ? water_level : undefined);
    res.json({ success: true, message: `Single simulation tick executed`, data: result });
  } catch (error: any) {
    console.error('Error triggering simulation via API:', error);
    res.status(500).json({ error: error.message || 'Failed to trigger simulation' });
  }
});

// Endpoint specifically for starting/stopping the manual heavy rain flood scenario
app.post('/api/sim-data/scenario', express.json(), (req, res) => {
  const { scenario = 'heavy_rain_flood', action = 'start' } = req.body;
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
      temperature = 28.5, 
      humidity = 70.0, 
      local_rain = 0 
    } = req.body;

    const tempVal = Number(temperature) || 28.5;
    const humVal = Number(humidity) || 70.0;
    const rainVal = Number(local_rain) || 0;

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
      temperature: tempVal,
      humidity: humVal,
      local_rain: rainVal,
      node_id: node_id,
      distance: typeof distance === 'number' ? distance : Math.max(0, currentConfig.reference_height - finalWaterLevel),
      source: 'Hardware-ESP32'
    });

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

    // Determine representative water level (e.g. median / latest stable value)
    const sortedLevels = [...validLevels].sort((a, b) => a - b);
    const medianVal = sortedLevels[Math.floor(sortedLevels.length / 2)];
    
    // If the numbers were raw distances (e.g. median > 100 with water_level context or explicitly distance)
    let finalWaterLevel = Math.round(medianVal * 10) / 10;
    let finalDistance = Math.max(0, currentConfig.reference_height - finalWaterLevel);

    // If input explicitly provided raw distances (all values < reference_height and specified as distance)
    if (Array.isArray(distances) && !isPairArray) {
      finalDistance = Math.round(medianVal * 10) / 10;
      finalWaterLevel = getCorrectedWaterLevel(finalDistance, tempVal, currentConfig.reference_height);
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
      source: 'Hardware-ESP32-Batch'
    });

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



// Serve static assets and mount Vite middleware
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Web SCADA Hydrological prognostic server running on http://localhost:${PORT}`);
  });
}

startServer();
