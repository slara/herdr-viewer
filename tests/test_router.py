"""python3 -m unittest discover tests  —  where router.py sends a file opened by macOS."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "mods", "viewer", "router"))
import router  # noqa: E402

place = router.place


class OpenFilesTest(unittest.TestCase):
    def setUp(self):
        # place is shared with test_place: put back what these tests replace.
        saved = (place.STATE, place.focused_terminal, place.open_doc, router.subprocess.run)
        self.addCleanup(self.restore, saved)
        self.dir = tempfile.TemporaryDirectory()
        place.STATE = os.path.join(self.dir.name, "state.json")
        with open(place.STATE, "w") as f:
            json.dump({"viewers": {}, "defaults": {"com.adobe.pdf": "com.google.Chrome"}}, f)
        self.viewer, self.apps = [], []
        place.focused_terminal = lambda: "t2"
        place.open_doc = lambda path, source, tab: self.viewer.append((os.path.basename(path), source))
        # ["open", "-b", app, file] -> (app, name); plain ["open", file] -> (None, name)
        router.subprocess.run = lambda argv, **kw: self.apps.append(
            (argv[2] if "-b" in argv else None, os.path.basename(argv[-1])))

    def restore(self, saved):
        place.STATE, place.focused_terminal, place.open_doc, router.subprocess.run = saved
        self.dir.cleanup()

    def test_from_herdr_files_open_in_the_viewer(self):
        router.open_files(router.HERDR_ID, ["/a/spec.pdf", "/a/notes.md"])
        self.assertEqual(self.viewer, [("spec.pdf", "t2"), ("notes.md", "t2")])
        self.assertEqual(self.apps, [])

    def test_from_another_app_files_go_to_the_previous_default(self):
        router.open_files("com.apple.finder", ["/a/spec.pdf", "/a/notes.md", "/a/photo.JPG"])
        self.assertEqual(self.viewer, [])
        self.assertEqual(self.apps, [("com.google.Chrome", "spec.pdf"),
                                     ("com.apple.TextEdit", "notes.md"),
                                     ("com.apple.Preview", "photo.JPG")])

    def test_when_herdr_fails_the_file_still_opens(self):
        def fail(*_, **__):
            raise place.HerdrError("no window")
        place.open_doc = fail
        router.open_files(router.HERDR_ID, ["/a/spec.pdf"])
        self.assertEqual(self.apps, [("com.google.Chrome", "spec.pdf")])

    def test_without_the_router_installed_macos_picks_the_app(self):
        with open(place.STATE, "w") as f:
            json.dump({"viewers": {}}, f)
        router.open_files("", ["/a/spec.pdf"])
        self.assertEqual(self.apps, [(None, "spec.pdf")])


class KindTest(unittest.TestCase):
    def test_the_types_the_viewer_shows(self):
        for name in ("a.pdf", "b.MD", "c.markdown", "d.jpg", "e.JPEG", "f.png", "g.gif", "h.webp", "i.bmp", "j.svg"):
            self.assertTrue(router.supported(name), name)
        for name in ("k.txt", "l.tiff", "pdf", "m.mdx"):
            self.assertFalse(router.supported(name), name)


if __name__ == "__main__":
    unittest.main()
