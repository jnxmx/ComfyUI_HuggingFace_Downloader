from .nodes.huggingface_downloader import HuggingFaceDownloaderNode

NODE_CLASS_MAPPINGS = {
    "HuggingFace Downloader": HuggingFaceDownloaderNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HuggingFace Downloader": "HuggingFace Downloader Node",
}
