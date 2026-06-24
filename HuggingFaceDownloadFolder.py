import os
import threading
from comfy_api.latest import io

class AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False

any_typ = AnyType("*")

def _make_target_folder_list():
    from .file_manager import get_model_subfolders
    subfolders = get_model_subfolders()
    return ["custom"] + subfolders

class HuggingFaceDownloadFolder(io.ComfyNode):
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
            node_id="HuggingFaceDownloadFolder",
            display_name="Hugging Face Download Folder",
            category="Hugging Face Downloaders 🤗",
            inputs=[
                io.DynamicCombo.Input("target_folder", options=options),
                io.String.Input("link", default=""),
                io.Boolean.Input("download_in_background", default=False, tooltip="Download in background")
            ],
            outputs=[
                io.AnyType.Output(display_name="folder name")
            ]
        )

    @staticmethod
    def update_link_field(new_value, old_value):
        """
        Update the link field to show the parsed view (repo+/+subfolder).
        """
        from .parse_link import parse_link
        try:
            parsed = parse_link(new_value)
            repo = parsed.get("repo", "")
            subfolder = parsed.get("subfolder", "").strip("/")
            updated_value = "/".join(filter(None, [repo, subfolder]))
            return updated_value
        except Exception as e:
            print(f"[ERROR] Failed to parse link: {e}")
            return new_value

    @classmethod
    def execute(cls, target_folder: dict, link: str, download_in_background: bool) -> io.NodeOutput:
        from .parse_link import parse_link
        from .downloader import run_download_folder

        selected_folder = target_folder["target_folder"]
        custom_path = target_folder.get("custom_path", "")

        # Step 1: final_folder logic
        if selected_folder == "custom":
            final_folder = custom_path.strip().rstrip("/\\")
        else:
            final_folder = selected_folder.strip().rstrip("/\\")

        # Step 2: parse link
        try:
            parsed = parse_link(link)
        except Exception as e:
            return io.NodeOutput((f"Error parsing link: {e}",))

        remote_subfolder_path = parsed.get("subfolder", "").strip("/")
        if not remote_subfolder_path:
            # if empty => last_segment = second half of repo => e.g. "openai/clip-vit-large-patch14" => "clip-vit-large-patch14"
            splitted = parsed["repo"].split("/",1)
            if len(splitted)>1:
                last_segment = splitted[1]
            else:
                last_segment = splitted[0]
        else:
            last_segment = os.path.basename(remote_subfolder_path)

        # Step 3: run in background or sync
        if download_in_background:
            threading.Thread(
                target=run_download_folder,
                args=(parsed, final_folder),
                kwargs={"remote_subfolder_path": remote_subfolder_path, "last_segment": last_segment},
                daemon=True
            ).start()
        else:
            run_download_folder(
                parsed, 
                final_folder,
                remote_subfolder_path=remote_subfolder_path,
                last_segment=last_segment,
                sync=True
            )

        # node output => leftover + last_segment if custom
        if selected_folder=="custom":
            segments=custom_path.strip("/\\").split("/")
            if len(segments)>1:
                leftover_segments=segments[1:]
                leftover="/".join(leftover_segments).strip("/")
                if leftover and last_segment:
                    return io.NodeOutput((leftover + "/" + last_segment,))
                elif leftover:
                    return io.NodeOutput((leftover,))
                elif last_segment:
                    return io.NodeOutput((last_segment,))
                else:
                    return io.NodeOutput(("",))
            else:
                if last_segment:
                    return io.NodeOutput((last_segment,))
                else:
                    return io.NodeOutput(("",))
        else:
            if last_segment:
                return io.NodeOutput((last_segment + "/",))
            else:
                return io.NodeOutput(("",))

