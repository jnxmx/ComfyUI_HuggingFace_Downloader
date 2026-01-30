import os
import re
import json
import time
from typing import List, Dict, Any, Tuple
from huggingface_hub import HfApi
from .downloader import get_token
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
]

POPULAR_MODELS_FILE = os.path.join(os.path.dirname(__file__), "metadata", "popular-models.json")
_popular_models_cache = None
_manager_model_list_cache = None
_hf_search_cache: dict[str, dict | None] = {}
_hf_api_calls = 0
_hf_rate_limited_until = 0.0

HF_SEARCH_MAX_CALLS = int(os.getenv("HF_SEARCH_MAX_CALLS", "200"))
HF_SEARCH_RATE_LIMIT_SECONDS = int(os.getenv("HF_SEARCH_RATE_LIMIT_SECONDS", "300"))

HF_SEARCH_SKIP_FILENAMES = {
    "pytorch_model.bin",
    "adapter_model.bin",
    "diffusion_pytorch_model.bin",
    "model.safetensors",
    "model.bin",
    "model.ckpt",
    "model.pt",
    "config.json",
    "tokenizer.json",
}

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

def normalize_save_path(save_path: str | None) -> str | None:
    if not save_path:
        return None
    normalized = save_path.replace("\\", "/")
    if normalized.startswith("models/"):
        normalized = normalized.split("/", 1)[1]
    return normalized or None

def normalize_filename_key(name: str) -> str:
    base = os.path.basename(name.replace("\\", "/")).strip()
    return base.lower()

def normalize_filename_compact(name: str) -> str:
    base = normalize_filename_key(name)
    return re.sub(r'[-_]+', '', base)

def split_model_identifier(value: str) -> Tuple[str, str | None]:
    normalized = value.replace("\\", "/").strip()
    if "/" in normalized:
        return os.path.basename(normalized), normalized
    return normalized, None

def load_popular_models_registry() -> dict:
    """Load curated popular-models.json registry."""
    global _popular_models_cache
    if _popular_models_cache is not None:
        return _popular_models_cache

    if not os.path.exists(POPULAR_MODELS_FILE):
        _popular_models_cache = {}
        return _popular_models_cache

    try:
        with open(POPULAR_MODELS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        models = data.get("models", {})
    except Exception as e:
        print(f"[ERROR] Failed to load popular models registry: {e}")
        _popular_models_cache = {}
        return _popular_models_cache

    registry = {}
    for name, info in models.items():
        url = info.get("url", "")
        if "huggingface.co" not in url:
            continue
        entry = dict(info)
        entry["filename"] = name
        registry[name.lower()] = entry

    _popular_models_cache = registry
    return _popular_models_cache

def load_comfyui_manager_model_list() -> dict:
    """Load ComfyUI Manager model-list.json from known locations."""
    global _manager_model_list_cache
    if _manager_model_list_cache is not None:
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
                if not filename or "huggingface.co" not in url:
                    continue
                filename_lower = filename.lower()
                if filename_lower in model_map:
                    continue
                entry = {
                    "filename": filename,
                    "url": url,
                    "directory": normalize_save_path(model.get("save_path")),
                    "save_path": model.get("save_path"),
                }
                model_map[filename_lower] = entry
        except Exception as e:
            print(f"[ERROR] Failed to load manager model list {path}: {e}")

    _manager_model_list_cache = model_map
    return _manager_model_list_cache

def enrich_model_with_url(model: Dict[str, Any], url: str, source: str, directory: str | None = None):
    model["url"] = url
    model["source"] = source
    if directory and not model.get("suggested_folder"):
        model["suggested_folder"] = directory
    hf_repo, hf_path = extract_huggingface_info(url)
    if hf_repo:
        model["hf_repo"] = hf_repo
        model["hf_path"] = hf_path

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

def load_comfyui_manager_cache(missing_models: List[Dict[str, Any]], status_cb=None) -> List[Dict[str, Any]]:
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
        if model.get("url"):
            continue
        if status_cb:
            status_cb({
                "message": "Checking manager cache",
                "source": "manager_cache",
                "filename": model.get("filename")
            })
        filename = model["filename"]
        requested_path = model.get("requested_path") or filename
        filename_key = filename.lower()
        entry = manager_map.get(filename_key) or manager_map.get(os.path.basename(filename_key))
        if entry and entry.get("url"):
            enrich_model_with_url(
                model,
                entry["url"],
                "manager_model_list",
                directory=entry.get("directory")
            )
            print(f"[DEBUG] Found URL in Manager cache for {filename}: {entry['url']}")

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
    
    # ControlNet Aux Preprocessors (comfyui_controlnet_aux)
    "DepthAnythingV2Preprocessor": "custom_nodes/comfyui_controlnet_aux/ckpts/depth-anything",
    "AIO_Preprocessor": None,  # Uses different models depending on type parameter
}


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

def resolve_node_folder(node: dict) -> str | None:
    node_type = node.get("type", "")
    if node_type in NODE_TYPE_MAPPING:
        return NODE_TYPE_MAPPING[node_type]

    properties = node.get("properties") or {}
    cnr_id = (properties.get("cnr_id") or "").lower()
    node_type_lower = node_type.lower()

    if "gguf" in node_type_lower or "gguf" in cnr_id:
        if "clip" in node_type_lower:
            return "text_encoders"
        if "vae" in node_type_lower:
            return "vae"
        if "lora" in node_type_lower:
            return "loras"
        return "diffusion_models"

    if "kjnodes" in cnr_id:
        if "clip" in node_type_lower:
            return "text_encoders"
        if "vae" in node_type_lower:
            return "vae"
        if "lora" in node_type_lower:
            return "loras"
        if "unet" in node_type_lower or "model" in node_type_lower:
            return "diffusion_models"

    return None

def resolve_proxy_widget_folder(widget_name: str | None) -> str | None:
    if not widget_name:
        return None
    name = widget_name.lower()
    if "unet" in name:
        return "diffusion_models"
    if "clip" in name:
        return "text_encoders"
    if "vae" in name:
        return "vae"
    if "lora" in name:
        return "loras"
    if "checkpoint" in name or "ckpt" in name:
        return "checkpoints"
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
            suggested_folder = resolve_proxy_widget_folder(widget_name)
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
        suggested_folder = resolve_proxy_widget_folder(widget_name)
        results.append({
            "filename": filename,
            "requested_path": requested_path,
            "url": None,
            "suggested_folder": suggested_folder,
            "origin": "proxy_widget"
        })
    return results

def _collect_models_from_nodes(
    nodes: list[dict],
    links_map: dict,
    nodes_by_id: dict,
    found_models: list[dict],
    note_links: dict,
    note_links_normalized: dict,
    node_title_fallback: str
) -> None:
    for node in nodes:
        # Skip disabled/muted nodes
        # 0 = Enabled, 2 = Muted, 4 = Bypass/Disabled?
        # Let's treat anything != 0 and != None as potentially disabled, 
        # or at least explicitly 2 and 4 as knowndisabled states.
        mode = node.get("mode", 0)
        if mode == 2 or mode == 4:
            continue
            
        node_id = node.get("id")
        # Skip disabled/muted nodes
        if node.get("mode") == 2:
            continue
            
        node_title = node.get("title") or node.get("type", node_title_fallback)
        node_type = node.get("type", "")
        node_cnr = ""
        if isinstance(node.get("properties"), dict):
            node_cnr = node["properties"].get("cnr_id", "") or ""

        linked_widget_indices = set()
        linked_widget_names = set()
        widget_pos = 0
        has_linked_widget_input = False
        for input_item in node.get("inputs", []):
            if "widget" in input_item:
                link_id = input_item.get("link")
                if link_id is not None:
                    linked_widget_indices.add(widget_pos)
                    has_linked_widget_input = True
                    input_name = input_item.get("name")
                    if isinstance(input_name, str) and input_name:
                        linked_widget_names.add(input_name)
                widget_pos += 1
        
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
                    "suggested_folder": proxy_model.get("suggested_folder"),
                    "origin": proxy_model.get("origin")
                })
            continue
        
        # Special handling for "Hugging Face Download Model" node
        # This node has widgets: [folder, url, custom_path]
        # We need to extract the custom_path (widgets[2]) to determine the target folder
        if node_type == "Hugging Face Download Model" and "widgets_values" in node:
            widgets = node["widgets_values"]
            if isinstance(widgets, list) and len(widgets) >= 3:
                folder = widgets[0]  # Base folder type (e.g., "checkpoints", "custom")
                url = widgets[1]  # URL
                custom_path = widgets[2]  # Custom subfolder path
                
                # Extract filename from URL
                filename = None
                if url and isinstance(url, str):
                    # Try to extract filename from URL
                    if "/" in url:
                        filename = url.split("/")[-1].split("?")[0]  # Remove query params
                    
                if filename:
                    # Determine suggested folder
                    if custom_path and isinstance(custom_path, str) and custom_path.strip():
                        # User specified custom path
                        suggested_folder = custom_path.strip()
                    elif folder and folder != "custom":
                        # Use base folder
                        suggested_folder = folder
                    else:
                        suggested_folder = None
                    
                    found_models.append({
                        "filename": filename,
                        "url": url,
                        "node_id": node_id,
                        "node_title": node_title,
                        "suggested_folder": suggested_folder
                    })
                    continue  # Skip generic widget scan for this node
        
        # Extract links from Notes - but DON'T add them to found_models
        # They should only be used to enrich loader nodes
        if "Note" in node_type or "PrimitiveString" in node_type:
            if "widgets_values" in node:
                for val in node["widgets_values"]:
                    if isinstance(val, str):
                        # Regex to find markdown links: [text](url)
                        links = re.findall(r'\[([^\]]+)\]\((https?://[^)]+)\)', val, re.IGNORECASE)
                        for label, url in links:
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
            continue  # Don't process Notes as loader nodes

        # 2. Check properties -> models (Standard ComfyUI template format)
        if node_cnr != "comfyui_controlnet_aux":
            if "properties" in node and "models" in node["properties"]:
                if not has_linked_widget_input:
                    for model_info in node["properties"]["models"]:
                        name = model_info.get("name")
                        filename, requested_path = split_model_identifier(name) if name else (name, None)
                        found_models.append({
                            "filename": filename,
                            "requested_path": requested_path,
                            "url": model_info.get("url"),
                            "node_id": node_id,
                            "node_title": node_title,
                            "suggested_folder": model_info.get("directory")
                        })
                
        # 3. Check widgets_values for filenames
        # SKIP for Notes/PrimitiveStrings as we handled them specifically above
        if (
            "widgets_values" in node
            and not ("Note" in node_type or "PrimitiveString" in node_type)
            and node_cnr != "comfyui_controlnet_aux"
        ):
            widgets = node["widgets_values"]
            if isinstance(widgets, list):
                for idx, val in enumerate(widgets):
                    if idx in linked_widget_indices:
                        continue
                    if not isinstance(val, str):
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
                                    suggested_folder = resolve_node_folder(node)
                                    found_models.append({
                                        "filename": parsed_filename,
                                        "url": val,
                                        "node_id": node_id,
                                        "node_title": node_title,
                                        "suggested_folder": suggested_folder
                                    })
                                continue

                    # CASE B: Value is a filename
                    if any(val.endswith(ext) for ext in MODEL_EXTENSIONS):
                        # Avoid duplicates if already found via properties
                        # Note: we don't check against subgraph findings here yet, 
                        # duplicate filtering happens in process_workflow
                        filename, requested_path = split_model_identifier(val)
                        if not any(m["filename"] == filename and m["node_id"] == node_id for m in found_models):
                            # Try to map folder
                            suggested_folder = resolve_node_folder(node)
                            found_models.append({
                                "filename": filename,
                                "requested_path": requested_path,
                                "url": None,
                                "node_id": node_id,
                                "node_title": node_title,
                                "suggested_folder": suggested_folder
                            })

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
    found_models = []

    # Track Note links separately - they should NOT create download entries
    # They should only be used to enrich loader nodes that are missing URLs
    note_links = {}  # {normalized_filename: url}
    note_links_normalized = {}  # {compact_filename: url}

    definitions = workflow.get("definitions", {})
    subgraphs = definitions.get("subgraphs", [])
    for subgraph in subgraphs:
        sub_nodes = subgraph.get("nodes", [])
        sub_links = subgraph.get("links", [])
        sub_links_map = _build_links_map(sub_links)
        sub_nodes_by_id = {n.get("id"): n for n in sub_nodes}
        subgraph_name = subgraph.get("name", "Subgraph")
        _collect_models_from_nodes(
            sub_nodes,
            sub_links_map,
            sub_nodes_by_id,
            found_models,
            note_links,
            note_links_normalized,
            f"Subgraph Node ({subgraph_name})"
        )

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
        "Unknown Node"
    )

    # Enrich found_models with URLs from note_links (highest priority)
    for model in found_models:
        note_key = normalize_filename_key(model["filename"])
        url = note_links.get(note_key)
        if not url:
            url = note_links_normalized.get(normalize_filename_compact(model["filename"]))
        if url:
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

        if not search_paths:
            # Fallback to standard models/ structure if type unknown
            # This might not be ideal as folder_paths.get_folder_paths is the canonical way
            # but provides a safety net.
            comfy_root = getattr(folder_paths, "base_path", os.getcwd())
            if folder_type and (os.path.isabs(folder_type) or _is_path_like(folder_type)):
                search_paths = [folder_type if os.path.isabs(folder_type) else os.path.join(comfy_root, folder_type)]
            else:
                search_paths = [os.path.join(comfy_root, "models", folder_type)]

        found_path = None
        found_root = None
        
        for root_path in search_paths:
             if not os.path.exists(root_path):
                 continue
                 
             # 1. Exact match check (e.g., "model.safetensors" in "models/checkpoints/model.safetensors")
             exact_path = os.path.join(root_path, filename)
             if os.path.exists(exact_path):
                 found_path = exact_path
                 found_root = root_path
                 break
                 
             # 2. Recursive search (e.g., "model.safetensors" in "models/checkpoints/subfolder/model.safetensors")
             found_file = recursive_find_file(filename, root_path)
             if found_file:
                 found_path = found_file
                 found_root = root_path
                 break
        
        if found_path:
            # Calculate relative path to see if it matches the widget value
            try:
                # Get path relative to the *specific* root_path where it was found
                rel_path = os.path.relpath(found_path, found_root)
            except ValueError: # If paths are on different drives, relpath can fail
                rel_path = os.path.basename(found_path) # Fallback to just filename
                
            # Normalize for comparison (e.g., "subfolder\file.safetensors" vs "subfolder/file.safetensors")
            req_norm = requested_path.replace("\\", "/")
            found_norm = rel_path.replace("\\", "/")
            
            model_entry = model.copy()
            model_entry["found_path"] = found_path
            model_entry["clean_path"] = rel_path # Path relative to the model type root
            
            existing.append(model_entry)
            
            # If the requested filename doesn't match the found relative path, it's a mismatch
            # strict check: "foo.safetensors" vs "subfolder/foo.safetensors"
            if req_norm != found_norm:
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

def search_huggingface_model(
    filename: str,
    token: str = None,
    status_cb=None,
    mode: str = "full"
) -> Dict[str, Any] | None:
    """
    Searches Hugging Face for the filename, prioritizing specific authors.
    Returns metadata dict with url/hf_repo/hf_path or None.
    """
    api = HfApi(token=token)

    key = _normalize_hf_search_key(filename)
    if key in _hf_search_cache:
        return _hf_search_cache[key]

    if key in HF_SEARCH_SKIP_FILENAMES:
        print(f"[DEBUG] Skipping HF search for generic filename: {filename}")
        _hf_search_cache[key] = None
        return None

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
    
    # 1. Try to search specifically in priority authors' repos first?
    # Actually, listing models by author and filtering is expensive. 
    # Better to use the global search and filter results.
    
    def is_rate_limited_error(err: Exception) -> bool:
        text = str(err)
        return "429" in text or "Too Many Requests" in text or "rate limit" in text.lower()

    try:
        search_terms = build_search_terms(filename)
        models = []
        if status_cb:
            status_cb({
                "message": "Searching Hugging Face",
                "source": "huggingface_search",
                "filename": filename
            })

        if mode in ("basic", "full"):
            for term in search_terms:
                if not _hf_search_allowed():
                    return None
                try:
                    models = list(api.list_models(search=term, limit=20, sort="downloads", direction=-1))
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
                        return None
                    raise
                if models:
                    if term != filename:
                        print(f"[DEBUG] No results for {filename}, trying search term: {term}")
                    break

        # Deep Search Fallback: Check priority authors if still nothing
        # This helps when the file is inside a repo like "flux-fp8" but we search for "flux-vae-bf16"
        if mode in ("priority", "full") and not models:
            print(f"[DEBUG] Still no results, checking priority authors directly...")
            if status_cb:
                status_cb({
                    "message": "Checking priority authors",
                    "source": "huggingface_priority_authors",
                    "filename": filename
                })
            total_authors = len(PRIORITY_AUTHORS)
            for author_index, author in enumerate(PRIORITY_AUTHORS, start=1):
                try:
                    found = []
                    if status_cb:
                        status_cb({
                            "message": f"Checking priority author {author_index}/{total_authors}",
                            "source": "huggingface_priority_authors",
                            "filename": filename,
                            "detail": author
                        })
                    for term in search_terms:
                        if not _hf_search_allowed():
                            return None
                        try:
                            author_models = list(api.list_models(
                                author=author,
                                search=term,
                                limit=15,
                                sort="downloads",
                                direction=-1
                            ))
                        except Exception as e:
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
                            break
                    if not found:
                        if not _hf_search_allowed():
                            return None
                        try:
                            found = list(api.list_models(author=author, limit=100, sort="downloads", direction=-1))
                        except Exception as e:
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

        tokens = []
        for t in re.split(r"[-_]", os.path.splitext(filename)[0]):
            t = t.lower()
            if len(t) >= 3:
                tokens.append(t)
            alpha = re.sub(r"\d+", "", t)
            if len(alpha) >= 3:
                tokens.append(alpha)

        for model in models:
            model_id = model.modelId

            # check if file exists in this repo (expensive? let's hope list_repo_files is fast or we assume)
            # Actually, `list_models` primarily matches repo names, but `search` parameter matches content too roughly.
            # A better way is to check if the repo structure likely contains the file.
            # But we can't be 100% sure without listing files.
            
            # Let's prioritize authors
            author = model_id.split("/")[0] if "/" in model_id else ""
            
            if author in PRIORITY_AUTHORS:
                 # Check if this repo actually has the file
                 try:
                     if not _hf_search_allowed():
                         return None
                     files = api.list_repo_files(repo_id=model_id, token=token)
                     if filename in files:
                         result = build_result(model_id, filename)
                         _hf_search_cache[key] = result
                         if status_cb:
                             status_cb({
                                 "message": "Found on Hugging Face",
                                 "source": "huggingface_search",
                                 "filename": filename,
                                 "detail": model_id
                             })
                         return result
                     for f in files:
                         if f.endswith(filename):
                             result = build_result(model_id, f)
                             _hf_search_cache[key] = result
                             if status_cb:
                                 status_cb({
                                     "message": "Found on Hugging Face",
                                     "source": "huggingface_search",
                                     "filename": filename,
                                     "detail": model_id
                                 })
                             return result
                 except Exception:
                     continue

        # If no priority author found, check the rest of the results
        for model in models:
            model_id = model.modelId
            try:
                 if tokens and not any(t in model_id.lower() for t in tokens):
                     continue
                 if not _hf_search_allowed():
                     return None
                 files = api.list_repo_files(repo_id=model_id, token=token)
                 if filename in files:
                     result = build_result(model_id, filename)
                     _hf_search_cache[key] = result
                     if status_cb:
                         status_cb({
                             "message": "Found on Hugging Face",
                             "source": "huggingface_search",
                             "filename": filename,
                             "detail": model_id
                         })
                     return result
                 for f in files:
                     if f.endswith(filename):
                         result = build_result(model_id, f)
                         _hf_search_cache[key] = result
                         if status_cb:
                             status_cb({
                                 "message": "Found on Hugging Face",
                                 "source": "huggingface_search",
                                 "filename": filename,
                                 "detail": model_id
                             })
                         return result
            except Exception:
                 continue

        # Final fallback: scan priority authors more broadly if nothing matched
        if mode in ("priority", "full"):
            for author in PRIORITY_AUTHORS:
            try:
                if not _hf_search_allowed():
                    return None
                author_models = list(api.list_models(author=author, limit=100, sort="downloads", direction=-1))
            except Exception as e:
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
                for model in author_models:
                    model_id = model.modelId
                    try:
                        if tokens and not any(t in model_id.lower() for t in tokens):
                            continue
                        if not _hf_search_allowed():
                            return None
                        files = api.list_repo_files(repo_id=model_id, token=token)
                        if filename in files:
                            result = build_result(model_id, filename)
                            _hf_search_cache[key] = result
                            if status_cb:
                                status_cb({
                                    "message": "Found on Hugging Face",
                                    "source": "huggingface_search",
                                    "filename": filename,
                                    "detail": model_id
                                })
                            return result
                        for f in files:
                            if f.endswith(filename):
                                result = build_result(model_id, f)
                                _hf_search_cache[key] = result
                                if status_cb:
                                    status_cb({
                                        "message": "Found on Hugging Face",
                                        "source": "huggingface_search",
                                        "filename": filename,
                                        "detail": model_id
                                    })
                                return result
                    except Exception as e:
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

    _hf_search_cache[key] = None
    return None

def process_workflow_for_missing_models(workflow_json: Dict[str, Any], status_cb=None) -> Dict[str, Any]:
    """
    Main entry point.
    1. Parse workflow.
    2. Check local models.
    3. If missing, search HF.
    """
    
    global _hf_api_calls
    _hf_api_calls = 0
    required_models = extract_models_from_workflow(workflow_json)

    def _derive_repo_hints_from_filename(name: str) -> set[str]:
        if not name:
            return set()
        stem = os.path.splitext(os.path.basename(name))[0].lower()
        tokens = [t for t in re.split(r"[-_]", stem) if t]
        hints: set[str] = set()

        if tokens:
            first = tokens[0]
            if len(first) >= 4:
                hints.add(first)
            m = re.match(r"([a-z]+)(\d+)", first)
            if m:
                hints.add(f"{m.group(1)}-{m.group(2)}")
                hints.add(f"{m.group(1)}{m.group(2)}")

        if len(tokens) >= 2 and tokens[0].isalpha():
            if tokens[1].isdigit():
                hints.add(f"{tokens[0]}-{tokens[1]}")
                hints.add(f"{tokens[0]}{tokens[1]}")
            if tokens[1].startswith("v") and tokens[1][1:].isdigit():
                hints.add(f"{tokens[0]}-{tokens[1]}")

        return hints

    repo_id_hints: set[str] = set()
    repo_name_hints: set[str] = set()
    for model in required_models:
        url = model.get("url")
        if url:
            repo_id, _ = extract_huggingface_info(url)
            if repo_id:
                repo_id_hints.add(repo_id)
                repo_name_hints.add(repo_id.split("/")[-1])
        repo_name_hints.update(_derive_repo_hints_from_filename(model.get("filename") or ""))

    def _normalize_dedupe_path(value: str | None) -> str:
        if not value:
            return ""
        return value.replace("\\", "/").strip("/")

    def _score_entry(entry: dict) -> int:
        score = 0
        if entry.get("url"):
            score += 10
        if entry.get("node_title") and "hugging face download model" in entry.get("node_title", "").lower():
            score += 5
        requested_path = _normalize_dedupe_path(entry.get("requested_path"))
        if "/" in requested_path:
            score += 4
        if entry.get("suggested_folder"):
            score += 2
        if entry.get("origin") != "proxy_widget":
            score += 1
        return score

    # Collapse duplicates by filename, preferring entries with richer path/folder info.
    grouped_by_name = {}
    for model in required_models:
        filename = (model.get("filename") or "").lower()
        if not filename:
            continue
        grouped_by_name.setdefault(filename, []).append(model)

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
    
    # Remove duplicates based on filename and node_id to avoid redundant checks for the same model in the same node
    # However, if a model is referenced by multiple nodes, we want to keep those distinct entries
    unique_required_models = []
    seen_model_node_pairs = set()
    for model in required_models:
        key = (model["filename"], model["node_id"])
        if key not in seen_model_node_pairs:
            unique_required_models.append(model)
            seen_model_node_pairs.add(key)
    
    # 1. Check local existence using ComfyUI's folder_paths
    missing_models, existing_models, path_mismatches = check_model_files(unique_required_models)

    # 2. Enrich any workflow-provided URLs with source + HF metadata
    for model in missing_models:
        if model.get("url") and not model.get("source"):
            model["source"] = "workflow_metadata"
        if model.get("url") and not model.get("hf_repo"):
            hf_repo, hf_path = extract_huggingface_info(model.get("url", ""))
            if hf_repo:
                model["hf_repo"] = hf_repo
                model["hf_path"] = hf_path

    # 2b. If a requested path includes subfolders, use that for download destination
    for model in missing_models:
        requested_path = model.get("requested_path")
        if not requested_path:
            continue
        normalized = requested_path.replace("\\", "/").strip("/")
        if "/" not in normalized:
            continue
        subfolder = "/".join(normalized.split("/")[:-1])
        if not subfolder:
            continue
        base_folder = model.get("suggested_folder") or "checkpoints"
        if not base_folder.replace("\\", "/").endswith(subfolder):
            model["suggested_folder"] = f"{base_folder}/{subfolder}"

    # 3. Check curated popular models registry
    if missing_models:
        popular_models = load_popular_models_registry()
        for model in missing_models:
            if model.get("url"):
                continue
            if status_cb:
                status_cb({
                    "message": "Checking popular models",
                    "source": "popular_models",
                    "filename": model.get("filename")
                })
            filename_key = model["filename"].lower()
            entry = popular_models.get(filename_key) or popular_models.get(os.path.basename(filename_key))
            if entry and entry.get("url"):
                enrich_model_with_url(
                    model,
                    entry["url"],
                    "popular_models",
                    directory=entry.get("directory")
                )

    # 4. Check ComfyUI Manager model list/cache for missing models
    if missing_models:
        missing_models = load_comfyui_manager_cache(missing_models, status_cb=status_cb)

    # 5. Search HF for remaining missing models (that didn't have URL from registry/manager)
    token = get_token()
    final_missing = []
    for m in missing_models:
        if not m.get("url"):
            if status_cb:
                status_cb({
                    "message": "Searching Hugging Face",
                    "source": "huggingface_search",
                    "filename": m.get("filename")
                })
            # Try HF search
            result = search_huggingface_model(
                m["filename"],
                token,
                status_cb=status_cb,
                repo_hints=sorted(repo_name_hints),
                repo_id_hints=sorted(repo_id_hints)
            )
            if result:
                m["url"] = result.get("url")
                m["hf_repo"] = result.get("hf_repo")
                m["hf_path"] = result.get("hf_path")
                m["source"] = "huggingface_search"
        final_missing.append(m)

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
