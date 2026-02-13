import os
import sys
import shutil
import tempfile
import time
import json
import zipfile
import hashlib
import re
import socket
import yaml
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional, Tuple, Callable

from huggingface_hub import (
    HfApi,
    hf_hub_download,
    snapshot_download,
    scan_cache_dir,
    list_repo_files
)

os.environ.setdefault("HF_HUB_ENABLE_HF_XET", "1")

token_override = os.getenv("HF_TOKEN")
_sha_max_env = os.getenv("HF_DOWNLOADER_SHA_MAX_BYTES", "0")
try:
    _sha_max_val = int(_sha_max_env)
except Exception:
    _sha_max_val = 0
SHA_VERIFY_MAX_BYTES = _sha_max_val if _sha_max_val > 0 else None

def folder_size(directory: str) -> int:
    total = 0
    for dirpath, _, filenames in os.walk(directory):
        for f in filenames:
            try:
                fp = os.path.join(dirpath, f)
                if os.path.isfile(fp):
                    total += os.path.getsize(fp)
            except Exception:
                pass
    return total


def traverse_subfolders(root_folder: str, segments: list[str]) -> str:
    current = root_folder
    for seg in segments:
        current = os.path.join(current, seg)
    return current


def clear_cache_for_path(downloaded_path: str):
    print(f"[DEBUG] Attempting to clean cache for {downloaded_path}")
    try:
        cache_info = scan_cache_dir()
        for repo in cache_info.repos:
            for revision in repo.revisions:
                # Match snapshot folder or file path
                if str(revision.snapshot_path) == downloaded_path or any(
                    str(f.file_path) == downloaded_path for f in revision.files
                ):
                    delete_strategy = cache_info.delete_revisions(revision.commit_hash)
                    print(f"[DEBUG] Deleting cached revision: {revision.commit_hash}")
                    delete_strategy.execute()
                    print("[DEBUG] Cache cleaned.")
                    return
    except Exception as e:
        print(f"[DEBUG] Cache cleaning failed: {e}")


def clear_cache_for_repo(repo_id: str):
    """Remove cached snapshots/blobs for a specific HF model repo."""
    normalized_repo = str(repo_id or "").strip()
    if not normalized_repo:
        return
    print(f"[DEBUG] Attempting to clean cache for repo {normalized_repo}")

    try:
        cache_info = scan_cache_dir()
        commit_hashes = []
        for repo in getattr(cache_info, "repos", []) or []:
            repo_key = str(getattr(repo, "repo_id", "") or "").strip()
            if repo_key.lower() != normalized_repo.lower():
                continue
            for revision in getattr(repo, "revisions", []) or []:
                commit_hash = str(getattr(revision, "commit_hash", "") or "").strip()
                if commit_hash:
                    commit_hashes.append(commit_hash)
        for commit_hash in commit_hashes:
            try:
                delete_strategy = cache_info.delete_revisions(commit_hash)
                print(f"[DEBUG] Deleting cached revision for repo cleanup: {commit_hash}")
                delete_strategy.execute()
            except Exception as inner:
                print(f"[DEBUG] Failed to delete revision {commit_hash}: {inner}")
    except Exception as e:
        print(f"[DEBUG] Repo cache cleanup via scan_cache_dir failed: {e}")

    # Interrupted downloads can leave orphaned *.incomplete blobs outside tracked revisions.
    try:
        repo_folder = f"models--{normalized_repo.replace('/', '--')}"
        repo_cache_dir = os.path.join(_get_hf_cache_dir(), repo_folder)
        blobs_dir = os.path.join(repo_cache_dir, "blobs")
        if os.path.isdir(blobs_dir):
            for name in os.listdir(blobs_dir):
                if name.endswith(".incomplete"):
                    _safe_remove(os.path.join(blobs_dir, name))
        if os.path.isdir(repo_cache_dir):
            shutil.rmtree(repo_cache_dir, ignore_errors=True)
        print(f"[DEBUG] Repo cache cleaned for {normalized_repo}")
    except Exception as e:
        print(f"[DEBUG] Repo cache directory cleanup failed: {e}")


def get_token():
    """
    Load the Hugging Face token from comfy.settings.json.
    If not found or empty, fall back to the HF_TOKEN environment variable.
    """
    settings_path = os.path.join("user", "default", "comfy.settings.json")
    token = ""
    if os.path.exists(settings_path):
        with open(settings_path, "r") as f:
            settings = json.load(f)
        token = settings.get("downloader.hf_token", "").strip()
    if not token:  # Fallback to HF_TOKEN environment variable
        token = os.getenv("HF_TOKEN", "").strip()
    return token


def _safe_remove(path: str):
    try:
        os.remove(path)
    except FileNotFoundError:
        return
    except Exception as e:
        print(f"[DEBUG] Failed to remove {path}: {e}")


def _extract_lfs_value(lfs, key: str):
    if not lfs:
        return None
    if isinstance(lfs, dict):
        return lfs.get(key)
    return getattr(lfs, key, None)


def get_remote_file_metadata(repo_id: str,
                             remote_filename: str,
                             revision: str = None,
                             token: str = None) -> Tuple[Optional[int], Optional[str], Optional[str]]:
    try:
        api = HfApi()
        info = api.model_info(repo_id, revision=revision, token=token, files_metadata=True)
        siblings = getattr(info, "siblings", []) or []
        for sibling in siblings:
            if getattr(sibling, "rfilename", None) != remote_filename:
                continue
            size = getattr(sibling, "size", None)
            blob_id = getattr(sibling, "blob_id", None)
            etag = getattr(sibling, "etag", None)
            lfs = getattr(sibling, "lfs", None)
            if lfs:
                sha = _extract_lfs_value(lfs, "sha256") or _extract_lfs_value(lfs, "oid")
                size = _extract_lfs_value(lfs, "size") or size
                etag = sha or blob_id or etag
            else:
                sha = None
                etag = blob_id or etag
            return size, sha, etag
    except Exception as e:
        print(f"[DEBUG] Failed to fetch metadata for {repo_id}/{remote_filename}: {e}")
    return None, None, None


def _get_hf_cache_dir() -> str:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
        return HF_HUB_CACHE
    except Exception:
        return os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")


def get_blob_paths(repo_id: str, etag: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    if not etag:
        return None, None
    repo_folder = f"models--{repo_id.replace('/', '--')}"
    blob_dir = os.path.join(_get_hf_cache_dir(), repo_folder, "blobs")
    blob_path = os.path.join(blob_dir, etag)
    return blob_path, blob_path + ".incomplete"


def _verify_file_integrity(dest_path: str,
                           expected_size: Optional[int],
                           expected_sha: Optional[str]):
    if expected_size is not None:
        actual_size = os.path.getsize(dest_path)
        if actual_size != expected_size:
            raise RuntimeError(
                f"Size mismatch (expected {expected_size} bytes, got {actual_size} bytes)"
            )
    if expected_sha:
        size_for_sha = expected_size if expected_size is not None else os.path.getsize(dest_path)
        if SHA_VERIFY_MAX_BYTES is not None and size_for_sha > SHA_VERIFY_MAX_BYTES:
            print(f"[DEBUG] Skipping SHA256 for large file ({size_for_sha} bytes).")
            return
        sha256 = hashlib.sha256()
        with open(dest_path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                sha256.update(chunk)
        actual_sha = sha256.hexdigest().lower()
        if actual_sha != expected_sha.lower():
            raise RuntimeError("SHA256 mismatch")


def _sanitize_download_filename(value: str) -> str:
    text = str(value or "").replace("\\", "/").strip()
    if not text:
        return ""
    name = os.path.basename(text)
    if not name or name in (".", ".."):
        return ""
    return name


def _filename_from_content_disposition(header_value: str) -> str:
    if not header_value:
        return ""
    text = str(header_value)
    # RFC 5987 form: filename*=UTF-8''encoded-name
    match_star = re.search(r"filename\*\s*=\s*([^;]+)", text, flags=re.IGNORECASE)
    if match_star:
        raw = match_star.group(1).strip().strip("\"'")
        if "''" in raw:
            raw = raw.split("''", 1)[1]
        try:
            return _sanitize_download_filename(urllib.parse.unquote(raw))
        except Exception:
            return _sanitize_download_filename(raw)

    match = re.search(r"filename\s*=\s*([^;]+)", text, flags=re.IGNORECASE)
    if match:
        raw = match.group(1).strip().strip("\"'")
        try:
            return _sanitize_download_filename(urllib.parse.unquote(raw))
        except Exception:
            return _sanitize_download_filename(raw)
    return ""


def _filename_from_url_path(url_value: str) -> str:
    if not url_value:
        return ""
    try:
        parsed = urllib.parse.urlparse(url_value)
        path = parsed.path or ""
    except Exception:
        path = str(url_value).split("?", 1)[0].split("#", 1)[0]
    tail = os.path.basename(path.rstrip("/"))
    if not tail:
        return ""
    try:
        tail = urllib.parse.unquote(tail)
    except Exception:
        pass
    return _sanitize_download_filename(tail)


def _parse_content_length(header_value: str) -> Optional[int]:
    if header_value is None:
        return None
    try:
        size = int(str(header_value).strip())
        return size if size >= 0 else None
    except Exception:
        return None


def _is_retryable_url_error(error: Exception) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return int(getattr(error, "code", 0) or 0) in (408, 425, 429, 500, 502, 503, 504)
    if isinstance(error, urllib.error.URLError):
        reason = getattr(error, "reason", None)
        if isinstance(reason, socket.timeout):
            return True
        text = str(reason or "").lower()
        return any(token in text for token in ("timeout", "temporarily", "reset", "refused", "unreachable"))
    text = str(error).lower()
    return "timeout" in text or "temporarily unavailable" in text


def run_download(parsed_data: dict,
                 final_folder: str,
                 sync: bool = False,
                 defer_verify: bool = False,
                 overwrite: bool = False,
                 return_info: bool = False,
                 target_filename: Optional[str] = None,
                 status_cb: Optional[Callable[[str], None]] = None,
                 cancel_check: Optional[Callable[[], bool]] = None) -> tuple:
    """
    Downloads a single file from Hugging Face Hub and copies it to models/<final_folder>.
    Cleans up the cached copy to save disk space.
    """
    token = get_token()
    print("[DEBUG] run_download (single-file) started")

    file_name = parsed_data.get("file", "unknown.bin").strip("/")
    sub = parsed_data.get("subfolder", "").strip("/")
    remote_filename = os.path.join(sub, file_name) if sub else file_name
    target_name = os.path.basename(str(target_filename or "").replace("\\", "/").strip())
    if not target_name:
        target_name = os.path.basename(remote_filename)

    expected_size, expected_sha, _ = get_remote_file_metadata(
        parsed_data["repo"],
        remote_filename,
        revision=parsed_data.get("revision"),
        token=token or None
    )

    dest_path = ""
    copy_tmp_path = ""
    try:
        target_dir = os.path.join(os.getcwd(), "models", final_folder)
        os.makedirs(target_dir, exist_ok=True)
        dest_path = os.path.join(target_dir, target_name)

        if os.path.exists(dest_path):
            if overwrite:
                print("[DEBUG] Overwrite requested, deleting existing file before download.")
                _safe_remove(dest_path)
            else:
                try:
                    _verify_file_integrity(dest_path, expected_size, expected_sha)
                    size_gb = os.path.getsize(dest_path) / (1024 ** 3)
                    message = f"{target_name} already exists | {size_gb:.3f} GB"
                    print("[DEBUG]", message)
                    if return_info:
                        return (message, dest_path, {"expected_size": expected_size, "expected_sha": expected_sha})
                    return (message, dest_path) if sync else ("", "")
                except Exception as e:
                    print(f"[DEBUG] Existing file failed verification, re-downloading: {e}")
                    _safe_remove(dest_path)

        def run_file_download_with_cancel(download_kwargs: dict) -> str:
            if not cancel_check:
                return hf_hub_download(**download_kwargs)

            comfy_temp = os.path.join(os.getcwd(), "temp")
            os.makedirs(comfy_temp, exist_ok=True)
            payload_fd, payload_path = tempfile.mkstemp(prefix="hf_file_payload_", suffix=".json", dir=comfy_temp)
            result_fd, result_path = tempfile.mkstemp(prefix="hf_file_result_", suffix=".json", dir=comfy_temp)
            os.close(payload_fd)
            os.close(result_fd)

            script = (
                "import json, sys\n"
                "from huggingface_hub import hf_hub_download\n"
                "payload_path = sys.argv[1]\n"
                "result_path = sys.argv[2]\n"
                "with open(payload_path, 'r', encoding='utf-8') as f:\n"
                "    kwargs = json.load(f)\n"
                "result = {}\n"
                "try:\n"
                "    path = hf_hub_download(**kwargs)\n"
                "    result = {'ok': True, 'path': path}\n"
                "except Exception as e:\n"
                "    result = {'ok': False, 'error': str(e)}\n"
                "with open(result_path, 'w', encoding='utf-8') as f:\n"
                "    json.dump(result, f)\n"
                "sys.exit(0 if result.get('ok') else 1)\n"
            )

            try:
                with open(payload_path, "w", encoding="utf-8") as f:
                    json.dump(download_kwargs, f)

                proc = subprocess.Popen(
                    [sys.executable, "-c", script, payload_path, result_path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )

                while True:
                    if proc.poll() is not None:
                        break
                    if cancel_check and cancel_check():
                        proc.terminate()
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait(timeout=5)
                        raise InterruptedError("Download cancelled")
                    time.sleep(0.2)

                result = {}
                if os.path.exists(result_path):
                    try:
                        with open(result_path, "r", encoding="utf-8") as f:
                            result = json.load(f)
                    except Exception:
                        result = {}

                if result.get("ok"):
                    return str(result.get("path") or "")

                raise RuntimeError(result.get("error") or "hf_hub_download failed.")
            finally:
                _safe_remove(payload_path)
                _safe_remove(result_path)

        download_start = time.time()
        print(f"[DEBUG] hf_hub_download start: {parsed_data['repo']}/{remote_filename}")
        file_path_in_cache = run_file_download_with_cancel({
            "repo_id": parsed_data["repo"],
            "filename": remote_filename,
            "revision": parsed_data.get("revision"),
            "token": token or None,
        })
        if not file_path_in_cache:
            raise RuntimeError("hf_hub_download did not return a cache path.")
        if cancel_check and cancel_check():
            raise InterruptedError("Download cancelled")
        elapsed = time.time() - download_start
        print(f"[DEBUG] hf_hub_download finished in {elapsed:.1f}s")
        print("[DEBUG] File downloaded to cache:", file_path_in_cache)

        if status_cb:
            status_cb("copying")
        copy_tmp_path = dest_path + ".tmp_copy"
        with open(file_path_in_cache, "rb") as src, open(copy_tmp_path, "wb") as dst:
            while True:
                if cancel_check and cancel_check():
                    raise InterruptedError("Download cancelled")
                chunk = src.read(8 * 1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)
        os.replace(copy_tmp_path, dest_path)
        copy_tmp_path = ""
        if cancel_check and cancel_check():
            raise InterruptedError("Download cancelled")
        print("[DEBUG] File copied to:", dest_path)

        if not defer_verify:
            try:
                if status_cb:
                    status_cb("verifying")
                if cancel_check and cancel_check():
                    raise InterruptedError("Download cancelled")
                _verify_file_integrity(dest_path, expected_size, expected_sha)
            except InterruptedError:
                raise
            except Exception as e:
                _safe_remove(dest_path)
                raise RuntimeError(f"Download verification failed: {e}") from e

        if status_cb:
            status_cb("cleaning_cache")
        if cancel_check and cancel_check():
            raise InterruptedError("Download cancelled")
        clear_cache_for_path(file_path_in_cache)

        size_gb = os.path.getsize(dest_path) / (1024 ** 3)
        source_name = os.path.basename(remote_filename)
        if target_name != source_name:
            final_message = f"Downloaded {target_name} (from {source_name}) | {size_gb:.3f} GB"
        else:
            final_message = f"Downloaded {target_name} | {size_gb:.3f} GB"
        print("[DEBUG]", final_message)
        if return_info:
            return (final_message, dest_path, {"expected_size": expected_size, "expected_sha": expected_sha})
        return (final_message, dest_path) if sync else ("", "")
    except InterruptedError:
        if copy_tmp_path:
            _safe_remove(copy_tmp_path)
        if dest_path and os.path.exists(dest_path):
            _safe_remove(dest_path)
        clear_cache_for_repo(parsed_data.get("repo", ""))
        cancel_msg = "Download cancelled"
        print("[DEBUG]", cancel_msg)
        if return_info:
            return (cancel_msg, "", {"expected_size": expected_size, "expected_sha": expected_sha})
        return (cancel_msg, "") if sync else ("", "")
    except Exception as e:
        # Provide clearer feedback for common authentication/authorization problems
        if "Invalid credentials" in str(e) or "401" in str(e):
            error_msg = (
                f"Invalid Hugging Face token for repository '{parsed_data['repo']}'.\n"
                "Add a valid token in ComfyUI settings or set the HF_TOKEN environment variable.\n"
                "Create/manage tokens at https://huggingface.co/settings/tokens/"
            )
        elif "403" in str(e) or "gated" in str(e) or "permission" in str(e):
            repo_url = f"https://huggingface.co/{parsed_data['repo']}"
            error_msg = (
                f"The repository '{parsed_data['repo']}' is gated or you do not have permission to access it.\n"
                f"Visit {repo_url}, accept its terms or request access, then retry the download."
            )
        else:
            error_msg = f"Download failed: {e}"
        print("[DEBUG]", error_msg)
        # Raise so ComfyUI shows the standard error dialog, not just console output
        raise RuntimeError(error_msg)


def run_download_url(url: str,
                     final_folder: str,
                     sync: bool = False,
                     overwrite: bool = False,
                     target_filename: Optional[str] = None,
                     status_cb: Optional[Callable[[str], None]] = None,
                     progress_cb: Optional[Callable[[dict], None]] = None,
                     cancel_check: Optional[Callable[[], bool]] = None,
                     max_retries: int = 3) -> tuple:
    """
    Download a single file from a direct HTTP(S) URL into models/<final_folder>.
    Uses streamed writes with retry/backoff, supports cancellation, and writes atomically.
    """
    raw_url = str(url or "").strip()
    parsed_url = urllib.parse.urlparse(raw_url)
    if parsed_url.scheme.lower() not in ("http", "https") or not parsed_url.netloc:
        raise RuntimeError("URL must be a valid http(s) link.")

    target_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(target_dir, exist_ok=True)

    explicit_target = _sanitize_download_filename(target_filename or "")
    request_headers = {
        "User-Agent": "ComfyUI-HuggingFace-Downloader/1.0",
        "Accept": "*/*",
    }

    retry_count = max(0, int(max_retries))
    last_error = None

    for attempt in range(retry_count + 1):
        if cancel_check and cancel_check():
            cancel_msg = "Download cancelled"
            print("[DEBUG]", cancel_msg)
            return (cancel_msg, "") if sync else ("", "")

        temp_path = ""
        dest_path = ""
        try:
            if status_cb:
                status_cb("downloading")

            request = urllib.request.Request(raw_url, headers=request_headers, method="GET")
            with urllib.request.urlopen(request, timeout=60) as response:
                final_url = str(getattr(response, "geturl", lambda: raw_url)() or raw_url)
                headers = getattr(response, "headers", {})
                content_disposition = ""
                content_length = None
                if headers:
                    try:
                        content_disposition = headers.get("Content-Disposition", "")
                        content_length = _parse_content_length(headers.get("Content-Length"))
                    except Exception:
                        content_disposition = ""
                        content_length = None

                resolved_name = (
                    explicit_target
                    or _filename_from_content_disposition(content_disposition)
                    or _filename_from_url_path(final_url)
                    or _filename_from_url_path(raw_url)
                    or "download.bin"
                )
                target_name = _sanitize_download_filename(resolved_name) or "download.bin"
                dest_path = os.path.join(target_dir, target_name)
                temp_path = dest_path + ".part"

                if os.path.exists(dest_path):
                    if overwrite:
                        print("[DEBUG] Overwrite requested, deleting existing file before direct URL download.")
                        _safe_remove(dest_path)
                    else:
                        existing_size = os.path.getsize(dest_path)
                        size_gb = existing_size / (1024 ** 3)
                        message = f"{target_name} already exists | {size_gb:.3f} GB"
                        print("[DEBUG]", message)
                        return (message, dest_path) if sync else ("", "")

                _safe_remove(temp_path)

                downloaded_bytes = 0
                last_bytes = 0
                last_time = time.time()
                last_progress_emit = 0.0
                ema_speed = None
                chunk_size = 8 * 1024 * 1024

                with open(temp_path, "wb") as out:
                    while True:
                        if cancel_check and cancel_check():
                            raise InterruptedError("Download cancelled")
                        chunk = response.read(chunk_size)
                        if not chunk:
                            break
                        out.write(chunk)
                        downloaded_bytes += len(chunk)

                        now = time.time()
                        dt = now - last_time
                        if dt > 0:
                            inst_speed = (downloaded_bytes - last_bytes) / dt
                            ema_speed = inst_speed if ema_speed is None else (0.2 * inst_speed + 0.8 * ema_speed)
                            last_time = now
                            last_bytes = downloaded_bytes

                        should_emit = False
                        if now - last_progress_emit >= 0.25:
                            should_emit = True
                        if content_length is not None and downloaded_bytes >= content_length:
                            should_emit = True
                        if should_emit and progress_cb:
                            eta_seconds = None
                            if content_length and ema_speed and ema_speed > 0:
                                eta_seconds = max(0, (content_length - downloaded_bytes) / ema_speed)
                            progress_cb({
                                "downloaded_bytes": downloaded_bytes,
                                "total_bytes": content_length,
                                "speed_bps": ema_speed or 0,
                                "eta_seconds": eta_seconds,
                                "phase": "downloading",
                            })
                            last_progress_emit = now

                if cancel_check and cancel_check():
                    raise InterruptedError("Download cancelled")

                if content_length is not None and downloaded_bytes != content_length:
                    raise RuntimeError(
                        f"Incomplete download (expected {content_length} bytes, got {downloaded_bytes} bytes)"
                    )

                if status_cb:
                    status_cb("finalizing")
                os.replace(temp_path, dest_path)
                temp_path = ""

                final_size = os.path.getsize(dest_path)
                size_gb = final_size / (1024 ** 3)
                if progress_cb:
                    progress_cb({
                        "downloaded_bytes": final_size,
                        "total_bytes": content_length if content_length is not None else final_size,
                        "speed_bps": 0,
                        "eta_seconds": 0,
                        "phase": "finalizing",
                    })

                final_message = f"Downloaded {target_name} | {size_gb:.3f} GB"
                print("[DEBUG]", final_message)
                return (final_message, dest_path) if sync else ("", "")
        except InterruptedError:
            if temp_path:
                _safe_remove(temp_path)
            if status_cb:
                status_cb("cancelling")
            cancel_msg = "Download cancelled"
            print("[DEBUG]", cancel_msg)
            return (cancel_msg, "") if sync else ("", "")
        except Exception as e:
            if temp_path:
                _safe_remove(temp_path)
            last_error = e
            if attempt >= retry_count or not _is_retryable_url_error(e):
                break
            backoff_seconds = min(8.0, float(2 ** attempt))
            print(
                f"[DEBUG] Direct URL download retry {attempt + 1}/{retry_count} "
                f"after {backoff_seconds:.1f}s: {e}"
            )
            time.sleep(backoff_seconds)

    raise RuntimeError(f"Download failed: {last_error}")


def run_download_folder(parsed_data: dict,
                        final_folder: str,
                        remote_subfolder_path: str = "",
                        last_segment: str = "",
                        sync: bool = False,
                        status_cb: Optional[Callable[[str], None]] = None,
                        cancel_check: Optional[Callable[[], bool]] = None) -> tuple[str, str]:
    """
    Downloads a folder or subfolder from Hugging Face Hub using snapshot_download.
    The result is placed in:
    - models/<final_folder>/<repo_name> if downloading entire repo
    - models/<final_folder>/<last_segment> if downloading specific subfolder
    """
    token = get_token()
    print("[DEBUG] run_download_folder started")
    if status_cb:
        status_cb("Resolving folder contents")

    # Get repository name from the parsed data
    repo_name = parsed_data["repo"].split("/")[-1] if "/" in parsed_data["repo"] else parsed_data["repo"]

    # Create base directory
    base_dir = os.path.join(os.getcwd(), "models", final_folder)
    os.makedirs(base_dir, exist_ok=True)
    
    # Determine destination folder name based on whether it's a subfolder or root link
    if remote_subfolder_path and last_segment:
        # If it's a subfolder link, use the last segment
        dest_path = os.path.join(base_dir, last_segment)
    else:
        # If it's a root link, use the repo name
        dest_path = os.path.join(base_dir, repo_name)

    if os.path.exists(dest_path) and os.listdir(dest_path):
        fz = folder_size(dest_path)
        fg = fz / (1024 ** 3)
        final_message = f"{os.path.basename(dest_path)} already exists | {fg:.3f} GB"
        print("[DEBUG]", final_message)
        return (final_message, dest_path) if sync else ("", "")

    comfy_temp = os.path.join(os.getcwd(), "temp")
    os.makedirs(comfy_temp, exist_ok=True)
    temp_dir = tempfile.mkdtemp(prefix="hf_dl_", dir=comfy_temp)
    print("[DEBUG] Temp folder =>", temp_dir)

    file_count = None
    try:
        repo_files = list_repo_files(
            parsed_data["repo"],
            revision=parsed_data.get("revision"),
            token=token or None
        )
        if remote_subfolder_path:
            prefix = remote_subfolder_path.strip("/") + "/"
            file_count = sum(1 for item in repo_files if str(item).startswith(prefix))
        else:
            file_count = len(repo_files)
    except Exception as e:
        print(f"[DEBUG] Could not count repository files: {e}")

    if status_cb:
        if isinstance(file_count, int) and file_count >= 0:
            status_cb(f"Fetching {file_count} files")
        else:
            status_cb("Fetching files")

    allow_patterns = [f"{remote_subfolder_path}/**"] if remote_subfolder_path else None
    kwargs = {
        "repo_id": parsed_data["repo"],
        "local_dir": temp_dir,
        "token": token or None
    }
    if parsed_data.get("revision"):
        kwargs["revision"] = parsed_data["revision"]
    if allow_patterns:
        kwargs["allow_patterns"] = allow_patterns

    def run_snapshot_with_cancel(download_kwargs: dict) -> str:
        payload_fd, payload_path = tempfile.mkstemp(prefix="hf_snapshot_payload_", suffix=".json", dir=comfy_temp)
        result_fd, result_path = tempfile.mkstemp(prefix="hf_snapshot_result_", suffix=".json", dir=comfy_temp)
        os.close(payload_fd)
        os.close(result_fd)
        script = (
            "import json, sys\n"
            "from huggingface_hub import snapshot_download\n"
            "payload_path = sys.argv[1]\n"
            "result_path = sys.argv[2]\n"
            "with open(payload_path, 'r', encoding='utf-8') as f:\n"
            "    kwargs = json.load(f)\n"
            "result = {}\n"
            "try:\n"
            "    path = snapshot_download(**kwargs)\n"
            "    result = {'ok': True, 'path': path}\n"
            "except Exception as e:\n"
            "    result = {'ok': False, 'error': str(e)}\n"
            "with open(result_path, 'w', encoding='utf-8') as f:\n"
            "    json.dump(result, f)\n"
            "sys.exit(0 if result.get('ok') else 1)\n"
        )

        try:
            with open(payload_path, "w", encoding="utf-8") as f:
                json.dump(download_kwargs, f)

            proc = subprocess.Popen(
                [sys.executable, "-c", script, payload_path, result_path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            while True:
                if proc.poll() is not None:
                    break
                if cancel_check and cancel_check():
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=5)
                    raise InterruptedError("Folder download cancelled")
                time.sleep(0.2)

            result = {}
            if os.path.exists(result_path):
                try:
                    with open(result_path, "r", encoding="utf-8") as f:
                        result = json.load(f)
                except Exception:
                    result = {}

            if result.get("ok"):
                return str(result.get("path") or temp_dir)

            error = result.get("error") or "snapshot_download failed."
            raise RuntimeError(error)
        finally:
            _safe_remove(payload_path)
            _safe_remove(result_path)

    start_time = time.time()
    stage_dir = tempfile.mkdtemp(prefix="hf_stage_", dir=base_dir)
    downloaded_folder = ""
    try:
        if status_cb:
            status_cb("Downloading files")
        downloaded_folder = run_snapshot_with_cancel(kwargs)
        print("[DEBUG] snapshot_download =>", downloaded_folder)

        source_folder = traverse_subfolders(downloaded_folder, remote_subfolder_path.split("/")) \
            if remote_subfolder_path else downloaded_folder
        if not os.path.isdir(source_folder):
            raise RuntimeError("Downloaded folder path not found.")

        if status_cb:
            status_cb("Copying files")
        for item in os.listdir(source_folder):
            if item == ".cache":
                continue
            if cancel_check and cancel_check():
                raise InterruptedError("Folder download cancelled")
            src_item = os.path.join(source_folder, item)
            dst_item = os.path.join(stage_dir, item)
            shutil.move(src_item, dst_item)

        if cancel_check and cancel_check():
            raise InterruptedError("Folder download cancelled")

        if os.path.exists(dest_path):
            shutil.rmtree(dest_path, ignore_errors=True)
        os.replace(stage_dir, dest_path)
        stage_dir = ""
    except InterruptedError:
        clear_cache_for_repo(parsed_data.get("repo", ""))
        cancel_msg = "Folder download cancelled"
        print("[DEBUG]", cancel_msg)
        return (cancel_msg, "") if sync else ("", "")
    except Exception as e:
        err = f"Download failed: {e}"
        print("[DEBUG]", err)
        return (err, "") if sync else ("", "")
    finally:
        if stage_dir and os.path.isdir(stage_dir):
            shutil.rmtree(stage_dir, ignore_errors=True)
        shutil.rmtree(temp_dir, ignore_errors=True)
        print("[DEBUG] Removed temp folder:", temp_dir)

    elapsed = time.time() - start_time
    fsz = folder_size(dest_path)
    fgb = fsz / (1024 ** 3)
    final_message = f"Folder downloaded: {os.path.basename(dest_path)} | {fgb:.3f} GB in {elapsed:.1f}s"
    print("[DEBUG]", final_message)

    if status_cb:
        status_cb("Finalizing")
    clear_cache_for_path(downloaded_folder)

    return (final_message, dest_path) if sync else ("", "")


def scan_repo_root(repo_id: str, token: str = None) -> tuple[list[str], list[str]]:
    """
    Scan a repository's root folder for subfolders and files.
    Returns (folders, files) where each is a list of names found at root level.
    """
    try:
        all_files = list_repo_files(repo_id, token=token)
        folders = set()
        root_files = set()
        
        for path in all_files:
            parts = path.split('/')
            if len(parts) > 1:
                folders.add(parts[0])
            else:
                root_files.add(path)
                
        return sorted(list(folders)), sorted(list(root_files))
    except Exception as e:
        print(f"[ERROR] Failed to scan repository root: {e}")
        raise

def extract_custom_nodes(zip_path: str, comfy_root: str) -> str:
    """
    Extract custom_nodes.zip to the custom_nodes folder in ComfyUI root.
    Returns the path to the extracted folder.
    """
    custom_nodes_dir = os.path.join(comfy_root, "custom_nodes")
    os.makedirs(custom_nodes_dir, exist_ok=True)
    
    print(f"[INFO] Extracting custom_nodes.zip to {custom_nodes_dir}")
    with zipfile.ZipFile(zip_path, 'r') as zipf:
        zipf.extractall(custom_nodes_dir)
    
    return custom_nodes_dir

def download_repo_contents(parsed_data: dict, comfy_root: str, sync: bool = True) -> tuple[str, list[str]]:
    """
    Download all contents from a repository's root level:
    1. Scan for subfolders and files
    2. Download each folder to ComfyUI root
    3. Handle custom_nodes.zip specially if it exists
    
    Returns (message, list of downloaded paths)
    """
    token = get_token()
    downloaded_paths = []
    
    try:
        folders, files = scan_repo_root(parsed_data["repo"], token)
        print(f"[INFO] Found {len(folders)} folders and {len(files)} files at root level")
        
        # First handle folders
        for folder in folders:
            if folder == ".git":  # Skip git metadata
                continue
                
            folder_parsed = parsed_data.copy()
            folder_parsed["subfolder"] = folder
            
            message, folder_path = run_download_folder(
                folder_parsed,
                folder,  # Use the folder name as the final folder
                remote_subfolder_path=folder,
                sync=True  # Always sync for better control
            )
            
            if folder_path:
                downloaded_paths.append(folder_path)
                print(f"[INFO] Downloaded folder: {message}")
        
        # Then handle root files
        for file in files:
            if file == "custom_nodes.zip":
                # Special handling for custom_nodes.zip
                file_parsed = parsed_data.copy()
                file_parsed["file"] = file
                
                message, zip_path = run_download(
                    file_parsed,
                    "temp",  # Temporary location
                    sync=True
                )
                
                if zip_path:
                    custom_nodes_dir = extract_custom_nodes(zip_path, comfy_root)
                    downloaded_paths.append(custom_nodes_dir)
                    print(f"[INFO] Extracted custom_nodes.zip")
                    # Clean up the temporary zip file
                    try:
                        os.remove(zip_path)
                    except:
                        pass
            else:
                # Regular file download to root
                file_parsed = parsed_data.copy()
                file_parsed["file"] = file
                
                message, file_path = run_download(
                    file_parsed,
                    "",  # Empty for root
                    sync=True
                )
                
                if file_path:
                    downloaded_paths.append(file_path)
                    print(f"[INFO] Downloaded file: {message}")
        
        final_message = f"Downloaded {len(downloaded_paths)} items from repository root"
        return (final_message, downloaded_paths) if sync else ("", [])
    except Exception as e:
        error_msg = f"Failed to download repository contents: {e}"
        print("[ERROR]", error_msg)
        raise RuntimeError(error_msg)

def merge_and_update_yaml(repo_id: str, token: str, local_snapshot: dict, yaml_filename: str = "custom_nodes_snapshot.yaml"):
    """
    Merge the `cnr_custom_nodes` list from the existing YAML file in the repo with the local snapshot.
    Clean the `pips` section and upload the updated YAML file back to the repository.
    """
    try:
        # Import HfApi here to avoid circular imports
        from huggingface_hub import HfApi

        print("[DEBUG] Starting YAML merge process...")

        # Check if the YAML file exists in the repository
        files = list_repo_files(repo_id, token=token)
        if yaml_filename in files:
            print(f"[DEBUG] Found existing YAML file: {yaml_filename}")
            # Download the existing YAML file
            yaml_path = hf_hub_download(repo_id=repo_id, filename=yaml_filename, token=token)
            with open(yaml_path, "r") as f:
                existing_data = yaml.safe_load(f)
                print(f"[DEBUG] Loaded existing data from {yaml_filename}")
        else:
            print(f"[DEBUG] No existing YAML file found. Creating new one.")
            existing_data = {}

        # Merge `cnr_custom_nodes` with priority to local versions
        existing_nodes = existing_data.get("cnr_custom_nodes", {})
        local_nodes = local_snapshot.get("cnr_custom_nodes", {})
        print(f"[DEBUG] Merging cnr_custom_nodes (existing: {len(existing_nodes)}, local: {len(local_nodes)})")
        merged_nodes = {**existing_nodes, **local_nodes}  # Local nodes take priority

        # Merge `git_custom_nodes` with priority to local versions
        existing_git_nodes = existing_data.get("git_custom_nodes", {})
        local_git_nodes = local_snapshot.get("git_custom_nodes", {})
        print(f"[DEBUG] Merging git_custom_nodes (existing: {len(existing_git_nodes)}, local: {len(local_git_nodes)})")
        merged_git_nodes = {**existing_git_nodes, **local_git_nodes}  # Local git nodes take priority

        # Create new data structure with empty pips
        updated_data = {
            "comfyui": local_snapshot.get("comfyui", ""),
            "git_custom_nodes": merged_git_nodes,
            "cnr_custom_nodes": merged_nodes,
            "file_custom_nodes": local_snapshot.get("file_custom_nodes", []),
            "pips": {}  # Explicitly empty dictionary
        }

        print("[DEBUG] Final structure:")
        print(f"- git_custom_nodes: {len(updated_data['git_custom_nodes'])} entries")
        print(f"- cnr_custom_nodes: {len(updated_data['cnr_custom_nodes'])} entries")
        print(f"- file_custom_nodes: {len(updated_data['file_custom_nodes'])} entries")
        print("- pips: empty dictionary")

        # Save to temp file
        temp_dir = tempfile.mkdtemp(prefix="comfyui_snapshot_")
        temp_path = os.path.join(temp_dir, yaml_filename)
        
        with open(temp_path, "w") as f:
            yaml.safe_dump(updated_data, f, sort_keys=False)
        
        print(f"[DEBUG] Saved updated YAML to: {temp_path}")

        # Upload back to repo
        api = HfApi()
        api.upload_file(
            path_or_fileobj=temp_path,
            path_in_repo=yaml_filename,
            repo_id=repo_id,
            token=token
        )
        print(f"[INFO] Successfully uploaded updated {yaml_filename} to repository")

        # Cleanup
        try:
            shutil.rmtree(temp_dir)
        except Exception as e:
            print(f"[WARNING] Failed to cleanup temp directory: {e}")

    except Exception as e:
        print(f"[ERROR] Failed to merge and update YAML: {e}")
        raise
