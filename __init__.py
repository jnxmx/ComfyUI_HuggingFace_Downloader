from .HuggingFaceDownloadModel import HuggingFaceDownloadModel
from .HuggingFaceDownloadFolder import HuggingFaceDownloadFolder

NODE_CLASS_MAPPINGS = {
    "Hugging Face Download Model": HuggingFaceDownloadModel,
    "Hugging Face Download Folder": HuggingFaceDownloadFolder,
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]
