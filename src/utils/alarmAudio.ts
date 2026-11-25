/**
 * Shared global SCADA alarm audio controller for SIMBA.
 * Drives custom MP3 gapless loops (/alarm_siaga.mp3, /alarm_bahaya.mp3) with
 * real-time FFT audio-reactive amplitude (window.__audioAmplitude) and Web Audio
 * synthesized fallback across Dashboard, Simulation, and Admin views without overlap.
 */

export type AlertSoundType = 'Siaga' | 'Bahaya';

let activeAudio: HTMLAudioElement | null = null;
let activeAlertType: AlertSoundType | null = null;
let loopInterval: ReturnType<typeof setInterval> | null = null;
let synthInterval: ReturnType<typeof setInterval> | null = null;
let synthPulseInterval: ReturnType<typeof setInterval> | null = null;
let audioContext: AudioContext | null = null;
let activePlayToken = 0;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext) {
    audioContext = new AudioContextClass();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  return audioContext;
}

/**
 * Call inside any user gesture (e.g., clicking ALARM: AKTIF or Mulai Simulasi)
 * so browser autoplay policies allow alarm playback later when Siaga/Bahaya triggers.
 */
export function unlockAlertAudio(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch {
    // Ignore audio context unlock failures on unsupported browsers
  }
}

export function stopAlertAudio(): void {
  activePlayToken += 1;
  activeAlertType = null;
  pendingAutoplayType = null;
  detachGestureUnlockListener();

  if (synthInterval) {
    clearInterval(synthInterval);
    synthInterval = null;
  }
  if (synthPulseInterval) {
    clearInterval(synthPulseInterval);
    synthPulseInterval = null;
  }
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.currentTime = 0;
    } catch {
      // Ignore pause errors
    }
    activeAudio = null;
  }
  if (typeof window !== 'undefined') {
    (window as any).__audioAmplitude = 0;
  }
}

function simulateSynthPulse(durationMs: number, maxAmp: number): void {
  if (synthPulseInterval) {
    clearInterval(synthPulseInterval);
  }
  const start = Date.now();
  synthPulseInterval = setInterval(() => {
    const elapsed = Date.now() - start;
    if (elapsed >= durationMs) {
      if (synthPulseInterval) {
        clearInterval(synthPulseInterval);
        synthPulseInterval = null;
      }
      if (typeof window !== 'undefined') {
        (window as any).__audioAmplitude = 0;
      }
    } else if (typeof window !== 'undefined') {
      const progress = elapsed / durationMs;
      const amp = Math.sin(progress * Math.PI) * maxAmp;
      (window as any).__audioAmplitude = Math.max((window as any).__audioAmplitude || 0, amp);
    }
  }, 16);
}

function playSynthesizedTone(type: AlertSoundType): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'Bahaya') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(950, ctx.currentTime);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);

      simulateSynthPulse(200, 0.95);

      setTimeout(() => {
        if (activeAlertType !== 'Bahaya') return;
        simulateSynthPulse(200, 1.0);
        try {
          const ctx2 = getAudioContext();
          if (!ctx2) return;
          const osc2 = ctx2.createOscillator();
          const gain2 = ctx2.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx2.destination);
          osc2.type = 'triangle';
          osc2.frequency.setValueAtTime(1050, ctx2.currentTime);
          gain2.gain.setValueAtTime(0.12, ctx2.currentTime);
          gain2.gain.exponentialRampToValueAtTime(0.001, ctx2.currentTime + 0.18);
          osc2.start();
          osc2.stop(ctx2.currentTime + 0.2);
        } catch {
          // Ignore secondary tone errors
        }
      }, 180);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(620, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);

      simulateSynthPulse(250, 0.7);

      setTimeout(() => {
        if (activeAlertType !== 'Siaga') return;
        simulateSynthPulse(250, 0.75);
        try {
          const ctx2 = getAudioContext();
          if (!ctx2) return;
          const osc2 = ctx2.createOscillator();
          const gain2 = ctx2.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx2.destination);
          osc2.type = 'sine';
          osc2.frequency.setValueAtTime(490, ctx2.currentTime);
          gain2.gain.setValueAtTime(0.08, ctx2.currentTime);
          gain2.gain.exponentialRampToValueAtTime(0.001, ctx2.currentTime + 0.22);
          osc2.start();
          osc2.stop(ctx2.currentTime + 0.25);
        } catch {
          // Ignore secondary tone errors
        }
      }, 160);
    }
  } catch (err) {
    console.warn('[Audio] Synthesized alarm failed:', err);
  }
}

/**
 * Brief single chime when toggling ALARM: AKTIF while status is Normal.
 */
export function playAlertPreviewChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  } catch {
    // Ignore preview chime errors
  }
}

function triggerSynthesizedLoop(type: AlertSoundType, token: number): void {
  if (token !== activePlayToken) return;
  if (synthInterval) {
    clearInterval(synthInterval);
  }
  const intervalMs = type === 'Bahaya' ? 1500 : 4500;
  synthInterval = setInterval(() => {
    if (token !== activePlayToken) {
      if (synthInterval) {
        clearInterval(synthInterval);
        synthInterval = null;
      }
      return;
    }
    playSynthesizedTone(type);
  }, intervalMs);
}

function setupAudioAnalyser(audio: HTMLAudioElement, type: AlertSoundType): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 32;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    audio.crossOrigin = 'anonymous';
    const source = ctx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(ctx.destination);

    let animId: number;
    const readData = () => {
      if (!activeAudio || activeAudio !== audio) {
        cancelAnimationFrame(animId);
        return;
      }
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const avg = sum / bufferLength;
      (window as any).__audioAmplitude = Math.min(avg / 130, 1.0);
      animId = requestAnimationFrame(readData);
    };

    animId = requestAnimationFrame(readData);

    const clearAmp = () => {
      cancelAnimationFrame(animId);
      if (typeof window !== 'undefined') {
        (window as any).__audioAmplitude = 0;
      }
    };
    audio.addEventListener('pause', clearAmp);
    audio.addEventListener('ended', clearAmp);
  } catch {
    const start = Date.now();
    let animIdFallback: number;
    const runFallback = () => {
      if (!activeAudio || activeAudio !== audio) {
        cancelAnimationFrame(animIdFallback);
        return;
      }
      const t = (Date.now() - start) / 1000;
      const speed = type === 'Bahaya' ? 6 : 2;
      (window as any).__audioAmplitude = 0.5 + 0.5 * Math.sin(t * speed);
      animIdFallback = requestAnimationFrame(runFallback);
    };
    animIdFallback = requestAnimationFrame(runFallback);
  }
}

let pendingAutoplayType: AlertSoundType | null = null;
let gestureListenerAttached = false;

function handleUserGestureResume(): void {
  unlockAlertAudio();
  const pending = pendingAutoplayType;
  if (!pending) return;
  pendingAutoplayType = null;
  // Retry starting the real MP3 loop now that a user gesture has unlocked playback
  activeAlertType = null;
  playAlertAudio(pending);
}

function attachGestureUnlockListener(): void {
  if (gestureListenerAttached || typeof window === 'undefined') return;
  gestureListenerAttached = true;
  window.addEventListener('pointerdown', handleUserGestureResume, { passive: true });
  window.addEventListener('keydown', handleUserGestureResume, { passive: true });
}

function detachGestureUnlockListener(): void {
  if (!gestureListenerAttached || typeof window === 'undefined') return;
  gestureListenerAttached = false;
  window.removeEventListener('pointerdown', handleUserGestureResume);
  window.removeEventListener('keydown', handleUserGestureResume);
}

export function playAlertAudio(type: AlertSoundType): void {
  // Keep playing smoothly without restart if the exact same alert level is already audibly active
  if (
    activeAlertType === type &&
    !pendingAutoplayType &&
    ((activeAudio && !activeAudio.paused) || synthInterval)
  ) {
    return;
  }

  stopAlertAudio();
  pendingAutoplayType = null;
  const token = activePlayToken;
  activeAlertType = type;

  const audioPaths =
    type === 'Siaga'
      ? ['/alarm_siaga.mp3', '/alarm_siaga.wav', '/siaga.mp3', '/siaga.wav', '/assets/alarm_siaga.mp3', '/assets/siaga.mp3']
      : ['/alarm_bahaya.mp3', '/alarm_bahaya.wav', '/bahaya.mp3', '/bahaya.wav', '/assets/alarm_bahaya.mp3', '/assets/bahaya.mp3'];

  const tryPlayAudio = (index: number) => {
    if (token !== activePlayToken) return;
    if (index >= audioPaths.length) {
      playSynthesizedTone(type);
      triggerSynthesizedLoop(type, token);
      return;
    }

    const audio = new Audio(audioPaths[index]);
    audio.volume = type === 'Siaga' ? 0.45 : 0.55;
    audio.loop = true;

    if (loopInterval) {
      clearInterval(loopInterval);
    }
    loopInterval = setInterval(() => {
      if (token !== activePlayToken || audio.paused || audio.ended || activeAudio !== audio) {
        if (loopInterval) {
          clearInterval(loopInterval);
          loopInterval = null;
        }
        return;
      }
      if (audio.duration && audio.currentTime >= audio.duration - 0.12) {
        audio.currentTime = 0.01;
      }
    }, 20);

    activeAudio = audio;

    audio
      .play()
      .then(() => {
        if (token !== activePlayToken) {
          audio.pause();
          return;
        }
        pendingAutoplayType = null;
        detachGestureUnlockListener();
        setupAudioAnalyser(audio, type);
        if (synthInterval) {
          clearInterval(synthInterval);
          synthInterval = null;
        }
      })
      .catch((err: any) => {
        if (token !== activePlayToken) return;
        if (loopInterval) {
          clearInterval(loopInterval);
          loopInterval = null;
        }
        if (activeAudio === audio) {
          activeAudio = null;
          // If blocked by browser autoplay policy (no click yet), wait for the first user gesture
          // (e.g., clicking Kontrol PLC / Dashboard) to immediately launch the real MP3 alarm.
          if (err?.name === 'NotAllowedError') {
            pendingAutoplayType = type;
            attachGestureUnlockListener();
            return;
          }
          tryPlayAudio(index + 1);
        }
      });
  };

  try {
    tryPlayAudio(0);
  } catch {
    playSynthesizedTone(type);
    triggerSynthesizedLoop(type, token);
  }
}
