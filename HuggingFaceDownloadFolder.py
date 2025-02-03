import threading
import os

class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

any_typ = AnyType("*")

class HuggingFaceDownloadFolder:
    CATEGORY = "Hugging Face Downloaders"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        from .file_manager import get_model_subfolders
        return {
            "required": {
                "link": ("STRING",),
                "target_folder": (get_model_subfolders(), {"default": "vae"}),
            },
            "optional": {
                "token": ("STRING", {"forceInput": True, "default": ""}),
                "custom_path": ("STRING", {"default": ""}),
                "download_in_background": ("BOOLEAN", {"default": False, "label": "Download in background"}),
            }
        }

    RETURN_TYPES = (any_typ,)
    RETURN_NAMES = ("folder name",)
    FUNCTION = "download_folder"

    def download_folder(self, link, target_folder, token="", custom_path="", download_in_background=False):
        from .parse_link import parse_link
        try:
            parsed = parse_link(link)
        except Exception as e:
            return (f"Error parsing link: {e}",)
        
        # Determine remote folder: if parsed subfolder exists, use it; otherwise use repo's second part.
        remote_folder = parsed.get("subfolder", "").strip("/")
        if not remote_folder:
            repo = parsed.get("repo", "")
            if "/" in repo:
                remote_folder = repo.split("/")[1]
            else:
                remote_folder = repo

        base = target_folder.strip("/")
        if custom_path.strip():
            final_folder = custom_path.strip().replace("\\", "/")
        else:
            final_folder = base

        # For folder downloads, the local folder name is the remote folder.
        local_folder_name = remote_folder
        output_connector = local_folder_name + "/"

        if not token:
            token = os.environ.get("HF_TOKEN", "")

        from .downloader import run_download_folder
        if download_in_background:
            threading.Thread(
                target=run_download_folder,
                args=(parsed, final_folder, token, remote_folder, local_folder_name, False),
                daemon=True
            ).start()
            return (output_connector,)
        else:
            final_message, local_path = run_download_folder(parsed, final_folder, token, remote_folder, local_folder_name, sync=True)
            return (output_connector,)
