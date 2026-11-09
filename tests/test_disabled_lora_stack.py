import os
import sys
import unittest
from unittest.mock import MagicMock

# Ensure ComfyUI and server environment mocks are in place for standalone testing
for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web", "nodes"]:
    sys.modules.setdefault(mod_name, MagicMock())

# Add the parent directory containing the repo directory so package imports work
current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.model_discovery as md


class TestDisabledLoraStack(unittest.TestCase):
    def test_extract_models_ignores_disabled_lora_rows(self):
        workflow = {
            "nodes": [
                {
                    "id": 10,
                    "type": "LoadLoraModel",
                    "title": "Load LoRA (Model)",
                    "mode": 0,
                    "widgets_values_named": {
                        "loras.0.lora_name": "disabled_lora.safetensors",
                        "loras.0.strength": 1.0,
                        "loras.0.enabled": False,
                        "loras.1.lora_name": "active_lora.safetensors",
                        "loras.1.strength": 0.8,
                        "loras.1.enabled": True,
                    },
                    "properties": {
                        "models": [
                            {"name": "disabled_lora.safetensors", "directory": "loras"},
                            {"name": "active_lora.safetensors", "directory": "loras"},
                        ]
                    }
                }
            ]
        }
        models = md.extract_models_from_workflow(workflow)
        filenames = [m["filename"] for m in models]
        self.assertNotIn("disabled_lora.safetensors", filenames)
        self.assertIn("active_lora.safetensors", filenames)

    def test_extract_models_ignores_zero_strength_rows(self):
        workflow = {
            "nodes": [
                {
                    "id": 11,
                    "type": "LoadLoraModel",
                    "title": "Load LoRA (Model)",
                    "mode": 0,
                    "widgets_values": [
                        2,
                        "zero_strength_lora.safetensors", 0.0, True,
                        "real_lora.safetensors", 1.0, True
                    ],
                    "properties": {
                        "models": [
                            {"name": "zero_strength_lora.safetensors", "directory": "loras"},
                            {"name": "real_lora.safetensors", "directory": "loras"}
                        ]
                    }
                }
            ]
        }
        models = md.extract_models_from_workflow(workflow)
        filenames = [m["filename"] for m in models]
        self.assertNotIn("zero_strength_lora.safetensors", filenames)
        self.assertIn("real_lora.safetensors", filenames)

    def test_extract_models_all_disabled_returns_empty(self):
        workflow = {
            "nodes": [
                {
                    "id": 12,
                    "type": "LoadLoraModel",
                    "title": "Load LoRA (Model)",
                    "mode": 0,
                    "widgets_values_named": {
                        "loras.0.lora_name": "disabled_lora_1.safetensors",
                        "loras.0.strength": 1.0,
                        "loras.0.enabled": False,
                        "loras.1.lora_name": "disabled_lora_2.safetensors",
                        "loras.1.strength": 0.0,
                        "loras.1.enabled": True,
                    },
                    "properties": {
                        "models": [
                            {"name": "disabled_lora_1.safetensors", "directory": "loras"},
                            {"name": "disabled_lora_2.safetensors", "directory": "loras"},
                        ]
                    }
                }
            ]
        }
        models = md.extract_models_from_workflow(workflow)
        self.assertEqual(len(models), 0)

    def test_patch_lora_stack_validation(self):
        class DummyLoadLoraModel:
            pass

        import nodes
        nodes.NODE_CLASS_MAPPINGS = {"LoadLoraModel": DummyLoadLoraModel}
        
        md.patch_lora_stack_nodes()

        self.assertTrue(hasattr(DummyLoadLoraModel, "validate_inputs"))
        
        # When all rows are disabled or strength=0, validation must return True
        res_disabled = DummyLoadLoraModel.validate_inputs(
            loras=[
                {"lora_name": "nonexistent.safetensors", "strength": 1.0, "enabled": False},
                {"lora_name": "nonexistent2.safetensors", "strength": 0.0, "enabled": True},
            ]
        )
        self.assertIs(res_disabled, True)

        # When an enabled row has nonexistent file, validation must return an error message string
        import folder_paths
        folder_paths.get_full_path.return_value = None
        folder_paths.get_filename_list.return_value = []
        res_enabled = DummyLoadLoraModel.validate_inputs(
            loras=[
                {"lora_name": "nonexistent_active.safetensors", "strength": 1.0, "enabled": True},
            ]
        )
        self.assertIsInstance(res_enabled, str)
        self.assertIn("nonexistent_active.safetensors", res_enabled)


if __name__ == "__main__":
    unittest.main()
