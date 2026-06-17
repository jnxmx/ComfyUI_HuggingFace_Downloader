#!/usr/bin/env python3
import os
import sys
import shutil
import subprocess
import json
import yaml
import re
import argparse
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

_GIT_HASH_RE = re.compile(r"^[0-9a-fA-F]{40}$")

def find_comfy_root(start_dir: str = None) -> str:
    """Dynamically locate the ComfyUI root directory."""
    current_dir = os.path.abspath(start_dir or os.path.dirname(__file__))
    while current_dir != os.path.dirname(current_dir):
        if os.path.isdir(os.path.join(current_dir, "custom_nodes")):
            return current_dir
        current_dir = os.path.dirname(current_dir)
    raise RuntimeError("Could not locate the ComfyUI root directory (custom_nodes folder not found).")

def find_manager_cli(comfy_dir: str) -> str:
    candidates = [
        os.path.join(comfy_dir, "custom_nodes", "ComfyUI-Manager", "cm-cli.py"),
        os.path.join(comfy_dir, "custom_nodes", "comfyui-manager", "cm-cli.py"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    raise RuntimeError("ComfyUI-Manager cm-cli.py not found. Install it first to restore nodes.")

# --- Snapshot Merge Logic ---

def _as_str(value) -> str:
    return str(value).strip() if value is not None else ""

def _as_dict(value) -> dict:
    return dict(value) if isinstance(value, dict) else {}

def _as_list(value) -> list:
    return list(value) if isinstance(value, list) else []

def _normalize_repo_url(repo_url: str) -> str:
    cleaned = repo_url.strip().rstrip("/")
    if cleaned.endswith(".git"):
        cleaned = cleaned[:-4]
    return cleaned.lower()

def _candidate_repo_urls(repo_url: str) -> list[str]:
    cleaned = repo_url.strip()
    candidates = [cleaned]
    if cleaned.endswith(".git"):
        candidates.append(cleaned[:-4])
    else:
        candidates.append(f"{cleaned}.git")
    seen = set()
    ordered = []
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)
    return ordered

def _remote_head(repo_url: str) -> str:
    errors = []
    for candidate in _candidate_repo_urls(repo_url):
        proc = subprocess.run(
            ["git", "ls-remote", candidate, "HEAD"],
            text=True, capture_output=True, check=False
        )
        if proc.returncode != 0:
            err = proc.stderr.strip() or f"exit {proc.returncode}"
            errors.append(f"{candidate}: {err}")
            continue
        first_line = next((line for line in proc.stdout.splitlines() if line.strip()), "")
        commit_hash = first_line.split()[0] if first_line else ""
        if _GIT_HASH_RE.match(commit_hash):
            return commit_hash
        errors.append(f"{candidate}: unexpected output '{first_line}'")
    error_text = "; ".join(errors) if errors else "no candidate URLs tried"
    raise RuntimeError(f"Unable to resolve remote HEAD for '{repo_url}': {error_text}")

def _existing_git_hash(node_data) -> str:
    if isinstance(node_data, dict):
        commit_hash = _as_str(node_data.get("hash"))
        return commit_hash if _GIT_HASH_RE.match(commit_hash) else ""
    if isinstance(node_data, str):
        commit_hash = _as_str(node_data)
        return commit_hash if _GIT_HASH_RE.match(commit_hash) else ""
    return ""

def _extract_custom_nodes(snapshot: dict) -> dict:
    # Look for custom_nodes key or assume it is the payload
    payload = snapshot.get("custom_nodes", snapshot)
    if not isinstance(payload, dict):
        payload = {}
    
    info = {}
    comfyui = payload.get("comfyui")
    if comfyui:
        info["comfyui"] = _as_str(comfyui)

    # Simplified normalization from script
    def norm_git(v):
        out = {}
        if isinstance(v, dict):
            for k, val in v.items():
                if not k: continue
                entry = {}
                if isinstance(val, dict):
                    if "hash" in val and val["hash"]: entry["hash"] = _as_str(val["hash"])
                    if "disabled" in val: entry["disabled"] = bool(val["disabled"])
                elif isinstance(val, str):
                    entry["hash"] = val.strip()
                out[k] = entry
        return out

    def norm_cnr(v):
        out = {}
        if isinstance(v, dict):
            for k, val in v.items():
                if not k: continue
                out[str(k)] = val
        return out
    
    def norm_file(v):
        out = []
        if isinstance(v, dict):
            for k, val in v.items():
                if not k: continue
                disabled = False
                if isinstance(val, bool): disabled = val
                elif isinstance(val, dict): disabled = bool(val.get("disabled", False))
                out.append({"filename": str(k), "disabled": disabled})
        elif isinstance(v, list):
            out = v
        return out

    info["git_custom_nodes"] = norm_git(payload.get("git_custom_nodes"))
    info["cnr_custom_nodes"] = norm_cnr(payload.get("cnr_custom_nodes"))
    info["file_custom_nodes"] = norm_file(payload.get("file_custom_nodes"))
    info["pips"] = _as_dict(payload.get("pips"))
    return info

def convert_snapshot_to_native_latest(snapshot: dict, strict_git_head: bool, label: str) -> dict:
    snapshot_custom = _extract_custom_nodes(snapshot)
    snapshot_git = _as_dict(snapshot_custom.get("git_custom_nodes"))
    snapshot_cnr = _as_dict(snapshot_custom.get("cnr_custom_nodes"))

    native_git = {}
    failed_head_resolve = []

    for repo_url, snapshot_node_data in snapshot_git.items():
        repo = _as_str(repo_url)
        if not repo:
            continue

        entry = dict(snapshot_node_data) if isinstance(snapshot_node_data, dict) else {}
        try:
            head_hash = _remote_head(repo)
        except Exception as exc:
            existing_hash = _existing_git_hash(snapshot_node_data)
            if not strict_git_head and existing_hash:
                entry["hash"] = existing_hash
                native_git[repo] = entry
                print(f"[restore][warn] failed to resolve remote HEAD for {label} git node {repo}; keeping existing hash {existing_hash[:12]}", file=sys.stderr)
                continue
            failed_head_resolve.append(f"{repo}: {exc}")
            continue

        entry["hash"] = head_hash
        native_git[repo] = entry

    if failed_head_resolve:
        print(f"[restore][warn] Failed to resolve remote HEAD for one or more {label} git nodes:\n" + "\n".join(failed_head_resolve), file=sys.stderr)

    native_cnr = {str(node_name): None for node_name in snapshot_cnr.keys()}

    native_custom = {
        "git_custom_nodes": native_git,
        "cnr_custom_nodes": native_cnr,
        "file_custom_nodes": _as_list(snapshot_custom.get("file_custom_nodes")),
        "pips": {},
    }
    if snapshot_custom.get("comfyui"):
        native_custom["comfyui"] = snapshot_custom["comfyui"]

    return {"custom_nodes": native_custom}

def merge_backup_into_current(backup_native_latest: dict, current: dict) -> dict:
    backup_custom = _extract_custom_nodes(backup_native_latest)
    current_custom = _extract_custom_nodes(current)

    merged_custom = dict(current_custom)
    current_git = _as_dict(current_custom.get("git_custom_nodes"))
    current_cnr = _as_dict(current_custom.get("cnr_custom_nodes"))
    current_files = _as_list(current_custom.get("file_custom_nodes"))

    merged_git = dict(current_git)
    merged_cnr = dict(current_cnr)
    current_git_key_by_norm = {_normalize_repo_url(url): url for url in current_git.keys()}

    for repo_url, backup_node_data in _as_dict(backup_custom.get("git_custom_nodes")).items():
        repo = _as_str(repo_url)
        if not repo: continue
        target_key = current_git_key_by_norm.get(_normalize_repo_url(repo), repo)
        
        entry = dict(merged_git.get(target_key, {}))
        if isinstance(backup_node_data, dict):
            entry.update(backup_node_data)
        merged_git[target_key] = entry

    for node_name in _as_dict(backup_custom.get("cnr_custom_nodes")).keys():
        merged_cnr[str(node_name)] = None

    merged_custom["git_custom_nodes"] = merged_git
    merged_custom["cnr_custom_nodes"] = merged_cnr
    merged_custom["file_custom_nodes"] = current_files
    merged_custom["pips"] = {}

    return {"custom_nodes": merged_custom}

def load_snapshot(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            if path.endswith(".json"): return json.load(f)
            return yaml.safe_load(f)
    except Exception:
        return {}

# --- Main Restore Logic ---

def main():
    parser = argparse.ArgumentParser(description="Restore ComfyUI workspace from Hugging Face backup.")
    parser.add_argument("--comfy-dir", default=None, help="Path to ComfyUI root directory")
    parser.add_argument("--skip-models", action="store_true", help="Skip restoring the models directory")
    parser.add_argument("--only-models", action="store_true", help="Only restore the models directory")
    args = parser.parse_args()

    if args.skip_models and args.only_models:
        print("[restore][error] Cannot specify both --skip-models and --only-models.")
        sys.exit(1)

    repo_id = os.environ.get("COMFYUI_BACKUP", "").strip()
    if not repo_id:
        print("[restore] COMFYUI_BACKUP environment variable is not set. Skipping restore.")
        sys.exit(0)

    try:
        api = HfApi()
        # Verify access
        api.repo_info(repo_id=repo_id, repo_type="model")
    except Exception as e:
        print(f"[restore] Backup repo '{repo_id}' not accessible ({e}); skipping restore.")
        sys.exit(0)

    try:
        comfy_dir = args.comfy_dir or find_comfy_root()
    except Exception as e:
        print(f"[restore] {e}")
        sys.exit(1)

    print(f"[restore] Using ComfyUI root: {comfy_dir}")
    
    # Use distinct temp dirs if running in parallel to avoid conflicts
    if args.only_models:
        tmp_dir = os.path.join(comfy_dir, ".hf_backup_tmp_models")
    else:
        tmp_dir = os.path.join(comfy_dir, ".hf_backup_tmp")
    
    if os.path.isdir(tmp_dir):
        shutil.rmtree(tmp_dir)

    # Configure download patterns
    download_kwargs = {
        "repo_id": repo_id,
        "local_dir": tmp_dir,
        "local_dir_use_symlinks": False,
        "resume_download": True,
    }
    if args.only_models:
        download_kwargs["allow_patterns"] = ["ComfyUI/models/**", "models/**"]
    else:
        ignore_pats = ["README.md", ".gitattributes"]
        if args.skip_models:
            ignore_pats.extend(["ComfyUI/models/**", "models/**"])
        download_kwargs["ignore_patterns"] = ignore_pats

    print(f"[restore] Downloading backup from {repo_id}...")
    try:
        snapshot_download(**download_kwargs)
    except Exception as e:
        print(f"[restore] Failed to download backup: {e}")
        sys.exit(1)

    # Paths inside downloaded backup usually have "ComfyUI/" prefix because backup.py forces it.
    backup_comfy_root = os.path.join(tmp_dir, "ComfyUI")
    if not os.path.isdir(backup_comfy_root):
        # Fallback if no ComfyUI dir, assume tmp_dir is root
        backup_comfy_root = tmp_dir

    print("[restore] Copying files into ComfyUI directory...")
    # List of directories to merge directly
    if args.only_models:
        dirs_to_merge = ["models"]
    else:
        dirs_to_merge = ["input", "output", "user"]
        if not args.skip_models:
            dirs_to_merge.append("models")

    for d in dirs_to_merge:
        src = os.path.join(backup_comfy_root, d)
        dst = os.path.join(comfy_dir, d)
        if os.path.isdir(src):
            for root, _, files in os.walk(src):
                rel = os.path.relpath(root, src)
                dst_dir = os.path.join(dst, rel) if rel != "." else dst
                os.makedirs(dst_dir, exist_ok=True)
                for f in files:
                    s = os.path.join(root, f)
                    d_path = os.path.join(dst_dir, f)
                    if os.path.exists(d_path) and not os.path.islink(d_path):
                        try: os.remove(d_path)
                        except: pass
                    shutil.copy2(s, d_path)
            print(f"[restore] Restored directory: {d}")

    # Now handle nodes (skip if --only-models)
    if not args.only_models:
        manager_cli = None
        try:
            manager_cli = find_manager_cli(comfy_dir)
        except Exception as e:
            print(f"[restore] {e}")
            manager_cli = None

        if manager_cli:
            print("[restore] Merging custom nodes snapshot...")
            current_snapshot_path = os.path.join(tmp_dir, "current_snapshot.yaml")
            # Save current snapshot
            subprocess.run(
                [sys.executable, manager_cli, "save-snapshot", "--output", current_snapshot_path],
                cwd=comfy_dir, check=False, stdout=subprocess.DEVNULL
            )

            backup_snapshot_path = None
            for cand in ["custom_nodes_snapshot.yaml", "custom_nodes_snapshot.json"]:
                p = os.path.join(backup_comfy_root, cand)
                if os.path.isfile(p):
                    backup_snapshot_path = p
                    break
            
            if not backup_snapshot_path:
                # Maybe inside user/__manager/snapshots
                snaps_dir = os.path.join(backup_comfy_root, "user", "__manager", "snapshots")
                if os.path.isdir(snaps_dir):
                    cands = [os.path.join(snaps_dir, f) for f in os.listdir(snaps_dir) if f.endswith(('.yaml', '.json'))]
                    if cands:
                        backup_snapshot_path = max(cands, key=os.path.getmtime)

            if backup_snapshot_path and os.path.isfile(current_snapshot_path):
                backup_data = load_snapshot(backup_snapshot_path)
                current_data = load_snapshot(current_snapshot_path)

                backup_native = convert_snapshot_to_native_latest(backup_data, strict_git_head=False, label="backup")
                current_native = convert_snapshot_to_native_latest(current_data, strict_git_head=False, label="current")

                merged = merge_backup_into_current(backup_native, current_native)
                merged_path = os.path.join(tmp_dir, "merged_restore.yaml")
                with open(merged_path, "w") as f:
                    yaml.safe_dump(merged, f, sort_keys=False)
                
                print("[restore] Calling cm-cli.py restore-snapshot...")
                env = os.environ.copy()
                env["PIP_NO_COMPILE"] = "1"
                subprocess.run(
                    [sys.executable, manager_cli, "restore-snapshot", merged_path],
                    cwd=comfy_dir, check=False, env=env
                )
            else:
                print("[restore] No backup snapshot or current snapshot found. Skipping node restore.")
    
    print("[restore] Cleaning up temporary files...")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    print("[restore] Done.")

if __name__ == "__main__":
    main()
