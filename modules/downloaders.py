import os
import shutil
from huggingface_hub import hf_hub_download, snapshot_download, list_repo_files

class HuggingFaceDownloader:
    @staticmethod
    def parse_link(link):
        """
        Parses a Hugging Face link to extract repo_id, file_path, and optional revision.

        Supports:
        - Fully qualified Hugging Face URLs with any revision (e.g., /blob/<revision>/ or /resolve/<revision>/)
        - Plain repo_id/file_path formats
        """
        try:
            # Handle fully qualified URLs
            if "huggingface.co" in link:
                # Normalize blob/<revision> to resolve/<revision>
                link = link.replace("/blob/", "/resolve/")
                if "/resolve/" in link:
                    parts = link.split("/resolve/", 1)
                    repo_id = parts[0].split("huggingface.co/")[-1].strip("/")
                    revision_and_path = parts[1].split("/", 1)  # Split into [revision, file_path]
                    revision = revision_and_path[0].strip("/")  # Extract the revision
                    file_path = revision_and_path[1].split("?")[0].strip("/") if len(revision_and_path) > 1 else ""  # Remove query params
                    return repo_id, file_path, revision

            # Handle plain repo_id/file_path format
            parts = link.split("/", 2)  # Split into [repo, subfolder, filename...]
            if len(parts) >= 2:
                repo_id = "/".join(parts[:2])  # Join the first two segments as repo_id
                file_path = "/".join(parts[2:]) if len(parts) > 2 else ""
                return repo_id, file_path, "main"  # Default to "main" revision

            # Unrecognized link format
            print(f"Unrecognized link format: {link}")
            return None, None, None
        except Exception as e:
            print(f"Failed to parse link: {link}. Error: {e}")
            return None, None, None

    @staticmethod
    def parse_folder_link(link):
        """
        Parses a Hugging Face link to extract repo_id, folder_path, and optional revision.

        Supports:
        - Fully qualified Hugging Face URLs for folders (e.g., /tree/<revision>/)
        - Plain repo/repo or repo/repo/subfolder formats
        """
        try:
            # Handle fully qualified URLs
            if "huggingface.co" in link:
                if "/tree/" in link:
                    parts = link.split("/tree/", 1)
                    repo_id = parts[0].split("huggingface.co/")[-1].strip("/")
                    revision_and_path = parts[1].split("/", 1)  # Split into [revision, folder_path]
                    revision = revision_and_path[0].strip("/")  # Extract the revision
                    folder_path = revision_and_path[1].strip("/") if len(revision_and_path) > 1 else None
                    return repo_id, folder_path, revision
                else:
                    # For links like https://huggingface.co/repo/repo/
                    repo_id = link.split("huggingface.co/")[-1].strip("/")
                    return repo_id, None, "main"

            # Handle plain repo/repo or repo/repo/subfolder formats
            parts = link.split("/", 2)  # Split into [repo, repo, subfolder...]
            if len(parts) >= 2:
                repo_id = "/".join(parts[:2])  # First two segments form the repo_id
                folder_path = "/".join(parts[2:]) if len(parts) > 2 else None
                return repo_id, folder_path, "main"

            # Unrecognized link format
            print(f"Unrecognized folder link format: {link}")
            return None, None, None
        except Exception as e:
            print(f"Failed to parse folder link: {link}. Error: {e}")
            return None, None, None

    @staticmethod
    def download_files(files, base_path, token=None):
        """
        Downloads individual files from Hugging Face, placing them directly into the specified base_path,
        cleaning up any unnecessary subfolders and the .cache directory.
        """
        downloaded_files = []
        for link in files.splitlines():
            repo_id, file_path, revision = HuggingFaceDownloader.parse_link(link)
            if not repo_id or not file_path:
                print(f"Skipping invalid link: {link}")
                continue
            try:
                # Temporarily download to Hugging Face cache
                temp_path = hf_hub_download(
                    repo_id=repo_id,
                    filename=file_path,
                    revision=revision,  # Include revision
                    local_dir=base_path,
                    token=token,
                )

                # Extract file name and move to base_path
                file_name = os.path.basename(file_path)  # Get only the file name
                final_path = os.path.join(base_path, file_name)
                shutil.move(temp_path, final_path)
                downloaded_files.append(final_path)

            except Exception as e:
                print(f"Failed to download file {link}: {e}")

        # Clean any empty subfolders and .cache
        HuggingFaceDownloader._clean_empty_subfolders(base_path)
        HuggingFaceDownloader._clear_huggingface_cache(base_path)

        return downloaded_files

    @staticmethod
    def download_folders(folders, base_path, token=None):
        """
        Downloads folders or repositories from Hugging Face, maintaining the desired structure
        and ensuring subfolders are placed directly in the target directory.
        """
        downloaded_files = []
        for folder in folders.splitlines():
            try:
                # Parse the folder link
                repo_id, folder_path, revision = HuggingFaceDownloader.parse_folder_link(folder)
                if not repo_id:
                    print(f"Skipping invalid folder link: {folder}")
                    continue

                # Create a distinct temporary path
                temp_download_dir = os.path.join(base_path, ".temp_hf_download")
                os.makedirs(temp_download_dir, exist_ok=True)

                # Download the snapshot to the temporary directory
                snapshot_path = snapshot_download(
                    repo_id=repo_id,
                    revision=revision,
                    allow_patterns=None if not folder_path else [f"{folder_path}/*"],
                    local_dir=temp_download_dir,
                    token=token,
                )

                # Determine the target directory
                target_path = os.path.join(base_path, os.path.basename(folder_path) if folder_path else os.path.basename(repo_id))
                os.makedirs(target_path, exist_ok=True)

                # Move relevant files to the target directory
                for root, dirs, files in os.walk(snapshot_path):
                    for file in files:
                        source_path = os.path.join(root, file)

                        # Calculate the relative path starting from the subfolder (if specified)
                        relative_path = os.path.relpath(source_path, start=os.path.join(snapshot_path, folder_path) if folder_path else snapshot_path)
                        final_path = os.path.join(target_path, relative_path)

                        # Ensure the target directory exists
                        os.makedirs(os.path.dirname(final_path), exist_ok=True)

                        # Move the file
                        shutil.move(source_path, final_path)
                        downloaded_files.append(final_path)

                # Clean up the temporary directory
                shutil.rmtree(temp_download_dir, ignore_errors=True)

            except Exception as e:
                print(f"Failed to download folder {folder}: {e}")

        # Clean the .cache folder inside the target base_path
        HuggingFaceDownloader._clear_huggingface_cache(base_path)

        return downloaded_files

    @staticmethod
    def _clean_empty_subfolders(directory):
        """
        Recursively removes empty subfolders in the specified directory.
        """
        for root, dirs, _ in os.walk(directory, topdown=False):
            for subdir in dirs:
                subdir_path = os.path.join(root, subdir)
                if not os.listdir(subdir_path):  # Check if the folder is empty
                    os.rmdir(subdir_path)  # Remove the empty folder

    @staticmethod
    def _clear_huggingface_cache(base_path):
        """
        Deletes the .cache directory used by Hugging Face for temporary downloads,
        both globally and within the local directory.
        """
        # Global Hugging Face cache
        global_cache_dir = os.path.expanduser("~/.cache/huggingface")
        if os.path.exists(global_cache_dir):
            try:
                shutil.rmtree(global_cache_dir)
                print("Cleared global Hugging Face cache directory.")
            except Exception as e:
                print(f"Failed to clear global Hugging Face cache directory: {e}")

        # Local .cache directory within base_path
        local_cache_dir = os.path.join(base_path, ".cache")
        if os.path.exists(local_cache_dir):
            try:
                shutil.rmtree(local_cache_dir)
                print(f"Cleared local .cache directory in {base_path}.")
            except Exception as e:
                print(f"Failed to clear local .cache directory: {e}")
