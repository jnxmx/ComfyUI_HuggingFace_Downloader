import os
from server import PromptServer
from ..modules.downloaders import HuggingFaceDownloader
from ..utils.file_helpers import create_folder, clear_cache

class HuggingFaceDownloaderNode:
    @classmethod
    def INPUT_TYPES(cls):
        prioritized_folders = [
            "checkpoints", "loras", "controlnet", "vae", "diffusion_models", "clip", "upscale_models", "clip_vision"
        ]

        # Fetch only first-level folders in the models directory
        models_dir = os.path.abspath("models")
        first_level_folders = []
        if os.path.exists(models_dir):
            first_level_folders = [
                folder for folder in os.listdir(models_dir)
                if os.path.isdir(os.path.join(models_dir, folder))
            ]

        # Combine prioritized folders with others, maintaining their order
        combined_folders = prioritized_folders + sorted(set(first_level_folders) - set(prioritized_folders))

        return {
            "required": {
                "local_folder": (combined_folders, {}),
                "subfolder": ("STRING", {"default": ""}),
                "download_file": ("STRING", {"multiline": True, "default": ""}),
                "download_folder": ("STRING", {"multiline": True, "default": ""}),
                "huggingface_token": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "manage_downloads"
    CATEGORY = "downloader"

    def __init__(self):
        self.status = "Idle"
        self.progress = 0.0
        self.node_id = None

    def set_progress(self, percentage):
        self.update_status(f"Downloading... {percentage:.1f}%", percentage)

    def update_status(self, status_text, progress=None):
        if progress is not None and hasattr(self, 'node_id'):
            PromptServer.instance.send_sync("progress", {
                "node": self.node_id,
                "value": progress,
                "max": 100
            })

    def manage_downloads(self, local_folder, subfolder, download_file, download_folder, huggingface_token):
        """
        Handles the download process for files and folders from Hugging Face.
        """
        # Prepare the base directory for downloads
        base_path = create_folder(local_folder, subfolder)

        # Clear cache before starting downloads
        clear_cache()

        downloaded_files = []

        # Handle individual file downloads
        if download_file.strip():
            downloaded_files.extend(
                HuggingFaceDownloader.download_files(download_file, base_path, token=huggingface_token)
            )

        # Handle folder or repository downloads
        if download_folder.strip():
            downloaded_files.extend(
                HuggingFaceDownloader.download_folders(download_folder, base_path, token=huggingface_token)
            )

        # Update the node's status and progress
        self.status = f"Downloaded {len(downloaded_files)} files."
        self.set_progress(100)

        return {
            "ui": {
                "text": f"Downloaded {len(downloaded_files)} files.\n" + "\n".join(downloaded_files)
            }
        }

