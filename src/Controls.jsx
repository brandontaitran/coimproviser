import { useState } from 'react';
import { DEFAULT_CONTROLS } from './useNotochord.js';

const ROOTS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

const SCALE_TYPES = [
    'minor pentatonic',
    'major pentatonic',
    'minor',
    'major',
    'dorian',
    'mixolydian',
    'chromatic',
];

const MIDI_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function midiName(m) { return `${MIDI_NAMES[m % 12]}${Math.floor(m / 12) - 1}`; }

const MODEL_OPTIONS = [
    { id: 'magenta', label: 'MelodyRNN',  desc: 'unconditioned melody continuation' },
    { id: 'improv',  label: 'ImprovRNN',  desc: 'chord-conditioned (uses scale key)' },
];

function CcButton({ controlKey, ccNum, learning, onLearn, onUnbind }) {
    const isLearning = learning === controlKey;
    const isBound    = ccNum != null;

    function handleClick() {
        if (isBound) onUnbind(controlKey);
        else onLearn(controlKey);
    }

    return (
        <button
            className={`cc-btn ${isLearning ? 'learning' : ''} ${isBound ? 'bound' : ''}`}
            onClick={handleClick}
            title={
                isLearning ? 'Twist a knob to bind…' :
                isBound    ? `CC ${ccNum} — click to unbind` :
                             'Click to bind a knob (MIDI learn)'
            }
        >
            {isLearning ? '…' : isBound ? `${ccNum}` : 'cc'}
        </button>
    );
}

function Slider({ label, min, max, step, value, onChange, fmt,
                  controlKey, ccNum, learning, onLearn, onUnbind }) {
    return (
        <div className="ctrl-row">
            <span className="ctrl-lbl">{label}</span>
            <input type="range" min={min} max={max} step={step}
                value={value} onChange={e => onChange(+e.target.value)} />
            <span className="ctrl-val">{fmt ? fmt(value) : value}</span>
            <CcButton controlKey={controlKey} ccNum={ccNum}
                learning={learning} onLearn={onLearn} onUnbind={onUnbind} />
        </div>
    );
}

function Toggle({ label, checked, onChange }) {
    return (
        <label className="ctrl-toggle-row">
            <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
            {label}
        </label>
    );
}

export function Controls({
    controls, setControls, ccBindings, learning, startLearning, unbind,
    model, switchModel, magentaStatus, improvStatus,
    sessionRunning, sessionNoteCount, startSession, stopSession, exportSession, clearSession,
    currentChord, progression, detectedKey,
    harmonyStatus, connectHarmony, disconnectHarmony,
}) {
    const [open, setOpen] = useState(false);

    const set = key => val => setControls({ [key]: val });

    function setMinPitch(v) { setControls({ minPitch: Math.min(v, controls.maxPitch - 1) }); }
    function setMaxPitch(v) { setControls({ maxPitch: Math.max(v, controls.minPitch + 1) }); }

    const cc = key => ({
        controlKey: key, ccNum: ccBindings[key],
        learning, onLearn: startLearning, onUnbind: unbind,
    });

    const statusOf = id => id === 'magenta' ? magentaStatus : improvStatus;
    const statusLabel = s => s === 'ready' ? '●' : s === 'loading' ? '○' : s === 'error' ? '✕' : '–';

    return (
        <div className="controls-wrap">
            <button className="ctrl-toggle-btn" onClick={() => setOpen(o => !o)}>
                Controls <span className="ctrl-arrow">{open ? '▲' : '▼'}</span>
            </button>

            {open && (
                <div className="ctrl-body">

                    {/* ── Model ── */}
                    <div className="ctrl-section">Model</div>
                    {MODEL_OPTIONS.map(({ id, label, desc }) => (
                        <div
                            key={id}
                            className={`model-option ${model === id ? 'active' : ''}`}
                            onClick={() => switchModel(id)}
                            title={desc}
                        >
                            <span className="model-radio">{model === id ? '◉' : '○'}</span>
                            <span className="model-label">{label}</span>
                            <span className={`model-status ${statusOf(id)}`}>
                                {statusLabel(statusOf(id))}
                            </span>
                        </div>
                    ))}
                    {model === 'improv' && (
                        <>
                            <Toggle label="auto-detect chord from playing"
                                checked={controls.autoDetectChord}
                                onChange={set('autoDetectChord')} />
                            <div className="chord-readout">
                                {progression.length > 1
                                    ? <>chord: <span className="chord-name">{progression.join(' → ')}</span></>
                                    : <>chord: <span className="chord-name">{currentChord ?? '–'}</span></>}
                            </div>
                            <div className="harmony-row">
                                <span className="harmony-lbl">harmony engine</span>
                                <span className={`harmony-pill ${harmonyStatus}`}>
                                    {harmonyStatus}
                                </span>
                                {harmonyStatus === 'connected'
                                    ? <button className="harmony-btn" onClick={disconnectHarmony}>disconnect</button>
                                    : <button className="harmony-btn" onClick={connectHarmony}>connect</button>}
                            </div>
                            {detectedKey && harmonyStatus === 'connected' && (
                                <div className="harmony-key">key: {detectedKey}</div>
                            )}
                        </>
                    )}

                    {/* ── Sampling ── */}
                    <div className="ctrl-section">Sampling</div>
                    <Slider label="pitch temp" min={0} max={1} step={0.01}
                        value={controls.pitchTemp} onChange={set('pitchTemp')}
                        fmt={v => v.toFixed(2)} {...cc('pitchTemp')} />
                    <Slider label="humanize" min={0} max={1} step={0.01}
                        value={controls.humanize} onChange={set('humanize')}
                        fmt={v => v.toFixed(2)} {...cc('humanize')} />

                    {/* ── Pitch register ── */}
                    <div className="ctrl-section">Pitch register</div>
                    <Slider label="min" min={0} max={127} step={1}
                        value={controls.minPitch} onChange={setMinPitch}
                        fmt={midiName} {...cc('minPitch')} />
                    <Slider label="max" min={0} max={127} step={1}
                        value={controls.maxPitch} onChange={setMaxPitch}
                        fmt={midiName} {...cc('maxPitch')} />

                    {/* ── Scale mask ── */}
                    <div className="ctrl-section">Scale mask</div>
                    <Toggle label="enabled"
                        checked={controls.scaleMaskOn} onChange={set('scaleMaskOn')} />
                    <div className="ctrl-row">
                        <span className="ctrl-lbl">root</span>
                        <select value={controls.scaleRoot}
                            onChange={e => setControls({ scaleRoot: e.target.value })}>
                            {ROOTS.map(r => <option key={r}>{r}</option>)}
                        </select>
                        <select value={controls.scaleName}
                            onChange={e => setControls({ scaleName: e.target.value })}>
                            {SCALE_TYPES.map(s => <option key={s}>{s}</option>)}
                        </select>
                    </div>

                    {/* ── Listener ── */}
                    <div className="ctrl-section">Listener</div>
                    <Slider label="vel follow" min={0} max={1} step={0.01}
                        value={controls.velocityFollow} onChange={set('velocityFollow')}
                        fmt={v => v.toFixed(2)} {...cc('velocityFollow')} />
                    <Slider label="reg offset" min={-24} max={24} step={1}
                        value={controls.registerOffset} onChange={set('registerOffset')}
                        fmt={v => (v > 0 ? `+${v}` : `${v}`)} {...cc('registerOffset')} />
                    <Slider label="reg width" min={12} max={48} step={1}
                        value={controls.registerWidth} onChange={set('registerWidth')}
                        {...cc('registerWidth')} />
                    <Toggle label="rest when player is silent"
                        checked={controls.restGate} onChange={set('restGate')} />
                    {controls.restGate && (
                        <Slider label="silence ms" min={500} max={3000} step={100}
                            value={controls.silenceMs} onChange={set('silenceMs')}
                            {...cc('silenceMs')} />
                    )}

                    {/* ── Session recording ── */}
                    <div className="ctrl-section">Session</div>
                    <div className="session-btns">
                        {sessionRunning
                            ? <button className="ctrl-btn active" onClick={stopSession}>■ Stop</button>
                            : <button className="ctrl-btn" onClick={startSession}>● Record</button>
                        }
                        <button className="ctrl-btn export"
                            onClick={exportSession}
                            disabled={sessionNoteCount === 0}
                            title="Export as .mid">
                            Export .mid
                        </button>
                        <button className="ctrl-btn"
                            onClick={clearSession}
                            disabled={sessionNoteCount === 0}>
                            Clear
                        </button>
                    </div>
                    {sessionNoteCount > 0 && (
                        <div className="session-count">
                            {sessionNoteCount} note{sessionNoteCount !== 1 ? 's' : ''} recorded
                        </div>
                    )}

                    <button className="ctrl-reset-defaults"
                        onClick={() => setControls(DEFAULT_CONTROLS)}>
                        Reset to defaults
                    </button>
                </div>
            )}
        </div>
    );
}
