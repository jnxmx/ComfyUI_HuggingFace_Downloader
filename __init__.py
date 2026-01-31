from .HuggingFaceDownloadModel import HuggingFaceDownloadModel
from .HuggingFaceDownloadFolder import HuggingFaceDownloadFolder

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
    import threading
    import time

    def _try_setup_routes() -> bool:
        instance = getattr(server.PromptServer, "instance", None)
        if instance is None:
            return False
        try:
            routes = getattr(instance, "routes", None)
            if routes is not None:
                web_api.setup(routes)
            else:
                web_api.setup(instance.app)
            return True
        except Exception:
            return False

    if not _try_setup_routes():
        def _delayed_setup():
            for _ in range(20):
                if _try_setup_routes():
                    return
                time.sleep(0.5)
            print("[ComfyUI_HuggingFace_Downloader] Web API not loaded: PromptServer not ready")

        threading.Thread(target=_delayed_setup, daemon=True).start()
except Exception as e:
    print(f"[ComfyUI_HuggingFace_Downloader] Web API not loaded: {e}")
