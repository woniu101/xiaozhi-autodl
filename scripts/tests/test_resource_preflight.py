import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import resource_preflight


class ResourcePreflightTest(unittest.TestCase):
    def make_cgroup(self, root: Path, cpu_max: str, memory_max: int) -> Path:
        cgroup = root / "cgroup"
        cgroup.mkdir()
        (cgroup / "cpu.max").write_text(cpu_max, encoding="utf-8")
        (cgroup / "memory.max").write_text(str(memory_max), encoding="utf-8")
        return cgroup

    def make_nvidia_smi(self, root: Path, memory_mb: int) -> Path:
        command = root / "nvidia-smi"
        command.write_text(f"#!/bin/sh\nprintf '%s\\n' '{memory_mb}'\n", encoding="utf-8")
        command.chmod(0o755)
        return command

    def test_index_tts_passes_on_full_resource_instance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cgroup = self.make_cgroup(root, "1600000 100000", 64 * 1024**3)
            nvidia_smi = self.make_nvidia_smi(root, 24564)
            with patch.dict(os.environ, {
                "XIAOZHI_CGROUP_ROOT": str(cgroup),
                "XIAOZHI_NVIDIA_SMI": str(nvidia_smi),
            }, clear=False):
                result = resource_preflight.evaluate("index-tts", resources_only=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["reason"], "启动条件已满足")

    def test_index_tts_reports_every_missing_resource(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cgroup = self.make_cgroup(root, "50000 100000", 2 * 1024**3)
            with patch.dict(os.environ, {
                "XIAOZHI_CGROUP_ROOT": str(cgroup),
                "XIAOZHI_NVIDIA_SMI": str(root / "missing-nvidia-smi"),
            }, clear=False):
                result = resource_preflight.evaluate("index-tts", resources_only=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "resource")
        self.assertIn("CPU需要至少 2核，当前 0.5核", result["reason"])
        self.assertIn("内存需要至少 8192MB，当前 2048MB", result["reason"])
        self.assertIn("未检测到 NVIDIA GPU", result["reason"])

    def test_xiaozhi_reports_dependency_after_resource_check_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cgroup = self.make_cgroup(root, "400000 100000", 8 * 1024**3)
            with patch.dict(os.environ, {"XIAOZHI_CGROUP_ROOT": str(cgroup)}, clear=False), \
                    patch.object(resource_preflight, "url_ready", return_value=False):
                result = resource_preflight.evaluate("xiaozhi-server")
        self.assertFalse(result["ok"])
        self.assertEqual(result["kind"], "dependency")
        self.assertIn("Manager API", result["reason"])
        self.assertIn("IndexTTS 2.5", result["reason"])


if __name__ == "__main__":
    unittest.main()
