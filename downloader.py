import os
import shutil
import time
import tempfile
import threading
import sys
import requests

from huggingface_hub import hf_hub_url, hf_hub_download, snapshot_download

def folder_size(directory):
    total = 0
    for dirpath, dirnames, filenames in os.walk(directory):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try:
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
            except Exception:
                pass
    return total

def run_download(parsed_data: dict, final_folder: str, token: str = "", remote_filename: str = "", local_filename: str = "", sync: bool = False):
    print("[DEBUG] run_download started")
    start_time = time.time()

    target_full_path = os.path.join(os.getcwd(), "models", final_folder)
    print(f"[DEBUG] Target full path: {target_full_path}")
    os.makedirs(target_full_path, exist_ok=True)

    dest_path = os.path.join(target_full_path, *local_filename.split('/')) if local_filename else target_full_path
    print(f"[DEBUG] Destination file path: {dest_path}")

    if local_filename and os.path.exists(dest_path):
        try:
            file_size_bytes = os.path.getsize(dest_path)
            file_size_gb = file_size_bytes / (1024 ** 3)
        except Exception:
            file_size_gb = 0
        final_message = f"{os.path.basename(dest_path)} already exists | {file_size_gb:.3f} GB"
        print(f"[DEBUG] {final_message}")
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("huggingface.download.complete", {"message": final_message, "local_path": dest_path, "no_popup": True})
        except Exception as e:
            print("[DEBUG] Failed to notify UI:", e)
        if sync:
            return final_message, dest_path
        return

    total_size = 0
    if remote_filename:
        try:
            file_url = hf_hub_url(
                repo_id=parsed_data["repo"],
                filename=remote_filename,
                revision=parsed_data.get("revision", None)
            )
            print(f"[DEBUG] Remote file URL: {file_url}")
            headers = {}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            head = requests.head(file_url, headers=headers, allow_redirects=True)
            total_size = int(head.headers.get("Content-Length", 0))
            print(f"[DEBUG] Total remote file size: {total_size} bytes")
        except Exception as e:
            print("[DEBUG] Could not determine total file size:", e)

    # Use streaming download for single-file downloads.
    temp_dir = tempfile.mkdtemp(prefix="hf_dl_")
    print(f"[DEBUG] Temporary directory created: {temp_dir}")
    temp_file_path = os.path.join(temp_dir, *remote_filename.split('/'))
    os.makedirs(os.path.dirname(temp_file_path), exist_ok=True)
    print(f"[DEBUG] Temp file path: {temp_file_path}")

    last_percent = -1
    try:
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        with requests.get(file_url, headers=headers, stream=True, allow_redirects=True) as r:
            r.raise_for_status()
            with open(temp_file_path, "wb") as f:
                downloaded = 0
                for chunk in r.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        percent = (downloaded / total_size) * 100 if total_size > 0 else 0
                        int_percent = int(percent)
                        if int_percent > last_percent:
                            sys.stdout.write(f"\r[DEBUG] Download progress: {int_percent}%")
                            sys.stdout.flush()
                            last_percent = int_percent
                            try:
                                from server import PromptServer
                                PromptServer.instance.send_sync("huggingface.download.progress", {"progress": int_percent})
                            except Exception as e:
                                print("[DEBUG] Progress update failed:", e)
        print("\n[DEBUG] Streaming download completed")
    except Exception as e:
        final_message = f"Download failed: {e}"
        print("[DEBUG]", final_message)
    else:
        if os.path.exists(temp_file_path):
            dest_dir = os.path.dirname(dest_path)
            os.makedirs(dest_dir, exist_ok=True)
            print(f"[DEBUG] Created destination directory: {dest_dir}")
            shutil.move(temp_file_path, dest_path)
            print(f"[DEBUG] Moved file to destination: {dest_path}")
        else:
            final_message = "Downloaded file not found in temporary directory."
            print("[DEBUG]", final_message)
        elapsed_time = time.time() - start_time
        file_size_gb = 0
        if os.path.exists(dest_path):
            try:
                file_size_bytes = os.path.getsize(dest_path)
                file_size_gb = file_size_bytes / (1024 ** 3)
            except Exception as e:
                print("[DEBUG] Failed to get file size:", e)
        final_message = f"File downloaded successfully: {os.path.basename(dest_path)} | {file_size_gb:.3f} GB | {elapsed_time:.1f} sec"
        print("\n[DEBUG] Final message:", final_message)

    shutil.rmtree(temp_dir, ignore_errors=True)
    print(f"[DEBUG] Temporary directory {temp_dir} removed.")

    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress": 100})
        PromptServer.instance.send_sync("huggingface.download.complete", {"message": final_message, "local_path": dest_path})
    except Exception as e:
        print("[DEBUG] Failed to notify UI:", e)

    if sync:
        return final_message, dest_path

def run_download_folder(parsed_data: dict, final_folder: str, token: str = "", remote_folder: str = "", local_folder_name: str = "", sync: bool = False):
    print("[DEBUG] run_download_folder started")
    start_time = time.time()

    target_full_path = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(target_full_path, exist_ok=True)
    # For folder downloads, we want the destination to be models/<target_folder>/<local_folder_name>
    dest_path = os.path.join(target_full_path, local_folder_name)
    print(f"[DEBUG] Destination folder path: {dest_path}")

    if os.path.exists(dest_path) and os.listdir(dest_path):
        try:
            folder_bytes = folder_size(dest_path)
            folder_gb = folder_bytes / (1024 ** 3)
        except Exception:
            folder_gb = 0
        final_message = f"{os.path.basename(dest_path)} already exists | {folder_gb:.3f} GB"
        print(f"[DEBUG] {final_message}")
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("huggingface.download.complete", {"message": final_message, "local_path": dest_path, "no_popup": True})
        except Exception as e:
            print("[DEBUG] Failed to notify UI:", e)
        if sync:
            return final_message, dest_path
        return

    allow_patterns = [f"{remote_folder}/**"] if remote_folder else None
    print(f"[DEBUG] Allow patterns: {allow_patterns}")

    temp_dir = tempfile.mkdtemp(prefix="hf_dl_folder_")
    print(f"[DEBUG] Temporary directory created: {temp_dir}")

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
    final_total = 0  # will be set after snapshot_download
    def monitor_progress_folder():
        nonlocal final_total, last_percent
        print(f"[DEBUG] Folder monitor started. Watching folder: {temp_dir}")
        while not progress_event.is_set():
            current_size = folder_size(temp_dir)
            if final_total > 0:
                percent = (current_size / final_total) * 100
            else:
                percent = 0
            int_percent = int(percent)
            if int_percent > last_percent:
                sys.stdout.write(f"\r[DEBUG] [Folder Monitor] Progress: {int_percent}%")
                sys.stdout.flush()
                last_percent = int_percent
                try:
                    from server import PromptServer
                    PromptServer.instance.send_sync("huggingface.download.progress", {"progress": int_percent})
                except Exception as e:
                    print("[DEBUG] Folder progress update failed:", e)
            time.sleep(1)
        print()
    threading.Thread(target=monitor_progress_folder, daemon=True).start()

    try:
        print("[DEBUG] Starting folder download via snapshot_download...")
        downloaded_folder = snapshot_download(**kwargs)
        print(f"[DEBUG] Folder download completed. Downloaded folder: {downloaded_folder}")
        final_total = folder_size(downloaded_folder)
        print(f"[DEBUG] Final total size of downloaded folder: {final_total} bytes")
    except Exception as e:
        final_message = f"Download failed: {e}"
        print("[DEBUG]", final_message)
    else:
        # Always move the contents of the inner folder.
        source_folder = os.path.join(downloaded_folder, os.path.basename(downloaded_folder))
        if not (os.path.exists(source_folder) and os.path.isdir(source_folder)):
            source_folder = downloaded_folder
        # Move the contents of source_folder (ignoring ".cache") into dest_path.
        os.makedirs(dest_path, exist_ok=True)
        for item in os.listdir(source_folder):
            if item == ".cache":
                continue
            s = os.path.join(source_folder, item)
            d = os.path.join(dest_path, item)
            shutil.move(s, d)
        print(f"[DEBUG] Moved folder contents to destination: {dest_path}")
        elapsed_time = time.time() - start_time
        folder_bytes = folder_size(dest_path)
        folder_gb = folder_bytes / (1024 ** 3)
        final_message = f"Folder downloaded successfully: {os.path.basename(dest_path)} | {folder_gb:.3f} GB | {elapsed_time:.1f} sec"
        print("\n[DEBUG] Final message:", final_message)

    progress_event.set()

    shutil.rmtree(temp_dir, ignore_errors=True)
    print(f"[DEBUG] Temporary directory {temp_dir} removed.")

    try:
        from server import PromptServer
        PromptServer.instance.send_sync("huggingface.download.progress", {"progress": 100})
        PromptServer.instance.send_sync("huggingface.download.complete", {"message": final_message, "local_path": dest_path})
    except Exception as e:
        print("[DEBUG] Failed to notify UI:", e)

    if sync:
        return final_message, dest_path

def folder_size(directory):
    total = 0
    for dirpath, dirnames, filenames in os.walk(directory):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try:
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
            except Exception:
                pass
    return total
