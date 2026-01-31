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
    routes = getattr(server.PromptServer.instance, "routes", None)
    if routes is not None:
        web_api.setup(routes)
        print("[ComfyUI_HuggingFace_Downloader] Web API routes registered")
    else:
        print("[ComfyUI_HuggingFace_Downloader] Web API not loaded: PromptServer routes not available")
except Exception as e:
    print(f"[ComfyUI_HuggingFace_Downloader] Web API not loaded: {e}")
