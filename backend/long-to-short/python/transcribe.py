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
        beam_size=get_default_beam_size(),
        word_timestamps=get_default_word_timestamps(),
        batch_size=get_default_batch_size(),
    )
    json.dump(payload, sys.stdout)
    return 0


_loaded_models: "OrderedDict[str, object]" = OrderedDict()
_batched_pipelines: dict[int, object] = {}


def default_model_name() -> str:
    return (
        string_env("FASTER_WHISPER_DEFAULT_MODEL")
        or string_env("FASTER_WHISPER_CAPTION_MODEL")
        or string_env("FASTER_WHISPER_MODEL")
        or "small"
    )


def max_loaded_models() -> int:
    return normalize_positive_int(os.environ.get("FASTER_WHISPER_MAX_LOADED_MODELS"), 2)


def default_device() -> str:
    return string_env("FASTER_WHISPER_DEVICE") or "auto"


def default_compute_type() -> str:
    return string_env("FASTER_WHISPER_COMPUTE_TYPE") or "auto"


def model_download_root() -> str | None:
    return os.environ.get("FASTER_WHISPER_DOWNLOAD_ROOT") or None


def normalize_model(raw_model: object) -> str:
    if raw_model is None:
        return default_model_name()
    if not isinstance(raw_model, str):
        raise ValueError("Model must be a string when provided.")

    name = raw_model.strip()
    return name or default_model_name()


def string_env(name: str) -> str | None:
    raw = os.environ.get(name)
    if raw is None:
        return None

    value = raw.strip()
    return value or None


def normalize_positive_int(raw_value: object, default: int) -> int:
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def normalize_bool(raw_value: object, default: bool) -> bool:
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, str):
        value = raw_value.strip().lower()
        if value in {"1", "true", "yes", "on"}:
            return True
        if value in {"0", "false", "no", "off"}:
            return False
    return default


def get_default_beam_size() -> int:
    return normalize_positive_int(os.environ.get("FASTER_WHISPER_BEAM_SIZE", "5"), 5)


def get_default_word_timestamps() -> bool:
    return normalize_bool(os.environ.get("FASTER_WHISPER_WORD_TIMESTAMPS"), True)


def get_default_batch_size() -> int:
    return normalize_positive_int(os.environ.get("FASTER_WHISPER_BATCH_SIZE", "1"), 1)


def model_setting_candidates() -> list[dict[str, str | None]]:
    requested_device = default_device().lower()
    requested_compute_type = default_compute_type().lower()
    download_root = model_download_root()

    if requested_device == "auto":
        candidates: list[tuple[str, list[str]]] = [
            ("cuda", resolve_cuda_compute_types(requested_compute_type)),
            ("cpu", resolve_cpu_compute_types(requested_compute_type)),
        ]
    elif requested_device == "cuda":
        candidates = [("cuda", resolve_cuda_compute_types(requested_compute_type))]
    else:
        candidates = [(requested_device, resolve_cpu_compute_types(requested_compute_type))]

    seen: set[tuple[str, str]] = set()
    resolved: list[dict[str, str | None]] = []
    for device, compute_types in candidates:
        for compute_type in compute_types:
            key = (device, compute_type)
            if key in seen:
                continue
            seen.add(key)
            resolved.append(
                {
                    "device": device,
                    "compute_type": compute_type,
                    "download_root": download_root,
                }
            )

    return resolved


def resolve_cuda_compute_types(requested_compute_type: str) -> list[str]:
    if requested_compute_type == "auto":
        return ["float16", "int8_float16", "int8"]
    return [requested_compute_type]


def resolve_cpu_compute_types(requested_compute_type: str) -> list[str]:
    if requested_compute_type == "auto":
        return ["int8"]
    return [requested_compute_type]


def get_model(name: str):
    """Return a cached model, loading (and downloading if needed) on demand."""
    from faster_whisper import WhisperModel

    key = name.strip() or default_model_name()
    errors: list[str] = []

    for settings in model_setting_candidates():
        cache_key = build_model_cache_key(
            name=key,
            device=str(settings["device"]),
            compute_type=str(settings["compute_type"]),
        )
        cached = _loaded_models.get(cache_key)
        if cached is not None:
            _loaded_models.move_to_end(cache_key)
            return cached

        try:
            model = WhisperModel(
                key,
                device=str(settings["device"]),
                compute_type=str(settings["compute_type"]),
                download_root=settings["download_root"],
            )
        except Exception as error:  # noqa: BLE001 - depends on runtime device state
            errors.append(
                f'{settings["device"]}/{settings["compute_type"]}: {error}'
            )
            print(
                f'Failed to load model "{key}" on {settings["device"]}/{settings["compute_type"]}: {error}',
                file=sys.stderr,
                flush=True,
            )
            continue

        _loaded_models[cache_key] = model
        while len(_loaded_models) > max_loaded_models():
            _, evicted_model = _loaded_models.popitem(last=False)
            _batched_pipelines.pop(id(evicted_model), None)

        return model

    if errors:
        raise RuntimeError(
            f'Unable to load model "{key}". Tried: {" | ".join(errors)}'
        )
    raise RuntimeError(f'Unable to load model "{key}".')


def build_model_cache_key(*, name: str, device: str, compute_type: str) -> str:
    return f"{name}|{device}|{compute_type}"


def active_model_name() -> str | None:
    if not _loaded_models:
        return None

    key = next(reversed(_loaded_models))
    return key.split("|", 1)[0]


def get_batched_pipeline(model):
    pipeline = _batched_pipelines.get(id(model))
    if pipeline is not None:
        return pipeline

    from faster_whisper import BatchedInferencePipeline

    pipeline = BatchedInferencePipeline(model=model)
    _batched_pipelines[id(model)] = pipeline
    return pipeline


def _download_model_fn():
    try:
        from faster_whisper.utils import download_model
    except ImportError:
        from faster_whisper import download_model
    return download_model


def ensure_model_downloaded(name: str) -> str:
    """Fetch model files into the local cache without loading them into memory."""
    download_model = _download_model_fn()
    return download_model(name, cache_dir=model_download_root())


def is_model_downloaded(name: str) -> bool:
    download_model = _download_model_fn()
    try:
        download_model(name, local_files_only=True, cache_dir=model_download_root())
        return True
    except Exception:
        return False


def serve() -> int:
    # Warm the default model so the first transcription is fast. A failure here
    # must not brick the worker, because a later request may use a different
    # model or fall back to CPU.
    try:
        get_model(default_model_name())
    except Exception as error:  # noqa: BLE001 - depends on runtime/device state
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
        beam_size=normalize_positive_int(request.get("beam_size"), get_default_beam_size()),
        word_timestamps=normalize_bool(
            request.get("word_timestamps"), get_default_word_timestamps()
        ),
        batch_size=normalize_positive_int(request.get("batch_size"), get_default_batch_size()),
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
        "active": active_model_name(),
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
    model,
    input_path: str,
    language: str | None,
    beam_size: int,
    word_timestamps: bool,
    batch_size: int,
) -> dict[str, object]:
    result_segments, text_parts, detected_language, used_vad_fallback = run_transcription(
        model=model,
        input_path=input_path,
        language=language,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
        batch_size=batch_size,
    )

    return {
        "text": " ".join(text_parts).strip(),
        "language": detected_language,
        "segments": result_segments,
        "usedVadFallback": used_vad_fallback,
    }


def run_transcription(
    *,
    model,
    input_path: str,
    language: str | None,
    beam_size: int,
    word_timestamps: bool,
    batch_size: int,
) -> tuple[list[dict[str, object]], list[str], str, bool]:
    first_segments, first_text_parts, first_language = transcribe_once(
        model=model,
        input_path=input_path,
        language=language,
        vad_filter=True,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
        batch_size=batch_size,
    )
    if first_segments:
        return first_segments, first_text_parts, first_language, False

    retry_segments, retry_text_parts, retry_language = transcribe_once(
        model=model,
        input_path=input_path,
        language=language,
        vad_filter=False,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
        batch_size=batch_size,
    )
    return retry_segments, retry_text_parts, retry_language, True


def transcribe_once(
    *,
    model,
    input_path: str,
    language: str | None,
    vad_filter: bool,
    beam_size: int,
    word_timestamps: bool,
    batch_size: int,
) -> tuple[list[dict[str, object]], list[str], str]:
    segments, info = transcribe_with_pipeline(
        model=model,
        input_path=input_path,
        language=language,
        vad_filter=vad_filter,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
        batch_size=batch_size,
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


def transcribe_with_pipeline(
    *,
    model,
    input_path: str,
    language: str | None,
    vad_filter: bool,
    beam_size: int,
    word_timestamps: bool,
    batch_size: int,
):
    kwargs = {
        "language": language,
        "vad_filter": vad_filter,
        "beam_size": beam_size,
        "word_timestamps": word_timestamps,
    }

    if batch_size > 1:
        try:
            pipeline = get_batched_pipeline(model)
            return pipeline.transcribe(
                input_path,
                batch_size=batch_size,
                **kwargs,
            )
        except Exception as error:  # noqa: BLE001 - depends on installed version/runtime
            print(
                f"Falling back to non-batched inference: {error}",
                file=sys.stderr,
                flush=True,
            )

    return model.transcribe(input_path, **kwargs)


def extract_words(segment) -> list[dict[str, object]]:
    """Normalize faster-whisper word objects into JSON-safe dicts."""
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
