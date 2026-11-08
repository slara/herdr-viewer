"""python3 -m unittest discover tests  —  place.py's placement rules, against a fake window."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "mods", "pdf-viewer"))
import place  # noqa: E402

CLAUDE, SHELL, VIEWER, NEW = "pClaude", "pShell", "pViewer", "pNew"


class FakeWindow:
    """Panes in one tab; `right`/`left` say who is beside whom (empty: never drawn)."""

    def __init__(self, panes, right=None):
        self.panes = panes                      # {pane: (terminal, tab, is_agent)}
        self.right = right or {}                # {pane: pane on its right}
        self.left = {v: k for k, v in self.right.items()}
        self.calls = []

    def do(self, command, **args):
        self.calls.append((command, args))
        if command == "pane.split":
            return {"pane": NEW}
        return {}

    def go(self, pane, direction):
        return {"right": self.right, "left": self.left}.get(direction, {}).get(pane)

    def take_place(self, old, props):
        self.calls.append(("take_place", {"old": old, "props": props}))
        return {"pane": NEW}


class PlaceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        place.STATE = os.path.join(self.dir.name, "state.json")

    def tearDown(self):
        self.dir.cleanup()

    def run_place(self, win, source, viewers=None):
        if viewers:
            with open(place.STATE, "w") as f:
                json.dump({"viewers": viewers}, f)
        for name in ("do", "go", "take_place"):
            setattr(place, name, getattr(win, name))
        place.terminal_panes = lambda: dict(win.panes)
        place.exists = lambda pane: True
        place.open_doc("/doc.pdf", source, tab=False)
        with open(place.STATE) as f:
            return json.load(f)["viewers"]

    def commands(self, win):
        return [(c, a.get("pane") or a.get("terminal") or a.get("old")) for c, a in win.calls
                if c in ("take_place", "pane.split", "pane.close", "terminal.park")]

    def test_from_a_shell_the_viewer_takes_its_place(self):
        win = FakeWindow({CLAUDE: ("t2", "tab", True), SHELL: ("t5", "tab", False)}, right={CLAUDE: SHELL})
        state = self.run_place(win, "t5")
        self.assertEqual(self.commands(win), [("take_place", SHELL), ("terminal.park", "t5")])
        (v,) = state.values()
        self.assertEqual((v["parked"], v["src"]), ("t5", CLAUDE))

    def test_from_claude_alone_a_new_pane_opens(self):
        win = FakeWindow({CLAUDE: ("t2", "tab", True)})
        self.run_place(win, "t2")
        self.assertEqual(self.commands(win), [("pane.split", CLAUDE)])

    def test_from_claude_a_terminal_on_the_right_is_parked(self):
        win = FakeWindow({CLAUDE: ("t2", "tab", True), SHELL: ("t5", "tab", False)}, right={CLAUDE: SHELL})
        state = self.run_place(win, "t2")
        self.assertEqual(self.commands(win), [("take_place", SHELL), ("terminal.park", "t5")])
        self.assertEqual(list(state.values())[0]["src"], CLAUDE)

    def test_from_claude_a_viewer_on_the_right_is_replaced(self):
        win = FakeWindow({CLAUDE: ("t2", "tab", True)}, right={CLAUDE: VIEWER})
        old = {"old": {"pane": VIEWER, "tab": "tab", "file": "/a.pdf", "parked": "t5", "src": CLAUDE}}
        state = self.run_place(win, "t2", viewers=old)
        self.assertEqual(self.commands(win), [("take_place", VIEWER), ("pane.close", VIEWER)])
        self.assertNotIn("old", state)  # removed before the close, so its close() gives nothing back
        self.assertEqual(list(state.values())[0]["parked"], "t5")  # the new viewer owns the parked shell

    def test_undrawn_window_uses_pane_order(self):
        win = FakeWindow({CLAUDE: ("t2", "tab", True), SHELL: ("t5", "tab", False)})  # no geometry
        self.run_place(win, "t2")
        self.assertEqual(self.commands(win), [("take_place", SHELL), ("terminal.park", "t5")])

    def test_viewers_in_other_tabs_are_not_checked(self):
        checked = []
        win = FakeWindow({CLAUDE: ("t2", "tab", True)})
        other = {"x": {"pane": "pElsewhere", "tab": "other", "file": "/a.pdf"}}
        with open(place.STATE, "w") as f:
            json.dump({"viewers": other}, f)
        place.exists = lambda pane: checked.append(pane) or True
        with place.State() as st:
            self.assertEqual(place.live_viewers(st, "tab"), [])
        self.assertEqual(checked, [])


if __name__ == "__main__":
    unittest.main()
