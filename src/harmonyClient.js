/**
 * HarmonyClient — WS client for the music21 progression engine (server.py).
 *
 * Auto-connects on construction; silently falls back to 'offline' if the
 * server isn't running. Requesting a progression while offline is a no-op,
 * so callers don't need to gate on connection state — the worst case is
 * that ImprovRNN keeps using the browser-detected single chord (Phase 1).
 */

const DEFAULT_URL = 'ws://localhost:8765';

export class HarmonyClient {
    constructor() {
        this._ws            = null;
        this._status        = 'offline'; // 'offline' | 'connecting' | 'connected'
        this._onProgression = null;
        this._onStatus      = null;
    }

    get status() { return this._status; }

    onProgression(cb) { this._onProgression = cb; }
    onStatus(cb)      { this._onStatus = cb; }

    _setStatus(s) {
        if (this._status === s) return;
        this._status = s;
        this._onStatus?.(s);
    }

    connect(url = DEFAULT_URL) {
        if (this._ws) {
            try { this._ws.close(); } catch { /* noop */ }
            this._ws = null;
        }
        this._setStatus('connecting');
        try {
            this._ws = new WebSocket(url);
        } catch {
            this._setStatus('offline');
            return;
        }
        this._ws.onopen    = () => this._setStatus('connected');
        this._ws.onclose   = () => { this._ws = null; this._setStatus('offline'); };
        this._ws.onerror   = () => { /* onclose will follow */ };
        this._ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'progression') this._onProgression?.(msg);
            } catch { /* ignore */ }
        };
    }

    disconnect() {
        if (this._ws) {
            try { this._ws.close(); } catch { /* noop */ }
            this._ws = null;
        }
        this._setStatus('offline');
    }

    requestProgression(currentChord, history) {
        if (this._status !== 'connected' || !this._ws) return;
        try {
            this._ws.send(JSON.stringify({
                type:          'harmony',
                current_chord: currentChord,
                history,
            }));
        } catch { /* socket may have closed mid-send */ }
    }
}
