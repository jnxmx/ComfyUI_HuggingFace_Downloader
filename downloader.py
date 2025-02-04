import os
import shutil
import time
import tempfile
import threading
import sys
import requests

from huggingface_hub import snapshot_download, hf_hub_url


def folder_size(directory):
    """Compute total size of files under 'directory'."""
    total = 0
    for dirpath, dirnames, filenames in os.walk(directory):
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
    For each segment in segments (e.g. ["transformer.opt","fp4"]),
    find a subfolder with that exact name, ignoring .cache.
    If not found, we stop early. Return the final folder path we land on.
    """
    current = root_folder
    for seg in segments:
        found_sub = False
        for item in os.listdir(current):
            if item == ".cache":
                continue
            candidate = os.path.join(current, item)
            if os.path.isdir(candidate) and item == seg:
                current = candidate
                found_sub = True
                break
        if not found_sub:
            # e.g. seg not found => stop
            break
    return current


def run_download(parsed_data: dict,
                 final_folder: str,
                 token: str = "",
                 sync: bool = False) -> tuple[str, str]:
    """
    Single-file download with streaming GET. We check if 'parsed_data' has
    a 'file' entry. We place it in models/<final_folder>/<the file name>.
    If sync=True => returns (final_message, local_path). Otherwise => None.
    """
    print("[DEBUG] run_download started (single-file).")
    start_time = time.time()

    # 1) Build final path = models/<final_folder>
    target_full_path = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(target_full_path, exist_ok=True)
    print("[DEBUG] target_full_path:", target_full_path)

    # If there's no 'file' in parsed_data, we can do something else or skip.
    remote_filename = ""
    if "file" in parsed_data:
        file_name = parsed_data["file"].strip("/")
        sub = parsed_data.get("subfolder","").strip("/")
        if sub:
            remote_filename = os.path.join(sub, file_name)
        else:
            remote_filename = file_name
    else:
        # If we have no "file", this might be an incomplete link or something.
        # We'll try anyway with default?
        print("[DEBUG] run_download: no 'file' in parsed_data, fallback.")
        remote_filename = "unknown.bin"

    # The local filename is just the file name part
    local_filename = os.path.basename(remote_filename)
    dest_path = os.path.join(target_full_path, local_filename)
    print("[DEBUG] single-file dest_path:", dest_path)

    # 2) if file already exist => skip
    if os.path.exists(dest_path):
        try:
            file_size_bytes = os.path.getsize(dest_path)
            file_size_gb = file_size_bytes / (1024**3)
        except:
            file_size_gb = 0
        final_message = f"{os.path.basename(dest_path)} already exists | {file_size_gb:.3f} GB"
        print("[DEBUG]", final_message)
        # UI no_popup
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
        return None, None

    # 3) Attempt to get total size
    total_size = 0
    repo_id = parsed_data["repo"]
    revision = parsed_data.get("revision", None)
    try:
        file_url = hf_hub_url(repo_id=repo_id, filename=remote_filename, revision=revision)
        print("[DEBUG] single-file file_url:", file_url)
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        head_resp = requests.head(file_url, headers=headers, allow_redirects=True)
        total_size = int(head_resp.headers.get("Content-Length",0))
        print("[DEBUG] total_size =>", total_size,"bytes")
    except Exception as e:
        print("[DEBUG] Could not determine file size:", e)

    # 4) comfy temp
    comfy_temp = os.path.join(os.getcwd(), "temp")
    os.makedirs(comfy_temp, exist_ok=True)
    temp_dir = tempfile.mkdtemp(prefix="hf_dl_", dir=comfy_temp)
    print("[DEBUG] Temp dir for single-file =>", temp_dir)

    temp_file_path = os.path.join(temp_dir, local_filename)
    final_message = "Download failed???"
    last_percent = -1

    try:
        # 5) streaming GET
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        with requests.get(file_url, headers=headers, stream=True, allow_redirects=True) as r:
            r.raise_for_status()
            downloaded = 0
            with open(temp_file_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total_size>0:
                            percent = (downloaded / total_size)*100
                        else:
                            percent=0
                        int_pct = int(percent)
                        if int_pct>last_percent:
                            sys.stdout.write(f"\r[DEBUG] Download progress: {int_pct}%")
                            sys.stdout.flush()
                            last_percent = int_pct
                            # UI progress
                            try:
                                from server import PromptServer
                                PromptServer.instance.send_sync("huggingface.download.progress",{"progress": int_pct})
                            except:
                                pass
        print("\n[DEBUG] Single-file streaming done.")
        # Move to final dest
        if os.path.exists(temp_file_path):
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            shutil.move(temp_file_path, dest_path)
            print("[DEBUG] Moved file =>", dest_path)
            elapsed = time.time() - start_time
            fs = 0
            if os.path.exists(dest_path):
                fs = os.path.getsize(dest_path)
            final_message = f"File downloaded successfully: {os.path.basename(dest_path)} | {fs/(1024**3):.3f} GB | {elapsed:.1f} sec"
            print("[DEBUG]", final_message)
        else:
            final_message="Downloaded file not found in temp."
            print("[DEBUG]", final_message)
    except Exception as e:
        final_message = f"Download failed: {e}"
        print("[DEBUG]", final_message)

    shutil.rmtree(temp_dir, ignore_errors=True)
    print("[DEBUG] Removed single-file temp =>", temp_dir)

    # UI notify
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress":100})
        PromptServer.instance.send_sync("huggingface.download.complete",
                                        {"message": final_message,
                                         "local_path": dest_path})
    except:
        pass

    if sync:
        return final_message, dest_path
    return None, None


def run_download_folder(parsed_data: dict,
                        final_folder: str,      # e.g. "loras/test2"
                        token: str = "",
                        remote_subfolder_path: str = "", # e.g. "transformer.opt/fp4"
                        last_segment: str = "",           # e.g. "fp4"
                        sync: bool = False):
    """
    The folder-based approach, partial patterns, plus subfolder traversal.
    This ensures only 'transformer.opt/fp4' is fetched, not the entire repo,
    then we find that subfolder inside the snapshot, skipping .cache, and copy
    it to models/<final_folder>/<last_segment> if last_segment is non-empty.
    """
    print("[DEBUG] run_download_folder started.")
    # 1) define final local path
    base_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(base_dir, exist_ok=True)
    if last_segment:
        dest_path = os.path.join(base_dir, last_segment)
    else:
        dest_path = base_dir

    print("[DEBUG] Destination folder path:", dest_path)

    # 2) if subfolder is not empty => skip
    if os.path.exists(dest_path) and os.listdir(dest_path):
        from .downloader import folder_size
        exist_sz = folder_size(dest_path)
        exist_gb = exist_sz / (1024**3)
        final_message = f"{os.path.basename(dest_path)} already exists | {exist_gb:.3f} GB"
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
        return

    # 3) comfy temp
    comfy_temp = os.path.join(os.getcwd(), "temp")
    os.makedirs(comfy_temp, exist_ok=True)
    temp_dir = tempfile.mkdtemp(prefix="hf_dl_", dir=comfy_temp)
    print("[DEBUG] Temp dir created:", temp_dir)

    # 4) partial patterns
    allow_patterns = None
    if remote_subfolder_path:
        allow_patterns = [f"{remote_subfolder_path}/**"]
    print("[DEBUG] allow_patterns:", allow_patterns)

    kwargs = {
        "repo_id": parsed_data["repo"],
        "local_dir": temp_dir,
        "token": token if token else None,
    }
    if "revision" in parsed_data:
        kwargs["revision"] = parsed_data["revision"]
    if allow_patterns:
        kwargs["allow_patterns"] = allow_patterns

    progress_event = threading.Event()
    last_percent = -1
    final_total = 0

    def folder_monitor():
        nonlocal final_total, last_percent
        print("[DEBUG] Folder monitor on", temp_dir)
        while not progress_event.is_set():
            current_sz = folder_size(temp_dir)
            if final_total>0:
                pct=(current_sz/final_total)*100
            else:
                pct=0
            ip=int(pct)
            if ip>last_percent:
                sys.stdout.write(f"\r[DEBUG] [Folder Monitor] {ip}%")
                sys.stdout.flush()
                last_percent=ip
                try:
                    from server import PromptServer
                    PromptServer.instance.send_sync("huggingface.download.progress",{"progress":ip})
                except:
                    pass
            time.sleep(1)
        print()
    threading.Thread(target=folder_monitor, daemon=True).start()

    start_time=time.time()
    final_message="Download failed: ???"
    try:
        print("[DEBUG] Starting snapshot_download with partial patterns if any.")
        downloaded_folder=snapshot_download(**kwargs)
        print("[DEBUG] snapshot_download =>",downloaded_folder)
        final_total=folder_size(downloaded_folder)
        print("[DEBUG] final_total =>",final_total,"bytes")
    except Exception as e:
        final_message=f"Download failed: {e}"
        print("[DEBUG]",final_message)
    else:
        from .downloader import traverse_subfolders
        segs = remote_subfolder_path.split("/") if remote_subfolder_path else []
        source_folder=traverse_subfolders(downloaded_folder,segs)
        print("[DEBUG] Final source folder =>",source_folder)

        os.makedirs(dest_path, exist_ok=True)
        for item in os.listdir(source_folder):
            if item==".cache":
                continue
            s=os.path.join(source_folder, item)
            d=os.path.join(dest_path, item)
            shutil.move(s,d)
        print("[DEBUG] Copied contents =>",dest_path)

        elap=time.time()-start_time
        fsz=folder_size(dest_path)
        fgb=fsz/(1024**3)
        final_message=f"Folder downloaded successfully: {os.path.basename(dest_path)} | {fgb:.3f} GB | {elap:.1f} sec"
        print("[DEBUG]",final_message)

    progress_event.set()
    shutil.rmtree(temp_dir, ignore_errors=True)
    print("[DEBUG] Removed temp =>",temp_dir)

    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress",{"progress":100})
        PromptServer.instance.send_sync("huggingface.download.complete",
                                        {"message":final_message,"local_path":dest_path})
    except:
        pass

    if sync:
        return final_message,dest_path
    return None,None
