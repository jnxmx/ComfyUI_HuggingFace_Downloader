import os
import shutil
from huggingface_hub import (
    hf_hub_download,
    snapshot_download,
    scan_cache_dir
)

def get_local_target(file_path: str, final_folder: str) -> str:
    """Construct destination path in models/final_folder."""
    file_name = os.path.basename(file_path)
    target_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(target_dir, exist_ok=True)
    return os.path.join(target_dir, file_name)


def clear_cache_for_path(cached_path: str):
    """
    Attempt to delete the cached symlink and its blob if no longer referenced.
    Uses huggingface_hub scan_cache_dir() to identify unreferenced blobs.
    """
    print(f"[DEBUG] Attempting to clean cache for {cached_path}")
    try:
        # Find the parent snapshot folder
        cache_info = scan_cache_dir()
        for repo in cache_info.repos:
            for revision in repo.revisions:
                for file_info in revision.files:
                    if str(file_info.file_path) == cached_path:
                        # Found the right revision; remove it
                        print(f"[DEBUG] Match found in cache: {file_info.file_path}")
                        delete_strategy = cache_info.delete_revisions(revision.commit_hash)
                        print(f"[DEBUG] Will free approx {delete_strategy.expected_freed_size_str}")
                        delete_strategy.execute()
                        print(f"[DEBUG] Cache cleaned for revision {revision.commit_hash}")
                        return
    except Exception as e:
        print(f"[DEBUG] Failed to clean cache for {cached_path}: {e}")


def run_download(parsed_data: dict, final_folder: str, token: str = "", sync: bool = False) -> tuple[str, str]:
    """
    Downloads a single file from Hugging Face Hub and places it in models/<final_folder>.
    Cleans up the downloaded cache afterward.
    """
    print("[DEBUG] run_download (single-file) started")

    # Resolve filename
    file_name = parsed_data.get("file", "unknown.bin").strip("/")
    sub = parsed_data.get("subfolder", "").strip("/")
    remote_filename = os.path.join(sub, file_name) if sub else file_name

    try:
        # Check if already downloaded
        dest_path = get_local_target(remote_filename, final_folder)
        if os.path.exists(dest_path):
            size_gb = os.path.getsize(dest_path) / (1024 ** 3)
            message = f"{file_name} already exists | {size_gb:.3f} GB"
            print("[DEBUG]", message)
            return (message, dest_path) if sync else ("", "")

        # Perform download
        file_path_in_cache = hf_hub_download(
            repo_id=parsed_data["repo"],
            filename=remote_filename,
            revision=parsed_data.get("revision", None),
            token=token or None
        )
        print("[DEBUG] File downloaded to cache:", file_path_in_cache)

        shutil.copyfile(file_path_in_cache, dest_path)
        print("[DEBUG] File copied to:", dest_path)

        clear_cache_for_path(file_path_in_cache)

        size_gb = os.path.getsize(dest_path) / (1024 ** 3)
        message = f"Downloaded {file_name} | {size_gb:.3f} GB"
        print("[DEBUG]", message)
        return (message, dest_path) if sync else ("", "")
    except Exception as e:
        error_msg = f"Download failed: {e}"
        print("[DEBUG]", error_msg)
        return (error_msg, "") if sync else ("", "")


def run_download_folder(parsed_data: dict, final_folder: str, token: str = "", sync: bool = False) -> tuple[str, str]:
    """
    Downloads an entire model/dataset folder (snapshot) from Hugging Face Hub.
    Moves it to models/<final_folder> and removes snapshot cache.
    """
    print("[DEBUG] run_download_folder (snapshot) started")
    try:
        # Perform full snapshot download
        snapshot_path = snapshot_download(
            repo_id=parsed_data["repo"],
            revision=parsed_data.get("revision", None),
            token=token or None,
            allow_patterns=parsed_data.get("allow_patterns", None),
            ignore_patterns=parsed_data.get("ignore_patterns", None),
            local_dir=None,  # default location
        )
        print("[DEBUG] Snapshot downloaded at:", snapshot_path)

        dest_path = os.path.join(os.getcwd(), "models", final_folder)
        if os.path.exists(dest_path):
            shutil.rmtree(dest_path)
        shutil.move(snapshot_path, dest_path)
        print("[DEBUG] Snapshot moved to:", dest_path)

        # Now clean the cache (same as single file)
        clear_cache_for_path(snapshot_path)

        return ("Folder downloaded successfully.", dest_path) if sync else ("", "")
    except Exception as e:
        error_msg = f"Folder download failed: {e}"
        print("[DEBUG]", error_msg)
        return (error_msg, "") if sync else ("", "")
