import os
import sys
import shutil
import time
import requests
import tempfile
import threading

# Always enable fast Rust-based hf_transfer if installed
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
# Do not override global HF_HOME; it will use the global value or the default (e.g. ~/.cache/huggingface/hub)

from huggingface_hub import snapshot_download, hf_hub_download

def folder_size(directory):
    total = 0
    for (dirpath, dirnames, filenames) in os.walk(directory):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try:
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
            except Exception as e:
                print("[DEBUG] Error reading file", fp, e)
                pass
    return total

def traverse_subfolders(root_folder: str, segments: list[str]) -> str:
    """
    For each segment in 'segments' (e.g. ["transformer.opt", "fp4"]),
    search for a subfolder with that exact name, ignoring .cache.
    If not found, stop early and return the current path.
    """
    current = root_folder
    for seg in segments:
        found_sub = False
        for item in os.listdir(current):
            if item == ".cache":
                continue
            subpath = os.path.join(current, item)
            if os.path.isdir(subpath) and item == seg:
                current = subpath
                found_sub = True
                break
        if not found_sub:
            break
    return current

def run_download(parsed_data: dict,
                 final_folder: str,
                 token: str = "",
                 sync: bool = False) -> tuple[str, str]:
    """
    Single-file approach using hf_hub_download – using global HF_HOME.
    The file is copied to models/<final_folder> and then removed from cache to free space.
    """
    print("[DEBUG] run_download (single-file) started.")
    target_path = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(target_path, exist_ok=True)

    # Build remote filename from subfolder + file
    if "file" in parsed_data:
        file_name = parsed_data["file"].strip("/")
        sub = parsed_data.get("subfolder", "").strip("/")
        remote_filename = os.path.join(sub, file_name) if sub else file_name
    else:
        remote_filename = "unknown.bin"

    local_filename = os.path.basename(remote_filename)
    dest_path = os.path.join(target_path, local_filename)
    print("[DEBUG] Single-file final dest:", dest_path)

    if os.path.exists(dest_path):
        try:
            fs = os.path.getsize(dest_path)
            fg = fs / (1024 ** 3)
        except Exception as e:
            print("[DEBUG] Error getting size of existing file:", e)
            fg = 0
        final_message = f"{local_filename} already exists | {fg:.3f} GB"
        print("[DEBUG]", final_message)
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("huggingface.download.complete",
                                            {"message": final_message,
                                             "local_path": dest_path,
                                             "no_popup": True})
        except Exception as e:
            print("[DEBUG] Error sending complete message:", e)
        if sync:
            return final_message, dest_path
        return "", ""

    try:
        repo_id = parsed_data["repo"]
        revision = parsed_data.get("revision", None)
        # hf_hub_download uses global HF_HOME now
        file_path_in_cache = hf_hub_download(
            repo_id=repo_id,
            filename=remote_filename,
            revision=revision,
            token=token if token else None
        )
        print("[DEBUG] hf_hub_download returned:", file_path_in_cache)

        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        shutil.copyfile(file_path_in_cache, dest_path)
        
        # Attempt to delete the cached file to free up space.
        try:
            os.remove(file_path_in_cache)
            print("[DEBUG] Removed cached file:", file_path_in_cache)
        except Exception as e:
            print("[DEBUG] Error removing cached file:", file_path_in_cache, e)

        fs = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
        fg = fs / (1024 ** 3)
        final_message = f"File downloaded successfully: {local_filename} | {fg:.3f} GB"
        print("[DEBUG]", final_message)
    except Exception as e:
        final_message = f"Download failed: {e}"
        print("[DEBUG]", final_message)

    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress": 100})
        PromptServer.instance.send_sync("huggingface.download.complete",
                                        {"message": final_message,
                                         "local_path": dest_path})
    except Exception as e:
        print("[DEBUG] Error notifying UI:", e)

    if sync:
        return final_message, dest_path
    return "", ""

def run_download_folder(parsed_data: dict,
                        final_folder: str,
                        token: str = "",
                        remote_subfolder_path: str = "",
                        last_segment: str = "",
                        sync: bool = False):
    """
    Partial subfolder approach using snapshot_download (with global HF_HOME).
    After the snapshot download, files are copied (or moved) to models/<final_folder> and then
    the downloaded snapshot folder is removed to free up space.
    """
    print("[DEBUG] run_download_folder started (folder).")
    base_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(base_dir, exist_ok=True)
    # Append last_segment to destination folder if provided.
    dest_path = os.path.join(base_dir, last_segment) if last_segment else base_dir
    print("[DEBUG] Folder final dest =>", dest_path)

    if os.path.exists(dest_path) and os.listdir(dest_path):
        fz = folder_size(dest_path)
        fg = fz / (1024 ** 3)
        final_message = f"{os.path.basename(dest_path)} already exists | {fg:.3f} GB"
        print("[DEBUG]", final_message)
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("huggingface.download.complete",
                                            {"message": final_message,
                                             "local_path": dest_path,
                                             "no_popup": True})
        except Exception as e:
            print("[DEBUG] Error notifying UI:", e)
        if sync:
            return final_message, dest_path
        return "", ""

    # No longer creating a temporary directory – using global HF_HOME cache.
    allow_patterns = None
    if remote_subfolder_path:
        allow_patterns = [f"{remote_subfolder_path}/**"]
    print("[DEBUG] allow_patterns =>", allow_patterns)

    repo_id = parsed_data["repo"]
    revision = parsed_data.get("revision", None)
    # Do NOT set local_dir – let snapshot_download use the global HF_HOME.
    kwargs = {
        "repo_id": repo_id,
        "token": token if token else None,
    }
    if revision:
        kwargs["revision"] = revision
    if allow_patterns:
        kwargs["allow_patterns"] = allow_patterns

    progress_event = threading.Event()
    last_percent = -1
    final_total = 0

    def folder_monitor():
        nonlocal final_total, last_percent
        print("[DEBUG] Folder monitor on snapshot download")
        while not progress_event.is_set():
            current_size = folder_size(downloaded_folder)
            pct = (current_size / final_total * 100) if final_total > 0 else 0
            ip = int(pct)
            if ip > last_percent:
                sys.stdout.write(f"\r[DEBUG] [Folder Monitor] {ip}%")
                sys.stdout.flush()
                last_percent = ip
                try:
                    from server import PromptServer
                    PromptServer.instance.send_sync("huggingface.download.progress", {"progress": ip})
                except Exception as e:
                    print("[DEBUG] Error notifying UI from folder monitor:", e)
            time.sleep(1)
        print()

    # Start a background thread to monitor progress.
    threading.Thread(target=folder_monitor, daemon=True).start()

    start_t = time.time()
    final_message = "Download failed???"
    try:
        print("[DEBUG] Starting snapshot_download (using global cache).")
        downloaded_folder = snapshot_download(**kwargs)
        print("[DEBUG] snapshot_download returned:", downloaded_folder)
        final_total = folder_size(downloaded_folder)
        print("[DEBUG] final_total size:", final_total)
    except Exception as e:
        final_message = f"Download failed: {e}"
        print("[DEBUG]", final_message)
    else:
        # Find the subfolder inside the downloaded snapshot if remote_subfolder_path is provided.
        segments = remote_subfolder_path.split("/") if remote_subfolder_path else []
        source_folder = traverse_subfolders(downloaded_folder, segments)
        print("[DEBUG] final source folder =>", source_folder)
        os.makedirs(dest_path, exist_ok=True)
        for item in os.listdir(source_folder):
            if item == ".cache":
                continue
            s = os.path.join(source_folder, item)
            d = os.path.join(dest_path, item)
            # If it's a symlink, resolve it and copy the actual file
            if os.path.islink(s):
                real_path = os.path.realpath(s)
                shutil.copy2(real_path, d)
                try:
                    os.remove(s)
                    print("[DEBUG] Removed symlink:", s)
                except Exception as e:
                    print("[DEBUG] Error removing symlink:", s, e)
            else:
                # Move file or directory and then remove the original to free up space.
                if os.path.isdir(s):
                    shutil.copytree(s, d)
                    shutil.rmtree(s, ignore_errors=True)
                else:
                    shutil.copy2(s, d)
                    try:
                        os.remove(s)
                    except Exception as e:
                        print("[DEBUG] Error removing file:", s, e)
        elap = time.time() - start_t
        fsz = folder_size(dest_path)
        fgb = fsz / (1024 ** 3)
        final_message = f"Folder downloaded successfully: {os.path.basename(dest_path)} | {fgb:.3f} GB | {elap:.1f} sec"
        print("[DEBUG]", final_message)

    progress_event.set()
    # After copying, attempt to delete the entire downloaded snapshot folder to reclaim space.
    try:
        shutil.rmtree(downloaded_folder, ignore_errors=True)
        print("[DEBUG] Removed downloaded snapshot folder:", downloaded_folder)
    except Exception as e:
        print("[DEBUG] Error removing downloaded folder:", downloaded_folder, e)

    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress": 100})
        PromptServer.instance.send_sync("huggingface.download.complete",
                                        {"message": final_message, "local_path": dest_path})
    except Exception as e:
        print("[DEBUG] Error notifying UI after folder download:", e)

    if sync:
        return final_message, dest_path
    return "", ""
