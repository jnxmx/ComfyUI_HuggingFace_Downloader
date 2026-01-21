import os
import re
from typing import List, Dict, Any, Tuple
from huggingface_hub import HfApi
from .downloader import get_token

# Known extensions for model files
MODEL_EXTENSIONS = {'.safetensors', '.ckpt', '.pt', '.bin', '.pth', '.gguf'}

# Priority authors for HF search as requested
PRIORITY_AUTHORS = [
    "Kijai",
    "comfyanonymous", 
    "Comfy-Org", 
    "city96"
]

def load_comfyui_manager_cache(comfy_root: str) -> Dict[str, str]:
    """
    Scans for ComfyUI-Manager model-list.json and returns {filename: url} mapping.
    Locations to check:
    - ComfyUI/user/default/ComfyUI-Manager/cache/*.json
    - ComfyUI/custom_nodes/ComfyUI-Manager/cache/*.json
    """
    cache_map = {}
    
    # Potential paths
    paths_to_check = [
        os.path.join(comfy_root, "user", "default", "ComfyUI-Manager", "cache"),
        os.path.join(comfy_root, "custom_nodes", "ComfyUI-Manager", "cache"),
        os.path.join(comfy_root, "user", "__manager", "cache") # Mentioned by user
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
                    
    return cache_map

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
    "DiffusersLoader": "diffusion_models" 
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
    comfy_root = os.getcwd() # Assuming running from ComfyUI root
    # Adjust if we are in a text env, but in ComfyUI environment os.getcwd() is root.
    
    
    local_models = get_all_local_models(comfy_root)
    manager_cache = load_comfyui_manager_cache(comfy_root)
    required_models = extract_models_from_workflow(workflow_json)
    
    token = get_token()
    
    missing_models = []
    found_models = []
    
    processed_files = set()
    
    for req in required_models:
        filename = req["filename"]
        # Skip if we already processed this filename (multiple nodes causing same model)
        if filename in processed_files:
            continue
            
        processed_files.add(filename)
        
        # Check if local
        if filename in local_models:
            found_path = local_models[filename]
            # Try to clean path if we have a suggested folder
            suggested = req.get("suggested_folder")
            if suggested:
                prefix = f"models/{suggested}/"
                if found_path.startswith(prefix):
                    found_path = found_path[len(prefix):]
            
            found_models.append({
                "filename": filename,
                "path": found_path,
                "node_id": req["node_id"],
                "original_path": local_models[filename]
            })
            continue
            
        # Also check just the basename in case of path differences in widgets
        basename = os.path.basename(filename)
        if basename in local_models:
             found_path = local_models[basename]
             # Try to clean path if we have a suggested folder
             suggested = req.get("suggested_folder")
             if suggested:
                 prefix = f"models/{suggested}/"
                 if found_path.startswith(prefix):
                     found_path = found_path[len(prefix):]
                     
             found_models.append({
                "filename": filename, # Keep original required name
                "path": found_path,
                "node_id": req["node_id"],
                "note": "Found with different path/name",
                "original_path": local_models[basename]
            })
             continue
             
        # If not found, it is missing
        url = req.get("url")
        
        
        # If no URL in workflow, try to search:
        # 1. ComfyUI Manager Cache
        # 2. Hugging Face
        if not url:
            if filename in manager_cache:
                url = manager_cache[filename]
                print(f"[DEBUG] Found in Manager cache: {filename} -> {url}")
            else:
                 url = search_huggingface_model(basename, token)
            
        missing_models.append({
            "filename": filename,
            "url": url,
            "suggested_folder": req.get("suggested_folder", "checkpoints"), # Default fallback
            "node_title": req["node_title"]
        })
        
    return {
        "missing": missing_models,
        "found": found_models
    }
