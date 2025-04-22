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

class HuggingFaceDownloadModel:
    CATEGORY = "Hugging Face Downloaders 🤗"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "target_folder": (_make_target_folder_list(), {"default": "loras"}),
                "link": ("STRING", {"default": ""}),
            },
            "optional": {
                "custom_path": ("STRING", {"default": ""})
                #,
                #"download_in_background": ("BOOLEAN", {"default": False, "label": "Download in background"}),
            }
        }

    @staticmethod
    def update_link_field(new_value, old_value):
        """
        Update the link field to show the parsed view.
        """
        from .parse_link import parse_link
        try:
            parsed = parse_link(new_value)
            repo = parsed.get("repo", "")
            subfolder = parsed.get("subfolder", "").strip("/")
            file = parsed.get("file", "").strip("/")
            updated_value = "/".join(filter(None, [repo, subfolder, file]))
            return updated_value
        except Exception as e:
            print(f"[ERROR] Failed to parse link: {e}")
            return new_value

    RETURN_TYPES = (any_typ,)
    RETURN_NAMES = ("model name",)
    FUNCTION = "download_model"

    def download_model(self, target_folder, link, custom_path="", download_in_background=False):
        """
        1) If user picks 'custom' in the combo, we interpret custom_path as final_folder, else just target_folder.
        2) parse link => subfolder/file for single file
        3) call run_download(...) which uses hf_hub_download so hf_transfer can be used
        4) node's return:
           - if target_folder != 'custom', we do just the filename
           - if 'custom', remove the first segment of custom_path (if any), then leftover + "/" + filename
        """
        from .parse_link import parse_link
        from .downloader import run_download

        # Step 1: final_folder logic
        if target_folder == "custom":
            final_folder = custom_path.strip().rstrip("/\\")
        else:
            final_folder = target_folder.strip().rstrip("/\\")

        # Step 2: parse link
        try:
            parsed = parse_link(link)
        except Exception as e:
            return (f"Error parsing link: {e}",)

        # Step 3: run in background or sync
        if download_in_background:
            threading.Thread(
                target=run_download,
                args=(parsed, final_folder),
                daemon=True
            ).start()
            # best guess: use parsed["file"]
            if "file" in parsed:
                guessed_file = parsed["file"].strip("/")
                # if user used 'custom', do leftover logic
                if target_folder == "custom":
                    segments = custom_path.strip("/\\").split("/")
                    if len(segments) > 1:
                        leftover = "/".join(segments[1:]).strip("/")
                        if leftover:
                            return (leftover + "/" + os.path.basename(guessed_file),)
                        else:
                            return (os.path.basename(guessed_file),)
                    else:
                        return (os.path.basename(guessed_file),)
                else:
                    return (os.path.basename(guessed_file),)
            else:
                return ("",)  # no file known
        else:
            # sync => we get final_message and local_path
            final_message, local_path = run_download(parsed, final_folder, sync=True)
            if local_path:
                # user wants leftover + "/" + filename if custom
                filename = os.path.basename(local_path)
                if target_folder == "custom":
                    segments = custom_path.strip("/\\").split("/")
                    if len(segments) > 1:
                        leftover = "/".join(segments[1:]).strip("/")
                        if leftover:
                            return (leftover + "/" + filename,)
                        else:
                            return (filename,)
                    else:
                        return (filename,)
                else:
                    return (filename,)
            else:
                return ("",)
