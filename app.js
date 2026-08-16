/* =====================================================================
   GLOBAL VARIABLES & CONFIG
===================================================================== */
// Embedded AI config — set ONCE so every deployment has AI grading with no per-user setup.
// WARNING: these values ship to the browser and are readable by anyone. Use a free API key
// and accept that others could use it up to its quota.
const HARDCODED_AI_PROVIDER = 'groq';          // 'gemini' | 'groq' | 'openrouter'
const HARDCODED_AI_KEY = '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';
const HARDCODED_AI_MODEL = 'llama-3.3-70b-versatile';

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
    const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#8b3dff', '#10b981'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 60; i++) {
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
    if (el) el.innerText = t > 0 ? t : '∞';
    const fill = document.getElementById('hud-timer-fill');
    if (!fill) return;
    const max = window._currentTimerMax && window._currentTimerMax > 0 ? window._currentTimerMax : t;
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
   AMBIENT FX (decorative background particles)
   Particle shape/color is driven by the active theme body class in CSS;
   here we only spawn .fx-particle spans with inline position/size/delay.
   ===================================================================== */
const FX_KINDS = {
    dark: 'star', light: 'cloud', pastel: 'petal', earth: 'leaf', warm: 'snow', cool: 'ice'
};

function fxSpawn(intensity = 1) {
    const container = document.getElementById('ambient-fx');
    if (!container) return;
    const bodyClass = [...document.body.classList].find(c => c.endsWith('-theme'));
    const theme = bodyClass ? bodyClass.replace('-theme', '') : 'dark';
    const kind = FX_KINDS[theme] || 'star';
    const isSmall = window.innerWidth < 768;
    const base = isSmall ? 18 : 32;
    const count = Math.round(base * intensity);
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const p = document.createElement('span');
        p.className = 'fx-particle fx-' + kind;
        p.style.left = (kind === 'cloud' ? -20 : 0) + (Math.random() * (kind === 'cloud' ? 80 : 100)) + 'vw';
        p.style.top = (kind === 'cloud' ? Math.random() * 75 : Math.random() * 100) + 'vh';
        const size = 0.7 + Math.random() * 0.9;
        p.style.scale = String(size);
        p.style.animationDuration = (kind === 'star' || kind === 'cloud')
            ? (7 + Math.random() * 8) + 's'
            : (9 + Math.random() * 10) + 's';
        p.style.animationDelay = (-Math.random() * 20) + 's';
        if (kind === 'star') {
            p.style.setProperty('--fx-drift', (Math.random() * 60 - 30) + 'vw');
        } else if (kind === 'cloud') {
            p.style.setProperty('--fx-drift', (100 + Math.random() * 60) + 'vw');
            p.style.setProperty('--fx-y-drift', (Math.random() * 20 - 10) + 'vh');
        } else {
            p.style.setProperty('--fx-drift', (kind === 'leaf' || kind === 'petal' ? -80 : 30) + Math.random() * 120 + 'px');
        }
        p.style.setProperty('--fx-opacity', (theme === 'dark' ? 0.75 : 0.55).toFixed(2));
        container.appendChild(p);
    }
}

function fxBurst() {
    const container = document.getElementById('ambient-fx');
    if (!container) return;
    for (let i = 0; i < 14; i++) {
        const p = document.createElement('span');
        const kind = (document.querySelector('.fx-particle')?.className || 'fx-star').split(' ')[1] || 'fx-star';
        p.className = 'fx-particle ' + kind;
        p.style.left = (50 + (Math.random() - 0.5) * 20) + 'vw';
        p.style.top = '50%';
        p.style.scale = String(0.8 + Math.random() * 1.2);
        p.style.setProperty('--fx-opacity', '0.95');
        const drift = (Math.random() - 0.5) * 140;
        p.style.setProperty('--fx-drift', drift + 'px');
        p.style.animationDuration = (1.2 + Math.random() * 1.2) + 's';
        container.appendChild(p);
    }
    setTimeout(() => { fxSpawn(1); }, 3000);
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
        });
    }
    // Make FX visible on load if the initially-active screen is an FX screen.
    const activeScreen = Object.entries(screens).find(([, el]) => el.classList.contains('active'))?.[0];
    const fxScreens = ['role', 'join', 'lobby', 'countdown', 'feedback'];
    document.body.classList.toggle('fx-active', fxScreens.includes(activeScreen));
    fxSpawn(1);
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
    let bgmGain = null;
    let isMuted = false;
    let audioUnlocked = false;
    let bgmRunning = false;
    let bgmTimeout = null;
    let bgmNextTime = 0;
    let chordIdx = 0;
    let currentStyle = MUSIC_STYLES.gameshow;

    const beat = () => 60 / currentStyle.bpm;
    const bar  = () => beat() * 4;

    function getCtx() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            // Global volume (controlled by mute button)
            masterGain = audioCtx.createGain();
            masterGain.gain.value = 0.20;
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
        startBGM();
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
        if (isMuted) {
            stopBGM();
            if (masterGain) masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.3);
            btn.innerText = '🔇'; btn.classList.add('muted');
        } else {
            if (masterGain) {
                masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
                masterGain.gain.linearRampToValueAtTime(0.20, audioCtx.currentTime + 0.5);
            }
            startBGM();
            btn.innerText = '🔊'; btn.classList.remove('muted');
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

    return { unlock, toggleMute, setStyle, playTick, playCorrect, playWrong };
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
document.getElementById('btn-music-toggle').addEventListener('click', () => AudioController.toggleMute());
document.getElementById('music-style-select').addEventListener('change', (e) => AudioController.setStyle(e.target.value));
/* =====================================================================
   HELPER FUNCTIONS
===================================================================== */
const levenshteinDistance = AppServices.levenshteinDistance;

function getTypingAnswerScore(playerAns, q) {
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
        '<div style="background:var(--input-bg);border:1px solid var(--glass-border);border-radius:12px;padding:1rem;">' +
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
    document.body.classList.toggle('fx-active', fxScreens.includes(screenName));
    // Countdown gets a denser effect + is the burst moment
    if (screenName === 'countdown') fxSpawn(1.5);
    else if (fxScreens.includes(screenName)) fxSpawn(1);

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
                <button class="btn-pill btn-pill-danger btn-delete-quiz" data-index="${index}" title="Delete quiz" aria-label="Delete quiz">🗑️</button>
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
        defaultModel: 'gemini-1.5-flash',
        models: [
            { value: 'gemini-1.5-flash', text: 'Gemini 1.5 Flash (Fastest & Free)' },
            { value: 'gemini-1.5-pro', text: 'Gemini 1.5 Pro (Smarter & Free)' }
        ]
    },
    groq: {
        label: 'Groq',
        keyPlaceholder: 'gsk_...',
        keyPrefix: 'gsk_',
        keyLink: 'https://console.groq.com/keys',
        defaultModel: 'llama-3.3-70b-versatile',
        models: [
            { value: 'llama-3.3-70b-versatile', text: 'Llama 3.3 70B (Smart)' },
            { value: 'llama-3.1-8b-instant', text: 'Llama 3.1 8B (Fast)' }
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
    const provider = localStorage.getItem('aiProvider') || HARDCODED_AI_PROVIDER;
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

        let typeBadge = `<span style="font-size: 0.7rem; background: var(--primary); color: white; padding: 2px 6px; border-radius: 4px; margin-right: 8px;">${q.type === 'typing' ? 'Text' : (q.type==='true-false' ? 'T/F' : 'Multiple Choice')}</span>`;

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

themeSelect.addEventListener('change', () => {
    const chosen = themeSelect.value;
    // Remove all theme classes first
    document.body.classList.remove('light-theme', 'pastel-theme', 'earth-theme', 'warm-theme', 'cool-theme');
    if (chosen !== 'dark') {
        document.body.classList.add(`${chosen}-theme`);
    }
    localStorage.setItem('spotDiagnosisTheme', chosen);
    if (typeof fxSpawn === 'function') fxSpawn(chosen === 'dark' ? 1 : 1);
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
const mcUploadedImages = { 0: null, 1: null, 2: null, 3: null, 4: null };

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
            customQuizData.push({
                type: type,
                text: '',
                context: '',
                timer: type === 'info' ? 0 : 30,
                freePoint: false,
                imageUrl: '',
                mediaType: 'image',
                options: type === 'multiple-choice' ? ['', '', '', '', ''] : [],
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
        mcOptionsDiv.style.display = type === 'multiple-choice' ? 'flex' : 'none';
        tfOptionsDiv.style.display = type === 'true-false' ? 'grid' : 'none';
        typingCorrectDiv.style.display = type === 'typing' ? 'block' : 'none';
        if (type === 'typing' && typingKeysContainer.children.length === 0) {
            addTypingKeyRow('', 10, false, false, false);
        }
        if (type === 'multiple-choice') {
            syncOptionRows();
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

/* --- "+ Add choice": reveal hidden MC rows 4-5 (row 3 always visible) --- */
const btnAddOption = document.getElementById('btn-add-option');
function syncOptionRows() {
    const extraRows = document.querySelectorAll('.mc-opt-extra');
    // Row data-opt="2" (3rd choice) is always shown; only 4-5 toggle.
    let foundEmptySlot = false;
    extraRows.forEach((row) => {
        const hasValue = document.getElementById(`mc-opt-${row.dataset.opt}`).value.trim() !== '';
        if (row.dataset.opt === '2') {
            row.style.display = 'flex';
        } else if (hasValue) {
            row.style.display = 'flex';
        } else if (!foundEmptySlot) {
            // Reveal the next empty slot so the "+ Add choice" target is visible
            row.style.display = 'flex';
            foundEmptySlot = true;
        } else {
            row.style.display = 'none';
        }
    });
    const anyHidden = [...extraRows].some(r => r.style.display === 'none');
    if (btnAddOption) btnAddOption.style.display = anyHidden ? 'inline-block' : 'none';
}
if (btnAddOption) {
    btnAddOption.addEventListener('click', () => {
        const extraRows = [...document.querySelectorAll('.mc-opt-extra')];
        const target = extraRows.find(r => r.style.display === 'none');
        if (target) {
            target.style.display = 'flex';
            const input = document.getElementById(`mc-opt-${target.dataset.opt}`);
            if (input) input.focus();
        }
        syncOptionRows();
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
    if (e.target.value === 'multiple-choice') {
        mcOptionsDiv.style.display = 'block';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'none';
    } else if (e.target.value === 'true-false') {
        mcOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'block';
    } else if (e.target.value === 'info') {
        mcOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'none';
    } else {
        mcOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'block';
        tfOptionsDiv.style.display = 'none';
        if (typingKeysContainer.children.length === 0) {
            addTypingKeyRow('', 10);
        }
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
    document.getElementById('maker-free-point').checked = q.freePoint;
    document.getElementById('maker-media-type').value = q.mediaType || 'image';
    mediaTypeTouched = false;
    document.getElementById('maker-img-url').value = q.imageUrl || "";
    const hasMedia = !!q.imageUrl;
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
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'none';
        for (let i=0; i<5; i++) {
            const opt = q.options[i];
            if (opt) {
                document.getElementById(`mc-opt-${i}`).value = typeof opt === 'string' ? opt : opt.text;
                // isImage is detected automatically - no checkbox needed

                const qCorrectRaw = typeof q.correctAnswer === 'string' ? q.correctAnswer : q.correctAnswer.text;
                const optRaw = typeof opt === 'string' ? opt : opt.text;
                if (optRaw === qCorrectRaw) {
                    document.querySelector(`input[name="mc-correct"][value="${i}"]`).checked = true;
                }
            } else {
                document.getElementById(`mc-opt-${i}`).value = "";
            }
        }
        syncOptionRows();
    } else if (q.type === 'true-false') {
        mcOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'block';
        if (q.correctAnswer) {
            const cVal = typeof q.correctAnswer === 'string' ? q.correctAnswer : q.correctAnswer.text;
            const rb = document.querySelector(`input[name="tf-correct"][value="${cVal}"]`);
            if (rb) rb.checked = true;
        }
    } else if (q.type === 'info') {
        mcOptionsDiv.style.display = 'none';
        typingCorrectDiv.style.display = 'none';
        tfOptionsDiv.style.display = 'none';
    } else {
        mcOptionsDiv.style.display = 'none';
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

    // New Question: reveal only the type tabs, wait for a tab click
    window._makerTypeStep = 'choose';
    const frm = document.getElementById('maker-form-container');
    frm.classList.add('maker-choose-type');
    document.getElementById('maker-empty-state').style.display = 'none';
    frm.dataset.type = 'question';
    document.getElementById('maker-form-title').innerText = "Choose Question Type";
    frm.style.display = "flex";
    document.getElementById('maker-content-area').style.display = 'none';
    // Hide everything except the tabs
    document.querySelectorAll('.maker-form-grid, .maker-form-actions').forEach(el => el.style.display = 'none');
    setMakerTypeTab(null);
    document.getElementById('maker-q-type').value = '';
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
        document.getElementById(`mc-opt-${i}`).value = '';
        document.getElementById(`mc-file-${i}`).value = '';
        document.getElementById(`mc-file-preview-${i}`).innerText = '';
        mcUploadedImages[i] = null;
    }
    document.querySelectorAll('.mc-opt-extra').forEach(row => {
        row.style.display = row.dataset.opt === '2' ? 'flex' : 'none';
    });
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
        renderMediaCommon({ imageUrl: imageUrl, mediaType: mediaType }, 'maker', false);

        if (imageUrl) {
            document.getElementById('maker-add-media-toggle').checked = true;
            document.getElementById('maker-media-fields').style.display = 'none';
            document.getElementById('btn-change-media').innerText = 'Change Media';
        } else {
            document.getElementById('btn-change-media').innerText = 'Add Media';
        }


        if (!text) throw new Error("Question text is required");

        let q = { type, text, context, imageUrl, mediaType, timer, freePoint };

        if (type === 'multiple-choice') {
            const opts = [];
            let correctOptObj = null;
            const selectedRadioEl = document.querySelector('input[name="mc-correct"]:checked');
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
            // No longer throwing error on auto-save
            // if (opts.length < 2) throw new Error("Please provide at least 2 multiple choice options.");
            // if (!correctOptObj && !freePoint) throw new Error("The selected correct answer is blank!");

            q.options = opts;
            q.correctAnswer = correctOptObj || opts[0];
            q.acceptedAnswers = [q.correctAnswer];

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
            const hasCorrect = !!document.querySelector('input[name="mc-correct"]:checked');
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
        renderOptions('options-container', q, !isPreview, 0, false);
    } else {
        document.getElementById('options-container').innerHTML = '<h3 style="text-align:center; margin-top:2rem; color:var(--text-muted);">Information Slide - Please review the content</h3>';
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
        document.getElementById('host-total-players').innerText = count;

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
    const imgEl = document.getElementById(`${prefix}-image`);
    const vidEl = document.getElementById(`${prefix}-video`);
    let ytEl = document.getElementById(`${prefix}-youtube`);

    if (mediaContainer && !q.imageUrl) {
        mediaContainer.style.display = 'none';
        if (vidEl) vidEl.pause();
        if (mediaContainer) {
            mediaContainer.dataset.currentUrl = '';
            mediaContainer.dataset.currentType = '';
        }
        return;
    }

    if (mediaContainer) {
        if (mediaContainer.dataset.currentUrl === q.imageUrl && mediaContainer.dataset.currentType === q.mediaType) {
            return; // Media hasn't changed, skip re-rendering to prevent page shaking
        }
        mediaContainer.dataset.currentUrl = q.imageUrl || '';
        mediaContainer.dataset.currentType = q.mediaType || '';
        mediaContainer.style.display = prefix === 'ekg' ? 'flex' : 'block';
    }

    if (!ytEl && vidEl) {
        ytEl = document.createElement('iframe');
        ytEl.id = `${prefix}-youtube`;
        ytEl.style.display = 'none';
        ytEl.style.width = '100%';
        ytEl.style.maxHeight = prefix === 'ekg' ? '100%' : '250px';
        ytEl.style.borderRadius = '8px';
        ytEl.style.border = 'none';
        ytEl.setAttribute('allowfullscreen', 'true');
        ytEl.setAttribute('allow', 'autoplay; encrypted-media');
        vidEl.parentNode.insertBefore(ytEl, vidEl.nextSibling);
    }

    if (imgEl) imgEl.style.display = 'none';
    if (vidEl) { vidEl.style.display = 'none'; vidEl.pause(); }
    if (ytEl) { ytEl.style.display = 'none'; ytEl.src = ''; }

    if (q.mediaType === 'video') {
        const isYoutube = q.imageUrl.includes('youtube.com') || q.imageUrl.includes('youtu.be');
        if (isYoutube && ytEl) {
            ytEl.style.display = prefix === 'ekg' ? 'block' : 'inline-block';
            let videoId = '';
            if (q.imageUrl.includes('youtu.be/')) {
                videoId = q.imageUrl.split('youtu.be/')[1].split('?')[0];
            } else if (q.imageUrl.includes('v=')) {
                videoId = new URLSearchParams(new URL(q.imageUrl).search).get('v');
            }
            ytEl.src = `https://www.youtube.com/embed/${videoId}?rel=0${autoplay ? '&autoplay=1&mute=1' : ''}`;
        } else if (vidEl) {
            vidEl.style.display = prefix === 'ekg' ? 'block' : 'inline-block';
            vidEl.src = q.imageUrl;
            if (autoplay) vidEl.play().catch(e => console.log('Autoplay blocked'));
        }
    } else if (imgEl) {
        imgEl.style.display = prefix === 'ekg' ? 'block' : 'inline-block';
        imgEl.src = q.imageUrl;
    }
}

function renderOptions(containerId, q, isInteractive, qIndex, isFeedback = false, myAnswer = null) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (q.type === 'multiple-choice' || q.type === 'true-false') {
        q.options.forEach((optRaw, idx) => {
            const btn = document.createElement('button');
            btn.className = 'option-btn kahoot-btn';

            const isImg = typeof optRaw === 'string' ? false : optRaw.isImage;
            const text = typeof optRaw === 'string' ? optRaw : optRaw.text;

            const colors = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#8b3dff'];
            const shapes = ['▲', '♦', '●', '■', '★'];

            btn.style.backgroundColor = colors[idx % colors.length];

            let contentHtml = "";
            if (isImg) {
                contentHtml = `<img src="${text}" class="option-img-choice" style="max-height:80px; background:white; border-radius:4px; margin-left:10px;">`;
            } else {
                contentHtml = `<span class="kahoot-answer-text">${text}</span>`;
            }

            btn.innerHTML = `<span class="kahoot-shape">${shapes[idx % shapes.length]}</span> ${contentHtml}`;

            if (isFeedback) {
                let isCorrectAnswer = false;
                if (!q.freePoint) {
                    const correctObj = q.correctAnswer;
                    const cText = typeof correctObj === 'string' ? correctObj : (correctObj ? correctObj.text : "");
                    if (text === cText) isCorrectAnswer = true;
                } else {
                    // For free points, all answers are considered correct/undimmed
                    isCorrectAnswer = true;
                }

                // Stagger the reveal for a game-show cascade effect
                btn.style.animationDelay = (idx * 0.08) + 's';

                if (isCorrectAnswer) {
                    btn.classList.add('reveal-correct');
                } else {
                    btn.classList.add('dimmed');
                    if (myAnswer != null && text === myAnswer) {
                        btn.classList.add('reveal-wrong');
                    }
                }
            } else if (isInteractive) {
                btn.onclick = () => submitAnswer(text, q, qIndex);
            }
            container.appendChild(btn);
        });
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
function startQuestionFlow() {
    db.ref(`rooms/${roomCode}`).update({
        gameState: 'starting_countdown',
        currentQuestionIndex: currentQuestionIndex
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

    if (q.type !== 'info') {
        renderOptions('options-container', q, false, currentQuestionIndex, false);
    } else {
        document.getElementById('options-container').innerHTML = ''; // Clear options
    }

    timeLeft = q.timer;
    window._currentTimerMax = timeLeft;
    setHudTimer(timeLeft);
    setQuizProgress(currentQuestionIndex, customQuizData.length);

    if (q.type === 'info') {
        document.getElementById('host-answers-count').parentElement.style.display = 'none';
    } else {
        document.getElementById('host-answers-count').parentElement.style.display = 'block';
        document.getElementById('host-answers-count').innerText = "0";
    }

    if (currentQuestionIndex === customQuizData.length - 1) {
        document.getElementById('btn-host-next').innerText = q.type === 'info' ? "Next (Finish Quiz)" : "Skip (Finish Quiz)";
    } else {
        document.getElementById('btn-host-next').innerText = q.type === 'info' ? "Next Slide" : "Skip / Next";
    }

    if (hostPlayersListener) {
        db.ref(`rooms/${roomCode}/players`).off('value', hostPlayersListener);
        hostPlayersListener = null;
    }

    if (q.type !== 'info') {
        hostPlayersListener = (snapshot) => {
            const pList = snapshot.val() || {};
            const total = Object.keys(pList).length;
            const answered = Object.values(pList).filter(p => p.hasAnswered === currentQuestionIndex).length;
            document.getElementById('host-answers-count').innerText = answered;
            document.getElementById('host-total-players').innerText = total;

            if (total > 0 && answered === total) endQuestion();
        };
        db.ref(`rooms/${roomCode}/players`).on('value', hostPlayersListener);
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
    const apiKey = localStorage.getItem('aiApiKey') || HARDCODED_AI_KEY;
    const provider = localStorage.getItem('aiProvider') || HARDCODED_AI_PROVIDER;
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

    const model = localStorage.getItem('aiModel') || HARDCODED_AI_MODEL || AI_PROVIDERS[provider].defaultModel;

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

    let promptText = `You are a strict but fair medical professor grading short-answer quiz responses.\n`;
    promptText += `Grade only what is explicitly supported by each student's answer. Do not assume a concept was meant if it is absent.\n`;
    promptText += `Question context: ${JSON.stringify(q.context || '')}\n`;
    promptText += `Question: ${JSON.stringify(q.text || '')}\n`;
    promptText += `Scoring mode: ${q.partialCredit === false ? 'all-or-nothing' : 'partial credit'}\n`;
    promptText += `Rubric (each concept is independent):\n`;
    rubric.forEach(item => {
        promptText += `- conceptId ${item.id}: ${JSON.stringify(item.concept)} (${item.points} points)\n`;
    });
    promptText += `The rubric total is ${rubricTotal} points. The final score must be an integer from 0 to ${maxPoints}.\n`;
    promptText += `Award points when the answer uses a valid synonym, abbreviation, or minor spelling variation. Do not award points for a related but clinically different diagnosis.\n`;
    promptText += `For all-or-nothing mode, score ${rubricTotal} only when every required concept is demonstrated; otherwise score 0.\n`;
    promptText += `Return ONLY valid JSON in this exact shape: {"answers":[{"id":"A1","score":0,"confidence":0.0,"concepts":[{"conceptId":1,"matched":false,"points":0,"reason":"brief reason"}]}]}\n`;
    promptText += `Use every answer ID exactly once. confidence must be between 0 and 1.\n\n`;
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

            let pts = Number(aiAnswer.score);
            if (!Number.isFinite(pts)) pts = 0;
            pts = Math.max(0, Math.min(rubricTotal, Math.round(pts)));
            if (q.partialCredit === false) pts = pts === rubricTotal ? maxPoints : 0;
            if (pts === maxPoints && maxPoints > 0) pts += 150; // Preserve existing bonus
            updates[`rooms/${roomCode}/players/${source.playerName}/lastPointsEarned`] = pts;
            updates[`rooms/${roomCode}/players/${source.playerName}/awardedPoints/${qIndex}`] = pts;
            updates[`rooms/${roomCode}/players/${source.playerName}/aiGrading`] = {
                score: pts > 150 ? pts - 150 : pts,
                confidence: Math.max(0, Math.min(1, Number(aiAnswer.confidence) || 0)),
                concepts: Array.isArray(aiAnswer.concepts) ? aiAnswer.concepts : []
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
        Swal.fire('AI Grading Error', e.message, 'error');
        // Fallback on error
        for (let i = 0; i < answersToGrade.length; i++) {
            let pts = getTypingAnswerScore(answersToGrade[i].answer, q);
            if (pts === maxPoints && maxPoints > 0) pts += 150; // Bonus
            updates[`rooms/${roomCode}/players/${answersToGrade[i].playerName}/lastPointsEarned`] = pts;
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
    if (q.type === 'multiple-choice') {
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
            answersCount[ans] = (answersCount[ans] || 0) + 1;
            totalAnswers++;
        }
    }

    if (true) {
        let chartHTML = `<h4 style="color:var(--text-main); margin-bottom: 0.5rem; text-align:center;">Responses:</h4>`;

        let cText = "";
        if (q.type === 'multiple-choice' || q.type === 'true-false') {
            cText = typeof q.correctAnswer === 'string' ? q.correctAnswer : q.correctAnswer.text;
        }

        for (let ans in answersCount) {
            const count = answersCount[ans];
            const pct = totalAnswers > 0 ? Math.round((count / totalAnswers) * 100) : 0;

            let isCorrectAnswer = false;
            let barColor = 'var(--danger)';
            if (q.type === 'multiple-choice' || q.type === 'true-false') {
                isCorrectAnswer = (ans === cText);
                barColor = isCorrectAnswer ? 'var(--success)' : 'var(--danger)';
            } else {
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
            }

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
        chartContainer.innerHTML = chartHTML;
    }
}

async function showHostFeedback() {
    switchScreen('feedback');
    const q = customQuizData[currentQuestionIndex];
    document.getElementById('feedback-title').innerText = "Time's Up!";
    document.getElementById('feedback-title').className = "";

    // Render the choices, highlighting the correct one
    renderOptions('feedback-options-container', q, false, currentQuestionIndex, true);

    // Render the bar chart
    await renderFeedbackChart('feedback-chart', q, currentQuestionIndex);

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

    const snap = await db.ref(`rooms/${roomCode}`).get();
    const room = snap.val();
    const q = room.quizData[room.currentQuestionIndex];

    // Show question number above the image
    const qNumEl = document.getElementById('student-q-num');
    if (qNumEl) {
        qNumEl.innerText = `Question ${room.currentQuestionIndex + 1} / ${room.quizData.length}`;
        qNumEl.style.display = 'block';
    }

    document.getElementById('clinical-context').innerText = q.context || "";
    document.getElementById('question-text').innerText = q.text;
    document.getElementById('question-text').style.wordBreak = 'normal';
    document.getElementById('question-text').style.overflowWrap = 'break-word';

    renderMediaCommon(q, 'ekg', true);

    if (q.type !== 'info') {
        renderOptions('options-container', q, true, room.currentQuestionIndex, false);
    } else {
        document.getElementById('options-container').innerHTML = '<h3 style="text-align:center; margin-top:2rem; color:var(--text-muted);">Information Slide - Please review the content</h3>';
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
    if (!q.freePoint) {
        if (q.type === 'multiple-choice' || q.type === 'true-false') {
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
    if (q.type === 'typing' && q.aiGrading && !q.freePoint) {
        studentCurrentPointsEarned = 'pending_ai';
    } else if (isCorrect && !q.freePoint) {
        if (q.type === 'typing') {
            studentCurrentPointsEarned = typingRawEarned;
            const max = getTypingMaxPoints(q);
            if (typingRawEarned === max && max > 0) {
                studentCurrentPointsEarned += 150; // Bonus for max points
            }
        } else {
            let maxPts = 100 + Math.floor((timeLeft / q.timer) * 50);
            studentCurrentPointsEarned = Math.floor(maxPts * scoreFrac);
        }
    } else {
        studentCurrentPointsEarned = 0;
    }

    // We store the answer in 'lastAnswer' for the host tally and in 'answers' history for review.
    let updateObj = {
        hasAnswered: qIndex,
        lastAnswer: answer,
        [`answerMeta/${qIndex}`]: {
            submittedAt: firebase.database.ServerValue.TIMESTAMP,
            timeLeftAtSubmit: timeLeft,
            localPoints: q.type === 'typing' ? typingRawEarned : Math.floor((100 + Math.floor((timeLeft / (q.timer || 1)) * 50)) * scoreFrac),
            localCorrect: isCorrect,
            questionType: q.type
        }
    };
    updateObj[`answers/${qIndex}`] = answer;

    await db.ref(`rooms/${roomCode}/players/${playerName}`).update(updateObj);
}

async function showStudentFeedback() {
    clearInterval(localTimer);
    document.getElementById('ekg-video').pause();

    // Fetch state first to avoid flashing old question data
    const snap = await db.ref(`rooms/${roomCode}`).get();
    const room = snap.val();
    const q = room.quizData[room.currentQuestionIndex];

    const title = document.getElementById('feedback-title');
    const pts = document.getElementById('feedback-points');
    const myAnsEl = document.getElementById('feedback-your-answer');

    // Fetch player's answer for this question (also used for reveal + score)
    const pSnap = await db.ref(`rooms/${roomCode}/players/${playerName}/answers/${room.currentQuestionIndex}`).get();
    const myAns = pSnap.exists() ? pSnap.val() : null;

    // Render the choices, highlighting the correct one (non-interactive)
    renderOptions('feedback-options-container', q, false, room.currentQuestionIndex, true, myAns);

    // For typing questions: show the rich two-panel highlight feedback
    const typingPanel = document.getElementById('feedback-typing-panel');
    if (q.type === 'typing') {
        myAnsEl.style.display = 'none'; // hide the plain text line
        if (typingPanel) {
            typingPanel.style.display = 'block';
            typingPanel.innerHTML = buildTypingFeedbackHTML(myAns, q);
        }
    } else {
        if (typingPanel) typingPanel.style.display = 'none';
        // For MC / T-F: show simple "Your Answer" line
        myAnsEl.style.display = 'block';
        myAnsEl.innerText = myAns ? `Your Answer: ${myAns}` : 'Your Answer: None';
    }

    // Render the bar chart
    await renderFeedbackChart('feedback-chart', q, room.currentQuestionIndex);

    // Switch screen only after all DOM updates are complete
    switchScreen('feedback');

    // If AI grading was used, fetch the result computed by the host
    if (studentCurrentPointsEarned === 'pending_ai') {
        // lastPointsEarned is stored on the PLAYER node, not the answer node
        const playerSnap = await db.ref(`rooms/${roomCode}/players/${playerName}`).get();
        const aiPoints = playerSnap.val()?.lastPointsEarned;
        studentCurrentPointsEarned = (typeof aiPoints === 'number') ? aiPoints : 0;
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

        const currentScore = pSnap.val().score || 0;
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

    // Populate podium data
    if (sorted[0]) {
        document.getElementById('podium-name-1').innerText = `${avatarFor(sorted[0][0])} ${sorted[0][0]}`;
        document.getElementById('podium-score-1').innerText = sorted[0][1].score + ' pts';
    }
    if (sorted[1]) {
        document.getElementById('podium-name-2').innerText = `${avatarFor(sorted[1][0])} ${sorted[1][0]}`;
        document.getElementById('podium-score-2').innerText = sorted[1][1].score + ' pts';
    }
    if (sorted[2]) {
        document.getElementById('podium-name-3').innerText = `${avatarFor(sorted[2][0])} ${sorted[2][0]}`;
        document.getElementById('podium-score-3').innerText = sorted[2][1].score + ' pts';
    }

    // Animate sequence
    setTimeout(() => {
        if(titleEl) titleEl.style.opacity = '1';
    }, 500);

    setTimeout(() => {
        if(sorted[2]) document.getElementById('podium-3').classList.add('revealed');
    }, 1500);

    setTimeout(() => {
        if(sorted[1]) document.getElementById('podium-2').classList.add('revealed');
    }, 2500);

    setTimeout(() => {
        if(sorted[0]) {
            document.getElementById('podium-1').classList.add('revealed');
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
        if (q.type === 'multiple-choice' || q.type === 'true-false') {
            const cText = typeof q.correctAnswer === 'string' ? q.correctAnswer : q.correctAnswer.text;
            const cImg = typeof q.correctAnswer === 'string' ? false : q.correctAnswer.isImage;

            if (cImg) {
                correctHtml = `<div class="review-answer">Correct Answer:<br><img src="${cText}" style="max-height:50px; margin-top:5px; border-radius:4px;"></div>`;
            } else {
                correctHtml = `<div class="review-answer">Correct Answer: ${cText}</div>`;
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
            const myAns = studentAnswers[idx] || 'No Answer';
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

    // Populate standard feedback data directly to ensure Host and Student see exactly the same layout
    renderOptions('feedback-options-container', qData, false, currentQuestionIndex, true);
    renderFeedbackChart('feedback-chart', qData, currentQuestionIndex);

    const myAnsEl = document.getElementById('feedback-your-answer');
    if (role === 'student') {
        db.ref(`rooms/${roomCode}/players/${playerName}/answers/${currentQuestionIndex}`).get().then(pSnap => {
            if (pSnap.exists()) {
                const myAns = pSnap.val();
                myAnsEl.style.display = 'block';
                myAnsEl.innerText = `Your Answer: ${myAns}`;
            } else {
                myAnsEl.style.display = 'block';
                myAnsEl.innerText = `Your Answer: None`;
            }
        });
    } else {
        myAnsEl.style.display = 'none';
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

        let cText = "";
        if (q.type === 'multiple-choice' || q.type === 'true-false') {
            cText = typeof q.correctAnswer === 'string' ? q.correctAnswer : q.correctAnswer.text;
            if (typeof q.correctAnswer !== 'string' && q.correctAnswer.isImage) {
                printContents += `<div class="q-answer">Correct Answer: <img class="q-media" src="${cText}" style="max-height:100px;"/></div>`;
            } else {
                printContents += `<div class="q-answer">Correct Answer: ${cText}</div>`;
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
            const myAns = studentAnswers[idx] || 'No Answer';
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
        // Skip the import quiz select — keep it as a native <select> so change events fire reliably
        if (select.id === 'import-quiz-select') return;
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

        select.addEventListener('change', () => {
            updateTrigger();
            optionsContainer.querySelectorAll('.custom-option').forEach((opt, idx) => {
                if (idx === select.selectedIndex) opt.classList.add('selected');
                else opt.classList.remove('selected');
            });
        });
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
