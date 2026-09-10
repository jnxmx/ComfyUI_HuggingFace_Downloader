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

def get_comfy_root() -> str:
    """
    Returns the authoritative ComfyUI root directory.
    Prioritizes folder_paths.base_path, then searching upwards from __file__
    for the directory containing 'custom_nodes', then searching upwards from cwd, and finally os.getcwd().
    """
    try:
        import folder_paths
        base = getattr(folder_paths, "base_path", None)
        if base and os.path.isdir(base):
            return os.path.abspath(base)
    except Exception:
        pass

    try:
        curr = os.path.abspath(os.path.dirname(__file__))
        while curr != os.path.dirname(curr):
            if os.path.isdir(os.path.join(curr, "custom_nodes")):
                return curr
            curr = os.path.dirname(curr)
    except Exception:
        pass

    try:
        curr = os.path.abspath(os.getcwd())
        while curr != os.path.dirname(curr):
            if os.path.isdir(os.path.join(curr, "custom_nodes")):
                return curr
            curr = os.path.dirname(curr)
    except Exception:
        pass

    return os.path.abspath(os.getcwd())


def get_models_root() -> str:
    """
    Returns the authoritative ComfyUI models directory.
    Prioritizes folder_paths.models_dir, then falls back to <get_comfy_root()>/models.
    """
    try:
        import folder_paths
        models_dir = getattr(folder_paths, "models_dir", None)
        if models_dir and os.path.isdir(models_dir):
            return os.path.abspath(models_dir)
    except Exception:
        pass
    return os.path.join(get_comfy_root(), "models")


def get_model_subfolders(models_dir: str = None) -> list:
    try:
        import folder_paths
    except ImportError:
        folder_paths = None

    if models_dir is None:
        models_dir = get_models_root()

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

def get_allowed_model_roots() -> list:
    """
    Returns a list of all authoritative, registered model root directories.
    Includes get_models_root() and all non-system paths registered in folder_paths.
    """
    roots = []
    default_root = get_models_root()
    if default_root:
        roots.append(os.path.realpath(os.path.abspath(default_root)))

    try:
        import folder_paths
        if hasattr(folder_paths, "folder_names_and_paths"):
            for base_type in folder_paths.folder_names_and_paths.keys():
                if base_type in ["custom_nodes", "user", "input", "output", "temp"]:
                    continue
                try:
                    paths = folder_paths.get_folder_paths(base_type) or []
                    for p in paths:
                        if p:
                            real_p = os.path.realpath(os.path.abspath(p))
                            if real_p not in roots:
                                roots.append(real_p)
                except Exception:
                    pass
    except Exception:
        pass

    return roots

def is_path_within_allowed_roots(candidate_path: str, allowed_roots: list = None) -> bool:
    """
    Validates that candidate_path resolves strictly within one of the allowed model root directories.
    Uses os.path.realpath and os.path.commonpath to prevent any path traversal or symlink escape.
    """
    if not candidate_path or not str(candidate_path).strip():
        return False
    if allowed_roots is None:
        allowed_roots = get_allowed_model_roots()
    if not allowed_roots:
        return False

    try:
        candidate_real = os.path.realpath(os.path.abspath(candidate_path))
        for root in allowed_roots:
            root_real = os.path.realpath(os.path.abspath(root))
            try:
                if os.path.commonpath([root_real, candidate_real]) == root_real:
                    return True
            except (ValueError, Exception):
                continue
        return False
    except Exception:
        return False

def sanitize_rel_folder(folder_str: str) -> str:
    """
    Sanitizes a relative folder string:
    - Normalizes separators to '/'
    - Rejects or removes '..' traversal components
    - Strips leading and trailing slashes and whitespace
    """
    if not folder_str:
        return ""
    normalized = str(folder_str).replace("\\", "/").strip().strip("/")
    parts = [part.strip() for part in normalized.split("/") if part.strip()]
    safe_parts = []
    for part in parts:
        if part in (".", ".."):
            continue
        clean_part = part.replace("\x00", "").strip()
        if clean_part and clean_part not in (".", ".."):
            safe_parts.append(clean_part)
    return "/".join(safe_parts)

def resolve_target_dir(final_folder: str) -> str:
    """
    Resolves the final folder path using ComfyUI's folder_paths configuration,
    strictly confining the resolved target within allowed model roots.
    Prevents path traversal, directory escape, and unauthorized absolute paths.
    """
    final_folder = (final_folder or "").strip().rstrip("/\\")
    allowed_roots = get_allowed_model_roots()
    default_models_dir = get_models_root()

    # If it is an absolute path, verify it is strictly within allowed roots
    if os.path.isabs(final_folder):
        if is_path_within_allowed_roots(final_folder, allowed_roots):
            return os.path.realpath(os.path.abspath(final_folder))
        # Refuse to return unconfined absolute path; fallback safely inside default models dir
        print(f"[SECURITY] Refusing unconfined absolute target directory: {final_folder}")
        safe_rel = sanitize_rel_folder(os.path.basename(final_folder))
        candidate = os.path.join(default_models_dir, safe_rel) if safe_rel else default_models_dir
        return os.path.realpath(os.path.abspath(candidate))

    # Sanitize relative folder components (disallowing '..')
    safe_rel_folder = sanitize_rel_folder(final_folder)
    if not safe_rel_folder:
        return default_models_dir

    # Import folder_paths dynamically to access current configuration
    try:
        import folder_paths
    except ImportError:
        folder_paths = None

    comfy_root = get_comfy_root()
    norm_comfy_root = os.path.abspath(comfy_root).replace("\\", "/").lower()

    parts = safe_rel_folder.split("/", 1)
    base_type = parts[0]
    sub_path = parts[1] if len(parts) > 1 else ""

    if folder_paths and hasattr(folder_paths, "get_folder_paths"):
        try:
            paths = folder_paths.get_folder_paths(base_type)
            if paths:
                primary_path = None
                non_instance_paths = []
                instance_paths = []

                for p in paths:
                    norm_p = os.path.abspath(p).replace("\\", "/").lower()
                    if norm_p.startswith(norm_comfy_root + "/") or norm_p == norm_comfy_root:
                        instance_paths.append(p)
                    else:
                        non_instance_paths.append(p)

                # 1. Prioritize non-instance path ending with base_type
                if non_instance_paths:
                    for p in non_instance_paths:
                        norm_p = p.replace("\\", "/").rstrip("/").lower()
                        if norm_p.endswith(f"/{base_type.lower()}"):
                            primary_path = p
                            break
                    if not primary_path:
                        primary_path = non_instance_paths[0]

                # 2. Check instance paths ending with base_type
                if not primary_path and instance_paths:
                    for p in instance_paths:
                        norm_p = p.replace("\\", "/").rstrip("/").lower()
                        if norm_p.endswith(f"/{base_type.lower()}"):
                            primary_path = p
                            break
                    if not primary_path:
                        primary_path = instance_paths[0]

                # 3. Fallback to paths[0]
                if not primary_path:
                    primary_path = paths[0]

                candidate = os.path.join(primary_path, sub_path) if sub_path else primary_path
                if is_path_within_allowed_roots(candidate, allowed_roots):
                    return os.path.realpath(os.path.abspath(candidate))
        except (KeyError, Exception):
            pass

    candidate = os.path.join(default_models_dir, safe_rel_folder)
    if is_path_within_allowed_roots(candidate, allowed_roots):
        return os.path.realpath(os.path.abspath(candidate))

    # Safe fallback: default models root
    return default_models_dir

def get_all_subfolders_flat(root_dir: str = None) -> list:
    """
    Fetch all folders inside the given root directory as a flat list.
    If no root directory is provided, defaults to the ComfyUI root directory.
    """
    if root_dir is None:
        root_dir = get_comfy_root()
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
    rel_path = sanitize_rel_folder(rel_path)
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

    default_models_dir = get_models_root()
    
    default_path = os.path.join(default_models_dir, base_type)
    if default_path not in search_paths:
        search_paths = list(search_paths) + [default_path]

    for root_path in search_paths:
        candidate = os.path.join(root_path, sub_path)
        if os.path.exists(candidate) and is_path_within_allowed_roots(candidate):
            return os.path.realpath(os.path.abspath(candidate))
    
    fallback = os.path.join(default_models_dir, rel_path)
    return os.path.realpath(os.path.abspath(fallback))
