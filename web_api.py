import os
import json
from aiohttp import web
from .backup import backup_to_huggingface, restore_from_huggingface
from .file_manager import get_model_subfolders
from .model_discovery import process_workflow_for_missing_models
from .downloader import run_download
from .parse_link import parse_link

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
        data = await request.json()
        result = process_workflow_for_missing_models(data)
        return web.json_response(result)
    except Exception as e:
        print(f"[ERROR] check_missing_models failed: {e}")
        return web.json_response({"error": str(e)}, status=500)

async def install_models(request):
    """
    Downloads a list of models.
    Expects JSON: { "models": [ { "url": "...", "filename": "...", "folder": "..." }, ... ] }
    """
    try:
        data = await request.json()
        models_to_install = data.get("models", [])
        
        results = []
        for model in models_to_install:
            url = model.get("url")
            filename = model.get("filename")
            folder = model.get("folder", "checkpoints") # Default to checkpoints
            
            if not url:
                results.append({"filename": filename, "status": "failed", "error": "No URL provided"})
                continue
                
            try:
                # Parse the URL to get repo info
                parsed = parse_link(url)
                
                # If parsed doesn't have 'file' (repo root link?), try to use filename
                # parse_link usually extracts file if it's a resolve/blob link.
                if "file" not in parsed and filename:
                     parsed["file"] = filename
                
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
