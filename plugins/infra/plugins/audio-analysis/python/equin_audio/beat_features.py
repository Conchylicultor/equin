"""Beat features of one audio file: Beat This! beats and downbeats, then a
beat-synchronous treble and bass chroma and a per-beat loudness.

The runPython contract: ONE JSON document on stdin, ONE on stdout, anything
else (progress, warnings) on stderr. The features themselves are too large for
stdout: they are written to `outPath`, which the caller validates and renames
into the cache. stdout carries a small summary.

stdin: {audioPath, outPath, device: "auto"|"cpu"|"mps", modelsDir, videoId,
        analysisVersion, settings: {beatModel, chroma}, audioFormat,
        ytDlpVersion}
stdout: {beats, medianBpm, seconds, device}
"""

import json
import os
import sys
import time

# The analysed signal's rate: Beat This! runs at 22.05 kHz, and so does the
# chroma, so one decode serves both.
SAMPLE_RATE = 22050
# Beat This! checkpoints (MIT licensed, code and weights), each fetched once
# into `modelsDir` (TORCH_HOME) and pinned by sha256. `final0` is the paper's
# main model; `small0` its small variant (≈10× fewer parameters).
CHECKPOINT_BASE = "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp"
CHECKPOINTS = {
    "final0": "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
    "small0": "6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b",
}
# The chroma variants, both the harmonic part (HPSS) of a tuning-compensated
# CQT. `full`: tuning from every STFT frame, a CQT every 512 samples (23 ms).
# `fast`: tuning from every 4th frame, a CQT every 1024 samples (46 ms — still
# ≥7 frames per beat at 170 BPM), the HPSS kernel halved in frames so it spans
# the same 0.7 s. Dropping HPSS instead saved only ~0.1 s more and let drums
# into the bass: its strongest pitch class matched `full` on 45–87 % of beats.
CHROMA = {
    "full": {"hop": 512, "tuning_hop": 512, "hpss_kernel": (31, 9)},
    "fast": {"hop": 1024, "tuning_hop": 2048, "hpss_kernel": (15, 9)},
}
# (first MIDI note, bins): treble chroma C3..B6 (MIDI 48..95), bass chroma
# E1..E3 (MIDI 28..52). Both are cut from one CQT spanning 28..95.
TREBLE = (48, 48)
BASS = (28, 25)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> None:
    req = json.load(sys.stdin)
    settings = req["settings"]
    model = settings["beatModel"]
    chroma_variant = CHROMA[settings["chroma"]]
    if model not in CHECKPOINTS:
        raise ValueError(f"unknown Beat This! checkpoint {model!r}")
    # Before torch is imported: torch.hub resolves its cache from TORCH_HOME.
    os.environ["TORCH_HOME"] = req["modelsDir"]

    import numpy as np

    from equin_audio.decode import decode_mono

    started = time.monotonic()
    # Importing the two stacks costs more than using them (torch ≈1.5 s;
    # librosa's scipy.signal and numba ≈2 s), and neither overlaps with the
    # other in one interpreter: the chroma runs in a spawned child, which
    # imports librosa while this process decodes, then imports torch and
    # tracks the beats.
    chroma_proc = ChromaProcess(settings["chroma"])
    try:
        y = decode_mono(req["audioPath"], SAMPLE_RATE)
        duration = len(y) / SAMPLE_RATE
        log(f"decoded {duration:.1f} s in {time.monotonic() - started:.1f} s")
        chroma_proc.send(y)
        beats, downbeats, device = track_beats(y, req["device"], model)
        tuning, treble, bass = chroma_proc.result()
    finally:
        chroma_proc.close()
    if len(beats) < 2:
        raise ValueError(f"only {len(beats)} beat(s) found: not music, or silent")

    starts = np.asarray(beats, dtype=np.float64)
    ends = np.append(starts[1:], duration)
    frame_times = np.arange(treble.shape[1]) * chroma_variant["hop"] / SAMPLE_RATE
    is_down = mark_downbeats(starts, np.asarray(downbeats, dtype=np.float64))
    loud = span_rms(y, starts, ends)

    out_beats = []
    bar_pos = 0
    for i, start in enumerate(starts):
        if is_down[i]:
            bar_pos = 1
        elif bar_pos > 0:
            bar_pos += 1
        cols = span_columns(frame_times, start, ends[i])
        out_beats.append(
            {
                "t": r4(start),
                "downbeat": bool(is_down[i]),
                "barPos": bar_pos,
                "chroma": vec(np.median(treble[:, cols], axis=1)),
                "bass": vec(np.median(bass[:, cols], axis=1)),
                "rms": r4(loud[i]),
            }
        )

    features = {
        "videoId": req["videoId"],
        "analysisVersion": req["analysisVersion"],
        "durationSec": r4(duration),
        "sampleRate": SAMPLE_RATE,
        "tuningCents": r4(tuning * 100),
        "beats": out_beats,
        "source": {
            "audioFormat": req["audioFormat"],
            "ytDlpVersion": req["ytDlpVersion"],
            "model": f"beat_this {model}",
            "device": device,
            "settings": settings,
        },
    }
    with open(req["outPath"], "w") as f:
        json.dump(features, f, separators=(",", ":"))

    json.dump(
        {
            "beats": len(out_beats),
            "medianBpm": r4(60.0 / float(np.median(np.diff(starts)))),
            "seconds": r4(time.monotonic() - started),
            "device": device,
        },
        sys.stdout,
    )


class ChromaProcess:
    """`chromas` in a spawned child: started at once (so its imports overlap
    the parent's decode), fed the decoded signal, read back once. A child that
    throws sends its traceback, raised here; one that dies is an EOF, raised
    with its exit code — never a missing chroma."""

    def __init__(self, variant: str) -> None:
        import multiprocessing

        ctx = multiprocessing.get_context("spawn")
        self._conn, child_conn = ctx.Pipe()
        self._proc = ctx.Process(
            target=chroma_worker, args=(child_conn, variant), daemon=True
        )
        self._proc.start()
        child_conn.close()

    def send(self, y) -> None:
        self._conn.send(y)

    def result(self):
        try:
            kind, value = self._conn.recv()
        except EOFError:
            self._proc.join()
            raise RuntimeError(
                f"the chroma process died (exit code {self._proc.exitcode})"
            ) from None
        if kind == "error":
            raise RuntimeError(f"the chroma process failed:\n{value}")
        return value

    def close(self) -> None:
        self._conn.close()
        self._proc.join(timeout=5)
        if self._proc.is_alive():
            self._proc.kill()


def chroma_worker(conn, variant_name: str) -> None:
    """The child's body: import librosa's whole chroma path before the signal
    arrives, then compute and send (tuning, treble, bass)."""
    import traceback

    try:
        t = time.monotonic()
        import librosa.core.constantq  # noqa: F401
        import librosa.core.pitch  # noqa: F401
        import librosa.decompose  # noqa: F401
        import scipy.ndimage  # noqa: F401  (HPSS's median filter)
        import scipy.signal  # noqa: F401  (librosa's window functions)

        log(f"chroma process ready in {time.monotonic() - t:.1f} s")
        y = conn.recv()
        t = time.monotonic()
        tuning, treble, bass = chromas(y, CHROMA[variant_name])
        log(
            f"chroma ({variant_name}) in {time.monotonic() - t:.1f} s "
            f"(tuning {tuning * 100:+.1f} cents)"
        )
        conn.send(("ok", (tuning, treble, bass)))
    except BaseException:
        conn.send(("error", traceback.format_exc()))
        raise
    finally:
        conn.close()
    # The result is sent: skip the interpreter's teardown (≈1 s of unloading
    # numba and scipy), which the parent would otherwise wait out in close().
    os._exit(0)


def resolve_device(requested: str) -> str:
    """`auto` is MPS when torch can use it, else CPU; an explicit `mps` that
    torch cannot use is an error, never a silent CPU run."""
    import torch

    mps = torch.backends.mps.is_available()
    if requested == "auto":
        return "mps" if mps else "cpu"
    if requested == "mps" and not mps:
        raise RuntimeError("device mps requested but torch reports MPS unavailable")
    if requested not in ("cpu", "mps"):
        raise ValueError(f"unknown device {requested!r}")
    return requested


def track_beats(y, requested_device: str, model: str):
    """Beat This! with its minimal post-processing (no DBN): (beat times,
    downbeat times, the device it ran on)."""
    t = time.monotonic()
    import torch
    from beat_this.inference import Audio2Beats

    device = resolve_device(requested_device)
    tracker = Audio2Beats(checkpoint_path=checkpoint(model), device=device, dbn=False)
    with torch.inference_mode():
        beats, downbeats = tracker(y, SAMPLE_RATE)
    log(
        f"beat this {model} ({device}): {len(beats)} beats, {len(downbeats)} "
        f"downbeats in {time.monotonic() - t:.1f} s"
    )
    return list(beats), list(downbeats), device


def checkpoint(model: str) -> str:
    """The pinned checkpoint's local path, downloaded (sha256-checked, no
    progress bar on stderr) on first use into torch.hub's dir (TORCH_HOME)."""
    import hashlib

    import torch

    url = f"{CHECKPOINT_BASE}/{model}.ckpt"
    expected = CHECKPOINTS[model]
    path = os.path.join(torch.hub.get_dir(), "checkpoints", f"beat_this-{model}.ckpt")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        log(f"downloading the Beat This! {model} checkpoint")
        tmp = f"{path}.part-{os.getpid()}"
        torch.hub.download_url_to_file(url, tmp, progress=False)
        with open(tmp, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        if digest != expected:
            os.remove(tmp)
            raise RuntimeError(f"{url}: sha256 {digest}, expected {expected}")
        os.replace(tmp, path)
    return path


def chromas(y, variant):
    """(tuning in semitone fractions, treble chroma, bass chroma) — each chroma
    is 12 x frames, C..B: log-compressed magnitudes of the harmonic part of one
    tuning-compensated CQT, folded by pitch class.

    The harmonic/percussive split is median filtering on the CQT magnitude
    itself (time-wise for harmonic, across bins for percussive), not
    `librosa.effects.harmonic` on the waveform: the same idea at ~1 s instead
    of ~30 s for a 4-minute song.
    """
    import librosa
    import numpy as np

    tuning = float(
        librosa.estimate_tuning(y=y, sr=SAMPLE_RATE, hop_length=variant["tuning_hop"])
    )
    low = BASS[0]
    high = TREBLE[0] + TREBLE[1]
    cqt = np.abs(
        librosa.cqt(
            y,
            sr=SAMPLE_RATE,
            hop_length=variant["hop"],
            fmin=librosa.midi_to_hz(low),
            n_bins=high - low,
            bins_per_octave=12,
            tuning=tuning,
        )
    )
    harmonic_mask, _ = librosa.decompose.hpss(
        cqt, kernel_size=variant["hpss_kernel"], mask=True
    )
    compressed = np.log1p(100.0 * harmonic_mask * cqt)

    def folded(fmin_midi: int, n_bins: int):
        chroma = np.zeros((12, compressed.shape[1]), dtype=np.float64)
        for k in range(n_bins):
            chroma[(fmin_midi + k) % 12] += compressed[fmin_midi - low + k]
        return chroma

    return tuning, folded(*TREBLE), folded(*BASS)


def mark_downbeats(beats, downbeats):
    """Which beats are downbeats: Beat This! snaps each downbeat to its nearest
    beat, so the nearest beat index is exact."""
    import numpy as np

    is_down = np.zeros(len(beats), dtype=bool)
    for d in downbeats:
        is_down[int(np.argmin(np.abs(beats - d)))] = True
    return is_down


def span_columns(frame_times, start: float, end: float):
    """The chroma frames inside [start, end) — at least the nearest one."""
    import numpy as np

    cols = np.nonzero((frame_times >= start) & (frame_times < end))[0]
    if len(cols) == 0:
        cols = np.array([int(np.argmin(np.abs(frame_times - start)))])
    return cols


def span_rms(y, starts, ends):
    """Each beat span's RMS, relative to the loudest span (0–1)."""
    import numpy as np

    values = []
    for s, e in zip(starts, ends):
        seg = y[int(s * SAMPLE_RATE) : max(int(e * SAMPLE_RATE), int(s * SAMPLE_RATE) + 1)]
        values.append(float(np.sqrt(np.mean(np.square(seg, dtype=np.float64)))))
    arr = np.asarray(values)
    top = arr.max()
    return arr / top if top > 0 else arr


def vec(v) -> list[float]:
    """Max-normalised to 0–1, rounded (all zeros stays all zeros)."""
    top = float(v.max())
    return [r4(x / top) if top > 0 else 0.0 for x in v]


def r4(x) -> float:
    return round(float(x), 4)


if __name__ == "__main__":
    main()
