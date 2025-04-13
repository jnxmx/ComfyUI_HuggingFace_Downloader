import os
import sys
import shutil
import time
import requests
import tempfile
import threading

# Always enable fast Rust-based hf_transfer if installed
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
# Using the global HF_HOME; do not override with a custom value
# os.environ["HF_HOME"] = os.path.join(os.getcwd(), "temp", "hf-cache")

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


def run_download(parsed_data: dict,
                 final_folder: str,
                 token: str = "",
                 sync: bool = False) -> tuple[str, str]:
    """
    Single-file approach using hf_hub_download => uses HF_TRANSFER if installed,
    storing cache in global HF_HOME. Moved final file to models/<final_folder>/filename.
    After copying, the source file is removed.
    """
    print("[DEBUG] run_download (single-file) started.")
    target_path = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(target_path, exist_ok=True)

    # Build remote filename from subfolder + file
    remote_filename = ""
    if "file" in parsed_data:
        file_name = parsed_data["file"].strip("/")
        sub = parsed_data.get("subfolder","").strip("/")
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
        shutil.copyfile(file_path_in_cache, dest_path)

        # After copying, delete the file in the cache if it still exists.
        if os.path.exists(file_path_in_cache):
            try:
                os.remove(file_path_in_cache)
                print("[DEBUG] Deleted cache file:", file_path_in_cache)
            except Exception as del_err:
                print("[DEBUG] Failed to delete cache file:", del_err)

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
