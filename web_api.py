import os
import json
import traceback
import threading
import time
import uuid
import asyncio
from aiohttp import web
from .backup import backup_to_huggingface, restore_from_huggingface
from .file_manager import get_model_subfolders
from .model_discovery import process_workflow_for_missing_models
from .downloader import run_download, get_remote_file_metadata, get_blob_paths, get_token
from .parse_link import parse_link

download_queue = []
download_queue_lock = threading.Lock()
download_status = {}
download_status_lock = threading.Lock()
download_worker_running = False
search_status = {}
search_status_lock = threading.Lock()

def _build_parsed_download_info(model: dict) -> dict:
    """Build parsed download info for run_download using HF repo/path if provided."""
    hf_repo = model.get("hf_repo")
    hf_path = model.get("hf_path")
    if hf_repo and hf_path:
        subfolder = os.path.dirname(hf_path).replace("\\", "/")
        file_name = os.path.basename(hf_path)
        parsed = {"repo": hf_repo, "file": file_name}
        if subfolder and subfolder != ".":
            parsed["subfolder"] = subfolder
        return parsed

    url = model.get("url")
    if not url:
        raise ValueError("No URL or HuggingFace repo/path provided.")
    if "civitai.com" in url:
        raise ValueError("CivitAI downloads are not supported.")

    parsed = parse_link(url)
    if "file" not in parsed and model.get("filename"):
        parsed["file"] = model["filename"]
    return parsed

def _set_download_status(download_id: str, fields: dict):
    with download_status_lock:
        existing = download_status.get(download_id, {})
        existing.update(fields)
        download_status[download_id] = existing

def _set_search_status(request_id: str, fields: dict):
    if not request_id:
        return
    with search_status_lock:
        existing = search_status.get(request_id, {})
        existing.update(fields)
        existing["updated_at"] = time.time()
        search_status[request_id] = existing

def _download_worker():
    global download_worker_running
    while download_worker_running:
        item = None
        with download_queue_lock:
            if download_queue:
                item = download_queue.pop(0)

        if not item:
            time.sleep(0.2)
            continue

        download_id = item["download_id"]
        _set_download_status(download_id, {"status": "downloading", "started_at": time.time()})

        stop_event = None
        try:
            parsed = _build_parsed_download_info(item)
            token = get_token()
            remote_filename = parsed["file"]
            if parsed.get("subfolder"):
                remote_filename = f"{parsed['subfolder'].strip('/')}/{parsed['file']}"
            expected_size, _, etag = get_remote_file_metadata(
                parsed["repo"],
                remote_filename,
                revision=parsed.get("revision"),
                token=token or None
            )
            _set_download_status(download_id, {
                "status": "downloading",
                "downloaded_bytes": 0,
                "total_bytes": expected_size,
                "updated_at": time.time()
            })

            def monitor_progress(stop_event, download_id, expected_size, blob_path, incomplete_path, filename):
                last_bytes = None
                last_time = time.time()
                ema_speed = None
                last_report = time.time()
                last_change = time.time()
                last_stall_log = time.time()
                try:
                    while not stop_event.is_set():
                        bytes_now = None
                        if incomplete_path and os.path.exists(incomplete_path):
                            bytes_now = os.path.getsize(incomplete_path)
                        elif blob_path and os.path.exists(blob_path):
                            bytes_now = os.path.getsize(blob_path)

                        if bytes_now is not None:
                            now = time.time()
                            if now - last_report >= 5:
                                blob_label = "incomplete" if (incomplete_path and os.path.exists(incomplete_path)) else "blob"
                                size_label = bytes_now
                                total_label = expected_size if expected_size is not None else "unknown"
                                print(f"[DEBUG] monitor_progress {filename}: {size_label}/{total_label} bytes ({blob_label})")
                                last_report = now
                            if last_bytes is None or bytes_now != last_bytes:
                                last_change = now
                            if expected_size and bytes_now >= expected_size:
                                _set_download_status(download_id, {
                                    "status": "verifying",
                                    "downloaded_bytes": bytes_now,
                                    "total_bytes": expected_size,
                                    "speed_bps": 0,
                                    "eta_seconds": None,
                                    "updated_at": now
                                })
                                return
                            if expected_size:
                                near_done = expected_size - bytes_now <= max(8 * 1024 * 1024, int(expected_size * 0.0005))
                                stalled = (now - last_change) >= 15
                                if near_done and stalled:
                                    print(f"[DEBUG] monitor_progress {filename}: stalled near completion, switching to verifying")
                                    _set_download_status(download_id, {
                                        "status": "verifying",
                                        "downloaded_bytes": bytes_now,
                                        "total_bytes": expected_size,
                                        "speed_bps": 0,
                                        "eta_seconds": None,
                                        "updated_at": now
                                    })
                                    return
                            if last_bytes is None:
                                inst_speed = 0
                            else:
                                delta = bytes_now - last_bytes
                                dt = now - last_time
                                inst_speed = (delta / dt) if dt > 0 else 0
                            ema_speed = inst_speed if ema_speed is None else (0.2 * inst_speed + 0.8 * ema_speed)
                            if bytes_now == last_bytes and (now - last_change) >= 10 and (now - last_stall_log) >= 10:
                                stall_for = now - last_change
                                total_label = expected_size if expected_size is not None else "unknown"
                                print(f"[DEBUG] monitor_progress {filename}: stalled at {bytes_now}/{total_label} for {stall_for:.0f}s")
                                last_stall_log = now
                            eta_seconds = None
                            if expected_size and ema_speed and ema_speed > 0:
                                eta_seconds = max(0, (expected_size - bytes_now) / ema_speed)
                            _set_download_status(download_id, {
                                "status": "downloading",
                                "downloaded_bytes": bytes_now,
                                "total_bytes": expected_size,
                                "speed_bps": ema_speed,
                                "eta_seconds": eta_seconds,
                                "updated_at": now
                            })
                            last_bytes = bytes_now
                            last_time = now
                        time.sleep(0.5)
                except Exception:
                    return

            if etag:
                stop_event = threading.Event()
                blob_path, incomplete_path = get_blob_paths(parsed["repo"], etag)
                threading.Thread(
                    target=monitor_progress,
                    args=(stop_event, download_id, expected_size, blob_path, incomplete_path, remote_filename),
                    daemon=True
                ).start()

            msg, path = run_download(parsed, item["folder"], sync=True)
            _set_download_status(download_id, {
                "status": "completed",
                "message": msg,
                "path": path,
                "finished_at": time.time()
            })
        except Exception as e:
            _set_download_status(download_id, {
                "status": "failed",
                "error": str(e),
                "finished_at": time.time()
            })
        finally:
            if stop_event:
                stop_event.set()

def _start_download_worker():
    global download_worker_running
    if download_worker_running:
        return
    download_worker_running = True
    threading.Thread(target=_download_worker, daemon=True).start()

async def folder_structure(request):
    """Return the list of model subfolders"""
    try:
        folders = get_model_subfolders()
        return web.json_response(folders)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def check_missing_models(request):
    """
    Analyzes the workflow JSON to find missing models.
    Returns: { "missing": [...], "found": [...] }
    """
    try:
        print("[DEBUG] check_missing_models called")
        data = await request.json()
        request_id = data.get("request_id") or uuid.uuid4().hex
        _set_search_status(request_id, {"message": "Scanning workflow", "source": "workflow"})

        def status_cb(payload):
            if not payload:
                return
            if isinstance(payload, str):
                _set_search_status(request_id, {"message": payload})
                return
            if isinstance(payload, dict):
                _set_search_status(request_id, payload)

        result = await asyncio.to_thread(
            process_workflow_for_missing_models,
            data,
            status_cb
        )
        _set_search_status(request_id, {"message": "Done", "source": "complete"})
        result["request_id"] = request_id
        return web.json_response(result)
    except Exception as e:
        print(f"[ERROR] check_missing_models failed: {e}")
        print(f"[ERROR] Traceback: {traceback.format_exc()}")
        return web.json_response({"error": str(e) if str(e) else repr(e)}, status=500)

async def install_models(request):
    """
    Downloads a list of models.
    Expects JSON: { "models": [ { "url": "...", "filename": "...", "folder": "..." }, ... ] }
    """
    try:
        print("[DEBUG] install_models called")
        data = await request.json()
        models_to_install = data.get("models", [])
        
        results = []
        for model in models_to_install:
            url = model.get("url")
            filename = model.get("filename")
            folder = model.get("folder", "checkpoints") # Default to checkpoints
            
            if not url and not (model.get("hf_repo") and model.get("hf_path")):
                results.append({"filename": filename, "status": "failed", "error": "No URL provided"})
                continue
                
            try:
                parsed = _build_parsed_download_info(model)
                msg, path = run_download(parsed, folder, sync=True)
                results.append({"filename": filename, "status": "success", "path": path, "message": msg})
                
            except Exception as e:
                print(f"[ERROR] Failed to download {filename}: {e}")
                results.append({"filename": filename, "status": "failed", "error": str(e)})
        
        return web.json_response({"results": results})
        
    except Exception as e:
         return web.json_response({"error": str(e)}, status=500)

async def backup_to_hf(request):
    data = await request.json()
    folders = data.get("folders", [])
    size_limit_gb = float(data.get("size_limit_gb", 5))
    # Read repo name from comfy.settings.json
    settings_path = os.path.join("user", "default", "comfy.settings.json")
    repo_name = ""
    if os.path.exists(settings_path):
        with open(settings_path, "r") as f:
            settings = json.load(f)
        repo_name = settings.get("downloaderbackup.repo_name", "").strip()
    if not repo_name:
        return web.json_response({"status": "error", "message": "No repo name set in settings."}, status=400)
    try:
        # Pass size_limit_gb as a keyword argument, not a positional argument
        backup_to_huggingface(repo_name, folders, size_limit_gb=size_limit_gb)
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

async def restore_from_hf(request):
    # Read repo name from comfy.settings.json
    settings_path = os.path.join("user", "default", "comfy.settings.json")
    repo_name = ""
    if os.path.exists(settings_path):
        with open(settings_path, "r") as f:
            settings = json.load(f)
        repo_name = settings.get("downloaderbackup.repo_name", "").strip()
    if not repo_name:
        return web.json_response({"status": "error", "message": "No repo name set in settings."}, status=400)
    try:
        restore_from_huggingface(repo_name)
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)

def setup(app):
    app.router.add_get("/folder_structure", folder_structure)
    app.router.add_post("/backup_to_hf", backup_to_hf)
    app.router.add_post("/restore_from_hf", restore_from_hf)
    app.router.add_post("/check_missing_models", check_missing_models)
    app.router.add_post("/install_models", install_models)

    async def queue_download(request):
        """Queue background downloads with status tracking."""
        try:
            data = await request.json()
            models = data.get("models", [])
            queued = []
            for model in models:
                filename = model.get("filename")
                folder = model.get("folder", "checkpoints")
                if not filename:
                    continue
                download_id = f"dl_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}"
                item = dict(model)
                item["download_id"] = download_id
                item["folder"] = folder
                with download_queue_lock:
                    download_queue.append(item)
                _set_download_status(download_id, {
                    "status": "queued",
                    "filename": filename,
                    "folder": folder,
                    "queued_at": time.time()
                })
                queued.append({"download_id": download_id, "filename": filename})

            _start_download_worker()
            return web.json_response({"queued": queued})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def download_status_endpoint(request):
        """Get current status of downloads."""
        ids_param = request.query.get("ids", "")
        ids = [x for x in ids_param.split(",") if x]
        with download_status_lock:
            if ids:
                filtered = {i: download_status.get(i) for i in ids if i in download_status}
            else:
                filtered = dict(download_status)
        return web.json_response({"downloads": filtered})

    async def search_status_endpoint(request):
        request_id = request.query.get("request_id", "")
        with search_status_lock:
            status = search_status.get(request_id, {}) if request_id else {}
        return web.json_response({"status": status})
    
    async def restart(request):
        """Restart ComfyUI server"""
        import sys
        import os
        
        # Schedule the restart after sending response
        def restart_server():
            python = sys.executable
            os.execl(python, python, *sys.argv)
            
        app.loop.call_later(1, restart_server)
        return web.json_response({"status": "ok"})
        
    app.router.add_post("/restart", restart)
    app.router.add_post("/queue_download", queue_download)
    app.router.add_get("/download_status", download_status_endpoint)
    app.router.add_get("/search_status", search_status_endpoint)
