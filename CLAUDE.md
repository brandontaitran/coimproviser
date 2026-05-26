# CLAUDE.md — Notochord Live Interface (experimental spike)

## Purpose

A thin, single-purpose interface for live experimentation with **Notochord** in two
modes: **auto-pitch** and **neural harmonization**. The player performs on an
**Akai MPK Mini MkII**; Notochord fills in pitches in real time. The goal of this
project is to validate two things and nothing else:

1. Whether end-to-end latency is low enough to feel like an instrument.
2. Whether the musical results of auto-pitch / harmonization are good enough to build on.

This is a **spike**, not a product. Optimize for fast iteration and the ability to
twist every Notochord knob while playing. It will likely be folded into a larger
project later, so keep the model-server boundary clean — but do not build for that
future now.

## What this is NOT (scope guardrails — do not add these)

- No LLM, no text prompts, no Strudel code generation. Notochord is the only model.
- No accounts, persistence, database, or deployment. Local dev only.
- No audio synthesis in this app. Output is **MIDI out** via WebMIDI (see Output).
- No build tooling beyond Vite. No Docker. No tests beyond a latency harness.
- Do not add features not listed in this file. If a change seems needed, leave a
  `// TODO(spike):` comment and keep going rather than expanding scope.

## Hard constraints

- **Latency is the top priority.** Notochord advertises ~6 ms to feed an event and
  ~3 ms to sample, i.e. sub-10 ms model time. The end-to-end budget (key press →
  note sounding) target is **under ~20 ms**, perceptually immediate. Every
  architectural choice defers to this.
- Therefore: **no HTTP request/response per event.** Use one persistent WebSocket.
- **No `setTimeout`/`setInterval` for any time-critical scheduling.** Auto-pitch is
  immediate (no scheduling needed). For anything that must be timed, use the Web
  Audio `AudioContext.currentTime` clock.
- Model server and browser run on **localhost**. No network hops.
- Build a **latency readout into the UI from milestone 1** (see Latency instrumentation).
  We cannot tune what we cannot measure.

## Architecture

Browser is the MIDI host and the UI. Python is only the model server. Node/Express
is intentionally absent from the hot path.

```
 Akai MPK MkII ──WebMIDI in──▶  Browser (React/Vite)
                                  │  ▲
                          WebSocket│  │WebSocket  (localhost, persistent)
                                  ▼  │
                               Python Notochord server
                                  (model inference only)

 Browser ──WebMIDI out──▶ IAC Driver ──▶ Logic Pro (or any synth/DAW)
```

Rationale: the browser already speaks WebMIDI, so it captures MPK notes AND CC knobs
directly. Python never touches MIDI hardware — it receives note events as JSON,
queries Notochord, returns pitches. The browser emits the resulting MIDI out. This
removes a whole Node layer and a MIDI-bridge dependency from the critical path.

## Tech stack

- **Frontend:** React + Vite, plain WebMIDI API (no wrapper lib unless one proves
  necessary), Tonal.js for scale/key utilities. State in React (no Redux).
- **Backend:** Python. Notochord for the model. A direct WebSocket server — use
  `websockets` or FastAPI's WebSocket support, whichever is lighter to stand up.
  No OSC layer needed unless the Notochord API forces it (verify — see Setup).
- Serve the frontend with the Vite dev server. The Python process is separate.

## Setup (verify everything against current sources — do not trust these from memory)

1. **Install Notochord.** The package comes from the Intelligent Instruments Lab.
   The standalone repo is `github.com/Intelligent-Instruments-Lab/notochord`
   (it may also live under `iil-python-tools`). **Read its current README before
   installing** — confirm the package name, the pip command, and the Python version.
   Do not assume `pip install notochord` works until verified.
2. **Download a model checkpoint.** Notochord ships pretrained checkpoints (trained
   on the Lakh MIDI dataset). Find the current checkpoint download instructions in
   the repo and document the exact path you used in this file.
3. **Inventory the real query API.** Open the Notochord source and find the
   `query`/`predict`/`feed` method signatures. The exact parameter names matter and
   may differ from what this file lists below — **treat the source as ground truth**
   and adapt the controls to whatever the API actually accepts. Record the real
   signatures in a comment block in the server file.
4. Confirm WebMIDI works in your browser (Chrome-based is most reliable) and that the
   MPK MkII appears as both a note input and a CC input.
5. Confirm a MIDI-out destination exists (e.g. the macOS IAC Driver) and is reachable
   from WebMIDI.

## Notochord lifecycle (get this right — it is the main correctness risk)

Notochord is a **stateful** autoregressive sequence model. Its predictions depend on
the running hidden state, which only advances when you **feed** it events. The
feed/query discipline is what gives musical coherence; getting it wrong yields
random-sounding output even when latency is perfect.

The per-note loop for **auto-pitch**:

1. Player plays a note. The browser has `velocity`, timing (`Δt` since last event),
   and a chosen `instrument`.
2. Browser sends a `query_pitch` message with those three **fixed** and pitch left
   open.
3. Server calls Notochord's query with instrument/time/velocity fixed, samples
   **pitch only** (apply scale mask first if enabled), and returns it.
4. Server **feeds the completed event** (now including the sampled pitch) back into
   Notochord so the state advances. Then it is ready for the next note.
5. Browser emits the MIDI note-on out, and a matching note-off when the player
   releases.

Notes:
- Note-offs are events too (velocity 0). Decide whether to feed them to the model;
  start by feeding them so timing/state stays honest, and expose a toggle if it
  changes the feel.
- Provide a **reset** message that returns Notochord to its initial state (clears the
  hidden state). The UI needs a visible "reset" button — improvisations drift and the
  player will want to start the model's memory fresh.

For **neural harmonization** the loop is the same, except step 2 queries for **N
additional simultaneous voices** constrained to `Δt = 0, velocity > 0`, sampling
pitch (and optionally instrument) for each. Maintain a map
`playedNoteId → [harmonizingPitches]` so that when the player releases the original
note you emit note-offs for all of its harmonizing voices. (This is the state machine
in Figure 5 of the Notochord paper.)

## WebSocket message contract

Keep messages tiny. Suggested shapes (adjust field names to the real API, but keep
the structure):

Browser → server:
```jsonc
{ "type": "query_pitch",   "inst": 0, "dt": 0.12, "vel": 95, "params": { ... } }
{ "type": "query_harmony", "inst": 0, "pitch": 61, "vel": 95, "voices": 3, "params": { ... } }
{ "type": "feed",          "inst": 0, "pitch": 61, "dt": 0.0, "vel": 0 }   // e.g. a note-off
{ "type": "reset" }
```

Server → browser:
```jsonc
{ "type": "pitch",   "pitch": 61,          "t_send": 1234.5, "model_ms": 7.2 }
{ "type": "harmony", "pitches": [64,67,71],"t_send": 1234.5, "model_ms": 9.1 }
{ "type": "ready" }
```

- `params` carries the live Notochord steering values (see Controls). They ride along
  with each query so there is no separate round trip when a knob moves.
- `model_ms` is the server-measured inference time; the browser computes full
  round-trip latency separately (see below).

## The two modes

A top-level mode switch: **Auto-pitch** | **Harmonizer**. Only one active at a time
for now.

**Auto-pitch.** Player supplies rhythm, dynamics, and instrument; Notochord supplies
pitch. The headline use case is generating a melodic/arpeggiated line from a fixed
input gesture — e.g. the player taps a steady rhythm and gets a coherent line back.

**Harmonizer.** Player supplies complete notes; Notochord answers each with N
simultaneous harmonizing voices, sensitive to the whole performance so far.

## Controls (expose as many Notochord parameters as the API allows)

Two surfaces for every continuous parameter: an on-screen slider/knob AND the ability
to bind it to an MPK CC knob (see CC mapping). When a CC moves, the on-screen control
should track it.

Discover the real parameter set from the Notochord source (Setup step 3) and expose
everything plausible. Expected categories — confirm names against the API:

| Control | Type | Notes |
|---|---|---|
| Overall temperature | slider | Sharpness of all sampled distributions |
| Rhythm temperature | slider | Mixture-weight temperature (Appendix A) — "which rhythm" |
| Timing temperature | slider | Component-scale temperature (Appendix A) — "the groove" |
| Pitch min / max | dual slider | Register clipping on the pitch distribution |
| Velocity min / max | dual slider | Even when vel is player-supplied, useful for harmony voices |
| Time/density min/max (Δt) | dual slider | Truncate timing to control event density |
| Instrument allow / exclude | multi-select | Which General MIDI instruments may be chosen |
| Allow anonymous instruments | toggle | Notochord's bias-free instrument identities |
| Scale + root | selector | App-level pitch mask via Tonal.js (default: C# minor pentatonic) |
| Scale mask on/off | toggle | When off, no theory constraint on pitch |
| Harmonizer voice count | stepper | N simultaneous voices (Harmonizer mode) |
| Harmonizer voice instrument | selector | Fix or sample the voice instrument |
| Feed note-offs | toggle | Whether note-off events advance model state |
| Reset model state | button | Clears Notochord's hidden state |

Scale masking is applied **before** sampling pitch: zero out probabilities for pitches
outside the selected scale and renormalize. Doing this on the server is lower-bandwidth;
doing it client-side keeps the music theory inspectable in JS. Start server-side; make
it easy to move.

## CC mapping (MPK MkII knobs → parameters)

The MkII has 8 assignable knobs sending Control Change. The player wants to drive
parameters by hand while performing.

- Build a simple **MIDI-learn** flow: click a parameter's "bind" affordance, twist a
  knob, and the incoming CC number is captured and bound to that parameter. Show the
  bound CC number next to the control.
- Map the CC's 0–127 range onto the parameter's range. Persist bindings in React state
  for the session (no storage layer — losing them on refresh is acceptable for a spike).
- A bound CC moving updates the parameter live; the on-screen control reflects it.
- Note: confirm the MkII's current CC assignments via WebMIDI rather than assuming;
  knobs are user-remappable in the MPK editor.

## Latency instrumentation (required from milestone 1)

- The browser timestamps when it sends each query (`performance.now()`), the server
  returns its `model_ms`, and the browser records round-trip on response.
- Display a **live latency readout** in the UI: current round-trip ms, a rolling
  average, and the server `model_ms` separately so we can see transport vs inference.
- If round-trip exceeds the budget, that is the single most important signal in this
  project — make it visually obvious (e.g. the readout turns red over ~20 ms).

## Coding conventions / what to avoid

- Keep the whole thing small and readable. One frontend file for the MIDI/WS plumbing,
  one for the UI, one Python server file is fine. Do not over-architect.
- No HTTP-per-event, no `setTimeout` scheduling, no audio synthesis here (see constraints).
- Do not invent Notochord API parameters. If unsure whether the API supports something,
  read the source; if it does not, omit the control rather than faking it.
- Prefer plain WebMIDI and plain `websockets` over heavy abstractions.
- Comment the Notochord feed/query lifecycle clearly where it lives — it is the part a
  future reader (or future Claude) will most likely break.

## Build milestones (latency-first — do them in this order)

1. **Hot loop, no UI.** Python WS server wrapping Notochord; browser captures one MPK
   note via WebMIDI, sends `query_pitch`, gets a pitch back, emits MIDI out, prints
   round-trip latency to console. **This milestone answers the project's main question** —
   do not move on until latency is measured and acceptable.
2. **Feed/query correctness.** Implement the full lifecycle (query → feed → advance,
   plus reset and note-offs). Confirm output is coherent, not random.
3. **Auto-pitch UI + latency readout.** Mode switch, latency display, reset button.
4. **Notochord controls.** Sliders for every steering parameter the API exposes,
   plus scale mask via Tonal.js.
5. **CC mapping.** MIDI-learn binding of MPK knobs to parameters.
6. **Harmonizer mode.** N-voice query + note-off tracking map.

## How to run (fill in real commands once verified)

- Start the Python Notochord server: `python server.py` (document the real entrypoint
  and the checkpoint path here).
- Start the frontend: `npm run dev`, open the Vite URL in a WebMIDI-capable browser.
- In the browser, grant MIDI access, select the MPK as input and the IAC Driver (or
  chosen destination) as output.
- Record the actual measured round-trip latency here once milestone 1 works: `____ ms`.
