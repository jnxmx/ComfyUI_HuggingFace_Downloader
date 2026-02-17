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
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ALLOWED_EXPLORER_CATEGORIES = {
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

BASE_APPLICABLE_CATEGORIES = {"checkpoints", "diffusion_models"}

SOURCE_RANKS = {
    "comfyui_manager_model_list": 1,
    "cloud_marketplace_export": 2,
    "priority_repo_scrape": 3,
}

PRECISION_PATTERN = re.compile(
    r"(?:^|[-_.])("
    r"fp(?:32|16|8|4)"
    r"|bf16"
    r"|int(?:8|4)"
    r"|q\d(?:_[a-z0-9]+)*"
    r"|iq\d(?:_[a-z0-9]+)*"
    r")(?:$|[-_.])",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--popular",
        default="metadata/popular-models.json",
        help="Path to canonical popular-models.json",
    )
    parser.add_argument(
        "--cloud",
        default="metadata/marketplace_extract/from_dump/cloud_marketplace_models.json",
        help="Path to cloud marketplace models export",
    )
    parser.add_argument(
        "--manager-model-list",
        default="temp_repos/ComfyUI-Workflow-Models-Downloader/metadata/model-list.json",
        help="Path to manager model-list.json",
    )
    parser.add_argument(
        "--summary-out",
        default="metadata/marketplace_extract/from_dump/unified_build_summary.json",
        help="Path to build summary output",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Write updates to canonical DB file",
    )
    return parser.parse_args()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_path(value: str | None) -> str:
    return str(value or "").replace("\\", "/").strip().strip("/")


def get_category_root(directory: str | None) -> str | None:
    normalized = normalize_path(directory)
    if not normalized:
        return None
    root = normalized.split("/", 1)[0]
    if root in ALLOWED_EXPLORER_CATEGORIES:
        return root
    return None


def provider_from_url(url: Any) -> str:
    if not isinstance(url, str) or not url.strip():
        return ""
    try:
        return (urlparse(url.strip()).netloc or "").lower()
    except Exception:
        return ""


def normalize_group_stem(filename: str) -> str:
    stem = Path(filename).stem.lower()
    stem = stem.replace("-", "_")
    stem = PRECISION_PATTERN.sub("_", stem)
    stem = re.sub(r"_+", "_", stem).strip("_")
    return stem or Path(filename).stem.lower()


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
    popular_path = Path(args.popular).expanduser().resolve()
    cloud_path = Path(args.cloud).expanduser().resolve()
    manager_path = Path(args.manager_model_list).expanduser().resolve()
    summary_path = Path(args.summary_out).expanduser().resolve()

    popular_doc = load_json(popular_path)
    cloud_doc = load_json(cloud_path)
    manager_doc = load_json(manager_path)

    models = popular_doc.get("models", {}) if isinstance(popular_doc, dict) else {}
    if not isinstance(models, dict):
        raise ValueError("popular-models.json has invalid schema: models must be object")

    cloud_by_filename = build_cloud_index(cloud_doc if isinstance(cloud_doc, dict) else {})
    manager_by_filename = build_manager_index(manager_doc if isinstance(manager_doc, dict) else {})

    built_at = datetime.now(tz=timezone.utc).isoformat()

    source_counts = Counter()
    explorer_enabled_counts = Counter()
    category_counts = Counter()
    base_unknown_counts = Counter()

    updated_models: dict[str, dict[str, Any]] = {}
    for filename, raw_entry in models.items():
        if not isinstance(raw_entry, dict):
            continue

        entry = copy.deepcopy(raw_entry)
        row_filename = str(filename or entry.get("filename") or "").strip()
        if not row_filename:
            continue

        entry["filename"] = row_filename
        source = str(entry.get("source") or "").strip() or "unknown"
        source_counts[source] += 1

        url = entry.get("url")
        provider = str(entry.get("provider") or "").strip().lower()
        if not provider:
            provider = provider_from_url(url)
        if provider:
            entry["provider"] = provider

        manager_row = manager_by_filename.get(row_filename)
        cloud_row = cloud_by_filename.get(row_filename)

        own_category = get_category_root(entry.get("directory"))
        cloud_category = get_category_root(cloud_row.get("directory")) if isinstance(cloud_row, dict) else None
        manager_category = get_category_root(manager_row.get("save_path")) if isinstance(manager_row, dict) else None

        category = cloud_category or manager_category or own_category
        category_verified = bool(cloud_category or manager_category)

        if category:
            category_counts[category] += 1

        base_applicable = category in BASE_APPLICABLE_CATEGORIES
        base_value = None
        base_verified = False
        base_from = "not_applicable"
        if base_applicable:
            manager_base = str((manager_row or {}).get("base") or "").strip()
            if manager_base:
                base_value = manager_base
                base_verified = True
                base_from = "manager"
            else:
                base_value = "unknown"
                base_verified = False
                base_from = "fallback_unknown"
                base_unknown_counts[category or "unknown_category"] += 1

        explorer_enabled = (
            source in {"cloud_marketplace_export", "comfyui_manager_model_list"}
            and bool(category)
            and bool(category_verified)
            and (not base_applicable or bool(base_value))
        )

        entry["explorer_category"] = category
        entry["explorer_category_verified"] = category_verified
        entry["explorer_base"] = base_value
        entry["explorer_base_verified"] = base_verified
        entry["explorer_base_applicable"] = bool(base_applicable)
        entry["explorer_enabled"] = bool(explorer_enabled)
        entry["explorer_group_stem"] = normalize_group_stem(row_filename)
        entry["source_rank"] = resolve_source_rank(source)
        entry["updated_from"] = {
            "script": "build_unified_models_db.py",
            "built_at": built_at,
            "category_from": (
                "cloud"
                if cloud_category
                else ("manager" if manager_category else ("row" if own_category else "none"))
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

        explorer_enabled_counts["enabled" if explorer_enabled else "disabled"] += 1
        updated_models[row_filename] = entry

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

