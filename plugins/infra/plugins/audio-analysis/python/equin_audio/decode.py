"""Decode any audio file PyAV can open to one mono float32 signal.

PyAV's wheels bundle the FFmpeg libraries, so no system ffmpeg is involved.
"""

import av
import numpy as np
import soxr


def decode_mono(path: str, rate: int) -> np.ndarray:
    """The whole file as mono float32 in [-1, 1], resampled to `rate` Hz.

    Frames are decoded at their native rate and layout and resampled once, as
    one array, with soxr's HQ filter. Resampling each ~20 ms frame through
    PyAV's `AudioResampler` instead cost ~0.5 s of a 4-minute song's ~1.5 s
    decode (12,000 calls into swresample), with a lower-quality default filter.
    """
    chunks: list[np.ndarray] = []
    # Opus and AAC decode to planar float already; anything else is converted
    # to it frame by frame (same rate and layout, so no filtering happens).
    to_fltp: av.AudioResampler | None = None
    with av.open(path) as container:
        stream = container.streams.audio[0]
        native_rate = stream.rate
        for frame in container.decode(stream):
            if frame.format.name == "fltp":
                chunks.append(frame.to_ndarray())
                continue
            if to_fltp is None:
                to_fltp = av.AudioResampler(
                    format="fltp", layout=frame.layout.name, rate=frame.rate
                )
            for out in to_fltp.resample(frame):
                chunks.append(out.to_ndarray())
        if to_fltp is not None:
            for out in to_fltp.resample(None):
                chunks.append(out.to_ndarray())
    if not chunks:
        raise ValueError(f"{path}: no audio decoded")
    samples = np.concatenate(chunks, axis=1)
    mono = samples.mean(axis=0, dtype=np.float32)
    if native_rate == rate:
        return mono
    return soxr.resample(mono, native_rate, rate, quality="HQ").astype(
        np.float32, copy=False
    )
