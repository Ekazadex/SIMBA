# 🖥️ BACKEND, CLOUD & SIMULATION SUBSYSTEM — SIMBA SCADA

Direktori ini memuat arsitektur dan layanan **Backend Server (Express + TypeScript)**, integrasi **Firebase Firestore**, *caching* **API BMKG**, *inference* **Model LSTM & Gemini AI**, integrasi batch telemetri **Node ESP32 WROOM**, serta engine **Simulasi 9-Node DAS Ciliwung & CupCarbon**.

---

## 👥 Penanggung Jawab Sub-Sistem
- **Lead Backend & Cloud Engineer:** Muhammad Iqbal Alfajri
- **Simulasi DAS Ciliwung & CupCarbon:** Naufal Hani Zakwan
- **Tanggung Jawab Utama:**
  - Arsitektur Cloud Database **Firebase Firestore** (`sensor_readings`, `system_config`, `system_logs`, `bmkg_forecast`, `predictions`).
  - REST API ingest telemetri tunggal & batch (`POST /api/telemetry/batch` untuk paket 360 sampel LittleFS dari ESP32 WROOM).
  - Pipeline koreksi jarak ultrasonik ($v = 331.3 + 0.606 \times T$) & konversi ke elevasi air ($\text{Tinggi Referensi} - \text{Jarak}$).
  - *Caching* prakiraan cuaca **API BMKG** di Firestore untuk mitigasi kendala SLA API eksternal.
  - Endpoint prediksi **Model LSTM** (`model_lstm_banjir.h5`) dan asisten analisis banjir **Gemini AI** (`@google/genai`).
  - Engine propagasi hidrologi **9 Stasiun DAS Ciliwung (`UP1 Puncak` → `N5 Manggarai`)** & bridge telemetri **CupCarbon** (logger port `5005`, ekspor `rekap_banjir.csv`).

---

## 📂 Struktur Modul Backend

```text
/
├── server.ts                            # Entry Point Server Express + TypeScript, REST API & Vite Middleware
├── backend/
│   ├── ciliwung/
│   │   ├── ciliwung-api.mjs             # REST & SSE Endpoints Simulasi 9-Node DAS Ciliwung
│   │   ├── simulation-engine.mjs        # Propagasi Hidrologi Deterministik 9 Stasiun (UP1 → N5)
│   │   ├── cupcarbon-telemetry.mjs      # Integrasi & Receiver Telemetri Jaringan CupCarbon (Port 5005)
│   │   ├── rain-replay.mjs              # Engine Replay Episode Hujan Sintetis 24 Jam
│   │   ├── forecast-worker.mjs          # Worker Proyeksi Elevasi
│   │   ├── forecast-udp.mjs             # Kanal Forecast UDP
│   │   ├── hardware-live.mjs            # Adapter Data Hardware Lapangan ke Peta Koridor
│   │   ├── hardware-demo-forecast.mjs   # Proyeksi Demo Hardware
│   │   ├── scenario-preview.mjs         # Preview Kurva Skenario Hujan (Ringan/Sedang/Lebat)
│   │   └── weather-context.mjs          # Konteks Cuaca BMKG Koridor Ciliwung
│   └── README.md                        # Dokumentasi Spesifikasi Backend & API (File ini)
├── firebase-blueprint.json              # Skema Entitas & Koleksi Firebase Firestore
├── firestore.rules                      # Security Rules Database Firestore
└── .env.example                         # Template Environment Variables (GEMINI_API_KEY, Firebase, CORS)
```

---

## 🔌 Daftar REST API Aktif

### 1. Telemetri & Manajemen Node IoT (`ESP32 WROOM`)
| Method & Endpoint | Fungsi |
|---|---|
| `POST /api/telemetry/batch` | Menerima batch **360 sampel** (`distance`, `timestamp`) yang diunggah ESP32 WROOM dari memori flash **LittleFS** via Wi-Fi saat *capacitive soil sensor* mendeteksi kondisi basah. |
| `POST /api/telemetry` *(alias `/api/sensor-data`)* | Menerima pembacaan sensor tunggal real-time, menghitung elevasi air, menyimpan ke Firestore, dan mengembalikan status alarm (`Normal` / `Siaga` / `Bahaya`). |
| `POST /api/heartbeat` | Menerima status *online/offline*, kekuatan sinyal Wi-Fi (`rssi`), persentase baterai, dan `uptime_sec` dari node lapangan. |
| `GET /api/config` | Mengambil parameter ambang batas `threshold_siaga`, `threshold_bahaya`, `reference_height`, dan interval sampling terbaru. |
| `GET /api/health` | Pemeriksaan status operasional server backend. |

### 2. Prediksi LSTM, Cuaca BMKG & Asisten AI
| Method & Endpoint | Fungsi |
|---|---|
| `POST /api/predict` | Memproses analisis & prediksi kondisi banjir berbasis **Gemini AI** (`@google/genai`) + konteks sensor dan BMKG. |
| `POST /api/lstm-predict` | Menjalankan inferensi model deep learning **LSTM** untuk proyeksi elevasi **T+30m, T+1 Jam, T+3 Jam, T+6 Jam**. |
| `GET /api/live-weather` | Mengambil prakiraan cuaca aktual **API BMKG** dengan *in-memory cache* 3 menit, batas *timeout*, *fallback* Open-Meteo & *stale snapshot*, serta parameter `?force=1` untuk muat ulang paksa. |
| `POST /api/search-news` | Menarik ringkasan informasi cuaca dan berita kondisi banjir terkini. |
| `POST /api/sim-data` | Memicu injeksi data simulasi (*normal / siaga / bahaya*) untuk pengujian & demo dashboard. |

### 3. Simulasi 9-Node DAS Ciliwung & CupCarbon
| Method & Endpoint | Fungsi |
|---|---|
| `GET /api/ciliwung-simulation/scenarios` | Daftar skenario hujan deterministik (`ringan`, `sedang`, `lebat`). |
| `GET /api/ciliwung-simulation/state` | State terkini seluruh 9 node (`UP1 Puncak` → `N5 Manggarai`) termasuk koordinat 3D (`N1`–`N5`). |
| `GET /api/ciliwung-simulation/history` | Riwayat *time-series* simulasi untuk grafik & masukan jendela LSTM. |
| `GET /api/ciliwung-simulation/stream` | *Server-Sent Events (SSE)* pembaruan *real-time* status 9 node simulasi. |
| `POST /api/ciliwung-simulation/start` | Memulai simulasi propagasi hidrologi untuk skenario terpilih. |
| `POST /api/ciliwung-simulation/replay/start` | Memulai mode *Replay* episode hujan 24 jam. |
| `POST /api/ciliwung-simulation/speed` | Mengatur percepatan waktu simulasi (`1x`, `10x`, `25x`, `50x`, `150x`). |
| `POST /api/ciliwung-simulation/stop` & `/reset` | Menghentikan atau mereset state simulasi ke kondisi awal. |
| `GET /api/ciliwung-weather/context` | Mengambil konteks cuaca koridor DAS Ciliwung. |

---

## 📦 Contoh Payload Batch ESP32 (`POST /api/telemetry/batch`)

```json
{
  "node_id": "node-ciliwung-01",
  "samples": [
    { "distance": 185.4, "timestamp": 1732450000000 },
    { "distance": 184.9, "timestamp": 1732450001000 }
  ],
  "soil_wet": true
}
```

> **Catatan Firmware (`ESP32_Firebase_WiFi_JSNSensor_Deepsleep`):**  
> ESP32 WROOM mengumpulkan 360 sampel (~6 menit) menggunakan **Median Filter (N=5)** di **LittleFS**, lalu mengunggahnya via Wi-Fi ketika *capacitive soil sensor* (`GPIO34`) mendeteksi kondisi basah.
