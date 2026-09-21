"""Command line interface: clean files (or whole folders) with the same engine.

    /opt/nsvenv/bin/python -m noisesimplifier.cli meeting.wav
    /opt/nsvenv/bin/python -m noisesimplifier.cli recordings/ --strength 0.85 --auto-gain
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from .backends.spectral import SpectralDenoiser, SpectralSettings

AUDIO_SUFFIXES = {".wav", ".flac", ".ogg", ".aiff", ".aif"}


def collect_inputs(targets: list[str]) -> list[Path]:
    files: list[Path] = []
    for target in targets:
        path = Path(target).expanduser()
        if path.is_dir():
            files.extend(sorted(p for p in path.iterdir() if p.suffix.lower() in AUDIO_SUFFIXES))
        elif path.is_file():
            files.append(path)
        else:
            raise SystemExit(f"not found: {path}")
    return files


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="noisesimplifier", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("inputs", nargs="+", help="audio files or folders")
    parser.add_argument("-o", "--out", help="output file (single input only)")
    parser.add_argument("--strength", type=float, default=0.75, help="0..1, default 0.75")
    parser.add_argument("--max-attenuation-db", type=float, default=26.0)
    parser.add_argument("--no-voice-focus", action="store_true", help="keep the full band")
    parser.add_argument("--auto-gain", action="store_true", help="level quiet talkers")
    parser.add_argument("--highpass-hz", type=float, default=95.0)
    parser.add_argument("--lowpass-hz", type=float, default=7600.0)
    parser.add_argument("--fft-size", type=int, default=1024)
    parser.add_argument("--quiet", action="store_true", help="summary lines only")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        import soundfile as sf
    except ImportError:
        raise SystemExit("soundfile is required: /opt/nsvenv/bin/pip install soundfile")

    inputs = collect_inputs(args.inputs)
    if not inputs:
        raise SystemExit("no audio files found")
    if args.out and len(inputs) > 1:
        raise SystemExit("--out only works with a single input")

    settings = SpectralSettings(
        strength=args.strength,
        voice_focus=not args.no_voice_focus,
        auto_gain=args.auto_gain,
        highpass_hz=args.highpass_hz,
        lowpass_hz=args.lowpass_hz,
        max_attenuation_db=args.max_attenuation_db,
        fft_size=args.fft_size,
    )

    for source in inputs:
        audio, sample_rate = sf.read(str(source), always_2d=True)
        denoiser = SpectralDenoiser(sample_rate, settings)
        clean = denoiser.denoise_channels(audio.T).T
        peak = float(np.max(np.abs(clean))) if clean.size else 0.0
        if peak > 1.0:
            clean = clean / peak * 0.999
        target = Path(args.out) if args.out else source.with_name(f"{source.stem}.clean{source.suffix}")
        sf.write(str(target), clean, sample_rate)
        if not args.quiet:
            print(f"{source}  ->  {target}")
            print(f"  {sample_rate} Hz, {audio.shape[1]} ch, {audio.shape[0] / sample_rate:.1f} s"
                  f"  |  suppression {denoiser.last_suppression_db:5.1f} dB"
                  f"  |  noise floor {denoiser.last_noise_floor_db:6.1f} dB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
