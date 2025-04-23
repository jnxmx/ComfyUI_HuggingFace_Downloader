import os
import json
import tempfile
import shutil
from huggingface_hub import HfApi
from .parse_link import parse_link

def get_token_and_size_limit():
    """
    Load the Hugging Face token and backup file size limit from comfy.settings.json.
    If not found or empty, fall back to the HF_TOKEN environment variable and default size limit 5.
    """
    settings_path = os.path.join("user", "default", "comfy.settings.json")
    token = ""
    size_limit_gb = 5
    if os.path.exists(settings_path):
        with open(settings_path, "r") as f:
            settings = json.load(f)
        token = settings.get("downloader.hf_token", "").strip()
        try:
            size_limit_gb = float(settings.get("downloaderbackup.file_size_limit", 5))
        except Exception:
            size_limit_gb = 5
    if not token:
        token = os.getenv("HF_TOKEN", "").strip()
    return token, size_limit_gb


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

def _move_big_files(root_dir, size_limit_gb):
    """
    Move files larger than size_limit_gb into a .skipbigtmp subfolder within their parent directory.
    Returns a list of (original_path, skip_path) tuples for restoration.
    """
    moved = []
    for dirpath, _, files in os.walk(root_dir):
        for fname in files:
            fpath = os.path.join(dirpath, fname)
            try:
                if os.path.getsize(fpath) > size_limit_gb * 1024 ** 3:
                    skip_dir = os.path.join(dirpath, ".skipbigtmp")
                    os.makedirs(skip_dir, exist_ok=True)
                    skip_path = os.path.join(skip_dir, fname)
                    shutil.move(fpath, skip_path)
                    moved.append((fpath, skip_path))
                    print(f"[INFO] Temporarily moved big file '{fpath}' to '{skip_path}'")
            except Exception as e:
                print(f"[WARNING] Could not check/move '{fpath}': {e}")
    return moved

def _restore_big_files(moved):
    """
    Move files back from .skipbigtmp to their original location and remove empty .skipbigtmp folders.
    """
    for orig, skip in moved:
        try:
            shutil.move(skip, orig)
            print(f"[INFO] Restored big file '{orig}'")
        except Exception as e:
            print(f"[WARNING] Could not restore '{orig}': {e}")
    # Remove empty .skipbigtmp folders
    skip_dirs = set(os.path.dirname(skip) for _, skip in moved)
    for d in skip_dirs:
        try:
            if os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)
        except Exception:
            pass

def backup_to_huggingface(repo_name_or_link, folders, *args, **kwargs):
    """
    Backup specified folders to a Hugging Face repository under a single 'ComfyUI' root,
    preserving the relative folder structure. Skips .cache folders.
    If uploading 'user' or any subfolder, strips downloader.hf_token from comfy.settings.json.
    Uses upload_folder (not upload_large_folder).
    Respects file size limit from settings.
    Accepts extra unused arguments for compatibility with various callers.
    """
    import threading

    def show_upload_popup():
        try:
            import tkinter as tk
            from tkinter import messagebox
            root = tk.Tk()
            root.withdraw()
            # Show popup immediately and allow mainloop to process events
            def show_and_destroy():
                messagebox.showinfo(
                    "ComfyUI HuggingFace Backup",
                    "Backup upload started!\n\nMonitor the console for upload progress and status."
                )
                root.destroy()
            root.after(100, show_and_destroy)
            root.mainloop()
        except Exception:
            print("[INFO] Backup upload started! (Could not show popup window; monitor the console for status.)")

    # On macOS, use a thread (not a process) for tkinter popup, but ensure mainloop runs before upload
    popup_thread = threading.Thread(target=show_upload_popup)
    popup_thread.start()
    # Give the popup a moment to appear before starting the upload
    import time
    time.sleep(0.5)

    api = HfApi()
    token, size_limit_gb = get_token_and_size_limit()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

    with tempfile.TemporaryDirectory() as temp_root:
        comfyui_root = os.path.join(temp_root, "ComfyUI")
        os.makedirs(comfyui_root, exist_ok=True)
        temp_dirs = []
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
            is_user = rel_path == "user" or rel_path.startswith("user" + os.sep)
            upload_path = folder
            temp_dir = None
            if is_user:
                temp_dir = tempfile.mkdtemp(prefix="comfyui_user_strip_")
                upload_path = _copy_and_strip_token(folder, temp_dir)
                temp_dirs.append(temp_dir)
                print(f"[INFO] Created sanitized copy of '{folder}' at '{upload_path}' for upload.")
            dest = os.path.join(comfyui_root, rel_path)
            if os.path.isdir(upload_path):
                shutil.copytree(upload_path, dest, dirs_exist_ok=True)
            else:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copy2(upload_path, dest)
        print(f"[INFO] Uploading '{comfyui_root}' to repo '{repo_name}' as 'ComfyUI'...")
        print(f"[INFO] Upload started. File size limit: {size_limit_gb} GB. Check the console for status updates.")

        moved_big_files = []
        try:
            moved_big_files = _move_big_files(comfyui_root, size_limit_gb)
            # --- FIX: Use upload_folder with repo_type=None for model repos (default), and do NOT set path_in_repo ---
            api.upload_folder(
                folder_path=comfyui_root,
                repo_id=repo_name,
                token=token,
                ignore_patterns=["**/.cache/**", "**/.cache*", ".cache", ".cache*"],
            )
            print(f"[INFO] Upload of '{comfyui_root}' complete.")
        except Exception as e:
            print(f"[ERROR] Backup failed: {e}")
            raise
        finally:
            _restore_big_files(moved_big_files)
            for temp_dir in temp_dirs:
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
