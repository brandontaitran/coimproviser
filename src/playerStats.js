/**
 * PlayerStats — rolling window of recent player note-ons.
 *
 * Owned by useNotochord, consulted by chord detection (Phase 1) and by the
 * per-step generator for velocity/register modulation (Phase 2).
 *
 * Stores only note-ons; note-offs aren't needed for any current consumer.
 */
export class PlayerStats {
    constructor(maxEvents = 64) {
        this._buf  = [];
        this._max  = maxEvents;
        this._held = new Set();  // pitches currently held down (note-on without note-off)
    }

    push(pitch, vel) {
        this._buf.push({ pitch, vel, t: performance.now() });
        if (this._buf.length > this._max) this._buf.shift();
        this._held.add(pitch);
    }

    release(pitch) { this._held.delete(pitch); }

    heldPitches() { return [...this._held]; }

    recentPitches(windowMs = 2000) {
        const cutoff = performance.now() - windowMs;
        const out = [];
        for (let i = this._buf.length - 1; i >= 0; i--) {
            if (this._buf[i].t < cutoff) break;
            out.push(this._buf[i].pitch);
        }
        return out;
    }

    stats(windowMs = 1500) {
        const cutoff = performance.now() - windowMs;
        let n = 0, sumVel = 0, sumPitch = 0;
        for (let i = this._buf.length - 1; i >= 0; i--) {
            const e = this._buf[i];
            if (e.t < cutoff) break;
            n++; sumVel += e.vel; sumPitch += e.pitch;
        }
        if (n === 0) return { density: 0, meanVel: 80, registerCentroid: 60 };
        return {
            density:          n / (windowMs / 1000),
            meanVel:          sumVel / n,
            registerCentroid: sumPitch / n,
        };
    }

    silentFor() {
        if (this._buf.length === 0) return Infinity;
        return performance.now() - this._buf[this._buf.length - 1].t;
    }

    clear() { this._buf = []; this._held.clear(); }
}
