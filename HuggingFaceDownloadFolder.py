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
    return ["custom"] + subfolders

class HuggingFaceDownloadFolder:
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
    RETURN_NAMES = ("folder name",)
    FUNCTION = "download_folder"

    def download_folder(self, target_folder, link, custom_path="", token="", download_in_background=False):
        """
        1) If target_folder == 'custom', interpret custom_path as final_folder.
        2) parse link => we get subfolder path + last_segment
        3) run_download_folder
        4) The node output: if using a custom path with multiple segments, we remove the first segment of custom_path
           and then join the leftover with the last subfolder name from the link. That is the user’s #3 request.
        """
        from .parse_link import parse_link
        from .downloader import run_download_folder
        import os

        # Step 1: final_folder is either picked from combo or custom
        if target_folder == "custom":
            final_folder = custom_path.strip().rstrip("/\\")
        else:
            final_folder = target_folder.strip().rstrip("/\\")

        # Step 2: parse link
        try:
            parsed = parse_link(link)
        except Exception as e:
            return (f"Error parsing link: {e}",)

        remote_subfolder_path = parsed.get("subfolder", "").strip("/")
        # The last segment => e.g. "fp4"
        last_segment = os.path.basename(remote_subfolder_path) if remote_subfolder_path else ""

        # We'll do background or sync
        if download_in_background:
            threading.Thread(
                target=run_download_folder,
                args=(parsed, final_folder, token, remote_subfolder_path, last_segment),
                daemon=True
            ).start()
        else:
            run_download_folder(parsed, final_folder, token, remote_subfolder_path, last_segment, sync=True)

        # Step 4: Node output name for the folder
        # If user used a custom path that has multiple segments (like "LLM/BrandX"),
        # we remove the first segment "LLM" and keep leftover "BrandX". Then we add last_segment => "BrandX/fp4".
        # If there's only one segment => leftover is "", => "fp4".
        if target_folder == "custom":
            # parse custom_path into segments
            segments = custom_path.strip("/\\").split("/")
            if len(segments) > 1:
                leftover_segments = segments[1:]  # remove first
                leftover = "/".join(leftover_segments).strip("/")
                if leftover and last_segment:
                    return (leftover + "/" + last_segment,)
                elif leftover:
                    return (leftover,)
                elif last_segment:
                    return (last_segment,)
                else:
                    return ("",)
            else:
                # if the custom_path is single segment => leftover is empty => just last_segment
                if last_segment:
                    return (last_segment,)
                else:
                    return ("",)
        else:
            # normal scenario => just last_segment if any
            if last_segment:
                return (last_segment + "/",)
            else:
                return ("",)
