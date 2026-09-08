"""Small offline checks for safe release-asset installation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location(
    "setup_assets", Path(__file__).resolve().parents[1] / "scripts/setup_assets.py"
)
setup_assets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup_assets)


class AssetInstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "checkout"
        self.root.mkdir()

    def archive(self, entries=None):
        entries = entries or [("public/nested/model.bin", b"\x00\xffmodel"),
                              ("public/manifest.json", b'{"version":1}')]
        path = self.base / "assets.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for name, data in entries:
                archive.writestr(name, data)
        data = path.read_bytes()
        return path, {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                      "files": len(entries), "uncompressedBytes": sum(len(data) for _, data in entries)}

    def test_installs_exact_binary_and_nested_paths(self):
        archive, expected = self.archive()
        setup_assets.install(archive, expected, self.root)
        self.assertEqual((self.root / "public/nested/model.bin").read_bytes(), b"\x00\xffmodel")
        self.assertEqual(json.loads((self.root / "public/manifest.json").read_text()), {"version": 1})
        self.assertEqual(len(list((self.root / "public").rglob("*.bin"))), 1)

    def test_bad_checksum_is_rejected_before_checkout_writes(self):
        archive, expected = self.archive()
        expected["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "checksum"):
            setup_assets.install(archive, expected, self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_traversal_and_symlink_are_rejected_without_publication(self):
        symlink = zipfile.ZipInfo("public/link")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for name in ["public/../../escaped.txt", symlink]:
            with self.subTest(name=str(name)):
                archive, expected = self.archive([(name, b"../../escaped.txt")])
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    setup_assets.install(archive, expected, self.root)
                self.assertFalse((self.root / "public").exists())
                self.assertFalse((self.base / "escaped.txt").exists())
                self.assertEqual(list((self.root / ".cache").iterdir()), [])

    def test_existing_public_content_is_preserved(self):
        public = self.root / "public"
        public.mkdir()
        sentinel = public / "user-file.txt"
        sentinel.write_bytes(b"keep my local work")
        archive, expected = self.archive()
        with self.assertRaisesRegex(ValueError, "already exists"):
            setup_assets.install(archive, expected, self.root)
        self.assertEqual(sentinel.read_bytes(), b"keep my local work")
        self.assertEqual(list(public.iterdir()), [sentinel])

    def test_repeated_install_succeeds_without_replacing_files(self):
        archive, expected = self.archive()
        setup_assets.install(archive, expected, self.root)
        model = self.root / "public/nested/model.bin"
        before = model.stat()
        setup_assets.install(archive, expected, self.root)
        self.assertEqual(model.read_bytes(), b"\x00\xffmodel")
        self.assertEqual((model.stat().st_ino, model.stat().st_mtime_ns),
                         (before.st_ino, before.st_mtime_ns))


if __name__ == "__main__":
    unittest.main()
