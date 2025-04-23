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

def _copy_and_strip_token(src_folder, temp_dir):
    """
    Copy src_folder to temp_dir, removing 'downloader.hf_token' from any comfy.settings.json found.
    Returns the path to the copied folder.
    """
    dst_folder = os.path.join(temp_dir, os.path.basename(src_folder))
    shutil.copytree(src_folder, dst_folder)
    for root, _, files in os.walk(dst_folder):
        for fname in files:
            if fname == "comfy.settings.json":
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if "downloader.hf_token" in data:
                        del data["downloader.hf_token"]
                        with open(fpath, "w", encoding="utf-8") as f:
                            json.dump(data, f, indent=2)
                        print(f"[INFO] Stripped downloader.hf_token from {fpath}")
                except Exception as e:
                    print(f"[WARNING] Could not clean token from {fpath}: {e}")
    return dst_folder

def backup_to_huggingface(repo_name_or_link, folders, size_limit_gb=5, use_large_folder=True):
    """
    Backup specified folders to a Hugging Face repository under a single 'ComfyUI' root,
    preserving the relative folder structure. Skips .cache folders.
    Always uses upload_large_folder for reliability.
    If uploading 'user' or any subfolder, strips downloader.hf_token from comfy.settings.json.
    """
    import threading

    def show_upload_popup():
        try:
            import tkinter as tk
            from tkinter import messagebox
            root = tk.Tk()
            root.withdraw()
            messagebox.showinfo(
                "ComfyUI HuggingFace Backup",
                "Backup upload started!\n\nMonitor the console for upload progress and status."
            )
            root.destroy()
        except Exception:
            print("[INFO] Backup upload started! (Could not show popup window; monitor the console for status.)")

    threading.Thread(target=show_upload_popup, daemon=True).start()

    api = HfApi()
    token = get_token()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

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

        # Check if this is 'user' or a subfolder of 'user'
        is_user = rel_path == "user" or rel_path.startswith("user" + os.sep)
        upload_path = folder
        temp_dir = None
        if is_user:
            temp_dir = tempfile.mkdtemp(prefix="comfyui_user_strip_")
            upload_path = _copy_and_strip_token(folder, temp_dir)
            print(f"[INFO] Created sanitized copy of '{folder}' at '{upload_path}' for upload.")

        print(f"[INFO] Uploading '{upload_path}' to repo '{repo_name}' as '{comfyui_subpath}'...")
        print("[INFO] Upload started. Check the console for status updates.")

        api.upload_large_folder(
            folder_path=upload_path,
            repo_id=repo_name,
            path_in_repo=comfyui_subpath,
            repo_type="model",
            token=token,
            ignore_patterns=["**/.cache/**", "**/.cache*", ".cache", ".cache*"],
        )
        print(f"[INFO] Upload of '{upload_path}' complete.")

        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)
            print(f"[INFO] Removed temporary sanitized folder '{temp_dir}'.")

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
