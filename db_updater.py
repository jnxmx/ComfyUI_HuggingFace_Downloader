import datetime
import hashlib
import json
import os
import threading
import urllib.error
import urllib.request
from typing import Any, Optional

DEFAULT_DB_VERSION_URL = os.environ.get(
    "HF_DOWNLOADER_DB_VERSION_URL",
    "https://raw.githubusercontent.com/jnxmx/ComfyUI_HuggingFace_Downloader/main/metadata/db_version.json",
)
DEFAULT_DB_URL = os.environ.get(
    "HF_DOWNLOADER_DB_URL",
    "https://raw.githubusercontent.com/jnxmx/ComfyUI_HuggingFace_Downloader/main/metadata/popular-models.json",
)

_METADATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "metadata")
LOCAL_DB_PATH = os.path.join(_METADATA_DIR, "popular-models.json")
LOCAL_DB_VERSION_PATH = os.path.join(_METADATA_DIR, "db_version.json")

_update_lock = threading.Lock()
_startup_check_started = False
_startup_check_lock = threading.Lock()


def compute_file_sha256(path: str) -> str:
    if not path or not os.path.isfile(path):
        return ""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _parse_iso_dt(value: Any) -> Optional[datetime.datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt
    except Exception:
        return None


def _read_json_file(path: str) -> Optional[dict[str, Any]]:
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _is_remote_newer(
    local_manifest: Optional[dict[str, Any]],
    local_sha256: str,
    remote_manifest: dict[str, Any],
) -> bool:
    remote_sha = str(remote_manifest.get("sha256") or "").strip().lower()
    if not remote_sha:
        return False
    if not local_sha256:
        return True
    if local_sha256.lower() == remote_sha:
        return False

    if isinstance(local_manifest, dict):
        local_dt = _parse_iso_dt(local_manifest.get("built_at"))
        remote_dt = _parse_iso_dt(remote_manifest.get("built_at"))
        if local_dt is not None and remote_dt is not None:
            return remote_dt > local_dt

    return True


def _invalidate_runtime_caches() -> None:
    try:
        from . import model_discovery
        if hasattr(model_discovery, "invalidate_popular_models_cache"):
            model_discovery.invalidate_popular_models_cache()
    except Exception:
        pass
    try:
        from . import web_api
        if hasattr(web_api, "_invalidate_model_library_assets_cache"):
            web_api._invalidate_model_library_assets_cache()
        if hasattr(web_api, "_invalidate_model_explorer_catalog_cache"):
            web_api._invalidate_model_explorer_catalog_cache()
    except Exception:
        pass


def check_and_update_database(
    db_path: str = LOCAL_DB_PATH,
    version_path: str = LOCAL_DB_VERSION_PATH,
    remote_version_url: str = DEFAULT_DB_VERSION_URL,
    remote_db_url: str = DEFAULT_DB_URL,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """
    Checks GitHub for a newer model database manifest (metadata/db_version.json)
    and atomically downloads metadata/popular-models.json if a newer version exists.
    """
    with _update_lock:
        headers = {"User-Agent": "ComfyUI_HuggingFace_Downloader/1.0"}
        try:
            req = urllib.request.Request(remote_version_url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                remote_manifest = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            return {"updated": False, "reason": "manifest_fetch_failed", "error": str(e)}

        if not isinstance(remote_manifest, dict) or not remote_manifest.get("sha256"):
            return {"updated": False, "reason": "invalid_remote_manifest"}

        local_manifest = _read_json_file(version_path)
        local_sha = compute_file_sha256(db_path)

        if not _is_remote_newer(local_manifest, local_sha, remote_manifest):
            return {
                "updated": False,
                "reason": "up_to_date",
                "sha256": local_sha,
            }

        remote_sha = str(remote_manifest["sha256"]).strip().lower()
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        tmp_db_path = f"{db_path}.tmp"
        tmp_ver_path = f"{version_path}.tmp"

        try:
            dl_req = urllib.request.Request(remote_db_url, headers=headers)
            h = hashlib.sha256()
            with urllib.request.urlopen(dl_req, timeout=max(timeout, 60.0)) as resp, open(tmp_db_path, "wb") as out:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    h.update(chunk)
                    out.write(chunk)

            downloaded_sha = h.hexdigest().lower()
            if downloaded_sha != remote_sha:
                raise ValueError(f"SHA-256 mismatch (expected {remote_sha}, got {downloaded_sha})")

            with open(tmp_db_path, "r", encoding="utf-8") as f:
                parsed = json.load(f)
            if not isinstance(parsed, dict) or not isinstance(parsed.get("models"), dict):
                raise ValueError("Downloaded database JSON is missing 'models' dictionary")

            os.replace(tmp_db_path, db_path)
            with open(tmp_ver_path, "w", encoding="utf-8") as vf:
                json.dump(remote_manifest, vf, indent=2)
                vf.write("\n")
            os.replace(tmp_ver_path, version_path)
        except Exception as e:
            for p in (tmp_db_path, tmp_ver_path):
                try:
                    if os.path.exists(p):
                        os.remove(p)
                except Exception:
                    pass
            return {"updated": False, "reason": "download_failed", "error": str(e)}

        _invalidate_runtime_caches()
        row_count = remote_manifest.get("row_count") or len(parsed.get("models", {}))
        built_at = remote_manifest.get("built_at") or "unknown"
        print(
            f"[ComfyUI_HuggingFace_Downloader] Updated model database from GitHub "
            f"({row_count} models, built_at={built_at})."
        )
        return {
            "updated": True,
            "row_count": row_count,
            "built_at": built_at,
            "sha256": remote_sha,
        }


def start_background_db_update_check() -> None:
    global _startup_check_started
    if os.environ.get("HF_DOWNLOADER_DISABLE_DB_AUTO_UPDATE", "").strip().lower() in {"1", "true", "yes"}:
        return
    with _startup_check_lock:
        if _startup_check_started:
            return
        _startup_check_started = True

    def _worker():
        try:
            check_and_update_database()
        except Exception as e:
            print(f"[ComfyUI_HuggingFace_Downloader] Background DB update check failed: {e}")

    t = threading.Thread(target=_worker, name="hf-downloader-db-updater", daemon=True)
    t.start()
