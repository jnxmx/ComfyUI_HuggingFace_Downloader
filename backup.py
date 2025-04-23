import os
import json
import tempfile
import shutil
import time
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
            return api.upload_folder(
                folder_path=upload_path,
                repo_id=repo_name,
                token=token,
                path_in_repo=path_in_repo,
                ignore_patterns=["**/.cache/**", "**/.cache*", ".cache", ".cache*"],
            )
        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                print(f"[WARNING] Upload attempt {attempt + 1} failed: {str(e)}")
                print(f"[INFO] Retrying in {delay} seconds...")
                time.sleep(delay)
                delay *= 2
            
    raise RuntimeError(f"Upload failed after {max_retries} attempts. Last error: {str(last_error)}")

def backup_to_huggingface(repo_name_or_link, folders, on_backup_start=None, on_backup_progress=None, *args, **kwargs):
    """
    Backup specified folders to a Hugging Face repository under a single 'ComfyUI' root.
    Uses retry logic for better reliability.
    
    Callbacks:
    - on_backup_start(): Called when backup starts 
    - on_backup_progress(folder, progress_pct): Called during backup with current folder and progress
    """
    api = HfApi()
    token, size_limit_gb = get_token_and_size_limit()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

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
            upload_path = folder
            temp_dir = None
            if is_user:
                temp_dir = tempfile.mkdtemp(prefix="comfyui_user_strip_")
                upload_path = _copy_and_strip_token(folder, temp_dir)
                temp_dirs.append(temp_dir)
                print(f"[INFO] Created sanitized copy of '{folder}' at '{upload_path}' for upload.")

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

def restore_from_huggingface(repo_name_or_link, target_dir=None):
    """
    Restore the 'ComfyUI' folder from a Hugging Face repository.
    Uses hf_transfer for faster downloads.
    """
    from huggingface_hub import hf_hub_download
    import hf_transfer

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

    print(f"[INFO] Checking files in '{repo_name}' (using hf_transfer)...")
    try:
        # Get list of all files and their info from repo
        repo_files = api.list_repo_files(repo_id=repo_name, token=token)
        comfy_files = [f for f in repo_files if f.startswith("ComfyUI/")]
        
        if not comfy_files:
            raise ValueError("No ComfyUI folder found in backup")

        for file in comfy_files:
            local_path = os.path.join(target_dir, file.replace("ComfyUI/", "", 1))
            
            # Skip if file exists and has same size
            try:
                file_info = api.get_info_from_repo(
                    repo_id=repo_name,
                    filename=file,
                    token=token
                )
                if os.path.exists(local_path):
                    local_size = os.path.getsize(local_path)
                    if local_size == file_info.size:
                        print(f"[INFO] Skipping existing file: {local_path}")
                        continue
            except Exception as e:
                print(f"[WARNING] Could not check file info for {file}: {e}")

            # Download if missing or different
            print(f"[INFO] Downloading: {file}")
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            hf_hub_download(
                repo_id=repo_name,
                filename=file,
                token=token,
                local_dir=target_dir,
                local_dir_use_symlinks=False
            )

        print(f"[INFO] Successfully restored backup to {target_dir}")
        return target_dir

    except Exception as e:
        print(f"[ERROR] Failed to restore: {e}")
        raise
