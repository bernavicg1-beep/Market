/**
 * Tests for `POST /delete-images`, the endpoint the app calls when a seller
 * deletes a listing, replaces its photos, or deletes their account.
 *
 * The important rule is the admin branch: a normal user may only delete photos
 * inside their own `listing_images/<uid>/` folder, and moderator access is
 * granted only by an `admins/{uid}` document found through the service account.
 *
 * Run with: npm test  (inside `worker/`)
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import worker from "../index.js";

const PHOTO = "https://worker.example/i";
const URL_TOKEN = { "user-token": "u1", "admin-token": "admin1" };

// A throwaway key so the Worker's RS256 service-account JWT signing works.
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" });

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub the Google endpoints the Worker talks to, plus the R2 binding. */
function stub({ admins = [], serviceAccount = true, cloudinary = false } = {}) {
  const deleted = [];
  const adminLookups = [];
  const cloudinaryDeletes = [];

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);

    if (href.includes("api.cloudinary.com")) {
      const raw = href.split("public_ids=")[1] || "";
      const ids = decodeURIComponent(raw).split(",").filter(Boolean);
      cloudinaryDeletes.push(...ids);
      return jsonResponse({
        deleted: Object.fromEntries(ids.map((id) => [id, "deleted"])),
      });
    }

    if (href.includes("identitytoolkit.googleapis.com")) {
      const { idToken } = JSON.parse(init.body);
      const uid = URL_TOKEN[idToken];
      return jsonResponse({ users: uid ? [{ localId: uid }] : [] });
    }

    if (href.includes("oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "stub-access-token", expires_in: 3600 });
    }

    if (href.includes("/documents/admins/")) {
      const uid = href.split("/documents/admins/")[1];
      adminLookups.push(uid);
      if (admins.includes(uid)) return jsonResponse({ name: `admins/${uid}`, fields: {} });
      return new Response('{"error":{"code":404}}', { status: 404 });
    }

    throw new Error(`unexpected fetch: ${href}`);
  };

  const env = {
    FIREBASE_WEB_API_KEY: "test-web-api-key",
    IMAGES: {
      async delete(key) {
        deleted.push(key);
      },
    },
  };

  if (serviceAccount) {
    env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
      project_id: "demo-camiguin",
      client_email: "worker@demo-camiguin.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY,
    });
  }

  if (cloudinary) {
    env.CLOUDINARY_CLOUD_NAME = "camiguin-market";
    env.CLOUDINARY_API_KEY = "123456789012345";
    env.CLOUDINARY_API_SECRET = "delete-test-secret";
  }

  return { env, deleted, adminLookups, cloudinaryDeletes };
}

async function call(env, body, { token = "user-token", method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await worker.fetch(
    new Request("https://worker.example/delete-images", {
      method,
      headers,
      body:
        method === "POST"
          ? typeof body === "string"
            ? body
            : JSON.stringify(body)
          : undefined,
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );

  return { status: response.status, body: await response.json() };
}

test("no ID token is rejected", async () => {
  const { env, deleted } = stub();
  const res = await call(env, { urls: [`${PHOTO}/listing_images/u1/a.jpg`] }, { token: "" });

  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error: "unauthorized" });
  assert.deepEqual(deleted, []);
});

test("a seller deletes only their own photos", async () => {
  const { env, deleted, adminLookups } = stub();

  const res = await call(env, {
    urls: [
      `${PHOTO}/listing_images/u1/mine.jpg`,
      `${PHOTO}/listing_images/u2/someone-else.jpg`,
      "https://elsewhere.example/not-r2.jpg",
    ],
  });

  assert.deepEqual(res.body, { deleted: 1, skipped: 2 });
  assert.deepEqual(deleted, ["listing_images/u1/mine.jpg"]);
  // The admin lookup ran for the foreign key, and found nothing.
  assert.deepEqual(adminLookups, ["u1"]);
});

test("an admin may delete another seller's photos", async () => {
  const { env, deleted, adminLookups } = stub({ admins: ["admin1"] });

  const res = await call(env, { urls: [`${PHOTO}/listing_images/u2/someone-else.jpg`] }, {
    token: "admin-token",
  });

  assert.deepEqual(res.body, { deleted: 1, skipped: 0 });
  assert.deepEqual(deleted, ["listing_images/u2/someone-else.jpg"]);
  assert.deepEqual(adminLookups, ["admin1"]);
});

test("without the service account nobody is treated as an admin", async () => {
  const { env, deleted } = stub({ admins: ["admin1"], serviceAccount: false });

  const res = await call(env, { urls: [`${PHOTO}/listing_images/u2/someone-else.jpg`] }, {
    token: "admin-token",
  });

  assert.deepEqual(res.body, { deleted: 0, skipped: 1 });
  assert.deepEqual(deleted, []);
});

test("the admin lookup is reused for every foreign key in one call", async () => {
  const { env, adminLookups } = stub({ admins: ["admin1"] });

  await call(
    env,
    {
      urls: [
        `${PHOTO}/listing_images/u2/a.jpg`,
        `${PHOTO}/listing_images/u3/b.jpg`,
      ],
    },
    { token: "admin-token" },
  );

  assert.deepEqual(adminLookups, ["admin1"]);
});

test("one call deletes at most 30 photos", async () => {
  const { env, deleted } = stub();
  const urls = Array.from({ length: 35 }, (_, i) => `${PHOTO}/listing_images/u1/p${i}.jpg`);

  const res = await call(env, { urls });

  assert.deepEqual(res.body, { deleted: 30, skipped: 0 });
  assert.equal(deleted.length, 30);
});

test("a seller deletes their own Cloudinary assets by public ID", async () => {
  const { env, cloudinaryDeletes, deleted } = stub({ cloudinary: true });

  const res = await call(env, {
    urls: [],
    publicIds: ["u1/1763000000-abcd1234", "u1/1763000001-efgh5678"],
  });

  assert.deepEqual(res.body, { deleted: 2, skipped: 0 });
  assert.deepEqual(cloudinaryDeletes, ["u1/1763000000-abcd1234", "u1/1763000001-efgh5678"]);
  assert.deepEqual(deleted, []);
});

test("another seller's public ID is skipped unless the caller is an admin", async () => {
  const { env, cloudinaryDeletes } = stub({ cloudinary: true });

  const res = await call(env, { urls: [], publicIds: ["u2/theirs"] });

  assert.deepEqual(res.body, { deleted: 0, skipped: 1 });
  assert.deepEqual(cloudinaryDeletes, []);

  const admin = stub({ cloudinary: true, admins: ["admin1"] });
  const adminRes = await call(admin.env, { urls: [], publicIds: ["u2/theirs"] }, {
    token: "admin-token",
  });

  assert.deepEqual(adminRes.body, { deleted: 1, skipped: 0 });
  assert.deepEqual(admin.cloudinaryDeletes, ["u2/theirs"]);
});

test("public IDs are skipped when Cloudinary is not configured", async () => {
  const { env, cloudinaryDeletes } = stub();

  const res = await call(env, { urls: [], publicIds: ["u1/1763000000-abcd1234"] });

  assert.deepEqual(res.body, { deleted: 0, skipped: 1 });
  assert.deepEqual(cloudinaryDeletes, []);
});

test("invalid JSON and the wrong method are refused", async () => {
  const { env } = stub();

  assert.equal((await call(env, "not json")).status, 400);
  assert.equal((await call(env, { urls: [] }, { method: "GET" })).status, 405);
});
