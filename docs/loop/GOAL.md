# Loop goal — Camiguin Market v0.8

The single objective the loop works toward, until the gate is green **and** every
acceptance item below is met.

**Trigger (do not auto-run):**

```bash
/goal "Work through docs/loop/GOAL.md in order. After each work package, run
python3 .claude/gate.py and keep fixing until it is green. Stop when the
acceptance list is complete or after 30 turns, whichever comes first."
```

**Ceiling: 30 turns.** When the ceiling is hit, the loop stops and reports what
is left — it does not keep spending budget.

---

## Definition of done

An item is done only when all three hold:

1. `.claude/gate.py` is **green** (Gradle debug build, Worker tests, web build,
   99 Firestore rule checks).
2. The item's own acceptance line below is satisfied by real code, not a stub.
3. Nothing in [BRIEF.md](BRIEF.md) was violated — in particular: no Cloudinary
   API secret in the app, no unsigned upload preset, no unrestricted Firestore
   rules, no committed keystore or credentials.

The gate is the only authority on "done". Anything reported as complete without
a green gate is false completeness.

---

## Current state (verified at setup)

| Thing | State |
| --- | --- |
| `gradle assembleDebug` | Green (JDK 21, Gradle 9.6.0, SDK 37.0) |
| `worker` tests | Green, 17/17 |
| Firestore rules tests | Green, 99/99 (brief says 90; the script actually has 99) |
| `web` Vite build | Not yet run in this VM |
| Media storage | **Cloudflare R2 today** via `worker/index.js` `/upload` — must become Cloudinary |
| App version | 0.41 |
| Map | `LeafletMap.kt` + `assets/` (WebView bridge present, unverified on device) |
| Account deletion | In-app, handles `FirebaseAuthRecentLoginRequiredException` |
| `docs/account-deletion.html` | Present, still has `YOUR_SUPPORT_EMAIL_HERE` |

---

## Work packages, in order

Follow the order from the brief: Cloudinary first, because every later media
step (compression, cleanup, deletion) depends on it.

### W1 — Cloudinary signed uploads (blocks W2–W5)

- Worker endpoint `POST /cloudinary-sign` (or `/upload/sign`) that verifies the
  Firebase ID token, then returns `timestamp`, `signature`, `api_key`, `folder`,
  `upload_preset`, and a unique `public_id`.
- Signature = SHA-1/SHA-256 of `folder + public_id + timestamp (+ preset)` signed
  with `CLOUDINARY_API_SECRET`, which lives **only** in Worker secrets.
- Preset stays `camiguin_market_products`, folder `camiguin_market/products`,
  overwrite disabled, unique public IDs, **signed** mode. Never flip it to
  unsigned.
- `ml_default` stays untouched.
- Worker tests cover: missing token → 401, valid token → signature shape,
  tampered/missing secret → 503, no secret leakage in the response body.

**Accept:** `worker` tests green with new cases; `grep -r CLOUDINARY_API_SECRET
app/` returns nothing.

### W2 — Kotlin photo upload through Cloudinary

- Compress before upload: longest side ≤ 1600 px, JPEG quality ≈ 80.
- Max 5 photos per listing, enforced in UI **and** in the Firestore rules tests.
- Upload directly to Cloudinary using the signed params; show progress; handle
  failure; allow preview and removal before publishing.
- Persist `imageUrls` **and** `cloudinaryPublicIds` (plus video equivalents).

**Accept:** gate green; a listing posted with 6 photos is rejected by the rules
test, 5 accepted.

### W3 — Firestore schema and rules for the new fields

- `listings` gains `cloudinaryPublicIds`, `videoUrls`, `cloudinaryVideoPublicIds`,
  `quantity`, `condition`, `status`, `pickupAddress`, `updatedAt`,
  `expirationDate`, `expirationTime` — while keeping the compatibility the tests
  already pin (`id = ""`, `price` double, `createdAt` long, null coordinates).
- Owner-only update restricted to permitted fields; ownership transfer denied.

**Accept:** 99+ checks pass, including new field cases; no existing check is
weakened or deleted to make room.

### W4 — Expiration and Cloudinary media cleanup

- Scheduled Worker (cron in `wrangler.toml`) finds expired perishable listings,
  hides them from active queries, deletes Cloudinary assets by stored public ID
  through the Admin API (server-side only), then deletes the Firestore document.
- Record cleanup status (`status` / `cleanupState`) so a partial failure is
  visible and retryable; retry failed media deletions.
- Never rely on document deletion alone to reclaim media.

**Accept:** `worker/test/purge.test.js` extended to cover ordering
(document only after media), retry on media failure, and the
non-perishable `expiresAt = 0` case.

### W5 — Map, OSRM, Nominatim on the WebView bridge

- `onPick` / `onMarker` callbacks hardened: validate numeric ranges, ignore
  malformed payloads, never crash the WebView.
- Buyer location only with permission and never required to browse.
- Graceful degradation when OSRM/Nominatim are unreachable.

**Accept:** JS parses, `assembleDebug` green; device behaviour listed as
unverified in the handover note (no emulator in this VM — say so, do not claim
it works).

### W6 — GitHub Actions

- `firestore-rules.yml`: VALIDATE (compile + run the checks) and DEPLOY
  (`FIREBASE_SERVICE_ACCOUNT` first, `FIREBASE_TOKEN` fallback) that **skips with
  a clear summary** when no credential exists and never reports a false success.
- `build.yml`: debug APK on push to main.
- `release.yml`: manual + tag, signed APK/AAB, `apksigner verify --print-certs`,
  GitHub Release. Fail on unsigned release build.

**Accept:** workflow YAML validates; docs list the required secrets by name only.

### W7 — Version and Play Store preparation

- Bump to `versionCode`/`versionName` for v0.8.
- Replace `YOUR_SUPPORT_EMAIL_HERE` in `docs/account-deletion.html`.
- Privacy policy, data-safety declarations, screenshot list, descriptions.

**Accept:** no placeholder string remains; gate green.

### W8 — Verification sweep and handover

- Run the full gate one last time.
- Write the handover note: what is proven by the gate, what needs a real device
  (SMS verification, pin dragging, WebView callbacks, OSRM/Nominatim live,
  media uploads), and the exact remaining manual steps.

**Accept:** the note contains no claim the gate did not prove.

---

## Rules the loop must not break

1. Never put `CLOUDINARY_API_SECRET`, `FIREBASE_SERVICE_ACCOUNT`, or any keystore
   in the repo or in the app.
2. Never deploy test-mode Firestore rules (`allow read, write: if true`).
3. Never weaken or delete a passing test to make the gate green — fix the cause.
4. Never change the document format without changing the Kotlin code and the
   rule tests in the same turn.
5. Do not flip the Cloudinary preset to unsigned.
6. Stop at 30 turns and report.
