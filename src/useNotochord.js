/**
 * useNotochord — MIDI plumbing + MelodyRNN/ImprovRNN free-gen loop for coimproviser.
 *
 * Free-gen lifecycle:
 *   startFreeGen() → magentaStep loop ticks at grid (or jittered eighth)
 *   Player note-on → activeModel.addSeedNote(pitch) clears buffer; next
 *                    refill primes from recent player input
 *   Player note-off → echo only
 *   reset()        → stops generation, releases any held model note
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Scale, Note } from 'tonal';
import { MagentaMelodyModel, MagentaImprovModel } from './magentaModel.js';
import { SessionRecorder } from './sessionRecorder.js';
import { PlayerStats } from './playerStats.js';
import { HarmonyClient } from './harmonyClient.js';

export const DEFAULT_CONTROLS = {
    pitchTemp:       1.0,
    minPitch:        0,
    maxPitch:        127,
    scaleMaskOn:     false,
    scaleRoot:       'C#',
    scaleName:       'minor pentatonic',
    bpm:             120,
    subdiv:          0.5,   // 0 = free (jittered eighth), >0 = grid subdivision in beats
    autoDetectChord: true,  // when on, ImprovRNN chord is inferred from recent player notes
    // Listener — model adapts to player dynamics and register
    velocityFollow:  0.5,   // 0 = ignore player dynamics, 1 = match them
    registerOffset:  12,    // semitones: where model sits relative to player register
    registerWidth:   48,    // semitones: window around the centered register
    restGate:        false, // when on, model goes silent while player is silent
    silenceMs:       1500,  // how long of player silence before model rests
    humanize:        0.6,   // 0 = mechanical (uniform duration & velocity), 1 = full variation
};

export const PARAM_RANGES = {
    pitchTemp:      { min: 0,    max: 1,    step: 0.01 },
    minPitch:       { min: 0,    max: 127,  step: 1    },
    maxPitch:       { min: 0,    max: 127,  step: 1    },
    bpm:            { min: 40,   max: 240,  step: 1    },
    velocityFollow: { min: 0,    max: 1,    step: 0.01 },
    registerOffset: { min: -24,  max: 24,   step: 1    },
    registerWidth:  { min: 12,   max: 48,   step: 1    },
    silenceMs:      { min: 500,  max: 3000, step: 100  },
    humanize:       { min: 0,    max: 1,    step: 0.01 },
};

// Maps scale name → chord quality suffix for ImprovRNN chord conditioning.
const SCALE_CHORD = {
    'major':            '',
    'major pentatonic': '',
    'minor':            'm',
    'minor pentatonic': 'm',
    'dorian':           'm7',
    'mixolydian':       '7',
    'chromatic':        '',
};

function scaleToChord(root, scaleName) {
    return `${root}${SCALE_CHORD[scaleName] ?? ''}`;
}

// Pitch-class templates for common triads/sevenths, intervals from root.
// Order matters slightly — earlier entries win on score ties (preferring
// simpler triads over 7th chords when both fit equally).
const CHORD_TEMPLATES = [
    { suffix: '',     pcs: [0, 4, 7]      },  // major
    { suffix: 'm',    pcs: [0, 3, 7]      },  // minor
    { suffix: 'sus4', pcs: [0, 5, 7]      },  // sus4
    { suffix: 'sus2', pcs: [0, 2, 7]      },  // sus2
    { suffix: 'dim',  pcs: [0, 3, 6]      },  // diminished
    { suffix: 'aug',  pcs: [0, 4, 8]      },  // augmented
    { suffix: '7',    pcs: [0, 4, 7, 10]  },  // dominant 7
    { suffix: 'maj7', pcs: [0, 4, 7, 11]  },  // major 7
    { suffix: 'm7',   pcs: [0, 3, 7, 10]  },  // minor 7
    { suffix: 'm7b5', pcs: [0, 3, 6, 10]  },  // half-diminished
];

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Score each (root, template) pairing against the played pitch-class set.
// +3 per template tone present, −4 per template tone missing, −2 per extra
// pitch class not in the template. Slight bias toward triads over 7ths.
// Returns the highest-scoring chord name or null.
function detectChordFromPitches(pitches) {
    if (pitches.length < 2) return null;
    const set = new Set(pitches.map(p => p % 12));
    if (set.size < 2) return null;

    let best = null;
    let bestScore = -Infinity;

    for (let root = 0; root < 12; root++) {
        for (const tmpl of CHORD_TEMPLATES) {
            const expected = tmpl.pcs.map(i => (root + i) % 12);
            const present  = expected.filter(pc => set.has(pc)).length;
            if (present < 2) continue;  // never call something a chord on one matching tone
            const missing  = expected.length - present;
            const extra    = [...set].filter(pc => !expected.includes(pc)).length;
            const score    = present * 3 - missing * 4 - extra * 2
                           - (tmpl.pcs.length > 3 ? 0.5 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = `${PC_NAMES[root]}${tmpl.suffix}`;
            }
        }
    }
    return best;
}

function ccToParam(ccVal, { min, max, step }) {
    const raw   = min + (ccVal / 127) * (max - min);
    const steps = Math.round((raw - min) / step);
    return +Math.max(min, Math.min(max, min + steps * step)).toFixed(6);
}

function computeIncludePitch({ scaleMaskOn, scaleRoot, scaleName, minPitch, maxPitch }) {
    let pitches = null;

    if (scaleMaskOn) {
        const scale = Scale.get(`${scaleRoot} ${scaleName}`);
        if (scale.notes.length > 0) {
            const chromas = new Set(scale.notes.map(n => Note.get(n).chroma));
            pitches = Array.from({ length: 128 }, (_, i) => i)
                .filter(p => chromas.has(p % 12));
        }
    }

    if (minPitch > 0 || maxPitch < 127) {
        if (pitches) {
            pitches = pitches.filter(p => p >= minPitch && p <= maxPitch);
        } else {
            pitches = Array.from({ length: maxPitch - minPitch + 1 }, (_, i) => i + minPitch);
        }
    }

    return pitches && pitches.length > 0 ? pitches : null;
}

function nearestAllowed(pitch, includePitch) {
    if (!includePitch || includePitch.length === 0) return pitch;
    return includePitch.reduce((best, p) =>
        Math.abs(p - pitch) < Math.abs(best - pitch) ? p : best
    , includePitch[0]);
}

// Sample a note-duration ratio (relative to the grid tick interval).
// At humanize=0 every note is ~0.9 of the tick (a hair short of legato).
// At humanize=1 a mix of staccato / normal / legato gives natural feel.
// Distribution: 15% staccato, 55% normal, 30% legato.
function sampleDurationRatio(humanize) {
    const base = 0.9;
    if (humanize <= 0) return base;
    const r = Math.random();
    let varied;
    if (r < 0.15)      varied = 0.3 + Math.random() * 0.3;   // staccato (15%)
    else if (r < 0.70) varied = 0.7 + Math.random() * 0.4;   // normal   (55%)
    else               varied = 1.1 + Math.random() * 0.4;   // legato   (30%)
    return base + (varied - base) * humanize;
}

// Sample a velocity multiplier for attack variation. At humanize=0 every note
// is full strength; at humanize=1 a mix of ghost notes / normal / accents gives
// the feel of a player varying touch from note to note.
// Distribution: 60% ghost, 20% normal, 20% accent.
function sampleVelocityRatio(humanize) {
    const base = 1.0;
    if (humanize <= 0) return base;
    const r = Math.random();
    let varied;
    if (r < 0.60)      varied = 0.45 + Math.random() * 0.25; // ghost   (~0.45-0.70)
    else if (r < 0.80) varied = 0.85 + Math.random() * 0.30; // normal  (~0.85-1.15)
    else               varied = 1.15 + Math.random() * 0.25; // accent  (~1.15-1.40)
    return base + (varied - base) * humanize;
}

export function useNotochord() {
    // ── Refs ──────────────────────────────────────────────────────────────────

    const midiOutRef         = useRef(null);
    const activeInputRef     = useRef(null);
    const midiAccessRef      = useRef(null);
    const controlsRef        = useRef(DEFAULT_CONTROLS);
    const ccBindingsRef      = useRef(new Map());
    const learningRef        = useRef(null);
    const freeGenRef         = useRef(false);
    const noteCallbackRef    = useRef(null);
    const magentaRef         = useRef(new MagentaMelodyModel());
    const improvRef          = useRef(new MagentaImprovModel());
    const activeModelRef     = useRef(magentaRef.current);  // points to whichever model is selected
    const modelHeldRef       = useRef(new Map());  // pitch → timeout ID for scheduled note-offs
    const sessionRecorderRef = useRef(new SessionRecorder());
    const sessionRunningRef  = useRef(false);
    const playerStatsRef     = useRef(new PlayerStats());
    const lastChordRef       = useRef(null);  // last chord applied to ImprovRNN
    const harmonyClientRef   = useRef(new HarmonyClient());

    // ── State ─────────────────────────────────────────────────────────────────

    const [midiInputs,       setMidiInputs]       = useState([]);
    const [midiOutputs,      setMidiOutputs]      = useState([]);
    const [selectedInputId,  setSelectedInputId]  = useState('');
    const [selectedOutputId, setSelectedOutputId] = useState('');
    const [controls, _setControls]                = useState(DEFAULT_CONTROLS);
    const [ccBindings,    setCcBindings]          = useState({});
    const [learning,      setLearning]            = useState(null);
    const [freeGenRunning, setFreeGenRunning]     = useState(false);
    const [magentaStatus,  setMagentaStatus]      = useState('idle');
    const [improvStatus,   setImprovStatus]       = useState('idle');
    const [model,          setModel]              = useState('magenta');
    const [sessionRunning,   setSessionRunning]   = useState(false);
    const [sessionNoteCount, setSessionNoteCount] = useState(0);
    const [currentChord,     setCurrentChord]     = useState(null);
    const [progression,      setProgression]      = useState([]);   // chord array from server
    const [detectedKey,      setDetectedKey]      = useState(null); // "C major", etc.
    const [harmonyStatus,    setHarmonyStatus]    = useState('offline');

    const setControls = useCallback((patch) => {
        _setControls(prev => {
            const next = { ...prev, ...patch };
            controlsRef.current = next;
            return next;
        });
    }, []);

    const syncCcDisplay = useCallback(() => {
        const display = {};
        for (const [ccNum, key] of ccBindingsRef.current) display[key] = ccNum;
        setCcBindings(display);
    }, []);

    // Load MelodyRNN once on mount.
    useEffect(() => {
        magentaRef.current.init(setMagentaStatus);
    }, []);

    // Harmony engine: auto-connect on mount; silently falls to offline if the
    // Python server isn't up. When a progression arrives, route it to ImprovRNN.
    useEffect(() => {
        const hc = harmonyClientRef.current;
        hc.onStatus(setHarmonyStatus);
        hc.onProgression(({ chords, key }) => {
            if (Array.isArray(chords) && chords.length > 0) {
                improvRef.current.setChord(chords);
                setProgression(chords);
            }
            if (key) setDetectedKey(key);
        });
        hc.connect();
        return () => hc.disconnect();
    }, []);

    // Keep temperature in sync with the slider for both models.
    useEffect(() => {
        magentaRef.current.setTemperature(controls.pitchTemp);
        improvRef.current.setTemperature(controls.pitchTemp);
    }, [controls.pitchTemp]);

    // Single mutation path for ImprovRNN's chord. Skips no-op re-applies and
    // mirrors the chord into UI state. When the harmony engine is connected,
    // ask it for a projected progression — its response will override the
    // single-chord assignment with a multi-chord progression.
    const applyChord = useCallback((chord) => {
        if (!chord || chord === lastChordRef.current) return;
        lastChordRef.current = chord;
        improvRef.current.setChord([chord]);
        setCurrentChord(chord);
        setProgression([]);
        // Send recent pitch history so the server can estimate the key.
        const history = playerStatsRef.current.recentPitches(6000);
        harmonyClientRef.current.requestProgression(chord, history);
    }, []);

    // Prefer pitches the player is currently holding (clean chord input);
    // fall back to the recent window only when nothing is held.
    const chordInputPitches = useCallback(() => {
        const held = playerStatsRef.current.heldPitches();
        if (held.length >= 2) return held;
        return playerStatsRef.current.recentPitches(800);
    }, []);

    // Scale → chord fallback. When auto-detect is on, scale changes don't
    // override the live-detected chord — they only re-seed it when the player
    // has been silent (or no chord has ever been detected).
    useEffect(() => {
        const scaleChord = scaleToChord(controls.scaleRoot, controls.scaleName);
        if (controls.autoDetectChord) {
            const detected = detectChordFromPitches(chordInputPitches());
            applyChord(detected ?? scaleChord);
        } else {
            applyChord(scaleChord);
        }
    }, [controls.scaleRoot, controls.scaleName, controls.autoDetectChord, applyChord, chordInputPitches]);

    // ── MIDI event handler ────────────────────────────────────────────────────

    const onMIDI = useCallback(({ data }) => {
        const [status, byte1, byte2] = data;
        const ch   = status & 0x0F;
        const type = status & 0xF0;

        if (type === 0xB0) {
            const ccNum = byte1;
            const ccVal = byte2;

            if (learningRef.current) {
                const controlKey = learningRef.current;
                for (const [k, v] of ccBindingsRef.current) {
                    if (k === ccNum || v === controlKey) ccBindingsRef.current.delete(k);
                }
                ccBindingsRef.current.set(ccNum, controlKey);
                learningRef.current = null;
                setLearning(null);
                syncCcDisplay();
                return;
            }

            const controlKey = ccBindingsRef.current.get(ccNum);
            if (controlKey && PARAM_RANGES[controlKey]) {
                setControls({ [controlKey]: ccToParam(ccVal, PARAM_RANGES[controlKey]) });
            }
            return;
        }

        const note     = byte1;
        const velocity = byte2;
        const isOn  = type === 0x90 && velocity > 0;
        const isOff = type === 0x80 || (type === 0x90 && velocity === 0);

        if (isOn && learningRef.current) {
            learningRef.current = null;
            setLearning(null);
        }

        if (isOn) {
            midiOutRef.current?.send([0x90 | ch, note, velocity]);
            activeModelRef.current.addSeedNote(note);
            playerStatsRef.current.push(note, velocity);
            if (controlsRef.current.autoDetectChord) {
                const detected = detectChordFromPitches(chordInputPitches());
                if (detected) applyChord(detected);
            }
            sessionRecorderRef.current.record('on', note, velocity);
            if (sessionRunningRef.current) setSessionNoteCount(c => c + 1);
        }

        if (isOff) {
            midiOutRef.current?.send([0x80 | ch, note, 0]);
            playerStatsRef.current.release(note);
            sessionRecorderRef.current.record('off', note, 0);
        }
    }, [setControls, syncCcDisplay, applyChord, chordInputPitches]);

    // ── MIDI access ───────────────────────────────────────────────────────────

    useEffect(() => {
        async function init() {
            let access;
            try { access = await navigator.requestMIDIAccess({ sysex: false }); }
            catch { return; }
            midiAccessRef.current = access;

            function buildLists() {
                setMidiInputs( [...access.inputs.values()].map(d => ({ id: d.id, name: d.name })));
                setMidiOutputs([...access.outputs.values()].map(d => ({ id: d.id, name: d.name })));
            }
            buildLists();
            access.onstatechange = buildLists;

            const defIn  = [...access.inputs.values()].find(i => i.name.toLowerCase().includes('mpk'))
                        ?? access.inputs.values().next().value;
            const defOut = [...access.outputs.values()].find(o => o.name.toLowerCase().includes('iac'))
                        ?? access.outputs.values().next().value;
            if (defIn)  setSelectedInputId(defIn.id);
            if (defOut) setSelectedOutputId(defOut.id);
        }
        init();
    }, []);

    useEffect(() => {
        const access = midiAccessRef.current;
        if (!access || !selectedInputId) return;
        activeInputRef.current?.removeEventListener('midimessage', onMIDI);
        const inp = access.inputs.get(selectedInputId) ?? null;
        inp?.addEventListener('midimessage', onMIDI);
        activeInputRef.current = inp;
        return () => inp?.removeEventListener('midimessage', onMIDI);
    }, [selectedInputId, onMIDI]);

    useEffect(() => {
        const access = midiAccessRef.current;
        if (!access || !selectedOutputId) return;
        midiOutRef.current = access.outputs.get(selectedOutputId) ?? null;
    }, [selectedOutputId]);

    // ── MelodyRNN / ImprovRNN free-gen loop ───────────────────────────────────

    const releaseModelNote = useCallback((pitch) => {
        const t = modelHeldRef.current.get(pitch);
        if (t != null) clearTimeout(t);
        modelHeldRef.current.delete(pitch);
        midiOutRef.current?.send([0x80, pitch, 0]);
    }, []);

    const magentaStep = useCallback(() => {
        if (!freeGenRef.current) return;
        const c     = controlsRef.current;
        const mag   = activeModelRef.current;
        const stats = playerStatsRef.current.stats(1500);

        const shouldRest = c.restGate
            && playerStatsRef.current.silentFor() > c.silenceMs;

        // Compute next-tick delay first; durations are sized relative to it
        // so legato/staccato variation reads naturally against the grid.
        let delayMs;
        if (c.subdiv > 0 && c.bpm > 0) {
            delayMs = (60000 / c.bpm) * c.subdiv;
        } else {
            const base = c.bpm > 0 ? (60000 / c.bpm) * 0.5 : 300;
            delayMs = base * (0.65 + Math.random() * 0.70);
        }

        let pitch = mag.popPitch();
        if (pitch != null && !shouldRest) {
            const hasPlayerData = stats.density > 0;
            let allowed = computeIncludePitch(c);
            if (hasPlayerData) {
                const center = stats.registerCentroid + c.registerOffset;
                const regMin = Math.max(0,   Math.round(center - c.registerWidth / 2));
                const regMax = Math.min(127, Math.round(center + c.registerWidth / 2));
                if (allowed) {
                    const narrowed = allowed.filter(p => p >= regMin && p <= regMax);
                    if (narrowed.length > 0) allowed = narrowed;
                } else {
                    allowed = Array.from(
                        { length: regMax - regMin + 1 },
                        (_, i) => i + regMin,
                    );
                }
            }
            if (allowed) pitch = nearestAllowed(pitch, allowed);

            // Velocity: follow player mean, then humanize by sampling a touch
            // ratio that produces real ghost notes, normal hits, and accents.
            const baseVel = Math.round(80 + (stats.meanVel - 80) * c.velocityFollow);
            const ratio   = sampleVelocityRatio(c.humanize);
            const vel     = Math.max(20, Math.min(127, Math.round(baseVel * ratio)));

            // Retrigger if the same pitch is still ringing from before.
            if (modelHeldRef.current.has(pitch)) releaseModelNote(pitch);

            midiOutRef.current?.send([0x90, pitch, vel]);
            noteCallbackRef.current?.({ pitch, velocity: vel, source: 'model' });

            // Schedule note-off at a humanized duration relative to the tick.
            const durationMs = delayMs * sampleDurationRatio(c.humanize);
            const timeoutId  = setTimeout(() => {
                if (modelHeldRef.current.get(pitch) === timeoutId) {
                    modelHeldRef.current.delete(pitch);
                    midiOutRef.current?.send([0x80, pitch, 0]);
                }
            }, durationMs);
            modelHeldRef.current.set(pitch, timeoutId);
        }

        setTimeout(magentaStep, delayMs);
    }, [releaseModelNote]);

    const releaseHeldModelNote = useCallback(() => {
        for (const [pitch, timeoutId] of modelHeldRef.current) {
            clearTimeout(timeoutId);
            midiOutRef.current?.send([0x80, pitch, 0]);
        }
        modelHeldRef.current.clear();
    }, []);

    const reset = useCallback(() => {
        freeGenRef.current = false;
        setFreeGenRunning(false);
        releaseHeldModelNote();
    }, [releaseHeldModelNote]);

    const startFreeGen = useCallback(() => {
        freeGenRef.current = true;
        setFreeGenRunning(true);
        magentaStep();
    }, [magentaStep]);

    const stopFreeGen = useCallback(() => {
        freeGenRef.current = false;
        setFreeGenRunning(false);
        releaseHeldModelNote();
    }, [releaseHeldModelNote]);

    // ── Model switching ───────────────────────────────────────────────────────

    const switchModel = useCallback((name) => {
        if (name === 'magenta') {
            activeModelRef.current = magentaRef.current;
        } else if (name === 'improv') {
            // Lazy-init: only load the improv checkpoint the first time it's selected.
            if (improvRef.current.status === 'idle') {
                improvRef.current.init(setImprovStatus);
            }
            activeModelRef.current = improvRef.current;
        }
        setModel(name);
    }, []);

    // ── Session recording ─────────────────────────────────────────────────────

    const startSession = useCallback(() => {
        sessionRecorderRef.current.start();
        sessionRunningRef.current = true;
        setSessionRunning(true);
    }, []);

    const stopSession = useCallback(() => {
        sessionRecorderRef.current.stop();
        sessionRunningRef.current = false;
        setSessionRunning(false);
    }, []);

    const exportSession = useCallback(() => {
        sessionRecorderRef.current.exportMidi();
    }, []);

    const clearSession = useCallback(() => {
        sessionRecorderRef.current.clear();
        sessionRunningRef.current = false;
        setSessionRunning(false);
        setSessionNoteCount(0);
    }, []);

    // ── CC learn ──────────────────────────────────────────────────────────────

    const startLearning = useCallback((controlKey) => {
        const next = learningRef.current === controlKey ? null : controlKey;
        learningRef.current = next;
        setLearning(next);
    }, []);

    const unbind = useCallback((controlKey) => {
        for (const [k, v] of ccBindingsRef.current) {
            if (v === controlKey) { ccBindingsRef.current.delete(k); break; }
        }
        syncCcDisplay();
    }, [syncCcDisplay]);

    return {
        midiInputs, midiOutputs,
        selectedInputId,  setSelectedInputId,
        selectedOutputId, setSelectedOutputId,
        controls, setControls,
        ccBindings, learning, startLearning, unbind,
        freeGenRunning, startFreeGen, stopFreeGen,
        reset,
        noteCallbackRef,
        model, switchModel, magentaStatus, improvStatus,
        sessionRunning, sessionNoteCount,
        startSession, stopSession, exportSession, clearSession,
        currentChord, progression, detectedKey,
        harmonyStatus,
        connectHarmony:    () => harmonyClientRef.current.connect(),
        disconnectHarmony: () => harmonyClientRef.current.disconnect(),
    };
}
