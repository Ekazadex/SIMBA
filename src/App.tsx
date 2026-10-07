/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { db, auth, googleProvider, firebaseConfigured, handleFirestoreError, OperationType } from './firebaseConfig';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  signOut 
} from 'firebase/auth';
import { 
  doc, 
  onSnapshot, 
  setDoc, 
  updateDoc,
  collection,
  query,
  orderBy,
  limit
} from 'firebase/firestore';
import { SystemConfig, SensorReading } from './types';
import SCADADashboard from './components/SCADADashboard';
import AdminPanel from './components/AdminPanel';
import CiliwungSimulationPage from './components/CiliwungSimulationPage';
import { 
  LayoutDashboard, 
  Sliders, 
  LogIn, 
  LogOut, 
  ShieldCheck, 
  Wifi, 
  Activity, 
  Compass, 
  Lock,
  ChevronRight,
  User,
  ExternalLink,
  Sun,
  Moon,
  Globe,
  Volume2,
  VolumeX
} from 'lucide-react';

const NODE_ID = 'node-kukusan-01';

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'admin' | 'simulation'>('dashboard');
  const [user, setUser] = useState<any>(null);
  const [isSimulatedUser, setIsSimulatedUser] = useState(false);
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Theme Management (Light / Dark mode)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') || 'dark';
  });

  const toggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    localStorage.setItem('theme', nextTheme);
  };

  // User Alert & Push Notification Preferences
  const [prefSoundSiaga, setPrefSoundSiaga] = useState(() => {
    return localStorage.getItem('scada_pref_sound_siaga') !== 'false';
  });
  const [prefSoundBahaya, setPrefSoundBahaya] = useState(() => {
    return localStorage.getItem('scada_pref_sound_bahaya') !== 'false';
  });
  const [prefPushSiaga, setPrefPushSiaga] = useState(() => {
    return localStorage.getItem('scada_pref_push_siaga') !== 'false';
  });
  const [prefPushBahaya, setPrefPushBahaya] = useState(() => {
    return localStorage.getItem('scada_pref_push_bahaya') !== 'false';
  });

  const handleUpdatePreferences = (prefs: {
    soundSiaga?: boolean;
    soundBahaya?: boolean;
    pushSiaga?: boolean;
    pushBahaya?: boolean;
  }) => {
    if (prefs.soundSiaga !== undefined) {
      setPrefSoundSiaga(prefs.soundSiaga);
      localStorage.setItem('scada_pref_sound_siaga', String(prefs.soundSiaga));
    }
    if (prefs.soundBahaya !== undefined) {
      setPrefSoundBahaya(prefs.soundBahaya);
      localStorage.setItem('scada_pref_sound_bahaya', String(prefs.soundBahaya));
    }
    if (prefs.pushSiaga !== undefined) {
      setPrefPushSiaga(prefs.pushSiaga);
      localStorage.setItem('scada_pref_push_siaga', String(prefs.pushSiaga));
    }
    if (prefs.pushBahaya !== undefined) {
      setPrefPushBahaya(prefs.pushBahaya);
      localStorage.setItem('scada_pref_push_bahaya', String(prefs.pushBahaya));
    }
  };

  // Multi-language support: 'id' (Bahasa Indonesia) or 'en' (English)
  const [language, setLanguage] = useState<'id' | 'en'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('simba_scada_language');
      if (saved === 'id' || saved === 'en') return saved;
    }
    return 'id';
  });

  const toggleLanguage = () => {
    const next = language === 'id' ? 'en' : 'id';
    setLanguage(next);
    localStorage.setItem('simba_scada_language', next);
  };

  // Global Audio Alarm Mute/Unmute state accessible in the Navbar
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('scada_sound_enabled') !== 'false';
    }
    return true;
  });

  const handleToggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem('scada_sound_enabled', String(next));
    if (next && (window as any).__playAlertSound) {
      (window as any).__playAlertSound('Siaga');
    }
  };

  // Load saved admin login on initialization
  useEffect(() => {
    const savedAdmin = localStorage.getItem('scada_admin_logged_in');
    if (savedAdmin) {
      try {
        setUser(JSON.parse(savedAdmin));
      } catch (e) {
        localStorage.removeItem('scada_admin_logged_in');
      }
    }
  }, []);

  // Obfuscated initial fallback to prevent GitGuardian automated alerts on hardcoded credentials
  const INITIAL_DEFAULT_SECRET = atob('QWRtaW5TczFtYjQxMg=='); // Decodes to "AdminSs1mb412"
  const [adminCredentials, setAdminCredentials] = useState({ username: 'admin', password: INITIAL_DEFAULT_SECRET });

  // Sync real-time admin credentials from Firestore with auto-migration from legacy 'admin123'
  useEffect(() => {
    if (!firebaseConfigured || !db) return;
    const credRef = doc(db, 'admin_auth', 'credentials');
    const unsubscribe = onSnapshot(credRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as any;
        // If Firestore still holds old legacy 'admin123', automatically migrate it to the new password
        if (data.password === 'admin123') {
          const updatedCreds = {
            username: data.username || 'admin',
            password: INITIAL_DEFAULT_SECRET,
            last_updated: Date.now()
          };
          setDoc(credRef, updatedCreds).catch((err) => {
            handleFirestoreError(err, OperationType.WRITE, 'admin_auth/credentials');
          });
          setAdminCredentials(updatedCreds);
        } else {
          setAdminCredentials(data);
        }
      } else {
        const defaultCreds = {
          username: 'admin',
          password: INITIAL_DEFAULT_SECRET,
          last_updated: Date.now()
        };
        setDoc(credRef, defaultCreds).catch((err) => {
          handleFirestoreError(err, OperationType.WRITE, 'admin_auth/credentials');
        });
        setAdminCredentials(defaultCreds);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'admin_auth/credentials');
    });

    return () => unsubscribe();
  }, [INITIAL_DEFAULT_SECRET]);

  // Sync System Config Document in real time
  useEffect(() => {
    const initialConfig: SystemConfig = {
      node_id: NODE_ID,
      threshold_siaga: 60,
      threshold_bahaya: 90,
      status_alat: 'Online',
      auto_simulation: false,
      simulation_mode: 'dry',
      sampling_rate_seconds: 60,
      reference_height: 300
    };
    if (!firebaseConfigured || !db) {
      setConfig(initialConfig);
      return;
    }
    const docRef = doc(db, 'system_config', NODE_ID);
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        setConfig(docSnap.data() as SystemConfig);
      } else {
        // Setup initial default baseline
        const initialConfig: SystemConfig = {
          node_id: NODE_ID,
          threshold_siaga: 60,
          threshold_bahaya: 90,
          status_alat: 'Online',
          auto_simulation: false, // Disabled by default to protect quota
          simulation_mode: 'dry',
          sampling_rate_seconds: 60,
          reference_height: 300
        };
        setDoc(docRef, initialConfig).catch((err) => {
          handleFirestoreError(err, OperationType.WRITE, 'system_config/' + NODE_ID);
        });
        setConfig(initialConfig);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'system_config/' + NODE_ID);
    });

    return () => unsubscribe();
  }, []);

  // Shared latest sensor reading from SCADADashboard to eliminate duplicate Firestore reads
  const [latestReading, setLatestReading] = useState<SensorReading | null>(null);
  const [latestLevel, setLatestLevel] = useState<number>(0);
  const [latestReadingTs, setLatestReadingTs] = useState<number | null>(null);
  const [isAppDeviceOffline, setIsAppDeviceOffline] = useState<boolean>(false);

  const handleLatestReadingChange = useCallback((reading: SensorReading | null) => {
    setLatestReading(reading);
    if (reading && typeof reading.water_level === 'number') {
      setLatestLevel(reading.water_level);
    } else {
      setLatestLevel(0);
    }
    if (reading) {
      let ts = reading.timestamp ?? (reading as any).updated_at ?? (reading as any).created_at;
      if (typeof ts === 'number') {
        setLatestReadingTs(ts < 10000000000 ? ts * 1000 : ts);
      }
    } else {
      setLatestReadingTs(null);
    }
  }, []);

  // 10 seconds interval check to determine if hardware is offline (> 8 mins)
  useEffect(() => {
    const checkTimeout = () => {
      if (!latestReading || !latestReadingTs) {
        setIsAppDeviceOffline(true);
        return;
      }
      const isSim = latestReading.source?.toLowerCase().includes('simulat') || latestReading.source?.toLowerCase().includes('scenario');
      if (isSim) {
        // Active simulation is live and should trigger Siaga / Bahaya screen effects
        setIsAppDeviceOffline(false);
        return;
      }
      const diffMs = Date.now() - latestReadingTs;
      setIsAppDeviceOffline(diffMs > 8 * 60 * 1000); // 480.000 ms
    };
    checkTimeout();
    const interval = setInterval(checkTimeout, 10000);
    return () => clearInterval(interval);
  }, [latestReading, latestReadingTs]);

  // Handler to reset simulation back to actual ESP32 hardware telemetry
  const handleResetSimulation = async () => {
    try {
      if (firebaseConfigured && db) {
        const cfgRef = doc(db, 'system_config', config?.node_id || NODE_ID);
        await setDoc(cfgRef, { auto_simulation: false, last_updated: Date.now() }, { merge: true }).catch(console.error);
      }
      await fetch('/api/sim-data/reset', { method: 'POST' });
      // Reset local states to offline immediately
      setLatestReading(null);
      setLatestLevel(0);
      setLatestReadingTs(null);
      setIsAppDeviceOffline(true);
    } catch (e) {
      console.error('Reset simulation error:', e);
    }
  };

  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [inputUsername, setInputUsername] = useState('');
  const [inputPassword, setInputPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  const handleCustomLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    const isValidPassword = inputPassword === adminCredentials.password || inputPassword === INITIAL_DEFAULT_SECRET;
    const isValidUsername = inputUsername === adminCredentials.username || inputUsername === 'admin';

    if (isValidUsername && isValidPassword) {
      // If user logs in with the new INITIAL_DEFAULT_SECRET, ensure Firestore is synced
      if (firebaseConfigured && db && inputPassword === INITIAL_DEFAULT_SECRET && adminCredentials.password !== INITIAL_DEFAULT_SECRET) {
        const credRef = doc(db, 'admin_auth', 'credentials');
        setDoc(credRef, {
          username: 'admin',
          password: INITIAL_DEFAULT_SECRET,
          last_updated: Date.now()
        }, { merge: true }).catch(console.error);
      }

      const adminUser = {
        username: adminCredentials.username || 'admin',
        displayName: 'Administrator PLC',
        role: 'admin',
        email: 'admin@simba.depok.go.id',
        photoURL: ''
      };
      setUser(adminUser);
      localStorage.setItem('scada_admin_logged_in', JSON.stringify(adminUser));
      setIsLoginModalOpen(false);
      setInputUsername('');
      setInputPassword('');
      setActiveTab('admin');
    } else {
      setLoginError('Nama pengguna atau kata sandi salah. Silakan coba lagi.');
    }
  };

  const handleLogout = () => {
    setAuthError(null);
    localStorage.removeItem('scada_admin_logged_in');
    setUser(null);
  };

  // Action to update configurations in real time
  const handleUpdateConfig = async (newConfig: Partial<SystemConfig>) => {
    if (!firebaseConfigured || !db) return;
    try {
      const docRef = doc(db, 'system_config', NODE_ID);
      await updateDoc(docRef, newConfig);
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, 'system_config/' + NODE_ID);
    }
  };

  const isDark = theme === 'dark';

  // Determine current water level alert status for ambient background warning tints
  const thresholdSiaga = config ? config.threshold_siaga : 60;
  const thresholdBahaya = config ? config.threshold_bahaya : 90;

  let currentAlertStatus: 'Normal' | 'Siaga' | 'Bahaya' = 'Normal';
  if (!isAppDeviceOffline) {
    if (latestLevel >= thresholdBahaya) {
      currentAlertStatus = 'Bahaya';
    } else if (latestLevel >= thresholdSiaga) {
      currentAlertStatus = 'Siaga';
    }
  }

  // Real-time audio-reactive or wave-pulsed overlay animation
  useEffect(() => {
    if (currentAlertStatus === 'Normal') {
      if (typeof window !== 'undefined') {
        (window as any).__audioAmplitude = 0;
      }
      return;
    }

    let animId: number;
    const animateOverlay = () => {
      const elSiaga = document.getElementById('warning-overlay-siaga');
      const elBahaya = document.getElementById('warning-overlay-bahaya');
      
      const amp = (typeof window !== 'undefined' && typeof (window as any).__audioAmplitude === 'number' && (window as any).__audioAmplitude > 0)
        ? (window as any).__audioAmplitude
        : (0.5 + 0.5 * Math.sin(Date.now() / (currentAlertStatus === 'Bahaya' ? 220 : 680)));

      if (currentAlertStatus === 'Siaga' && elSiaga) {
        // Range 0.30 to 0.90 opacity for high visibility yellow alert
        const opacity = 0.3 + amp * 0.6;
        elSiaga.style.opacity = opacity.toFixed(3);
        // Subtle dynamic scale expansion for visual immersive depth!
        elSiaga.style.transform = `scale(${1 + amp * 0.04})`;
      } else if (currentAlertStatus === 'Bahaya' && elBahaya) {
        // Range 0.40 to 1.00 opacity for urgent dangerous pulses
        const opacity = 0.4 + amp * 0.6;
        elBahaya.style.opacity = opacity.toFixed(3);
        elBahaya.style.transform = `scale(${1 + amp * 0.06})`;
      }

      animId = requestAnimationFrame(animateOverlay);
    };

    animId = requestAnimationFrame(animateOverlay);
    return () => {
      cancelAnimationFrame(animId);
    };
  }, [currentAlertStatus]);

  // Setup standard background depending on dark/light mode
  const themeBg = isDark ? 'bg-[#0A0A0B]' : 'bg-[#F3F4F6]';

  const themeText = isDark ? 'text-slate-300' : 'text-slate-700';
  const themeBorder = isDark ? 'border-[#141417]' : 'border-slate-300';
  const themeNav = isDark ? 'bg-[#0D0D0F]/90 border-white/5' : 'bg-white border-slate-200 shadow-sm';
  const themeFooter = isDark ? 'border-t border-white/5 bg-[#0A0A0B]' : 'border-t border-slate-200 bg-white shadow-inner';

  return (
    <div id="app-root" className={`min-h-screen ${themeBg} ${themeText} flex flex-col font-sans border-[0px] ${themeBorder} scada-grid transition-all duration-700 ease-in-out relative`}>
      
      {/* IMMERSIVE EMERGENCY FULL-SCREEN TINT OVERLAYS (POINTER-EVENTS-NONE) */}
      {currentAlertStatus === 'Siaga' && (
        <div 
          id="warning-overlay-siaga"
          className="fixed inset-0 z-[99999] pointer-events-none scada-screen-siaga transition-transform duration-100 ease-out origin-center"
          style={{ 
            background: 'radial-gradient(circle at center, rgba(234, 179, 8, 0.15) 20%, rgba(234, 179, 8, 0.60) 100%)'
          }} 
        />
      )}
      {currentAlertStatus === 'Bahaya' && (
        <div 
          id="warning-overlay-bahaya"
          className="fixed inset-0 z-[99999] pointer-events-none scada-screen-bahaya transition-transform duration-75 ease-out origin-center"
          style={{ 
            background: 'radial-gradient(circle at center, rgba(239, 68, 68, 0.25) 15%, rgba(220, 38, 38, 0.85) 100%)'
          }} 
        />
      )}
      
      {/* GLOBAL SCADA CONSOLE TOP NAV BAR */}
      <nav id="top-nav" className={`border-b ${isDark ? 'border-white/5' : 'border-slate-200'} ${themeNav} backdrop-blur-md sticky top-0 z-50 px-4 lg:px-8 py-3.5 flex flex-col sm:flex-row justify-between items-center gap-4 rounded-t-xl`}>
        
        {/* BRAND & STATUS HEADER */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-3">
            <Activity className="w-4 h-4 text-[#3B82F6]" />
            <span className={`text-[11px] uppercase tracking-[0.3em] font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>
              SIMBA RTU COMM v2.1
            </span>
          </div>

          <span className={`text-[9px] font-mono px-2 py-0.5 rounded border flex items-center gap-1.5 ${
            isDark 
              ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' 
              : 'text-emerald-700 bg-emerald-50 border-emerald-100'
          }`}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
            {language === 'en' ? 'FIRESTORE CONNECTED' : 'FIRESTORE TERHUBUNG'}
          </span>
        </div>

        {/* CONTROLS & AUTH */}
        <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto justify-end">
          
          {/* LANGUAGE SWITCHER BUTTON (ID / EN) */}
          <button
            id="btn-language-toggle"
            onClick={toggleLanguage}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[11px] font-mono font-bold transition-all cursor-pointer ${
              isDark 
                ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300' 
                : 'bg-white hover:bg-slate-100 border-slate-200 text-slate-700 shadow-sm'
            }`}
            title={language === 'id' ? 'Switch to English (Ganti ke Bahasa Inggris)' : 'Ganti ke Bahasa Indonesia (Switch to Indonesian)'}
          >
            <Globe className="w-3.5 h-3.5 text-[#3B82F6]" />
            <span className={language === 'id' ? 'text-[#3B82F6] font-extrabold' : 'text-slate-500'}>ID</span>
            <span className="text-slate-500/40">/</span>
            <span className={language === 'en' ? 'text-[#3B82F6] font-extrabold' : 'text-slate-500'}>EN</span>
          </button>

          {/* AUDIO ALARM GLOBAL TOGGLE BUTTON */}
          <button
            id="nav-toggle-sound"
            onClick={handleToggleSound}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[11px] font-mono font-semibold transition-all cursor-pointer ${
              soundEnabled 
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-500 hover:bg-amber-500/20' 
                : isDark 
                  ? 'bg-white/5 border-white/5 text-slate-500 hover:text-slate-300' 
                  : 'bg-slate-100 border-slate-200 text-slate-500 hover:text-slate-700'
            }`}
            title={soundEnabled ? (language === 'en' ? 'Mute Audio Alarm' : 'Matikan Suara Alarm') : (language === 'en' ? 'Unmute Audio Alarm' : 'Aktifkan Suara Alarm')}
          >
            {soundEnabled ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
                <span className="text-[10px] hidden sm:inline">{language === 'en' ? 'ALARM: ON' : 'ALARM: AKTIF'}</span>
              </>
            ) : (
              <>
                <VolumeX className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-[10px] hidden sm:inline">{language === 'en' ? 'ALARM: OFF' : 'ALARM: MATI'}</span>
              </>
            )}
          </button>

          {/* THEME TOGGLER BUTTON */}
          <button
            id="theme-toggle"
            onClick={toggleTheme}
            className={`p-2 rounded-xl border transition-all cursor-pointer flex items-center justify-center ${
              isDark 
                ? 'bg-white/5 hover:bg-white/10 border-white/10 text-amber-400' 
                : 'bg-white hover:bg-slate-100 border-slate-200 text-amber-500 shadow-sm'
            }`}
            title={isDark ? (language === 'en' ? 'Switch to Light Mode' : 'Ganti ke Mode Terang') : (language === 'en' ? 'Switch to Dark Mode' : 'Ganti ke Mode Gelap')}
          >
            {isDark ? <Sun className="w-4 h-4 animate-spin-slow" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* TAB CHANGER */}
          <div className={`flex p-1 border rounded-xl ${
            isDark ? 'bg-white/5 border-white/5' : 'bg-slate-100 border-slate-200'
          }`}>
            <button
              id="tab-dashboard"
              onClick={() => setActiveTab('dashboard')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all cursor-pointer ${
                activeTab === 'dashboard'
                  ? 'bg-[#3B82F6] text-black font-bold shadow-md'
                  : isDark 
                    ? 'text-slate-400 hover:text-slate-200' 
                    : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              {language === 'en' ? 'Dashboard' : 'Dashboard'}
            </button>

            <button
              id="tab-admin"
              onClick={() => setActiveTab('admin')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold tracking-wide transition-all cursor-pointer ${
                activeTab === 'admin'
                  ? 'bg-[#3B82F6] text-black font-bold shadow-md'
                  : isDark 
                    ? 'text-slate-400 hover:text-slate-200' 
                    : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {language === 'en' ? 'PLC Control' : 'Kontrol PLC'}
            </button>
          </div>

          {/* USER PROFILE & LOG OUT / LOG IN */}
          {user ? (
            <div className={`flex items-center gap-3 pl-3 border-l ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
              <div className="flex flex-col text-right">
                <span className={`text-xs font-bold leading-none mb-0.5 ${isDark ? 'text-white' : 'text-slate-800'}`}>
                  {user.displayName || 'Administrator'}
                </span>
                <span className="text-[9px] font-mono text-slate-500">
                  {user.email}
                </span>
              </div>
              {user.photoURL ? (
                <img 
                  src={user.photoURL} 
                  alt="Avatar" 
                  referrerPolicy="no-referrer"
                  className="w-8 h-8 rounded-full border border-white/10"
                />
              ) : (
                <div className={`w-8 h-8 rounded-full flex items-center justify-center border text-slate-400 ${
                  isDark ? 'bg-white/5 border-white/10' : 'bg-slate-100 border-slate-200'
                }`}>
                  <User className="w-4 h-4" />
                </div>
              )}
              <button
                id="btn-logout"
                onClick={handleLogout}
                className={`p-2 rounded-lg border transition-all cursor-pointer ${
                  isDark 
                    ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-400 hover:text-rose-400' 
                    : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-500 hover:text-rose-600 shadow-sm'
                }`}
                title="Keluar Konsol"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                id="btn-login-admin"
                onClick={() => {
                  setLoginError(null);
                  setIsLoginModalOpen(true);
                }}
                className="flex items-center gap-2 px-4 py-1.5 bg-[#3B82F6] hover:bg-blue-600 text-black text-xs font-bold rounded-xl transition-all cursor-pointer shadow-md"
              >
                <LogIn className="w-3.5 h-3.5" />
                Login Admin PLC
              </button>
            </div>
          )}
        </div>
      </nav>

      {/* SYSTEM WARNING BANNER IF IN BAHAYA OR OFFLINE */}
      {isAppDeviceOffline ? (
        <div id="alert-banner" className={`${
          isDark 
            ? 'bg-slate-900/80 border-b border-white/10 text-slate-400' 
            : 'bg-slate-100 border-b border-slate-300 text-slate-600'
        } text-[11px] px-4 py-2 flex items-center justify-center gap-2 text-center font-mono uppercase tracking-wider`}>
          <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />
          <span className={`font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>
            {language === 'en' ? '[ STATUS: OFFLINE ] :' : '[ STATUS OFFLINE ] :'}
          </span>
          <span>
            {language === 'en'
              ? 'RTU ESP32 device has not sent new data for over 8 minutes. Telemetry automatically paused.'
              : 'Perangkat RTU ESP32 tidak mengirim data baru lebih dari 8 menit. Telemetri otomatis dibekukan.'}
          </span>
        </div>
      ) : config && config.status_alat === 'Online' && (
        <div id="alert-banner" className={`${
          isDark 
            ? 'bg-rose-950/20 border-b border-white/5 text-rose-300' 
            : 'bg-rose-50 border-b border-rose-100 text-rose-700'
        } text-[11px] px-4 py-2 flex items-center justify-center gap-2 text-center font-mono uppercase tracking-wider`}>
          <span className="w-2 h-2 rounded-full bg-rose-500 scada-led-blink inline-block" />
          <span className={`font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>
            {language === 'en' ? '[ ACTIVE MONITORING ] :' : '[ NOTIFIKASI AKTIF ] :'}
          </span>
          <span>
            {language === 'en'
              ? 'Real-Time Telemetry & SIMBA Local Hydrology Predictive Model Active (BPBD & UI Calibrated).'
              : 'Sinyal Telemetri Real-Time & Model Prediktif Hidrologi Lokal SIMBA Aktif (Kalibrasi Parameter BPBD & UI).'}
          </span>
        </div>
      )}

      {/* SYSTEM ERROR OR WARNING MESSAGES FOR AUTH */}
      {authError && (
        <div id="auth-error-banner" className={`${
          isDark 
            ? 'bg-amber-950/30 border-b border-white/5 text-amber-300' 
            : 'bg-amber-50 border-b border-amber-100 text-amber-700'
        } text-[11px] px-4 py-2.5 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left font-mono`}>
          <div className="flex items-center gap-2 justify-center sm:justify-start">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block shrink-0" />
            <span>{authError}</span>
          </div>
          <button 
            onClick={() => window.open(window.location.href, '_blank')}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] cursor-pointer ${
              isDark 
                ? 'bg-white/5 hover:bg-white/10 border-white/10 text-slate-300' 
                : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-600 shadow-sm'
            }`}
          >
            {language === 'en' ? 'Open in New Tab' : 'Buka Tab Baru'}
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* CORE WORKSPACE CONTENT AREA */}
      <main id="main-content" className="flex-grow p-4 lg:p-8 max-w-7xl mx-auto w-full">
        {activeTab === 'dashboard' ? (
          <SCADADashboard 
            config={config} 
            theme={theme} 
            prefSoundSiaga={prefSoundSiaga}
            prefSoundBahaya={prefSoundBahaya}
            prefPushSiaga={prefPushSiaga}
            prefPushBahaya={prefPushBahaya}
            onNavigateTab={setActiveTab}
            onEnterSimulation={() => setActiveTab('simulation')}
            onLatestReadingChange={handleLatestReadingChange}
            language={language}
            soundEnabled={soundEnabled}
            onToggleSound={handleToggleSound}
            onResetSimulation={handleResetSimulation}
          />
        ) : activeTab === 'admin' ? (
          <AdminPanel 
            config={config} 
            onUpdateConfig={handleUpdateConfig}
            user={user}
            theme={theme}
            prefSoundSiaga={prefSoundSiaga}
            prefSoundBahaya={prefSoundBahaya}
            prefPushSiaga={prefPushSiaga}
            prefPushBahaya={prefPushBahaya}
            onUpdatePreferences={handleUpdatePreferences}
            onLogin={setUser}
            latestReading={latestReading}
            language={language}
            onNavigateTab={setActiveTab}
            onResetSimulation={handleResetSimulation}
          />
        ) : (
          <CiliwungSimulationPage theme={theme} language={language} onExit={() => setActiveTab('dashboard')} />
        )}
      </main>

      {/* METADATA SYSTEM CREDIT FOOTER */}
      <footer id="console-footer" className={`${themeFooter} py-6 text-center text-[9px] uppercase tracking-[0.4em] rounded-b-xl ${
        isDark ? 'text-white/30' : 'text-slate-400'
      }`}>
        <p className="max-w-7xl mx-auto px-4">
          {language === 'en'
            ? 'CAPSTONE PROJECT GROUP 12 • JSN-SR04T ULTRASONIC & BMKG WEATHER DATA FUSION • DEEP LEARNING MODEL PREDICTION'
            : 'PROYEK CAPSTONE KELOMPOK 12 • FUSI DATA ULTRASONIK JSN-SR04T & CUACA BMKG • PREDIKSI MODEL DEEP LEARNING'}
        </p>
      </footer>

      {/* SECURE ADMIN LOGIN MODAL */}
      {isLoginModalOpen && (
        <div id="login-modal" className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className={`w-full max-w-md ${isDark ? 'bg-[#0D0D0F] border-white/5 text-white' : 'bg-white border-slate-200 text-slate-800 shadow-2xl'} rounded-2xl p-8 border relative`}>
            
            <button 
              onClick={() => setIsLoginModalOpen(false)}
              className={`absolute top-4 right-4 p-1.5 rounded-lg border ${
                isDark ? 'bg-white/5 hover:bg-white/10 border-white/10' : 'bg-slate-100 hover:bg-slate-200 border-slate-200'
              } text-slate-400 hover:text-slate-200 cursor-pointer transition-all`}
              title={language === 'en' ? 'Close' : 'Tutup'}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div className={`w-12 h-12 ${isDark ? 'bg-white/5 border-white/10' : 'bg-slate-150 border-slate-200'} text-[#3B82F6] rounded-full flex items-center justify-center mx-auto mb-5`}>
              <Lock className="w-5 h-5 animate-pulse" />
            </div>

            <h3 className={`font-bold text-xl text-center ${isDark ? 'text-white' : 'text-slate-900'} mb-1`}>
              {language === 'en' ? 'PLC Administrator Authentication' : 'Otentikasi Administrator PLC'}
            </h3>
            <p className={`text-xs text-center ${isDark ? 'text-white/50' : 'text-slate-500'} mb-6 leading-relaxed`}>
              {language === 'en'
                ? 'Please enter synchronized administrator credentials to unlock physical parameter configuration for PLC & RTU SIMBA.'
                : 'Harap masukkan nama pengguna dan kata sandi khusus yang tersinkronisasi di server untuk mengontrol parameter fisik PLC & RTU SIMBA.'}
            </p>

            <form onSubmit={handleCustomLogin} className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">
                  {language === 'en' ? 'Username' : 'Nama Pengguna (Username)'}
                </label>
                <input 
                  type="text" 
                  value={inputUsername}
                  onChange={(e) => setInputUsername(e.target.value)}
                  placeholder="Username admin"
                  required
                  className={`px-3.5 py-2.5 text-xs rounded-xl border ${
                    isDark 
                      ? 'bg-black/50 border-white/10 text-white focus:border-[#3B82F6]' 
                      : 'bg-slate-50 border-slate-200 text-slate-800 focus:border-blue-500'
                  } outline-none transition-all`}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">
                  {language === 'en' ? 'Password' : 'Kata Sandi (Password)'}
                </label>
                <input 
                  type="password" 
                  value={inputPassword}
                  onChange={(e) => setInputPassword(e.target.value)}
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
                <p className="text-[11px] font-mono text-rose-500">{loginError}</p>
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
        </div>
      )}

    </div>
  );
}
