import os
import subprocess
import logging
from comfy.utils import ProgressBar
from folder_paths import get_folder_paths, folder_names_and_paths

class HuggingFaceModelSelector:
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
                "links_to_files": ("STRING", {"multiline": True, "default": ""}),
                "links_to_folders": ("STRING", {"multiline": True, "default": ""}),
                "model_type": (combined_folders, {}),
            }
        }

    RETURN_TYPES = ("HF_LINK",)
    FUNCTION = "process_links"
    CATEGORY = "model_selector"

    def process_links(self, links_to_files, links_to_folders, model_type):
        def parse_link(link):
            try:
                if "resolve/main" in link:
                    parts = link.split("resolve/main/")
                    repo_id = parts[0].split("huggingface.co/")[-1].strip("/")
                    file_path = parts[1].split("?")[0]  # Remove query parameters
                else:
                    repo_id = link.split("huggingface.co/")[-1].strip("/")
                    file_path = None
                return repo_id, file_path
            except Exception as e:
                logging.error(f"Failed to parse Hugging Face link: {link}. Error: {e}")
                return None, None

        files = [
            {
                "repo_id": parse_link(link)[0],
                "file_path": parse_link(link)[1],
                "model_type": model_type
            }
            for link in links_to_files.splitlines() if link.strip()
        ]

        folders = [
            {
                "repo_id": parse_link(link)[0],
                "file_path": None,
                "model_type": model_type
            }
            for link in links_to_folders.splitlines() if link.strip()
        ]

        links = files + folders
        return (links,)

class HuggingFaceDownloader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "huggingface_token": ("STRING", {"default": ""}),
                "HF_LINK_1": ("HF_LINK", {"forceInput": True}),
            },
            "optional": {
                f"HF_LINK_{i+2}": ("HF_LINK", {"forceInput": True}) for i in range(9)  # HF_LINK_2 to HF_LINK_10
            },
        }

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "download_links"
    CATEGORY = "downloader"

    def download_links(self, HF_LINK_1, huggingface_token, **hf_links):
        all_links = HF_LINK_1 + sum(hf_links.values(), [])  # Combine required and optional HF_LINKs
        downloaded_files = []
        total_size = 0  # Track total size of downloaded files in bytes

        if all_links:
            pbar = ProgressBar(len(all_links))

            for link in all_links:
                try:
                    repo_id = link.get("repo_id")
                    file_path = link.get("file_path")
                    model_type = link.get("model_type", "misc")

                    if repo_id is None:
                        continue

                    output_dir = os.path.abspath(f"models/{model_type}")

                    if not os.path.exists(output_dir):
                        os.makedirs(output_dir)

                    command = [
                        "huggingface-cli", "download", repo_id
                    ]

                    if file_path:
                        command.append(file_path)

                    command.extend(["--local-dir", output_dir])

                    if huggingface_token:
                        command.extend(["--use-auth-token", huggingface_token])

                    subprocess.run(command, check=True)

                    # Calculate the size of the downloaded file
                    if file_path:
                        full_path = os.path.join(output_dir, file_path)
                        if os.path.exists(full_path):
                            file_size = os.path.getsize(full_path)
                            total_size += file_size
                            downloaded_files.append(full_path)
                    else:
                        downloaded_files.append(output_dir)

                    pbar.update(1)

                except Exception as e:
                    logging.error(f"Error downloading {repo_id}/{file_path}: {e}")

        # Convert total size to megabytes for display
        total_size_mb = total_size / (1024 ** 2)
        summary_text = f"Downloaded {len(downloaded_files)} files totaling {total_size_mb:.2f} MB."

        # Log the summary to the console
        logging.info(summary_text)

        # Display the downloaded files and total size on the node
        display_text = "\n".join(downloaded_files) if downloaded_files else "No files downloaded."
        return {
            "ui": {
                "text": f"{summary_text}\n\n{display_text}"
            }
        }

NODE_CLASS_MAPPINGS = {
    "HuggingFace Model Selector": HuggingFaceModelSelector,
    "HuggingFace Downloader": HuggingFaceDownloader
}
