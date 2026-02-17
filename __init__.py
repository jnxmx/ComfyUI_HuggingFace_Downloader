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
    prompt_instance = getattr(server.PromptServer, "instance", None)
    if prompt_instance is not None:
        # Primary path (aiohttp app router)
        web_api.setup(getattr(prompt_instance, "app", None))
        # Fallback path for environments that expose route table differently
        web_api.setup(prompt_instance)
    else:
        print("[ComfyUI_HuggingFace_Downloader] PromptServer.instance is not available; web API not registered.")
except Exception as e:
    print(f"[ComfyUI_HuggingFace_Downloader] Web API not loaded: {e}")
