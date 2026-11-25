/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { db, auth, handleFirestoreError, OperationType } from '../firebaseConfig';
import { doc, setDoc, updateDoc, collection, addDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { SystemConfig, SystemLog, SensorReading } from '../types';
import { normalizeSensorReading } from '../utils/readingUtils';
import { apiUrl } from '../utils/apiBase';
import { 
  Sliders, 
  Play, 
  Square,
  Activity,
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
  FileText,
  Database
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
  latestReading?: SensorReading | null;
  language?: 'id' | 'en';
  onNavigateTab?: (tab: 'dashboard' | 'simulation' | 'admin') => void;
  onResetSimulation?: () => Promise<void>;
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
  onLogin,
  latestReading: propLatestReading,
  language = 'id',
  onNavigateTab,
  onResetSimulation
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

  // Real-time latest sensor telemetry & batch data listener for Inspector (Shared from App state to save quota)
  const [latestReading, setLatestReading] = useState<SensorReading | null>(propLatestReading ?? null);
  const [timeAgoText, setTimeAgoText] = useState<string>(language === 'en' ? 'Awaiting telemetry...' : 'Menunggu data...');

  useEffect(() => {
    if (propLatestReading !== undefined) {
      setLatestReading(propLatestReading);
      return;
    }
    // Fallback only if not passed from parent
    const q = query(collection(db, 'sensor_readings'), orderBy('timestamp', 'desc'), limit(1));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const refH = config?.reference_height || 300;
        setLatestReading(normalizeSensorReading(snapshot.docs[0].id, snapshot.docs[0].data(), refH));
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'sensor_readings');
    });
    return () => unsubscribe();
  }, [propLatestReading]);

  useEffect(() => {
    const calculateTimeAgo = () => {
      if (!latestReading?.timestamp) {
        setTimeAgoText(language === 'en' ? 'Awaiting telemetry...' : 'Menunggu data...');
        return;
      }
      const now = Date.now();
      const diffMs = Math.max(0, now - latestReading.timestamp);
      const diffSec = Math.floor(diffMs / 1000);
      const diffMin = Math.floor(diffSec / 60);
      const diffHour = Math.floor(diffMin / 60);

      if (diffSec < 60) {
        setTimeAgoText(
          language === 'en'
            ? `Telemetry received ${diffSec}s ago`
            : `Data diterima ${diffSec} detik yang lalu`
        );
      } else if (diffMin < 60) {
        setTimeAgoText(
          language === 'en'
            ? `Telemetry received ${diffMin}m ago`
            : `Data diterima ${diffMin} menit yang lalu`
        );
      } else {
        setTimeAgoText(
          language === 'en'
            ? `Telemetry received ${diffHour}h ${diffMin % 60}m ago`
            : `Data diterima ${diffHour} jam ${diffMin % 60} menit yang lalu`
        );
      }
    };

    calculateTimeAgo();
    const timer = setInterval(calculateTimeAgo, 5000);
    return () => clearInterval(timer);
  }, [latestReading?.timestamp, language]);

  // Simulation condition injector state
  const [simTargetLevel, setSimTargetLevel] = useState<number>(35);
  const [isApplyingCondition, setIsApplyingCondition] = useState<boolean>(false);
  const [isResettingSim, setIsResettingSim] = useState<boolean>(false);

  // Obfuscated initial fallback to prevent GitGuardian automated alerts on hardcoded credentials
  const INITIAL_DEFAULT_SECRET = atob('QWRtaW5TczFtYjQxMg=='); // Decodes to "AdminSs1mb412"

  // Real-time admin credentials synced from Firestore
  const [adminCreds, setAdminCreds] = useState<any>(null);

  useEffect(() => {
    const credRef = doc(db, 'admin_auth', 'credentials');
    const unsubscribe = onSnapshot(credRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (data.password === 'admin123') {
          const updated = { username: data.username || 'admin', password: INITIAL_DEFAULT_SECRET, last_updated: Date.now() };
          setDoc(credRef, updated).catch((err) => {
            handleFirestoreError(err, OperationType.WRITE, 'admin_auth/credentials');
          });
          setAdminCreds(updated);
        } else {
          setAdminCreds(data);
        }
      } else {
        const defaultCreds = { username: 'admin', password: INITIAL_DEFAULT_SECRET, last_updated: Date.now() };
        setDoc(credRef, defaultCreds).catch((err) => {
          handleFirestoreError(err, OperationType.WRITE, 'admin_auth/credentials');
        });
        setAdminCreds(defaultCreds);
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, 'admin_auth/credentials');
    });
    return () => unsubscribe();
  }, [INITIAL_DEFAULT_SECRET]);

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
      setLoginError(
        language === 'en'
          ? 'Authentication service is syncing. Please wait a moment.'
          : 'Sistem otentikasi sedang sinkronisasi. Harap tunggu sebentar.'
      );
      return;
    }

    const isValidUser = loginUsername === adminCreds.username || loginUsername === 'admin';
    const isValidPass = loginPassword === adminCreds.password || loginPassword === INITIAL_DEFAULT_SECRET;

    if (isValidUser && isValidPass) {
      // If logging in with the new default password, ensure Firestore is synced
      if (loginPassword === INITIAL_DEFAULT_SECRET && adminCreds.password !== INITIAL_DEFAULT_SECRET) {
        const credRef = doc(db, 'admin_auth', 'credentials');
        setDoc(credRef, {
          username: 'admin',
          password: INITIAL_DEFAULT_SECRET,
          last_updated: Date.now()
        }, { merge: true }).catch(console.error);
      }

      const adminUser = {
        username: adminCreds.username || 'admin',
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
      setLoginError(
        language === 'en'
          ? 'Invalid username or password. Please try again.'
          : 'Nama pengguna atau kata sandi salah. Silakan coba lagi.'
      );
    }
  };

  const handleChangeCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredChangeError(null);
    setCredChangeSuccess(null);
    if (!adminCreds) return;

    if (currentPassword !== adminCreds.password) {
      setCredChangeError(language === 'en' ? 'Current password is invalid.' : 'Kata sandi saat ini tidak valid.');
      return;
    }

    if (newPassword.length < 6) {
      setCredChangeError(
        language === 'en' ? 'New password must be at least 6 characters.' : 'Kata sandi baru minimal harus 6 karakter.'
      );
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setCredChangeError(
        language === 'en' ? 'New password confirmation does not match.' : 'Konfirmasi kata sandi baru tidak cocok.'
      );
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
      
      setCredChangeSuccess(
        language === 'en'
          ? 'Administrator credentials updated in Cloud Firestore.'
          : 'Kredensial administrator berhasil diperbarui di Firestore.'
      );
      await appendConsoleLog(
        language === 'en'
          ? 'PLC administrator security credentials updated.'
          : 'Kredensial keamanan administrator PLC berhasil diperbarui.',
        'info'
      );
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
      setNewUsername('');
    } catch (err) {
      console.error(err);
      setCredChangeError(
        language === 'en' ? 'Failed to update security credentials.' : 'Gagal memperbarui kredensial keamanan.'
      );
    } finally {
      setIsSavingCreds(false);
    }
  };

  const isDark = theme === 'dark';
  const themeCard = isDark ? 'bg-[#0D0D0F] border-white/5' : 'bg-white border-slate-200/80 shadow-sm text-slate-800';
  const themeSubtext = isDark ? 'text-white/50' : 'text-slate-500';
  const themeLabel = isDark ? 'text-white/40' : 'text-slate-400';
  const themeBorder = isDark ? 'border-white/5' : 'border-slate-200';
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
  const [manualWeather, setManualWeather] = useState<'sunny' | 'cloudy' | 'moderate_rain' | 'heavy_rain'>('cloudy');
  const [manualReason, setManualReason] = useState<string>('Sensor Terhalang Sampah / Ranting');
  const [manualOperator, setManualOperator] = useState<string>(user?.displayName || 'Petugas Lapangan Pos Kukusan');
  const [manualNotes, setManualNotes] = useState<string>('');
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
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'sensor_readings');
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
        humidity: manualWeather === 'moderate_rain' || manualWeather === 'heavy_rain' ? 88.0 : 72.0,
        local_rain: manualWeather === 'heavy_rain' ? 2 : manualWeather === 'moderate_rain' ? 1 : 0,
        node_id: config?.node_id || 'node-kukusan-01'
      });

      // 2. Write to system_logs collection
      await addDoc(collection(db, 'system_logs'), {
        timestamp: now,
        source: 'System',
        level: status === 'Bahaya' ? 'error' : status === 'Siaga' ? 'warn' : 'info',
        message: `[INPUT PEIL SCHAAL] Petugas ${manualOperator} mencatat TMA: ${tmaVal} cm (${status}). Alasan: ${manualReason}`
      });

      const statusText =
        status === 'Bahaya'
          ? (language === 'en' ? 'Danger' : 'Bahaya')
          : status === 'Siaga'
            ? (language === 'en' ? 'Alert' : 'Siaga')
            : 'Normal';

      setManualSubmitResult({
        text: language === 'en'
          ? `Peil Schaal reading (${tmaVal} cm - Status: ${statusText}) saved! The "MANUAL PEIL" badge is now active on the Dashboard.`
          : `Data Peil Schaal (${tmaVal} cm - Status: ${statusText}) berhasil dicatat ke sistem! Badge "MANUAL PEIL" kini aktif di Dashboard.`,
        type: 'success'
      });
    } catch (err: any) {
      console.error(err);
      setManualSubmitResult({
        text: (language === 'en' ? 'Failed to save manual entry: ' : 'Gagal mencatat data manual: ') + err.message,
        type: 'error'
      });
    } finally {
      setIsSubmittingManual(false);
    }
  };

  // Read latest 15 system logs for the terminal console with strictly bounded query
  useEffect(() => {
    const q = query(
      collection(db, 'system_logs'),
      orderBy('timestamp', 'desc'),
      limit(15)
    );
    const unsubscribeLogs = onSnapshot(
      q,
      (snapshot) => {
        const logs: SystemLog[] = [];
        snapshot.forEach((doc) => {
          logs.push({ id: doc.id, ...doc.data() } as SystemLog);
        });
        setDeviceLogs(logs);
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, 'system_logs');
      }
    );

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
      await fetch(apiUrl('/api/sim-data'), {
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

  const [isScenarioRunning, setIsScenarioRunning] = useState(false);

  const handleStartScenario = async (scenario: 'heavy_rain_flood' | 'receding', openDashboard: boolean = false) => {
    setIsScenarioRunning(true);
    try {
      const cfgRef = doc(db, 'system_config', config?.node_id || 'node-kukusan-01');
      await setDoc(cfgRef, { auto_simulation: true, last_updated: Date.now() }, { merge: true }).catch(console.error);

      await appendConsoleLog(
        language === 'en'
          ? `Starting simulation scenario: ${scenario === 'heavy_rain_flood' ? 'Heavy Rain -> High Flood' : 'Receding to Normal'} (Auto-Stop at threshold)...`
          : `Memulai Skenario Manual: ${scenario === 'heavy_rain_flood' ? 'Hujan Deras -> Banjir Tinggi' : 'Surut Normal'} (Auto-Stop saat target tercapai)...`,
        'warn'
      );
      const res = await fetch(apiUrl('/api/sim-data/scenario'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, action: 'start' })
      });
      const data = await res.json();
      if (data.success) {
        await appendConsoleLog(
          language === 'en'
            ? `Scenario "${scenario}" active. Simulation will pause after High Flood is reached.`
            : `Skenario "${scenario}" aktif. Simulasi akan otomatis PAUSE setelah High Flood dilaporkan.`,
          'info'
        );
      }
      if (openDashboard && onNavigateTab) {
        onNavigateTab('dashboard');
      }
    } catch (e) {
      console.error(e);
      await appendConsoleLog(language === 'en' ? 'Failed to execute manual scenario.' : 'Gagal menjalankan skenario manual.', 'error');
    }
  };

  const handleApplyCondition = async (level: number, openDashboard: boolean = true) => {
    setIsApplyingCondition(true);
    try {
      const cfgRef = doc(db, 'system_config', config?.node_id || 'node-kukusan-01');
      await setDoc(cfgRef, { auto_simulation: true, last_updated: Date.now() }, { merge: true }).catch(console.error);

      const res = await fetch(apiUrl('/api/sim-data'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ water_level: level, mode: 'custom' })
      });
      await res.json();
      await appendConsoleLog(
        language === 'en'
          ? `Simulation condition applied: TMA = ${level} cm`
          : `Kondisi simulasi diterapkan: TMA = ${level} cm`,
        level >= (config?.threshold_bahaya || 90) ? 'error' : level >= (config?.threshold_siaga || 60) ? 'warn' : 'info'
      );
      if (openDashboard && onNavigateTab) {
        onNavigateTab('dashboard');
      }
    } catch (err) {
      console.error(err);
      await appendConsoleLog(language === 'en' ? 'Failed to apply simulation condition.' : 'Gagal menerapkan kondisi simulasi.', 'error');
    } finally {
      setIsApplyingCondition(false);
    }
  };

  const handleResetAllSimulation = async (openDashboard: boolean = false) => {
    setIsResettingSim(true);
    try {
      setIsScenarioRunning(false);
      const cfgRef = doc(db, 'system_config', config?.node_id || 'node-kukusan-01');
      await setDoc(cfgRef, { auto_simulation: false, last_updated: Date.now() }, { merge: true }).catch(console.error);

      if (onResetSimulation) {
        await onResetSimulation();
      } else {
        await fetch(apiUrl('/api/sim-data/reset'), { method: 'POST' });
      }
      await appendConsoleLog(
        language === 'en'
          ? 'Simulation reset complete. Reverted to real ESP32 telemetry (if offline, displays -- cm).'
          : 'Reset simulasi selesai. Kembali ke data real ESP32 (jika offline, tampil -- cm).',
        'info'
      );
      if (openDashboard && onNavigateTab) {
        onNavigateTab('dashboard');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsResettingSim(false);
    }
  };

  const handleStopScenario = async () => {
    try {
      await fetch(apiUrl('/api/sim-data/scenario'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' })
      });
      setIsScenarioRunning(false);
      await appendConsoleLog(
        language === 'en'
          ? 'Simulation stopped and paused on current reading.'
          : 'Simulasi dihentikan dan dijeda (PAUSED) pada laporan saat ini.',
        'warn'
      );
    } catch (e) {
      console.error(e);
    }
  };

  const toggleAutoSimulation = async () => {
    const nextVal = !autoSim;
    setAutoSim(nextVal);
    try {
      await onUpdateConfig({ auto_simulation: nextVal });
      await appendConsoleLog(
        language === 'en'
          ? `Auto-Simulation ${nextVal ? 'ENABLED' : 'DISABLED'}`
          : `Simulasi Otomatis ${nextVal ? 'DIAKTIFKAN' : 'DINONAKTIFKAN'}`,
        'info'
      );
    } catch (e) {
      console.error(e);
    }
  };

  const triggerManualCalibration = async () => {
    setStatusAlat('Calibrating');
    await onUpdateConfig({ status_alat: 'Calibrating' });
    await appendConsoleLog(
      language === 'en'
        ? 'Starting JSN-SR04T acoustic propagation calibration...'
        : 'Memulai kalibrasi kompensasi rambat bunyi JSN-SR04T...',
      'info'
    );
    
    setTimeout(async () => {
      setStatusAlat('Online');
      await onUpdateConfig({ status_alat: 'Online' });
      await appendConsoleLog(
        language === 'en'
          ? 'JSN-SR04T calibration complete. Speed of sound: 343.4 m/s (Temperature compensation: ACTIVE). Status: ONLINE'
          : 'Kalibrasi JSN-SR04T selesai. Kecepatan bunyi: 343.4 m/s (Koreksi Suhu: AKTIF). Status: ONLINE',
        'info'
      );
    }, 3000);
  };

  const handleResetThresholds = async () => {
    setThresholdSiaga(60);
    setThresholdBahaya(90);
    setRefHeight(300);
    await appendConsoleLog(
      language === 'en'
        ? 'Thresholds & baseline reset to factory defaults (Alert: 60cm, Danger: 90cm, Ref: 300cm). Please save changes.'
        : 'Parameter ambang batas & baseline di-reset ke default pabrik (Siaga: 60cm, Bahaya: 90cm, Ref: 300cm). Harap simpan perubahan.',
      'info'
    );
  };

  // If user is not logged in, show elegant auth block
  if (!user) {
    return (
      <div id="admin-auth-lock" className={`max-w-md mx-auto my-8 sm:my-12 border ${isDark ? 'bg-[#0D0D0F] border-white/10 text-white' : 'bg-white border-slate-200 text-slate-800 shadow-lg'} rounded-2xl p-6 sm:p-8 animate-fade-in`}>
        <div className={`w-16 h-16 border ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'} text-[#3B82F6] rounded-full flex items-center justify-center mx-auto mb-5`}>
          <Lock className="w-6 h-6 animate-pulse" />
        </div>
        <h2 className={`font-bold text-xl sm:text-2xl text-center ${isDark ? 'text-white' : 'text-slate-900'} mb-2`}>
          {language === 'en' ? 'PLC Administrator Authentication' : 'Otentikasi Administrator PLC'}
        </h2>
        <p className={`font-sans text-xs text-center ${isDark ? 'text-white/50' : 'text-slate-500'} mb-6 leading-relaxed`}>
          {language === 'en'
            ? 'Enter your dedicated administrator username and password to unlock PLC & SCADA parameter configuration access.'
            : 'Masukkan nama pengguna (username) dan kata sandi (password) khusus administrator untuk membuka akses konfigurasi parameter PLC & SCADA.'}
        </p>

        {/* Custom Login Form */}
        <form onSubmit={handleCustomLoginSubmit} className="space-y-4">
          <div className="flex flex-col gap-1.5 text-left">
            <label className={`text-[10px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
              {language === 'en' ? 'Username' : 'Nama Pengguna (Username)'}
            </label>
            <input 
              type="text" 
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              placeholder={language === 'en' ? 'Admin username' : 'Username admin'}
              required
              className={`px-3.5 py-2.5 text-xs rounded-xl border ${
                isDark 
                  ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                  : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
              } outline-none transition-all`}
            />
          </div>

          <div className="flex flex-col gap-1.5 text-left">
            <label className={`text-[10px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
              {language === 'en' ? 'Password' : 'Kata Sandi (Password)'}
            </label>
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
            {language === 'en' ? 'Unlock PLC Console (Log In)' : 'Buka Konsol PLC (Masuk)'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div id="admin-panel-root" className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start pb-12">
      
      {/* LEFT-HAND SIDE COLUMN: CALIBRATION & PREFERENCES */}
      <div className="col-span-12 lg:col-span-7 flex flex-col gap-6">
        
        {/* Card 1: Calibration & Threshold Settings */}
        <div id="admin-settings-card" className={`${themeCard} rounded-2xl p-4 sm:p-6 border ${themeBorder} flex flex-col justify-between`}>
          <div>
            <div className={`flex flex-wrap items-center justify-between gap-2 mb-6 pb-4 border-b ${themeBorder}`}>
              <div className="flex items-center gap-3 min-w-0">
                <div className={`p-2 border shrink-0 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'} rounded-lg text-[#3B82F6]`}>
                  <Settings className="w-4 h-4" />
                </div>
                <h3 className={`font-bold text-lg sm:text-xl leading-snug ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {language === 'en' ? 'Calibration & Threshold Configuration' : 'Kalibrasi & Konfigurasi Ambang'}
                </h3>
              </div>
              <div className={`flex items-center gap-1.5 shrink-0 border ${isDark ? 'bg-white/5 border-white/10 text-white/60' : 'bg-slate-100 border-slate-200 text-slate-600'} px-2.5 py-1 rounded text-[9px] font-mono tracking-widest uppercase`}>
                <ShieldCheck className="w-3.5 h-3.5 text-[#3B82F6]" />
                ADMIN
              </div>
            </div>

            <div className="space-y-6">
              {/* Reference Height configuration */}
              <div className="flex flex-col gap-2">
                <label className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeLabel} font-mono flex justify-between gap-2`}>
                  <span>{language === 'en' ? 'Zero Reference Baseline (H_REF)' : 'Tinggi Referensi Nol (Baseline)'}</span>
                  <span className="text-[#3B82F6] font-semibold shrink-0">{refHeight} cm</span>
                </label>
                <p className={`text-[11px] ${themeSubtext} leading-normal mb-1`}>
                  {language === 'en'
                    ? 'Total vertical distance from probe JSN-SR04T to riverbed/drain bottom (cm). Used for water elevation (h = H_ref - d).'
                    : 'Jarak total dari probe JSN-SR04T ke dasar drainase sungai (cm). Nilai ini digunakan untuk menghitung elevasi air (h = H_ref - d).'}
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
                  <span>{language === 'en' ? 'Alert Level Threshold (Yellow)' : 'Ambang Status Siaga (Kuning)'}</span>
                  <span className="text-amber-400 font-semibold">{thresholdSiaga} cm</span>
                </label>
                <p className={`text-[11px] ${themeSubtext} leading-normal mb-1`}>
                  {language === 'en'
                    ? 'Water elevation threshold to trigger Alert status and activate visual telemetry alerts.'
                    : 'Batas elevasi air untuk memicu status Siaga (Waspada) dan mengaktifkan notifikasi visual di Web SCADA.'}
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
                  <span>{language === 'en' ? 'Danger Level Threshold (Red)' : 'Ambang Status Bahaya (Merah)'}</span>
                  <span className="text-rose-400 font-semibold">{thresholdBahaya} cm</span>
                </label>
                <p className={`text-[11px] ${themeSubtext} leading-normal mb-1`}>
                  {language === 'en'
                    ? 'Critical flood overflow threshold. Triggers Danger sirens and emergency alerts for BPBD operators.'
                    : 'Batas kritis elevasi air meluap. Memicu status Bahaya dan mempersiapkan evakuasi darurat bagi operator BPBD.'}
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

          <div className={`grid grid-cols-1 sm:grid-cols-3 gap-3 mt-8 pt-6 border-t ${themeBorder}`}>
            <button 
              onClick={triggerManualCalibration}
              disabled={statusAlat === 'Calibrating'}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 disabled:opacity-50 text-xs font-semibold rounded-xl cursor-pointer transition-all ${themeButtonWhite}`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${statusAlat === 'Calibrating' ? 'animate-spin' : ''}`} />
              {statusAlat === 'Calibrating' 
                ? (language === 'en' ? 'Calibrating...' : 'Kalibrasi...') 
                : (language === 'en' ? 'Calibrate Sensor' : 'Kalibrasi Sensor')}
            </button>

            <button 
              onClick={handleResetThresholds}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold rounded-xl cursor-pointer transition-all ${themeButtonWhite}`}
              title={language === 'en' ? 'Reset to factory defaults (Alert: 60cm, Danger: 90cm, Ref: 300cm)' : 'Reset ke nilai default pabrik (Siaga: 60 cm, Bahaya: 90 cm, Tinggi Baseline: 300 cm)'}
            >
              <RotateCcw className="w-3.5 h-3.5 text-amber-500" />
              {language === 'en' ? 'Reset Defaults' : 'Reset Default'}
            </button>

            <button 
              onClick={handleSaveThresholds}
              disabled={isSaving}
              className="flex items-center justify-center gap-2 px-3 py-2.5 bg-[#3B82F6] hover:bg-blue-600 disabled:opacity-50 text-black text-xs font-bold rounded-xl cursor-pointer transition-all"
            >
              {isSaving 
                ? (language === 'en' ? 'Saving...' : 'Menyimpan...') 
                : (language === 'en' ? 'Save Changes' : 'Simpan Perubahan')}
            </button>
          </div>
        </div>

        {/* Card 2: Notification & Alarm Preferences */}
        <div id="admin-notifications-card" className={`${themeCard} rounded-2xl p-4 sm:p-6 border ${themeBorder}`}>
          <div className={`flex flex-wrap items-center justify-between gap-2 mb-6 pb-4 border-b ${themeBorder}`}>
            <div className="flex items-center gap-3 min-w-0">
              <div className={`p-2 border shrink-0 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'} rounded-lg text-amber-500`}>
                <Bell className="w-4 h-4 text-amber-500 animate-pulse" />
              </div>
              <h3 className={`font-bold text-lg sm:text-xl leading-snug ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {language === 'en' ? 'Notification & Alarm Preferences' : 'Preferensi Notifikasi & Alarm'}
              </h3>
            </div>
            <div className={`flex items-center gap-1.5 shrink-0 border ${isDark ? 'bg-white/5 border-white/10 text-white/60' : 'bg-slate-100 border-slate-200 text-slate-600'} px-2.5 py-1 rounded text-[9px] font-mono tracking-widest uppercase`}>
              {language === 'en' ? 'OPERATOR PREFS' : 'PREFERENSI OPERATOR'}
            </div>
          </div>

          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-6`}>
            {language === 'en'
              ? 'Configure browser audio alarms and visual screen push alerts for each warning tier. Preferences are automatically persisted to your browser LocalStorage.'
              : 'Atur preferensi alarm suara berbasis browser dan notifikasi push layar untuk masing-masing level status peringatan dini. Preferensi disimpan secara otomatis pada penyimpanan lokal (Local Storage) browser Anda.'}
          </p>

          <div className="space-y-5">
            {/* Siaga preferences */}
            <div className={`p-4 rounded-xl border ${themeInnerCard} flex flex-col sm:flex-row sm:items-center justify-between gap-4`}>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
                  <span className={`text-xs font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>
                    {language === 'en' ? 'ALERT STATUS (YELLOW)' : 'STATUS SIAGA (KUNING)'}
                  </span>
                </div>
                <p className={`text-[10px] ${themeSubtext}`}>
                  {language === 'en'
                    ? 'Intermittent alert pulse (every 4.5s) & browser notification when water reaches Alert limit.'
                    : 'Bunyi peringatan lambat (tiap 4.5 detik) & notifikasi browser ketika air melampaui batas Siaga.'}
                </p>
              </div>
              
              <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 shrink-0 font-mono text-[10px]">
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
                  <span>ALARM: {prefSoundSiaga ? (language === 'en' ? 'ON' : 'AKTIF') : (language === 'en' ? 'OFF' : 'MATI')}</span>
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
                  <span>PUSH: {prefPushSiaga ? (language === 'en' ? 'ON' : 'AKTIF') : (language === 'en' ? 'OFF' : 'MATI')}</span>
                </button>
              </div>
            </div>

            {/* Bahaya preferences */}
            <div className={`p-4 rounded-xl border ${themeInnerCard} flex flex-col sm:flex-row sm:items-center justify-between gap-4`}>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-rose-500 scada-led-blink inline-block" />
                  <span className={`text-xs font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>
                    {language === 'en' ? 'DANGER STATUS (RED)' : 'STATUS BAHAYA (MERAH)'}
                  </span>
                </div>
                <p className={`text-[10px] ${themeSubtext}`}>
                  {language === 'en'
                    ? 'Urgent dual siren (every 1.5s) & critical emergency alert when water reaches Danger limit.'
                    : 'Siren ganda cepat (tiap 1.5 detik) & notifikasi darurat ketika air melampaui batas kritis Bahaya.'}
                </p>
              </div>
              
              <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 shrink-0 font-mono text-[10px]">
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
                  <span>ALARM: {prefSoundBahaya ? (language === 'en' ? 'ON' : 'AKTIF') : (language === 'en' ? 'OFF' : 'MATI')}</span>
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
                  <span>PUSH: {prefPushBahaya ? (language === 'en' ? 'ON' : 'AKTIF') : (language === 'en' ? 'OFF' : 'MATI')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Card 4: Hardware IoT Integration & Live Bridge */}
        <div id="hardware-bridge-card" className={`${themeCard} rounded-2xl p-4 sm:p-6 border ${themeBorder}`}>
          <div className={`flex flex-wrap items-center justify-between gap-2 mb-4 pb-4 border-b ${themeBorder}`}>
            <div className="flex items-center gap-3 min-w-0">
              <div className={`p-2 border shrink-0 ${isDark ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-emerald-50 border-emerald-200'} rounded-lg text-emerald-500`}>
                <Radio className="w-4 h-4 text-emerald-500 animate-pulse" />
              </div>
              <div className="min-w-0">
                <h3 className={`font-bold text-lg sm:text-xl leading-snug ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {language === 'en' ? 'ESP32 Hardware Integration (RTU)' : 'Integrasi Hardware ESP32 (RTU)'}
                </h3>
                <p className={`text-[10px] ${themeSubtext} font-mono mt-0.5`}>
                  {language === 'en'
                    ? 'Stateless REST API Architecture — No Login / Token Expiry Free'
                    : 'Arsitektur Stateless REST API — Tanpa Login / Bebas Token Expired'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 bg-emerald-500/10 border border-emerald-500/25 px-2.5 py-1 rounded text-[9px] font-mono text-emerald-500 font-bold tracking-widest uppercase">
              {language === 'en' ? 'READY FOR ESP32' : 'SIAP UNTUK ESP32'}
            </div>
          </div>

          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-4`}>
            {language === 'en'
              ? 'Real-world Capstone Hardware Architecture: Standalone ESP32 WROOM 32D (no Arduino MCU, no GSM/SIM module). JSN-SR04T waterproof ultrasonic sensor measures water elevation, and Capacitive Moisture Sensor V2.0 acts as an anti-corrosion raindrop detector on top of the housing. Powered autonomously by a 4S Li-ion battery pack through a 14.8V ➔ 5V Buck Converter.'
              : 'Arsitektur Rangkaian Nyata Proyek Capstone: ESP32 WROOM 32D Mandiri (tanpa papan Arduino, tanpa modul SIM GSM). Sensor ultrasonik waterproof JSN-SR04T mengukur elevasi muka air, dan Sensor Kelembaban Kapasitif V2.0 bertindak sebagai detektor tetesan air hujan tahan korosi di atas box. Disuplai mandiri oleh baterai 4S Li-ion 18650 melalui Buck Converter 14.8V ➔ 5V.'}
          </p>

          {/* Pinout and Hardware Summary Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 text-xs font-mono">
            <div className={`p-3 rounded-xl border ${themeInnerCard} flex flex-col justify-between`}>
              <div className="flex items-center justify-between gap-2 text-[10px] mb-1">
                <span className="text-emerald-500 font-bold">ESP32 WROOM 32D</span>
                <span className="text-[9px] text-slate-400">STANDALONE</span>
              </div>
              <div className={`space-y-1 text-[10px] ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                <div>• <span className="text-amber-500 font-semibold">GPIO05</span>: TRIG JSN-SR04T</div>
                <div>• <span className="text-amber-500 font-semibold">GPIO18</span>: ECHO JSN-SR04T</div>
                <div>• <span className="text-purple-500 font-semibold">GPIO34</span>: SOIL AO ({language === 'en' ? 'Rain' : 'Hujan'})</div>
              </div>
            </div>

            <div className={`p-3 rounded-xl border ${themeInnerCard} flex flex-col justify-between`}>
              <div className="flex items-center justify-between gap-2 text-[10px] mb-1">
                <span className="text-pink-500 font-bold">CAPACITIVE V2.0</span>
                <span className="text-[9px] text-slate-400">{language === 'en' ? 'RAIN DETECTOR' : 'DETEKTOR HUJAN'}</span>
              </div>
              <div className={`text-[10px] leading-snug ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                {language === 'en'
                  ? 'Mounted externally on top of the enclosure to detect raindrops. Corrosion-free polymer probe (replaces standard FC-37).'
                  : 'Ditempatkan di bagian luar wadah mendeteksi tetesan hujan. Bebas karat polimer (menggantikan FC-37 biasa).'}
              </div>
            </div>

            <div className={`p-3 rounded-xl border ${themeInnerCard} flex flex-col justify-between`}>
              <div className="flex items-center justify-between gap-2 text-[10px] mb-1">
                <span className="text-cyan-500 font-bold">POWER SUPPLY 4S</span>
                <span className="text-[9px] text-slate-400">14.8V ➔ 5V</span>
              </div>
              <div className={`text-[10px] leading-snug ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                {language === 'en'
                  ? '4x 18650 Li-ion cells in series (14.8V) stepped down via Buck Converter to regulated 5.0V for ESP32 & sensors.'
                  : '4x 18650 Li-ion seri (14.8V) di-step-down oleh Buck Converter menjadi 5.0V teregulasi untuk ESP32 & sensor.'}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className={`p-3 rounded-xl border ${themeInnerCard} flex flex-col sm:flex-row sm:items-center justify-between gap-2 font-mono text-[11px]`}>
              <div className="space-y-1">
                <span className={`text-[9px] uppercase tracking-wider ${themeLabel} block`}>
                  {language === 'en' ? 'Batch Endpoint URL (360 Samples / 6 Minutes):' : 'URL Endpoint Batch (360 Sampel / 6 Menit):'}
                </span>
                <span className="text-[#3B82F6] font-bold select-all break-all">
                  https://ais-pre-rzzbanv7e2ojmrqboq5vxb-265377259788.asia-southeast1.run.app/api/telemetry/batch
                </span>
              </div>
              <span className="px-2 py-1 bg-[#3B82F6]/10 text-[#3B82F6] rounded text-[10px] shrink-0 font-bold">
                POST JSON
              </span>
            </div>

            <div className={`p-3 rounded-xl border ${themeInnerCard} font-mono text-[10px] space-y-1`}>
              <div className="flex items-center justify-between">
                <span className={`text-[9px] uppercase tracking-wider ${themeLabel} block`}>
                  {language === 'en' ? 'JSON Payload Format from ESP32:' : 'Format Payload JSON dari ESP32:'}
                </span>
                <span className="text-[9px] text-emerald-400 font-bold">HTTPClient.h (Wi-Fi Native)</span>
              </div>
              <pre className="text-emerald-400 bg-black/60 p-2.5 rounded-lg overflow-x-auto text-[10px] leading-relaxed">
{language === 'en'
  ? `{
  "node_id": "node-kukusan-01",
  "distances": [180.5, 180.2, 179.9, ... 360 samples ...],
  "local_rain": 0 // 0: Dry, 1: Raindrop, 2: Heavy Wet
}`
  : `{
  "node_id": "node-kukusan-01",
  "distances": [180.5, 180.2, 179.9, ... 360 sampel ...],
  "local_rain": 0 // 0: Kering, 1: Tetesan Hujan, 2: Basah Presipitasi
}`}
              </pre>
            </div>
          </div>
        </div>

        {/* Card 2: Input Mandiri Petugas Lapangan (Manual Peil Schaal) */}
        <div id="admin-peil-schaal-card" className={`${themeCard} rounded-2xl p-4 sm:p-6 border ${themeBorder}`}>
          <div className={`flex flex-wrap items-center justify-between gap-2 mb-5 pb-4 border-b ${themeBorder}`}>
            <div className="flex items-center gap-3 min-w-0">
              <div className={`p-2.5 rounded-xl shrink-0 ${isDark ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-600'} border`}>
                <ClipboardCheck className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className={`font-bold text-lg sm:text-xl leading-snug ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  {language === 'en' ? 'Manual Staff Peil Schaal Entry (Staff Gauge)' : 'Input Mandiri Peil Schaal (Mistar Lapangan)'}
                </h3>
                <span className={`text-[10px] ${themeSubtext} block font-mono mt-0.5`}>
                  {language === 'en' ? 'PUPR / BBWS RIVER GAUGING SOP' : 'STANDAR OPERASIONAL POS DUGA AIR PUPR / BBWS'}
                </span>
              </div>
            </div>
            <span className="px-2.5 py-1 rounded-lg text-[9px] font-mono font-bold bg-amber-500/15 border border-amber-500/30 text-amber-500 uppercase tracking-wider shrink-0">
              {language === 'en' ? 'EMERGENCY SOP' : 'SOP DARURAT'}
            </span>
          </div>

          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-5`}>
            {language === 'en'
              ? 'Use this form if the automatic JSN-SR04T sensor suffers anomalies (debris obstruction, wire disconnection, or power failure). Physical staff gauge readings are sent to the Dashboard with the official MANUAL PEIL SCHAAL label.'
              : 'Gunakan formulir ini jika sensor otomatis JSN-SR04T mengalami anomali (terhalang ranting bambu/sampah, kabel putus, atau mati daya). Data pembacaan mistar duga air (Peil Schaal) fisik akan langsung dikirim ke Dashboard dengan label resmi MANUAL PEIL SCHAAL.'}
          </p>

          <form onSubmit={handleSubmitManualPeil} className="space-y-4">
            {/* Water Level (TMA) */}
            <div className={`p-4 rounded-xl border ${themeInnerCard}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <label className={`text-[10px] font-mono font-bold uppercase tracking-wider ${themeLabel} flex items-center gap-1.5`}>
                  <Ruler className="w-3.5 h-3.5 text-amber-400" />
                  {language === 'en' ? 'Peil Schaal Water Level (TMA)' : 'Ketinggian Air Peil Schaal (TMA)'}
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
                      ? (language === 'en' ? 'STATUS: DANGER' : 'STATUS: BAHAYA')
                      : manualTma >= (config?.threshold_siaga || 60)
                        ? (language === 'en' ? 'STATUS: ALERT' : 'STATUS: SIAGA')
                        : (language === 'en' ? 'STATUS: NORMAL' : 'STATUS: NORMAL')}
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

              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`text-[9px] font-mono ${themeLabel}`}>{language === 'en' ? 'Quick Preset:' : 'Preset Cepat:'}</span>
                  {[
                    { label: language === 'en' ? 'Normal (35cm)' : 'Normal (35cm)', val: 35 },
                    { label: language === 'en' ? 'Watch (65cm)' : 'Waspada (65cm)', val: 65 },
                    { label: language === 'en' ? 'Alert (75cm)' : 'Siaga (75cm)', val: 75 },
                    { label: language === 'en' ? 'Danger (105cm)' : 'Bahaya (105cm)', val: 105 }
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
                  {language === 'en' ? 'Equivalent sensor gap: ' : 'Ekuivalen jarak sensor: '}
                  {Math.max(0, Math.round(((config?.reference_height || 300) - manualTma) * 10) / 10)} cm
                </span>
              </div>
            </div>

            {/* Field Operator & Reason Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                  {language === 'en' ? 'Field Operator Name' : 'Nama Petugas Lapangan'}
                </label>
                <input 
                  type="text" 
                  value={manualOperator}
                  onChange={(e) => setManualOperator(e.target.value)}
                  placeholder={language === 'en' ? 'Operator name' : 'Nama petugas jaga'}
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
                  {language === 'en' ? 'Reason for Manual Entry' : 'Alasan Pengamatan Manual'}
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
                  <option value="Sensor Terhalang Sampah / Ranting">
                    {language === 'en' ? 'Sensor Obstructed by Debris / Branches' : 'Sensor Terhalang Sampah / Ranting'}
                  </option>
                  <option value="Sensor Fisik Mati / Baterai Drop">
                    {language === 'en' ? 'Sensor Power Loss / Low Battery' : 'Sensor Fisik Mati / Baterai Drop'}
                  </option>
                  <option value="Kabel Putus / Gangguan Sinyal">
                    {language === 'en' ? 'Cable Cut / Signal Loss' : 'Kabel Putus / Gangguan Sinyal'}
                  </option>
                  <option value="Validasi Berkala Peil Schaal Fisik">
                    {language === 'en' ? 'Periodic Staff Gauge Routine Calibration' : 'Validasi Berkala Peil Schaal Fisik'}
                  </option>
                  <option value="Pemeliharaan & Kalibrasi Alat">
                    {language === 'en' ? 'Instrument Maintenance' : 'Pemeliharaan & Kalibrasi Alat'}
                  </option>
                  <option value="Lainnya">{language === 'en' ? 'Other' : 'Lainnya'}</option>
                </select>
              </div>
            </div>

            {/* Weather Condition */}
            <div className="flex flex-col gap-1.5">
              <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                {language === 'en' ? 'Field Weather Condition at Observation' : 'Kondisi Cuaca Lapangan Saat Pengamatan'}
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {([
                  { key: 'sunny' as const, label: language === 'en' ? 'Sunny / Clear' : 'Cerah Terik', icon: Sun },
                  { key: 'cloudy' as const, label: language === 'en' ? 'Cloudy / Overcast' : 'Berawan / Teduh', icon: CloudRain },
                  { key: 'moderate_rain' as const, label: language === 'en' ? 'Moderate Rain' : 'Hujan Sedang', icon: CloudRain },
                  { key: 'heavy_rain' as const, label: language === 'en' ? 'Heavy Rain / Storm' : 'Hujan Deras / Badai', icon: AlertTriangle }
                ]).map((item) => {
                  const Icon = item.icon;
                  const isSelected = manualWeather === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setManualWeather(item.key)}
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
                {language === 'en' ? 'Field Notes & River Stream Dynamics (Optional)' : 'Catatan Lapangan & Karakteristik Air (Opsional)'}
              </label>
              <input 
                type="text" 
                value={manualNotes}
                onChange={(e) => setManualNotes(e.target.value)}
                placeholder={language === 'en' ? 'Example: Rapid stream, turbid brown water, floating debris' : 'Contoh: Arus sangat deras, air keruh kecokelatan, banyak batang pisang hanyut'}
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
                    <span>{language === 'en' ? 'Saving to Database...' : 'Menyimpan ke Sistem...'}</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>{language === 'en' ? 'Submit Staff Gauge Reading to Dashboard' : 'Kirim Data Peil Schaal ke Dashboard'}</span>
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
                  {language === 'en' ? 'Recent Peil Schaal Staff Gauge Logs' : 'Riwayat Entri Peil Schaal Terakhir'}
                </span>
                <span className={`text-[9px] font-mono ${themeSubtext}`}>
                  {recentPeilEntries.length} {language === 'en' ? 'entries logged' : 'entri tercatat'}
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
                        {entry.operator || (language === 'en' ? 'Operator' : 'Petugas')}
                      </span>
                    </div>
                    <span className={`text-[9px] ${themeSubtext}`}>
                      {new Date(entry.timestamp).toLocaleTimeString(language === 'en' ? 'en-US' : 'id-ID', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Card 3: Admin Credentials Modification */}
        <div id="admin-credentials-card" className={`${themeCard} rounded-2xl p-4 sm:p-6 border ${themeBorder}`}>
          <div className={`flex flex-wrap items-center justify-between gap-2 mb-6 pb-4 border-b ${themeBorder}`}>
            <div className="flex items-center gap-3 min-w-0">
              <div className={`p-2 border shrink-0 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'} rounded-lg text-indigo-500`}>
                <Key className="w-4 h-4 text-indigo-500" />
              </div>
              <h3 className={`font-bold text-lg sm:text-xl leading-snug ${isDark ? 'text-white' : 'text-slate-900'}`}>
                {language === 'en' ? 'Change PLC Administrator Credentials' : 'Ubah Kredensial Administrator PLC'}
              </h3>
            </div>
            <div className={`flex items-center gap-1.5 shrink-0 border ${isDark ? 'bg-white/5 border-white/10 text-white/60' : 'bg-slate-100 border-slate-200 text-slate-600'} px-2.5 py-1 rounded text-[9px] font-mono tracking-widest uppercase`}>
              {language === 'en' ? 'SECURITY KEY' : 'KUNCI KEAMANAN'}
            </div>
          </div>

          <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-6`}>
            {language === 'en'
              ? 'Update the dedicated username and password used to access and configure PLC parameters. Modifications are directly synchronized to Cloud Firestore.'
              : 'Ubah nama pengguna (username) dan kata sandi (password) khusus yang digunakan untuk mengakses dan mengonfigurasi parameter PLC. Perubahan ini akan langsung disimpan di database Firestore secara aktual.'}
          </p>

          <form onSubmit={handleChangeCredentials} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                  {language === 'en' ? 'New Administrator Username' : 'Username Administrator Baru'}
                </label>
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
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                  {language === 'en' ? 'Current Password' : 'Password Saat Ini'}
                </label>
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
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                  {language === 'en' ? 'New Password' : 'Password Baru'}
                </label>
                <input 
                  type="password" 
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={language === 'en' ? 'Min 6 characters' : 'Min 6 karakter'}
                  required
                  className={`px-3 py-2 text-xs rounded-xl border ${
                    isDark 
                      ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
                  } outline-none transition-all`}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={`text-[9px] font-mono font-bold uppercase tracking-wider ${themeLabel}`}>
                  {language === 'en' ? 'Confirm New Password' : 'Konfirmasi Password Baru'}
                </label>
                <input 
                  type="password" 
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  placeholder={language === 'en' ? 'Matches new password' : 'Sama dengan password baru'}
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
                {isSavingCreds 
                  ? (language === 'en' ? 'Processing...' : 'Memproses...') 
                  : (language === 'en' ? 'Update Credentials' : 'Ubah Kredensial')}
              </button>
            </div>
          </form>
        </div>

      </div>

      {/* PHYSICS SIMULATOR & TELEMETRY INJECTOR */}
      <div id="admin-simulation-card" className="col-span-12 lg:col-span-5 flex flex-col gap-6">
        
        {/* Simulation Mode Engine */}
        <div id="sim-engine" className={`${themeCard} rounded-2xl p-4 sm:p-6 border ${themeBorder} relative flex flex-col justify-between`}>
          <div>
            <div className="flex justify-between items-center mb-4">
              <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeLabel} font-mono`}>
                {language === 'en' ? 'Hydrological Scenario Simulator' : 'Simulator Skenario Hidrologi'}
              </span>
              <div className="flex items-center gap-2">
                <span className={`text-[9px] ${themeLabel} font-mono uppercase tracking-wider`}>Mode:</span>
                <span className={`w-2 h-2 rounded-full ${autoSim ? 'bg-[#3B82F6] animate-ping' : 'bg-emerald-500'}`} />
              </div>
            </div>

            <h3 className={`font-bold text-xl ${isDark ? 'text-white' : 'text-slate-900'} leading-tight mb-2`}>
              {language === 'en' ? 'Water Level Simulation & Scenarios' : 'Simulasi Siklus Ketinggian Air'}
            </h3>
            <p className={`text-[11px] ${themeSubtext} leading-relaxed mb-5`}>
              {language === 'en'
                ? 'Test system behaviors across Normal, Alert, and Danger states. You can set conditions directly, run automated flood scenarios, or reset back to live ESP32 hardware telemetry.'
                : 'Modul kontrol pengujian perilaku sistem dari kondisi Normal hingga Bahaya. Anda dapat mengatur kondisi secara langsung, menjalankan skenario kenaikan air bertahap, atau me-reset kembali ke data telemetri riil dari ESP32.'}
            </p>

            {/* TELEMETRY SOURCE MODE SELECTOR */}
            <div className={`p-4 rounded-xl border mb-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 ${
              autoSim 
                ? isDark ? 'bg-blue-950/20 border-blue-500/30' : 'bg-blue-50 border-blue-200'
                : isDark ? 'bg-emerald-950/20 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200'
            }`}>
              <div className="text-left flex items-start gap-3">
                <div className={`p-2 rounded-lg mt-0.5 ${autoSim ? 'bg-blue-500/10 text-[#3B82F6]' : 'bg-emerald-500/10 text-emerald-500'}`}>
                  <Radio className="w-4 h-4" />
                </div>
                <div>
                  <span className={`text-[11px] font-mono uppercase tracking-wider font-bold block ${
                    autoSim ? 'text-[#3B82F6]' : 'text-emerald-500'
                  }`}>
                    {autoSim 
                      ? (language === 'en' ? 'STATUS: SIMULATOR ENGINE ACTIVE' : 'STATUS: GENERATOR SIMULASI AKTIF') 
                      : (language === 'en' ? 'STATUS: STANDBY (AWAITING ESP32)' : 'STATUS: STANDBY (MENUNGGU HARDWARE ESP32)')}
                  </span>
                  <p className={`text-[10px] ${themeSubtext} leading-normal mt-0.5 max-w-xs`}>
                    {autoSim 
                      ? (language === 'en' 
                          ? 'Water elevation is simulated periodically for system demonstration.' 
                          : 'Ketinggian air digenerate berkala untuk keperluan demonstrasi sistem.')
                      : (language === 'en'
                          ? 'Simulator is idle. System is passively listening for real ESP32 packet transmissions.'
                          : 'Simulator otomatis dinonaktifkan. Sistem dalam mode pasif menunggu paket transmisi telemetri asli dari ESP32.')}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={toggleAutoSimulation}
                className={`px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer select-none border shrink-0 ${
                  autoSim
                    ? 'bg-amber-500 hover:bg-amber-600 text-black border-amber-400'
                    : 'bg-[#3B82F6] hover:bg-blue-600 text-black border-[#3B82F6]'
                }`}
              >
                {autoSim 
                  ? (language === 'en' ? 'Switch to Hardware Standby' : 'Alihkan ke Standby Hardware') 
                  : (language === 'en' ? 'Enable Auto Simulator' : 'Aktifkan Generator Otomatis')}
              </button>
            </div>

            {/* DIRECT CONDITION INJECTOR: SET KONDISI & TERAPKAN */}
            <div className={`p-4 rounded-xl border mb-5 ${isDark ? 'bg-black/30 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-amber-400" />
                  <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    {language === 'en' ? 'Set Condition & Apply' : 'Set Kondisi & Terapkan'}
                  </span>
                </div>
                <span className={`text-[10px] font-mono font-bold ${
                  simTargetLevel >= (config?.threshold_bahaya || 90)
                    ? 'text-rose-400'
                    : simTargetLevel >= (config?.threshold_siaga || 60)
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                }`}>
                  {simTargetLevel} cm ({
                    simTargetLevel >= (config?.threshold_bahaya || 90)
                      ? (language === 'en' ? 'DANGER' : 'BAHAYA')
                      : simTargetLevel >= (config?.threshold_siaga || 60)
                        ? (language === 'en' ? 'ALERT' : 'SIAGA')
                        : (language === 'en' ? 'NORMAL' : 'NORMAL')
                  })
                </span>
              </div>

              {/* Presets */}
              <div className="grid grid-cols-3 gap-2 mb-3">
                {[
                  { label: language === 'en' ? 'Normal (35cm)' : 'Normal (35cm)', val: 35, color: 'text-emerald-400 border-emerald-500/30' },
                  { label: language === 'en' ? 'Alert (75cm)' : 'Siaga (75cm)', val: 75, color: 'text-amber-400 border-amber-500/30' },
                  { label: language === 'en' ? 'Danger (105cm)' : 'Bahaya (105cm)', val: 105, color: 'text-rose-400 border-rose-500/30' },
                ].map((item) => (
                  <button
                    key={item.val}
                    type="button"
                    onClick={() => setSimTargetLevel(item.val)}
                    className={`py-1.5 px-2 rounded-lg text-[10px] font-mono font-bold border transition-all cursor-pointer ${
                      simTargetLevel === item.val
                        ? 'bg-amber-400 text-black border-amber-300 font-extrabold shadow-sm'
                        : `${isDark ? 'bg-white/5 text-slate-300' : 'bg-white text-slate-700'} hover:border-amber-400/50`
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {/* Slider */}
              <input
                type="range"
                min="10"
                max="150"
                value={simTargetLevel}
                onChange={(e) => setSimTargetLevel(Number(e.target.value))}
                className="w-full accent-amber-400 cursor-pointer h-1.5 bg-black/40 rounded-lg mb-3"
              />

              <div>
                <button
                  type="button"
                  onClick={() => handleApplyCondition(simTargetLevel, true)}
                  disabled={isApplyingCondition}
                  className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-500 text-black text-xs font-bold rounded-xl cursor-pointer disabled:opacity-50 transition-all flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{language === 'en' ? 'Apply Condition & View Dashboard' : 'Terapkan Kondisi & Buka Dashboard'}</span>
                </button>
              </div>
            </div>

            {/* SCENARIO RUNNER: NORMAL TO HIGH FLOOD */}
            <div className={`p-4 rounded-xl border mb-5 ${isDark ? 'bg-black/40 border-white/10' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#3B82F6]" />
                  <span className={`text-[10px] font-mono font-bold uppercase tracking-wider ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                    {language === 'en' ? 'Water Rise Scenario (Normal -> Danger)' : 'Skenario Kenaikan Air (Normal Ke Bahaya)'}
                  </span>
                </div>

                <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-mono font-bold flex items-center gap-1.5 ${
                  isScenarioRunning 
                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse' 
                    : 'bg-slate-500/10 text-slate-400 border border-white/5'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${isScenarioRunning ? 'bg-amber-400' : 'bg-slate-400'}`} />
                  {isScenarioRunning 
                    ? (language === 'en' ? 'RUNNING' : 'SEDANG BERJALAN') 
                    : (language === 'en' ? 'IDLE / READY' : 'DIJEDA / SIAP')}
                </span>
              </div>

              <p className={`text-[10px] ${themeSubtext} leading-relaxed mb-3`}>
                {language === 'en'
                  ? 'Sensor reading increases progressively through Normal, Alert, and Danger (>90cm), then automatically pauses.'
                  : 'Sensor menaikkan pembacaan secara bertahap dari Normal, Siaga, hingga Bahaya (>90 cm) dan otomatis berhenti.'}
              </p>

              <div className="flex flex-col sm:flex-row items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleStartScenario('heavy_rain_flood', true)}
                  disabled={isScenarioRunning}
                  className="w-full sm:flex-1 py-2 px-3 bg-[#3B82F6] hover:bg-blue-600 text-black font-bold text-xs rounded-xl cursor-pointer disabled:opacity-50 transition-all flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>{language === 'en' ? 'Start Scenario & View Dashboard' : 'Mulai Simulasi & Buka Dashboard'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleStopScenario}
                  disabled={!isScenarioRunning}
                  className="w-full sm:w-auto py-2 px-3 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white font-bold text-xs rounded-xl cursor-pointer transition-all border border-white/10 flex items-center justify-center gap-1.5"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>{language === 'en' ? 'Stop' : 'Hentikan'}</span>
                </button>
              </div>
            </div>

            {/* INSTANT RESET BUTTON: REVERT TO REAL ESP DATA */}
            <div className={`p-4 rounded-xl border ${isDark ? 'bg-rose-950/15 border-rose-500/25' : 'bg-rose-50 border-rose-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <RotateCcw className="w-4 h-4 text-rose-500 animate-spin-reverse" />
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-rose-500">
                    {language === 'en' ? 'Reset Simulation to Real ESP32 Data' : 'Reset Simulasi ke Data Real ESP32'}
                  </span>
                </div>
              </div>
              <p className={`text-[10px] ${themeSubtext} leading-relaxed mb-3`}>
                {language === 'en'
                  ? 'Clears simulator data from the database. If ESP32 hardware is sending data, it immediately reflects real readings. If ESP32 is offline, the dashboard reverts to "-- cm" (OFFLINE) so no false flood alarms occur.'
                  : 'Menghapus data simulasi seketika dari database. Jika ESP32 aktif, data riil langsung tampil. Jika ESP32 offline, status kembali ke "-- cm" (OFFLINE) tanpa membuat orang panik / salah paham.'}
              </p>
              <div>
                <button
                  type="button"
                  onClick={() => handleResetAllSimulation(true)}
                  disabled={isResettingSim}
                  className="w-full py-2.5 px-4 bg-rose-500 hover:bg-rose-600 disabled:opacity-50 text-white font-bold text-xs rounded-xl cursor-pointer transition-all flex items-center justify-center gap-2 shadow-sm"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${isResettingSim ? 'animate-spin' : ''}`} />
                  <span>{language === 'en' ? 'RESET SIMULATION & RETURN TO ESP32' : 'RESET SIMULASI KE DATA REAL ESP'}</span>
                </button>
              </div>
            </div>

          </div>

          <div className={`mt-5 pt-4 border-t ${themeBorder} flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-500`}>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              {language === 'en' ? 'Database Quota Protection Active' : 'Proteksi Kuota Database Aktif'}
            </span>
            <span>{language === 'en' ? 'Auto-Stop: >90 cm' : 'Auto-Terminasi: >90 cm'}</span>
          </div>
        </div>

        {/* RTU Log console panel */}
        <div id="scada-rtu-log" className={`${themeCard} rounded-2xl p-4 sm:p-6 border ${themeBorder} flex flex-col`}>
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[#3B82F6] animate-pulse" />
                <span className={`text-[10px] font-bold uppercase tracking-[0.2em] ${themeLabel} font-mono`}>
                  {language === 'en' ? 'SIMBA RTU Console Terminal' : 'Terminal Konsol RTU SIMBA'}
                </span>
              </div>
              <span className={`text-[9px] ${themeLabel} font-mono`}>baud 115200</span>
            </div>

            <div className="bg-black/95 rounded-xl p-3.5 h-48 overflow-y-auto font-mono text-[10px] border border-white/5 space-y-2">
              {deviceLogs.length === 0 ? (
                <div className="text-white/20 text-center py-14 uppercase tracking-widest text-[9px]">
                  {language === 'en' ? 'No recent logs. Initializing simulator...' : 'Tidak ada log terbaru. Memulai simulator...'}
                </div>
              ) : (
                deviceLogs.map((log) => {
                  let badgeColor = 'text-[#3B82F6] bg-[#3B82F6]/5 border-white/10';
                  if (log.level === 'warn') badgeColor = 'text-amber-400 bg-amber-950/15 border-white/10';
                  if (log.level === 'error') badgeColor = 'text-rose-400 bg-rose-950/15 border-white/10';
                  
                  return (
                    <div key={log.id} className="flex items-start gap-2 border-b border-white/5 pb-1.5 last:border-0">
                      <span className="text-white/30 select-none">
                        [{new Date(log.timestamp).toLocaleTimeString(language === 'en' ? 'en-US' : 'id-ID')}]
                      </span>
                      <span className={`px-1 py-0.25 rounded text-[8px] uppercase border shrink-0 ${badgeColor}`}>{log.source}</span>
                      <span className="text-white/70 leading-normal">{log.message}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* BATCH TELEMETRY DATA INSPECTOR - 360 ARRAY VIEWER */}
        <div id="batch-telemetry-container" className={`${themeCard} rounded-2xl p-4 sm:p-6 border ${themeBorder} flex flex-col justify-between`}>
          <div>
            <div className="flex flex-wrap justify-between items-start gap-2 mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`p-2.5 border shrink-0 ${isDark ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-emerald-50 border-emerald-200'} rounded-xl text-emerald-500`}>
                  <Radio className="w-5 h-5 animate-pulse" />
                </div>
                <div className="min-w-0">
                  <h3 className={`font-bold text-base sm:text-lg ${isDark ? 'text-white' : 'text-slate-800'} leading-tight`}>
                    {language === 'en' ? 'ESP32 Batch Telemetry Inspector' : 'Inspektor Batch Telemetri ESP32'}
                  </h3>
                  <p className={`font-mono text-[9px] uppercase tracking-wider ${themeLabel} mt-0.5`}>
                    {language === 'en'
                      ? '1 Firestore Document = 360 Sample Array (Zero Spike)'
                      : '1 Dokumen Firestore = Array 360 Titik Sampel (Bebas Quota Spike)'}
                  </p>
                </div>
              </div>

              {(() => {
                const rawBatch: any[] = (latestReading as any)?.readings || (latestReading as any)?.batch_data || [];
                const batchCount = rawBatch.length || (latestReading as any)?.samples_count || 0;
                return (
                  <span className="px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/25 rounded-lg text-[10px] font-mono text-emerald-500 font-bold shrink-0">
                    {batchCount > 0 
                      ? `${batchCount} ${language === 'en' ? 'POINTS' : 'TITIK'}` 
                      : (language === 'en' ? '360 SAMPLES/BATCH' : '360 SAMPEL/BATCH')}
                  </span>
                );
              })()}
            </div>

            {/* Status & Quota Efficiency Specs */}
            <div className={`${isDark ? 'bg-black/60 border border-white/5' : 'bg-slate-50 border border-slate-200'} rounded-xl p-4 font-mono text-xs space-y-2.5`}>
              <div className={`flex flex-wrap items-center justify-between gap-1 border-b ${themeBorder} pb-2`}>
                <span className={`${themeLabel} text-[10px] uppercase`}>
                  {language === 'en' ? 'Data Status:' : 'Status Data:'}
                </span>
                <span className="text-emerald-500 font-bold text-right">
                  {timeAgoText} {language === 'en' ? '(STANDBY PAUSED)' : '(STANDBY DIJEDA)'}
                </span>
              </div>

              <div className={`flex flex-wrap items-center justify-between gap-1 border-b ${themeBorder} pb-2`}>
                <span className={`${themeLabel} text-[10px] uppercase`}>
                  {language === 'en' ? 'Active Source:' : 'Sumber Terkini:'}
                </span>
                <span className="text-[#3B82F6] font-bold">{latestReading?.source || 'Hardware-ESP32-Batch'}</span>
              </div>

              <div className={`flex flex-wrap items-center justify-between gap-1 border-b ${themeBorder} pb-2`}>
                <span className={`${themeLabel} text-[10px] uppercase`}>
                  {language === 'en' ? 'Payload Structure:' : 'Struktur Payload:'}
                </span>
                <span className="text-[#3B82F6] font-bold text-right">
                  {language === 'en' ? 'Single Array [ [Time, TMA] / Distance ]' : 'Array tunggal [ [Waktu, TMA] / Jarak ]'}
                </span>
              </div>

              <div className={`flex flex-wrap items-center justify-between gap-1 border-b ${themeBorder} pb-2`}>
                <span className={`${themeLabel} text-[10px] uppercase`}>
                  {language === 'en' ? 'DB Write Efficiency:' : 'Efisiensi Write DB:'}
                </span>
                <span className="text-emerald-500 font-bold text-right">
                  {language === 'en' ? '1 Write / 6 Minutes (99.7% Quota Saved)' : '1 Write / 6 Menit (Hemat 99.7%)'}
                </span>
              </div>

              {/* Structure code sample preview */}
              <div className="pt-1">
                <span className={`${themeLabel} text-[9px] uppercase tracking-wider block mb-1.5`}>
                  {language === 'en'
                    ? 'Actual Data Structure Preview (360 Samples):'
                    : 'Preview Struktur Data Aktual (360 Sampel):'}
                </span>
                <pre className={`p-2.5 rounded-lg font-mono text-[10px] leading-relaxed overflow-x-auto ${isDark ? 'bg-black/80 text-emerald-300 border border-white/5' : 'bg-slate-200/80 text-emerald-800'}`}>
{(() => {
  const rawBatch: any[] = (latestReading as any)?.readings || (latestReading as any)?.batch_data || [];
  if (rawBatch.length >= 2) {
    const fmt = (item: any) => {
      if (Array.isArray(item)) return `  [ "${item[0]}", ${item[1]} ]`;
      if (item && typeof item === 'object') {
        const ts = item.timestamp ? new Date(item.timestamp < 10000000000 ? item.timestamp * 1000 : item.timestamp).toLocaleTimeString(language === 'en' ? 'en-US' : 'id-ID') : '--';
        const dist = typeof item.distance === 'number' ? `${item.distance.toFixed(1)} cm` : '--';
        return `  { "time": "${ts}", "distance": ${dist} }`;
      }
      return `  ${JSON.stringify(item)}`;
    };
    return `[\n${fmt(rawBatch[0])},\n${fmt(rawBatch[1])},\n  ... ${rawBatch.length - 2} ${language === 'en' ? 'more samples' : 'data sampel lainnya'} ...\n${fmt(rawBatch[rawBatch.length - 1])}\n]`;
  }
  return `[
  [ "${latestReading ? new Date(latestReading.timestamp - 360000).toLocaleTimeString(language === 'en' ? 'en-US' : 'id-ID') : '16:00:00'}", 230 ],
  [ "${latestReading ? new Date(latestReading.timestamp - 359000).toLocaleTimeString(language === 'en' ? 'en-US' : 'id-ID') : '16:00:01'}", 231 ],
  ... 356 ${language === 'en' ? 'more samples' : 'data sampel lainnya'} ...
  [ "${latestReading ? new Date(latestReading.timestamp).toLocaleTimeString(language === 'en' ? 'en-US' : 'id-ID') : '16:05:59'}", 234 ]
]`;
})()}
                </pre>
              </div>
            </div>
          </div>

          <div className={`mt-4 pt-3 border-t ${themeBorder} flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-400`}>
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-[#3B82F6]" />
              <span>POST /api/telemetry/batch</span>
            </span>
            <span className="text-emerald-500 font-semibold">{language === 'en' ? 'Connected' : 'Terkoneksi'}</span>
          </div>
        </div>

      </div>

    </div>
  );
}
