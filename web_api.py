import os
import json
import traceback
import threading
import time
import uuid
import asyncio
from urllib.parse import urlparse
from aiohttp import web
from .backup import (
    backup_to_huggingface,
    restore_from_huggingface,
    get_backup_browser_tree,
    backup_selected_to_huggingface,
    restore_selected_from_huggingface,
    delete_selected_from_huggingface,
)
from .file_manager import get_model_subfolders
from .model_discovery import process_workflow_for_missing_models
from .downloader import run_download, get_remote_file_metadata, get_blob_paths, get_token
from .parse_link import parse_link
try:
    import folder_paths
except Exception:
    folder_paths = None

download_queue = []
download_queue_lock = threading.Lock()
download_status = {}
download_status_lock = threading.Lock()
download_worker_running = False
search_status = {}
search_status_lock = threading.Lock()
pending_verifications = []
pending_verifications_lock = threading.Lock()
cancel_requests = set()
cancel_requests_lock = threading.Lock()
SETTINGS_REL_PATH = os.path.join("user", "default", "comfy.settings.json")
POPULAR_MODELS_PATH = os.path.join(os.path.dirname(__file__), "metadata", "popular-models.json")
MODEL_LIBRARY_BACKEND_SETTING = "downloader.model_library_backend_enabled"
HUGGINGFACE_HOST = "huggingface.co"
MODEL_LIBRARY_EXTENSIONS = {
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".gguf",
    ".onnx",
    ".json",
    ".yaml",
    ".yml",
    ".torchscript",
    ".zip",
}
MODEL_LIBRARY_LOCAL_TYPE_MAP = {
    "checkpoints": "checkpoint",
    "diffusion_models": "diffusion_model",
    "loras": "lora",
    "controlnet": "controlnet",
    "vae": "vae",
    "text_encoders": "text_encoder",
    "clip_vision": "clip_vision",
    "upscale_models": "upscale",
    "embeddings": "embedding",
    "ipadapter": "ipadapter",
    "sam2": "sam2",
    "sam": "sam",
    "depthanything": "depthanything",
}
model_library_catalog_cache = {"mtime": None, "entries": []}
model_library_catalog_cache_lock = threading.Lock()
model_library_local_cache = {
    "timestamp": 0.0,
    "entries": [],
    "name_map": {},
}
model_library_local_cache_lock = threading.Lock()
settings_cache = {"path": None, "mtime": None, "settings": {}}
settings_cache_lock = threading.Lock()
MODEL_LIBRARY_LOCAL_CACHE_TTL_SECONDS = 3.0

# Defer verification until the download queue is empty (default on).
VERIFY_AFTER_QUEUE = True
# Minimum idle time before running deferred verification.
VERIFY_IDLE_SECONDS = 5
last_queue_activity = 0.0
last_queue_activity_lock = threading.Lock()

def _touch_queue_activity():
    global last_queue_activity
    with last_queue_activity_lock:
        last_queue_activity = time.time()

def _request_cancel(download_id: str):
    with cancel_requests_lock:
        cancel_requests.add(download_id)

def _is_cancel_requested(download_id: str) -> bool:
    with cancel_requests_lock:
        return download_id in cancel_requests

def _clear_cancel_request(download_id: str):
    with cancel_requests_lock:
        cancel_requests.discard(download_id)

def _is_huggingface_url(url: str | None) -> bool:
    if not isinstance(url, str):
        return False
    value = url.strip()
    if not value:
        return False
    try:
        parsed = urlparse(value)
    except Exception:
        return False
    host = (parsed.netloc or "").lower()
    return host == HUGGINGFACE_HOST

def _is_supported_hf_link(value: str | None) -> bool:
    if _is_huggingface_url(value):
        return True
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or "://" in text:
        return False
    try:
        parsed = parse_link(text)
        return bool(parsed.get("repo"))
    except Exception:
        return False

def _build_parsed_download_info(model: dict) -> dict:
    """Build parsed download info for run_download using HF repo/path if provided."""
    hf_repo = model.get("hf_repo")
    hf_path = model.get("hf_path")
    if hf_repo and hf_path:
        subfolder = os.path.dirname(hf_path).replace("\\", "/")
        file_name = os.path.basename(hf_path)
        parsed = {"repo": hf_repo, "file": file_name}
        if subfolder and subfolder != ".":
            parsed["subfolder"] = subfolder
        return parsed

    url = model.get("url")
    if not url:
        raise ValueError("No URL or HuggingFace repo/path provided.")
    if not _is_supported_hf_link(url):
        raise ValueError("Only Hugging Face URLs are supported by this backend.")

    parsed = parse_link(url)
    if not parsed.get("file"):
        raise ValueError(
            "URL must point to a specific file (resolve/blob/file path). "
            "Folder/repo links are not valid for single-file download queue."
        )
    return parsed

def _set_download_status(download_id: str, fields: dict):
    with download_status_lock:
        existing = download_status.get(download_id, {})
        existing.update(fields)
        download_status[download_id] = existing

def _set_search_status(request_id: str, fields: dict):
    if not request_id:
        return
    with search_status_lock:
        existing = search_status.get(request_id, {})
        existing.update(fields)
        existing["updated_at"] = time.time()
        search_status[request_id] = existing

def _coerce_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    normalized = str(value).strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    return default

def _safe_int(value: str | None, default: int, minimum: int = 0, maximum: int = 2000) -> int:
    try:
        number = int(value) if value is not None else default
    except Exception:
        number = default
    if number < minimum:
        number = minimum
    if number > maximum:
        number = maximum
    return number

def _extract_provider(entry: dict) -> str:
    provider = entry.get("provider")
    if isinstance(provider, str) and provider.strip():
        return provider.strip().lower()
    url = entry.get("url")
    if isinstance(url, str) and url.startswith("http"):
        try:
            return urlparse(url).netloc.lower()
        except Exception:
            return ""
    return ""

def _normalize_rel_path(path: str) -> str:
    return str(path or "").replace("\\", "/").lstrip("/")

def _candidate_settings_paths() -> list[str]:
    candidates = []
    base_path = getattr(folder_paths, "base_path", None) if folder_paths else None
    if base_path:
        candidates.append(os.path.join(base_path, SETTINGS_REL_PATH))
    candidates.append(os.path.join(os.getcwd(), SETTINGS_REL_PATH))
    candidates.append(SETTINGS_REL_PATH)

    unique = []
    seen = set()
    for path in candidates:
        normalized = os.path.abspath(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique.append(normalized)
    return unique

def _read_settings_dict() -> dict:
    global settings_cache
    settings_path = None
    for candidate in _candidate_settings_paths():
        if os.path.exists(candidate):
            settings_path = candidate
            break
    if not settings_path:
        return {}

    try:
        mtime = os.path.getmtime(settings_path)
    except Exception:
        return {}

    with settings_cache_lock:
        if settings_cache.get("path") == settings_path and settings_cache.get("mtime") == mtime:
            data = settings_cache.get("settings", {})
            return data if isinstance(data, dict) else {}

    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception:
        payload = {}

    if not isinstance(payload, dict):
        payload = {}

    with settings_cache_lock:
        settings_cache = {"path": settings_path, "mtime": mtime, "settings": payload}
    return payload

def _read_setting_bool(setting_id: str, default: bool) -> bool:
    settings = _read_settings_dict()
    return _coerce_bool(settings.get(setting_id), default=default)

def _is_model_library_backend_enabled() -> bool:
    return _read_setting_bool(MODEL_LIBRARY_BACKEND_SETTING, default=True)

def _get_models_root() -> str:
    base_path = getattr(folder_paths, "base_path", None) if folder_paths else None
    if not base_path:
        base_path = os.getcwd()
    return os.path.join(base_path, "models")

def _infer_local_type(directory: str) -> str:
    normalized = _normalize_rel_path(directory)
    root = normalized.split("/", 1)[0] if normalized else ""
    return MODEL_LIBRARY_LOCAL_TYPE_MAP.get(root, "checkpoint")

def _scan_local_models() -> tuple[list[dict], dict[str, list[dict]]]:
    global model_library_local_cache
    now = time.time()
    with model_library_local_cache_lock:
        if now - float(model_library_local_cache.get("timestamp", 0.0)) <= MODEL_LIBRARY_LOCAL_CACHE_TTL_SECONDS:
            return (
                model_library_local_cache.get("entries", []),
                model_library_local_cache.get("name_map", {}),
            )

    models_root = _get_models_root()
    entries: list[dict] = []
    name_map: dict[str, list[dict]] = {}
    if os.path.exists(models_root):
        for root, _, files in os.walk(models_root):
            for file in files:
                ext = os.path.splitext(file)[1].lower()
                if ext not in MODEL_LIBRARY_EXTENSIONS:
                    continue
                absolute_path = os.path.join(root, file)
                rel_path = _normalize_rel_path(os.path.relpath(absolute_path, models_root))
                directory = _normalize_rel_path(os.path.dirname(rel_path))
                stat = None
                try:
                    stat = os.stat(absolute_path)
                except Exception:
                    stat = None
                record = {
                    "filename": file,
                    "filename_lower": file.lower(),
                    "absolute_path": absolute_path,
                    "rel_path": rel_path,
                    "directory": directory,
                    "size_bytes": int(stat.st_size) if stat else None,
                    "modified_at": float(stat.st_mtime) if stat else None,
                }
                entries.append(record)
                name_map.setdefault(record["filename_lower"], []).append(record)

    entries.sort(key=lambda item: (item.get("filename_lower", ""), item.get("rel_path", "")))
    for key in list(name_map.keys()):
        name_map[key] = sorted(name_map[key], key=lambda item: item.get("rel_path", ""))

    with model_library_local_cache_lock:
        model_library_local_cache = {
            "timestamp": now,
            "entries": entries,
            "name_map": name_map,
        }
    return entries, name_map

def _load_model_library_catalog_entries() -> list[dict]:
    global model_library_catalog_cache
    if not os.path.exists(POPULAR_MODELS_PATH):
        return []

    mtime = os.path.getmtime(POPULAR_MODELS_PATH)
    with model_library_catalog_cache_lock:
        cached_mtime = model_library_catalog_cache.get("mtime")
        if cached_mtime == mtime:
            return model_library_catalog_cache.get("entries", [])

    try:
        with open(POPULAR_MODELS_PATH, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as e:
        print(f"[ERROR] Failed to load model library from {POPULAR_MODELS_PATH}: {e}")
        return []

    models = payload.get("models", {}) if isinstance(payload, dict) else {}
    if not isinstance(models, dict):
        return []

    entries = []
    for filename, meta in models.items():
        if not isinstance(meta, dict):
            continue
        entry = dict(meta)
        entry["filename"] = filename
        entry["directory"] = _normalize_rel_path(entry.get("directory", ""))
        entry["provider"] = _extract_provider(entry)
        entry["library_visible"] = bool(entry.get("library_visible", False))
        entry["is_huggingface_url"] = _is_huggingface_url(entry.get("url"))
        entries.append(entry)

    entries.sort(key=lambda item: str(item.get("filename", "")).lower())
    with model_library_catalog_cache_lock:
        model_library_catalog_cache = {"mtime": mtime, "entries": entries}
    return entries

def _build_model_library_items(
    *,
    include_catalog: bool,
    include_local_only: bool,
    hf_only: bool,
    visible_only: bool,
) -> list[dict]:
    local_entries, local_name_map = _scan_local_models()
    catalog_entries = _load_model_library_catalog_entries() if include_catalog else []

    items: list[dict] = []
    matched_local_keys: set[tuple[str, str]] = set()
    for catalog in catalog_entries:
        if hf_only and not catalog.get("is_huggingface_url"):
            continue
        if visible_only and not catalog.get("library_visible", False):
            continue

        filename = str(catalog.get("filename", "")).strip()
        filename_lower = filename.lower()
        local_matches = local_name_map.get(filename_lower, [])
        for local in local_matches:
            matched_local_keys.add((local["filename_lower"], local["rel_path"]))

        installed_paths = [local["rel_path"] for local in local_matches]
        installed_bytes = [
            local.get("size_bytes")
            for local in local_matches
            if isinstance(local.get("size_bytes"), int)
        ]

        item = dict(catalog)
        item["source_kind"] = "catalog"
        item["installed"] = len(local_matches) > 0
        item["installed_count"] = len(local_matches)
        item["installed_paths"] = installed_paths
        item["installed_bytes_total"] = sum(installed_bytes) if installed_bytes else None
        item["local_files"] = [
            {
                "rel_path": local["rel_path"],
                "directory": local["directory"],
                "size_bytes": local.get("size_bytes"),
                "modified_at": local.get("modified_at"),
            }
            for local in local_matches
        ]
        item["downloadable"] = bool(item.get("url")) and bool(item.get("is_huggingface_url"))
        items.append(item)

    if include_local_only:
        for local in local_entries:
            key = (local["filename_lower"], local["rel_path"])
            if key in matched_local_keys:
                continue
            item = {
                "filename": local["filename"],
                "name": local["filename"],
                "directory": local["directory"],
                "type": _infer_local_type(local["directory"]),
                "provider": "",
                "url": None,
                "source": "local_scan",
                "source_kind": "local",
                "library_visible": True,
                "installed": True,
                "installed_count": 1,
                "installed_paths": [local["rel_path"]],
                "installed_bytes_total": local.get("size_bytes"),
                "local_files": [
                    {
                        "rel_path": local["rel_path"],
                        "directory": local["directory"],
                        "size_bytes": local.get("size_bytes"),
                        "modified_at": local.get("modified_at"),
                    }
                ],
                "downloadable": False,
                "is_huggingface_url": False,
            }
            items.append(item)

    items.sort(key=lambda item: str(item.get("filename", "")).lower())
    return items

def _download_worker():
    global download_worker_running
    while download_worker_running:
        item = None
        with download_queue_lock:
            if download_queue:
                item = download_queue.pop(0)
        if item:
            _touch_queue_activity()

        if not item:
            if VERIFY_AFTER_QUEUE:
                with last_queue_activity_lock:
                    idle_for = time.time() - last_queue_activity
                if idle_for >= VERIFY_IDLE_SECONDS:
                    with pending_verifications_lock:
                        to_verify = pending_verifications[:]
                        pending_verifications.clear()
                    for entry in to_verify:
                        download_id = entry.get("download_id")
                        dest_path = entry.get("dest_path")
                        expected_size = entry.get("expected_size")
                        expected_sha = entry.get("expected_sha")
                        if not download_id or not dest_path:
                            continue
                        if _is_cancel_requested(download_id):
                            _set_download_status(download_id, {
                                "status": "cancelled",
                                "message": "Cancelled",
                                "finished_at": time.time()
                            })
                            _clear_cancel_request(download_id)
                            continue
                        _set_download_status(download_id, {
                            "status": "verifying",
                            "updated_at": time.time()
                        })
                        try:
                            from .downloader import _verify_file_integrity
                            _verify_file_integrity(dest_path, expected_size, expected_sha)
                            _set_download_status(download_id, {
                                "status": "completed",
                                "finished_at": time.time(),
                                "message": entry.get("message"),
                                "path": dest_path
                            })
                        except Exception as e:
                            try:
                                if os.path.exists(dest_path):
                                    os.remove(dest_path)
                            except Exception:
                                pass
                            _set_download_status(download_id, {
                                "status": "failed",
                                "error": f"Verification failed: {e}",
                                "finished_at": time.time()
                            })
            time.sleep(0.2)
            continue

        download_id = item["download_id"]
        if _is_cancel_requested(download_id):
            _set_download_status(download_id, {
                "status": "cancelled",
                "message": "Cancelled before download started",
                "finished_at": time.time()
            })
            _clear_cancel_request(download_id)
            continue
        _set_download_status(download_id, {"status": "downloading", "started_at": time.time()})

        stop_event = None
        try:
            parsed = _build_parsed_download_info(item)
            token = get_token()
            remote_filename = parsed["file"]
            if parsed.get("subfolder"):
                remote_filename = f"{parsed['subfolder'].strip('/')}/{parsed['file']}"
            expected_size, _, etag = get_remote_file_metadata(
                parsed["repo"],
                remote_filename,
                revision=parsed.get("revision"),
                token=token or None
            )
            _set_download_status(download_id, {
                "status": "downloading",
                "downloaded_bytes": 0,
                "total_bytes": expected_size,
                "updated_at": time.time()
            })

            def monitor_progress(stop_event, download_id, expected_size, blob_path, incomplete_path, filename, defer_verify):
                last_bytes = None
                last_time = time.time()
                ema_speed = None
                last_report = time.time()
                last_change = time.time()
                last_stall_log = time.time()
                waiting_logged = False
                try:
                    while not stop_event.is_set():
                        bytes_now = None
                        if incomplete_path and os.path.exists(incomplete_path):
                            bytes_now = os.path.getsize(incomplete_path)
                        elif blob_path and os.path.exists(blob_path):
                            bytes_now = os.path.getsize(blob_path)

                        if bytes_now is not None:
                            now = time.time()
                            if now - last_report >= 5:
                                blob_label = "incomplete" if (incomplete_path and os.path.exists(incomplete_path)) else "blob"
                                size_label = bytes_now
                                total_label = expected_size if expected_size is not None else "unknown"
                                print(f"[DEBUG] monitor_progress {filename}: {size_label}/{total_label} bytes ({blob_label})")
                                last_report = now
                            if last_bytes is None or bytes_now != last_bytes:
                                last_change = now
                            if expected_size and bytes_now >= expected_size:
                                _set_download_status(download_id, {
                                    "status": "downloading" if defer_verify else "verifying",
                                    "downloaded_bytes": bytes_now,
                                    "total_bytes": expected_size,
                                    "speed_bps": 0,
                                    "eta_seconds": None,
                                    "phase": "finalizing" if defer_verify else "verifying",
                                    "updated_at": now
                                })
                                return
                            if expected_size:
                                near_done = expected_size - bytes_now <= max(8 * 1024 * 1024, int(expected_size * 0.0005))
                                stalled = (now - last_change) >= 15
                                if near_done and stalled:
                                    print(f"[DEBUG] monitor_progress {filename}: stalled near completion, switching to verifying")
                                    _set_download_status(download_id, {
                                        "status": "downloading" if defer_verify else "verifying",
                                        "downloaded_bytes": bytes_now,
                                        "total_bytes": expected_size,
                                        "speed_bps": 0,
                                        "eta_seconds": None,
                                        "phase": "finalizing" if defer_verify else "verifying",
                                        "updated_at": now
                                    })
                                    return
                            if last_bytes is None:
                                inst_speed = 0
                            else:
                                delta = bytes_now - last_bytes
                                dt = now - last_time
                                inst_speed = (delta / dt) if dt > 0 else 0
                            ema_speed = inst_speed if ema_speed is None else (0.2 * inst_speed + 0.8 * ema_speed)
                            stalled_for = now - last_change
                            if stalled_for >= 30 and not waiting_logged:
                                print(f"[DEBUG] monitor_progress {filename}: waiting for data (no size change for {stalled_for:.0f}s)")
                                waiting_logged = True
                            if bytes_now != last_bytes:
                                waiting_logged = False
                            if bytes_now == last_bytes and (now - last_change) >= 10 and (now - last_stall_log) >= 10:
                                stall_for = now - last_change
                                total_label = expected_size if expected_size is not None else "unknown"
                                print(f"[DEBUG] monitor_progress {filename}: stalled at {bytes_now}/{total_label} for {stall_for:.0f}s")
                                last_stall_log = now
                            eta_seconds = None
                            if expected_size and ema_speed and ema_speed > 0:
                                eta_seconds = max(0, (expected_size - bytes_now) / ema_speed)
                            if stalled_for >= 30:
                                ema_speed = 0
                                eta_seconds = None
                            _set_download_status(download_id, {
                                "status": "downloading",
                                "downloaded_bytes": bytes_now,
                                "total_bytes": expected_size,
                                "speed_bps": ema_speed,
                                "eta_seconds": eta_seconds,
                                "phase": "waiting_for_data" if stalled_for >= 30 else "downloading",
                                "updated_at": now
                            })
                            last_bytes = bytes_now
                            last_time = now
                        time.sleep(0.5)
                except Exception:
                    return

            if etag:
                stop_event = threading.Event()
                blob_path, incomplete_path = get_blob_paths(parsed["repo"], etag)
                threading.Thread(
                    target=monitor_progress,
                    args=(stop_event, download_id, expected_size, blob_path, incomplete_path, remote_filename, VERIFY_AFTER_QUEUE),
                    daemon=True
                ).start()

            overwrite = bool(item.get("overwrite"))
            def status_cb(phase: str):
                _set_download_status(download_id, {
                    "status": phase,
                    "phase": phase,
                    "updated_at": time.time()
                })
            if VERIFY_AFTER_QUEUE:
                msg, path, info = run_download(
                    parsed,
                    item["folder"],
                    sync=True,
                    defer_verify=True,
                    overwrite=overwrite,
                    return_info=True,
                    status_cb=status_cb
                )
                if _is_cancel_requested(download_id):
                    try:
                        if path and os.path.exists(path):
                            os.remove(path)
                    except Exception:
                        pass
                    _set_download_status(download_id, {
                        "status": "cancelled",
                        "message": "Cancelled",
                        "finished_at": time.time()
                    })
                    _clear_cancel_request(download_id)
                    _touch_queue_activity()
                    continue
                _set_download_status(download_id, {
                    "status": "downloaded",
                    "message": msg,
                    "path": path,
                    "updated_at": time.time()
                })
                _touch_queue_activity()
                with pending_verifications_lock:
                    pending_verifications.append({
                        "download_id": download_id,
                        "dest_path": path,
                        "expected_size": info.get("expected_size"),
                        "expected_sha": info.get("expected_sha"),
                        "message": msg
                    })
            else:
                msg, path = run_download(parsed, item["folder"], sync=True, overwrite=overwrite, status_cb=status_cb)
                if _is_cancel_requested(download_id):
                    try:
                        if path and os.path.exists(path):
                            os.remove(path)
                    except Exception:
                        pass
                    _set_download_status(download_id, {
                        "status": "cancelled",
                        "message": "Cancelled",
                        "finished_at": time.time()
                    })
                    _clear_cancel_request(download_id)
                    _touch_queue_activity()
                    continue
                _set_download_status(download_id, {
                    "status": "completed",
                    "message": msg,
                    "path": path,
                    "finished_at": time.time()
                })
                _touch_queue_activity()
        except Exception as e:
            if _is_cancel_requested(download_id):
                _set_download_status(download_id, {
                    "status": "cancelled",
                    "message": "Cancelled",
                    "finished_at": time.time()
                })
                _clear_cancel_request(download_id)
                continue
            _set_download_status(download_id, {
                "status": "failed",
                "error": str(e),
                "finished_at": time.time()
            })
        finally:
            if stop_event:
                stop_event.set()

def _start_download_worker():
    global download_worker_running
    if download_worker_running:
        return
    download_worker_running = True
    threading.Thread(target=_download_worker, daemon=True).start()

async def folder_structure(request):
    """Return the list of model subfolders"""
    try:
        folders = get_model_subfolders()
        return web.json_response(folders)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def check_missing_models(request):
    """
    Analyzes the workflow JSON to find missing models.
    Returns: { "missing": [...], "found": [...] }
    """
    try:
        print("[DEBUG] check_missing_models called")
        data = await request.json()
        request_id = data.get("request_id") or uuid.uuid4().hex
        _set_search_status(request_id, {"message": "Scanning workflow", "source": "workflow"})

        def status_cb(payload):
            if not payload:
                return
            if isinstance(payload, str):
                _set_search_status(request_id, {"message": payload})
                return
            if isinstance(payload, dict):
                _set_search_status(request_id, payload)

        result = await asyncio.to_thread(
            process_workflow_for_missing_models,
            data,
            status_cb
        )
        _set_search_status(request_id, {"message": "Done", "source": "complete"})
        result["request_id"] = request_id
        return web.json_response(result)
    except Exception as e:
        print(f"[ERROR] check_missing_models failed: {e}")
        print(f"[ERROR] Traceback: {traceback.format_exc()}")
        return web.json_response({"error": str(e) if str(e) else repr(e)}, status=500)

async def install_models(request):
    """
    Downloads a list of models.
    Expects JSON: { "models": [ { "url": "...", "filename": "...", "folder": "..." }, ... ] }
    """
    try:
        print("[DEBUG] install_models called")
        data = await request.json()
        models_to_install = data.get("models", [])
        
        results = []
        for model in models_to_install:
            url = model.get("url")
            filename = model.get("filename")
            folder = model.get("folder", "checkpoints") # Default to checkpoints
            
            if not url and not (model.get("hf_repo") and model.get("hf_path")):
                results.append({"filename": filename, "status": "failed", "error": "No URL provided"})
                continue
                
            try:
                parsed = _build_parsed_download_info(model)
                msg, path = run_download(parsed, folder, sync=True, overwrite=bool(model.get("overwrite")))
                results.append({"filename": filename, "status": "success", "path": path, "message": msg})
                
            except Exception as e:
                print(f"[ERROR] Failed to download {filename}: {e}")
                results.append({"filename": filename, "status": "failed", "error": str(e)})
        
        return web.json_response({"results": results})
        
    except Exception as e:
         return web.json_response({"error": str(e)}, status=500)

def _read_backup_repo_name() -> str:
    settings_path = os.path.join("user", "default", "comfy.settings.json")
    if not os.path.exists(settings_path):
        return ""
    try:
        with open(settings_path, "r", encoding="utf-8") as handle:
            settings = json.load(handle)
        return settings.get("downloaderbackup.repo_name", "").strip()
    except Exception:
        return ""


def _parse_size_limit(value, default=5.0) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)


async def backup_browser_tree(request):
    repo_name = _read_backup_repo_name()
    try:
        payload = get_backup_browser_tree(repo_name)
        return web.json_response({"status": "ok", **payload})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def backup_to_hf(request):
    data = await request.json()
    folders = data.get("folders", [])
    size_limit_gb = _parse_size_limit(data.get("size_limit_gb", 5), default=5)
    repo_name = _read_backup_repo_name()
    if not repo_name:
        return web.json_response({"status": "error", "message": "No repo name set in settings."}, status=400)
    try:
        backup_to_huggingface(repo_name, folders, size_limit_gb=size_limit_gb)
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def backup_selected_to_hf_endpoint(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    selections = data.get("items", [])
    size_limit_gb = _parse_size_limit(data.get("size_limit_gb", 5), default=5)
    repo_name = _read_backup_repo_name()
    if not repo_name:
        return web.json_response({"status": "error", "message": "No repo name set in settings."}, status=400)
    try:
        result = backup_selected_to_huggingface(repo_name, selections, size_limit_gb=size_limit_gb)
        return web.json_response({"status": "ok", **result})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def restore_from_hf(request):
    repo_name = _read_backup_repo_name()
    if not repo_name:
        return web.json_response({"status": "error", "message": "No repo name set in settings."}, status=400)
    try:
        restore_from_huggingface(repo_name)
        return web.json_response({"status": "ok", "restart_required": True})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def restore_selected_from_hf_endpoint(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    selections = data.get("items", [])
    repo_name = _read_backup_repo_name()
    if not repo_name:
        return web.json_response({"status": "error", "message": "No repo name set in settings."}, status=400)
    try:
        result = restore_selected_from_huggingface(repo_name, selections)
        return web.json_response({"status": "ok", **result})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def delete_from_hf_backup_endpoint(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    selections = data.get("items", [])
    repo_name = _read_backup_repo_name()
    if not repo_name:
        return web.json_response({"status": "error", "message": "No repo name set in settings."}, status=400)
    try:
        result = delete_selected_from_huggingface(repo_name, selections)
        return web.json_response({"status": "ok", **result})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

def setup(app):
    app.router.add_get("/folder_structure", folder_structure)
    app.router.add_get("/backup_browser_tree", backup_browser_tree)
    app.router.add_post("/backup_to_hf", backup_to_hf)
    app.router.add_post("/backup_selected_to_hf", backup_selected_to_hf_endpoint)
    app.router.add_post("/restore_from_hf", restore_from_hf)
    app.router.add_post("/restore_selected_from_hf", restore_selected_from_hf_endpoint)
    app.router.add_post("/delete_from_hf_backup", delete_from_hf_backup_endpoint)
    app.router.add_post("/check_missing_models", check_missing_models)
    app.router.add_post("/install_models", install_models)

    async def queue_download(request):
        """Queue background downloads with status tracking."""
        try:
            data = await request.json()
            models = data.get("models", [])
            queued = []
            rejected = []
            for model in models:
                filename = model.get("filename")
                folder = model.get("folder", "checkpoints")
                if not filename:
                    rejected.append({
                        "filename": filename or "",
                        "error": "Missing filename",
                    })
                    continue
                url = model.get("url")
                if url and not _is_supported_hf_link(url):
                    rejected.append({
                        "filename": filename,
                        "error": "Only Hugging Face URLs are supported by this backend.",
                    })
                    continue
                download_id = f"dl_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
                item = dict(model)
                item["download_id"] = download_id
                item["folder"] = folder
                with download_queue_lock:
                    download_queue.append(item)
                _set_download_status(download_id, {
                    "status": "queued",
                    "filename": filename,
                    "folder": folder,
                    "queued_at": time.time()
                })
                queued.append({"download_id": download_id, "filename": filename})

            if queued:
                _touch_queue_activity()
            _start_download_worker()
            return web.json_response({"queued": queued, "rejected": rejected})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def cancel_download(request):
        """Cancel a queued download or request cancellation for an active one."""
        try:
            data = await request.json()
        except Exception:
            data = {}
        download_id = (data.get("download_id") or "").strip()
        if not download_id:
            return web.json_response({"error": "download_id is required"}, status=400)

        _request_cancel(download_id)

        removed_from_queue = False
        with download_queue_lock:
            if download_queue:
                kept = []
                for item in download_queue:
                    if item.get("download_id") == download_id:
                        removed_from_queue = True
                        continue
                    kept.append(item)
                if removed_from_queue:
                    download_queue[:] = kept

        if removed_from_queue:
            _set_download_status(download_id, {
                "status": "cancelled",
                "message": "Cancelled before download started",
                "finished_at": time.time()
            })
            _clear_cancel_request(download_id)
            return web.json_response({"status": "cancelled", "download_id": download_id})

        with pending_verifications_lock:
            before = len(pending_verifications)
            pending_verifications[:] = [
                entry for entry in pending_verifications
                if entry.get("download_id") != download_id
            ]
            removed_from_verify = len(pending_verifications) < before
        if removed_from_verify:
            _set_download_status(download_id, {
                "status": "cancelled",
                "message": "Cancelled before verification",
                "finished_at": time.time()
            })
            _clear_cancel_request(download_id)
            return web.json_response({"status": "cancelled", "download_id": download_id})

        with download_status_lock:
            current = dict(download_status.get(download_id, {}))
        current_status = current.get("status")
        if current_status in ("cancelled", "failed", "completed"):
            _clear_cancel_request(download_id)
            return web.json_response({"status": current_status, "download_id": download_id})

        if current_status in ("downloading", "copying", "cleaning_cache", "finalizing", "verifying", "downloaded"):
            _set_download_status(download_id, {
                "status": "cancelling",
                "updated_at": time.time()
            })
            return web.json_response({"status": "cancelling", "download_id": download_id})

        # Fallback when status entry is missing or still queued in race window.
        _set_download_status(download_id, {
            "status": "cancelled",
            "message": "Cancelled",
            "finished_at": time.time()
        })
        _clear_cancel_request(download_id)
        return web.json_response({"status": "cancelled", "download_id": download_id})

    async def download_status_endpoint(request):
        """Get current status of downloads."""
        ids_param = request.query.get("ids", "")
        ids = [x for x in ids_param.split(",") if x]
        with download_status_lock:
            if ids:
                filtered = {i: download_status.get(i) for i in ids if i in download_status}
            else:
                filtered = dict(download_status)
        return web.json_response({"downloads": filtered})

    async def search_status_endpoint(request):
        request_id = request.query.get("request_id", "")
        with search_status_lock:
            status = search_status.get(request_id, {}) if request_id else {}
        return web.json_response({"status": status})

    async def model_library_endpoint(request):
        """
        Return local model-library items (catalog + installed models).
        Query params:
        - visible_only: true|false (default: true); applies to catalog entries
        - include_catalog: true|false (default: true)
        - include_local_only: true|false (default: true)
        - hf_only: ignored (backend is always HuggingFace-only)
        - installed_only: true|false (default: false)
        - missing_only: true|false (default: false)
        - q: substring search over filename/url/type/directory/provider/source
        - type: exact match against manager_type or type
        - directory: exact directory match
        - provider: exact provider host match
        - sort: name|installed|size|updated (default: name)
        - offset: pagination offset (default 0)
        - limit: page size (default 200, max 2000)
        """
        backend_enabled = _is_model_library_backend_enabled()
        if not backend_enabled:
            return web.json_response(
                {
                    "backend_enabled": False,
                    "error": "Model library backend is disabled in settings.",
                    "setting_id": MODEL_LIBRARY_BACKEND_SETTING,
                },
                status=403,
            )

        visible_only = _coerce_bool(request.query.get("visible_only"), default=True)
        include_catalog = _coerce_bool(request.query.get("include_catalog"), default=True)
        include_local_only = _coerce_bool(request.query.get("include_local_only"), default=True)
        # Current backend scope is HuggingFace-only by design.
        hf_only = True
        installed_only = _coerce_bool(request.query.get("installed_only"), default=False)
        missing_only = _coerce_bool(request.query.get("missing_only"), default=False)
        query = (request.query.get("q", "") or "").strip().lower()
        type_filter = (request.query.get("type", "") or "").strip().lower()
        directory_filter = (request.query.get("directory", "") or "").strip().lower()
        provider_filter = (request.query.get("provider", "") or "").strip().lower()
        sort = (request.query.get("sort", "name") or "name").strip().lower()
        offset = _safe_int(request.query.get("offset"), default=0, minimum=0, maximum=5_000_000)
        limit = _safe_int(request.query.get("limit"), default=200, minimum=1, maximum=2000)

        entries = _build_model_library_items(
            include_catalog=include_catalog,
            include_local_only=include_local_only,
            hf_only=hf_only,
            visible_only=visible_only,
        )
        filtered = []
        for entry in entries:
            installed = bool(entry.get("installed"))
            if installed_only and not installed:
                continue
            if missing_only and installed:
                continue

            manager_type = str(entry.get("manager_type", "") or "").strip().lower()
            model_type = str(entry.get("type", "") or "").strip().lower()
            if type_filter and type_filter not in (manager_type, model_type):
                continue

            directory = _normalize_rel_path(str(entry.get("directory", "") or "")).lower()
            if directory_filter and directory_filter != directory:
                continue

            provider = str(entry.get("provider", "") or "").strip().lower()
            if provider_filter and provider_filter != provider:
                continue

            if query:
                haystack = " ".join(
                    [
                        str(entry.get("filename", "") or ""),
                        str(entry.get("url", "") or ""),
                        str(entry.get("type", "") or ""),
                        str(entry.get("manager_type", "") or ""),
                        str(entry.get("directory", "") or ""),
                        str(entry.get("source", "") or ""),
                        provider,
                    ]
                ).lower()
                if query not in haystack:
                    continue

            filtered.append(entry)

        if sort == "installed":
            filtered.sort(
                key=lambda item: (
                    0 if item.get("installed") else 1,
                    str(item.get("filename", "")).lower(),
                )
            )
        elif sort == "size":
            filtered.sort(
                key=lambda item: (
                    -(item.get("installed_bytes_total") or 0),
                    str(item.get("filename", "")).lower(),
                )
            )
        elif sort == "updated":
            def _updated_key(item: dict):
                files = item.get("local_files") or []
                timestamps = [x.get("modified_at") for x in files if isinstance(x, dict)]
                numeric = [t for t in timestamps if isinstance(t, (int, float))]
                latest = max(numeric) if numeric else 0
                return (-latest, str(item.get("filename", "")).lower())
            filtered.sort(key=_updated_key)
        else:
            filtered.sort(key=lambda item: str(item.get("filename", "")).lower())

        directory_counts = {}
        type_counts = {}
        provider_counts = {}
        stats = {
            "total": len(filtered),
            "installed": 0,
            "missing": 0,
            "catalog": 0,
            "local_only": 0,
            "downloadable": 0,
        }
        for entry in filtered:
            if entry.get("installed"):
                stats["installed"] += 1
            else:
                stats["missing"] += 1
            if entry.get("source_kind") == "local":
                stats["local_only"] += 1
            else:
                stats["catalog"] += 1
            if entry.get("downloadable"):
                stats["downloadable"] += 1
            directory = _normalize_rel_path(str(entry.get("directory", "") or ""))
            if directory:
                directory_counts[directory] = directory_counts.get(directory, 0) + 1
            manager_type = str(entry.get("manager_type", "") or "").strip()
            model_type = str(entry.get("type", "") or "").strip()
            type_name = manager_type or model_type
            if type_name:
                type_counts[type_name] = type_counts.get(type_name, 0) + 1
            provider = str(entry.get("provider", "") or "").strip()
            if provider:
                provider_counts[provider] = provider_counts.get(provider, 0) + 1

        total = len(filtered)
        items = filtered[offset : offset + limit]
        return web.json_response(
            {
                "backend_enabled": True,
                "hf_only": hf_only,
                "visible_only": visible_only,
                "include_catalog": include_catalog,
                "include_local_only": include_local_only,
                "installed_only": installed_only,
                "missing_only": missing_only,
                "sort": sort,
                "total": total,
                "offset": offset,
                "limit": limit,
                "stats": stats,
                "facets": {
                    "directories": directory_counts,
                    "types": type_counts,
                    "providers": provider_counts,
                },
                "items": items,
            }
        )
    
    async def restart(request):
        """Restart ComfyUI server"""
        import sys
        import os
        
        # Schedule the restart after sending response
        def restart_server():
            python = sys.executable
            os.execl(python, python, *sys.argv)
            
        app.loop.call_later(1, restart_server)
        return web.json_response({"status": "ok"})
        
    app.router.add_post("/restart", restart)
    app.router.add_post("/queue_download", queue_download)
    app.router.add_post("/cancel_download", cancel_download)
    app.router.add_get("/download_status", download_status_endpoint)
    app.router.add_get("/search_status", search_status_endpoint)
    app.router.add_get("/model_library", model_library_endpoint)
