import os
import json
from aiohttp import web
from .backup import backup_to_huggingface, restore_from_huggingface

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
    app.router.add_post("/backup_to_hf", backup_to_hf)
    app.router.add_post("/restore_from_hf", restore_from_hf)
