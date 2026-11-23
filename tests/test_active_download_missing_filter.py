import os
import sys
import unittest
from unittest.mock import MagicMock

for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web"]:
    sys.modules.setdefault(mod_name, MagicMock())

current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.web_api as web_api


class TestFilterActiveDownloadsFromMissing(unittest.TestCase):
    def setUp(self):
        with web_api.download_status_lock:
            self._orig_status = dict(web_api.download_status)
            web_api.download_status.clear()

    def tearDown(self):
        with web_api.download_status_lock:
            web_api.download_status.clear()
            web_api.download_status.update(self._orig_status)

    def test_excludes_actively_downloading_and_verifying_models(self):
        with web_api.download_status_lock:
            web_api.download_status["dl_1"] = {
                "status": "downloading",
                "filename": "qwen3.8_27b_uncensored_w4a8_convrot.safetensors",
                "folder": "text_encoders",
            }
            web_api.download_status["dl_2"] = {
                "status": "verifying",
                "filename": "minimax_h3_vae.safetensors",
                "folder": "vae",
            }
            web_api.download_status["dl_3"] = {
                "status": "failed",
                "filename": "broken_model.safetensors",
                "folder": "checkpoints",
            }

        result = {
            "missing": [
                {
                    "filename": "qwen3.8_27b_uncensored_w4a8_convrot.safetensors",
                    "requested_path": "qwen3.8_27b_uncensored_w4a8_convrot.safetensors",
                    "folder": "text_encoders",
                },
                {
                    "filename": "minimax_h3_vae.safetensors",
                    "requested_path": "vae/minimax_h3_vae.safetensors",
                    "folder": "vae",
                },
                {
                    "filename": "broken_model.safetensors",
                    "requested_path": "broken_model.safetensors",
                    "folder": "checkpoints",
                },
            ],
            "found": [],
        }

        filtered = web_api._filter_active_downloads_from_missing(result)
        self.assertEqual(
            [m["filename"] for m in filtered["missing"]],
            ["broken_model.safetensors"],
        )
        self.assertEqual(len(filtered["found"]), 2)
        self.assertTrue(all(f.get("in_progress") for f in filtered["found"]))


if __name__ == "__main__":
    unittest.main()
