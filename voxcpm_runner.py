"""One resident official VoxCPM2; JSON line protocol to the stdlib queue worker."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time


def split_text(text: str, limit: int = 60) -> list[str]:
    """Keep every character, split at sentence boundaries, cap long clauses."""
    pieces = re.findall(r"[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+", text)
    result = []
    for piece in pieces:
        while len(piece) > limit:
            cut = max(piece.rfind(mark, 0, limit) + 1 for mark in "，,；;、 ")
            cut = cut if cut >= limit // 2 else limit
            result.append(piece[:cut])
            piece = piece[cut:]
        if piece:
            result.append(piece)
    return result


def event(**values):
    print("VOICE_EVENT " + json.dumps(values, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    for path in reversed(config["runtime_paths"]):
        sys.path.insert(0, path)
    sys.path.insert(0, str(Path(config["adapter_path"]).parent))
    import numpy as np
    import soundfile as sf
    import torch
    from voxcpm_low_memory_adapter import load_voxcpm2_low_memory

    torch.set_num_threads(6)
    start = time.monotonic()
    model = load_voxcpm2_low_memory(config["model_dir"], device="cpu", optimize=False,
                                   repo_dir=config["repo_dir"])
    # Same BF16 tensors, now owned by anonymous RAM. Keeping same-dtype mmap
    # tensors on an external disk caused every inference step to reread weights
    # under memory pressure. Copy one tensor at a time without a second model.
    if config.get("resident_cpu_weights", True):
        names = [name for name, _ in model.tts_model.named_parameters()]
        for name in names:
            previous = model.tts_model.get_parameter(name)
            copied = previous.detach().to(device="cpu", copy=True)
            parent_name, _, leaf = name.rpartition(".")
            parent = model.tts_model.get_submodule(parent_name) if parent_name else model.tts_model
            setattr(parent, leaf, torch.nn.Parameter(copied, requires_grad=False))
            del previous, copied
        print("VOX_CPU_WEIGHTS_RESIDENT", flush=True)
    event(type="ready", model="VoxCPM2", load_seconds=time.monotonic() - start)
    for line in sys.stdin:
        try:
            job = json.loads(line)
            output = Path(job["output_dir"])
            output.mkdir(parents=True, exist_ok=True)
            cancel = Path(job["cancel_file"])
            ref = Path(job["reference_path"])
            with ref.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            if job.get("reference_sha256") and digest != job["reference_sha256"]:
                raise ValueError("Reference checksum does not match the catalog")
            chunks = [chunk for chunk in split_text(job["text"]) if chunk.strip()]
            report = {"model": "VoxCPM2", "device": "cpu", "precision": "BF16 LM / FP32 VAE",
                      "inference_timesteps": 10, "reference_sha256": digest,
                      "job_id": job["id"], "segments": []}
            audio = []
            sr = model.tts_model.sample_rate
            began = time.monotonic()
            event(type="progress", job_id=job["id"], completed_segments=0, total=len(chunks))
            for index, text in enumerate(chunks):
                if cancel.exists():
                    break
                if not text.strip():
                    continue
                seed = (int(job["seed"]) + index) % (2**31)
                segment_start = time.monotonic()
                wav = model.generate(text=text, reference_wav_path=str(ref), prompt_wav_path=str(ref),
                                     prompt_text=job["reference_text"], normalize=False, denoise=False,
                                     seed=seed, inference_timesteps=10, retry_badcase=True)
                wav = np.asarray(wav, dtype=np.float32).squeeze()
                if wav.ndim != 1 or len(wav) < sr / 4 or not np.isfinite(wav).all():
                    raise ValueError("Generated waveform is invalid")
                peak = float(np.abs(wav).max())
                if peak <= .001:
                    raise ValueError("Generated waveform is silent")
                wav *= min(1.0, .99 / peak)
                segment = output / f"segment-{index:03}.wav"
                sf.write(segment, wav, sr, subtype="PCM_16")
                audio.extend((wav, np.zeros(round(.24 * sr), dtype=np.float32)))
                report["segments"].append({"index": index, "text": text, "seed": seed,
                    "duration_seconds": len(wav) / sr, "generation_seconds": time.monotonic() - segment_start})
                event(type="segment", job_id=job["id"], index=index, completed_segments=index + 1, total=len(chunks))
            if cancel.exists():
                event(type="result", job_id=job["id"], status="cancelled")
                continue
            if not audio:
                raise ValueError("There is no spoken text")
            # VoxCPM2 produces 48 kHz natively; don't relabel a different sample rate.
            if sr != 48000:
                raise ValueError(f"Unexpected model sample rate: {sr}")
            final = output / "speech.wav"
            sf.write(final, np.concatenate(audio[:-1]), sr, subtype="PCM_16")
            report.update(duration_seconds=sf.info(final).duration,
                          generation_seconds=time.monotonic() - began,
                          result_sha256=hashlib.sha256(final.read_bytes()).hexdigest())
            (output / "generation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
            event(type="result", job_id=job["id"], status="completed", path=str(final),
                  duration_seconds=report["duration_seconds"], generation_seconds=report["generation_seconds"])
        except Exception as exc:
            # Log no credential or source path to the public queue.
            print(f"RUNNER_ERROR {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            event(type="result", status="failed", error="语音生成失败，请重试")


if __name__ == "__main__":
    main()
