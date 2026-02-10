import os
import json
import yaml
import tempfile
import shutil
import time
import subprocess
import copy
import re
from huggingface_hub import HfApi
from .parse_link import parse_link

PLACEHOLDER_MODEL_FILE_RE = re.compile(r"^put[\s._-]*models?[\s._-]*here(?:\.[^/\\]+)?$", re.IGNORECASE)
LOCAL_SUBGRAPH_PATHS = (
    "user/default/workflows/.subgraphs",
    "user/default/subgraphs",
)
REPO_SUBGRAPH_PATHS = tuple(f"ComfyUI/{p}" for p in LOCAL_SUBGRAPH_PATHS)
CUSTOM_NODES_SNAPSHOT_PATH = "ComfyUI/custom_nodes_snapshot.yaml"


def _normalize_local_path(path: str) -> str:
    """Normalize a local ComfyUI-relative path and reject traversal."""
    parts = []
    for part in str(path or "").replace("\\", "/").split("/"):
        part = part.strip()
        if not part or part == ".":
            continue
        if part == "..":
            raise ValueError(f"Invalid path segment '..' in '{path}'")
        parts.append(part)
    return "/".join(parts)


def _normalize_repo_path(path: str) -> str:
    """Normalize a repo path and enforce ComfyUI prefix."""
    clean = _normalize_local_path(path)
    if not clean:
        return "ComfyUI"
    if clean == "ComfyUI" or clean.startswith("ComfyUI/"):
        return clean
    return f"ComfyUI/{clean}"


def _to_os_path(path: str) -> str:
    """Convert a normalized '/' path to an OS-native relative path."""
    if not path:
        return path
    return os.path.normpath(path.replace("/", os.sep))


def _is_placeholder_model_file(filename: str) -> bool:
    if not filename:
        return False
    return bool(PLACEHOLDER_MODEL_FILE_RE.match(filename.strip().lower()))


def _is_settings_file_path(path: str) -> bool:
    normalized = _normalize_local_path(path).lower()
    return normalized.endswith("comfy.settings.json")


def _parse_repo_name(repo_name_or_link: str) -> str:
    parsed = parse_link(repo_name_or_link)
    return parsed.get("repo", repo_name_or_link)


def _settings_file_exists(path: str = "user/default/comfy.settings.json") -> bool:
    try:
        return os.path.isfile(_to_os_path(_normalize_local_path(path)))
    except Exception:
        return False


def _get_local_files(path: str, include_hidden: bool = True) -> list:
    """
    Return local file paths relative to ComfyUI root.
    If path is a file, returns [path]. If it's a folder, returns all files recursively.
    """
    rel = _normalize_local_path(path)
    if not rel:
        return []
    abs_path = _to_os_path(rel)
    if not os.path.exists(abs_path):
        return []
    if os.path.isfile(abs_path):
        return [rel]

    files = []
    for root, _, names in os.walk(abs_path):
        for name in names:
            if (not include_hidden) and name.startswith("."):
                continue
            full = os.path.join(root, name)
            rel_file = os.path.relpath(full, os.getcwd()).replace("\\", "/")
            files.append(_normalize_local_path(rel_file))
    return files


def _filter_real_model_files(files: list) -> list:
    """Drop placeholder marker files (for example, put_model_here.txt)."""
    return [f for f in files if not _is_placeholder_model_file(os.path.basename(f))]


def _order_model_folders(folders: list) -> list:
    unique = sorted(set(folders))
    if "loras" in unique:
        return ["loras"] + [f for f in unique if f != "loras"]
    return unique


def _make_tree_node(node_id: str, label: str, node_type: str, selectable=False, default_checked=False, action=None, children=None):
    return {
        "id": node_id,
        "label": label,
        "node_type": node_type,
        "selectable": bool(selectable),
        "default_checked": bool(default_checked),
        "action": action,
        "children": children or []
    }


def _build_path_tree(side: str, base_path: str, rel_files: list, default_checked=False) -> list:
    """
    Build nested folder/file nodes from files relative to base_path.
    rel_files: list like ["a.txt", "dir/b.txt"].
    """
    tree = {"dirs": {}, "files": set()}
    for rel in rel_files:
        clean = _normalize_local_path(rel)
        if not clean:
            continue
        parts = clean.split("/")
        current = tree
        for idx, part in enumerate(parts):
            is_last = idx == len(parts) - 1
            if is_last:
                current["files"].add(part)
            else:
                current = current["dirs"].setdefault(part, {"dirs": {}, "files": set()})

    def recurse(branch: dict, current_path: str) -> list:
        nodes = []
        for dirname in sorted(branch["dirs"].keys()):
            folder_path = f"{current_path}/{dirname}" if current_path else dirname
            children = recurse(branch["dirs"][dirname], folder_path)
            nodes.append(_make_tree_node(
                node_id=f"{side}:folder:{folder_path}",
                label=dirname,
                node_type="folder",
                selectable=True,
                default_checked=default_checked,
                action={"kind": "path", "path": folder_path, "entry_type": "folder"},
                children=children
            ))
        for filename in sorted(branch["files"]):
            file_path = f"{current_path}/{filename}" if current_path else filename
            nodes.append(_make_tree_node(
                node_id=f"{side}:file:{file_path}",
                label=filename,
                node_type="file",
                selectable=True,
                default_checked=default_checked,
                action={"kind": "path", "path": file_path, "entry_type": "file"},
                children=[]
            ))
        return nodes

    return recurse(tree, _normalize_local_path(base_path))


def _empty_panel_structure(side: str) -> list:
    defaults = [
        ("Settings", False),
        ("Custom Nodes", side == "local"),
        ("Workflows", side == "local"),
        ("Subgraphs", side == "local"),
        ("Input", False),
        ("Output", False),
    ]
    return [
        _make_tree_node(
            node_id=f"{side}:category:{label.lower().replace(' ', '_')}",
            label=label,
            node_type="category",
            selectable=False,
            default_checked=checked,
            action=None,
            children=[]
        )
        for label, checked in defaults
    ]


def _safe_yaml_load(path: str):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _snapshot_file_key(entry) -> str:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, dict):
        if "path" in entry:
            return str(entry["path"])
        if "filename" in entry:
            return str(entry["filename"])
        if "name" in entry:
            return str(entry["name"])
        return json.dumps(entry, sort_keys=True)
    return str(entry)


def _snapshot_git_label(repo_url: str, node_data) -> str:
    if isinstance(node_data, dict):
        label = node_data.get("title") or node_data.get("name")
        if label:
            return str(label)
    cleaned = repo_url.rstrip("/").rsplit("/", 1)[-1]
    if cleaned.endswith(".git"):
        cleaned = cleaned[:-4]
    return cleaned or repo_url


def _extract_snapshot_entries(snapshot_data: dict) -> list:
    entries = []

    git_nodes = snapshot_data.get("git_custom_nodes", {}) or {}
    if isinstance(git_nodes, dict):
        for repo_url, node_data in git_nodes.items():
            entries.append({
                "node_type": "git",
                "key": str(repo_url),
                "label": _snapshot_git_label(str(repo_url), node_data)
            })

    cnr_nodes = snapshot_data.get("cnr_custom_nodes", {}) or {}
    if isinstance(cnr_nodes, dict):
        for node_name, version in cnr_nodes.items():
            label = str(node_name)
            if version not in (None, "", {}):
                label = f"{label} ({version})"
            entries.append({
                "node_type": "cnr",
                "key": str(node_name),
                "label": label
            })

    file_nodes = snapshot_data.get("file_custom_nodes", []) or []
    if isinstance(file_nodes, list):
        for entry in file_nodes:
            key = _snapshot_file_key(entry)
            label = os.path.basename(key) or key
            entries.append({
                "node_type": "file",
                "key": key,
                "label": label
            })

    entries.sort(key=lambda item: item["label"].lower())
    return entries


def _filter_snapshot_entries(snapshot_data: dict, selected_entries: set) -> dict:
    """
    Keep only selected custom-node entries from snapshot_data.
    selected_entries: set of tuples {(node_type, key), ...}
    """
    kept = copy.deepcopy(snapshot_data or {})
    kept.setdefault("comfyui", snapshot_data.get("comfyui", "") if isinstance(snapshot_data, dict) else "")
    kept.setdefault("pips", {})

    git_nodes = snapshot_data.get("git_custom_nodes", {}) if isinstance(snapshot_data, dict) else {}
    if isinstance(git_nodes, dict):
        kept["git_custom_nodes"] = {
            k: v for k, v in git_nodes.items()
            if ("git", str(k)) in selected_entries
        }
    else:
        kept["git_custom_nodes"] = {}

    cnr_nodes = snapshot_data.get("cnr_custom_nodes", {}) if isinstance(snapshot_data, dict) else {}
    if isinstance(cnr_nodes, dict):
        kept["cnr_custom_nodes"] = {
            k: v for k, v in cnr_nodes.items()
            if ("cnr", str(k)) in selected_entries
        }
    else:
        kept["cnr_custom_nodes"] = {}

    file_nodes = snapshot_data.get("file_custom_nodes", []) if isinstance(snapshot_data, dict) else []
    if isinstance(file_nodes, list):
        kept["file_custom_nodes"] = [
            entry for entry in file_nodes
            if ("file", _snapshot_file_key(entry)) in selected_entries
        ]
    else:
        kept["file_custom_nodes"] = []

    return kept


def _remove_snapshot_entries(snapshot_data: dict, removed_entries: set) -> dict:
    """Remove selected entries from snapshot_data."""
    existing = _extract_snapshot_entries(snapshot_data or {})
    keep_entries = {
        (entry["node_type"], entry["key"])
        for entry in existing
        if (entry["node_type"], entry["key"]) not in removed_entries
    }
    return _filter_snapshot_entries(snapshot_data, keep_entries)


def _snapshot_has_entries(snapshot_data: dict) -> bool:
    if not isinstance(snapshot_data, dict):
        return False
    if snapshot_data.get("git_custom_nodes"):
        return True
    if snapshot_data.get("cnr_custom_nodes"):
        return True
    if snapshot_data.get("file_custom_nodes"):
        return True
    return False


def _copy_settings_without_token(src_file: str, temp_dir: str) -> str:
    dst_file = os.path.join(temp_dir, os.path.basename(src_file))
    shutil.copy2(src_file, dst_file)
    try:
        with open(dst_file, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and "downloader.hf_token" in data:
            del data["downloader.hf_token"]
            with open(dst_file, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2)
    except Exception as e:
        print(f"[WARNING] Failed to sanitize settings file '{src_file}': {e}")
    return dst_file

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
    Also migrates ComfyUI-Manager legacy paths to the new structure.
    Returns the path to the copied folder.
    """
    dst_folder = os.path.join(temp_dir, os.path.basename(src_folder))
    shutil.copytree(src_folder, dst_folder)

    # Migrate legacy ComfyUI-Manager path if it exists:
    # user/default/ComfyUI-Manager -> user/__manager
    legacy_mgr = os.path.join(dst_folder, "default", "ComfyUI-Manager")
    new_mgr = os.path.join(dst_folder, "__manager")
    
    if os.path.exists(legacy_mgr):
        print(f"[INFO] Migrating legacy ComfyUI-Manager path in backup: {legacy_mgr} -> {new_mgr}")
        if os.path.exists(new_mgr):
             # If both exist, merge legacy into new (new takes precedence for conflicts)
             _safe_move_or_copy(legacy_mgr, new_mgr)
             shutil.rmtree(legacy_mgr)
        else:
             shutil.move(legacy_mgr, new_mgr)

        # Cleanup empty default folder if it was only holding ComfyUI-Manager
        default_dir = os.path.join(dst_folder, "default")
        if os.path.exists(default_dir) and not os.listdir(default_dir):
            os.rmdir(default_dir)

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

def _retry_upload(api, upload_path, repo_name, token, path_in_repo, ignore_patterns=None, max_retries=3, initial_delay=1):
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
                kwargs = {
                    "folder_path": upload_path,
                    "repo_id": repo_name,
                    "token": token,
                    "path_in_repo": path_in_repo
                }
                if ignore_patterns:
                    kwargs["ignore_patterns"] = ignore_patterns
                api.upload_folder(**kwargs)
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
                # Check new path first (v3.38+)
                original_snapshot = os.path.join(comfy_dir, "user", "__manager", "snapshots", snapshot_file_name)
                if not os.path.exists(original_snapshot):
                    # Check legacy path
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

    repo_name = _parse_repo_name(repo_name_or_link)

    temp_dirs = []
    moved_big_files = []
    try:
        total_folders = len([f for f in folders if f and os.path.exists(f.strip())])
        for i, folder in enumerate(folders, 1):
            folder = folder.strip()
            if not folder or not os.path.exists(folder):
                continue
            
            folder = os.path.normpath(folder)
            normalized_folder = _normalize_local_path(folder)
            is_user_dir = os.path.isdir(folder) and (
                folder == "user" or folder.startswith("user" + os.sep)
            )
            # Keep snapshot behavior for the custom_nodes root only.
            # Subfolders are uploaded as normal paths so users can select specific nodes.
            is_custom_nodes_root = normalized_folder == "custom_nodes"
            is_settings_file = os.path.isfile(folder) and _is_settings_file_path(folder)
            upload_path = folder
            temp_dir = None

            # Handle special cases: user folder and custom_nodes
            if is_user_dir:
                temp_dir = tempfile.mkdtemp(prefix="comfyui_user_strip_")
                upload_path = _copy_and_strip_token(folder, temp_dir)
                temp_dirs.append(temp_dir)
                print(f"[INFO] Created sanitized copy of '{folder}' at '{upload_path}' for upload.")
            elif is_custom_nodes_root:
                # Create snapshot using comfy-cli
                snapshot_file, temp_dir = _backup_custom_nodes(folder)
                temp_dirs.append(temp_dir)
                path_in_repo = CUSTOM_NODES_SNAPSHOT_PATH
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
            elif is_settings_file:
                temp_dir = tempfile.mkdtemp(prefix="comfyui_settings_strip_")
                upload_path = _copy_settings_without_token(folder, temp_dir)
                temp_dirs.append(temp_dir)
                print(f"[INFO] Created sanitized settings copy at '{upload_path}' for upload.")

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
    import requests.exceptions
    from collections import defaultdict
    from .downloader import clear_cache_for_path

    os.environ.setdefault("HF_HUB_ENABLE_HF_XET", "1")
    
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
                            
                            # Remap legacy ComfyUI-Manager path to new path
                            # user/default/ComfyUI-Manager/... -> user/__manager/...
                            if "user/default/ComfyUI-Manager/" in rel_path:
                                new_rel_path = rel_path.replace("user/default/ComfyUI-Manager/", "user/__manager/")
                                print(f"[INFO] in-flight migration: {rel_path} -> {new_rel_path}")
                                rel_path = new_rel_path

                            src_file = os.path.join(source_dir, f.split("ComfyUI/", 1)[1]) # src is still the downloaded path
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
                            # process_structure will handle individual files, so we don't strictly need to create dirs here
                            # but keeping the recursion structure
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


def _build_local_panel_nodes() -> list:
    nodes = []

    settings_path = "user/default/comfy.settings.json"
    settings_exists = _settings_file_exists(settings_path)
    nodes.append(_make_tree_node(
        node_id="local:category:settings",
        label="Settings",
        node_type="category",
        selectable=settings_exists,
        default_checked=settings_exists,
        action={"kind": "path", "path": settings_path, "entry_type": "file"} if settings_exists else None,
        children=[]
    ))

    workflows_base = "user/default/workflows"
    workflows_dir_exists = os.path.isdir(_to_os_path(workflows_base))
    workflow_files = _get_local_files(workflows_base)
    workflow_prefix = f"{workflows_base}/"
    workflow_rel = [
        f[len(workflow_prefix):]
        for f in workflow_files
        if f.startswith(workflow_prefix)
    ]
    workflow_rel = [f for f in workflow_rel if not f.startswith(".subgraphs/")]
    workflow_children = _build_path_tree("local", workflows_base, workflow_rel)
    nodes.append(_make_tree_node(
        node_id="local:category:workflows",
        label="Workflows",
        node_type="category",
        selectable=workflows_dir_exists,
        default_checked=workflows_dir_exists,
        action={"kind": "path", "path": workflows_base, "entry_type": "folder"} if workflows_dir_exists else None,
        children=workflow_children
    ))

    existing_subgraph_roots = [p for p in LOCAL_SUBGRAPH_PATHS if os.path.isdir(_to_os_path(p))]
    subgraph_roots = existing_subgraph_roots or [LOCAL_SUBGRAPH_PATHS[0]]
    subgraph_children = []
    if len(subgraph_roots) == 1:
        base = subgraph_roots[0]
        files = _get_local_files(base)
        prefix = f"{base}/"
        rel = [f[len(prefix):] for f in files if f.startswith(prefix)]
        subgraph_children = _build_path_tree("local", base, rel)
    else:
        for base in subgraph_roots:
            files = _get_local_files(base)
            prefix = f"{base}/"
            rel = [f[len(prefix):] for f in files if f.startswith(prefix)]
            children = _build_path_tree("local", base, rel)
            label = ".subgraphs" if base.endswith(".subgraphs") else os.path.basename(base)
            subgraph_children.append(_make_tree_node(
                node_id=f"local:folder:{base}",
                label=label,
                node_type="folder",
                selectable=True,
                default_checked=False,
                action={"kind": "path", "path": base, "entry_type": "folder"},
                children=children
            ))

    subgraphs_selectable = bool(existing_subgraph_roots)
    subgraphs_action = None
    if subgraphs_selectable:
        if len(existing_subgraph_roots) == 1:
            subgraphs_action = {"kind": "path", "path": existing_subgraph_roots[0], "entry_type": "folder"}
        else:
            subgraphs_action = {"kind": "paths", "paths": existing_subgraph_roots, "entry_type": "folder"}
    nodes.append(_make_tree_node(
        node_id="local:category:subgraphs",
        label="Subgraphs",
        node_type="category",
        selectable=subgraphs_selectable,
        default_checked=subgraphs_selectable,
        action=subgraphs_action,
        children=subgraph_children
    ))

    for category_label, base in (("Input", "input"), ("Output", "output")):
        exists = os.path.isdir(_to_os_path(base))
        files = _get_local_files(base)
        prefix = f"{base}/"
        rel = [f[len(prefix):] for f in files if f.startswith(prefix)]
        children = _build_path_tree("local", base, rel)
        nodes.append(_make_tree_node(
            node_id=f"local:category:{category_label.lower()}",
            label=category_label,
            node_type="category",
            selectable=exists,
            default_checked=False,
            action={"kind": "path", "path": base, "entry_type": "folder"} if exists else None,
            children=children
        ))

    custom_nodes_dir = _to_os_path("custom_nodes")
    custom_nodes_exists = os.path.isdir(custom_nodes_dir)
    custom_nodes_children = []
    if custom_nodes_exists:
        names = []
        for name in os.listdir(custom_nodes_dir):
            full = os.path.join(custom_nodes_dir, name)
            if not os.path.isdir(full):
                continue
            if name.startswith(".") or name in ("__pycache__",):
                continue
            names.append(name)
        for name in sorted(names):
            node_path = f"custom_nodes/{name}"
            custom_nodes_children.append(_make_tree_node(
                node_id=f"local:custom-node:{node_path}",
                label=name,
                node_type="custom_node",
                selectable=True,
                default_checked=False,
                action={"kind": "path", "path": node_path, "entry_type": "folder"},
                children=[]
            ))

    nodes.insert(1, _make_tree_node(
        node_id="local:category:custom_nodes",
        label="Custom Nodes",
        node_type="category",
        selectable=custom_nodes_exists,
        default_checked=custom_nodes_exists,
        action={"kind": "local_custom_nodes_all"} if custom_nodes_exists else None,
        children=custom_nodes_children
    ))

    models_root = _to_os_path("models")
    model_dirs = []
    if os.path.isdir(models_root):
        for name in os.listdir(models_root):
            full = os.path.join(models_root, name)
            if os.path.isdir(full):
                model_dirs.append(name)

    for folder in _order_model_folders(model_dirs):
        base = f"models/{folder}"
        files = _get_local_files(base)
        prefix = f"{base}/"
        rel = [f[len(prefix):] for f in files if f.startswith(prefix)]
        rel = _filter_real_model_files(rel)
        if not rel:
            continue
        nodes.append(_make_tree_node(
            node_id=f"local:category:model:{folder}",
            label=folder,
            node_type="category",
            selectable=True,
            default_checked=(folder == "loras"),
            action={"kind": "path", "path": base, "entry_type": "folder"},
            children=_build_path_tree("local", base, rel)
        ))

    return nodes


def _build_backup_panel_nodes(repo_name: str, token: str, comfy_files: list) -> list:
    from huggingface_hub import hf_hub_download

    nodes = []
    comfy_set = set(comfy_files)

    settings_repo_path = "ComfyUI/user/default/comfy.settings.json"
    settings_exists = settings_repo_path in comfy_set
    nodes.append(_make_tree_node(
        node_id="backup:category:settings",
        label="Settings",
        node_type="category",
        selectable=settings_exists,
        default_checked=False,
        action={"kind": "path", "path": settings_repo_path, "entry_type": "file"} if settings_exists else None,
        children=[]
    ))

    workflows_base = "ComfyUI/user/default/workflows"
    workflow_prefix = f"{workflows_base}/"
    workflow_rel = [
        path[len(workflow_prefix):]
        for path in comfy_files
        if path.startswith(workflow_prefix) and not path.startswith(f"{workflow_prefix}.subgraphs/")
    ]
    nodes.append(_make_tree_node(
        node_id="backup:category:workflows",
        label="Workflows",
        node_type="category",
        selectable=bool(workflow_rel),
        default_checked=False,
        action={"kind": "path", "path": workflows_base, "entry_type": "folder"} if workflow_rel else None,
        children=_build_path_tree("backup", workflows_base, workflow_rel)
    ))

    existing_subgraph_roots = []
    for base in REPO_SUBGRAPH_PATHS:
        prefix = f"{base}/"
        if any(path.startswith(prefix) for path in comfy_files):
            existing_subgraph_roots.append(base)

    subgraph_roots = existing_subgraph_roots or [REPO_SUBGRAPH_PATHS[0]]
    subgraph_children = []
    if len(subgraph_roots) == 1:
        base = subgraph_roots[0]
        prefix = f"{base}/"
        rel = [path[len(prefix):] for path in comfy_files if path.startswith(prefix)]
        subgraph_children = _build_path_tree("backup", base, rel)
    else:
        for base in subgraph_roots:
            prefix = f"{base}/"
            rel = [path[len(prefix):] for path in comfy_files if path.startswith(prefix)]
            children = _build_path_tree("backup", base, rel)
            label = ".subgraphs" if base.endswith(".subgraphs") else os.path.basename(base)
            subgraph_children.append(_make_tree_node(
                node_id=f"backup:folder:{base}",
                label=label,
                node_type="folder",
                selectable=True,
                default_checked=False,
                action={"kind": "path", "path": base, "entry_type": "folder"},
                children=children
            ))

    subgraphs_selectable = bool(existing_subgraph_roots)
    subgraphs_action = None
    if subgraphs_selectable:
        if len(existing_subgraph_roots) == 1:
            subgraphs_action = {"kind": "path", "path": existing_subgraph_roots[0], "entry_type": "folder"}
        else:
            subgraphs_action = {"kind": "paths", "paths": existing_subgraph_roots, "entry_type": "folder"}
    nodes.append(_make_tree_node(
        node_id="backup:category:subgraphs",
        label="Subgraphs",
        node_type="category",
        selectable=subgraphs_selectable,
        default_checked=False,
        action=subgraphs_action,
        children=subgraph_children
    ))

    for category_label, base in (("Input", "ComfyUI/input"), ("Output", "ComfyUI/output")):
        prefix = f"{base}/"
        rel = [path[len(prefix):] for path in comfy_files if path.startswith(prefix)]
        nodes.append(_make_tree_node(
            node_id=f"backup:category:{category_label.lower()}",
            label=category_label,
            node_type="category",
            selectable=bool(rel),
            default_checked=False,
            action={"kind": "path", "path": base, "entry_type": "folder"} if rel else None,
            children=_build_path_tree("backup", base, rel)
        ))

    custom_children = []
    snapshot_exists = CUSTOM_NODES_SNAPSHOT_PATH in comfy_set
    if snapshot_exists:
        try:
            snapshot_file = hf_hub_download(
                repo_id=repo_name,
                filename=CUSTOM_NODES_SNAPSHOT_PATH,
                token=token
            )
            snapshot_data = _safe_yaml_load(snapshot_file)
            snapshot_entries = _extract_snapshot_entries(snapshot_data)
            for entry in snapshot_entries:
                custom_children.append(_make_tree_node(
                    node_id=f"backup:snapshot-node:{entry['node_type']}:{entry['key']}",
                    label=entry["label"],
                    node_type="custom_node",
                    selectable=True,
                    default_checked=False,
                    action={
                        "kind": "snapshot_custom_node",
                        "node_type": entry["node_type"],
                        "key": entry["key"]
                    },
                    children=[]
                ))
        except Exception as e:
            print(f"[WARNING] Failed to parse custom_nodes snapshot: {e}")

    custom_prefix = "ComfyUI/custom_nodes/"
    custom_dirs = set()
    custom_root_files = set()
    for path in comfy_files:
        if not path.startswith(custom_prefix):
            continue
        rel = path[len(custom_prefix):]
        if not rel:
            continue
        if "/" in rel:
            custom_dirs.add(rel.split("/", 1)[0])
        else:
            custom_root_files.add(rel)

    for dirname in sorted(custom_dirs):
        node_path = f"ComfyUI/custom_nodes/{dirname}"
        custom_children.append(_make_tree_node(
            node_id=f"backup:custom-node-path:{node_path}",
            label=dirname,
            node_type="custom_node",
            selectable=True,
            default_checked=False,
            action={"kind": "path", "path": node_path, "entry_type": "folder"},
            children=[]
        ))

    for filename in sorted(custom_root_files):
        node_path = f"ComfyUI/custom_nodes/{filename}"
        custom_children.append(_make_tree_node(
            node_id=f"backup:file:{node_path}",
            label=filename,
            node_type="file",
            selectable=True,
            default_checked=False,
            action={"kind": "path", "path": node_path, "entry_type": "file"},
            children=[]
        ))

    nodes.insert(1, _make_tree_node(
        node_id="backup:category:custom_nodes",
        label="Custom Nodes",
        node_type="category",
        selectable=bool(snapshot_exists or custom_dirs or custom_root_files),
        default_checked=False,
        action={"kind": "custom_nodes_all"} if (snapshot_exists or custom_dirs or custom_root_files) else None,
        children=custom_children
    ))

    model_map = {}
    model_prefix = "ComfyUI/models/"
    for path in comfy_files:
        if not path.startswith(model_prefix):
            continue
        rel = path[len(model_prefix):]
        if "/" not in rel:
            continue
        folder, file_rel = rel.split("/", 1)
        model_map.setdefault(folder, []).append(file_rel)

    for folder in _order_model_folders(list(model_map.keys())):
        rel_files = _filter_real_model_files(model_map.get(folder, []))
        if not rel_files:
            continue
        base = f"ComfyUI/models/{folder}"
        nodes.append(_make_tree_node(
            node_id=f"backup:category:model:{folder}",
            label=folder,
            node_type="category",
            selectable=True,
            default_checked=False,
            action={"kind": "path", "path": base, "entry_type": "folder"},
            children=_build_path_tree("backup", base, rel_files)
        ))

    return nodes


def get_backup_browser_tree(repo_name_or_link: str) -> dict:
    local_nodes = _build_local_panel_nodes()
    backup_nodes = _empty_panel_structure("backup")
    backup_total_size_bytes = None

    if not repo_name_or_link:
        return {
            "local": local_nodes,
            "backup": backup_nodes,
            "backup_error": "No backup repository configured in settings.",
            "repo_name": "",
            "backup_total_size_bytes": backup_total_size_bytes,
        }

    token, _ = get_token_and_size_limit()
    if not token:
        return {
            "local": local_nodes,
            "backup": backup_nodes,
            "backup_error": "No Hugging Face token configured.",
            "repo_name": repo_name_or_link,
            "backup_total_size_bytes": backup_total_size_bytes,
        }

    try:
        repo_name = _parse_repo_name(repo_name_or_link)
    except Exception:
        repo_name = repo_name_or_link

    try:
        api = HfApi()
        comfy_files = []
        siblings = None
        try:
            try:
                repo_info = api.repo_info(repo_id=repo_name, token=token, files_metadata=True)
            except TypeError:
                repo_info = api.repo_info(repo_id=repo_name, token=token)
            siblings = getattr(repo_info, "siblings", None)
        except Exception as e:
            print(f"[WARNING] Could not fetch repo metadata for size info: {e}")

        if siblings:
            size_acc = 0
            has_size_data = False
            for sibling in siblings:
                if isinstance(sibling, dict):
                    rfilename = sibling.get("rfilename", "")
                    size = sibling.get("size")
                else:
                    rfilename = getattr(sibling, "rfilename", "") or ""
                    size = getattr(sibling, "size", None)
                if not rfilename.startswith("ComfyUI/"):
                    continue
                comfy_files.append(rfilename)
                if isinstance(size, (int, float)):
                    size_acc += int(size)
                    has_size_data = True
            comfy_files = sorted(set(comfy_files))
            if has_size_data:
                backup_total_size_bytes = size_acc

        if not comfy_files:
            repo_files = api.list_repo_files(repo_id=repo_name, token=token)
            comfy_files = sorted([path for path in repo_files if path.startswith("ComfyUI/")])

        backup_nodes = _build_backup_panel_nodes(repo_name, token, comfy_files)
        return {
            "local": local_nodes,
            "backup": backup_nodes,
            "backup_error": None,
            "repo_name": repo_name,
            "backup_total_size_bytes": backup_total_size_bytes,
        }
    except Exception as e:
        return {
            "local": local_nodes,
            "backup": backup_nodes,
            "backup_error": str(e),
            "repo_name": repo_name,
            "backup_total_size_bytes": backup_total_size_bytes,
        }


def _expand_repo_files_by_path(repo_files: list, path: str, entry_type: str = None) -> list:
    normalized_path = _normalize_repo_path(path)
    repo_set = set(repo_files)
    if entry_type == "file":
        return [normalized_path] if normalized_path in repo_set else []

    prefix = f"{normalized_path.rstrip('/')}/"
    matches = [item for item in repo_files if item == normalized_path or item.startswith(prefix)]
    return matches


def _collapse_paths(paths: list) -> list:
    collapsed = []
    for path in sorted(set(paths), key=lambda p: (p.count("/"), p)):
        if any(path == kept or path.startswith(f"{kept}/") for kept in collapsed):
            continue
        collapsed.append(path)
    return collapsed


def _path_has_uploadable_content(path: str) -> bool:
    os_path = _to_os_path(path)
    if os.path.isfile(os_path):
        return True
    if not os.path.isdir(os_path):
        return False
    for _, _, files in os.walk(os_path):
        if files:
            return True
    return False


def _copy_repo_file_to_target(src_file: str, repo_file: str, target_dir: str, token: str):
    rel_path = repo_file.split("ComfyUI/", 1)[1] if repo_file.startswith("ComfyUI/") else repo_file
    rel_path = rel_path.replace("\\", "/")

    if "user/default/ComfyUI-Manager/" in rel_path:
        rel_path = rel_path.replace("user/default/ComfyUI-Manager/", "user/__manager/")

    dst_file = os.path.join(target_dir, rel_path)
    os.makedirs(os.path.dirname(dst_file), exist_ok=True)

    if rel_path == "user/default/comfy.settings.json":
        existing_settings = {}
        if os.path.exists(dst_file):
            try:
                with open(dst_file, "r", encoding="utf-8") as handle:
                    existing_settings = json.load(handle)
            except Exception:
                existing_settings = {}
        with open(src_file, "r", encoding="utf-8") as handle:
            new_settings = json.load(handle)
        if isinstance(existing_settings, dict) and "downloader.hf_token" in existing_settings:
            new_settings["downloader.hf_token"] = existing_settings["downloader.hf_token"]
        else:
            new_settings["downloader.hf_token"] = token
        with open(dst_file, "w", encoding="utf-8") as handle:
            json.dump(new_settings, handle, indent=2)
        return

    shutil.copy2(src_file, dst_file)


def restore_selected_from_huggingface(repo_name_or_link: str, selections: list, target_dir=None) -> dict:
    from huggingface_hub import hf_hub_download

    token, _ = get_token_and_size_limit()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    repo_name = _parse_repo_name(repo_name_or_link)
    if target_dir is None:
        target_dir = os.getcwd()

    api = HfApi()
    repo_files = api.list_repo_files(repo_id=repo_name, token=token)
    comfy_files = sorted([path for path in repo_files if path.startswith("ComfyUI/")])
    comfy_set = set(comfy_files)

    files_to_restore = set()
    snapshot_entries = set()
    restore_all_custom_nodes = False

    for item in selections or []:
        kind = (item or {}).get("kind")
        if kind == "path":
            files_to_restore.update(_expand_repo_files_by_path(
                comfy_files,
                item.get("path", ""),
                item.get("entry_type")
            ))
        elif kind == "paths":
            for path in item.get("paths", []) or []:
                files_to_restore.update(_expand_repo_files_by_path(
                    comfy_files,
                    path,
                    item.get("entry_type")
                ))
        elif kind == "snapshot_custom_node":
            node_type = str(item.get("node_type", "")).strip()
            key = str(item.get("key", "")).strip()
            if node_type and key:
                snapshot_entries.add((node_type, key))
        elif kind == "custom_nodes_all":
            restore_all_custom_nodes = True
            files_to_restore.update(_expand_repo_files_by_path(
                comfy_files,
                "ComfyUI/custom_nodes",
                "folder"
            ))

    restored_custom_nodes = 0
    restart_required = False

    if (restore_all_custom_nodes or snapshot_entries) and CUSTOM_NODES_SNAPSHOT_PATH in comfy_set:
        snapshot_file = hf_hub_download(
            repo_id=repo_name,
            filename=CUSTOM_NODES_SNAPSHOT_PATH,
            token=token
        )
        snapshot_data = _safe_yaml_load(snapshot_file)
        if restore_all_custom_nodes:
            _restore_custom_nodes_from_snapshot(snapshot_file)
            restored_custom_nodes = len(_extract_snapshot_entries(snapshot_data))
            restart_required = restart_required or restored_custom_nodes > 0
        elif snapshot_entries:
            filtered = _filter_snapshot_entries(snapshot_data, snapshot_entries)
            if _snapshot_has_entries(filtered):
                temp_dir = tempfile.mkdtemp(prefix="hf_restore_custom_nodes_")
                try:
                    filtered_file = os.path.join(temp_dir, "custom_nodes_snapshot.yaml")
                    with open(filtered_file, "w", encoding="utf-8") as handle:
                        yaml.safe_dump(filtered, handle, sort_keys=False, allow_unicode=True, default_flow_style=False)
                    _restore_custom_nodes_from_snapshot(filtered_file)
                    restored_custom_nodes = len(_extract_snapshot_entries(filtered))
                    restart_required = restart_required or restored_custom_nodes > 0
                finally:
                    shutil.rmtree(temp_dir, ignore_errors=True)

    files_to_restore.discard(CUSTOM_NODES_SNAPSHOT_PATH)
    restored_files = 0
    for repo_file in sorted(files_to_restore):
        cached_file = hf_hub_download(
            repo_id=repo_name,
            filename=repo_file,
            token=token
        )
        _copy_repo_file_to_target(cached_file, repo_file, target_dir, token)
        restored_files += 1
        if repo_file.startswith("ComfyUI/custom_nodes/"):
            restart_required = True

    return {
        "restored_files": restored_files,
        "restored_custom_nodes": restored_custom_nodes,
        "restart_required": bool(restart_required),
        "target_dir": target_dir
    }


def _delete_repo_files(api: HfApi, repo_name: str, token: str, files: list) -> int:
    files = sorted(set(files))
    if not files:
        return 0

    try:
        from huggingface_hub import CommitOperationDelete
        operations = [CommitOperationDelete(path_in_repo=path) for path in files]
        api.create_commit(
            repo_id=repo_name,
            operations=operations,
            commit_message=f"Delete {len(files)} backup item(s)",
            token=token
        )
        return len(files)
    except Exception as e:
        print(f"[WARNING] Batch delete unavailable, falling back to per-file delete: {e}")

    deleted = 0
    for path in files:
        api.delete_file(
            path_in_repo=path,
            repo_id=repo_name,
            token=token,
            commit_message=f"Delete {path}"
        )
        deleted += 1
    return deleted


def delete_selected_from_huggingface(repo_name_or_link: str, selections: list) -> dict:
    from huggingface_hub import hf_hub_download

    token, _ = get_token_and_size_limit()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    repo_name = _parse_repo_name(repo_name_or_link)
    api = HfApi()
    repo_files = api.list_repo_files(repo_id=repo_name, token=token)
    comfy_files = sorted([path for path in repo_files if path.startswith("ComfyUI/")])
    comfy_set = set(comfy_files)

    files_to_delete = set()
    snapshot_entries_to_remove = set()
    delete_all_custom_nodes = False

    for item in selections or []:
        kind = (item or {}).get("kind")
        if kind == "path":
            files_to_delete.update(_expand_repo_files_by_path(
                comfy_files,
                item.get("path", ""),
                item.get("entry_type")
            ))
        elif kind == "paths":
            for path in item.get("paths", []) or []:
                files_to_delete.update(_expand_repo_files_by_path(
                    comfy_files,
                    path,
                    item.get("entry_type")
                ))
        elif kind == "snapshot_custom_node":
            node_type = str(item.get("node_type", "")).strip()
            key = str(item.get("key", "")).strip()
            if node_type and key:
                snapshot_entries_to_remove.add((node_type, key))
        elif kind == "custom_nodes_all":
            delete_all_custom_nodes = True
            files_to_delete.update(_expand_repo_files_by_path(
                comfy_files,
                "ComfyUI/custom_nodes",
                "folder"
            ))
            if CUSTOM_NODES_SNAPSHOT_PATH in comfy_set:
                files_to_delete.add(CUSTOM_NODES_SNAPSHOT_PATH)

    removed_snapshot_nodes = 0
    snapshot_updated = False
    if snapshot_entries_to_remove and not delete_all_custom_nodes and CUSTOM_NODES_SNAPSHOT_PATH in comfy_set:
        snapshot_file = hf_hub_download(
            repo_id=repo_name,
            filename=CUSTOM_NODES_SNAPSHOT_PATH,
            token=token
        )
        snapshot_data = _safe_yaml_load(snapshot_file)
        existing_entries = {
            (entry["node_type"], entry["key"])
            for entry in _extract_snapshot_entries(snapshot_data)
        }
        removed_snapshot_nodes = len(existing_entries.intersection(snapshot_entries_to_remove))
        updated_snapshot = _remove_snapshot_entries(snapshot_data, snapshot_entries_to_remove)
        if _snapshot_has_entries(updated_snapshot):
            temp_dir = tempfile.mkdtemp(prefix="hf_update_snapshot_")
            try:
                updated_file = os.path.join(temp_dir, "custom_nodes_snapshot.yaml")
                with open(updated_file, "w", encoding="utf-8") as handle:
                    yaml.safe_dump(updated_snapshot, handle, sort_keys=False, allow_unicode=True, default_flow_style=False)
                api.upload_file(
                    path_or_fileobj=updated_file,
                    path_in_repo=CUSTOM_NODES_SNAPSHOT_PATH,
                    repo_id=repo_name,
                    token=token
                )
                snapshot_updated = True
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)
        else:
            files_to_delete.add(CUSTOM_NODES_SNAPSHOT_PATH)

    existing_files_to_delete = [path for path in files_to_delete if path in comfy_set]
    deleted_files = _delete_repo_files(api, repo_name, token, existing_files_to_delete)

    return {
        "deleted_files": deleted_files,
        "removed_snapshot_nodes": removed_snapshot_nodes,
        "snapshot_updated": snapshot_updated
    }


def backup_selected_to_huggingface(repo_name_or_link: str, selections: list, size_limit_gb=None) -> dict:
    paths = []
    include_all_custom_nodes = False

    for item in selections or []:
        kind = (item or {}).get("kind")
        if kind == "path":
            path = _normalize_local_path(item.get("path", ""))
            if path.startswith("ComfyUI/"):
                path = path.split("ComfyUI/", 1)[1]
            if path:
                paths.append(path)
        elif kind == "paths":
            for path in item.get("paths", []) or []:
                clean = _normalize_local_path(path)
                if clean.startswith("ComfyUI/"):
                    clean = clean.split("ComfyUI/", 1)[1]
                if clean:
                    paths.append(clean)
        elif kind == "local_custom_nodes_all":
            include_all_custom_nodes = True

    if include_all_custom_nodes:
        paths.append("custom_nodes")

    collapsed = _collapse_paths(paths)
    existing = []
    for path in collapsed:
        if _path_has_uploadable_content(path):
            existing.append(path)

    if not existing:
        raise ValueError("No valid local selections to backup.")

    backup_to_huggingface(
        repo_name_or_link=repo_name_or_link,
        folders=existing,
        size_limit_gb=size_limit_gb
    )

    return {
        "uploaded_paths": existing,
        "uploaded_count": len(existing)
    }
