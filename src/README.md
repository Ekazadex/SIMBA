# 🎨 FRONTEND SUBSYSTEM — SIMBA SCADA IOT

Folder ini (`src/`) memuat seluruh source code antarmuka pengguna (**Frontend Web SCADA Client**) berbasis **React 19**, **TypeScript**, dan **Tailwind CSS**.

---

## 👥 Penanggung Jawab Sub-Sistem
* **Lead Frontend Engineer:** Ekananda Zhafif Dean (Eka)
* **Tanggung Jawab:**
  - Desain & Pengembangan Dashboard Antarmuka SCADA (`src/components/SCADADashboard.tsx`)
  - Visualisasi Grafik Hidrograf Tren Kenaikan Air 24 Jam (`recharts`)
  - Panel Kontrol Admin & Kalibrasi Sensor (`src/components/AdminPanel.tsx`)
  - Sistem Indikator Audio & Alarm Immersive Darurat (Web Audio API)
  - Desain Industrial SCADA Responsif & Dual-Theme (Dark Mode / Light Mode)
  - Data Binding Realtime Snapshot Listener Firestore ke State React

---

## 📂 Struktur File Frontend (`src/`)
```text
src/
├── components/
│   ├── SCADADashboard.tsx    # Komponen Utama Dashboard SCADA (Gauge, Chart, Cuaca, Status RTU)
│   └── AdminPanel.tsx        # Panel Kontrol Admin, Kalibrasi Sensor & Slider Injeksi Manual
├── firebaseConfig.ts         # Inisialisasi Firebase Client SDK untuk Realtime Listener
├── types.ts                  # Definisi TypeScript Interface & Tipe Data Telemetri
├── index.css                 # Styling Global & Utilitas Tailwind CSS v4
├── App.tsx                   # Root Layout & Navigasi Dashboard / Admin Panel
├── main.tsx                  # React DOM Entry Point
└── README.md                 # Dokumentasi Khusus Tim Frontend
```
