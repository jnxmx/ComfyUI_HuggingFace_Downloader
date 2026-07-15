import os

def get_model_subfolders(models_dir: str = None) -> list:
    if models_dir is None:
        try:
            import folder_paths
            if hasattr(folder_paths, "models_dir") and folder_paths.models_dir:
                models_dir = folder_paths.models_dir
        except ImportError:
            pass
    if models_dir is None:
        models_dir = os.path.join(os.getcwd(), "models")

    subfolders = []
    if os.path.exists(models_dir):
        subfolders = [name for name in os.listdir(models_dir)
                      if os.path.isdir(os.path.join(models_dir, name))]

    # Merge in known keys from folder_paths if available, so they are always listed
    try:
        import folder_paths
        if hasattr(folder_paths, "folder_names_and_paths"):
            for k in folder_paths.folder_names_and_paths.keys():
                if k not in subfolders and k not in ["custom_nodes", "user", "input", "output", "temp"]:
                    subfolders.append(k)
    except ImportError:
        pass

    subfolders.sort()
    priority = ["checkpoints", "clip", "diffusion_models", "vae", "loras", "controlnet"]
    prio_list = [p for p in priority if p in subfolders]
    non_prio = [f for f in subfolders if f not in priority]
    return prio_list + non_prio

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
