import io
import json
import os
import sys
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

import ComfyUI_HuggingFace_Downloader.model_discovery as md


def _mock_urlopen_json(payload: dict):
    raw = json.dumps(payload).encode("utf-8")
    cm = MagicMock()
    cm.__enter__.return_value = io.BytesIO(raw)
    cm.__exit__.return_value = False
    return cm


class TestHFFulltextSearch(unittest.TestCase):
    def setUp(self):
        md._hf_search_cache.clear()
        md._hf_repo_files_cache.clear()
        md._hf_rate_limited_until = 0.0
        md._reset_hf_search_budget()

    def test_generic_filename_skipped_without_context(self):
        with patch("urllib.request.urlopen") as mock_open:
            cands = md._hf_fulltext_candidate_repos("model.safetensors", token=None)
            self.assertEqual(cands, [])
            mock_open.assert_not_called()

            res = md.search_huggingface_model("model.safetensors", mode="full")
            self.assertIsNone(res)
            mock_open.assert_not_called()

    def test_generic_filename_uses_context_when_available(self):
        payload = {
            "hits": [
                {
                    "repoOwner": {"name": "lodestones"},
                    "repoName": "Chroma",
                    "likes": 120,
                    "formatted": "<em>model.safetensors</em> for chroma",
                }
            ]
        }
        with patch("urllib.request.urlopen", return_value=_mock_urlopen_json(payload)) as mock_open, \
             patch.object(md, "_get_repo_files", return_value=["diffusion_models/model.safetensors"]):
            res = md.search_huggingface_model(
                "model.safetensors",
                mode="full",
                workflow_keywords=["chroma"],
            )
            self.assertIsNotNone(res)
            self.assertEqual(res["hf_repo"], "lodestones/Chroma")
            self.assertEqual(res["hf_path"], "diffusion_models/model.safetensors")
            called_url = mock_open.call_args[0][0].full_url
            self.assertIn("model.safetensors", called_url)
            self.assertIn("chroma", called_url.lower())

    def test_fallback_ranks_priority_author_above_forks_and_verifies_files(self):
        payload = {
            "hits": [
                {
                    "repoOwner": "randomfork",
                    "repoName": "mirror-repo",
                    "likes": 999,
                    "formatted": "includes <em>rare_model_v1.safetensors</em>",
                },
                {
                    "repoOwner": {"name": "Comfy-Org"},
                    "repoName": "official-repack",
                    "likes": 5,
                    "formatted": "includes <em>rare_model_v1.safetensors</em>",
                },
                {
                    "repoOwner": "badhit",
                    "repoName": "unrelated",
                    "likes": 500,
                    "formatted": "no exact match here",
                },
            ]
        }

        def fake_repo_files(api, repo_id, token=None):
            if repo_id == "Comfy-Org/official-repack":
                return ["split_files/diffusion_models/rare_model_v1.safetensors"]
            return []

        with patch.object(md.HfApi, "list_models", return_value=[]), \
             patch("urllib.request.urlopen", return_value=_mock_urlopen_json(payload)), \
             patch.object(md, "_get_repo_files", side_effect=fake_repo_files):
            res = md.search_huggingface_model("rare_model_v1.safetensors", mode="full")
            self.assertIsNotNone(res)
            self.assertEqual(res["hf_repo"], "Comfy-Org/official-repack")
            self.assertEqual(
                res["url"],
                "https://huggingface.co/Comfy-Org/official-repack/resolve/main/split_files/diffusion_models/rare_model_v1.safetensors",
            )

    def test_search_huggingface_variants_for_model_explorer(self):
        ft_payload = {
            "hits": [
                {
                    "repoOwner": {"name": "lodestones"},
                    "repoName": "Kromoss",
                    "likes": 42,
                    "formatted": "<em>kromoss_int8_convrot.safetensors</em>",
                }
            ]
        }
        with patch("urllib.request.urlopen", return_value=_mock_urlopen_json(ft_payload)), \
             patch.object(
                 md.HfApi,
                 "list_models",
                 return_value=[SimpleNamespace(modelId="other/Kromoss-Fork", likes=10, downloads=50)],
             ), \
             patch.object(
                 md,
                 "_get_repo_files",
                 side_effect=lambda api, rid, token=None: (
                     ["kromoss_int8_convrot.safetensors", "README.md"]
                     if rid == "lodestones/Kromoss"
                     else ["kromoss_int8_convrot.safetensors"]
                 ),
             ):
            results = md.search_huggingface_variants("kromoss_int8_convrot.safetensors", category="diffusion_models")
            self.assertGreaterEqual(len(results), 1)
            self.assertEqual(results[0]["repo_id"], "lodestones/Kromoss")
            self.assertTrue(results[0]["is_priority_author"])
            self.assertEqual(results[0]["directory"], "diffusion_models")


if __name__ == "__main__":
    unittest.main()
