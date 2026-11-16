# Handover — Camiguin Market v0.8 loop run

Written at the end of the loop run. It states only what the gate actually
proved. Anything else is listed as unverified.

## What the gate proved

`.claude/gate.py` was green on the final run (`GATE_EXIT=0`):

| Check | Command | Result |
| --- | --- | --- |
| Android debug build | `gradle assembleDebug` | PASS |
| Worker tests | `npm test` in `worker/` | PASS, **32/32** |
| Web build | `npm run build` in `web/` | PASS |
| Firestore rules | `firebase emulators:exec ... test-firestore-rules.py` | PASS, **110/110** |

The gate was also proven to block: a deliberately failing test produced
`exit 2` and `{"decision":"block", ...}`. That fail path is wired to the Stop
hook in `.claude/settings.json`.

The gate does **not** prove that the app talks to Cloudinary successfully. It
proves the signing code, the request shapes, the rules and the cleanup
ordering. A real account and a real phone are still needed for the rest.

## Work packages

### W1 — Cloudinary signed uploads — done

- `POST /cloudinary-sign` verifies the Firebase ID token, then returns
  `cloudName`, `apiKey`, `timestamp`, `signature`, `folder`, `uploadPreset`,
  `publicId`, `overwrite: false`, `resourceType` and `uploadUrl`.
- Signature is SHA-1 over the alphabetically sorted params plus
  `CLOUDINARY_API_SECRET`, which lives only in Worker secrets.
- Preset stays `camiguin_market_products`, folder `camiguin_market/products`,
  signed mode. `ml_default` is untouched.
- Missing credentials fail closed with `503 media_not_configured` — there is no
  unsigned fallback.
- `grep -r CLOUDINARY_API_SECRET app/` returns nothing; a test asserts the
  secret never appears in a response body.

### W2 — Kotlin upload through Cloudinary — done

- `requestCloudinarySignature()` + `uploadListingMedia()` in `MainActivity.kt`;
  the app posts the bytes straight to Cloudinary with exactly the signed params.
- Photos are compressed to ≤1600 px at JPEG 80 before upload (already the case
  in `compressForUpload`, now on the Cloudinary path too).
- Maximum 5 photos, enforced in the picker (`take(5)`) **and** in the rules.
- `imageUrls` and `cloudinaryPublicIds` are stored together, so assets can be
  deleted later by ID rather than by URL.
- Failure is surfaced through the existing `uploadError` state; previews and
  removal before publishing are unchanged.

### W3 — Schema and rules — done

`listings` gains `cloudinaryPublicIds`, `videoUrls`, `cloudinaryVideoPublicIds`,
`quantity`, `condition`, `status`, `pickupAddress`, `updatedAt`,
`expirationDate`, `expirationTime`.

- Optional, but typed when present; `quantity >= 1`; media lists capped at 5.
- Owner update is restricted to the documented field list, and ownership
  transfer is still refused.
- Existing compatibility is unchanged: `id = ""`, `price` double,
  `createdAt` long, nullable coordinates, `createdAt` ordering.
- Rules checks went from 99 to **110**; no existing check was deleted or
  weakened. Two checks were deliberately *tightened* (6 photos → 5).

### W4 — Expiration and media cleanup — done

- The cron hides each expired listing first (`status: "expired"`,
  `cleanupState: "purging"`), then deletes its media, then the document. The
  document is never removed before its media, so no asset is ever orphaned.
- Cloudinary assets are deleted by public ID through the Admin API (server-side
  only). Legacy R2 photos are still removed by key.
- A failed media delete leaves the document with `cleanupState: "media_failed"`
  and an incremented `cleanupAttempts`, so the next run retries it.
- Tests cover ordering, retry, the attempt counter, and the
  `expiresAt = 0` non-perishable case.
- `POST /delete-images` now also accepts `publicIds`, authorized by the
  `<uid>/` prefix (or an admin), used when a seller replaces photos.

### W5 — Map bridge — partially done, and the premise was wrong

`LeafletBridge` is dead code: the in-app map is **native osmdroid**
(`LeafletMap.kt` builds `MapView`s), and nothing registers the bridge or calls
`leafletConfig()`. The callbacks were hardened anyway — non-finite or
out-of-range coordinates and empty/oversized marker IDs are dropped, and every
callback is wrapped so a malformed payload cannot throw on the WebView thread.

Nothing about the map was verified on a device. Pin tapping, dragging, and the
OSRM/Nominatim lookups remain unverified.

### W6 — GitHub Actions — configuration done, never executed

- `firestore-rules.yml`: VALIDATE runs the emulator suite; DEPLOY uses
  `FIREBASE_SERVICE_ACCOUNT` first, `FIREBASE_TOKEN` second, and **skips with a
  written summary** when neither exists. No false success.
- `build.yml`: debug APK on push to `main`.
- `release.yml`: manual + tag, signed APK/AAB, `apksigner verify --print-certs`.
- JDK and Gradle pinned to the versions verified here (JDK 21, Gradle 9.6.0);
  they previously pinned JDK 17, which the verified toolchain does not use.
- All four workflow files parse as YAML. **No workflow has been run on GitHub**,
  so a green Actions run is not claimed.

### W7 — Version and Play preparation — done

- `versionCode = 42`, `versionName = "0.8"`.
- `docs/account-deletion.html` now shows the real support address
  (`bernavicg1@gmail.com`) as a `mailto:` link; no placeholder remains, and the
  README no longer tells the reader to replace one.
- Store material lives in `docs/store/`:
  - `listing.md` — name, short description, full description, category,
    contact, URLs and the “what's new” text.
  - `data-safety.md` — every Data safety answer, the processor list, and the
    permission justifications.
  - `screenshots.md` — required sizes and the exact shots to take.
- **Not done, because it needs a phone:** the screenshots, icon and feature
  graphic themselves. Play will not accept the listing without them.

### W8 — This note

## Still needs a real device or a real account

None of the following was observed working:

1. SMS phone verification.
2. Cloudinary upload from the app (needs `CLOUDINARY_CLOUD_NAME`,
   `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` set as Worker secrets, then a
   real listing posted from a phone).
3. Video capture and upload — the UI for it does not exist yet; the schema and
   signing path do.
4. Map pin tapping/dragging, and live OSRM/Nominatim routing.
5. WebView callbacks (the bridge is unused; see W5).
6. Signed release build and Play Console upload (needs the keystore secrets).
7. The GitHub Actions workflows.

## Manual steps left

1. Set the three Cloudinary secrets on the Worker
   (`wrangler secret put ...`), keeping the preset signed.
2. Enable GitHub Pages (Settings → Pages → Branch `main`, folder `/docs`), then
   submit the account-deletion URL in Play Console → Data deletion.
3. Take the screenshots, icon and feature graphic listed in
   `docs/store/screenshots.md`.
4. Add `FIREBASE_SERVICE_ACCOUNT` to the repository secrets so rules deploy
   from CI instead of being skipped.
5. Post one listing from a real phone and confirm the photo lands in
   `camiguin_market/products/<uid>/` and appears on the listing.
