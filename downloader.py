import os
import sys
import shutil
import time
import requests
import tempfile
import threading

# Always enable fast Rust-based hf_transfer if installed
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
# Note: Removed custom setting of HF_HOME so that the global (externally set) HF_HOME is used.
# If HF_HOME is not set, ensure you set it in your environment.

from huggingface_hub import snapshot_download, hf_hub_download

def folder_size(directory):
    total = 0
    for (dirpath, dirnames, filenames) in os.walk(directory):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try:
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
            except:
                pass
    return total

def traverse_subfolders(root_folder: str, segments: list[str]) -> str:
    """
    For each segment in 'segments' (e.g. ["transformer.opt","fp4"]),
    we search for a subfolder with that exact name, ignoring .cache.
    If not found, we stop early. Return the final path we get.
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

def link_or_move(src: str, dst: str):
    """
    Tries to create a hard link from src to dst; if that fails, falls back to a move.
    This avoids duplicating the file on disk while ensuring that the final file is "linked".
    """
    try:
        os.link(src, dst)
        os.remove(src)
        print(f"[DEBUG] Hardlink created from {src} to {dst}")
    except Exception as e:
        print(f"[DEBUG] Hardlink failed ({e}); falling back to move.")
        shutil.move(src, dst)

def run_download(parsed_data: dict,
                 final_folder: str,
                 token: str = "",
                 sync: bool = False) -> tuple[str, str]:
    """
    Single-file approach using hf_hub_download => uses HF_TRANSFER if installed,
    storing the file in the cache defined by the global HF_HOME.
    The file is then transferred to models/<final_folder>/filename using a hard link (or move fallback),
    so no duplicate disk usage is incurred.
    """
    print("[DEBUG] run_download (single-file) started.")
    target_path = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(target_path, exist_ok=True)

    # Build remote filename from subfolder + file
    remote_filename = ""
    if "file" in parsed_data:
        file_name = parsed_data["file"].strip("/")
        sub = parsed_data.get("subfolder", "").strip("/")
        if sub:
            remote_filename = os.path.join(sub, file_name)
        else:
            remote_filename = file_name
    else:
        remote_filename = "unknown.bin"

    local_filename = os.path.basename(remote_filename)
    dest_path = os.path.join(target_path, local_filename)
    print("[DEBUG] Single-file final dest:", dest_path)

    if os.path.exists(dest_path):
        try:
            fs = os.path.getsize(dest_path)
            fg = fs / (1024**3)
        except:
            fg = 0
        final_message = f"{local_filename} already exists | {fg:.3f} GB"
        print("[DEBUG]", final_message)
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("huggingface.download.complete",
                                            {"message": final_message,
                                             "local_path": dest_path,
                                             "no_popup": True})
        except:
            pass
        if sync:
            return final_message, dest_path
        return "", ""

    try:
        repo_id = parsed_data["repo"]
        revision = parsed_data.get("revision", None)
        # hf_hub_download => uses HF_TRANSFER if installed
        file_path_in_cache = hf_hub_download(
            repo_id=repo_id,
            filename=remote_filename,
            revision=revision,
            token=token if token else None
        )
        print("[DEBUG] hf_hub_download =>", file_path_in_cache)

        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        # Use a hard link (or fallback to move) to avoid duplicate storage and maintain linking expectations.
        link_or_move(file_path_in_cache, dest_path)

        fs = 0
        if os.path.exists(dest_path):
            fs = os.path.getsize(dest_path)
        fg = fs / (1024**3)
        final_message = f"File downloaded successfully: {local_filename} | {fg:.3f} GB"
        print("[DEBUG]", final_message)
    except Exception as e:
        final_message = f"Download failed: {e}"
        print("[DEBUG]", final_message)

    # notify UI
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress": 100})
        PromptServer.instance.send_sync("huggingface.download.complete",
                                        {"message": final_message,
                                         "local_path": dest_path})
    except:
        pass

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
    Partial subfolder approach => snapshot_download w/ allow_patterns if remote_subfolder_path is not empty.
    We store in the cache defined by HF_HOME plus a separate temp_dir for partial snapshot,
    then traverse to final subfolder and transfer files to models/<final_folder>/<last_segment>
    (or models/<final_folder> if last_segment is empty) using hard links (or move fallback),
    so no duplicate storage is incurred.
    """
    print("[DEBUG] run_download_folder started (folder).")
    base_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(base_dir, exist_ok=True)
    # If last_segment is provided, use it as an additional subfolder.
    if last_segment:
        dest_path = os.path.join(base_dir, last_segment)
    else:
        dest_path = base_dir

    print("[DEBUG] Folder final dest =>", dest_path)

    if os.path.exists(dest_path) and os.listdir(dest_path):
        fz = folder_size(dest_path)
        fg = fz / (1024**3)
        final_message = f"{os.path.basename(dest_path)} already exists | {fg:.3f} GB"
        print("[DEBUG]", final_message)
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("huggingface.download.complete",
                                            {"message": final_message,
                                             "local_path": dest_path,
                                             "no_popup": True})
        except:
            pass
        if sync:
            return final_message, dest_path
        return "", ""

    comfy_temp = os.path.join(os.getcwd(), "temp")
    os.makedirs(comfy_temp, exist_ok=True)
    temp_dir = tempfile.mkdtemp(prefix="hf_dl_", dir=comfy_temp)
    print("[DEBUG] Temp folder =>", temp_dir)

    allow_patterns = None
    if remote_subfolder_path:
        allow_patterns = [f"{remote_subfolder_path}/**"]
    print("[DEBUG] allow_patterns =>", allow_patterns)

    repo_id = parsed_data["repo"]
    revision = parsed_data.get("revision", None)
    kwargs = {
        "repo_id": repo_id,
        "local_dir": temp_dir,
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
        print("[DEBUG] Folder monitor on", temp_dir)
        while not progress_event.is_set():
            csz = folder_size(temp_dir)
            if final_total > 0:
                pct = (csz / final_total) * 100
            else:
                pct = 0
            ip = int(pct)
            if ip > last_percent:
                sys.stdout.write(f"\r[DEBUG] [Folder Monitor] {ip}%")
                sys.stdout.flush()
                last_percent = ip
                try:
                    from server import PromptServer
                    PromptServer.instance.send_sync("huggingface.download.progress", {"progress": ip})
                except:
                    pass
            time.sleep(1)
        print()
    threading.Thread(target=folder_monitor, daemon=True).start()

    start_t = time.time()
    final_message = "Download failed???"
    try:
        print("[DEBUG] Starting snapshot_download (partial if subfolder).")
        downloaded_folder = snapshot_download(**kwargs)
        print("[DEBUG] snapshot_download =>", downloaded_folder)
        final_total = folder_size(downloaded_folder)
        print("[DEBUG] final_total =>", final_total)
    except Exception as e:
        final_message = f"Download failed: {e}"
        print("[DEBUG]", final_message)
    else:
        segments = remote_subfolder_path.split("/") if remote_subfolder_path else []
        source_folder = traverse_subfolders(downloaded_folder, segments)
        print("[DEBUG] final source =>", source_folder)

        os.makedirs(dest_path, exist_ok=True)
        for item in os.listdir(source_folder):
            if item == ".cache":
                continue
            s = os.path.join(source_folder, item)
            d = os.path.join(dest_path, item)
            link_or_move(s, d)
        elap = time.time() - start_t
        fsz = folder_size(dest_path)
        fgb = fsz / (1024**3)
        final_message = f"Folder downloaded successfully: {os.path.basename(dest_path)} | {fgb:.3f} GB | {elap:.1f} sec"
        print("[DEBUG]", final_message)

    progress_event.set()
    shutil.rmtree(temp_dir, ignore_errors=True)
    print("[DEBUG] removed temp =>", temp_dir)

    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress": 100})
        PromptServer.instance.send_sync("huggingface.download.complete",
                                        {"message": final_message, "local_path": dest_path})
    except:
        pass

    if sync:
        return final_message, dest_path
    return "", ""
