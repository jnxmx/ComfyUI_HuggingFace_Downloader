import os

def _find_subdirs_recursive(base_path: str, max_depth: int = 3) -> list:
    subdirs = []
    if not os.path.exists(base_path) or not os.path.isdir(base_path):
        return subdirs

    seen_realpaths = set()
    seen_realpaths.add(os.path.realpath(base_path))

    def walk_dir(current_path: str, depth: int):
        if depth > max_depth:
            return
        try:
            entries = os.listdir(current_path)
        except OSError:
            return
        for entry in entries:
            if entry.startswith(".") or entry == "__pycache__":
                continue
            full_path = os.path.join(current_path, entry)
            if os.path.isdir(full_path):
                real_p = os.path.realpath(full_path)
                if real_p in seen_realpaths:
                    continue
                seen_realpaths.add(real_p)
                rel = os.path.relpath(full_path, base_path).replace("\\", "/")
                subdirs.append(rel)
                walk_dir(full_path, depth + 1)

    walk_dir(base_path, 1)
    return subdirs

def get_model_subfolders(models_dir: str = None) -> list:
    try:
        import folder_paths
    except ImportError:
        folder_paths = None

    if models_dir is None:
        if folder_paths and hasattr(folder_paths, "models_dir") and folder_paths.models_dir:
            models_dir = folder_paths.models_dir
    if models_dir is None:
        models_dir = os.path.join(os.getcwd(), "models")

    # Get candidate folder types (base names like checkpoints, loras, etc.)
    base_types = []
    if folder_paths and hasattr(folder_paths, "folder_names_and_paths"):
        for k in folder_paths.folder_names_and_paths.keys():
            if k not in ["custom_nodes", "user", "input", "output", "temp"]:
                base_types.append(k)
    else:
        # Fallback list if folder_paths is not available
        base_types = ["checkpoints", "clip", "diffusion_models", "vae", "loras", "controlnet", "upscale_models", "text_encoders", "style_models", "embeddings"]

    # Also include any actual top-level folders inside models_dir
    if os.path.exists(models_dir):
        try:
            for name in os.listdir(models_dir):
                if os.path.isdir(os.path.join(models_dir, name)) and name not in base_types:
                    base_types.append(name)
        except OSError:
            pass

    # Sort base_types with priority
    priority = ["checkpoints", "clip", "diffusion_models", "vae", "loras", "controlnet"]
    prio_list = [p for p in priority if p in base_types]
    non_prio = [f for f in base_types if f not in priority]
    ordered_base_types = prio_list + sorted(non_prio)

    result_folders = []
    for base_type in ordered_base_types:
        # Add the base folder type itself
        result_folders.append(base_type)

        # Get search paths for this type
        search_paths = []
        if folder_paths and hasattr(folder_paths, "get_folder_paths"):
            try:
                search_paths = folder_paths.get_folder_paths(base_type) or []
            except KeyError:
                pass
        
        # Always fallback/include default models_dir/base_type path
        default_path = os.path.join(models_dir, base_type)
        if default_path not in search_paths:
            search_paths = list(search_paths) + [default_path]

        # Scan each search path for subdirectories
        subdirs_found = set()
        for root_path in search_paths:
            if os.path.exists(root_path) and os.path.isdir(root_path):
                for rel_path in _find_subdirs_recursive(root_path, max_depth=3):
                    subdirs_found.add(rel_path)

        # Append subdirectories in sorted order
        for rel_path in sorted(list(subdirs_found)):
            result_folders.append(f"{base_type}/{rel_path}")

    return result_folders

def resolve_target_dir(final_folder: str) -> str:
    """
    Resolves the final folder path using ComfyUI's folder_paths configuration,
    especially useful for multi-instance ComfyUI and custom model directories.
    If the first segment of final_folder matches a registered folder type,
    it uses the primary path for that type from folder_paths.
    Otherwise, it falls back to the default models/final_folder path.
    """
    final_folder = final_folder.strip().rstrip("/\\")
    
    # If it is already an absolute path, return it directly
    if os.path.isabs(final_folder):
        return final_folder

    # Import folder_paths dynamically to access current configuration
    try:
        import folder_paths
    except ImportError:
        folder_paths = None

    # Determine default models dir
    default_models_dir = None
    if folder_paths and hasattr(folder_paths, "models_dir") and folder_paths.models_dir:
        default_models_dir = folder_paths.models_dir
    if not default_models_dir:
        default_models_dir = os.path.join(os.getcwd(), "models")

    # Split final_folder to check if the first part is a known model folder type
    normalized = final_folder.replace("\\", "/")
    parts = normalized.split("/", 1)
    base_type = parts[0]
    sub_path = parts[1] if len(parts) > 1 else ""

    # Check if folder_paths can resolve this type
    if folder_paths and hasattr(folder_paths, "get_folder_paths"):
        try:
            paths = folder_paths.get_folder_paths(base_type)
            if paths:
                primary_path = paths[0]
                if sub_path:
                    return os.path.join(primary_path, sub_path)
                return primary_path
        except KeyError:
            pass

    # Fallback: combine default_models_dir with final_folder
    return os.path.join(default_models_dir, final_folder)

def get_all_subfolders_flat(root_dir: str = None) -> list:
    """
    Fetch all folders inside the given root directory as a flat list.
    If no root directory is provided, defaults to the ComfyUI root directory.
    """
    if root_dir is None:
        root_dir = os.getcwd()  # Default to ComfyUI root directory
    if not os.path.exists(root_dir):
        return []
    subfolders = []
    for root, dirs, _ in os.walk(root_dir):
        for d in dirs:
            subfolders.append(os.path.relpath(os.path.join(root, d), root_dir))
    return subfolders

def resolve_model_absolute_path(rel_path: str) -> str:
    """
    Given a relative path like 'checkpoints/sdxl/model.safetensors',
    finds the actual absolute path by searching all registered directories for that type.
    """
    rel_path = rel_path.strip().replace("\\", "/").strip("/")
    parts = rel_path.split("/", 1)
    if len(parts) < 2:
        return ""
    base_type, sub_path = parts[0], parts[1]

    try:
        import folder_paths
    except ImportError:
        folder_paths = None

    search_paths = []
    if folder_paths and hasattr(folder_paths, "get_folder_paths"):
        try:
            search_paths = folder_paths.get_folder_paths(base_type) or []
        except KeyError:
            pass

    default_models_dir = None
    if folder_paths and hasattr(folder_paths, "models_dir") and folder_paths.models_dir:
        default_models_dir = folder_paths.models_dir
    if not default_models_dir:
        default_models_dir = os.path.join(os.getcwd(), "models")
    
    default_path = os.path.join(default_models_dir, base_type)
    if default_path not in search_paths:
        search_paths = list(search_paths) + [default_path]

    for root_path in search_paths:
        candidate = os.path.join(root_path, sub_path)
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    
    return os.path.abspath(os.path.join(default_models_dir, rel_path))
