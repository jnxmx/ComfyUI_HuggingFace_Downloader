import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# Ensure ComfyUI and server environment mocks are in place for standalone testing
for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web"]:
    sys.modules.setdefault(mod_name, MagicMock())

# Add the parent directory containing the repo directory so package imports work
current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from huggingface_hub.hf_api import RepoFile, RepoFolder

import ComfyUI_HuggingFace_Downloader.file_manager as fm
import ComfyUI_HuggingFace_Downloader.web_api as web_api


FOLDER_TYPES = [
    "checkpoints", "loras", "vae", "text_encoders", "diffusion_models",
    "clip_vision", "controlnet", "upscale_models", "model_patches",
]


def _repo_file(path, size=100):
    return RepoFile(path=path, size=size, oid="x")


class TestSuggestModelFolder(unittest.TestCase):

    def test_root_file_has_no_suggestion(self):
        self.assertEqual(fm.suggest_model_folder("model.safetensors", FOLDER_TYPES), "")

    def test_top_level_model_folder(self):
        self.assertEqual(fm.suggest_model_folder("diffusion_models/a.safetensors", FOLDER_TYPES), "diffusion_models")
        self.assertEqual(fm.suggest_model_folder("vae/flux2-vae.safetensors", FOLDER_TYPES), "vae")

    def test_nested_split_files_layout(self):
        self.assertEqual(
            fm.suggest_model_folder("split_files/diffusion_models/wan.safetensors", FOLDER_TYPES),
            "diffusion_models",
        )
        self.assertEqual(
            fm.suggest_model_folder("split_files/clip_vision/clip_vision_h.safetensors", FOLDER_TYPES),
            "clip_vision",
        )

    def test_sub_path_below_match_is_kept(self):
        self.assertEqual(fm.suggest_model_folder("loras/wan/style.safetensors", FOLDER_TYPES), "loras/wan")
        self.assertEqual(
            fm.suggest_model_folder("split_files/loras/wan/v2/style.safetensors", FOLDER_TYPES),
            "loras/wan/v2",
        )

    def test_first_matching_segment_wins(self):
        self.assertEqual(fm.suggest_model_folder("checkpoints/vae/x.safetensors", FOLDER_TYPES), "checkpoints/vae")

    def test_legacy_aliases(self):
        self.assertEqual(fm.suggest_model_folder("unet/x.safetensors", FOLDER_TYPES), "diffusion_models")
        self.assertEqual(fm.suggest_model_folder("clip/t5xxl.safetensors", FOLDER_TYPES), "text_encoders")

    def test_case_insensitive(self):
        self.assertEqual(fm.suggest_model_folder("Split_Files/VAE/x.safetensors", FOLDER_TYPES), "vae")

    def test_unrelated_folders(self):
        self.assertEqual(fm.suggest_model_folder("example workflows_Wan2.1/t2v.json", FOLDER_TYPES), "")
        # Diffusers-style singular names are not ComfyUI folders.
        self.assertEqual(fm.suggest_model_folder("text_encoder/model.safetensors", FOLDER_TYPES), "")

    def test_default_folder_types_fallback(self):
        # folder_paths is mocked in tests, so the fallback list is used.
        self.assertEqual(fm.suggest_model_folder("split_files/text_encoders/t5.safetensors"), "text_encoders")


class TestGuessModelFolderFromName(unittest.TestCase):

    def guess(self, path, folder_types=FOLDER_TYPES + ["vae_approx", "latent_upscale_models", "audio_encoders"]):
        return fm.guess_model_folder_from_name(path, folder_types)

    def test_real_world_names(self):
        cases = {
            # Kijai/WanVideo_comfy root files
            "Wan21_CausVid_14B_T2V_lora_rank32.safetensors": "loras",
            "UniAnimate-Wan2.1-14B-Lora-12000-fp16.safetensors": "loras",
            "Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors": "loras",
            "Wan2_1_VAE_bf16.safetensors": "vae",
            "taew2_1.safetensors": "vae_approx",
            "umt5-xxl-enc-bf16.safetensors": "text_encoders",
            "open-clip-xlm-roberta-large-vit-huge-14_visual_fp16.safetensors": "clip_vision",
            "Wan21_Uni3C_controlnet_fp16.safetensors": "controlnet",
            "HuMo/whisper_large_v3_encoder_fp16.safetensors": "audio_encoders",
            "Wan2_1-T2V-14B_fp8_e4m3fn.safetensors": "diffusion_models",
            "Phantom-Wan-14B_fp16.safetensors": "diffusion_models",
            "Qwen/Qwen2.5_7B_instruct_bf16.safetensors": "text_encoders",
            # FLUX
            "ae.safetensors": "vae",
            "flux1-schnell.safetensors": "diffusion_models",
            "flux-vae-bf16.safetensors": "vae",
            "flux_shakker_labs_union_pro-fp8_e4m3fn.safetensors": "controlnet",
            "clip_l.safetensors": "text_encoders",
            "t5xxl_fp8_e4m3fn_scaled.safetensors": "text_encoders",
            # Misc
            "RealESRGAN_x4plus.pth": "upscale_models",
            "4x-UltraSharp.pth": "upscale_models",
            "qwen_image_fp8_e4m3fn.safetensors": "diffusion_models",
            "sd_xl_base_1.0.safetensors": "checkpoints",
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(self.guess(path), expected)

    def test_specific_rules_beat_model_family(self):
        # Family names (flux, wan) appear in LoRA/VAE names but must not win.
        self.assertEqual(self.guess("flux_realism_lora.safetensors"), "loras")
        self.assertEqual(self.guess("wan_2.1_vae.safetensors"), "vae")

    def test_no_match(self):
        self.assertEqual(self.guess("body_pose_model.pth"), "")
        self.assertEqual(self.guess("model.safetensors"), "")
        # Short tokens must not match inside other words.
        self.assertEqual(self.guess("swan_lake_portrait.safetensors"), "")
        self.assertEqual(self.guess("explorations.safetensors"), "")

    def test_unavailable_folder_gives_no_hint(self):
        # The first matching rule decides; no fallback to a looser rule.
        self.assertEqual(fm.guess_model_folder_from_name("taew2_1.safetensors", FOLDER_TYPES), "")
        self.assertEqual(fm.guess_model_folder_from_name("ltx_latent_upscaler.safetensors", FOLDER_TYPES), "")


class TestListHfRepoFiles(unittest.TestCase):

    def _list(self, link, entries):
        api = MagicMock()
        api.list_repo_tree.return_value = entries
        with patch("huggingface_hub.HfApi", return_value=api), \
                patch.object(web_api, "get_token", return_value=None), \
                patch.object(web_api, "get_model_folder_types", return_value=FOLDER_TYPES), \
                patch.object(web_api, "resolve_target_dir", side_effect=lambda f: os.path.join("/nonexistent-models", f)):
            return web_api._list_hf_repo_files(link), api

    def test_shapes_files_and_suggestions(self):
        entries = [
            _repo_file(".gitattributes"),
            _repo_file("README.md"),
            RepoFolder(path="split_files", oid="t"),
            _repo_file("split_files/diffusion_models/wan_fp8.safetensors", size=16_000_000_000),
            _repo_file("split_files/vae/wan_vae.safetensors"),
            _repo_file("lora_at_root.safetensors"),
        ]
        result, api = self._list("Comfy-Org/Wan_2.1_ComfyUI_repackaged", entries)

        self.assertEqual(result["repo"], "Comfy-Org/Wan_2.1_ComfyUI_repackaged")
        self.assertEqual(result["revision"], "main")
        self.assertFalse(result["is_diffusers"])
        self.assertEqual(api.list_repo_tree.call_args.kwargs["path_in_repo"], None)

        by_path = {f["path"]: f for f in result["files"]}
        self.assertNotIn("split_files", by_path)  # folders are dropped
        self.assertFalse(by_path["README.md"]["is_model"])
        self.assertFalse(by_path[".gitattributes"]["is_model"])

        dm = by_path["split_files/diffusion_models/wan_fp8.safetensors"]
        self.assertTrue(dm["is_model"])
        self.assertEqual(dm["suggested_folder"], "diffusion_models")
        self.assertEqual(dm["dir"], "split_files/diffusion_models")
        self.assertEqual(dm["name"], "wan_fp8.safetensors")
        self.assertEqual(dm["size"], 16_000_000_000)
        self.assertFalse(dm["exists"])

        self.assertEqual(by_path["split_files/vae/wan_vae.safetensors"]["suggested_folder"], "vae")
        self.assertEqual(by_path["lora_at_root.safetensors"]["suggested_folder"], "")

    def test_tree_link_passes_revision_and_subfolder(self):
        entries = [_repo_file("split_files/vae/v.safetensors")]
        result, api = self._list(
            "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/dev/split_files", entries
        )
        self.assertEqual(result["revision"], "dev")
        self.assertEqual(result["subfolder"], "split_files")
        kwargs = api.list_repo_tree.call_args.kwargs
        self.assertEqual(kwargs["revision"], "dev")
        self.assertEqual(kwargs["path_in_repo"], "split_files")
        self.assertTrue(kwargs["recursive"])

    def test_diffusers_repo_disables_suggestions(self):
        entries = [
            _repo_file("model_index.json"),
            _repo_file("unet/diffusion_pytorch_model.safetensors"),
            _repo_file("vae/diffusion_pytorch_model.safetensors"),
        ]
        result, _ = self._list("someone/diffusers-repo", entries)
        self.assertTrue(result["is_diffusers"])
        self.assertTrue(all(f["suggested_folder"] == "" for f in result["files"]))

    def test_hint_folder_only_for_unrouted_model_files(self):
        entries = [
            _repo_file("README.md"),
            _repo_file("ae.safetensors"),
            _repo_file("my_style_lora.safetensors"),
            _repo_file("vae/wan_vae.safetensors"),
            _repo_file("mystery.safetensors"),
        ]
        result, _ = self._list("someone/mixed-repo", entries)
        by_path = {f["path"]: f for f in result["files"]}
        self.assertEqual(by_path["ae.safetensors"]["hint_folder"], "vae")
        self.assertEqual(by_path["my_style_lora.safetensors"]["hint_folder"], "loras")
        self.assertEqual(by_path["README.md"]["hint_folder"], "")
        self.assertEqual(by_path["mystery.safetensors"]["hint_folder"], "")
        # Already routed by its folder, so no hint.
        self.assertEqual(by_path["vae/wan_vae.safetensors"]["suggested_folder"], "vae")
        self.assertEqual(by_path["vae/wan_vae.safetensors"]["hint_folder"], "")

    def test_diffusers_repo_hints_root_files_only(self):
        entries = [
            _repo_file("model_index.json"),
            _repo_file("ae.safetensors"),
            _repo_file("flux1-schnell.safetensors"),
            _repo_file("vae/diffusion_pytorch_model.safetensors"),
        ]
        result, _ = self._list("black-forest-labs/FLUX.1-schnell", entries)
        by_path = {f["path"]: f for f in result["files"]}
        self.assertEqual(by_path["ae.safetensors"]["hint_folder"], "vae")
        self.assertEqual(by_path["flux1-schnell.safetensors"]["hint_folder"], "diffusion_models")
        self.assertEqual(by_path["vae/diffusion_pytorch_model.safetensors"]["hint_folder"], "")


if __name__ == "__main__":
    unittest.main()
