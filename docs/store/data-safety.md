# Data safety declaration — Camiguin Market

Answers for Play Console → *App content → Data safety*. Each row matches what
the app actually writes; see `MainActivity.kt`, `Extras.kt`, `firestore.rules`
and `worker/index.js`.

## Overview answers

| Question | Answer | Why |
| --- | --- | --- |
| Does your app collect or share user data? | **Yes** | Accounts, listings, photos, chat |
| Is all collected data encrypted in transit? | **Yes** | Firebase and the Worker are HTTPS only |
| Do you provide a way to request data deletion? | **Yes** | In-app 🗑️, plus `docs/account-deletion.html` |
| Is data shared with third parties? | **No** (service providers only) | See the note below |
| Is the data used for advertising or tracking? | **No** | No ads SDK, no analytics SDK |
| Does the app target children? | **No** | General audience |

Play treats a processor that only handles data on your behalf as *not* "shared".
Firebase (Google) and Cloudinary are processors here, named below.

## Data collected

| Data type (Play label) | Collected | Purpose | Optional? | Notes |
| --- | --- | --- | --- | --- |
| Name | Yes | Account, listing display | No | `users/{uid}.name`, `sellerName` |
| Email address | Yes | Account, sign-in, contact | No | Firebase Auth; shown on a listing as seller contact |
| Phone number | Yes | Contact, verification | **Yes** | Only if the user adds and verifies it |
| Photos | Yes | Listing content, profile picture | **Yes** | Uploaded to Cloudinary; public IDs stored in Firestore |
| Approximate location | Yes | Local listings, pickup | **Yes** | Town name only if the user picks one |
| Precise location | Yes | Pickup pin, "my location", routing | **Yes** | Only with the location permission, and never required to browse |
| Messages (in-app) | Yes | Buyer–seller chat | Yes | `chats/{id}/messages` |
| Other user content | Yes | Listings, orders, ratings, reports | Yes | Titles, descriptions, prices |
| Device or other IDs | Yes | Push notifications | **Yes** | FCM registration token, deleted on sign-out and account deletion |
| App activity | Yes | Views and cart counts per listing | No | Counters only, not a per-user history |

### Not collected

- Payment or financial info — orders are arranged directly between buyer and
  seller; the app processes no payments.
- Contacts, calendar, SMS, call logs.
- Health, fitness, browsing history.
- Advertising ID.

## Processors

| Processor | Data | Why |
| --- | --- | --- |
| Google Firebase (Auth, Firestore, FCM) | Account, listings, messages, device tokens | Backend, database, push |
| Cloudinary | Listing photos and videos | Media storage and delivery |
| OpenStreetMap / OSRM / Nominatim | Map tiles, route and place lookups | Map display and directions |

## Security and retention

- Transport: HTTPS only; the Cloudinary API secret exists only as a Worker
  secret and never in the app.
- Retention: listings live until the seller deletes them or a perishable
  listing expires (the cron removes the document and its media). Account
  deletion removes the user's listings and their photos, then the account.
- Deletion requests: in-app, or by email to `bernavicg1@gmail.com` (answered
  within 7 business days, completed within 30 days).

## Permission justifications

| Permission | Why the app asks |
| --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Firebase, media, map tiles |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | Pickup pin, "my location", distances. Browsing works without it |
| `POST_NOTIFICATIONS` | Order and chat updates. Refusing only silences push |
