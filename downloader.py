import os
import sys
import shutil
import tempfile
import threading
import time
import json
import zipfile
import hashlib
import yaml
from typing import Optional, Tuple

from huggingface_hub import (
    HfApi,
    hf_hub_download,
    snapshot_download,
    scan_cache_dir,
    list_repo_files
)

os.environ.setdefault("HF_HUB_ENABLE_HF_XET", "1")

token_override = os.getenv("HF_TOKEN")
SHA_VERIFY_MAX_BYTES = int(os.getenv("HF_DOWNLOADER_SHA_MAX_BYTES", str(1024 ** 3)))

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


def _safe_remove(path: str):
    try:
        os.remove(path)
    except FileNotFoundError:
        return
    except Exception as e:
        print(f"[DEBUG] Failed to remove {path}: {e}")


def _extract_lfs_value(lfs, key: str):
    if not lfs:
        return None
    if isinstance(lfs, dict):
        return lfs.get(key)
    return getattr(lfs, key, None)


def get_remote_file_metadata(repo_id: str,
                             remote_filename: str,
                             revision: str = None,
                             token: str = None) -> Tuple[Optional[int], Optional[str], Optional[str]]:
    try:
        api = HfApi()
        info = api.model_info(repo_id, revision=revision, token=token, files_metadata=True)
        siblings = getattr(info, "siblings", []) or []
        for sibling in siblings:
            if getattr(sibling, "rfilename", None) != remote_filename:
                continue
            size = getattr(sibling, "size", None)
            blob_id = getattr(sibling, "blob_id", None)
            etag = getattr(sibling, "etag", None)
            lfs = getattr(sibling, "lfs", None)
            if lfs:
                sha = _extract_lfs_value(lfs, "sha256") or _extract_lfs_value(lfs, "oid")
                size = _extract_lfs_value(lfs, "size") or size
                etag = sha or blob_id or etag
            else:
                sha = None
                etag = blob_id or etag
            return size, sha, etag
    except Exception as e:
        print(f"[DEBUG] Failed to fetch metadata for {repo_id}/{remote_filename}: {e}")
    return None, None, None


def _get_hf_cache_dir() -> str:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
        return HF_HUB_CACHE
    except Exception:
        return os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")


def get_blob_paths(repo_id: str, etag: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    if not etag:
        return None, None
    repo_folder = f"models--{repo_id.replace('/', '--')}"
    blob_dir = os.path.join(_get_hf_cache_dir(), repo_folder, "blobs")
    blob_path = os.path.join(blob_dir, etag)
    return blob_path, blob_path + ".incomplete"


def _verify_file_integrity(dest_path: str,
                           expected_size: Optional[int],
                           expected_sha: Optional[str]):
    if expected_size is not None:
        actual_size = os.path.getsize(dest_path)
        if actual_size != expected_size:
            raise RuntimeError(
                f"Size mismatch (expected {expected_size} bytes, got {actual_size} bytes)"
            )
    if expected_sha:
        size_for_sha = expected_size if expected_size is not None else os.path.getsize(dest_path)
        if size_for_sha > SHA_VERIFY_MAX_BYTES:
            print(f"[DEBUG] Skipping SHA256 for large file ({size_for_sha} bytes).")
            return
        sha256 = hashlib.sha256()
        with open(dest_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                sha256.update(chunk)
        actual_sha = sha256.hexdigest().lower()
        if actual_sha != expected_sha.lower():
            raise RuntimeError("SHA256 mismatch")


def run_download(parsed_data: dict,
                 final_folder: str,
                 sync: bool = False) -> tuple[str, str]:
    """
    Downloads a single file from Hugging Face Hub and copies it to models/<final_folder>.
    Cleans up the cached copy to save disk space.
    """
    token = get_token()
    print("[DEBUG] run_download (single-file) started")

    file_name = parsed_data.get("file", "unknown.bin").strip("/")
    sub = parsed_data.get("subfolder", "").strip("/")
    remote_filename = os.path.join(sub, file_name) if sub else file_name

    expected_size, expected_sha, _ = get_remote_file_metadata(
        parsed_data["repo"],
        remote_filename,
        revision=parsed_data.get("revision"),
        token=token or None
    )

    try:
        target_dir = os.path.join(os.getcwd(), "models", final_folder)
        os.makedirs(target_dir, exist_ok=True)
        dest_path = os.path.join(target_dir, os.path.basename(remote_filename))

        if os.path.exists(dest_path):
            try:
                _verify_file_integrity(dest_path, expected_size, expected_sha)
                size_gb = os.path.getsize(dest_path) / (1024 ** 3)
                message = f"{file_name} already exists | {size_gb:.3f} GB"
                print("[DEBUG]", message)
                return (message, dest_path) if sync else ("", "")
            except Exception as e:
                print(f"[DEBUG] Existing file failed verification, re-downloading: {e}")
                _safe_remove(dest_path)

        file_path_in_cache = hf_hub_download(
            repo_id=parsed_data["repo"],
            filename=remote_filename,
            revision=parsed_data.get("revision"),
            token=token or None
        )
        print("[DEBUG] File downloaded to cache:", file_path_in_cache)

        shutil.copyfile(file_path_in_cache, dest_path)
        print("[DEBUG] File copied to:", dest_path)

        try:
            _verify_file_integrity(dest_path, expected_size, expected_sha)
        except Exception as e:
            _safe_remove(dest_path)
            raise RuntimeError(f"Download verification failed: {e}") from e

        clear_cache_for_path(file_path_in_cache)

        size_gb = os.path.getsize(dest_path) / (1024 ** 3)
        final_message = f"Downloaded {file_name} | {size_gb:.3f} GB"
        print("[DEBUG]", final_message)
        return (final_message, dest_path) if sync else ("", "")
    except Exception as e:
        # Provide clearer feedback for common authentication/authorization problems
        if "Invalid credentials" in str(e) or "401" in str(e):
            error_msg = (
                f"Invalid Hugging Face token for repository '{parsed_data['repo']}'.\n"
                "Add a valid token in ComfyUI settings or set the HF_TOKEN environment variable.\n"
                "Create/manage tokens at https://huggingface.co/settings/tokens/"
            )
        elif "403" in str(e) or "gated" in str(e) or "permission" in str(e):
            repo_url = f"https://huggingface.co/{parsed_data['repo']}"
            error_msg = (
                f"The repository '{parsed_data['repo']}' is gated or you do not have permission to access it.\n"
                f"Visit {repo_url}, accept its terms or request access, then retry the download."
            )
        else:
            error_msg = f"Download failed: {e}"
        print("[DEBUG]", error_msg)
        # Raise so ComfyUI shows the standard error dialog, not just console output
        raise RuntimeError(error_msg)


def run_download_folder(parsed_data: dict,
                        final_folder: str,
                        remote_subfolder_path: str = "",
                        last_segment: str = "",
                        sync: bool = False) -> tuple[str, str]:
    """
    Downloads a folder or subfolder from Hugging Face Hub using snapshot_download.
    The result is placed in:
    - models/<final_folder>/<repo_name> if downloading entire repo
    - models/<final_folder>/<last_segment> if downloading specific subfolder
    """
    token = get_token()
    print("[DEBUG] run_download_folder started")

    # Get repository name from the parsed data
    repo_name = parsed_data["repo"].split("/")[-1] if "/" in parsed_data["repo"] else parsed_data["repo"]

    # Create base directory
    base_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(base_dir, exist_ok=True)
    
    # Determine destination folder name based on whether it's a subfolder or root link
    if remote_subfolder_path and last_segment:
        # If it's a subfolder link, use the last segment
        dest_path = os.path.join(base_dir, last_segment)
    else:
        # If it's a root link, use the repo name
        dest_path = os.path.join(base_dir, repo_name)

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


def scan_repo_root(repo_id: str, token: str = None) -> tuple[list[str], list[str]]:
    """
    Scan a repository's root folder for subfolders and files.
    Returns (folders, files) where each is a list of names found at root level.
    """
    try:
        all_files = list_repo_files(repo_id, token=token)
        folders = set()
        root_files = set()
        
        for path in all_files:
            parts = path.split('/')
            if len(parts) > 1:
                folders.add(parts[0])
            else:
                root_files.add(path)
                
        return sorted(list(folders)), sorted(list(root_files))
    except Exception as e:
        print(f"[ERROR] Failed to scan repository root: {e}")
        raise

def extract_custom_nodes(zip_path: str, comfy_root: str) -> str:
    """
    Extract custom_nodes.zip to the custom_nodes folder in ComfyUI root.
    Returns the path to the extracted folder.
    """
    custom_nodes_dir = os.path.join(comfy_root, "custom_nodes")
    os.makedirs(custom_nodes_dir, exist_ok=True)
    
    print(f"[INFO] Extracting custom_nodes.zip to {custom_nodes_dir}")
    with zipfile.ZipFile(zip_path, 'r') as zipf:
        zipf.extractall(custom_nodes_dir)
    
    return custom_nodes_dir

def download_repo_contents(parsed_data: dict, comfy_root: str, sync: bool = True) -> tuple[str, list[str]]:
    """
    Download all contents from a repository's root level:
    1. Scan for subfolders and files
    2. Download each folder to ComfyUI root
    3. Handle custom_nodes.zip specially if it exists
    
    Returns (message, list of downloaded paths)
    """
    token = get_token()
    downloaded_paths = []
    
    try:
        folders, files = scan_repo_root(parsed_data["repo"], token)
        print(f"[INFO] Found {len(folders)} folders and {len(files)} files at root level")
        
        # First handle folders
        for folder in folders:
            if folder == ".git":  # Skip git metadata
                continue
                
            folder_parsed = parsed_data.copy()
            folder_parsed["subfolder"] = folder
            
            message, folder_path = run_download_folder(
                folder_parsed,
                folder,  # Use the folder name as the final folder
                remote_subfolder_path=folder,
                sync=True  # Always sync for better control
            )
            
            if folder_path:
                downloaded_paths.append(folder_path)
                print(f"[INFO] Downloaded folder: {message}")
        
        # Then handle root files
        for file in files:
            if file == "custom_nodes.zip":
                # Special handling for custom_nodes.zip
                file_parsed = parsed_data.copy()
                file_parsed["file"] = file
                
                message, zip_path = run_download(
                    file_parsed,
                    "temp",  # Temporary location
                    sync=True
                )
                
                if zip_path:
                    custom_nodes_dir = extract_custom_nodes(zip_path, comfy_root)
                    downloaded_paths.append(custom_nodes_dir)
                    print(f"[INFO] Extracted custom_nodes.zip")
                    # Clean up the temporary zip file
                    try:
                        os.remove(zip_path)
                    except:
                        pass
            else:
                # Regular file download to root
                file_parsed = parsed_data.copy()
                file_parsed["file"] = file
                
                message, file_path = run_download(
                    file_parsed,
                    "",  # Empty for root
                    sync=True
                )
                
                if file_path:
                    downloaded_paths.append(file_path)
                    print(f"[INFO] Downloaded file: {message}")
        
        final_message = f"Downloaded {len(downloaded_paths)} items from repository root"
        return (final_message, downloaded_paths) if sync else ("", [])
    except Exception as e:
        error_msg = f"Failed to download repository contents: {e}"
        print("[ERROR]", error_msg)
        raise RuntimeError(error_msg)

def merge_and_update_yaml(repo_id: str, token: str, local_snapshot: dict, yaml_filename: str = "custom_nodes_snapshot.yaml"):
    """
    Merge the `cnr_custom_nodes` list from the existing YAML file in the repo with the local snapshot.
    Clean the `pips` section and upload the updated YAML file back to the repository.
    """
    try:
        # Import HfApi here to avoid circular imports
        from huggingface_hub import HfApi

        print("[DEBUG] Starting YAML merge process...")

        # Check if the YAML file exists in the repository
        files = list_repo_files(repo_id, token=token)
        if yaml_filename in files:
            print(f"[DEBUG] Found existing YAML file: {yaml_filename}")
            # Download the existing YAML file
            yaml_path = hf_hub_download(repo_id=repo_id, filename=yaml_filename, token=token)
            with open(yaml_path, "r") as f:
                existing_data = yaml.safe_load(f)
                print(f"[DEBUG] Loaded existing data from {yaml_filename}")
        else:
            print(f"[DEBUG] No existing YAML file found. Creating new one.")
            existing_data = {}

        # Merge `cnr_custom_nodes` with priority to local versions
        existing_nodes = existing_data.get("cnr_custom_nodes", {})
        local_nodes = local_snapshot.get("cnr_custom_nodes", {})
        print(f"[DEBUG] Merging cnr_custom_nodes (existing: {len(existing_nodes)}, local: {len(local_nodes)})")
        merged_nodes = {**existing_nodes, **local_nodes}  # Local nodes take priority

        # Merge `git_custom_nodes` with priority to local versions
        existing_git_nodes = existing_data.get("git_custom_nodes", {})
        local_git_nodes = local_snapshot.get("git_custom_nodes", {})
        print(f"[DEBUG] Merging git_custom_nodes (existing: {len(existing_git_nodes)}, local: {len(local_git_nodes)})")
        merged_git_nodes = {**existing_git_nodes, **local_git_nodes}  # Local git nodes take priority

        # Create new data structure with empty pips
        updated_data = {
            "comfyui": local_snapshot.get("comfyui", ""),
            "git_custom_nodes": merged_git_nodes,
            "cnr_custom_nodes": merged_nodes,
            "file_custom_nodes": local_snapshot.get("file_custom_nodes", []),
            "pips": {}  # Explicitly empty dictionary
        }

        print("[DEBUG] Final structure:")
        print(f"- git_custom_nodes: {len(updated_data['git_custom_nodes'])} entries")
        print(f"- cnr_custom_nodes: {len(updated_data['cnr_custom_nodes'])} entries")
        print(f"- file_custom_nodes: {len(updated_data['file_custom_nodes'])} entries")
        print("- pips: empty dictionary")

        # Save to temp file
        temp_dir = tempfile.mkdtemp(prefix="comfyui_snapshot_")
        temp_path = os.path.join(temp_dir, yaml_filename)
        
        with open(temp_path, "w") as f:
            yaml.safe_dump(updated_data, f, sort_keys=False)
        
        print(f"[DEBUG] Saved updated YAML to: {temp_path}")

        # Upload back to repo
        api = HfApi()
        api.upload_file(
            path_or_fileobj=temp_path,
            path_in_repo=yaml_filename,
            repo_id=repo_id,
            token=token
        )
        print(f"[INFO] Successfully uploaded updated {yaml_filename} to repository")

        # Cleanup
        try:
            shutil.rmtree(temp_dir)
        except Exception as e:
            print(f"[WARNING] Failed to cleanup temp directory: {e}")

    except Exception as e:
        print(f"[ERROR] Failed to merge and update YAML: {e}")
        raise
