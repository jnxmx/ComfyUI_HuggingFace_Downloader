import os
import json
import tempfile
import shutil
import time
import subprocess
from huggingface_hub import HfApi
from .parse_link import parse_link

def get_token_and_size_limit():
    """
    Load the Hugging Face token and backup file size limit from comfy.settings.json.
    If not found or empty, fall back to the HF_TOKEN environment variable and default size limit 5.
    """
    settings_path = os.path.join("user", "default", "comfy.settings.json")
    token = ""
    size_limit_gb = None
    if os.path.exists(settings_path):
        with open(settings_path, "r") as f:
            settings = json.load(f)
        token = settings.get("downloader.hf_token", "").strip()
        try:
            size_limit_gb = float(settings.get("downloaderbackup.file_size_limit"))
        except Exception:
            size_limit_gb = None
    if not token:
        token = os.getenv("HF_TOKEN", "").strip()
    if size_limit_gb is None:
        size_limit_gb = 5
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

def _retry_upload(api, upload_path, repo_name, token, path_in_repo, max_retries=3, initial_delay=1):
    """Helper function to retry uploads with exponential backoff"""
    delay = initial_delay
    last_error = None
    
    for attempt in range(max_retries):
        try:
            # Handle single file vs directory upload differently
            if os.path.isfile(upload_path):
                api.upload_file(
                    path_or_fileobj=upload_path,
                    path_in_repo=path_in_repo,
                    repo_id=repo_name,
                    token=token
                )
            else:
                api.upload_folder(
                    folder_path=upload_path,
                    repo_id=repo_name,
                    token=token,
                    path_in_repo=path_in_repo,
                    ignore_patterns=["**/.cache/**", "**/.cache*", ".cache", ".cache*"],
                )
            return True
        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                print(f"[WARNING] Upload attempt {attempt + 1} failed: {str(e)}")
                print(f"[INFO] Retrying in {delay} seconds...")
                time.sleep(delay)
                delay *= 2
            
    raise RuntimeError(f"Upload failed after {max_retries} attempts. Last error: {str(last_error)}")

def find_comfy_root() -> str:
    """
    Dynamically locate the ComfyUI root directory by searching for the 'custom_nodes' folder.
    Returns the path to the ComfyUI root directory.
    """
    current_dir = os.getcwd()
    while current_dir != os.path.dirname(current_dir):  # Stop at the root of the filesystem
        if os.path.isdir(os.path.join(current_dir, "custom_nodes")):
            return current_dir
        current_dir = os.path.dirname(current_dir)
    raise RuntimeError("Could not locate the ComfyUI root directory (custom_nodes folder not found).")

def _backup_custom_nodes(target_dir: str) -> str:
    """
    Use comfy-cli to save a snapshot of custom nodes.
    Returns the path to the snapshot file and temp dir.
    """
    # First check if comfy-cli is installed
    try:
        subprocess.run(
            ["comfy", "--version"],
            check=True,
            capture_output=True,
            text=True
        )
    except subprocess.CalledProcessError:
        raise RuntimeError("comfy-cli not found. Please install it with 'pip install comfy-cli'")
    except FileNotFoundError:
        raise RuntimeError("comfy-cli not found. Please install it with 'pip install comfy-cli'")

    temp_dir = tempfile.mkdtemp(prefix="comfyui_nodes_snapshot_")
    
    try:
        comfy_dir = find_comfy_root()
        if not os.path.isdir(os.path.join(comfy_dir, "custom_nodes")):
            raise RuntimeError("Not in a ComfyUI directory (custom_nodes folder not found)")

        # Create snapshots directory if it doesn't exist
        snapshots_dir = os.path.join(comfy_dir, "custom_nodes", "snapshots")
        os.makedirs(snapshots_dir, exist_ok=True)

        # Save snapshot using comfy-cli
        result = subprocess.run(
            ["comfy", "node", "save-snapshot"],
            check=True,
            capture_output=True,
            text=True,
            cwd=comfy_dir  # Explicitly set working directory
        )
        
        # Find the most recently created snapshot file
        snapshot_file = None
        if os.path.exists(snapshots_dir):
            snapshot_files = [(f, os.path.getmtime(os.path.join(snapshots_dir, f))) 
                            for f in os.listdir(snapshots_dir)
                            if f.endswith('.yaml')]
            if snapshot_files:
                snapshot_files.sort(key=lambda x: x[1], reverse=True)
                snapshot_file = os.path.join(snapshots_dir, snapshot_files[0][0])
        
        if not snapshot_file:
            raise RuntimeError("Could not find generated snapshot file")
            
        snapshot_dest = os.path.join(temp_dir, "custom_nodes_snapshot.yaml")
        shutil.copy2(snapshot_file, snapshot_dest)
        
        return snapshot_dest, temp_dir
    except subprocess.CalledProcessError as e:
        print(f"[WARNING] Failed to create nodes snapshot: {e.stderr}")
        if "not found" in str(e.stderr):
            raise RuntimeError("comfy-cli command failed. Please ensure ComfyUI is properly installed.")
        raise
    except Exception as e:
        print(f"[WARNING] Failed to create nodes snapshot: {str(e)}")
        raise

def _restore_custom_nodes_from_snapshot(snapshot_file: str):
    """
    Use comfy-cli to restore custom nodes from a snapshot.
    """
    # First save current state as backup
    try:
        subprocess.run(
            ["comfy", "node", "save-snapshot"],
            check=True,
            capture_output=True,
            text=True
        )
        print("[INFO] Saved current nodes state as backup")
    except subprocess.CalledProcessError as e:
        print(f"[WARNING] Failed to backup current nodes state: {e.stderr}")
    
    # Copy snapshot file to custom_nodes/snapshots directory
    comfy_dir = os.getcwd()
    snapshots_dir = os.path.join(comfy_dir, "custom_nodes", "snapshots")
    os.makedirs(snapshots_dir, exist_ok=True)
    snapshot_dest = os.path.join(snapshots_dir, "restore_snapshot.yaml")
    shutil.copy2(snapshot_file, snapshot_dest)
    
    try:
        # Restore using comfy-cli
        subprocess.run(
            ["comfy", "node", "restore-snapshot", "restore_snapshot"],
            check=True,
            capture_output=True,
            text=True
        )
        print("[INFO] Successfully restored custom nodes")
        
        # Update all nodes to ensure latest versions
        subprocess.run(
            ["comfy", "node", "update", "all"],
            check=True,
            capture_output=True,
            text=True
        )
        print("[INFO] Updated all custom nodes")
        
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] Failed to restore nodes: {e.stderr}")
        raise

def backup_to_huggingface(repo_name_or_link, folders, size_limit_gb=None, on_backup_start=None, on_backup_progress=None, *args, **kwargs):
    """
    Backup specified folders to a Hugging Face repository under a single 'ComfyUI' root.
    Uses retry logic for better reliability.
    
    Args:
        repo_name_or_link: Repository name or link
        folders: List of folders to backup
        size_limit_gb: Maximum size in GB for individual files to backup (overrides settings)
        on_backup_start(): Called when backup starts 
        on_backup_progress(folder, progress_pct): Called during backup with current folder and progress
    """
    api = HfApi()
    token, default_size_limit = get_token_and_size_limit()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    # Use provided size_limit_gb if set, otherwise use the one from settings
    size_limit_gb = size_limit_gb if size_limit_gb is not None else default_size_limit

    if on_backup_start:
        try:
            on_backup_start()
        except Exception as e:
            print(f"[WARNING] Backup start callback failed: {e}")

    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

    temp_dirs = []
    moved_big_files = []
    try:
        total_folders = len([f for f in folders if f and os.path.exists(f.strip())])
        for i, folder in enumerate(folders, 1):
            folder = folder.strip()
            if not folder or not os.path.exists(folder):
                continue
            folder = os.path.normpath(folder)
            rel_path = os.path.basename(folder)
            is_user = rel_path == "user" or rel_path.startswith("user" + os.sep)
            is_custom_nodes = rel_path == "custom_nodes" or rel_path.startswith("custom_nodes" + os.sep)
            upload_path = folder
            temp_dir = None

            # Handle special cases: user folder and custom_nodes
            if is_user:
                temp_dir = tempfile.mkdtemp(prefix="comfyui_user_strip_")
                upload_path = _copy_and_strip_token(folder, temp_dir)
                temp_dirs.append(temp_dir)
                print(f"[INFO] Created sanitized copy of '{folder}' at '{upload_path}' for upload.")
            elif is_custom_nodes:
                # Create snapshot using comfy-cli
                snapshot_file, temp_dir = _backup_custom_nodes(folder)
                temp_dirs.append(temp_dir)
                path_in_repo = os.path.join("ComfyUI", "custom_nodes_snapshot.yaml")
                print(f"[INFO] Created nodes snapshot at '{snapshot_file}'")
                _retry_upload(
                    api=api,
                    upload_path=snapshot_file,
                    repo_name=repo_name,
                    token=token,
                    path_in_repo=path_in_repo
                )
                print(f"[INFO] Upload of nodes snapshot complete.")
                continue

            path_in_repo = os.path.basename(folder) # Default to base name
            if os.path.isabs(folder):
                try:
                    path_in_repo = os.path.relpath(folder, os.getcwd())
                except ValueError:
                    path_in_repo = os.path.basename(folder)

            print(f"[INFO] Uploading '{upload_path}' to repo '{repo_name}' with path '{path_in_repo}'...")
            print(f"[INFO] Upload started. File size limit: {size_limit_gb} GB. Check the console for status updates.")

            if on_backup_progress:
                try:
                    on_backup_progress(path_in_repo, (i / total_folders) * 100)
                except Exception as e:
                    print(f"[WARNING] Progress callback failed: {e}")

            moved_big_files.extend(_move_big_files(upload_path, size_limit_gb))
            try:
                _retry_upload(
                    api=api,
                    upload_path=upload_path,
                    repo_name=repo_name,
                    token=token,
                    path_in_repo="ComfyUI/" + path_in_repo
                )
                print(f"[INFO] Upload of '{upload_path}' complete.")
            except Exception as e:
                print(f"[ERROR] Upload failed for '{upload_path}': {str(e)}")
                if "Stream" in str(e) and "reset by remote peer" in str(e):
                    print("[INFO] This appears to be a connection issue. You may want to:")
                    print("1. Check your internet connection")
                    print("2. Try uploading fewer/smaller files at once")
                    print("3. Ensure you have sufficient permissions on Hugging Face")
                raise
    except Exception as e:
        print(f"[ERROR] Backup failed: {e}")
        raise
    finally:
        _restore_big_files(moved_big_files)
        for temp_dir in temp_dirs:
            shutil.rmtree(temp_dir, ignore_errors=True)
            print(f"[INFO] Removed temporary sanitized folder '{temp_dir}'.")

def _safe_move_or_copy(src, dst):
    """Helper to move files when possible, fall back to copy if on different devices"""
    try:
        # Try to move first (more efficient)
        shutil.move(src, dst)
    except OSError:
        # If move fails (e.g., across devices), fall back to copy
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)

def _extract_custom_nodes_archive(src_file, target_dir):
    """
    Extract custom_nodes.zip to the target directory.
    """
    custom_nodes_dir = os.path.join(target_dir, "custom_nodes")
    print(f"[INFO] Extracting custom_nodes archive to '{custom_nodes_dir}'")
    
    with zipfile.ZipFile(src_file, 'r') as zipf:
        zipf.extractall(custom_nodes_dir)
    
    print(f"[INFO] Successfully extracted custom_nodes archive")
    return custom_nodes_dir

def restore_from_huggingface(repo_name_or_link, target_dir=None):
    """
    Restore the 'ComfyUI' folder from a Hugging Face repository.
    Uses snapshot_download for faster parallel downloads.
    """
    from huggingface_hub import snapshot_download, hf_hub_download
    import hf_transfer
    import requests.exceptions
    from collections import defaultdict
    from .downloader import clear_cache_for_path, folder_size

    # Enable hf_transfer
    os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
    
    api = HfApi()
    token, _ = get_token_and_size_limit()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

    if target_dir is None:
        target_dir = os.getcwd()

    print(f"[INFO] Starting download from '{repo_name}' (using parallel download)...")
    try:
        # Validate repo access first
        try:
            repo_info = api.repo_info(repo_id=repo_name, token=token)
            if not repo_info:
                raise ValueError(f"Repository {repo_name} not found or not accessible")
        except requests.exceptions.HTTPError as e:
            status_code = getattr(e.response, 'status_code', None)
            if status_code == 401:
                raise ValueError(f"Invalid token for repository '{repo_name}'. Please check your token in settings.")
            elif status_code == 403:
                raise ValueError(f"Access denied to repository '{repo_name}'. Please verify permissions and token.")
            elif status_code == 404:
                raise ValueError(f"Repository '{repo_name}' not found. Please verify the repository name/link.")
            else:
                raise ValueError(f"Error accessing repository: {str(e)}")
        except Exception as e:
            if isinstance(e, (ValueError, RuntimeError)) and "<!DOCTYPE" in str(e):
                raise ValueError("Network error or invalid response from Hugging Face. Please check your internet connection.")
            raise

        # Get list of files to download
        try:
            repo_files = api.list_repo_files(repo_id=repo_name, token=token)
        except Exception as e:
            raise ValueError(f"Failed to list repository files: {str(e)}")

        comfy_files = [f for f in repo_files if f.startswith("ComfyUI/")]
        if not comfy_files:
            raise ValueError("No ComfyUI folder found in backup")

        # Check for nodes snapshot first
        if "ComfyUI/custom_nodes_snapshot.yaml" in comfy_files:
            # Download and process nodes snapshot
            print("[INFO] Found nodes snapshot, restoring custom nodes...")
            snapshot_file = hf_hub_download(
                repo_id=repo_name,
                filename="ComfyUI/custom_nodes_snapshot.yaml",
                token=token
            )
            _restore_custom_nodes_from_snapshot(snapshot_file)
            print("[INFO] Custom nodes restoration complete")
        
        # Download the rest of the files
        comfy_temp = os.path.join(os.getcwd(), "temp")
        os.makedirs(comfy_temp, exist_ok=True)
        temp_dir = tempfile.mkdtemp(prefix="hf_dl_", dir=comfy_temp)

        try:
            # Download all files in parallel using snapshot_download
            downloaded_folder = snapshot_download(
                repo_id=repo_name,
                token=token,
                local_dir=temp_dir,
                allow_patterns=["ComfyUI/*"],
                ignore_patterns=["ComfyUI/custom_nodes_snapshot.yaml"],  # Skip snapshot since we handled it
                local_dir_use_symlinks=False,
                max_workers=4  # Adjust based on system capabilities
            )

            # Move files from snapshot to target directory
            source_dir = os.path.join(downloaded_folder, "ComfyUI")
            if os.path.exists(source_dir):
                for root, dirs, files in os.walk(source_dir):
                    for d in dirs:
                        src_dir = os.path.join(root, d)
                        rel_path = os.path.relpath(src_dir, source_dir)
                        dst_dir = os.path.join(target_dir, rel_path)
                        os.makedirs(dst_dir, exist_ok=True)
                    
                    for f in files:
                        src_file = os.path.join(root, f)
                        rel_path = os.path.relpath(src_file, source_dir)
                        dst_file = os.path.join(target_dir, rel_path)
                        
                        # Skip custom_nodes_snapshot.yaml since we already handled it
                        if rel_path == "custom_nodes_snapshot.yaml":
                            continue
                            
                        # Handle other files normally
                        os.makedirs(os.path.dirname(dst_file), exist_ok=True)
                        _safe_move_or_copy(src_file, dst_file)

            # Clean up
            clear_cache_for_path(downloaded_folder)
            print(f"[INFO] Successfully restored backup to {target_dir}")
            return target_dir

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
            print("[INFO] Cleaned up temporary files")

    except Exception as e:
        print(f"[ERROR] Failed to restore: {e}")
        raise
