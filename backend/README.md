# 🖥️ BACKEND SUBSYSTEM — SIMBA SCADA IOT

Folder ini memuat arsitektur dan layanan **Backend Server**, **Database Cloud**, dan **Integrasi Hardware RTU/ESP32** untuk sistem monitoring banjir SIMBA.

---

## 👥 Penanggung Jawab Sub-Sistem
* **Lead Backend Engineer:** Iqbal
* **Tanggung Jawab:**
  - Arsitektur Database Cloud Firebase Firestore (`sensor_readings`, `system_config`, `system_logs`)
  - Pengembangan REST API Express (`/api/telemetry`, `/api/config`, `/api/heartbeat`, `/api/sim-data`)
  - Algoritma Fusi Sensor (JSN-SR04T + DHT22 Temperature Compensation)
  - Engine AI Google Gemini (`@google/genai`) untuk prediksi hidrologi
  - Dokumentasi API & Integrasi Hardware Mikrokontroler ESP32

---

## 📂 Struktur Modul Backend
```text
/
├── server.ts                  # Entry Point Server Express & Vite Middleware
├── backend/                   # Direktori Dokumentasi & Spesifikasi Backend
│   └── README.md              # Spesifikasi Lengkap Modul Backend
├── firebase-applet-config.json # Konfigurasi Kredensial Firebase Firestore
├── firestore.rules            # Security Rules Keamanan Database
└── .env.example               # Template Variabel Lingkungan (GEMINI_API_KEY)
```

---

## 🔌 Daftar REST API Aktif
1. `GET /api/config` — Mengambil parameter ambang batas Siaga, Bahaya, dan tinggi referensi sensor.
2. `POST /api/telemetry` — Menerima data telemetri jarak (cm) dan suhu (°C) dari ESP32 di lapangan.
3. `POST /api/heartbeat` — Menerima status sinyal WiFi (RSSI), baterai, dan uptime alat.
4. `POST /api/sim-data` — Triger simulasi skenario air surut, hujan deras, dan banjir bandang.
5. `POST /api/gemini-analysis` — Memproses prediksi luapan air menggunakan model AI Google Gemini.
6. `GET /api/search-news` — Menarik informasi cuaca dan berita banjir terkini.
