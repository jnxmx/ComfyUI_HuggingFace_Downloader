import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web"]:
    sys.modules.setdefault(mod_name, MagicMock())

current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.web_api as web_api


class TestModelExplorerMoveAndCategories(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.models_root = os.path.realpath(os.path.join(self.tmpdir.name, "models"))
        os.makedirs(os.path.join(self.models_root, "checkpoints"), exist_ok=True)
        os.makedirs(os.path.join(self.models_root, "loras"), exist_ok=True)

        self.db_path = os.path.join(self.tmpdir.name, "popular-models.json")
        db_payload = {
            "version": "2.0.0",
            "models": {
                "ckpt_a.safetensors": {
                    "filename": "ckpt_a.safetensors",
                    "source": "cloud_marketplace_export",
                    "explorer_category": "checkpoints",
                    "explorer_base": "SDXL",
                    "explorer_enabled": True,
                    "directory": "checkpoints",
                },
                "rife47.pth": {
                    "filename": "rife47.pth",
                    "source": "cloud_marketplace_export",
                    "explorer_category": "other",
                    "explorer_enabled": True,
                    "directory": "rife",
                },
                "birefnet_general_model.safetensors": {
                    "filename": "birefnet_general_model.safetensors",
                    "source": "cloud_marketplace_export",
                    "explorer_category": "other",
                    "explorer_enabled": True,
                    "directory": "BiRefNet/BiRefNet-General",
                },
                "sam2_hiera.safetensors": {
                    "filename": "sam2_hiera.safetensors",
                    "source": "cloud_marketplace_export",
                    "explorer_category": "other",
                    "explorer_enabled": True,
                    "directory": "sam2",
                },
            },
        }
        with open(self.db_path, "w", encoding="utf-8") as f:
            json.dump(db_payload, f)

        web_api._invalidate_model_explorer_catalog_cache()
        web_api._invalidate_model_library_local_cache()

    def tearDown(self):
        web_api._invalidate_model_explorer_catalog_cache()
        web_api._invalidate_model_library_local_cache()
        self.tmpdir.cleanup()

    def test_other_filter_and_new_categories(self):
        with (
            patch.object(web_api, "MODEL_EXPLORER_DB_PATH", self.db_path),
            patch.object(web_api, "_get_models_root", return_value=self.models_root),
            patch.object(web_api, "folder_paths", None),
        ):
            cats_payload = web_api._sync_model_explorer_list_categories()
            cat_ids = {item["id"] for item in cats_payload["categories"]}
            self.assertIn("frame_interpolation", cat_ids)
            self.assertIn("background_removal", cat_ids)
            self.assertIn("other", cat_ids)

            other_groups = web_api._sync_model_explorer_list_groups(
                category_filter="__other__",
                base_filter="",
                precision_filter="",
                installed_only=False,
                search_query="",
                offset=0,
                limit=50,
                installed_first=True,
            )
            filenames = [v["filename"] for g in other_groups["groups"] for v in g["variants"]]
            self.assertIn("sam2_hiera.safetensors", filenames)
            self.assertNotIn("ckpt_a.safetensors", filenames)
            self.assertNotIn("rife47.pth", filenames)
            self.assertNotIn("birefnet_general_model.safetensors", filenames)

    def test_move_model_to_another_folder(self):
        src_file = os.path.join(self.models_root, "checkpoints", "my_lora.safetensors")
        with open(src_file, "wb") as f:
            f.write(b"test-weights")

        with (
            patch.object(web_api, "MODEL_EXPLORER_DB_PATH", self.db_path),
            patch.object(web_api, "_get_models_root", return_value=self.models_root),
            patch("ComfyUI_HuggingFace_Downloader.file_manager.get_models_root", return_value=self.models_root),
            patch.object(web_api, "is_path_within_allowed_roots", return_value=True),
            patch.object(web_api, "folder_paths", None),
            patch.dict(sys.modules, {"folder_paths": None}),
        ):
            res, status = web_api._sync_model_explorer_move(
                filename="my_lora.safetensors",
                category="checkpoints",
                requested_model_path="my_lora.safetensors",
                target_folder="loras/wan",
            )
            self.assertEqual(status, 200)
            self.assertEqual(res["status"], "moved")
            self.assertEqual(res["target_folder"], "loras/wan")
            expected_dest = os.path.join(self.models_root, "loras", "wan", "my_lora.safetensors")
            self.assertFalse(os.path.exists(src_file))
            self.assertTrue(os.path.isfile(expected_dest))

            # Moving to same folder returns already_in_place
            res_same, status_same = web_api._sync_model_explorer_move(
                filename="my_lora.safetensors",
                category="loras",
                requested_model_path="wan/my_lora.safetensors",
                target_folder="loras/wan",
            )
            self.assertEqual(status_same, 200)
            self.assertEqual(res_same["status"], "already_in_place")


if __name__ == "__main__":
    unittest.main()
