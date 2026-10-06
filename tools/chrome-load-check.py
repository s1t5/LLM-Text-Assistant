#!/usr/bin/env python3
"""Load a built extension tree into a real Chrome and report load-time errors.

Why this exists
---------------
The Chrome Web Store's automated "does not work as described" review runs on a
FRESH profile and reports only a generic reason. It does not tell you that the
extension never loaded at all. Chrome refuses to load an extension whose
_locales/*/messages.json references an undeclared placeholder:

    Extension error: Fehler beim Laden der Erweiterung aus: <dir>.
    Variable $COUNT$ used but not defined.

That shipped in v1.6.0/v1.6.1 (`optionsModelsLoaded` = "$COUNT$ models found"
without a `placeholders` block) and got the item rejected twice. This script
reproduces that check locally in ~20 seconds.

Headless Chrome does NOT load extensions, and this environment exposes no
DevTools port under Xvfb — but chrome's own stderr log names the load error,
which is all we need.

Usage
-----
    python3 tools/chrome-load-check.py [build/chrome]

Exit codes: 0 = extension loaded, 1 = load error, 2 = could not run Chrome.
"""
import glob
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
TARGET = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "build", "chrome"))

LOAD_ERROR_RE = re.compile(
    r"(Fehler beim Laden der Erweiterung aus|Failed to load extension from"
    r"|load_error_reporter\.cc|Variable \$\w+\$ used but not defined)"
)


def find_chrome():
    if os.environ.get("CHROME_BIN"):
        return os.environ["CHROME_BIN"]
    for pattern in (
        os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[-1]
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        p = shutil.which(name)
        if p:
            return p
    return None


def main():
    if not os.path.isdir(TARGET):
        print(f"target tree missing: {TARGET}\nrun: node tools/build.mjs --no-zip", file=sys.stderr)
        return 2

    chrome = find_chrome()
    if not chrome:
        print("no chrome/chromium binary found (set CHROME_BIN)", file=sys.stderr)
        return 2

    xvfb = None
    display = os.environ.get("DISPLAY")
    if not display or not os.path.exists(f"/tmp/.X11-unix/X{display.lstrip(':')}"):
        display = ":97"
        xvfb = subprocess.Popen(
            ["Xvfb", display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(1.5)

    profile = tempfile.mkdtemp(prefix="chrome-load-check-")
    env = dict(os.environ, DISPLAY=display)
    log = os.path.join(profile, "chrome.log")
    proc = None
    try:
        with open(log, "w") as fh:
            proc = subprocess.Popen(
                [
                    chrome,
                    f"--user-data-dir={profile}",
                    f"--load-extension={TARGET}",
                    f"--disable-extensions-except={TARGET}",
                    "--no-first-run", "--no-default-browser-check",
                    "--no-sandbox", "--disable-gpu",
                    "--enable-logging=stderr", "--v=1",
                    "about:blank",
                ],
                env=env, stdout=fh, stderr=subprocess.STDOUT,
            )
            time.sleep(12)
    finally:
        if proc:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        if xvfb:
            xvfb.terminate()

    text = open(log, errors="replace").read()
    errors = [ln for ln in text.splitlines() if LOAD_ERROR_RE.search(ln)]
    sw = re.search(r"chrome-extension://([a-p]{32})/background\.js", text)

    print(f"chrome: {chrome}")
    print(f"target: {TARGET}")
    if errors:
        print("\nLOAD ERRORS:")
        for ln in errors:
            print("  " + ln.strip())
        print("\nVERDICT: extension did NOT load — Chrome would reject this package.")
        return 1
    if sw:
        print(f"extension id: {sw.group(1)}")
        print("service worker ran: yes")
        print("\nVERDICT: extension loads and its service worker executes.")
        return 0
    print("\nVERDICT: no load error found, but the service worker did not appear either.")
    print("Check the log manually:", log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
