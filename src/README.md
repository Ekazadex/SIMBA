# 🎨 FRONTEND SUBSYSTEM — SIMBA WEB SCADA

Direktori `src/` memuat seluruh *source code* antarmuka pengguna **Web SCADA SIMBA** (*Sistem Prediksi Elevasi Air Sungai Berbasis Deep Learning Menggunakan Fusi Data Sensor Ultrasonik dan Prakiraan Cuaca BMKG*) yang dikembangkan oleh **Kelompok 12**.

---

## 👥 Penanggung Jawab & Kontributor Frontend
- **Lead Frontend & Web SCADA:** Ekananda Zhafif Dean
- **Simulasi 3D DAS Ciliwung (Three.js):** Naufal Hani Zakwan
- **Ruang Lingkup Utama:**
  - Dashboard monitoring elevasi air real-time Depok–Jakarta terhubung langsung ke **Firebase Firestore**.
  - Visualisasi kurva elevasi aktual & proyeksi **LSTM terlatih (`model_lstm_banjir.h5`)** multi-horizon (**T+30m, T+1 Jam, T+3 Jam, T+6 Jam**).
  - Visualisasi **Simulasi 3D Sungai Ciliwung** (5 node utama `N1`–`N5` hingga Laut Jawa) dan **Peta Koridor 2D** (9 stasiun `UP1 Puncak` → `N5 Manggarai`).
  - Panel Admin PLC untuk kalibrasi tinggi referensi, pengaturan ambang batas **Siaga (`≥ 60 cm`)** / **Bahaya (`≥ 90 cm`)**, dan simulasi uji.
  - Deteksi perangkat *offline* / data lama (*stale*), konteks prakiraan cuaca **BMKG**, asisten **Gemini AI**, serta alarm suara darurat (**Web Audio API**).
  - Dukungan penuh *smartphone* (tanpa instalasi aplikasi), **Dark/Light Mode**, dan dwibahasa **Indonesia / Inggris (ID/EN)**.

---

## 📂 Struktur File Frontend (`src/`)

```text
src/
├── components/
│   ├── SCADADashboard.tsx           # Dashboard Utama (Gauge TMA, Grafik Aktual+LSTM 4 Horizon, BMKG, Gemini AI)
│   ├── AdminPanel.tsx               # Panel Kontrol PLC, Kalibrasi Tinggi Referensi, Threshold & Injeksi Uji
│   ├── CiliwungSimulationPage.tsx   # Halaman Simulasi 9-Node DAS Ciliwung (Tab Peta 3D/2D & Grafik LSTM)
│   ├── CiliwungOfficial3DView.tsx   # Viewport Visualisasi 3D Sungai Ciliwung (Three.js N1–N5)
│   ├── CiliwungHardwareLiveView.tsx # Peta Koridor 2D Leaflet (9 Node) & Integrasi Sensor Live
│   ├── Ciliwung3DMap.tsx            # Peta 3D Interaktif
│   ├── Ciliwung3DViewer.tsx         # Wrapper Renderer 3D
│   └── ciliwung-graph-scale.json    # Konfigurasi Skala Grafik Simulasi
├── ciliwung3d/                      # Engine 3D DAS Ciliwung (Terrain, River, Floodplain, Sensor Node, Kamera)
├── lib/ciliwung3d/                  # Loader Aset & Utilitas Scene 3D
├── ml/
│   ├── lstmEngine.ts                # Forward-pass Deterministik LSTM di Browser (10–100 ms, 4 Horizon)
│   └── lstmModelWeights.json        # Bobot Model Terlatih dari model_lstm_banjir.h5 (29.857 parameter)
├── utils/
│   ├── alarmAudio.ts                # Synthesizer & Audio Loop Alarm Siaga/Bahaya (Web Audio API)
│   ├── apiBase.ts                   # Resolver Base URL Backend (Local / Railway / Vercel Split Deploy)
│   └── readingUtils.ts              # Utilitas Pemrosesan Pembacaan Sensor
├── firebaseConfig.ts                # Inisialisasi Firebase Client SDK (Realtime Snapshot Listener)
├── types.ts                         # Definisi Interface & Tipe Data Telemetri SCADA
├── index.css                        # Styling Global Tailwind CSS v4
├── App.tsx                          # Root Layout, Navigasi (Dashboard, Simulasi, PLC), Tema & Bahasa
├── main.tsx                         # React DOM Entry Point
└── README.md                        # Dokumentasi Khusus Frontend
```

---

## 🛠️ Stack Frontend
- **React 19** + **TypeScript 5.8** + **Vite 6**
- **Tailwind CSS v4** + **Lucide React**
- **Recharts** (Grafik Elevasi Aktual & Proyeksi LSTM 4 Horizon)
- **Three.js** (Simulasi 3D DAS Ciliwung N1–N5)
- **Leaflet & MapLibre GL** (Peta Koridor 2D 9 Stasiun)
- **Firebase Web SDK** (Sinkronisasi *real-time* koleksi `sensor_readings`, `system_config`, `system_logs`)
