#!/usr/bin/env python3
"""Verification gate for the Camiguin Market build loop.

This is the *checker* half of the loop: it never asks the model whether the work
is done. It runs the real commands and answers pass/fail.

Wired to the Claude Code `Stop` hook (see .claude/settings.json). A red gate
prints {"decision": "block", "reason": ...} and exits 2, which refuses the stop
and sends the agent back to keep fixing. A green gate exits 0.

Usage:
  python3 .claude/gate.py            # run every check
  python3 .claude/gate.py --fast     # skip the slow checks (gradle, emulator)
  python3 .claude/gate.py --list     # show the checks without running them

Environment:
  GATE_SKIP=gradle,firestore         # skip individual checks by name
  GATE_ALLOW_MISSING_TOOLCHAIN=1     # treat a missing toolchain as skip, not fail

Exit codes: 0 = green, 2 = red (blocks the Stop hook), 1 = gate itself broke.

The toolchain lives in the user's home (no root in this VM):
  ~/.local/jdk21                        Temurin JDK 21
  ~/.local/gradle                       Gradle 9.6.0
  ~/.local/android-sdk                  Android SDK (platform 37.0, build-tools 36)
  ~/.local/npm/bin                      firebase-tools
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = Path.home()
LOG = ROOT / ".claude" / "gate.log"

GRADLE_TIMEOUT = 900
WORKER_TIMEOUT = 180
WEB_TIMEOUT = 300
FIRESTORE_TIMEOUT = 420


def toolchain_env():
    """Environment with the home-installed JDK, Gradle, SDK and npm bin."""
    env = os.environ.copy()
    jdk = HOME / ".local" / "jdk21"
    npm_bin = HOME / ".local" / "npm" / "bin"
    android = HOME / ".local" / "android-sdk"

    if jdk.exists():
        env["JAVA_HOME"] = str(jdk)
    env["ANDROID_HOME"] = str(android)
    env["ANDROID_SDK_ROOT"] = str(android)

    path = [
        str(jdk / "bin"),
        str(HOME / ".local" / "gradle" / "bin"),
        str(npm_bin),
        str(android / "platform-tools"),
        env.get("PATH", ""),
    ]
    env["PATH"] = os.pathsep.join(p for p in path if p)
    return env


def find_gradle(env):
    for candidate in (
        HOME / ".local" / "gradle" / "bin" / "gradle",
        Path(shutil.which("gradle", path=env["PATH"]) or "/nonexistent"),
    ):
        if candidate and Path(candidate).is_file():
            return str(candidate)
    return None


def run(name, command, cwd, timeout, env):
    """Run one check. Returns (ok, summary, detail)."""
    started = time.time()
    try:
        completed = subprocess.run(
            command,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, f"{name}: TIMEOUT after {timeout}s", ""
    except OSError as error:
        return False, f"{name}: cannot run ({error})", ""

    elapsed = time.time() - started
    output = (completed.stdout or "") + (completed.stderr or "")
    tail = "\n".join(output.strip().splitlines()[-40:])
    if completed.returncode == 0:
        return True, f"{name}: PASS ({elapsed:.0f}s)", tail
    return False, f"{name}: FAIL (exit {completed.returncode}, {elapsed:.0f}s)", tail


def checks(env, fast):
    """(name, command, cwd, timeout) for every verification the loop relies on."""
    gradle = find_gradle(env)
    items = []

    if gradle:
        items.append(
            (
                "gradle",
                [gradle, "assembleDebug", "--console=plain"],
                ROOT,
                GRADLE_TIMEOUT,
            )
        )
    else:
        items.append(("gradle", None, ROOT, GRADLE_TIMEOUT))

    items.append(
        (("worker"), ["npm", "test"], ROOT / "worker", WORKER_TIMEOUT)
    )

    if not fast:
        items.append(
            ("web", ["npm", "run", "build"], ROOT / "web", WEB_TIMEOUT)
        )
        items.append(
            (
                "firestore",
                [
                    "firebase",
                    "emulators:exec",
                    "--only",
                    "firestore",
                    "--project",
                    "demo-camiguin",
                    "python3 scripts/test-firestore-rules.py",
                ],
                ROOT,
                FIRESTORE_TIMEOUT,
            )
        )

    return items


def main(argv):
    fast = "--fast" in argv
    listed = "--list" in argv
    skip = {
        name.strip()
        for name in os.environ.get("GATE_SKIP", "").split(",")
        if name.strip()
    }
    allow_missing = os.environ.get("GATE_ALLOW_MISSING_TOOLCHAIN") == "1"
    env = toolchain_env()
    items = checks(env, fast)

    if listed:
        for name, command, cwd, _ in items:
            print(f"{name:10} {' '.join(command) if command else '(toolchain missing)'}  [{cwd}]")
        return 0

    skipped = set(skip)
    if not (HOME / ".local" / "jdk21").exists() and allow_missing:
        skipped |= {"gradle", "firestore"}
    if shutil.which("firebase", path=env["PATH"]) is None and allow_missing:
        skipped.add("firestore")

    results = []
    lines = [f"gate: {'fast' if fast else 'full'} run at {time.strftime('%Y-%m-%d %H:%M:%S')}"]

    for name, command, cwd, timeout in items:
        if name in skipped:
            lines.append(f"{name}: SKIPPED")
            print(f"  · {name}: skipped")
            continue
        if command is None:
            ok, summary, detail = False, f"{name}: toolchain missing (no gradle found)", ""
        else:
            ok, summary, detail = run(name, command, cwd, timeout, env)
        results.append((ok, summary, detail))
        lines.append(summary)
        if detail:
            lines.append(detail)
        print(("  ✓ " if ok else "  ✗ ") + summary)

    failures = [r for r in results if not r[0]]
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text("\n\n".join(["\n".join(lines)]) + "\n")

    if not results:
        print("gate: nothing ran (everything skipped) — refusing to call this green")
        return 0 if allow_missing else 1

    if not failures:
        print(f"\ngate: GREEN — {len(results)} checks passed")
        return 0

    print(f"\ngate: RED — {len(failures)} of {len(results)} checks failed")
    print(f"full output: {LOG}")
    reason = "; ".join(s for _, s, _ in failures)
    print(
        json.dumps(
            {
                "decision": "block",
                "reason": (
                    f"Verification gate is red: {reason}. "
                    f"Read the failing output in {LOG}, fix the cause, "
                    "and do not report the work as done until the gate is green."
                ),
            }
        )
    )
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
