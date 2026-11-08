#!/usr/bin/env python3
"""Open a document in a pdf-viewer pane, placed beside the terminal that asked.

  place.py [--from tN] [--tab] FILE   open FILE
  place.py --closed ID                a viewer closed: give back the terminal it parked
  place.py --restore ID               close viewer ID and give back its terminal

Placement, from the source terminal (--from, else $HC_TERMINAL_ID):
  - a plain terminal (a shell): the viewer takes that terminal's own place,
    and the terminal is parked (`terminal.park`: off screen, still running);
  - an agent (Claude Code, anything reporting a status): the viewer takes the
    place of the pane on its right (a viewer is replaced, a terminal parked),
    or opens as a new pane on the right when there is none.
Closing a viewer puts the parked terminal back beside its neighbour; the
viewer's "↩ Terminal" button puts it back in the viewer's place.

State (viewer panes, parked terminals) is kept in
~/.config/herdr-app/data/pdf-viewer/state.json.
"""

import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
import uuid

HOME = os.environ.get("HERDR_APP_HOME") or os.path.expanduser("~/.config/herdr-app")
STATE = os.path.join(HOME, "data", "pdf-viewer", "state.json")
MOD = "pdf-viewer"


class HerdrError(Exception):
    pass


def herdr(*args):
    r = subprocess.run(["herdr-app", *args], capture_output=True, text=True, timeout=20)
    out = r.stdout.strip()
    try:
        data = json.loads(out) if out else {}
    except json.JSONDecodeError:
        data = {}
    if r.returncode != 0 or (isinstance(data, dict) and "error" in data):
        raise HerdrError((data.get("error") if isinstance(data, dict) else None) or r.stderr.strip() or out)
    return data


def do(command, **args):
    return herdr("do", command, json.dumps({k: v for k, v in args.items() if v is not None}))


class State:
    """state.json under an exclusive lock: {"viewers": {id: {pane, tab, file, parked, src}}}."""

    def __enter__(self):
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        self.lock = open(STATE + ".lock", "w")
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        try:
            with open(STATE) as f:
                self.data = json.load(f)
        except (OSError, json.JSONDecodeError):
            self.data = {}
        self.data.setdefault("viewers", {})
        return self

    def __exit__(self, *exc):
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=1)
        os.replace(tmp, STATE)
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.lock.close()

    @property
    def viewers(self):
        return self.data["viewers"]

    def by_pane(self, pane):
        return next(((i, v) for i, v in self.viewers.items() if v.get("pane") == pane), (None, None))


def terminal_panes():
    """{pane: (terminal, tab, is_agent)} for every terminal pane, in each tab's order."""
    out = {}
    for space in herdr("ls").get("spaces", []):
        for tab in space.get("tabs", []):
            for t in tab.get("terminals", []):
                if t.get("pane"):
                    out[t["pane"]] = (t["terminal"], tab["id"], bool(t.get("app") or t.get("status")))
    return out


def pane_of(term, panes=None):
    panes = terminal_panes() if panes is None else panes
    return next((p for p, (t, _, _) in panes.items() if t == term), None)


def exists(pane):
    try:
        do("pane.focus", pane=pane)
        return True
    except HerdrError:
        return False


def live_viewers(st, tab):
    """Registered viewer panes that still exist in `tab`; forgets the ones that are gone.
    Only `tab`'s are checked: focusing a pane elsewhere would switch the window to it."""
    found = []
    for vid, v in list(st.viewers.items()):
        if v.get("tab") != tab:
            continue
        if exists(v.get("pane")):
            found.append(v["pane"])
        elif not v.get("parked"):  # a parked terminal's entry is kept until given back
            del st.viewers[vid]
    return found


def go(pane, direction):
    """The pane next to `pane` in `direction`, by moving focus there (none: None)."""
    do("pane.focus", pane=pane)
    do("pane.go", direction=direction)
    there = herdr("status").get("focused_pane")
    return there if there and there != pane else None


def right_of(pane, tab, panes, st):
    """The pane on the right of `pane`, or None. pane.go finds it by geometry,
    which a pane gets only once the window has drawn it; without any, the tab's
    pane order (left/top first) decides."""
    right = go(pane, "right")
    if right or go(pane, "left"):
        return right
    terms = [p for p, (_, t, _) in panes.items() if t == tab]
    after = terms[terms.index(pane) + 1:] + live_viewers(st, tab)
    return after[0] if len(after) == 1 else None


def neighbour(pane, tab, panes):
    """Some pane beside `pane` in its tab, to give a parked terminal back next to."""
    for d in ("left", "up", "right", "down"):
        n = go(pane, d)
        if n:
            return n
    return next((p for p, (_, t, _) in panes.items() if t == tab and p != pane), None)


def take_place(old, props):
    """Open a viewer that will take `old`'s place, at `old`'s size.

    A split halves `old`, and when a pane goes its space goes to the pane
    before it. So the viewer is split off to the right of `old`, then swapped
    to its left: once `old` is closed or parked, the viewer gets it all.
    pane.swap goes by geometry, so it waits until the window has drawn the new
    pane beside `old` (swapping before that, or twice, would go wrong)."""
    made = do("pane.split", pane=old, direction="right", mod=MOD, props=props)
    new = made.get("pane")
    for _ in range(15):
        time.sleep(0.1)
        if go(new, "left") == old:
            break
    else:
        return made  # never drawn (window hidden): it keeps half of old's width
    do("pane.focus", pane=new)
    do("pane.swap", direction="left")
    return made


def open_doc(path, source, tab):
    """From a plain terminal: the viewer takes that terminal's place (parked).
    From an agent (Claude Code): it takes the place of the pane on the agent's
    right (a viewer is replaced, a terminal parked), or opens a new one there."""
    vid = uuid.uuid4().hex[:12]
    props = {"file": path, "id": vid}

    if tab:
        made = do("tab.new", name=os.path.basename(path), mod=MOD, props=props)
        with State() as st:
            st.viewers[vid] = {"pane": made.get("pane"), "tab": made.get("tab"), "file": path}
        return

    panes = terminal_panes()
    src_pane = pane_of(source, panes) if source else None
    if not src_pane:  # not run from a Herdr terminal: beside whatever has focus
        made = do("pane.split", direction="right", mod=MOD, props=props)
        with State() as st:
            st.viewers[vid] = {"pane": made.get("pane"), "tab": herdr("status").get("tab"), "file": path}
        return

    term, tab_id, agent = panes[src_pane]
    focus = src_pane
    try:
        with State() as st:
            if not agent:
                # Take the asking terminal's own place.
                anchor = neighbour(src_pane, tab_id, panes)
                props["parked"] = term
                made = take_place(src_pane, props)
                st.viewers[vid] = {"pane": made.get("pane"), "tab": tab_id, "file": path,
                                   "parked": term, "src": anchor}
                do("terminal.park", terminal=term)
                focus = made.get("pane")
                return

            right = right_of(src_pane, tab_id, panes, st)
            old_id, old = st.by_pane(right) if right else (None, None)
            if old:  # a viewer: take its place, and whatever it had parked
                props["parked"] = old.get("parked")
                made = take_place(right, props)
                st.viewers[vid] = {"pane": made.get("pane"), "tab": tab_id, "file": path,
                                   "parked": old.get("parked"), "src": old.get("src")}
                del st.viewers[old_id]  # before closing it, so its close() gives nothing back
                do("pane.close", pane=right)
            elif right in panes:  # a terminal: park it and take its place
                parked = panes[right][0]
                props["parked"] = parked
                made = take_place(right, props)
                st.viewers[vid] = {"pane": made.get("pane"), "tab": tab_id, "file": path,
                                   "parked": parked, "src": src_pane}
                do("terminal.park", terminal=parked)
            else:  # nothing there (or a pane that isn't ours): a new pane on the right
                # shortcut: a viewer not opened through here (a bare `pane.split`) isn't in
                # state, so it isn't replaced; the CLI can't tell mod panes apart. If that
                # matters, have the viewer publish its pane via setShared/shared.json.
                made = do("pane.split", pane=src_pane, direction="right", mod=MOD, props=props)
                st.viewers[vid] = {"pane": made.get("pane"), "tab": tab_id, "file": path}
    finally:
        try:
            do("pane.focus", pane=focus)
        except HerdrError:
            pass


def keep_beside(term, pane, place="right"):
    """Give `term` a pane next to `pane` and wait until it has one (keep may answer `pending`)."""
    do("pane.focus", pane=pane)
    do("terminal.keep", terminal=term, place=place)
    for _ in range(20):
        if pane_of(term):
            break
        time.sleep(0.1)
    time.sleep(0.15)


def give_back(v):
    """Show a parked terminal again, beside the pane recorded with it (the agent
    that opened the viewer, or the parked terminal's old neighbour)."""
    term = v.get("parked")
    if not term or pane_of(term):
        return
    anchor = v.get("src")
    if anchor and exists(anchor):
        keep_beside(term, anchor)
        do("pane.focus", pane=anchor)
    else:  # nothing left beside it: it comes back as a tab
        do("terminal.keep", terminal=term, place="tab")


def closed(vid):
    with State() as st:
        v = st.viewers.pop(vid, None)
        if v:
            try:
                give_back(v)
            except HerdrError:
                st.viewers[vid] = v  # the window may be quitting: keep it for next time
                raise


def restore(vid):
    """The viewer's "↩ Terminal": the parked terminal comes back in the viewer's place."""
    with State() as st:
        v = st.viewers.pop(vid, None)
        if not v:
            return
        term, pane = v.get("parked"), v.get("pane")
        if term and pane and exists(pane) and not pane_of(term):
            # Same trick as take_place: the terminal comes back right of the
            # viewer, swaps to its left, and gets the viewer's space when it closes.
            keep_beside(term, pane)
            back = pane_of(term)
            for _ in range(15):
                if back and go(back, "left") == pane:
                    do("pane.focus", pane=back)
                    do("pane.swap", direction="left")
                    break
                time.sleep(0.1)
            do("pane.close", pane=pane)
            do("pane.focus", pane=back)
        else:
            if pane and exists(pane):
                do("pane.close", pane=pane)
            give_back(v)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?")
    ap.add_argument("--from", dest="source", default=os.environ.get("HC_TERMINAL_ID"))
    ap.add_argument("--tab", action="store_true")
    ap.add_argument("--closed", metavar="ID")
    ap.add_argument("--restore", metavar="ID")
    a = ap.parse_args()
    try:
        if a.closed:
            closed(a.closed)
        elif a.restore:
            restore(a.restore)
        elif a.file:
            path = os.path.realpath(os.path.expanduser(a.file))
            if not os.path.isfile(path):
                raise HerdrError(f"no such file: {a.file}")
            open_doc(path, a.source, a.tab)
        else:
            ap.error("a file is required")
    except (HerdrError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        print(f"view: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
