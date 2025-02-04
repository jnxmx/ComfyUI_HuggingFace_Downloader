import os
import threading

class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

any_typ = AnyType("*")

def _make_target_folder_list():
    """
    Returns a list with 'custom' as the first option,
    plus all subfolders from get_model_subfolders.
    """
    from .file_manager import get_model_subfolders
    subfolders = get_model_subfolders()
    # Insert 'custom' at the front:
    return ["custom"] + subfolders

class HuggingFaceDownloadModel:
    CATEGORY = "Hugging Face Downloaders"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "target_folder": (_make_target_folder_list(), {"default": "loras"}),
                "link": ("STRING",),
            },
            "optional": {
                "custom_path": ("STRING", {"default": ""}),
                "token": ("STRING", {"forceInput": True, "default": ""}),
                "download_in_background": ("BOOLEAN", {"default": False, "label": "Download in background"}),
            }
        }

    RETURN_TYPES = (any_typ,)
    RETURN_NAMES = ("model name",)
    FUNCTION = "download_model"

    def download_model(self, target_folder, link, custom_path="", token="", download_in_background=False):
        """
        1. If target_folder == 'custom', we interpret custom_path as final_folder.
        2. Else final_folder = target_folder.
        3. Then parse link for single-file info, run run_download.
        4. Return the file name as the node's output. (No special logic for removing segments.)
        """
        from .parse_link import parse_link
        from .downloader import run_download

        # 1) Determine final_folder from the user's picks
        if target_folder == "custom":
            # user typed something like 'loras/test2'
            final_folder = custom_path.strip().rstrip("/\\")
        else:
            final_folder = target_folder.strip().rstrip("/\\")

        # 2) parse link => may yield subfolder, file, etc.
        try:
            parsed = parse_link(link)
        except Exception as e:
            return (f"Error parsing link: {e}",)

        # If it's missing 'file', we might do something else, but let's proceed:
        # We'll let run_download handle the scenario for single file.

        # 3) We'll do a background or sync call
        if download_in_background:
            threading.Thread(
                target=run_download,
                args=(parsed, final_folder, token),
                daemon=True
            ).start()
            # We can't know the final file name if we're backgrounding, but let's guess
            if "file" in parsed:
                return (parsed["file"],)
            else:
                return ("",)
        else:
            final_message, local_path = run_download(parsed, final_folder, token, sync=True)
            # We'll guess we want to return the file name from the local_path
            if local_path:
                return (os.path.basename(local_path),)
            else:
                return ("",)
