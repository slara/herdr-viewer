"""python3 -m unittest discover tests  —  place.py's placement rules, against a fake window."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "mods", "viewer"))
import place  # noqa: E402

AGENT, SHELL, VIEWER, NEW = "pAgent", "pShell", "pViewer", "pNew"


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
        win = FakeWindow({AGENT: ("t2", "tab", True), SHELL: ("t5", "tab", False)}, right={AGENT: SHELL})
        state = self.run_place(win, "t5")
        self.assertEqual(self.commands(win), [("take_place", SHELL), ("terminal.park", "t5")])
        (v,) = state.values()
        self.assertEqual((v["parked"], v["src"]), ("t5", AGENT))

    def test_from_an_agent_alone_a_new_pane_opens(self):
        win = FakeWindow({AGENT: ("t2", "tab", True)})
        self.run_place(win, "t2")
        self.assertEqual(self.commands(win), [("pane.split", AGENT)])

    def test_from_an_agent_a_terminal_on_the_right_is_parked(self):
        win = FakeWindow({AGENT: ("t2", "tab", True), SHELL: ("t5", "tab", False)}, right={AGENT: SHELL})
        state = self.run_place(win, "t2")
        self.assertEqual(self.commands(win), [("take_place", SHELL), ("terminal.park", "t5")])
        self.assertEqual(list(state.values())[0]["src"], AGENT)

    def test_from_an_agent_a_viewer_on_the_right_is_replaced(self):
        win = FakeWindow({AGENT: ("t2", "tab", True)}, right={AGENT: VIEWER})
        old = {"old": {"pane": VIEWER, "tab": "tab", "file": "/a.pdf", "parked": "t5", "src": AGENT}}
        state = self.run_place(win, "t2", viewers=old)
        self.assertEqual(self.commands(win), [("take_place", VIEWER), ("pane.close", VIEWER)])
        self.assertNotIn("old", state)  # removed before the close, so its close() gives nothing back
        self.assertEqual(list(state.values())[0]["parked"], "t5")  # the new viewer owns the parked shell

    def test_undrawn_window_uses_pane_order(self):
        win = FakeWindow({AGENT: ("t2", "tab", True), SHELL: ("t5", "tab", False)})  # no geometry
        self.run_place(win, "t2")
        self.assertEqual(self.commands(win), [("take_place", SHELL), ("terminal.park", "t5")])

    def test_viewers_in_other_tabs_are_not_checked(self):
        checked = []
        win = FakeWindow({AGENT: ("t2", "tab", True)})
        other = {"x": {"pane": "pElsewhere", "tab": "other", "file": "/a.pdf"}}
        with open(place.STATE, "w") as f:
            json.dump({"viewers": other}, f)
        place.exists = lambda pane: checked.append(pane) or True
        with place.State() as st:
            self.assertEqual(place.live_viewers(st, "tab"), [])
        self.assertEqual(checked, [])


    def test_a_focused_viewer_stands_for_the_terminal_that_opened_it(self):
        win = FakeWindow({AGENT: ("t2", "tab", True)})
        with open(place.STATE, "w") as f:
            json.dump({"viewers": {"v": {"pane": VIEWER, "tab": "tab", "src": AGENT}}}, f)
        place.terminal_panes = lambda: dict(win.panes)
        for focused, expected in ((AGENT, "t2"), (VIEWER, "t2"), ("pUnknown", None)):
            place.herdr = lambda *args, f=focused: {"focused_pane": f}
            self.assertEqual(place.focused_terminal(), expected)



class GiveBackTest(unittest.TestCase):
    """A closed viewer gives its parked terminal back; this is the path that could lose one."""

    def setUp(self):
        saved = {n: getattr(place, n) for n in ("STATE", "do", "terminal_panes", "exists", "running")}
        self.addCleanup(lambda: [setattr(place, n, v) for n, v in saved.items()])
        saved_sleep = place.time.sleep
        self.addCleanup(setattr, place.time, "sleep", saved_sleep)
        place.time.sleep = lambda _: None
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        place.STATE = os.path.join(self.dir.name, "state.json")
        self.panes = {AGENT: ("t2", "tab", True)}
        self.calls = []
        place.terminal_panes = lambda: dict(self.panes)
        place.exists = lambda pane: pane in self.panes

    def viewer(self, **entry):
        with open(place.STATE, "w") as f:
            json.dump({"viewers": {"v": {"pane": VIEWER, "tab": "tab", "parked": "t5", **entry}}}, f)

    def entries(self):
        with open(place.STATE) as f:
            return json.load(f)["viewers"]

    def keep_works(self, command, **args):
        self.calls.append((command, args.get("pane") or args.get("terminal"), args.get("place")))
        if command == "terminal.keep":
            self.panes[SHELL] = ("t5", "tab", False)
        return {}

    def test_closing_gives_the_terminal_back_beside_its_anchor(self):
        self.viewer(src=AGENT)
        place.do = self.keep_works
        place.closed("v")
        self.assertIn(("pane.focus", AGENT, None), self.calls)
        self.assertIn(("terminal.keep", "t5", "right"), self.calls)
        self.assertEqual(self.entries(), {})

    def test_with_the_anchor_gone_it_comes_back_as_a_tab(self):
        self.viewer(src="pGone")
        place.do = self.keep_works
        place.closed("v")
        self.assertIn(("terminal.keep", "t5", "tab"), self.calls)

    def fail(self, command, **_):
        raise place.HerdrError("no window")

    def test_a_failed_give_back_is_kept_to_retry(self):
        self.viewer(src=AGENT)
        place.do, place.running = self.fail, lambda term: True
        with self.assertRaises(place.HerdrError):
            place.closed("v")
        self.assertIn("v", self.entries())

    def test_a_terminal_that_no_longer_runs_is_forgotten(self):
        self.viewer(src=AGENT)
        place.do, place.running = self.fail, lambda term: False
        with self.assertRaises(place.HerdrError):
            place.closed("v")
        self.assertEqual(self.entries(), {})


if __name__ == "__main__":
    unittest.main()
