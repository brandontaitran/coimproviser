import { Midi } from '@tonejs/midi';

export class SessionRecorder {
    constructor() {
        this._events   = [];
        this._t0       = null;
        this._running  = false;
        this._noteCount = 0;
    }

    get running()   { return this._running; }
    get noteCount() { return this._noteCount; }

    start() {
        if (this._t0 === null) this._t0 = performance.now();
        this._running = true;
    }

    stop() { this._running = false; }

    clear() {
        this._events    = [];
        this._t0        = null;
        this._running   = false;
        this._noteCount = 0;
    }

    record(type, pitch, velocity) {
        if (!this._running || this._t0 === null) return;
        this._events.push({ type, pitch, velocity, t: performance.now() - this._t0 });
        if (type === 'on') this._noteCount++;
    }

    exportMidi() {
        if (this._events.length === 0) return;

        const midi    = new Midi();
        const track   = midi.addTrack();
        const pending = new Map(); // pitch → { time, velocity }

        for (const ev of this._events) {
            if (ev.type === 'on') {
                pending.set(ev.pitch, { time: ev.t / 1000, velocity: ev.velocity / 127 });
            } else if (ev.type === 'off') {
                const on = pending.get(ev.pitch);
                if (on) {
                    track.addNote({
                        midi:     ev.pitch,
                        time:     on.time,
                        duration: Math.max(0.05, ev.t / 1000 - on.time),
                        velocity: on.velocity,
                    });
                    pending.delete(ev.pitch);
                }
            }
        }

        // Close notes still held at the end of recording.
        const endSec = this._events[this._events.length - 1].t / 1000;
        for (const [pitch, on] of pending) {
            track.addNote({
                midi: pitch, time: on.time,
                duration: Math.max(0.05, endSec - on.time),
                velocity: on.velocity,
            });
        }

        const blob = new Blob([midi.toArray()], { type: 'audio/midi' });
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), {
            href:     url,
            download: `coimproviser-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.mid`,
        });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
