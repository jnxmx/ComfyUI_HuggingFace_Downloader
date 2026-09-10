import os
import threading
from comfy_api.latest import io

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

class HuggingFaceDownloadModel(io.ComfyNode):
    OUTPUT_NODE = True
    
    @classmethod
    def define_schema(cls):
        options = []
        for f in _make_target_folder_list():
            if f == "custom":
                options.append(io.DynamicCombo.Option("custom", [io.String.Input("custom_path", default="")]))
            else:
                options.append(io.DynamicCombo.Option(f, []))

        return io.Schema(
            node_id="Hugging Face Download Model",
            display_name="Hugging Face Download Model",
            category="Hugging Face Downloaders 🤗",
            inputs=[
                io.DynamicCombo.Input("target_folder", options=options),
                io.String.Input("link", default="")
            ],
            outputs=[
                io.AnyType.Output(display_name="model name")
            ]
        )

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

    @classmethod
    def execute(cls, target_folder: dict, link: str) -> io.NodeOutput:
        from .parse_link import parse_link
        from .downloader import run_download

        selected_folder = target_folder["target_folder"]
        custom_path = target_folder.get("custom_path", "")

        from .file_manager import sanitize_rel_folder

        # Step 1: final_folder logic
        if selected_folder == "custom":
            safe_custom = sanitize_rel_folder(custom_path)
            if not safe_custom:
                return io.NodeOutput("Error: custom_path cannot be empty or contain invalid/traversal characters.")
            final_folder = safe_custom
        else:
            final_folder = sanitize_rel_folder(selected_folder) or "checkpoints"

        # Step 2: parse link
        try:
            parsed = parse_link(link)
        except Exception as e:
            return io.NodeOutput(f"Error parsing link: {e}")

        # Step 3: sync download
        try:
            final_message, local_path = run_download(parsed, final_folder, sync=True)
        except Exception as e:
            print(f"[ERROR] Download failed: {e}")
            return io.NodeOutput(f"Error downloading model: {e}")

        if local_path:
            try:
                import server
                import folder_paths
                if hasattr(folder_paths, "clear_cache"):
                    folder_paths.clear_cache()
                server.PromptServer.instance.send_sync("hf_download_finished", {"path": local_path})
            except Exception:
                pass

            # user wants leftover + "/" + filename if custom
            filename = os.path.basename(local_path)
            if selected_folder == "custom":
                segments = safe_custom.split("/")
                if len(segments) > 1:
                    leftover = "/".join(segments[1:]).strip("/")
                    if leftover:
                        return io.NodeOutput(leftover + "/" + filename)
                    else:
                        return io.NodeOutput(filename)
                else:
                    return io.NodeOutput(filename)
            else:
                return io.NodeOutput(filename)
        else:
            return io.NodeOutput("")
