# Menjalankan SIMBA dan viewer 3D

Viewer 3D ada di `public/3d/` dan ikut disalin ke `dist/3d/` saat build. Website dan viewer menggunakan origin yang sama untuk file dan stream API, sehingga pengunjung tidak perlu menjalankan server di perangkatnya. Salinan viewer ini berasal dari folder workspace `flood_3d_visual_map`; perubahan di folder sumber tidak otomatis tersalin ke sini.

## Menjalankan hasil build

Server harus menjalankan Node.js dengan dependensi proyek terpasang. Dari direktori repositori:

```sh
npm ci
npm run build
npm start
```

`PORT` menentukan port HTTP; default `3000`. Gunakan platform yang menjalankan proses Node persisten, atau tempatkan reverse proxy HTTPS di depannya. Arahkan semua path, termasuk `/3d/` dan `/api/`, ke aplikasi ini. Proxy harus mendukung koneksi SSE yang berumur panjang dan tidak melakukan buffering pada respons stream. Gunakan satu instance backend: mode dan simulasi masih berupa state bersama di memori proses.

Variabel `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, dan `VITE_FIREBASE_APP_ID` digunakan oleh browser dan backend. Bila memakai database bernama, atur juga `VITE_FIRESTORE_DATABASE_ID`; untuk database default kosongkan. Atur variabel sebelum **build** karena Vite menyertakannya dalam kode browser, dan sediakan juga saat server berjalan. `VITE_FIREBASE_STORAGE_BUCKET` dan `VITE_FIREBASE_MESSAGING_SENDER_ID` dipakai bila diperlukan konfigurasi Firebase. Nilai `VITE_` bersifat publik; jangan masukkan kredensial rahasia di dalamnya. Simpan kunci layanan lain seperti `GEMINI_API_KEY` hanya pada konfigurasi rahasia server.

Periksa `/3d/` dan kedua endpoint `/api/ciliwung-hardware/stream` serta `/api/ciliwung-simulation/stream` melalui domain HTTPS setelah deployment. Uji data sensor sebenarnya secara terpisah. Fitur prediksi tertentu juga dapat memerlukan runtime Python, data, dan model yang tidak otomatis tersedia di server.

## Sebelum dibuka ke publik

Jangan menganggap deployment ini aman hanya karena 3D sudah dapat dimuat. File `firestore.rules` lokal saat ini mengizinkan baca dan tulis untuk semua orang; periksa aturan yang benar-benar aktif di Firebase dan rancang aturan serta autentikasi sesuai kebutuhan sebelum membuka layanan. Sejumlah API perubahan data, telemetri, dan kontrol simulasi juga belum dilindungi autentikasi server. Login atau pembatasan di browser saja tidak cukup. Simulasi dan mode saat ini dibagi semua pengunjung, sehingga kontrol satu pengunjung memengaruhi yang lain. Amankan API dan tentukan model akses serta isolasi sesi sebelum layanan dibuka untuk umum.

CupCarbon menggunakan UDP localhost:5005 dan pengiriman ke localhost. CupCarbon di laptop tidak otomatis terhubung ke backend di cloud. Integrasi jarak jauh memerlukan rancangan koneksi terpisah dan aman; jangan membuka port UDP begitu saja. Menjalankan viewer 3D tidak memerlukan CupCarbon.
