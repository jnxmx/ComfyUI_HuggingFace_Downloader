import os
import json
import traceback
import threading
import time
import uuid
import asyncio
import mimetypes
import shutil
import re
from datetime import datetime, timezone
from urllib.parse import urlparse, unquote
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
from .downloader import (
    run_download,
    run_download_folder,
    run_download_url,
    get_remote_file_metadata,
    get_blob_paths,
    get_token,
)
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
MODEL_LIBRARY_CLOUD_CATALOG_PATH_CANDIDATES = [
    os.path.join(
        os.path.dirname(__file__),
        "metadata",
        "marketplace_extract",
        "from_dump",
        "cloud_marketplace_models.json",
    ),
    os.path.join(
        os.path.dirname(__file__),
        "metadata",
        "marketplace_extract",
        "cloud_marketplace_models.json",
    ),
]
MODEL_LIBRARY_PRIORITY_CATALOG_PATH = os.path.join(
    os.path.dirname(__file__), "metadata", "popular-models.json"
)
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
MODEL_LIBRARY_ASSET_ROUTE_BASE = "/api/hf_model_library_assets"
MODEL_LIBRARY_ASSET_CACHE_TTL_SECONDS = 2.0
MODEL_LIBRARY_PREVIEW_URL = (
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20320%20320'%3E"
    "%3Cdefs%3E%3ClinearGradient%20id='g'%20x1='0'%20y1='0'%20x2='1'%20y2='1'%3E"
    "%3Cstop%20offset='0%25'%20stop-color='%23d6d7dc'/%3E%3Cstop%20offset='100%25'%20stop-color='%2353555f'/%3E"
    "%3C/linearGradient%3E%3C/defs%3E%3Crect%20width='320'%20height='320'%20fill='url(%23g)'/%3E%3C/svg%3E"
)
MODEL_LIBRARY_CATEGORY_CANONICAL = {
    "checkpoint": "checkpoints",
    "checkpoints": "checkpoints",
    "diffusion_model": "diffusion_models",
    "diffusion_models": "diffusion_models",
    "lora": "loras",
    "loras": "loras",
    "vae": "vae",
    "controlnet": "controlnet",
    "upscale": "upscale_models",
    "upscaler": "upscale_models",
    "upscale_models": "upscale_models",
    "style_models": "style_models",
    "gligen": "gligen",
    "clip_vision": "clip_vision",
    "clip": "text_encoders",
    "text_encoder": "text_encoders",
    "text_encoders": "text_encoders",
    "audio_encoder": "audio_encoders",
    "audio_encoders": "audio_encoders",
    "model_patches": "model_patches",
    "animatediff_models": "animatediff_models",
    "animatediff_motion_lora": "animatediff_motion_lora",
    "chatterbox/chatterbox": "chatterbox/chatterbox",
    "chatterbox/chatterbox_turbo": "chatterbox/chatterbox_turbo",
    "chatterbox/chatterbox_multilingual": "chatterbox/chatterbox_multilingual",
    "chatterbox/chatterbox_vc": "chatterbox/chatterbox_vc",
    "latent_upscale_models": "latent_upscale_models",
    "sam2": "sams",
    "sam": "sams",
    "sams": "sams",
    "ultralytics": "ultralytics",
    "ultralytics/bbox": "ultralytics",
    "ultralytics/segm": "ultralytics",
    "depthanything": "depthanything",
    "ipadapter": "ipadapter",
    "segformer_b2_clothes": "segformer_b2_clothes",
    "segformer_b3_clothes": "segformer_b3_clothes",
    "segformer_b3_fashion": "segformer_b3_fashion",
    "flashvsr-v1.1": "FlashVSR-v1.1",
}

# --- Model Explorer Helpers ---

MODEL_EXPLORER_ALLOWED_CATEGORIES = {
    "diffusion_models",
    "text_encoders",
    "vae",
    "checkpoints",
    "loras",
    "upscale_models",
    "controlnet",
    "clip_vision",
    "model_patches",
    "style_models",
    "latent_upscale_models",
    "vae_approx",
    "animatediff_models",
    "animatediff_motion_lora",
    "ipadapter",
}

MODEL_EXPLORER_BASE_APPLICABLE_CATEGORIES = {"checkpoints", "diffusion_models", "loras"}
MODEL_EXPLORER_VISIBLE_SOURCES = {
    "cloud_marketplace_export",
    "comfyui_manager_model_list",
}
MODEL_EXPLORER_DB_PATH = os.path.join(
    os.path.dirname(__file__),
    "metadata",
    "popular-models.json",
)

_model_explorer_catalog_cache = {"mtime": 0.0, "models": {}}
_model_explorer_catalog_lock = threading.Lock()
_model_explorer_precision_pattern = re.compile(
    r"(?:^|[-_.])("
    r"fp(?:32|16|8|4)"
    r"|bf16"
    r"|int(?:8|4)"
    r"|q\d(?:_[a-z0-9]+)*"
    r"|iq\d(?:_[a-z0-9]+)*"
    r")(?:$|[-_.])",
    re.IGNORECASE,
)
_model_explorer_filename_precision_pattern = re.compile(
    r"(fp32|fp16|bf16|fp8|int8|int4|fp4|q\d(?:_[a-z0-9]+)*|iq\d(?:_[a-z0-9]+)*)",
    re.IGNORECASE,
)

def _load_model_explorer_catalog() -> dict:
    global _model_explorer_catalog_cache
    if not os.path.exists(MODEL_EXPLORER_DB_PATH):
        return {}

    try:
        mtime = os.path.getmtime(MODEL_EXPLORER_DB_PATH)
    except Exception:
        return {}

    with _model_explorer_catalog_lock:
        if _model_explorer_catalog_cache["mtime"] == mtime:
            return _model_explorer_catalog_cache["models"]

    try:
        with open(MODEL_EXPLORER_DB_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            raw_models = data.get("models", {})
            filtered_models = {}
            for name, row in raw_models.items():
                if not isinstance(row, dict):
                    continue
                source = str(row.get("source") or "").strip()
                if source not in MODEL_EXPLORER_VISIBLE_SOURCES:
                    continue
                if not bool(row.get("explorer_enabled")):
                    continue
                category = str(row.get("explorer_category") or "").strip()
                if category not in MODEL_EXPLORER_ALLOWED_CATEGORIES:
                    continue
                entry = dict(row)
                entry["filename"] = str(entry.get("filename") or name or "").strip()
                if not entry["filename"]:
                    continue
                filtered_models[entry["filename"]] = entry
    except Exception as e:
        print(f"[ERROR] Failed to load unified Model Explorer DB: {e}")
        filtered_models = {}

    with _model_explorer_catalog_lock:
        _model_explorer_catalog_cache = {"mtime": mtime, "models": filtered_models}
    return filtered_models

PRIORITY_RECLASS_CATEGORY_UNKNOWN = "unknown"
PRIORITY_RECLASS_LORA_MARKERS = (
    " lora",
    "_lora",
    "-lora",
    "loras",
    "lycoris",
    "locon",
)
PRIORITY_RECLASS_VAE_MARKERS = (
    "vae",
    "tae",
    "taesd",
    "vae_approx",
)
PRIORITY_RECLASS_CONTROLNET_MARKERS = (
    "controlnet",
    "control-net",
    "t2i-adapter",
    "t2iadapter",
    "scribble",
    "lineart",
    "openpose",
    "depth-control",
    "canny-control",
    "pose-control",
)
PRIORITY_RECLASS_TEXT_ENCODER_MARKERS = (
    "text_encoder",
    "text-encoder",
    "text enc",
    "tokenizer",
    "embedder",
    "embeddings_connector",
    "clip_l",
    "clip_g",
    "umt5",
    "t5xxl",
)
PRIORITY_RECLASS_CLIP_VISION_MARKERS = (
    "clip_vision",
    "clipvision",
    "image_encoder",
    "vision_encoder",
)
PRIORITY_RECLASS_IPADAPTER_MARKERS = (
    "ipadapter",
    "ip-adapter",
    "ip_adapter",
)
PRIORITY_RECLASS_SAM_MARKERS = (
    "sam2",
    "segment-anything",
    "segment_anything",
    "mobile_sam",
    "sam_hiera",
    "hiera_",
)
PRIORITY_RECLASS_UPSCALE_MARKERS = (
    "upscale",
    "upscaler",
    "esrgan",
    "realesrgan",
    "swinir",
)
PRIORITY_RECLASS_DIFFUSION_MARKERS = (
    "diffusion",
    "unet",
    "transformer_only",
    "flux",
    "klein",
    "sdxl",
    "stable-diffusion",
    "sd3",
    "wan",
    "hunyuan",
    "qwen-image",
    "qwen_image",
    "ltx",
    "pixart",
    "kolors",
    "cogview",
    "svd",
    "zero123",
)
model_library_catalog_cache = {"signature": None, "entries": []}
model_library_catalog_cache_lock = threading.Lock()
model_library_local_cache = {
    "timestamp": 0.0,
    "entries": [],
    "name_map": {},
}
model_library_local_cache_lock = threading.Lock()
model_explorer_local_cache: dict[str, dict] = {}
model_explorer_local_cache_lock = threading.Lock()
model_library_assets_cache = {"timestamp": 0.0, "assets": [], "id_map": {}}
model_library_assets_cache_lock = threading.Lock()
model_library_asset_overrides = {}
model_library_asset_overrides_lock = threading.Lock()
settings_cache = {"path": None, "mtime": None, "settings": {}}
settings_cache_lock = threading.Lock()
MODEL_LIBRARY_LOCAL_CACHE_TTL_SECONDS = 3.0
MODEL_EXPLORER_LOCAL_CACHE_TTL_SECONDS = 30.0

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


def _is_direct_http_url(value: str | None) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text:
        return False
    try:
        parsed = urlparse(text)
    except Exception:
        return False
    scheme = (parsed.scheme or "").lower()
    return scheme in ("http", "https") and bool(parsed.netloc)


def _sanitize_filename_hint(value: str | None) -> str:
    text = str(value or "").replace("\\", "/").strip().strip("/")
    if not text:
        return ""
    base = os.path.basename(text)
    if not base or base in (".", ".."):
        return ""
    return base


def _derive_file_display_name(model: dict) -> str:
    explicit = _sanitize_filename_hint(model.get("filename"))
    if explicit:
        return explicit

    hf_path = _sanitize_filename_hint(model.get("hf_path"))
    if hf_path:
        return hf_path

    url = str(model.get("url") or "").strip()
    if not url:
        return ""

    if _is_supported_hf_link(url):
        try:
            parsed = parse_link(url)
            parsed_file = _sanitize_filename_hint(parsed.get("file"))
            if parsed_file:
                return parsed_file
        except Exception:
            pass

    if _is_direct_http_url(url):
        try:
            parsed_url = urlparse(url)
            tail = _sanitize_filename_hint(unquote(os.path.basename((parsed_url.path or "").rstrip("/"))))
            if tail:
                return tail
        except Exception:
            pass
        return "download"

    return ""

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

def _build_parsed_folder_download_info(model: dict) -> dict:
    """Build parsed info for folder/repo download queue items."""
    url = model.get("url")
    if not url:
        raise ValueError("No URL provided for folder download.")
    if not _is_supported_hf_link(url):
        raise ValueError("Only Hugging Face URLs are supported by this backend.")

    parsed = parse_link(url)
    repo = str(parsed.get("repo") or "").strip()
    if not repo:
        raise ValueError("Link does not contain repository information.")

    remote_subfolder_path = str(parsed.get("subfolder") or "").replace("\\", "/").strip("/")
    if remote_subfolder_path:
        last_segment = os.path.basename(remote_subfolder_path)
    else:
        split_repo = repo.split("/", 1)
        last_segment = split_repo[1] if len(split_repo) > 1 else split_repo[0]

    if not last_segment:
        raise ValueError("Could not determine destination folder name from link.")

    return {
        "parsed": parsed,
        "remote_subfolder_path": remote_subfolder_path,
        "last_segment": last_segment,
        "display_name": f"{last_segment}",
    }

def _set_download_status(download_id: str, fields: dict):
    with download_status_lock:
        existing = download_status.get(download_id, {})
        existing_status = str(existing.get("status") or "").strip().lower()
        incoming_status = str(fields.get("status") or "").strip().lower()

        # Once a download is cancelling/cancelled, do not let progress callbacks
        # overwrite it back to active states like "downloading".
        if existing_status in ("cancelling", "cancelled"):
            if incoming_status and incoming_status not in ("cancelled", "failed"):
                fields = dict(fields)
                fields.pop("status", None)
                if existing_status == "cancelling":
                    fields["phase"] = "cancelling"
            elif existing_status == "cancelled" and incoming_status and incoming_status != "cancelled":
                fields = dict(fields)
                fields.pop("status", None)
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
    return _read_setting_bool(MODEL_LIBRARY_BACKEND_SETTING, default=False)

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

def _scan_local_models_for_explorer(category_filter: str = "") -> tuple[list[dict], dict[str, list[dict]]]:
    models_root = _get_models_root()
    category = str(category_filter or "").strip()
    cache_key = category or "__all__"
    now = time.time()

    with model_explorer_local_cache_lock:
        cached = model_explorer_local_cache.get(cache_key)
        if cached and (now - float(cached.get("timestamp", 0.0)) <= MODEL_EXPLORER_LOCAL_CACHE_TTL_SECONDS):
            return cached.get("entries", []), cached.get("name_map", {})

    entries: list[dict] = []
    name_map: dict[str, list[dict]] = {}

    def _add_record(rel_path: str):
        rel_norm = _normalize_rel_path(rel_path)
        if not rel_norm:
            return
        filename = os.path.basename(rel_norm)
        if not filename:
            return
        ext = os.path.splitext(filename)[1].lower()
        if ext not in MODEL_LIBRARY_EXTENSIONS:
            return
        absolute_path = os.path.join(models_root, rel_norm)
        directory = _normalize_rel_path(os.path.dirname(rel_norm))
        stat = None
        try:
            if os.path.exists(absolute_path):
                stat = os.stat(absolute_path)
        except Exception:
            stat = None
        record = {
            "filename": filename,
            "filename_lower": filename.lower(),
            "absolute_path": absolute_path,
            "rel_path": rel_norm,
            "directory": directory,
            "size_bytes": int(stat.st_size) if stat else None,
            "modified_at": float(stat.st_mtime) if stat else None,
        }
        entries.append(record)
        name_map.setdefault(record["filename_lower"], []).append(record)

    used_folder_paths = False
    if folder_paths and hasattr(folder_paths, "get_filename_list"):
        categories = [category] if category else sorted(MODEL_EXPLORER_ALLOWED_CATEGORIES)
        for cat in categories:
            try:
                names = folder_paths.get_filename_list(cat) or []
            except Exception:
                continue
            used_folder_paths = True
            for rel_name in names:
                rel_in_category = _normalize_rel_path(str(rel_name or ""))
                if not rel_in_category:
                    continue
                rel_path = _normalize_rel_path(f"{cat}/{rel_in_category}")
                _add_record(rel_path)

    if not used_folder_paths:
        all_entries, all_name_map = _scan_local_models()
        if category:
            filtered_entries = []
            filtered_name_map: dict[str, list[dict]] = {}
            for item in all_entries:
                directory = _normalize_rel_path(item.get("directory", ""))
                root = directory.split("/", 1)[0] if directory else ""
                if root != category:
                    continue
                filtered_entries.append(item)
                key = str(item.get("filename_lower") or "")
                if key:
                    filtered_name_map.setdefault(key, []).append(item)
            entries = filtered_entries
            name_map = filtered_name_map
        else:
            entries = all_entries
            name_map = all_name_map

    entries.sort(key=lambda item: (item.get("filename_lower", ""), item.get("rel_path", "")))
    for key in list(name_map.keys()):
        name_map[key] = sorted(name_map[key], key=lambda item: item.get("rel_path", ""))

    with model_explorer_local_cache_lock:
        model_explorer_local_cache[cache_key] = {
            "timestamp": now,
            "entries": entries,
            "name_map": name_map,
        }

    return entries, name_map

def _resolve_model_library_cloud_catalog_path() -> str | None:
    for candidate in MODEL_LIBRARY_CLOUD_CATALOG_PATH_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    # Fallback for installs that only carry popular-models.json.
    if os.path.exists(MODEL_LIBRARY_PRIORITY_CATALOG_PATH):
        return MODEL_LIBRARY_PRIORITY_CATALOG_PATH
    return None

def _resolve_model_library_priority_catalog_path() -> str | None:
    if os.path.exists(MODEL_LIBRARY_PRIORITY_CATALOG_PATH):
        return MODEL_LIBRARY_PRIORITY_CATALOG_PATH
    return None

def _safe_mtime(path: str | None) -> float | None:
    if not path:
        return None
    try:
        return os.path.getmtime(path)
    except Exception:
        return None

def _load_models_dict_from_catalog_path(path: str | None) -> dict:
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as e:
        print(f"[ERROR] Failed to load model library from {path}: {e}")
        return {}

    models = payload.get("models", {}) if isinstance(payload, dict) else {}
    if not isinstance(models, dict):
        return {}
    return models

def _build_model_library_catalog_entry(filename: str, meta: dict) -> dict | None:
    filename_clean = str(filename or "").strip()
    if not filename_clean:
        return None
    if not isinstance(meta, dict):
        return None

    entry = dict(meta)
    entry["filename"] = filename_clean
    entry["directory"] = _normalize_rel_path(entry.get("directory", ""))
    entry["provider"] = _extract_provider(entry)
    # Cloud export entries do not include library_visible, so default to visible.
    entry["library_visible"] = bool(entry.get("library_visible", True))
    entry["is_huggingface_url"] = _is_huggingface_url(entry.get("url"))
    return entry

def _contains_any_marker(signal: str, markers: tuple[str, ...]) -> bool:
    if not signal:
        return False
    for marker in markers:
        if marker and marker in signal:
            return True
    return False

def _build_priority_reclass_signal(entry: dict) -> str:
    fields = [
        entry.get("filename"),
        entry.get("name"),
        entry.get("url"),
        entry.get("repo_id"),
        entry.get("directory"),
        entry.get("type"),
        entry.get("manager_type"),
        entry.get("provider"),
    ]
    lowered = [
        str(value or "").strip().lower()
        for value in fields
        if str(value or "").strip()
    ]
    return " | ".join(lowered)

def _smart_reclass_priority_checkpoint_entry(entry: dict) -> str:
    signal = _build_priority_reclass_signal(entry)
    if not signal:
        return PRIORITY_RECLASS_CATEGORY_UNKNOWN

    if _contains_any_marker(signal, PRIORITY_RECLASS_LORA_MARKERS):
        return "loras"
    if _contains_any_marker(signal, PRIORITY_RECLASS_VAE_MARKERS):
        return "vae"
    if _contains_any_marker(signal, PRIORITY_RECLASS_CONTROLNET_MARKERS):
        return "controlnet"
    if _contains_any_marker(signal, PRIORITY_RECLASS_TEXT_ENCODER_MARKERS):
        return "text_encoders"
    if _contains_any_marker(signal, PRIORITY_RECLASS_CLIP_VISION_MARKERS):
        return "clip_vision"
    if _contains_any_marker(signal, PRIORITY_RECLASS_IPADAPTER_MARKERS):
        return "ipadapter"
    if _contains_any_marker(signal, PRIORITY_RECLASS_SAM_MARKERS):
        return "sams"
    if _contains_any_marker(signal, PRIORITY_RECLASS_UPSCALE_MARKERS):
        return "upscale_models"
    if _contains_any_marker(signal, PRIORITY_RECLASS_DIFFUSION_MARKERS):
        return "diffusion_models"
    return PRIORITY_RECLASS_CATEGORY_UNKNOWN

def _load_model_library_catalog_entries() -> list[dict]:
    global model_library_catalog_cache
    cloud_catalog_path = _resolve_model_library_cloud_catalog_path()
    priority_catalog_path = _resolve_model_library_priority_catalog_path()
    if not cloud_catalog_path and not priority_catalog_path:
        return []

    cache_signature = (
        cloud_catalog_path or "",
        _safe_mtime(cloud_catalog_path),
        priority_catalog_path or "",
        _safe_mtime(priority_catalog_path),
    )
    with model_library_catalog_cache_lock:
        if model_library_catalog_cache.get("signature") == cache_signature:
            return model_library_catalog_cache.get("entries", [])

    cloud_models = _load_models_dict_from_catalog_path(cloud_catalog_path)
    if priority_catalog_path and priority_catalog_path == cloud_catalog_path:
        priority_models = cloud_models
    else:
        priority_models = _load_models_dict_from_catalog_path(priority_catalog_path)

    entries_by_filename: dict[str, dict] = {}

    # Cloud entries are authoritative and win conflicts by filename.
    for filename, meta in cloud_models.items():
        if not isinstance(meta, dict):
            continue
        source_value = str(meta.get("source", "") or "").strip().lower()
        if source_value and source_value != "cloud_marketplace_export":
            continue
        entry = _build_model_library_catalog_entry(filename, meta)
        if not entry:
            continue
        filename_key = str(entry.get("filename", "")).lower()
        if not filename_key:
            continue
        entries_by_filename[filename_key] = entry

    # Add non-cloud entries from merged priority DB if cloud does not already
    # provide the filename. For priority checkpoint rows, run smart reclass.
    for filename, meta in priority_models.items():
        if not isinstance(meta, dict):
            continue
        filename_key = str(filename or "").strip().lower()
        if not filename_key or filename_key in entries_by_filename:
            continue
        source_value = str(meta.get("source", "") or "").strip().lower()
        if source_value == "cloud_marketplace_export":
            continue
        entry = _build_model_library_catalog_entry(filename, meta)
        if not entry:
            continue

        category = _resolve_model_library_category(entry)

        # Only smart-reclass checkpoint rows from priority source.
        if source_value == "priority_repo_scrape" and (
            not category or str(category).lower() == "checkpoints"
        ):
            reclassed = _smart_reclass_priority_checkpoint_entry(entry)
            if reclassed == PRIORITY_RECLASS_CATEGORY_UNKNOWN:
                entry["library_visible"] = False
                entry["_resolved_category"] = PRIORITY_RECLASS_CATEGORY_UNKNOWN
                continue
            entry["_resolved_category"] = reclassed
            category = reclassed

        if not category:
            continue
        if str(category).lower() in {"checkpoints", PRIORITY_RECLASS_CATEGORY_UNKNOWN}:
            continue
        entries_by_filename[filename_key] = entry

    entries = list(entries_by_filename.values())

    entries.sort(key=lambda item: str(item.get("filename", "")).lower())
    with model_library_catalog_cache_lock:
        model_library_catalog_cache = {"signature": cache_signature, "entries": entries}
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

def _to_iso8601(value) -> str | None:
    if isinstance(value, (int, float)):
        try:
            if float(value) <= 0:
                return None
            return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
        except Exception:
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            return datetime.fromisoformat(text).isoformat()
        except Exception:
            return None
    return None

def _canonical_model_library_category(value: str | None) -> str | None:
    normalized = _normalize_rel_path(value or "").strip("/")
    if not normalized:
        return None
    lowered = normalized.lower()
    direct = MODEL_LIBRARY_CATEGORY_CANONICAL.get(lowered)
    if direct:
        return direct
    top_level = lowered.split("/", 1)[0]
    return MODEL_LIBRARY_CATEGORY_CANONICAL.get(top_level)

def _resolve_model_library_category(entry: dict) -> str | None:
    resolved_override = str(
        entry.get("_resolved_category", "") or entry.get("resolved_category", "")
    ).strip()
    if resolved_override:
        return resolved_override

    manager_type = str(entry.get("manager_type", "") or "").strip()
    model_type = str(entry.get("type", "") or "").strip()
    directory = _normalize_rel_path(str(entry.get("directory", "") or "").strip())
    directory_top_level = directory.split("/", 1)[0] if directory else ""
    manager_category = _canonical_model_library_category(manager_type) if manager_type else None
    manager_is_checkpoint_like = manager_category == "checkpoints"
    # 1) Trust explicit non-checkpoint manager_type first.
    if manager_type and not manager_is_checkpoint_like:
        category = _canonical_model_library_category(manager_type)
        if category:
            return category

    # 2) Prefer directory category over checkpoint-like type/manager values.
    if directory:
        category = _canonical_model_library_category(directory)
        if category:
            return category
        category = _canonical_model_library_category(directory_top_level)
        if category:
            return category
        if directory_top_level and directory_top_level.lower() not in {"checkpoint", "checkpoints"}:
            return directory_top_level

    # 3) Fall back to manager/type if directory could not classify.
    if manager_type:
        category = _canonical_model_library_category(manager_type)
        if category:
            return category
    if model_type:
        category = _canonical_model_library_category(model_type)
        if category:
            return category

    if directory_top_level:
        return directory_top_level
    return None

def _split_csv_query(value: str | None) -> list[str]:
    if not isinstance(value, str):
        return []
    parts = [x.strip() for x in value.split(",")]
    return [x for x in parts if x]

def _guess_mime_type(filename: str) -> str:
    guessed, _ = mimetypes.guess_type(filename or "")
    return guessed or "application/octet-stream"

def _strip_category_prefix(path: str, category: str) -> str:
    normalized = _normalize_rel_path(path)
    if not normalized:
        return normalized
    category_norm = _normalize_rel_path(category)
    if not category_norm:
        return normalized
    normalized_lower = normalized.lower()
    category_lower = category_norm.lower()
    if normalized_lower == category_lower:
        return ""
    prefix = f"{category_lower}/"
    if normalized_lower.startswith(prefix):
        return normalized[len(category_norm) + 1 :]
    return normalized

def _resolve_model_relative_path(entry: dict, category: str, filename: str) -> str:
    filename_clean = str(filename or "").strip()
    if not filename_clean:
        return ""

    installed_paths = entry.get("installed_paths") or []
    candidate = ""
    if isinstance(installed_paths, list):
        for value in installed_paths:
            text = _normalize_rel_path(str(value or "").strip())
            if text:
                candidate = text
                break
    if not candidate:
        directory = _normalize_rel_path(str(entry.get("directory", "") or "").strip())
        if directory:
            candidate = f"{directory}/{filename_clean}"
        else:
            candidate = filename_clean

    candidate = _normalize_rel_path(candidate)
    if candidate:
        tail = candidate.split("/")[-1].lower()
        if tail != filename_clean.lower():
            candidate = f"{candidate.rstrip('/')}/{filename_clean}"
    else:
        candidate = filename_clean

    relative = _strip_category_prefix(candidate, category).strip("/")
    return relative or filename_clean

def _extract_base_models(entry: dict) -> list[str]:
    raw_values = [
        entry.get("base_models"),
        entry.get("base_model"),
        entry.get("compatible_base_models"),
    ]
    values = []
    for raw in raw_values:
        if isinstance(raw, str) and raw.strip():
            values.extend([x.strip() for x in raw.split(",") if x.strip()])
        elif isinstance(raw, list):
            values.extend([str(x).strip() for x in raw if str(x).strip()])
    deduped = []
    seen = set()
    for value in values:
        key = value.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(value)
    return deduped

def _extract_additional_tags(entry: dict) -> list[str]:
    raw = entry.get("additional_tags")
    if isinstance(raw, list):
        tags = [str(x).strip() for x in raw if str(x).strip()]
        deduped = []
        seen = set()
        for tag in tags:
            key = tag.lower()
            if key in seen:
                continue
            seen.add(key)
            deduped.append(tag)
        return deduped
    return []

def _normalize_asset_tags(raw_tags) -> list[str]:
    if not isinstance(raw_tags, list):
        return []
    tags = []
    seen = set()
    for value in raw_tags:
        tag = str(value or "").strip()
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        tags.append(tag)
    return tags

def _apply_model_library_asset_override(asset: dict, override: dict) -> dict:
    updated = dict(asset)
    name = override.get("name")
    if isinstance(name, str) and name.strip():
        updated["name"] = name.strip()

    tags = _normalize_asset_tags(override.get("tags"))
    if tags:
        updated["tags"] = tags

    if isinstance(override.get("user_metadata"), dict):
        merged_meta = dict(updated.get("user_metadata") or {})
        merged_meta.update(override.get("user_metadata") or {})
        updated["user_metadata"] = merged_meta

    updated_at = override.get("updated_at")
    if isinstance(updated_at, str) and updated_at:
        updated["updated_at"] = updated_at
        updated["last_access_time"] = updated_at
    return updated

def _invalidate_model_library_assets_cache():
    global model_library_assets_cache
    with model_library_assets_cache_lock:
        model_library_assets_cache = {"timestamp": 0.0, "assets": [], "id_map": {}}

def _build_model_library_asset_index() -> tuple[list[dict], dict[str, dict]]:
    global model_library_assets_cache

    now = time.time()
    with model_library_assets_cache_lock:
        cached_ts = float(model_library_assets_cache.get("timestamp", 0.0))
        if now - cached_ts <= MODEL_LIBRARY_ASSET_CACHE_TTL_SECONDS:
            return (
                model_library_assets_cache.get("assets", []),
                model_library_assets_cache.get("id_map", {}),
            )

    entries = _build_model_library_items(
        include_catalog=True,
        include_local_only=True,
        hf_only=True,
        visible_only=True,
    )
    with model_library_asset_overrides_lock:
        overrides = dict(model_library_asset_overrides)

    assets = []
    id_map = {}
    for entry in entries:
        category = _resolve_model_library_category(entry)
        if not category or str(category).lower() == PRIORITY_RECLASS_CATEGORY_UNKNOWN:
            continue

        filename = str(entry.get("filename", "") or "").strip()
        if not filename:
            continue

        model_rel_path = _resolve_model_relative_path(entry, category, filename)
        provider = str(entry.get("provider", "") or "").strip()
        source_url = str(entry.get("url", "") or "").strip() or None
        preview_url = str(entry.get("preview_url", "") or "").strip() or None
        installed_size = entry.get("installed_bytes_total")
        size_value = installed_size if isinstance(installed_size, int) and installed_size >= 0 else None

        local_files = entry.get("local_files") if isinstance(entry.get("local_files"), list) else []
        local_times = []
        for file_meta in local_files:
            if not isinstance(file_meta, dict):
                continue
            modified = file_meta.get("modified_at")
            if isinstance(modified, (int, float)):
                local_times.append(float(modified))
        latest_local_ts = max(local_times) if local_times else None

        created_at = _to_iso8601(entry.get("created_at")) or _to_iso8601(latest_local_ts)
        updated_at = _to_iso8601(entry.get("updated_at")) or _to_iso8601(latest_local_ts)

        user_metadata = {
            "filename": model_rel_path or filename,
        }
        display_name = str(entry.get("name", "") or "").strip()
        if display_name and display_name != filename:
            user_metadata["name"] = display_name
        if source_url:
            user_metadata["source_url"] = source_url
        if provider:
            user_metadata["provider"] = provider

        base_models = _extract_base_models(entry)
        if base_models:
            user_metadata["base_model"] = base_models
        additional_tags = _extract_additional_tags(entry)
        if additional_tags:
            user_metadata["additional_tags"] = additional_tags

        description = str(entry.get("description", "") or "").strip()
        if description:
            user_metadata["user_description"] = description

        installed = bool(entry.get("installed"))

        metadata = {
            "filename": model_rel_path or filename,
            "model_category": category,
            "source_kind": str(entry.get("source_kind", "") or ""),
            "installed": installed,
        }
        if source_url:
            metadata["repo_url"] = source_url
        if provider:
            metadata["provider"] = provider
        directory = _normalize_rel_path(str(entry.get("directory", "") or "").strip())
        if directory:
            metadata["directory"] = directory
            user_metadata["directory"] = directory

        seed = "|".join(
            [
                str(entry.get("source_kind", "") or ""),
                category,
                filename,
                directory,
                model_rel_path,
                source_url or "",
            ]
        )
        asset_id = str(uuid.uuid5(uuid.NAMESPACE_URL, seed))

        asset = {
            "id": asset_id,
            "name": filename,
            "asset_hash": None,
            "mime_type": _guess_mime_type(filename),
            "tags": ["models", category],
            "preview_url": preview_url or MODEL_LIBRARY_PREVIEW_URL,
            # Native Asset API treats non-immutable assets as "Imported".
            # Locally-installed files should be visible there.
            "is_immutable": not installed,
            "metadata": metadata,
            "user_metadata": user_metadata,
        }
        asset["user_metadata"]["installed"] = installed
        if size_value is not None:
            asset["size"] = size_value
        if created_at:
            asset["created_at"] = created_at
        if updated_at:
            asset["updated_at"] = updated_at
            asset["last_access_time"] = updated_at

        if asset_id in overrides and isinstance(overrides[asset_id], dict):
            asset = _apply_model_library_asset_override(asset, overrides[asset_id])

        assets.append(asset)
        id_map[asset_id] = {
            "asset": asset,
            "entry": entry,
            "category": category,
        }

    assets.sort(key=lambda item: str(item.get("name", "")).lower())

    with model_library_assets_cache_lock:
        model_library_assets_cache = {
            "timestamp": now,
            "assets": assets,
            "id_map": id_map,
        }
    return assets, id_map

def _find_model_library_asset_for_downloaded_file(path: str) -> dict | None:
    if not path:
        return None
    abs_path = os.path.abspath(path)
    models_root = os.path.abspath(_get_models_root())
    try:
        rel_path = _normalize_rel_path(os.path.relpath(abs_path, models_root))
    except Exception:
        rel_path = _normalize_rel_path(os.path.basename(abs_path))
    rel_lower = rel_path.lower()

    _, id_map = _build_model_library_asset_index()
    for row in id_map.values():
        asset = row.get("asset") if isinstance(row, dict) else None
        category = str(row.get("category", "") or "").strip() if isinstance(row, dict) else ""
        if not isinstance(asset, dict):
            continue
        filename_rel = _normalize_rel_path(str((asset.get("user_metadata") or {}).get("filename", "") or ""))
        combined = f"{category}/{filename_rel}".strip("/") if filename_rel else filename_rel
        combined_lower = combined.lower()
        if combined_lower and combined_lower == rel_lower:
            return asset
        if filename_rel and filename_rel.lower() == rel_lower:
            return asset
        if filename_rel and os.path.basename(filename_rel).lower() == os.path.basename(rel_lower):
            return asset
    return None

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
            download_mode = str(item.get("download_mode") or "").strip().lower()
            if download_mode == "folder":
                folder_info = _build_parsed_folder_download_info(item)
                def folder_status_cb(phase_text: str):
                    phase_value = str(phase_text or "").strip()
                    _set_download_status(download_id, {
                        "status": "downloading",
                        "phase": phase_value or "downloading",
                        "updated_at": time.time()
                    })
                msg, path = run_download_folder(
                    folder_info["parsed"],
                    item.get("folder", ""),
                    remote_subfolder_path=folder_info["remote_subfolder_path"],
                    last_segment=folder_info["last_segment"],
                    sync=True,
                    status_cb=folder_status_cb,
                    cancel_check=lambda: _is_cancel_requested(download_id),
                )
                if _is_cancel_requested(download_id):
                    _set_download_status(download_id, {
                        "status": "cancelled",
                        "message": "Cancelled",
                        "finished_at": time.time()
                    })
                    _clear_cancel_request(download_id)
                    _touch_queue_activity()
                    continue
                if not path:
                    raise RuntimeError(msg or "Folder download failed.")
                _set_download_status(download_id, {
                    "status": "completed",
                    "message": msg,
                    "path": path,
                    "finished_at": time.time()
                })
                _touch_queue_activity()
                continue

            overwrite = bool(item.get("overwrite"))
            item_url = str(item.get("url") or "").strip()
            is_hf_file_download = bool(item.get("hf_repo") and item.get("hf_path"))
            if not is_hf_file_download and item_url:
                is_hf_file_download = _is_supported_hf_link(item_url)

            if not is_hf_file_download:
                if not _is_direct_http_url(item_url):
                    raise RuntimeError("URL must be a valid http(s) link for direct file downloads.")

                _set_download_status(download_id, {
                    "status": "downloading",
                    "downloaded_bytes": 0,
                    "total_bytes": None,
                    "updated_at": time.time()
                })

                def direct_status_cb(phase: str):
                    if _is_cancel_requested(download_id):
                        return
                    phase_text = str(phase or "").strip()
                    phase_lower = phase_text.lower()
                    status_value = "downloading"
                    if phase_lower in ("finalizing", "cancelling", "cancelled", "failed"):
                        status_value = phase_lower
                    _set_download_status(download_id, {
                        "status": status_value,
                        "phase": phase_text or status_value,
                        "updated_at": time.time()
                    })

                def direct_progress_cb(payload: dict):
                    if _is_cancel_requested(download_id):
                        return
                    data = payload if isinstance(payload, dict) else {}
                    phase_text = str(data.get("phase") or "downloading").strip()
                    phase_lower = phase_text.lower()
                    status_value = "downloading" if phase_lower not in ("finalizing", "cancelling") else phase_lower
                    _set_download_status(download_id, {
                        "status": status_value,
                        "downloaded_bytes": data.get("downloaded_bytes", 0),
                        "total_bytes": data.get("total_bytes"),
                        "speed_bps": data.get("speed_bps"),
                        "eta_seconds": data.get("eta_seconds"),
                        "phase": phase_text,
                        "updated_at": time.time()
                    })

                msg, path = run_download_url(
                    item_url,
                    item["folder"],
                    sync=True,
                    overwrite=overwrite,
                    target_filename=item.get("target_filename"),
                    status_cb=direct_status_cb,
                    progress_cb=direct_progress_cb,
                    cancel_check=lambda: _is_cancel_requested(download_id),
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
                if not path:
                    raise RuntimeError(msg or "Direct URL download failed.")
                _set_download_status(download_id, {
                    "status": "completed",
                    "message": msg,
                    "path": path,
                    "finished_at": time.time()
                })
                _touch_queue_activity()
                continue

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
                        if _is_cancel_requested(download_id):
                            return
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

            def status_cb(phase: str):
                if _is_cancel_requested(download_id):
                    return
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
                    target_filename=item.get("filename"),
                    status_cb=status_cb,
                    cancel_check=lambda: _is_cancel_requested(download_id),
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
                msg, path = run_download(
                    parsed,
                    item["folder"],
                    sync=True,
                    overwrite=overwrite,
                    target_filename=item.get("filename"),
                    status_cb=status_cb,
                    cancel_check=lambda: _is_cancel_requested(download_id),
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


def _is_path_like(value: str) -> bool:
    return ("/" in value) or ("\\" in value)


def _resolve_model_search_paths(folder_hint: str) -> list[str]:
    folder_value = str(folder_hint or "checkpoints").strip() or "checkpoints"
    search_paths = []
    if folder_paths is not None:
        try:
            search_paths = folder_paths.get_folder_paths(folder_value) or []
        except KeyError:
            search_paths = []
        except Exception:
            search_paths = []

    if not search_paths:
        comfy_root = getattr(folder_paths, "base_path", os.getcwd()) if folder_paths else os.getcwd()
        if folder_value and (os.path.isabs(folder_value) or _is_path_like(folder_value)):
            fallback = folder_value if os.path.isabs(folder_value) else os.path.join(comfy_root, folder_value)
        else:
            fallback = os.path.join(comfy_root, "models", folder_value)
        search_paths = [fallback]

    normalized = []
    seen = set()
    for path in search_paths:
        abs_path = os.path.abspath(path)
        if abs_path in seen:
            continue
        seen.add(abs_path)
        normalized.append(abs_path)
    return normalized


def _is_within_directory(base_dir: str, candidate_path: str) -> bool:
    try:
        return os.path.commonpath([os.path.abspath(base_dir), os.path.abspath(candidate_path)]) == os.path.abspath(base_dir)
    except Exception:
        return False


def _invalidate_model_library_local_cache() -> None:
    global model_library_local_cache, model_explorer_local_cache
    with model_library_local_cache_lock:
        model_library_local_cache = {"timestamp": 0.0, "entries": [], "name_map": {}}
    with model_explorer_local_cache_lock:
        model_explorer_local_cache = {}


async def relocate_model_file(request):
    """Move an already-downloaded model into the requested path under the suggested model folder root."""
    try:
        data = await request.json()
    except Exception:
        data = {}

    found_path_raw = str(data.get("found_path") or "").strip()
    requested_path_raw = str(data.get("requested_path") or data.get("filename") or "").strip()
    suggested_folder = str(data.get("suggested_folder") or "checkpoints").strip() or "checkpoints"

    if not found_path_raw:
        return web.json_response({"error": "Missing found_path."}, status=400)

    source_path = os.path.abspath(found_path_raw)
    if not os.path.exists(source_path):
        return web.json_response({"error": f"Source not found: {source_path}"}, status=404)

    requested_path = _normalize_rel_path(requested_path_raw)
    if not requested_path:
        requested_path = _normalize_rel_path(os.path.basename(source_path))
    if not requested_path:
        return web.json_response({"error": "Could not determine destination filename/path."}, status=400)

    search_roots = _resolve_model_search_paths(suggested_folder)
    if not search_roots:
        return web.json_response({"error": "Could not resolve destination search paths."}, status=500)

    preferred_root = None
    for root in search_roots:
        if _is_within_directory(root, source_path):
            preferred_root = root
            break

    ordered_roots = [preferred_root, *search_roots] if preferred_root else search_roots
    dedup_roots = []
    seen_roots = set()
    for root in ordered_roots:
        if not root or root in seen_roots:
            continue
        seen_roots.add(root)
        dedup_roots.append(root)

    destination_path = None
    destination_root = None
    for root in dedup_roots:
        candidate = os.path.abspath(os.path.join(root, requested_path))
        if not _is_within_directory(root, candidate):
            continue
        destination_path = candidate
        destination_root = root
        break

    if not destination_path or not destination_root:
        return web.json_response({"error": "Could not resolve a safe destination path."}, status=400)

    if os.path.abspath(destination_path) == source_path:
        clean_path = _normalize_rel_path(os.path.relpath(source_path, destination_root))
        return web.json_response({
            "status": "already_in_place",
            "from": source_path,
            "to": source_path,
            "clean_path": clean_path,
        })

    if os.path.exists(destination_path):
        return web.json_response({
            "error": f"Destination already exists: {destination_path}",
            "status": "destination_exists",
        }, status=409)

    os.makedirs(os.path.dirname(destination_path), exist_ok=True)
    shutil.move(source_path, destination_path)
    _invalidate_model_library_local_cache()

    clean_path = _normalize_rel_path(os.path.relpath(destination_path, destination_root))
    return web.json_response({
        "status": "moved",
        "from": source_path,
        "to": destination_path,
        "clean_path": clean_path,
    })

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
                has_hf_repo_path = bool(model.get("hf_repo") and model.get("hf_path"))
                is_hf_url = _is_supported_hf_link(url) if url else False
                overwrite = bool(model.get("overwrite"))

                if has_hf_repo_path or is_hf_url:
                    parsed = _build_parsed_download_info(model)
                    msg, path = run_download(
                        parsed,
                        folder,
                        sync=True,
                        overwrite=overwrite,
                        target_filename=filename,
                    )
                else:
                    if not _is_direct_http_url(url):
                        raise ValueError("URL must be a valid http(s) link or Hugging Face file link.")
                    msg, path = run_download_url(
                        url,
                        folder,
                        sync=True,
                        overwrite=overwrite,
                        target_filename=filename,
                    )
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
    app.router.add_post("/relocate_model_file", relocate_model_file)
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
                url = model.get("url")
                download_mode = str(model.get("download_mode") or "").strip().lower()
                is_hf_file_download = False

                if download_mode == "folder":
                    folder = str(model.get("folder", "") or "").replace("\\", "/").strip().strip("/")
                    if not url:
                        rejected.append({
                            "filename": filename or "",
                            "error": "Missing URL",
                        })
                        continue
                    try:
                        folder_info = _build_parsed_folder_download_info(model)
                    except Exception as e:
                        rejected.append({
                            "filename": filename or "",
                            "error": str(e),
                        })
                        continue
                    if not filename:
                        filename = folder_info.get("display_name") or ""
                else:
                    download_mode = "file"
                    folder = model.get("folder", "checkpoints")
                    has_hf_repo_path = bool(model.get("hf_repo") and model.get("hf_path"))
                    is_hf_file_download = has_hf_repo_path or (url and _is_supported_hf_link(url))
                    if not url and not has_hf_repo_path:
                        rejected.append({
                            "filename": filename or "",
                            "error": "Missing URL",
                        })
                        continue
                    if url and not (_is_supported_hf_link(url) or _is_direct_http_url(url)):
                        rejected.append({
                            "filename": filename or "",
                            "error": "URL must be a valid http(s) link or Hugging Face file link.",
                        })
                        continue
                    filename = _derive_file_display_name(model) or "download"

                download_id = f"dl_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
                item = dict(model)
                requested_filename = _sanitize_filename_hint(model.get("target_filename"))
                if not requested_filename and download_mode == "file" and is_hf_file_download:
                    requested_filename = _sanitize_filename_hint(model.get("filename"))
                item["download_id"] = download_id
                item["filename"] = filename
                item["target_filename"] = requested_filename or None
                item["folder"] = folder
                item["download_mode"] = download_mode
                with download_queue_lock:
                    download_queue.append(item)
                _set_download_status(download_id, {
                    "status": "queued",
                    "filename": filename,
                    "folder": folder,
                    "download_mode": download_mode,
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

        if current_status == "cancelling":
            return web.json_response({"status": "cancelling", "download_id": download_id})

        if current_status in ("downloading", "copying", "cleaning_cache", "finalizing", "verifying", "downloaded"):
            _set_download_status(download_id, {
                "status": "cancelling",
                "phase": "cancelling",
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

    def _asset_api_error(status: int, code: str, message: str):
        return web.json_response({"code": code, "message": message}, status=status)

    async def hf_model_library_assets_list(request):
        if not _is_model_library_backend_enabled():
            return web.json_response(
                {
                    "error": "Model library backend is disabled in settings.",
                    "setting_id": MODEL_LIBRARY_BACKEND_SETTING,
                },
                status=403,
            )

        include_tags = [x.lower() for x in _split_csv_query(request.query.get("include_tags"))]
        exclude_tags = [x.lower() for x in _split_csv_query(request.query.get("exclude_tags"))]
        name_contains = str(request.query.get("name_contains", "") or "").strip().lower()
        # Native model library UI expects both marketplace and imported model assets.
        # Ownership filtering is handled in the frontend via is_immutable.
        limit = _safe_int(request.query.get("limit"), default=500, minimum=1, maximum=2000)
        offset = _safe_int(request.query.get("offset"), default=0, minimum=0, maximum=5_000_000)

        assets, _ = _build_model_library_asset_index()
        filtered = []
        for asset in assets:
            tags = [str(x or "").strip() for x in (asset.get("tags") or [])]
            tags_lower = {x.lower() for x in tags if x}
            if include_tags and any(tag not in tags_lower for tag in include_tags):
                continue
            if exclude_tags and any(tag in tags_lower for tag in exclude_tags):
                continue
            if name_contains and name_contains not in str(asset.get("name", "") or "").lower():
                display_name = str((asset.get("user_metadata") or {}).get("name", "") or "").lower()
                if name_contains not in display_name:
                    continue
            filtered.append(asset)

        total = len(filtered)
        page = filtered[offset : offset + limit]
        return web.json_response(
            {
                "assets": page,
                "total": total,
                "has_more": (offset + limit) < total,
            }
        )

    async def hf_model_library_asset_detail(request):
        if not _is_model_library_backend_enabled():
            return web.json_response({"error": "Model library backend disabled."}, status=403)
        asset_id = str(request.match_info.get("asset_id", "") or "").strip()
        _, id_map = _build_model_library_asset_index()
        row = id_map.get(asset_id)
        if not row:
            return web.json_response({"error": "Asset not found."}, status=404)
        return web.json_response(row.get("asset", {}))

    async def hf_model_library_asset_update(request):
        if not _is_model_library_backend_enabled():
            return web.json_response({"error": "Model library backend disabled."}, status=403)
        asset_id = str(request.match_info.get("asset_id", "") or "").strip()
        _, id_map = _build_model_library_asset_index()
        row = id_map.get(asset_id)
        if not row:
            return web.json_response({"error": "Asset not found."}, status=404)

        try:
            data = await request.json()
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}

        current_asset = row.get("asset") if isinstance(row, dict) else {}
        if not isinstance(current_asset, dict):
            current_asset = {}

        category = ""
        tags_now = _normalize_asset_tags(current_asset.get("tags"))
        if len(tags_now) >= 2:
            category = str(tags_now[1] or "").strip()

        override = {}
        with model_library_asset_overrides_lock:
            existing = model_library_asset_overrides.get(asset_id)
            if isinstance(existing, dict):
                override = dict(existing)

            incoming_name = data.get("name")
            if isinstance(incoming_name, str) and incoming_name.strip():
                override["name"] = incoming_name.strip()

            incoming_tags = _normalize_asset_tags(data.get("tags"))
            if incoming_tags:
                normalized = list(incoming_tags)
                lower_tags = {x.lower() for x in normalized}
                if "models" not in lower_tags:
                    normalized.insert(0, "models")
                    lower_tags.add("models")
                if category and category.lower() not in lower_tags:
                    normalized.append(category)
                override["tags"] = normalized

            incoming_user_metadata = data.get("user_metadata")
            if isinstance(incoming_user_metadata, dict):
                previous_meta = override.get("user_metadata")
                merged_meta = dict(previous_meta) if isinstance(previous_meta, dict) else {}
                merged_meta.update(incoming_user_metadata)
                override["user_metadata"] = merged_meta

            now_iso = datetime.now(tz=timezone.utc).isoformat()
            override["updated_at"] = now_iso
            model_library_asset_overrides[asset_id] = override

        _invalidate_model_library_assets_cache()
        _, id_map = _build_model_library_asset_index()
        updated = id_map.get(asset_id, {}).get("asset", {})
        return web.json_response(updated)

    async def hf_model_library_asset_add_tags(request):
        if not _is_model_library_backend_enabled():
            return web.json_response({"error": "Model library backend disabled."}, status=403)
        asset_id = str(request.match_info.get("asset_id", "") or "").strip()
        _, id_map = _build_model_library_asset_index()
        row = id_map.get(asset_id)
        if not row:
            return web.json_response({"error": "Asset not found."}, status=404)
        try:
            data = await request.json()
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}

        current_asset = row.get("asset") if isinstance(row, dict) else {}
        current_tags = _normalize_asset_tags((current_asset or {}).get("tags"))
        requested = _normalize_asset_tags(data.get("tags"))

        lower_existing = {x.lower() for x in current_tags}
        added = []
        already_present = []
        for tag in requested:
            if tag.lower() in lower_existing:
                already_present.append(tag)
                continue
            current_tags.append(tag)
            lower_existing.add(tag.lower())
            added.append(tag)

        with model_library_asset_overrides_lock:
            existing = model_library_asset_overrides.get(asset_id)
            override = dict(existing) if isinstance(existing, dict) else {}
            override["tags"] = current_tags
            override["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
            model_library_asset_overrides[asset_id] = override

        _invalidate_model_library_assets_cache()
        return web.json_response(
            {
                "total_tags": current_tags,
                "added": added,
                "already_present": already_present,
            }
        )

    async def hf_model_library_asset_remove_tags(request):
        if not _is_model_library_backend_enabled():
            return web.json_response({"error": "Model library backend disabled."}, status=403)
        asset_id = str(request.match_info.get("asset_id", "") or "").strip()
        _, id_map = _build_model_library_asset_index()
        row = id_map.get(asset_id)
        if not row:
            return web.json_response({"error": "Asset not found."}, status=404)
        try:
            data = await request.json()
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}

        current_asset = row.get("asset") if isinstance(row, dict) else {}
        current_tags = _normalize_asset_tags((current_asset or {}).get("tags"))
        requested = _normalize_asset_tags(data.get("tags"))

        protected = {"models"}
        if len(current_tags) >= 2:
            protected.add(current_tags[1].lower())

        removed = []
        not_present = []
        for tag in requested:
            tag_lower = tag.lower()
            if tag_lower in protected:
                not_present.append(tag)
                continue
            index = next((i for i, item in enumerate(current_tags) if item.lower() == tag_lower), -1)
            if index == -1:
                not_present.append(tag)
                continue
            removed.append(current_tags.pop(index))

        with model_library_asset_overrides_lock:
            existing = model_library_asset_overrides.get(asset_id)
            override = dict(existing) if isinstance(existing, dict) else {}
            override["tags"] = current_tags
            override["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
            model_library_asset_overrides[asset_id] = override

        _invalidate_model_library_assets_cache()
        return web.json_response(
            {
                "total_tags": current_tags,
                "removed": removed,
                "not_present": not_present,
            }
        )

    async def hf_model_library_remote_metadata(request):
        if not _is_model_library_backend_enabled():
            return _asset_api_error(403, "SERVICE_UNAVAILABLE", "Model library backend disabled.")

        source_url = str(request.query.get("url", "") or "").strip()
        if not source_url:
            return _asset_api_error(400, "INVALID_URL", "Missing URL.")
        if not _is_supported_hf_link(source_url):
            return _asset_api_error(400, "UNSUPPORTED_SOURCE", "Only Hugging Face URLs are supported.")

        try:
            parsed = parse_link(source_url)
        except Exception:
            return _asset_api_error(400, "INVALID_URL_FORMAT", "Invalid Hugging Face URL.")

        if not parsed.get("repo") or not parsed.get("file"):
            return _asset_api_error(
                400,
                "INVALID_URL_FORMAT",
                "URL must target a specific Hugging Face file (resolve/blob/file).",
            )

        remote_filename = parsed["file"]
        if parsed.get("subfolder"):
            remote_filename = f"{parsed['subfolder'].strip('/')}/{parsed['file']}"
        size, _, _ = get_remote_file_metadata(
            parsed["repo"],
            remote_filename,
            revision=parsed.get("revision"),
            token=get_token() or None,
        )

        filename = os.path.basename(remote_filename)
        return web.json_response(
            {
                "content_length": int(size) if isinstance(size, int) else 0,
                "final_url": source_url,
                "content_type": _guess_mime_type(filename),
                "filename": filename,
                "name": filename,
                "tags": ["models"],
                "validation": {
                    "is_valid": True,
                    "errors": [],
                    "warnings": [],
                },
            }
        )

    async def hf_model_library_download(request):
        if not _is_model_library_backend_enabled():
            return _asset_api_error(403, "SERVICE_UNAVAILABLE", "Model library backend disabled.")

        try:
            data = await request.json()
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}

        source_url = str(data.get("source_url", "") or data.get("url", "") or "").strip()
        if not source_url:
            return _asset_api_error(400, "INVALID_URL", "Missing source URL.")
        if not _is_supported_hf_link(source_url):
            return _asset_api_error(400, "UNSUPPORTED_SOURCE", "Only Hugging Face URLs are supported.")

        tags = _normalize_asset_tags(data.get("tags"))
        user_metadata = data.get("user_metadata") if isinstance(data.get("user_metadata"), dict) else {}

        requested_category = ""
        if len(tags) >= 2 and tags[0].lower() == "models":
            requested_category = tags[1]
        if not requested_category and isinstance(user_metadata.get("model_type"), str):
            requested_category = user_metadata.get("model_type", "")
        if not requested_category and isinstance(user_metadata.get("directory"), str):
            requested_category = user_metadata.get("directory", "")

        normalized_requested_category = _normalize_rel_path(requested_category).split("/", 1)[0]
        category = (
            _canonical_model_library_category(requested_category)
            or normalized_requested_category
            or "checkpoints"
        )
        model_payload = {
            "url": source_url,
            "folder": category,
        }

        try:
            parsed = _build_parsed_download_info(model_payload)
            _, path = run_download(parsed, category, sync=True, overwrite=False)
        except Exception as e:
            message = str(e) or "Download failed."
            if "Invalid credentials" in message or "401" in message:
                return _asset_api_error(422, "UNAUTHORIZED_SOURCE", message)
            if "404" in message:
                return _asset_api_error(422, "RESOURCE_NOT_FOUND", message)
            if "403" in message:
                return _asset_api_error(422, "ACCESS_FORBIDDEN", message)
            return _asset_api_error(500, "INTERNAL_ERROR", message)

        _invalidate_model_library_assets_cache()
        asset = _find_model_library_asset_for_downloaded_file(path)
        if not asset:
            filename = os.path.basename(path or "")
            now_iso = datetime.now(tz=timezone.utc).isoformat()
            rel_path = filename
            try:
                rel_path = _normalize_rel_path(os.path.relpath(path, _get_models_root()))
            except Exception:
                rel_path = filename
            rel_for_widget = _strip_category_prefix(rel_path, category).strip("/") or filename
            seed = f"download|{category}|{filename}|{rel_for_widget}"
            asset = {
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, seed)),
                "name": filename,
                "asset_hash": None,
                "mime_type": _guess_mime_type(filename),
                "tags": ["models", category],
                "preview_url": MODEL_LIBRARY_PREVIEW_URL,
                "is_immutable": False,
                "user_metadata": {
                    "filename": rel_for_widget,
                    "source_url": source_url,
                },
                "metadata": {
                    "filename": rel_for_widget,
                    "model_category": category,
                    "repo_url": source_url,
                    "source_kind": "download",
                },
                "created_at": now_iso,
                "updated_at": now_iso,
                "last_access_time": now_iso,
            }
            try:
                if path and os.path.exists(path):
                    asset["size"] = int(os.path.getsize(path))
            except Exception:
                pass

        return web.json_response(asset, status=200)
    
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

    async def model_explorer_download_proxy(request):
        # Reuse the existing queue-based downloader contract.
        return await queue_download(request)
        
    app.router.add_post("/restart", restart)
    app.router.add_post("/queue_download", queue_download)
    app.router.add_post("/api/model_explorer/download", model_explorer_download_proxy)
    app.router.add_post("/cancel_download", cancel_download)
    app.router.add_get("/download_status", download_status_endpoint)
    app.router.add_get("/search_status", search_status_endpoint)
    app.router.add_get("/model_library", model_library_endpoint)
    app.router.add_get(MODEL_LIBRARY_ASSET_ROUTE_BASE, hf_model_library_assets_list)
    app.router.add_get(f"{MODEL_LIBRARY_ASSET_ROUTE_BASE}/remote-metadata", hf_model_library_remote_metadata)
    app.router.add_post(f"{MODEL_LIBRARY_ASSET_ROUTE_BASE}/download", hf_model_library_download)
    app.router.add_get(f"{MODEL_LIBRARY_ASSET_ROUTE_BASE}/{{asset_id}}", hf_model_library_asset_detail)
    app.router.add_put(f"{MODEL_LIBRARY_ASSET_ROUTE_BASE}/{{asset_id}}", hf_model_library_asset_update)
    app.router.add_post(f"{MODEL_LIBRARY_ASSET_ROUTE_BASE}/{{asset_id}}/tags", hf_model_library_asset_add_tags)
    app.router.add_delete(f"{MODEL_LIBRARY_ASSET_ROUTE_BASE}/{{asset_id}}/tags", hf_model_library_asset_remove_tags)

    # --- Model Explorer Routes ---
    app.router.add_get("/api/model_explorer/categories", model_explorer_list_categories)
    app.router.add_get("/api/model_explorer/filters", model_explorer_get_filters)
    app.router.add_get("/api/model_explorer/groups", model_explorer_list_groups)
    app.router.add_post("/api/model_explorer/use", model_explorer_use)
    app.router.add_post("/api/model_explorer/delete", model_explorer_delete)


def _model_explorer_normalize_text(value: str) -> str:
    return str(value or "").lower().replace("_", " ").replace("-", " ").replace(".", " ").strip()


def _model_explorer_precision(filename: str) -> str:
    lowered = str(filename or "").lower().replace("-", "_")
    if "fp8" in lowered:
        if "mixed" in lowered:
            return "fp8 mixed"
        if "scaled" in lowered:
            return "fp8 scaled"
        return "fp8"
    match = _model_explorer_filename_precision_pattern.search(lowered)
    if match:
        return str(match.group(1)).lower()
    return "unknown"


def _model_explorer_group_stem(entry: dict) -> str:
    provided = str(entry.get("explorer_group_stem") or "").strip().lower()
    if provided:
        return provided
    filename = str(entry.get("filename") or "").strip()
    stem = os.path.splitext(filename)[0].lower().replace("-", "_")
    stem = _model_explorer_precision_pattern.sub("_", stem)
    stem = re.sub(r"_+", "_", stem).strip("_")
    return stem or os.path.splitext(filename)[0].lower()


def _model_explorer_resolve_installed_info(entry: dict, local_name_map: dict[str, list[dict]]) -> dict:
    filename = str(entry.get("filename") or "").strip()
    category = str(entry.get("explorer_category") or "").strip()
    if not filename:
        return {"installed": False}

    candidates = list(local_name_map.get(filename.lower()) or [])
    if not candidates:
        return {"installed": False}

    for candidate in candidates:
        directory = _normalize_rel_path(candidate.get("directory", ""))
        root = directory.split("/", 1)[0] if directory else ""
        if category and root != category:
            continue
        rel_path = _normalize_rel_path(candidate.get("rel_path", ""))
        widget_path = _strip_category_prefix(rel_path, category).strip("/") or filename
        return {
            "installed": True,
            "absolute_path": candidate.get("absolute_path"),
            "rel_path": rel_path,
            "widget_path": widget_path,
            "directory": directory,
        }
    return {"installed": False}


def _model_explorer_collect_rows() -> list[dict]:
    rows = _load_model_explorer_catalog()
    return [dict(v) for v in rows.values() if isinstance(v, dict)]


def _model_explorer_find_row(filename: str, category: str = "") -> dict | None:
    rows = _load_model_explorer_catalog()
    row = rows.get(filename)
    if isinstance(row, dict):
        if category and str(row.get("explorer_category") or "") != category:
            return None
        return dict(row)
    return None


async def model_explorer_list_categories(request):
    try:
        rows = _model_explorer_collect_rows()
        counts = Counter()
        for row in rows:
            category = str(row.get("explorer_category") or "").strip()
            if category in MODEL_EXPLORER_ALLOWED_CATEGORIES:
                counts[category] += 1
        categories = [
            {"id": category, "count": int(count)}
            for category, count in sorted(counts.items(), key=lambda item: item[0])
        ]
        return web.json_response({"categories": categories})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def model_explorer_get_filters(request):
    try:
        category_filter = str(request.query.get("category") or "").strip()
        rows = _model_explorer_collect_rows()
        precisions = set()
        bases = set()

        for row in rows:
            category = str(row.get("explorer_category") or "").strip()
            if category_filter and category != category_filter:
                continue
            precisions.add(_model_explorer_precision(str(row.get("filename") or "")))
            if category in MODEL_EXPLORER_BASE_APPLICABLE_CATEGORIES:
                base_value = str(row.get("explorer_base") or "").strip() or "unknown"
                bases.add(base_value)

        precision_values = sorted([x for x in precisions if x and x != "unknown"])
        if "unknown" in precisions:
            precision_values.append("unknown")

        payload = {
            "precisions": precision_values,
            "bases": sorted(bases) if category_filter in MODEL_EXPLORER_BASE_APPLICABLE_CATEGORIES else [],
        }
        return web.json_response(payload)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def model_explorer_list_groups(request):
    try:
        category_filter = str(request.query.get("category") or "").strip()
        base_filter = str(request.query.get("base") or "").strip()
        precision_filter = str(request.query.get("precision") or "").strip().lower()
        search_query = _model_explorer_normalize_text(str(request.query.get("search") or ""))
        offset = _safe_int(request.query.get("offset"), default=0, minimum=0, maximum=5_000_000)
        limit = _safe_int(request.query.get("limit"), default=150, minimum=1, maximum=2000)
        installed_first = _coerce_bool(request.query.get("installed_first"), default=True)

        rows = _model_explorer_collect_rows()
        _, local_name_map = _scan_local_models_for_explorer(category_filter)

        grouped: dict[str, dict] = {}
        for row in rows:
            filename = str(row.get("filename") or "").strip()
            if not filename:
                continue

            category = str(row.get("explorer_category") or "").strip()
            if category_filter and category != category_filter:
                continue

            base_value = str(row.get("explorer_base") or "").strip() or (
                "unknown" if category in MODEL_EXPLORER_BASE_APPLICABLE_CATEGORIES else ""
            )
            if base_filter and category in MODEL_EXPLORER_BASE_APPLICABLE_CATEGORIES and base_value != base_filter:
                continue

            precision = _model_explorer_precision(filename)
            if precision_filter and precision_filter != "any" and precision != precision_filter:
                continue

            if search_query:
                searchable = " ".join([
                    _model_explorer_normalize_text(filename),
                    _model_explorer_normalize_text(base_value),
                    _model_explorer_normalize_text(category),
                    _model_explorer_normalize_text(str(row.get("provider") or "")),
                ])
                if search_query not in searchable:
                    continue

            installed_info = _model_explorer_resolve_installed_info(row, local_name_map)
            stem = _model_explorer_group_stem(row)
            group_key = f"{stem}|{category}|{base_value}"
            group_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"model-explorer|{group_key}"))

            if group_key not in grouped:
                grouped[group_key] = {
                    "group_id": group_id,
                    "group_name": stem,
                    "category": category,
                    "base": base_value if category in MODEL_EXPLORER_BASE_APPLICABLE_CATEGORIES else None,
                    "installed": False,
                    "variants": [],
                }

            variant = {
                "filename": filename,
                "url": row.get("url"),
                "precision": precision,
                "source": row.get("source"),
                "provider": row.get("provider"),
                "preview_url": row.get("preview_url"),
                "content_length": row.get("content_length"),
                "repo_id": row.get("repo_id"),
                "installed": bool(installed_info.get("installed")),
                "model_path": installed_info.get("widget_path"),
            }
            grouped[group_key]["variants"].append(variant)
            if variant["installed"]:
                grouped[group_key]["installed"] = True

        groups = list(grouped.values())
        for group in groups:
            group["variants"].sort(
                key=lambda item: (
                    0 if item.get("installed") else 1,
                    str(item.get("filename") or "").lower(),
                )
            )
            first_name = str(group["variants"][0].get("filename") or "").strip() if group["variants"] else ""
            if first_name:
                group["group_name"] = first_name

        groups.sort(
            key=lambda group: (
                0 if (installed_first and group.get("installed")) else 1,
                str(group.get("group_name") or "").lower(),
            )
        )

        total = len(groups)
        page = groups[offset : offset + limit]
        has_more = offset + len(page) < total

        return web.json_response({
            "groups": page,
            "offset": offset,
            "limit": limit,
            "total_groups": total,
            "has_more": has_more,
        })
    except Exception as e:
        traceback.print_exc()
        return web.json_response({"error": str(e)}, status=500)


async def model_explorer_use(request):
    try:
        data = await request.json()
    except Exception:
        data = {}

    filename = str(data.get("filename") or "").strip()
    category = str(data.get("category") or "").strip()
    if not filename:
        return web.json_response({"error": "Missing filename."}, status=400)

    row = _model_explorer_find_row(filename, category=category)
    if not row:
        return web.json_response({"error": "Model row not found in explorer catalog."}, status=404)

    _, local_name_map = _scan_local_models_for_explorer(category)
    installed_info = _model_explorer_resolve_installed_info(row, local_name_map)
    if not installed_info.get("installed"):
        return web.json_response({"error": "Model is not installed locally."}, status=400)

    return web.json_response({
        "status": "ok",
        "filename": filename,
        "category": row.get("explorer_category"),
        "model_path": installed_info.get("widget_path"),
        "node_hint": {
            "category": row.get("explorer_category"),
        },
    })


async def model_explorer_delete(request):
    try:
        data = await request.json()
    except Exception:
        data = {}

    filename = str(data.get("filename") or "").strip()
    category = str(data.get("category") or "").strip()
    requested_model_path = _normalize_rel_path(str(data.get("model_path") or "").strip())
    if not filename:
        return web.json_response({"error": "Missing filename."}, status=400)

    _, local_name_map = _scan_local_models_for_explorer(category)
    candidates = list(local_name_map.get(filename.lower()) or [])
    if not candidates:
        return web.json_response({"error": "Model file not found locally."}, status=404)

    chosen = None
    for candidate in candidates:
        directory = _normalize_rel_path(candidate.get("directory", ""))
        root = directory.split("/", 1)[0] if directory else ""
        if category and root != category:
            continue
        rel_path = _normalize_rel_path(candidate.get("rel_path", ""))
        widget_path = _strip_category_prefix(rel_path, category or root).strip("/") or filename
        if requested_model_path and requested_model_path != _normalize_rel_path(widget_path):
            continue
        chosen = (candidate, rel_path, widget_path)
        break

    if chosen is None:
        return web.json_response({"error": "No matching installed model path found."}, status=404)

    candidate, rel_path, widget_path = chosen
    absolute_path = os.path.abspath(str(candidate.get("absolute_path") or ""))
    if not absolute_path or not os.path.isfile(absolute_path):
        return web.json_response({"error": "Resolved model path is not a file."}, status=404)
    if not _is_within_directory(_get_models_root(), absolute_path):
        return web.json_response({"error": "Refusing to delete path outside models root."}, status=400)

    try:
        os.remove(absolute_path)
    except Exception as e:
        return web.json_response({"error": f"Delete failed: {e}"}, status=500)

    _invalidate_model_library_local_cache()
    return web.json_response({
        "status": "deleted",
        "filename": filename,
        "rel_path": rel_path,
        "model_path": widget_path,
    })
