
import os
import json

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
            if _try_register_web_api_once():
                return
            time.sleep(0.5)
        print("[ComfyUI_HuggingFace_Downloader] Web API registration timed out waiting for PromptServer.instance.")

    if not _try_register_web_api_once():
        threading.Thread(target=_register_web_api_with_retry, daemon=True).start()
except Exception as e:
    print(f"[ComfyUI_HuggingFace_Downloader] Web API not loaded: {e}")
