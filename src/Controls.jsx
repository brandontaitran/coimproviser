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

export function Controls({ controls, setControls, ccBindings, learning, startLearning, unbind }) {
    const [open, setOpen] = useState(false);

    const set = key => val => setControls({ [key]: val });

    function setMinPitch(v) { setControls({ minPitch: Math.min(v, controls.maxPitch - 1) }); }
    function setMaxPitch(v) { setControls({ maxPitch: Math.max(v, controls.minPitch + 1) }); }

    const cc = key => ({
        controlKey: key, ccNum: ccBindings[key],
        learning, onLearn: startLearning, onUnbind: unbind,
    });

    return (
        <div className="controls-wrap">
            <button className="ctrl-toggle-btn" onClick={() => setOpen(o => !o)}>
                Controls <span className="ctrl-arrow">{open ? '▲' : '▼'}</span>
            </button>

            {open && (
                <div className="ctrl-body">
                    <div className="ctrl-section">Sampling</div>
                    <Slider label="pitch temp" min={0} max={1} step={0.01}
                        value={controls.pitchTemp} onChange={set('pitchTemp')}
                        fmt={v => v.toFixed(2)} {...cc('pitchTemp')} />

                    <div className="ctrl-section">Pitch register</div>
                    <Slider label="min" min={0} max={127} step={1}
                        value={controls.minPitch} onChange={setMinPitch}
                        fmt={midiName} {...cc('minPitch')} />
                    <Slider label="max" min={0} max={127} step={1}
                        value={controls.maxPitch} onChange={setMaxPitch}
                        fmt={midiName} {...cc('maxPitch')} />

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

                    <button className="ctrl-reset-defaults"
                        onClick={() => setControls(DEFAULT_CONTROLS)}>
                        Reset to defaults
                    </button>
                </div>
            )}
        </div>
    );
}
