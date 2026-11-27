import os
import re
import json
import time
import ast
import concurrent.futures
import urllib.request
import urllib.parse
import urllib.error
from typing import List, Dict, Any, Tuple
from types import SimpleNamespace
from huggingface_hub import HfApi
from .downloader import get_token, get_civitai_token, has_civitai_token
from .civitai_client import (
    is_civitai_url,
    parse_civitai_url,
    lookup_civitai_by_hash,
    search_civitai_by_filename,
)
from .parse_link import parse_link
from .file_manager import get_registered_model_buckets, is_valid_model_folder_type
import folder_paths

# Known extensions for model files
MODEL_EXTENSIONS = {'.safetensors', '.ckpt', '.pt', '.bin', '.pth', '.gguf'}

# Priority authors for HF search as requested
PRIORITY_AUTHORS = [
    "Kijai",
    "comfyanonymous",
    "Comfy-Org",
    "city96",
    "QuantStack",
    "alibaba-pai",
    "unsloth",
    "nunchaku-ai",
    "black-forest-labs",
    "Winnougan",
    "LBH-123-AI",
    "lodestones",
]

POPULAR_MODELS_FILE = os.path.join(os.path.dirname(__file__), "metadata", "popular-models.json")
_popular_models_cache = None
_popular_models_cache_civitai_enabled: bool | None = None
_manager_model_list_cache = None
_manager_model_list_cache_civitai_enabled: bool | None = None
_hf_search_cache: dict[str, dict | None] = {}
_hf_api_calls = 0
_hf_rate_limited_until = 0.0
_hf_search_deadline = 0.0
_hf_search_time_exhausted = False
_hf_repo_files_cache: dict[str, list[str] | None] = {}
_hf_url_exists_cache: dict[str, bool] = {}
_nunchaku_blackwell_cache: bool | None = None
_node_widget_schema_hints_cache: dict[str, list[dict[str, Any]]] | None = None
_runtime_node_widget_schema_cache: dict[str, list[dict[str, Any]]] = {}

HF_SEARCH_MAX_CALLS = int(os.getenv("HF_SEARCH_MAX_CALLS", "200"))
HF_SEARCH_RATE_LIMIT_SECONDS = int(os.getenv("HF_SEARCH_RATE_LIMIT_SECONDS", "300"))
HF_SEARCH_MAX_SECONDS = int(os.getenv("HF_SEARCH_MAX_SECONDS", "60"))
HF_SEARCH_CALL_TIMEOUT = int(os.getenv("HF_SEARCH_CALL_TIMEOUT", "20"))
PRIORITY_REPO_SCAN_LIMIT = int(os.getenv("HF_PRIORITY_REPO_SCAN_LIMIT", "100"))
HF_URL_CHECK_TIMEOUT = int(os.getenv("HF_URL_CHECK_TIMEOUT", "8"))

HF_SEARCH_SKIP_FILENAMES = {
    "pytorch_model.bin",
    "adapter_model.bin",
    "diffusion_pytorch_model.bin",
    "diffusion_pytorch_model.safetensors",
    "model.safetensors",
    "model.bin",
    "model.ckpt",
    "model.pt",
    "config.json",
    "tokenizer.json",
}

AMBIGUOUS_REGISTRY_FILENAMES = set(HF_SEARCH_SKIP_FILENAMES) | {
    "adapter_model.safetensors",
    "consolidated.safetensors",
    "weights.safetensors",
}

class HFSearchBudgetError(Exception):
    pass

import threading

_cancelled_searches = set()
_skipped_models = {}  # request_id -> set of lowercase filenames
_search_locks = threading.Lock()
_current_searching_models = {}  # request_id -> current filename

class SearchCancelledException(Exception):
    pass

def cancel_search(request_id: str):
    if not request_id:
        return
    with _search_locks:
        _cancelled_searches.add(request_id)

def skip_search_model(request_id: str, filename: str = None):
    if not request_id:
        return
    with _search_locks:
        if request_id not in _skipped_models:
            _skipped_models[request_id] = set()
        if filename:
            _skipped_models[request_id].add(filename.lower())
        else:
            curr = _current_searching_models.get(request_id)
            if curr:
                _skipped_models[request_id].add(curr.lower())

def is_search_cancelled(request_id: str) -> bool:
    if not request_id:
        return False
    with _search_locks:
        return request_id in _cancelled_searches

def is_model_skipped(request_id: str, filename: str) -> bool:
    if not request_id or not filename:
        return False
    with _search_locks:
        skipped = _skipped_models.get(request_id)
        return skipped and (filename.lower() in skipped)

def set_current_searching_model(request_id: str, filename: str):
    if not request_id:
        return
    with _search_locks:
        if filename:
            _current_searching_models[request_id] = filename
        else:
            _current_searching_models.pop(request_id, None)

def is_rate_limited_error(err: Exception) -> bool:
    text = str(err)
    return "429" in text or "Too Many Requests" in text or "rate limit" in text.lower()

def is_timeout_error(err: Exception) -> bool:
    text = str(err).lower()
    return "timeout" in text or "timed out" in text or "gateway" in text or "504" in text or "524" in text

def call_with_timeout(fn, *args, **kwargs):
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        fut = ex.submit(fn, *args, **kwargs)
        return fut.result(timeout=HF_SEARCH_CALL_TIMEOUT)

def _get_repo_files(api: HfApi, repo_id: str, token: str | None) -> list[str]:
    if repo_id in _hf_repo_files_cache:
        return _hf_repo_files_cache[repo_id] or []
    if not _hf_search_allowed():
        raise HFSearchBudgetError()
    try:
        files = call_with_timeout(api.list_repo_files, repo_id=repo_id, token=token)
    except Exception:
        _hf_repo_files_cache[repo_id] = []
        raise
    _hf_repo_files_cache[repo_id] = files or []
    return files or []

def extract_huggingface_info(url: str) -> tuple[str | None, str | None]:
    """Extract HuggingFace repo and file path from a resolve/blob URL."""
    if not url or "huggingface.co" not in url:
        return None, None

    # Pattern: https://huggingface.co/{repo}/resolve/{rev}/{path}
    pattern = r'huggingface\.co/([^/]+/[^/]+)/(?:resolve|blob)/[^/]+/(.+?)(?:\?|$)'
    match = re.search(pattern, url)
    if not match:
        return None, None
    return match.group(1), match.group(2)

def extract_hf_repo_and_path(url: str) -> tuple[str | None, str | None]:
    """Extract HF repo/path from a URL or shorthand, including non-resolve direct file paths."""
    hf_repo, hf_path = extract_huggingface_info(url)
    if hf_repo and hf_path:
        return hf_repo, hf_path

    try:
        parsed = parse_link(url)
    except Exception:
        return None, None

    repo = parsed.get("repo")
    filename = parsed.get("file")
    if not repo or not filename:
        return None, None

    subfolder = (parsed.get("subfolder") or "").strip("/")
    if subfolder:
        return repo, f"{subfolder}/{filename}"
    return repo, filename

def is_specific_model_file_url(url: str, expected_filename: str | None = None) -> bool:
    """True when URL/shorthand points to a specific model file path or Civitai model/version target."""
    if url and is_civitai_url(url) and parse_civitai_url(url) is not None:
        return True

    hf_repo, hf_path = extract_hf_repo_and_path(url)
    if not hf_repo or not hf_path:
        return False

    file_name = os.path.basename(hf_path.replace("\\", "/")).strip()
    if not file_name:
        return False
    if not any(file_name.lower().endswith(ext) for ext in MODEL_EXTENSIONS):
        return False

    if expected_filename:
        expected_base = os.path.basename(expected_filename.replace("\\", "/")).strip().lower()
        if expected_base and expected_base != file_name.lower():
            return False

    return True

def normalize_save_path(save_path: str | None) -> str | None:
    if not save_path:
        return None
    normalized = save_path.replace("\\", "/")
    if normalized.startswith("models/"):
        normalized = normalized.split("/", 1)[1]
    return normalized or None

def normalize_relative_model_path(value: str | None) -> str:
    normalized = str(value or "").replace("\\", "/").strip()
    if not normalized:
        return ""
    normalized = re.sub(r"/+", "/", normalized)
    normalized = re.sub(r"^(?:\./)+", "", normalized)
    if normalized == ".":
        return ""
    return normalized.strip("/")

def normalize_filename_key(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/")).strip()
    return base.lower()

def normalize_filename_compact(name: str) -> str:
    base = normalize_filename_key(name)
    return re.sub(r'[-_]+', '', base)

def _compact_lookup_text(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())

def _tokenize_lookup_context(value: str | None) -> set[str]:
    text = normalize_relative_model_path(value)
    if not text:
        return set()
    tokens: set[str] = set()
    for chunk in re.split(r"[^a-z0-9]+", text.lower()):
        compact = _compact_lookup_text(chunk)
        if len(compact) >= 4:
            tokens.add(compact)
    compact_text = _compact_lookup_text(text)
    if len(compact_text) >= 8:
        tokens.add(compact_text)
    return tokens

def _is_ambiguous_registry_filename(filename: str | None, requested_path: str | None = None) -> bool:
    base = normalize_filename_key(filename or requested_path or "")
    if not base:
        return True
    if base in AMBIGUOUS_REGISTRY_FILENAMES:
        return True
    requested_norm = normalize_relative_model_path(requested_path)
    return bool(requested_norm and "/" in requested_norm and base == "diffusion_pytorch_model.safetensors")

def split_model_identifier(value: str) -> Tuple[str, str | None]:
    normalized = value.replace("\\", "/").strip()
    if not normalized:
        return "", None
    return os.path.basename(normalized), normalized

def _is_nunchaku_svdq_name(value: str | None) -> bool:
    if not value:
        return False
    lowered = value.lower()
    return "svdq-" in lowered and ("int4" in lowered or "fp4" in lowered)

def _swap_nunchaku_precision(value: str, target_precision: str) -> str:
    if not value:
        return value
    if target_precision == "fp4":
        return re.sub(r'(?<![a-z0-9])int4(?![a-z0-9])', "fp4", value, flags=re.IGNORECASE)
    if target_precision == "int4":
        return re.sub(r'(?<![a-z0-9])fp4(?![a-z0-9])', "int4", value, flags=re.IGNORECASE)
    return value

def _is_nunchaku_extensionless_identifier(value: str | None) -> bool:
    if not value:
        return False
    base = os.path.basename(str(value).replace("\\", "/"))
    stem, ext = os.path.splitext(base)
    return _is_nunchaku_svdq_name(base) and not ext

def _looks_like_model_widget_value(value: str, node_type: str) -> bool:
    if any(value.endswith(ext) for ext in MODEL_EXTENSIONS):
        return True
    if "nunchaku" in (node_type or "").lower() and _is_nunchaku_svdq_name(value):
        return True
    return False

def invalidate_popular_models_cache() -> None:
    global _popular_models_cache, _popular_models_cache_civitai_enabled
    _popular_models_cache = None
    _popular_models_cache_civitai_enabled = None


def load_popular_models_registry() -> dict:
    """Load curated popular-models.json registry."""
    global _popular_models_cache, _popular_models_cache_civitai_enabled
    civitai_enabled = has_civitai_token()
    if _popular_models_cache is not None and _popular_models_cache_civitai_enabled == civitai_enabled:
        return _popular_models_cache

    if not os.path.exists(POPULAR_MODELS_FILE):
        _popular_models_cache = {}
        _popular_models_cache_civitai_enabled = civitai_enabled
        return _popular_models_cache

    try:
        with open(POPULAR_MODELS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        models = data.get("models", {})
    except Exception as e:
        print(f"[ERROR] Failed to load popular models registry: {e}")
        _popular_models_cache = {}
        _popular_models_cache_civitai_enabled = civitai_enabled
        return _popular_models_cache

    registry = {}
    for name, info in models.items():
        url = info.get("url", "")
        is_hf = "huggingface.co" in url
        is_civ = civitai_enabled and is_civitai_url(url)
        if not is_hf and not is_civ:
            continue
        entry = dict(info)
        entry["filename"] = name
        registry[name.lower()] = entry

    _popular_models_cache = registry
    _popular_models_cache_civitai_enabled = civitai_enabled
    return _popular_models_cache

def _iter_registry_urls(entry: dict) -> list[str]:
    urls: list[str] = []
    primary = entry.get("url")
    if isinstance(primary, str) and primary.strip():
        urls.append(primary.strip())

    for key in ("candidate_urls", "priority_urls", "urls"):
        value = entry.get(key)
        if not isinstance(value, list):
            continue
        for url in value:
            if isinstance(url, str) and url.strip():
                urls.append(url.strip())

    deduped: list[str] = []
    seen: set[str] = set()
    for url in urls:
        if url in seen:
            continue
        seen.add(url)
        deduped.append(url)
    return deduped

def _hf_url_exists(url: str) -> bool:
    if not url:
        return False
    if is_civitai_url(url):
        return has_civitai_token()
    if "huggingface.co" not in url:
        return False
    cached = _hf_url_exists_cache.get(url)
    if cached is not None:
        return cached

    headers = {
        "User-Agent": "ComfyUI-HuggingFace-Downloader/1.0",
        "Accept": "*/*",
    }

    def _request(method: str, extra_headers: dict | None = None) -> bool:
        req_headers = dict(headers)
        if extra_headers:
            req_headers.update(extra_headers)
        req = urllib.request.Request(url, method=method, headers=req_headers)
        with urllib.request.urlopen(req, timeout=HF_URL_CHECK_TIMEOUT) as resp:
            code = getattr(resp, "status", None) or resp.getcode()
            return 200 <= int(code) < 400

    ok = False
    try:
        ok = _request("HEAD")
    except urllib.error.HTTPError as e:
        # Some endpoints disallow HEAD. Try a tiny ranged GET before giving up.
        if e.code in (401, 403, 405):
            try:
                ok = _request("GET", {"Range": "bytes=0-0"})
            except Exception:
                ok = False
        else:
            ok = False
    except Exception:
        ok = False

    _hf_url_exists_cache[url] = ok
    return ok

def _preferred_nunchaku_precision() -> str:
    """
    Match ComfyUI-nunchaku logic:
    - Blackwell (SM 120) => fp4
    - otherwise => int4
    """
    global _nunchaku_blackwell_cache
    if _nunchaku_blackwell_cache is None:
        is_blackwell = False
        try:
            import torch  # Lazy import to avoid hard dependency during static tooling.
            if torch.cuda.is_available():
                capability = torch.cuda.get_device_capability(0)
                sm = f"{int(capability[0])}{int(capability[1])}"
                is_blackwell = (sm == "120" or int(capability[0]) >= 12)
        except Exception as e:
            print(f"[DEBUG] Could not detect GPU architecture for Nunchaku precision selection: {e}")
        _nunchaku_blackwell_cache = is_blackwell
    return "fp4" if _nunchaku_blackwell_cache else "int4"

def _lookup_popular_entry(
    popular_models: dict,
    filename: str,
    requested_path: str | None = None,
) -> dict | None:
    requested_key = normalize_relative_model_path(requested_path).lower()
    if requested_key:
        entry = popular_models.get(requested_key)
        if entry:
            return entry

    key = (filename or "").lower()
    if not key and not requested_key:
        return None
    entry = popular_models.get(key) or popular_models.get(os.path.basename(key))
    if entry:
        return entry

    base = os.path.basename(key)
    _stem, ext = os.path.splitext(base)
    if ext:
        return None

    candidates = []
    for k, v in popular_models.items():
        if k == base or k.startswith(base + "."):
            candidates.append((k, v))
    if not candidates:
        return None
    candidates.sort(key=lambda kv: len(kv[0]))
    return candidates[0][1]


def _is_exact_popular_entry_match(entry: dict | None, requested_path: str | None) -> bool:
    if not isinstance(entry, dict):
        return False
    requested_key = normalize_relative_model_path(requested_path).lower()
    if not requested_key:
        return False

    for candidate in (
        entry.get("hf_path"),
        entry.get("filename"),
        entry.get("requested_path"),
    ):
        normalized = normalize_relative_model_path(candidate).lower()
        if normalized and normalized == requested_key:
            return True
    return False

def load_comfyui_manager_model_list() -> dict:
    """Load ComfyUI Manager model-list.json from known locations."""
    global _manager_model_list_cache, _manager_model_list_cache_civitai_enabled
    civitai_enabled = has_civitai_token()
    if _manager_model_list_cache is not None and _manager_model_list_cache_civitai_enabled == civitai_enabled:
        return _manager_model_list_cache

    model_map = {}
    comfy_root = folder_paths.base_path if hasattr(folder_paths, "base_path") else os.getcwd()
    cache_dirs = [
        os.path.join(comfy_root, "user", "__manager", "cache"),
        os.path.join(comfy_root, "user", "default", "ComfyUI-Manager", "cache"),
        os.path.join(comfy_root, "custom_nodes", "ComfyUI-Manager", "cache"),
    ]
    candidate_files = [
        os.path.join(comfy_root, "custom_nodes", "ComfyUI-Manager", "model-list.json"),
        os.path.join(comfy_root, "user", "__manager", "model-list.json"),
        os.path.join(comfy_root, "user", "default", "ComfyUI-Manager", "model-list.json"),
    ]

    for cache_dir in cache_dirs:
        if not os.path.exists(cache_dir):
            continue
        for file in os.listdir(cache_dir):
            if file.endswith("model-list.json"):
                candidate_files.append(os.path.join(cache_dir, file))

    for path in candidate_files:
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for model in data.get("models", []):
                filename = model.get("filename")
                url = model.get("url", "")
                if not filename or not ("huggingface.co" in url or (civitai_enabled and is_civitai_url(url))):
                    continue
                filename_lower = filename.lower()
                if filename_lower in model_map:
                    continue
                entry = {
                    "filename": filename,
                    "url": url,
                    "name": model.get("name"),
                    "directory": normalize_save_path(model.get("save_path")),
                    "save_path": model.get("save_path"),
                }
                hf_repo, hf_path = extract_huggingface_info(url)
                if hf_repo:
                    entry["hf_repo"] = hf_repo
                    entry["hf_path"] = hf_path
                existing = model_map.get(filename_lower)
                if not existing:
                    model_map[filename_lower] = entry
                    continue
                alternatives = existing.setdefault("alternatives", [])
                candidate_key = (
                    str(entry.get("url") or "").strip().lower(),
                    str(entry.get("save_path") or "").strip().lower(),
                )
                existing_keys = {
                    (
                        str(candidate.get("url") or "").strip().lower(),
                        str(candidate.get("save_path") or "").strip().lower(),
                    )
                    for candidate in [existing, *alternatives]
                    if isinstance(candidate, dict)
                }
                if candidate_key not in existing_keys:
                    alternatives.append(entry)
        except Exception as e:
            print(f"[ERROR] Failed to load manager model list {path}: {e}")

    _manager_model_list_cache = model_map
    _manager_model_list_cache_civitai_enabled = civitai_enabled
    return _manager_model_list_cache

def _iter_manager_entries_for_filename(manager_map: dict, filename: str | None) -> list[dict]:
    key = normalize_filename_key(filename or "")
    if not key:
        return []
    entry = manager_map.get(key)
    if not isinstance(entry, dict):
        return []

    candidates: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for candidate in [entry, *(entry.get("alternatives") or [])]:
        if not isinstance(candidate, dict):
            continue
        dedupe_key = (
            str(candidate.get("url") or "").strip().lower(),
            str(candidate.get("save_path") or "").strip().lower(),
        )
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        candidates.append(candidate)
    return candidates

def _score_manager_entry_for_model(candidate: dict, model: dict) -> int:
    candidate_text = " ".join(
        str(candidate.get(field) or "")
        for field in ("name", "save_path", "directory", "url", "hf_repo", "hf_path")
    )
    candidate_compact = _compact_lookup_text(candidate_text)
    if not candidate_compact:
        return 0

    requested_path = normalize_relative_model_path(model.get("requested_path") or model.get("filename"))
    requested_dir = normalize_relative_model_path(os.path.dirname(requested_path))
    folder = normalize_save_path(
        model.get("locked_folder") or model.get("suggested_folder") or model.get("directory")
    ) or ""
    folder = normalize_relative_model_path(folder)
    folder_tail = normalize_relative_model_path(os.path.basename(folder))
    requested_tail = normalize_relative_model_path(os.path.basename(requested_dir))
    save_path = normalize_relative_model_path(candidate.get("save_path") or candidate.get("directory"))

    score = 0
    if folder and save_path:
        if save_path.lower() == folder.lower():
            score += 60
        elif save_path.lower().endswith("/" + folder.lower()) or folder.lower().endswith("/" + save_path.lower()):
            score += 40

    anchor_values = [requested_dir, requested_tail, folder, folder_tail]
    anchor_tokens = [
        token
        for value in anchor_values
        for token in _tokenize_lookup_context(value)
        if len(token) >= 8
    ]

    anchor_matched = False
    for token in anchor_tokens:
        if token and token in candidate_compact:
            score += 35 if token == _compact_lookup_text(requested_dir or folder) else 22
            anchor_matched = True

    for token in _tokenize_lookup_context(model.get("display_name")) | _tokenize_lookup_context(model.get("filename")):
        if len(token) < 6:
            continue
        if token in candidate_compact:
            score += 4

    if anchor_matched:
        score += 8

    if _is_ambiguous_registry_filename(model.get("filename"), model.get("requested_path")) and not anchor_matched and score < 40:
        return 0
    return score

def _lookup_manager_entry_for_model(manager_map: dict, model: dict) -> dict | None:
    candidates = _iter_manager_entries_for_filename(manager_map, model.get("filename"))
    if not candidates:
        return None
    if len(candidates) == 1 and not _is_ambiguous_registry_filename(model.get("filename"), model.get("requested_path")):
        return candidates[0]

    best = None
    best_score = 0
    for candidate in candidates:
        score = _score_manager_entry_for_model(candidate, model)
        if score > best_score:
            best = candidate
            best_score = score
    return best if best_score > 0 else None

def _dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = normalize_save_path(value) or value
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result

def _extract_folder_names_from_ast_expr(
    expr: ast.AST | None,
    folder_vars: dict[str, list[str]],
    module_consts: dict[str, str] | None = None,
    helper_folders: dict[str, list[str]] | None = None,
) -> list[str]:
    if expr is None:
        return []

    if isinstance(expr, ast.Call):
        fn = expr.func
        if (
            isinstance(fn, ast.Attribute)
            and fn.attr in {"get_filename_list", "get_folder_paths"}
            and isinstance(fn.value, ast.Name)
            and fn.value.id == "folder_paths"
            and expr.args
        ):
            arg0 = expr.args[0]
            if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
                return _dedupe_preserve_order([arg0.value])
            if isinstance(arg0, ast.Name) and module_consts and arg0.id in module_consts:
                return _dedupe_preserve_order([module_consts[arg0.id]])
        if isinstance(fn, ast.Name):
            if helper_folders and fn.id in helper_folders:
                return list(helper_folders[fn.id])
            if fn.id in {"list", "tuple", "set", "sorted"} and expr.args:
                return _extract_folder_names_from_ast_expr(
                    expr.args[0], folder_vars, module_consts, helper_folders
                )
        return []

    if isinstance(expr, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
        combined: list[str] = []
        for gen in expr.generators:
            combined.extend(
                _extract_folder_names_from_ast_expr(gen.iter, folder_vars, module_consts, helper_folders)
            )
        combined.extend(
            _extract_folder_names_from_ast_expr(expr.elt, folder_vars, module_consts, helper_folders)
        )
        return _dedupe_preserve_order(combined)

    if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
        left = _extract_folder_names_from_ast_expr(expr.left, folder_vars, module_consts, helper_folders)
        right = _extract_folder_names_from_ast_expr(expr.right, folder_vars, module_consts, helper_folders)
        return _dedupe_preserve_order(left + right)

    if isinstance(expr, ast.Name):
        return list(folder_vars.get(expr.id, []))

    if isinstance(expr, (ast.List, ast.Tuple, ast.Set)):
        combined: list[str] = []
        for item in expr.elts:
            combined.extend(
                _extract_folder_names_from_ast_expr(item, folder_vars, module_consts, helper_folders)
            )
        return _dedupe_preserve_order(combined)

    if isinstance(expr, ast.IfExp):
        body = _extract_folder_names_from_ast_expr(expr.body, folder_vars, module_consts, helper_folders)
        orelse = _extract_folder_names_from_ast_expr(expr.orelse, folder_vars, module_consts, helper_folders)
        return _dedupe_preserve_order(body + orelse)

    return []


def _resolve_ast_str_constant(expr: ast.AST | None, consts: dict[str, str] | None = None) -> str | None:
    if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        return expr.value
    if isinstance(expr, ast.Name) and consts and expr.id in consts:
        return consts[expr.id]
    return None


def _extract_module_constants_and_helpers_ast(
    tree: ast.Module,
) -> tuple[dict[str, str], dict[str, list[str]]]:
    module_consts: dict[str, str] = {}
    helper_folders: dict[str, list[str]] = {}

    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    module_consts[target.id] = stmt.value.value
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
            if isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
                module_consts[stmt.target.id] = stmt.value.value

    for stmt in tree.body:
        if not isinstance(stmt, ast.FunctionDef):
            continue
        local_vars: dict[str, list[str]] = {}
        local_consts = dict(module_consts)
        for sub in stmt.body:
            if isinstance(sub, ast.Assign):
                val_str = _resolve_ast_str_constant(sub.value, local_consts)
                folders = _extract_folder_names_from_ast_expr(sub.value, local_vars, local_consts, helper_folders)
                for target in sub.targets:
                    if isinstance(target, ast.Name):
                        if val_str is not None:
                            local_consts[target.id] = val_str
                        if folders:
                            local_vars[target.id] = folders
            elif isinstance(sub, ast.Return) and sub.value is not None:
                ret_folders = _extract_folder_names_from_ast_expr(
                    sub.value, local_vars, local_consts, helper_folders
                )
                if ret_folders:
                    helper_folders[stmt.name] = _dedupe_preserve_order(ret_folders)
                break

    return module_consts, helper_folders


_V3_WIDGET_INPUT_TYPES = {
    "Combo",
    "MultiCombo",
    "Int",
    "Float",
    "Boolean",
    "String",
    "Text",
    "Autogrow",
    "DynamicCombo",
}

_V3_SOCKET_INPUT_TYPES = {
    "Custom",
    "Model",
    "Conditioning",
    "Audio",
    "Vae",
    "Clip",
    "Image",
    "Latent",
    "Mask",
    "ControlNet",
    "ClipVision",
    "StyleModel",
    "Gligen",
    "UpscaleModel",
    "Sigmas",
    "Sampler",
    "Noise",
    "Guider",
    "Mesh",
    "Voxel",
    "Video",
    "Photomaker",
    "ModelType",
    "AnyType",
}


def _extract_method_folder_bindings_ast(
    cls_node: ast.ClassDef,
    module_consts: dict[str, str] | None = None,
) -> dict[str, list[str]]:
    bindings: dict[str, list[str]] = {}
    local_consts = dict(module_consts or {})
    for child in cls_node.body:
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if child.name in {"INPUT_TYPES", "define_schema"}:
            continue
        for sub in ast.walk(child):
            if not isinstance(sub, ast.Call):
                continue
            fn = sub.func
            if not (
                isinstance(fn, ast.Attribute)
                and fn.attr in {"get_full_path", "get_full_path_or_raise"}
                and isinstance(fn.value, ast.Name)
                and fn.value.id == "folder_paths"
            ):
                continue
            folder_expr = sub.args[0] if len(sub.args) >= 1 else None
            param_expr = sub.args[1] if len(sub.args) >= 2 else None
            for kw in sub.keywords:
                if kw.arg in {"folder_name", "folder_type", "type"} and folder_expr is None:
                    folder_expr = kw.value
                elif kw.arg in {"filename", "filename_name"} and param_expr is None:
                    param_expr = kw.value
            folder_str = _resolve_ast_str_constant(folder_expr, local_consts)
            if folder_str and isinstance(param_expr, ast.Name):
                norm_folder = normalize_save_path(folder_str) or folder_str
                existing = bindings.setdefault(param_expr.id, [])
                if norm_folder not in existing:
                    existing.append(norm_folder)
    return bindings


def _merge_method_folder_bindings(
    schema: list[dict[str, Any]],
    method_bindings: dict[str, list[str]],
) -> list[dict[str, Any]]:
    if not schema or not method_bindings:
        return schema
    for entry in schema:
        widget_name = entry.get("name")
        if not widget_name or widget_name not in method_bindings:
            continue
        if not entry.get("folders"):
            entry["folders"] = _dedupe_preserve_order(list(method_bindings[widget_name]))
        else:
            combined = list(entry["folders"]) + list(method_bindings[widget_name])
            entry["folders"] = _dedupe_preserve_order(combined)
    return schema


def _resolve_ast_dict_expr(expr: ast.AST | None, dict_vars: dict[str, ast.Dict]) -> ast.Dict | None:
    if isinstance(expr, ast.Dict):
        return expr
    if isinstance(expr, ast.Name):
        return dict_vars.get(expr.id)
    return None

def _extract_widget_schema_from_input_types_ast(
    fn: ast.FunctionDef,
    module_consts: dict[str, str] | None = None,
    helper_folders: dict[str, list[str]] | None = None,
) -> list[dict[str, Any]]:
    folder_vars: dict[str, list[str]] = {}
    dict_vars: dict[str, ast.Dict] = {}
    local_consts = dict(module_consts or {})
    return_expr: ast.AST | None = None

    for stmt in fn.body:
        if isinstance(stmt, ast.Assign):
            val_str = _resolve_ast_str_constant(stmt.value, local_consts)
            folders = _extract_folder_names_from_ast_expr(
                stmt.value, folder_vars, local_consts, helper_folders
            )
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    if val_str is not None:
                        local_consts[target.id] = val_str
                    if folders:
                        folder_vars[target.id] = folders
                    if isinstance(stmt.value, ast.Dict):
                        dict_vars[target.id] = stmt.value
                    elif isinstance(stmt.value, ast.Name):
                        if stmt.value.id in dict_vars:
                            dict_vars[target.id] = dict_vars[stmt.value.id]
        elif isinstance(stmt, ast.AnnAssign):
            target = stmt.target
            value = stmt.value
            if isinstance(target, ast.Name) and value is not None:
                val_str = _resolve_ast_str_constant(value, local_consts)
                if val_str is not None:
                    local_consts[target.id] = val_str
                folders = _extract_folder_names_from_ast_expr(
                    value, folder_vars, local_consts, helper_folders
                )
                if folders:
                    folder_vars[target.id] = folders
                if isinstance(value, ast.Dict):
                    dict_vars[target.id] = value
                elif isinstance(value, ast.Name):
                    if value.id in dict_vars:
                        dict_vars[target.id] = dict_vars[value.id]
        elif isinstance(stmt, ast.Return):
            return_expr = stmt.value
            break

    top_dict = _resolve_ast_dict_expr(return_expr, dict_vars)
    if top_dict is None:
        return []

    schema: list[dict[str, Any]] = []
    for key_node, section_expr in zip(top_dict.keys, top_dict.values):
        if not isinstance(key_node, ast.Constant) or not isinstance(key_node.value, str):
            continue
        if key_node.value not in {"required", "optional"}:
            continue

        section_dict = _resolve_ast_dict_expr(section_expr, dict_vars)
        if section_dict is None:
            continue

        for widget_key_node, widget_value_expr in zip(section_dict.keys, section_dict.values):
            if not isinstance(widget_key_node, ast.Constant) or not isinstance(widget_key_node.value, str):
                continue

            widget_name = widget_key_node.value
            first_expr = widget_value_expr
            if isinstance(widget_value_expr, ast.Tuple) and widget_value_expr.elts:
                first_expr = widget_value_expr.elts[0]

            folders = _extract_folder_names_from_ast_expr(
                first_expr, folder_vars, local_consts, helper_folders
            )
            schema.append({
                "name": widget_name,
                "folders": _dedupe_preserve_order(folders),
            })

    return schema


def _extract_v3_io_input_entry(
    expr: ast.AST | None,
    folder_vars: dict[str, list[str]],
    local_consts: dict[str, str],
    helper_folders: dict[str, list[str]] | None,
) -> dict[str, Any] | None:
    if not isinstance(expr, ast.Call):
        return None
    fn = expr.func
    if not isinstance(fn, ast.Attribute) or fn.attr != "Input":
        return None

    # Detect io.<Type>.Input(...) or <Type>.Input(...) vs io.Custom(...).Input(...)
    type_name: str | None = None
    owner = fn.value
    if isinstance(owner, ast.Attribute):
        type_name = owner.attr
    elif isinstance(owner, ast.Name):
        type_name = owner.id
    elif isinstance(owner, ast.Call):
        # e.g. io.Custom("DRAMA3_MODEL").Input(...) -> pure socket input
        return None

    if type_name in _V3_SOCKET_INPUT_TYPES:
        return None

    widget_name: str | None = None
    if expr.args:
        widget_name = _resolve_ast_str_constant(expr.args[0], local_consts)
    for kw in expr.keywords:
        if kw.arg == "id" and widget_name is None:
            widget_name = _resolve_ast_str_constant(kw.value, local_consts)
    if not widget_name:
        return None

    options_expr: ast.AST | None = None
    for kw in expr.keywords:
        if kw.arg == "options":
            options_expr = kw.value
            break
    if options_expr is None and type_name in {"Combo", "MultiCombo"} and len(expr.args) >= 2:
        options_expr = expr.args[1]

    folders = _extract_folder_names_from_ast_expr(
        options_expr, folder_vars, local_consts, helper_folders
    )

    if type_name not in _V3_WIDGET_INPUT_TYPES and not folders:
        return None

    return {
        "name": widget_name,
        "folders": _dedupe_preserve_order(folders),
    }


def _extract_widget_schema_from_define_schema_ast(
    fn: ast.FunctionDef,
    cls_node: ast.ClassDef,
    module_consts: dict[str, str] | None = None,
    helper_folders: dict[str, list[str]] | None = None,
) -> tuple[str | None, list[dict[str, Any]]]:
    """Extracts (node_id, ordered widget schema) from a ComfyUI V3 io.ComfyNode define_schema method."""
    folder_vars: dict[str, list[str]] = {}
    local_consts = dict(module_consts or {})
    list_vars: dict[str, ast.AST] = {}
    call_vars: dict[str, ast.Call] = {}
    return_expr: ast.AST | None = None

    for stmt in fn.body:
        if isinstance(stmt, ast.Assign):
            val_str = _resolve_ast_str_constant(stmt.value, local_consts)
            folders = _extract_folder_names_from_ast_expr(
                stmt.value, folder_vars, local_consts, helper_folders
            )
            for target in stmt.targets:
                if isinstance(target, ast.Name):
                    if val_str is not None:
                        local_consts[target.id] = val_str
                    if folders:
                        folder_vars[target.id] = folders
                    if isinstance(stmt.value, (ast.List, ast.Tuple)):
                        list_vars[target.id] = stmt.value
                    elif isinstance(stmt.value, ast.Call):
                        call_vars[target.id] = stmt.value
                    elif isinstance(stmt.value, ast.Name):
                        if stmt.value.id in list_vars:
                            list_vars[target.id] = list_vars[stmt.value.id]
                        if stmt.value.id in call_vars:
                            call_vars[target.id] = call_vars[stmt.value.id]
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
            val_str = _resolve_ast_str_constant(stmt.value, local_consts)
            if val_str is not None:
                local_consts[stmt.target.id] = val_str
            folders = _extract_folder_names_from_ast_expr(
                stmt.value, folder_vars, local_consts, helper_folders
            )
            if folders:
                folder_vars[stmt.target.id] = folders
            if isinstance(stmt.value, (ast.List, ast.Tuple)):
                list_vars[stmt.target.id] = stmt.value
            elif isinstance(stmt.value, ast.Call):
                call_vars[stmt.target.id] = stmt.value
        elif isinstance(stmt, ast.Return):
            return_expr = stmt.value
            break

    schema_call: ast.Call | None = None
    if isinstance(return_expr, ast.Call):
        schema_call = return_expr
    elif isinstance(return_expr, ast.Name):
        schema_call = call_vars.get(return_expr.id)

    if schema_call is None:
        return None, []

    fn_ref = schema_call.func
    schema_fn_name = fn_ref.attr if isinstance(fn_ref, ast.Attribute) else (fn_ref.id if isinstance(fn_ref, ast.Name) else "")
    if schema_fn_name != "Schema":
        return None, []

    node_id: str | None = cls_node.name
    inputs_expr: ast.AST | None = None
    for kw in schema_call.keywords:
        if kw.arg == "node_id":
            resolved = _resolve_ast_str_constant(kw.value, local_consts)
            if resolved:
                node_id = resolved
        elif kw.arg == "inputs":
            inputs_expr = kw.value

    if isinstance(inputs_expr, ast.Name):
        inputs_expr = list_vars.get(inputs_expr.id, inputs_expr)

    if not isinstance(inputs_expr, (ast.List, ast.Tuple)):
        return node_id, []

    schema: list[dict[str, Any]] = []
    for item_expr in inputs_expr.elts:
        entry = _extract_v3_io_input_entry(item_expr, folder_vars, local_consts, helper_folders)
        if entry is not None:
            schema.append(entry)

    return node_id, schema


def _scan_custom_node_widget_schemas() -> dict[str, list[dict[str, Any]]]:
    comfy_root = folder_paths.base_path if hasattr(folder_paths, "base_path") else os.getcwd()
    if not isinstance(comfy_root, str) or not comfy_root:
        comfy_root = os.getcwd()
    custom_nodes_dir = os.path.join(comfy_root, "custom_nodes")
    if not os.path.isdir(custom_nodes_dir):
        return {}

    hints: dict[str, list[dict[str, Any]]] = {}
    skip_dirs = {".git", "__pycache__", "venv", ".venv", "node_modules", "tests", "metadata"}
    files_processed = 0

    def _store_hint(key: str, schema: list[dict[str, Any]]) -> None:
        if not key or not schema:
            return
        existing = hints.get(key)
        if not existing:
            hints[key] = schema
            return
        existing_scored = sum(1 for item in existing if item.get("folders"))
        schema_scored = sum(1 for item in schema if item.get("folders"))
        if schema_scored > existing_scored:
            hints[key] = schema

    for root, dirs, files in os.walk(custom_nodes_dir, followlinks=True):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for filename in files:
            if not filename.endswith(".py"):
                continue

            files_processed += 1
            if files_processed % 25 == 0:
                time.sleep(0)

            path = os.path.join(root, filename)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    source = f.read()
                tree = ast.parse(source, filename=path)
            except Exception:
                continue

            module_consts, helper_folders = _extract_module_constants_and_helpers_ast(tree)

            for node in tree.body:
                if not isinstance(node, ast.ClassDef):
                    continue
                input_types_fn = None
                define_schema_fn = None
                for child in node.body:
                    if not isinstance(child, ast.FunctionDef):
                        continue
                    if child.name == "INPUT_TYPES" and input_types_fn is None:
                        input_types_fn = child
                    elif child.name == "define_schema" and define_schema_fn is None:
                        define_schema_fn = child

                method_bindings = _extract_method_folder_bindings_ast(node, module_consts)

                if input_types_fn is not None:
                    schema = _extract_widget_schema_from_input_types_ast(
                        input_types_fn, module_consts, helper_folders
                    )
                    schema = _merge_method_folder_bindings(schema, method_bindings)
                    _store_hint(node.name, schema)

                if define_schema_fn is not None:
                    v3_node_id, v3_schema = _extract_widget_schema_from_define_schema_ast(
                        define_schema_fn, node, module_consts, helper_folders
                    )
                    v3_schema = _merge_method_folder_bindings(v3_schema, method_bindings)
                    if v3_schema:
                        if v3_node_id:
                            _store_hint(v3_node_id, v3_schema)
                        if node.name and node.name != v3_node_id:
                            _store_hint(node.name, v3_schema)

    return hints


def _match_runtime_options_to_model_buckets(options: Any) -> list[str]:
    if not isinstance(options, (list, tuple, set)):
        return []
    opt_set = {str(v).strip() for v in options if isinstance(v, str) and str(v).strip()}
    if not opt_set:
        return []
    matched: list[str] = []
    for bucket in get_registered_model_buckets(folder_paths_mod=folder_paths):
        try:
            bucket_files = folder_paths.get_filename_list(bucket)
        except Exception:
            continue
        if not isinstance(bucket_files, (list, tuple, set)) or not bucket_files:
            continue
        bucket_set = {str(v).strip() for v in bucket_files if isinstance(v, str) and str(v).strip()}
        if not bucket_set:
            continue
        if opt_set.issubset(bucket_set) or bucket_set.issubset(opt_set):
            norm = normalize_save_path(bucket) or bucket
            if norm not in matched:
                matched.append(norm)
    return matched


def _inspect_runtime_node_widget_schema(node_type: str) -> list[dict[str, Any]]:
    if not node_type or node_type in _runtime_node_widget_schema_cache:
        return _runtime_node_widget_schema_cache.get(node_type, [])

    schema: list[dict[str, Any]] = []
    try:
        import inspect
        import nodes as comfy_nodes
        mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", None)
        cls = mappings.get(node_type) if isinstance(mappings, dict) else None
        if cls is not None:
            # 1. Prefer source AST introspection of the live class if source file is readable
            try:
                src = inspect.getsource(cls)
                cls_tree = ast.parse(src)
                if cls_tree.body and isinstance(cls_tree.body[0], ast.ClassDef):
                    cls_ast = cls_tree.body[0]
                    mod_consts: dict[str, str] = {}
                    method_bindings = _extract_method_folder_bindings_ast(cls_ast, mod_consts)
                    for child in cls_ast.body:
                        if not isinstance(child, ast.FunctionDef):
                            continue
                        if child.name == "define_schema":
                            _, v3_schema = _extract_widget_schema_from_define_schema_ast(
                                child, cls_ast, mod_consts, None
                            )
                            schema = _merge_method_folder_bindings(v3_schema, method_bindings)
                            break
                        if child.name == "INPUT_TYPES":
                            v1_schema = _extract_widget_schema_from_input_types_ast(child, mod_consts, None)
                            schema = _merge_method_folder_bindings(v1_schema, method_bindings)
                            break
            except Exception:
                pass

            # 2. If AST didn't yield folder hints, inspect live V3 define_schema() or V1 INPUT_TYPES()
            has_folder_hints = any(item.get("folders") for item in schema)
            if not has_folder_hints and callable(getattr(cls, "define_schema", None)):
                try:
                    live_schema = cls.define_schema()
                    live_inputs = getattr(live_schema, "inputs", None) or []
                    runtime_rows: list[dict[str, Any]] = []
                    for inp in live_inputs:
                        inp_type_name = type(inp).__name__
                        inp_id = str(getattr(inp, "id", "") or "").strip()
                        if not inp_id:
                            continue
                        if inp_type_name in _V3_SOCKET_INPUT_TYPES:
                            continue
                        options = getattr(inp, "options", None)
                        matched_buckets = _match_runtime_options_to_model_buckets(options)
                        if inp_type_name in _V3_WIDGET_INPUT_TYPES or hasattr(inp, "options") or matched_buckets:
                            runtime_rows.append({"name": inp_id, "folders": matched_buckets})
                    if runtime_rows:
                        schema = runtime_rows
                except Exception:
                    pass

            has_folder_hints = any(item.get("folders") for item in schema)
            if not has_folder_hints and callable(getattr(cls, "INPUT_TYPES", None)):
                try:
                    live_types = cls.INPUT_TYPES()
                    if isinstance(live_types, dict):
                        runtime_rows = []
                        for section in ("required", "optional"):
                            sec_dict = live_types.get(section)
                            if not isinstance(sec_dict, dict):
                                continue
                            for w_name, spec in sec_dict.items():
                                first = spec[0] if isinstance(spec, (tuple, list)) and spec else spec
                                matched_buckets = _match_runtime_options_to_model_buckets(first)
                                runtime_rows.append({"name": str(w_name), "folders": matched_buckets})
                        if runtime_rows:
                            schema = runtime_rows
                except Exception:
                    pass
    except Exception:
        schema = []

    _runtime_node_widget_schema_cache[node_type] = schema
    return schema


def _get_widget_schema_hints_for_node(node_type: str | None) -> list[dict[str, Any]]:
    if not node_type:
        return []
    hints = get_node_widget_schema_hints().get(node_type) or []
    if hints and any(item.get("folders") for item in hints):
        return hints
    runtime_hints = _inspect_runtime_node_widget_schema(node_type)
    if runtime_hints and any(item.get("folders") for item in runtime_hints):
        return runtime_hints
    return hints or runtime_hints

_BUILTIN_NODE_WIDGET_SCHEMA_HINTS: dict[str, list[dict[str, Any]]] = {
    "LTXAVTextEncoderLoader": [
        {"name": "text_encoder", "folders": ["text_encoders"]},
        {"name": "ckpt_name", "folders": ["checkpoints"]},
    ],
    "CheckpointLoader": [
        {"name": "config_name", "folders": ["configs"]},
        {"name": "ckpt_name", "folders": ["checkpoints"]},
    ],
}

_node_widget_schema_hints_lock = threading.Lock()
_widget_schema_prewarm_started = False


def get_node_widget_schema_hints() -> dict[str, list[dict[str, Any]]]:
    global _node_widget_schema_hints_cache
    if _node_widget_schema_hints_cache is not None:
        return _node_widget_schema_hints_cache
    with _node_widget_schema_hints_lock:
        if _node_widget_schema_hints_cache is None:
            try:
                scanned = _scan_custom_node_widget_schemas()
                for k, v in _BUILTIN_NODE_WIDGET_SCHEMA_HINTS.items():
                    scanned.setdefault(k, v)
                _node_widget_schema_hints_cache = scanned
                print(f"[DEBUG] Scanned widget schema hints for {len(_node_widget_schema_hints_cache)} node classes")
            except Exception as e:
                print(f"[DEBUG] Failed to scan custom node widget schemas: {e}")
                _node_widget_schema_hints_cache = dict(_BUILTIN_NODE_WIDGET_SCHEMA_HINTS)
    return _node_widget_schema_hints_cache


def start_background_widget_schema_prewarm() -> None:
    global _widget_schema_prewarm_started
    if _widget_schema_prewarm_started or _node_widget_schema_hints_cache is not None:
        return
    _widget_schema_prewarm_started = True

    def _worker():
        try:
            get_node_widget_schema_hints()
        except Exception:
            pass

    threading.Thread(target=_worker, name="hf-downloader-schema-prewarm", daemon=True).start()

def _lookup_known_directory_for_filename(filename: str | None) -> str | None:
    if not filename:
        return None
    base = os.path.basename(filename.replace("\\", "/")).strip()
    if not base:
        return None

    filename_hint = _guess_folder_from_filename(base)

    popular = load_popular_models_registry()
    entry = _lookup_popular_entry(popular, base)
    if entry and entry.get("directory"):
        known_dir = normalize_save_path(entry.get("directory")) or entry.get("directory")
        if (
            known_dir in {"checkpoints", "diffusion_models"}
            and filename_hint
            and _is_specific_model_bucket(filename_hint)
        ):
            return filename_hint
        return known_dir

    manager = load_comfyui_manager_model_list()
    manager_entry = manager.get(base.lower())
    if manager_entry and manager_entry.get("directory"):
        known_dir = normalize_save_path(manager_entry.get("directory")) or manager_entry.get("directory")
        if (
            known_dir in {"checkpoints", "diffusion_models"}
            and filename_hint
            and _is_specific_model_bucket(filename_hint)
        ):
            return filename_hint
        return known_dir
    return None

def _guess_folder_from_filename(filename: str | None) -> str | None:
    if not filename:
        return None
    name = os.path.basename(filename.replace("\\", "/")).lower()
    if not name:
        return None

    if "controlnet" in name:
        return "controlnet"
    if "lora" in name:
        return "loras"
    if (
        "clip_vision" in name
        or ("clip" in name and "vision" in name)
        or "clip-vit-" in name
        or "clip_vit_" in name
        or "clipvith" in re.sub(r"[^a-z0-9]+", "", name)
        or "clipvitg" in re.sub(r"[^a-z0-9]+", "", name)
    ):
        return "clip_vision"
    if "whisper" in name:
        return "audio_encoders"
    if (
        "asr" in re.split(r"[^a-z0-9]+", name)
        or "_asr_" in name
        or "-asr-" in name
        or "_asr." in name
    ):
        return "asr"
    if "codec" in name and "video" not in name:
        return "vae"
    if (
        "text_encoder" in name
        or "text-encoder" in name
        or "umt5" in name
        or "t5" in name
        or "qwen" in name
    ):
        return "text_encoders"
    if (
        "vae_approx" in name
        or "tinyvae" in name
        or "tiny_vae" in name
        or name.startswith("tae")
        or "taesd" in name
    ):
        return "vae_approx"
    if "vae" in name:
        return "vae"
    if "wav2vec" in name:
        return "wav2vec2"
    if "nlf" in name:
        return "nlf"
    if "audio" in name and "encoder" in name:
        return "audio_encoders"
    if "latent" in name and ("upscale" in name or "upscaler" in name):
        return "latent_upscale_models"
    if "h3_upscaler" in name or "h3-upscaler" in name:
        return "latent_upscale_models"
    if "minimax_h3" in name or "minimaxh3" in name:
        if "latent" in name or "upscale" in name or "upscaler" in name:
            return "latent_upscale_models"
        if "fun_controlnet" in name:
            return "model_patches"
    return None

def _is_specific_model_bucket(folder: str | None) -> bool:
    if not folder:
        return False
    key = normalize_save_path(folder) or folder
    return key in {
        "vae",
        "vae_approx",
        "text_encoders",
        "clip_vision",
        "loras",
        "controlnet",
        "style_models",
        "gligen",
        "audio_encoders",
        "asr",
        "wav2vec2",
        "nlf",
        "mmaudio",
        "latent_upscale_models",
        "upscale_models",
        "frame_interpolation",
        "background_removal",
        "model_patches",
        "optical_flow",
        "geometry_estimation",
        "detection",
        "hypernetworks",
        "photomaker",
        "embeddings",
    }

def _choose_best_folder_candidate(
    candidates: list[str],
    *,
    widget_name: str | None = None,
    filename: str | None = None
) -> str | None:
    normalized = _dedupe_preserve_order(candidates)
    if not normalized:
        return None
    if len(normalized) == 1:
        return normalized[0]

    widget_hint = resolve_proxy_widget_folder(widget_name) if widget_name else None
    if widget_hint and widget_hint in normalized:
        return widget_hint

    known_dir = _lookup_known_directory_for_filename(filename)
    if known_dir:
        known_norm = normalize_save_path(known_dir) or known_dir
        for candidate in normalized:
            cand_norm = normalize_save_path(candidate) or candidate
            if (
                known_norm == cand_norm
                or known_norm.startswith(cand_norm + "/")
                or cand_norm.startswith(known_norm + "/")
                or known_norm.replace("/", "_") == cand_norm.replace("/", "_")
            ):
                return candidate

    if filename and ("/" in filename or "\\" in filename):
        sub_prefix = filename.replace("\\", "/").split("/")[0].lower()
        for candidate in normalized:
            cand_lower = candidate.lower()
            if (
                cand_lower.endswith(sub_prefix)
                or cand_lower.endswith("_" + sub_prefix)
                or cand_lower.endswith("/" + sub_prefix)
            ):
                return candidate

    name_hint = _guess_folder_from_filename(filename)
    if name_hint and name_hint in normalized:
        return name_hint

    if "diffusion_models" in normalized and "unet_gguf" in normalized:
        return "diffusion_models"

    if "clip_vision" in normalized and "text_encoders" in normalized:
        value = (filename or "").lower()
        if "clip" in value or "vision" in value:
            return "clip_vision"
        return "text_encoders"

    if "vae" in normalized and "mmaudio" in normalized:
        value = (filename or "").lower()
        if "vocoder" in value or "mmaudio" in value:
            return "mmaudio"
        return "vae"

    return normalized[0]

def resolve_node_folder_for_widget_with_authority(
    node: dict,
    *,
    widget_index: int | None = None,
    widget_name: str | None = None,
    widget_value: str | None = None
) -> tuple[str | None, bool, str | None]:
    if widget_name:
        direct_widget_hint = resolve_proxy_widget_folder(widget_name)
        if direct_widget_hint:
            return direct_widget_hint, False, widget_name

    node_type = node.get("type", "")
    schema_hints = _get_widget_schema_hints_for_node(node_type)

    if schema_hints:
        hint_entry = None
        if widget_index is not None and 0 <= widget_index < len(schema_hints):
            hint_entry = schema_hints[widget_index]

        if hint_entry is not None:
            resolved_wname = widget_name or hint_entry.get("name")
            chosen = _choose_best_folder_candidate(
                hint_entry.get("folders") or [],
                widget_name=resolved_wname,
                filename=widget_value
            )
            if chosen:
                return chosen, True, resolved_wname
            widget_name = resolved_wname

        if widget_name:
            for entry in schema_hints:
                if entry.get("name") != widget_name:
                    continue
                chosen = _choose_best_folder_candidate(
                    entry.get("folders") or [],
                    widget_name=widget_name,
                    filename=widget_value
                )
                if chosen:
                    return chosen, True, widget_name

        all_candidates: list[str] = []
        for entry in schema_hints:
            all_candidates.extend(entry.get("folders") or [])
        chosen = _choose_best_folder_candidate(all_candidates, widget_name=widget_name, filename=widget_value)
        if chosen:
            return chosen, True, widget_name

    fallback = resolve_node_folder(node)
    if _is_strict_node_folder_mapping(node_type, fallback):
        return fallback, True, widget_name

    filename_hint = _guess_folder_from_filename(widget_value)
    known_dir = _lookup_known_directory_for_filename(widget_value)
    known_norm = normalize_save_path(known_dir) if known_dir else None

    if (
        known_norm in {"checkpoints", "diffusion_models"}
        and filename_hint
        and _is_specific_model_bucket(filename_hint)
    ):
        known_dir = filename_hint
        known_norm = filename_hint

    if known_dir:
        if not fallback or fallback == "checkpoints":
            return known_dir, False, widget_name
        if fallback == "diffusion_models" and _is_specific_model_bucket(known_dir):
            return known_dir, False, widget_name
    if filename_hint:
        if not fallback or fallback == "checkpoints":
            return filename_hint, False, widget_name
        if fallback == "diffusion_models" and _is_specific_model_bucket(filename_hint):
            return filename_hint, False, widget_name
    return fallback, False, widget_name


def resolve_node_folder_for_widget(
    node: dict,
    *,
    widget_index: int | None = None,
    widget_name: str | None = None,
    widget_value: str | None = None
) -> str | None:
    folder, _, _ = resolve_node_folder_for_widget_with_authority(
        node,
        widget_index=widget_index,
        widget_name=widget_name,
        widget_value=widget_value,
    )
    return folder

def apply_known_directory_hints(models: list[dict]) -> None:
    for model in models:
        locked_folder = normalize_save_path(model.get("locked_folder") or model.get("authoritative_folder")) or ""
        if model.get("folder_locked") or model.get("authoritative_folder"):
            if locked_folder and not model.get("suggested_folder"):
                model["suggested_folder"] = locked_folder.split("/", 1)[0]
            continue

        filename = model.get("filename")
        known_dir = _lookup_known_directory_for_filename(filename)
        if not known_dir:
            continue

        current = normalize_save_path(model.get("suggested_folder")) or ""
        if _is_strict_node_folder_mapping(model.get("node_type"), current):
            continue
        if not current:
            model["suggested_folder"] = known_dir
            continue
        if current == "checkpoints":
            model["suggested_folder"] = known_dir
            continue
        if current == "diffusion_models" and _is_specific_model_bucket(known_dir):
            model["suggested_folder"] = known_dir

def enrich_model_with_url(model: Dict[str, Any], url: str, source: str, directory: str | None = None):
    model["url"] = url
    model["source"] = source
    if directory and not model.get("suggested_folder"):
        model["suggested_folder"] = directory
    hf_repo, hf_path = extract_huggingface_info(url)
    if hf_repo:
        model["hf_repo"] = hf_repo
        model["hf_path"] = hf_path
    print(f"[DEBUG] Found URL for {model.get('filename')} via {source}: {url}")

def _missing_model_destination_key(model: dict) -> tuple[str, str]:
    filename = normalize_filename_key(model.get("filename") or "")
    requested_path = normalize_relative_model_path(model.get("requested_path") or filename)
    requested_dir = normalize_relative_model_path(os.path.dirname(requested_path))
    folder = normalize_save_path(
        model.get("locked_folder") or model.get("suggested_folder") or model.get("directory")
    ) or ""
    folder = normalize_relative_model_path(folder)
    if requested_dir and folder and not folder.lower().endswith(requested_dir.lower()):
        folder = normalize_relative_model_path(f"{folder}/{requested_dir}")
    elif requested_dir and not folder:
        folder = requested_dir
    return folder.lower(), filename

def _missing_model_merge_score(model: dict) -> tuple[int, int, int]:
    source = str(model.get("source") or "").strip().lower()
    node_type = str(model.get("node_type") or "").strip().lower()
    requested_path = normalize_relative_model_path(model.get("requested_path") or "")

    score = 0
    if model.get("url"):
        score += 30
    if model.get("hf_repo") and model.get("hf_path"):
        score += 10
    if "hugging face download model" in node_type:
        score += 16
    if source in {"workflow_metadata", "frontend_missing_model_store"}:
        score += 12
    if source in {"manager_model_list", "comfyui_manager_model_list", "popular_models"}:
        score += 4
    if model.get("folder_locked") or model.get("locked_folder"):
        score += 3

    return (
        score,
        len(requested_path),
        1 if _is_ambiguous_registry_filename(model.get("filename"), model.get("requested_path")) else 0,
    )

def coalesce_missing_models_by_destination(missing_models: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str], list[dict]] = {}
    passthrough: list[dict] = []
    for model in missing_models:
        if not isinstance(model, dict):
            continue
        key = _missing_model_destination_key(model)
        if not key[1]:
            passthrough.append(model)
            continue
        grouped.setdefault(key, []).append(model)

    merged_models: list[dict] = list(passthrough)
    for group in grouped.values():
        if len(group) == 1:
            merged_models.append(group[0])
            continue

        best = max(group, key=_missing_model_merge_score)
        merged = dict(best)

        if not merged.get("url"):
            for candidate in group:
                if candidate.get("url"):
                    merged["url"] = candidate.get("url")
                    merged["source"] = candidate.get("source") or merged.get("source")
                    if candidate.get("hf_repo"):
                        merged["hf_repo"] = candidate.get("hf_repo")
                    if candidate.get("hf_path"):
                        merged["hf_path"] = candidate.get("hf_path")
                    break

        if not merged.get("locked_folder"):
            for candidate in group:
                if candidate.get("locked_folder"):
                    merged["locked_folder"] = candidate.get("locked_folder")
                    merged["folder_locked"] = candidate.get("folder_locked", True)
                    break

        if not merged.get("suggested_folder"):
            for candidate in group:
                if candidate.get("suggested_folder"):
                    merged["suggested_folder"] = candidate.get("suggested_folder")
                    break

        longest_requested = max(
            group,
            key=lambda item: len(normalize_relative_model_path(item.get("requested_path") or "")),
        )
        if longest_requested.get("requested_path"):
            merged["requested_path"] = longest_requested.get("requested_path")
        if longest_requested.get("display_name"):
            merged["display_name"] = longest_requested.get("display_name")

        alternatives: list[dict] = []
        seen_alternatives: set[tuple[str, str]] = set()
        for candidate in group:
            for alt in candidate.get("alternatives") or []:
                if not isinstance(alt, dict):
                    continue
                alt_key = (
                    str(alt.get("url") or "").strip().lower(),
                    str(alt.get("filename") or "").strip().lower(),
                )
                if alt_key in seen_alternatives:
                    continue
                seen_alternatives.add(alt_key)
                alternatives.append(alt)
        if alternatives:
            merged["alternatives"] = alternatives

        merged_models.append(merged)

    return merged_models

def is_quant_variant_filename(filename: str) -> bool:
    name = os.path.splitext(filename.lower())[0]
    quant_patterns = [
        r'(^|[-_])fp8[-_]?e4m3fn($|[-_])',
        r'(^|[-_])fp(16|32|8|4)($|[-_])',
        r'(^|[-_])bf16($|[-_])',
        r'(^|[-_])nf4($|[-_])',
        r'(^|[-_])int(8|4)($|[-_])',
    ]
    return any(re.search(p, name) for p in quant_patterns)

def canonicalize_model_base(filename: str) -> str:
    base = os.path.splitext(filename.lower())[0]
    base = re.sub(r'[-_]?fp8[-_]?e4m3fn$', '', base)
    base = re.sub(r'[-_]?fp(16|32|8|4)$', '', base)
    base = re.sub(r'[-_]?bf16$', '', base)
    base = re.sub(r'[-_]?nf4$', '', base)
    base = re.sub(r'[-_]?int(8|4)$', '', base)
    return base

def find_quantized_alternatives(filename: str, registries: list[tuple[str, dict]]) -> list[Dict[str, Any]]:
    filename_lower = filename.lower()
    if filename_lower.endswith(".gguf") or "svdq" in filename_lower:
        return []

    base = canonicalize_model_base(filename)
    if not base:
        return []

    alternatives = []
    seen = set()

    for source, model_map in registries:
        for entry in model_map.values():
            entry_name = entry.get("filename")
            if not entry_name:
                continue
            entry_lower = entry_name.lower()
            if entry_lower in seen or entry_lower == filename_lower:
                continue
            if entry_lower.endswith(".gguf") or "svdq" in entry_lower:
                continue
            if canonicalize_model_base(entry_name) != base:
                continue
            if not is_quant_variant_filename(entry_name):
                continue

            alt = {
                "filename": entry_name,
                "url": entry.get("url"),
                "source": source,
                "suggested_folder": entry.get("directory"),
            }
            hf_repo, hf_path = extract_huggingface_info(entry.get("url", ""))
            if hf_repo:
                alt["hf_repo"] = hf_repo
                alt["hf_path"] = hf_path
            alternatives.append(alt)
            seen.add(entry_lower)

    return alternatives

def load_comfyui_manager_cache(missing_models: List[Dict[str, Any]], status_cb=None, request_id: str = None) -> List[Dict[str, Any]]:
    """
    Checks ComfyUI-Manager cache for missing model URLs and enriches the missing_models list.
    Locations to check:
    - ComfyUI/user/__manager/cache/*.json
    - ComfyUI/user/default/ComfyUI-Manager/cache/*.json
    - ComfyUI/custom_nodes/ComfyUI-Manager/cache/*.json
    """
    manager_map = load_comfyui_manager_model_list()

    # Enrich missing_models with URLs from cache/model-list
    for model in missing_models:
        if request_id and is_search_cancelled(request_id):
            raise SearchCancelledException("Search cancelled by user")
        if model.get("url"):
            continue
        filename = model["filename"]
        if request_id:
            if is_model_skipped(request_id, filename):
                continue
            set_current_searching_model(request_id, filename)
        if status_cb:
            status_cb({
                "message": "Checking manager cache",
                "source": "manager_cache",
                "filename": model.get("filename")
            })
        entry = _lookup_manager_entry_for_model(manager_map, model)
        if entry and entry.get("url"):
            enrich_model_with_url(
                model,
                entry["url"],
                "manager_model_list",
                directory=entry.get("directory")
            )
            print(f"[DEBUG] Found URL in Manager cache for {filename}: {entry['url']}")
        if request_id:
            set_current_searching_model(request_id, None)

    return missing_models

def get_all_local_models(comfy_root: str) -> Dict[str, str]:
    """
    Scans the 'models' directory and returns a dictionary:
    { "filename.ext": "relative/path/to/filename.ext" }
    """
    models_dir = os.path.join(comfy_root, "models")
    model_map = {}
    
    if not os.path.exists(models_dir):
        return model_map

    for root, _, files in os.walk(models_dir):
        for file in files:
            if any(file.endswith(ext) for ext in MODEL_EXTENSIONS):
                # storage relative path from comfy root
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, comfy_root)
                model_map[file] = rel_path
                
    return model_map

# Mapping of node types to default model subfolders
NODE_TYPE_MAPPING = {
    "UNETLoader": "diffusion_models",
    "UnetLoaderGGUF": "diffusion_models",
    "LoraLoader": "loras",
    "LoraLoaderModelOnly": "loras",
    "VAELoader": "vae",
    "CLIPLoader": "text_encoders",
    "ControlNetLoader": "controlnet",
    "DiffControlNetLoader": "controlnet",
    "CheckpointLoaderSimple": "checkpoints",
    "CheckpointLoader": "checkpoints",
    "DualCLIPLoader": "text_encoders",
    "CLIPVisionLoader": "clip_vision",
    "UpscaleModelLoader": "upscale_models",
    "LatentUpscaleModelLoader": "latent_upscale_models",
    "ESAModelLoader": "upscale_models",
    "StyleModelLoader": "style_models",
    "GligenLoader": "gligen",
    "DiffusersLoader": "diffusion_models",
    "GLIGENLoader": "gligen",
    "CLIPVisionLoader": "clip_vision",
    "StyleModelLoader": "style_models",
    "DiffControlNetLoader": "controlnet",
    
    # External Repos / Custom Nodes
    
    # ComfyUI-WanVideoWrapper
    "WanVideoModelLoader": "diffusion_models",
    "WanVideoVAELoader": "vae",
    "WanVideoTextEncodeCached": "text_encoders",
    "WanVideoTextEncode": "text_encoders",
    "WanVideoLoraSelect": "loras",
    "WanVideoLoraSelectByName": "loras",
    "WanVideoLoraSelectMulti": "loras",
    "WanVideoVACEModelSelect": "diffusion_models", # Fallback, could be unet_gguf
    "WanVideoExtraModelSelect": "diffusion_models",
    
    # GGUF
    "LoaderGGUF": "diffusion_models",
    "LoaderGGUFAdvanced": "diffusion_models",
    "UnetLoaderGGUF": "diffusion_models", # MultiGPU variant
    "ClipLoaderGGUF": "text_encoders",
    "DualClipLoaderGGUF": "text_encoders",
    "TripleClipLoaderGGUF": "text_encoders",
    "QuadrupleClipLoaderGGUF": "text_encoders",
    "VAELoaderGGUF": "vae",

    # KJNodes
    "VAELoaderKJ": "vae",
    "CLIPLoaderKJ": "text_encoders",
    "DualCLIPLoaderKJ": "text_encoders",
    "UnetLoaderKJ": "diffusion_models",
    "LoraLoaderKJ": "loras",
    
    # Nunchaku
    "NunchakuFluxDiTLoader": "diffusion_models",
    "NunchakuQwenImageDiTLoader": "diffusion_models",
    "NunchakuZImageDiTLoader": "diffusion_models",
    "NunchakuTextEncoderLoader": "text_encoders",
    "NunchakuTextEncoderLoaderV2": "text_encoders",
    "NunchakuFluxLoraLoader": "loras",
    "NunchakuFluxLoraStack": "loras",
    "NunchakuIPAdapterLoader": "ipadapter",
    "NunchakuPulidLoader": "pulid",
    "NunchakuPuLIDLoaderV2": "pulid",
    
    # IPAdapter
    "IPAdapterPlus": "ipadapter",
    "IPAdapterUnifiedLoader": "ipadapter",
    
    # AnimateDiff
    "ADE_AnimateDiffLoaderGen1": "animatediff_models",
    "ADE_AnimateDiffLoaderWithContext": "animatediff_models",
    
    # ComfyUI-MultiGPU
    "CheckpointLoaderNF4": "checkpoints",
    "LoadFluxControlNet": "xlabs_controlnets",
    "MMAudioModelLoader": "mmaudio",
    "PulidModelLoader": "pulid",
    "Florence2ModelLoader": "LLM",
    "DownloadAndLoadFlorence2Model": "LLM",

    # Native ComfyUI Background Removal
    "LoadBackgroundRemovalModel": "background_removal",
    "BackgroundRemovalModelLoader": "background_removal",
    "Load Background Removal Model": "background_removal",

    # Native ComfyUI Model Patches
    "ModelPatchLoader": "model_patches",

    # ComfyUI-HunyuanVideoWrapper
    "HunyuanVideoModelLoader": "diffusion_models",
    "HunyuanVideoVAELoader": "vae",
    "HyVideoModelLoader": "diffusion_models",
    "HyVideoVAELoader": "vae",

    # ComfyUI-LTXVideo
    "LTXVideoModelLoader": "checkpoints",
    "LTXVideoVAELoader": "vae",

    # Native ComfyUI Frame Interpolation
    "FrameInterpolationModelLoader": "frame_interpolation",
    "FrameInterpolationLoader": "frame_interpolation",
    "Load Frame Interpolation Model": "frame_interpolation",

    # Native ComfyUI LoRA Stack / Debug / Hook LoRA
    "LoadLoraModel": "loras",
    "LoadLoraTextEncoder": "loras",
    "Load LoRA (Model)": "loras",
    "Load LoRA (Text Encoder)": "loras",
    "Load LoRA (Model and CLIP)": "loras",
    "Load LoRA": "loras",
    "LoraLoaderBypass": "loras",
    "LoraLoaderBypassModelOnly": "loras",
    "CreateHookLora": "loras",
    "CreateHookLoraModelOnly": "loras",
    "TrainLoraNode": "loras",

    # Native ComfyUI Core Loaders
    "TripleCLIPLoader": "text_encoders",
    "QuadrupleCLIPLoader": "text_encoders",
    "Load CLIP (Triple)": "text_encoders",
    "Load CLIP (Quadruple)": "text_encoders",
    "ImageOnlyCheckpointLoader": "checkpoints",
    "unCLIPCheckpointLoader": "checkpoints",
    "CreateHookModelAsLora": "checkpoints",
    "CreateHookModelAsLoraModelOnly": "checkpoints",
    "LTXVAudioVAELoader": "checkpoints",
    "Load LTXV Audio VAE": "checkpoints",
    "Load Latent Upscale Model": "latent_upscale_models",
    "MiniMaxH3LatentUpscaleWithModel": "latent_upscale_models",
    "MiniMax H3 Latent Upscale With Model": "latent_upscale_models",
    "HunyuanVideoLatentUpscaleModelLoader": "latent_upscale_models",
    "Load HunyuanVideo Latent Upscale Model": "latent_upscale_models",
    "AudioEncoderLoader": "audio_encoders",
    "Load Audio Encoder": "audio_encoders",
    "OpticalFlowLoader": "optical_flow",
    "Load Optical Flow Model": "optical_flow",
    "LoadMoGeModel": "geometry_estimation",
    "Load MoGe Model": "geometry_estimation",
    "LoadDA3Model": "geometry_estimation",
    "Load Depth Anything 3": "geometry_estimation",
    "LoadMediaPipeFaceLandmarker": "detection",
    "Load Face Detection Model (MediaPipe)": "detection",
    "SAM3DBody_Loader": "detection",
    "Load SAM3D Body Model": "detection",
    "ConditioningLoader": "embeddings",
    "Load Conditioning": "embeddings",
    "HypernetworkLoader": "hypernetworks",
    "Load Hypernetwork": "hypernetworks",
    "PhotoMakerLoader": "photomaker",
    "Load PhotoMaker Model": "photomaker",

    # ComfyUI-Minimax_h3_latent_Upscaler
    "MinimaxH3LatentUpscalerNode2D": "latent_upscale_models",
    "MinimaxH3LatentUpscalerNode3D": "latent_upscale_models",
    "MinimaxH3LatentUpscaler2D": "latent_upscale_models",
    "MinimaxH3LatentUpscaler3D": "latent_upscale_models",
    "MinimaxH3LatentUpscalerNode": "latent_upscale_models",
    "MinimaxH3LatentUpscaler": "latent_upscale_models",
    "Minimax_h3_latent_Upscaler": "latent_upscale_models",
    "Minimax_h3_latent_Upscaler_2D": "latent_upscale_models",
    "Minimax_h3_latent_Upscaler_3D": "latent_upscale_models",
    "MMH3_Split_Upscale": "latent_upscale_models",

    # ComfyUI-KJNodes Model Preview Override
    "ModelPreviewOverrideKJ": "vae_approx",
    "ModelPreviewOverride": "vae_approx",
    "Model Preview Override": "vae_approx",
    "Model Preview Override KJ": "vae_approx",
    "LTX2SamplingPreviewOverride": "vae_approx",
    "LTX2 Sampling Preview Override": "vae_approx",
}



def resolve_wanvideo_wrapper_folder(node_type_lower: str) -> str | None:
    if not node_type_lower:
        return None
    if "lora" in node_type_lower:
        return "loras"
    if "vae" in node_type_lower:
        return "vae"
    if "clipvision" in node_type_lower or "clip_vision" in node_type_lower:
        return "clip_vision"
    if "textencode" in node_type_lower or "textencoder" in node_type_lower:
        return "text_encoders"
    if "controlnet" in node_type_lower:
        return "controlnet"
    if "modelloader" in node_type_lower:
        return "diffusion_models"
    return None


def _is_strict_node_folder_mapping(node_type: str | None, folder: str | None) -> bool:
    """
    Treat explicit node-type mapping as authoritative for auto-download folder selection.
    """
    if not node_type or not folder:
        return False
    mapped = NODE_TYPE_MAPPING.get(node_type)
    if not mapped:
        return False
    mapped_norm = normalize_save_path(mapped) or mapped
    folder_norm = normalize_save_path(folder) or folder
    return mapped_norm == folder_norm

def _get_strict_node_folder(node_type: str | None) -> str | None:
    if not node_type:
        return None
    mapped = NODE_TYPE_MAPPING.get(node_type)
    if not mapped:
        return None
    return normalize_save_path(mapped) or mapped

def _lock_model_to_node_folder(model: dict) -> None:
    strict_folder = _get_strict_node_folder(model.get("node_type"))
    if not strict_folder:
        auth_folder = normalize_save_path(model.get("authoritative_folder"))
        if auth_folder:
            strict_folder = auth_folder
    if not strict_folder:
        return

    current = normalize_save_path(model.get("suggested_folder")) or ""
    locked_folder = strict_folder
    strict_prefix = f"{strict_folder}/"
    if current.startswith(strict_prefix):
        locked_folder = current

    model["suggested_folder"] = locked_folder
    model["folder_locked"] = True
    model["authoritative_folder"] = strict_folder

def enforce_authoritative_node_folders(models: list[dict]) -> None:
    for model in models:
        if isinstance(model, dict):
            _lock_model_to_node_folder(model)


def _build_links_map(raw_links: list[Any]) -> dict:
    links_map = {}
    for link in raw_links:
        if isinstance(link, list) and len(link) >= 4:
            link_id = link[0]
            start_node_id = link[1]
            start_slot = link[2]
            links_map[link_id] = (start_node_id, start_slot)
        elif isinstance(link, dict):
            link_id = link.get("id")
            start_node_id = link.get("origin_id")
            start_slot = link.get("origin_slot")
            if link_id is not None and start_node_id is not None:
                links_map[link_id] = (start_node_id, start_slot)
    return links_map

def _collect_all_subgraph_defs(root_defs: list[Any]) -> list[dict]:
    result: list[dict] = []
    seen: set[str] = set()

    def collect(defs: list[Any]) -> None:
        if not isinstance(defs, list):
            return
        for subgraph_def in defs:
            if not isinstance(subgraph_def, dict):
                continue
            def_id = str(subgraph_def.get("id") or "").strip()
            if not def_id or def_id in seen:
                continue
            seen.add(def_id)
            result.append(subgraph_def)
            nested_defs = (subgraph_def.get("definitions") or {}).get("subgraphs", [])
            if isinstance(nested_defs, list) and nested_defs:
                collect(nested_defs)

    collect(root_defs)
    return result

def _build_subgraph_execution_paths(root_nodes: list[dict], all_subgraph_defs: list[dict]) -> dict[str, list[str]]:
    subgraph_def_map = {
        str(subgraph_def.get("id") or "").strip(): subgraph_def
        for subgraph_def in all_subgraph_defs
        if isinstance(subgraph_def, dict) and str(subgraph_def.get("id") or "").strip()
    }
    path_map: dict[str, list[str]] = {}
    visited: set[str] = set()

    def build(nodes: list[dict], parent_prefix: str) -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            node_type = str(node.get("type") or "").strip()
            if not node_type or node_type not in subgraph_def_map:
                continue

            node_id = node.get("id")
            if node_id is None:
                continue
            path = f"{parent_prefix}:{node_id}" if parent_prefix else str(node_id)
            path_map.setdefault(node_type, []).append(path)

            if node_type in visited:
                continue
            visited.add(node_type)
            inner_def = subgraph_def_map.get(node_type)
            if inner_def:
                build(inner_def.get("nodes", []), path)
            visited.remove(node_type)

    build(root_nodes, "")
    return path_map

def resolve_node_folder(node: dict) -> str | None:
    node_type = node.get("type", "")
    if node_type in NODE_TYPE_MAPPING:
        return NODE_TYPE_MAPPING[node_type]

    properties = node.get("properties") or {}
    cnr_id = (properties.get("cnr_id") or "").lower()
    node_type_lower = node_type.lower()

    if "wanvideowrapper" in cnr_id or node_type_lower.startswith("wanvideo"):
        wan_folder = resolve_wanvideo_wrapper_folder(node_type_lower)
        if wan_folder:
            return wan_folder

    if "gguf" in node_type_lower or "gguf" in cnr_id:
        if "clip" in node_type_lower:
            return "text_encoders"
        if "vae" in node_type_lower:
            return "vae"
        if "lora" in node_type_lower:
            return "loras"
        return "diffusion_models"

    if "kjnodes" in cnr_id:
        if "preview" in node_type_lower or "tiny_vae" in node_type_lower:
            return "vae_approx"
        if "clip" in node_type_lower:
            return "text_encoders"
        if "vae" in node_type_lower:
            return "vae"
        if "lora" in node_type_lower:
            return "loras"
        if "unet" in node_type_lower or "model" in node_type_lower:
            return "diffusion_models"

    if "modelpreviewoverride" in node_type_lower or "previewoverride" in node_type_lower:
        return "vae_approx"

    return None

def resolve_proxy_widget_folder(widget_name: str | None) -> str | None:
    if not widget_name:
        return None
    name = widget_name.lower()
    if "latent" in name and "upscale" in name:
        return "latent_upscale_models"
    if "upscale" in name:
        return "upscale_models"
    if "clip_vision" in name or "clip vision" in name:
        return "clip_vision"
    if "text_encoder" in name or "text encoder" in name or "textencode" in name:
        return "text_encoders"
    if "unet" in name:
        return "diffusion_models"
    if "clip" in name:
        return "text_encoders"
    if "tiny_vae" in name or "tinyvae" in name or "vae_approx" in name:
        return "vae_approx"
    if "vae" in name:
        return "vae"
    if "lora" in name:
        return "loras"
    if "checkpoint" in name or "ckpt" in name:
        return "checkpoints"
    if "bg_removal" in name or "background_removal" in name or "background removal" in name:
        return "background_removal"
    if "model_patch" in name or "model patch" in name:
        return "model_patches"
    if "rife" in name or "film" in name or "frame_interpolation" in name or "frame interpolation" in name:
        return "frame_interpolation"
    if ("minimax" in name or "mmh3" in name) and ("upscale" in name or "latent" in name):
        return "latent_upscale_models"
    if "audio_encoder" in name or "audio encoder" in name:
        return "audio_encoders"
    if "optical_flow" in name or "optical flow" in name:
        return "optical_flow"
    if "geometry_estimation" in name or "moge" in name or "da3" in name:
        return "geometry_estimation"
    if "mediapipe" in name or "sam3d" in name or "face_detection" in name or "detection" in name:
        return "detection"
    if "conditioning_name" in name:
        return "embeddings"
    if "hypernetwork" in name:
        return "hypernetworks"
    if "photomaker" in name:
        return "photomaker"
    return None

def collect_proxy_widget_models(
    node: dict,
    linked_widget_indices: set[int] | None = None,
    linked_widget_names: set[str] | None = None
) -> list[dict]:
    props = node.get("properties") or {}
    proxy = props.get("proxyWidgets")
    widgets = node.get("widgets_values")
    if not isinstance(proxy, list) or not isinstance(widgets, list):
        return []

    proxy_len = len(proxy)
    results = []
    for idx, value in enumerate(widgets):
        proxy_item = proxy[idx] if idx < proxy_len else None
        widget_name = None
        if isinstance(proxy_item, (list, tuple)) and len(proxy_item) >= 2:
            widget_name = proxy_item[1]
        if linked_widget_names and widget_name and widget_name in linked_widget_names:
            continue
        if linked_widget_indices and idx in linked_widget_indices and not widget_name:
            continue
        if not isinstance(value, str):
            continue
        if value.startswith("http://") or value.startswith("https://"):
            parsed_filename = value.split("?")[0].split("/")[-1]
            if not any(parsed_filename.endswith(ext) for ext in MODEL_EXTENSIONS):
                continue
            suggested_folder = resolve_node_folder_for_widget(
                node,
                widget_index=idx,
                widget_name=widget_name,
                widget_value=parsed_filename
            )
            results.append({
                "filename": parsed_filename,
                "requested_path": None,
                "url": value,
                "suggested_folder": suggested_folder,
                "origin": "proxy_widget"
            })
            continue
        if not any(value.endswith(ext) for ext in MODEL_EXTENSIONS):
            continue
        filename, requested_path = split_model_identifier(value)
        suggested_folder = resolve_node_folder_for_widget(
            node,
            widget_index=idx,
            widget_name=widget_name,
            widget_value=filename
        )
        results.append({
            "filename": filename,
            "requested_path": requested_path,
            "url": None,
            "suggested_folder": suggested_folder,
            "origin": "proxy_widget"
        })
    return results

def patch_lora_stack_nodes():
    """
    Patches LoadLoraModel and LoadLoraTextEncoder (from ComfyUI core comfy_extras)
    to define validate_inputs(cls, **kwargs).
    
    By default in ComfyUI core, these nodes inherit io.ComfyNode without overriding
    validate_inputs. As a result, ComfyUI's execution.py performs a generic combo
    check (value_not_in_list) against every dynamic row, even when enabled=False or
    strength=0, which blocks prompt execution and workflow runs when uninstalled LoRAs
    are present but disabled.
    
    Overriding validate_inputs delegates input validation to this method, allowing
    disabled rows (enabled=False or strength=0) to be skipped safely while still
    validating enabled, non-zero strength rows against folder_paths.
    """
    try:
        classes_to_patch = []
        try:
            import comfy_extras.nodes_lora_stack as nls
            if hasattr(nls, "LoadLoraModel"):
                classes_to_patch.append(nls.LoadLoraModel)
            if hasattr(nls, "LoadLoraTextEncoder"):
                classes_to_patch.append(nls.LoadLoraTextEncoder)
        except Exception:
            pass

        try:
            import nodes
            mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {})
            for name in ("LoadLoraModel", "LoadLoraTextEncoder", "Load LoRA (Model)", "Load LoRA (Text Encoder)"):
                cls = mappings.get(name)
                if cls and cls not in classes_to_patch:
                    classes_to_patch.append(cls)
        except Exception:
            pass

        if not classes_to_patch:
            return

        @classmethod
        def _validate_dynamic_loras(cls, *args, **kwargs):
            loras = kwargs.get("loras")
            if loras is None and args:
                for arg in args:
                    if isinstance(arg, list) and (not arg or isinstance(arg[0], dict)):
                        loras = arg
                        break
            if isinstance(loras, list):
                try:
                    import folder_paths
                except Exception:
                    folder_paths = None

                for row in loras:
                    if not isinstance(row, dict):
                        continue
                    enabled = row.get("enabled", True)
                    if enabled is False or enabled == "false" or enabled == 0:
                        continue
                    strength = row.get("strength", 1.0)
                    try:
                        if float(strength) == 0.0:
                            continue
                    except (ValueError, TypeError):
                        pass

                    lora_name = row.get("lora_name")
                    if not lora_name:
                        continue

                    if folder_paths:
                        try:
                            full_path = folder_paths.get_full_path("loras", lora_name)
                        except Exception:
                            full_path = None
                        if not full_path:
                            try:
                                filename_list = folder_paths.get_filename_list("loras")
                            except Exception:
                                filename_list = []
                            if lora_name not in filename_list:
                                return f"LoRA '{lora_name}' not found"
            return True

        for cls in classes_to_patch:
            if not getattr(cls, "_hfd_lora_stack_patched", False):
                cls.validate_inputs = _validate_dynamic_loras
                cls._hfd_lora_stack_patched = True
    except Exception as e:
        print(f"[ComfyUI_HuggingFace_Downloader] Note: could not patch LoRA stack validation: {e}")


_HF_REPO_EXCLUDED_OWNERS = {
    "spaces",
    "datasets",
    "docs",
    "blog",
    "organizations",
    "settings",
    "join",
    "login",
    "pricing",
    "enterprise",
    "models",
    "tasks",
}

_NOTE_MODEL_FILENAME_RE = re.compile(
    r"([A-Za-z0-9._/\-]+\.(?:safetensors|ckpt|pt|bin|pth|gguf))",
    re.IGNORECASE,
)
_NOTE_MODELS_DIR_RE = re.compile(
    r"(?:^|[\s`|(\"'=])models[/\\]([A-Za-z0-9_.\-/]+)",
    re.IGNORECASE,
)


def _extract_hf_repo_id_from_url(url: str | None) -> str | None:
    if not url or not isinstance(url, str):
        return None
    m = re.search(r"huggingface\.co/([A-Za-z0-9._\-]+)/([A-Za-z0-9._\-]+)", url, re.IGNORECASE)
    if not m:
        return None
    owner = m.group(1).strip()
    repo = m.group(2).strip().rstrip(".,;:!?)\"'`")
    if not owner or not repo or owner.lower() in _HF_REPO_EXCLUDED_OWNERS:
        return None
    return f"{owner}/{repo}"


def _extract_note_context_from_text(
    text: str,
    note_links: dict[str, str],
    note_links_normalized: dict[str, str],
    note_repos: list[str] | None = None,
    note_folder_hints: dict[str, str] | None = None,
) -> None:
    if not isinstance(text, str) or not text:
        return

    # 1. Markdown links: [text](url)
    links = re.findall(r'\[([^\]]+)\]\((https?://[^)]+)\)', text, re.IGNORECASE)
    for label, url in links:
        repo_id = _extract_hf_repo_id_from_url(url)
        if repo_id and note_repos is not None and repo_id not in note_repos:
            note_repos.append(repo_id)
        if not is_specific_model_file_url(url):
            continue
        url_filename = url.split("?")[0].split("/")[-1]
        candidates = []
        if any(url_filename.lower().endswith(ext) for ext in MODEL_EXTENSIONS):
            candidates.append(url_filename)
        if any(label.lower().endswith(ext) for ext in MODEL_EXTENSIONS):
            candidates.append(label)
        for filename in candidates:
            note_key = normalize_filename_key(filename)
            note_links.setdefault(note_key, url)
            note_links_normalized.setdefault(normalize_filename_compact(filename), url)

    # 2. Bare HuggingFace URLs in notes (e.g. plain https://huggingface.co/owner/repo)
    for raw_url in re.findall(r"https?://huggingface\.co/[^\s)>\]]+", text, re.IGNORECASE):
        repo_id = _extract_hf_repo_id_from_url(raw_url)
        if repo_id and note_repos is not None and repo_id not in note_repos:
            note_repos.append(repo_id)

    # 3. Markdown tables or line-by-line hints: | file.safetensors | models/asr |
    if note_folder_hints is not None:
        for line in text.splitlines():
            folder_matches = _NOTE_MODELS_DIR_RE.findall(line)
            if not folder_matches:
                continue
            raw_folder = folder_matches[-1].strip().strip("`|\"'.,;:()[]{}").rstrip("/\\")
            norm_folder = normalize_relative_model_path(raw_folder)
            if not norm_folder:
                continue
            top_bucket = norm_folder.split("/", 1)[0]
            if top_bucket in {"output", "input", "temp", "user", "custom_nodes"}:
                continue
            for file_match in _NOTE_MODEL_FILENAME_RE.findall(line):
                fname = os.path.basename(file_match.replace("\\", "/")).strip()
                if not fname:
                    continue
                note_folder_hints.setdefault(normalize_filename_key(fname), norm_folder)
                note_folder_hints.setdefault(normalize_filename_compact(fname), norm_folder)


def _extract_note_context_from_workflow(workflow: dict) -> tuple[list[str], dict[str, str]]:
    note_links: dict[str, str] = {}
    note_links_normalized: dict[str, str] = {}
    note_repos: list[str] = []
    note_folder_hints: dict[str, str] = {}

    def _visit_nodes(node_list: Any) -> None:
        if not isinstance(node_list, list):
            return
        for node in node_list:
            if not isinstance(node, dict):
                continue
            if node.get("mode", 0) in {2, 4}:
                continue
            node_type = str(node.get("type") or "")
            if "Note" in node_type or "PrimitiveString" in node_type:
                wv = node.get("widgets_values")
                if isinstance(wv, list):
                    for val in wv:
                        if isinstance(val, str):
                            _extract_note_context_from_text(
                                val,
                                note_links,
                                note_links_normalized,
                                note_repos,
                                note_folder_hints,
                            )

    _visit_nodes(workflow.get("nodes", []))
    defs = workflow.get("definitions", {})
    if isinstance(defs, dict):
        for sg in _collect_all_subgraph_defs(defs.get("subgraphs", [])):
            _visit_nodes(sg.get("nodes", []))

    return note_repos, note_folder_hints


def _collect_models_from_nodes(
    nodes: list[dict],
    links_map: dict,
    nodes_by_id: dict,
    found_models: list[dict],
    note_links: dict,
    note_links_normalized: dict,
    node_title_fallback: str,
    node_id_prefix: str = "",
    note_repos: list[str] | None = None,
    note_folder_hints: dict[str, str] | None = None,
) -> None:
    for node in nodes:
        # Skip disabled/muted nodes
        # 0 = Enabled, 2 = Muted, 4 = Bypass/Disabled?
        # Let's treat anything != 0 and != None as potentially disabled, 
        # or at least explicitly 2 and 4 as knowndisabled states.
        mode = node.get("mode", 0)
        if mode == 2 or mode == 4:
            continue
            
        raw_node_id = node.get("id")
        node_id = f"{node_id_prefix}:{raw_node_id}" if node_id_prefix and raw_node_id is not None else raw_node_id
        # Skip disabled/muted nodes
        if node.get("mode") == 2:
            continue
            
        node_title = node.get("title") or node.get("type", node_title_fallback)
        node_type = node.get("type", "")
        node_cnr = ""
        if isinstance(node.get("properties"), dict):
            node_cnr = node["properties"].get("cnr_id", "") or ""
        if node_cnr in {"comfyui_controlnet_aux", "frame-interpolation", "ComfyUI-Frame-Interpolation", "video-depth-anything", "ComfyUI-Video-Depth-Anything"}:
            continue
        if node_type.endswith(" VFI") or node_type in {"KSampler Gradually Adding More Denoise (efficient)", "Make Interpolation State List", "VFI FloatToInt"} or "VideoDepthAnything" in node_type:
            continue

        # Common widget names for model loaders and their typical indices.
        # This helps backend discovery skip redundant widgets even if the frontend
        # serialization doesn't explicitly null them.
        _COMMON_LOADER_WIDGET_MAPPING = {
            "unet_name": 0,
            "lora_name": 0,
            "lora_name_1": 1,
            "vae_name": 0,
            "clip_name": 0,
            "checkpoint_name": 0,
            "model_name": 0,
            "unet": 0,
            "lora": 0,
            "vae": 0,
            "clip": 0,
            "model": 0,
            "diffusion_model": 0,
            "vitpose_model": 0,
            "yolo_model": 0,
            "tiny_vae": 5,
        }

        linked_widget_names = set()
        linked_widget_indices = set()
        has_linked_widget_input = False
        for input_item in node.get("inputs", []):
            if "widget" in input_item:
                input_name = input_item.get("name")
                widget_map = input_item.get("widget")
                link_id = input_item.get("link")
                if link_id is not None:
                    has_linked_widget_input = True
                    # Record name
                    if isinstance(input_name, str) and input_name:
                        linked_widget_names.add(input_name)
                    
                    # Resolve index
                    idx = None
                    if isinstance(widget_map, dict):
                        w_name = widget_map.get("name")
                        if w_name:
                            linked_widget_names.add(w_name)
                            idx = _COMMON_LOADER_WIDGET_MAPPING.get(w_name)
                    elif isinstance(widget_map, int):
                        idx = widget_map
                    elif isinstance(widget_map, str):
                        linked_widget_names.add(widget_map)
                        idx = _COMMON_LOADER_WIDGET_MAPPING.get(widget_map)
                    
                    if idx is not None:
                        linked_widget_indices.add(idx)
                    elif isinstance(input_name, str):
                        idx = _COMMON_LOADER_WIDGET_MAPPING.get(input_name)
                        if idx is not None:
                            linked_widget_indices.add(idx)

        # Detect disabled dynamic LoRA stack rows in LoadLoraModel / LoadLoraTextEncoder
        disabled_widget_indices = set()
        disabled_widget_names = set()
        disabled_model_keys = set()
        named_widgets = node.get("widgets_values_named")
        if not isinstance(named_widgets, dict) and isinstance(node.get("widgets_values"), dict):
            named_widgets = node.get("widgets_values")
        if not isinstance(named_widgets, dict) and isinstance(node.get("inputs"), dict):
            named_widgets = node.get("inputs")

        def _is_disabled_flag(val):
            if val is False:
                return True
            if isinstance(val, (int, float)) and val == 0:
                return True
            if isinstance(val, str) and val.strip().lower() in ("false", "0", "0.0", "off", "disable", "disabled"):
                return True
            return False

        def _is_zero_strength(val):
            try:
                return float(val) == 0.0
            except (ValueError, TypeError):
                return False

        if isinstance(named_widgets, dict):
            for k, v in named_widgets.items():
                if not isinstance(k, str):
                    continue
                if k.endswith(".lora_name"):
                    prefix = k[:-len(".lora_name")]
                    enabled_val = named_widgets.get(f"{prefix}.enabled", True)
                    strength_val = named_widgets.get(f"{prefix}.strength", named_widgets.get(f"{prefix}.strength_model", 1.0))
                    if _is_disabled_flag(enabled_val) or _is_zero_strength(strength_val):
                        disabled_widget_names.add(k)
                        if isinstance(v, str) and v.strip():
                            fname, _ = split_model_identifier(v.strip())
                            if fname:
                                disabled_model_keys.add(normalize_filename_key(fname))

        if node_type in {"LoadLoraModel", "LoadLoraTextEncoder", "Load LoRA (Model)", "Load LoRA (Text Encoder)"}:
            raw_wv = node.get("widgets_values")
            if isinstance(raw_wv, list) and len(raw_wv) >= 3:
                # Format is either:
                # - [count, lora_name_0, strength_0, enabled_0, ...] (saved workflow with count)
                # - [lora_name_0, strength_0, enabled_0, ...] (live serialized graph without count)
                row_idx = 1 if (not isinstance(raw_wv[0], bool) and isinstance(raw_wv[0], int)) else 0
                while row_idx + 2 < len(raw_wv):
                    lora_val = raw_wv[row_idx]
                    strength_val = raw_wv[row_idx + 1]
                    enabled_val = raw_wv[row_idx + 2]
                    if _is_disabled_flag(enabled_val) or _is_zero_strength(strength_val):
                        disabled_widget_indices.add(row_idx)
                        if isinstance(lora_val, str) and lora_val.strip():
                            fname, _ = split_model_identifier(lora_val.strip())
                            if fname:
                                disabled_model_keys.add(normalize_filename_key(fname))
                    row_idx += 3

        # Gather currently selected model-like widget values for this node.
        # Some workflows keep stale entries in properties.models (template metadata),
        # so we later only trust matching property rows when widget-selected models exist.
        widget_model_keys = set()
        widgets_for_keys = node.get("widgets_values")
        if isinstance(widgets_for_keys, list):
            for idx, raw_val in enumerate(widgets_for_keys):
                if idx in disabled_widget_indices:
                    continue
                if raw_val is None or not isinstance(raw_val, str):
                    continue
                val = raw_val.strip()
                if not val:
                    continue
                if val.startswith("http://") or val.startswith("https://"):
                    parsed_filename = val.split("?")[0].split("/")[-1]
                    if any(parsed_filename.lower().endswith(ext) for ext in MODEL_EXTENSIONS):
                        widget_model_keys.add(normalize_filename_key(parsed_filename))
                    continue
                if _looks_like_model_widget_value(val, node_type):
                    filename, _requested_path = split_model_identifier(val)
                    if filename:
                        widget_model_keys.add(normalize_filename_key(filename))
        if isinstance(named_widgets, dict):
            for w_name, raw_val in named_widgets.items():
                if w_name in disabled_widget_names or w_name in linked_widget_names:
                    continue
                if raw_val is None or not isinstance(raw_val, str):
                    continue
                val = raw_val.strip()
                if not val:
                    continue
                if _looks_like_model_widget_value(val, node_type):
                    filename, _requested_path = split_model_identifier(val)
                    if filename:
                        widget_model_keys.add(normalize_filename_key(filename))
        
        # Subgraph wrapper nodes (UUID-type) proxy model widgets from inside the subgraph.
        # Capture those proxy widgets here so models are still discovered.
        if is_subgraph_node(node_type):
            proxy_models = collect_proxy_widget_models(
                node,
                linked_widget_indices,
                linked_widget_names
            )
            for proxy_model in proxy_models:
                filename = proxy_model.get("filename")
                if not filename:
                    continue
                found_models.append({
                    "filename": filename,
                    "requested_path": proxy_model.get("requested_path"),
                    "url": proxy_model.get("url"),
                    "node_id": node_id,
                    "node_title": node_title,
                    "node_type": node_type,
                    "suggested_folder": proxy_model.get("suggested_folder"),
                    "origin": proxy_model.get("origin")
                })
            continue
        
        # Special handling for "Hugging Face Download Model" node
        # This node has widgets: [folder, url, custom_path]
        # We need to extract the custom_path (widgets[2]) to determine the target folder
        if node_type == "Hugging Face Download Model" and "widgets_values" in node:
            widgets = node["widgets_values"]
            if isinstance(widgets, list) and len(widgets) >= 2:
                folder = str(widgets[0]).strip()
                if folder == "custom":
                    custom_path = widgets[1] if len(widgets) >= 2 else None
                    url = widgets[2] if len(widgets) >= 3 else None
                else:
                    custom_path = None
                    url = widgets[1] if len(widgets) >= 2 else None
                
                # Extract filename from URL
                filename = None
                if url and isinstance(url, str):
                    # Try to extract filename from URL
                    if "/" in url:
                        filename = url.split("/")[-1].split("?")[0]  # Remove query params
                    
                if filename:
                    suggested_folder = None
                    requested_path = filename
                    folder_locked = False
                    locked_folder = None

                    if custom_path and isinstance(custom_path, str) and custom_path.strip():
                        normalized_custom = normalize_relative_model_path(
                            normalize_save_path(custom_path) or custom_path
                        )
                        if normalized_custom:
                            custom_segments = [seg for seg in normalized_custom.split("/") if seg]
                            if custom_segments:
                                suggested_folder = custom_segments[0]
                                locked_folder = normalized_custom
                                folder_locked = True
                                if len(custom_segments) > 1:
                                    requested_path = "/".join(custom_segments[1:] + [filename])
                    elif folder and folder != "custom":
                        normalized_folder = normalize_relative_model_path(
                            normalize_save_path(str(folder).strip()) or str(folder).strip()
                        )
                        if normalized_folder:
                            suggested_folder = normalized_folder
                            locked_folder = normalized_folder
                            folder_locked = True

                    found_models.append({
                        "filename": filename,
                        "requested_path": requested_path,
                        "url": url,
                        "node_id": node_id,
                        "node_title": node_title,
                        "node_type": node_type,
                        "suggested_folder": suggested_folder,
                        "folder_locked": folder_locked,
                        "locked_folder": locked_folder,
                        "display_name": requested_path or filename,
                    })
                    continue  # Skip generic widget scan for this node
        
        # Extract links from Notes - but DON'T add them to found_models
        # They should only be used to enrich loader nodes
        if "Note" in node_type or "PrimitiveString" in node_type:
            if "widgets_values" in node and isinstance(node["widgets_values"], list):
                for val in node["widgets_values"]:
                    if isinstance(val, str):
                        _extract_note_context_from_text(
                            val,
                            note_links,
                            note_links_normalized,
                            note_repos,
                            note_folder_hints,
                        )
            continue  # Don't process Notes as loader nodes

        # 2. Check properties -> models (Standard ComfyUI template format)
        if "properties" in node and "models" in node["properties"]:
            # Collect models from property rows, but ONLY if they are not overridden by a link.
            # 'has_linked_widget_input' is now a signal that we must be careful.
            for model_info in node["properties"]["models"]:
                name = model_info.get("name")
                filename, requested_path = split_model_identifier(name) if name else (name, None)
                if not filename:
                    continue
                filename_key = normalize_filename_key(filename)
                if filename_key in disabled_model_keys:
                    continue
                if node_type in {"LoadLoraModel", "LoadLoraTextEncoder", "Load LoRA (Model)", "Load LoRA (Text Encoder)"}:
                    if filename_key not in widget_model_keys:
                        continue
                
                # If any linked widget's ORIGINAL value (which we can't always know, 
                # but we know it's being overridden) matched this filename, we skip.
                # As a heuristic, if a widget is linked and 'has_linked_widget_input' is true,
                # we only trust the property row if the filename matches a NON-LINKED widget.
                # AUTHORITATIVE CHECK:
                # If the node has any model(s) selected in its widgets (populated in widget_model_keys),
                # we ONLY trust the property-metadata rows that match those selections.
                # This prevents stale metadata (leftover from previous selections) from being reported.
                if (has_linked_widget_input or widget_model_keys) and filename_key not in widget_model_keys:
                    # It's either linked or stale, so skip it.
                    continue

                if any(m["filename"] == filename and m["node_id"] == node_id for m in found_models):
                    continue
                found_models.append({
                    "filename": filename,
                    "requested_path": requested_path,
                    "url": model_info.get("url"),
                    "node_id": node_id,
                    "node_title": node_title,
                    "node_type": node_type,
                    "suggested_folder": model_info.get("directory")
                })
                
        # 3. Check widgets_values for filenames
        # SKIP for Notes/PrimitiveStrings as we handled them specifically above
        if (
            ("widgets_values" in node or isinstance(named_widgets, dict))
            and not ("Note" in node_type or "PrimitiveString" in node_type)
        ):
            widgets = node.get("widgets_values")
            if isinstance(widgets, list):
                for idx, val in enumerate(widgets):
                    if idx in linked_widget_indices or idx in disabled_widget_indices:
                        continue
                    if val is None or not isinstance(val, str):
                        continue

                    # CASE A: Value is a URL
                    if val.startswith("http://") or val.startswith("https://"):
                        # Check if it points to a model file
                        if any(val.endswith(ext) for ext in MODEL_EXTENSIONS) or "blob" in val or "resolve" in val:
                            # Try to extract filename from URL
                            # Typical specific link: https://.../resolve/main/filename.safetensors
                            # Or query params? 
                            parsed_filename = val.split("?")[0].split("/")[-1]
                            # If it looks like a model filename
                            if any(parsed_filename.endswith(ext) for ext in MODEL_EXTENSIONS):
                                if not any(m["filename"] == parsed_filename and m["node_id"] == node_id for m in found_models):
                                    suggested_folder, is_auth, resolved_wname = resolve_node_folder_for_widget_with_authority(
                                        node,
                                        widget_index=idx,
                                        widget_name=None,
                                        widget_value=parsed_filename
                                    )
                                    entry = {
                                        "filename": parsed_filename,
                                        "url": val,
                                        "node_id": node_id,
                                        "node_title": node_title,
                                        "node_type": node_type,
                                        "suggested_folder": suggested_folder,
                                        "widget_index": idx,
                                    }
                                    if resolved_wname:
                                        entry["input_name"] = resolved_wname
                                    if is_auth and suggested_folder:
                                        entry["authoritative_folder"] = suggested_folder
                                        entry["folder_locked"] = True
                                    found_models.append(entry)
                                continue

                    # CASE B: Value is a filename
                    if _looks_like_model_widget_value(val, node_type):
                        # Avoid duplicates if already found via properties
                        # Note: we don't check against subgraph findings here yet, 
                        # duplicate filtering happens in process_workflow
                        filename, requested_path = split_model_identifier(val)
                        if not any(m["filename"] == filename and m["node_id"] == node_id for m in found_models):
                            # Try to map folder
                            suggested_folder, is_auth, resolved_wname = resolve_node_folder_for_widget_with_authority(
                                node,
                                widget_index=idx,
                                widget_name=None,
                                widget_value=filename
                            )
                            entry = {
                                "filename": filename,
                                "requested_path": requested_path,
                                "url": None,
                                "node_id": node_id,
                                "node_title": node_title,
                                "node_type": node_type,
                                "suggested_folder": suggested_folder,
                                "widget_index": idx,
                            }
                            if resolved_wname:
                                entry["input_name"] = resolved_wname
                            if is_auth and suggested_folder:
                                entry["authoritative_folder"] = suggested_folder
                                entry["folder_locked"] = True
                            found_models.append(entry)

            if isinstance(named_widgets, dict):
                for w_name, val in named_widgets.items():
                    if w_name in linked_widget_names or w_name in disabled_widget_names:
                        continue
                    if val is None or not isinstance(val, str):
                        continue
                    if _looks_like_model_widget_value(val, node_type):
                        filename, requested_path = split_model_identifier(val)
                        if not any(m["filename"] == filename and m["node_id"] == node_id for m in found_models):
                            suggested_folder, is_auth, resolved_wname = resolve_node_folder_for_widget_with_authority(
                                node,
                                widget_index=None,
                                widget_name=w_name,
                                widget_value=filename
                            )
                            entry = {
                                "filename": filename,
                                "requested_path": requested_path,
                                "url": None,
                                "node_id": node_id,
                                "node_title": node_title,
                                "node_type": node_type,
                                "suggested_folder": suggested_folder,
                                "input_name": resolved_wname or w_name,
                            }
                            if is_auth and suggested_folder:
                                entry["authoritative_folder"] = suggested_folder
                                entry["folder_locked"] = True
                            found_models.append(entry)

        # 4. Check inputs for upstream URLs (Model Injection)
        if "inputs" in node:
            for input_item in node["inputs"]:
                link_id = input_item.get("link")
                if link_id and link_id in links_map:
                    upstream_id, _ = links_map[link_id]
                    upstream_node = nodes_by_id.get(upstream_id)
                    
                    if upstream_node:
                        # Check upstream node for URLs
                        if "widgets_values" in upstream_node:
                            # Skip if upstream is disabled
                            if upstream_node.get("mode", 0) in [2, 4]:
                                continue

                            u_widgets = upstream_node["widgets_values"]
                            if isinstance(u_widgets, list):
                                for u_val in u_widgets:
                                    if isinstance(u_val, str) and (u_val.startswith("http://") or u_val.startswith("https://")):
                                        # It's a URL in the upstream node
                                        # Check if we should attribute it to this node?
                                        # Or just ensure it's captured (which it likely is by the main loop)
                                        
                                        # The requirement is: "auto-download node should count this as a link for this loader's model"
                                        # We need to find the model entry for THIS node and attach the URL.
                                        
                                        # Find the model for this node corresponding to this input?
                                        # Or just find ANY model required by this node and if missing URL, try this one.
                                        # Simplification: If this node requires a model (found above), and has no URL, and upstream has a URL, use it.
                                        
                                        # Let's iterate over found_models for this node and enrich them
                                        for m in found_models:
                                            if m["node_id"] == node_id and not m["url"]:
                                                # Check if the URL filename matches? 
                                                # Or just blindly assign if it's the only one?
                                                # "count this as a link for this loader's model" implies loose coupling or direct assignment.
                                                
                                                # Let's verify if URL looks like a model
                                                if any(u_val.endswith(ext) for ext in MODEL_EXTENSIONS) or "blob" in u_val or "resolve" in u_val:
                                                    url_filename = u_val.split("?")[0].split("/")[-1]
                                                    if url_filename and url_filename.lower() == m["filename"].lower():
                                                        m["url"] = u_val
                                                        m["note"] = f"Resolved from upstream node {upstream_node.get('title', upstream_id)}"
    
def extract_models_from_workflow(workflow: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Parses the workflow JSON to find potential model files.
    Returns a list of dicts: 
    {
        "filename": "model.safetensors",
        "url": "https://...", (optional)
        "node_id": 123,
        "node_title": "Load Checkpoint",
        "suggested_path": "checkpoints" (optional category)
    }
    """
    patch_lora_stack_nodes()
    found_models = []

    # Track Note links separately - they should NOT create download entries
    # They should only be used to enrich loader nodes that are missing URLs
    note_links = {}  # {normalized_filename: url}
    note_links_normalized = {}  # {compact_filename: url}
    note_repos: list[str] = []
    note_folder_hints: dict[str, str] = {}

    links_map = _build_links_map(workflow.get("links", []))
    nodes = workflow.get("nodes", [])
    nodes_by_id = {n.get("id"): n for n in nodes}
    _collect_models_from_nodes(
        nodes,
        links_map,
        nodes_by_id,
        found_models,
        note_links,
        note_links_normalized,
        "Unknown Node",
        note_repos=note_repos,
        note_folder_hints=note_folder_hints,
    )

    definitions = workflow.get("definitions", {})
    root_subgraphs = definitions.get("subgraphs", [])
    all_subgraph_defs = _collect_all_subgraph_defs(root_subgraphs)
    path_map = _build_subgraph_execution_paths(nodes, all_subgraph_defs)
    for subgraph in all_subgraph_defs:
        def_id = str(subgraph.get("id") or "").strip()
        if not def_id:
            continue
        instance_paths = path_map.get(def_id, [])
        if not instance_paths:
            continue

        sub_nodes = subgraph.get("nodes", [])
        sub_links = subgraph.get("links", [])
        sub_links_map = _build_links_map(sub_links)
        sub_nodes_by_id = {n.get("id"): n for n in sub_nodes}
        subgraph_name = subgraph.get("name", "Subgraph")
        for instance_path in instance_paths:
            _collect_models_from_nodes(
                sub_nodes,
                sub_links_map,
                sub_nodes_by_id,
                found_models,
                note_links,
                note_links_normalized,
                f"Subgraph Node ({subgraph_name})",
                instance_path,
                note_repos=note_repos,
                note_folder_hints=note_folder_hints,
            )

    # Enrich found_models with URLs from note_links and folder hints from MarkdownNote tables.
    # Note links should never override an already valid file URL from loader metadata.
    for model in found_models:
        note_key = normalize_filename_key(model["filename"])
        compact_key = normalize_filename_compact(model["filename"])

        if not model.get("folder_locked"):
            hinted_folder = note_folder_hints.get(note_key) or note_folder_hints.get(compact_key)
            if hinted_folder:
                current_folder = normalize_save_path(model.get("suggested_folder")) or ""
                if not current_folder or current_folder in {"checkpoints", "diffusion_models", "text_encoders"}:
                    model["suggested_folder"] = hinted_folder

        url = note_links.get(note_key) or note_links_normalized.get(compact_key)
        if not url:
            continue
        if not is_specific_model_file_url(url, expected_filename=model["filename"]):
            continue
        existing_url = model.get("url")
        if existing_url and is_specific_model_file_url(existing_url):
            continue
        model["url"] = url
        model["source"] = "note"
        model["note"] = "URL from Note"

    return found_models

def is_subgraph_node(node_type: str) -> bool:
    """Check if node_type is a UUID (indicates subgraph wrapper node)"""
    import re
    uuid_pattern = r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    return bool(re.match(uuid_pattern, node_type, re.IGNORECASE))

def recursive_find_file(filename: str, root_dir: str) -> str | None:
    """Recursively searches for a file within a directory."""
    for dirpath, _, filenames in os.walk(root_dir):
        if filename in filenames:
            return os.path.join(dirpath, filename)
    return None

def resolve_requested_model_path(root_dir: str, requested_path: str | None, filename: str | None = None) -> str | None:
    """
    Resolve the workflow-requested relative path directly under a model root.

    This is the hot path for workflow-managed downloader nodes. When requested_path
    includes subfolders (for example `repo_subdir/model.safetensors`), checking the
    exact relative destination avoids a full recursive walk on every scan.
    """
    root_abs = os.path.abspath(root_dir)
    candidate_rel_paths = []

    requested_norm = normalize_relative_model_path(requested_path)
    if requested_norm:
        candidate_rel_paths.append(requested_norm)

    filename_norm = normalize_relative_model_path(os.path.basename(str(filename or "").replace("\\", "/")))
    if filename_norm and filename_norm not in candidate_rel_paths:
        candidate_rel_paths.append(filename_norm)

    seen_candidates = set()
    for rel_path in candidate_rel_paths:
        candidate = os.path.abspath(os.path.join(root_abs, rel_path))
        if candidate in seen_candidates:
            continue
        seen_candidates.add(candidate)
        try:
            if os.path.commonpath([root_abs, candidate]) != root_abs:
                continue
        except Exception:
            continue
        if os.path.exists(candidate):
            return candidate

    return None

def recursive_find_file_by_stem(stem: str, root_dir: str) -> str | None:
    """Recursively searches for a file by exact stem or stem + known extension."""
    stem_lower = (stem or "").lower()
    if not stem_lower:
        return None
    for dirpath, _, filenames in os.walk(root_dir):
        for file in filenames:
            file_lower = file.lower()
            if file_lower == stem_lower or file_lower.startswith(stem_lower + "."):
                return os.path.join(dirpath, file)
    return None

def _clip_vision_alias_family(value: str | None) -> str | None:
    base = os.path.basename(str(value or "").replace("\\", "/")).lower()
    if not base:
        return None
    stem = os.path.splitext(base)[0]
    compact = re.sub(r"[^a-z0-9]+", "", stem)
    if "unclip" in compact:
        return None
    if "sigclipvision" in compact:
        return "sigclip_vision"
    if "clipvisionh" in compact or "clipvith" in compact:
        return "clip_vision_h"
    if "clipvisiong" in compact or "clipvitg" in compact:
        return "clip_vision_g"
    return None

def recursive_find_equivalent_model_file(filename: str, root_dir: str, folder_type: str | None = None) -> str | None:
    folder_norm = normalize_save_path(folder_type) or folder_type or ""
    if folder_norm != "clip_vision":
        return None

    family = _clip_vision_alias_family(filename)
    if not family:
        return None

    best_match = None
    best_score = None
    for dirpath, _, filenames in os.walk(root_dir):
        for file in filenames:
            if _clip_vision_alias_family(file) != family:
                continue
            candidate_path = os.path.join(dirpath, file)
            score = (
                0 if normalize_filename_key(file).startswith(family) else 1,
                len(file),
                len(candidate_path),
            )
            if best_score is None or score < best_score:
                best_match = candidate_path
                best_score = score
    return best_match

def recursive_find_dir(dirname: str, root_dir: str) -> str | None:
    """Recursively searches for a directory."""
    for dirpath, dirnames, _ in os.walk(root_dir):
        if dirname in dirnames:
            return os.path.join(dirpath, dirname)
    return None

def check_model_files(found_models: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Checks if models exist locally.
    Returns:
        missing_models: list of models not found
        existing_models: list of models found (filename, actual_path, etc.)
        path_mismatches: list of models found but with different paths than requested
    """
    missing = []
    existing = []
    path_mismatches = []
    
    # ComfyUI's folder_paths.base_path is usually the ComfyUI root
    # If not, os.getcwd() might be more reliable if this script is run from custom_nodes
    # For now, assuming folder_paths is correctly configured.
    
    def _is_path_like(value: str) -> bool:
        return ("/" in value) or ("\\" in value)

    for model in found_models:
        filename = model["filename"]
        requested_path = model.get("requested_path") or filename
        
        # Skip models with None/null filenames (from disabled nodes or empty widgets)
        if filename is None or filename == "null" or not filename:
            continue
            
        folder_type = model.get("suggested_folder", "checkpoints")
        
        # Safety check: if folder_type is None, default to checkpoints
        if folder_type is None:
            folder_type = "checkpoints"
        
        # Use ComfyUI's folder_paths to get valid paths for this type
        try:
            search_paths = folder_paths.get_folder_paths(folder_type)
        except KeyError:
            search_paths = []

        if not search_paths and folder_type and ("/" in folder_type or "\\" in folder_type):
            norm_folder = folder_type.replace("\\", "/")
            for alt_key in [norm_folder.replace("/", "_"), norm_folder.split("/")[0]]:
                try:
                    search_paths = folder_paths.get_folder_paths(alt_key)
                    if search_paths:
                        break
                except KeyError:
                    continue

        if not search_paths:
            # Fallback to standard models/ structure if type unknown
            # This might not be ideal as folder_paths.get_folder_paths is the canonical way
            # but provides a safety net.
            comfy_root = getattr(folder_paths, "base_path", os.getcwd())
            models_dir = getattr(folder_paths, "models_dir", None) or os.path.join(comfy_root, "models")
            if folder_type and os.path.isabs(folder_type):
                search_paths = [folder_type]
            elif folder_type and (folder_type.startswith("models/") or folder_type.startswith("models\\")):
                search_paths = [os.path.join(comfy_root, folder_type)]
            else:
                search_paths = [os.path.join(models_dir, folder_type)]
                if "/" in folder_type.replace("\\", "/"):
                    parent_rel = folder_type.replace("\\", "/").split("/")[0]
                    parent_path = os.path.join(models_dir, parent_rel)
                    if parent_path not in search_paths:
                        search_paths.append(parent_path)

        found_path = None
        found_root = None
        found_bucket = None
        allow_nunchaku_fuzzy = _is_nunchaku_extensionless_identifier(filename)

        def _search_roots_for_model(roots: list[str], search_folder_type: str | None) -> tuple[str | None, str | None]:
            for root_path in roots:
                if not isinstance(root_path, str) or not root_path or not os.path.exists(root_path):
                    continue

                exact_path = resolve_requested_model_path(root_path, requested_path, filename)
                if exact_path:
                    return exact_path, root_path

                found_file = recursive_find_file(filename, root_path)
                if found_file:
                    return found_file, root_path

                found_file = recursive_find_equivalent_model_file(filename, root_path, search_folder_type)
                if found_file:
                    return found_file, root_path

                if allow_nunchaku_fuzzy:
                    found_file = recursive_find_file_by_stem(filename, root_path)
                    if found_file:
                        return found_file, root_path
                    found_dir = recursive_find_dir(filename, root_path)
                    if found_dir:
                        return found_dir, root_path
            return None, None

        found_path, found_root = _search_roots_for_model(search_paths, folder_type)

        # Cross-bucket fallback: when a model's folder was unknown or only guessed weakly
        # (not folder_locked by an authoritative node schema), check all valid registered
        # model buckets in folder_paths so already-installed models in custom buckets
        # (such as models/asr) are never falsely reported as missing.
        if not found_path and not model.get("folder_locked"):
            fp_base = getattr(folder_paths, "base_path", None)
            fp_base_str = fp_base if isinstance(fp_base, str) and fp_base else os.getcwd()
            fp_models = getattr(folder_paths, "models_dir", None)
            fp_models_str = (
                fp_models
                if isinstance(fp_models, str) and fp_models
                else os.path.join(fp_base_str, "models")
            )
            checked_roots = {
                os.path.realpath(os.path.abspath(p))
                for p in search_paths
                if isinstance(p, str) and p
            }
            for bucket in get_registered_model_buckets(models_dir=fp_models_str, folder_paths_mod=folder_paths):
                if bucket == folder_type:
                    continue
                bucket_paths: list[str] = []
                try:
                    raw_paths = folder_paths.get_folder_paths(bucket)
                    if isinstance(raw_paths, (list, tuple, set)):
                        bucket_paths = [p for p in raw_paths if isinstance(p, str) and p]
                except Exception:
                    bucket_paths = []
                default_bucket_dir = os.path.join(fp_models_str, bucket)
                if os.path.isdir(default_bucket_dir) and default_bucket_dir not in bucket_paths:
                    bucket_paths.append(default_bucket_dir)
                candidate_roots = [
                    p
                    for p in bucket_paths
                    if os.path.exists(p) and os.path.realpath(os.path.abspath(p)) not in checked_roots
                ]
                if not candidate_roots:
                    continue
                for p in candidate_roots:
                    checked_roots.add(os.path.realpath(os.path.abspath(p)))
                c_path, c_root = _search_roots_for_model(candidate_roots, bucket)
                if c_path:
                    found_path = c_path
                    found_root = c_root
                    found_bucket = bucket
                    break
        
        if found_path:
            # Calculate relative path to see if it matches the widget value
            try:
                # Get path relative to the *specific* root_path where it was found
                rel_path = os.path.relpath(found_path, found_root)
            except ValueError: # If paths are on different drives, relpath can fail
                rel_path = os.path.basename(found_path) # Fallback to just filename
                
            # Normalize logical relative paths so slash style, duplicate separators,
            # and leading "./" do not create false mismatch reports.
            req_norm = normalize_relative_model_path(requested_path)
            found_norm = normalize_relative_model_path(rel_path)
            
            model_entry = model.copy()
            model_entry["found_path"] = found_path
            model_entry["clean_path"] = rel_path # Path relative to the model type root
            if found_bucket:
                model_entry["suggested_folder"] = found_bucket
                model_entry["actual_folder"] = found_bucket
            
            existing.append(model_entry)
            
            # If the requested filename doesn't match the found relative path, it's a mismatch
            # strict check: "foo.safetensors" vs "subfolder/foo.safetensors"
            if req_norm != found_norm:
                prefix = req_norm[:-len(found_norm)].rstrip("/") if req_norm.endswith(found_norm) else ""
                root_norm = found_root.rstrip("/\\").replace("\\", "/")
                if prefix and (root_norm.endswith("/" + prefix) or root_norm == prefix):
                    model_entry["clean_path"] = req_norm
                else:
                    path_mismatches.append(model_entry)
                 
        else:
            missing.append(model)

    return missing, existing, path_mismatches

def _normalize_hf_search_key(filename: str) -> str:
    return os.path.basename(filename or "").lower()

def _hf_search_allowed() -> bool:
    global _hf_api_calls
    if _hf_rate_limited_until and time.time() < _hf_rate_limited_until:
        return False
    if _hf_search_deadline and time.time() >= _hf_search_deadline:
        global _hf_search_time_exhausted
        _hf_search_time_exhausted = True
        return False
    if _hf_api_calls >= HF_SEARCH_MAX_CALLS:
        return False
    _hf_api_calls += 1
    return True

def _set_hf_rate_limited() -> None:
    global _hf_rate_limited_until
    if _hf_rate_limited_until:
        return
    _hf_rate_limited_until = time.time() + HF_SEARCH_RATE_LIMIT_SECONDS
    print(f"[WARN] Hugging Face rate limit hit; pausing search for {HF_SEARCH_RATE_LIMIT_SECONDS}s.")

def _hf_search_budget_exhausted() -> bool:
    if _hf_rate_limited_until and time.time() < _hf_rate_limited_until:
        return True
    if _hf_api_calls >= HF_SEARCH_MAX_CALLS:
        return True
    return False

def _reset_hf_search_budget() -> None:
    global _hf_api_calls, _hf_search_deadline, _hf_search_time_exhausted
    _hf_api_calls = 0
    _hf_search_deadline = time.time() + HF_SEARCH_MAX_SECONDS if HF_SEARCH_MAX_SECONDS > 0 else 0.0
    _hf_search_time_exhausted = False


HF_FULLTEXT_URL = "https://huggingface.co/api/search/full-text"
_GENERIC_STEMS = {
    "model", "weights", "checkpoint", "ckpt", "lora", "vae", "unet",
    "clip", "text_encoder", "encoder", "diffusion_pytorch_model",
    "pytorch_model", "adapter_model", "consolidated", "ema",
    "fp16", "bf16", "fp8", "fp32", "config", "tokenizer",
}


def _is_generic_hf_filename(filename: str) -> bool:
    base = os.path.basename(str(filename or "")).strip().lower()
    if not base:
        return True
    if base in AMBIGUOUS_REGISTRY_FILENAMES:
        return True
    stem = os.path.splitext(base)[0]
    return stem in _GENERIC_STEMS or len(stem) < 4


def _hf_fulltext_candidate_repos(
    query_text: str,
    token: str | None = None,
    context_terms: list[str] | None = None,
    limit: int = 20,
    allow_generic: bool = False,
) -> list[dict[str, Any]]:
    """
    Query Hugging Face /api/search/full-text for repositories whose README/model card
    mentions the exact filename or query string.
    """
    clean_query = os.path.basename(str(query_text or "").strip()) or str(query_text or "").strip()
    if not clean_query or len(clean_query) < 3:
        return []

    is_generic = _is_generic_hf_filename(clean_query)
    usable_context = [
        str(t).strip()
        for t in (context_terms or [])
        if isinstance(t, str) and len(str(t).strip()) >= 3 and str(t).strip().lower() not in _GENERIC_STEMS
    ]

    if is_generic and not allow_generic:
        if not usable_context:
            return []
        search_q = f'"{clean_query}" "{usable_context[0]}"'
    elif "." in clean_query or "_" in clean_query or "-" in clean_query:
        search_q = f'"{clean_query}"'
    else:
        search_q = clean_query

    if not _hf_search_allowed():
        return []

    url = (
        f"{HF_FULLTEXT_URL}?q={urllib.parse.quote(search_q)}"
        f"&type=model&limit={max(1, min(int(limit or 20), 50))}"
    )
    headers = {"User-Agent": "ComfyUI_HuggingFace_Downloader/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HF_SEARCH_CALL_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            _set_hf_rate_limited()
        return []
    except Exception as e:
        if is_rate_limited_error(e):
            _set_hf_rate_limited()
        return []

    hits = data.get("hits") if isinstance(data, dict) else None
    if not isinstance(hits, list):
        return []

    needle = clean_query.lower()
    seen_repos: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        owner_raw = hit.get("repoOwner")
        owner = owner_raw.get("name") if isinstance(owner_raw, dict) else owner_raw
        repo_name = hit.get("repoName")
        if not isinstance(owner, str) or not isinstance(repo_name, str) or not owner or not repo_name:
            continue
        repo_id = f"{owner}/{repo_name}"
        if repo_id in seen_repos:
            continue

        if "." in needle and not allow_generic:
            formatted = json.dumps(hit.get("formatted") or "", ensure_ascii=False).lower()
            formatted = formatted.replace("<em>", "").replace("</em>", "")
            if needle not in formatted:
                continue

        seen_repos.add(repo_id)
        candidates.append({
            "repo_id": repo_id,
            "likes": int(hit.get("likes") or 0),
        })
    return candidates

def search_huggingface_model(
    filename: str,
    token: str = None,
    status_cb=None,
    mode: str = "full",
    workflow_keywords: list[str] | None = None,
    priority_author_repos: dict[str, list[str]] | None = None,
    skip_priority_repo_scan: bool = False,
    request_id: str = None
) -> Dict[str, Any] | None:
    """
    Searches Hugging Face for the filename, prioritizing specific authors.
    Returns metadata dict with url/hf_repo/hf_path or None.
    """
    if request_id and is_search_cancelled(request_id):
        raise SearchCancelledException("Search cancelled by user")
    if request_id and is_model_skipped(request_id, filename):
        print(f"[DEBUG] Skipping search_huggingface_model for {filename} (model skipped)")
        return None

    token = token or get_token()
    api = HfApi(token=token)

    key = _normalize_hf_search_key(filename)
    if key in _hf_search_cache:
        cached = _hf_search_cache[key]
        if cached is not None:
            print(f"[DEBUG] HF cache hit for {filename}")
            return cached
        if mode == "basic":
            print(f"[DEBUG] HF cache miss for {filename} (basic), skipping")
            return None

    skip_regular_search = False
    if key in HF_SEARCH_SKIP_FILENAMES or _is_generic_hf_filename(filename):
        usable_kw = [
            str(k).strip()
            for k in (workflow_keywords or [])
            if isinstance(k, str) and len(str(k).strip()) >= 3 and str(k).strip().lower() not in _GENERIC_STEMS
        ]
        if not usable_kw:
            print(f"[DEBUG] Skipping HF search for generic filename without context: {filename}")
            _hf_search_cache[key] = None
            return None
        skip_regular_search = True

    if _hf_rate_limited_until and time.time() < _hf_rate_limited_until:
        print(f"[DEBUG] HF search paused due to rate limit; skipping {filename}")
        return None
    if _hf_api_calls >= HF_SEARCH_MAX_CALLS:
        print(f"[DEBUG] HF search budget exhausted; skipping {filename}")
        return None

    if status_cb:
        status_cb({
            "message": "Searching Hugging Face",
            "source": "huggingface_search",
            "filename": filename
        })

    print(f"[DEBUG] Searching HF for: {filename}")

    def add_term(terms: list[str], term: str | None):
        if not term:
            return
        term = term.strip()
        if len(term) < 4 or term in terms:
            return
        terms.append(term)

    def build_search_terms(name: str) -> list[str]:
        stem = os.path.splitext(name)[0]
        terms: list[str] = []
        add_term(terms, name)
        add_term(terms, stem)
        add_term(terms, stem.replace("_", "-"))
        add_term(terms, stem.replace("-", "_"))
        tokens = [t for t in re.split(r"[-_]", stem) if t]
        if len(tokens) >= 2:
            add_term(terms, "-".join(tokens[:2]))
        if len(tokens) >= 3:
            add_term(terms, "-".join(tokens[:3]))
        return terms

    def build_author_search_terms(name: str) -> list[str]:
        terms = build_search_terms(name)
        stem = os.path.splitext(name)[0]
        tokens = [t for t in re.split(r"[-_]", stem) if t]
        for t in tokens:
            alpha = re.sub(r"\d+", "", t).lower()
            add_term(terms, alpha)
        return terms

    stem_lower = os.path.splitext(filename)[0].lower()
    token_hints = []
    for t in re.split(r"[-_]", stem_lower):
        t = t.strip().lower()
        if len(t) >= 3:
            token_hints.append(t)
        alpha = re.sub(r"\d+", "", t)
        if len(alpha) >= 3:
            token_hints.append(alpha)
    token_hints = list(dict.fromkeys(token_hints))
    workflow_hints = []
    if workflow_keywords:
        for t in workflow_keywords:
            t = str(t or "").strip().lower()
            if len(t) >= 3:
                workflow_hints.append(t)
    workflow_hints = list(dict.fromkeys(workflow_hints))

    def _repo_score(model_id: str) -> int:
        mid = model_id.lower()
        score = 0
        if stem_lower and stem_lower in mid:
            score += 100
        for t in token_hints:
            if t and t in mid:
                score += 10
        for t in workflow_hints:
            if t and t in mid:
                score += 6
        return score

    def _workflow_match(model_id: str) -> bool:
        if not workflow_hints:
            return False
        mid = model_id.lower()
        return any(t in mid for t in workflow_hints)

    # 1. Try to search specifically in priority authors' repos first?
    # Actually, listing models by author and filtering is expensive.
    # Better to use the global search and filter results.

    try:
        search_terms = build_search_terms(filename)
        models = []
        if status_cb:
            status_cb({
                "message": "Searching Hugging Face",
                "source": "huggingface_search",
                "filename": filename
            })

        if not skip_regular_search and mode in ("basic", "full"):
            for term in search_terms:
                if not _hf_search_allowed():
                    print(f"[DEBUG] HF search budget/rate limit hit before term search for {filename}")
                    return None
                try:
                    models = list(call_with_timeout(api.list_models, search=term, limit=20, sort="downloads"))
                except concurrent.futures.TimeoutError:
                    if status_cb:
                        status_cb({
                            "message": "Hugging Face search timeout",
                            "source": "huggingface_search",
                            "filename": filename,
                            "detail": f"list_models({term})"
                        })
                    return None
                except Exception as e:
                    if is_timeout_error(e):
                        if status_cb:
                            status_cb({
                                "message": "Hugging Face search timeout",
                                "source": "huggingface_search",
                                "filename": filename,
                                "detail": f"list_models({term})"
                            })
                        return None
                    if is_rate_limited_error(e):
                        _set_hf_rate_limited()
                        if status_cb:
                            status_cb({
                                "message": "Hugging Face rate limit hit",
                                "source": "huggingface_search",
                                "filename": filename,
                                "detail": str(e)
                            })
                        return None
                    raise
                if models:
                    if term != filename:
                        print(f"[DEBUG] No results for {filename}, trying search term: {term}")
                    break

        # Deep Search Fallback: Check priority authors if still nothing
        # This helps when the file is inside a repo like "flux-fp8" but we search for "flux-vae-bf16"
        if not skip_regular_search and mode in ("priority", "full") and not models and not priority_author_repos:
            print(f"[DEBUG] Still no results, checking priority authors directly...")
            if status_cb:
                status_cb({
                    "message": "Checking priority authors",
                    "source": "huggingface_priority_authors",
                    "filename": filename
                })
            author_search_terms = build_author_search_terms(filename)
            total_authors = len(PRIORITY_AUTHORS)
            for author_index, author in enumerate(PRIORITY_AUTHORS, start=1):
                try:
                    found = []
                    if status_cb:
                        status_cb({
                            "message": f"Searching {author}",
                            "source": "huggingface_priority_authors",
                            "filename": filename,
                            "detail": author
                        })
                    for term in author_search_terms:
                        if not _hf_search_allowed():
                            print(f"[DEBUG] HF search budget/rate limit hit before author term search for {filename}")
                            return None
                        try:
                            author_models = list(call_with_timeout(
                                api.list_models,
                                author=author,
                                search=term,
                                limit=15,
                                sort="downloads"
                            ))
                        except concurrent.futures.TimeoutError:
                            if status_cb:
                                status_cb({
                                    "message": "Hugging Face search timeout",
                                    "source": "huggingface_priority_authors",
                                    "filename": filename,
                                    "detail": f"list_models({author}, {term})"
                                })
                            return None
                        except Exception as e:
                            if is_timeout_error(e):
                                if status_cb:
                                    status_cb({
                                        "message": "Hugging Face search timeout",
                                        "source": "huggingface_priority_authors",
                                        "filename": filename,
                                        "detail": f"list_models({author}, {term})"
                                    })
                                return None
                            if is_rate_limited_error(e):
                                _set_hf_rate_limited()
                                if status_cb:
                                    status_cb({
                                        "message": "Hugging Face rate limit hit",
                                        "source": "huggingface_priority_authors",
                                        "filename": filename,
                                        "detail": str(e)
                                    })
                                return None
                            raise
                        if author_models:
                            found.extend(author_models)
                    print(f"[DEBUG] Priority author {author} search returned {len(found)} repos for {filename}")
                    if 0 < len(found) <= 5:
                        try:
                            ids = [m.modelId for m in found]
                            print(f"[DEBUG] Priority author {author} repos for {filename}: {ids}")
                        except Exception:
                            pass
                    if not _hf_search_allowed():
                        print(f"[DEBUG] HF search budget/rate limit hit before author list for {filename}")
                        return None
                    try:
                        author_list = list(call_with_timeout(api.list_models, author=author, limit=100, sort="downloads"))
                    except concurrent.futures.TimeoutError:
                        if status_cb:
                            status_cb({
                                "message": "Hugging Face search timeout",
                                "source": "huggingface_priority_authors",
                                "filename": filename,
                                "detail": f"list_models({author})"
                            })
                        return None
                    except Exception as e:
                        if is_timeout_error(e):
                            if status_cb:
                                status_cb({
                                    "message": "Hugging Face search timeout",
                                    "source": "huggingface_priority_authors",
                                    "filename": filename,
                                    "detail": f"list_models({author})"
                                })
                            return None
                        if is_rate_limited_error(e):
                            _set_hf_rate_limited()
                            if status_cb:
                                status_cb({
                                    "message": "Hugging Face rate limit hit",
                                    "source": "huggingface_priority_authors",
                                    "filename": filename,
                                    "detail": str(e)
                                })
                            return None
                        raise
                    if author_list:
                        author_list = sorted(
                            author_list,
                            key=lambda m: _repo_score(getattr(m, "modelId", "")),
                            reverse=True
                        )
                        found.extend(author_list)
                    print(f"[DEBUG] Priority author {author} list returned {len(author_list)} repos for {filename}")
                    if 0 < len(author_list) <= 5:
                        try:
                            ids = [m.modelId for m in author_list]
                            print(f"[DEBUG] Priority author {author} list repos for {filename}: {ids}")
                        except Exception:
                            pass
                    models.extend(found)
                except Exception:
                    continue
        
        best_match = None
        
        # Deduplicate models list
        seen_ids = set()
        unique_models = []
        for m in models:
            if m.modelId not in seen_ids:
                unique_models.append(m)
                seen_ids.add(m.modelId)
        models = unique_models
        
        def build_result(model_id: str, file_path: str) -> Dict[str, Any]:
            return {
                "url": f"https://huggingface.co/{model_id}/resolve/main/{file_path}",
                "hf_repo": model_id,
                "hf_path": file_path
            }

        priority_repo_ids: list[str] = []
        if priority_author_repos and not skip_priority_repo_scan:
            for author in PRIORITY_AUTHORS:
                priority_repo_ids.extend(priority_author_repos.get(author, []))
        priority_repo_ids = list(dict.fromkeys(priority_repo_ids))
        if priority_repo_ids:
            priority_repo_ids = sorted(
                priority_repo_ids,
                key=lambda rid: (
                    0 if _workflow_match(rid) else 1,
                    -_repo_score(rid)
                )
            )
            if PRIORITY_REPO_SCAN_LIMIT > 0:
                priority_repo_ids = priority_repo_ids[:PRIORITY_REPO_SCAN_LIMIT]

        priority_models: list[Any] = []
        if priority_repo_ids:
            priority_models = [SimpleNamespace(modelId=rid) for rid in priority_repo_ids]
        else:
            priority_models = [
                m for m in models
                if (m.modelId.split("/")[0] if "/" in m.modelId else "") in PRIORITY_AUTHORS
            ]
        priority_models = sorted(
            priority_models,
            key=lambda m: (
                0 if _workflow_match(getattr(m, "modelId", "")) else 1,
                -_repo_score(getattr(m, "modelId", ""))
            )
        )

        for model in priority_models:
            model_id = model.modelId
            # Check if this repo actually has the file
            try:
                files = _get_repo_files(api, model_id, token)
                filename_lower = filename.lower()
                if any(os.path.basename(f).lower() == filename_lower for f in files):
                    match_path = next(
                        (f for f in files if os.path.basename(f).lower() == filename_lower),
                        filename
                    )
                    result = build_result(model_id, match_path)
                    _hf_search_cache[key] = result
                    print(f"[DEBUG] Found {filename} in repo {model_id} (priority author)")
                    if status_cb:
                        status_cb({
                            "message": "Found on Hugging Face",
                            "source": "huggingface_search",
                            "filename": filename,
                            "detail": model_id
                        })
                    return result
                print(f"[DEBUG] {filename} not in repo {model_id} (priority author)")
            except HFSearchBudgetError:
                print(f"[DEBUG] HF search budget/rate limit hit before priority repo scan for {filename}")
                return None
            except concurrent.futures.TimeoutError:
                print(f"[DEBUG] list_repo_files timeout for {model_id} while searching {filename} (priority author)")
                if status_cb:
                    status_cb({
                        "message": "Hugging Face search timeout",
                        "source": "huggingface_search",
                        "filename": filename,
                        "detail": f"list_repo_files({model_id})"
                    })
                continue
            except Exception as e:
                if is_timeout_error(e):
                    print(f"[DEBUG] list_repo_files timeout for {model_id} while searching {filename} (priority author)")
                    if status_cb:
                        status_cb({
                            "message": "Hugging Face search timeout",
                            "source": "huggingface_search",
                            "filename": filename,
                            "detail": f"list_repo_files({model_id})"
                        })
                    continue
                continue

        # If no priority author found, check the rest of the results
        priority_ids = {m.modelId for m in priority_models}
        other_models = [m for m in models if m.modelId not in priority_ids]
        other_workflow = [m for m in other_models if _workflow_match(getattr(m, "modelId", ""))]
        other_workflow = sorted(
            other_workflow,
            key=lambda m: -_repo_score(getattr(m, "modelId", ""))
        )
        other_rest = [m for m in other_models if m not in other_workflow]
        other_rest = sorted(
            other_rest,
            key=lambda m: -_repo_score(getattr(m, "modelId", ""))
        )

        for model in other_workflow:
            model_id = model.modelId
            try:
                files = _get_repo_files(api, model_id, token)
                filename_lower = filename.lower()
                if any(os.path.basename(f).lower() == filename_lower for f in files):
                    match_path = next(
                        (f for f in files if os.path.basename(f).lower() == filename_lower),
                        filename
                    )
                    result = build_result(model_id, match_path)
                    _hf_search_cache[key] = result
                    print(f"[DEBUG] Found {filename} in repo {model_id}")
                    if status_cb:
                        status_cb({
                            "message": "Found on Hugging Face",
                            "source": "huggingface_search",
                            "filename": filename,
                            "detail": model_id
                        })
                    return result
                print(f"[DEBUG] {filename} not in repo {model_id}")
            except HFSearchBudgetError:
                print(f"[DEBUG] HF search budget/rate limit hit before workflow repo scan for {filename}")
                return None
            except concurrent.futures.TimeoutError:
                if status_cb:
                    status_cb({
                        "message": "Hugging Face search timeout",
                        "source": "huggingface_search",
                        "filename": filename,
                        "detail": f"list_repo_files({model_id})"
                    })
                continue
            except Exception as e:
                if is_timeout_error(e):
                    if status_cb:
                        status_cb({
                            "message": "Hugging Face search timeout",
                            "source": "huggingface_search",
                            "filename": filename,
                            "detail": f"list_repo_files({model_id})"
                        })
                    continue
                continue

        for model in other_rest:
            model_id = model.modelId
            try:
                files = _get_repo_files(api, model_id, token)
                filename_lower = filename.lower()
                if any(os.path.basename(f).lower() == filename_lower for f in files):
                    match_path = next(
                        (f for f in files if os.path.basename(f).lower() == filename_lower),
                        filename
                    )
                    result = build_result(model_id, match_path)
                    _hf_search_cache[key] = result
                    print(f"[DEBUG] Found {filename} in repo {model_id}")
                    if status_cb:
                        status_cb({
                            "message": "Found on Hugging Face",
                            "source": "huggingface_search",
                            "filename": filename,
                            "detail": model_id
                        })
                    return result
                print(f"[DEBUG] {filename} not in repo {model_id}")
            except HFSearchBudgetError:
                print(f"[DEBUG] HF search budget/rate limit hit before repo scan for {filename}")
                return None
            except concurrent.futures.TimeoutError:
                if status_cb:
                    status_cb({
                        "message": "Hugging Face search timeout",
                        "source": "huggingface_search",
                        "filename": filename,
                        "detail": f"list_repo_files({model_id})"
                    })
                continue
            except Exception as e:
                if is_timeout_error(e):
                    if status_cb:
                        status_cb({
                            "message": "Hugging Face search timeout",
                            "source": "huggingface_search",
                            "filename": filename,
                            "detail": f"list_repo_files({model_id})"
                        })
                    continue
                continue

        # Final fallback: scan priority authors more broadly if nothing matched
        if not skip_regular_search and mode in ("priority", "full") and not priority_author_repos:
            for author in PRIORITY_AUTHORS:
                try:
                    if not _hf_search_allowed():
                        return None
                    author_models = list(call_with_timeout(api.list_models, author=author, limit=100, sort="downloads"))
                except concurrent.futures.TimeoutError:
                    if status_cb:
                        status_cb({
                            "message": "Hugging Face search timeout",
                            "source": "huggingface_priority_authors",
                            "filename": filename,
                            "detail": f"list_models({author})"
                        })
                    return None
                except Exception as e:
                    if is_timeout_error(e):
                        if status_cb:
                            status_cb({
                                "message": "Hugging Face search timeout",
                                "source": "huggingface_priority_authors",
                                "filename": filename,
                                "detail": f"list_models({author})"
                            })
                        return None
                        if is_rate_limited_error(e):
                            _set_hf_rate_limited()
                            if status_cb:
                                status_cb({
                                    "message": "Hugging Face rate limit hit",
                                    "source": "huggingface_priority_authors",
                                    "filename": filename,
                                    "detail": str(e)
                                })
                        return None
                        continue
                print(f"[DEBUG] Priority author final list for {author}: {len(author_models)} repos for {filename}")
                for model in author_models:
                    model_id = model.modelId
                    try:
                        files = _get_repo_files(api, model_id, token)
                        filename_lower = filename.lower()
                        if any(os.path.basename(f).lower() == filename_lower for f in files):
                            match_path = next(
                                (f for f in files if os.path.basename(f).lower() == filename_lower),
                                filename
                            )
                            result = build_result(model_id, match_path)
                            _hf_search_cache[key] = result
                            print(f"[DEBUG] Found {filename} in repo {model_id} (priority author final)")
                            if status_cb:
                                status_cb({
                                    "message": "Found on Hugging Face",
                                    "source": "huggingface_search",
                                    "filename": filename,
                                    "detail": model_id
                                })
                            return result
                        print(f"[DEBUG] {filename} not in repo {model_id} (priority author final)")
                    except HFSearchBudgetError:
                        print(f"[DEBUG] HF search budget/rate limit hit before priority repo scan for {filename}")
                        return None
                    except concurrent.futures.TimeoutError:
                        print(f"[DEBUG] list_repo_files timeout for {model_id} while searching {filename} (priority author final)")
                        if status_cb:
                            status_cb({
                                "message": "Hugging Face search timeout",
                                "source": "huggingface_priority_authors",
                                "filename": filename,
                                "detail": f"list_repo_files({model_id})"
                            })
                        continue
                    except Exception as e:
                        if is_timeout_error(e):
                            print(f"[DEBUG] list_repo_files timeout for {model_id} while searching {filename} (priority author final)")
                            if status_cb:
                                status_cb({
                                    "message": "Hugging Face search timeout",
                                    "source": "huggingface_priority_authors",
                                    "filename": filename,
                                    "detail": f"list_repo_files({model_id})"
                                })
                            continue
                        if is_rate_limited_error(e):
                            _set_hf_rate_limited()
                            if status_cb:
                                status_cb({
                                    "message": "Hugging Face rate limit hit",
                                    "source": "huggingface_priority_authors",
                                    "filename": filename,
                                    "detail": str(e)
                                })
                            return None
                        continue
                 
    except Exception as e:
        if is_rate_limited_error(e):
            _set_hf_rate_limited()
            if status_cb:
                status_cb({
                    "message": "Hugging Face rate limit hit",
                    "source": "huggingface_search",
                    "filename": filename,
                    "detail": str(e)
                })
        else:
            print(f"[ERROR] check_huggingface failed: {e}")
            if status_cb:
                status_cb({
                    "message": "Hugging Face search error",
                    "source": "huggingface_search",
                    "filename": filename,
                    "detail": str(e)
                })

    if _hf_rate_limited_until and time.time() < _hf_rate_limited_until:
        return None

    # Full-text README fallback: HF has no global file-name index, so search repos
    # whose README mentions this exact filename, then verify via list_repo_files.
    try:
        if status_cb:
            status_cb({
                "message": "Searching Hugging Face by file name",
                "source": "huggingface_fulltext",
                "filename": filename,
            })
        ft_candidates = _hf_fulltext_candidate_repos(
            filename,
            token=token,
            context_terms=workflow_hints,
            limit=20,
        )
        if ft_candidates:
            priority_lower = {a.lower() for a in PRIORITY_AUTHORS}

            def _ft_rank(cand: dict[str, Any]) -> tuple[int, int, int, int]:
                rid = cand["repo_id"]
                owner = rid.split("/", 1)[0].lower() if "/" in rid else ""
                is_prio = 1 if owner in priority_lower else 0
                wf_match = 1 if _workflow_match(rid) else 0
                return (is_prio, wf_match, _repo_score(rid), int(cand.get("likes") or 0))

            ft_candidates.sort(key=_ft_rank, reverse=True)
            filename_lower = filename.lower()
            for cand in ft_candidates[:5]:
                if request_id and is_search_cancelled(request_id):
                    raise SearchCancelledException("Search cancelled by user")
                rid = cand["repo_id"]
                try:
                    files = _get_repo_files(api, rid, token)
                except HFSearchBudgetError:
                    return None
                except Exception:
                    continue
                match_path = next(
                    (f for f in files if os.path.basename(f).lower() == filename_lower),
                    None,
                )
                if match_path:
                    result = {
                        "url": f"https://huggingface.co/{rid}/resolve/main/{match_path}",
                        "hf_repo": rid,
                        "hf_path": match_path,
                    }
                    _hf_search_cache[key] = result
                    print(f"[DEBUG] Found {filename} in repo {rid} via HF full-text fallback")
                    if status_cb:
                        status_cb({
                            "message": "Found on Hugging Face",
                            "source": "huggingface_fulltext",
                            "filename": filename,
                            "detail": rid,
                        })
                    return result
    except SearchCancelledException:
        raise
    except Exception as e:
        print(f"[DEBUG] HF full-text fallback failed for {filename}: {e}")

    if _hf_rate_limited_until and time.time() < _hf_rate_limited_until:
        return None

    if mode != "basic":
        _hf_search_cache[key] = None
    return None


def search_huggingface_variants(
    query: str,
    category: str | None = None,
    limit: int = 15,
    token: str | None = None,
) -> list[dict[str, Any]]:
    """
    Search Hugging Face globally for downloadable model files matching a query
    (used by Model Explorer 'Search on Hugging Face').
    Combines full-text README search and repository search, verifies actual files
    in top candidate repositories, and ranks originals/priority authors first.
    """
    clean_query = str(query or "").strip()
    if len(clean_query) < 2:
        return []

    _reset_hf_search_budget()
    token = token or get_token()
    api = HfApi(token=token)
    priority_lower = {a.lower() for a in PRIORITY_AUTHORS}

    candidate_map: dict[str, dict[str, Any]] = {}

    def _add_candidate(repo_id: str, likes: int = 0, downloads: int = 0, from_fulltext: bool = False):
        rid = str(repo_id or "").strip()
        if not rid or "/" not in rid:
            return
        existing = candidate_map.get(rid)
        if existing is None:
            candidate_map[rid] = {
                "repo_id": rid,
                "likes": int(likes or 0),
                "downloads": int(downloads or 0),
                "from_fulltext": from_fulltext,
            }
        else:
            existing["likes"] = max(existing["likes"], int(likes or 0))
            existing["downloads"] = max(existing["downloads"], int(downloads or 0))
            existing["from_fulltext"] = existing["from_fulltext"] or from_fulltext

    # Direct owner/repo query support
    if "/" in clean_query and " " not in clean_query and clean_query.count("/") == 1:
        _add_candidate(clean_query, likes=1000, from_fulltext=True)

    # 1. Full-text search (finds exact filenames inside READMEs)
    ft_hits = _hf_fulltext_candidate_repos(clean_query, token=token, limit=15, allow_generic=True)
    for hit in ft_hits:
        _add_candidate(hit["repo_id"], likes=hit.get("likes", 0), from_fulltext=True)

    # Build expanded search terms (same strategy as search_huggingface_model)
    stem = os.path.splitext(clean_query)[0]
    tokens = [t for t in re.split(r"[-_.\s/]+", stem) if t]
    search_terms: list[str] = []
    for cand_term in [
        clean_query,
        stem,
        stem.replace("_", "-"),
        stem.replace("-", "_"),
        "-".join(tokens[:3]) if len(tokens) >= 3 else "",
        "-".join(tokens[:2]) if len(tokens) >= 2 else "",
    ]:
        t = str(cand_term or "").strip()
        if len(t) >= 2 and t not in search_terms:
            search_terms.append(t)

    # 2. Standard Hugging Face repository search (multi-term expansion)
    list_models_added = 0
    for term in search_terms[:4]:
        if not _hf_search_allowed() or list_models_added >= 6:
            break
        try:
            models = list(call_with_timeout(api.list_models, search=term, limit=20, sort="downloads"))
            for m in models:
                rid = getattr(m, "modelId", None) or getattr(m, "id", None)
                if rid:
                    was_new = str(rid).strip() not in candidate_map
                    _add_candidate(
                        rid,
                        likes=int(getattr(m, "likes", 0) or 0),
                        downloads=int(getattr(m, "downloads", 0) or 0),
                    )
                    if was_new:
                        list_models_added += 1
        except Exception:
            continue

    # 3. Priority authors fallback when fewer than 3 priority-author candidates exist
    prio_count = sum(
        1 for rid in candidate_map
        if rid.split("/", 1)[0].lower() in priority_lower
    )
    if prio_count < 3 and _hf_search_allowed():
        author_term = "-".join(tokens[:2]) if len(tokens) >= 2 else (stem or clean_query)
        for author in PRIORITY_AUTHORS[:8]:
            if not _hf_search_allowed():
                break
            try:
                models = list(call_with_timeout(api.list_models, author=author, search=author_term, limit=5))
                for m in models:
                    rid = getattr(m, "modelId", None) or getattr(m, "id", None)
                    if rid:
                        _add_candidate(
                            rid,
                            likes=int(getattr(m, "likes", 0) or 0),
                            downloads=int(getattr(m, "downloads", 0) or 0),
                        )
            except Exception:
                continue

    if not candidate_map:
        return []

    q_lower = clean_query.lower()
    q_stem = os.path.splitext(q_lower)[0]
    q_tokens = [t for t in re.split(r"[-_.\s/]+", q_stem) if len(t) >= 2]

    def _repo_rank(cand: dict[str, Any]) -> tuple[int, int, int, int, int]:
        rid = cand["repo_id"]
        rid_lower = rid.lower()
        owner = rid_lower.split("/", 1)[0]
        is_prio = 1 if owner in priority_lower else 0
        exact_repo = 1 if (
            q_lower in rid_lower
            or (q_stem and q_stem in rid_lower)
            or (q_tokens and all(tok in rid_lower for tok in q_tokens))
        ) else 0
        ft_bonus = 1 if cand.get("from_fulltext") else 0
        return (is_prio, exact_repo, ft_bonus, cand.get("likes", 0), cand.get("downloads", 0))

    sorted_candidates = sorted(candidate_map.values(), key=_repo_rank, reverse=True)

    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    target_category = str(category or "").strip()
    if target_category in {"", "all", "other", "__other__"}:
        target_category = ""

    collect_cap = max(limit * 2, limit)
    for cand in sorted_candidates[:16]:
        if len(results) >= collect_cap or not _hf_search_allowed():
            break
        rid = cand["repo_id"]
        try:
            files = _get_repo_files(api, rid, token)
        except Exception:
            continue

        model_files = [
            f for f in files
            if os.path.splitext(f)[1].lower() in MODEL_EXTENSIONS
        ]
        if not model_files:
            continue

        # Prefer exact basename, then substring matches, then token matches, then repo name matches
        exact_basename = [f for f in model_files if os.path.basename(f).lower() == q_lower]
        exact_matches = [f for f in model_files if q_lower in f.lower() and f not in exact_basename]
        token_matches = [
            f for f in model_files
            if q_tokens and all(tok in f.lower() for tok in q_tokens)
        ] if (not exact_basename and not exact_matches) else []
        repo_matches = (
            model_files[:6]
            if (
                not exact_basename
                and not exact_matches
                and not token_matches
                and (
                    (q_stem and q_stem in rid.lower())
                    or (q_tokens and all(tok in rid.lower() for tok in q_tokens))
                )
            )
            else []
        )

        picked = (exact_basename + exact_matches) or token_matches or repo_matches
        if not picked:
            continue

        owner = rid.split("/", 1)[0].lower()
        is_prio = owner in priority_lower
        for hf_path in picked[:6]:
            if len(results) >= collect_cap:
                break
            fn = os.path.basename(hf_path)
            url = f"https://huggingface.co/{rid}/resolve/main/{hf_path}"
            if url in seen_urls:
                continue
            seen_urls.add(url)
            folder = target_category or _guess_folder_from_filename(fn) or "checkpoints"
            results.append({
                "filename": fn,
                "hf_path": hf_path,
                "repo_id": rid,
                "url": url,
                "directory": folder,
                "likes": cand.get("likes", 0),
                "downloads": cand.get("downloads", 0),
                "is_priority_author": is_prio,
            })

    results.sort(
        key=lambda r: (
            1 if str(r.get("filename") or "").lower() == q_lower else 0,
            1 if r.get("is_priority_author") else 0,
            1 if q_lower in str(r.get("filename") or "").lower() else 0,
            int(r.get("likes") or 0),
            int(r.get("downloads") or 0),
        ),
        reverse=True,
    )
    return results[:limit]

def process_workflow_for_missing_models(workflow_json: Dict[str, Any], status_cb=None) -> Dict[str, Any]:
    """
    Main entry point.
    1. Parse workflow.
    2. Check local models.
    3. If missing, search HF.
    """
    request_id = workflow_json.get("request_id")
    def _check_cancelled():
        if request_id and is_search_cancelled(request_id):
            raise SearchCancelledException("Search cancelled by user")

    _check_cancelled()
    
    global _hf_api_calls, _hf_search_deadline, _hf_search_time_exhausted, _hf_rate_limited_until, _hf_repo_files_cache
    _hf_api_calls = 0
    _hf_search_deadline = 0.0
    _hf_search_time_exhausted = False
    _hf_rate_limited_until = None
    _hf_repo_files_cache = {}
    prefilled_missing_models = workflow_json.get("prefilled_missing_models")

    def _normalize_prefilled_missing_models(prefilled_items: Any) -> list[dict]:
        normalized_items: list[dict] = []
        if not isinstance(prefilled_items, list):
            return normalized_items

        for item in prefilled_items:
            if not isinstance(item, dict):
                continue
            filename = os.path.basename(
                str(
                    item.get("filename")
                    or item.get("name")
                    or item.get("requested_path")
                    or ""
                ).replace("\\", "/")
            ).strip()
            if not filename:
                continue

            requested_path = str(item.get("requested_path") or filename).strip() or filename
            node_title = str(item.get("node_title") or item.get("nodeType") or "").strip()
            node_type = str(item.get("node_type") or item.get("nodeType") or "").strip()
            input_name = str(item.get("input_name") or item.get("widgetName") or "").strip()
            raw_folder = str(
                item.get("suggested_folder")
                or item.get("directory")
                or item.get("folder")
                or ""
            ).strip()
            resolved_folder = None
            if not raw_folder or raw_folder == "checkpoints":
                resolved_folder = resolve_node_folder_for_widget(
                    {"type": node_type or node_title, "title": node_title or node_type},
                    widget_index=None,
                    widget_name=input_name or None,
                    widget_value=filename,
                )
            suggested_folder = (
                (resolved_folder if resolved_folder and resolved_folder != "checkpoints" else None)
                or raw_folder
                or resolved_folder
                or "checkpoints"
            )
            node_id = item.get("node_id") if item.get("node_id") is not None else item.get("nodeId")
            normalized_items.append({
                "filename": filename,
                "requested_path": requested_path,
                "suggested_folder": suggested_folder,
                "directory": suggested_folder,
                "node_id": node_id,
                "node_title": node_title,
                "node_type": node_type,
                "input_name": input_name,
                "url": str(item.get("url") or "").strip(),
                "hash": str(item.get("hash") or "").strip(),
                "hash_type": str(item.get("hash_type") or item.get("hashType") or "").strip(),
                "source": str(item.get("source") or "frontend_missing_model_store").strip() or "frontend_missing_model_store",
            })
        return normalized_items

    def _merge_prefilled_metadata_into_model(existing: dict, incoming: dict) -> None:
        if not isinstance(existing, dict) or not isinstance(incoming, dict):
            return

        if incoming.get("url") and not existing.get("url"):
            existing["url"] = incoming.get("url")
            if incoming.get("source") and not existing.get("source"):
                existing["source"] = incoming.get("source")

        for key in ("hash", "hash_type", "input_name"):
            if incoming.get(key) and not existing.get(key):
                existing[key] = incoming.get(key)

        for key in ("node_title", "node_type"):
            if incoming.get(key) and not existing.get(key):
                existing[key] = incoming.get(key)

        if incoming.get("requested_path") and not existing.get("requested_path"):
            existing["requested_path"] = incoming.get("requested_path")

        incoming_folder = str(incoming.get("suggested_folder") or "").strip()
        existing_folder = str(existing.get("suggested_folder") or "").strip()
        if incoming_folder and (
            not existing_folder
            or (existing_folder == "checkpoints" and incoming_folder != "checkpoints")
        ):
            existing["suggested_folder"] = incoming_folder
            existing["directory"] = incoming_folder

    def _merge_prefilled_missing_models(
        existing_models: list[dict],
        prefilled_items: list[dict]
    ) -> list[dict]:
        if not prefilled_items:
            return existing_models

        def _store_unique_match(index: dict, key: tuple | str, model: dict) -> None:
            if not key:
                return
            current = index.get(key)
            if current is None:
                index[key] = model
            elif current is not model:
                index[key] = False

        by_node_and_path: dict[tuple[str, str], dict | bool] = {}
        by_node_and_filename: dict[tuple[str, str], dict | bool] = {}
        by_path: dict[str, dict | bool] = {}

        for model in existing_models:
            if not isinstance(model, dict):
                continue
            requested_norm = normalize_relative_model_path(model.get("requested_path") or model.get("filename"))
            filename_key = normalize_filename_key(model.get("filename") or requested_norm)
            node_key = str(model.get("node_id")).strip() if model.get("node_id") is not None else ""

            if node_key and requested_norm:
                _store_unique_match(by_node_and_path, (node_key, requested_norm), model)
            if node_key and filename_key:
                _store_unique_match(by_node_and_filename, (node_key, filename_key), model)
            if requested_norm:
                _store_unique_match(by_path, requested_norm, model)

        remaining_prefilled: list[dict] = []
        for item in prefilled_items:
            if not isinstance(item, dict):
                continue

            requested_norm = normalize_relative_model_path(item.get("requested_path") or item.get("filename"))
            filename_key = normalize_filename_key(item.get("filename") or requested_norm)
            node_key = str(item.get("node_id")).strip() if item.get("node_id") is not None else ""

            match = None
            if node_key and requested_norm:
                candidate = by_node_and_path.get((node_key, requested_norm))
                if candidate not in (None, False):
                    match = candidate
            if match is None and node_key and filename_key:
                candidate = by_node_and_filename.get((node_key, filename_key))
                if candidate not in (None, False):
                    match = candidate
            if match is None and requested_norm:
                candidate = by_path.get(requested_norm)
                if candidate not in (None, False):
                    match = candidate

            if match is not None:
                _merge_prefilled_metadata_into_model(match, item)
                continue

            remaining_prefilled.append(item)

        if remaining_prefilled:
            existing_models.extend(remaining_prefilled)
        return existing_models

    required_models = extract_models_from_workflow(workflow_json)
    if prefilled_missing_models:
        required_models = _merge_prefilled_missing_models(
            required_models,
            _normalize_prefilled_missing_models(prefilled_missing_models)
        )

    # Trace upstream connections to inject URLs if a node is connected to a Hugging Face Download Model node
    try:
        links_map = {}
        nodes_by_id = {}
        
        def collect_nodes_and_links(graph):
            if not isinstance(graph, dict):
                return
            for node in graph.get("nodes", []):
                if isinstance(node, dict) and "id" in node:
                    nodes_by_id[node["id"]] = node
            for link in graph.get("links", []):
                if isinstance(link, list) and len(link) >= 5:
                    link_id = link[0]
                    origin_node_id = link[1]
                    target_node_id = link[3]
                    links_map[link_id] = (origin_node_id, target_node_id)
            
            # Recurse subgraphs inside definitions
            defs = graph.get("definitions", {})
            if isinstance(defs, dict):
                subgraphs = defs.get("subgraphs", [])
                if isinstance(subgraphs, list):
                    for sg in subgraphs:
                        collect_nodes_and_links(sg)
                elif isinstance(subgraphs, dict):
                    for sg in subgraphs.values():
                        collect_nodes_and_links(sg)
        
        collect_nodes_and_links(workflow_json)

        for model in required_models:
            if model.get("url"):
                continue
            
            node_id_str = str(model.get("node_id") or "")
            # Handle possible prefix like "prefix:node_id"
            raw_node_id_str = node_id_str.split(":")[-1]
            try:
                node_id = int(raw_node_id_str)
            except ValueError:
                continue

            node = nodes_by_id.get(node_id)
            if not node:
                continue

            input_name = model.get("input_name")
            if not input_name:
                continue

            # Look for linked inputs on this node
            inputs = node.get("inputs", [])
            for inp in inputs:
                if not isinstance(inp, dict):
                    continue
                inp_name = inp.get("name")
                widget_map = inp.get("widget")
                w_name = widget_map.get("name") if isinstance(widget_map, dict) else (widget_map if isinstance(widget_map, str) else None)
                
                # Check if it matches input_name or widget name
                if inp_name == input_name or w_name == input_name:
                    link_id = inp.get("link")
                    if link_id in links_map:
                        upstream_id, _ = links_map[link_id]
                        upstream_node = nodes_by_id.get(upstream_id)
                        if upstream_node and upstream_node.get("type") == "Hugging Face Download Model":
                            u_widgets = upstream_node.get("widgets_values", [])
                            if isinstance(u_widgets, list) and len(u_widgets) >= 2:
                                folder = str(u_widgets[0]).strip()
                                if folder == "custom":
                                    custom_path = u_widgets[1] if len(u_widgets) >= 2 else None
                                    url = u_widgets[2] if len(u_widgets) >= 3 else None
                                else:
                                    custom_path = None
                                    url = u_widgets[1] if len(u_widgets) >= 2 else None

                                if isinstance(url, str) and url.startswith("http"):
                                    model["url"] = url
                                    # Update suggested_folder from the downloader node if custom path is set
                                    if custom_path and isinstance(custom_path, str) and custom_path.strip():
                                        normalized_custom = custom_path.replace("\\", "/").strip("/")
                                        if normalized_custom:
                                            custom_segments = [seg for seg in normalized_custom.split("/") if seg]
                                            if custom_segments:
                                                model["suggested_folder"] = custom_segments[0]
                                                model["directory"] = custom_segments[0]
                                                model["folder_locked"] = True
                                                model["locked_folder"] = normalized_custom
                                                if len(custom_segments) > 1:
                                                    filename = url.split("/")[-1].split("?")[0]
                                                    model["requested_path"] = "/".join(custom_segments[1:] + [filename])
                                    elif folder and folder != "custom":
                                        normalized_folder = folder.replace("\\", "/").strip("/")
                                        if normalized_folder:
                                            model["suggested_folder"] = normalized_folder
                                            model["directory"] = normalized_folder
                                            model["folder_locked"] = True
                                            model["locked_folder"] = normalized_folder
    except Exception as trace_err:
        print(f"[ERROR] Failed to trace upstream links for model URLs: {trace_err}")

    enforce_authoritative_node_folders(required_models)

    def _normalize_dedupe_path(value: str | None) -> str:
        if not value:
            return ""
        return value.replace("\\", "/").strip("/")

    def _score_entry(entry: dict) -> int:
        score = 0
        if entry.get("url"):
            score += 10
        node_label = " ".join(
            str(entry.get(field) or "")
            for field in ("node_title", "node_type")
        ).lower()
        if "hugging face download model" in node_label:
            score += 5
        requested_path = _normalize_dedupe_path(entry.get("requested_path"))
        if "/" in requested_path:
            score += 4
        if entry.get("suggested_folder"):
            score += 2
        if entry.get("origin") != "proxy_widget":
            score += 1
        return score

    def _variant_group_key(entry: dict) -> tuple[Any, str, str] | None:
        filename = (entry.get("filename") or "").strip()
        if not filename:
            return None
        normalized_name = os.path.basename(filename.replace("\\", "/")).lower()
        stem, ext = os.path.splitext(normalized_name)
        canonical_stem = canonicalize_model_base(normalized_name) or stem
        folder_key = _normalize_dedupe_path(entry.get("suggested_folder"))
        return (entry.get("node_id"), folder_key, f"{canonical_stem}{ext}")

    def _prefer_entry_for_variant_group(entry: dict) -> tuple[int, int, int]:
        filename = (entry.get("filename") or "").lower()
        non_quant_bonus = 1 if filename and not is_quant_variant_filename(filename) else 0
        return (
            _score_entry(entry),
            non_quant_bonus,
            len(_normalize_dedupe_path(entry.get("requested_path")))
        )

    # Within a single node/folder, quantized and non-quantized variants of the same
    # canonical filename should be treated as one model requirement. This prevents
    # duplicate rows like `clip_vision_h.safetensors` + `clip_vision_h_fp16.safetensors`
    # and preserves widget-path auto-fix after download.
    variant_groups: dict[tuple[Any, str, str], list[dict]] = {}
    passthrough_models: list[dict] = []
    for model in required_models:
        key = _variant_group_key(model)
        if key is None:
            passthrough_models.append(model)
            continue
        variant_groups.setdefault(key, []).append(model)

    coalesced_models: list[dict] = list(passthrough_models)
    for group in variant_groups.values():
        if len(group) == 1:
            coalesced_models.append(group[0])
            continue

        best = max(group, key=_prefer_entry_for_variant_group)
        merged = dict(best)

        if not merged.get("url"):
            for candidate in group:
                if candidate.get("url"):
                    merged["url"] = candidate.get("url")
                    if candidate.get("source"):
                        merged["source"] = candidate.get("source")
                    break

        if not merged.get("suggested_folder"):
            for candidate in group:
                if candidate.get("suggested_folder"):
                    merged["suggested_folder"] = candidate.get("suggested_folder")
                    break

        requested_candidates = []
        for candidate in group:
            requested = candidate.get("requested_path")
            normalized = _normalize_dedupe_path(requested)
            if normalized:
                requested_candidates.append((requested, normalized))

        if requested_candidates:
            target_name = (merged.get("filename") or "").lower()
            requested_candidates.sort(key=lambda item: len(item[1]), reverse=True)

            preferred_requested = None
            for original, normalized in requested_candidates:
                basename = os.path.basename(normalized).lower()
                if basename and basename != target_name:
                    preferred_requested = original
                    break

            if not preferred_requested:
                preferred_requested = requested_candidates[0][0]

            merged["requested_path"] = preferred_requested

        coalesced_models.append(merged)

    required_models = coalesced_models

    # Collapse duplicates within the same node+filename scope, preferring entries
    # with richer path/folder info. Do not collapse across different nodes.
    grouped_by_name = {}
    for model in required_models:
        filename = (model.get("filename") or "").lower()
        if not filename:
            continue
        node_id = model.get("node_id")
        grouped_by_name.setdefault((node_id, filename), []).append(model)

    deduped = []
    for _, models in grouped_by_name.items():
        folder_groups = {}
        for model in models:
            folder_key = _normalize_dedupe_path(model.get("suggested_folder"))
            folder_groups.setdefault(folder_key, []).append(model)

        # If we have folder-specific entries, drop ambiguous ones without a folder.
        if len(folder_groups) > 1 and "" in folder_groups:
            del folder_groups[""]

        for group in folder_groups.values():
            best = group[0]
            best_score = _score_entry(best)
            for candidate in group[1:]:
                cand_score = _score_entry(candidate)
                if cand_score > best_score:
                    best = candidate
                    best_score = cand_score
                elif cand_score == best_score:
                    # Tie-breaker: prefer longer requested_path (keeps subfolder info).
                    if len(_normalize_dedupe_path(candidate.get("requested_path"))) > len(_normalize_dedupe_path(best.get("requested_path"))):
                        best = candidate
                        best_score = cand_score
            deduped.append(best)

    required_models = deduped

    # Normalize Nunchaku SVDQ precision before local presence checks.
    # Avoid probing torch/CUDA unless the workflow actually references Nunchaku SVDQ names,
    # otherwise the first scan of an ordinary workflow pays a large cold-start cost.
    needs_nunchaku_precision = any(
        _is_nunchaku_svdq_name(model.get("filename"))
        for model in required_models
    )
    preferred_nunchaku_precision = _preferred_nunchaku_precision() if needs_nunchaku_precision else None
    for model in required_models:
        current_name = model.get("filename")
        if not _is_nunchaku_svdq_name(current_name):
            continue
        target_name = _swap_nunchaku_precision(current_name, preferred_nunchaku_precision)
        if not target_name or target_name == current_name:
            continue

        # Keep original requested path so mismatch reporting can still point to the workflow value.
        if not model.get("requested_path"):
            model["requested_path"] = current_name

        model["filename"] = target_name
        model["nunchaku_precision"] = preferred_nunchaku_precision
        model["source"] = "nunchaku_precision_adjusted"

        # Drop stale URL metadata tied to the incompatible precision.
        model.pop("url", None)
        model.pop("hf_repo", None)
        model.pop("hf_path", None)

        print(
            f"[DEBUG] Pre-check Nunchaku precision adjusted: {current_name} -> {target_name} "
            f"({preferred_nunchaku_precision})"
        )

    # Apply registry-based folder hints before local presence checks.
    # This auto-corrects generic fallbacks (e.g. checkpoints) across any node pack.
    apply_known_directory_hints(required_models)

    # Remove duplicates based on filename and node_id to avoid redundant checks for the same model in the same node
    # However, if a model is referenced by multiple nodes, we want to keep those distinct entries
    unique_required_models = []
    seen_model_node_pairs = set()
    for model in required_models:
        key = (model["filename"], model["node_id"])
        if key not in seen_model_node_pairs:
            unique_required_models.append(model)
            seen_model_node_pairs.add(key)
    
    # Collect workflow-wide keywords to bias repo ordering.
    keyword_counts: dict[str, int] = {}
    for model in required_models:
        name = os.path.splitext(model.get("filename") or "")[0].lower()
        if not name:
            continue
        for t in re.split(r"[-_]", name):
            t = t.strip().lower()
            if len(t) < 3:
                continue
            keyword_counts[t] = keyword_counts.get(t, 0) + 1
            alpha = re.sub(r"\d+", "", t)
            if len(alpha) >= 3:
                keyword_counts[alpha] = keyword_counts.get(alpha, 0) + 1
    workflow_keywords = [k for k, _ in sorted(keyword_counts.items(), key=lambda kv: kv[1], reverse=True)[:10]]

    # 1. Check local existence using ComfyUI's folder_paths
    missing_models, existing_models, path_mismatches = check_model_files(unique_required_models)

    # 2. Enrich any workflow-provided URLs with source + HF metadata
    for model in missing_models:
        current_url = model.get("url")
        if current_url and not is_specific_model_file_url(current_url):
            print(
                f"[DEBUG] Ignoring non-file workflow URL for {model.get('filename')}: {current_url}"
            )
            model.pop("url", None)
            model.pop("hf_repo", None)
            model.pop("hf_path", None)
            if model.get("source") == "note":
                model["note"] = "Ignored non-file note URL"

        if model.get("url") and not model.get("source"):
            model["source"] = "workflow_metadata"
        if model.get("url") and not model.get("hf_repo"):
            hf_repo, hf_path = extract_hf_repo_and_path(model.get("url", ""))
            if hf_repo and hf_path:
                model["hf_repo"] = hf_repo
                model["hf_path"] = hf_path

    # 2b. If a requested path includes subfolders, use that for download destination
    for model in missing_models:
        if model.get("folder_locked") and model.get("locked_folder"):
            continue
        requested_path = model.get("requested_path")
        if not requested_path:
            continue
        normalized = normalize_relative_model_path(requested_path)
        if "/" not in normalized:
            continue
        subfolder = "/".join(normalized.split("/")[:-1])
        if not subfolder:
            continue
        base_folder = model.get("suggested_folder") or "checkpoints"
        if not base_folder.replace("\\", "/").endswith(subfolder):
            model["suggested_folder"] = f"{base_folder}/{subfolder}"
    enforce_authoritative_node_folders(missing_models)
    missing_models = coalesce_missing_models_by_destination(missing_models)

    models_to_search = [m for m in missing_models if not m.get("url")]
    total_files = len(models_to_search)
    model_to_index = {m["filename"].lower(): idx + 1 for idx, m in enumerate(models_to_search)}

    original_status_cb = status_cb
    def wrapped_status_cb(payload):
        if not original_status_cb or not payload:
            return
        if isinstance(payload, str):
            payload = {"message": payload}
        elif not isinstance(payload, dict):
            return
        filename = payload.get("filename")
        if filename:
            fn_lower = filename.lower()
            if fn_lower in model_to_index:
                payload["current_index"] = model_to_index[fn_lower]
                payload["total_files"] = total_files
                for m in models_to_search:
                    if m.get("filename", "").lower() == fn_lower:
                        payload["node_label"] = m.get("node_title") or m.get("node_type") or ""
                        break
        original_status_cb(payload)
    status_cb = wrapped_status_cb

    # 3. Check curated popular models registry
    if missing_models:
        popular_models = load_popular_models_registry()
        for model in missing_models:
            _check_cancelled()
            if model.get("url"):
                continue
            filename = model.get("filename")
            if filename and request_id:
                if is_model_skipped(request_id, filename):
                    continue
                set_current_searching_model(request_id, filename)
            if status_cb:
                status_cb({
                    "message": "Checking popular models",
                    "source": "popular_models",
                    "filename": model.get("filename")
                })
            entry = _lookup_popular_entry(
                popular_models,
                model["filename"],
                model.get("requested_path"),
            )
            if not entry:
                if request_id:
                    set_current_searching_model(request_id, None)
                continue

            candidate_urls = _iter_registry_urls(entry)
            if not candidate_urls:
                if request_id:
                    set_current_searching_model(request_id, None)
                continue

            live_url = None
            for candidate_url in candidate_urls:
                _check_cancelled()
                if request_id and is_model_skipped(request_id, filename):
                    break
                if _hf_url_exists(candidate_url):
                    live_url = candidate_url
                    break

            if request_id and is_model_skipped(request_id, filename):
                set_current_searching_model(request_id, None)
                continue

            exact_path_match = _is_exact_popular_entry_match(entry, model.get("requested_path"))
            if not live_url:
                trusted_curated_source = (entry.get("source") or "") in {
                    "cloud_marketplace_export",
                    "comfyui_manager_model_list",
                }
                if trusted_curated_source or exact_path_match:
                    live_url = next(
                        (url for url in candidate_urls if "/resolve/" in url),
                        candidate_urls[0],
                    )
                    print(
                        f"[DEBUG] Curated URL verification failed for {model.get('filename')}; "
                        f"using trusted fallback URL: {live_url}"
                    )
                else:
                    print(f"[DEBUG] Skipping stale curated URLs for {model.get('filename')}; falling back to other sources")
                    if request_id:
                        set_current_searching_model(request_id, None)
                    continue

            enrich_model_with_url(
                model,
                live_url,
                entry.get("source") or "popular_models",
                directory=entry.get("directory")
            )
            if request_id:
                set_current_searching_model(request_id, None)

    # 4. Check ComfyUI Manager model list/cache for missing models
    if missing_models:
        missing_models = load_comfyui_manager_cache(missing_models, status_cb=status_cb, request_id=request_id)

    token = get_token()
    civitai_token = get_civitai_token()
    skip_hf_search_all = bool(workflow_json.get("skip_hf_search"))

    # 4b. Fast exact hash lookup on Civitai when API key is configured and workflow provides a model hash
    if missing_models and civitai_token and not skip_hf_search_all:
        for model in missing_models:
            _check_cancelled()
            if model.get("url"):
                continue
            model_hash = str(model.get("hash") or "").strip()
            if not model_hash:
                continue
            filename = model.get("filename") or ""
            if filename and request_id:
                if is_model_skipped(request_id, filename):
                    continue
                set_current_searching_model(request_id, filename)
            if status_cb:
                status_cb({
                    "message": "Checking Civitai by hash",
                    "source": "civitai_hash",
                    "filename": filename,
                })
            hit = lookup_civitai_by_hash(model_hash, token=civitai_token)
            if hit and hit.get("download_url"):
                model["url"] = hit["download_url"]
                model["source"] = "civitai_hash"
                if hit.get("size_bytes") is not None:
                    model["expected_size"] = hit["size_bytes"]
                if hit.get("sha256"):
                    model["expected_sha"] = hit["sha256"]
                if not model.get("folder_locked") and not model.get("suggested_folder") and hit.get("folder"):
                    model["suggested_folder"] = hit["folder"]
            if filename and request_id:
                set_current_searching_model(request_id, None)

    skip_filenames = {
        (f or "").lower()
        for f in (workflow_json.get("skip_filenames") or [])
        if isinstance(f, str) and f.strip()
    }

    def _skip_hf_search(model: dict) -> bool:
        if skip_hf_search_all:
            return True
        name = (model.get("filename") or "").lower()
        return name in skip_filenames

    if missing_models and skip_hf_search_all:
        reused_cache_hits = 0
        for model in missing_models:
            _check_cancelled()
            if model.get("url"):
                continue
            key = _normalize_hf_search_key(model.get("filename") or "")
            cached = _hf_search_cache.get(key)
            if not isinstance(cached, dict):
                continue
            cached_url = cached.get("url")
            if not cached_url:
                continue
            model["url"] = cached_url
            model["hf_repo"] = cached.get("hf_repo")
            model["hf_path"] = cached.get("hf_path")
            model["source"] = "huggingface_cache"
            reused_cache_hits += 1
        if status_cb:
            status_cb({
                "message": "Skipping unresolved Hugging Face lookups",
                "source": "huggingface_skip",
                "detail": f"Reused {reused_cache_hits} cached link(s)"
            })

    # 5. Search HF for remaining missing models (that didn't have URL from registry/manager)
    workflow_note_repos, _ = _extract_note_context_from_workflow(workflow_json)
    priority_author_repos: dict[str, list[str]] | None = None
    api = None
    if missing_models and not skip_hf_search_all:
        try:
            api = HfApi(token=token)
        except Exception as e:
            print(f"[DEBUG] HfApi init failed: {e}")
            api = None

    def _scan_repo_list_for_missing(repo_ids: list[str], source_label: str) -> None:
        if not repo_ids or not api or not missing_models:
            return
        remaining: dict[str, dict] = {}
        for model in [m for m in missing_models if not m.get("url")]:
            if _skip_hf_search(model):
                continue
            fn = model.get("filename")
            if fn:
                remaining[fn.lower()] = model
        if not remaining:
            return
        for repo_id in repo_ids:
            if not remaining:
                break
            _check_cancelled()
            current_model = next(iter(remaining.values()))
            current_filename = current_model.get("filename") or ""
            if current_filename and request_id:
                if is_model_skipped(request_id, current_filename):
                    remaining.pop(current_filename.lower(), None)
                    continue
                set_current_searching_model(request_id, current_filename)
            if status_cb:
                status_cb({
                    "message": f"Checking {repo_id}",
                    "source": source_label,
                    "filename": current_filename,
                    "detail": repo_id,
                })
            try:
                files = _get_repo_files(api, repo_id, token)
            except HFSearchBudgetError:
                if current_filename and request_id:
                    set_current_searching_model(request_id, None)
                return
            except Exception:
                if current_filename and request_id:
                    set_current_searching_model(request_id, None)
                continue

            found_paths: dict[str, str] = {}
            for f in files:
                base = os.path.basename(f).lower()
                if base not in remaining:
                    continue
                prev = found_paths.get(base)
                if prev is None or len(f) < len(prev):
                    found_paths[base] = f

            for base, match_path in found_paths.items():
                model = remaining.pop(base, None)
                if not model:
                    continue
                model["url"] = f"https://huggingface.co/{repo_id}/resolve/main/{match_path}"
                model["hf_repo"] = repo_id
                model["hf_path"] = match_path
                model["source"] = source_label
                _hf_search_cache[base] = {
                    "url": model["url"],
                    "hf_repo": repo_id,
                    "hf_path": match_path,
                }
                print(f"[DEBUG] Found {model.get('filename')} in repo {repo_id} ({source_label})")

            if current_filename and request_id:
                set_current_searching_model(request_id, None)

    # Tier-0: Check explicit Hugging Face repositories linked inside workflow Note / MarkdownNote nodes
    # before fetching PRIORITY_AUTHORS or falling back to global search/mirrors.
    if missing_models and workflow_note_repos and not skip_hf_search_all and api:
        _reset_hf_search_budget()
        _scan_repo_list_for_missing(workflow_note_repos, "workflow_note_repo")

    if any(not m.get("url") and not _skip_hf_search(m) for m in missing_models) and not skip_hf_search_all and api:
        priority_author_repos = {}
        try:
            for author in PRIORITY_AUTHORS:
                _check_cancelled()
                try:
                    repos = list(call_with_timeout(api.list_models, author=author, limit=100, sort="downloads"))
                    priority_author_repos[author] = [m.modelId for m in repos if getattr(m, "modelId", None)]
                except Exception as e:
                    print(f"[DEBUG] Priority author {author} list fetch failed: {e}")
                    priority_author_repos[author] = []
        except Exception as e:
            print(f"[DEBUG] Priority author repo cache init failed: {e}")
            priority_author_repos = None

    priority_tokens: list[str] = []
    if missing_models and not skip_hf_search_all:
        for model in missing_models:
            _check_cancelled()
            if model.get("url"):
                continue
            filename = model.get("filename")
            if not filename:
                continue
            stem = os.path.splitext(filename)[0].lower()
            for part in re.split(r"[-_]", stem):
                part = part.strip().lower()
                if len(part) >= 3:
                    priority_tokens.append(part)
                alpha = re.sub(r"\d+", "", part)
                if len(alpha) >= 3:
                    priority_tokens.append(alpha)
    priority_tokens = list(dict.fromkeys(priority_tokens))

    def _workflow_match_repo(repo_id: str) -> bool:
        if not workflow_keywords:
            return False
        repo_lower = repo_id.lower()
        return any(k in repo_lower for k in workflow_keywords)

    def _workflow_repo_score(repo_id: str) -> int:
        repo_lower = repo_id.lower()
        score = 0
        for k in workflow_keywords or []:
            if k and k in repo_lower:
                score += 5
        for t in priority_tokens:
            if t and t in repo_lower:
                score += 4
        if _workflow_match_repo(repo_id):
            score += 50
        return score

    def _scan_priority_repos_for_missing():
        if not priority_author_repos or not api:
            return
        priority_repo_ids = []
        for author in PRIORITY_AUTHORS:
            priority_repo_ids.extend(priority_author_repos.get(author, []))
        priority_repo_ids = list(dict.fromkeys(priority_repo_ids))
        if not priority_repo_ids:
            return
        repo_order = {rid: idx for idx, rid in enumerate(priority_repo_ids)}
        priority_repo_ids.sort(
            key=lambda rid: (
                0 if _workflow_match_repo(rid) else 1,
                -_workflow_repo_score(rid),
                repo_order.get(rid, 0)
            )
        )
        if PRIORITY_REPO_SCAN_LIMIT > 0:
            priority_repo_ids[:] = priority_repo_ids[:PRIORITY_REPO_SCAN_LIMIT]

        if status_cb:
            status_cb({
                "message": "Searching priority repos",
                "source": "huggingface_priority_repos"
            })

        remaining: dict[str, dict] = {}
        for model in [m for m in missing_models if not m.get("url")]:
            if _skip_hf_search(model):
                print(f"[DEBUG] Skipping HF search for {model.get('filename')} (user skipped)")
                continue
            filename = model.get("filename")
            if not filename:
                continue
            remaining[filename.lower()] = model

        if not remaining:
            return

        for repo_id in priority_repo_ids:
            if not remaining:
                break
            _check_cancelled()
            current_model = next(iter(remaining.values()))
            current_filename = current_model.get("filename") or ""
            if current_filename and request_id:
                if is_model_skipped(request_id, current_filename):
                    remaining.pop(current_filename.lower(), None)
                    continue
                set_current_searching_model(request_id, current_filename)
            author = repo_id.split("/")[0] if "/" in repo_id else repo_id
            if status_cb:
                status_cb({
                    "message": f"Searching {author}",
                    "source": "huggingface_priority_repos",
                    "filename": current_filename,
                    "detail": author
                })
            try:
                files = _get_repo_files(api, repo_id, token)
            except HFSearchBudgetError:
                print(f"[DEBUG] HF search budget/rate limit hit before priority repo scan for {current_filename}")
                if status_cb:
                    status_cb({
                        "message": "Hugging Face search budget exhausted",
                        "source": "huggingface_priority_repos",
                        "filename": current_filename
                    })
                if current_filename and request_id:
                    set_current_searching_model(request_id, None)
                return
            except concurrent.futures.TimeoutError:
                print(f"[DEBUG] list_repo_files timeout for {repo_id} while searching {current_filename} (priority repo scan)")
                if status_cb:
                    status_cb({
                        "message": "Hugging Face search timeout",
                        "source": "huggingface_priority_repos",
                        "filename": current_filename,
                        "detail": f"list_repo_files({repo_id})"
                    })
                if current_filename and request_id:
                    set_current_searching_model(request_id, None)
                continue
            except Exception as e:
                if is_timeout_error(e):
                    print(f"[DEBUG] list_repo_files timeout for {repo_id} while searching {current_filename} (priority repo scan)")
                    if status_cb:
                        status_cb({
                            "message": "Hugging Face search timeout",
                            "source": "huggingface_priority_repos",
                            "filename": current_filename,
                            "detail": f"list_repo_files({repo_id})"
                        })
                    if current_filename and request_id:
                        set_current_searching_model(request_id, None)
                    continue
                if is_rate_limited_error(e):
                    _set_hf_rate_limited()
                    if status_cb:
                        status_cb({
                            "message": "Hugging Face rate limit hit",
                            "source": "huggingface_priority_repos",
                            "filename": current_filename,
                            "detail": str(e)
                        })
                    if current_filename and request_id:
                        set_current_searching_model(request_id, None)
                    return
                if current_filename and request_id:
                    set_current_searching_model(request_id, None)
                continue

            found_paths: dict[str, str] = {}
            for f in files:
                base = os.path.basename(f).lower()
                if base not in remaining:
                    continue
                prev = found_paths.get(base)
                if prev is None or len(f) < len(prev):
                    found_paths[base] = f

            for base, match_path in found_paths.items():
                model = remaining.pop(base, None)
                if not model:
                    continue
                model["url"] = f"https://huggingface.co/{repo_id}/resolve/main/{match_path}"
                model["hf_repo"] = repo_id
                model["hf_path"] = match_path
                model["source"] = "priority_repo_scan"
                _hf_search_cache[base] = {
                    "url": model["url"],
                    "hf_repo": repo_id,
                    "hf_path": match_path
                }
                print(f"[DEBUG] Found {model.get('filename')} in repo {repo_id} (priority repo scan)")
            
            if current_filename and request_id:
                set_current_searching_model(request_id, None)

    if missing_models and priority_author_repos and not skip_hf_search_all:
        _reset_hf_search_budget()
        _scan_priority_repos_for_missing()

    def _run_hf_stage(label: str, mode: str):
        _reset_hf_search_budget()
        for m in [m for m in missing_models if not m.get("url")]:
            _check_cancelled()
            filename = m.get("filename")
            if filename and request_id:
                if is_model_skipped(request_id, filename):
                    continue
                set_current_searching_model(request_id, filename)
            if _skip_hf_search(m):
                print(f"[DEBUG] Skipping HF search for {m.get('filename')} (user skipped)")
                if request_id:
                    set_current_searching_model(request_id, None)
                continue
            if _hf_search_budget_exhausted():
                if status_cb:
                    status_cb({
                        "message": "Hugging Face search budget exhausted",
                        "source": "huggingface_search",
                        "filename": m.get("filename")
                    })
                if request_id:
                    set_current_searching_model(request_id, None)
                break
            if status_cb:
                status_cb({
                    "message": f"Searching Hugging Face ({label})",
                    "source": "huggingface_search",
                    "filename": m.get("filename")
                })
            result = search_huggingface_model(
                m["filename"],
                token,
                status_cb=status_cb,
                mode=mode,
                workflow_keywords=workflow_keywords,
                priority_author_repos=priority_author_repos,
                skip_priority_repo_scan=True,
                request_id=request_id
            )
            if result:
                m["url"] = result.get("url")
                m["hf_repo"] = result.get("hf_repo")
                m["hf_path"] = result.get("hf_path")
                m["source"] = "huggingface_search"
            if request_id:
                set_current_searching_model(request_id, None)

    if missing_models and not skip_hf_search_all:
        _run_hf_stage("basic", "basic")
        if priority_author_repos is None:
            _run_hf_stage("priority", "priority")

    # 5b. Civitai exact-filename fallback search when Civitai API key is configured
    if missing_models and civitai_token and not skip_hf_search_all:
        for m in [m for m in missing_models if not m.get("url")]:
            _check_cancelled()
            filename = m.get("filename") or ""
            if not filename:
                continue
            if request_id:
                if is_model_skipped(request_id, filename):
                    continue
                set_current_searching_model(request_id, filename)
            if _skip_hf_search(m):
                if request_id:
                    set_current_searching_model(request_id, None)
                continue
            if status_cb:
                status_cb({
                    "message": "Searching Civitai",
                    "source": "civitai_search",
                    "filename": filename,
                })
            hit = search_civitai_by_filename(
                filename,
                folder_hint=m.get("suggested_folder"),
                token=civitai_token,
            )
            if hit and hit.get("download_url"):
                m["url"] = hit["download_url"]
                m["source"] = "civitai_search"
                if hit.get("size_bytes") is not None:
                    m["expected_size"] = hit["size_bytes"]
                if hit.get("sha256"):
                    m["expected_sha"] = hit["sha256"]
                if (
                    not m.get("folder_locked")
                    and hit.get("folder")
                    and str(m.get("suggested_folder") or "").strip() in {"", "checkpoints"}
                ):
                    m["suggested_folder"] = hit["folder"]
            if request_id:
                set_current_searching_model(request_id, None)

    final_missing = missing_models
    enforce_authoritative_node_folders(final_missing)
    enforce_authoritative_node_folders(existing_models)
    enforce_authoritative_node_folders(path_mismatches)

    # 6. Quantized variant detection for unresolved models (no URL)
    if final_missing:
        popular_models = load_popular_models_registry()
        manager_models = load_comfyui_manager_model_list()
        for model in final_missing:
            if model.get("url"):
                continue
            alternatives = find_quantized_alternatives(
                model["filename"],
                [
                    ("popular_models", popular_models),
                    ("manager_model_list", manager_models),
                ],
            )
            if alternatives:
                model["alternatives"] = alternatives

    return {
        "missing": final_missing,
        "found": existing_models,
        "mismatches": path_mismatches
    }
