# Camiguin Market — master brief (v0.8)

Canonical specification for the loop. When this file and the code disagree, this
file wins; when this file and [GOAL.md](GOAL.md) disagree about *order of work*,
GOAL.md wins.

**Project:** Camiguin Market · *Camiguin Market · Buy Local. Support Local!*
**Version:** 0.8 · **Platform:** Android · **Language:** Kotlin
**UI:** Jetpack Compose · **Auth/DB:** Firebase Authentication + Firestore
**Media:** Cloudinary Free Plan (**not** Cloudflare R2)
**Map:** Leaflet + OpenStreetMap in a WebView · **Routing:** OSRM
**Search:** Nominatim · **CI:** GitHub Actions · **Distribution:** Google Play

---

## 1. Overview

A local marketplace connecting buyers and sellers across Camiguin Island:
agricultural produce, fruit and vegetables, fish and seafood, meat and poultry,
groceries, household goods, clothing, electronics, local products.

## 2. Accounts

Register, login, logout, Firebase Authentication, SMS phone verification, profile
creation with picture, edit profile, display name/profile, secure session
management, account deletion.

## 3. Buyer features

Browse · search by name · categories · filters · photos · descriptions · prices ·
quantity and availability · seller info and profile · pickup locations ·
directions · contact seller · report a listing · expiration info · active/sold/
expired status.

## 4. Seller features

Create listing · up to 5 photos (+ video if enabled) · name, description, price,
category, quantity, condition, pickup location · drop a pin on the map · edit own
products · mark sold · delete own listings · view active and expired listings ·
manage availability. **Only the authenticated owner may edit or delete.**

## 5. Categories

Fruits · Vegetables · Fish and Seafood · Meat and Poultry · Fresh Food · Rice and
Agricultural Products · Groceries · Household Items · Clothing · Electronics ·
Local Products · Other Products. Must stay expandable.

## 6. Mandatory perishable expiration

Perishable listings require an expiration date **and** time before publishing.
The system monitors expiry, removes expired items from active search, deletes
them under the retention policy, and schedules their Cloudinary media for
deletion. Failed deletions are retried. Non-perishables follow a separate policy.

## 7. Cloudinary

Preset `camiguin_market_products` · folder `camiguin_market/products` ·
**signed** · unique auto public IDs · overwrite disabled · upload restrictions.
`ml_default` must stay unchanged. Never switch the preset to unsigned.

**Images:** max 5 per listing; compress before upload; longest side ≤ 1600 px;
JPEG quality ≈ 80; auto format where supported; progress indicator; error
handling; preview and removal before publishing; store `secure_url` **and**
`public_id`.

**Video (if enabled):** validate type, 100 MB max on the Free Plan, progress,
store URL and public ID, allow cleanup on expiry.

**Signed flow:** app → backend → backend verifies the Firebase user → backend
signs → app uploads directly to Cloudinary → Cloudinary returns URL + public ID →
app saves references in Firestore. **The API secret never ships in the app.**

**Free plan limits:** 25 monthly credits shared across storage, bandwidth and
transformations; 10 MB max image, 100 MB max video, 10 MB max raw, 100 MB max
image transformation, 40 MB max video transformation, 25 MP max megapixels,
500 Admin API requests/hour. Do not treat 25 credits as 25 GB of storage.
Monitor credits, storage, bandwidth, transformations, upload failures and
deletion failures.

## 8. Firestore

`users`: uid, name, email, phone, profileImageUrl, createdAt.

`listings`: id, sellerId, sellerName, title, description, price, category,
quantity, isPerishable, expirationDate, expirationTime, createdAt, updatedAt,
status, latitude, longitude, pickupAddress, imageUrls, cloudinaryPublicIds,
videoUrls, cloudinaryVideoPublicIds.

**Compatibility the tests pin:** `id = ""`; `price` is a double; `createdAt` is a
long; `latitude`/`longitude` may be null; listings ordered by `createdAt`;
account deletion uses the existing seller-listing query. Never change a document
format without changing the Kotlin code and the tests together.

## 9. Security rules

Anonymous users cannot read or write protected listings. Authenticated owners
manage only their own. Ownership cannot be transferred. Invalid field types are
rejected. Price must be numeric. Unauthorized deletes are denied. Only permitted
fields may be modified. **Never** ship `allow read, write: if true`.

## 10. Rule tests

`scripts/test-firestore-rules.py`, behavioural checks covering anonymous denial,
owner allowed, other user denied, transfer denied, wrong price type, the exact
documents the Android app writes, empty id, double price, long createdAt, null
coordinates, createdAt ordering and the account-deletion query.

```bash
firebase emulators:exec --only firestore --project demo-camiguin \
  "python3 scripts/test-firestore-rules.py"
```

Requires JDK 21 or newer.

## 11. Rules CI

`.github/workflows/firestore-rules.yml`, two jobs:
**VALIDATE** — compile the rules, run the checks, on every push to main and on
PRs touching the rules; fail on any failure.
**DEPLOY** — `firebase deploy --only firestore:rules`, only when a credential
exists (`FIREBASE_SERVICE_ACCOUNT` preferred, `FIREBASE_TOKEN` legacy, service
account wins). Missing credential ⇒ skip with a clear Actions summary; never a
false success. No credentials in the repo.

## 12. Map

Leaflet + OSM in a WebView. Show Camiguin; show seller pickup pins; drop and drag
pins; save latitude/longitude; show buyer location with permission; A-to-B via
OSRM; location search via Nominatim; route info; graceful failure. JS↔Kotlin
callbacks `onPick` and `onMarker` must validate their payloads. Location sharing
is optional and never required for browsing.

## 13. Expiration and media cleanup

Scheduled backend: find expired perishables → remove from active results → mark
for processing → delete Cloudinary images → delete video if present → delete the
Firestore document only when cleanup completes → record status → retry failures.
The Admin API is reached only from the backend; cleanup uses stored public IDs.
Deleting the document alone does not reclaim media.

## 14. Account deletion

**In-app:** top bar of the market screen; confirmation dialog naming the account;
delete the user's listings; delete their Cloudinary media; delete the Firebase
Auth account; handle `FirebaseAuthRecentLoginRequiredException`; clear success
and failure messages; no orphaned media.

**Web:** `docs/account-deletion.html` via GitHub Pages (branch `main`, folder
`/docs`); replace `YOUR_SUPPORT_EMAIL_HERE`; submit the URL in Play Console →
App content → Data deletion.

## 15. Screens

Welcome · Login · Registration · Home marketplace · Categories · Search ·
Product details · Create listing · Edit listing · Image selector · Upload
progress · Pickup map · Seller profile · Buyer profile · Seller product
management · Active listings · Expired listings · Notifications · Account
settings · Delete-account confirmation.

Modern, clean, mobile-first, Camiguin-inspired identity, readable information,
consistent colour and type, loading indicators, error messages, empty states.

## 16. GitHub Actions

`.github/workflows/firestore-rules.yml`, `build.yml`, `release.yml`.
Build: debug APK on push to main, plus release APK/AAB when credentials exist.
Release: manual and tag driven, signed APK and AAB, GitHub Release, permanent
download links. Bump `versionCode`/`versionName` before every release (v0.8).

## 17. Signing

Same identity forever. Secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`,
`KEY_ALIAS`, `KEY_PASSWORD`. Verify with `apksigner verify --print-certs`; an
unsigned or wrongly signed release must fail. Never commit the keystore. Enable
Play App Signing.

## 18. Testing

Auth: register, login, logout, SMS verification, profile update, deletion.
Marketplace: create, edit, search, category filter, status, seller permissions.
Media: five-photo cap, compression, upload, display, URL storage, unauthorized
deletion blocked, automatic cleanup.
Expiration: expiry required, invalid rejected, expired removed, cleanup, retry.
Map: loading, pin select, pin drag, coordinate save, route, search, bridge.
Security: rules, auth, signature validation, backend authorization, secrets.

## 19. Play Store

Signed AAB · icon · screenshots · description · privacy policy · data safety ·
account deletion URL · package name · version info · content declarations ·
internal then closed testing then production.

## 20. Build commands

```bash
gradle assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
gradle assembleRelease   # signed APK
gradle bundleRelease     # app/build/outputs/bundle/release/app-release.aab
```

## 21. Verified vs unverified

Already confirmed: `assembleDebug`, `assembleRelease`, Worker tests, the JS in
`leaflet_map.html` parses.

Not verified on a device or emulator: Leaflet pin tapping, pin dragging, WebView
callbacks, live OSRM routes, Nominatim responses, media uploads, SMS
verification. Cloudinary account and preset setup also still need verifying.

## 22–23. Deliverables and acceptance

Complete Kotlin source, Compose UI, Auth, Firestore, production rules, automated
security tests, Cloudinary signed uploads, secure signing backend, compression,
five-photo cap, media display, media deletion, automatic expiry, cleanup service,
Leaflet map, OSRM, Nominatim, account deletion, CI workflows, signed APK, signed
AAB, GitHub Release automation, account-deletion page, setup docs.

Production-ready only when every item above works end to end, the rule tests
pass, the workflows run, both artifacts are correctly signed, and real-device
testing is complete.

---

## Final decisions

| Area | Decision |
| --- | --- |
| Media storage | Cloudinary Free Plan |
| Database | Firebase Firestore |
| Upload security | Signed upload + secure backend |
| Product photos | Max 5, compressed to 1600 px |
| Automatic cleanup | Expired listing + Cloudinary media deletion |
| Stack | Kotlin + Jetpack Compose |

**Order of work:** Cloudinary account and preset → transformations and upload
restrictions → signing backend → Kotlin uploads → Firestore → expiry and media
deletion → tests and CI → APK/AAB and Play Store.
