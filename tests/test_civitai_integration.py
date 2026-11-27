import io
import json
import os
import sys
import tempfile
import unittest
import urllib.request
from unittest.mock import MagicMock, patch

for mod_name in ["comfy_api", "comfy_api.latest", "folder_paths", "server", "aiohttp", "aiohttp.web"]:
    sys.modules.setdefault(mod_name, MagicMock())

current_dir = os.path.dirname(os.path.abspath(__file__))
repo_dir = os.path.dirname(current_dir)
parent_dir = os.path.dirname(repo_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

import ComfyUI_HuggingFace_Downloader.backup as backup
import ComfyUI_HuggingFace_Downloader.civitai_client as civitai_client
import ComfyUI_HuggingFace_Downloader.downloader as downloader
import ComfyUI_HuggingFace_Downloader.model_discovery as model_discovery
import ComfyUI_HuggingFace_Downloader.web_api as web_api


class _FakeHttpResponse:
    def __init__(
        self,
        body: bytes,
        *,
        status: int = 200,
        headers: dict | None = None,
        url: str = "https://cdn.example.com/model.safetensors",
        interrupt_after_chunks: int | None = None,
        on_interrupt=None,
    ):
        self._buf = io.BytesIO(body)
        self.status = status
        self.headers = headers or {}
        self._url = url
        self._reads = 0
        self._interrupt_after_chunks = interrupt_after_chunks
        self._on_interrupt = on_interrupt

    def geturl(self):
        return self._url

    def getcode(self):
        return self.status

    def read(self, n=-1):
        if self._interrupt_after_chunks is not None and self._reads >= self._interrupt_after_chunks:
            if callable(self._on_interrupt):
                self._on_interrupt()
            return b""
        self._reads += 1
        return self._buf.read(n)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


class TestCivitaiClientAndUrlParsing(unittest.TestCase):
    def test_parse_civitai_url_all_supported_forms(self):
        p1 = civitai_client.parse_civitai_url(
            "https://civitai.com/models/84958/architecturerealmix?modelVersionId=431755"
        )
        self.assertEqual(p1["kind"], "model")
        self.assertEqual(p1["model_id"], "84958")
        self.assertEqual(p1["version_id"], "431755")

        p2 = civitai_client.parse_civitai_url("https://civitai.com/models/84958/architecturerealmix")
        self.assertEqual(p2["kind"], "model")
        self.assertEqual(p2["model_id"], "84958")
        self.assertIsNone(p2["version_id"])

        p3 = civitai_client.parse_civitai_url("https://civitai.com/models/84958")
        self.assertEqual(p3["kind"], "model")
        self.assertEqual(p3["model_id"], "84958")

        p4 = civitai_client.parse_civitai_url("https://civitai.com/model-versions/431755")
        self.assertEqual(p4["kind"], "version")
        self.assertEqual(p4["version_id"], "431755")

        p5 = civitai_client.parse_civitai_url(
            "https://civitai.com/api/download/models/431755?type=Model&token=SECRET"
        )
        self.assertEqual(p5["kind"], "download")
        self.assertEqual(p5["version_id"], "431755")
        self.assertNotIn("SECRET", p5["query"])

        p6 = civitai_client.parse_civitai_url(
            "https://civitai.green/models/123/test-lora?modelVersionId=999"
        )
        self.assertEqual(p6["kind"], "model")
        self.assertEqual(p6["model_id"], "123")
        self.assertEqual(p6["version_id"], "999")
        self.assertEqual(p6["host"], "civitai.green")

        self.assertIsNone(civitai_client.parse_civitai_url("https://huggingface.co/owner/repo"))
        self.assertIsNone(civitai_client.parse_civitai_url("https://civitai.com/user/account"))

    def test_resolve_civitai_target_selects_safetensor_folder_and_versions(self):
        fake_model_payload = {
            "id": 1001,
            "name": "Cool Style LoRA",
            "type": "LORA",
            "modelVersions": [
                {
                    "id": 2002,
                    "name": "v2.0",
                    "baseModel": "Flux.1 D",
                    "downloadUrl": "https://civitai.com/api/download/models/2002?token=LEAK",
                    "files": [
                        {
                            "name": "cool_style_v2.ckpt",
                            "type": "Model",
                            "primary": False,
                            "sizeKB": 100,
                            "metadata": {"format": "PickleTensor"},
                            "hashes": {"SHA256": "aaaa"},
                            "downloadUrl": "https://civitai.com/api/download/models/2002?format=PickleTensor",
                        },
                        {
                            "name": "cool_style_v2.safetensors",
                            "type": "Model",
                            "primary": True,
                            "sizeKB": 200,
                            "metadata": {"format": "SafeTensor"},
                            "hashes": {"SHA256": "DEADBEEF1234"},
                            "downloadUrl": "https://civitai.com/api/download/models/2002?type=Model&token=SECRET",
                        },
                    ],
                },
                {
                    "id": 2001,
                    "name": "v1.0",
                    "baseModel": "SDXL 1.0",
                    "files": [
                        {
                            "name": "cool_style_v1.safetensors",
                            "type": "Model",
                            "primary": True,
                            "sizeKB": 150,
                            "metadata": {"format": "SafeTensor"},
                            "hashes": {"SHA256": "11112222"},
                            "downloadUrl": "https://civitai.com/api/download/models/2001",
                        }
                    ],
                },
            ],
        }

        with patch.object(civitai_client, "_api_get_json", return_value=fake_model_payload):
            target = civitai_client.resolve_civitai_target(
                "https://civitai.com/models/1001/cool-style-lora",
                token="my-secret-key",
                include_versions=True,
            )

        self.assertEqual(target["filename"], "cool_style_v2.safetensors")
        self.assertEqual(target["folder"], "loras")
        self.assertEqual(target["base_model"], "FLUX.1 [dev]")
        self.assertEqual(target["sha256"], "deadbeef1234")
        self.assertEqual(target["size_bytes"], 200 * 1024)
        self.assertNotIn("SECRET", target["download_url"])
        self.assertEqual(len(target["versions"]), 2)
        self.assertEqual(target["versions"][0]["id"], "2002")
        self.assertEqual(target["versions"][1]["id"], "2001")

    def test_resolve_rejects_danger_virus_scan(self):
        bad_payload = {
            "id": 55,
            "name": "Evil",
            "type": "Checkpoint",
            "modelVersions": [
                {
                    "id": 77,
                    "name": "v1",
                    "files": [
                        {
                            "name": "evil.ckpt",
                            "type": "Model",
                            "primary": True,
                            "virusScanResult": "Danger",
                        }
                    ],
                }
            ],
        }
        with patch.object(civitai_client, "_api_get_json", return_value=bad_payload):
            with self.assertRaises(civitai_client.CivitaiError) as ctx:
                civitai_client.resolve_civitai_target("https://civitai.com/models/55", token="k")
            self.assertEqual(ctx.exception.error_code, "civitai_unsafe_file")


class TestDownloaderCivitaiAndResume(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.models_root = os.path.realpath(os.path.join(self.tmpdir.name, "models"))
        self.loras_dir = os.path.join(self.models_root, "loras")
        os.makedirs(self.loras_dir, exist_ok=True)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_cross_origin_redirect_strips_auth_but_keeps_range(self):
        handler = downloader._CrossOriginAuthStripRedirectHandler(
            civitai_client.CIVITAI_HOSTS,
            civitai_client.CIVITAI_USER_AGENT,
        )
        orig_req = urllib.request.Request(
            "https://civitai.com/api/download/models/123",
            headers={
                "Authorization": "Bearer super-secret-key",
                "Range": "bytes=1024-",
            },
        )
        # Same-family redirect preserves Authorization
        same_req = handler.redirect_request(
            orig_req, None, 307, "Temporary Redirect", {}, "https://www.civitai.com/api/download/models/123"
        )
        same_headers = {k.lower(): v for k, v in list(same_req.headers.items()) + list(same_req.unredirected_hdrs.items())}
        self.assertEqual(same_headers.get("authorization"), "Bearer super-secret-key")
        self.assertEqual(same_headers.get("range"), "bytes=1024-")

        # Cross-origin redirect to Cloudflare R2 strips Authorization (prevents S3 400 Bad Request)
        r2_req = handler.redirect_request(
            orig_req,
            None,
            307,
            "Temporary Redirect",
            {},
            "https://civitai-delivery-worker-prod.r2.cloudflarestorage.com/file?X-Amz-Signature=abc",
        )
        r2_headers = {k.lower(): v for k, v in list(r2_req.headers.items()) + list(r2_req.unredirected_hdrs.items())}
        self.assertNotIn("authorization", r2_headers)
        self.assertEqual(r2_headers.get("range"), "bytes=1024-")

    def test_html_login_page_is_rejected_not_saved(self):
        html_resp = _FakeHttpResponse(
            b"<html><body>Please sign in</body></html>",
            status=200,
            headers={"Content-Type": "text/html; charset=utf-8", "Content-Length": "38"},
            url="https://civitai.com/login?returnUrl=%2Fapi%2Fdownload%2Fmodels%2F999",
        )
        fake_opener = MagicMock()
        fake_opener.open.return_value = html_resp

        with patch.object(downloader, "resolve_target_dir", return_value=self.loras_dir), \
             patch.object(downloader, "is_path_within_allowed_roots", return_value=True), \
             patch.object(downloader, "get_civitai_token", return_value=None), \
             patch("urllib.request.build_opener", return_value=fake_opener):
            with self.assertRaises(RuntimeError) as ctx:
                downloader.run_download_url(
                    "https://civitai.com/api/download/models/999",
                    "loras",
                    sync=True,
                    target_filename="secret_lora.safetensors",
                    max_retries=0,
                )
            self.assertIn("API key", str(ctx.exception))
            self.assertFalse(os.path.exists(os.path.join(self.loras_dir, "secret_lora.safetensors")))

    def test_pause_preserves_part_and_resume_uses_range_206(self):
        full_payload = b"A" * (1024 * 1024 + 500)
        part_one = full_payload[: 1024 * 1024]
        part_two = full_payload[1024 * 1024 :]

        paused = {"flag": False}

        def _trigger_pause():
            paused["flag"] = True

        resp_pause = _FakeHttpResponse(
            full_payload,
            status=200,
            headers={"Content-Length": str(len(full_payload)), "Content-Type": "application/octet-stream"},
            interrupt_after_chunks=1,
            on_interrupt=_trigger_pause,
        )
        resp_resume = _FakeHttpResponse(
            part_two,
            status=206,
            headers={
                "Content-Length": str(len(part_two)),
                "Content-Range": f"bytes {len(part_one)}-{len(full_payload) - 1}/{len(full_payload)}",
                "Content-Type": "application/octet-stream",
            },
        )
        seen_ranges = []

        def _fake_open(req, timeout=60):
            hdrs = {k.lower(): v for k, v in req.header_items()}
            seen_ranges.append(hdrs.get("range"))
            return resp_pause if len(seen_ranges) == 1 else resp_resume

        fake_opener = MagicMock()
        fake_opener.open.side_effect = _fake_open

        with patch.object(downloader, "resolve_target_dir", return_value=self.loras_dir), \
             patch.object(downloader, "is_path_within_allowed_roots", return_value=True), \
             patch.object(downloader, "get_civitai_token", return_value="civ-key"), \
             patch("urllib.request.build_opener", return_value=fake_opener):
            msg1, path1, _ = downloader.run_download_url(
                "https://civitai.com/api/download/models/42",
                "loras",
                sync=True,
                target_filename="resumable.safetensors",
                cancel_check=lambda: paused["flag"],
                pause_check=lambda: paused["flag"],
                return_info=True,
                expected_sha="deadbeef",
            )
            self.assertEqual(path1, "")
            self.assertIn("paused", msg1.lower())
            part_file = os.path.join(self.loras_dir, ".resumable.safetensors.part")
            self.assertTrue(os.path.isfile(part_file))
            self.assertEqual(os.path.getsize(part_file), len(part_one))

            # Resume
            paused["flag"] = False
            msg2, path2, info2 = downloader.run_download_url(
                "https://civitai.com/api/download/models/42",
                "loras",
                sync=True,
                target_filename="resumable.safetensors",
                cancel_check=lambda: False,
                pause_check=lambda: False,
                return_info=True,
                expected_sha="deadbeef",
            )
            self.assertEqual(seen_ranges[0], None)
            self.assertEqual(seen_ranges[1], f"bytes={len(part_one)}-")
            self.assertTrue(os.path.isfile(path2))
            with open(path2, "rb") as f:
                self.assertEqual(f.read(), full_payload)
            self.assertEqual(info2["expected_sha"], "deadbeef")
            self.assertFalse(info2["skip_verify"])


class TestBackupAndCatalogAndDiscovery(unittest.TestCase):
    def test_backup_strips_both_hf_and_civitai_keys(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            src_dir = os.path.join(tmpdir, "user")
            default_dir = os.path.join(src_dir, "default")
            os.makedirs(default_dir, exist_ok=True)
            settings_path = os.path.join(default_dir, "comfy.settings.json")
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "downloader.hf_token": "hf_secret",
                        "downloader.civitai_api_key": "civ_secret",
                        "Comfy.Theme": "dark",
                    },
                    f,
                )

            out_dir = os.path.join(tmpdir, "out1")
            os.makedirs(out_dir, exist_ok=True)
            copied_single = backup._copy_settings_without_token(settings_path, out_dir)
            with open(copied_single, "r", encoding="utf-8") as f:
                data1 = json.load(f)
            self.assertNotIn("downloader.hf_token", data1)
            self.assertNotIn("downloader.civitai_api_key", data1)
            self.assertEqual(data1.get("Comfy.Theme"), "dark")

            out_dir2 = os.path.join(tmpdir, "out2")
            os.makedirs(out_dir2, exist_ok=True)
            copied_tree = backup._copy_and_strip_token(src_dir, out_dir2)
            with open(os.path.join(copied_tree, "default", "comfy.settings.json"), "r", encoding="utf-8") as f:
                data2 = json.load(f)
            self.assertNotIn("downloader.hf_token", data2)
            self.assertNotIn("downloader.civitai_api_key", data2)

    def test_model_explorer_civitai_visibility_depends_on_key(self):
        fake_catalog = {
            "hf_model.safetensors": {
                "filename": "hf_model.safetensors",
                "provider": "huggingface.co",
                "url": "https://huggingface.co/a/b/resolve/main/hf_model.safetensors",
                "explorer_category": "checkpoints",
                "explorer_enabled": True,
            },
            "civ_model.safetensors": {
                "filename": "civ_model.safetensors",
                "provider": "civitai.com",
                "url": "https://civitai.com/api/download/models/123",
                "explorer_category": "loras",
                "explorer_enabled": True,
            },
        }
        with patch.object(web_api, "_load_model_explorer_catalog", return_value=fake_catalog):
            with patch.object(web_api, "has_civitai_token", return_value=False):
                rows_off = web_api._model_explorer_collect_rows()
                self.assertEqual([r["filename"] for r in rows_off], ["hf_model.safetensors"])
            with patch.object(web_api, "has_civitai_token", return_value=True):
                rows_on = web_api._model_explorer_collect_rows()
                self.assertEqual(
                    sorted(r["filename"] for r in rows_on),
                    ["civ_model.safetensors", "hf_model.safetensors"],
                )

    def test_popular_registry_unlocks_civitai_only_with_key(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = os.path.join(tmpdir, "popular.json")
            with open(db_file, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "models": {
                            "civ_lora.safetensors": {
                                "url": "https://civitai.com/api/download/models/9876",
                                "directory": "loras",
                            },
                            "hf_lora.safetensors": {
                                "url": "https://huggingface.co/a/b/resolve/main/hf_lora.safetensors",
                                "directory": "loras",
                            },
                        }
                    },
                    f,
                )

            model_discovery.invalidate_popular_models_cache()
            with patch.object(model_discovery, "POPULAR_MODELS_FILE", db_file):
                with patch.object(model_discovery, "has_civitai_token", return_value=False):
                    reg_off = model_discovery.load_popular_models_registry()
                    self.assertNotIn("civ_lora.safetensors", reg_off)
                    self.assertIn("hf_lora.safetensors", reg_off)
                with patch.object(model_discovery, "has_civitai_token", return_value=True):
                    reg_on = model_discovery.load_popular_models_registry()
                    self.assertIn("civ_lora.safetensors", reg_on)
                    self.assertIn("hf_lora.safetensors", reg_on)
            model_discovery.invalidate_popular_models_cache()

    def test_civitai_filename_search_requires_exact_match_and_skips_generic(self):
        self.assertIsNone(civitai_client.search_civitai_by_filename("model.safetensors", token="k"))

        fake_search = {
            "items": [
                {
                    "id": 900,
                    "name": "Wrong Name Card",
                    "type": "LORA",
                    "modelVersions": [
                        {
                            "id": 901,
                            "name": "v1",
                            "baseModel": "SDXL 1.0",
                            "files": [
                                {
                                    "name": "completely_other.safetensors",
                                    "type": "Model",
                                    "primary": True,
                                    "downloadUrl": "https://civitai.com/api/download/models/901",
                                }
                            ],
                        }
                    ],
                },
                {
                    "id": 902,
                    "name": "Different Title",
                    "type": "LORA",
                    "modelVersions": [
                        {
                            "id": 903,
                            "name": "v1",
                            "baseModel": "Flux.1 D",
                            "files": [
                                {
                                    "name": "my_specific_flux_lora.safetensors",
                                    "type": "Model",
                                    "primary": True,
                                    "sizeKB": 512,
                                    "hashes": {"SHA256": "ABCDEF"},
                                    "downloadUrl": "https://civitai.com/api/download/models/903",
                                }
                            ],
                        }
                    ],
                },
            ]
        }

        with patch.object(civitai_client, "_api_get_json", return_value=fake_search):
            hit = civitai_client.search_civitai_by_filename(
                "my_specific_flux_lora.safetensors",
                folder_hint="loras",
                token="k",
            )
            self.assertIsNotNone(hit)
            self.assertEqual(hit["download_url"], "https://civitai.com/api/download/models/903")
            self.assertEqual(hit["sha256"], "abcdef")

            miss = civitai_client.search_civitai_by_filename(
                "nonexistent_lora_xyz.safetensors",
                folder_hint="loras",
                token="k",
            )
            self.assertIsNone(miss)


if __name__ == "__main__":
    unittest.main()
