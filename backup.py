import os
import json
import tempfile
import shutil
from huggingface_hub import HfApi
from .parse_link import parse_link

def get_token():
    """
    Load the Hugging Face token from comfy.settings.json.
    If not found or empty, fall back to the HF_TOKEN environment variable.
    """
    settings_path = os.path.join("user", "default", "comfy.settings.json")
    token = ""
    if os.path.exists(settings_path):
        with open(settings_path, "r") as f:
            settings = json.load(f)
        token = settings.get("downloader.hf_token", "").strip()
    if not token:  # Fallback to HF_TOKEN environment variable
        token = os.getenv("HF_TOKEN", "").strip()
    return token

def _safe_symlink(src, dst):
    """
    Always try to symlink src to dst. Raise if not possible.
    """
    os.symlink(src, dst, target_is_directory=os.path.isdir(src))

def make_virtual_comfyui_folder(folders, virtual_root):
    """
    Create a virtual folder named 'ComfyUI' in virtual_root, with symlinks to the specified folders.
    Returns the path to the created 'ComfyUI' folder.
    Raises if symlinks are not supported.
    """
    comfyui_path = os.path.join(virtual_root, "ComfyUI")
    os.makedirs(comfyui_path, exist_ok=True)
    for folder in folders:
        folder = folder.strip()
        if not folder or not os.path.exists(folder):
            continue
        name = os.path.basename(os.path.normpath(folder))
        dst = os.path.join(comfyui_path, name)
        _safe_symlink(folder, dst)
    return comfyui_path

def backup_to_huggingface(repo_name_or_link, folders, size_limit_gb=5, use_large_folder=False):
    """
    Backup specified folders to a Hugging Face repository under a single 'ComfyUI' root,
    preserving the relative folder structure. Skips .cache folders.
    """
    api = HfApi()
    token = get_token()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

    def ignore_cache(dir, files):
        # Ignore any .cache folder or file
        return [f for f in files if f == ".cache" or f.startswith(".cache")]

    for folder in folders:
        folder = folder.strip()
        if not folder or not os.path.exists(folder):
            continue
        folder = os.path.normpath(folder)
        rel_path = folder
        if os.path.isabs(folder):
            try:
                rel_path = os.path.relpath(folder, os.getcwd())
            except ValueError:
                rel_path = os.path.basename(folder)
        comfyui_subpath = os.path.join("ComfyUI", rel_path)
        print(f"[INFO] Uploading '{folder}' to repo '{repo_name}' as '{comfyui_subpath}'...")
        upload_fn = api.upload_large_folder if use_large_folder else api.upload_folder
        upload_fn(
            folder_path=folder,
            repo_id=repo_name,
            path_in_repo=comfyui_subpath,
            repo_type="model",
            token=token,
            ignore_patterns=["**/.cache/**", "**/.cache*", ".cache", ".cache*"],
        )
        print(f"[INFO] Upload of '{folder}' complete.")

def restore_from_huggingface(repo_name_or_link, target_dir=None):
    """
    Restore the 'ComfyUI' folder from a Hugging Face repository.
    """
    api = HfApi()
    token = get_token()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

    if target_dir is None:
        target_dir = os.getcwd()

    print(f"[INFO] Restoring 'ComfyUI' folder from '{repo_name}' to '{target_dir}'...")
    files = api.list_repo_files(repo_id=repo_name, token=token)
    for file in files:
        if not file.startswith("ComfyUI/"):
            continue
        local_path = os.path.join(target_dir, file)
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        print(f"[INFO] Downloading '{file}' to '{local_path}'...")
        api.download_file(
            repo_id=repo_name,
            filename=file,
            local_dir=os.path.dirname(local_path),
            token=token,
        )
