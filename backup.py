import os
import json
import yaml
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
                    ignore_patterns=["**/.cache/**", "**/.cache*", ".cache", ".cache*", "**/.skipbigtmp/**", "**/.skipbigtmp"],
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
        # Find ComfyUI root directory
        comfy_dir = os.getcwd()
        while comfy_dir != os.path.dirname(comfy_dir):  # Stop at filesystem root
            if os.path.isdir(os.path.join(comfy_dir, "custom_nodes")):
                break
            comfy_dir = os.path.dirname(comfy_dir)
        
        if not os.path.isdir(os.path.join(comfy_dir, "custom_nodes")):
            raise RuntimeError("Could not locate ComfyUI root directory (custom_nodes folder not found)")

        # Save snapshot using comfy-cli from ComfyUI root
        print("[DEBUG] Current working directory:", os.getcwd())
        print("[DEBUG] Using ComfyUI root directory:", comfy_dir)

        # Send N to the tracking consent prompt
        process = subprocess.Popen(
            ["comfy", "node", "save-snapshot"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=comfy_dir  # Run from ComfyUI root
        )
        stdout, stderr = process.communicate(input="N\n")
        
        if process.returncode != 0:
            print("[ERROR] comfy-cli save-snapshot failed:")
            print(f"stderr: {stderr}")
            print(f"stdout: {stdout}")
            raise RuntimeError("Failed to create nodes snapshot")

        print(f"[DEBUG] comfy-cli save-snapshot output:\n{stdout}")
        if stderr:
            print(f"[DEBUG] comfy-cli save-snapshot stderr:\n{stderr}")

        # Extract snapshot file name and copy to temp dir
        snapshot_file = None
        for line in stdout.splitlines():
            if "Current snapshot is saved as" in line:
                snapshot_file_name = line.split("`", 1)[-1].rsplit("`", 1)[0]
                original_snapshot = os.path.join(comfy_dir, "user", "default", "ComfyUI-Manager", "snapshots", snapshot_file_name)
                if os.path.exists(original_snapshot):
                    # Copy to temp dir for modification
                    snapshot_file = os.path.join(temp_dir, "original_snapshot.json")
                    shutil.copy2(original_snapshot, snapshot_file)
                break

        print(f"[DEBUG] Original snapshot file: {original_snapshot}")
        print(f"[DEBUG] Working copy in temp dir: {snapshot_file}")

        if not snapshot_file or not os.path.exists(snapshot_file):
            raise RuntimeError("Could not find or copy generated snapshot file")

        # Read and modify the snapshot
        with open(snapshot_file, 'r') as f:
            snapshot_data = json.load(f)
        
        # Explicitly create new data structure with empty pips
        cleaned_data = {
            "comfyui": snapshot_data.get("comfyui", ""),
            "git_custom_nodes": snapshot_data.get("git_custom_nodes", {}),
            "cnr_custom_nodes": snapshot_data.get("cnr_custom_nodes", {}),
            "file_custom_nodes": snapshot_data.get("file_custom_nodes", []),
            "pips": {}  # Explicitly empty dictionary
        }
        
        # Save cleaned snapshot in YAML format
        snapshot_dest = os.path.join(temp_dir, "custom_nodes_snapshot.yaml")
        with open(snapshot_dest, 'w') as f:
            yaml.safe_dump(cleaned_data, f, sort_keys=False, allow_unicode=True, default_flow_style=False)
        
        # Verify the saved file
        with open(snapshot_dest, 'r') as f:
            verify_data = yaml.safe_load(f)
            if verify_data.get('pips', None) != {}:
                raise RuntimeError("Failed to clean pips section in the snapshot file")
        
        print(f"[INFO] Created and verified cleaned nodes snapshot at '{snapshot_dest}'")
        print(f"[DEBUG] Snapshot structure:")
        print(f"- git_custom_nodes: {len(cleaned_data['git_custom_nodes'])} entries")
        print(f"- cnr_custom_nodes: {len(cleaned_data['cnr_custom_nodes'])} entries")
        print(f"- file_custom_nodes: {len(cleaned_data['file_custom_nodes'])} entries")
        print("- pips: verified empty dictionary")
        
        return snapshot_dest, temp_dir

    except subprocess.CalledProcessError as e:
        print(f"[WARNING] Failed to create nodes snapshot: {e.stderr if hasattr(e, 'stderr') else str(e)}")
        if isinstance(e.stderr, bytes):
            stderr = e.stderr.decode('utf-8', errors='replace')
        else:
            stderr = str(e.stderr)
        if "not found" in stderr:
            raise RuntimeError("comfy-cli command failed. Please ensure ComfyUI is properly installed.")
        raise
    except Exception as e:
        print(f"[WARNING] Failed to create nodes snapshot: {str(e)}")
        raise

def _restore_custom_nodes_from_snapshot(snapshot_file: str):
    """
    Use comfy-cli to restore nodes from a snapshot.
    """
    comfy_dir = os.getcwd()
    custom_nodes_dir = os.path.join(comfy_dir, "custom_nodes")
    os.makedirs(custom_nodes_dir, exist_ok=True)

    failed_nodes = []

    try:
        with open(snapshot_file, "r") as f:
            snapshot_data = yaml.safe_load(f)

        # Install git nodes first
        print("\n[INFO] Installing nodes from git repositories...")
        git_custom_nodes = snapshot_data.get("git_custom_nodes", {})
        if git_custom_nodes:
            for repo_url, node_data in git_custom_nodes.items():
                if node_data.get("disabled", False):
                    print(f"[INFO] Skipping disabled node: {repo_url}")
                    continue

                try:
                    repo_name = os.path.splitext(os.path.basename(repo_url))[0]
                    repo_dir = os.path.join(custom_nodes_dir, repo_name)

                    if os.path.exists(repo_dir):
                        print(f"[INFO] Node {repo_name} already exists, skipping")
                        continue

                    print(f"[INFO] Cloning: {repo_url}")
                    clone_result = subprocess.run(
                        ["git", "clone", repo_url],
                        capture_output=True,
                        text=True,
                        cwd=custom_nodes_dir
                    )
                    
                    if clone_result.returncode != 0:
                        print(f"[ERROR] Failed to clone {repo_url}:")
                        print(f"stderr: {clone_result.stderr}")
                        print(f"stdout: {clone_result.stdout}")
                        failed_nodes.append(repo_url)
                    else:
                        print(f"[SUCCESS] Cloned {repo_url}")

                except Exception as e:
                    print(f"[ERROR] Failed to install {repo_url}: {str(e)}")
                    failed_nodes.append(repo_url)
        else:
            print("[INFO] No git custom nodes found to install")

        # Install CNR nodes using comfy-cli
        print("\n[INFO] Installing nodes from CNR registry...")
        cnr_custom_nodes = snapshot_data.get("cnr_custom_nodes", {})
        if cnr_custom_nodes:
            for node_name, version in cnr_custom_nodes.items():
                try:
                    print(f"[INFO] Installing CNR node: {node_name}")
                    # Answer N to tracking prompt for each node installation
                    process = subprocess.Popen(
                        ["comfy", "node", "install", node_name],
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        cwd=comfy_dir
                    )
                    
                    stdout, stderr = process.communicate(input="N\n")
                    
                    if process.returncode != 0:
                        print(f"[ERROR] Failed to install CNR node {node_name}:")
                        print(f"stderr: {stderr}")
                        print(f"stdout: {stdout}")
                        failed_nodes.append(node_name)
                    else:
                        print(f"[SUCCESS] Installed CNR node {node_name}")
                        if stdout:
                            print(f"[DEBUG] Install output:\n{stdout}")

                except Exception as e:
                    print(f"[ERROR] Failed to install CNR node {node_name}: {str(e)}")
                    failed_nodes.append(node_name)
        else:
            print("[INFO] No CNR nodes found to install")

        if failed_nodes:
            print("\n[WARNING] The following nodes failed to install:")
            for node in failed_nodes:
                print(f"- {node}")
        else:
            print("\n[SUCCESS] All nodes were installed successfully")

    except Exception as e:
        print(f"[ERROR] Failed to restore nodes: {str(e)}")
        raise

def _copy_and_restore_token(src_folder, temp_dir):
    """
    Copy src_folder to temp_dir, ensuring 'downloader.hf_token' in comfy.settings.json is preserved.
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
                    original_token = data.get("downloader.hf_token")
                    if original_token:
                        print(f"[INFO] Preserving downloader.hf_token in {fpath}")
                    else:
                        print(f"[INFO] No downloader.hf_token found in {fpath}")
                except Exception as e:
                    print(f"[WARNING] Could not process token in {fpath}: {e}")
    return dst_folder

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
            is_user = folder == "user" or folder.startswith("user" + os.sep)
            is_custom_nodes = folder == "custom_nodes" or folder.startswith("custom_nodes" + os.sep)
            upload_path = folder
            temp_dir = None

            # Handle special cases: user folder and custom_nodes
            if (is_user):
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

            # Preserve the full path structure, especially for models/
            if os.path.isabs(folder):
                try:
                    # Get relative path from ComfyUI root
                    path_in_repo = os.path.relpath(folder, os.getcwd())
                except ValueError:
                    # If not under ComfyUI root, use the full path structure
                    path_parts = folder.strip(os.sep).split(os.sep)
                    if "models" in path_parts:
                        # Keep everything from models/ onwards
                        models_idx = path_parts.index("models")
                        path_in_repo = os.path.join(*path_parts[models_idx:])
                    else:
                        path_in_repo = os.path.basename(folder)
            else:
                path_in_repo = folder  # Use the relative path as is

            print(f"[INFO] Uploading '{upload_path}' to repo '{repo_name}' with path '{path_in_repo}'...")
            print(f"[INFO] Upload started. File size limit: {size_limit_gb} GB. Check the console for status updates.")

            if on_backup_progress:
                try:
                    on_backup_progress(path_in_repo, (i / total_folders) * 100)
                except Exception as e:
                    print(f"[WARNING] Progress callback failed: {e}")

            # Move big files to .skipbigtmp folders
            moved_big_files.extend(_move_big_files(upload_path, size_limit_gb))

            try:
                _retry_upload(
                    api=api,
                    upload_path=upload_path,
                    repo_name=repo_name,
                    token=token,
                    path_in_repo=os.path.join("ComfyUI", path_in_repo),
                    ignore_patterns=["**/.cache/**", "**/.cache*", ".cache", ".cache*", "**/.skipbigtmp/**", ".skipbigtmp/"]
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
        # Restore moved files even if upload failed
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
    from .downloader import clear_cache_for_path

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
            if (status_code == 401):
                raise ValueError(f"Invalid token for repository '{repo_name}'. Please check your token in settings.")
            elif (status_code == 403):
                raise ValueError(f"Access denied to repository '{repo_name}'. Please verify permissions and token.")
            elif (status_code == 404):
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
            print(f"[INFO] Found {len(repo_files)} files in the repository")
        except Exception as e:
            raise ValueError(f"Failed to list repository files: {str(e)}")

        comfy_files = [f for f in repo_files if f.startswith("ComfyUI/")]
        print(f"[INFO] Found {len(comfy_files)} files in ComfyUI folder")
        
        if not comfy_files:
            raise ValueError("No ComfyUI folder found in backup")

        # Map ComfyUI folders
        folder_structure = {}
        for f in comfy_files:
            # Split the path after "ComfyUI/" prefix
            rel_path = f.split("ComfyUI/", 1)[1]
            parts = rel_path.split("/")
            current = folder_structure
            for i, part in enumerate(parts):
                if i == len(parts) - 1:  # This is a file
                    if "files" not in current:
                        current["files"] = []
                    current["files"].append(f)  # Store full path for download
                else:  # This is a directory
                    if part not in current:
                        current[part] = {}
                    current = current[part]
        
        # Print folder structure
        def print_structure(struct, level=0, prefix=""):
            for key, value in struct.items():
                if key != "files":
                    file_count = sum(1 for _ in walk_files(value))
                    print(f"{'  ' * level}[INFO] {prefix}{key}/: {file_count} files")
                    print_structure(value, level + 1)

        def walk_files(struct):
            if "files" in struct:
                yield from struct["files"]
            for key, value in struct.items():
                if key != "files":
                    yield from walk_files(value)

        print("\n[INFO] Found the following structure in backup:")
        print_structure(folder_structure)

        # Check for nodes snapshot first
        if any(f.endswith("custom_nodes_snapshot.yaml") for f in comfy_files):
            # Download and process nodes snapshot
            print("\n[INFO] Found nodes snapshot, restoring custom nodes...")
            snapshot_file = hf_hub_download(
                repo_id=repo_name,
                filename="ComfyUI/custom_nodes_snapshot.yaml",
                token=token
            )
            print(f"[DEBUG] Downloaded snapshot file location: {snapshot_file}")
            try:
                with open(snapshot_file, 'r') as f:
                    snapshot_content = f.read()
                print(f"[DEBUG] Content of downloaded snapshot file:\n{snapshot_content}")
            except Exception as e:
                print(f"[ERROR] Failed to read downloaded snapshot file: {e}")
            _restore_custom_nodes_from_snapshot(snapshot_file)
            print("[INFO] Custom nodes restoration complete")
        
        # Download the rest of the files
        print("\n[INFO] Downloading model folders and other files...")
        comfy_temp = os.path.join(os.getcwd(), "temp")
        os.makedirs(comfy_temp, exist_ok=True)
        temp_dir = tempfile.mkdtemp(prefix="hf_dl_", dir=comfy_temp)

        try:
            # Download all files in parallel using snapshot_download
            print(f"[INFO] Starting parallel download to {temp_dir}")
            downloaded_folder = snapshot_download(
                repo_id=repo_name,
                token=token,
                local_dir=temp_dir,
                allow_patterns=["ComfyUI/*"],
                ignore_patterns=["ComfyUI/custom_nodes_snapshot.yaml"],  # Skip snapshot since we handled it
                local_dir_use_symlinks=False,
                max_workers=4  # Adjust based on system capabilities
            )
            print(f"[INFO] Download completed to {downloaded_folder}")

            # Move files from snapshot to target directory
            source_dir = os.path.join(downloaded_folder, "ComfyUI")
            if os.path.exists(source_dir):
                print("\n[INFO] Moving downloaded files to target directory...")
                
                def process_structure(struct, current_path=""):
                    # Process files in current directory
                    if "files" in struct:
                        for f in struct["files"]:
                            rel_path = f.split("ComfyUI/", 1)[1]
                            src_file = os.path.join(source_dir, rel_path)
                            dst_file = os.path.join(target_dir, rel_path)
                            
                            if rel_path == "custom_nodes_snapshot.yaml":
                                continue
                                
                            # Create parent directory if needed
                            os.makedirs(os.path.dirname(dst_file), exist_ok=True)
                            
                            # Always copy file even if folder exists
                            try:
                                # Handle special cases
                                if rel_path == os.path.normpath("user/default/comfy.settings.json"):
                                    try:
                                        existing_settings = {}
                                        if os.path.exists(dst_file):
                                            with open(dst_file, "r", encoding="utf-8") as f:
                                                existing_settings = json.load(f)
                                        
                                        with open(src_file, "r", encoding="utf-8") as f:
                                            new_settings = json.load(f)
                                        
                                        # Preserve token
                                        if "downloader.hf_token" in existing_settings:
                                            new_settings["downloader.hf_token"] = existing_settings["downloader.hf_token"]
                                        else:
                                            new_settings["downloader.hf_token"] = token
                                        
                                        with open(dst_file, "w", encoding="utf-8") as f:
                                            json.dump(new_settings, f, indent=2)
                                        print(f"[INFO] Updated settings file: {rel_path}")
                                    except Exception as e:
                                        print(f"[WARNING] Error handling settings file: {e}")
                                else:
                                    # Copy regular file
                                    if os.path.exists(dst_file):
                                        print(f"[INFO] Updating file: {rel_path}")
                                    else:
                                        print(f"[INFO] Copying new file: {rel_path}")
                                    shutil.copy2(src_file, dst_file)
                                    print(f"[DEBUG] Successfully copied {rel_path}")
                            except Exception as e:
                                print(f"[ERROR] Failed to copy file {rel_path}: {e}")

                    # Process subdirectories
                    for key, value in struct.items():
                        if key != "files":
                            new_path = os.path.join(current_path, key)
                            dir_path = os.path.join(target_dir, new_path)
                            
                            if not os.path.exists(dir_path):
                                os.makedirs(dir_path)
                                print(f"[INFO] Created directory: {os.path.relpath(dir_path, target_dir)}")
                            else:
                                print(f"[DEBUG] Using existing directory: {os.path.relpath(dir_path, target_dir)}")
                            # Process its contents
                            process_structure(value, new_path)

                process_structure(folder_structure)

            # Clean up
            clear_cache_for_path(downloaded_folder)
            print(f"\n[SUCCESS] Successfully restored backup to {target_dir}")
            return target_dir

        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
            print("[INFO] Cleaned up temporary files")

    except Exception as e:
        print(f"[ERROR] Failed to restore: {e}")
        raise
