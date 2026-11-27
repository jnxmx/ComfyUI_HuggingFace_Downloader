"""Zero-dependency Civitai REST API v1 client, URL parser, and model resolver."""

from __future__ import annotations

import datetime
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

CIVITAI_HOSTS = {
    "civitai.com",
    "www.civitai.com",
    "civitai.green",
    "www.civitai.green",
    "civitai.red",
    "www.civitai.red",
}

CIVITAI_API_BASE = "https://civitai.com/api/v1"
CIVITAI_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

MODEL_FILE_EXTENSIONS = {
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".gguf",
    ".onnx",
    ".sft",
    ".zip",
}

GENERIC_FILENAME_SKIP = {
    "model.safetensors",
    "model.bin",
    "model.ckpt",
    "model.pt",
    "pytorch_model.bin",
    "adapter_model.bin",
    "adapter_model.safetensors",
    "diffusion_pytorch_model.bin",
    "diffusion_pytorch_model.safetensors",
    "consolidated.safetensors",
    "weights.safetensors",
    "lora.safetensors",
    "v1.safetensors",
    "config.json",
    "tokenizer.json",
}

_API_CACHE_LOCK = threading.Lock()
_API_CACHE: dict[tuple, tuple[float, Any]] = {}
_API_CACHE_TTL_SECONDS = 300.0


class CivitaiError(RuntimeError):
    """Error raised when resolving or querying Civitai API."""

    def __init__(self, message: str, status_code: int = 400, error_code: str = "civitai_error"):
        super().__init__(message)
        self.status_code = int(status_code)
        self.error_code = error_code


def _extract_host(url: str | None) -> str:
    if not isinstance(url, str):
        return ""
    text = url.strip()
    if not text:
        return ""
    try:
        parsed = urllib.parse.urlparse(text)
    except Exception:
        return ""
    if (parsed.scheme or "").lower() not in ("http", "https"):
        return ""
    return (parsed.hostname or "").lower()


def is_civitai_url(url: str | None) -> bool:
    """Return True if url points to civitai.com, civitai.green, or civitai.red over http(s)."""
    return _extract_host(url) in CIVITAI_HOSTS


def strip_token_from_url(url: str | None) -> str:
    """Remove any token= query parameter from a Civitai URL before storing/returning."""
    text = str(url or "").strip()
    if not text:
        return ""
    try:
        parsed = urllib.parse.urlparse(text)
        if not parsed.query:
            return text
        pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        filtered = [(k, v) for k, v in pairs if k.lower() != "token"]
        new_query = urllib.parse.urlencode(filtered)
        return urllib.parse.urlunparse(parsed._replace(query=new_query))
    except Exception:
        return text


def parse_civitai_url(url: str | None) -> dict[str, Any] | None:
    """
    Parse Civitai catalog page, model-version, or direct download URLs.

    Supported forms:
      - https://civitai.com/models/{model_id}[/{slug}][?modelVersionId={version_id}]
      - https://civitai.com/model-versions/{version_id}
      - https://civitai.com/api/download/models/{version_id}[?...]
      - Same paths on civitai.green and civitai.red
    """
    if not is_civitai_url(url):
        return None
    try:
        parsed = urllib.parse.urlparse(str(url).strip())
    except Exception:
        return None

    host = (parsed.hostname or "civitai.com").lower()
    if host.startswith("www."):
        host = host[4:]
    path_parts = [p for p in (parsed.path or "").split("/") if p]
    query_params = urllib.parse.parse_qs(parsed.query or "")

    # /api/download/models/{version_id}
    if (
        len(path_parts) >= 4
        and path_parts[0].lower() == "api"
        and path_parts[1].lower() == "download"
        and path_parts[2].lower() == "models"
        and path_parts[3].isdigit()
    ):
        return {
            "kind": "download",
            "model_id": None,
            "version_id": path_parts[3],
            "host": host,
            "query": strip_token_from_url(str(url).strip()),
        }

    # /model-versions/{version_id}
    if len(path_parts) >= 2 and path_parts[0].lower() == "model-versions" and path_parts[1].isdigit():
        return {
            "kind": "version",
            "model_id": None,
            "version_id": path_parts[1],
            "host": host,
        }

    # /models/{model_id}[/{slug}][?modelVersionId=...]
    if len(path_parts) >= 2 and path_parts[0].lower() == "models" and path_parts[1].isdigit():
        version_id = None
        for key in ("modelVersionId", "modelversionid", "versionId"):
            vals = query_params.get(key)
            if vals and str(vals[0]).strip().isdigit():
                version_id = str(vals[0]).strip()
                break
        return {
            "kind": "model",
            "model_id": path_parts[1],
            "version_id": version_id,
            "host": host,
        }

    return None


def map_civitai_type_to_folder(
    model_type: str | None,
    base_model: str | None = None,
    filename: str | None = None,
) -> str:
    """Map a Civitai model type and metadata into a ComfyUI models subfolder."""
    t = str(model_type or "").strip().lower()
    if t in {"lora", "locon", "dora", "loha", "lokr"}:
        return "loras"
    if t in {"textualinversion", "embedding", "embeddings"}:
        return "embeddings"
    if t == "vae":
        return "vae"
    if t in {"controlnet", "poses"}:
        return "controlnet"
    if t == "upscaler":
        return "upscale_models"
    if t == "motionmodule":
        return "animatediff_models"
    if t == "checkpoint":
        combined = f"{base_model or ''} {filename or ''}".lower()
        is_legacy_full_ckpt = any(
            marker in combined
            for marker in ("sd 1.5", "sd1.5", "sdxl", "pony", "illustrious", "noobai", "sd 1.4")
        )
        is_diffusion_unet = any(
            marker in combined
            for marker in ("flux", "wan", "qwen", "hunyuan", "ltx", "chroma", ".gguf", "unet")
        )
        if is_diffusion_unet and not is_legacy_full_ckpt:
            return "diffusion_models"
        return "checkpoints"
    return "checkpoints"


def canonicalize_civitai_base_model(base_model: str | None) -> str:
    """Normalize Civitai baseModel names into Model Explorer taxonomy."""
    raw = str(base_model or "").strip()
    if not raw:
        return ""
    lowered = raw.lower()
    if lowered in {"flux.1 d", "flux.1 dev", "flux.1 [dev]", "flux1 d"}:
        return "FLUX.1 [dev]"
    if lowered in {"flux.1 s", "flux.1 schnell", "flux.1 [schnell]"}:
        return "FLUX.1 [schnell]"
    if "flux.1 kontext" in lowered or "flux kontext" in lowered:
        return "FLUX.1 Kontext [dev]"
    if lowered in {"flux.2 d", "flux.2 dev", "flux.2 [dev]"}:
        return "FLUX.2 [dev]"
    if lowered.startswith("sdxl"):
        return "SDXL"
    if lowered.startswith("sd 1.5") or lowered == "sd1.5":
        return "SD1.5"
    if "wan video 2.2" in lowered or "wan 2.2" in lowered or "wan2.2" in lowered:
        return "Wan2.2"
    if "wan video 2.1" in lowered or "wan 2.1" in lowered or "wan2.1" in lowered:
        return "WAN 2.1"
    if "wan video" in lowered:
        return "WAN"
    if lowered.startswith("qwen"):
        return "Qwen"
    return raw


def _is_early_access_active(version_data: dict[str, Any]) -> bool:
    availability = str(version_data.get("availability") or "").strip().lower()
    if availability == "earlyaccess":
        return True
    ea_ends = version_data.get("earlyAccessEndsAt")
    if isinstance(ea_ends, str) and ea_ends.strip():
        raw = ea_ends.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            dt = datetime.datetime.fromisoformat(raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            if dt > datetime.datetime.now(datetime.timezone.utc):
                return True
        except Exception:
            return True
    return False


def _select_primary_version_file(
    version_data: dict[str, Any],
    version_id: str | None = None,
) -> dict[str, Any] | None:
    files = version_data.get("files")
    if not isinstance(files, list) or not files:
        vid = str(version_id or version_data.get("id") or "").strip()
        dl_url = strip_token_from_url(version_data.get("downloadUrl") or "")
        if not dl_url and vid:
            dl_url = f"https://civitai.com/api/download/models/{vid}"
        if not dl_url:
            return None
        return {
            "filename": f"civitai_{vid or 'model'}.safetensors",
            "size_bytes": None,
            "sha256": None,
            "download_url": dl_url,
        }

    candidates: list[tuple[tuple[int, int, int, int], dict[str, Any]]] = []
    danger_found = False
    for f in files:
        if not isinstance(f, dict):
            continue
        name = os.path.basename(str(f.get("name") or "").replace("\\", "/").strip())
        if not name:
            continue
        ftype = str(f.get("type") or "").strip().lower()
        if ftype == "training data":
            continue

        virus_scan = str(f.get("virusScanResult") or "").strip().lower()
        pickle_scan = str(f.get("pickleScanResult") or "").strip().lower()
        if virus_scan == "danger" or pickle_scan == "danger":
            danger_found = True
            continue

        ext = os.path.splitext(name)[1].lower()
        meta = f.get("metadata") if isinstance(f.get("metadata"), dict) else {}
        fmt = str(meta.get("format") or "").strip().lower()
        is_primary = 1 if f.get("primary") else 0
        is_type_model = 1 if ftype in {"model", ""} else 0
        is_safetensor = 1 if (ext == ".safetensors" or fmt == "safetensor") else 0
        has_model_ext = 1 if (ext in MODEL_FILE_EXTENSIONS and ext != ".zip") else 0
        score = (is_primary, is_type_model, is_safetensor, has_model_ext)
        candidates.append((score, f))

    if not candidates:
        if danger_found:
            raise CivitaiError(
                "Civitai flagged this model file as unsafe (virus/pickle scan Danger).",
                status_code=400,
                error_code="civitai_unsafe_file",
            )
        return None

    candidates.sort(key=lambda pair: pair[0], reverse=True)
    chosen = candidates[0][1]

    vid = str(version_id or version_data.get("id") or "").strip()
    filename = os.path.basename(str(chosen.get("name") or "").replace("\\", "/").strip())
    size_bytes = None
    size_kb = chosen.get("sizeKB")
    if isinstance(size_kb, (int, float)) and size_kb > 0:
        size_bytes = int(float(size_kb) * 1024)

    hashes = chosen.get("hashes") if isinstance(chosen.get("hashes"), dict) else {}
    sha256 = None
    for k, v in hashes.items():
        if str(k).strip().upper() == "SHA256" and isinstance(v, str) and v.strip():
            sha256 = v.strip().lower()
            break

    dl_url = strip_token_from_url(chosen.get("downloadUrl") or version_data.get("downloadUrl") or "")
    if not dl_url and vid:
        dl_url = f"https://civitai.com/api/download/models/{vid}"

    return {
        "filename": filename,
        "size_bytes": size_bytes,
        "sha256": sha256,
        "download_url": dl_url,
    }


def _api_get_json(
    path_or_url: str,
    *,
    token: str | None = None,
    timeout: float = 8.0,
    use_cache: bool = True,
) -> Any:
    url = path_or_url if path_or_url.startswith("http") else f"{CIVITAI_API_BASE}{path_or_url}"
    cache_key = (url, bool(token))
    now = time.monotonic()

    if use_cache:
        with _API_CACHE_LOCK:
            cached = _API_CACHE.get(cache_key)
            if cached and (now - cached[0]) < _API_CACHE_TTL_SECONDS:
                return cached[1]

    headers = {
        "User-Agent": CIVITAI_USER_AGENT,
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token.strip()}"

    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
    except urllib.error.HTTPError as e:
        code = int(getattr(e, "code", 500) or 500)
        if code == 401:
            raise CivitaiError(
                "Civitai API rejected the request (401 Unauthorized). Check your Civitai API Key in Settings or CIVITAI_API_KEY.",
                status_code=401,
                error_code="civitai_auth",
            ) from e
        if code == 403:
            raise CivitaiError(
                "Civitai denied access to this resource (403 Forbidden). It may require a valid Civitai API Key or Early Access unlock.",
                status_code=403,
                error_code="civitai_early_access" if token else "civitai_auth",
            ) from e
        if code == 404:
            raise CivitaiError(
                "Model or version was not found on Civitai (404).",
                status_code=404,
                error_code="civitai_not_found",
            ) from e
        if code == 429:
            raise CivitaiError(
                "Civitai API rate limit reached (429). Please retry shortly.",
                status_code=429,
                error_code="civitai_rate_limit",
            ) from e
        raise CivitaiError(
            f"Civitai API request failed with HTTP {code}.",
            status_code=code,
            error_code="civitai_http_error",
        ) from e
    except CivitaiError:
        raise
    except Exception as e:
        raise CivitaiError(f"Civitai API request failed: {e}", status_code=502, error_code="civitai_network") from e

    if use_cache:
        with _API_CACHE_LOCK:
            if len(_API_CACHE) > 512:
                _API_CACHE.clear()
            _API_CACHE[cache_key] = (time.monotonic(), data)

    return data


def _build_target_from_version(
    version_data: dict[str, Any],
    model_data: dict[str, Any] | None = None,
    include_versions: bool = False,
) -> dict[str, Any]:
    vid = str(version_data.get("id") or "").strip()
    model_meta = model_data if isinstance(model_data, dict) else (version_data.get("model") if isinstance(version_data.get("model"), dict) else {})
    mid = str(
        (model_data or {}).get("id")
        or version_data.get("modelId")
        or ""
    ).strip()
    model_name = str(model_meta.get("name") or "").strip()
    model_type = str(model_meta.get("type") or "").strip()
    version_name = str(version_data.get("name") or (f"Version {vid}" if vid else "")).strip()
    base_model_raw = str(version_data.get("baseModel") or "").strip()

    file_info = _select_primary_version_file(version_data, version_id=vid)
    if not file_info:
        raise CivitaiError(
            "No downloadable model file found for this Civitai version.",
            status_code=404,
            error_code="civitai_no_files",
        )

    folder = map_civitai_type_to_folder(model_type, base_model_raw, file_info["filename"])
    source_page_url = (
        f"https://civitai.com/models/{mid}?modelVersionId={vid}"
        if mid and vid
        else (f"https://civitai.com/model-versions/{vid}" if vid else "https://civitai.com")
    )

    versions_out: list[dict[str, Any]] = []
    if include_versions and isinstance(model_data, dict):
        raw_versions = model_data.get("modelVersions")
        if isinstance(raw_versions, list):
            for v in raw_versions[:25]:
                if not isinstance(v, dict):
                    continue
                v_id = str(v.get("id") or "").strip()
                if not v_id:
                    continue
                try:
                    v_file = _select_primary_version_file(v, version_id=v_id)
                except CivitaiError:
                    v_file = None
                if not v_file:
                    continue
                v_base_raw = str(v.get("baseModel") or "").strip()
                versions_out.append({
                    "id": v_id,
                    "name": str(v.get("name") or f"Version {v_id}").strip(),
                    "base_model": canonicalize_civitai_base_model(v_base_raw),
                    "filename": v_file["filename"],
                    "size_bytes": v_file["size_bytes"],
                    "sha256": v_file["sha256"],
                    "download_url": v_file["download_url"],
                    "folder": map_civitai_type_to_folder(model_type, v_base_raw, v_file["filename"]),
                    "early_access": _is_early_access_active(v),
                })

    return {
        "provider": "civitai.com",
        "model_id": mid,
        "version_id": vid,
        "model_name": model_name,
        "version_name": version_name,
        "filename": file_info["filename"],
        "download_url": file_info["download_url"],
        "source_page_url": source_page_url,
        "folder": folder,
        "model_type": model_type,
        "base_model": canonicalize_civitai_base_model(base_model_raw),
        "size_bytes": file_info["size_bytes"],
        "sha256": file_info["sha256"],
        "early_access": _is_early_access_active(version_data),
        "versions": versions_out,
    }


def resolve_civitai_target(
    url: str,
    token: str | None = None,
    preferred_version_id: str | None = None,
    include_versions: bool = False,
    timeout: float = 8.0,
) -> dict[str, Any]:
    """
    Resolve any Civitai URL (catalog page, version page, or download API URL)
    into concrete download metadata without leaking the API key into URLs.
    """
    parsed = parse_civitai_url(url)
    if not parsed:
        raise CivitaiError("Unrecognized Civitai URL format.", status_code=400, error_code="civitai_invalid_url")

    target_vid = str(preferred_version_id or parsed.get("version_id") or "").strip() or None
    model_id = str(parsed.get("model_id") or "").strip() or None

    model_data: dict[str, Any] | None = None
    version_data: dict[str, Any] | None = None

    if model_id:
        model_data = _api_get_json(f"/models/{model_id}", token=token, timeout=timeout)
        raw_versions = model_data.get("modelVersions") if isinstance(model_data, dict) else None
        if not isinstance(raw_versions, list) or not raw_versions:
            raise CivitaiError("Civitai model has no published versions.", status_code=404, error_code="civitai_no_versions")
        if target_vid:
            for v in raw_versions:
                if isinstance(v, dict) and str(v.get("id") or "").strip() == target_vid:
                    version_data = v
                    break
        if version_data is None:
            if target_vid:
                version_data = _api_get_json(f"/model-versions/{target_vid}", token=token, timeout=timeout)
            else:
                version_data = raw_versions[0]
    elif target_vid:
        version_data = _api_get_json(f"/model-versions/{target_vid}", token=token, timeout=timeout)
        parent_mid = str(version_data.get("modelId") or "").strip() if isinstance(version_data, dict) else ""
        if include_versions and parent_mid:
            try:
                model_data = _api_get_json(f"/models/{parent_mid}", token=token, timeout=timeout)
            except Exception:
                model_data = None

    if not isinstance(version_data, dict):
        raise CivitaiError("Could not resolve Civitai model version.", status_code=404, error_code="civitai_not_found")

    return _build_target_from_version(version_data, model_data=model_data, include_versions=include_versions)


def lookup_civitai_by_hash(
    file_hash: str,
    token: str | None = None,
    timeout: float = 6.0,
) -> dict[str, Any] | None:
    """Resolve a Civitai model version directly by SHA256 / AutoV2 / BLAKE3 hash."""
    clean_hash = str(file_hash or "").strip()
    if not clean_hash or len(clean_hash) < 8:
        return None
    try:
        version_data = _api_get_json(
            f"/model-versions/by-hash/{urllib.parse.quote(clean_hash)}",
            token=token,
            timeout=timeout,
        )
        if not isinstance(version_data, dict):
            return None
        return _build_target_from_version(version_data, model_data=None, include_versions=False)
    except Exception:
        return None


def _folder_to_civitai_types(folder_hint: str | None) -> list[str]:
    norm = str(folder_hint or "").strip().lower().replace("\\", "/")
    root = norm.split("/", 1)[0] if norm else ""
    mapping = {
        "loras": ["LORA", "LoCon", "DoRA"],
        "checkpoints": ["Checkpoint"],
        "diffusion_models": ["Checkpoint"],
        "controlnet": ["Controlnet"],
        "vae": ["VAE"],
        "upscale_models": ["Upscaler"],
        "embeddings": ["TextualInversion"],
        "animatediff_models": ["MotionModule"],
    }
    return mapping.get(root, [])


def _compact_filename_stem(filename: str) -> str:
    stem = os.path.splitext(os.path.basename(str(filename or "")))[0].lower()
    return re.sub(r"[^a-z0-9]+", "", stem)


def _clean_civitai_search_queries(filename: str) -> list[str]:
    base = os.path.basename(str(filename or "").strip())
    stem = os.path.splitext(base)[0]
    cleaned = re.sub(r"[_-]+", " ", stem).strip()
    stripped = re.sub(
        r"\b(?:fp8|fp16|fp32|bf16|e4m3fn|e5m2|mixed|scaled|safetensors|pruned|emaonly|noema)\b",
        " ",
        cleaned,
        flags=re.IGNORECASE,
    )
    stripped = re.sub(r"\s+", " ", stripped).strip()
    queries: list[str] = []
    for cand in (stripped, cleaned):
        if len(cand) >= 3 and cand.lower() not in {q.lower() for q in queries}:
            queries.append(cand)
    return queries[:2]


def search_civitai_by_filename(
    filename: str,
    folder_hint: str | None = None,
    token: str | None = None,
    timeout: float = 6.0,
) -> dict[str, Any] | None:
    """
    Search Civitai for an exact model file matching `filename`.
    Only returns a match when a version file strictly matches the target filename.
    """
    base_name = os.path.basename(str(filename or "").replace("\\", "/").strip())
    if not base_name:
        return None
    base_lower = base_name.lower()
    if base_lower in GENERIC_FILENAME_SKIP:
        return None

    queries = _clean_civitai_search_queries(base_name)
    if not queries:
        return None

    target_ext = os.path.splitext(base_lower)[1]
    target_compact = _compact_filename_stem(base_name)
    civitai_types = _folder_to_civitai_types(folder_hint)

    def _run_query(query_text: str, types_filter: list[str]) -> dict[str, Any] | None:
        params: list[tuple[str, str]] = [
            ("query", query_text),
            ("limit", "10"),
            ("nsfw", "true"),
        ]
        for t in types_filter:
            params.append(("types", t))
        qs = urllib.parse.urlencode(params)
        data = _api_get_json(f"/models?{qs}", token=token, timeout=timeout)
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return None

        compact_candidate: dict[str, Any] | None = None
        for model in items:
            if not isinstance(model, dict):
                continue
            versions = model.get("modelVersions")
            if not isinstance(versions, list):
                continue
            for version in versions:
                if not isinstance(version, dict):
                    continue
                files = version.get("files")
                if not isinstance(files, list):
                    continue
                for f in files:
                    if not isinstance(f, dict):
                        continue
                    fname = os.path.basename(str(f.get("name") or "").replace("\\", "/").strip())
                    if not fname:
                        continue
                    fname_lower = fname.lower()
                    if fname_lower == base_lower:
                        try:
                            return _build_target_from_version(version, model_data=model, include_versions=False)
                        except CivitaiError:
                            continue
                    if (
                        compact_candidate is None
                        and len(target_compact) >= 12
                        and os.path.splitext(fname_lower)[1] == target_ext
                        and _compact_filename_stem(fname) == target_compact
                    ):
                        try:
                            compact_candidate = _build_target_from_version(
                                version, model_data=model, include_versions=False
                            )
                        except CivitaiError:
                            pass
        return compact_candidate

    for q in queries:
        try:
            if civitai_types:
                hit = _run_query(q, civitai_types)
                if hit:
                    return hit
            hit = _run_query(q, [])
            if hit:
                return hit
        except Exception:
            continue
    return None


def search_civitai_variants(
    query: str,
    category: str | None = None,
    limit: int = 15,
    token: str | None = None,
    timeout: float = 8.0,
) -> list[dict[str, Any]]:
    """
    Search Civitai globally for Model Explorer unified online search.
    Returns normalized rows compatible with `search_huggingface_variants`.
    """
    clean_query = str(query or "").strip()
    if len(clean_query) < 2:
        return []

    params: list[tuple[str, str]] = [
        ("query", clean_query),
        ("limit", str(max(1, min(int(limit or 15), 20)))),
        ("sort", "Highest Rated"),
        ("nsfw", "true"),
    ]
    for t in _folder_to_civitai_types(category):
        params.append(("types", t))

    qs = urllib.parse.urlencode(params)
    data = _api_get_json(f"/models?{qs}", token=token, timeout=timeout)
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []

    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for model in items:
        if not isinstance(model, dict):
            continue
        versions = model.get("modelVersions")
        if not isinstance(versions, list) or not versions:
            continue
        latest = versions[0]
        if not isinstance(latest, dict):
            continue
        try:
            target = _build_target_from_version(latest, model_data=model, include_versions=False)
        except CivitaiError:
            continue

        dl_url = target.get("download_url") or ""
        if not dl_url or dl_url in seen_urls:
            continue
        seen_urls.add(dl_url)

        stats = model.get("stats") if isinstance(model.get("stats"), dict) else {}
        likes = int(stats.get("thumbsUpCount") or stats.get("favoriteCount") or 0)
        downloads = int(stats.get("downloadCount") or 0)

        results.append({
            "filename": target["filename"],
            "repo_id": f"civitai/{target['model_id']}" if target.get("model_id") else "civitai",
            "source_label": f"civitai.com · {target['model_name']}" if target.get("model_name") else "civitai.com",
            "source_page_url": target["source_page_url"],
            "provider": "civitai.com",
            "url": dl_url,
            "directory": target["folder"],
            "base": target.get("base_model") or "",
            "size_bytes": target.get("size_bytes"),
            "sha256": target.get("sha256"),
            "likes": likes,
            "downloads": downloads,
            "is_priority_author": False,
        })
        if len(results) >= limit:
            break

    return results
