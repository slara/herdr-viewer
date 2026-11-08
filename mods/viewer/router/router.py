#!/usr/bin/env python3
"""Cmd-click support for the viewer (macOS).

A Cmd-clicked path in a Herdr terminal is opened the way macOS opens any file:
with the default app for its type. `install` makes that app a small shim
(shim.swift) which hands every file back to this script. Here, a file opens in
the viewer when Herdr was the app in front, and otherwise in the app that was
the default before.

  router.py install                  build the shim and make it the default
  router.py uninstall                give every type back to its previous app
  router.py open --front ID FILE...  called by the shim; ID is the app in front
  router.py kind FILE                exit 0 if the viewer shows FILE (bin/view asks)

TYPES below is the one list of what the viewer opens, outside its JavaScript.
"""

import argparse
import os
import plistlib
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import place  # noqa: E402

APP = os.path.expanduser("~/Applications/Herdr Viewer.app")
EXE = os.path.join(APP, "Contents", "MacOS", "herdr-viewer")
BUNDLE_ID = "io.github.slara.herdr-viewer"
HERDR_ID = "dev.herdr.app"
LSREGISTER = ("/System/Library/Frameworks/CoreServices.framework/Frameworks/"
              "LaunchServices.framework/Support/lsregister")

# Each type the viewer shows: its uniform type id, its extensions, and the app
# to fall back on when no previous default was saved.
TYPES = [
    ("com.adobe.pdf", ("pdf",), "com.apple.Preview"),
    ("net.daringfireball.markdown", ("md", "markdown"), "com.apple.TextEdit"),
    ("public.png", ("png",), "com.apple.Preview"),
    ("public.jpeg", ("jpg", "jpeg"), "com.apple.Preview"),
    ("com.compuserve.gif", ("gif",), "com.apple.Preview"),
    ("org.webmproject.webp", ("webp",), "com.apple.Preview"),
    ("com.microsoft.bmp", ("bmp",), "com.apple.Preview"),
    ("public.svg-image", ("svg",), "com.apple.Safari"),
]


def shim(*args):
    return subprocess.run([EXE, *args], capture_output=True, text=True)


def build():
    shutil.rmtree(APP, ignore_errors=True)
    os.makedirs(os.path.dirname(EXE))
    subprocess.run(["swiftc", "-O", "-o", EXE, os.path.join(HERE, "shim.swift")], check=True)
    info = {
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleName": "Herdr Viewer",
        "CFBundleExecutable": "herdr-viewer",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "LSBackgroundOnly": True,
        "CFBundleDocumentTypes": [{
            "CFBundleTypeName": "Documents the Herdr viewer shows",
            "CFBundleTypeRole": "Viewer",
            "LSHandlerRank": "Alternate",
            "LSItemContentTypes": [uti for uti, _, _ in TYPES],
        }],
    }
    with open(os.path.join(APP, "Contents", "Info.plist"), "wb") as f:
        plistlib.dump(info, f)
    subprocess.run(["codesign", "--sign", "-", "--force", APP], check=True, capture_output=True)
    subprocess.run([LSREGISTER, "-f", APP], check=True)


def install():
    build()
    failed = []
    with place.State() as st:
        saved = st.data.setdefault("defaults", {})
        for uti, _, _ in TYPES:
            current = shim("get", uti).stdout.strip()
            if current and current.lower() != BUNDLE_ID:
                saved[uti] = current
            if shim("set", uti, BUNDLE_ID).returncode != 0:
                failed.append(uti)
    if failed:
        raise place.HerdrError("could not become the default for " + ", ".join(failed))
    print(f"{APP} now opens PDFs, Markdown and images")


def uninstall():
    with place.State() as st:
        saved = st.data.pop("defaults", {})
    for uti, _, fallback in TYPES:
        app = saved.get(uti, fallback)
        if not os.path.exists(EXE) or shim("set", uti, app).returncode != 0:
            print(f"{uti}: set its app back by hand (Finder > Get Info > Open with): {app}")
    subprocess.run([LSREGISTER, "-u", APP], capture_output=True)
    shutil.rmtree(APP, ignore_errors=True)
    print("removed", APP)


def extension(path):
    return os.path.splitext(path)[1].lstrip(".").lower()


def supported(path):
    return any(extension(path) in exts for _, exts, _ in TYPES)


def open_elsewhere(path):
    """Open in the app that isn't the viewer: the saved previous default once the
    router is installed, else whatever macOS picks (not the router: it isn't one)."""
    with place.State() as st:
        saved = st.data.get("defaults")
    if saved is None:
        subprocess.run(["open", path])
        return
    uti, fallback = next(((u, f) for u, exts, f in TYPES if extension(path) in exts), (None, "com.apple.Preview"))
    subprocess.run(["open", "-b", saved.get(uti, fallback), path])


def open_files(front, files):
    for path in files:
        if front == HERDR_ID:
            try:
                place.open_doc(os.path.realpath(path), place.focused_terminal(), tab=False)
                continue
            except (place.HerdrError, subprocess.TimeoutExpired, FileNotFoundError):
                pass  # Herdr didn't take it: fall through to the usual app
        open_elsewhere(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("install")
    sub.add_parser("uninstall")
    op = sub.add_parser("open")
    op.add_argument("--front", default="")
    op.add_argument("files", nargs="+")
    sub.add_parser("kind").add_argument("file")
    a = ap.parse_args()
    if a.cmd == "kind":
        return 0 if supported(a.file) else 1
    try:
        if a.cmd == "install":
            install()
        elif a.cmd == "uninstall":
            uninstall()
        else:
            open_files(a.front, a.files)
    except (place.HerdrError, subprocess.CalledProcessError) as e:
        print(f"router: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
