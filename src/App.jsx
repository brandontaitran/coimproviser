import { useState, useCallback } from 'react';
import { useNotochord } from './useNotochord.js';
import { Controls } from './Controls.jsx';
import { NoteVisualizer } from './NoteVisualizer.jsx';
import './App.css';

export function App() {
    const {
        midiInputs, midiOutputs,
        selectedInputId,  setSelectedInputId,
        selectedOutputId, setSelectedOutputId,
        controls, setControls,
        ccBindings, learning, startLearning, unbind,
        freeGenRunning, startFreeGen, stopFreeGen,
        reset,
        noteCallbackRef,
        magentaStatus,
    } = useNotochord();

    const [resetFlash, setResetFlash] = useState(false);

    const handleReset = useCallback(() => {
        reset();
        setResetFlash(true);
        setTimeout(() => setResetFlash(false), 300);
    }, [reset]);

    const modelReady = magentaStatus === 'ready';

    return (
        <div className="app">
            <NoteVisualizer callbackRef={noteCallbackRef} />

            <div className="ui-overlay">
                <div className="top-bar">
                    {/* Top-left: controls */}
                    <Controls controls={controls} setControls={setControls}
                        ccBindings={ccBindings} learning={learning}
                        startLearning={startLearning} unbind={unbind} />

                    {/* Top-right: title + model status */}
                    <div className="top-right">
                        <div className="title-row">
                            <span className="app-title">coimproviser v1</span>
                            <div className={`ws-dot ${modelReady ? 'ok' : 'off'}`}
                                title={`MelodyRNN: ${magentaStatus}`} />
                        </div>
                    </div>
                </div>

                {/* Bottom: MIDI selectors + quantizer + Generate + Reset */}
                <div className="bottom-bar">
                    <div className="midi-selectors">
                        <select value={selectedInputId}
                            onChange={e => setSelectedInputId(e.target.value)}
                            disabled={midiInputs.length === 0} title="MIDI in">
                            {midiInputs.length === 0
                                ? <option>no MIDI in</option>
                                : midiInputs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                        <select value={selectedOutputId}
                            onChange={e => setSelectedOutputId(e.target.value)}
                            disabled={midiOutputs.length === 0} title="MIDI out">
                            {midiOutputs.length === 0
                                ? <option>no MIDI out</option>
                                : midiOutputs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                    </div>
                    <div className="quantizer-row">
                        <label className="q-label">
                            BPM
                            <input className="q-bpm" type="number" min={40} max={240} step={1}
                                value={controls.bpm}
                                onChange={e => setControls({ bpm: Math.max(40, Math.min(240, +e.target.value)) })} />
                        </label>
                        <label className="q-label">
                            grid
                            <select className="q-subdiv" value={controls.subdiv}
                                onChange={e => setControls({ subdiv: parseFloat(e.target.value) })}>
                                <option value={0}>free</option>
                                <option value={1.0}>1/4</option>
                                <option value={0.5}>1/8</option>
                                <option value={0.25}>1/16</option>
                                <option value={0.125}>1/32</option>
                            </select>
                        </label>
                    </div>
                    <button
                        className={`gen-btn ${freeGenRunning ? 'running' : ''}`}
                        onClick={freeGenRunning ? stopFreeGen : startFreeGen}
                    >
                        {freeGenRunning ? '■ Stop' : '▶ Generate'}
                    </button>
                    <button
                        className={`reset-btn ${resetFlash ? 'flash' : ''}`}
                        onClick={handleReset}
                    >Reset</button>
                </div>
            </div>
        </div>
    );
}
