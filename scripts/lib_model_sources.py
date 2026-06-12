"""Shared model-source normalization helpers used by dev scripts and internal tools."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

MODEL_EXTENSIONS = {
    ".safetensors",
    ".ckpt",
    ".pt",
    ".bin",
    ".pth",
    ".gguf",
    ".onnx",
    ".zip",
}

COMFY_CLOUD_ORIGIN = "https://cloud.comfy.org"

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
    "background_removal",
    "frame_interpolation",
    "other",
}

BASE_APPLICABLE_CATEGORIES = {"checkpoints", "diffusion_models", "loras"}

MANAGER_TYPE_CATEGORY_MAP = {
    "upscale": "upscale_models",
    "upscale_model": "upscale_models",
    "checkpoint": "checkpoints",
    "checkpoints": "checkpoints",
    "diffusion_model": "diffusion_models",
    "diffusion_models": "diffusion_models",
    "unet": "diffusion_models",
    "lora": "loras",
    "loras": "loras",
    "vae": "vae",
    "controlnet": "controlnet",
    "text_encoder": "text_encoders",
    "text_encoders": "text_encoders",
    "clip_vision": "clip_vision",
    "ipadapter": "ipadapter",
    "vae_approx": "vae_approx",
    "style_model": "style_models",
    "style_models": "style_models",
    "model_patch": "model_patches",
    "model_patches": "model_patches",
    "animatediff_model": "animatediff_models",
    "animatediff_models": "animatediff_models",
    "animatediff_motion_lora": "animatediff_motion_lora",
    "motion_lora": "animatediff_motion_lora",
    "latent_upscale_model": "latent_upscale_models",
    "latent_upscale_models": "latent_upscale_models",
    "background_removal": "background_removal",
    "background_removal_model": "background_removal",
    "frame_interpolation": "frame_interpolation",
    "frame_interpolators": "frame_interpolation",
    "other": "other",
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
FP8_COMPACT_PATTERN = re.compile(r"(?:^|_)(fp8(?:mixed|scaled)|fp8_(?:mixed|scaled))(?:_|$)", re.IGNORECASE)
BASE_CANONICAL_SPACE_RE = re.compile(r"[\s_-]+")
BASE_CANONICAL_ALNUM_RE = re.compile(r"[^a-z0-9]+")
HUNYUAN_VIDEO_15_RE = re.compile(r"\b1(?:[.\s_-]?5)\b")

LIGHTX2V_MODELS_REPO = "lightx2v/models"
LIGHTX2V_ENCODERS_REPO = "lightx2v/encoders"
LIGHTX2V_ALLOWED_REPO_IDS = {LIGHTX2V_MODELS_REPO, LIGHTX2V_ENCODERS_REPO}

_LIGHTX2V_AMBIGUOUS_BASENAME_PREFIXES = (
    "model.",
    "model_",
    "high_model.",
    "high_model_",
    "hig model.",
    "hig_model.",
    "distill_model.",
    "distill_model_",
    "distill_high_model.",
    "distill_high_model_",
    "fp8_model.",
    "fp8_model_",
    "int8_model.",
    "int8_model_",
    "high_noise_model.",
)


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


def get_category_from_manager_type(value: str | None) -> str | None:
    key = str(value or "").strip().lower()
    if not key:
        return None
    category = MANAGER_TYPE_CATEGORY_MAP.get(key)
    if category in ALLOWED_EXPLORER_CATEGORIES:
        return category
    return None


def provider_from_url(url: Any) -> str:
    if not isinstance(url, str) or not url.strip():
        return ""
    try:
        return (urlparse(url.strip()).netloc or "").lower()
    except Exception:
        return ""


def parse_hf_repo_and_path(url: Any) -> tuple[str, str]:
    if not isinstance(url, str) or not url.strip():
        return "", ""
    value = url.strip()
    marker = "huggingface.co/"
    idx = value.lower().find(marker)
    if idx < 0:
        return "", ""
    remainder = value[idx + len(marker) :]
    parts = [p for p in remainder.split("/") if p]
    if len(parts) < 4:
        return "", ""
    owner = parts[0]
    repo = parts[1]
    repo_id = f"{owner}/{repo}"
    try:
        resolve_idx = parts.index("resolve")
    except ValueError:
        return repo_id, ""
    if len(parts) <= resolve_idx + 2:
        return repo_id, ""
    rel_path = "/".join(parts[resolve_idx + 2 :]).split("?", 1)[0]
    return repo_id, rel_path


def infer_cloud_type(folder: str, name: str) -> str:
    lowered_folder = (folder or "").lower()
    lowered_name = (name or "").lower()
    ext = os.path.splitext(lowered_name)[1]

    if "controlnet" in lowered_folder or "controlnet" in lowered_name:
        return "controlnet"
    if "lora" in lowered_folder or "lora" in lowered_name:
        return "lora"
    if "vae" in lowered_folder or "_vae" in lowered_name:
        return "vae"
    if "clip_vision" in lowered_folder or "image_encoder" in lowered_name:
        return "clip_vision"
    if "text_encoder" in lowered_folder or "text_encoders" in lowered_folder:
        return "text_encoder"
    if "upscale" in lowered_folder or "esrgan" in lowered_name:
        return "upscale"
    if "ipadapter" in lowered_folder:
        return "ipadapter"
    if ext == ".gguf":
        return "gguf"
    if ext == ".onnx":
        return "onnx"
    return "checkpoint"


def normalize_preview_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    preview = value.strip()
    if not preview:
        return None
    if preview.startswith("/api/view?"):
        return f"{COMFY_CLOUD_ORIGIN}{preview}"
    return preview


def normalize_group_stem(filename: str) -> str:
    stem = Path(filename).stem.lower()
    stem = stem.replace("-", "_")
    stem = FP8_COMPACT_PATTERN.sub("_", stem)
    stem = PRECISION_PATTERN.sub("_", stem)
    stem = re.sub(r"(?:^|_)(?:mixed|scaled)(?:_|$)", "_", stem)
    stem = re.sub(r"(?<=[a-z])_(?=\d)", "", stem)
    stem = re.sub(r"(?<=\d)_(?=[a-z])", "", stem)
    stem = re.sub(r"_+", "_", stem).strip("_")
    return stem or Path(filename).stem.lower()


def infer_lightx2v_base(repo_id: str, rel_path: str, filename: str = "") -> str:
    text = f"{repo_id} {rel_path} {filename}".lower().replace("_", " ").replace("-", " ")
    if "wan 2.2" in text and "a14b" in text:
        return "WAN 2.2 A14B"
    if "wan 2.1" in text:
        return "WAN 2.1"
    if "wan 1.3b" in text or "wan13b" in text:
        return "WAN 1.3B"
    if "qwen image edit" in text:
        return "Qwen Image Edit"
    if "qwen image" in text:
        return "Qwen Image"
    if "hunyuanvideo 1.5" in text or "hunyuan video 1.5" in text:
        return "HunyuanVideo-1.5"
    if "z image" in text:
        return "Z-Image"
    if "qwen" in text:
        return "Qwen"
    if "wan" in text:
        return "WAN"
    return ""


def canonicalize_base_name(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    lowered = raw.lower().strip()
    if lowered == "unknown":
        return "unknown"

    normalized = BASE_CANONICAL_SPACE_RE.sub(" ", lowered).strip()
    compact = normalized.replace(" ", "")
    alnum = BASE_CANONICAL_ALNUM_RE.sub("", lowered)

    if "qwen" in normalized:
        if (
            "imageedit" in compact
            or "umageedit" in compact
            or (("image" in normalized or "umage" in normalized) and "edit" in normalized)
        ):
            return "Qwen Image Edit"
        if "image" in normalized or "umage" in normalized:
            return "Qwen Image"

    if "pixart" in compact:
        return "PixArt"

    if "hunyuanvideo15" in alnum:
        return "HunyuanVideo-1.5"
    if "hunyuanvideo" in compact or "hunyuan video" in normalized:
        if HUNYUAN_VIDEO_15_RE.search(normalized) or normalized in {"hunyuan video", "hunyuanvideo"}:
            return "HunyuanVideo-1.5"

    return raw


def infer_flux_base(repo_id: str, filename: str) -> str | None:
    text = f"{repo_id} {filename}".lower()
    if "redux" in text:
        return None
    if "flux.2-klein-base-9b" in text or "flux-2-klein-base-9b" in text:
        return "FLUX.2 [klein] 9B"
    if "flux.2-klein-9b" in text or "flux-2-klein-9b" in text:
        return "FLUX.2 [klein] 9B"
    if "flux.2-klein-base-4b" in text or "flux-2-klein-base-4b" in text:
        return "FLUX.2 [klein] 4B"
    if "flux.2-klein-4b" in text or "flux-2-klein-4b" in text:
        return "FLUX.2 [klein] 4B"
    if "flux.2-dev" in text or "flux2-dev" in text:
        return "FLUX.2 [dev]"
    if "kontext" in text:
        return "FLUX.1 Kontext [dev]"
    if "fill" in text:
        return "FLUX.1 Fill [dev]"
    if "schnell" in text:
        return "FLUX.1 [schnell]"
    if "canny" in text or "depth" in text or "krea" in text:
        return "FLUX.1 [dev]"
    if "flux.1-dev" in text or "flux1-dev" in text:
        return "FLUX.1 [dev]"
    return None


def infer_wan_base(repo_id: str, filename: str) -> str | None:
    text = f"{repo_id} {filename}".lower().replace("_", "-")
    if not any(token in text for token in ("wan2.2", "wan2-2", "wan 2.2", "wan22")):
        return None
    if "ti2v" in text and "5b" in text:
        return "Wab-5B TI2V"
    return "Wan2.2"


def infer_qwen_base(repo_id: str, filename: str) -> str | None:
    text = f"{repo_id} {filename}".lower().replace("_", " ").replace("-", " ")
    if "qwen" not in text:
        return None
    if "qwen image edit" in text or "qwen umage edit" in text:
        return "Qwen Image Edit"
    if "qwen image" in text or "qwen umage" in text:
        return "Qwen Image"
    return "Qwen"


def lightx2v_should_use_subfolder(
    basename: str,
    subdir: str,
    basename_count: int = 1,
) -> bool:
    if not subdir:
        return False
    lowered = str(basename or "").strip().lower()
    if not lowered:
        return False
    if int(basename_count or 0) > 1:
        return True
    return lowered.startswith(_LIGHTX2V_AMBIGUOUS_BASENAME_PREFIXES)
