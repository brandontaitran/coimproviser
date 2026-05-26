#!/usr/bin/env python3
"""
Notochord WebSocket server for notochordspike (milestone 1: hot loop).

Real Notochord API (verified from installed source):

  Notochord.from_checkpoint(path) -> Notochord
    path="notochord-latest.ckpt" triggers auto-download on first run

  noto.reset(start=True) -> None
    Resets RNN hidden state. By default feeds start tokens so h is valid.

  noto.feed(inst, pitch, time, vel) -> None
    Advances hidden state.
      inst:  0=start, 1-128=GM melodic, 129-256=drums,
             257-288=anon melodic, 289-320=anon drums
      pitch: 0-127 MIDI pitch (128=start token)
      time:  float, seconds since previous event
      vel:   float 0-127; 0 = note-off

  noto.query(next_inst, next_time, next_vel,
             include_pitch, pitch_temp,
             min_vel, max_vel,
             rhythm_temp, timing_temp, ...) -> dict
    Samples the next event.
    Fixed modalities (next_*) are passed through unchanged.
    Returns dict: {'inst', 'pitch', 'time', 'vel', 'end', 'step'}
    Does NOT advance hidden state — caller must call feed() after.

Auto-pitch lifecycle per note:
  1. Client sends query_pitch {inst, dt, vel, params}
  2. Server calls query(next_inst, next_time, next_vel, include_pitch=...)
  3. Server feeds the completed event (inst, sampled_pitch, dt, vel)
  4. Server returns {type:"pitch", pitch, model_ms}
  5. Client emits MIDI note-on with the returned pitch.
  6. On note-off, client sends feed {inst, pitch, dt, vel=0}.
"""

import asyncio
import json
import logging
import time as time_module

import websockets
from notochord import Notochord


logging.getLogger('websockets').setLevel(logging.CRITICAL)

CHECKPOINT = "notochord-latest.ckpt"
PORT = 8765
INST = 1  # GM Grand Piano (matches browser-side constant)

noto: Notochord = None


def load_model():
    global noto
    print(f"Loading Notochord ({CHECKPOINT}) …")
    noto = Notochord.from_checkpoint(CHECKPOINT)
    # from_checkpoint already calls eval() and reset()
    print("Model ready.")



async def handle(ws):
    print("Client connected")
    await ws.send(json.dumps({"type": "ready"}))
    try:
        async for raw in ws:
            msg = json.loads(raw)
            t0  = time_module.perf_counter()
            try:
                await dispatch(ws, msg, t0)
            except websockets.exceptions.ConnectionClosed:
                raise
            except Exception as exc:
                import traceback
                print(f"[server] error in '{msg.get('type')}': {exc}")
                traceback.print_exc()
    except websockets.exceptions.ConnectionClosedError:
        pass  # browser closed without a close frame (page reload / HMR)


async def dispatch(ws, msg, t0):
    match msg.get("type"):

        case "query_pitch":
            inst   = int(msg["inst"])
            dt     = float(msg["dt"])
            vel    = float(msg["vel"])
            params = msg.get("params", {})

            # In auto-pitch mode: inst/time/vel are fixed by the player;
            # only pitch is sampled. So only pitch_temp and include_pitch
            # affect this query. The remaining params (rhythm_temp,
            # timing_temp, min/max vel/time, allow_anon) are passed through
            # for future harmonizer queries where more modalities are free.
            include_pitch = params.get("include_pitch") or None  # list or None
            held_for_inst = {p for (i, p) in noto.held_notes if i == inst}

            result = noto.query(
                next_inst=inst,
                next_time=dt,
                next_vel=vel,
                include_pitch=include_pitch,
                exclude_pitch=held_for_inst or None,
                pitch_temp=params.get("pitch_temp"),
                rhythm_temp=params.get("rhythm_temp"),
                timing_temp=params.get("timing_temp"),
                min_vel=params.get("min_vel"),
                max_vel=params.get("max_vel"),
                min_time=params.get("min_time"),
                max_time=params.get("max_time"),
                allow_anon=params.get("allow_anon", True),
                allow_end=False,
            )
            pitch = int(result["pitch"])

            # Advance model state with the now-complete event.
            noto.feed(inst=inst, pitch=pitch, time=dt, vel=vel)

            model_ms = (time_module.perf_counter() - t0) * 1000
            await ws.send(json.dumps({
                "type":     "pitch",
                "pitch":    pitch,
                "t_send":   time_module.time(),
                "model_ms": round(model_ms, 2),
            }))

        case "query_harmony":
            inst   = int(msg["inst"])
            pitch  = int(msg["pitch"])
            vel    = float(msg["vel"])
            dt     = float(msg["dt"])
            voices = max(1, min(4, int(msg.get("voices", 2))))
            params = msg.get("params", {})
            include_pitch = params.get("include_pitch") or None

            # Feed the player's note first so model state is current.
            noto.feed(inst=inst, pitch=pitch, time=dt, vel=vel)

            # Query N simultaneous harmony voices (dt=0).
            harmony_pitches = []
            used = {pitch}

            for _ in range(voices):
                held = {p for (i, p) in noto.held_notes if i == inst}
                result = noto.query(
                    next_inst=inst,
                    next_time=0.0,
                    next_vel=vel,
                    include_pitch=include_pitch,
                    exclude_pitch=(held | used) or None,
                    pitch_temp=params.get("pitch_temp"),
                    allow_anon=params.get("allow_anon", True),
                    allow_end=False,
                )
                hp = int(result["pitch"])
                noto.feed(inst=inst, pitch=hp, time=0.0, vel=vel)
                harmony_pitches.append(hp)
                used.add(hp)

            model_ms = (time_module.perf_counter() - t0) * 1000
            await ws.send(json.dumps({
                "type":     "harmony",
                "pitches":  harmony_pitches,
                "model_ms": round(model_ms, 2),
            }))

        case "query_free":
            params        = msg.get("params", {})
            include_pitch = params.get("include_pitch") or None
            harmony_voices = max(0, min(4, int(params.get("harmony_voices", 0))))

            # Timing is quantized client-side; let Notochord sample freely.
            result = noto.query(
                next_inst=INST,
                next_time=None,
                next_vel=None,
                include_pitch=include_pitch,
                pitch_temp=params.get("pitch_temp"),
                min_vel=params.get("min_vel"),
                max_vel=params.get("max_vel"),
                min_time=params.get("min_time"),
                max_time=params.get("max_time"),
                allow_anon=params.get("allow_anon", True),
                allow_end=False,
            )
            pitch = int(result["pitch"])
            dt    = float(result["time"])
            vel   = float(result["vel"])

            noto.feed(inst=INST, pitch=pitch, time=dt, vel=vel)

            # Harmony voices: query N simultaneous notes on top of each note-on.
            harmony_pitches = []
            if harmony_voices > 0 and vel > 0:
                used = {pitch}
                for _ in range(harmony_voices):
                    held = {p for (i, p) in noto.held_notes if i == INST}
                    hr = noto.query(
                        next_inst=INST,
                        next_time=0.0,
                        next_vel=None,
                        include_pitch=include_pitch,
                        exclude_pitch=(held | used) or None,
                        pitch_temp=params.get("pitch_temp"),
                        min_vel=1,
                        allow_anon=params.get("allow_anon", True),
                        allow_end=False,
                    )
                    hp = int(hr["pitch"])
                    noto.feed(inst=INST, pitch=hp, time=0.0, vel=float(hr["vel"]))
                    harmony_pitches.append(hp)
                    used.add(hp)

            model_ms = (time_module.perf_counter() - t0) * 1000
            await ws.send(json.dumps({
                "type":     "free_event",
                "pitch":    pitch,
                "vel":      int(vel),
                "dt":       round(dt, 4),
                "harmony":  harmony_pitches,
                "model_ms": round(model_ms, 2),
            }))

        case "feed":
            # Direct feed — used for note-offs (vel=0).
            noto.feed(
                inst=int(msg["inst"]),
                pitch=int(msg["pitch"]),
                time=float(msg["dt"]),
                vel=float(msg["vel"]),
            )

        case "reset":
            noto.reset()
            await ws.send(json.dumps({"type": "ready"}))

async def main():
    load_model()
    print(f"WebSocket server listening on ws://localhost:{PORT}")
    async with websockets.serve(handle, "localhost", PORT):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
