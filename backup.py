import os
import shutil
from dotenv import load_dotenv
from huggingface_hub import HfApi
from .parse_link import parse_link

load_dotenv()
token = os.getenv("HF_TOKEN_FOR_HFD") or os.getenv("HF_TOKEN")

def backup_to_huggingface(repo_name_or_link, folders, size_limit_gb):
    """
    Backup specified folders to a Hugging Face repository.
    """
    api = HfApi()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    # Parse repo name if a link is provided
    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

    for folder in folders:
        folder = folder.strip()
        if not os.path.exists(folder):
            print(f"[WARNING] Folder '{folder}' does not exist. Skipping.")
            continue

        for root, _, files in os.walk(folder):
            for file in files:
                file_path = os.path.join(root, file)
                file_size_gb = os.path.getsize(file_path) / (1024 ** 3)
                if file_size_gb > size_limit_gb:
                    print(f"[WARNING] File '{file}' exceeds size limit ({file_size_gb:.2f} GB). Skipping.")
                    continue

                dest_path = os.path.relpath(file_path, folder)
                print(f"[INFO] Checking '{repo_name}/{dest_path}' for updates...")

                # Check if the file exists in the repository and compare timestamps
                try:
                    repo_file_info = api.repo_file_info(repo_id=repo_name, path_in_repo=dest_path, token=token)
                    repo_last_modified = repo_file_info.lastModified
                    local_last_modified = os.path.getmtime(file_path)

                    if local_last_modified <= repo_last_modified.timestamp():
                        print(f"[INFO] Skipping '{file_path}' as it is not newer than the repository version.")
                        continue
                except Exception:
                    # If the file does not exist in the repository, proceed with upload
                    pass

                print(f"[INFO] Uploading '{file_path}' to '{repo_name}/{dest_path}'...")
                api.upload_file(
                    path_or_fileobj=file_path,
                    path_in_repo=dest_path,
                    repo_id=repo_name,
                    token=token,
                )

def restore_from_huggingface(repo_name_or_link):
    """
    Restore folders from a Hugging Face repository.
    """
    api = HfApi()
    if not token:
        raise ValueError("Hugging Face token not found. Please set it in the settings.")

    # Parse repo name if a link is provided
    parsed = parse_link(repo_name_or_link)
    repo_name = parsed.get("repo", repo_name_or_link)

    print(f"[INFO] Restoring files from '{repo_name}'...")
    files = api.list_repo_files(repo_id=repo_name, token=token)
    for file in files:
        local_path = os.path.join(os.getcwd(), file)
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        print(f"[INFO] Downloading '{file}' to '{local_path}'...")
        api.download_file(
            repo_id=repo_name,
            filename=file,
            local_dir=os.path.dirname(local_path),
            token=token,
        )
