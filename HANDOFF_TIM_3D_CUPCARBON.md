# Handoff tim: SIMBA, 3D, dan CupCarbon

Tanggal: 18 November 2026. Dokumen ini menjelaskan kondisi workspace saat handoff dan rancangan integrasi yang **belum diimplementasikan**. Periksa kembali branch dan kode sebelum mulai karena kondisi bisa berubah.

## Status penting

- Repo website: `D:\Documents\Semester7\Despro2\Website\SIMBA`, branch `naufal_revamp_final`, commit dasar `860b103` (`Create SESSION_HANDOFF.md`).
- Penyesuaian 3D untuk deployment, file `DEPLOYMENT.md`, dan dokumen ini masih **perubahan lokal yang belum di-commit atau di-push** saat dokumen dibuat. Tim tidak akan mendapatkannya hanya dengan menarik branch dari GitHub. Sertakan perubahan ini dalam commit/transfer yang disepakati sebelum handoff.
- Website belum di-deploy secara publik. Server/domain belum ditentukan. Bridge CupCarbon ↔ server **belum dibuat dan belum diuji**.
- Terdapat `SESSION_HANDOFF.md` di repo yang mencatat bahwa grafik yang lebih lengkap pernah dikerjakan tetapi tidak ditemukan pada checkout tersebut. Jangan berasumsi fitur grafik itu tersedia; periksa kode dan riwayat bila diperlukan.

## Kondisi dan alur saat ini

```text
ESP32 → Firebase/Firestore → backend SIMBA → stream hardware → website + 3D

Laptop lokal:
CupCarbon ⇄ UDP localhost ⇄ backend SIMBA → stream simulasi → website + 3D
```

- Website React/Vite dan backend Express ada di repo ini. Viewer 3D adalah HTML/JavaScript dan aset statis; rendering berjalan di browser pengunjung. Data live/simulasi diterima lewat Server-Sent Events (SSE).
- Viewer asal ada di `D:\Documents\Semester7\Despro2\flood_3d_visual_map`. Salinan yang akan ikut repo sekarang ada di `public/3d/`; Vite menyalinnya ke `dist/3d/` saat build. Perubahan pada folder asal **tidak otomatis** mengubah salinan di repo.
- `src/components/CiliwungHardwareLiveView.tsx` membuka iframe `/3d/` dengan `mode=hardware` dan `/api/ciliwung-hardware/stream`. `src/components/CiliwungSimulationPage.tsx` menggunakan `mode=backend` dan `/api/ciliwung-simulation/stream`. Keduanya memakai origin website yang sama, bukan `127.0.0.1:8765` milik pengunjung.
- Di mode hardware, N1 menggunakan data ESP32 bila tersedia; N2–N5 merupakan preset turunan visual, bukan pembacaan sensor fisik. Simulasi, data aktual, dan prediksi eksperimental perlu tetap dibedakan dalam tampilan dan interpretasi.
- Viewer bisa ditampilkan tanpa CupCarbon. Data dan fitur yang bergantung pada CupCarbon tidak otomatis tersedia bila CupCarbon terputus.

## Menjalankan dan menghubungkan 3D di server

Persiapan build dan konfigurasi selengkapnya ada di `DEPLOYMENT.md`. Ringkasnya, dari repo dengan Node.js dan konfigurasi Firebase yang sesuai:

```sh
npm ci
npm run build
npm start
```

`npm start` menjalankan server mode produksi; `PORT` diambil dari environment (default `3000`). Host perlu mendukung proses Node yang terus berjalan. Sajikan `/`, `/3d/`, dan `/api/` lewat origin HTTPS yang sama; bila memakai reverse proxy, dukung koneksi SSE yang panjang dan nonaktifkan buffering untuk stream. Firebase `VITE_...` harus disediakan saat build dan runtime sesuai `DEPLOYMENT.md`. Jangan menyertakan file `.env` atau kunci rahasia dalam handoff.

Setelah hosting siap, uji website dan `/3d/` dari perangkat lain, lalu periksa kedua stream, pergerakan 3D, dan pembacaan ESP32 nyata. Uji melalui domain HTTPS, bukan hanya localhost. Saat ini engine simulasi/mode disimpan di memori dan dibagi antar pengguna; gunakan satu instance atau rancang ulang penyimpanan dan isolasi sesi sebelum memperbanyak instance.

## CupCarbon: apa yang ada sekarang

`server.ts` mengirim perintah UDP ke `127.0.0.1` pada port node `5101–5109`. Pemetaan node/port simulasi ada di `backend/ciliwung/simulation-engine.mjs`; mapping hardware hilir ada di `backend/ciliwung/hardware-live.mjs`. Perintah simulasi mencakup `node_update`; pesan forecast terpisah dikirim melalui `backend/ciliwung/forecast-udp.mjs`.

Telemetri CupCarbon diterima backend pada UDP `127.0.0.1:5005` oleh `backend/ciliwung/cupcarbon-telemetry.mjs`, yang memvalidasi format dan nama node. Ini hanya bekerja langsung saat CupCarbon dan backend berada pada mesin yang sama. Port localhost di server cloud menunjuk ke server cloud, bukan laptop operator.

Launcher workspace `D:\Documents\Semester7\Despro2\RUN_SIMBA_LOCAL.bat` menjalankan lingkungan lokal, termasuk viewer lama port 8765 dan CupCarbon. Proyek CupCarbon berada di `D:\Documents\Semester7\Despro2\Flood Detection System Ciliwung\Flood Detection System Ciliwung - CupVisual`. Viewer lama standalone dan salinan `public/3d/` adalah dua salinan terpisah. Untuk CupCarbon lokal, proyek mungkin perlu dibuka dan IoT Play ditekan.

## Usulan bridge: CupCarbon di laptop, SIMBA di server

Ini rancangan untuk tim, **bukan fitur yang sudah tersedia**:

```text
Laptop operator                                  Server
CupCarbon ⇄ UDP loopback ⇄ program bridge ⇄ WSS ⇄ backend SIMBA → SSE → browser/3D
```

1. Jalankan bridge di laptop bersama CupCarbon. Bridge membuat koneksi keluar WSS ke backend, bukan membuka UDP CupCarbon ke internet.
2. Tambahkan endpoint bridge di server dengan autentikasi kredensial yang disimpan aman, TLS, validasi pesan, batas ukuran/frekuensi, dan kontrol bridge yang diizinkan. Jangan kirim rahasia ke kode browser atau repo.
3. Teruskan perintah server ke port CupCarbon lokal yang benar dan telemetri dari CupCarbon kembali ke backend. Pertahankan format/pemetaan `node_update`, `forecast_update`, dan telemetri yang berlaku; desain mekanisme pengiriman kedua arah bersama tim sebelum mengubah kontrak.
4. Pastikan bridge yang menerima telemetri pada UDP 5005 tidak berebut port dengan backend lokal yang masih aktif. Jika keduanya harus berjalan bersamaan, rancang pembagian port atau penerusan secara eksplisit.
5. Sediakan reconnect/backoff, status online/offline dan waktu data terakhir, serta aturan mencegah perintah lama dijalankan kembali setelah reconnect. Atur perilaku saat laptop atau internet mati; jangan tampilkan data lama seolah live.
6. Setelah server tersedia, uji sembilan node, kedua arah pesan, forecast bila dipakai, koneksi terputus/tersambung kembali, serta penolakan kredensial atau pesan yang tidak sah. Pastikan setiap kontrol publik memiliki otorisasi.

Alternatifnya, jalankan CupCarbon dan backend pada host yang sama bila lingkungan server mendukung. Fitur 3D tidak mengharuskan bridge selesai lebih dahulu.

## Keamanan dan bukti pengujian

- File `firestore.rules` lokal mengizinkan read/write semua pengguna. **Belum diketahui apakah aturan tersebut aktif di Firebase.** Periksa aturan aktif dan rancang hak akses sesuai identitas sensor, operator, dan pengunjung. Beberapa API perubahan data/kontrol saat ini juga belum dilindungi autentikasi server. Jangan buka layanan ke publik sebelum ditangani.
- Sebelum handoff ini, `npm test` lulus 84/84 dan `npm run build` berhasil. Server produksi lokal menyajikan halaman, aset 3D, dan dua stream SSE saat dicek. Ini bukan uji end-to-end lewat internet atau uji aktual perangkat.
- Saat pemeriksaan server produksi lokal, UDP 5005 sudah digunakan proses lain sehingga listener CupCarbon pada proses uji tidak bisa bind. Jangan menafsirkan pemeriksaan tersebut sebagai bukti integrasi CupCarbon berhasil. Tidak ada pengujian baru yang dilakukan saat membuat dokumen handoff ini.
- Masih diperlukan pengujian browser dan 3D di deployment publik, sensor ESP32/Firestore nyata, serta bridge/CupCarbon setelah diimplementasikan. Lihat `DEPLOYMENT.md` untuk catatan tambahan konfigurasi, keamanan, dan keterbatasan model.
