import os
import re
import json
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
    "city96"
]

def load_comfyui_manager_cache(missing_models: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Checks ComfyUI-Manager cache for missing model URLs and enriches the missing_models list.
    Locations to check:
    - ComfyUI/user/__manager/cache/*.json
    - ComfyUI/user/default/ComfyUI-Manager/cache/*.json
    - ComfyUI/custom_nodes/ComfyUI-Manager/cache/*.json
    """
    # Build filename -> url map from cache
    cache_map = {}
    
    # Get ComfyUI root - folder_paths.base_path should give us the root
    comfy_root = folder_paths.base_path if hasattr(folder_paths, 'base_path') else os.getcwd()
    
    # Potential cache paths
    paths_to_check = [
        os.path.join(comfy_root, "user", "__manager", "cache"), # User mentioned this path
        os.path.join(comfy_root, "user", "default", "ComfyUI-Manager", "cache"),
        os.path.join(comfy_root, "custom_nodes", "ComfyUI-Manager", "cache"),
    ]
    
    for path in paths_to_check:
        if not os.path.exists(path):
            continue
            
        for file in os.listdir(path):
            if file.endswith("model-list.json"):
                try:
                    full_path = os.path.join(path, file)
                    print(f"[DEBUG] Loading Manager cache: {full_path}")
                    with open(full_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        models = data.get("models", [])
                        for m in models:
                            # ComfyUI Manager model list format:
                            # {"filename": "...", "url": "...", "save_path": "..."}
                            filename = m.get("filename")
                            url = m.get("url")
                            if filename and url:
                                cache_map[filename] = url
                except Exception as e:
                    print(f"[ERROR] Failed to load manager cache {file}: {e}")
    
    # Enrich missing_models with URLs from cache
    for model in missing_models:
        if not model.get("url"):
            filename = model["filename"]
            if filename in cache_map:
                model["url"] = cache_map[filename]
                print(f"[DEBUG] Found URL in Manager cache for {filename}: {cache_map[filename]}")
    
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
    "LoaderGGUF": "unet",
    "LoaderGGUFAdvanced": "unet",
    "UnetLoaderGGUF": "unet", # MultiGPU variant
    "ClipLoaderGGUF": "clip",
    "DualClipLoaderGGUF": "clip",
    "TripleClipLoaderGGUF": "clip",
    "QuadrupleClipLoaderGGUF": "clip",
    
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
    
    # 1. Check definitions (subgraphs) if present to find hidden URLs in templates
    definitions = workflow.get("definitions", {})
    subgraphs = definitions.get("subgraphs", [])
    for subgraph in subgraphs:
        sub_nodes = subgraph.get("nodes", [])
        for node in sub_nodes:
            # Recursively check properties in subgraph nodes
            if "properties" in node and "models" in node["properties"]:
                 for model_info in node["properties"]["models"]:
                    found_models.append({
                        "filename": model_info.get("name"),
                        "url": model_info.get("url"),
                        "node_id": node.get("id"), # Inner ID
                        "node_title": "Subgraph Node",
                        "suggested_folder": model_info.get("directory")
                    })

    # Create a map of links: link_id -> (start_node_id, start_slot_index)
    # The 'links' array in ComfyUI workflow format usually looks like: [id, start_node_id, start_slot, end_node_id, end_slot, type]
    links_map = {}
    raw_links = workflow.get("links", [])
    for link in raw_links:
        if isinstance(link, list) and len(link) >= 4:
            link_id = link[0]
            start_node_id = link[1]
            start_slot = link[2]
            links_map[link_id] = (start_node_id, start_slot) # type: ignore

    nodes = workflow.get("nodes", [])
    # Create a quick ID lookup for nodes
    nodes_by_id = {n.get("id"): n for n in nodes}

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
            
        node_title = node.get("title") or node.get("type", "Unknown Node")
        node_type = node.get("type", "")
        
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
        
        # Check for Markdown/Notes with links
        if "Note" in node_type or "PrimitiveString" in node_type:
            # Extract links from widgets_values if present
            if "widgets_values" in node:
                for val in node["widgets_values"]:
                    if isinstance(val, str):
                        # Regex to find markdown links: [filename](url)
                        # We specifically look for lines that might look like models
                        # Pattern: [filename.ext](url)
                        links = re.findall(r'\[([^\]]+\.(?:safetensors|ckpt|pt|bin|pth|gguf))\]\((https?://[^)]+)\)', val, re.IGNORECASE)
                        for fname, url in links:
                             found_models.append({
                                "filename": fname,
                                "url": url,
                                "node_id": node_id,
                                "node_title": f"Note: {node_title}",
                                "suggested_folder": None # Hard to guess from note, unless context
                            })

        # 2. Check properties -> models (Standard ComfyUI template format)
        if "properties" in node and "models" in node["properties"]:
            for model_info in node["properties"]["models"]:
                found_models.append({
                    "filename": model_info.get("name"),
                    "url": model_info.get("url"),
                    "node_id": node_id,
                    "node_title": node_title,
                    "suggested_folder": model_info.get("directory")
                })
                
        # 3. Check widgets_values for filenames
        # SKIP for Notes/PrimitiveStrings as we handled them specifically above
        if "widgets_values" in node and not ("Note" in node_type or "PrimitiveString" in node_type):
            widgets = node["widgets_values"]
            if isinstance(widgets, list):
                for val in widgets:
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
                                    suggested_folder = NODE_TYPE_MAPPING.get(node_type)
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
                        if not any(m["filename"] == val and m["node_id"] == node_id for m in found_models):
                            # Try to map folder
                            suggested_folder = NODE_TYPE_MAPPING.get(node_type)
                            
                            
                            found_models.append({
                                "filename": val,
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
                                                    m["url"] = u_val
                                                    m["note"] = f"Resolved from upstream node {upstream_node.get('title', upstream_id)}"
    
    return found_models

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
    
    for model in found_models:
        filename = model["filename"]
        
        # Skip models with None/null filenames (from disabled nodes or empty widgets)
        if filename is None or filename == "null" or not filename:
            continue
            
        folder_type = model.get("suggested_folder", "checkpoints")
        
        # Safety check: if folder_type is None, default to checkpoints
        if folder_type is None:
            folder_type = "checkpoints"
        
        # Use ComfyUI's folder_paths to get valid paths for this type
        search_paths = folder_paths.get_folder_paths(folder_type)
        if not search_paths:
             # Fallback to standard models/ structure if type unknown
            # This might not be ideal as folder_paths.get_folder_paths is the canonical way
            # but provides a safety net.
            comfy_root = os.getcwd() # Assuming this is ComfyUI root
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
            req_norm = filename.replace("\\", "/")
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

def search_huggingface_model(filename: str, token: str = None) -> str:
    """
    Searches Hugging Face for the filename, prioritizing specific authors.
    Returns the best matching URL or None.
    """
    api = HfApi(token=token)
    
    print(f"[DEBUG] Searching HF for: {filename}")
    
    # 1. Try to search specifically in priority authors' repos first?
    # Actually, listing models by author and filtering is expensive. 
    # Better to use the global search and filter results.
    
    try:
        # Search for models containing the filename
        # We can use the 'models' endpoint with a search query
        models = list(api.list_models(search=filename, limit=20, sort="downloads", direction=-1))
        
        # Fallback: strict search might fail if ext is included, try stem
        if not models:
            stem = os.path.splitext(filename)[0]
            if len(stem) > 3: # Avoid searching for "model" or short terms
                print(f"[DEBUG] No results for {filename}, trying stem: {stem}")
                models = list(api.list_models(search=stem, limit=20, sort="downloads", direction=-1))

        # Deep Search Fallback: Check top repos of priority authors if still nothing
        # This helps when the file is inside a repo like "flux-fp8" but we search for "flux-vae-bf16"
        if not models:
            print(f"[DEBUG] Still no results, checking priority authors directly...")
            path_keywords = []
            stem = os.path.splitext(filename)[0].lower()
            # simple heuristics to filter repos? No, just check top repos.
            
            for author in PRIORITY_AUTHORS:
                try:
                    # Get top 5 repos by popularity/recent
                    author_models = list(api.list_models(author=author, limit=5, sort="downloads", direction=-1))
                    models.extend(author_models)
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
                     files = api.list_repo_files(repo_id=model_id, token=token)
                     if filename in files or any(f.endswith(filename) for f in files):
                         # Construct resolve URL
                         # If it's a direct match
                         if filename in files:
                             return f"https://huggingface.co/{model_id}/resolve/main/{filename}"
                         # If it's in a subfolder
                         for f in files:
                             if f.endswith(filename):
                                 return f"https://huggingface.co/{model_id}/resolve/main/{f}"
                 except Exception:
                     continue

        # If no priority author found, check the rest of the results
        for model in models:
            model_id = model.modelId
            try:
                 files = api.list_repo_files(repo_id=model_id, token=token)
                 if filename in files:
                     return f"https://huggingface.co/{model_id}/resolve/main/{filename}"
                 for f in files:
                     if f.endswith(filename):
                         return f"https://huggingface.co/{model_id}/resolve/main/{f}"
            except Exception:
                 continue
                 
    except Exception as e:
        print(f"[ERROR] check_huggingface failed: {e}")
        
    return None

def process_workflow_for_missing_models(workflow_json: Dict[str, Any]) -> Dict[str, Any]:
    """
    Main entry point.
    1. Parse workflow.
    2. Check local models.
    3. If missing, search HF.
    """
    
    required_models = extract_models_from_workflow(workflow_json)
    
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
    
    # 2. Check ComfyUI Manager Cache for missing models
    # This helps find URLs for models that are missing locally
    if missing_models:
        missing_models = load_comfyui_manager_cache(missing_models)

    # 3. Search HF for remaining missing models (that didn't have URL from Manager cache)
    token = get_token()
    final_missing = []
    for m in missing_models:
        if not m.get("url"):
             # Try HF search
             url = search_huggingface_model(m["filename"], token)
             if url:
                 m["url"] = url
        final_missing.append(m)

    return {
        "missing": final_missing,
        "found": existing_models,
        "mismatches": path_mismatches
    }
