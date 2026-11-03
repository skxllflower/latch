"""latch-gui.exe --setup / --uninstall under a test root (app/setup_cli.cpp) change nothing outside it.

    python native/tests/setup/check_setup.py <built latch-gui.exe>

Unelevated, Windows only; never runs --setup or --uninstall without --test-root. The exe is copied into
<tmp>\\Latch\\latch-gui.exe (the manager's layout), then:
  - the machine's side is read before and after (the HKCU and HKLM roots' values, HKCU\\Software's keys, the real
    uninstall entry and vacantsystems key, the real shortcuts, %ProgramData%\\Vacant Systems): it must not change;
  - --setup --test-root writes the test entry with its name and uninstall string (Latch writes no Explorer verbs);
  - --setup runs twice; --setup --nonsense exits 2;
  - --uninstall --quiet --keep-files --test-root leaves no test key and no shortcut.
Ported from WAVdesk's native/tests/app_setup/check_setup.py (the HKLM-root incident, WAVdesk 4162d54c / f1c42aa6).
Exit 0: every check passed.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import winreg

PRODUCT = "Latch"
EXE = "latch-gui.exe"
TEST = r"Software\Vacant Systems\Manager Test"
ENTRY = TEST + r"\Apps\Latch"
VERBS = TEST + r"\Verbs\Latch"   # (Latch writes none: nothing may land here)

failed = 0


def check(ok, what):
    global failed
    print(("ok    " if ok else "FAIL  ") + what)
    if not ok:
        failed += 1


def values(root, sub, view=0):
    try:
        with winreg.OpenKey(root, sub, 0, winreg.KEY_READ | view) as k:
            out, i = {}, 0
            while True:
                try:
                    n, v, t = winreg.EnumValue(k, i)
                except OSError:
                    return out
                out[n] = (v, t)
                i += 1
    except OSError:
        return None


def subkeys(root, sub):
    try:
        with winreg.OpenKey(root, sub) as k:
            out, i = [], 0
            while True:
                try:
                    out.append(winreg.EnumKey(k, i))
                except OSError:
                    return sorted(out)
                i += 1
    except OSError:
        return None


def files_under(path):
    out = {}
    for d, _, fs in os.walk(path):
        for f in fs:
            p = os.path.join(d, f)
            try:
                st = os.stat(p)
                out[p] = (st.st_size, st.st_mtime_ns)
            except OSError:
                pass
    return out


def machine():
    """What a test-root run must never change."""
    w64 = winreg.KEY_WOW64_64KEY
    pd = os.environ.get("ProgramData", r"C:\ProgramData")
    pub = os.environ.get("PUBLIC", r"C:\Users\Public")
    lnks = [os.path.join(pd, r"Microsoft\Windows\Start Menu\Programs\Vacant Systems", PRODUCT + ".lnk"), os.path.join(pub, "Desktop", PRODUCT + ".lnk")]
    return {
        "HKCU root": values(winreg.HKEY_CURRENT_USER, ""),
        "HKLM root": values(winreg.HKEY_LOCAL_MACHINE, ""),
        "HKCU Software keys": subkeys(winreg.HKEY_CURRENT_USER, "Software"),
        "HKLM entry": values(winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall" + "\\" + PRODUCT, w64),
        "HKLM vacantsystems": values(winreg.HKEY_LOCAL_MACHINE, r"Software\vacantsystems" + "\\" + PRODUCT, w64),
        "shortcuts": {p: (os.path.getmtime(p) if os.path.exists(p) else None) for p in lnks},
        "ProgramData": files_under(os.path.join(pd, "Vacant Systems")),
    }


def main():
    if len(sys.argv) != 2 or not os.path.isfile(sys.argv[1]):
        sys.exit(__doc__)
    if values(winreg.HKEY_CURRENT_USER, ENTRY) is not None or values(winreg.HKEY_CURRENT_USER, VERBS) is not None:
        sys.exit(f"HKCU\\{TEST} holds {PRODUCT} keys already (a test left them): delete them first")
    tmp = tempfile.mkdtemp(prefix="latch_setup_")
    try:
        folder = os.path.join(tmp, PRODUCT)
        os.makedirs(folder)
        exe = os.path.join(folder, EXE)
        shutil.copy2(sys.argv[1], exe)
        root = os.path.join(tmp, "root")

        def run(*args):
            assert "--test-root" in args   # (never a real setup)
            return subprocess.run([exe, *args], capture_output=True, timeout=120).returncode

        before = machine()
        check(run("--setup", "--test-root", root) == 0, "--setup --test-root exits 0")
        e = values(winreg.HKEY_CURRENT_USER, ENTRY) or {}
        check(e.get("DisplayName", ("",))[0] == PRODUCT and e.get("UninstallString", ("",))[0].lower().startswith(f'"{exe}" --uninstall'.lower()),
              "the test entry: its name and uninstall string")
        check(values(winreg.HKEY_CURRENT_USER, VERBS) is None, "no verbs key under the test key")
        check(os.path.exists(os.path.join(root, "StartMenu", PRODUCT + ".lnk")) and os.path.exists(os.path.join(root, "Desktop", PRODUCT + ".lnk")),
              "the shortcuts under the test root")
        check(run("--setup", "--test-root", root) == 0, "--setup runs again")
        check(run("--setup", "--nonsense", "--test-root", root) == 2, "--setup --nonsense exits 2")
        after = machine()
        for k in before:
            check(before[k] == after[k], f"after --setup, unchanged: {k}")
        check(run("--uninstall", "--quiet", "--keep-files", "--test-root", root) == 0, "--uninstall --quiet --keep-files --test-root exits 0")
        check(values(winreg.HKEY_CURRENT_USER, ENTRY) is None, "the test entry is gone")
        left = [os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs if f.endswith(".lnk")]
        check(not left, f"no shortcut left under the test root {left}")
        check(os.path.exists(exe), "the folder left (the manager removes it)")
        gone = machine()
        for k in before:
            check(before[k] == gone[k], f"after --uninstall, unchanged: {k}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("all passed" if not failed else f"FAILED ({failed})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
