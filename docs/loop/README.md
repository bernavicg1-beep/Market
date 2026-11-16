# The build loop

A closed loop: the loop prompts the agent instead of you prompting the loop.
Maker and checker are separate, so "done" is never the agent's own opinion.

```
        ┌──────────────────────────────────────────────┐
        │  goal: docs/loop/GOAL.md   (ceiling: 30 turns)│
        └───────────────────┬──────────────────────────┘
                            │
                     maker: the agent edits code
                            │
              agent tries to stop ──────► .claude/settings.json (Stop hook)
                                                │
                                      python3 .claude/gate.py
                                       │                     │
                                  exit 0 (green)        exit 2 + block reason
                                       │                     │
                                    finish            agent keeps working
```

## The four parts

| Part | Where |
| --- | --- |
| Goal | [GOAL.md](GOAL.md) — work packages W1–W8 plus acceptance lines |
| Maker | the coding agent |
| Gate | [.claude/gate.py](../../.claude/gate.py), wired as a `Stop` hook in [.claude/settings.json](../../.claude/settings.json) |
| Bound | 30 turns, stated in GOAL.md and in the `/goal` prompt |

## Why the gate is trustworthy

- It runs **real commands**, not a model: Gradle debug build, Worker unit tests,
  Vite build, and the Firestore emulator suite.
- It costs **zero tokens** — verification is a shell script, not an LLM call.
- It cannot be talked out of a failure: red output ⇒ exit 2 ⇒ the stop is
  refused and the agent is thrown back in with the failing summary.
- Its last output is written to `.claude/gate.log` so the reason is inspectable.

## Commands

```bash
python3 .claude/gate.py              # full gate (build + tests + emulator)
python3 .claude/gate.py --fast       # skip web build and emulator
python3 .claude/gate.py --list       # what would run
GATE_SKIP=firestore python3 .claude/gate.py
```

Expected cost of a full run: roughly 3–5 minutes warm
(Gradle is the slow part; the emulator suite adds about a minute).

## Toolchain (installed in this VM, no root)

| Tool | Path | Version |
| --- | --- | --- |
| JDK | `~/.local/jdk21` | Temurin 21.0.13 |
| Gradle | `~/.local/gradle` | 9.6.0 (AGP 9.5.1 requires ≥ 9.6.0) |
| Android SDK | `~/.local/android-sdk` | platform 37.0, build-tools 36.0.0 |
| firebase-tools | `~/.local/npm/bin` | 15.36.0 |

`gate.py` puts these on `PATH` itself, so no shell exports are needed.
System packages and these downloads do **not** survive archiving — rebuild the
toolchain with:

```bash
mkdir -p ~/.local/bin
curl -L -o /tmp/jdk21.tar.gz https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse
mkdir -p ~/.local/jdk21 && tar -xzf /tmp/jdk21.tar.gz -C ~/.local/jdk21 --strip-components=1
curl -L -o /tmp/gradle.zip https://services.gradle.org/distributions/gradle-9.6.0-bin.zip
(cd ~/.local && unzip -q /tmp/gradle.zip && mv gradle-9.6.0 gradle)
curl -L -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
mkdir -p ~/.local/android-sdk/cmdline-tools && (cd ~/.local/android-sdk/cmdline-tools && unzip -q /tmp/cmdtools.zip && mv cmdline-tools latest)
export JAVA_HOME=~/.local/jdk21 ANDROID_HOME=~/.local/android-sdk
yes | ~/.local/android-sdk/cmdline-tools/latest/bin/sdkmanager --licenses
~/.local/android-sdk/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-37.0" "build-tools;36.0.0"
npm config set prefix ~/.local/npm && npm install -g firebase-tools
```

## Model routing

- **Maker:** the strong model — it writes the Kotlin, Worker, and rules.
- **Checker:** free — it is a script. That is the whole saving.
- **Log reading / triage:** cheap model only.

## What the gate does *not* prove

The gate cannot see a phone. These stay manual and must be reported as
unverified in any handover:

- SMS phone verification (needs real Firebase phone auth + a real SIM).
- Leaflet pin tapping, pin dragging, WebView → Kotlin callbacks.
- Live OSRM routes and Nominatim search responses.
- Real Cloudinary uploads (needs a configured account and Worker secret).
- Release signing with the real keystore.
