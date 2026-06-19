import argparse
import json
import os
import sys
from collections import OrderedDict


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", dest="input_path")
    parser.add_argument("--language", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--serve", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        from faster_whisper import WhisperModel  # noqa: F401  (presence check)
    except ModuleNotFoundError as error:
        if error.name == "faster_whisper":
            print(
                "Missing Python dependency: faster-whisper. Install backend/long-to-short/python/requirements.txt.",
                file=sys.stderr,
            )
            return 2
        raise

    if args.serve:
        return serve()

    if not args.input_path:
        print("--input is required unless --serve is used.", file=sys.stderr)
        return 2

    model = get_model(normalize_model(args.model))
    payload = transcribe_request(
        model=model,
        input_path=args.input_path,
        language=normalize_language(args.language),
    )
    json.dump(payload, sys.stdout)
    return 0


# Faster-Whisper models are loaded lazily and cached so the client can switch
# models without restarting the worker. The cache is kept small to bound memory;
# switching back to an evicted model just reloads it from the local disk cache.
MAX_LOADED_MODELS = 1
_loaded_models: "OrderedDict[str, object]" = OrderedDict()


def default_model_name() -> str:
    name = os.environ.get("FASTER_WHISPER_MODEL", "medium")
    return name.strip() or "medium"


def normalize_model(raw_model: object) -> str:
    if raw_model is None:
        return default_model_name()
    if not isinstance(raw_model, str):
        raise ValueError("Model must be a string when provided.")

    name = raw_model.strip()
    return name or default_model_name()


def model_settings() -> dict[str, object]:
    return {
        "device": os.environ.get("FASTER_WHISPER_DEVICE", "cpu"),
        "compute_type": os.environ.get("FASTER_WHISPER_COMPUTE_TYPE", "int8"),
        "download_root": os.environ.get("FASTER_WHISPER_DOWNLOAD_ROOT") or None,
    }


def get_model(name: str):
    """Return a cached model, loading (and downloading if needed) on demand."""
    from faster_whisper import WhisperModel

    key = name.strip() or default_model_name()

    cached = _loaded_models.get(key)
    if cached is not None:
        _loaded_models.move_to_end(key)
        return cached

    settings = model_settings()
    model = WhisperModel(
        key,
        device=settings["device"],
        compute_type=settings["compute_type"],
        download_root=settings["download_root"],
    )

    _loaded_models[key] = model
    while len(_loaded_models) > MAX_LOADED_MODELS:
        _loaded_models.popitem(last=False)

    return model


def _download_model_fn():
    try:
        from faster_whisper.utils import download_model
    except ImportError:
        from faster_whisper import download_model
    return download_model


def ensure_model_downloaded(name: str) -> str:
    """Fetch model files into the local cache without loading them into memory."""
    download_model = _download_model_fn()
    settings = model_settings()
    return download_model(name, cache_dir=settings["download_root"])


def is_model_downloaded(name: str) -> bool:
    download_model = _download_model_fn()
    settings = model_settings()
    try:
        download_model(name, local_files_only=True, cache_dir=settings["download_root"])
        return True
    except Exception:
        return False


def get_beam_size() -> int:
    """Beam width for decoding. Higher = more accurate, slower. Default 5."""
    raw = os.environ.get("FASTER_WHISPER_BEAM_SIZE", "5")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 5
    return value if value > 0 else 5


def serve() -> int:
    # Warm the default model so the first transcription is fast. A failure here
    # (offline, model not downloaded yet, etc.) must not brick the worker: log it
    # to stderr and still announce readiness so the client can pick another model
    # or trigger a download. Anything other than the ready line on stdout would be
    # treated as a startup failure by the Node side, so warnings go to stderr.
    try:
        get_model(default_model_name())
    except Exception as error:  # noqa: BLE001 - depends on runtime/network
        print(f"Failed to preload default model: {error}", file=sys.stderr, flush=True)

    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = ""
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Invalid request payload.")

            request_id = str(request.get("id", "")).strip()
            if not request_id:
                raise ValueError("Request id is required.")

            action = str(request.get("action") or "transcribe").strip() or "transcribe"

            if action == "transcribe":
                payload = handle_transcribe(request)
            elif action == "ensure_model":
                payload = handle_ensure_model(request)
            elif action == "list_models":
                payload = handle_list_models(request)
            else:
                raise ValueError(f"Unknown action: {action}")

            response = {
                "id": request_id,
                "ok": True,
                "payload": payload,
            }
        except Exception as error:
            response = {
                "id": request_id,
                "ok": False,
                "error": str(error) or "Python transcription failed.",
            }

        print(json.dumps(response), flush=True)

    return 0


def handle_transcribe(request: dict) -> dict[str, object]:
    input_path = request.get("input_path")
    if not isinstance(input_path, str) or not input_path.strip():
        raise ValueError("Input path is required.")

    model = get_model(normalize_model(request.get("model")))
    return transcribe_request(
        model=model,
        input_path=input_path.strip(),
        language=normalize_language(request.get("language")),
    )


def handle_ensure_model(request: dict) -> dict[str, object]:
    name = normalize_model(request.get("model"))
    path = ensure_model_downloaded(name)
    return {"model": name, "downloaded": True, "path": str(path)}


def handle_list_models(request: dict) -> dict[str, object]:
    requested = request.get("models")
    if requested is None:
        names: list[str] = []
    elif isinstance(requested, list):
        names = [str(item).strip() for item in requested if str(item).strip()]
    else:
        raise ValueError("models must be a list when provided.")

    return {
        "default": default_model_name(),
        "active": next(reversed(_loaded_models), None),
        "models": [
            {"id": name, "downloaded": is_model_downloaded(name)} for name in names
        ],
    }


def normalize_language(raw_language: object) -> str | None:
    if raw_language is None:
        return None
    if not isinstance(raw_language, str):
        raise ValueError("Language must be a string when provided.")

    language = raw_language.strip()
    return language or None


def transcribe_request(
    *,
    model: "WhisperModel",
    input_path: str,
    language: str | None,
) -> dict[str, object]:
    result_segments, text_parts, detected_language, used_vad_fallback = run_transcription(
        model=model,
        input_path=input_path,
        language=language,
    )

    return {
        "text": " ".join(text_parts).strip(),
        "language": detected_language,
        "segments": result_segments,
        "usedVadFallback": used_vad_fallback,
    }


def run_transcription(
    *,
    model: "WhisperModel",
    input_path: str,
    language: str | None,
) -> tuple[list[dict[str, object]], list[str], str, bool]:
    first_segments, first_text_parts, first_language = transcribe_once(
        model=model,
        input_path=input_path,
        language=language,
        vad_filter=True,
    )
    if first_segments:
        return first_segments, first_text_parts, first_language, False

    retry_segments, retry_text_parts, retry_language = transcribe_once(
        model=model,
        input_path=input_path,
        language=language,
        vad_filter=False,
    )
    return retry_segments, retry_text_parts, retry_language, True


def transcribe_once(
    *,
    model: "WhisperModel",
    input_path: str,
    language: str | None,
    vad_filter: bool,
) -> tuple[list[dict[str, object]], list[str], str]:
    segments, info = model.transcribe(
        input_path,
        language=language,
        vad_filter=vad_filter,
        beam_size=get_beam_size(),
        # Per-word timing is what makes captions line up with speech instead of
        # being linearly guessed from a coarse segment duration on the client.
        word_timestamps=True,
    )

    result_segments = []
    text_parts = []

    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue

        result_segments.append(
            {
                "text": text,
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "words": extract_words(segment),
            }
        )
        text_parts.append(text)

    detected_language = language or getattr(info, "language", None) or "unknown"
    return result_segments, text_parts, detected_language


def extract_words(segment) -> list[dict[str, object]]:
    """Normalize faster-whisper word objects into JSON-safe dicts.

    Returns an empty list when word timings are unavailable so the client can
    fall back to estimating timing from the segment as a whole.
    """
    raw_words = getattr(segment, "words", None)
    if not raw_words:
        return []

    words: list[dict[str, object]] = []
    for word in raw_words:
        text = (getattr(word, "word", "") or "").strip()
        if not text:
            continue

        start = getattr(word, "start", None)
        end = getattr(word, "end", None)
        if start is None or end is None:
            continue

        start_value = round(float(start), 3)
        end_value = round(float(end), 3)
        if end_value < start_value:
            end_value = start_value

        entry: dict[str, object] = {
            "word": text,
            "start": start_value,
            "end": end_value,
        }

        probability = getattr(word, "probability", None)
        if probability is not None:
            entry["probability"] = round(float(probability), 4)

        words.append(entry)

    return words


if __name__ == "__main__":
    raise SystemExit(main())
