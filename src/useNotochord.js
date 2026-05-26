/**
 * useNotochord — MIDI plumbing + MelodyRNN free-gen loop for coimproviser.
 *
 * Free-gen lifecycle:
 *   startFreeGen() → magentaStep loop ticks at grid (or jittered eighth)
 *   Player note-on → magentaModel.addSeedNote(pitch) clears buffer; next
 *                    refill primes from recent player input
 *   Player note-off → echo only
 *   reset()        → stops generation, releases any held model note
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Scale, Note } from 'tonal';
import { MagentaMelodyModel } from './magentaModel.js';

export const DEFAULT_CONTROLS = {
    pitchTemp:   1.0,
    minPitch:    0,
    maxPitch:    127,
    scaleMaskOn: false,
    scaleRoot:   'C#',
    scaleName:   'minor pentatonic',
    bpm:         120,
    subdiv:      0.5,   // 0 = free (jittered eighth), >0 = grid subdivision in beats
};

export const PARAM_RANGES = {
    pitchTemp: { min: 0,  max: 1,   step: 0.01 },
    minPitch:  { min: 0,  max: 127, step: 1    },
    maxPitch:  { min: 0,  max: 127, step: 1    },
    bpm:       { min: 40, max: 240, step: 1    },
};

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
    // Tracks the last pitch MelodyRNN played so we can send a note-off before the next.
    const magentaLastNoteRef = useRef(null);

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

    // Keep the model's sampling temperature in sync with the slider.
    useEffect(() => {
        magentaRef.current.setTemperature(controls.pitchTemp);
    }, [controls.pitchTemp]);

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
            // Echo player's note out + feed MelodyRNN as seed context.
            midiOutRef.current?.send([0x90 | ch, note, velocity]);
            magentaRef.current.addSeedNote(note);
        }

        if (isOff) {
            midiOutRef.current?.send([0x80 | ch, note, 0]);
        }
    }, [setControls, syncCcDisplay]);

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

    // ── MelodyRNN free-gen loop ───────────────────────────────────────────────

    const magentaStep = useCallback(() => {
        if (!freeGenRef.current) return;
        const c   = controlsRef.current;
        const mag = magentaRef.current;

        // Release previous note before playing the next.
        const prev = magentaLastNoteRef.current;
        if (prev != null) {
            midiOutRef.current?.send([0x80, prev, 0]);
            magentaLastNoteRef.current = null;
        }

        let pitch = mag.popPitch();
        if (pitch != null) {
            const includePitch = computeIncludePitch(c);
            if (includePitch) pitch = nearestAllowed(pitch, includePitch);

            const vel = 80;
            midiOutRef.current?.send([0x90, pitch, vel]);
            noteCallbackRef.current?.({ pitch, velocity: vel, source: 'model' });
            magentaLastNoteRef.current = pitch;
        }
        // Schedule next tick: grid-locked when subdiv>0, jittered eighth when free.
        let delayMs;
        if (c.subdiv > 0 && c.bpm > 0) {
            delayMs = (60000 / c.bpm) * c.subdiv;
        } else {
            const base = c.bpm > 0 ? (60000 / c.bpm) * 0.5 : 300;
            delayMs = base * (0.65 + Math.random() * 0.70);
        }
        setTimeout(magentaStep, delayMs);
    }, []);

    const releaseHeldModelNote = useCallback(() => {
        const prev = magentaLastNoteRef.current;
        if (prev != null) {
            midiOutRef.current?.send([0x80, prev, 0]);
            magentaLastNoteRef.current = null;
        }
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
        magentaStatus,
    };
}
