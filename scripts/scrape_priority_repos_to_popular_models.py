#!/usr/bin/env python3
"""
Development utility (not runtime nodepack code):
Scrape model files from priority Hugging Face authors and merge them into
metadata/popular-models.json.

Usage:
  python3 scripts/scrape_priority_repos_to_popular_models.py --write

Optional:
  HF_TOKEN=hf_xxx python3 scripts/scrape_priority_repos_to_popular_models.py --write
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, Iterable, Tuple

try:
    from scripts.lib_model_sources import (
        MODEL_EXTENSIONS,
        PRECISION_PATTERN,
        canonicalize_base_name,
        infer_lightx2v_base,
        lightx2v_should_use_subfolder,
    )
except Exception:
    from lib_model_sources import (  # type: ignore
        MODEL_EXTENSIONS,
        PRECISION_PATTERN,
        canonicalize_base_name,
        infer_lightx2v_base,
        lightx2v_should_use_subfolder,
    )

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
    "Kim2091",
    "Phips",
    "lightx2v",
    "vrgamedevgirl84",
    "Lightricks",
    "Winnougan",
]

EXCLUDED_REPO_IDS = {
    "Phips/Reinforce-Pixelcopter-PLE-v0",
    "Phips/Reinforce-CartPole-v1",
    "Phips/dqn-BeamRiderNoFrameskip-v4",
    "Phips/dqn-SpaceInvadersNoFrameskip-v4",
    "Phips/Taxi-v3",
    "Phips/q-FrozenLake-v1-4x4-noSlippery",
    "Phips/ppo-Huggy",
    "Phips/ppo-LunarLander-v2",
}

FORCE_UPSCALE_AUTHORS = {"kim2091", "phips"}
LIGHTX2V_OWNER = "lightx2v"

API_BASE = "https://huggingface.co/api"
REPO_ROOT = Path(__file__).resolve().parents[1]


def is_lightx2v_encoder_repo(repo_id: str) -> bool:
    repo_lower = str(repo_id or "").strip().lower()
    if "/" not in repo_lower:
        return False
    repo_name = repo_lower.split("/", 1)[1]
    return repo_name == "encoders" or "encoder" in repo_name


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape priority HF repos into popular-models.json")
    parser.add_argument(
        "--input",
        default=str(REPO_ROOT / "metadata" / "popular-models.json"),
        help="Path to popular-models.json",
    )
    parser.add_argument(
        "--authors",
        default=",".join(PRIORITY_AUTHORS),
        help="Comma-separated list of authors",
    )
    parser.add_argument(
        "--repo-limit-per-author",
        type=int,
        default=0,
        help="Limit repos per author (0 = no limit)",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.2,
        help="Delay (seconds) between API calls to scrape slowly",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=45,
        help="HTTP timeout per request",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Write output file. Without this flag, dry-run only.",
    )
    return parser.parse_args()


def resolve_cli_path(raw_path: str) -> Path:
    path = Path(str(raw_path or "").strip()).expanduser()
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve()


def request_json(
    url: str,
    *,
    token: str | None,
    timeout: int,
    retries: int = 5,
) -> Tuple[object, Dict[str, str]]:
    headers = {
        "User-Agent": "ComfyUI-HF-Downloader-PriorityScraper/1.0",
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    backoff = 1.0
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = resp.read()
                data = json.loads(payload.decode("utf-8"))
                response_headers = {k.lower(): v for k, v in resp.headers.items()}
                return data, response_headers
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                print(f"[WARN] {e.code} for {url} (attempt {attempt}/{retries}), retrying in {backoff:.1f}s")
                time.sleep(backoff)
                backoff = min(backoff * 2.0, 30.0)
                continue
            raise RuntimeError(f"HTTP {e.code} for {url}: {body[:400]}")
        except Exception as e:
            if attempt < retries:
                print(f"[WARN] Request failed for {url} (attempt {attempt}/{retries}): {e}")
                time.sleep(backoff)
                backoff = min(backoff * 2.0, 30.0)
                continue
            raise

    raise RuntimeError(f"Failed to fetch {url}")


def parse_next_link(link_header: str | None) -> str | None:
    if not link_header:
        return None
    # Example: <https://...>; rel="next"
    match = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
    return match.group(1) if match else None


def fetch_model_info(repo_id: str, *, token: str | None, timeout: int) -> dict:
    encoded_repo = urllib.parse.quote(repo_id, safe="/")
    url = f"{API_BASE}/models/{encoded_repo}?blobs=0"
    data, _ = request_json(url, token=token, timeout=timeout)
    return data if isinstance(data, dict) else {}


def fetch_repo_tree_paths(
    repo_id: str,
    *,
    token: str | None,
    timeout: int,
    sleep_seconds: float,
) -> list[str]:
    encoded_repo = urllib.parse.quote(repo_id, safe="/")
    next_url = f"{API_BASE}/models/{encoded_repo}/tree/main?recursive=1&expand=0&limit=1000"
    out: list[str] = []
    seen: set[str] = set()

    while next_url:
        data, headers = request_json(next_url, token=token, timeout=timeout)
        if not isinstance(data, list) or not data:
            break
        for item in data:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            if not isinstance(path, str) or not path:
                continue
            ext = os.path.splitext(path)[1].lower()
            if ext not in MODEL_EXTENSIONS:
                continue
            if path in seen:
                continue
            seen.add(path)
            out.append(path)

        next_url = parse_next_link(headers.get("link"))
        if next_url:
            time.sleep(max(0.0, sleep_seconds))
    return out


def parse_repo_id_from_url(url: str) -> str:
    if not isinstance(url, str):
        return ""
    marker = "huggingface.co/"
    idx = url.lower().find(marker)
    if idx < 0:
        return ""
    suffix = url[idx + len(marker) :]
    parts = [p for p in suffix.split("/") if p]
    if len(parts) < 2:
        return ""
    return f"{parts[0]}/{parts[1]}"


def iter_author_models(
    author: str,
    *,
    token: str | None,
    timeout: int,
    sleep_seconds: float,
    repo_limit: int,
) -> Iterable[dict]:
    params = {
        "author": author,
        "limit": 100,
        "sort": "downloads",
        "direction": "-1",
        "full": "1",
    }
    next_url = f"{API_BASE}/models?{urllib.parse.urlencode(params)}"
    emitted = 0
    seen = set()

    while next_url:
        data, headers = request_json(next_url, token=token, timeout=timeout)
        if not isinstance(data, list) or not data:
            break

        for entry in data:
            if not isinstance(entry, dict):
                continue
            repo_id = entry.get("id") or entry.get("modelId")
            if not isinstance(repo_id, str) or "/" not in repo_id:
                continue
            if repo_id in seen:
                continue
            seen.add(repo_id)
            yield entry
            emitted += 1
            if repo_limit > 0 and emitted >= repo_limit:
                return

        next_url = parse_next_link(headers.get("link"))
        if next_url:
            time.sleep(max(0.0, sleep_seconds))


def infer_type_and_directory(path: str) -> Tuple[str, str]:
    return infer_type_and_directory_for_repo(path, "")


def infer_type_and_directory_for_repo(path: str, repo_id: str) -> Tuple[str, str]:
    repo_lower = str(repo_id or "").strip().lower()
    owner = str(repo_id).split("/", 1)[0].strip().lower() if repo_id else ""

    if owner == LIGHTX2V_OWNER:
        path_lower = str(path or "").lower()
        base_lower = os.path.basename(path_lower)
        if is_lightx2v_encoder_repo(repo_lower) or "text_encoder" in path_lower or "text_encoders" in path_lower:
            return "text_encoder", "text_encoders"
        repo_name = repo_lower.split("/", 1)[1] if "/" in repo_lower else ""
        is_lora = "lora" in base_lower or "/lora" in path_lower or "lora" in repo_name
        return ("lora" if is_lora else "diffusion_model"), ("loras" if is_lora else "diffusion_models")
    if owner in FORCE_UPSCALE_AUTHORS:
        return "upscale_model", "upscale_models"

    p = path.lower()
    base = os.path.basename(p)
    ext = os.path.splitext(base)[1]

    if "controlnet" in p or "control_" in base:
        return "controlnet", "controlnet"
    if "lora" in p or "lora" in base:
        return "lora", "loras"
    if "vae" in p or base.startswith("vae") or "_vae" in base:
        return "vae", "vae"
    if "clip_vision" in p or "image_encoder" in p:
        return "clip_vision", "clip_vision"
    if "text_encoder" in p or "text_encoders" in p:
        return "text_encoder", "text_encoders"
    if "upscale" in p or "esrgan" in p:
        return "upscale", "upscale_models"
    if "embedding" in p or "embeddings" in p:
        return "embedding", "embeddings"
    if ext == ".gguf":
        return "gguf", "diffusion_models"

    return "checkpoint", "checkpoints"


def _canonical_precision(filename: str) -> str:
    lowered = str(filename or "").lower().replace("-", "_")
    if "fp8" in lowered and "scaled" in lowered:
        return "fp8_scaled"
    if "fp8" in lowered and "mixed" in lowered:
        return "fp8_mixed"
    match = PRECISION_PATTERN.search(lowered)
    if not match:
        return "unknown"
    return str(match.group(1) or "").lower()


def _normalized_stem_without_precision(filename: str) -> str:
    stem = os.path.splitext(os.path.basename(str(filename or "").strip()))[0].lower()
    stem = stem.replace("-", "_")
    stem = PRECISION_PATTERN.sub("_", stem)
    stem = re.sub(r"_+", "_", stem).strip("_")
    return stem or os.path.splitext(os.path.basename(str(filename or "").strip()))[0].lower()


def _encoder_signature(filename: str) -> str:
    return f"{_normalized_stem_without_precision(filename)}|{_canonical_precision(filename)}"


def _build_existing_encoder_signatures(models: dict) -> set[str]:
    out: set[str] = set()
    for key, entry in models.items():
        filename = str((entry or {}).get("filename") or key or "").strip() if isinstance(entry, dict) else str(key)
        if not filename:
            continue
        directory = str((entry or {}).get("directory") or "").replace("\\", "/").strip().strip("/") if isinstance(entry, dict) else ""
        mtype = str((entry or {}).get("type") or "").strip().lower() if isinstance(entry, dict) else ""
        if directory.startswith("text_encoders") or mtype in {"text_encoder", "clip"}:
            out.add(_encoder_signature(filename))
    return out


def build_model_identity(repo_id: str, path: str, basename_count: int = 1) -> dict:
    repo_lower = str(repo_id or "").strip().lower()
    owner = str(repo_id).split("/", 1)[0].strip().lower() if repo_id else ""
    path_norm = str(path or "").replace("\\", "/").strip().strip("/")
    basename = os.path.basename(path_norm)
    subdir = os.path.dirname(path_norm).replace("\\", "/").strip().strip("/")
    mtype, directory = infer_type_and_directory_for_repo(path_norm, repo_id)

    identity = {
        "skip": False,
        "filename_key": basename,
        "display_filename": basename,
        "mtype": mtype,
        "directory": directory,
        "extra_fields": {},
    }

    if owner == LIGHTX2V_OWNER:
        if basename.lower().startswith("block_") and basename.lower().endswith(".safetensors"):
            identity["skip"] = True
            identity["skip_reason"] = "lightx2v_block_split_file"
            return identity
        if (mtype == "text_encoder" or is_lightx2v_encoder_repo(repo_lower)) and basename.lower().endswith(".pth"):
            identity["skip"] = True
            identity["skip_reason"] = "encoders_skip_pth"
            return identity

        use_subfolder = lightx2v_should_use_subfolder(basename, subdir, basename_count=basename_count)
        display = f"{subdir}/{basename}" if (use_subfolder and subdir) else basename
        if mtype == "text_encoder":
            directory_base = "text_encoders"
        elif mtype == "lora":
            directory_base = "loras"
        else:
            directory_base = "diffusion_models"
        directory = f"{directory_base}/{subdir}" if (use_subfolder and subdir) else directory_base
        identity["filename_key"] = display
        identity["display_filename"] = display
        identity["directory"] = directory
        identity["extra_fields"] = {
            "filename": display,
            "hf_path": path_norm,
            "repo_subfolder": subdir if use_subfolder else "",
            "base": canonicalize_base_name(infer_lightx2v_base(repo_id, path_norm, basename)),
            "source_note": "lightx2v_repo_ingest",
        }
    return identity


def extract_model_paths(model_info: dict) -> list[str]:
    siblings = model_info.get("siblings")
    if not isinstance(siblings, list):
        return []
    out = []
    for item in siblings:
        if not isinstance(item, dict):
            continue
        path = item.get("rfilename")
        if not isinstance(path, str):
            continue
        ext = os.path.splitext(path)[1].lower()
        if ext in MODEL_EXTENSIONS:
            out.append(path)
    return out


def make_resolve_url(repo_id: str, branch: str, path: str) -> str:
    repo = urllib.parse.quote(repo_id, safe="/")
    rev = urllib.parse.quote(branch, safe="")
    quoted_path = urllib.parse.quote(path, safe="/")
    return f"https://huggingface.co/{repo}/resolve/{rev}/{quoted_path}"


def normalize_model_db(raw: object) -> dict:
    if not isinstance(raw, dict):
        return {
            "version": "1.0.0",
            "description": "Curated list of popular models with download URLs",
            "models": {},
        }
    if not isinstance(raw.get("models"), dict):
        raw["models"] = {}
    return raw


def is_excluded_repo(repo_id: str) -> bool:
    return repo_id.strip() in EXCLUDED_REPO_IDS


def remove_excluded_repo_rows(models: dict) -> int:
    to_delete = []
    for filename, entry in models.items():
        if not isinstance(entry, dict):
            continue
        repo_id = str(entry.get("repo_id") or "").strip()
        if not repo_id:
            repo_id = parse_repo_id_from_url(str(entry.get("url") or ""))
        if is_excluded_repo(repo_id):
            to_delete.append(filename)
            continue
        if is_lightx2v_encoder_repo(repo_id):
            model_name = str(entry.get("filename") or filename or "").strip().lower()
            if model_name.endswith(".pth"):
                to_delete.append(filename)
                continue
        candidate_urls = entry.get("candidate_urls")
        if isinstance(candidate_urls, list):
            for item in candidate_urls:
                if not isinstance(item, str):
                    continue
                candidate_repo = parse_repo_id_from_url(item)
                if is_excluded_repo(candidate_repo):
                    to_delete.append(filename)
                    break

    for filename in to_delete:
        models.pop(filename, None)
    return len(to_delete)


def remove_lightx2v_non_cloud_rows(models: dict) -> int:
    to_delete = []
    for key, entry in models.items():
        if not isinstance(entry, dict):
            continue
        source = str(entry.get("source") or "").strip().lower()
        repo_id = str(entry.get("repo_id") or "").strip()
        if not repo_id:
            repo_id = parse_repo_id_from_url(str(entry.get("url") or ""))
        owner = repo_id.split("/", 1)[0].strip().lower() if "/" in repo_id else ""
        if owner != LIGHTX2V_OWNER:
            continue

        # Keep real cloud rows.
        if source == "cloud_marketplace_export":
            continue

        # Keep real manager rows, but purge manager-labeled rows that originally came from priority scrape.
        if source == "comfyui_manager_model_list":
            source_origin = str(entry.get("source_origin") or "").strip().lower()
            if source_origin != "priority_repo_scrape":
                continue

        if owner == LIGHTX2V_OWNER:
            to_delete.append(key)

    for key in to_delete:
        models.pop(key, None)
    return len(to_delete)


def upsert_model_entry(models: dict, filename: str, url: str, mtype: str, directory: str) -> None:
    upsert_model_entry_with_meta(
        models,
        filename,
        url,
        mtype,
        directory,
        display_filename=filename,
        extra_fields=None,
    )


def upsert_model_entry_with_meta(
    models: dict,
    key_name: str,
    url: str,
    mtype: str,
    directory: str,
    *,
    display_filename: str,
    extra_fields: dict | None,
) -> None:
    entry = models.get(key_name)
    if not isinstance(entry, dict):
        entry = {}
    entry_source = str(entry.get("source") or "").strip().lower()
    can_override_metadata = (not entry_source) or (entry_source == "priority_repo_scrape")

    candidate_urls = []
    for key in ("url",):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            candidate_urls.append(value.strip())
    existing_candidates = entry.get("candidate_urls")
    if isinstance(existing_candidates, list):
        for item in existing_candidates:
            if isinstance(item, str) and item.strip():
                candidate_urls.append(item.strip())

    candidate_urls.append(url)
    deduped = []
    seen = set()
    for item in candidate_urls:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)

    primary_url = entry.get("url") if isinstance(entry.get("url"), str) and entry.get("url").strip() else deduped[0]
    next_entry = dict(entry)
    next_entry["url"] = primary_url
    if can_override_metadata:
        next_entry["type"] = mtype if mtype else next_entry.get("type")
        next_entry["directory"] = directory if directory else next_entry.get("directory")
        next_entry["filename"] = str(display_filename or "").strip() or str(next_entry.get("filename") or "").strip()
    if not next_entry.get("source"):
        next_entry["source"] = "priority_repo_scrape"
    if not next_entry.get("repo_id"):
        next_entry["repo_id"] = parse_repo_id_from_url(url)
    if can_override_metadata and isinstance(extra_fields, dict):
        for field, value in extra_fields.items():
            if value is None:
                continue
            if isinstance(value, str):
                value = value.strip()
            if value == "":
                continue
            next_entry[field] = value
    if len(deduped) > 1:
        next_entry["candidate_urls"] = deduped
    else:
        next_entry.pop("candidate_urls", None)
    if "base" in next_entry:
        next_entry["base"] = canonicalize_base_name(next_entry.get("base"))

    models[key_name] = next_entry


def main() -> int:
    args = parse_args()
    token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
    input_path = resolve_cli_path(args.input)

    with input_path.open("r", encoding="utf-8") as f:
        db = normalize_model_db(json.load(f))

    models = db.get("models", {})
    assert isinstance(models, dict)
    removed_excluded = remove_excluded_repo_rows(models)
    if removed_excluded:
        print(f"[INFO] Removed {removed_excluded} excluded repo entries from existing DB")
    removed_lightx2v = remove_lightx2v_non_cloud_rows(models)
    if removed_lightx2v:
        print(f"[INFO] Removed {removed_lightx2v} non-cloud lightx2v entries before re-scrape")
    existing_encoder_signatures = _build_existing_encoder_signatures(models)

    authors = [a.strip() for a in str(args.authors).split(",") if a.strip()]
    if not authors:
        print("[ERROR] No authors provided.")
        return 2

    total_repos = 0
    total_model_files = 0
    new_filenames = 0
    merged_candidates = 0

    for author in authors:
        print(f"[INFO] Scraping author: {author}")
        models_for_author = list(
            iter_author_models(
                author,
                token=token,
                timeout=args.timeout,
                sleep_seconds=args.sleep,
                repo_limit=max(0, args.repo_limit_per_author),
            )
        )
        print(f"[INFO] {author}: {len(models_for_author)} repos")
        total_repos += len(models_for_author)

        for model_info in models_for_author:
            repo_id = model_info.get("id") or model_info.get("modelId")
            if not isinstance(repo_id, str) or "/" not in repo_id:
                continue
            if is_excluded_repo(repo_id):
                continue
            branch = (
                model_info.get("default_branch")
                or model_info.get("defaultBranch")
                or "main"
            )
            model_paths = extract_model_paths(model_info)
            repo_owner = repo_id.split("/", 1)[0].strip().lower()
            if repo_owner == LIGHTX2V_OWNER:
                # Repo listing payload may not include full siblings for these repos.
                try:
                    details = fetch_model_info(repo_id, token=token, timeout=args.timeout)
                    if details:
                        branch = (
                            details.get("default_branch")
                            or details.get("defaultBranch")
                            or branch
                        )
                        detail_paths = extract_model_paths(details)
                        if detail_paths:
                            model_paths = detail_paths
                except Exception as e:
                    print(f"[WARN] Failed to fetch model details for {repo_id}: {e}")
                if not model_paths:
                    try:
                        tree_paths = fetch_repo_tree_paths(
                            repo_id,
                            token=token,
                            timeout=args.timeout,
                            sleep_seconds=args.sleep,
                        )
                        if tree_paths:
                            model_paths = tree_paths
                    except Exception as e:
                        print(f"[WARN] Failed to fetch repo tree for {repo_id}: {e}")
            if not model_paths:
                time.sleep(max(0.0, args.sleep))
                continue
            basename_counts = {}
            for path in model_paths:
                base = os.path.basename(str(path or "")).strip().lower()
                if not base:
                    continue
                basename_counts[base] = basename_counts.get(base, 0) + 1

            for path in model_paths:
                filename = os.path.basename(path)
                if not filename:
                    continue
                identity = build_model_identity(
                    repo_id,
                    path,
                    basename_count=basename_counts.get(filename.lower(), 1),
                )
                if identity.get("skip"):
                    continue
                total_model_files += 1
                key_name = str(identity.get("filename_key") or "").strip()
                display_filename = str(identity.get("display_filename") or filename).strip()
                mtype = str(identity.get("mtype") or "")
                directory = str(identity.get("directory") or "")
                extra_fields = identity.get("extra_fields") if isinstance(identity.get("extra_fields"), dict) else None
                if is_lightx2v_encoder_repo(repo_id):
                    signature = _encoder_signature(display_filename)
                    if signature in existing_encoder_signatures:
                        continue
                url = make_resolve_url(repo_id, branch, path)
                if not key_name:
                    key_name = display_filename or filename
                existed_before = key_name in models
                before_candidates = 1
                existing_entry = models.get(key_name)
                if isinstance(existing_entry, dict) and isinstance(existing_entry.get("candidate_urls"), list):
                    before_candidates = 1 + len(existing_entry.get("candidate_urls"))
                upsert_model_entry_with_meta(
                    models,
                    key_name,
                    url,
                    mtype,
                    directory,
                    display_filename=display_filename,
                    extra_fields=extra_fields,
                )
                if is_lightx2v_encoder_repo(repo_id):
                    existing_encoder_signatures.add(_encoder_signature(display_filename))
                after_entry = models.get(key_name, {})
                after_candidates = 1
                if isinstance(after_entry, dict) and isinstance(after_entry.get("candidate_urls"), list):
                    after_candidates = 1 + len(after_entry.get("candidate_urls"))
                if not existed_before:
                    new_filenames += 1
                elif after_candidates > before_candidates:
                    merged_candidates += 1

            time.sleep(max(0.0, args.sleep))

        if args.write:
            # Checkpoint write after each author to avoid losing long runs.
            db["models"] = {k: models[k] for k in sorted(models.keys(), key=lambda x: x.lower())}
            with input_path.open("w", encoding="utf-8") as f:
                json.dump(db, f, indent=2, ensure_ascii=False)
                f.write("\n")
            print(f"[INFO] Checkpoint saved after author {author}: {len(db['models'])} entries")

    # Deterministic order for stable diffs.
    db["models"] = {k: models[k] for k in sorted(models.keys(), key=lambda x: x.lower())}

    print(f"[INFO] Processed repos: {total_repos}")
    print(f"[INFO] Model-like files seen: {total_model_files}")
    print(f"[INFO] New filenames added: {new_filenames}")
    print(f"[INFO] Existing filenames with extra candidate URLs: {merged_candidates}")
    print(f"[INFO] Total entries after merge: {len(db['models'])}")

    if args.write:
        with input_path.open("w", encoding="utf-8") as f:
            json.dump(db, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"[INFO] Wrote {input_path}")
    else:
        print("[INFO] Dry-run complete. Re-run with --write to save.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
