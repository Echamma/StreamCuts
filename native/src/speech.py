"""StreamCuts speech: word timings for sound files, with faster-whisper on the graphics card when it works, else the
processor. StreamCuts carries this script inside itself and writes it out to run it.

Usage: python speech.py manifest.json
The manifest is a list of {"wav": path, "out": path}; each out gets {"words": [[start, end, text], ...], "noises":
[[start, end], ...]}, seconds from the start of its wav. Noises are stretches with sound but no words heard in them (a laugh,
a shout, or words the model missed), so whoever edits from the words doesn't take them for silence. A line of JSON is printed as each one finishes, so StreamCuts can show progress.
"""
import json
import os
import site
import sys
import wave

# The pip-installed CUDA libraries (nvidia-cublas-cu12, nvidia-cudnn-cu12) aren't on the DLL search path by themselves.
for base in site.getsitepackages() + [site.getusersitepackages()]:
    for lib in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
        folder = os.path.join(base, "nvidia", lib, "bin")
        if os.path.isdir(folder):
            os.add_dll_directory(folder)
            os.environ["PATH"] = folder + os.pathsep + os.environ["PATH"]

from faster_whisper import WhisperModel  # noqa: E402

GPU_MODEL = os.environ.get("STREAMCUTS_WHISPER_MODEL", "medium")
CPU_MODEL = os.environ.get("STREAMCUTS_WHISPER_CPU_MODEL", "small")


def load(device):
    if device == "cuda":
        return WhisperModel(GPU_MODEL, device="cuda", compute_type="float16")
    return WhisperModel(CPU_MODEL, device="cpu", compute_type="int8")


def words_of(model, wav):
    segments, _ = model.transcribe(
        wav,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        word_timestamps=True,
    )
    return [
        [round(w.start, 3), round(w.end, 3), w.word.strip()]
        for s in segments
        for w in (s.words or [])
        if w.word.strip()
    ]


def noises(wav, words):
    """Stretches of 0.3 s or more louder than -45 dBFS where no word is (words padded a little), as [start, end]."""
    import numpy as np

    with wave.open(wav) as w:
        rate = w.getframerate()
        samples = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    hop = int(rate * 0.05)
    if hop == 0 or len(samples) < hop:
        return []
    frames = len(samples) // hop
    levels = 20 * np.log10(np.sqrt(np.mean(samples[: frames * hop].reshape(frames, hop) ** 2, axis=1)) + 1e-9)
    loud = levels > -45
    for start, end, _ in words:
        loud[max(int((start - 0.15) / 0.05), 0) : int((end + 0.15) / 0.05) + 1] = False
    out = []
    i = 0
    while i < frames:
        if loud[i]:
            j = i
            # Holes of up to 0.2 s don't end a stretch.
            while j < frames and (loud[j] or loud[j : j + 5].any()):
                j += 1
            if (j - i) * 0.05 >= 0.3:
                out.append([round(i * 0.05, 2), round(j * 0.05, 2)])
            i = j
        else:
            i += 1
    return out


def main():
    jobs = json.load(open(sys.argv[1], encoding="utf-8"))
    device = "cuda"
    try:
        model = load(device)
    except Exception:
        device = "cpu"
        model = load(device)
    for job in jobs:
        try:
            words = words_of(model, job["wav"])
        except Exception:
            # The CUDA libraries load lazily: a card that can't run it fails here, not when loading.
            if device != "cuda":
                raise
            device = "cpu"
            model = load(device)
            words = words_of(model, job["wav"])
        with open(job["out"], "w", encoding="utf-8") as f:
            json.dump({"words": words, "noises": noises(job["wav"], words)}, f, ensure_ascii=False)
        print(json.dumps({"done": job["out"], "device": device}), flush=True)


if __name__ == "__main__":
    main()
