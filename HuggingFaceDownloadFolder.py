import os
import threading

class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

any_typ = AnyType("*")

def _make_target_folder_list():
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
        1) If user picks 'custom', final_folder= custom_path, else final_folder= target_folder
        2) parse link => subfolder path => last_segment
           if subfolder empty => use second half of the repo => "clip-vit-large-patch14"
        3) call run_download_folder
        4) final node output => leftover from custom path minus first segment + last_segment
        """
        from .parse_link import parse_link
        from .downloader import run_download_folder
        import os

        if target_folder == "custom":
            final_folder = custom_path.strip().rstrip("/\\")
        else:
            final_folder = target_folder.strip().rstrip("/\\")

        try:
            parsed = parse_link(link)
        except Exception as e:
            return (f"Error parsing link: {e}",)

        remote_subfolder_path = parsed.get("subfolder", "").strip("/")
        if not remote_subfolder_path:
            # if empty => last_segment= second half of repo => e.g. "openai/clip-vit-large-patch14" => "clip-vit-large-patch14"
            splitted = parsed["repo"].split("/",1)
            if len(splitted)>1:
                last_segment = splitted[1]
            else:
                last_segment = splitted[0]
        else:
            last_segment = os.path.basename(remote_subfolder_path)

        if download_in_background:
            threading.Thread(
                target=run_download_folder,
                args=(parsed, final_folder, token, remote_subfolder_path, last_segment),
                daemon=True
            ).start()
        else:
            run_download_folder(parsed, final_folder, token, remote_subfolder_path, last_segment, sync=True)

        # node output => leftover + last_segment if custom
        if target_folder=="custom":
            segments=custom_path.strip("/\\").split("/")
            if len(segments)>1:
                leftover_segments=segments[1:]
                leftover="/".join(leftover_segments).strip("/")
                if leftover and last_segment:
                    return (leftover + "/" + last_segment,)
                elif leftover:
                    return (leftover,)
                elif last_segment:
                    return (last_segment,)
                else:
                    return ("",)
            else:
                if last_segment:
                    return (last_segment,)
                else:
                    return ("",)
        else:
            if last_segment:
                return (last_segment + "/",)
            else:
                return ("",)
