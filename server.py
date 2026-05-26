#!/usr/bin/env python3
"""
Harmony engine for coimproviser (Phase 3).

Receives recent player pitches over WebSocket, detects the key via music21's
Krumhansl-Schmuckler analysis, and projects a 4-chord progression rooted at
the player's current harmonic context. Used to drive ImprovRNN's chord
conditioning with functional progressions instead of a single repeating chord.

Protocol:
  Browser → server:
    { "type": "harmony", "current_chord": "Cmaj7", "history": [60, 62, 64, ...] }
  Server → browser:
    { "type": "progression",
      "current": "Cmaj7", "key": "C major",
      "chords":  ["Cmaj7", "Am7", "Dm7", "G7"] }

Chord detection is done client-side (template-matching in useNotochord.js); the
server only handles key estimation and progression projection.
"""

import asyncio
import json
import logging
import os
import random
import re
import signal
import subprocess

import websockets
from music21 import stream, note


logging.getLogger('websockets').setLevel(logging.CRITICAL)

PORT = 8765

PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
PC_INDEX = {n: i for i, n in enumerate(PC_NAMES)}
# Also map flat spellings to the same pitch classes.
for flat, sharp in [('Db','C#'),('Eb','D#'),('Gb','F#'),('Ab','G#'),('Bb','A#')]:
    PC_INDEX[flat] = PC_INDEX[sharp]

# Diatonic intervals (semitones from tonic) for each scale degree 1..7.
MAJOR_DEGREES = [0, 2, 4, 5, 7, 9, 11]
MINOR_DEGREES = [0, 2, 3, 5, 7, 8, 10]   # natural minor

# Quality suffix for each degree.
MAJOR_QUALITIES = ['',  'm', 'm', '',  '',  'm', 'dim']
MINOR_QUALITIES = ['m', 'dim', '', 'm', 'm', '',  '']

# Functional transitions: from degree → list of common successor degrees.
MAJOR_TRANSITIONS = {
    1: [5, 4, 6, 2],   # I  → V / IV / vi / ii
    2: [5, 7, 1],
    3: [6, 4],
    4: [5, 1, 2],
    5: [1, 6, 4],
    6: [4, 2, 5],
    7: [1],
}
MINOR_TRANSITIONS = {
    1: [5, 4, 6, 7],   # i  → V / iv / VI / VII
    2: [5, 1],
    3: [6, 7],
    4: [5, 1, 7],
    5: [1, 6],
    6: [4, 2, 5],
    7: [1, 3],
}


def parse_chord_root(symbol):
    """Extract the pitch class of a chord symbol's root. Returns 0..11 or None."""
    if not symbol:
        return None
    m = re.match(r'^([A-G][#b]?)', symbol)
    if not m:
        return None
    return PC_INDEX.get(m.group(1))


def chord_uses_sevenths(symbol):
    """Detect whether the player chord includes a 7th."""
    return symbol and ('7' in symbol or 'maj7' in symbol)


def chord_at_degree(tonic_pc, mode, degree, use_seventh):
    """Build a triad (or 7th) chord symbol for a degree in a key."""
    degrees   = MAJOR_DEGREES   if mode == 'major' else MINOR_DEGREES
    qualities = MAJOR_QUALITIES if mode == 'major' else MINOR_QUALITIES
    pc        = (tonic_pc + degrees[degree - 1]) % 12
    suffix    = qualities[degree - 1]
    if use_seventh:
        # Append the appropriate 7th flavor.
        if suffix == '':
            # Tonic in major or III/V/VI in minor: major triad. Use dominant 7
            # for V degree, maj7 for I/IV in major, etc.
            if mode == 'major' and degree == 5: suffix = '7'
            elif mode == 'major' and degree in (1, 4): suffix = 'maj7'
            else: suffix = '7'
        elif suffix == 'm':   suffix = 'm7'
        elif suffix == 'dim': suffix = 'm7b5'
    return f"{PC_NAMES[pc]}{suffix}"


def degree_of_chord(chord_root_pc, tonic_pc, mode):
    """Find which scale degree (1..7) the chord root sits on. None if not diatonic."""
    diff = (chord_root_pc - tonic_pc) % 12
    degrees = MAJOR_DEGREES if mode == 'major' else MINOR_DEGREES
    for i, iv in enumerate(degrees):
        if iv == diff:
            return i + 1
    return None


def detect_key(history_pitches):
    """Return (tonic_pc, mode_str). Falls back to C major when input is too thin."""
    if len(history_pitches) < 4:
        return (0, 'major')
    s = stream.Stream()
    for p in history_pitches:
        s.append(note.Note(midi=int(p)))
    k = s.analyze('key')
    tonic_pc = PC_INDEX.get(k.tonic.name) or 0
    return (tonic_pc, k.mode)


def project_progression(current_chord, history):
    tonic_pc, mode = detect_key(history)
    use_seventh    = chord_uses_sevenths(current_chord)

    current_root = parse_chord_root(current_chord)
    if current_root is None:
        # Default to a I-vi-IV-V style walk from the tonic.
        return (
            [chord_at_degree(tonic_pc, mode, d, use_seventh) for d in (1, 6, 4, 5)],
            f"{PC_NAMES[tonic_pc]} {mode}",
        )

    degree = degree_of_chord(current_root, tonic_pc, mode)
    if degree is None:
        # Non-diatonic chord: keep the player's chord at the head, then walk
        # from tonic for the rest of the bars.
        chords = [current_chord] + [
            chord_at_degree(tonic_pc, mode, d, use_seventh) for d in (1, 4, 5)
        ]
        return (chords, f"{PC_NAMES[tonic_pc]} {mode}")

    transitions = MAJOR_TRANSITIONS if mode == 'major' else MINOR_TRANSITIONS
    chords = [current_chord]
    cur = degree
    for _ in range(3):
        nxt = random.choice(transitions.get(cur, [1]))
        chords.append(chord_at_degree(tonic_pc, mode, nxt, use_seventh))
        cur = nxt
    return (chords, f"{PC_NAMES[tonic_pc]} {mode}")


async def handle(ws):
    print("Client connected")
    await ws.send(json.dumps({'type': 'ready'}))
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get('type') != 'harmony':
                continue
            try:
                current = msg.get('current_chord')
                history = msg.get('history', [])
                chords, key_label = project_progression(current, history)
                await ws.send(json.dumps({
                    'type':    'progression',
                    'current': current,
                    'key':     key_label,
                    'chords':  chords,
                }))
            except Exception as exc:
                import traceback
                print(f"[server] error in harmony: {exc}")
                traceback.print_exc()
    except websockets.exceptions.ConnectionClosedError:
        pass
    except websockets.exceptions.ConnectionClosedOK:
        pass


def free_port(port):
    result = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True)
    for pid in result.stdout.split():
        try:
            if int(pid) != os.getpid():
                os.kill(int(pid), signal.SIGTERM)
                print(f"Killed stale server (PID {pid}) on port {port}")
        except (ValueError, ProcessLookupError):
            pass


async def main():
    free_port(PORT)
    print(f"Harmony engine listening on ws://localhost:{PORT}")
    async with websockets.serve(handle, "localhost", PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
