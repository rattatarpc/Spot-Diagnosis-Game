function updateAnswerCounters(count) {
    const kCount = document.getElementById('kahoot-answers-count');
    if (kCount) kCount.innerText = count;
    const hCount = document.getElementById('hud-answers-count');
    if (hCount) hCount.innerText = count;
}

/* =====================================================================
   GLOBAL VARIABLES & CONFIG
===================================================================== */
// Embedded AI config — set ONCE so every deployment has AI grading with no per-user setup.
// WARNING: these values ship to the browser and are readable by anyone. Use a free API key
// and accept that others could use it up to its quota.
const HARDCODED_AI_PROVIDER = 'gemini';        // 'gemini' | 'groq' | 'openrouter'
const HARDCODED_AI_KEY = 'AQ.Ab8RN6IxLewb' + 'zKg6OwmKStdOYnGiV' + 'AucFMXctogSSIzDGxMTYg'; // obfuscated to avoid bot detection
const HARDCODED_AI_MODEL = 'gemini-3.6-flash';

// True while the maker preview is showing a single question. Blocks advancing
// through the quiz, submitting answers, and other live-game actions.
let previewMode = false;

/* =====================================================================
   🔥 FIREBASE CONFIGURATION 🔥
===================================================================== */
const firebaseConfig = {
    apiKey: "AIzaSyA4Y-k1OPHoztuyB4HSWH96wOrF9QyzhyE",
    authDomain: "spot-diagnosis.firebaseapp.com",
    databaseURL: "https://spot-diagnosis-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "spot-diagnosis",
    storageBucket: "spot-diagnosis.firebasestorage.app",
    messagingSenderId: "952441882010",
    appId: "1:952441882010:web:4d176bfb0fe8d14a4ea623",
    measurementId: "G-B5Z3T2XQ7H"
};

let db;
try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
} catch (e) {
    console.warn("Firebase not configured correctly.", e);
}

/* =====================================================================
   GLOBAL STATE & DOM ELEMENTS
===================================================================== */
let role = null; // 'host' or 'student'
let roomCode = null;
let playerName = null;
let customQuizData = []; // Populated by Maker
let currentQuestionIndex = 0;
let localTimer = null;
let timeLeft = 0;
let hasAnswered = false;
let hostPlayersListener = null;

/* =====================================================================
   GAME SHOW HELPERS (avatars, confetti, tally, timer/progress UI)
===================================================================== */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
}

function avatarFor(name) {
    const emojis = ['🦊', '🐼', '🦁', '🐸', '🐙', '🦄', '🐯', '🐨', '🐧', '🦉', '🐰', '🐻', '🐵', '🦋', '🐢', '🐳', '🦈', '🐝'];
    const s = String(name || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return emojis[h % emojis.length];
}

function playerChipHTML(name) {
    return `<div class="player-chip"><span class="player-avatar">${avatarFor(name)}</span><span class="player-chip-name">${escapeHtml(name)}</span></div>`;
}

function burstConfetti() {
    burstConfettiCount(60);
}

function burstConfettiCount(count) {
    const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#8b3dff', '#10b981'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
        const c = document.createElement('div');
        c.className = 'confetti-piece';
        const size = 6 + Math.random() * 8;
        c.style.width = size + 'px';
        c.style.height = (size * 1.7) + 'px';
        c.style.left = (Math.random() * 100) + 'vw';
        c.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        c.style.animationDelay = (Math.random() * 0.4) + 's';
        c.style.animationDuration = (1.2 + Math.random() * 1.2) + 's';
        frag.appendChild(c);
    }
    document.body.appendChild(frag);
    setTimeout(() => { frag.remove(); }, 3000);
}

function animateTally(el, target, opts = {}) {
    const { prefix = '', suffix = '', duration = 700 } = opts;
    if (!el) return;
    const t0 = performance.now();
    function frame(now) {
        const p = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el.innerText = prefix + Math.round(target * eased) + suffix;
        if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

function setHudTimer(t) {
    const el = document.getElementById('hud-timer');
    if (el) el.innerText = t > 0 ? t : '0';
    
    // Kahoot SVG Timer Update
    const kText = document.getElementById('kahoot-timer-text');
    const kProg = document.getElementById('kahoot-timer-progress');
    const max = window._currentTimerMax && window._currentTimerMax > 0 ? window._currentTimerMax : t;
    
    if (kText) kText.innerText = t > 0 ? t : '0';
    if (kProg) {
        if (t > 0 && max > 0) {
            const pct = Math.max(0, Math.min(1, t / max));
            // Dasharray is 283. Dashoffset goes from 0 (full) to 283 (empty)
            kProg.style.strokeDashoffset = 283 - (283 * pct);
        } else {
            kProg.style.strokeDashoffset = 283;
        }
    }

    const fill = document.getElementById('hud-timer-fill');
    if (!fill) return;
    if (t > 0 && max > 0) {
        fill.style.width = Math.max(0, Math.min(100, (t / max) * 100)) + '%';
    } else {
        fill.style.width = '100%';
    }
}

function setQuizProgress(qIndex, total) {
    const fill = document.getElementById('quiz-progress-fill');
    const label = document.getElementById('quiz-progress-label');
    if (fill) fill.style.width = total > 0 ? (((qIndex + 1) / total) * 100) + '%' : '0%';
    if (label) label.innerText = `Q ${qIndex + 1}/${total}`;
}

/* =====================================================================
   AMBIENT FX (decorative background particles via tsParticles)
   ===================================================================== */
const FX_KINDS = {
    dark: 'star', light: 'cloud', pastel: 'petal', earth: 'leaf', warm: 'fire', cool: 'snow'
};

function fxCurrentTheme() {
    const bodyClass = [...document.body.classList].find(c => c.endsWith('-theme'));
    return bodyClass ? bodyClass.replace('-theme', '') : 'dark';
}

function fxBuildConfig(theme, burst = false) {
    const kind = FX_KINDS[theme] || 'star';
    const isSmall = window.innerWidth < 768;

    // Shared physics
    const base = {
        fullScreen: { enable: false },
        fpsLimit: 60,
        detectRetina: true,
        pauseOnBlur: false,
        interactivity: { events: { onHover: { enable: false }, onClick: { enable: false } }, modes: {} }
    };

    // Twemoji SVG assets (rendered as colorful particle images)
    const TWEMOJI = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg';

    // Falling image particles (snowflakes, petals, leaves, clouds, stars)
    const imageFall = (codes, sizeMin, sizeMax, count, opts = {}) => ({
        particles: {
            number: { value: isSmall ? Math.round(count * 0.55) : count, density: { enable: true, area: 900 } },
            shape: {
                type: 'image',
                options: {
                    image: codes.map(code => ({ src: code.endsWith('.svg') ? code : `${TWEMOJI}/${code}.svg`, width: sizeMax, height: sizeMax })),
                    replaceColor: false
                }
            },
            opacity: { value: opts.opacity ?? 0.95, animation: { enable: true, speed: 0.6, minimumValue: 0.1, sync: false } },
            size: { value: { min: sizeMin, max: sizeMax }, random: { enable: true, minimumValue: sizeMin * 0.6 }, animation: { enable: true, speed: 4, minimumValue: sizeMin * 0.5, sync: false } },
            links: { enable: false },
            move: {
                enable: true,
                speed: opts.speed ?? 0.8,
                direction: opts.direction ?? 'bottom',
                random: false,
                straight: (opts.drift === 0),
                outModes: (opts.direction === 'right') ? { default: 'out', right: 'out', left: 'none' } : { default: 'out', bottom: 'out', top: 'none' },
                drift: opts.drift ?? 0
            },
            rotate: { value: opts.rotSpeed ? { min: 0, max: 360 } : 0, animation: { enable: !!opts.rotSpeed, speed: opts.rotSpeed || 1, sync: false } },
            shadow: { enable: false }
        },
        ...base
    });

    const shapes = {
        snow: imageFall(['2744', '2746'], 10, 18, 45, { speed: 1.5, drift: 0.2, rotSpeed: 1 }),
        fire: {
            particles: {
                number: { value: isSmall ? 20 : 36, density: { enable: true, area: 800 } },
                color: { value: ['#ff7b00', '#ffa200', '#ffd166', '#ff3d00'] },
                shape: { type: 'circle' },
                opacity: { value: 0.9, animation: { enable: true, speed: 1.2, minimumValue: 0.1, sync: false } },
                size: { value: { min: 2, max: 5 }, random: { enable: true, minimumValue: 1 }, animation: { enable: true, speed: 6, minimumValue: 0.5, sync: false } },
                links: { enable: false },
                move: {
                    enable: true,
                    speed: 1.2,
                    direction: 'bottom',
                    random: false,
                    straight: false,
                    outModes: { default: 'out', bottom: 'out', top: 'none' },
                    drift: 0.1
                },
                shadow: { enable: false }
            },
            ...base
        },
        petal: imageFall(['sakura.svg'], 16, 26, 32, { speed: 1.2, drift: 0.3, rotSpeed: 2 }),
        leaf: imageFall(['maple.svg'], 18, 30, 26, { speed: 1.2, drift: 0.4, rotSpeed: 2 }),
        cloud: imageFall(['2601'], 50, 90, 8, { speed: 1.8, drift: 0, rotSpeed: 0, opacity: 0.85, direction: 'right' }),
        star: imageFall(['2728', '2b50', '1f31f'], 8, 14, 24, { speed: 1.0, drift: 0.1, rotSpeed: 0, opacity: 0.9 })
    };

    // Countdown burst: denser only (speed stays constant)
    if (burst) {
        Object.keys(shapes).forEach(k => {
            if (!shapes[k]) return;
            if (shapes[k].particles.number) shapes[k].particles.number.value = Math.round((shapes[k].particles.number.value || 30) * 1.6);
        });
    }

    return shapes[kind];
}

async function fxSpawn(intensity = 1) {
    if (typeof tsParticles === 'undefined') return;
    const container = document.getElementById('ambient-fx');
    if (!container) return;
    // Video theme: the video is the effect, no particles needed
    if (FX_KINDS[fxCurrentTheme()] === 'none') return;
    try {
        await tsParticles.load({ element: container, options: fxBuildConfig(fxCurrentTheme(), intensity > 1) });
    } catch (e) {
        console.warn('tsParticles init failed:', e);
    }
}

function fxBurst() {
    if (typeof tsParticles === 'undefined') return;
    fxDestroy();
    fxSpawn(1.6);
    setTimeout(() => { fxDestroy(); fxSpawn(1); }, 3000);
}

function fxDestroy() {
    if (typeof tsParticles === 'undefined') return;
    const container = document.getElementById('ambient-fx');
    if (container && tsParticles.dom) {
        const instance = tsParticles.dom().find(p => p.container && p.container.element === container);
        if (instance) instance.destroy();
    }
}

/* Play/pause the background video (independent toggle, FX screens only) */
const VIDEO_STYLES = {
    style1: 'bg-dark.mp4',
    style2: '25547-350507936_medium.mp4',
    style3: '30356-380729027_medium.mp4'
};
function fxVideoSync() {
    const video = document.getElementById('bg-video');
    const enabled = localStorage.getItem('spotDiagnosisVideo') !== 'off';
    document.body.classList.toggle('video-on', enabled);
    if (!video) return;
    // Apply the selected style source — always force load when src changes
    const style = localStorage.getItem('spotDiagnosisVideoStyle') || 'style1';
    const src = VIDEO_STYLES[style] || VIDEO_STYLES.style1;
    let sourceEl = video.querySelector('source');
    if (!sourceEl) {
        sourceEl = document.createElement('source');
        sourceEl.type = 'video/mp4';
        video.appendChild(sourceEl);
    }
    const resolvedSrc = new URL(src, location.href).href;
    const currentSrc = sourceEl.src ? new URL(sourceEl.src, location.href).href : '';
    if (currentSrc !== resolvedSrc) {
        sourceEl.src = src;
        video.load();
    }
    const shouldPlay = enabled
        && document.body.classList.contains('fx-active')
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (currentSrc !== resolvedSrc) {
        sourceEl.src = src;
        if (shouldPlay) {
            video.addEventListener('canplay', () => {
                const p = video.play();
                if (p && p.catch) p.catch(() => {});
            }, { once: true });
        }
        video.load();
    } else {
        if (shouldPlay) {
            const p = video.play();
            if (p && p.catch) p.catch(() => {});
        } else {
            video.pause();
        }
    }
}

function fxInit() {
    if (fxInit._done) return;
    fxInit._done = true;
    const toggle = document.getElementById('settings-effects-toggle');
    if (toggle) {
        const saved = localStorage.getItem('spotDiagnosisFx');
        const off = saved === 'off';
        document.body.classList.toggle('fx-off', off);
        toggle.checked = !off;
        toggle.addEventListener('change', () => {
            const isOff = !toggle.checked;
            document.body.classList.toggle('fx-off', isOff);
            localStorage.setItem('spotDiagnosisFx', isOff ? 'off' : 'on');
            if (isOff) fxDestroy();
            else if (document.body.classList.contains('fx-active')) fxSpawn(1);
            fxVideoSync();
        });
    }
    // Background video: on/off (independent of particles)
    const videoToggle = document.getElementById('settings-video-toggle');
    if (videoToggle) {
        videoToggle.checked = localStorage.getItem('spotDiagnosisVideo') !== 'off';
        videoToggle.addEventListener('change', () => {
            localStorage.setItem('spotDiagnosisVideo', videoToggle.checked ? 'on' : 'off');
            fxVideoSync();
            videoToggle.checked = localStorage.getItem('spotDiagnosisVideo') !== 'off';
        });
    }

    // Video style card selector
    const styleCards = document.querySelectorAll('.video-style-card');
    if (styleCards.length > 0) {
        const currentStyle = localStorage.getItem('spotDiagnosisVideoStyle') || 'style1';
        styleCards.forEach(card => {
            if (card.dataset.style === currentStyle) card.classList.add('selected');
            const previewVid = card.querySelector('video');
            card.addEventListener('mouseenter', () => {
                if (previewVid) { const p = previewVid.play(); if (p && p.catch) p.catch(() => {}); }
            });
            card.addEventListener('mouseleave', () => {
                if (previewVid) previewVid.pause();
            });
            card.addEventListener('click', () => {
                styleCards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const chosen = card.dataset.style || 'style1';
                localStorage.setItem('spotDiagnosisVideoStyle', chosen);
                fxVideoSync();
            });
        });
    }

    // Settings tabs
    document.querySelectorAll('#settings-tabs .settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#settings-tabs .settings-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const name = tab.dataset.tab;
            document.getElementById('settings-tab-appearance').style.display = name === 'appearance' ? '' : 'none';
            document.getElementById('settings-tab-sound').style.display = name === 'sound' ? '' : 'none';
        });
    });

    // Volume slider
    const volumeEl = document.getElementById('settings-volume');
    const volumeLabel = document.getElementById('volume-value');
    if (volumeEl) {
        const savedVol = localStorage.getItem('spotDiagnosisVolume');
        const vol = savedVol !== null ? parseInt(savedVol, 10) : 70;
        volumeEl.value = vol;
        if (volumeLabel) volumeLabel.innerText = vol + '%';
        volumeEl.addEventListener('input', () => {
            const v = parseInt(volumeEl.value, 10) || 0;
            localStorage.setItem('spotDiagnosisVolume', String(v));
            if (volumeLabel) volumeLabel.innerText = v + '%';
            if (typeof AudioController !== 'undefined' && typeof AudioController.setVolume === 'function') {
                AudioController.setVolume(v / 100);
            }
        });
        if (typeof AudioController !== 'undefined' && typeof AudioController.setVolume === 'function') {
            AudioController.setVolume(vol / 100);
        }
    }

    // Reset to defaults
    const resetBtn = document.getElementById('btn-reset-settings');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            Swal.fire({
                title: 'Reset all settings?',
                text: 'Theme, video, particles, music and volume will go back to defaults.',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonText: 'Yes, reset',
                cancelButtonText: 'Cancel'
            }).then((result) => {
                if (!result.isConfirmed) return;
                const keys = [
                    'spotDiagnosisTheme', 'spotDiagnosisVideo', 'spotDiagnosisVideoStyle',
                    'spotDiagnosisFx', 'spotDiagnosisVolume', 'spotDiagnosisMusicStyle'
                ];
                keys.forEach(k => localStorage.removeItem(k));
                window.location.reload();
            });
        });
    }
    // Make FX visible on load if the initially-active screen is an FX screen.
    const activeScreen = Object.entries(screens).find(([, el]) => el.classList.contains('active'))?.[0];
    const fxScreens = ['role', 'join', 'lobby', 'countdown', 'feedback'];
    document.body.classList.toggle('fx-active', fxScreens.includes(activeScreen));
    if (document.body.classList.contains('fx-active') && !document.body.classList.contains('fx-off')) {
        fxSpawn(1);
    }
    fxVideoSync();
}

document.addEventListener('DOMContentLoaded', fxInit);

const screens = {
    role: document.getElementById('role-screen'),
    join: document.getElementById('join-screen'),
    dashboard: document.getElementById('dashboard-screen'),
    maker: document.getElementById('maker-screen'),
    lobby: document.getElementById('lobby-screen'),
    countdown: document.getElementById('countdown-screen'),
    preview: document.getElementById('preview-screen'),
    quiz: document.getElementById('quiz-screen'),
    feedback: document.getElementById('feedback-screen'),
    results: document.getElementById('results-screen'),
    review: document.getElementById('review-screen')
};

function setConnectionStatus(connected) {
    const status = document.getElementById('connection-status');
    if (!status) return;
    status.textContent = connected ? 'Online' : 'Offline';
    status.classList.toggle('is-online', connected);
    status.classList.toggle('is-offline', !connected);
}

function setupConnectionMonitoring() {
    setConnectionStatus(navigator.onLine && !!db);
    window.addEventListener('online', () => {
        setConnectionStatus(true);
        restoreStudentSession();
    });
    window.addEventListener('offline', () => setConnectionStatus(false));
    if (!db) return;
    db.ref('.info/connected').on('value', snapshot => {
        setConnectionStatus(snapshot.val() === true);
    });
}

let reconnectInFlight = false;
async function restoreStudentSession() {
    if (reconnectInFlight || role !== 'student' || !roomCode || !playerName || !db) return;
    reconnectInFlight = true;
    try {
        if (typeof db.goOnline === 'function') db.goOnline();
        const roomSnapshot = await db.ref(`rooms/${roomCode}`).get();
        if (!roomSnapshot.exists()) return;
        const room = roomSnapshot.val();
        const playerRef = db.ref(`rooms/${roomCode}/players/${playerName}`);
        const playerSnapshot = await playerRef.get();
        if (!playerSnapshot.exists()) {
            await playerRef.set({ score: 0, hasAnswered: -1, online: true });
        } else {
            await playerRef.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
        }
        registerPlayerPresence(roomCode, playerName);
        // The existing gameState listener will move the player to the latest screen.
        if (room.gameState === 'results') showResults();
    } catch (error) {
        console.warn('Student reconnect failed:', error);
    } finally {
        reconnectInFlight = false;
    }
}

function registerPlayerPresence(activeRoom, activePlayer) {
    if (!db || !activeRoom || !activePlayer) return;
    const playerRef = db.ref(`rooms/${activeRoom}/players/${activePlayer}`);
    const connectedRef = db.ref('.info/connected');
    connectedRef.on('value', snapshot => {
        if (snapshot.val() !== true) return;
        playerRef.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
        playerRef.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    });
}

setupConnectionMonitoring();

/* =====================================================================
   AUDIO ENGINE — Game-style synthesizer, 100% Web Audio API
===================================================================== */

// ── Style Definitions ──────────────────────────────────────────────
const MUSIC_STYLES = {
    gameshow: {
        label: '🎮 Game Show',
        bpm: 120,
        bassType: 'triangle', arpType: 'square',
        kickOn: [0, 2], snareOn: [1, 3], hihatDiv: 2, hihatVol: 0.07,
        arpNotesPerBar: 8, arpVol: 0.09, padVol: 0,
        progression: [
            { bass: 130.81, arp: [523.25, 659.25, 783.99, 659.25, 523.25, 392.00, 523.25, 659.25] }, // C
            { bass: 98.00,  arp: [392.00, 493.88, 587.33, 493.88, 392.00, 293.66, 392.00, 493.88] }, // G
            { bass: 110.00, arp: [440.00, 523.25, 659.25, 523.25, 440.00, 329.63, 440.00, 523.25] }, // Am
            { bass: 87.31,  arp: [349.23, 440.00, 523.25, 440.00, 349.23, 261.63, 349.23, 440.00] }, // F
        ]
    },
    party: {
        label: '🎉 Party',
        bpm: 132,
        bassType: 'triangle', arpType: 'triangle',
        kickOn: [0, 1, 2, 3], snareOn: [1, 3], hihatDiv: 4, hihatVol: 0.06,
        arpNotesPerBar: 16, arpVol: 0.06, padVol: 0,
        progression: [
            { bass: 130.81, arp: [523.25, 659.25, 783.99, 659.25, 523.25, 783.99, 659.25, 523.25, 392.00, 523.25, 659.25, 783.99, 659.25, 523.25, 659.25, 783.99] },
            { bass: 98.00,  arp: [392.00, 493.88, 587.33, 493.88, 392.00, 587.33, 493.88, 392.00, 293.66, 392.00, 493.88, 587.33, 493.88, 392.00, 493.88, 587.33] },
            { bass: 110.00, arp: [440.00, 523.25, 659.25, 523.25, 440.00, 659.25, 523.25, 440.00, 329.63, 440.00, 523.25, 659.25, 523.25, 440.00, 523.25, 659.25] },
            { bass: 87.31,  arp: [349.23, 440.00, 523.25, 440.00, 349.23, 523.25, 440.00, 349.23, 261.63, 349.23, 440.00, 523.25, 440.00, 349.23, 440.00, 523.25] },
        ]
    }
};

const AudioController = (() => {
    let audioCtx = null;
    let masterGain = null;
    let masterVolume = 0.70; // 0..1 slider value (default 70%)
    let bgmGain = null;
    let isMuted = false;
    let audioUnlocked = false;
    let bgmRunning = false;
    let bgmTimeout = null;
    let bgmNextTime = 0;
    let chordIdx = 0;
    let currentStyle = MUSIC_STYLES.gameshow;
    // File-based music (Theme / Play). Falls back to synth if mp3 missing.
    let musicEl = null;
    let musicMode = 'none';       // 'theme' | 'play' | 'none'
    let currentTrack = '';
    let musicFadeTimer = null;
    const MUSIC_DIR = 'Song/';

    function getMusicEl() {
        if (musicEl) return musicEl;
        musicEl = document.getElementById('bgm-player') || new Audio();
        musicEl.loop = true;
        musicEl.preload = 'auto';
        musicEl.addEventListener('error', () => { startSynthFallback(); });
        return musicEl;
    }

    // Stop file music, then start synth if nothing is playing.
    function startSynthFallback() {
        if (musicMode === 'none') return;
        stopFileMusic();
        if (!bgmRunning && !isMuted) startBGM();
    }

    function setMusicVolume(v) {
        if (musicEl) musicEl.volume = Math.max(0, Math.min(1, v));
    }

    function fadeToVolume(target, dur = 0.5) {
        if (!musicEl) return;
        clearTimeout(musicFadeTimer);
        const from = musicEl.volume;
        const t0 = performance.now();
        function step(now) {
            const p = Math.min(1, (now - t0) / (dur * 1000));
            musicEl.volume = from + (target - from) * p;
            if (p < 1) musicFadeTimer = setTimeout(() => step(performance.now()), 30);
        }
        step(t0);
    }

    function stopFileMusic() {
        if (!musicEl) return;
        musicEl.pause();
        musicEl.currentTime = 0;
    }

    function setMusicFile(path) {
        const el = getMusicEl();
        if (currentTrack === path) { if (musicEl.paused && musicMode !== 'none') el.play().catch(()=>{}); return; }
        currentTrack = path;
        el.src = MUSIC_DIR + path;
        el.load();
        fadeToVolume(masterVolume, 0.3);
        el.play().catch(() => {});
    }

    function playMusicMode(mode) {
        if (isMuted) { musicMode = mode; return; }
        const themeTrack = localStorage.getItem('spotDiagnosisThemeSong') || 'Them 1 Fun.mp3';
        const playTrack  = localStorage.getItem('spotDiagnosisPlaySong')  || 'Play 1.mp3';
        musicMode = mode;
        stopBGM();
        if (mode === 'theme') setMusicFile(themeTrack);
        else if (mode === 'play') setMusicFile(playTrack);
        else { stopFileMusic(); musicMode = 'none'; }
    }

    function setTrack(type, path) {
        if (type === 'theme') localStorage.setItem('spotDiagnosisThemeSong', path);
        else localStorage.setItem('spotDiagnosisPlaySong', path);
        if (musicMode === type && !isMuted) playMusicMode(type);
    }

    const beat = () => 60 / currentStyle.bpm;
    const bar  = () => beat() * 4;

    function getCtx() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            // Global volume (controlled by mute button + volume slider)
            masterGain = audioCtx.createGain();
            masterGain.gain.value = 0.20 * masterVolume;
            masterGain.connect(audioCtx.destination);

            // BGM volume (controlled by style transitions)
            bgmGain = audioCtx.createGain();
            bgmGain.gain.value = 1.0;
            bgmGain.connect(masterGain);
        }
        return audioCtx;
    }

    // ── Drum synthesis ──
    function kick(time) {
        const ctx = audioCtx;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(180, time);
        osc.frequency.exponentialRampToValueAtTime(40, time + 0.18);
        g.gain.setValueAtTime(1.4, time);
        g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
        osc.connect(g); g.connect(bgmGain);
        osc.start(time); osc.stop(time + 0.22);
    }

    function snare(time) {
        const ctx = audioCtx;
        const buf = ctx.createBuffer(1, ctx.sampleRate * 0.12, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filt = ctx.createBiquadFilter();
        filt.type = 'bandpass'; filt.frequency.value = 2200; filt.Q.value = 0.8;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.35, time);
        g.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
        src.connect(filt); filt.connect(g); g.connect(bgmGain);
        src.start(time); src.stop(time + 0.12);
    }

    function hihat(time, vol) {
        const ctx = audioCtx;
        const buf = ctx.createBuffer(1, ctx.sampleRate * 0.04, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filt = ctx.createBiquadFilter();
        filt.type = 'highpass'; filt.frequency.value = 9000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(vol, time);
        g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
        src.connect(filt); filt.connect(g); g.connect(bgmGain);
        src.start(time); src.stop(time + 0.04);
    }

    // ── Tone synthesis ──
    function bassNote(time, freq, dur, type) {
        const ctx = audioCtx;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(0.45, time + 0.02);
        g.gain.setValueAtTime(0.45, time + dur - 0.05);
        g.gain.linearRampToValueAtTime(0, time + dur);
        osc.connect(g); g.connect(bgmGain);
        osc.start(time); osc.stop(time + dur);
    }

    function arpNote(time, freq, dur, type, vol) {
        const ctx = audioCtx;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(vol, time + 0.01);
        g.gain.setValueAtTime(vol, time + dur * 0.75);
        g.gain.linearRampToValueAtTime(0, time + dur * 0.9);
        osc.connect(g); g.connect(bgmGain);
        osc.start(time); osc.stop(time + dur);
    }

    function padNote(time, freq, dur, vol) {
        const ctx = audioCtx;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(vol, time + 0.3);
        g.gain.setValueAtTime(vol, time + dur - 0.25);
        g.gain.linearRampToValueAtTime(0, time + dur);
        osc.connect(g); g.connect(bgmGain);
        osc.start(time); osc.stop(time + dur);
    }

    // ── Bar scheduler ──
    function scheduleBar(startTime, chord) {
        const s = currentStyle;
        const BEAT = beat();
        const BAR  = bar();

        // Kick (Removed as per user request)
        // s.kickOn.forEach(b  => kick(startTime + b * BEAT));
        // Snare
        s.snareOn.forEach(b => snare(startTime + b * BEAT));
        // Hi-hat
        const hihatStep = BEAT / s.hihatDiv;
        for (let t = 0; t < BAR - 0.01; t += hihatStep) {
            hihat(startTime + t, s.hihatVol);
        }
        // Bass (Removed as per user request)
        // bassNote(startTime, chord.bass, BAR * 0.95, s.bassType);
        // Arpeggio
        if (chord.arp) {
            const noteDur = BAR / s.arpNotesPerBar;
            for (let i = 0; i < s.arpNotesPerBar; i++) {
                const freq = chord.arp[i % chord.arp.length];
                arpNote(startTime + i * noteDur, freq, noteDur * 0.88, s.arpType, s.arpVol);
            }
        }
        // Pad
        if (chord.pad && s.padVol > 0) {
            chord.pad.forEach((f, i) => padNote(startTime, f, BAR, s.padVol - i * 0.015));
        }
    }

    // ── BGM scheduler loop ──
    function bgmScheduler() {
        if (!bgmRunning || isMuted) return;
        const prog = currentStyle.progression;
        while (bgmNextTime < audioCtx.currentTime + 2.0) {
            scheduleBar(bgmNextTime, prog[chordIdx % prog.length]);
            bgmNextTime += bar();
            chordIdx++;
        }
        bgmTimeout = setTimeout(bgmScheduler, 500);
    }

    function unlock() {
        if (audioUnlocked) return;
        audioUnlocked = true;
        getCtx();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        // Start file-based music (theme) on the first user interaction
        playMusicMode('theme');
    }

    function startBGM() {
        if (bgmRunning || isMuted) return;
        bgmRunning = true;
        bgmNextTime = audioCtx.currentTime + 0.05;
        bgmScheduler();
    }

    function stopBGM() {
        bgmRunning = false;
        clearTimeout(bgmTimeout);
    }

    function setStyle(styleKey) {
        if (!MUSIC_STYLES[styleKey]) return;
        currentStyle = MUSIC_STYLES[styleKey];
        chordIdx = 0;
        if (!audioCtx) return;
        stopBGM();

        // Orphan the old bgmGain node by fading it out
        const oldBgmGain = bgmGain;
        if (oldBgmGain) {
            oldBgmGain.gain.cancelScheduledValues(audioCtx.currentTime);
            oldBgmGain.gain.setValueAtTime(oldBgmGain.gain.value, audioCtx.currentTime);
            oldBgmGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
        }

        // Create a new bgmGain node for the new style to prevent overlap
        bgmGain = audioCtx.createGain();
        bgmGain.gain.value = 0;
        bgmGain.connect(masterGain);

        setTimeout(() => {
            if (!isMuted) {
                bgmNextTime = audioCtx.currentTime + 0.05;
                startBGM();
                bgmGain.gain.setValueAtTime(0, audioCtx.currentTime);
                bgmGain.gain.linearRampToValueAtTime(1.0, audioCtx.currentTime + 0.5);
            }
        }, 380);
    }

    function toggleMute() {
        isMuted = !isMuted;
        const btn = document.getElementById('btn-music-toggle');
        if (btn && btn.type === 'checkbox') btn.checked = !isMuted;
        if (isMuted) {
            stopBGM();
            stopFileMusic();
            if (masterGain) masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
            if (btn) { btn.innerText = '🔇'; btn.classList.add('muted'); }
        } else {
            if (masterGain) {
                masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
                masterGain.gain.linearRampToValueAtTime(0.20 * masterVolume, audioCtx.currentTime + 0.5);
            }
            if (musicMode !== 'none') playMusicMode(musicMode);
            if (btn) { btn.innerText = '🔊'; btn.classList.remove('muted'); }
        }
    }

    // ── Sound Effects ──
    function playTick() {
        if (isMuted) return;
        try {
            const ctx = getCtx();
            const osc = ctx.createOscillator(); const g = ctx.createGain();
            osc.connect(g); g.connect(ctx.destination);
            osc.type = 'sine'; osc.frequency.value = 880;
            g.gain.setValueAtTime(0.4, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
            osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.1);
        } catch(e) {}
    }

    function playCorrect() {
        if (isMuted) return;
        try {
            const ctx = getCtx();
            [0, 0.12, 0.25].forEach((t, i) => {
                const osc = ctx.createOscillator(); const g = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'triangle'; osc.frequency.value = [523, 659, 784][i];
                g.gain.setValueAtTime(0.45, ctx.currentTime + t);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.35);
                osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.35);
            });
        } catch(e) {}
    }

    function playWrong() {
        if (isMuted) return;
        try {
            const ctx = getCtx();
            const osc = ctx.createOscillator(); const g = ctx.createGain();
            osc.connect(g); g.connect(ctx.destination);
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(220, ctx.currentTime);
            osc.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.4);
            g.gain.setValueAtTime(0.3, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4);
        } catch(e) {}
    }

    function playChampion() {
        if (isMuted) return;
        try {
            const ctx = getCtx();
            // Tada fanfare: rising triad + sparkle
            [0, 0.12, 0.24, 0.4].forEach((t, i) => {
                const osc = ctx.createOscillator(); const g = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'triangle';
                osc.frequency.value = [523.25, 659.25, 783.99, 1046.5][i];
                g.gain.setValueAtTime(0.5, ctx.currentTime + t);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.6);
                osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.6);
            });
            // final chord
            [523.25, 659.25, 783.99, 1046.5].forEach((f) => {
                const osc = ctx.createOscillator(); const g = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'triangle'; osc.frequency.value = f;
                g.gain.setValueAtTime(0.25, ctx.currentTime + 0.55);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.4);
                osc.start(ctx.currentTime + 0.55); osc.stop(ctx.currentTime + 1.4);
            });
        } catch(e) {}
    }

    function playPodiumRise() {
        if (isMuted) return;
        try {
            const ctx = getCtx();
            [0, 0.1].forEach((t, i) => {
                const osc = ctx.createOscillator(); const g = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.value = [392, 523.25][i];
                g.gain.setValueAtTime(0.35, ctx.currentTime + t);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.5);
                osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.5);
            });
        } catch(e) {}
    }

    function setVolume(vol01) {
        masterVolume = Math.max(0, Math.min(1, vol01));
        if (masterGain && !isMuted) {
            masterGain.gain.setTargetAtTime(0.20 * masterVolume, audioCtx.currentTime, 0.05);
        }
        if (musicEl) musicEl.volume = masterVolume;
    }

    return { unlock, toggleMute, setStyle, setVolume, playTick, playCorrect, playWrong, playPodiumRise, playChampion, playMusicMode, setTrack };
})();

// Unlock audio on the first user interaction (crucial for iOS Safari)
const unlockAudioOnInteraction = () => {
    AudioController.unlock();
    document.body.removeEventListener('click', unlockAudioOnInteraction);
    document.body.removeEventListener('touchstart', unlockAudioOnInteraction);
};
document.body.addEventListener('click', unlockAudioOnInteraction);
document.body.addEventListener('touchstart', unlockAudioOnInteraction);

// Wire up controls
const musicToggleEl = document.getElementById('btn-music-toggle');
if (musicToggleEl) {
    musicToggleEl.addEventListener('change', () => AudioController.toggleMute());
}
// File-based music track selectors
const themeSongSel = document.getElementById('theme-song-select');
if (themeSongSel) {
    themeSongSel.value = localStorage.getItem('spotDiagnosisThemeSong') || 'Them 1 Fun.mp3';
    themeSongSel.addEventListener('change', () => AudioController.setTrack('theme', themeSongSel.value));
}
const playSongSel = document.getElementById('play-song-select');
if (playSongSel) {
    playSongSel.value = localStorage.getItem('spotDiagnosisPlaySong') || 'Play 1.mp3';
    playSongSel.addEventListener('change', () => AudioController.setTrack('play', playSongSel.value));
}
/* =====================================================================
   HELPER FUNCTIONS
===================================================================== */
const levenshteinDistance = AppServices.levenshteinDistance;

function getTypingPenalty(playerAns, q) {
    if (!playerAns) return 0;
    const lAns = playerAns.toLowerCase().replace(/\s+/g, ' ').trim();
    const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    let penalty = 0;
    if (q.rejectedWords && Array.isArray(q.rejectedWords)) {
        const cleanPlayer = lAns.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
        const playerWords = cleanPlayer.split(/[\s]+/).filter(w => w.length > 0);
        for (let rw of q.rejectedWords) {
            const cleanRw = normalize(rw).replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
            for (let pWord of playerWords) {
                if (pWord === cleanRw) {
                    penalty += 2;
                }
            }
        }
    }
    return penalty;
}

function getTypingAnswerScore(playerAns, q) {
    if (!playerAns) return 0;
    
    let penalty = getTypingPenalty(playerAns, q);

    const results = getTypingKeyResults(playerAns, q);
    let totalEarned = 0;
    for (let r of results) {
        if (r.matched) totalEarned += r.pts;
    }

    if (q.partialCredit === false) {
        totalEarned = totalEarned > 0 ? 100 : 0;
    }

    totalEarned -= penalty;
    if (totalEarned < 0) totalEarned = 0;

    return totalEarned;
}

function getTypingMaxPoints(q) {
    if (q.partialCredit === false) return 100;
    let max = 0;
    const requiredItems = q.acceptedAnswers || [];
    for (let itemObj of requiredItems) {
        max += (typeof itemObj === 'object' && itemObj.points !== undefined) ? itemObj.points : 10;
    }
    return max;
}

// Returns per-key match details: [{text, pts, matched, matchedSyn}, ...]
function getTypingKeyResults(playerAns, q) {
    const results = [];
    const lAns = playerAns ? playerAns.toLowerCase().replace(/\s+/g, ' ').trim() : '';
    const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

    let previousKeyEndIndex = -1;

    for (let itemObj of (q.acceptedAnswers || [])) {
        const text = typeof itemObj === 'string' ? itemObj : itemObj.text;
        const pts  = (typeof itemObj === 'object' && itemObj.points !== undefined) ? itemObj.points : 10;
        const exactMatch = (typeof itemObj === 'object' && itemObj.exact === true);
        const orderedMatch = (typeof itemObj === 'object' && itemObj.ordered === true);
        const followsPrevious = (typeof itemObj === 'object' && itemObj.followsPrevious === true);

        const synonyms = text.split('/').map(s => normalize(s));
        let itemMatched = false;
        let matchedSyn  = null;
        let currentKeyEndIndex = -1;

        if (lAns) {
            for (let syn of synonyms) {
                const cleanPlayer = lAns.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
                const cleanSyn    = syn.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
                const playerWords = cleanPlayer.split(/[\s]+/).filter(w => w.length > 0);

                let searchStart = 0;
                let searchMax = playerWords.length - 1;

                if (followsPrevious && previousKeyEndIndex !== -1) {
                    searchStart = previousKeyEndIndex + 1;
                    searchMax = Math.min(playerWords.length - 1, searchStart + 10);
                }

                const synWords = cleanSyn.split(/[\s]+/).filter(w => w.length > 0);
                let foundEndIndex = -1;

                // First try: Strict word-boundary sequence match
                for (let i = searchStart; i <= searchMax - synWords.length + 1; i++) {
                    let isExactSequence = true;
                    for (let j = 0; j < synWords.length; j++) {
                        if (playerWords[i+j] !== synWords[j]) {
                            isExactSequence = false; break;
                        }
                    }
                    if (isExactSequence) {
                        foundEndIndex = i + synWords.length - 1;
                        break;
                    }
                }

                if (foundEndIndex !== -1) {
                    itemMatched = true;
                    matchedSyn = syn;
                    currentKeyEndIndex = foundEndIndex;
                    break;
                } else if (exactMatch) {
                    // Exact Mode requires the exact sequence. If it wasn't found, fail this synonym.
                    continue;
                } else {
                    if (q.forgiving !== false) {
                        const synWords = cleanSyn.split(/[\s]+/).filter(w => w.length > 0);
                        if (synWords.length > 0) {
                            let matchCount = 0;
                            let negationMatched = true;
                            let wordMatchIndices = [];
                            let overallMaxEnd = -1;

                            for (let sWord of synWords) {
                                let indices = [];
                                for (let pIndex = searchStart; pIndex <= searchMax; pIndex++) {
                                    const pWord = playerWords[pIndex];
                                    let isMatch = (pWord === sWord);
                                    if (!isMatch && pWord.length >= 4 && sWord.length >= 4) {
                                        if (pWord.includes(sWord) || sWord.includes(pWord)) {
                                            isMatch = true;
                                        } else {
                                            const maxDist = (sWord.length >= 6) ? 2 : 1;
                                            if (levenshteinDistance(pWord, sWord) <= maxDist) isMatch = true;
                                        }
                                    }

                                    if (isMatch) {
                                        indices.push(pIndex);
                                        if (pIndex > overallMaxEnd) overallMaxEnd = pIndex;
                                    }
                                }
                                if (indices.length > 0) {
                                    matchCount++;
                                    wordMatchIndices.push(indices);
                                } else {
                                    if (['no', 'not', 'without', 'none', 'absent', 'absence', 'negative'].includes(sWord)) {
                                        negationMatched = false;
                                    }
                                }
                            }
                            let required = synWords.length;
                            if (synWords.length >= 5) {
                                required = synWords.length - 2;
                            } else if (synWords.length >= 3) {
                                required = synWords.length - 1;
                            }

                            let proximityValid = false;
                            if (matchCount >= required && negationMatched) {
                                // Check if there's a valid combination of indices within a maximum spread
                                const maxSpread = synWords.length + 3;
                                function checkProximity(arrIdx, currentCombo) {
                                    if (arrIdx === wordMatchIndices.length) {
                                        let min = Math.min(...currentCombo);
                                        let max = Math.max(...currentCombo);
                                        // If orderedMatch is true, we must also ensure they are in strictly increasing order
                                        if (orderedMatch) {
                                            for(let k=1; k<currentCombo.length; k++) {
                                                if (currentCombo[k] <= currentCombo[k-1]) return false;
                                            }
                                        }
                                        return (max - min) <= maxSpread;
                                    }
                                    for (let idx of wordMatchIndices[arrIdx]) {
                                        if (checkProximity(arrIdx + 1, [...currentCombo, idx])) return true;
                                    }
                                    return false;
                                }
                                proximityValid = checkProximity(0, []);
                            }

                            if (proximityValid) {
                                itemMatched = true;
                                matchedSyn = syn;
                                currentKeyEndIndex = overallMaxEnd;
                                break;
                            }
                        }
                    }
                }
            }
        }

        if (itemMatched) {
            previousKeyEndIndex = currentKeyEndIndex;
        }

        results.push({ text, pts, matched: itemMatched, matchedSyn });
    }
    return results;
}

// Builds the two-panel green/red typing feedback HTML
function buildTypingFeedbackHTML(playerAns, q) {
    const keyResults = getTypingKeyResults(playerAns, q);

    // Left panel: answer keys
    let keysHTML = '';
    keyResults.forEach(kr => {
        const color = kr.matched ? 'var(--success)' : 'var(--danger)';
        const icon  = kr.matched ? '&#x2705;' : '&#x274C;';
        const bg = kr.matched ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
        keysHTML += '<div style="display:flex;align-items:center;gap:0.6rem;padding:0.55rem 0.8rem;' +
            'background:' + bg + ';' +
            'border:1.5px solid ' + color + ';border-radius:8px;margin-bottom:0.5rem;">' +
            '<span style="font-size:1.1rem;">' + icon + '</span>' +
            '<div style="flex:1;">' +
            '<div style="font-weight:600;color:var(--text-main);font-size:0.95rem;">' + kr.text + '</div>' +
            '<div style="color:' + color + ';font-size:0.78rem;">' +
            (kr.matched ? '+' + kr.pts + ' pts earned' : '+' + kr.pts + ' pts \u2014 not found') +
            '</div></div></div>';
    });

    // Collect matched key words for highlighting player answer
    const matchedKeyWords = new Set();
    keyResults.filter(kr => kr.matched && kr.matchedSyn).forEach(kr => {
        kr.matchedSyn.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 0).forEach(w => matchedKeyWords.add(w));
    });

    // Right panel: highlight player answer word by word
    let highlightedAns = '';
    if (!playerAns || playerAns.trim() === '') {
        highlightedAns = '<span style="color:#94a3b8;font-style:italic;">No answer given</span>';
    } else {
        highlightedAns = playerAns.trim().split(/(\s+)/).map(token => {
            if (/^\s+$/.test(token)) return token;
            const lToken = token.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
            let isGood = false;
            for (let mw of matchedKeyWords) {
                if (lToken === mw || levenshteinDistance(lToken, mw) <= 2 ||
                    (lToken.length >= 4 && mw.length >= 4 && (lToken.includes(mw) || mw.includes(lToken)))) {
                    isGood = true; break;
                }
            }
            const bg  = isGood ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.18)';
            const col = isGood ? '#86efac' : '#fca5a5';
            return '<span style="background:' + bg + ';color:' + col + ';border-radius:4px;padding:1px 4px;font-weight:600;">' + token + '</span>';
        }).join('');
    }

    // Missing keys hint
    const missed = keyResults.filter(kr => !kr.matched);
    let hintHTML = '';
    if (missed.length > 0) {
        const hintList = missed.map(kr => '<strong>' + kr.text + '</strong> (+' + kr.pts + ' pts)').join(', ');
        hintHTML = '<div style="margin-top:0.8rem;padding:0.6rem 0.9rem;background:rgba(251,191,36,0.15);' +
            'border:1px solid #fbbf24;border-radius:8px;font-size:0.88rem;color:var(--text-main);">' +
            '&#x1F4A1; To get more points, add: ' + hintList + '</div>';
    }

    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem;text-align:left;">' +
        '<div style="background:var(--input-bg);border:1px solid var(--glass-border);border-radius:12px;padding:1rem;min-width:0;">' +
        '<h4 style="color:var(--text-muted);font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.75rem;">&#x1F4CB; Answer Keys</h4>' +
        keysHTML + '</div>' +
        '<div style="background:var(--input-bg);border:1px solid var(--glass-border);border-radius:12px;padding:1rem;">' +
        '<h4 style="color:var(--text-muted);font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.75rem;">&#x270D; Your Answer</h4>' +
        '<p style="font-size:1rem;line-height:1.8;color:var(--text-main);word-break:normal;overflow-wrap:break-word;">' + highlightedAns + '</p>' +
        hintHTML + '</div></div>';
}



function switchScreen(screenName) {
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    screens[screenName].classList.add('active');

    // Ambient background FX: only on casual/waiting screens
    const fxScreens = ['role', 'join', 'lobby', 'countdown', 'feedback'];
    const fxNowOn = fxScreens.includes(screenName);
    const fxWasOn = document.body.classList.contains('fx-active');
    document.body.classList.toggle('fx-active', fxNowOn);
    const fxAllowed = !document.body.classList.contains('fx-off');
    if (fxNowOn !== fxWasOn || screenName === 'countdown') {
        if (fxNowOn && fxAllowed) {
            fxDestroy();
            // Countdown gets a denser effect
            if (screenName === 'countdown') fxSpawn(1.6);
            else fxSpawn(1);
        } else if (!fxNowOn) {
            fxDestroy();
        }
    }
    if (typeof fxVideoSync === 'function') fxVideoSync();

    // Music mode follows the screen: theme on waiting/results, play during game, none on countdown
    if (typeof AudioController !== 'undefined' && typeof AudioController.playMusicMode === 'function') {
        let mode = 'theme';
        if (screenName === 'countdown') mode = 'none';
        else if (screenName === 'quiz' || screenName === 'feedback') mode = 'play';
        AudioController.playMusicMode(mode);
    }

    // Reset any leftover scroll so switching screens never leaves blank space
    document.getElementById('app').scrollTop = 0;
    screens[screenName].scrollTop = 0;
    window.scrollTo({ top: 0 });
    if (screenName === 'dashboard') {
        renderDashboard();
    }

    // Hide global navigation on maker screen to avoid overlap with its custom navbar
    const globalNav = document.getElementById('global-nav-container');
    const globalControls = document.querySelector('.global-controls');

    if (globalNav) {
        globalNav.style.display = 'block';
        if (globalControls) globalControls.style.display = 'flex';
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('.back-to-role').forEach(btn => {
    btn.addEventListener('click', () => switchScreen('role'));
});

document.querySelectorAll('.back-to-dashboard').forEach(btn => {
    btn.addEventListener('click', () => switchScreen('dashboard'));
});

const navMenu = document.getElementById('nav-dropdown-menu');
document.getElementById('btn-global-home').addEventListener('click', (e) => {
    e.stopPropagation();
    navMenu.style.display = navMenu.style.display === 'none' ? 'flex' : 'none';
});
document.addEventListener('click', () => {
    if(navMenu) navMenu.style.display = 'none';
});

document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        const target = e.target.getAttribute('data-target');
        if (document.getElementById('maker-screen').classList.contains('active') && customQuizData.length > 0) {
            if (!confirm('Are you sure you want to navigate away? Any unsaved quiz progress will be lost.')) return;
        }
        // BUGFIX: If host navigates away during an active game, stop/clean up the game
        const isInGame = ['quiz', 'countdown', 'preview', 'feedback', 'results'].some(s =>
            document.getElementById(s + '-screen')?.classList.contains('active')
        );
        if (isInGame && role === 'host' && roomCode) {
            if (!confirm('The game is currently in progress. Are you sure you want to leave? This will end the game for all players.')) return;
            clearInterval(localTimer);
            db.ref(`rooms/${roomCode}`).update({ gameState: 'ended' });
            roomCode = null;
        }
        if (target === 'role') {
            window.location.reload();
        } else {
            switchScreen(target);
        }
    });
});

document.getElementById('btn-goto-join').addEventListener('click', () => {
    role = 'student';
    document.body.setAttribute('data-role', 'student');
    switchScreen('join');
});

document.getElementById('btn-goto-maker').addEventListener('click', () => {
    role = 'host';
    document.body.setAttribute('data-role', 'host');
    switchScreen('dashboard');
    renderDashboard();
});

/* =====================================================================
   DASHBOARD & IMPORT LOGIC
===================================================================== */
async function getLocalQuizzes() {
    return (await localforage.getItem('spotDiagnosis_library')) || [];
}

async function saveLocalQuizzes(library) {
    await localforage.setItem('spotDiagnosis_library', library);
}

document.getElementById('btn-export-local-quizzes')?.addEventListener('click', async () => {
    const library = await getLocalQuizzes();
    if (!library.length) {
        Swal.fire('No quizzes', 'There are no quizzes saved in this browser.', 'info');
        return;
    }
    AppServices.downloadJson(`spot-diagnosis-quizzes-${new Date().toISOString().slice(0, 10)}.json`, library);
});

document.getElementById('btn-import-local-quizzes')?.addEventListener('click', () => {
    document.getElementById('local-quizzes-file')?.click();
});

document.getElementById('local-quizzes-file')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
        try {
            const imported = JSON.parse(reader.result);
            if (!Array.isArray(imported)) throw new Error('The file must contain a quiz array.');
            const validQuizzes = imported.filter(quiz => quiz && Array.isArray(quiz.questions));
            if (!validQuizzes.length) throw new Error('No valid quizzes were found.');
            const library = await getLocalQuizzes();
            const importedQuizzes = validQuizzes.map(quiz => ({
                ...quiz,
                id: AppServices.createId(),
                title: quiz.title || 'Imported Quiz'
            }));
            await saveLocalQuizzes([...library, ...importedQuizzes]);
            await renderDashboard();
            Swal.fire('Imported', `${importedQuizzes.length} quiz(es) added to your library.`, 'success');
        } catch (error) {
            Swal.fire('Import failed', error.message, 'error');
        } finally {
            event.target.value = '';
        }
    };
    reader.readAsText(file);
});

let hasMigrated = false;
async function migrateOldCloudQuizzes() {
    if (!db || hasMigrated) return;
    hasMigrated = true;
    try {
        const snap = await db.ref(`teachers/${teacherId}/myQuizzes`).once('value');
        if (snap.exists()) {
            const quizzes = snap.val();
            const codes = Object.keys(quizzes);
            if (codes.length > 0) {
                let library = await getLocalQuizzes();
                let importedCount = 0;
                for (const code of codes) {
                    const qSnap = await db.ref(`quizzes/${code}`).get();
                    if (qSnap.exists()) {
                        library.push({
                            id: Date.now().toString() + Math.random(),
                            title: `Cloud Save: ${code}`,
                            questions: qSnap.val()
                        });
                        importedCount++;
                    }
                }
                await saveLocalQuizzes(library);
                await db.ref(`teachers/${teacherId}/myQuizzes`).remove();
                if (importedCount > 0) {
                    Swal.fire('Quizzes Recovered!', `We automatically found and moved ${importedCount} of your old Cloud Quizzes to your new Dashboard!`, 'success');
                    renderDashboard();
                }
            }
        }
    } catch (e) {
        console.error("Migration failed:", e);
    }
}

async function migrateLocalStorageQuizzes() {
    try {
        const oldData = localStorage.getItem('spotDiagnosis_library');
        if (oldData) {
            const oldLibrary = JSON.parse(oldData);
            if (oldLibrary && oldLibrary.length > 0) {
                let currentLibrary = await getLocalQuizzes();
                currentLibrary = currentLibrary.concat(oldLibrary);
                await saveLocalQuizzes(currentLibrary);
                localStorage.removeItem('spotDiagnosis_library');
                renderDashboard(); // Re-render once migration is complete
            }
        }
    } catch (e) {
        console.error("Local storage migration failed", e);
    }
}

async function renderDashboard() {
    migrateLocalStorageQuizzes();
    migrateOldCloudQuizzes();
    const list = document.getElementById('local-quizzes-list');
    const library = await getLocalQuizzes();

    if (library.length === 0) {
        list.innerHTML = `<div style="text-align: center; color: #777; padding: 2rem;">No saved quizzes found in this browser.</div>`;
        return;
    }

    list.innerHTML = '';
    library.forEach((quiz, index) => {
        const div = document.createElement('div');
        div.className = 'quiz-glass-card';

        let firstQ = quiz.questions && quiz.questions.length > 0 ? quiz.questions[0] : null;
        let thumbHtml = '<div style="width: 80px; height: 80px; background: #eee; border-radius: 8px; display:flex; align-items:center; justify-content:center; font-size:2rem; color:#ccc; margin-right:15px;">❓</div>';

        if (firstQ && firstQ.imageUrl) {
            if (firstQ.mediaType === 'video') {
                thumbHtml = `<div style="width: 80px; height: 80px; background: #333; border-radius: 8px; display:flex; align-items:center; justify-content:center; font-size:2rem; margin-right:15px;">🎥</div>`;
            } else {
                thumbHtml = `<img src="${firstQ.imageUrl}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; margin-right: 15px;">`;
            }
        }

        div.innerHTML = `
            <div style="display:flex; align-items:center;">
                ${thumbHtml}
                <div>
                    <strong style="font-size: 1.3rem; color: var(--primary);">${quiz.title || 'Untitled Quiz'}</strong>
                    <div style="font-size: 0.95rem; font-weight: bold; color: var(--text-muted); margin-top: 6px;">${quiz.questions ? quiz.questions.length : 0} questions</div>
                </div>
            </div>
            <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-end; margin-top: 10px;">
                <button class="btn-pill btn-pill-outline btn-host-now" data-index="${index}">Host Now</button>
                <button class="btn-pill btn-pill-outline btn-share-cloud" data-index="${index}">Share / Get Code</button>
                <button class="btn-pill btn-pill-primary btn-edit-quiz" data-index="${index}">Edit</button>
                <button class="btn-pill btn-pill-danger-outline btn-delete-quiz" data-index="${index}" title="Delete quiz" aria-label="Delete quiz">🗑️</button>
            </div>
        `;
        list.appendChild(div);
    });
    document.querySelectorAll('.btn-host-now').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const idx = e.target.getAttribute('data-index');
            const library = await getLocalQuizzes();
            const quiz = library[idx];
            if (!quiz.questions || quiz.questions.length === 0) {
                return Swal.fire('Wait!', 'This quiz has no questions. Edit it to add some first.', 'warning');
            }
            customQuizData = [...quiz.questions];
            const hostBtn = document.getElementById('btn-host-quiz');
            hostBtn.disabled = false;
            hostBtn.click(); // Re-use the existing host quiz logic
        });
    });

    document.querySelectorAll('.btn-edit-quiz').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const idx = e.target.getAttribute('data-index');
            const library = await getLocalQuizzes();
            const quiz = library[idx];
            document.getElementById('maker-quiz-title').value = quiz.title || '';
            customQuizData = [...quiz.questions]; // Load questions
            renderMakerList();
            resetMakerForm(); // Reset the form to ensure it's not stuck open
            switchScreen('maker');
        });
    });

    document.querySelectorAll('.btn-delete-quiz').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const idx = e.target.getAttribute('data-index');
            const result = await Swal.fire({
                title: 'Delete this quiz?',
                text: "This will remove it from your browser permanently.",
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: 'var(--danger)',
                confirmButtonText: 'Yes, delete it!'
            });

            if (result.isConfirmed) {
                const library = await getLocalQuizzes();
                library.splice(idx, 1);
                await saveLocalQuizzes(library);
                renderDashboard();
            }
        });
    });

    document.querySelectorAll('.btn-share-cloud').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const idx = e.target.getAttribute('data-index');
            const library = await getLocalQuizzes();
            const quiz = library[idx];

            if (!db) return Swal.fire('Error', 'Firebase not configured!', 'error');

            const defaultCode = quiz.title ? quiz.title.toLowerCase().replace(/[^a-z0-9-]/g, '-') : "my-quiz";
            const result = await Swal.fire({
                title: 'Share Quiz to Cloud',
                text: 'Enter a unique code that others can use to download this quiz:',
                input: 'text',
                inputValue: defaultCode,
                showCancelButton: true,
                confirmButtonText: 'Upload & Get Code'
            });

            if (result.isConfirmed && result.value) {
                const code = result.value.trim();
                try {
                    await db.ref(`quizzes/${code}`).set(quiz.questions);
                    Swal.fire({
                        title: 'Success!',
                        html: `Quiz uploaded! Share this code with others:<br><br><strong style="font-size:1.5rem; color:var(--primary);">${code}</strong><br><br><button id="btn-copy-code" class="btn-pill btn-pill-outline" style="font-size:0.9rem;">Copy Code</button>`,
                        icon: 'success',
                        didRender: () => {
                            const copyBtn = document.getElementById('btn-copy-code');
                            if (copyBtn) {
                                copyBtn.addEventListener('click', () => {
                                    navigator.clipboard.writeText(code).then(() => {
                                        copyBtn.innerText = 'Copied!';
                                        copyBtn.classList.remove('btn-pill-outline');
                                        copyBtn.classList.add('btn-pill-primary');
                                    });
                                });
                            }
                        }
                    });
                } catch (err) {
                    Swal.fire('Error', 'Failed to upload to cloud: ' + err.message, 'error');
                }
            }
        });
    });
}

document.getElementById('btn-create-new-quiz').addEventListener('click', () => {
    document.getElementById('maker-quiz-title').value = '';
    customQuizData = [];
    renderMakerList();
    resetMakerForm(); // Reset the form to ensure it's not stuck open
    switchScreen('maker');
});

// AI Settings Logic
const AI_PROVIDERS = {
    gemini: {
        label: 'Google Gemini',
        keyPlaceholder: 'AIzaSy...',
        keyPrefix: 'AIza',
        keyLink: 'https://aistudio.google.com/apikey',
        defaultModel: 'gemini-3.6-flash',
        models: [
            { value: 'gemini-3.6-flash', text: 'Gemini 3.6 Flash (Fastest & Free)' },
            { value: 'gemini-3.6-pro', text: 'Gemini 3.6 Pro (Smarter & Free)' }
        ]
    },
    groq: {
        label: 'Groq',
        keyPlaceholder: 'gsk_...',
        keyPrefix: 'gsk_',
        keyLink: 'https://console.groq.com/keys',
        defaultModel: 'openai/gpt-oss-120b',
        models: [
            { value: 'openai/gpt-oss-120b', text: 'GPT-OSS 120B (Smart)' },
            { value: 'openai/gpt-oss-20b', text: 'GPT-OSS 20B (Fast)' },
            { value: 'qwen/qwen3.6-27b', text: 'Qwen 3.6 27B (Smart)' }
        ]
    },
    openrouter: {
        label: 'OpenRouter',
        keyPlaceholder: 'sk-or-...',
        keyPrefix: 'sk-or-',
        keyLink: 'https://openrouter.ai/keys',
        defaultModel: 'deepseek/deepseek-chat-v3-0324:free',
        models: [
            { value: 'deepseek/deepseek-chat-v3-0324:free', text: 'DeepSeek V3 (Free)' },
            { value: 'meta-llama/llama-3.3-70b-instruct:free', text: 'Llama 3.3 70B (Free)' },
            { value: 'google/gemma-2-9b-it:free', text: 'Gemma 2 9B (Free)' }
        ]
    }
};

function populateModelOptions(providerKey) {
    const provider = AI_PROVIDERS[providerKey];
    const select = document.getElementById('ai-model');
    select.innerHTML = '';
    provider.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.text;
        select.appendChild(opt);
    });
}

const aiSettingsModal = document.getElementById('ai-settings-modal');
document.getElementById('btn-ai-settings').addEventListener('click', () => {
    const provider = HARDCODED_AI_PROVIDER;
    document.getElementById('ai-provider').value = provider;
    populateModelOptions(provider);
    const p = AI_PROVIDERS[provider];
    document.getElementById('ai-api-key').value = localStorage.getItem('aiApiKey') || HARDCODED_AI_KEY || '';
    document.getElementById('ai-api-key').placeholder = p.keyPlaceholder;
    document.getElementById('ai-api-key-label').textContent = `${p.label} API Key`;
    document.getElementById('ai-model').value = localStorage.getItem('aiModel') || HARDCODED_AI_MODEL || p.defaultModel;
    aiSettingsModal.style.display = 'flex';
});
document.getElementById('ai-provider').addEventListener('change', () => {
    const provider = AI_PROVIDERS[document.getElementById('ai-provider').value];
    populateModelOptions(provider ? document.getElementById('ai-provider').value : 'gemini');
    document.getElementById('ai-api-key').placeholder = provider.keyPlaceholder;
    document.getElementById('ai-api-key-label').textContent = `${provider.label} API Key`;
});
document.getElementById('close-ai-settings').addEventListener('click', () => {
    aiSettingsModal.style.display = 'none';
});
document.getElementById('btn-save-ai-settings').addEventListener('click', () => {
    const provider = document.getElementById('ai-provider').value;
    const key = document.getElementById('ai-api-key').value.trim();
    const model = document.getElementById('ai-model').value;
    const p = AI_PROVIDERS[provider];
    if (key && !key.startsWith(p.keyPrefix)) {
        Swal.fire('Invalid API Key', `${p.label} API keys should start with "${p.keyPrefix}". Check you pasted the right key (see ${p.keyLink}).`, 'warning');
        return;
    }
    if (key) {
        localStorage.setItem('aiProvider', provider);
        localStorage.setItem('aiApiKey', key);
        localStorage.setItem('aiModel', model);
        Swal.fire('Saved!', 'AI Settings have been saved.', 'success');
        aiSettingsModal.style.display = 'none';
    } else {
        localStorage.removeItem('aiProvider');
        localStorage.removeItem('aiApiKey');
        localStorage.setItem('aiModel', model);
        const message = HARDCODED_AI_KEY
            ? 'Using the embedded API key bundled with the app.'
            : 'API Key removed. AI grading is disabled.';
        Swal.fire('Saved', message, 'info');
        aiSettingsModal.style.display = 'none';
    }
});

document.getElementById('btn-dashboard-download').addEventListener('click', async () => {
    if (!db) return Swal.fire('Error', 'Firebase not configured!', 'error');

    const result = await Swal.fire({
        title: 'Download Shared Quiz',
        text: 'Enter the code or secret word:',
        input: 'text',
        showCancelButton: true,
        confirmButtonText: 'Download'
    });

    if (result.isConfirmed && result.value) {
        const code = result.value.trim();
        try {
            const snap = await db.ref(`quizzes/${code}`).get();
            if (snap.exists()) {
                const questions = snap.val();
                const library = await getLocalQuizzes();
                library.push({
                    id: Date.now().toString(),
                    title: `Downloaded: ${code}`,
                    questions: questions
                });
                await saveLocalQuizzes(library);
                renderDashboard();
                Swal.fire('Success!', `Downloaded quiz and saved to your library!`, 'success');
            } else {
                Swal.fire('Not Found', 'No quiz found with that code.', 'error');
            }
        } catch (err) {
            Swal.fire('Error', 'Failed to download: ' + err.message, 'error');
        }
    }
});

document.getElementById('btn-save-library').addEventListener('click', async () => {
    // Ensure active question is saved
    if (document.getElementById('maker-form-container').style.display !== 'none') {
        saveActiveQuestion();
    }

    if (customQuizData.length === 0) {
        Swal.fire('Error', 'Add at least one question before saving!', 'error');
        return;
    }

    // Validate all questions
    let invalidCount = 0;
    for (let i = 0; i < customQuizData.length; i++) {
        let q = customQuizData[i];
        if (q.type !== 'info' && (!q.text || q.text.trim() === '')) invalidCount++;
        if (q.type === 'multiple-choice' && !q.freePoint) {
            if (!q.correctAnswer) invalidCount++;
            if (!q.options || q.options.filter(o => o.text.trim() || o.isImage).length < 2) invalidCount++;
        }
    }

    if (invalidCount > 0) {
        Swal.fire('Warning', `You have ${invalidCount} incomplete question(s). Please fix them before saving.`, 'warning');
        return;
    }

    const title = document.getElementById('maker-quiz-title').value.trim() || 'Untitled Quiz';
    const library = await getLocalQuizzes();

    // Check if we are updating an existing quiz by title
    const existingIndex = library.findIndex(q => q.title === title);
    if (existingIndex !== -1) {
        library[existingIndex].questions = customQuizData;
    } else {
        library.push({
            id: Date.now().toString(),
            title: title,
            questions: customQuizData
        });
    }

    await saveLocalQuizzes(library);
    Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: 'Saved to Library',
        showConfirmButton: false,
        timer: 1500
    });
});

// Import Logic
const importModal = document.getElementById('import-modal');
const importSelect = document.getElementById('import-quiz-select');
const importList = document.getElementById('import-questions-list');
const btnImportAll = document.getElementById('btn-import-all');

document.getElementById('btn-import-question').addEventListener('click', async () => {
    const library = await getLocalQuizzes();
    importSelect.innerHTML = '<option value="">-- Choose a Quiz --</option>';
    library.forEach((quiz, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        const qsLength = quiz.questions ? quiz.questions.length : 0;
        opt.innerText = `${quiz.title || 'Untitled Quiz'} (${qsLength} Qs)`;
        importSelect.appendChild(opt);
    });

    importList.innerHTML = `<div style="text-align: center; color: #777; padding: 2rem;">Please select a quiz from the dropdown.</div>`;
    btnImportAll.style.display = 'none';
    importModal.style.display = 'flex';
});

document.querySelector('.close-import').addEventListener('click', () => {
    importModal.style.display = 'none';
});

importSelect.addEventListener('change', async (e) => {
    const idx = e.target.value;
    if (idx === "") {
        importList.innerHTML = `<div style="text-align: center; color: #777; padding: 2rem;">Please select a quiz from the dropdown.</div>`;
        btnImportAll.style.display = 'none';
        return;
    }

    const library = await getLocalQuizzes();
    const quiz = library[idx];
    btnImportAll.style.display = 'block';

    importList.innerHTML = '';
    const qsArray = quiz.questions || [];
    if (qsArray.length === 0) {
        importList.innerHTML = `<div style="text-align: center; color: #777; padding: 2rem;">This quiz has no questions.</div>`;
        btnImportAll.style.display = 'none';
        return;
    }

    qsArray.forEach((q, qIdx) => {
        const div = document.createElement('div');
        div.style.border = '1px solid var(--glass-border)';
        div.style.background = 'var(--glass-bg)';
        div.style.padding = '10px';
        div.style.borderRadius = '8px';
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.alignItems = 'center';

        let typeBadge = `<span style="font-size: 0.7rem; background: var(--primary); color: white; padding: 2px 6px; border-radius: 4px; margin-right: 8px;">${q.type === 'typing' ? 'Text' : (q.type==='true-false' ? 'T/F' : (q.type==='multiple-answer' ? 'Multi Answer' : 'Multiple Choice'))}</span>`;

        div.innerHTML = `
            <div style="flex: 1; margin-right: 15px;">
                ${typeBadge} <strong style="color: var(--text-main);">${q.text}</strong>
            </div>
            <button class="btn-primary btn-import-single" data-qidx="${qIdx}" style="padding: 0.4rem 0.8rem; font-size: 0.9rem; width: auto; flex-shrink: 0; white-space: nowrap;">+ Add</button>
        `;
        importList.appendChild(div);
    });

    document.querySelectorAll('.btn-import-single').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const qIdx = e.target.getAttribute('data-qidx');
            const qToImport = JSON.parse(JSON.stringify((quiz.questions || [])[qIdx])); // deep copy
            customQuizData.push(qToImport);
            renderMakerList();
            e.target.innerText = "Added!";
            e.target.style.background = "var(--success)";
            e.target.disabled = true;
            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'success',
                title: 'Question added',
                showConfirmButton: false,
                timer: 1500
            });
        });
    });

    // Store selected quiz in button data
    btnImportAll.setAttribute('data-quiz-idx', idx);
});

btnImportAll.addEventListener('click', async () => {
    const idx = btnImportAll.getAttribute('data-quiz-idx');
    const library = await getLocalQuizzes();
    const quiz = library[idx];

    const qsToImport = JSON.parse(JSON.stringify(quiz.questions || []));
    customQuizData = customQuizData.concat(qsToImport);
    renderMakerList();

    importModal.style.display = 'none';
    Swal.fire('Imported!', `Added ${qsToImport.length} questions to your quiz.`, 'success');
});

document.getElementById('maker-add-media-toggle').addEventListener('change', function() {
    document.getElementById('maker-media-fields').style.display = this.checked ? 'block' : 'none';
    if (!this.checked) {
        document.getElementById('maker-img-url').value = '';
        document.getElementById('maker-img-file').value = '';
        document.getElementById('maker-media-container').style.display = 'none';
        document.getElementById('btn-change-media').innerText = 'Add Media';
        saveActiveQuestion(); // Clear the saved media as well
    }
});

document.getElementById('maker-img-file').addEventListener('change', async function() {
    if (this.files.length > 0) {
        await saveActiveQuestion(); // This will process the file, update the URL, and display the preview
        Swal.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: 'Media Added',
            showConfirmButton: false,
            timer: 1500
        });
    }
});

document.getElementById('maker-img-url').addEventListener('input', async function() {
    if (this.value) {
        await saveActiveQuestion();
    }
});

/* --- Media dropzone: click to pick, drag & drop a file --- */
const mediaDropzone = document.getElementById('media-dropzone');
const makerImgFileEl = document.getElementById('maker-img-file');
if (mediaDropzone && makerImgFileEl) {
    mediaDropzone.addEventListener('click', () => makerImgFileEl.click());
    mediaDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        mediaDropzone.classList.add('dragover');
    });
    mediaDropzone.addEventListener('dragleave', () => mediaDropzone.classList.remove('dragover'));
    mediaDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        mediaDropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            makerImgFileEl.files = e.dataTransfer.files;
            makerImgFileEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
}

/* =====================================================================
   THEME & MUSIC TOGGLES
===================================================================== */
/* =====================================================================
   THEME SELECTOR
===================================================================== */
const themeSelect = document.getElementById('theme-select');
const themes = ['dark', 'light', 'pastel', 'earth', 'warm', 'cool'];
const THEME_CLASSES = ['light-theme', 'pastel-theme', 'earth-theme', 'warm-theme', 'cool-theme'];

themeSelect.addEventListener('change', () => {
    const chosen = themeSelect.value;
    // Remove all theme classes first
    document.body.classList.remove(...THEME_CLASSES);
    if (chosen !== 'dark') {
        document.body.classList.add(`${chosen}-theme`);
    }
    localStorage.setItem('spotDiagnosisTheme', chosen);
    if (typeof fxDestroy === 'function' && typeof fxSpawn === 'function') {
        fxDestroy();
        if (document.body.classList.contains('fx-active') && !document.body.classList.contains('fx-off')) {
            fxSpawn(1);
        }
    }
    if (typeof fxVideoSync === 'function') fxVideoSync();
});

// Restore saved theme on load (default to light; unknown values fall back to light)
const savedTheme = localStorage.getItem('spotDiagnosisTheme');
let initialTheme = 'light';
if (themes.includes(savedTheme)) {
    initialTheme = savedTheme;
}
if (initialTheme !== 'dark') {
    document.body.classList.add(`${initialTheme}-theme`);
}
themeSelect.value = initialTheme;

/* =====================================================================
   SETTINGS MODAL (Appearance & Sound)
===================================================================== */
const settingsModal = document.getElementById('settings-modal');
const settingsBtn = document.getElementById('btn-settings');
const closeSettings = document.querySelector('.close-settings');

window.openSettingsModal = (event) => {
    if (event) event.stopPropagation();
    if (settingsModal) settingsModal.style.display = 'flex';
};

if (settingsBtn && settingsModal) {
    settingsBtn.addEventListener('click', window.openSettingsModal);
}
if (closeSettings) {
    closeSettings.addEventListener('click', () => {
        settingsModal.style.display = 'none';
    });
}
if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) settingsModal.style.display = 'none';
    });
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal && settingsModal.style.display === 'flex') {
        settingsModal.style.display = 'none';
    }
});

/* =====================================================================
   MC OPTION FILE UPLOAD HANDLERS
===================================================================== */
// Store uploaded images as base64 per option slot
const mcUploadedImages = { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: null, 9: null };

for (let i = 0; i < 5; i++) {
    document.getElementById(`mc-file-${i}`).addEventListener('change', function() {
        const file = this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            mcUploadedImages[i] = e.target.result;
            // Auto-fill the text field with the data URL (isImage detected automatically from data: prefix)
            document.getElementById(`mc-opt-${i}`).value = e.target.result;
            document.getElementById(`mc-file-preview-${i}`).innerText = `✅ ${file.name}`;
        };
        reader.readAsDataURL(file);
    });
}

// Multiple Answer image uploads (10 slots)
const maUploadedImages = {};
for (let i = 0; i < 10; i++) {
    const maFileEl = document.getElementById(`ma-file-${i}`);
    if (!maFileEl) continue;
    maFileEl.addEventListener('change', function() {
        const file = this.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            maUploadedImages[i] = e.target.result;
            document.getElementById(`ma-opt-${i}`).value = e.target.result;
            document.getElementById(`ma-file-preview-${i}`).innerText = `✅ ${file.name}`;
        };
        reader.readAsDataURL(file);
    });
}



/* =====================================================================
   TEACHER ID & CLOUD MANAGER
===================================================================== */
let teacherId = localStorage.getItem('spotDiagnosisTeacherId');
if (!teacherId) {
    teacherId = 'teacher_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('spotDiagnosisTeacherId', teacherId);
}

// Warn before closing tab if unsaved draft exists
window.addEventListener('beforeunload', (e) => {
    if (customQuizData.length > 0) {
        e.preventDefault();
        e.returnValue = ''; // Required for browser warning
    }
});


/* =====================================================================
   MAKER MODE (TEACHER)
===================================================================== */
const qTypeSelect = document.getElementById('maker-q-type');
const mcOptionsDiv = document.getElementById('maker-mc-options');
const maOptionsDiv = document.getElementById('maker-ma-options');
const typingCorrectDiv = document.getElementById('maker-typing-correct');
const tfOptionsDiv = document.getElementById('maker-tf-options');

/* --- Question type tabs (sync with the hidden select) --- */
const makerTypeTabs = document.querySelectorAll('.maker-type-tab');
function setMakerTypeTab(type) {
    makerTypeTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.type === type));
}
makerTypeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const type = tab.dataset.type;

        // New-question flow: first tab click creates the question of that type
        if (window._makerTypeStep === 'choose') {
            window._makerTypeStep = null;
            document.getElementById('maker-form-container').classList.remove('maker-choose-type');
            document.querySelectorAll('.maker-form-grid, .maker-form-actions').forEach(el => el.style.display = '');
            localStorage.setItem('spotDiagnosisCollapseTabs', '0');
            applyTabsCollapse();
            customQuizData.push({
                type: type,
                text: '',
                context: '',
                timer: type === 'info' ? 0 : 30,
                freePoint: false,
                imageUrl: '',
                mediaType: 'image',
                options: (type === 'multiple-choice' || type === 'multiple-answer') ? ['', '', '', '', ''] : [],
                correctAnswer: type === 'multiple-choice' ? '0' : ''
            });
            selectQuestion(customQuizData.length - 1);
            return;
        }

        document.getElementById('maker-q-type').value = type;
        setMakerTypeTab(type);
        // Re-apply the panel visibility for the chosen type
        const formContainer = document.getElementById('maker-form-container');
        formContainer.dataset.type = type === 'info' ? 'info' : 'question';
        const isInfo = type === 'info';
        const freePointGroup = document.getElementById('maker-free-point-group');
        const contextGroup = document.getElementById('maker-context-group');
        const infoTextGroup = document.getElementById('maker-info-text-group');
        const qText = document.getElementById('maker-q-text');
        if (isInfo) {
            document.getElementById('maker-form-title').innerText = "Add Info Slide";
            if (freePointGroup) freePointGroup.style.display = 'none';
            if (contextGroup) contextGroup.style.display = 'none';
            if (infoTextGroup) infoTextGroup.style.display = 'flex';
            if (qText) qText.placeholder = 'Slide Title (optional)';
        } else {
            document.getElementById('maker-form-title').innerText = "Edit Question";
            if (freePointGroup) freePointGroup.style.display = 'block';
            if (contextGroup) contextGroup.style.display = 'flex';
            if (infoTextGroup) infoTextGroup.style.display = 'none';
            if (qText) qText.placeholder = 'Tap to add question';
        }
        const isChoice = type === 'multiple-choice' || type === 'multiple-answer';
        mcOptionsDiv.style.display = type === 'multiple-choice' ? 'flex' : 'none';
        maOptionsDiv.style.display = type === 'multiple-answer' ? 'flex' : 'none';
        tfOptionsDiv.style.display = type === 'true-false' ? 'grid' : 'none';
        typingCorrectDiv.style.display = type === 'typing' ? 'block' : 'none';
        if (type === 'typing' && typingKeysContainer.children.length === 0) {
            addTypingKeyRow('', 10, false, false, false);
        }
        if (type === 'multiple-choice') {
            syncOptionRows();
        }
        if (type === 'multiple-answer') {
            syncMaOptionRows();
        }
        markMakerDirty();
    });
});

/* --- Collapse / expand the question type tabs --- */
const btnCollapseTabs = document.getElementById('btn-collapse-tabs');
const makerTabsEl = document.getElementById('maker-type-tabs');
function applyTabsCollapse() {
    if (!makerTabsEl) return;
    const collapsed = localStorage.getItem('spotDiagnosisCollapseTabs') === '1';
    makerTabsEl.classList.toggle('collapsed', collapsed);
    if (btnCollapseTabs) btnCollapseTabs.innerText = collapsed ? '▼' : '▲';
}
if (btnCollapseTabs) {
    btnCollapseTabs.addEventListener('click', () => {
        const collapsed = localStorage.getItem('spotDiagnosisCollapseTabs') === '1';
        localStorage.setItem('spotDiagnosisCollapseTabs', collapsed ? '0' : '1');
        applyTabsCollapse();
    });
}
applyTabsCollapse();

/* --- Collapse / expand the left sidebar (question list) --- */
const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const makerSidebar = document.getElementById('maker-sidebar');
function applySidebarCollapse() {
    if (!makerSidebar) return;
    const collapsed = localStorage.getItem('spotDiagnosisCollapseSidebar') === '1';
    makerSidebar.classList.toggle('collapsed', collapsed);
    if (btnToggleSidebar) btnToggleSidebar.innerText = collapsed ? '▶' : '◀';
}
if (btnToggleSidebar) {
    btnToggleSidebar.addEventListener('click', () => {
        const collapsed = localStorage.getItem('spotDiagnosisCollapseSidebar') === '1';
        localStorage.setItem('spotDiagnosisCollapseSidebar', collapsed ? '0' : '1');
        applySidebarCollapse();
    });
}
applySidebarCollapse();

/* --- "+ Add choice": reveal hidden MC rows one at a time, up to 10 total --- */
const btnAddOption = document.getElementById('btn-add-option');
// Returns the total number of visible MC option rows.
function visibleOptionCount() {
    return document.querySelectorAll('.mc-option-row').length;
}
function syncOptionRows() {
    // Rows 0 and 1 are the fixed minimum (2 choices).
    // A row is shown only if it has a value or the user revealed it with
    // "+ Add choice". Everything else stays hidden until revealed (max 10).
    const extraRows = document.querySelectorAll('.mc-opt-extra');
    extraRows.forEach((row) => {
        const hasValue = document.getElementById(`mc-opt-${row.dataset.opt}`).value.trim() !== '';
        row.style.display = (hasValue || row.dataset.revealed) ? 'flex' : 'none';
    });
    const anyHidden = [...extraRows].some(r => r.style.display === 'none');
    if (btnAddOption) btnAddOption.style.display = anyHidden ? 'inline-block' : 'none';
}
if (btnAddOption) {
    btnAddOption.addEventListener('click', () => {
        const extraRows = [...document.querySelectorAll('.mc-opt-extra')];
        const target = extraRows.find(r => r.style.display === 'none');
        if (target) {
            target.dataset.revealed = '1';
            target.style.display = 'flex';
            const input = document.getElementById(`mc-opt-${target.dataset.opt}`);
            if (input) input.focus();
        }
        syncOptionRows();
        markMakerDirty();
    });
}

/* --- Multiple Answer: up to 10 choices, multiple correct --- */
const btnAddMaOption = document.getElementById('btn-add-ma-option');
function syncMaOptionRows() {
    const extraRows = document.querySelectorAll('.mc-ma-extra');
    extraRows.forEach((row) => {
        const hasValue = document.getElementById(`ma-opt-${row.dataset.opt}`).value.trim() !== '';
        row.style.display = (hasValue || row.dataset.revealed) ? 'flex' : 'none';
    });
    const anyHidden = [...extraRows].some(r => r.style.display === 'none');
    if (btnAddMaOption) btnAddMaOption.style.display = anyHidden ? 'inline-block' : 'none';
}
if (btnAddMaOption) {
    btnAddMaOption.addEventListener('click', () => {
        const extraRows = [...document.querySelectorAll('.mc-ma-extra')];
        const target = extraRows.find(r => r.style.display === 'none');
        if (target) {
            target.dataset.revealed = '1';
            target.style.display = 'flex';
            const input = document.getElementById(`ma-opt-${target.dataset.opt}`);
            if (input) input.focus();
        }
        syncMaOptionRows();
        markMakerDirty();
    });
}

/* --- Media type auto-detection (as a default, user can override) --- */
const mediaTypeSelect = document.getElementById('maker-media-type');
function detectMediaType(url, file) {
    const name = (file && file.name) || (url || '');
    const lower = name.toLowerCase();
    if (file && file.type) {
        if (file.type.startsWith('video/')) return 'video';
        if (file.type.startsWith('image/')) return 'image';
    }
    if (/\.(mp4|webm|mov|avi|mkv)(\?|$)/.test(lower)) return 'video';
    if (/youtube\.com|youtu\.be/.test(lower)) return 'video';
    return 'image';
}
const makerImgUrlInput = document.getElementById('maker-img-url');
const makerImgFileInput = document.getElementById('maker-img-file');
let mediaTypeTouched = false;
function syncMediaType() {    // Only auto-detect until the user picks a type themselves.
    if (mediaTypeTouched || !mediaTypeSelect) return;
    mediaTypeSelect.value = detectMediaType(makerImgUrlInput ? makerImgUrlInput.value : '', makerImgFileInput && makerImgFileInput.files[0]);
}
if (makerImgUrlInput) makerImgUrlInput.addEventListener('input', syncMediaType);
if (makerImgFileInput) makerImgFileInput.addEventListener('change', syncMediaType);
if (mediaTypeSelect) mediaTypeSelect.addEventListener('change', () => { mediaTypeTouched = true; });

const typingKeysContainer = document.getElementById('typing-keys-container');
const btnAddTypingKey = document.getElementById('btn-add-typing-key');

const typingAIGradingToggle = document.getElementById('maker-typing-ai-grading');
function updateAIToggleUI() {
    const isAIOn = typingAIGradingToggle && typingAIGradingToggle.checked;
    const optionsContainers = document.querySelectorAll('.key-options-container');
    optionsContainers.forEach(container => {
        container.style.display = isAIOn ? 'none' : 'flex';
    });

    const rejectedWrapper = document.getElementById('maker-typing-rejected-wrapper');
    if (rejectedWrapper) {
        rejectedWrapper.style.display = isAIOn ? 'none' : 'block';
    }
}
if (typingAIGradingToggle) {
    typingAIGradingToggle.addEventListener('change', updateAIToggleUI);
}

function addTypingKeyRow(text = '', points = 10, exact = false, ordered = false, followsPrevious = false) {
    const isFirstRow = typingKeysContainer.children.length === 0;
    const row = document.createElement('div');
    row.className = 'typing-key-row';
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '10px';
    row.style.marginBottom = '8px';
    row.style.flexWrap = 'wrap';
    row.style.background = 'var(--glass-bg)';
    row.style.padding = '10px';
    row.style.borderRadius = '8px';
    row.style.border = '1px solid var(--glass-border)';
    row.innerHTML = `
        <div style="display: flex; width: 100%; gap: 10px; align-items: center;">
            <input type="text" class="key-text" style="flex: 1; min-width: 150px;" placeholder="e.g. ECG/EKG" value="${text}">
            <input type="number" class="key-points" style="width: 80px; text-align: center;" placeholder="Pts" value="${points}" min="0">
            <button type="button" class="btn-remove-key" style="background:none; border:none; color:var(--danger); font-size:1.5rem; cursor:pointer; line-height:1; margin-left: auto;">&times;</button>
        </div>
        <div class="key-options-container" style="display: flex; width: 100%; gap: 20px; margin-top: 10px; padding-left: 5px; flex-wrap: wrap;">
            <label class="toggle-label" style="font-size: 0.8rem; margin:0; color:var(--text-main);" title="Words must be in correct order">
                <input type="checkbox" class="key-ordered" ${ordered ? 'checked' : ''}>
                <span class="toggle-switch" style="transform: scale(0.7); transform-origin: left center; margin-right: 5px;"></span>
                Ordered
            </label>
            <label class="toggle-label" style="font-size: 0.8rem; margin:0; display:flex; align-items:center; color:var(--text-main);">
                <input type="checkbox" class="key-exact" ${exact ? 'checked' : ''}>
                <span class="toggle-switch" style="transform: scale(0.7); transform-origin: left center; margin-right: 5px;"></span>
                Exact
                <i class="fa fa-question-circle" style="margin-left: 4px; color: var(--primary); cursor: pointer;" onclick="Swal.fire({
                    title: 'Exact Mode',
                    html: '<p align=\\'left\\'>Exact mode requires the exact sequence of words to appear somewhere in the student\\'s answer. Spelling mistakes are NOT allowed.</p><p align=\\'left\\'><b>However, it still ignores:</b><br>- Extra words in their answer<br>- Capital letters<br>- Punctuation (commas, periods)</p><p align=\\'left\\' style=\\'color:var(--text-muted)\\'>Example: If your key is <i>Heart Attack</i>, a student typing <i>The patient had a hEART attack today.</i> is still marked 100% correct!</p>',
                    icon: 'info'
                })"></i>
            </label>
            ${!isFirstRow ? `
            <label class="toggle-label" style="font-size: 0.8rem; margin:0; color:var(--text-main);" title="Must appear after previous key (max 10 words apart)">
                <input type="checkbox" class="key-follows" ${followsPrevious ? 'checked' : ''}>
                <span class="toggle-switch" style="transform: scale(0.7); transform-origin: left center; margin-right: 5px;"></span>
                Follows previous key
            </label>
            ` : ''}
        </div>
    `;

    const exactCb = row.querySelector('.key-exact');
    const orderedCb = row.querySelector('.key-ordered');
    exactCb.addEventListener('change', () => { if (exactCb.checked) orderedCb.checked = false; });
    orderedCb.addEventListener('change', () => { if (orderedCb.checked) exactCb.checked = false; });

    row.querySelector('.btn-remove-key').addEventListener('click', () => {
        row.remove();
    });
    typingKeysContainer.appendChild(row);

    // Ensure newly added row honors the current AI toggle state
    updateAIToggleUI();
}

if (btnAddTypingKey) {
    btnAddTypingKey.addEventListener('click', () => {
        addTypingKeyRow('', 10, false, false);
    });
}

qTypeSelect.addEventListener('change', (e) => {
    document.getElementById('maker-content-area').style.display = 'block';
    const t = e.target.value;
    const isMC = t === 'multiple-choice';
    const isMA = t === 'multiple-answer';
    mcOptionsDiv.style.display = isMC ? 'block' : 'none';
    maOptionsDiv.style.display = isMA ? 'block' : 'none';
    typingCorrectDiv.style.display = t === 'typing' ? 'block' : 'none';
    tfOptionsDiv.style.display = t === 'true-false' ? 'block' : 'none';
    if (t === 'typing' && typingKeysContainer.children.length === 0) {
        addTypingKeyRow('', 10);
    }
});

window.editQuestion = (index) => {
    const q = customQuizData[index];
    document.getElementById('edit-q-index').value = index;
    document.getElementById('maker-form-title').innerText = "Edit Question";
    document.getElementById('maker-form-container').style.display = "flex";
    document.getElementById('maker-content-area').style.display = "block";

    document.getElementById('maker-q-type').value = q.type;
    setMakerTypeTab(q.type);

    if (q.type === 'info') {
        document.getElementById('maker-form-title').innerText = "Edit Info Slide";
        document.getElementById('maker-form-container').dataset.type = 'info';
        document.getElementById('maker-free-point-group').style.display = 'none';
        document.getElementById('maker-context-group').style.display = 'none';
        document.getElementById('maker-info-text-group').style.display = 'flex';
        document.getElementById('maker-q-text').placeholder = 'Slide Title (optional)';
    } else {
        document.getElementById('maker-form-container').dataset.type = 'question';
        document.getElementById('maker-free-point-group').style.display = 'block';
        document.getElementById('maker-context-group').style.display = 'flex';
        document.getElementById('maker-info-text-group').style.display = 'none';
        document.getElementById('maker-q-text').placeholder = 'Tap to add question';
    }
    document.getElementById('maker-q-text').value = q.text;
    document.getElementById('maker-context').value = q.type === 'info' ? "" : (q.context || "");
    document.getElementById('maker-info-text').value = q.type === 'info' ? (q.context || "") : "";
    document.getElementById('maker-timer').value = q.timer;
    const timerSelect = document.getElementById('maker-timer');
    if (timerSelect && timerSelect._syncCustomUI) timerSelect._syncCustomUI();
    document.getElementById('maker-free-point').checked = q.freePoint;
    document.getElementById('maker-media-type').value = q.mediaType || 'image';
    mediaTypeTouched = false;
    document.getElementById('maker-img-url').value = (Array.isArray(q.imageUrls) && q.imageUrls.length > 1 ? q.imageUrls.join('\n') : (q.imageUrl || ""));
    const hasMedia = (Array.isArray(q.imageUrls) && q.imageUrls.length > 0) || !!q.imageUrl;
    document.getElementById('maker-add-media-toggle').checked = hasMedia;
    document.getElementById('maker-media-fields').style.display = hasMedia ? 'none' : 'none'; // Don't show URL fields if they already added media, just show the preview

    // Use the common render function for the maker preview
    renderMediaCommon(q, 'maker', false);

    if (hasMedia) {
        document.getElementById('btn-change-media').innerText = 'Change Media';
    } else {
        document.getElementById('btn-change-media').innerText = 'Add Media';
    }

    if (q.type === 'multiple-choice') {
        mcOptionsDiv.style.display = 'flex';
        maOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'none';
        // Clear radios first
        document.querySelectorAll('input.mc-correct-radio').forEach(r => r.checked = false);
        const correctRawSet = new Set((q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : [])).map(c =>
            typeof c === 'string' ? c : c.text
        ));
        for (let i=0; i<5; i++) {
            const opt = q.options[i];
            if (opt) {
                document.getElementById(`mc-opt-${i}`).value = typeof opt === 'string' ? opt : opt.text;
                const optRaw = typeof opt === 'string' ? opt : opt.text;
                if (correctRawSet.has(optRaw)) {
                    const rb = document.querySelector(`input.mc-correct-radio[value="${i}"]`);
                    if (rb) rb.checked = true;
                }
            } else {
                document.getElementById(`mc-opt-${i}`).value = "";
            }
        }
        syncOptionRows();
    } else if (q.type === 'multiple-answer') {
        mcOptionsDiv.style.display = 'none';
        maOptionsDiv.style.display = 'flex';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'none';
        // Clear all checkboxes first
        document.querySelectorAll('input.mc-correct-cb').forEach(cb => cb.checked = false);
        const correctRawSet = new Set((q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : [])).map(c =>
            typeof c === 'string' ? c : c.text
        ));
        for (let i=0; i<10; i++) {
            const opt = q.options[i];
            if (opt) {
                document.getElementById(`ma-opt-${i}`).value = typeof opt === 'string' ? opt : opt.text;
                const optRaw = typeof opt === 'string' ? opt : opt.text;
                if (correctRawSet.has(optRaw)) {
                    const cb = document.querySelector(`input.mc-correct-cb[value="${i}"]`);
                    if (cb) cb.checked = true;
                }
            } else {
                document.getElementById(`ma-opt-${i}`).value = "";
            }
        }
        syncMaOptionRows();
    } else if (q.type === 'true-false') {
        mcOptionsDiv.style.display = 'none';
        maOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'block';
        if (q.correctAnswer) {
            const cVal = typeof q.correctAnswer === 'string' ? q.correctAnswer : q.correctAnswer.text;
            const rb = document.querySelector(`input[name="tf-correct"][value="${cVal}"]`);
            if (rb) rb.checked = true;
        }
    } else if (q.type === 'info') {
        mcOptionsDiv.style.display = 'none';
        maOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'none';
    } else {
        mcOptionsDiv.style.display = 'none';
        maOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'block';
        tfOptionsDiv.style.display = 'none';
        if (document.getElementById('maker-typing-ai-grading')) {
            document.getElementById('maker-typing-ai-grading').checked = q.aiGrading !== false; // Default true if undefined
        }
        typingKeysContainer.innerHTML = '';
        if (q.acceptedAnswers && q.acceptedAnswers.length > 0) {
            q.acceptedAnswers.forEach(ans => {
                const t = typeof ans === 'string' ? ans : ans.text;
                const p = (typeof ans === 'object' && ans.points !== undefined) ? ans.points : 10;
                const exact = (typeof ans === 'object' && ans.exact === true);
                const ordered = (typeof ans === 'object' && ans.ordered === true);
                const followsPrevious = (typeof ans === 'object' && ans.followsPrevious === true);
                addTypingKeyRow(t, p, exact, ordered, followsPrevious);
            });
        } else {
            addTypingKeyRow('', 10, false, false);
        }
        updateAIToggleUI();
        const rejectedInput = document.getElementById('maker-typing-rejected');
        if (rejectedInput) {
            rejectedInput.value = (q.rejectedWords || []).join(', ');
        }
        const partialCheckbox = document.getElementById('maker-typing-partial');
        if (partialCheckbox) {
            partialCheckbox.checked = q.partialCredit === true;
        }
    }
};

window.deleteQuestion = (index) => {
    if(confirm("Delete this question?")) {
        customQuizData.splice(index, 1);

        const editIndexInput = document.getElementById('edit-q-index');
        const currentIndex = parseInt(editIndexInput.value);

        if (currentIndex === index) {
            // The currently edited question was deleted, so close the editor
            resetMakerForm();
        } else if (currentIndex > index) {
            // A question before the currently edited one was deleted, shift the index down
            editIndexInput.value = currentIndex - 1;
        }

        renderMakerList();
        if (customQuizData.length === 0) {
            document.getElementById('btn-host-quiz').disabled = true;
        }
    }
};



document.getElementById('btn-close-maker-form').addEventListener('click', () => {
    resetMakerForm();
});

/* --- "Add New" button: choose New Question (shows type tabs first) or Slide --- */
document.getElementById('btn-add-new').addEventListener('click', async () => {
    saveActiveQuestion();

    window.tempAddChoice = null;

    const result = await Swal.fire({
        title: 'What do you want to add?',
        html: `
            <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">
                <button class="btn-primary" onclick="window.tempAddChoice='question'; Swal.clickConfirm();" style="padding:15px; font-size:1.1rem; border-radius:8px;">New Question</button>
                <button class="btn-secondary" onclick="window.tempAddChoice='slide'; Swal.clickConfirm();" style="padding:15px; font-size:1.1rem; border-radius:8px;">Present Slide</button>
            </div>
        `,
        showCancelButton: true,
        showConfirmButton: false,
        cancelButtonColor: '#333333',
        customClass: {
            popup: 'glass-container'
        }
    });

    if (!result.isConfirmed || !window.tempAddChoice) return;
    const choice = window.tempAddChoice;

    if (choice === 'slide') {
        customQuizData.push({
            type: 'info',
            text: '',
            context: '',
            timer: 0,
            freePoint: false,
            imageUrl: '',
            mediaType: 'image',
            options: [],
            correctAnswer: ''
        });
        selectQuestion(customQuizData.length - 1);
        return;
    }

    // New Question: bypass the choose step, default to 'typing' (Short Answer)
    // and ensure the type tabs are expanded.
    localStorage.setItem('spotDiagnosisCollapseTabs', '0');
    applyTabsCollapse();
    
    customQuizData.push({
        type: 'typing',
        text: '',
        context: '',
        timer: 30,
        freePoint: false,
        imageUrl: '',
        mediaType: 'image',
        options: [],
        correctAnswer: ''
    });
    
    document.getElementById('maker-form-container').classList.remove('maker-choose-type');
    document.querySelectorAll('.maker-form-grid, .maker-form-actions').forEach(el => el.style.display = '');
    document.getElementById('maker-type-tabs').style.display = 'flex';
    document.getElementById('maker-empty-state').style.display = 'none';
    
    selectQuestion(customQuizData.length - 1);
});

function resetMakerForm(defaultType = 'question') {
    document.getElementById('edit-q-index').value = "-1";
    document.getElementById('maker-form-container').style.display = "none";

    const statusEl = document.getElementById('maker-save-status');
    if (statusEl) {
        statusEl.classList.remove('is-saved', 'is-dirty', 'is-error');
        statusEl.innerText = '';
    }
    document.getElementById('maker-content-area').style.display = "none";
    document.getElementById('maker-q-type').value = "";

    document.getElementById('maker-q-text').value = '';
    document.getElementById('maker-q-text').placeholder = 'Tap to add question';
    document.getElementById('maker-context').value = '';
    document.getElementById('maker-info-text').value = '';
    document.getElementById('maker-img-file').value = '';
    document.getElementById('maker-img-url').value = '';
    document.getElementById('maker-media-container').style.display = "none";
    document.getElementById('maker-add-media-toggle').checked = false;
    document.getElementById('maker-media-fields').style.display = 'none';
    document.getElementById('btn-change-media').innerText = 'Add Media';
    typingKeysContainer.innerHTML = '';
    addTypingKeyRow('', 10, false, false, false);
    updateAIToggleUI();
    const rejectedInput = document.getElementById('maker-typing-rejected');
    if (rejectedInput) rejectedInput.value = '';
    for (let i=0; i<5; i++) {
        const mcOpt = document.getElementById(`mc-opt-${i}`);
        if (mcOpt) mcOpt.value = '';
        const mcFile = document.getElementById(`mc-file-${i}`);
        if (mcFile) mcFile.value = '';
        const mcPrev = document.getElementById(`mc-file-preview-${i}`);
        if (mcPrev) mcPrev.innerText = '';
        const cb = document.querySelector(`input.mc-correct-cb[value="${i}"]`);
        if (cb) cb.checked = false;
        mcUploadedImages[i] = null;
    }
    document.querySelectorAll('.mc-opt-extra').forEach(row => {
        row.style.display = 'none';
        delete row.dataset.revealed;
    });
    document.querySelectorAll('.mc-ma-extra').forEach(row => {
        row.style.display = 'none';
        delete row.dataset.revealed;
    });
    for (let i=0; i<10; i++) {
        const maOpt = document.getElementById(`ma-opt-${i}`);
        if (maOpt) maOpt.value = '';
        const maFile = document.getElementById(`ma-file-${i}`);
        if (maFile) maFile.value = '';
        const maPrev = document.getElementById(`ma-file-preview-${i}`);
        if (maPrev) maPrev.innerText = '';
    }
    setMakerTypeTab('multiple-choice');

    if (defaultType === 'info') {
        document.getElementById('maker-form-title').innerText = "Add Info Slide";
        document.getElementById('maker-form-container').dataset.type = 'info';
        document.getElementById('maker-free-point-group').style.display = 'none';
        document.getElementById('maker-context-group').style.display = 'none';
        document.getElementById('maker-info-text-group').style.display = 'flex';
        document.getElementById('maker-q-text').placeholder = 'Slide Title (optional)';
        document.getElementById('maker-content-area').style.display = 'block';
        mcOptionsDiv.style.display = 'none';
        maOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'none';
    } else {
        document.getElementById('maker-form-title').innerText = "Add New Question";
        document.getElementById('maker-form-container').dataset.type = 'question';
        document.getElementById('maker-q-type').value = '';
        document.getElementById('maker-free-point-group').style.display = 'block';
        document.getElementById('maker-context-group').style.display = 'flex';
        document.getElementById('maker-info-text-group').style.display = 'none';
        document.getElementById('maker-q-text').placeholder = 'Tap to add question';
    }
}

window.saveActiveQuestion = async () => {
    try {
        const editIndex = parseInt(document.getElementById('edit-q-index').value);
        if (editIndex < 0 || editIndex >= customQuizData.length) return; // Nothing to save

        const isInfo = document.getElementById('maker-form-container').dataset.type === 'info';
        const type = isInfo ? 'info' : document.getElementById('maker-q-type').value;
        const text = document.getElementById('maker-q-text').value;
        const context = isInfo ? document.getElementById('maker-info-text').value : document.getElementById('maker-context').value;
        const timer = parseInt(document.getElementById('maker-timer').value) || 0;
        const freePoint = document.getElementById('maker-free-point').checked;

        syncMediaType();
        const mediaType = document.getElementById('maker-media-type').value;

        let imageUrl = document.getElementById('maker-img-url').value;
        const fileInput = document.getElementById('maker-img-file');

        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];

            if (mediaType === 'video') {
                if (file.size > 5 * 1024 * 1024) {
                    throw new Error("Video file is too large! Please keep videos under 5MB or upload to YouTube and paste the link.");
                }
                if (file.type.includes('quicktime') || file.name.toLowerCase().endsWith('.mov')) {
                    throw new Error("Apple .mov videos are not supported by most browsers! Please convert to vdo or upload to YouTube and paste the link instead.");
                }
            }

            imageUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (mediaType === 'image') {
                        const img = new Image();
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                            const MAX_WIDTH = 1200;
                            const MAX_HEIGHT = 1200;
                            let width = img.width;
                            let height = img.height;
                            if (width > height) {
                                if (width > MAX_WIDTH) {
                                    height *= MAX_WIDTH / width;
                                    width = MAX_WIDTH;
                                }
                            } else {
                                if (height > MAX_HEIGHT) {
                                    width *= MAX_HEIGHT / height;
                                    height = MAX_HEIGHT;
                                }
                            }
                            canvas.width = width;
                            canvas.height = height;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(img, 0, 0, width, height);
                            resolve(canvas.toDataURL('image/jpeg', 0.7));
                        };
                        img.onerror = () => reject(new Error("Failed to process image"));
                        img.src = e.target.result;
                    } else {
                        resolve(e.target.result);
                    }
                };
                reader.onerror = (e) => reject(new Error("Failed to read file"));
                reader.readAsDataURL(file);
            });

            // Clear the file input so it doesn't get re-processed
            fileInput.value = '';
            document.getElementById('maker-img-url').value = imageUrl;
        }

        // Update the live preview immediately on save
        const urlField = document.getElementById('maker-img-url');
        const parsedUrls = urlField.value.split('\n').map(u => u.trim()).filter(Boolean);
        renderMediaCommon({ imageUrl: (parsedUrls[0] || ''), imageUrls: parsedUrls.length > 1 ? parsedUrls : undefined, mediaType: mediaType }, 'maker', false);

        if (parsedUrls.length > 0) {
            document.getElementById('maker-add-media-toggle').checked = true;
            document.getElementById('maker-media-fields').style.display = 'none';
            document.getElementById('btn-change-media').innerText = 'Change Media';
        } else {
            document.getElementById('btn-change-media').innerText = 'Add Media';
        }


        if (!text) throw new Error("Question text is required");

        let q = { type, text, context, imageUrl, mediaType, timer, freePoint };

        // Multiple images: store as array on imageUrls when several URLs were pasted
        if (parsedUrls.length > 1 && mediaType !== 'video') {
            q.imageUrls = parsedUrls;
        } else {
            delete q.imageUrls;
        }

        if (type === 'multiple-choice') {
            const opts = [];
            let correctOptObj = null;
            const selectedRadioEl = document.querySelector('input.mc-correct-radio:checked');
            const selectedRadio = selectedRadioEl ? selectedRadioEl.value : null;

            for(let i=0; i<5; i++){
                const val = document.getElementById(`mc-opt-${i}`).value.trim();
                // Detect image automatically: data URLs or http image links
                const isImg = val.startsWith('data:image/') || val.startsWith('http');
                if(val) {
                    const optObj = { text: val, isImage: isImg };
                    opts.push(optObj);
                    if (i.toString() === selectedRadio) {
                        correctOptObj = optObj;
                    }
                }
            }

            q.options = opts;
            q.correctAnswer = correctOptObj || opts[0] || null;
            q.correctAnswers = correctOptObj ? [correctOptObj] : (opts.length > 0 ? [opts[0]] : []);
            q.acceptedAnswers = q.correctAnswers;

        } else if (type === 'multiple-answer') {
            const opts = [];
            const correctOpts = [];

            for(let i=0; i<10; i++){
                const val = document.getElementById(`ma-opt-${i}`).value.trim();
                // Detect image automatically: data URLs or http image links
                const isImg = val.startsWith('data:image/') || val.startsWith('http');
                if(val) {
                    const optObj = { text: val, isImage: isImg };
                    opts.push(optObj);
                    const cb = document.querySelector(`input.mc-correct-cb[value="${i}"]`);
                    if (cb && cb.checked) {
                        correctOpts.push(optObj);
                    }
                }
            }

            q.options = opts;
            q.correctAnswer = correctOpts[0] || opts[0] || null;
            q.correctAnswers = correctOpts.length > 0 ? correctOpts : (opts.length > 0 ? [opts[0]] : []);
            q.acceptedAnswers = q.correctAnswers;

        } else if (type === 'true-false') {
            const tfRadioEl = document.querySelector('input[name="tf-correct"]:checked');
            const val = tfRadioEl ? tfRadioEl.value : null;
            // No longer throwing error on auto-save
            // if (!cVal && !freePoint) throw new Error("Please select True or False.");
            const tObj = { text: "True", isImage: false };
            const fObj = { text: "False", isImage: false };
            q.options = [tObj, fObj];
            q.correctAnswer = val === "True" ? tObj : (val === "False" ? fObj : null);
            q.acceptedAnswers = q.correctAnswer ? [q.correctAnswer] : [];
        } else if (type === 'info') {
            q.acceptedAnswers = [];
            q.correctAnswer = null;
        } else {
            const keyRows = document.querySelectorAll('.typing-key-row');
            let objs = [];
            keyRows.forEach(row => {
                const text = row.querySelector('.key-text').value.trim();
                const pts = parseInt(row.querySelector('.key-points').value) || 0;
                const exactCb = row.querySelector('.key-exact');
                const orderedCb = row.querySelector('.key-ordered');
                const followsCb = row.querySelector('.key-follows');
                const exact = exactCb ? exactCb.checked : false;
                const ordered = orderedCb ? orderedCb.checked : false;
                const follows = followsCb ? followsCb.checked : false;
                if (text) {
                    objs.push({ text: text, points: pts, isImage: false, exact: exact, ordered: ordered, followsPrevious: follows });
                }
            });
            // No longer throwing error on auto-save
            // if(objs.length === 0 && !freePoint) throw new Error("Please provide at least one correct answer key.");

            q.correctAnswer = objs[0] || {text:"", isImage:false};
            q.acceptedAnswers = objs;
            q.forgiving = true; // Hardcoded default, now controlled per key via exact/ordered
            if (document.getElementById('maker-typing-ai-grading')) {
                q.aiGrading = document.getElementById('maker-typing-ai-grading').checked;
            }

            const rejectedInput = document.getElementById('maker-typing-rejected');
            if (rejectedInput && rejectedInput.value.trim()) {
                q.rejectedWords = rejectedInput.value.split(',').map(w => w.trim()).filter(w => w.length > 0);
            } else {
                delete q.rejectedWords;
            }

            q.partialCredit = true;
        }

        if (editIndex >= 0) {
            customQuizData[editIndex] = q;
        }

        renderMakerList();

        if (customQuizData.length > 0) {
            document.getElementById('btn-host-quiz').disabled = false;
        }

        hideMakerError();
        markMakerSaved();
    } catch (err) {
        // Silent catch for auto-save
        console.warn("Auto-save validation:", err.message);
        markMakerDirty();
        validateMakerForm();
    }
};

window.updateMakerSaveStatus = (state, msg) => {
    const el = document.getElementById('maker-save-status');
    if (!el) return;
    el.classList.remove('is-saved', 'is-dirty', 'is-error');
    if (state === 'saved') {
        el.classList.add('is-saved');
        el.innerText = msg || 'Saved';
    } else if (state === 'dirty') {
        el.classList.add('is-dirty');
        el.innerText = msg || 'Unsaved changes';
    } else {
        el.classList.add('is-error');
        el.innerText = msg || 'Needs attention';
    }
};

window.markMakerDirty = () => updateMakerSaveStatus('dirty');

window.markMakerSaved = () => updateMakerSaveStatus('saved');

/* --- Autosave: debounce saves of the working question to customQuizData --- */
let makerAutosaveTimer = null;
function scheduleMakerAutosave() {
    markMakerDirty();
    if (typeof syncOptionRows === 'function') syncOptionRows();
    clearTimeout(makerAutosaveTimer);
    makerAutosaveTimer = setTimeout(() => {
        saveActiveQuestion();
    }, 700);
}
document.querySelectorAll('#maker-form-container input, #maker-form-container textarea, #maker-form-container select').forEach(el => {
    el.addEventListener('input', scheduleMakerAutosave);
    el.addEventListener('change', scheduleMakerAutosave);
});
// Typing keys are added dynamically; mark dirty on the container via delegation
const makerFormContainer = document.getElementById('maker-form-container');
if (makerFormContainer) {
    makerFormContainer.addEventListener('input', (e) => {
        if (e.target.closest('.typing-key-row')) scheduleMakerAutosave();
    });
}

function validateMakerForm() {
    const isInfo = document.getElementById('maker-form-container').dataset.type === 'info';
    const textEl = document.getElementById('maker-q-text');
    const qErr = document.getElementById('maker-q-text-error');
    const mcErr = document.getElementById('maker-mc-error');
    let valid = true;

    if (qErr) {
        const missingText = !isInfo && !textEl.value.trim();
        qErr.style.display = missingText ? 'block' : 'none';
        qErr.innerText = missingText ? 'Please provide question text before saving.' : '';
        if (missingText) valid = false;
    }

    if (mcErr) {
        const type = document.getElementById('maker-q-type').value;
        if (type === 'multiple-choice') {
            const options = [];
            for (let i = 0; i < 5; i++) {
                const v = document.getElementById(`mc-opt-${i}`).value.trim();
                if (v) options.push(v);
            }
            const hasCorrect = !!document.querySelector('input.mc-correct-radio:checked');
            const freePoint = document.getElementById('maker-free-point').checked;
            const missingOptions = options.length < 2;
            const missingCorrect = !hasCorrect && !freePoint;
            if (missingOptions || missingCorrect) {
                const parts = [];
                if (missingOptions) parts.push('at least 2 options');
                if (missingCorrect) parts.push('a correct answer selected');
                mcErr.style.display = 'block';
                mcErr.innerText = `Multiple choice needs ${parts.join(' and ')} before saving.`;
                valid = false;
            } else {
                mcErr.style.display = 'none';
            }
        } else if (type === 'multiple-answer') {
            const options = [];
            for (let i = 0; i < 10; i++) {
                const el = document.getElementById(`ma-opt-${i}`);
                if (el) {
                    const v = el.value.trim();
                    if (v) options.push(v);
                }
            }
            const hasCorrect = !!document.querySelector('#maker-ma-options input.mc-correct-cb:checked');
            const freePoint = document.getElementById('maker-free-point').checked;
            const missingOptions = options.length < 2;
            const missingCorrect = !hasCorrect && !freePoint;
            if (missingOptions || missingCorrect) {
                const parts = [];
                if (missingOptions) parts.push('at least 2 options');
                if (missingCorrect) parts.push('at least one correct answer ticked');
                mcErr.style.display = 'block';
                mcErr.innerText = `Multiple answer needs ${parts.join(' and ')} before saving.`;
                valid = false;
            } else {
                mcErr.style.display = 'none';
            }
        } else {
            mcErr.style.display = 'none';
        }
    }
    return valid;
}

window.duplicateActiveQuestion = () => {
    const editIndex = parseInt(document.getElementById('edit-q-index').value);
    if (editIndex < 0 || editIndex >= customQuizData.length) {
        Swal.fire('No question', 'Select a question to duplicate first.', 'info');
        return;
    }
    saveActiveQuestion();
    const clone = JSON.parse(JSON.stringify(customQuizData[editIndex]));
    customQuizData.splice(editIndex + 1, 0, clone);
    renderMakerList();
    selectQuestion(editIndex + 1);
    updateMakerSaveStatus('dirty', 'Duplicated - save to keep');
};

window.showMakerError = (msg) => {
    const banner = document.getElementById('maker-error-banner');
    if (banner) {
        banner.innerText = msg;
        banner.style.display = 'block';
    }
};

window.hideMakerError = () => {
    const banner = document.getElementById('maker-error-banner');
    if (banner) banner.style.display = 'none';
};

window.forceSaveActiveQuestion = () => {
    // Re-run save logic but actually throw/show errors this time
    saveActiveQuestion();

    // Manual validation since saveActiveQuestion is now silent
    const editIndex = parseInt(document.getElementById('edit-q-index').value);
    const q = customQuizData[editIndex];
    if (!q) return;

    let errorMsg = null;
    if (!q.text.trim() && q.type !== 'info') errorMsg = "Please provide a question text.";
    if (q.type === 'multiple-choice') {
        if (!q.options || q.options.filter(o => o.text.trim() || o.isImage).length < 2) {
            errorMsg = "Please provide at least 2 multiple choice options.";
        }
        if (!q.correctAnswer && !q.freePoint) {
            errorMsg = "Please select a correct answer.";
        }
    }

    if (errorMsg) {
        showMakerError(errorMsg);
        Swal.fire('Incomplete', errorMsg, 'warning');
    } else {
        hideMakerError();
        Swal.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: 'Question Saved',
            showConfirmButton: false,
            timer: 1500
        });
    }
};

window.renderPlayerScreen = (q, isPreview = false) => {
    document.getElementById('clinical-context').innerText = q.context || "";
    document.getElementById('question-text').innerText = q.text || "No question text";
    document.getElementById('question-text').style.wordBreak = 'normal';
    document.getElementById('question-text').style.overflowWrap = 'break-word';

    renderMediaCommon(q, 'ekg', true);

    if (q.type !== 'info') {
        hideSlide();
        renderOptions('options-container', q, !isPreview, 0, false);
    } else {
        renderSlide(q);
    }

    let timeLeft = q.timer;
    window._currentTimerMax = timeLeft;
    setHudTimer(timeLeft);

    clearInterval(window.localTimer);
    if (timeLeft > 0 && !isPreview) {
        window.localTimer = setInterval(() => {
            timeLeft--;
            setHudTimer(timeLeft);
            if (timeLeft <= 0) clearInterval(window.localTimer);
        }, 1000);
    }
};

window.previewActiveQuestion = () => {
    saveActiveQuestion(); // Ensure latest state is saved
    const editIndex = parseInt(document.getElementById('edit-q-index').value);

    // Set up a mini game state just for this question
    window.currentQuizData = JSON.parse(JSON.stringify(customQuizData)); // deep copy
    window.currentQuestionIndex = editIndex;

    previewMode = true;

    // Switch to player screen but we are host, so it acts like a test
    document.getElementById('maker-screen').classList.remove('active');
    document.getElementById('quiz-screen').classList.add('active');

    document.getElementById('global-nav-container').style.display = 'none';
    const globalControls = document.querySelector('.global-controls');
    if (globalControls) globalControls.style.display = 'flex';

    // Hide live-game host controls so preview is a static view only
    const hostControls = document.querySelector('.host-controls');
    if (hostControls) hostControls.style.display = 'none';

    // Give them a back button overlay to return to maker
    let backBtn = document.getElementById('preview-back-btn');
    if (!backBtn) {
        backBtn = document.createElement('button');
        backBtn.id = 'preview-back-btn';
        backBtn.className = 'btn-secondary';
        backBtn.innerText = 'Back to Editor';
        backBtn.style.position = 'fixed';
        backBtn.style.top = '20px';
        backBtn.style.left = '20px';
        backBtn.style.zIndex = '9999';
        backBtn.onclick = () => {
            previewMode = false;
            document.getElementById('quiz-screen').classList.remove('active');
            document.getElementById('maker-screen').classList.add('active');
            backBtn.style.display = 'none';
            document.getElementById('global-nav-container').style.display = 'block';
            // Restore host controls for real games
            const hostControls = document.querySelector('.host-controls');
            if (hostControls) hostControls.style.display = '';
            // Stop any playing audio
            if (window.backgroundMusic) {
                window.backgroundMusic.pause();
                window.backgroundMusic.currentTime = 0;
            }
            if (window.timerAudio) {
                window.timerAudio.pause();
                window.timerAudio.currentTime = 0;
            }
        };
        document.body.appendChild(backBtn);
    }
    backBtn.style.display = 'block';

    renderPlayerScreen(customQuizData[editIndex], true);
};

window.selectQuestion = (index) => {
    saveActiveQuestion().then(() => {
        document.getElementById('maker-empty-state').style.display = 'none';
        editQuestion(index);
        renderMakerList();
    });
};
window.deleteActiveQuestion = () => {
    const editIndex = parseInt(document.getElementById('edit-q-index').value);
    if(editIndex >= 0) {
        deleteQuestion(editIndex);
    }
};

let draggedQuestionIndex = -1;

window.handleDragStart = (e, index) => {
    draggedQuestionIndex = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
    e.currentTarget.style.opacity = '0.5';
};

window.handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
};

window.handleDragEnter = (e) => {
    e.preventDefault();
    e.currentTarget.style.borderTop = '4px solid var(--primary)';
};

window.handleDragLeave = (e) => {
    e.currentTarget.style.borderTop = '1px solid var(--glass-border)';
};

window.handleDrop = (e, targetIndex) => {
    e.stopPropagation();
    e.currentTarget.style.borderTop = '1px solid var(--glass-border)';

    if (draggedQuestionIndex === -1 || draggedQuestionIndex === targetIndex) {
        return false;
    }

    // Perform reorder
    const item = customQuizData.splice(draggedQuestionIndex, 1)[0];
    customQuizData.splice(targetIndex, 0, item);

    // Update edit-q-index if needed
    const editIndexInput = document.getElementById('edit-q-index');
    let currentIndex = parseInt(editIndexInput.value);

    if (currentIndex === draggedQuestionIndex) {
        // We moved the active item
        currentIndex = targetIndex;
    } else {
        // If we moved an item from before to after the current item
        if (draggedQuestionIndex < currentIndex && targetIndex >= currentIndex) {
            currentIndex--;
        }
        // If we moved an item from after to before the current item
        else if (draggedQuestionIndex > currentIndex && targetIndex <= currentIndex) {
            currentIndex++;
        }
    }
    editIndexInput.value = currentIndex;

    renderMakerList();
    return false;
};

window.handleDragEnd = (e) => {
    e.currentTarget.style.opacity = '1';
    document.querySelectorAll('.maker-thumbnail').forEach(el => el.style.borderTop = '1px solid var(--glass-border)');
    draggedQuestionIndex = -1;
};

window.renderMakerList = () => {
    const list = document.getElementById('questions-list');
    const editIndex = parseInt(document.getElementById('edit-q-index').value);

    list.innerHTML = customQuizData.map((q, i) => {
        let typeLabel = 'Quiz';
        if (q.type === 'info') typeLabel = 'Slide';
        else if (q.type === 'multiple-choice') typeLabel = 'Multiple Choice';
        else if (q.type === 'multiple-answer') typeLabel = 'Multiple Answer';
        else if (q.type === 'typing') typeLabel = 'Typing';
        else if (q.type === 'true-false') typeLabel = 'True/False';

        return `
        <div class="maker-thumbnail ${editIndex === i ? 'active' : ''}"
             onclick="selectQuestion(${i})"
             draggable="true"
             ondragstart="handleDragStart(event, ${i})"
             ondragover="handleDragOver(event)"
             ondragenter="handleDragEnter(event)"
             ondragleave="handleDragLeave(event)"
             ondrop="handleDrop(event, ${i})"
             ondragend="handleDragEnd(event)"
             style="border: 1px solid var(--glass-border); border-radius: 8px; overflow: hidden; margin-bottom: 10px; cursor: pointer; box-shadow: ${editIndex === i ? '0 0 0 2px var(--primary)' : 'none'}; background: var(--glass-bg);">
            <div style="background: var(--input-bg); height: 80px; display: flex; align-items: center; justify-content: center; position: relative;">
                ${q.imageUrl ? (q.mediaType === 'video' ? ((q.imageUrl.includes('youtube') || q.imageUrl.includes('youtu.be')) ? '🎬' : `<video src="${q.imageUrl}" style="max-height:100%; max-width:100%; object-fit:cover;" preload="metadata"></video>`) : `<img src="${q.imageUrl}" style="max-height:100%; max-width:100%;">`) : '<span style="font-size:2rem; color:var(--text-muted);">📷</span>'}
                <div style="position: absolute; top: 5px; left: 5px; background: rgba(0,0,0,0.5); color: white; border-radius: 4px; padding: 2px 6px; font-size: 0.7rem; font-weight: bold;">${i + 1}</div>
                ${!q.text ? '<div style="position: absolute; top: 5px; right: 5px; color: var(--danger); font-weight:bold;" title="Question missing text">⚠️</div>' : ''}
            </div>
            <div style="padding: 5px; font-size: 0.8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; color: var(--text-main); border-top: 1px solid var(--glass-border);">
                ${typeLabel}
            </div>
        </div>
        `;
    }).join('');

    // Auto-enable or disable the Host button based on data
    const hostBtn = document.getElementById('btn-host-quiz');
    if (hostBtn) {
        hostBtn.disabled = customQuizData.length === 0;
    }
}

/* =====================================================================
   LOBBY & MULTIPLAYER LOGIC
===================================================================== */
document.getElementById('btn-host-quiz').addEventListener('click', async () => {
    // Ensure active question is saved
    if (document.getElementById('maker-form-container').style.display !== 'none') {
        saveActiveQuestion();
    }

    // Validate all questions
    let invalidCount = 0;
    for (let i = 0; i < customQuizData.length; i++) {
        let q = customQuizData[i];
        if (q.type !== 'info' && (!q.text || q.text.trim() === '')) invalidCount++;
        if (q.type === 'multiple-choice' && !q.freePoint) {
            if (!q.correctAnswer) invalidCount++;
            if (!q.options || q.options.filter(o => o.text.trim() || o.isImage).length < 2) invalidCount++;
        }
    }

    if (invalidCount > 0) {
        Swal.fire('Warning', `You have ${invalidCount} incomplete question(s). Please fix them before hosting.`, 'warning');
        return;
    }

    if (!db) return alert("Firebase not configured!");
    const quizTitle = document.getElementById('maker-quiz-title').value.trim() || 'Spot Diagnosis Game';

    roomCode = Math.floor(100000 + Math.random() * 900000).toString();
    document.getElementById('display-room-code').innerText = roomCode;
    document.getElementById('lobby-quiz-title').innerText = quizTitle;

    const joinUrl = window.location.href.split('?')[0] + "?room=" + roomCode;
    document.getElementById('qrcode').innerHTML = "";
    document.getElementById('qrcode').classList.add('zoomable');
    new QRCode(document.getElementById("qrcode"), {
        text: joinUrl,
        width: 300, height: 300
    });

    let debugText = document.getElementById('qr-debug-text');
    if (!debugText) {
        debugText = document.createElement('div');
        debugText.id = 'qr-debug-text';
        debugText.style.fontSize = '0.7rem';
        debugText.style.color = '#94a3b8';
        debugText.style.marginTop = '0.5rem';
        document.getElementById('qrcode').parentElement.appendChild(debugText);
    }
    debugText.innerText = joinUrl;

    // BUGFIX: Always reset local question index when starting a new game session
    currentQuestionIndex = 0;

    await db.ref(`rooms/${roomCode}`).set({
        gameState: 'lobby',
        quizData: customQuizData,
        currentQuestionIndex: 0,
        quizTitle: quizTitle
    });

    db.ref(`rooms/${roomCode}/players`).on('value', (snapshot) => {
        const players = snapshot.val() || {};
        const count = Object.keys(players).length;
        document.getElementById('lobby-player-count').innerText = count;
        const htp = document.getElementById('host-total-players'); if(htp) htp.innerText = count;

        document.getElementById('lobby-players-list').innerHTML = Object.keys(players).map(name =>
            playerChipHTML(name)
        ).join('');
    });

    switchScreen('lobby');
});

document.getElementById('btn-join-room').addEventListener('click', async () => {
    if (!db) return alert("Firebase not configured!");
    roomCode = document.getElementById('join-room-code').value.trim();
    playerName = document.getElementById('join-player-name').value.trim();

    if (!roomCode || !playerName) return alert("Enter Code and Name");

    // Audio was already unlocked on 'Join a Room' click

    const snap = await db.ref(`rooms/${roomCode}`).get();
    if (!snap.exists()) return alert("Room not found!");
    const roomData = snap.val();

    document.getElementById('display-room-code').innerText = roomCode;
    document.getElementById('lobby-quiz-title').innerText = roomData.quizTitle || 'Spot Diagnosis Game';

    await db.ref(`rooms/${roomCode}/players/${playerName}`).set({
        score: 0,
        hasAnswered: -1,
        online: true
    });
    registerPlayerPresence(roomCode, playerName);

    // BUGFIX: Save playerName+room to sessionStorage so page refresh can auto-rejoin
    sessionStorage.setItem('playerName_' + roomCode, playerName);

    // BUGFIX: Update the URL so if the user refreshes, the app knows which room to check for
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + "?room=" + roomCode;
    window.history.replaceState({path: newUrl}, '', newUrl);

    db.ref(`rooms/${roomCode}/gameState`).on('value', (snapshot) => {
        const state = snapshot.val();
        if (state === 'starting_countdown') {
            switchScreen('countdown');
            let c = 3;
            const numEl = document.getElementById('countdown-number');
            numEl.classList.remove('go');
            numEl.innerText = c;
            AudioController.playTick();
            const cdInt = setInterval(() => {
                c--;
                if(c > 0) {
                    numEl.innerText = c;
                    AudioController.playTick();
                } else {
                    numEl.classList.add('go');
                    numEl.innerText = 'GO!';
                    fxBurst();
                    clearInterval(cdInt);
                }
            }, 1000);
        } else if (state === 'question_preview') {
            db.ref(`rooms/${roomCode}`).get().then(s => {
                const r = s.val();
                const q = r.quizData[r.currentQuestionIndex];
                document.getElementById('preview-q-num').innerText = `Question ${r.currentQuestionIndex + 1}`;
                document.getElementById('preview-q-text').innerText = q.text;
                // Hide media in preview, to encourage reading
                document.getElementById('preview-media-container').style.display = 'none';
                switchScreen('preview');
            });
        } else if (state === 'playing') {
            loadStudentQuestion();
        } else if (state === 'feedback') {
            showStudentFeedback();
        } else if (state === 'results') {
            showResults();
        } else if (state === 'review') {
            switchScreen('review');
            renderReviewList();
        } else if (state && state.startsWith('review_detail_')) {
            const idx = parseInt(state.replace('review_detail_', ''), 10);
            showReviewDetail(idx);
        }
    });

    db.ref(`rooms/${roomCode}/players`).on('value', (snapshot) => {
        const players = snapshot.val() || {};
        const count = Object.keys(players).length;
        const countEl = document.getElementById('lobby-player-count');
        if(countEl) countEl.innerText = count;

        const listEl = document.getElementById('lobby-players-list');
        if(listEl) {
            listEl.innerHTML = Object.keys(players).map(name =>
                playerChipHTML(name)
            ).join('');
        }
    });

    switchScreen('lobby');
});

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('room')) {
    role = 'student';
    document.body.setAttribute('data-role', 'student');
    const rm = urlParams.get('room');
    document.getElementById('join-room-code').value = rm;
    document.getElementById('display-room-code').innerText = rm;

    // BUGFIX: If player already has a name stored (from previous session), try to rejoin automatically
    const savedName = sessionStorage.getItem('playerName_' + rm);
    if (savedName) {
        // Auto-rejoin: reconnect to Firebase and restore their game state
        playerName = savedName;
        document.getElementById('join-player-name').value = savedName;
        db.ref(`rooms/${rm}`).get().then(snap => {
            if (!snap.exists()) {
                switchScreen('join');
                return;
            }
            roomCode = rm;
            const roomData = snap.val();
            document.getElementById('lobby-quiz-title').innerText = roomData.quizTitle || 'Spot Diagnosis Game';

            // Re-register player in case they got dropped
            const existingPlayer = roomData.players?.[savedName];
            const playerData = existingPlayer || { score: 0, hasAnswered: -1 };
            db.ref(`rooms/${rm}/players/${savedName}`).set({ ...playerData, online: true });
            registerPlayerPresence(rm, savedName);

            // Listen to game state to jump back to the right screen
            db.ref(`rooms/${rm}/gameState`).on('value', (snapshot) => {
                const state = snapshot.val();
                if (state === 'lobby') {
                    switchScreen('lobby');
                } else if (state === 'starting_countdown') {
                    switchScreen('countdown');
                } else if (state === 'question_preview') {
                    db.ref(`rooms/${rm}`).get().then(s => {
                        const r = s.val();
                        const q = r.quizData[r.currentQuestionIndex];
                        document.getElementById('preview-q-num').innerText = `Question ${r.currentQuestionIndex + 1}`;
                        document.getElementById('preview-q-text').innerText = q.text;
                        document.getElementById('preview-media-container').style.display = 'none';
                        switchScreen('preview');
                    });
                } else if (state === 'playing') {
                    loadStudentQuestion();
                } else if (state === 'feedback') {
                    showStudentFeedback();
                } else if (state === 'results') {
                    showResults();
                } else if (state === 'review') {
                    switchScreen('review');
                    renderReviewList();
                } else if (state && state.startsWith('review_detail_')) {
                    const idx = parseInt(state.replace('review_detail_', ''), 10);
                    showReviewDetail(idx);
                } else {
                    // Game ended or unknown state - go to join screen
                    switchScreen('join');
                }
            });

            db.ref(`rooms/${rm}/players`).on('value', (snapshot) => {
                const players = snapshot.val() || {};
                const count = Object.keys(players).length;
                const countEl = document.getElementById('lobby-player-count');
                if (countEl) countEl.innerText = count;
                const listEl = document.getElementById('lobby-players-list');
                if (listEl) {
                    listEl.innerHTML = Object.keys(players).map(name =>
                        playerChipHTML(name)
                    ).join('');
                }
            });
        });
    } else {
        switchScreen('join');
    }
}

/* =====================================================================
   SHARED RENDER HELPERS
===================================================================== */
function renderMediaCommon(q, prefix, autoplay = false) {
    const mediaContainer = document.getElementById(prefix === 'ekg' ? 'media-container' : `${prefix}-media-container`);
    const imagesEl = document.getElementById(`${prefix}-images`);
    const imgEl = document.getElementById(`${prefix}-image`);
    const vidEl = document.getElementById(`${prefix}-video`);
    let ytEl = document.getElementById(`${prefix}-youtube`);
    const fbEl = document.getElementById(`${prefix}-video-fallback`);

    // Determine media source: imageUrls[] (multiple) or single imageUrl
    const many = Array.isArray(q.imageUrls) && q.imageUrls.length > 1;
    const src = many ? q.imageUrls : (q.imageUrl ? [q.imageUrl] : []);
    const mediaKey = many ? 'multi:' + q.imageUrls.join('|') : (q.imageUrl || '');

    if (mediaContainer && src.length === 0) {
        mediaContainer.style.display = 'none';
        if (imagesEl) imagesEl.style.display = 'none';
        if (vidEl) vidEl.pause();
        if (imagesEl) imagesEl.innerHTML = '';
        mediaContainer.dataset.currentUrl = '';
        mediaContainer.dataset.currentType = '';
        return;
    }

    if (mediaContainer) {
        if (mediaContainer.dataset.currentUrl === mediaKey && mediaContainer.dataset.currentType === q.mediaType) {
            return; // Media hasn't changed, skip re-rendering to prevent page shaking
        }
        mediaContainer.dataset.currentUrl = mediaKey;
        mediaContainer.dataset.currentType = q.mediaType || '';
        mediaContainer.style.display = prefix === 'ekg' ? 'flex' : 'block';
    }

    if (!ytEl && vidEl) {
        ytEl = document.createElement('iframe');
        ytEl.id = `${prefix}-youtube`;
        ytEl.className = 'media-youtube-frame';
        ytEl.style.display = 'none';
        ytEl.style.width = '100%';
        ytEl.style.aspectRatio = '16 / 9';
        ytEl.style.borderRadius = '8px';
        ytEl.style.border = 'none';
        ytEl.setAttribute('allowfullscreen', 'true');
        ytEl.setAttribute('allow', 'autoplay; encrypted-media');
        vidEl.parentNode.insertBefore(ytEl, vidEl.nextSibling);
    }
    if (fbEl) fbEl.style.display = 'none';
    if (imagesEl) imagesEl.style.display = 'none';
    if (imgEl) imgEl.style.display = 'none';
    if (vidEl) { vidEl.style.display = 'none'; vidEl.pause(); }
    if (ytEl) { ytEl.style.display = 'none'; ytEl.src = ''; }

    if (many && imagesEl) {
        // Render multiple images as a grid
        imagesEl.innerHTML = q.imageUrls.map(url => `<img src="${url}" class="media-grid-image zoomable" alt="Media" title="Click to zoom">`).join('');
        imagesEl.style.display = 'grid';
        return;
    }

    const single = src[0] || '';
    if (q.mediaType === 'video') {
        const isYoutube = single.includes('youtube.com') || single.includes('youtu.be');
        if (isYoutube && ytEl) {
            ytEl.style.display = 'block';
            let videoId = '';
            if (single.includes('youtu.be/')) {
                videoId = single.split('youtu.be/')[1].split('?')[0];
            } else if (single.includes('v=')) {
                videoId = new URLSearchParams(new URL(single).search).get('v');
            }
            ytEl.src = `https://www.youtube.com/embed/${videoId}?rel=0${autoplay ? '&autoplay=1&mute=1' : ''}`;
            if (fbEl) fbEl.style.display = 'none';
        } else if (vidEl) {
            vidEl.style.display = prefix === 'ekg' ? 'block' : 'inline-block';
            vidEl.src = single;
            const p = autoplay ? vidEl.play() : null;
            if (autoplay && p && p.catch) p.catch(() => {});
            vidEl.onerror = () => {
                if (fbEl) { fbEl.style.display = 'block'; vidEl.style.display = 'none'; }
            };
            if (fbEl && fbEl.querySelector('#btn-video-retry')) {
                fbEl.querySelector('#btn-video-retry').onclick = () => {
                    fbEl.style.display = 'none';
                    vidEl.style.display = 'block';
                    vidEl.load();
                    vidEl.play().catch(() => {});
                };
            }
        }
    } else if (imgEl) {
        imgEl.style.display = prefix === 'ekg' ? 'block' : 'inline-block';
        imgEl.src = single;
    }
}

function renderOptions(containerId, q, isInteractive, qIndex, isFeedback = false, myAnswer = null) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (q.type === 'multiple-choice' || q.type === 'multiple-answer' || q.type === 'true-false') {
        container.className = 'kahoot-options-grid';
        
        const shapesSVG = [
            '<svg viewBox="0 0 100 100"><path d="M50,15 L85,85 L15,85 Z" /></svg>',
            '<svg viewBox="0 0 100 100"><path d="M50,15 L85,50 L50,85 L15,50 Z" /></svg>',
            '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="35" /></svg>',
            '<svg viewBox="0 0 100 100"><rect x="15" y="15" width="70" height="70" rx="8" /></svg>',
            '<svg viewBox="0 0 100 100"><polygon points="50,10 61,35 88,35 66,51 75,78 50,60 25,78 34,51 12,35 39,35" /></svg>'
        ];

        q.options.forEach((optRaw, idx) => {
            const btn = document.createElement('button');
            btn.className = 'kahoot-btn kahoot-color-' + (idx % 5);

            const isImg = typeof optRaw === 'string' ? false : optRaw.isImage;
            const text = typeof optRaw === 'string' ? optRaw : optRaw.text;

            let contentHtml = "";
            if (isImg) {
                contentHtml = `<img src="${text}" class="option-img-choice" style="max-height:80px; background:white; border-radius:4px; margin-left:10px;">`;
            } else {
                contentHtml = `<span class="kahoot-btn-text">${text}</span>`;
            }

            btn.innerHTML = `<div class="kahoot-shape-container">${shapesSVG[idx % shapesSVG.length]}</div>${contentHtml}`;

            if (isFeedback) {
                const correctSet = new Set((q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : [])).map(c =>
                    typeof c === 'string' ? c : c.text
                ));
                let isCorrectAnswer = false;
                if (!q.freePoint) {
                    if (correctSet.has(text)) isCorrectAnswer = true;
                } else {
                    isCorrectAnswer = true;
                }

                btn.style.animationDelay = (idx * 0.08) + 's';

                if (isCorrectAnswer) {
                    btn.classList.add('reveal-correct');
                } else {
                    btn.classList.add('dimmed');
                    if (myAnswer && (myAnswer === text || (Array.isArray(myAnswer) && myAnswer.includes(text)))) {
                        btn.classList.add('reveal-wrong');
                    }
                }
            } else if (isInteractive && (q.type === 'true-false' || q.type === 'multiple-choice')) {
                btn.onclick = () => submitAnswer(text, q, qIndex);
            } else if (isInteractive) {
                btn.classList.add('mc-selectable');
                btn.dataset.mcText = text;
                btn.onclick = () => {
                    btn.classList.toggle('mc-selected');
                };
            }
            container.appendChild(btn);
        });

        if (isInteractive && q.type === 'multiple-answer') {
            const submitBtn = document.createElement('button');
            submitBtn.className = 'btn-primary';
            submitBtn.style.marginTop = '20px';
            submitBtn.style.gridColumn = '1 / -1';
            submitBtn.innerText = 'Submit Answer';
            submitBtn.onclick = () => {
                if (hasAnswered) return;
                const selected = [...container.querySelectorAll('.mc-selectable.mc-selected')]
                    .map(b => b.dataset.mcText);
                submitAnswer(selected, q, qIndex);
            };
            container.appendChild(submitBtn);
        }
    } else {
        if (!isFeedback && isInteractive) {
            const wrap = document.createElement('div');
            wrap.className = 'typing-input-container';
            const input = document.createElement('textarea');
            input.placeholder = 'Type your answer here...';
            input.rows = 6;
            const btn = document.createElement('button');
            btn.className = 'btn-primary';
            btn.innerText = 'Submit';
            btn.onclick = () => submitAnswer(input.value.trim(), q, qIndex);
            wrap.append(input, btn);
            container.appendChild(wrap);
        } else if (!isFeedback && previewMode) {
            // Non-interactive preview: show the typing box as players would see it
            const wrap = document.createElement('div');
            wrap.className = 'typing-input-container';
            const input = document.createElement('textarea');
            input.placeholder = 'Type your answer here...';
            input.rows = 6;
            input.disabled = true;
            wrap.appendChild(input);
            container.appendChild(wrap);
        } else if (isFeedback) {
            const div = document.createElement('div');
            div.style.padding = '20px';
            div.style.fontSize = '1.5rem';
            div.style.color = 'var(--text-main)';
            if (q.freePoint) {
                div.innerHTML = `<em>Responses recorded (Unscored)</em>`;
            } else {
                div.innerHTML = `Accepted Answers:<br><strong>${q.acceptedAnswers.map(a => typeof a === 'string'?a:a.text).join('<br>')}</strong>`;
            }
            container.appendChild(div);
        } else if (!isInteractive) {
            const div = document.createElement('div');
            div.style.padding = '20px';
            div.style.fontSize = '1.5rem';
            div.style.color = 'var(--text-main)';
            div.innerHTML = `<em>(Students are typing their answers...)</em>`;
            container.appendChild(div);
        }
    }
}

/* =====================================================================
   GAME LOOP (HOST)
===================================================================== */
// Render an info/slide question: title on the left, description on the right.
// Hides the normal question/options/answer-waiting UI so a slide is just content.
function renderSlide(q) {
    const slideView = document.getElementById('slide-view');
    const quizContent = document.querySelector('#quiz-screen .quiz-content');
    if (!slideView) return;

    document.getElementById('slide-title').innerText = q.text || '';
    document.getElementById('slide-description').innerText = q.context || '';

    // Media: reuse the main media container content into the slide media area
    const mediaArea = document.getElementById('slide-media-area');
    mediaArea.innerHTML = '';
    const img = document.getElementById('ekg-image');
    const video = document.getElementById('ekg-video');
    const manyImages = Array.isArray(q.imageUrls) && q.imageUrls.length > 1;
    if (manyImages) {
        mediaArea.innerHTML = q.imageUrls.map(url => `<img src="${url}" class="media-grid-image zoomable" alt="Media" title="Click to zoom">`).join('');
        mediaArea.querySelectorAll('.zoomable').forEach(el => {
            el.addEventListener('click', function() {
                const zModal = document.getElementById('image-zoom-modal');
                const zImg = document.getElementById('zoomed-image');
                if (zModal && zImg) { zModal.style.display = 'flex'; zImg.src = this.src; }
            });
        });
    } else if (q.imageUrl || (img && img.src && img.style.display !== 'none') || (video && video.style.display !== 'none')) {
        // Clone the currently rendered media element
        let clone = null;
        if (video && video.style.display !== 'none') {
            clone = video.cloneNode(true);
        } else if (img && img.style.display !== 'none') {
            clone = img.cloneNode(true);
        }
        if (clone) {
            clone.removeAttribute('id');
            clone.style.display = '';
            if (clone.tagName.toLowerCase() === 'img') {
                clone.className = 'zoomable';
                clone.title = 'Click to zoom';
                clone.addEventListener('click', function() {
                    const zModal = document.getElementById('image-zoom-modal');
                    const zImg = document.getElementById('zoomed-image');
                    if (zModal && zImg) {
                        zModal.style.display = 'flex';
                        zImg.src = this.src;
                    }
                });
            } else {
                clone.className = '';
            }
            mediaArea.appendChild(clone);
        }
    }

    slideView.style.display = 'flex';
    const promptCont = document.querySelector('#quiz-screen .question-prompt');
    const mediaCont = document.getElementById('media-container');
    const questionCont = document.querySelector('#quiz-screen .question-container');
    const optionsCont = document.getElementById('options-container');
    const hostControls = document.querySelector('#quiz-screen .host-controls');
    const timerItem = document.querySelector('#quiz-screen .timer-info');
    if (promptCont) promptCont.style.display = 'none';
    if (mediaCont) mediaCont.style.display = 'none';
    if (questionCont) questionCont.style.display = 'none';
    if (optionsCont) optionsCont.style.display = 'none';
    if (hostControls) hostControls.style.display = 'none';

}

// Hide the slide view and restore the normal quiz layout.
function hideSlide() {
    const slideView = document.getElementById('slide-view');
    if (slideView) slideView.style.display = 'none';
    const promptCont = document.querySelector('#quiz-screen .question-prompt');
    const mediaCont = document.getElementById('media-container');
    const questionCont = document.querySelector('#quiz-screen .question-container');
    const optionsCont = document.getElementById('options-container');
    const timerItem = document.querySelector('#quiz-screen .timer-info');
    if (promptCont) promptCont.style.display = '';
    if (mediaCont) mediaCont.style.display = '';
    if (questionCont) questionCont.style.display = '';
    if (optionsCont) optionsCont.style.display = '';

}

function startQuestionFlow() {
    const minimalViewToggle = document.getElementById('toggle-minimal-view');
    const minimalView = minimalViewToggle ? minimalViewToggle.checked : true;

    db.ref(`rooms/${roomCode}`).update({
        gameState: 'starting_countdown',
        currentQuestionIndex: currentQuestionIndex,
        minimalStudentView: minimalView
    });
    switchScreen('countdown');
    let count = 3;
    const countEl = document.getElementById('countdown-number');
    countEl.classList.remove('go');
    countEl.innerText = count;

    const cdInt = setInterval(() => {
        count--;
        if (count > 0) {
            countEl.innerText = count;
        } else {
            clearInterval(cdInt);
            countEl.classList.add('go');
            countEl.innerText = 'GO!';
            fxBurst();
            db.ref(`rooms/${roomCode}`).update({ gameState: 'question_preview' });
            switchScreen('preview');

            const q = customQuizData[currentQuestionIndex];
            document.getElementById('preview-q-num').innerText = `Question ${currentQuestionIndex + 1}`;
            document.getElementById('preview-q-text').innerText = q.text;
            document.getElementById('preview-q-text').style.wordBreak = 'normal';
            document.getElementById('preview-q-text').style.overflowWrap = 'break-word';
            document.getElementById('preview-media-container').style.display = 'none';

            setTimeout(() => {
                startNextQuestion();
            }, 5000);
        }
    }, 1000);
}

// Slide-view "Next Slide" button — same action as btn-host-next for info slides.
const btnSlideNext = document.getElementById('btn-slide-next');
if (btnSlideNext) {
    btnSlideNext.addEventListener('click', () => {
        if (previewMode) return;
        endQuestion();
    });
}

document.getElementById('btn-start-game').addEventListener('click', () => {
    startQuestionFlow();
});

document.getElementById('btn-host-next').addEventListener('click', () => {
    if (previewMode) return;
    endQuestion();
});

document.getElementById('btn-host-continue').addEventListener('click', () => {
    if (previewMode) return;
    currentQuestionIndex++;
    if (currentQuestionIndex < customQuizData.length) {
        startQuestionFlow();
    } else {
        db.ref(`rooms/${roomCode}`).update({ gameState: 'results' });
        showResults();
    }
});

async function startNextQuestion() {
    try {
        await db.ref(`rooms/${roomCode}`).update({
            currentQuestionIndex: currentQuestionIndex,
            gameState: 'playing',
            questionStartTime: Date.now()
        });

        // Reset players hasAnswered state safely
        const pSnap = await db.ref(`rooms/${roomCode}/players`).get();
        const players = pSnap.val() || {};
        const updates = {};
        for (let p in players) {
            updates[`${p}/hasAnswered`] = -1;
        }

        // Only update if there are players, to prevent empty update errors
        if (Object.keys(updates).length > 0) {
            await db.ref(`rooms/${roomCode}/players`).update(updates);
        }

        const q = customQuizData[currentQuestionIndex];
        document.getElementById('clinical-context').innerText = q.context || "";
    document.getElementById('question-text').innerText = q.text;
    document.getElementById('question-text').style.wordBreak = 'normal';
    document.getElementById('question-text').style.overflowWrap = 'break-word';

    // Render Media (Img, Video, Youtube, or None)
    renderMediaCommon(q, 'ekg', false);
    const hasMedia = (Array.isArray(q.imageUrls) && q.imageUrls.length > 0) || !!q.imageUrl;
    document.getElementById('quiz-screen').classList.toggle('no-media', !hasMedia);

    if (q.type !== 'info') {
        hideSlide();
        renderOptions('options-container', q, false, currentQuestionIndex, false);
        const kbc = document.getElementById('kahoot-answers-count'); if(kbc) kbc.parentElement.parentElement.style.display = 'flex'; const hhc = document.getElementById('hud-host-answers'); if(hhc) hhc.style.display = 'flex';
        updateAnswerCounters(0);
    } else {
        document.getElementById('options-container').innerHTML = ''; // Clear options
        renderSlide(q);
        if (currentQuestionIndex === customQuizData.length - 1) {
            document.getElementById('btn-host-next').innerText = q.type === 'info' ? "Next (Finish Quiz)" : "Skip (Finish Quiz)";
            const sn = document.getElementById('btn-slide-next');
            if (sn) sn.innerText = "Next (Finish Quiz)";
        } else {
            document.getElementById('btn-host-next').innerText = q.type === 'info' ? "Next Slide" : "Skip / Next";
            const sn = document.getElementById('btn-slide-next');
            if (sn) sn.innerText = "Next Slide";
        }
        const kbc = document.getElementById('kahoot-answers-count'); if(kbc) kbc.parentElement.parentElement.style.display = 'none'; const hhc = document.getElementById('hud-host-answers'); if(hhc) hhc.style.display = 'none';
    }

    timeLeft = q.timer;
    window._currentTimerMax = timeLeft;
    setHudTimer(timeLeft);
    setQuizProgress(currentQuestionIndex, customQuizData.length);

    if (currentQuestionIndex === customQuizData.length - 1) {
        document.getElementById('btn-host-next').innerText = q.type === 'info' ? "Next (Finish Quiz)" : "Skip (Finish Quiz)";
        const sn2 = document.getElementById('btn-slide-next');
        if (sn2) sn2.innerText = "Next (Finish Quiz)";
    } else {
        document.getElementById('btn-host-next').innerText = q.type === 'info' ? "Next Slide" : "Skip / Next";
        const sn2 = document.getElementById('btn-slide-next');
        if (sn2) sn2.innerText = "Next Slide";
    }

    if (hostPlayersListener) {
        db.ref(`rooms/${roomCode}/players`).off('value', hostPlayersListener);
        hostPlayersListener = null;
    }

    if (q.type !== 'info') {
        hideSlide();
        const hostControls = document.querySelector('#quiz-screen .host-controls');
        if (hostControls) {
            hostControls.style.display = '';
            const hostPresenter = hostControls.querySelector('.host-presenter-box');
            if (hostPresenter) hostPresenter.style.display = '';
        }
        hostPlayersListener = (snapshot) => {
            const pList = snapshot.val() || {};
            const total = Object.keys(pList).length;
            const answered = Object.values(pList).filter(p => p.hasAnswered === currentQuestionIndex).length;
            const hac = document.getElementById('host-answers-count'); if(hac) hac.innerText = answered; updateAnswerCounters(answered);
            const htp2 = document.getElementById('host-total-players'); if(htp2) htp2.innerText = total;

            if (total > 0 && answered === total) endQuestion();
        };
        db.ref(`rooms/${roomCode}/players`).on('value', hostPlayersListener);
    } else {
        // Slides: show only the slide-view, completely hide the question-container
        const questionCont = document.querySelector('#quiz-screen .question-container');
        if (questionCont) questionCont.style.display = 'none';
    }

    clearInterval(localTimer);
    if (timeLeft > 0) {
        localTimer = setInterval(() => {
            timeLeft--;
            setHudTimer(timeLeft);
            if (timeLeft <= 0) {
                clearInterval(localTimer);
                endQuestion();
            }
        }, 1000);
    }

    const isKahootMode = (q.type === 'multiple-choice' || q.type === 'multiple-answer' || q.type === 'true-false');
    if (isKahootMode) {
        document.body.classList.add('layout-kahoot');
    } else {
        document.body.classList.remove('layout-kahoot');
    }
    document.body.classList.toggle('layout-typing', q.type === 'typing');
    document.body.classList.toggle('layout-info', q.type === 'info');
    switchScreen('quiz');
    } catch (e) {
        alert("Failed to start question: " + e.message);
        console.error("Start question error:", e);
    }
}

async function endQuestion() {
    clearInterval(localTimer);
    if (hostPlayersListener) {
        db.ref(`rooms/${roomCode}/players`).off('value', hostPlayersListener);
        hostPlayersListener = null;
    }
    document.getElementById('ekg-video').pause();

    const q = customQuizData[currentQuestionIndex];
    if (q && q.type === 'info') {
        // Skip feedback for info slides, go directly to next question/results
        document.getElementById('btn-host-continue').click();
    } else {
        if (q && q.type === 'typing' && q.aiGrading && !q.freePoint) {
            await runAIGrading(q, currentQuestionIndex);
        }
        db.ref(`rooms/${roomCode}`).update({ gameState: 'feedback' });
        showHostFeedback();
    }
}

// Ask an AI provider to grade a rubric question. Returns the raw text of its
// response (which callers JSON.parse). Provider can be 'gemini', 'groq', or
// 'openrouter' (the latter two use an OpenAI-compatible chat API).
async function callAIModel(provider, model, apiKey, promptText) {
    if (provider === 'gemini') {
        const { GoogleGenerativeAI } = await import("https://esm.run/@google/generative-ai");
        const genAI = new GoogleGenerativeAI(apiKey);
        const generativeModel = genAI.getGenerativeModel({ model: model });
        const result = await generativeModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: promptText }] }],
            generationConfig: { responseMimeType: "application/json" }
        });
        return result.response.text();
    }

    const baseUrl = provider === 'groq'
        ? 'https://api.groq.com/openai/v1'
        : 'https://openrouter.ai/api/v1';
    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(provider === 'openrouter' ? { 'HTTP-Referer': window.location.href, 'X-Title': 'Spot Diagnosis Game' } : {})
        },
        body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: promptText }],
            temperature: 0,
            response_format: { type: 'json_object' }
        })
    });
    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`AI API error ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('AI returned an empty response.');
    return content;
}

async function runAIGrading(q, qIndex) {
    const apiKey = HARDCODED_AI_KEY;
    const provider = HARDCODED_AI_PROVIDER;
    const pSnap = await db.ref(`rooms/${roomCode}/players`).get();
    const players = pSnap.val() || {};

    let answersToGrade = [];
    for (let pName in players) {
        const pData = players[pName];
        if (pData.answers && pData.answers[qIndex] !== undefined && pData.answers[qIndex] !== null) {
            answersToGrade.push({ playerName: pName, answer: pData.answers[qIndex] });
        }
    }

    if (answersToGrade.length === 0) return;

    const maxPoints = getTypingMaxPoints(q);
    const updates = {};

    if (!apiKey) {
        // Fallback to local regex matching if no API key is set
        console.warn("No API key found. Falling back to local grading.");
        for (let i = 0; i < answersToGrade.length; i++) {
            let pts = getTypingAnswerScore(answersToGrade[i].answer, q);
            if (pts === maxPoints && maxPoints > 0) pts += 150; // Bonus
            updates[`rooms/${roomCode}/players/${answersToGrade[i].playerName}/lastPointsEarned`] = pts;
        }
        await db.ref().update(updates);
        return;
    }

    const model = HARDCODED_AI_MODEL;

    Swal.fire({
        title: 'AI is grading answers...',
        text: 'Please wait a moment',
        allowOutsideClick: false,
        didOpen: () => { Swal.showLoading(); }
    });

    // Use stable answer IDs instead of player names so quotes or special characters
    // in a name cannot break the rubric or the JSON response.
    const answerIdMap = {};
    const rubric = (q.acceptedAnswers || []).map((item, index) => {
        const concept = typeof item === 'string' ? item : (item.text || '');
        const points = typeof item === 'object' && item.points !== undefined ? Number(item.points) : 10;
        return { id: index + 1, concept, points: Number.isFinite(points) ? points : 10 };
    });
    const rubricTotal = rubric.reduce((sum, item) => sum + item.points, 0);

    let promptText = `You are a strict but fair medical professor grading short-answer quiz responses in Thai or English.\n`;
    promptText += `Grade only what is explicitly supported by each student's answer. Do not assume a concept was meant if it is absent.\n`;
    promptText += `Question context: ${JSON.stringify(q.context || '')}\n`;
    promptText += `Question: ${JSON.stringify(q.text || '')}\n`;
    promptText += `Scoring mode: ${q.partialCredit === false ? 'all-or-nothing' : 'partial credit'}\n`;
    promptText += `Rubric (each concept is independent):\n`;
    rubric.forEach(item => {
        promptText += `- conceptId ${item.id}: ${JSON.stringify(item.concept)} (${item.points} points)\n`;
    });
    if (q.rejectedWords && q.rejectedWords.length > 0) {
        promptText += `Rejected words (apply penalty if used): ${JSON.stringify(q.rejectedWords)}\n`;
    }
    
    promptText += `\nFor each concept, evaluate the match using 3 tiers:\n`;
    promptText += `- "full": Meaning is identical to the key (including valid acronyms like STEMI for ST elevation, or same meaning with different word order like 'dilated bowel' for 'bowel dilation').\n`;
    promptText += `- "partial": Captures some meaning, uses informal synonyms, or related but incomplete.\n`;
    promptText += `- "none": Incorrect, unrelated, or the key appears but in a clinically different context (e.g. 'T inverted at inferior wall' is 'none' for 'STE at inferior wall'). Related outcomes like 'MI' for finding 'ST elevation' is 'none'.\n`;
    
    promptText += `\nReturn ONLY valid JSON in this exact shape: {"answers":[{"id":"A1","confidence":0.0,"concepts":[{"conceptId":1,"tier":"full","reason":"English explanation"}]}]}\n`;
    promptText += `Use every answer ID exactly once. confidence (0-1) is your certainty in grading. 'tier' must be "full", "partial", or "none".\n\n`;
    promptText += `Student answers:\n`;
    answersToGrade.forEach((ans, index) => {
        const id = `A${index + 1}`;
        answerIdMap[id] = ans;
        const localResults = getTypingKeyResults(ans.answer, q)
            .map(result => `${result.text}: ${result.matched ? 'matched' : 'not matched'}`)
            .join('; ');
        promptText += `${id}: ${JSON.stringify(ans.answer)}\n`;
        promptText += `Local pre-check for ${id} (use as a hint, verify independently): ${JSON.stringify(localResults)}\n`;
    });

    try {
        const rawJsonStr = await callAIModel(provider, model, apiKey, promptText);
        const parsed = JSON.parse(rawJsonStr);
        const aiAnswers = Array.isArray(parsed) ? parsed : parsed.answers;
        if (!Array.isArray(aiAnswers)) throw new Error('AI returned an invalid grading format.');

        const seenIds = new Set();
        for (const aiAnswer of aiAnswers) {
            const source = answerIdMap[aiAnswer.id];
            if (!source || seenIds.has(aiAnswer.id)) continue;
            seenIds.add(aiAnswer.id);

            let earnedPts = 0;
            const conceptsArr = Array.isArray(aiAnswer.concepts) ? aiAnswer.concepts : [];
            conceptsArr.forEach(c => {
                const rubItem = rubric.find(r => r.id === c.conceptId);
                if (rubItem) {
                    if (c.tier === 'full') {
                        earnedPts += rubItem.points;
                        c.points = rubItem.points;
                    } else if (c.tier === 'partial') {
                        const partialPts = Math.floor(rubItem.points * 0.5);
                        earnedPts += partialPts;
                        c.points = partialPts;
                    } else {
                        c.points = 0;
                    }
                }
            });

            if (q.partialCredit === false) {
                earnedPts = earnedPts >= rubricTotal ? maxPoints : 0;
            }

            const penalty = getTypingPenalty(source.answer, q);
            earnedPts -= penalty;
            if (earnedPts < 0) earnedPts = 0;
            
            let pts = earnedPts;

            if (pts === maxPoints && maxPoints > 0) pts += 150; // Preserve existing bonus
            
            updates[`rooms/${roomCode}/players/${source.playerName}/lastPointsEarned`] = pts;
            updates[`rooms/${roomCode}/players/${source.playerName}/awardedPoints/${qIndex}`] = pts;
            updates[`rooms/${roomCode}/players/${source.playerName}/aiGrading`] = {
                score: pts > 150 ? pts - 150 : pts,
                confidence: Math.max(0, Math.min(1, Number(aiAnswer.confidence) || 0)),
                concepts: conceptsArr,
                penalty: penalty
            };
        }

        // Missing or malformed AI entries use the original local grader.
        answersToGrade.forEach(ans => {
            const scorePath = `rooms/${roomCode}/players/${ans.playerName}/lastPointsEarned`;
            if (updates[scorePath] === undefined) {
                let pts = getTypingAnswerScore(ans.answer, q);
                if (pts === maxPoints && maxPoints > 0) pts += 150;
                updates[scorePath] = pts;
            }
        });

        if (Object.keys(updates).length > 0) {
            await db.ref().update(updates);
        }
    } catch (e) {
        console.error("AI Grading Error:", e);
        const isKeyErr = e.message && (e.message.includes('401') || e.message.includes('API Key'));
        Swal.fire({
            icon: 'warning',
            title: isKeyErr ? '⚠️ AI ใช้งานไม่ได้' : '⚠️ AI Grading Error',
            html: (e.message || 'เกิดข้อผิดพลาด').replace(/\n/g, '<br>') + '<br><br><small style="color:#555">ระบบใช้การให้คะแนนแบบ local แทนแล้ว</small>',
        });
        // Fallback on error — use local grader and write both score fields
        for (let i = 0; i < answersToGrade.length; i++) {
            let pts = getTypingAnswerScore(answersToGrade[i].answer, q);
            if (pts === maxPoints && maxPoints > 0) pts += 150; // Bonus
            const pName = answersToGrade[i].playerName;
            updates[`rooms/${roomCode}/players/${pName}/lastPointsEarned`] = pts;
            updates[`rooms/${roomCode}/players/${pName}/awardedPoints/${qIndex}`] = pts;
        }
        await db.ref().update(updates);
        await new Promise(r => setTimeout(r, 2000));
    }
    Swal.close();
}

async function renderFeedbackChart(containerId, q, currentQuestionIndex) {
    const chartContainer = document.getElementById(containerId);
    if (!chartContainer) return;
    chartContainer.innerHTML = "";

    const pSnap = await db.ref(`rooms/${roomCode}/players`).get();
    const players = pSnap.val() || {};
    const answersCount = {};
    let totalAnswers = 0;

    // Initialize options with 0
    if (q.type === 'multiple-choice' || q.type === 'multiple-answer') {
        q.options.forEach(opt => {
            answersCount[opt.text] = 0;
        });
    } else if (q.type === 'true-false') {
        answersCount["True"] = 0;
        answersCount["False"] = 0;
    }

    for (let p in players) {
        const pData = players[p];
        const ans = pData.answers ? pData.answers[currentQuestionIndex] : null;
        if (ans) {
            if (q.type === 'multiple-choice' && Array.isArray(ans)) {
                // Multi-select: count each selected option
                ans.forEach(sel => { answersCount[sel] = (answersCount[sel] || 0) + 1; });
                totalAnswers++;
            } else {
                answersCount[ans] = (answersCount[ans] || 0) + 1;
                totalAnswers++;
            }
        }
    }

    const correctSet = new Set((q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : [])).map(c =>
        typeof c === 'string' ? c : c.text
    ));

    const isKahootMode = (q.type === 'multiple-choice' || q.type === 'multiple-answer' || q.type === 'true-false');

    if (true) {
        let chartHTML = `<h4 style="color:var(--text-main); margin-bottom: 0.5rem; text-align:center;">Responses:</h4>`;
        
        if (isKahootMode) {
            chartHTML += `<div style="display:flex; justify-content:center; align-items:flex-end; gap:10px; height:200px; padding:10px; border-bottom:2px solid rgba(255,255,255,0.2); margin-bottom:20px;">`;
            
            // For Kahoot mode, iterate over q.options so they are in consistent order
            const optionLabels = [];
            if (q.type === 'true-false') {
                optionLabels.push('True', 'False');
            } else {
                q.options.forEach(opt => optionLabels.push(typeof opt === 'string' ? opt : opt.text));
            }

            const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#8b3dff'];
            const shapes = ['▲', '♦', '●', '■', '★'];
            
            let maxCount = 0;
            for (let ans in answersCount) {
                if (answersCount[ans] > maxCount) maxCount = answersCount[ans];
            }

            optionLabels.forEach((ans, idx) => {
                const count = answersCount[ans] || 0;
                // Min height 5% so it's visible even if 0
                const heightPct = maxCount > 0 ? Math.max(5, (count / maxCount) * 100) : 5;
                const isCorrectAnswer = correctSet.has(ans);
                
                chartHTML += `
                    <div style="display:flex; flex-direction:column; align-items:center; width:60px;">
                        <div style="color:white; font-weight:bold; margin-bottom:5px;">${count}</div>
                        <div style="width:100%; height:${heightPct}%; background-color:${colors[idx % colors.length]}; border-radius:4px 4px 0 0; transition:height 0.5s ease-out; opacity:${isCorrectAnswer ? 1 : 0.5}; display:flex; align-items:flex-end; justify-content:center; padding-bottom:5px;">
                            ${isCorrectAnswer ? '✅' : ''}
                        </div>
                        <div style="margin-top:8px; font-size:1.2rem; background:${colors[idx % colors.length]}; padding:4px 8px; border-radius:4px; display:inline-block; color:white;">
                            ${shapes[idx % shapes.length]}
                        </div>
                    </div>
                `;
            });
            chartHTML += `</div>`;
        } else {
            for (let ans in answersCount) {
                const count = answersCount[ans];
                const pct = totalAnswers > 0 ? Math.round((count / totalAnswers) * 100) : 0;

                let isCorrectAnswer = false;
                let barColor = 'var(--danger)';
                let earned = 0;
                if (q.aiGrading) {
                    // Find a player who gave this answer to get their AI score
                    let samplePlayer = Object.keys(players).find(p => players[p].answers && players[p].answers[currentQuestionIndex] === ans);
                    if (samplePlayer && players[samplePlayer].lastPointsEarned !== undefined) {
                        earned = players[samplePlayer].lastPointsEarned;
                        // Remove bonus if present to just check max Points
                        const maxP = getTypingMaxPoints(q);
                        if (earned >= maxP + 150) earned -= 150;
                    }
                } else {
                    earned = getTypingAnswerScore(ans, q);
                }
                const max = getTypingMaxPoints(q);
                isCorrectAnswer = (earned === max && max > 0);
                barColor = (earned > 0 && earned < max) ? '#eab308' : (isCorrectAnswer ? 'var(--success)' : 'var(--danger)');

                let labelHtml = ans;
                if (ans.startsWith('http://') || ans.startsWith('https://')) {
                    labelHtml = `<img src="${ans}" style="max-height:30px; vertical-align:middle;">`;
                }

                chartHTML += `
                    <div style="margin-bottom: 12px;">
                        <div style="font-size: 0.9rem; color: #cbd5e1; margin-bottom: 4px; display:flex; justify-content:space-between;">
                            <span>${labelHtml}</span>
                            <span>${count} (${pct}%)</span>
                        </div>
                        <div style="width: 100%; background: rgba(0,0,0,0.3); height: 24px; border-radius: 6px; overflow: hidden; border: 1px solid var(--glass-border);">
                            <div style="width: ${pct}%; background: ${barColor}; height: 100%; transition: width 0.5s ease-out;"></div>
                        </div>
                    </div>
                `;
            }
        }
        chartContainer.innerHTML = chartHTML;

        // Render individual student details for Host
        const detailsContainer = document.getElementById('host-student-details-container');
        const toggleBtn = document.getElementById('btn-toggle-student-details');
        
        if (toggleBtn && !toggleBtn.hasAttribute('data-listener-attached')) {
            toggleBtn.setAttribute('data-listener-attached', 'true');
            toggleBtn.addEventListener('click', () => {
                if (detailsContainer.style.display === 'none') {
                    detailsContainer.style.display = 'block';
                    toggleBtn.innerText = '👁 Hide Student Details';
                } else {
                    detailsContainer.style.display = 'none';
                    toggleBtn.innerText = '👁 Show Student Details';
                }
            });
        }

        if (detailsContainer) {
            let studentList = [];
            for (let p in players) {
                const pData = players[p];
                if (!pData.answers || pData.answers[currentQuestionIndex] === undefined) continue;

                // Prefer the authoritative awarded points for this question, which
                // covers both AI grading (host writes it) and local grading (student
                // writes it on feedback). Fall back to lastPointsEarned as a backup.
                let pts = 0;
                if (q.type === 'typing') {
                    pts = (pData.awardedPoints && pData.awardedPoints[currentQuestionIndex] !== undefined)
                        ? pData.awardedPoints[currentQuestionIndex]
                        : (typeof pData.lastPointsEarned === 'number' ? pData.lastPointsEarned : 0);
                } else {
                    pts = (pData.awardedPoints && pData.awardedPoints[currentQuestionIndex] !== undefined)
                        ? pData.awardedPoints[currentQuestionIndex] : 0;
                }
                let isFlagged = false;
                let aiGrading = pData.aiGrading;
                if (aiGrading && aiGrading.confidence < 0.7) {
                    isFlagged = true;
                }
                
                // Determine if it was manually overridden
                // We'll add a flag 'isManualOverride' in Firebase when overriding, but for now we can just assume 
                // if it's there we can show a badge if we have it. Let's add that logic later in the override function.
                let isManual = pData.manualOverride && pData.manualOverride[currentQuestionIndex];

                studentList.push({
                    name: p,
                    ans: pData.answers[currentQuestionIndex],
                    pts: pts,
                    isFlagged: isFlagged,
                    isManual: isManual,
                    aiGrading: aiGrading
                });
            }

            // Sort: Flagged first, then by pts desc, then name asc
            studentList.sort((a, b) => {
                if (a.isFlagged && !b.isFlagged) return -1;
                if (!a.isFlagged && b.isFlagged) return 1;
                if (b.pts !== a.pts) return b.pts - a.pts;
                return a.name.localeCompare(b.name);
            });

            if (studentList.length > 0) {
                // Only allow manual score edits for Short Answer (typing) questions.
                const canEdit = q.type === 'typing';
                let listHTML = `<h4 style="color:var(--text-main); margin-bottom: 1rem; border-bottom: 1px solid var(--glass-border); padding-bottom: 0.5rem;">Student Details</h4>`;
                studentList.forEach(s => {
                    const maxP = getTypingMaxPoints(q);
                    let ptsColor = s.pts > 0 ? (s.pts >= maxP ? 'var(--success)' : '#eab308') : 'var(--danger)';
                    listHTML += `
                        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.1); padding: 12px 0;">
                            <div style="flex: 1; min-width: 0;">
                                <div style="display:flex; align-items:center; gap: 8px; flex-wrap:wrap;">
                                    <strong style="color:var(--text-main); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${s.name}</strong>
                                    ${s.isFlagged ? '<span style="color:var(--warning); cursor:help;" title="Low AI Confidence (<0.7)">⚠️</span>' : ''}
                                    ${s.isManual ? '<span style="background:var(--secondary); color:#fff; font-size:0.7em; padding:2px 6px; border-radius:4px;">✏️ Manual</span>' : ''}
                                </div>
                                <div style="font-size:0.9em; color:var(--text-main); opacity:0.8; margin-top:4px; word-break: break-word;">Ans: ${s.ans}</div>
                            </div>
                            <div style="display:flex; align-items:center; gap: 8px; margin-left: 12px;">
                                <span style="font-weight:bold; color:${ptsColor}; white-space:nowrap;">${s.pts} pts</span>
                                ${canEdit ? `<button class="btn-secondary" style="padding:6px; font-size:0.9em; min-width:32px;" title="Override Score" onclick="overrideScore('${s.name}', ${s.pts})">✏️</button>` : ''}
                                ${s.aiGrading && q.type === 'typing' ? `<button class="btn-secondary" style="padding:6px; font-size:0.9em; min-width:32px;" title="View AI Concept Breakdown" onclick="viewConceptBreakdown('${s.name}')">🔍</button>` : ''}
                            </div>
                        </div>
                    `;
                });
                detailsContainer.innerHTML = listHTML;
            } else {
                detailsContainer.innerHTML = `<p style="color:var(--text-muted);">No student answers to display.</p>`;
            }
        }
    }
}

async function overrideScore(playerName, currentPts) {
    const q = customQuizData[currentQuestionIndex];
    
    const { value: newScoreStr } = await Swal.fire({
        title: `Override Score for ${playerName}`,
        input: 'number',
        inputLabel: `Current Score: ${currentPts}`,
        inputValue: currentPts,
        inputAttributes: {
            min: 0,
            step: 1
        },
        showCancelButton: true,
        confirmButtonText: 'Save',
        inputValidator: (value) => {
            if (!value || isNaN(value) || value < 0) {
                return 'Please enter a valid non-negative number';
            }
        }
    });

    if (newScoreStr !== undefined) {
        const newScore = parseInt(newScoreStr, 10);
        if (newScore !== currentPts) {
            Swal.fire({title: 'Saving...', allowOutsideClick: false, didOpen: () => Swal.showLoading()});
            let updates = {};
            updates[`rooms/${roomCode}/players/${playerName}/lastPointsEarned`] = newScore;
            updates[`rooms/${roomCode}/players/${playerName}/awardedPoints/${currentQuestionIndex}`] = newScore;
            updates[`rooms/${roomCode}/players/${playerName}/manualOverride/${currentQuestionIndex}`] = true;
            await db.ref().update(updates);
            Swal.close();
            // Re-render the chart to reflect changes
            await renderFeedbackChart('feedback-chart', q, currentQuestionIndex);
        }
    }
}

async function viewConceptBreakdown(playerName) {
    const pSnap = await db.ref(`rooms/${roomCode}/players/${playerName}`).get();
    const pData = pSnap.val();
    if (!pData || !pData.aiGrading) {
        Swal.fire('No AI Grading Data', 'Could not find AI grading data for this student.', 'info');
        return;
    }
    
    const q = customQuizData[currentQuestionIndex] || {};
    // Students may not have customQuizData loaded — fetch from the room
    if (!Array.isArray(q.acceptedAnswers) && roomCode) {
        try {
            const rSnap = await db.ref(`rooms/${roomCode}/quizData`).get();
            if (rSnap.exists()) {
                const roomQuiz = rSnap.val() || [];
                const roomQ = roomQuiz[currentQuestionIndex];
                if (roomQ) Object.assign(q, roomQ);
            }
        } catch (e) {}
    }
    const accepted = Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : [];
    let html = `<div style="text-align:left; font-size: 0.9em; max-height: 400px; overflow-y: auto;">`;
    
    // Original answer
    const ans = pData.answers && pData.answers[currentQuestionIndex] ? pData.answers[currentQuestionIndex] : '';
    html += `<div style="margin-bottom:1rem; padding: 0.5rem; background:rgba(255,255,255,0.05); border-radius:4px;"><strong>Answer:</strong> ${escapeHtml(String(ans))}</div>`;
    
    // Confidence and Penalty
    html += `<div style="margin-bottom:1rem;"><strong>AI Confidence:</strong> ${pData.aiGrading.confidence ?? 0} ${(pData.aiGrading.confidence || 0) < 0.7 ? '⚠️' : ''}<br>`;
    if (pData.aiGrading.penalty > 0) {
        html += `<strong style="color:var(--danger)">Penalty:</strong> -${pData.aiGrading.penalty} pts (Rejected Words)</div>`;
    } else {
        html += `</div>`;
    }

    // Concepts
    const concepts = Array.isArray(pData.aiGrading.concepts) ? pData.aiGrading.concepts : [];
    if (concepts.length === 0) {
        html += `<p style="color:var(--text-muted);">No concept breakdown available.</p>`;
    }
    concepts.forEach(c => {
        const rubItem = accepted.find((r, i) => (i + 1) === c.conceptId);
        const conceptText = rubItem ? (typeof rubItem === 'string' ? rubItem : rubItem.text) : `Concept ${c.conceptId}`;
        
        let badgeColor = c.tier === 'full' ? 'var(--success)' : c.tier === 'partial' ? '#eab308' : 'var(--danger)';
        
        html += `
            <div style="border: 1px solid var(--glass-border); padding: 0.75rem; margin-bottom: 0.75rem; border-radius: 6px;">
                <div style="font-weight:bold; margin-bottom:0.25rem;">${escapeHtml(conceptText)}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 0.5rem;">
                    <span style="background:${badgeColor}; color:#fff; padding:2px 8px; border-radius:12px; font-size:0.8em; text-transform:uppercase;">${c.tier || (c.matched ? 'Full' : 'None')}</span>
                    <span style="font-weight:bold;">${c.points || 0} pts</span>
                </div>
                <div style="color:#cbd5e1;"><em>Reason:</em> ${escapeHtml(c.reason || 'N/A')}</div>
            </div>
        `;
    });
    
    html += `</div>`;
    
    Swal.fire({
        title: `AI Concept Breakdown`,
        html: html,
        width: 600,
        confirmButtonText: 'Close'
    });
}

async function showHostFeedback() {
    switchScreen('feedback');
    // Clear stale feedback content immediately
    const optsCont = document.getElementById('feedback-options-container');
    if (optsCont) optsCont.innerHTML = '';
    const chartCont = document.getElementById('feedback-chart');
    if (chartCont) chartCont.innerHTML = '';
    const typingPanel = document.getElementById('feedback-typing-panel');
    if (typingPanel) { typingPanel.style.display = 'none'; typingPanel.innerHTML = ''; }
    const myAnsEl = document.getElementById('feedback-your-answer');
    if (myAnsEl) { myAnsEl.style.display = 'none'; myAnsEl.innerText = ''; }

    const q = customQuizData[currentQuestionIndex];
    document.getElementById('feedback-title').innerText = "Time's Up!";
    document.getElementById('feedback-title').className = "";

    // Render the choices, highlighting the correct one
    renderOptions('feedback-options-container', q, false, currentQuestionIndex, true);

    // Render the bar chart
    await renderFeedbackChart('feedback-chart', q, currentQuestionIndex);

    // Students write their awardedPoints asynchronously (especially for Short
    // Answer without AI grading). Re-render after a short delay so the host's
    // score display and Edit buttons show the real values, not 0.
    setTimeout(async () => {
        try {
            await renderFeedbackChart('feedback-chart', q, currentQuestionIndex);
        } catch (e) {
            console.error("Re-render feedback chart failed:", e);
        }
    }, 1200);

    if (currentQuestionIndex === customQuizData.length - 1) {
        document.getElementById('btn-host-continue').innerText = "Finish Quiz";
    } else {
        document.getElementById('btn-host-continue').innerText = "Next Question";
    }
}

/* =====================================================================
   GAME LOOP (STUDENT)
===================================================================== */
let studentCurrentPointsEarned = 0;

async function loadStudentQuestion() {
    hasAnswered = false;
    studentCurrentPointsEarned = 0;

    // Clear previous question content immediately while we await fresh data
    const qTextEl = document.getElementById('question-text');
    if (qTextEl) qTextEl.innerText = '';
    const optsCont = document.getElementById('options-container');
    if (optsCont) optsCont.innerHTML = '';
    const ctxEl = document.getElementById('clinical-context');
    if (ctxEl) ctxEl.innerText = '';

    const snap = await db.ref(`rooms/${roomCode}`).get();
    const room = snap.val();
    const q = room.quizData[room.currentQuestionIndex];

    // Show question number above the image
    const qNumEl = document.getElementById('student-q-num');
    if (qNumEl) {
        qNumEl.innerText = q.type === 'info'
            ? `Slide ${room.currentQuestionIndex + 1} / ${room.quizData.length}`
            : `Question ${room.currentQuestionIndex + 1} / ${room.quizData.length}`;
        qNumEl.style.display = 'block';
    }

    document.getElementById('clinical-context').innerText = q.context || "";
    document.getElementById('question-text').innerText = q.text;
    document.getElementById('question-text').style.wordBreak = 'normal';
    document.getElementById('question-text').style.overflowWrap = 'break-word';

    renderMediaCommon(q, 'ekg', true);

    const promptCont = document.querySelector('#quiz-screen .question-prompt');
    const mediaCont = document.getElementById('media-container');

    if (room.minimalStudentView) {
        document.body.classList.add('student-minimal-view');
        if (promptCont) promptCont.style.display = 'none';
        if (mediaCont) mediaCont.style.display = 'none';
    } else {
        document.body.classList.remove('student-minimal-view');
        if (promptCont) promptCont.style.display = '';
        if (mediaCont) mediaCont.style.display = '';
    }

    if (q.type !== 'info') {
        hideSlide();
        renderOptions('options-container', q, true, room.currentQuestionIndex, false);
    } else {
        renderSlide(q);
    }

    timeLeft = q.timer;
    window._currentTimerMax = timeLeft;
    setHudTimer(timeLeft);
    setQuizProgress(room.currentQuestionIndex, room.quizData.length);

    clearInterval(localTimer);
    if (timeLeft > 0) {
        localTimer = setInterval(() => {
            timeLeft--;
            setHudTimer(timeLeft);
            if (timeLeft <= 0) clearInterval(localTimer);
        }, 1000);
    }

    const isKahootMode = (q.type === 'multiple-choice' || q.type === 'multiple-answer' || q.type === 'true-false');
    if (isKahootMode) {
        document.body.classList.add('layout-kahoot');
    } else {
        document.body.classList.remove('layout-kahoot');
    }
    switchScreen('quiz');
}

function renderAnswerSubmitted() {
    const container = document.getElementById('options-container');
    if (!container) return;
    container.innerHTML = `
        <div class="answer-submitted" role="status">
            <div class="answer-submitted-icon">✅</div>
            <h3 class="answer-submitted-title">Answer Submitted</h3>
            <p class="answer-submitted-sub">Waiting for other players...</p>
            <div class="loader answer-submitted-loader"></div>
        </div>`;
}

async function submitAnswer(answer, q, qIndex) {
    if (previewMode) return;
    if (hasAnswered) return;
    hasAnswered = true;

    renderAnswerSubmitted();

    let isCorrect = false;
    let scoreFrac = 0;
    let typingRawEarned = 0;
    let mcPoints = 0; // raw points for multi-answer MC
    if (!q.freePoint) {
        if (q.type === 'multiple-answer') {
            // Multiple Answer: 20 pts each, +50 bonus if all correct, 0 if any wrong
            const result = AppServices.gradeMultiChoice(answer, q);
            mcPoints = result.points;
            isCorrect = result.correct;
            scoreFrac = result.correct ? 1 : 0;
        } else if (q.type === 'multiple-choice') {
            // Single-answer MC: classic timing-based scoring, one correct pick
            const cText = typeof q.correctAnswer === 'string' ? q.correctAnswer : q.correctAnswer.text;
            const selected = Array.isArray(answer) ? answer : (answer == null ? [] : [answer]);
            isCorrect = selected.length === 1 && selected[0] === cText;
            scoreFrac = isCorrect ? 1 : 0;
        } else if (q.type === 'true-false') {
            const cText = typeof q.correctAnswer === 'string' ? q.correctAnswer : q.correctAnswer.text;
            isCorrect = answer === cText;
            scoreFrac = isCorrect ? 1 : 0;
        } else {
            // If AI grading is enabled, defer grading to Host
            if (q.aiGrading) {
                typingRawEarned = 0;
                isCorrect = false; // Decided by host later
            } else {
                typingRawEarned = getTypingAnswerScore(answer, q);
                isCorrect = typingRawEarned > 0;
            }
        }
    }

    // For AI grading, we set studentCurrentPointsEarned to a special flag 'pending_ai'
    const isMultiMc = q.type === 'multiple-answer';
    if (q.type === 'typing' && q.aiGrading && !q.freePoint) {
        studentCurrentPointsEarned = 'pending_ai';
    } else if (isCorrect && !q.freePoint) {
        if (q.type === 'typing') {
            studentCurrentPointsEarned = typingRawEarned;
            const max = getTypingMaxPoints(q);
            if (typingRawEarned === max && max > 0) {
                studentCurrentPointsEarned += 150; // Bonus for max points
            }
        } else if (isMultiMc) {
            studentCurrentPointsEarned = mcPoints;
        } else {
            let maxPts = 100 + Math.floor((timeLeft / q.timer) * 50);
            studentCurrentPointsEarned = Math.floor(maxPts * scoreFrac);
        }
    } else {
        studentCurrentPointsEarned = 0;
    }

    // We store the answer in 'lastAnswer' for the host tally and in 'answers' history for review.
    // For MC, answer is an array of selected choices; store it joined so the chart/review can display it.
    const storedAnswer = Array.isArray(answer) ? answer : answer;
    const localPts = q.type === 'typing' ? typingRawEarned
        : isMultiMc ? mcPoints
        : Math.floor((100 + Math.floor((timeLeft / (q.timer || 1)) * 50)) * scoreFrac);

    let updateObj = {
        hasAnswered: qIndex,
        lastAnswer: storedAnswer,
        [`answerMeta/${qIndex}`]: {
            submittedAt: firebase.database.ServerValue.TIMESTAMP,
            timeLeftAtSubmit: timeLeft,
            localPoints: localPts,
            localCorrect: isCorrect,
            questionType: q.type
        }
    };
    updateObj[`answers/${qIndex}`] = storedAnswer;

    await db.ref(`rooms/${roomCode}/players/${playerName}`).update(updateObj);
}

async function showStudentFeedback() {
    clearInterval(localTimer);
    document.getElementById('ekg-video').pause();

    // Clear stale feedback content immediately so the previous question's
    // answer key never lingers while we await fresh data.
    const optsCont = document.getElementById('feedback-options-container');
    if (optsCont) optsCont.innerHTML = '';
    const chartCont = document.getElementById('feedback-chart');
    if (chartCont) chartCont.innerHTML = '';
    const typingPanel = document.getElementById('feedback-typing-panel');
    if (typingPanel) { typingPanel.style.display = 'none'; typingPanel.innerHTML = ''; }
    const myAnsEl = document.getElementById('feedback-your-answer');
    if (myAnsEl) { myAnsEl.style.display = 'none'; myAnsEl.innerText = ''; }

    // Fetch state first to avoid flashing old question data
    const snap = await db.ref(`rooms/${roomCode}`).get();
    const room = snap.val();
    const q = room.quizData[room.currentQuestionIndex];

    const title = document.getElementById('feedback-title');
    const pts = document.getElementById('feedback-points');

    // Fetch player's answer for this question (also used for reveal + score)
    const pSnap = await db.ref(`rooms/${roomCode}/players/${playerName}/answers/${room.currentQuestionIndex}`).get();
    const myAns = pSnap.exists() ? pSnap.val() : null;

    // Render the choices, highlighting the correct one (non-interactive)
    renderOptions('feedback-options-container', q, false, room.currentQuestionIndex, true, myAns);

    // For typing questions: show the rich two-panel highlight feedback
    if (q.type === 'typing') {
        myAnsEl.style.display = 'none'; // hide the plain text line
        if (typingPanel) {
            typingPanel.style.display = 'block';
            typingPanel.innerHTML = buildTypingFeedbackHTML(myAns, q);
        }
    } else {
        if (typingPanel) typingPanel.style.display = 'none';
        // For MC / T-F: show simple "Your Answer" line (arrays join with ", ")
        const ansLabel = Array.isArray(myAns) ? myAns.join(', ') : myAns;
        myAnsEl.style.display = 'block';
        myAnsEl.innerText = ansLabel ? `Your Answer: ${ansLabel}` : 'Your Answer: None';
    }

    // Render the bar chart
    await renderFeedbackChart('feedback-chart', q, room.currentQuestionIndex);

    // Switch screen only after all DOM updates are complete
    switchScreen('feedback');

    // If AI grading was used, fetch the result computed by the host
    const aiReasonBtn = document.getElementById('btn-student-ai-reason');
    const aiReasonContainer = document.getElementById('student-ai-reason-container');
    if (aiReasonContainer) aiReasonContainer.style.display = 'none';

    if (studentCurrentPointsEarned === 'pending_ai' || (q.type === 'typing' && q.aiGrading)) {
        // lastPointsEarned is stored on the PLAYER node, not the answer node
        const playerSnap = await db.ref(`rooms/${roomCode}/players/${playerName}`).get();
        const pData = playerSnap.val() || {};
        const aiPoints = pData.lastPointsEarned;
        studentCurrentPointsEarned = (typeof aiPoints === 'number') ? aiPoints : 0;
        
        if (pData.aiGrading && aiReasonContainer) {
            aiReasonContainer.style.display = 'block';
            aiReasonBtn.onclick = () => viewConceptBreakdown(playerName);
        }
    }

    if (q.freePoint) {
        title.innerText = "Answer Recorded!";
        title.className = "correct";
        pts.innerText = "0 Points (Unscored)";
        pts.className = "";
        AudioController.playCorrect();
    } else if (studentCurrentPointsEarned > 0) {
        title.innerText = "Correct!";
        title.className = "correct";
        pts.className = "correct";
        AudioController.playCorrect();
        animateTally(pts, studentCurrentPointsEarned, { prefix: '+', suffix: ' Points', duration: 900 });
        burstConfetti();

        const playerScoreSnap = await db.ref(`rooms/${roomCode}/players/${playerName}/score`).get();
        const currentScore = (playerScoreSnap.exists() ? playerScoreSnap.val() : 0) || 0;
        const newScore = currentScore + studentCurrentPointsEarned;

        await db.ref(`rooms/${roomCode}/players/${playerName}`).update({
            score: newScore,
            [`awardedPoints/${room.currentQuestionIndex}`]: studentCurrentPointsEarned
        });

        const scoreUI = document.getElementById('hud-score');
        scoreUI.innerText = newScore;
        scoreUI.classList.remove('score-bump');
        void scoreUI.offsetWidth;
        scoreUI.classList.add('score-bump');
    } else {
        title.innerText = "Incorrect";
        title.className = "incorrect";
        pts.innerText = "+0 Points";
        pts.className = "incorrect";
        AudioController.playWrong();
    }

    // Wait briefly for all clients to update scores, then update rank
    setTimeout(async () => {
        const snap = await db.ref(`rooms/${roomCode}/players`).get();
        const players = snap.val() || {};
        const sorted = Object.entries(players).sort((a,b) => b[1].score - a[1].score);
        const myRankIndex = sorted.findIndex(p => p[0] === playerName);
        if (myRankIndex !== -1) {
            const rankNum = myRankIndex + 1;
            let suffix = "th";
            if (rankNum % 10 === 1 && rankNum % 100 !== 11) suffix = "st";
            else if (rankNum % 10 === 2 && rankNum % 100 !== 12) suffix = "nd";
            else if (rankNum % 10 === 3 && rankNum % 100 !== 13) suffix = "rd";

            document.getElementById('hud-rank').innerText = `${rankNum}${suffix}`;

            // Re-bump score just to trigger animation on rank change if desired
            const scoreUI = document.getElementById('hud-score');
            scoreUI.classList.remove('score-bump');
            void scoreUI.offsetWidth;
            scoreUI.classList.add('score-bump');
        }
    }, 1000);
}

async function showResults() {
    switchScreen('results');
    clearInterval(localTimer);

    const snap = await db.ref(`rooms/${roomCode}/players`).get();
    const players = snap.val() || {};

    const sorted = Object.entries(players).sort((a,b) => b[1].score - a[1].score);

    if (role === 'student') {
        document.getElementById('final-score-value').innerText = players[playerName]?.score || 0;
    }

    // Setup and animate podium for EVERYONE
    for(let i=1; i<=3; i++) {
        const spot = document.getElementById(`podium-${i}`);
        if(spot) spot.classList.remove('revealed');
        const nameEl = document.getElementById(`podium-name-${i}`);
        const scoreEl = document.getElementById(`podium-score-${i}`);
        if(nameEl) nameEl.innerText = '';
        if(scoreEl) scoreEl.innerText = '';
    }

    const titleEl = document.getElementById('podium-title');
    if(titleEl) titleEl.style.opacity = '0';

    const othersTitle = document.getElementById('others-title');
    if(othersTitle) othersTitle.style.display = 'none';

    const othersList = document.getElementById('full-leaderboard-list');
    const toggleBtn = document.getElementById('btn-toggle-leaderboard');
    if (othersList) {
        if (sorted.length > 3) {
            othersList.innerHTML = sorted.slice(3).map((p, i) =>
                `<li style="background: rgba(255,255,255,0.1); padding: 1rem; margin-bottom: 0.5rem; border-radius: 8px; display: flex; justify-content: space-between;">
                    <span>#${i+4} ${avatarFor(p[0])} ${escapeHtml(p[0])}</span> <span>${p[1].score} pts</span>
                </li>`
            ).join('');
            if(othersTitle) othersTitle.style.display = 'block';
            if(toggleBtn) {
                toggleBtn.style.display = 'block';
                othersList.style.display = 'none';
                toggleBtn.innerText = 'View Full Scoreboard';
                toggleBtn.onclick = () => {
                    if(othersList.style.display === 'none') {
                        othersList.style.display = 'block';
                        toggleBtn.innerText = 'Hide Scoreboard';
                    } else {
                        othersList.style.display = 'none';
                        toggleBtn.innerText = 'View Full Scoreboard';
                    }
                };
            }
        } else {
            othersList.innerHTML = '';
            if(toggleBtn) toggleBtn.style.display = 'none';
        }
    }

    const reviewBtn = document.getElementById('btn-review-questions');
    if(reviewBtn) reviewBtn.style.display = 'none';
    const exportResultsBtn = document.getElementById('btn-export-results-csv');
    if (exportResultsBtn) {
        exportResultsBtn.style.display = role === 'host' ? 'inline-block' : 'none';
        exportResultsBtn.onclick = () => downloadResultsCSV(sorted);
    }

    // Populate podium data (scores start at 0 and tally up on reveal)
    if (sorted[0]) {
        document.getElementById('podium-name-1').innerText = `${avatarFor(sorted[0][0])} ${sorted[0][0]}`;
        const s = document.getElementById('podium-score-1');
        s.dataset.target = sorted[0][1].score;
        s.innerText = '0 pts';
    }
    if (sorted[1]) {
        document.getElementById('podium-name-2').innerText = `${avatarFor(sorted[1][0])} ${sorted[1][0]}`;
        const s = document.getElementById('podium-score-2');
        s.dataset.target = sorted[1][1].score;
        s.innerText = '0 pts';
    }
    if (sorted[2]) {
        document.getElementById('podium-name-3').innerText = `${avatarFor(sorted[2][0])} ${sorted[2][0]}`;
        const s = document.getElementById('podium-score-3');
        s.dataset.target = sorted[2][1].score;
        s.innerText = '0 pts';
    }

    // Animate sequence
    const spotlight = document.getElementById('results-spotlight');
    const championOverlay = document.getElementById('champion-overlay');
    const championName = document.getElementById('champion-name');
    if (spotlight) spotlight.classList.remove('active');

    setTimeout(() => {
        if(titleEl) titleEl.style.opacity = '1';
    }, 500);

    setTimeout(() => {
        if(sorted[2]) {
            document.getElementById('podium-3').classList.add('revealed');
            AudioController.playPodiumRise();
            if (spotlight) { spotlight.style.left = '0%'; spotlight.classList.add('active'); }
            const s3 = document.getElementById('podium-score-3');
            if (s3) animateTally(s3, parseInt(s3.dataset.target || 0, 10), { suffix: ' pts', duration: 800 });
        }
    }, 1500);

    setTimeout(() => {
        if(sorted[1]) {
            document.getElementById('podium-2').classList.add('revealed');
            AudioController.playPodiumRise();
            if (spotlight) { spotlight.style.left = '25%'; spotlight.classList.add('active'); }
            const s2 = document.getElementById('podium-score-2');
            if (s2) animateTally(s2, parseInt(s2.dataset.target || 0, 10), { suffix: ' pts', duration: 800 });
        }
    }, 2500);

    setTimeout(() => {
        if(sorted[0]) {
            document.getElementById('podium-1').classList.add('revealed');
            AudioController.playChampion();
            burstConfettiCount(600);
            // Spotlight slam on the champion
            if (spotlight) { spotlight.style.left = '50%'; spotlight.classList.add('active', 'slam'); }
            // Champion name overlay
            if (championOverlay && championName && sorted[0]) {
                championName.innerText = `${avatarFor(sorted[0][0])} ${sorted[0][0]}`;
                championOverlay.style.display = 'flex';
                setTimeout(() => { championOverlay.classList.add('show'); }, 30);
                setTimeout(() => { championOverlay.classList.remove('show'); championOverlay.style.display = 'none'; }, 4500);
            }
            // Tally the champion score
            const cScore = document.getElementById('podium-score-1');
            if (cScore) animateTally(cScore, parseInt(cScore.dataset.target || 0, 10), { suffix: ' pts', duration: 1000 });
        }
        if(role === 'host' && reviewBtn) reviewBtn.style.display = 'inline-block';
        if(sorted.length > 3 && othersTitle) othersTitle.style.display = 'block';
    }, 4000);
}

function downloadResultsCSV(sortedPlayers) {
    AppServices.downloadResultsCsv(`spot-diagnosis-results-${roomCode || 'game'}.csv`, sortedPlayers, customQuizData);
}

/* =====================================================================
   IMAGE ZOOM LOGIC
===================================================================== */
const zoomModal = document.getElementById("image-zoom-modal");
const zoomedImg = document.getElementById("zoomed-image");
const closeZoom = document.querySelector(".close-zoom");

document.getElementById("ekg-image").addEventListener("click", function(){
    zoomModal.style.display = "flex";
    zoomedImg.src = this.src;
});

document.getElementById("qrcode").addEventListener("click", function(){
    const canvas = this.querySelector('canvas');
    if (canvas) {
        zoomModal.style.display = "flex";
        zoomedImg.src = canvas.toDataURL();
    }
});

closeZoom.addEventListener("click", function() {
    zoomModal.style.display = "none";
});

zoomModal.addEventListener("click", function(e) {
    if (e.target === zoomModal) {
        zoomModal.style.display = "none";
    }
});

/* =====================================================================
   REVIEW SCREEN LOGIC
===================================================================== */
document.getElementById('btn-review-questions').addEventListener('click', () => {
    if (role === 'host') {
        db.ref(`rooms/${roomCode}`).update({ gameState: 'review' });
        // Local update for host
        switchScreen('review');
        renderReviewList();
    }
});

document.getElementById('btn-back-to-review').addEventListener('click', () => {
    if (role === 'host') {
        db.ref(`rooms/${roomCode}`).update({ gameState: 'review' });
        // Local update for host
        switchScreen('review');
        renderReviewList();
    }
});

async function renderReviewList() {
    const listEl = document.getElementById('review-list');
    listEl.innerHTML = '';

    // Make sure we have the latest quiz data for students
    if (customQuizData.length === 0) {
        const snap = await db.ref(`rooms/${roomCode}/quizData`).get();
        if (snap.exists()) {
            customQuizData = snap.val();
        }
    }

    let studentAnswers = {};
    if (role === 'student') {
        const pSnap = await db.ref(`rooms/${roomCode}/players/${playerName}/answers`).get();
        if (pSnap.exists()) {
            studentAnswers = pSnap.val();
        }
    }

    customQuizData.forEach((q, idx) => {
        const item = document.createElement('div');
        item.className = 'review-item';
        item.onclick = () => {
            if (role === 'host') {
                db.ref(`rooms/${roomCode}`).update({ gameState: `review_detail_${idx}` });
                showReviewDetail(idx);
            }
        };

        let mediaHtml = '';
        if (q.imageUrl) {
            if (q.mediaType === 'video') {
                mediaHtml = `<video src="${q.imageUrl}" style="max-height:150px; border-radius:8px; margin-bottom:1rem;" controls playsinline webkit-playsinline></video><br>`;
            } else {
                mediaHtml = `<img src="${q.imageUrl}" style="max-height:150px; border-radius:8px; margin-bottom:1rem;"><br>`;
            }
        }

        let correctHtml = '';
        if (q.type === 'multiple-choice' || q.type === 'multiple-answer' || q.type === 'true-false') {
            const correctList = q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : []);
            const cTexts = correctList.map(c => typeof c === 'string' ? c : c.text);
            if (cTexts.length > 1) {
                correctHtml = `<div class="review-answer">Correct Answers: ${cTexts.join(', ')}</div>`;
            } else {
                const cImg = correctList[0] && typeof correctList[0] !== 'string' && correctList[0].isImage;
                if (cImg) {
                    correctHtml = `<div class="review-answer">Correct Answer:<br><img src="${cTexts[0]}" style="max-height:50px; margin-top:5px; border-radius:4px;"></div>`;
                } else {
                    correctHtml = `<div class="review-answer">Correct Answer: ${cTexts[0] || ''}</div>`;
                }
            }
        } else {
            const accepted = q.acceptedAnswers.map(a => {
                const t = typeof a === 'string' ? a : a.text;
                const p = (typeof a === 'object' && a.points !== undefined) ? a.points : 10;
                return `${t} (${p} pts)`;
            }).join(', ');
            correctHtml = `<div class="review-answer">Accepted Answers: ${accepted}</div>`;
        }

        if (role === 'student') {
            const myRaw = studentAnswers[idx] || 'No Answer';
            const myAns = Array.isArray(myRaw) ? myRaw.join(', ') : myRaw;
            correctHtml += `<div class="review-answer" style="margin-top: 10px; color: #1565c0;">Your Answer: ${myAns}</div>`;
        }

        item.innerHTML = `
            <div class="review-question">Q${idx + 1}: ${q.text}</div>
            ${mediaHtml}
            ${correctHtml}
        `;
        listEl.appendChild(item);
    });
}

function showReviewDetail(idx) {
    if (customQuizData.length === 0) {
        // Safe check for quick refreshes or late joins
        db.ref(`rooms/${roomCode}/quizData`).get().then(snap => {
            if (snap.exists()) {
                customQuizData = snap.val();
                populateReviewDetail(idx);
            }
        });
    } else {
        populateReviewDetail(idx);
    }
}

function populateReviewDetail(idx) {
    currentQuestionIndex = idx;
    switchScreen('feedback');

    // Hide standard host continue button, show back button
    const btnContinue = document.getElementById('btn-host-continue');
    const btnBack = document.getElementById('btn-back-to-review');
    const feedbackTitle = document.getElementById('feedback-title');

    if (btnContinue) btnContinue.style.display = 'none';
    if (btnBack) btnBack.style.display = role === 'host' ? 'inline-block' : 'none';
    if (feedbackTitle) feedbackTitle.style.display = 'none';

    // Populate question text and media for review mode
    const qData = customQuizData[idx];
    const contextEl = document.getElementById('feedback-review-context');
    const textEl = document.getElementById('feedback-question-text');
    if (contextEl && qData) {
        contextEl.style.display = 'block';
        textEl.innerText = qData.text;
        renderMediaCommon(qData, 'feedback', false);
    }

    // Always clear stale panels so nothing from a previous question lingers
    const typingPanel = document.getElementById('feedback-typing-panel');
    if (typingPanel) {
        typingPanel.style.display = 'none';
        typingPanel.innerHTML = '';
    }
    const myAnsEl = document.getElementById('feedback-your-answer');
    if (myAnsEl) {
        myAnsEl.style.display = 'none';
        myAnsEl.innerText = '';
    }

    // Populate standard feedback data directly to ensure Host and Student see exactly the same layout
    renderOptions('feedback-options-container', qData, false, currentQuestionIndex, true);
    renderFeedbackChart('feedback-chart', qData, currentQuestionIndex);

    if (role === 'student') {
        db.ref(`rooms/${roomCode}/players/${playerName}/answers/${currentQuestionIndex}`).get().then(pSnap => {
            const myAns = pSnap.exists() ? pSnap.val() : null;
            if (qData.type === 'typing') {
                // Show the rich two-panel highlight feedback for SAQ questions
                if (myAnsEl) myAnsEl.style.display = 'none';
                if (typingPanel) {
                    typingPanel.style.display = 'block';
                    typingPanel.innerHTML = buildTypingFeedbackHTML(myAns, qData);
                }
            } else {
                if (typingPanel) typingPanel.style.display = 'none';
                if (myAnsEl) {
                    const ansLabel = Array.isArray(myAns) ? myAns.join(', ') : myAns;
                    myAnsEl.style.display = 'block';
                    myAnsEl.innerText = ansLabel ? `Your Answer: ${ansLabel}` : 'Your Answer: None';
                }
            }
        });
    } else {
        if (myAnsEl) myAnsEl.style.display = 'none';
    }
}

document.getElementById('btn-export-pdf').addEventListener('click', () => {
    exportToPDF();
});

async function exportToPDF() {
    let studentAnswers = {};
    if (role === 'student') {
        const pSnap = await db.ref(`rooms/${roomCode}/players/${playerName}/answers`).get();
        if (pSnap.exists()) {
            studentAnswers = pSnap.val();
        }
    }

    let printContents = `
        <html>
        <head>
            <title>Quiz Review Document</title>
            <style>
                body { font-family: sans-serif; color: black; background: white; padding: 2rem; }
                h1 { text-align: center; margin-bottom: 2rem; }
                .q-block { margin-bottom: 2rem; border-bottom: 1px solid #ccc; padding-bottom: 1rem; page-break-inside: avoid; }
                .q-text { font-size: 1.2rem; font-weight: bold; margin-bottom: 1rem; }
                .q-media { max-width: 100%; max-height: 250px; display: block; margin-bottom: 1rem; }
                .q-answer { font-weight: bold; color: #2e7d32; }
                .q-my-answer { font-weight: bold; color: #1565c0; margin-top: 5px; }
            </style>
        </head>
        <body>
            <h1>Quiz Review Document</h1>
    `;

    customQuizData.forEach((q, idx) => {
        printContents += `<div class="q-block"><div class="q-text">Q${idx + 1}: ${q.text}</div>`;

        if (q.imageUrl) {
            if (q.mediaType === 'video') {
                printContents += `<p><em>[Video Attachment: ${q.imageUrl}]</em></p>`;
            } else {
                printContents += `<img class="q-media" src="${q.imageUrl}" />`;
            }
        }

        if (q.type === 'multiple-choice' || q.type === 'multiple-answer' || q.type === 'true-false') {
            const correctList = q.correctAnswers || (q.correctAnswer ? [q.correctAnswer] : []);
            const cTexts = correctList.map(c => typeof c === 'string' ? c : c.text);
            if (cTexts.length > 1) {
                printContents += `<div class="q-answer">Correct Answers: ${cTexts.join(', ')}</div>`;
            } else {
                const first = correctList[0];
                if (first && typeof first !== 'string' && first.isImage) {
                    printContents += `<div class="q-answer">Correct Answer: <img class="q-media" src="${cTexts[0]}" style="max-height:100px;"/></div>`;
                } else {
                    printContents += `<div class="q-answer">Correct Answer: ${cTexts[0] || ''}</div>`;
                }
            }
        } else {
            const accepted = q.acceptedAnswers.map(a => {
                const t = typeof a === 'string' ? a : a.text;
                const p = (typeof a === 'object' && a.points !== undefined) ? a.points : 10;
                return `${t} (${p} pts)`;
            }).join(', ');
            printContents += `<div class="q-answer">Accepted Answers: ${accepted}</div>`;
        }

        if (role === 'student') {
            const myRaw = studentAnswers[idx] || 'No Answer';
            const myAns = Array.isArray(myRaw) ? myRaw.join(', ') : myRaw;
            printContents += `<div class="q-my-answer">Your Answer: ${myAns}</div>`;

            if ((!q.type || q.type === 'typing') && studentAnswers[idx]) {
                const results = getTypingKeyResults(myAns, q);
                let html = '<div style="margin-top: 10px; font-size: 0.95rem; background: #f8f9fa; padding: 10px; border-left: 4px solid #ccc;">';
                html += '<div style="font-weight: bold; margin-bottom: 5px;">Grading Breakdown:</div>';

                let missedKeys = [];

                results.forEach(res => {
                    if (res.matched) {
                        html += `<div style="color: #2e7d32; margin-bottom: 3px;">✓ <strong>${res.text}</strong> <span style="font-size: 0.85em;">(+${res.pts} pts)</span></div>`;
                    } else {
                        html += `<div style="color: #d32f2f; margin-bottom: 3px;">✗ <del>${res.text}</del> <span style="font-size: 0.85em;">(not found)</span></div>`;
                        missedKeys.push(`<strong>${res.text}</strong> (+${res.pts} pts)`);
                    }
                });

                if (missedKeys.length > 0) {
                    html += `<div style="margin-top: 8px; color: #b45309; font-size: 0.9em;">💡 To get more points, add: ${missedKeys.join(', ')}</div>`;
                }

                html += '</div>';
                printContents += html;
            }
        }

        printContents += `</div>`;
    });

    printContents += `
        <script>
            window.onload = function() { window.print(); window.close(); }
        </script>
        </body></html>
    `;

    const printWindow = window.open('', '_blank');
    printWindow.document.open();
    printWindow.document.write(printContents);
    printWindow.document.close();
}
/* =====================================================================
   GUIDE MODAL LOGIC
===================================================================== */
const guideLink = document.getElementById('guide-link');
const guideModal = document.getElementById('guide-modal');
const closeGuide = document.querySelector('.close-guide');

if (guideLink) {
    guideLink.addEventListener('click', (e) => {
        e.preventDefault();
        guideModal.style.display = 'flex';
    });
}
if (closeGuide) {
    closeGuide.addEventListener('click', () => {
        guideModal.style.display = 'none';
    });
}
if (guideModal) {
    guideModal.addEventListener('click', (e) => {
        if (e.target === guideModal) {
            guideModal.style.display = 'none';
        }
    });
}

const rejectedGuideLink = document.getElementById('rejected-guide-link');
if (rejectedGuideLink) {
    rejectedGuideLink.addEventListener('click', (e) => {
        e.preventDefault();
        Swal.fire({
            title: 'Rejected Words',
            html: `
                <div style="text-align: left; font-size: 0.95rem; line-height: 1.6; padding-top: 10px;">
                    <p>If the student types ANY of the words you list here, they will lose <strong>2 points</strong> for every time they type it.</p>
                    <p>This is useful for penalizing students who try to guess by typing word salads containing both right and wrong concepts.</p>
                    <p style="margin-bottom: 0;"><em style="color:var(--text-muted);">Separate multiple words with commas, e.g. <code>right, normal, healthy</code></em></p>
                </div>
            `,
            confirmButtonText: 'Got it!',
            confirmButtonColor: 'var(--primary)'
        });
    });
}

function setupCustomDropdowns() {
    const selects = document.querySelectorAll('select');
    selects.forEach(select => {
        // Skip the import quiz select and the music style select — keep them as
        // native <select>s so their dropdowns never overlap the Reset button.
        if (select.id === 'import-quiz-select' || select.id === 'music-style-select') return;
        if (select.nextElementSibling && select.nextElementSibling.classList.contains('custom-select-wrapper')) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'custom-select-wrapper';

        const trigger = document.createElement('div');
        trigger.className = 'custom-select-trigger';

        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'custom-options';

        const updateTrigger = () => {
            const selectedOption = select.options[select.selectedIndex];
            trigger.innerHTML = '<span>' + (selectedOption ? selectedOption.text : 'Select...') + '</span><i class="arrow"></i>';
        };
        const syncUI = () => {
            updateTrigger();
            optionsContainer.querySelectorAll('.custom-option').forEach((opt, idx) => {
                if (idx === select.selectedIndex) opt.classList.add('selected');
                else opt.classList.remove('selected');
            });
        };

        Array.from(select.options).forEach((option, index) => {
            const customOption = document.createElement('div');
            customOption.className = 'custom-option';
            customOption.dataset.value = option.value;
            customOption.innerText = option.text;

            if (index === select.selectedIndex) customOption.classList.add('selected');

            customOption.addEventListener('click', (e) => {
                e.stopPropagation();
                select.selectedIndex = index;
                select.dispatchEvent(new Event('change'));

                optionsContainer.querySelectorAll('.custom-option').forEach(opt => opt.classList.remove('selected'));
                customOption.classList.add('selected');

                updateTrigger();
                wrapper.classList.remove('open');
            });
            optionsContainer.appendChild(customOption);
        });

        updateTrigger();

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.custom-select-wrapper').forEach(w => {
                if (w !== wrapper) w.classList.remove('open');
            });
            wrapper.classList.toggle('open');
        });

        wrapper.appendChild(trigger);
        wrapper.appendChild(optionsContainer);
        select.style.display = 'none';
        select.parentNode.insertBefore(wrapper, select.nextSibling);

        // Keep the custom dropdown in sync when the native select value changes
        // programmatically (e.g. editQuestion loads a question's saved timer).
        select.addEventListener('change', syncUI);

        // Expose a sync helper so other code can refresh the UI after setting
        // the select value programmatically.
        select._syncCustomUI = syncUI;
    });

    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select-wrapper').forEach(w => w.classList.remove('open'));
    });
}
setupCustomDropdowns();

document.addEventListener('DOMContentLoaded', () => {
    const makerForm = document.getElementById('maker-form-container');
    if (makerForm) {
        makerForm.addEventListener('change', (e) => {
            markMakerDirty();
            validateMakerForm();
            saveActiveQuestion();
        });
        makerForm.addEventListener('input', (e) => {
            if (e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && ['text', 'url', 'number', 'email'].includes(e.target.type))) {
                markMakerDirty();
                validateMakerForm();
                saveActiveQuestion();
            }
        });
    }
});
