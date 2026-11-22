# Hugging Face Download & Backup for ComfyUI

A complete model management, auto-download, and cloud backup suite for ComfyUI.

Stop hunting down broken links when opening shared workflows. This pack automatically detects missing models, resolves download URLs across 30,000+ indexed Hugging Face & Comfy Cloud entries, downloads them at full speed via `hf-xet`, and lets you back up and restore your entire ComfyUI setup to a Hugging Face repository.

---

## Key Features

### 1. Auto-Download Missing Workflow Models
- **Automatic workflow scanning** — inspects standard nodes and nested subgraphs to find missing models, already-installed files, and mismatched paths (with one-click **Fix Path**).
- **Multi-source model resolution**:
  1. Embedded workflow metadata
  2. Built-in curated model database (**30,000+ models**, automatically kept up to date from GitHub on startup)
  3. ComfyUI-Manager model lists (when installed)
  4. Live Hugging Face full-text filename search fallback
- **Smart alternatives** — suggests compatible models when an exact quantized variant cannot be found.
- **Native missing-model dialog integration** — adds one-click **Auto-search and download missing models** right where you need it.

### 2. Built-in Model Explorer
- Browse and filter thousands of models by category, architecture, and base model directly inside ComfyUI.
- Built-in live **Hugging Face Search** modal for models not yet in the curated catalog.
- One-click **Download**, **Use** (insert/apply in workflow), and **Delete** local files.

### 3. Fast Background Downloader & Status Panel
- **High-speed transfers** powered by `huggingface_hub` and `hf-xet`.
- **No 2× disk space spike** — moves downloaded files directly out of the Hugging Face cache on the same drive (instant rename instead of copying), with automatic chunked-copy fallback across different drives.
- **Manual Download dialog** — supports Hugging Face links (`resolve`, `blob`, `tree`, shorthand) as well as direct non-HF `http(s)` model URLs, with standard or custom destination folders.
- **Live Queue & Status Panel** — track progress, cancel active/queued downloads cleanly, run deferred integrity verification, and auto-refresh ComfyUI model dropdowns when downloads finish.

### 4. ComfyUI Workflow Nodes
- **`Hugging Face Download Model`** — downloads a single file from Hugging Face into a standard or custom models folder and outputs the resolved model filename for downstream loaders.
- **`Hugging Face Download Folder`** — downloads an entire Hugging Face repository or subfolder.

### 5. Backup & Restore ComfyUI to Hugging Face
- Back up selected workflows, models, settings, and custom node snapshots (`custom_nodes_snapshot.yaml` via `comfy-cli`) to your Hugging Face repository.
- Interactive remote tree browser for **selective backup, restore, and deletion**.
- **Token-safe** — automatically strips `downloader.hf_token` before uploading settings and preserves your local token on restore.

---

## Installation

### Option 1: ComfyUI Manager / Comfy Registry
Search for **Hugging Face Download & Backup** (`ComfyUI_HuggingFace_Downloader`) in ComfyUI Manager and install it, then restart ComfyUI.

### Option 2: Manual Installation
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/jnxmx/ComfyUI_HuggingFace_Downloader.git
cd ComfyUI_HuggingFace_Downloader
pip install -r requirements.txt
```
Restart ComfyUI after installation.

---

## Quick Start

After restarting ComfyUI, open the **Hugging Face Download & Backup** menu in the top bar:

- **Auto-download models** — scan the current workflow for missing models and queue downloads.
- **Model Explorer** — browse and search 30,000+ models.
- **Download new model** — paste any Hugging Face link or direct HTTP(S) model URL.
- **Backup ComfyUI to Hugging Face** — back up or restore your ComfyUI environment.

> **Gated / Private Repos:** Set your Hugging Face token in ComfyUI Settings (`downloader.hf_token`) or via the `HF_TOKEN` environment variable.

---

## Settings

Configure in **ComfyUI Settings**:

| Setting | Description |
| --- | --- |
| `downloader.hf_token` | Hugging Face access token for gated/private repos and backups. |
| `downloader.auto_open_missing_models_on_run` | Automatically opens the downloader after clicking Run when ComfyUI detects missing models. |
| `downloaderbackup.repo_name` | Target Hugging Face repository (`username/repo`) for backups and restores. |
| `downloaderbackup.file_size_limit` | Maximum single file size (in GB) included in backups. |

---

<details>
<summary><strong>Advanced: Environment Variables & Web API Reference</strong></summary>

### Environment Variables
- `HF_TOKEN` — Hugging Face token (fallback if not set in ComfyUI settings)
- `HF_SEARCH_MAX_CALLS` (default: `200`)
- `HF_SEARCH_RATE_LIMIT_SECONDS` (default: `300`)
- `HF_SEARCH_MAX_SECONDS` (default: `60`)
- `HF_SEARCH_CALL_TIMEOUT` (default: `20`)
- `HF_PRIORITY_REPO_SCAN_LIMIT` (default: `100`)
- `HF_URL_CHECK_TIMEOUT` (default: `8`)
- `HF_DOWNLOADER_SHA_MAX_BYTES` — cap for SHA integrity verification

### Web API Endpoints
- `GET /folder_structure`
- `POST /check_missing_models`
- `POST /install_models`
- `POST /queue_download`
- `POST /cancel_download`
- `GET /download_status`
- `GET /search_status`
- `GET /model_library`
- `GET /api/model_explorer/categories`
- `GET /api/model_explorer/filters`
- `GET /api/model_explorer/groups`
- `POST /api/model_explorer/download`
- `POST /api/model_explorer/use`
- `POST /api/model_explorer/delete`
- `GET /backup_browser_tree`
- `POST /backup_to_hf`
- `POST /backup_selected_to_hf`
- `POST /restore_from_hf`
- `POST /restore_selected_from_hf`
- `POST /delete_from_hf_backup`
- `POST /restart`

</details>
