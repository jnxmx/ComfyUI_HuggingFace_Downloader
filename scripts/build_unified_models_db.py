#!/usr/bin/env python3
"""
Build a single canonical unified models database in metadata/popular-models.json.

Inputs:
- Existing popular-models.json (all sources, including priority rows)
- Cloud marketplace extract (cloud_marketplace_models.json)
- ComfyUI manager model list (model-list.json)

Outputs:
- Updated metadata/popular-models.json with explorer_* normalized fields
- Summary JSON for build diagnostics
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
try:
    from scripts.lib_model_sources import (
        ALLOWED_EXPLORER_CATEGORIES,
        BASE_APPLICABLE_CATEGORIES,
        canonicalize_base_name,
        get_category_from_manager_type,
        get_category_root,
        infer_flux_base,
        infer_lightx2v_base,
        infer_qwen_base,
        infer_wan_base,
        lightx2v_should_use_subfolder,
        normalize_group_stem,
        normalize_path,
        parse_hf_repo_and_path,
        provider_from_url,
    )
except Exception:
    from lib_model_sources import (  # type: ignore
        ALLOWED_EXPLORER_CATEGORIES,
        BASE_APPLICABLE_CATEGORIES,
        canonicalize_base_name,
        get_category_from_manager_type,
        get_category_root,
        infer_flux_base,
        infer_lightx2v_base,
        infer_qwen_base,
        infer_wan_base,
        lightx2v_should_use_subfolder,
        normalize_group_stem,
        normalize_path,
        parse_hf_repo_and_path,
        provider_from_url,
    )

SOURCE_RANKS = {
    "comfyui_manager_model_list": 1,
    "cloud_marketplace_export": 2,
    "priority_repo_scrape": 3,
}

BFL_OWNER = "black-forest-labs"
SPECIAL_UPSCALE_AUTHORS = {"kim2091", "phips"}
LIGHTX2V_OWNER = "lightx2v"
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
PRIORITY_GGUF_VISIBLE_OWNERS = {"city96", "quantstack", "unsloth"}

SIZE_VALUE_RE = re.compile(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)?\s*$", re.IGNORECASE)
REPO_ROOT = Path(__file__).resolve().parents[1]


def is_lightx2v_encoder_repo(repo_id: str) -> bool:
    repo_lower = str(repo_id or "").strip().lower()
    if "/" not in repo_lower:
        return False
    repo_name = repo_lower.split("/", 1)[1]
    return repo_name == "encoders" or "encoder" in repo_name


def parse_size_to_bytes(raw_size: Any) -> int | None:
    if raw_size is None:
        return None
    if isinstance(raw_size, bool):
        return None
    if isinstance(raw_size, (int, float)):
        value = int(raw_size)
        return value if value >= 0 else None

    text = str(raw_size or "").strip()
    if not text:
        return None
    text = text.replace(",", "")
    match = SIZE_VALUE_RE.match(text)
    if not match:
        return None

    value = float(match.group(1))
    unit = str(match.group(2) or "b").lower()

    multipliers = {
        "b": 1,
        "kb": 1024,
        "kib": 1024,
        "mb": 1024**2,
        "mib": 1024**2,
        "gb": 1024**3,
        "gib": 1024**3,
        "tb": 1024**4,
        "tib": 1024**4,
    }
    multiplier = multipliers.get(unit)
    if multiplier is None:
        return None

    parsed = int(value * multiplier)
    return parsed if parsed >= 0 else None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--popular",
        default=str(REPO_ROOT / "metadata" / "popular-models.json"),
        help="Path to canonical popular-models.json",
    )
    parser.add_argument(
        "--cloud",
        default=str(REPO_ROOT / "metadata" / "marketplace_extract" / "from_dump" / "cloud_marketplace_models.json"),
        help="Path to cloud marketplace models export",
    )
    parser.add_argument(
        "--manager-model-list",
        default=str(
            REPO_ROOT / "temp_repos" / "ComfyUI-Workflow-Models-Downloader" / "metadata" / "model-list.json"
        ),
        help="Path to manager model-list.json",
    )
    parser.add_argument(
        "--summary-out",
        default=str(REPO_ROOT / "metadata" / "marketplace_extract" / "from_dump" / "unified_build_summary.json"),
        help="Path to build summary output",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Write updates to canonical DB file",
    )
    return parser.parse_args()


def resolve_cli_path(raw_path: str) -> Path:
    path = Path(str(raw_path or "").strip()).expanduser()
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def is_excluded_repo(repo_id: str) -> bool:
    return repo_id.strip() in EXCLUDED_REPO_IDS


def build_special_upscale_overlay(entry: dict[str, Any], filename: str) -> dict[str, Any] | None:
    repo_id = str(entry.get("repo_id") or "").strip()
    rel_path = ""
    url = entry.get("url")
    if isinstance(url, str):
        parsed_repo_id, parsed_path = parse_hf_repo_and_path(url)
        if not repo_id:
            repo_id = parsed_repo_id
        rel_path = parsed_path

    if not repo_id or is_excluded_repo(repo_id):
        return None
    repo_lower = repo_id.lower()
    owner = repo_id.split("/", 1)[0].strip().lower() if "/" in repo_id else ""
    rel_path_norm = normalize_path(rel_path)
    current_name = str(filename or "").strip()
    if owner == LIGHTX2V_OWNER:
        basename = os.path.basename(rel_path_norm or current_name or "model.safetensors")
        basename_lower = basename.lower()
        if basename_lower.startswith("block_") and basename_lower.endswith(".safetensors"):
            return None
        if is_lightx2v_encoder_repo(repo_lower) and basename_lower.endswith(".pth"):
            return None

        subdir = normalize_path(os.path.dirname(rel_path_norm))
        use_subfolder = lightx2v_should_use_subfolder(basename, subdir, basename_count=1)
        display_filename = f"{subdir}/{basename}" if (use_subfolder and subdir) else basename

        if is_lightx2v_encoder_repo(repo_lower) or "text_encoder" in rel_path_norm.lower() or "text_encoders" in rel_path_norm.lower():
            category = "text_encoders"
            mapped_type = "text_encoder"
        else:
            rel_lower = rel_path_norm.lower()
            repo_name = repo_lower.split("/", 1)[1] if "/" in repo_lower else ""
            is_lora = "lora" in basename_lower or "/lora" in rel_lower or "lora" in repo_name
            category = "loras" if is_lora else "diffusion_models"
            mapped_type = "lora" if is_lora else "diffusion_model"

        save_path = f"{category}/{subdir}" if (use_subfolder and subdir) else category
        return {
            "filename": filename,
            "display_filename": display_filename,
            "type": mapped_type,
            "base": infer_lightx2v_base(repo_id, rel_path_norm or filename, basename),
            "save_path": save_path,
            "repo_id": repo_id,
            "is_special_upscale_overlay": True,
            "is_lightx2v_overlay": True,
            "relative_path": rel_path_norm,
        }
    owner = repo_id.split("/", 1)[0].strip().lower()
    if owner not in SPECIAL_UPSCALE_AUTHORS:
        return None

    is_model_like = str(filename or "").lower().endswith(
        (".safetensors", ".ckpt", ".pt", ".bin", ".pth", ".onnx", ".gguf", ".zip")
    )
    if not is_model_like:
        return None

    return {
        "filename": filename,
        "type": "upscale_model",
        "base": "",
        "save_path": "upscale_models",
        "repo_id": repo_id,
        "is_special_upscale_overlay": True,
        "relative_path": rel_path,
    }


def build_bfl_manager_overlay(entry: dict[str, Any], filename: str) -> dict[str, Any] | None:
    repo_id = str(entry.get("repo_id") or "").strip()
    rel_path = ""
    url = entry.get("url")
    if isinstance(url, str):
        parsed_repo_id, parsed_path = parse_hf_repo_and_path(url)
        if not repo_id:
            repo_id = parsed_repo_id
        rel_path = parsed_path

    if not repo_id or not repo_id.lower().startswith(f"{BFL_OWNER}/"):
        return None
    if "redux" in repo_id.lower() or "redux" in filename.lower():
        return None
    if not rel_path or "/" in rel_path or not rel_path.lower().endswith(".safetensors"):
        return None

    is_lora = "lora" in repo_id.lower()
    category = "loras" if is_lora else "diffusion_models"
    manager_type = "lora" if is_lora else "diffusion_model"
    base = infer_flux_base(repo_id, filename)
    if not base and is_lora:
        # For BFL lora repos, base follows the named model family.
        base = "FLUX.1 [dev]"

    return {
        "filename": filename,
        "type": manager_type,
        "base": base or "",
        "save_path": category,
        "repo_id": repo_id,
        "is_bfl_manager_overlay": True,
    }


def build_manager_index(manager_data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = manager_data.get("models", [])
    if not isinstance(rows, list):
        return {}

    by_filename: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        filename = str(row.get("filename") or "").strip()
        if not filename:
            continue
        by_filename[filename] = row
    return by_filename


def build_cloud_index(cloud_data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = cloud_data.get("models", {})
    if not isinstance(rows, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for filename, row in rows.items():
        if isinstance(row, dict):
            out[str(filename)] = row
    return out


def resolve_source_rank(source: str) -> int:
    return int(SOURCE_RANKS.get(source, 9))


def main() -> int:
    args = parse_args()
    popular_path = resolve_cli_path(args.popular)
    cloud_path = resolve_cli_path(args.cloud)
    manager_path = resolve_cli_path(args.manager_model_list)
    summary_path = resolve_cli_path(args.summary_out)

    popular_doc = load_json(popular_path)
    cloud_doc = load_json(cloud_path)
    manager_doc = load_json(manager_path)

    overrides_path = REPO_ROOT / "metadata" / "manual-curation-overrides.json"
    overrides = {}
    if overrides_path.exists():
        try:
            overrides_doc = load_json(overrides_path)
            overrides = overrides_doc.get("overrides", {}) if isinstance(overrides_doc, dict) else {}
        except Exception as e:
            print(f"[WARN] Failed to load overrides: {e}")

    models = popular_doc.get("models", {}) if isinstance(popular_doc, dict) else {}
    if not isinstance(models, dict):
        raise ValueError("popular-models.json has invalid schema: models must be object")

    cloud_by_filename = build_cloud_index(cloud_doc if isinstance(cloud_doc, dict) else {})
    manager_by_filename = build_manager_index(manager_doc if isinstance(manager_doc, dict) else {})

    # Curated families are the authoritative non-priority sources that define which
    # model stems may receive additional GGUF quantizations from priority repos.
    curated_family_keys: set[tuple[str, str]] = set()
    curated_categories_by_stem: dict[str, set[str]] = {}
    for filename, raw in models.items():
        if not isinstance(raw, dict):
            continue
        source_value = str(raw.get("source") or "").strip()
        if source_value not in {"cloud_marketplace_export", "comfyui_manager_model_list"}:
            continue
        row_filename = str(raw.get("filename") or filename or "").strip()
        if not row_filename:
            continue
        category_value = str(raw.get("explorer_category") or "").strip()
        if not category_value:
            category_value = (
                get_category_root(raw.get("directory"))
                or get_category_from_manager_type(raw.get("manager_type"))
                or get_category_from_manager_type(raw.get("type"))
                or ""
            )
        category_value = str(category_value or "").strip()
        if not category_value:
            continue
        stem = normalize_group_stem(row_filename)
        if not stem:
            continue
        curated_family_keys.add((category_value, stem))
        curated_categories_by_stem.setdefault(stem, set()).add(category_value)

    built_at = datetime.now(tz=timezone.utc).isoformat()

    source_counts = Counter()
    explorer_enabled_counts = Counter()
    category_counts = Counter()
    base_unknown_counts = Counter()
    bfl_promoted_count = 0
    special_upscale_promoted_count = 0

    updated_models: dict[str, dict[str, Any]] = {}
    for filename, raw_entry in models.items():
        if not isinstance(raw_entry, dict):
            continue

        entry = copy.deepcopy(raw_entry)
        row_filename = str(entry.get("filename") or filename or "").strip()
        if not row_filename:
            continue

        entry["filename"] = row_filename
        existing_row_base = canonicalize_base_name(entry.get("base"))
        if existing_row_base:
            entry["base"] = existing_row_base
        source = str(entry.get("source") or "").strip() or "unknown"
        original_source = str(entry.get("source_origin") or "").strip() or source
        source_counts[source] += 1

        url = entry.get("url")
        provider = str(entry.get("provider") or "").strip().lower()
        if not provider:
            provider = provider_from_url(url)
        if provider:
            entry["provider"] = provider

        row_repo_id = str(entry.get("repo_id") or "").strip()
        if not row_repo_id:
            row_repo_id, _ = parse_hf_repo_and_path(entry.get("url"))
            if row_repo_id:
                entry["repo_id"] = row_repo_id
        if is_excluded_repo(row_repo_id):
            continue
        row_owner = row_repo_id.split("/", 1)[0].strip().lower() if "/" in row_repo_id else ""
        is_priority_gguf_row = (
            source == "priority_repo_scrape"
            and str(entry.get("type") or "").strip().lower() in {"gguf", "gguf_model"}
            and str(entry.get("filename") or "").strip().lower().endswith(".gguf")
        )
        if is_priority_gguf_row and row_owner in PRIORITY_GGUF_VISIBLE_OWNERS:
            entry["library_visible"] = True
        allow_priority_gguf = is_priority_gguf_row and row_owner in PRIORITY_GGUF_VISIBLE_OWNERS

        manager_row_native = manager_by_filename.get(row_filename)
        manager_row = manager_row_native
        special_upscale_overlay = build_special_upscale_overlay(entry, row_filename)
        if special_upscale_overlay is not None:
            manager_row = special_upscale_overlay
            if source != "cloud_marketplace_export" and not special_upscale_overlay.get("is_lightx2v_overlay"):
                source = "comfyui_manager_model_list"
                entry["source"] = source
                if manager_row_native is None:
                    entry["source_origin"] = "priority_repo_scrape"
                else:
                    entry["source_origin"] = original_source
                special_upscale_promoted_count += 1
            if special_upscale_overlay.get("display_filename"):
                entry["filename"] = str(special_upscale_overlay.get("display_filename") or "").strip() or entry.get("filename")
            entry["directory"] = str(special_upscale_overlay.get("save_path") or entry.get("directory") or "").strip()
            entry["type"] = str(special_upscale_overlay.get("type") or entry.get("type") or "").strip()
            if special_upscale_overlay.get("base"):
                entry["base"] = special_upscale_overlay.get("base")
            if special_upscale_overlay.get("repo_id"):
                entry["repo_id"] = special_upscale_overlay.get("repo_id")

        bfl_overlay = build_bfl_manager_overlay(entry, row_filename)
        if bfl_overlay is not None:
            manager_row = bfl_overlay
        if bfl_overlay is not None and source != "cloud_marketplace_export":
            source = "comfyui_manager_model_list"
            entry["source"] = source
            if manager_row_native is None:
                entry["source_origin"] = "priority_repo_scrape"
            else:
                entry["source_origin"] = original_source
            bfl_promoted_count += 1
        if (
            isinstance(manager_row, dict)
            and manager_row.get("is_bfl_manager_overlay")
            and str(entry.get("directory") or "").strip() in {"", "checkpoints"}
        ):
            entry["directory"] = str(manager_row.get("save_path") or "").strip()
            if source != "cloud_marketplace_export":
                entry["type"] = str(manager_row.get("type") or entry.get("type") or "").strip()
            if manager_row.get("base"):
                entry["base"] = manager_row.get("base")
        cloud_row = cloud_by_filename.get(row_filename)

        own_category = get_category_root(entry.get("directory"))
        existing_category = str(entry.get("explorer_category") or "").strip()
        existing_category_verified = bool(entry.get("explorer_category_verified"))
        cloud_category = get_category_root(cloud_row.get("directory")) if isinstance(cloud_row, dict) else None
        manager_category = get_category_root(manager_row.get("save_path")) if isinstance(manager_row, dict) else None
        manager_type_category = (
            get_category_from_manager_type(manager_row.get("type")) if isinstance(manager_row, dict) else None
        )

        category = cloud_category or manager_category or manager_type_category or own_category
        category_verified = bool(cloud_category or manager_category or manager_type_category)
        if existing_category_verified and existing_category in ALLOWED_EXPLORER_CATEGORIES:
            # Preserve curator/manual category edits across rebuilds.
            category = existing_category
            category_verified = True
        
        # Fallback for cloud marketplace catalog models that are not mapped to any specific category
        if not category and source == "cloud_marketplace_export":
            category = "other"
            category_verified = True

        repo_id_for_category = str(entry.get("repo_id") or "").strip()
        if not repo_id_for_category:
            repo_id_for_category, _ = parse_hf_repo_and_path(entry.get("url"))
        if category == "checkpoints":
            inferred_flux_base_for_category = infer_flux_base(repo_id_for_category, row_filename)
            if inferred_flux_base_for_category and "lora" not in row_filename.lower():
                category = "diffusion_models"
                if str(entry.get("directory") or "").strip() in {"", "checkpoints"}:
                    entry["directory"] = "diffusion_models"
                category_verified = category_verified or source in {
                    "cloud_marketplace_export",
                    "comfyui_manager_model_list",
                }

        stem_key = normalize_group_stem(row_filename)
        if allow_priority_gguf and source == "priority_repo_scrape" and stem_key:
            exact_categories = curated_categories_by_stem.get(stem_key, set())
            candidate_categories = exact_categories
            if category and category not in candidate_categories and len(candidate_categories) == 1:
                aligned_category = next(iter(candidate_categories))
                category = aligned_category
                directory_value = str(entry.get("directory") or "").strip().replace("\\", "/").strip("/")
                suffix = directory_value.split("/", 1)[1] if "/" in directory_value else ""
                entry["directory"] = f"{aligned_category}/{suffix}" if suffix else aligned_category
                category_verified = True

        if category:
            category_counts[category] += 1

        base_applicable = category in BASE_APPLICABLE_CATEGORIES
        base_value = None
        base_verified = False
        base_from = "not_applicable"
        if base_applicable:
            existing_base = str(entry.get("explorer_base") or "").strip()
            existing_base_verified = bool(entry.get("explorer_base_verified"))
            existing_base = canonicalize_base_name(existing_base)
            if existing_base_verified and existing_base and existing_base.lower() != "unknown":
                # Preserve curator/manual base labels exactly as entered.
                base_value = existing_base
                base_verified = True
                base_from = "manual_verified_row"
            else:
                repo_id_for_base = str(entry.get("repo_id") or "").strip()
                if not repo_id_for_base:
                    repo_id_for_base, _ = parse_hf_repo_and_path(entry.get("url"))
                inferred_flux_base = infer_flux_base(repo_id_for_base, row_filename)
                inferred_wan = infer_wan_base(repo_id_for_base, row_filename)
                inferred_qwen = infer_qwen_base(repo_id_for_base, row_filename)
                manager_base = canonicalize_base_name((manager_row or {}).get("base"))
                own_base = canonicalize_base_name(entry.get("base"))
                if manager_base:
                    base_value = manager_base
                    base_verified = True
                    base_from = "manager"
                elif own_base:
                    base_value = own_base
                    base_verified = source in {"comfyui_manager_model_list", "cloud_marketplace_export"}
                    base_from = "row"
                else:
                    if inferred_flux_base:
                        base_value = inferred_flux_base
                        base_verified = source in {"comfyui_manager_model_list", "cloud_marketplace_export"}
                        base_from = "inferred_flux_family"
                    else:
                        if inferred_wan:
                            base_value = inferred_wan
                            base_verified = source in {"comfyui_manager_model_list", "cloud_marketplace_export"}
                            base_from = "inferred_wan_family"
                        elif inferred_qwen:
                            base_value = inferred_qwen
                            base_verified = source in {"comfyui_manager_model_list", "cloud_marketplace_export"}
                            base_from = "inferred_qwen_family"
                        else:
                            base_value = "unknown"
                            base_verified = False
                            base_from = "fallback_unknown"
                            base_unknown_counts[category or "unknown_category"] += 1

                # Normalize legacy manager/cloud base labels (e.g. "FLUX.1") to explicit
                # family labels requested by the model explorer taxonomy.
                if inferred_flux_base and str(base_value).strip().lower() in {"flux.1", "flux.2", "unknown"}:
                    base_value = inferred_flux_base
                    if base_from == "manager":
                        base_from = "manager_plus_flux_override"
                    elif base_from == "row":
                        base_from = "row_plus_flux_override"
                if inferred_wan and str(base_value).strip().lower() in {"wan2.2", "wan 2.2", "unknown", "wab-5b ti2v"}:
                    base_value = inferred_wan
                    if base_from == "manager":
                        base_from = "manager_plus_wan_override"
                    elif base_from == "row":
                        base_from = "row_plus_wan_override"
                if inferred_qwen and str(base_value).strip().lower() in {"qwen", "unknown"}:
                    base_value = inferred_qwen
                    if base_from == "manager":
                        base_from = "manager_plus_qwen_override"
                    elif base_from == "row":
                        base_from = "row_plus_qwen_override"

            base_value = canonicalize_base_name(base_value)
            if base_value and base_value.lower() != "unknown":
                entry["base"] = base_value

        explorer_enabled_core = (
            source in {"cloud_marketplace_export", "comfyui_manager_model_list"}
            and bool(category)
            and bool(category_verified)
            and (not base_applicable or bool(base_value))
        )
        priority_family_supported = bool(category) and bool(stem_key) and (
            (category, stem_key) in curated_family_keys
        )
        # Whitelist Comfy-Org models by default
        is_comfy_org = str(entry.get("repo_id") or "").lower().startswith("comfy-org/")
        explorer_enabled_priority = (
            source == "priority_repo_scrape"
            and bool(category)
            and (not base_applicable or bool(base_value))
            and (is_comfy_org or (allow_priority_gguf and priority_family_supported))
            and bool(entry.get("library_visible", True))
        )
        explorer_enabled = bool(explorer_enabled_core or explorer_enabled_priority)

        entry["explorer_category"] = category
        entry["explorer_category_verified"] = category_verified
        entry["explorer_base"] = base_value
        entry["explorer_base_verified"] = base_verified
        entry["explorer_base_applicable"] = bool(base_applicable)
        entry["explorer_enabled"] = bool(explorer_enabled)

        # Apply manual curation overrides if present
        row_override = overrides.get(row_filename)
        if isinstance(row_override, dict):
            if "explorer_category" in row_override:
                entry["explorer_category"] = row_override["explorer_category"]
                entry["explorer_category_verified"] = True
                category = row_override["explorer_category"]
                category_verified = True
            if "explorer_base" in row_override:
                entry["explorer_base"] = row_override["explorer_base"]
                entry["explorer_base_verified"] = True
                base_value = row_override["explorer_base"]
                base_verified = True
            if "explorer_enabled" in row_override:
                entry["explorer_enabled"] = bool(row_override["explorer_enabled"])
                explorer_enabled = entry["explorer_enabled"]

        entry["explorer_group_stem"] = normalize_group_stem(row_filename)
        entry["source_rank"] = resolve_source_rank(source)
        entry["updated_from"] = {
            "script": "build_unified_models_db.py",
            "built_at": built_at,
            "category_from": (
                "cloud"
                if cloud_category
                else (
                    "manager"
                    if manager_category
                    else ("manager_type" if manager_type_category else ("row" if own_category else "none"))
                )
            ),
            "base_from": base_from,
            "matched_manager": bool(manager_row),
            "matched_cloud": bool(cloud_row),
        }

        if isinstance(cloud_row, dict) and not entry.get("preview_url") and cloud_row.get("preview_url"):
            entry["preview_url"] = cloud_row.get("preview_url")
        if isinstance(cloud_row, dict) and not entry.get("repo_id") and cloud_row.get("repo_id"):
            entry["repo_id"] = cloud_row.get("repo_id")
        if isinstance(cloud_row, dict) and not entry.get("content_length") and cloud_row.get("content_length") is not None:
            entry["content_length"] = cloud_row.get("content_length")

        manager_size_text = ""
        manager_size_bytes = None
        manager_size_raw = None
        if isinstance(manager_row_native, dict):
            manager_size_raw = manager_row_native.get("size")
        elif isinstance(manager_row, dict):
            manager_size_raw = manager_row.get("size")
        if manager_size_raw not in (None, ""):
            manager_size_text = str(manager_size_raw).strip()
            manager_size_bytes = parse_size_to_bytes(manager_size_raw)
        if manager_size_text and not entry.get("size"):
            entry["size"] = manager_size_text
        if manager_size_bytes is not None and entry.get("content_length") in (None, "", 0):
            entry["content_length"] = manager_size_bytes

        explorer_enabled_counts["enabled" if explorer_enabled else "disabled"] += 1
        updated_models[row_filename] = entry

    # Fill unknown bases from known sibling variants in the same (category, group stem).
    base_by_family: dict[tuple[str, str], set[str]] = {}
    for row in updated_models.values():
        if not isinstance(row, dict):
            continue
        category = str(row.get("explorer_category") or "").strip()
        if category not in BASE_APPLICABLE_CATEGORIES:
            continue
        stem = normalize_group_stem(str(row.get("filename") or ""))
        if not stem:
            continue
        base_val = canonicalize_base_name(row.get("explorer_base"))
        if not base_val or base_val.lower() == "unknown":
            continue
        base_by_family.setdefault((category, stem), set()).add(base_val)

    for row in updated_models.values():
        if not isinstance(row, dict):
            continue
        category = str(row.get("explorer_category") or "").strip()
        if category not in BASE_APPLICABLE_CATEGORIES:
            continue
        current_base = canonicalize_base_name(row.get("explorer_base"))
        if current_base and current_base.lower() != "unknown":
            continue
        stem = normalize_group_stem(str(row.get("filename") or ""))
        if not stem:
            continue
        family_bases = base_by_family.get((category, stem)) or set()
        if len(family_bases) != 1:
            continue
        inferred_base = next(iter(family_bases))
        row["explorer_base"] = inferred_base
        row["explorer_base_verified"] = False
        if not canonicalize_base_name(row.get("base")) or canonicalize_base_name(row.get("base")).lower() == "unknown":
            row["base"] = inferred_base
        updated_from = row.get("updated_from")
        if isinstance(updated_from, dict):
            updated_from["base_from"] = "sibling_group_infer"

    output_doc = copy.deepcopy(popular_doc if isinstance(popular_doc, dict) else {})
    output_doc["version"] = "2.0.0"
    output_doc["description"] = "Unified models database with explorer-normalized fields"
    output_doc["source"] = "unified_models_db"
    output_doc["models"] = updated_models

    summary = {
        "built_at": built_at,
        "popular_path": str(popular_path),
        "cloud_path": str(cloud_path),
        "manager_model_list_path": str(manager_path),
        "total_rows": len(updated_models),
        "source_counts": dict(source_counts.most_common()),
        "explorer_enabled_counts": dict(explorer_enabled_counts),
        "category_counts": dict(category_counts.most_common()),
        "base_unknown_counts": dict(base_unknown_counts.most_common()),
        "bfl_promoted_count": int(bfl_promoted_count),
        "special_upscale_promoted_count": int(special_upscale_promoted_count),
    }

    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=True), encoding="utf-8")

    if args.write:
        popular_path.write_text(json.dumps(output_doc, indent=2, ensure_ascii=True), encoding="utf-8")
        print(f"Wrote unified DB: {popular_path}")
    else:
        print("Dry run (no DB write)")

    print(f"Wrote summary: {summary_path}")
    print(f"Rows: {len(updated_models)}")
    print(f"Explorer enabled: {explorer_enabled_counts.get('enabled', 0)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
