/**
 * MagentaMelodyModel — browser-side MelodyRNN via Magenta.js CDN.
 *
 * Generates pitches in GEN_STEPS-note chunks and buffers them so the
 * caller can pop() synchronously at each beat tick. Refill is async
 * and fires automatically when the buffer runs low.
 */

const MELODY_URL =
    'https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/melody_rnn';
const IMPROV_URL =
    'https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/chord_pitches_improv';

const GEN_STEPS        = 16;   // notes per continueSequence call
const REFILL_THRESHOLD = 4;    // refill when buffer has fewer than this

// Shared seed builder: last up-to-4 player pitches as quarter-step notes.
function buildSeed(seedNotes) {
    const pitches = seedNotes.length > 0 ? seedNotes.slice(-4) : [60];
    return {
        notes: pitches.map((p, i) => ({
            pitch: p, quantizedStartStep: i, quantizedEndStep: i + 1, velocity: 80,
        })),
        totalQuantizedSteps: pitches.length,
        quantizationInfo:    { stepsPerQuarter: 4 },
    };
}

export class MagentaMelodyModel {
    constructor() {
        this._rnn         = null;
        this._buffer      = [];   // MIDI pitches ready to play
        this._seedNotes   = [];   // recent context pitches (max 8)
        this._temperature = 1.0;
        this._generating  = false;
        this.status       = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
    }

    setTemperature(t) { this._temperature = t; }

    async init(onStatus) {
        this.status = 'loading';
        onStatus?.('loading');
        try {
            if (!window.__magentaReady) throw new Error('Magenta CDN script not found');
            const mm = await window.__magentaReady;
            this._rnn = new mm.MusicRNN(MELODY_URL);
            await this._rnn.initialize();
            this.status = 'ready';
            onStatus?.('ready');
        } catch (err) {
            console.error('[Magenta] init failed:', err);
            this.status = 'error';
            onStatus?.('error');
        }
    }

    dispose() {
        this._rnn?.dispose();
        this._rnn    = null;
        this._buffer = [];
        this.status  = 'idle';
    }

    // Feed a player note as seed context; clears buffer so next generation
    // reflects the new musical context.
    addSeedNote(pitch) {
        this._seedNotes.push(pitch);
        if (this._seedNotes.length > 8) this._seedNotes.shift();
        this._buffer = [];
    }

    // Pop the next pitch synchronously. Returns null if buffer is empty.
    // Automatically triggers a background refill when buffer runs low.
    popPitch() {
        if (this._buffer.length < REFILL_THRESHOLD) this._refill();
        return this._buffer.length > 0 ? this._buffer.shift() : null;
    }

    isReady() { return this.status === 'ready'; }

    // ── Private ─────────────────────────────────────────────────────────────

    async _refill() {
        if (this._generating || this.status !== 'ready') return;
        this._generating = true;
        try {
            const seed   = this._buildSeed();
            const result = await this._rnn.continueSequence(
                seed, GEN_STEPS, this._temperature,
            );
            // continueSequence returns quantized notes; extract pitches in order
            const sorted = [...result.notes].sort(
                (a, b) => a.quantizedStartStep - b.quantizedStartStep,
            );
            this._buffer.push(...sorted.map(n => n.pitch));
        } catch (err) {
            console.error('[Magenta] generate error:', err);
        }
        this._generating = false;
    }

    _buildSeed() { return buildSeed(this._seedNotes); }
}

/**
 * MagentaImprovModel — chord-conditioned MelodyRNN via the chord_pitches_improv checkpoint.
 *
 * Same buffer/popPitch interface as MagentaMelodyModel; the only differences are the
 * checkpoint URL and the chordProgression argument to continueSequence (required for
 * this checkpoint — calling without it throws). Call setChord() whenever the scale/key
 * changes to keep the chord context current.
 */
export class MagentaImprovModel {
    constructor() {
        this._rnn         = null;
        this._buffer      = [];
        this._seedNotes   = [];
        this._temperature = 1.0;
        this._generating  = false;
        this._chords      = ['C'];  // updated via setChord()
        this.status       = 'idle';
    }

    setTemperature(t) { this._temperature = t; }
    setChord(chords)  { this._chords = chords; this._buffer = []; }

    async init(onStatus) {
        this.status = 'loading';
        onStatus?.('loading');
        try {
            if (!window.__magentaReady) throw new Error('Magenta CDN script not found');
            const mm = await window.__magentaReady;
            this._rnn = new mm.MusicRNN(IMPROV_URL);
            await this._rnn.initialize();
            this.status = 'ready';
            onStatus?.('ready');
        } catch (err) {
            console.error('[ImprovRNN] init failed:', err);
            this.status = 'error';
            onStatus?.('error');
        }
    }

    dispose() {
        this._rnn?.dispose();
        this._rnn    = null;
        this._buffer = [];
        this.status  = 'idle';
    }

    addSeedNote(pitch) {
        this._seedNotes.push(pitch);
        if (this._seedNotes.length > 8) this._seedNotes.shift();
        this._buffer = [];
    }

    popPitch() {
        if (this._buffer.length < REFILL_THRESHOLD) this._refill();
        return this._buffer.length > 0 ? this._buffer.shift() : null;
    }

    isReady() { return this.status === 'ready'; }

    async _refill() {
        if (this._generating || this.status !== 'ready') return;
        this._generating = true;
        try {
            const result = await this._rnn.continueSequence(
                buildSeed(this._seedNotes), GEN_STEPS, this._temperature, this._chords,
            );
            const sorted = [...result.notes].sort(
                (a, b) => a.quantizedStartStep - b.quantizedStartStep,
            );
            this._buffer.push(...sorted.map(n => n.pitch));
        } catch (err) {
            console.error('[ImprovRNN] generate error:', err);
        }
        this._generating = false;
    }
}
