import ast
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web"]:
    sys.modules.setdefault(mod_name, MagicMock())

current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.file_manager as fm
import ComfyUI_HuggingFace_Downloader.model_discovery as md


V3_DRAMA3_SAMPLE_CODE = """
ASR_FOLDER = "asr"

def _list_codec_models():
    return folder_paths.get_filename_list("vae")

class Drama3Loader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="Drama3Loader",
            inputs=[
                io.Combo.Input("model_name", options=folder_paths.get_filename_list("diffusion_models")),
                io.Combo.Input("precision", options=["bf16", "fp8"]),
            ],
        )

    @classmethod
    def execute(cls, model_name, precision):
        path = folder_paths.get_full_path_or_raise("diffusion_models", model_name)
        return io.NodeOutput(path)


class CustomIdCodecLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        inputs = [
            io.Model.Input("optional_pipe"),
            io.Combo.Input("codec_name", options=_list_codec_models()),
        ]
        return io.Schema(
            node_id="Drama3CodecLoader",
            inputs=inputs,
        )


class Qwen3ASRLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="Qwen3ASRLoader",
            inputs=[
                io.Combo.Input("model_name", options=folder_paths.get_filename_list(ASR_FOLDER)),
            ],
        )


class ExecuteOnlyFolderLoader(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ExecuteOnlyFolderLoader",
            inputs=[
                io.String.Input("model_name"),
            ],
        )

    @classmethod
    def execute(cls, model_name):
        return folder_paths.get_full_path_or_raise("audio_encoders", model_name)
"""


class TestUniversalNodepackDiscovery(unittest.TestCase):
    def setUp(self):
        md._hf_search_cache.clear()
        md._hf_repo_files_cache.clear()
        md._runtime_node_widget_schema_cache.clear()
        md._node_widget_schema_hints_cache = None

    def tearDown(self):
        md._node_widget_schema_hints_cache = None
        md._runtime_node_widget_schema_cache.clear()

    def test_v3_define_schema_and_execute_ast_scanning(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            custom_dir = os.path.join(tmpdir, "custom_nodes", "drama3")
            os.makedirs(custom_dir, exist_ok=True)
            with open(os.path.join(custom_dir, "nodes.py"), "w", encoding="utf-8") as f:
                f.write(V3_DRAMA3_SAMPLE_CODE)

            mock_fp = MagicMock()
            mock_fp.base_path = tmpdir
            mock_fp.models_dir = os.path.join(tmpdir, "models")

            with patch.object(md, "folder_paths", mock_fp):
                hints = md._scan_custom_node_widget_schemas()

            self.assertIn("Drama3Loader", hints)
            self.assertEqual(hints["Drama3Loader"][0], {"name": "model_name", "folders": ["diffusion_models"]})

            # Socket input (io.Model.Input) must not shift widget_index of codec_name
            self.assertIn("Drama3CodecLoader", hints)
            self.assertEqual(len(hints["Drama3CodecLoader"]), 1)
            self.assertEqual(hints["Drama3CodecLoader"][0], {"name": "codec_name", "folders": ["vae"]})
            self.assertIn("CustomIdCodecLoader", hints)

            # Module-level constant ASR_FOLDER = "asr" resolved cleanly
            self.assertIn("Qwen3ASRLoader", hints)
            self.assertEqual(hints["Qwen3ASRLoader"][0], {"name": "model_name", "folders": ["asr"]})

            # Folder inferred from execute() get_full_path_or_raise binding
            self.assertIn("ExecuteOnlyFolderLoader", hints)
            self.assertEqual(hints["ExecuteOnlyFolderLoader"][0], {"name": "model_name", "folders": ["audio_encoders"]})

    def test_authoritative_schema_prevents_filename_heuristic_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            custom_dir = os.path.join(tmpdir, "custom_nodes", "drama3")
            os.makedirs(custom_dir, exist_ok=True)
            with open(os.path.join(custom_dir, "nodes.py"), "w", encoding="utf-8") as f:
                f.write(V3_DRAMA3_SAMPLE_CODE)

            mock_fp = MagicMock()
            mock_fp.base_path = tmpdir
            mock_fp.models_dir = os.path.join(tmpdir, "models")
            mock_fp.folder_names_and_paths = {}

            workflow = {
                "nodes": [
                    {
                        "id": 10,
                        "type": "Drama3Loader",
                        "mode": 0,
                        "widgets_values": ["drama3_fp8experts_bf16.safetensors", "bf16"],
                    },
                    {
                        "id": 11,
                        "type": "Drama3CodecLoader",
                        "mode": 0,
                        "widgets_values": ["drama3_codec.safetensors"],
                    },
                    {
                        "id": 12,
                        "type": "Qwen3ASRLoader",
                        "mode": 0,
                        "widgets_values": ["qwen3_asr_1.7b_bf16.safetensors"],
                    },
                ],
                "links": [],
            }

            with patch.object(md, "folder_paths", mock_fp):
                extracted = md.extract_models_from_workflow(workflow)
                # Even if registries think qwen* belongs in text_encoders, authoritative lock protects "asr"
                with patch.object(md, "_lookup_known_directory_for_filename", return_value="text_encoders"):
                    md.apply_known_directory_hints(extracted)
                md.enforce_authoritative_node_folders(extracted)

            by_file = {m["filename"]: m for m in extracted}
            self.assertEqual(by_file["drama3_fp8experts_bf16.safetensors"]["suggested_folder"], "diffusion_models")
            self.assertTrue(by_file["drama3_fp8experts_bf16.safetensors"].get("folder_locked"))
            self.assertEqual(by_file["drama3_codec.safetensors"]["suggested_folder"], "vae")
            self.assertTrue(by_file["drama3_codec.safetensors"].get("folder_locked"))
            self.assertEqual(by_file["qwen3_asr_1.7b_bf16.safetensors"]["suggested_folder"], "asr")
            self.assertTrue(by_file["qwen3_asr_1.7b_bf16.safetensors"].get("folder_locked"))

    def test_markdown_note_repo_tier0_and_folder_table_extraction(self):
        # Simulate workflow where custom node pack is NOT installed yet: MarkdownNote provides both folder table & repos
        workflow = {
            "nodes": [
                {
                    "id": 1,
                    "type": "MarkdownNote",
                    "mode": 0,
                    "widgets_values": [
                        "### Setup\n"
                        "- [Drama-3-ComfyUI](https://huggingface.co/PedroMarinhoDev/Drama-3-ComfyUI)\n"
                        "- [Qwen3-ASR-ComfyUI](https://huggingface.co/PedroMarinhoDev/Qwen3-ASR-ComfyUI)\n\n"
                        "| File | Folder |\n"
                        "|---|---|\n"
                        "| `drama3_fp8experts_bf16.safetensors` | `models/diffusion_models` |\n"
                        "| `drama3_codec.safetensors` | `models/vae` |\n"
                        "| `qwen3_asr_1.7b_bf16.safetensors` | `models/asr` |\n"
                    ],
                },
                {
                    "id": 2,
                    "type": "UninstalledDramaLoader",
                    "mode": 0,
                    "widgets_values": ["drama3_fp8experts_bf16.safetensors"],
                },
                {
                    "id": 3,
                    "type": "UninstalledCodecLoader",
                    "mode": 0,
                    "widgets_values": ["drama3_codec.safetensors"],
                },
                {
                    "id": 4,
                    "type": "UninstalledASRLoader",
                    "mode": 0,
                    "widgets_values": ["qwen3_asr_1.7b_bf16.safetensors"],
                },
            ],
            "links": [],
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            mock_fp = MagicMock()
            mock_fp.base_path = tmpdir
            mock_fp.models_dir = os.path.join(tmpdir, "models")
            mock_fp.folder_names_and_paths = {}
            mock_fp.get_folder_paths.side_effect = KeyError("missing")

            def fake_repo_files(api, repo_id, token):
                if repo_id == "PedroMarinhoDev/Drama-3-ComfyUI":
                    return ["drama3_fp8experts_bf16.safetensors", "drama3_codec.safetensors"]
                if repo_id == "PedroMarinhoDev/Qwen3-ASR-ComfyUI":
                    return ["qwen3_asr_1.7b_bf16.safetensors"]
                return []

            with patch.object(md, "folder_paths", mock_fp), \
                 patch.object(md, "get_node_widget_schema_hints", return_value={}), \
                 patch.object(md, "load_popular_models_registry", return_value={}), \
                 patch.object(md, "load_comfyui_manager_model_list", return_value={}), \
                 patch.object(md, "load_comfyui_manager_cache", side_effect=lambda models, **kw: models), \
                 patch.object(md, "_get_repo_files", side_effect=fake_repo_files), \
                 patch.object(md, "HfApi") as mock_api_cls:
                res = md.process_workflow_for_missing_models(workflow)
                # Tier-0 note repos should resolve everything without needing priority-author list scans
                mock_api_cls.return_value.list_models.assert_not_called()

        by_file = {m["filename"]: m for m in res["missing"]}
        self.assertEqual(by_file["drama3_fp8experts_bf16.safetensors"]["suggested_folder"], "diffusion_models")
        self.assertEqual(by_file["drama3_codec.safetensors"]["suggested_folder"], "vae")
        self.assertEqual(by_file["qwen3_asr_1.7b_bf16.safetensors"]["suggested_folder"], "asr")
        self.assertEqual(
            by_file["drama3_codec.safetensors"]["url"],
            "https://huggingface.co/PedroMarinhoDev/Drama-3-ComfyUI/resolve/main/drama3_codec.safetensors",
        )
        self.assertEqual(
            by_file["qwen3_asr_1.7b_bf16.safetensors"]["url"],
            "https://huggingface.co/PedroMarinhoDev/Qwen3-ASR-ComfyUI/resolve/main/qwen3_asr_1.7b_bf16.safetensors",
        )

    def test_valid_model_folder_filtering_and_cross_bucket_check(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            models_dir = os.path.join(tmpdir, "models")
            asr_dir = os.path.join(models_dir, "asr")
            voices_output_dir = os.path.join(tmpdir, "output", "drama3", "voices")
            os.makedirs(asr_dir, exist_ok=True)
            os.makedirs(voices_output_dir, exist_ok=True)
            asr_file = os.path.join(asr_dir, "qwen3_asr_1.7b_bf16.safetensors")
            with open(asr_file, "w", encoding="utf-8") as f:
                f.write("weights")

            mock_fp = MagicMock()
            mock_fp.base_path = tmpdir
            mock_fp.models_dir = models_dir
            mock_fp.folder_names_and_paths = {
                "checkpoints": ([os.path.join(models_dir, "checkpoints")], {".safetensors"}),
                "asr": ([asr_dir], {".safetensors"}),
                "drama3_voices": ([voices_output_dir], {".wav"}),
            }
            mock_fp.get_folder_paths.side_effect = lambda k: mock_fp.folder_names_and_paths[k][0]

            self.assertTrue(fm.is_valid_model_folder_type("asr", comfy_root=tmpdir, folder_paths_mod=mock_fp))
            self.assertFalse(fm.is_valid_model_folder_type("drama3_voices", comfy_root=tmpdir, folder_paths_mod=mock_fp))

            buckets = fm.get_registered_model_buckets(models_dir=models_dir, folder_paths_mod=mock_fp)
            self.assertIn("asr", buckets)
            self.assertNotIn("drama3_voices", buckets)

            with patch.object(md, "folder_paths", mock_fp):
                # Even when suggested_folder is None (unknown node), cross-bucket check finds file in models/asr
                missing, existing, mismatches = md.check_model_files([
                    {
                        "filename": "qwen3_asr_1.7b_bf16.safetensors",
                        "requested_path": "qwen3_asr_1.7b_bf16.safetensors",
                        "suggested_folder": None,
                    }
                ])

            self.assertEqual(missing, [])
            self.assertEqual(len(existing), 1)
            self.assertEqual(existing[0]["suggested_folder"], "asr")
            self.assertEqual(existing[0]["actual_folder"], "asr")
            self.assertEqual(mismatches, [])


if __name__ == "__main__":
    unittest.main()
