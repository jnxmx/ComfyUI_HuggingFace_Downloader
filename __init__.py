
import os
import json
import glob
import importlib.util
import re

# Monkeypatch huggingface_hub to automatically retry public downloads anonymously
# if they fail with a token (this resolves fine-grained token 403 blocks for other nodes).
try:
    import huggingface_hub.file_download
    _orig_hf_hub_download = huggingface_hub.file_download.hf_hub_download

    def _patched_hf_hub_download(*args, **kwargs):
        try:
            return _orig_hf_hub_download(*args, **kwargs)
        except Exception as e:
            e_str = str(e)
            if "403" in e_str or "401" in e_str or "AccessDenied" in e_str or "Forbidden" in e_str:
                token = kwargs.get("token")
                if token is not False:
                    kwargs_copy = kwargs.copy()
                    kwargs_copy["token"] = False
                    orig_env_token = os.environ.pop("HF_TOKEN", None)
                    try:
                        return _orig_hf_hub_download(*args, **kwargs_copy)
                    except Exception:
                        pass
                    finally:
                        if orig_env_token is not None:
                            os.environ["HF_TOKEN"] = orig_env_token
            raise e

    huggingface_hub.file_download.hf_hub_download = _patched_hf_hub_download
except Exception:
    pass




from .HuggingFaceDownloadModel import HuggingFaceDownloadModel
from .HuggingFaceDownloadFolder import HuggingFaceDownloadFolder
import threading
import time

NODE_CLASS_MAPPINGS = {
    "Hugging Face Download Model": HuggingFaceDownloadModel,
    "Hugging Face Download Folder": HuggingFaceDownloadFolder,
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]

try:
    from .model_discovery import patch_lora_stack_nodes
    patch_lora_stack_nodes()
except Exception:
    pass

# Register web API
try:
    from . import web_api
    import server

    _web_api_registered = False
    _web_api_register_lock = threading.Lock()

    def _try_register_web_api_once() -> bool:
        global _web_api_registered
        with _web_api_register_lock:
            if _web_api_registered:
                return True
            try:
                from .model_discovery import patch_lora_stack_nodes
                patch_lora_stack_nodes()
            except Exception:
                pass
            prompt_instance = getattr(server.PromptServer, "instance", None)
            if prompt_instance is None:
                return False
            try:
                # Primary path (aiohttp app router)
                web_api.setup(getattr(prompt_instance, "app", None))
                # Fallback path for environments that expose route table differently
                web_api.setup(prompt_instance)
                _web_api_registered = True
                print("[ComfyUI_HuggingFace_Downloader] Web API routes registered.")
                return True
            except Exception as inner_error:
                print(f"[ComfyUI_HuggingFace_Downloader] Web API registration attempt failed: {inner_error}")
                return False

    def _register_web_api_with_retry():
        # PromptServer.instance can be unavailable at extension import time.
        for _ in range(120):  # up to ~60s
            try:
                from .model_discovery import patch_lora_stack_nodes
                patch_lora_stack_nodes()
            except Exception:
                pass
            if _try_register_web_api_once():
                return
            time.sleep(0.5)
        print("[ComfyUI_HuggingFace_Downloader] Web API registration timed out waiting for PromptServer.instance.")

    if not _try_register_web_api_once():
        threading.Thread(target=_register_web_api_with_retry, daemon=True).start()
except Exception as e:
    print(f"[ComfyUI_HuggingFace_Downloader] Web API not loaded: {e}")


_EMPTY_DEFAULT_WORKFLOW_GRAPH = {
    "last_node_id": 0,
    "last_link_id": 0,
    "nodes": [],
    "links": [],
    "groups": [],
    "config": {},
    "extra": {},
    "version": 0.4,
}


def _dedupe_existing_paths(paths):
    seen = set()
    result = []
    for p in paths:
        ap = os.path.abspath(p)
        if ap not in seen:
            seen.add(ap)
            result.append(ap)
    return result


def _ensure_empty_default_workflow() -> None:
    """Enforce blankGraph as ComfyUI's startup workflow across settings, JSON, and frontend assets."""
    comfy_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    roots = _dedupe_existing_paths(["/workspace/ComfyUI", "/Comfy", comfy_root])

    settings_candidates = _dedupe_existing_paths(
        [
            "/workspace/ComfyUI/user/default/comfy.settings.json",
            "/Comfy/user/default/comfy.settings.json",
            os.path.join(comfy_root, "user", "default", "comfy.settings.json"),
        ]
    )
    for settings_path in settings_candidates:
        parent = os.path.dirname(settings_path)
        if not os.path.isdir(parent):
            continue
        try:
            data = {}
            if os.path.isfile(settings_path):
                with open(settings_path, "r", encoding="utf-8") as fh:
                    raw = fh.read().strip()
                if raw:
                    loaded = json.loads(raw)
                    if isinstance(loaded, dict):
                        data = loaded
            changed = (
                data.get("Comfy.TutorialCompleted") is not True
                or "Comfy.Workflow.Default" in data
                or "Comfy.Workspace.WorkflowOnLoad" in data
            )
            data["Comfy.TutorialCompleted"] = True
            data.pop("Comfy.Workflow.Default", None)
            data.pop("Comfy.Workspace.WorkflowOnLoad", None)
            if changed or not os.path.isfile(settings_path):
                tmp = f"{settings_path}.tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(data, fh, indent=4)
                    fh.write("\n")
                os.replace(tmp, settings_path)
                print(
                    f"[ComfyUI_HuggingFace_Downloader] Enforced empty-startup settings in {settings_path}"
                )
        except Exception as exc:
            print(
                f"[ComfyUI_HuggingFace_Downloader] Failed updating {settings_path}: {exc}"
            )

    blank_json = json.dumps(_EMPTY_DEFAULT_WORKFLOW_GRAPH, separators=(",", ":")) + "\n"
    for root_dir in roots:
        if not os.path.isdir(root_dir):
            continue
        dw_path = os.path.join(root_dir, "default_workflow.json")
        try:
            if os.path.isfile(dw_path):
                with open(dw_path, "r", encoding="utf-8") as fh:
                    if fh.read() == blank_json:
                        continue
            tmp = f"{dw_path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(blank_json)
            os.replace(tmp, dw_path)
            print(
                f"[ComfyUI_HuggingFace_Downloader] Wrote empty default workflow to {dw_path}"
            )
        except Exception as exc:
            print(
                f"[ComfyUI_HuggingFace_Downloader] Failed writing {dw_path}: {exc}"
            )

    asset_dirs = []
    seen_dirs = set()

    def _add_asset_dir(path: str) -> None:
        ap = os.path.abspath(path)
        if ap not in seen_dirs and os.path.isdir(ap):
            seen_dirs.add(ap)
            asset_dirs.append(ap)

    try:
        spec = importlib.util.find_spec("comfyui_frontend_package")
    except Exception:
        spec = None
    if spec:
        locations = list(spec.submodule_search_locations or [])
        if not locations and spec.origin:
            locations = [os.path.dirname(spec.origin)]
        for loc in locations:
            _add_asset_dir(os.path.join(loc, "static", "assets"))

    for pattern in (
        "/opt/comfyui-venv/lib/python*/site-packages/comfyui_frontend_package/static/assets",
        "/workspace/ComfyUI/venv/lib/python*/site-packages/comfyui_frontend_package/static/assets",
        "/workspace/.venv/lib/python*/site-packages/comfyui_frontend_package/static/assets",
        "/usr/local/lib/python*/dist-packages/comfyui_frontend_package/static/assets",
        "/usr/local/lib/python*/site-packages/comfyui_frontend_package/static/assets",
    ):
        for match in glob.glob(pattern):
            _add_asset_dir(match)

    pat = re.compile(
        r"window\.comfyAPI\.defaultGraph\.defaultGraph\s*=\s*([A-Za-z0-9_$]+)[,;]\s*"
        r"window\.comfyAPI\.defaultGraph\.defaultGraphJSON\s*=\s*([A-Za-z0-9_$]+)[,;]\s*"
        r"window\.comfyAPI\.defaultGraph\.blankGraph\s*=\s*([A-Za-z0-9_$]+)"
    )

    for assets_dir in asset_dirs:
        candidates = sorted(glob.glob(os.path.join(assets_dir, "workflowStore-*.js")))
        other_js = sorted(
            p for p in glob.glob(os.path.join(assets_dir, "*.js"))
            if p not in candidates
        )
        for js_path in candidates + other_js:
            try:
                with open(js_path, "r", encoding="utf-8") as fh:
                    text = fh.read()
                if "window.comfyAPI.defaultGraph.defaultGraph" not in text:
                    continue
                m = pat.search(text)
                if not m:
                    continue
                dg_var, json_var, blank_var = m.group(1), m.group(2), m.group(3)
                prefix_window = text[max(0, m.start() - 160) : m.start()]
                if f"Object.keys({dg_var}).forEach" in prefix_window:
                    break
                injection = (
                    f"Object.keys({dg_var}).forEach(k=>delete {dg_var}[k]),"
                    f"Object.assign({dg_var},{blank_var}),"
                    f"{json_var}=JSON.stringify({blank_var}),"
                )
                new_text = text[: m.start()] + injection + text[m.start() :]
                tmp = f"{js_path}.tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    fh.write(new_text)
                os.replace(tmp, js_path)
                print(
                    f"[ComfyUI_HuggingFace_Downloader] Patched defaultGraph to blankGraph in {js_path}"
                )
                break
            except Exception as exc:
                print(
                    f"[ComfyUI_HuggingFace_Downloader] Failed patching {js_path}: {exc}"
                )


try:
    _ensure_empty_default_workflow()
except Exception as exc:
    print(f"[ComfyUI_HuggingFace_Downloader] Empty default workflow check failed: {exc}")
