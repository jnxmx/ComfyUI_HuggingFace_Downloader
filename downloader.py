import os
import sys
import shutil
import tempfile
import threading
import time
from dotenv import load_dotenv

from huggingface_hub import (
    hf_hub_download,
    snapshot_download,
    scan_cache_dir
)

load_dotenv()
token_override = os.getenv("HF_TOKEN_FOR_HFD") or os.getenv("HF_TOKEN")

def folder_size(directory: str) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(directory):
        for f in filenames:
            try:
                fp = os.path.join(dirpath, f)
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
            except Exception:
                pass
    return total


def traverse_subfolders(root_folder: str, segments: list[str]) -> str:
    current = root_folder
    for seg in segments:
        current = os.path.join(current, seg)
    return current


def clear_cache_for_path(downloaded_path: str):
    print(f"[DEBUG] Attempting to clean cache for {downloaded_path}")
    try:
        cache_info = scan_cache_dir()
        for repo in cache_info.repos:
            for revision in repo.revisions:
                # Match snapshot folder or file path
                if str(revision.snapshot_path) == downloaded_path or any(
                    str(f.file_path) == downloaded_path for f in revision.files
                ):
                    delete_strategy = cache_info.delete_revisions(revision.commit_hash)
                    print(f"[DEBUG] Deleting cached revision: {revision.commit_hash}")
                    delete_strategy.execute()
                    print("[DEBUG] Cache cleaned.")
                    return
    except Exception as e:
        print(f"[DEBUG] Cache cleaning failed: {e}")


def run_download(parsed_data: dict,
                 final_folder: str,
                 sync: bool = False) -> tuple[str, str]:
    """
    Downloads a single file from Hugging Face Hub and copies it to models/<final_folder>.
    Cleans up the cached copy to save disk space.
    """
    token = token_override
    print("[DEBUG] run_download (single-file) started")

    file_name = parsed_data.get("file", "unknown.bin").strip("/")
    sub = parsed_data.get("subfolder", "").strip("/")
    remote_filename = os.path.join(sub, file_name) if sub else file_name

    try:
        target_dir = os.path.join(os.getcwd(), "models", final_folder)
        os.makedirs(target_dir, exist_ok=True)
        dest_path = os.path.join(target_dir, os.path.basename(remote_filename))

        if os.path.exists(dest_path):
            size_gb = os.path.getsize(dest_path) / (1024 ** 3)
            message = f"{file_name} already exists | {size_gb:.3f} GB"
            print("[DEBUG]", message)
            return (message, dest_path) if sync else ("", "")

        file_path_in_cache = hf_hub_download(
            repo_id=parsed_data["repo"],
            filename=remote_filename,
            revision=parsed_data.get("revision"),
            token=token or None
        )
        print("[DEBUG] File downloaded to cache:", file_path_in_cache)

        shutil.copyfile(file_path_in_cache, dest_path)
        print("[DEBUG] File copied to:", dest_path)

        clear_cache_for_path(file_path_in_cache)

        size_gb = os.path.getsize(dest_path) / (1024 ** 3)
        final_message = f"Downloaded {file_name} | {size_gb:.3f} GB"
        print("[DEBUG]", final_message)
        return (final_message, dest_path) if sync else ("", "")
    except Exception as e:
        error_msg = f"Download failed: {e}"
        print("[DEBUG]", error_msg)
        return (error_msg, "") if sync else ("", "")


def run_download_folder(parsed_data: dict,
                        final_folder: str,
                        remote_subfolder_path: str = "",
                        last_segment: str = "",
                        sync: bool = False) -> tuple[str, str]:
    """
    Downloads a folder or subfolder from Hugging Face Hub using snapshot_download.
    The result is placed in models/<final_folder>/<last_segment> if provided.
    """
    token = token_override
    print("[DEBUG] run_download_folder started")

    base_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(base_dir, exist_ok=True)
    dest_path = os.path.join(base_dir, last_segment) if last_segment else base_dir

    if os.path.exists(dest_path) and os.listdir(dest_path):
        fz = folder_size(dest_path)
        fg = fz / (1024 ** 3)
        final_message = f"{os.path.basename(dest_path)} already exists | {fg:.3f} GB"
        print("[DEBUG]", final_message)
        return (final_message, dest_path) if sync else ("", "")

    comfy_temp = os.path.join(os.getcwd(), "temp")
    os.makedirs(comfy_temp, exist_ok=True)
    temp_dir = tempfile.mkdtemp(prefix="hf_dl_", dir=comfy_temp)
    print("[DEBUG] Temp folder =>", temp_dir)

    allow_patterns = [f"{remote_subfolder_path}/**"] if remote_subfolder_path else None

    kwargs = {
        "repo_id": parsed_data["repo"],
        "local_dir": temp_dir,
        "token": token or None
    }
    if parsed_data.get("revision"):
        kwargs["revision"] = parsed_data["revision"]
    if allow_patterns:
        kwargs["allow_patterns"] = allow_patterns

    progress_event = threading.Event()
    final_total = 0
    last_percent = -1

    def folder_monitor():
        nonlocal final_total, last_percent
        print("[DEBUG] Folder monitor started.")
        while not progress_event.is_set():
            csz = folder_size(temp_dir)
            pct = (csz / final_total) * 100 if final_total else 0
            ip = int(pct)
            if ip > last_percent:
                print(f"\r[DEBUG] [Folder Monitor] {ip}%", end="")
                last_percent = ip
            time.sleep(1)
        print()

    threading.Thread(target=folder_monitor, daemon=True).start()

    try:
        downloaded_folder = snapshot_download(**kwargs)
        print("[DEBUG] snapshot_download =>", downloaded_folder)
        final_total = folder_size(downloaded_folder)
    except Exception as e:
        progress_event.set()
        shutil.rmtree(temp_dir, ignore_errors=True)
        err = f"Download failed: {e}"
        print("[DEBUG]", err)
        return (err, "") if sync else ("", "")

    source_folder = traverse_subfolders(downloaded_folder, remote_subfolder_path.split("/")) \
        if remote_subfolder_path else downloaded_folder

    os.makedirs(dest_path, exist_ok=True)
    for item in os.listdir(source_folder):
        if item == ".cache":
            continue
        shutil.move(os.path.join(source_folder, item), os.path.join(dest_path, item))

    elapsed = time.time() - time.time()
    fsz = folder_size(dest_path)
    fgb = fsz / (1024 ** 3)
    final_message = f"Folder downloaded: {os.path.basename(dest_path)} | {fgb:.3f} GB"
    print("[DEBUG]", final_message)

    progress_event.set()
    shutil.rmtree(temp_dir, ignore_errors=True)
    print("[DEBUG] Removed temp folder:", temp_dir)

    clear_cache_for_path(downloaded_folder)

    return (final_message, dest_path) if sync else ("", "")
