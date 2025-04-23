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
    Backup specified folders to a Hugging Face repository as a single 'ComfyUI' folder.
    """
    api = HfApi()
    token = get_token()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    # Parse repo name if a link is provided
    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

    # Create a temp dir and virtual ComfyUI folder
    with tempfile.TemporaryDirectory() as tmpdir:
        virtual_comfyui = make_virtual_comfyui_folder(folders, tmpdir)
        print(f"[INFO] Created virtual folder at {virtual_comfyui}")

        # Choose upload method
        upload_fn = api.upload_large_folder if use_large_folder else api.upload_folder

        print(f"[INFO] Uploading '{virtual_comfyui}' to repo '{repo_name}' as folder 'ComfyUI'...")
        upload_fn(
            folder_path=virtual_comfyui,
            repo_id=repo_name,
            path_in_repo="ComfyUI",
            repo_type="model",
            token=token,
            ignore_patterns=None,  # Optionally add ignore patterns
        )
        print("[INFO] Upload complete.")

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
