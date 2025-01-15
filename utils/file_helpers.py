import os
import shutil
import logging

def create_folder(local_folder, subfolder):
    base_path = os.path.abspath(f"models/{local_folder}")
    if subfolder:
        base_path = os.path.join(base_path, subfolder.strip("/"))
    os.makedirs(base_path, exist_ok=True)
    return base_path

def clear_cache():
    cache_dir = os.path.expanduser("~/.cache/huggingface")
    if os.path.exists(cache_dir):
        try:
            shutil.rmtree(cache_dir)
            logging.info("Cleared Hugging Face cache directory.")
        except Exception as e:
            logging.error(f"Failed to clear cache directory: {e}")
