import os
import sys
import unittest
from unittest.mock import MagicMock

# Ensure ComfyUI and server environment mocks are in place for standalone testing
for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web", "nodes"]:
    sys.modules.setdefault(mod_name, MagicMock())

current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.model_discovery as md


class TestModelPreviewOverride(unittest.TestCase):
    def test_model_preview_override_array_widgets(self):
        workflow = {
            "nodes": [
                {
                    "id": 100,
                    "type": "ModelPreviewOverrideKJ",
                    "title": "Model Preview Override",
                    "mode": 0,
                    # widgets: [max_resolution, jpeg_quality, suppress_default_preview, preview_frames, preview_fps, tiny_vae]
                    "widgets_values": [1024, 80, True, 1, 12, "taeh3.safetensors"],
                }
            ]
        }
        models = md.extract_models_from_workflow(workflow)
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]["filename"], "taeh3.safetensors")
        self.assertEqual(models[0]["suggested_folder"], "vae_approx")

    def test_model_preview_override_named_widgets(self):
        workflow = {
            "nodes": [
                {
                    "id": 101,
                    "type": "Model Preview Override",
                    "title": "Model Preview Override",
                    "mode": 0,
                    "widgets_values_named": {
                        "max_resolution": 1024,
                        "jpeg_quality": 80,
                        "suppress_default_preview": True,
                        "preview_frames": 1,
                        "preview_fps": 12,
                        "tiny_vae": "taesd.safetensors",
                    },
                }
            ]
        }
        models = md.extract_models_from_workflow(workflow)
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]["filename"], "taesd.safetensors")
        self.assertEqual(models[0]["suggested_folder"], "vae_approx")

    def test_model_preview_override_none_ignored(self):
        workflow = {
            "nodes": [
                {
                    "id": 102,
                    "type": "ModelPreviewOverrideKJ",
                    "title": "Model Preview Override",
                    "mode": 0,
                    "widgets_values_named": {
                        "max_resolution": 1024,
                        "jpeg_quality": 80,
                        "suppress_default_preview": True,
                        "preview_frames": 1,
                        "preview_fps": 12,
                        "tiny_vae": "none",
                    },
                }
            ]
        }
        models = md.extract_models_from_workflow(workflow)
        self.assertEqual(len(models), 0)

    def test_guess_folder_from_filename_tae(self):
        self.assertEqual(md._guess_folder_from_filename("taeh3.safetensors"), "vae_approx")
        self.assertEqual(md._guess_folder_from_filename("taesdxl.safetensors"), "vae_approx")
        self.assertEqual(md._guess_folder_from_filename("taef1.safetensors"), "vae_approx")
        self.assertEqual(md._guess_folder_from_filename("taeltx_2.safetensors"), "vae_approx")


if __name__ == "__main__":
    unittest.main()
