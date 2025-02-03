import threading
import os

class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

any_typ = AnyType("*")

class HuggingFaceDownloadModel:
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
    RETURN_NAMES = ("model name",)
    FUNCTION = "download_model"

    def download_model(self, link, target_folder, token="", custom_path="", download_in_background=False):
        from .parse_link import parse_link
        try:
            parsed = parse_link(link)
        except Exception as e:
            return (f"Error parsing link: {e}",)
        if "file" not in parsed:
            return ("No file specified in link",)

        # Remote filename: preserve full remote path.
        parsed_file = parsed["file"].strip("/")
        parsed_sub = parsed.get("subfolder", "").strip("/")
        if parsed_sub:
            remote_filename = f"{parsed_sub}/{parsed_file}"
        else:
            remote_filename = parsed_file

        # Local saving: for single file downloads, drop the parsed subfolder.
        base = target_folder.strip("/")
        if custom_path.strip():
            final_folder = custom_path.strip().replace("\\", "/")
        else:
            final_folder = base
        local_filename = parsed_file
        output_connector = parsed_file

        if not token:
            token = os.environ.get("HF_TOKEN", "")

        from .downloader import run_download
        if download_in_background:
            threading.Thread(
                target=run_download,
                args=(parsed, final_folder, token, remote_filename, local_filename, False),
                daemon=True
            ).start()
            return (output_connector,)
        else:
            final_message, local_path = run_download(parsed, final_folder, token, remote_filename, local_filename, sync=True)
            return (output_connector,)
