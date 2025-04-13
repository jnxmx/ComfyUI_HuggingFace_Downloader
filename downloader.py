import os
import sys
import shutil
import time
import requests
import tempfile
import threading

# Always enable fast Rust-based hf_transfer if installed
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
# Use the global HF_HOME; do not override with a custom path.
# It is expected that the cache will reside in the global HF_HOME.
# (This code will clean the repo’s cache folder after copying.)
#
# For example, if HF_HUB downloads a file into:
#    <HF_HOME>/hub/models--xinsir--controlnet-union-sdxl-1.0/blobs/<hash>
# then after copying the file, this script removes:
#    <HF_HOME>/hub/models--xinsir--controlnet-union-sdxl-1.0
# to free up the space.

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


def clean_repo_cache(file_path_in_cache: str):
    """
    Given the full path to a downloaded file from hf_hub_download,
    remove the repository folder that contains the blobs, snapshots, and refs.
    This is determined as two directories up from the file path.
    """
    try:
        repo_cache_folder = os.path.dirname(os.path.dirname(file_path_in_cache))
        if os.path.exists(repo_cache_folder):
            shutil.rmtree(repo_cache_folder, ignore_errors=True)
            print("[DEBUG] Removed repository cache folder:", repo_cache_folder)
    except Exception as e:
        print("[DEBUG] Error removing repository cache folder:", e)


def run_download(parsed_data: dict,
                 final_folder: str,
                 token: str = "",
                 sync: bool = False) -> tuple[str, str]:
    """
    Single-file approach using hf_hub_download.
    After copying, deletes the source file and then removes its repository cache folder.
    The file is placed into models/<final_folder>/filename.
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
            fg = fs / (1024**3)
        except:
            fg = 0
        final_message = f"{local_filename} already exists | {fg:.3f} GB"
        print("[DEBUG]", final_message)
        try:
            from server import PromptServer
            PromptServer.instance.send_sync(
                "huggingface.download.complete",
                {"message": final_message, "local_path": dest_path, "no_popup": True}
            )
        except:
            pass
        if sync:
            return final_message, dest_path
        return "", ""

    try:
        repo_id = parsed_data["repo"]
        revision = parsed_data.get("revision", None)
        # hf_hub_download uses HF_TRANSFER if installed.
        file_path_in_cache = hf_hub_download(
            repo_id=repo_id,
            filename=remote_filename,
            revision=revision,
            token=token if token else None
        )
        print("[DEBUG] hf_hub_download =>", file_path_in_cache)

        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        shutil.copyfile(file_path_in_cache, dest_path)
        print("[DEBUG] Copied file to:", dest_path)

        # Delete the downloaded file (or symlink) if it still exists.
        if os.path.exists(file_path_in_cache):
            try:
                os.remove(file_path_in_cache)
                print("[DEBUG] Deleted cache file:", file_path_in_cache)
            except Exception as del_err:
                print("[DEBUG] Failed to delete cache file:", del_err)

        # Additionally, clean the entire repository cache folder.
        clean_repo_cache(file_path_in_cache)

        fs = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
        fg = fs / (1024**3)
        final_message = f"File downloaded successfully: {local_filename} | {fg:.3f} GB"
        print("[DEBUG]", final_message)
    except Exception as e:
        final_message = f"Download failed: {e}"
        print("[DEBUG]", final_message)

    # Notify UI
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress": 100})
        PromptServer.instance.send_sync(
            "huggingface.download.complete",
            {"message": final_message, "local_path": dest_path}
        )
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
    Uses snapshot_download with allow_patterns if remote_subfolder_path is provided.
    Copies the downloaded folder contents to models/<final_folder>/<last_segment> (if specified) or models/<final_folder>.
    After copying, deletes the source files and then cleans the repository cache folder.
    """
    print("[DEBUG] run_download_folder started (folder).")
    base_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(base_dir, exist_ok=True)
    dest_path = os.path.join(base_dir, last_segment) if last_segment else base_dir
    print("[DEBUG] Folder final dest =>", dest_path)

    if os.path.exists(dest_path) and os.listdir(dest_path):
        fz = folder_size(dest_path)
        fg = fz / (1024**3)
        final_message = f"{os.path.basename(dest_path)} already exists | {fg:.3f} GB"
        print("[DEBUG]", final_message)
        try:
            from server import PromptServer
            PromptServer.instance.send_sync(
                "huggingface.download.complete",
                {"message": final_message, "local_path": dest_path, "no_popup": True}
            )
        except:
            pass
        if sync:
            return final_message, dest_path
        return "", ""

    comfy_temp = os.path.join(os.getcwd(), "temp")
    os.makedirs(comfy_temp, exist_ok=True)
    temp_dir = tempfile.mkdtemp(prefix="hf_dl_", dir=comfy_temp)
    print("[DEBUG] Temp folder =>", temp_dir)

    allow_patterns = [f"{remote_subfolder_path}/**"] if remote_subfolder_path else None
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
            pct = (csz / final_total) * 100 if final_total > 0 else 0
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
            # Instead of moving, copy then delete.
            if os.path.isdir(s):
                shutil.copytree(s, d)
                shutil.rmtree(s, ignore_errors=True)
                print("[DEBUG] Copied and deleted directory:", s)
            else:
                shutil.copy2(s, d)
                try:
                    os.remove(s)
                    print("[DEBUG] Copied and deleted file:", s)
                except Exception as del_err:
                    print("[DEBUG] Failed to delete file:", del_err)
        elap = time.time() - start_t
        fsz = folder_size(dest_path)
        fgb = fsz / (1024**3)
        final_message = f"Folder downloaded successfully: {os.path.basename(dest_path)} | {fgb:.3f} GB | {elap:.1f} sec"
        print("[DEBUG]", final_message)

        # Optionally, clean the repository cache folder by locating it from one of the source files.
        # Using one of the file paths from the downloaded_folder.
        sample_item = None
        for root, dirs, files in os.walk(downloaded_folder):
            if files:
                sample_item = os.path.join(root, files[0])
                break
        if sample_item:
            clean_repo_cache(sample_item)

    progress_event.set()
    shutil.rmtree(temp_dir, ignore_errors=True)
    print("[DEBUG] removed temp =>", temp_dir)

    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress": 100})
        PromptServer.instance.send_sync(
            "huggingface.download.complete",
            {"message": final_message, "local_path": dest_path}
        )
    except:
        pass

    if sync:
        return final_message, dest_path
    return "", ""
