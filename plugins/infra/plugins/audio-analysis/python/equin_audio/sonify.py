"""The beat grid made audible: a click at every beat (a higher, louder one on
downbeats) mixed over the audio, written as a 16-bit mono wav.

stdin: {audioPath, featuresPath, outPath}
stdout: {outPath, beats, seconds}
"""

import json
import sys
import time
import wave

import numpy as np

from equin_audio.decode import decode_mono

RATE = 44100


def click(freq: float, amp: float) -> np.ndarray:
    n = int(0.035 * RATE)
    t = np.arange(n) / RATE
    return amp * np.sin(2 * np.pi * freq * t) * np.exp(-t * 90)


def main() -> None:
    req = json.load(sys.stdin)
    started = time.monotonic()
    with open(req["featuresPath"]) as f:
        beats = json.load(f)["beats"]
    y = decode_mono(req["audioPath"], RATE).astype(np.float64)
    peak = float(np.max(np.abs(y))) or 1.0
    mix = 0.5 * y / peak
    down, up = click(1760.0, 0.9), click(1100.0, 0.55)
    for b in beats:
        c = down if b["downbeat"] else up
        i = int(b["t"] * RATE)
        n = min(len(c), len(mix) - i)
        if n > 0:
            mix[i : i + n] += c[:n]
    pcm = (np.clip(mix, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(req["outPath"], "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    json.dump(
        {
            "outPath": req["outPath"],
            "beats": len(beats),
            "seconds": round(time.monotonic() - started, 4),
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
