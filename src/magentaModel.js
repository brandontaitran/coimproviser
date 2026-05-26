/**
 * MagentaMelodyModel — browser-side MelodyRNN via Magenta.js CDN.
 *
 * Generates pitches in GEN_STEPS-note chunks and buffers them so the
 * caller can pop() synchronously at each beat tick. Refill is async
 * and fires automatically when the buffer runs low.
 */

const MELODY_URL =
    'https://storage.googleapis.com/magentadata/js/checkpoints/music_rnn/melody_rnn';

const GEN_STEPS        = 16;   // notes per continueSequence call
const REFILL_THRESHOLD = 4;    // refill when buffer has fewer than this

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

    _buildSeed() {
        const pitches = this._seedNotes.length > 0
            ? this._seedNotes.slice(-4)
            : [60];   // default: middle C if no player input yet

        return {
            notes: pitches.map((p, i) => ({
                pitch:               p,
                quantizedStartStep:  i,
                quantizedEndStep:    i + 1,
                velocity:            80,
            })),
            totalQuantizedSteps:  pitches.length,
            quantizationInfo:     { stepsPerQuarter: 4 },
        };
    }
}
