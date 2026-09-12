/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { db, auth, handleFirestoreError, OperationType } from '../firebaseConfig';
import { doc, setDoc, updateDoc, collection, addDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { SystemConfig, SystemLog } from '../types';
import { 
  Sliders, 
  Play, 
  Settings, 
  RefreshCw, 
  ToggleLeft, 
  ToggleRight, 
  Terminal, 
  ShieldCheck, 
  CloudRain, 
  Sun, 
  Flame, 
  AlertOctagon, 
  Info, 
  Key, 
  Lock,
  Compass,
  AlertTriangle,
  Volume2,
  Bell,
  VolumeX,
  RotateCcw,
  Radio,
  ClipboardCheck,
  Send,
  History,
  CheckCircle2,
  Ruler,
  UserCheck,
  FileText
} from 'lucide-react';

interface AdminPanelProps {
  config: SystemConfig | null;
  onUpdateConfig: (newConfig: Partial<SystemConfig>) => Promise<void>;
  user: any;
  theme?: 'light' | 'dark';
  prefSoundSiaga?: boolean;
  prefSoundBahaya?: boolean;
  prefPushSiaga?: boolean;
  prefPushBahaya?: boolean;
  onUpdatePreferences?: (prefs: {
    soundSiaga?: boolean;
    soundBahaya?: boolean;
    pushSiaga?: boolean;
    pushBahaya?: boolean;
  }) => void;
  onLogin?: (user: any) => void;
}

export default function AdminPanel({
  config,
  onUpdateConfig,
  user,
  theme = 'dark',
  prefSoundSiaga = true,
  prefSoundBahaya = true,
  prefPushSiaga = true,
  prefPushBahaya = true,
  onUpdatePreferences,
  onLogin
}: AdminPanelProps) {
  const [thresholdSiaga, setThresholdSiaga] = useState(60);
  const [thresholdBahaya, setThresholdBahaya] = useState(90);
  const [refHeight, setRefHeight] = useState(300);
  const [simMode, setSimMode] = useState<'dry' | 'light_rain' | 'storm' | 'flood'>('dry');
  const [autoSim, setAutoSim] = useState(true);
  const [statusAlat, setStatusAlat] = useState<'Online' | 'Offline' | 'Calibrating'>('Online');
  const [isSaving, setIsLoading] = useState(false);
  const [deviceLogs, setDeviceLogs] = useState<SystemLog[]>([]);
  const [newLogMsg, setNewLogMsg] = useState('');
  
  const [directWaterLevel, setDirectWaterLevel] = useState<number>(30);
  const [isInjecting, setIsInjecting] = useState<boolean>(false);

  // Sync direct water level with latest reading initially
  useEffect(() => {
    const q = query(
      collection(db, 'sensor_readings'),
      orderBy('timestamp', 'desc'),
      limit(1)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const data = snapshot.docs[0].data();
        if (data && typeof data.water_level === 'number') {
          setDirectWaterLevel(Math.round(data.water_level));
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Real-time admin credentials synced from Firestore
  const [adminCreds, setAdminCreds] = useState<any>(null);

  useEffect(() => {
    const credRef = doc(db, 'admin_auth', 'credentials');
    const unsubscribe = onSnapshot(credRef, (snap) => {
      if (snap.exists()) {
        setAdminCreds(snap.data());
      } else {
        const defaultCreds = { username: 'admin', password: 'admin123', last_updated: Date.now() };
        setDoc(credRef, defaultCreds).catch((err) => {
          handleFirestoreError(err, OperationType.WRITE, 'admin_auth/credentials');
        });
        setAdminCreds(defaultCreds);
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'admin_auth/credentials');
    });
    return () => unsubscribe();
  }, []);

  // Login state for locked console
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  // Credential change state
  const [newUsername, setNewUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [isSavingCreds, setIsSavingCreds] = useState(false);
  const [credChangeError, setCredChangeError] = useState<string | null>(null);
  const [credChangeSuccess, setCredChangeSuccess] = useState<string | null>(null);

  const handleCustomLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    if (!adminCreds) {
      setLoginError('Sistem otentikasi sedang sinkronisasi. Harap tunggu sebentar.');
      return;
    }
    if (loginUsername === adminCreds.username && loginPassword === adminCreds.password) {
      const adminUser = {
        username: adminCreds.username,
        displayName: 'Administrator PLC',
        role: 'admin',
        email: 'admin@simba.depok.go.id',
        photoURL: ''
      };
      onLogin?.(adminUser);
      localStorage.setItem('scada_admin_logged_in', JSON.stringify(adminUser));
      setLoginUsername('');
      setLoginPassword('');
    } else {
      setLoginError('Nama pengguna atau kata sandi salah. Silakan coba lagi.');
    }
  };

  const handleChangeCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredChangeError(null);
    setCredChangeSuccess(null);
    if (!adminCreds) return;

    if (currentPassword !== adminCreds.password) {
      setCredChangeError('Kata sandi saat ini tidak valid.');
      return;
    }

    if (newPassword.length < 6) {
      setCredChangeError('Kata sandi baru minimal harus 6 karakter.');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setCredChangeError('Konfirmasi kata sandi baru tidak cocok.');
      return;
    }

    setIsSavingCreds(true);
    try {
      const credRef = doc(db, 'admin_auth', 'credentials');
      await updateDoc(credRef, {
        username: newUsername || adminCreds.username,
        password: newPassword,
        last_updated: Date.now()
      });
      
      setCredChangeSuccess('Kredensial administrator berhasil diperbarui di Firestore.');
      await appendConsoleLog('Kredensial keamanan administrator PLC berhasil diperbarui.', 'info');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setNewUsername('');
    } catch (err) {
      console.error(err);
      setCredChangeError('Gagal memperbarui kredensial keamanan.');
    } finally {
      setIsSavingCreds(false);
    }
  };

  const isDark = theme === 'dark';
  const themeCard = isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200/80 shadow-sm text-slate-800';
  const themeSubtext = isDark ? 'text-white/50' : 'text-slate-500';
  const themeLabel = isDark ? 'text-white/40' : 'text-slate-400';
  const themeBorder = isDark ? 'border-white/5' : 'border-slate-150';
  const themeInputTrack = isDark ? 'bg-white/5' : 'bg-slate-200';
  const themeInnerCard = isDark ? 'bg-black/30 border-white/5' : 'bg-slate-50 border-slate-200';
  const themeButtonWhite = isDark 
    ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-200' 
    : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-700 shadow-sm';

  // Sync state values with active database configuration when loaded
  useEffect(() => {
    if (config) {
      setThresholdSiaga(config.threshold_siaga);
      setThresholdBahaya(config.threshold_bahaya);
      setRefHeight(config.reference_height);
      setSimMode(config.simulation_mode);
      setAutoSim(config.auto_simulation);
      setStatusAlat(config.status_alat);
    }
  }, [config]);

  // Manual Peil Schaal field observation state
  const [manualTma, setManualTma] = useState<number>(45);
  const [manualWeather, setManualWeather] = useState<string>('Berawan');
  const [manualReason, setManualReason] = useState<string>('Sensor Terhalang Sampah / Ranting');
  const [manualOperator, setManualOperator] = useState<string>(user?.displayName || 'Petugas Lapangan Pos Kukusan');
  const [manualNotes, setManualNotes] = useState<string>('Pengamatan visual mistar peil schaal dermaga akibat sensor ultrasonik terkendala.');
  const [isSubmittingManual, setIsSubmittingManual] = useState<boolean>(false);
  const [manualSubmitResult, setManualSubmitResult] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [recentPeilEntries, setRecentPeilEntries] = useState<any[]>([]);

  // Listen to recent manual entries from Firestore
  useEffect(() => {
    const q = query(
      collection(db, 'sensor_readings'),
      orderBy('timestamp', 'desc'),
      limit(25)
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const entries: any[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.source === 'Manual-Peil-Schaal' || data.source?.includes('Manual') || data.source?.includes('Peil')) {
          entries.push({ id: doc.id, ...data });
        }
      });
      setRecentPeilEntries(entries.slice(0, 5));
    });
    return () => unsubscribe();
  }, []);

  const handleSubmitManualPeil = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingManual(true);
    setManualSubmitResult(null);

    try {
      const now = Date.now();
      const tmaVal = Number(manualTma);
      const refH = config?.reference_height || 300;
      const calculatedDist = Math.max(0, Math.round((refH - tmaVal) * 10) / 10);
      const siagaLimit = config?.threshold_siaga || 60;
      const bahayaLimit = config?.threshold_bahaya || 90;
      const status = tmaVal >= bahayaLimit ? 'Bahaya' : tmaVal >= siagaLimit ? 'Siaga' : 'Normal';

      // 1. Write to sensor_readings collection
      await addDoc(collection(db, 'sensor_readings'), {
        timestamp: now,
        water_level: tmaVal,
        distance: calculatedDist,
        source: 'Manual-Peil-Schaal',
        operator: manualOperator.trim() || 'Petugas Lapangan',
        notes: `[${manualReason}] ${manualNotes.trim()}`,
        temperature: 28.0,
        humidity: manualWeather.includes('Hujan') ? 88.0 : 72.0,
        local_rain: manualWeather.includes('Deras') ? 2 : manualWeather.includes('Hujan') ? 1 : 0,
        node_id: config?.node_id || 'node-kukusan-01'
      });

      // 2. Write to system_logs collection
      await addDoc(collection(db, 'system_logs'), {
        timestamp: now,
        source: 'System',
        level: status === 'Bahaya' ? 'error' : status === 'Siaga' ? 'warn' : 'info',
        message: `[INPUT PEIL SCHAAL] Petugas ${manualOperator} mencatat TMA: ${tmaVal} cm (${status}). Alasan: ${manualReason}`
      });

      setManualSubmitResult({
        text: `Data Peil Schaal (${tmaVal} cm - Status: ${status}) berhasil dicatat ke sistem! Badge "MANUAL PEIL SCHAAL" kini aktif di Dashboard.`,
        type: 'success'
      });
    } catch (err: any) {
      console.error(err);
      setManualSubmitResult({
        text: 'Gagal mencatat data manual: ' + err.message,
        type: 'error'
      });
    } finally {
      setIsSubmittingManual(false);
    }
  };

  // Read latest 15 system logs for the terminal console
  useEffect(() => {
    const unsubscribeLogs = onSnapshot(
      collection(db, 'system_logs'),
      (snapshot) => {
        const logs: SystemLog[] = [];
        snapshot.forEach((doc) => {
          logs.push({ id: doc.id, ...doc.data() } as SystemLog);
        });
        const sorted = logs.sort((a, b) => b.timestamp - a.timestamp).slice(0, 12);
        setDeviceLogs(sorted);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'system_logs');
      }
    );

    // Initial logs seeder if empty
    return () => unsubscribeLogs();
  }, []);

  // Post a quick message directly onto the SCADA terminal console
  const appendConsoleLog = async (msg: string, level: 'info' | 'warn' | 'error' = 'info') => {
    try {
      await addDoc(collection(db, 'system_logs'), {
        timestamp: Date.now(),
        source: 'Server',
        level,
        message: msg
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.CREATE, 'system_logs');
    }
  };

  const handleSaveThresholds = async () => {
    setIsLoading(true);
    try {
      await onUpdateConfig({
        threshold_siaga: Number(thresholdSiaga),
        threshold_bahaya: Number(thresholdBahaya),
        reference_height: Number(refHeight)
      });
      await appendConsoleLog(`Konfigurasi ambang batas diperbarui: Siaga=${thresholdSiaga}cm, Bahaya=${thresholdBahaya}cm, Ref=${refHeight}cm`, 'info');
      
      // Request express server to immediately inject a matching simulated reading with the new config
      await fetch('/api/sim-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: simMode })
      });
    } catch (e) {
      console.error(e);
      await appendConsoleLog('Gagal memperbarui konfigurasi ambang batas', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSimulationModeChange = async (mode: 'dry' | 'light_rain' | 'storm' | 'flood') => {
    setSimMode(mode);
    try {
      await onUpdateConfig({ simulation_mode: mode });
      await appendConsoleLog(`Skenario simulasi diubah ke: "${mode.toUpperCase()}"`, 'warn');
      
      // Request express server to immediately inject a matching simulated reading
      await fetch('/api/sim-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleInjectWaterLevel = async (level: number) => {
    setIsInjecting(true);
    try {
      await appendConsoleLog(`Mengirimkan perintah set ketinggian air simulasi: ${level} cm...`, 'warn');
      const response = await fetch('/api/sim-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: simMode, water_level: level })
      });
      if (response.ok) {
        await appendConsoleLog(`Injeksi sukses! Ketinggian air simulator diset ke ${level} cm.`, 'info');
      } else {
        await appendConsoleLog('Gagal menginjeksikan ketinggian air.', 'error');
      }
    } catch (e) {
      console.error(e);
      await appendConsoleLog('Gagal berkomunikasi dengan server simulator.', 'error');
    } finally {
      setIsInjecting(false);
    }
  };

  const toggleAutoSimulation = async () => {
    const nextVal = !autoSim;
    setAutoSim(nextVal);
    try {
      await onUpdateConfig({ auto_simulation: nextVal });
      await appendConsoleLog(`Simulasi Otomatis ${nextVal ? 'DIAKTIFKAN' : 'DINONAKTIFKAN'}`, 'info');
    } catch (e) {
      console.error(e);
    }
  };

  const triggerManualCalibration = async () => {
    setStatusAlat('Calibrating');
    await onUpdateConfig({ status_alat: 'Calibrating' });
    await appendConsoleLog('Memulai kalibrasi kompensasi rambat bunyi JSN-SR04T...', 'info');
    
    setTimeout(async () => {
      setStatusAlat('Online');
      await onUpdateConfig({ status_alat: 'Online' });
      await appendConsoleLog('Kalibrasi JSN-SR04T selesai. Kecepatan bunyi: 343.4 m/s (Koreksi Suhu: AKTIF). Status: ONLINE', 'info');
    }, 3000);
  };

  const handleResetThresholds = async () => {
    setThresholdSiaga(60);
    setThresholdBahaya(90);
    setRefHeight(300);
    await appendConsoleLog('Parameter ambang batas & baseline di-reset ke default pabrik (Siaga: 60cm, Bahaya: 90cm, Ref: 300cm). Harap simpan perubahan.', 'info');
  };

  // If user is not logged in, show elegant auth block
  if (!user) {
    return (
      <div id="admin-auth-lock" className={`max-w-md mx-auto my-12 ${isDark ? 'bg-[#0D0D0F] border-white/5 text-white' : 'bg-white border-slate-200 text-slate-800 shadow-lg'} rounded-2xl p-8 animate-fade-in`}>
        <div className={`w-16 h-16 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'} text-[#3B82F6] rounded-full flex items-center justify-center mx-auto mb-5`}>
          <Lock className="w-6 h-6 animate-pulse" />
        </div>
        <h2 className={`font-bold text-2xl text-center ${isDark ? 'text-white' : 'text-slate-900'} mb-2`}>Otentikasi Administrator PLC</h2>
        <p className={`font-sans text-xs text-center ${isDark ? 'text-white/50' : 'text-slate-500'} mb-6 leading-relaxed`}>
          Masukkan nama pengguna (username) dan kata sandi (password) khusus administrator untuk membuka akses konfigurasi parameter PLC & SCADA.
        </p>

        {/* Custom Login Form */}
        <form onSubmit={handleCustomLoginSubmit} className="space-y-4">
          <div className="flex flex-col gap-1.5 text-left">
            <label className={`text-[10px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>Username</label>
            <input 
              type="text" 
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              placeholder="Username admin"
              required
              className={`px-3.5 py-2.5 text-xs rounded-xl border ${
                isDark 
                  ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                  : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
              } outline-none transition-all`}
            />
          </div>

          <div className="flex flex-col gap-1.5 text-left">
            <label className={`text-[10px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>Password</label>
            <input 
              type="password" 
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="••••••••"
              required
              className={`px-3.5 py-2.5 text-xs rounded-xl border ${
                isDark 
                  ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                  : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
              } outline-none transition-all`}
            />
          </div>

          {loginError && (
            <p className="text-[11px] font-mono text-rose-500 text-left">{loginError}</p>
          )}

          <button 
            type="submit"
            className="w-full flex items-center justify-center gap-2 py-3 bg-[#3B82F6] hover:bg-blue-600 text-black text-xs font-bold rounded-xl cursor-pointer transition-all shadow-md mt-2"
          >
            <ShieldCheck className="w-4 h-4" />
            Buka Konsol PLC (Masuk)
          </button>
        </form>
      </div>
    );
  }

  return (
    <div id="admin-panel-root" className="grid grid-cols-1 lg:grid-cols-12 gap-6 pb-12">
      
      {/* LEFT-HAND SIDE COLUMN: CALIBRATION & PREFERENCES */}
      <div className="col-span-12 lg:col-span-7 flex flex-col gap-6">
        
        {/* Card 1: Calibration & Threshold Settings */}
        <div id="admin-settings-card" className={`${themeCard} rounded-2xl p-6 border ${themeBorder} flex flex-col justify-between`}>
          <div>
            <div className={`flex items-center justify-between mb-6 pb-4 border-b ${isDark ? 'border-white/5' : 'border-slate-100'}`}>
              <div className="flex items-center gap-3">
                <div className={`p-2 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-150 border-slate-200'} rounded-lg text-[#3B82F6]`}>
                  <Settings className="w-4 h-4" />
                </div>
                <h3 className={`font-bold text-xl ${isDark ? 'text-white' : 'text-slate-900'}`}>Kalibrasi & Konfigurasi Ambang</h3>
              </div>
              <div className={`flex items-center gap-1.5 ${isDark ? 'bg-white/5 border-white/10 text-white/60' : 'bg-slate-100 border-slate-200 text-slate-600'} px-2.5 py-1 rounded text-[9px] font-mono tracking-widest uppercase`}>
                <ShieldCheck className="w-3.5 h-3.5 text-[#3B82F6]" />
                ADMIN
              </div>
            </div>

            <div className="space-y-6">
              {/* Reference Height configuration */}
              <div className="flex flex-col gap-2">
                <label className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeLabel} font-mono flex justify-between`}>
                  <span>Tinggi Referensi Nol (Baseline)</span>
                  <span className="text-[#3B82F6] font-semibold">{refHeight} cm</span>
                </label>
                <p className={`text-[11px] ${themeSubtext} leading-normal mb-1`}>
                  Jarak total dari probe JSN-SR04T ke dasar drainase sungai (cm). Nilai ini digunakan untuk menghitung elevasi air ($h = H_ref - d$).
                </p>
                <input 
                  type="range" 
                  min="100" 
                  max="500" 
                  value={refHeight} 
                  onChange={(e) => setRefHeight(Number(e.target.value))}
                  className={`w-full h-1 ${themeInputTrack} rounded-lg appearance-none cursor-pointer accent-[#3B82F6]`}
                />
              </div>

              {/* Threshold Siaga configuration */}
              <div className="flex flex-col gap-2">
                <label className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeLabel} font-mono flex justify-between`}>
                  <span>Ambang Status Siaga (Kuning)</span>
                  <span className="text-amber-400 font-semibold">{thresholdSiaga} cm</span>
                </label>
                <p className={`text-[11px] ${themeSubtext} leading-normal mb-1`}>
                  Batas elevasi air untuk memicu status Siaga (Waspada) dan mengaktifkan notifikasi visual di Web SCADA.
                </p>
                <input 
                  type="range" 
                  min="20" 
                  max="150" 
                  value={thresholdSiaga} 
                  onChange={(e) => setThresholdSiaga(Number(e.target.value))}
                  className={`w-full h-1 ${themeInputTrack} rounded-lg appearance-none cursor-pointer accent-amber-500`}
                />
              </div>

              {/* Threshold Bahaya configuration */}
              <div className="flex flex-col gap-2">
                <label className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeLabel} font-mono flex justify-between`}>
                  <span>Ambang Status Bahaya (Merah)</span>
                  <span className="text-rose-400 font-semibold">{thresholdBahaya} cm</span>
                </label>
                <p className={`text-[11px] ${themeSubtext} leading-normal mb-1`}>
                  Batas kritis elevasi air meluap. Memicu status Bahaya dan mempersiapkan evakuasi darurat bagi operator BPBD.
                </p>
                <input 
                  type="range" 
                  min="50" 
                  max="250" 
                  value={thresholdBahaya} 
                  onChange={(e) => setThresholdBahaya(Number(e.target.value))}
                  className={`w-full h-1 ${themeInputTrack} rounded-lg appearance-none cursor-pointer accent-rose-500`}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-8 pt-6 border-t border-slate-100 dark:border-white/5">
            <button 
              onClick={triggerManualCalibration}
              disabled={statusAlat === 'Calibrating'}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 disabled:opacity-50 text-xs font-semibold rounded-xl cursor-pointer transition-all ${themeButtonWhite}`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${statusAlat === 'Calibrating' ? 'animate-spin' : ''}`} />
              {statusAlat === 'Calibrating' ? 'Kalibrasi...' : 'Kalibrasi Sensor'}
            </button>

            <button 
              onClick={handleResetThresholds}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold rounded-xl cursor-pointer transition-all ${themeButtonWhite}`}
              title="Reset ke nilai default pabrik (Siaga: 60 cm, Bahaya: 90 cm, Tinggi Baseline: 300 cm)"
            >
              <RotateCcw className="w-3.5 h-3.5 text-amber-500" />
              Reset Default
            </button>

            <button 
              onClick={handleSaveThresholds}
              disabled={isSaving}
              className="flex items-center justify-center gap-2 px-3 py-2.5 bg-[#3B82F6] hover:bg-blue-600 disabled:opacity-50 text-black text-xs font-bold rounded-xl cursor-pointer transition-all"
            >
              {isSaving ? 'Menyimpan...' : 'Simpan Perubahan'}
            </button>
          </div>
        </div>

        {/* Card 2: Notification & Alarm Preferences */}
        <div id="admin-notifications-card" className={`${themeCard} rounded-2xl p-6 border ${themeBorder}`}>
          <div className={`flex items-center justify-between mb-6 pb-4 border-b ${themeBorder}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-150 border-slate-200'} rounded-lg text-amber-500`}>
                <Bell className="w-4 h-4 text-amber-500 animate-pulse" />
              </div>
              <h3 className={`font-bold text-xl ${isDark ? 'text-white' : 'text-slate-900'}`}>Preferensi Notifikasi & Alarm</h3>
            </div>
            <div className={`flex items-center gap-1.5 ${isDark ? 'bg-white/5 border-white/10 text-white/60' : 'bg-slate-100 border-slate-200 text-slate-600'} px-2.5 py-1 rounded text-[9px] font-mono tracking-widest uppercase`}>
              OPERATOR PREFS
            </div>
          </div>

          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-6`}>
            Atur preferensi alarm suara berbasis browser dan notifikasi push layar untuk masing-masing level status peringatan dini. Preferensi disimpan secara otomatis pada penyimpanan lokal (Local Storage) browser Anda.
          </p>

          <div className="space-y-5">
            {/* Siaga preferences */}
            <div className={`p-4 rounded-xl border ${themeInnerCard} flex flex-col sm:flex-row sm:items-center justify-between gap-4`}>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
                  <span className={`text-xs font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>STATUS SIAGA (KUNING)</span>
                </div>
                <p className={`text-[10px] ${themeSubtext}`}>Bunyi peringatan lambat (tiap 4.5 detik) & notifikasi browser ketika air melampaui batas Siaga.</p>
              </div>
              
              <div className="flex items-center gap-4 shrink-0 font-mono text-[10px]">
                {/* Sound toggle */}
                <button 
                  onClick={() => onUpdatePreferences?.({ soundSiaga: !prefSoundSiaga })}
                  className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg transition-all cursor-pointer ${
                    prefSoundSiaga 
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-500' 
                      : 'bg-slate-500/5 border-transparent text-slate-500'
                  }`}
                >
                  {prefSoundSiaga ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                  <span>ALARM: {prefSoundSiaga ? 'ON' : 'OFF'}</span>
                </button>

                {/* Push toggle */}
                <button 
                  onClick={() => onUpdatePreferences?.({ pushSiaga: !prefPushSiaga })}
                  className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg transition-all cursor-pointer ${
                    prefPushSiaga 
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-500' 
                      : 'bg-slate-500/5 border-transparent text-slate-500'
                  }`}
                >
                  <Bell className="w-3.5 h-3.5" />
                  <span>PUSH: {prefPushSiaga ? 'ON' : 'OFF'}</span>
                </button>
              </div>
            </div>

            {/* Bahaya preferences */}
            <div className={`p-4 rounded-xl border ${themeInnerCard} flex flex-col sm:flex-row sm:items-center justify-between gap-4`}>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-rose-500 scada-led-blink inline-block" />
                  <span className={`text-xs font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>STATUS BAHAYA (MERAH)</span>
                </div>
                <p className={`text-[10px] ${themeSubtext}`}>Siren ganda cepat (tiap 1.5 detik) & notifikasi darurat ketika air melampaui batas kritis Bahaya.</p>
              </div>
              
              <div className="flex items-center gap-4 shrink-0 font-mono text-[10px]">
                {/* Sound toggle */}
                <button 
                  onClick={() => onUpdatePreferences?.({ soundBahaya: !prefSoundBahaya })}
                  className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg transition-all cursor-pointer ${
                    prefSoundBahaya 
                      ? 'bg-rose-500/10 border-rose-500/30 text-rose-500 font-bold' 
                      : 'bg-slate-500/5 border-transparent text-slate-500'
                  }`}
                >
                  {prefSoundBahaya ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
                  <span>ALARM: {prefSoundBahaya ? 'ON' : 'OFF'}</span>
                </button>

                {/* Push toggle */}
                <button 
                  onClick={() => onUpdatePreferences?.({ pushBahaya: !prefPushBahaya })}
                  className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg transition-all cursor-pointer ${
                    prefPushBahaya 
                      ? 'bg-rose-500/10 border-rose-500/30 text-rose-500 font-bold' 
                      : 'bg-slate-500/5 border-transparent text-slate-500'
                  }`}
                >
                  <Bell className="w-3.5 h-3.5" />
                  <span>PUSH: {prefPushBahaya ? 'ON' : 'OFF'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Card 4: Hardware IoT Integration & Live Bridge */}
        <div id="hardware-bridge-card" className={`${themeCard} rounded-2xl p-6 border ${themeBorder}`}>
          <div className={`flex items-center justify-between mb-4 pb-4 border-b ${themeBorder}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 ${isDark ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-emerald-50 border-emerald-200'} rounded-lg text-emerald-500`}>
                <Radio className="w-4 h-4 text-emerald-500 animate-pulse" />
              </div>
              <div>
                <h3 className={`font-bold text-xl ${isDark ? 'text-white' : 'text-slate-900'}`}>Integrasi Hardware ESP32 (RTU)</h3>
                <p className={`text-[10px] ${themeSubtext} font-mono mt-0.5`}>Arsitektur Statless REST API — Tanpa Login / Bebas Token Expired</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded text-[9px] font-mono text-emerald-400 font-bold tracking-widest uppercase">
              READY FOR ESP32
            </div>
          </div>

          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-4`}>
            Teman hardware Anda cukup menggunakan library standar <code className="font-mono text-[#3B82F6]">HTTPClient.h</code>. Data jarak pantul ultrasonik (<code className="font-mono text-emerald-400">distance</code> dalam cm) yang dikirim per batch 6 menit (360 data) akan otomatis diolah server dan dimasukkan langsung ke <strong className={isDark ? 'text-white' : 'text-slate-900'}>Cloud Firestore</strong>.
          </p>

          <div className="space-y-3">
            <div className={`p-3 rounded-xl border ${themeInnerCard} flex flex-col sm:flex-row sm:items-center justify-between gap-2 font-mono text-[11px]`}>
              <div className="space-y-1">
                <span className={`text-[9px] uppercase tracking-wider ${themeLabel} block`}>URL Endpoint Batch (360 Sampel / 6 Menit):</span>
                <span className="text-[#3B82F6] font-bold select-all break-all">
                  https://ais-pre-rzzbanv7e2ojmrqboq5vxb-265377259788.asia-southeast1.run.app/api/telemetry/batch
                </span>
              </div>
              <span className="px-2 py-1 bg-[#3B82F6]/10 text-[#3B82F6] rounded text-[10px] shrink-0 font-bold">
                POST JSON
              </span>
            </div>

            <div className={`p-3 rounded-xl border ${themeInnerCard} font-mono text-[10px] space-y-1`}>
              <span className={`text-[9px] uppercase tracking-wider ${themeLabel} block`}>Format Payload JSON dari ESP32:</span>
              <pre className="text-emerald-400 bg-black/60 p-2.5 rounded-lg overflow-x-auto text-[10px] leading-relaxed">
{`{
  "node_id": "node-kukusan-01",
  "distances": [180.5, 180.2, 179.9, ... 360 sampel ...]
}`}
              </pre>
            </div>
          </div>
        </div>

        {/* Card 2: Input Mandiri Petugas Lapangan (Manual Peil Schaal) */}
        <div id="admin-peil-schaal-card" className={`${themeCard} rounded-2xl p-6 border ${themeBorder}`}>
          <div className={`flex items-center justify-between mb-5 pb-4 border-b ${themeBorder}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2.5 rounded-xl ${isDark ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-600'} border`}>
                <ClipboardCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className={`font-bold text-xl ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  Input Mandiri Peil Schaal (Mistar Lapangan)
                </h3>
                <span className={`text-[10px] ${themeSubtext} block font-mono mt-0.5`}>
                  STANDAR OPERASIONAL POS DUGA AIR PUPR / BBWS
                </span>
              </div>
            </div>
            <span className="px-2.5 py-1 rounded-lg text-[9px] font-mono font-bold bg-amber-500/15 border border-amber-500/30 text-amber-400 uppercase tracking-wider">
              SOP DARURAT
            </span>
          </div>

          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-5`}>
            Gunakan formulir ini jika sensor otomatis JSN-SR04T mengalami anomali (terhalang ranting bambu/sampah, kabel putus, atau mati daya). Data pembacaan mistar duga air (Peil Schaal) fisik akan langsung dikirim ke Dashboard dengan label resmi <strong>MANUAL PEIL SCHAAL</strong>.
          </p>

          <form onSubmit={handleSubmitManualPeil} className="space-y-4">
            {/* Water Level (TMA) */}
            <div className={`p-4 rounded-xl border ${themeInnerCard}`}>
              <div className="flex items-center justify-between mb-2">
                <label className={`text-[10px] font-mono font-bold uppercase tracking-wider ${themeLabel} flex items-center gap-1.5`}>
                  <Ruler className="w-3.5 h-3.5 text-amber-400" />
                  Ketinggian Air Peil Schaal (TMA)
                </label>
                <div className="flex items-center gap-2">
                  <span className={`px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold ${
                    manualTma >= (config?.threshold_bahaya || 90)
                      ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      : manualTma >= (config?.threshold_siaga || 60)
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  }`}>
                    {manualTma >= (config?.threshold_bahaya || 90)
                      ? 'STATUS: BAHAYA'
                      : manualTma >= (config?.threshold_siaga || 60)
                        ? 'STATUS: SIAGA'
                        : 'STATUS: NORMAL'}
                  </span>
                  <span className="text-sm font-bold font-mono text-amber-400">
                    {manualTma} cm
                  </span>
                </div>
              </div>

              {/* Slider & Quick Presets */}
              <input 
                type="range" 
                min="10" 
                max="200" 
                step="1"
                value={manualTma}
                onChange={(e) => setManualTma(Number(e.target.value))}
                className="w-full accent-amber-400 cursor-pointer h-1.5 bg-black/40 rounded-lg mb-3"
              />

              <div className="flex items-center justify-between gap-1.5 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className={`text-[9px] font-mono ${themeLabel}`}>Preset Cepat:</span>
                  {[
                    { label: 'Normal (35cm)', val: 35 },
                    { label: 'Waspada (65cm)', val: 65 },
                    { label: 'Siaga (75cm)', val: 75 },
                    { label: 'Bahaya (105cm)', val: 105 }
                  ].map((p) => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => setManualTma(p.val)}
                      className={`px-2 py-1 rounded text-[9px] font-mono font-bold transition-all cursor-pointer border ${
                        manualTma === p.val
                          ? 'bg-amber-400 text-black border-amber-300 font-extrabold'
                          : `${isDark ? 'bg-white/5 border-white/5 text-slate-300' : 'bg-white border-slate-200 text-slate-600'} hover:border-amber-400/50`
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <span className={`text-[9px] font-mono ${themeSubtext}`}>
                  Ekuivalen jarak sensor: {Math.max(0, Math.round(((config?.reference_height || 300) - manualTma) * 10) / 10)} cm
                </span>
              </div>
            </div>

            {/* Field Operator & Reason Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                  Nama Petugas Lapangan
                </label>
                <input 
                  type="text" 
                  value={manualOperator}
                  onChange={(e) => setManualOperator(e.target.value)}
                  placeholder="Nama petugas jaga"
                  required
                  className={`px-3 py-2 text-xs rounded-xl border ${
                    isDark 
                      ? 'bg-black/50 border-white/10 text-white focus:border-amber-400' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-amber-500'
                  } outline-none transition-all`}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                  Alasan Pengamatan Manual
                </label>
                <select 
                  value={manualReason}
                  onChange={(e) => setManualReason(e.target.value)}
                  className={`px-3 py-2 text-xs rounded-xl border ${
                    isDark 
                      ? 'bg-[#0D0D0F] border-white/10 text-white focus:border-amber-400' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-amber-500'
                  } outline-none transition-all`}
                >
                  <option value="Sensor Terhalang Sampah / Ranting">Sensor Terhalang Sampah / Ranting</option>
                  <option value="Sensor Fisik Mati / Baterai Drop">Sensor Fisik Mati / Baterai Drop</option>
                  <option value="Kabel Putus / Gangguan Sinyal">Kabel Putus / Gangguan Sinyal</option>
                  <option value="Validasi Berkala Peil Schaal Fisik">Validasi Berkala Peil Schaal Fisik</option>
                  <option value="Pemeliharaan & Kalibrasi Alat">Pemeliharaan & Kalibrasi Alat</option>
                  <option value="Lainnya">Lainnya</option>
                </select>
              </div>
            </div>

            {/* Weather Condition */}
            <div className="flex flex-col gap-1.5">
              <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                Kondisi Cuaca Lapangan Saat Pengamatan
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: 'Cerah Terik', icon: Sun },
                  { label: 'Berawan / Teduh', icon: CloudRain },
                  { label: 'Hujan Sedang', icon: CloudRain },
                  { label: 'Hujan Deras / Badai', icon: AlertTriangle }
                ].map((item) => {
                  const Icon = item.icon;
                  const isSelected = manualWeather === item.label;
                  return (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => setManualWeather(item.label)}
                      className={`px-2.5 py-2 rounded-xl text-xs font-mono flex items-center justify-center gap-1.5 border transition-all cursor-pointer ${
                        isSelected
                          ? 'bg-amber-400 text-black border-amber-300 font-bold shadow-sm'
                          : `${isDark ? 'bg-black/40 border-white/5 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600'} hover:border-amber-400/40`
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Visual Field Notes */}
            <div className="flex flex-col gap-1.5">
              <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                Catatan Lapangan & Karakteristik Air (Opsional)
              </label>
              <input 
                type="text" 
                value={manualNotes}
                onChange={(e) => setManualNotes(e.target.value)}
                placeholder="Contoh: Arus sangat deras, air keruh kecokelatan, banyak batang pisang hanyut"
                className={`px-3 py-2 text-xs rounded-xl border ${
                  isDark 
                    ? 'bg-black/50 border-white/10 text-white focus:border-amber-400' 
                    : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-amber-500'
                } outline-none transition-all`}
              />
            </div>

            {manualSubmitResult && (
              <div className={`p-3 rounded-xl border text-xs font-sans flex items-start gap-2 ${
                manualSubmitResult.type === 'success'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
              }`}>
                {manualSubmitResult.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <span>{manualSubmitResult.text}</span>
              </div>
            )}

            {/* Submit Button */}
            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={isSubmittingManual}
                className="w-full sm:w-auto px-5 py-2.5 bg-amber-400 hover:bg-amber-500 disabled:opacity-50 text-black text-xs font-bold font-mono rounded-xl cursor-pointer transition-all shadow-md flex items-center justify-center gap-2"
              >
                {isSubmittingManual ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Menyimpan ke Sistem...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>Kirim Data Peil Schaal ke Dashboard</span>
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Recent Manual Logs Mini-Table */}
          {recentPeilEntries.length > 0 && (
            <div className={`mt-5 pt-4 border-t ${themeBorder}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel} flex items-center gap-1.5`}>
                  <History className="w-3 h-3 text-amber-400" />
                  Riwayat Entri Peil Schaal Terakhir
                </span>
                <span className={`text-[9px] font-mono ${themeSubtext}`}>
                  {recentPeilEntries.length} entri tercatat
                </span>
              </div>
              <div className="space-y-1.5">
                {recentPeilEntries.map((entry) => (
                  <div 
                    key={entry.id} 
                    className={`p-2.5 rounded-lg border ${themeInnerCard} flex items-center justify-between text-xs font-mono`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                        entry.water_level >= (config?.threshold_bahaya || 90)
                          ? 'bg-rose-500/20 text-rose-400'
                          : entry.water_level >= (config?.threshold_siaga || 60)
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-emerald-500/20 text-emerald-400'
                      }`}>
                        TMA: {entry.water_level} cm
                      </span>
                      <span className={`text-[10px] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                        {entry.operator || 'Petugas'}
                      </span>
                    </div>
                    <span className={`text-[9px] ${themeSubtext}`}>
                      {new Date(entry.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Card 3: Admin Credentials Modification */}
        <div id="admin-credentials-card" className={`${themeCard} rounded-2xl p-6 border ${themeBorder}`}>
          <div className={`flex items-center justify-between mb-6 pb-4 border-b ${themeBorder}`}>
            <div className="flex items-center gap-3">
              <div className={`p-2 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-150 border-slate-200'} rounded-lg text-indigo-500`}>
                <Key className="w-4 h-4 text-indigo-500" />
              </div>
              <h3 className={`font-bold text-xl ${isDark ? 'text-white' : 'text-slate-900'}`}>Ubah Kredensial Administrator PLC</h3>
            </div>
            <div className={`flex items-center gap-1.5 ${isDark ? 'bg-white/5 border-white/10 text-white/60' : 'bg-slate-100 border-slate-200 text-slate-600'} px-2.5 py-1 rounded text-[9px] font-mono tracking-widest uppercase`}>
              SECURITY KEY
            </div>
          </div>

          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-6`}>
            Ubah nama pengguna (username) dan kata sandi (password) khusus yang digunakan untuk mengakses dan mengonfigurasi parameter PLC. Perubahan ini akan langsung disimpan di database Firestore secara aktual.
          </p>

          <form onSubmit={handleChangeCredentials} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>Username Administrator Baru</label>
                <input 
                  type="text" 
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder={adminCreds?.username || 'admin'}
                  className={`px-3 py-2 text-xs rounded-xl border ${
                    isDark 
                      ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
                  } outline-none transition-all`}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>Password Saat Ini</label>
                <input 
                  type="password" 
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className={`px-3 py-2 text-xs rounded-xl border ${
                    isDark 
                      ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
                  } outline-none transition-all`}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>Password Baru</label>
                <input 
                  type="password" 
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 6 karakter"
                  required
                  className={`px-3 py-2 text-xs rounded-xl border ${
                    isDark 
                      ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
                  } outline-none transition-all`}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>Konfirmasi Password Baru</label>
                <input 
                  type="password" 
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  placeholder="Sama dengan password baru"
                  required
                  className={`px-3 py-2 text-xs rounded-xl border ${
                    isDark 
                      ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
                  } outline-none transition-all`}
                />
              </div>
            </div>

            {credChangeError && (
              <p className="text-[11px] font-mono text-rose-500 pt-1">{credChangeError}</p>
            )}

            {credChangeSuccess && (
              <p className="text-[11px] font-mono text-emerald-500 pt-1">{credChangeSuccess}</p>
            )}

            <div className="flex justify-end pt-2">
              <button 
                type="submit"
                disabled={isSavingCreds}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#3B82F6] hover:bg-blue-600 disabled:opacity-50 text-black text-xs font-bold rounded-xl cursor-pointer transition-all"
              >
                {isSavingCreds ? 'Memproses...' : 'Ubah Kredensial'}
              </button>
            </div>
          </form>
        </div>

      </div>

      {/* PHYSICS SIMULATOR & TELEMETRY INJECTOR */}
      <div id="admin-simulation-card" className="col-span-12 lg:col-span-5 flex flex-col gap-6">
        
        {/* Simulation Mode Engine */}
        <div id="sim-engine" className={`${themeCard} rounded-2xl p-6 relative overflow-hidden`}>
          <div className="absolute top-0 right-0 w-32 h-32 bg-[#3B82F6]/5 rounded-full blur-2xl pointer-events-none" />
          
          <div className="flex justify-between items-center mb-4">
            <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeLabel} font-mono`}>Simulator Skenario Hidrologi</span>
            <div className="flex items-center gap-2">
              <span className={`text-[9px] ${themeLabel} font-mono uppercase tracking-wider`}>Auto run:</span>
              <span className={`w-1.5 h-1.5 rounded-full ${config?.auto_simulation ? 'bg-[#3B82F6] animate-pulse' : 'bg-slate-400'}`} />
            </div>
          </div>

          <h3 className={`font-bold text-xl ${isDark ? 'text-white' : 'text-slate-900'} leading-tight mb-2`}>Simulasi Keadaan Air</h3>
          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-5`}>
            Pilih skenario curah hujan dan pasang surut air sungai untuk menguji perilaku mitigasi bencana dan respons model prediktif secara real-time.
          </p>

          {/* INTERACTIVE SIMULATION MODE CONTROL TOGGLE */}
          <div className={`p-4 rounded-xl border mb-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 ${
            autoSim 
              ? isDark ? 'bg-blue-950/15 border-blue-500/20' : 'bg-blue-50 border-blue-200'
              : isDark ? 'bg-emerald-950/20 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200'
          }`}>
            <div className="text-left">
              <span className={`text-[10px] font-mono uppercase tracking-wider font-bold block ${
                autoSim ? 'text-[#3B82F6]' : 'text-emerald-500'
              }`}>
                {autoSim ? '🤖 STATUS: SIMULATOR SOFTWARE AKTIF' : '📡 STATUS: STANDBY (MENUNGGU HARDWARE ESP32)'}
              </span>
              <p className={`text-[10px] ${themeSubtext} leading-normal mt-0.5 max-w-xs`}>
                {autoSim 
                  ? 'Ketinggian air digenerate otomatis oleh server tiap 20 detik untuk demo sistem (Label: SIM / SENSOR).'
                  : 'Simulator background DIMATIKAN! Dashboard sekarang dalam mode STANDBY murni menunggu kiriman data dari ESP32 (Label otomatis: LIVE HARDWARE).'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={toggleAutoSimulation}
                className={`px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer select-none border flex items-center gap-1.5 shadow-sm ${
                  autoSim
                    ? 'bg-amber-500 hover:bg-amber-600 text-black border-amber-400'
                    : 'bg-[#3B82F6] hover:bg-blue-600 text-black border-[#3B82F6]'
                }`}
                title={autoSim ? "Matikan simulator agar dashboard hanya menampilkan data dari ESP32" : "Nyalakan generator data simulasi internal"}
              >
                {autoSim ? 'Matikan Auto-Run (Standby Hardware)' : 'Aktifkan Auto-Run'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Dry scenario */}
            <button 
              onClick={() => handleSimulationModeChange('dry')}
              className={`flex flex-col items-start p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                simMode === 'dry' 
                  ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-600 font-bold' 
                  : `${isDark ? 'bg-black/30 border-white/5' : 'bg-slate-50 border-slate-200'} hover:border-[#3B82F6] text-slate-500`
              }`}
            >
              <Compass className="w-4 h-4 mb-2 text-emerald-500/60" />
              <span className={`text-xs font-bold block ${isDark ? 'text-white' : 'text-slate-800'}`}>Cuaca Kering</span>
              <span className={`text-[9px] ${themeLabel} font-mono mt-1`}>level: ~30cm. Aman.</span>
            </button>

            {/* Light Rain scenario */}
            <button 
              onClick={() => handleSimulationModeChange('light_rain')}
              className={`flex flex-col items-start p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                simMode === 'light_rain' 
                  ? 'bg-blue-500/10 border-blue-500/25 text-blue-600 font-bold' 
                  : `${isDark ? 'bg-black/30 border-white/5' : 'bg-slate-50 border-slate-200'} hover:border-[#3B82F6] text-slate-500`
              }`}
            >
              <CloudRain className="w-4 h-4 mb-2 text-blue-500/60" />
              <span className={`text-xs font-bold block ${isDark ? 'text-white' : 'text-slate-800'}`}>Hujan Ringan</span>
              <span className={`text-[9px] ${themeLabel} font-mono mt-1`}>level: ~45cm.</span>
            </button>

            {/* Storm scenario */}
            <button 
              onClick={() => handleSimulationModeChange('storm')}
              className={`flex flex-col items-start p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                simMode === 'storm' 
                  ? 'bg-amber-500/10 border-amber-500/25 text-amber-600 font-bold' 
                  : `${isDark ? 'bg-black/30 border-white/5' : 'bg-slate-50 border-slate-200'} hover:border-[#3B82F6] text-slate-500`
              }`}
            >
              <AlertTriangle className="w-4 h-4 mb-2 text-amber-500/60" />
              <span className={`text-xs font-bold block ${isDark ? 'text-white' : 'text-slate-800'}`}>Hujan Lebat</span>
              <span className={`text-[9px] ${themeLabel} font-mono mt-1`}>Surge Siaga (&gt;60cm)</span>
            </button>

            {/* Flood scenario */}
            <button 
              onClick={() => handleSimulationModeChange('flood')}
              className={`flex flex-col items-start p-3.5 rounded-xl border text-left cursor-pointer transition-all ${
                simMode === 'flood' 
                  ? 'bg-rose-500/10 border-rose-500/25 text-rose-600 font-bold' 
                  : `${isDark ? 'bg-black/30 border-white/5' : 'bg-slate-50 border-slate-200'} hover:border-[#3B82F6] text-slate-500`
              }`}
            >
              <Flame className="w-4 h-4 mb-2 text-rose-500/60" />
              <span className={`text-xs font-bold block ${isDark ? 'text-white' : 'text-slate-800'}`}>Banjir Urban</span>
              <span className={`text-[9px] ${themeLabel} font-mono mt-1`}>Surge Bahaya (&gt;90cm)</span>
            </button>
          </div>

          {/* Direct Water Level Override Slider */}
          <div className={`mt-5 pt-5 border-t ${isDark ? 'border-white/5' : 'border-slate-200'}`}>
            <div className="flex flex-col gap-1.5 mb-3">
              <div className="flex items-center justify-between">
                <span className={`text-[10px] font-bold uppercase tracking-wider ${themeLabel} font-mono`}>Injeksi Ketinggian Air Mandiri</span>
                <span className={`px-2.5 py-0.5 rounded font-mono text-[10px] font-bold ${
                  directWaterLevel >= thresholdBahaya 
                    ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' 
                    : directWaterLevel >= thresholdSiaga 
                      ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' 
                      : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                }`}>
                  {directWaterLevel} cm ({
                    directWaterLevel >= thresholdBahaya ? 'BAHAYA' : directWaterLevel >= thresholdSiaga ? 'SIAGA' : 'NORMAL'
                  })
                </span>
              </div>

              {/* Lock Alert Notification */}
              {autoSim ? (
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[9px] font-mono font-bold ${
                  isDark ? 'bg-rose-950/20 border-rose-500/20 text-rose-400' : 'bg-rose-50 border-rose-200 text-rose-700'
                }`}>
                  🔒 TERKUNCI: Nonaktifkan "Auto-Run" di atas untuk mengaktifkan slider injeksi!
                </div>
              ) : (
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[9px] font-mono font-bold ${
                  isDark ? 'bg-emerald-950/20 border-emerald-500/20 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                }`}>
                  🔓 AKTIF: Anda dapat bebas memanipulasi tinggi air simulasi.
                </div>
              )}
            </div>

            {/* Slider control */}
            <div className="flex items-center gap-3 mb-4">
              <span className={`text-xs ${themeSubtext} font-mono w-10 text-left ${autoSim ? 'opacity-40' : ''}`}>10 cm</span>
              <input 
                type="range"
                min="10"
                max={Math.max(150, refHeight)}
                value={directWaterLevel}
                disabled={autoSim}
                onChange={(e) => setDirectWaterLevel(Number(e.target.value))}
                className={`flex-1 h-1.5 rounded-lg appearance-none transition-all ${
                  autoSim 
                    ? 'bg-slate-300 dark:bg-white/5 opacity-40 cursor-not-allowed' 
                    : 'bg-slate-200 dark:bg-white/10 cursor-pointer accent-[#3B82F6]'
                }`}
              />
              <span className={`text-xs ${themeSubtext} font-mono w-12 text-right ${autoSim ? 'opacity-40' : ''}`}>{Math.max(150, refHeight)} cm</span>
            </div>

            {/* Quick shortcuts */}
            <div className="flex flex-col sm:flex-row gap-2 justify-between items-stretch sm:items-center">
              <div className="flex flex-wrap gap-1.5">
                <button
                  disabled={autoSim}
                  onClick={() => {
                    setDirectWaterLevel(30);
                    handleInjectWaterLevel(30);
                  }}
                  className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border transition-all ${
                    autoSim 
                      ? 'opacity-40 cursor-not-allowed border-slate-300 dark:border-white/5 text-slate-500' 
                      : `cursor-pointer ${
                          isDark 
                            ? 'bg-emerald-950/20 hover:bg-emerald-950/40 border-emerald-500/25 text-emerald-400' 
                            : 'bg-emerald-50 hover:bg-emerald-100 border-emerald-200 text-emerald-700'
                        }`
                  }`}
                >
                  🟢 Normal (30cm)
                </button>
                <button
                  disabled={autoSim}
                  onClick={() => {
                    setDirectWaterLevel(75);
                    handleInjectWaterLevel(75);
                  }}
                  className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border transition-all ${
                    autoSim 
                      ? 'opacity-40 cursor-not-allowed border-slate-300 dark:border-white/5 text-slate-500' 
                      : `cursor-pointer ${
                          isDark 
                            ? 'bg-amber-950/20 hover:bg-amber-950/40 border-amber-500/25 text-amber-400' 
                            : 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-700'
                        }`
                  }`}
                >
                  🟡 Siaga (75cm)
                </button>
                <button
                  disabled={autoSim}
                  onClick={() => {
                    setDirectWaterLevel(115);
                    handleInjectWaterLevel(115);
                  }}
                  className={`px-2.5 py-1 text-[10px] font-bold rounded-lg border transition-all ${
                    autoSim 
                      ? 'opacity-40 cursor-not-allowed border-slate-300 dark:border-white/5 text-slate-500' 
                      : `cursor-pointer ${
                          isDark 
                            ? 'bg-rose-950/20 hover:bg-rose-950/40 border-rose-500/25 text-rose-400' 
                            : 'bg-rose-50 hover:bg-rose-100 border-rose-200 text-rose-700'
                        }`
                  }`}
                >
                  🔴 Bahaya (115cm)
                </button>
              </div>

              <button
                onClick={() => handleInjectWaterLevel(directWaterLevel)}
                disabled={autoSim || isInjecting}
                className={`px-4 py-1.5 text-black text-[10px] font-bold rounded-lg transition-all shrink-0 flex items-center justify-center gap-1 ${
                  autoSim 
                    ? 'bg-slate-400 dark:bg-slate-700 text-slate-500 dark:text-slate-400 opacity-40 cursor-not-allowed' 
                    : 'bg-[#3B82F6] hover:bg-blue-600 disabled:opacity-50 cursor-pointer'
                }`}
              >
                {isInjecting ? 'Mengirim...' : 'Kirim Simulasi'}
              </button>
            </div>
          </div>
        </div>

        {/* RTU Log console panel */}
        <div id="scada-rtu-log" className={`${themeCard} rounded-2xl p-6 flex-1 flex flex-col justify-between`}>
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[#3B82F6] animate-pulse" />
                <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeLabel} font-mono`}>Terminal Konsol RTU SIMBA</span>
              </div>
              <span className={`text-[9px] ${themeLabel} font-mono`}>baud 115200</span>
            </div>

            <div className="bg-black/95 rounded-xl p-3.5 h-48 overflow-y-auto font-mono text-[10px] border border-white/5 space-y-2">
              {deviceLogs.length === 0 ? (
                <div className="text-white/20 text-center py-14 uppercase tracking-widest text-[9px]">Tidak ada log terbaru. Memulai simulator...</div>
              ) : (
                deviceLogs.map((log) => {
                  let badgeColor = 'text-[#3B82F6] bg-[#3B82F6]/5 border-white/10';
                  if (log.level === 'warn') badgeColor = 'text-amber-400 bg-amber-950/15 border-white/10';
                  if (log.level === 'error') badgeColor = 'text-rose-400 bg-rose-950/15 border-white/10';
                  
                  return (
                    <div key={log.id} className="flex items-start gap-2 border-b border-white/5 pb-1.5 last:border-0">
                      <span className="text-white/30 select-none">[{new Date(log.timestamp).toLocaleTimeString('id-ID')}]</span>
                      <span className={`px-1 py-0.25 rounded text-[8px] uppercase border shrink-0 ${badgeColor}`}>{log.source}</span>
                      <span className="text-white/70 leading-normal">{log.message}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

      </div>

    </div>
  );
}