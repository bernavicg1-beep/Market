/**
 * Tests for `POST /cloudinary-sign`, the endpoint the app calls before it
 * uploads a photo or a video straight to Cloudinary.
 *
 * The contract that matters: a signed-in user gets parameters that are signed
 * with a secret they never see, the preset and folder are the pinned product
 * values, and a Worker without credentials refuses instead of falling back to
 * an unsigned upload.
 *
 * Run with: npm test  (inside `worker/`)
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import worker from "../index.js";

const SECRET = "test-api-secret-do-not-leak";
const CLOUD = "camiguin-market";
const API_KEY = "123456789012345";
const TOKENS = { "user-token": "u1" };

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stub({ cloudinary = true } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("identitytoolkit.googleapis.com")) {
      const { idToken } = JSON.parse(init.body);
      const uid = TOKENS[idToken];
      return jsonResponse({ users: uid ? [{ localId: uid }] : [] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };

  const env = { FIREBASE_WEB_API_KEY: "test-web-api-key" };
  if (cloudinary) {
    env.CLOUDINARY_CLOUD_NAME = CLOUD;
    env.CLOUDINARY_API_KEY = API_KEY;
    env.CLOUDINARY_API_SECRET = SECRET;
  }
  return { env };
}

async function call(env, body, { token = "user-token", method = "POST", raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const payload =
    body === undefined ? undefined : raw ? String(body) : JSON.stringify(body);

  const response = await worker.fetch(
    new Request("https://worker.example/cloudinary-sign", {
      method,
      headers,
      body: method === "POST" ? payload : undefined,
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} },
  );

  return { status: response.status, body: await response.json() };
}

/** Recompute Cloudinary's signature independently of the Worker. */
function expectedSignature(params) {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHash("sha1").update(toSign + SECRET).digest("hex");
}

test("without an ID token nothing is signed", async () => {
  const { env } = stub();

  assert.deepEqual(await call(env, {}, { token: "" }), {
    status: 401,
    body: { error: "unauthorized" },
  });
  assert.equal((await call(env, {}, { token: "not-a-real-token" })).status, 401);
});

test("a signed-in user gets a Cloudinary-ready signature", async () => {
  const { env } = stub();

  const { status, body } = await call(env, {});

  assert.equal(status, 200);
  assert.equal(body.cloudName, CLOUD);
  assert.equal(body.apiKey, API_KEY);
  assert.equal(body.folder, "camiguin_market/products");
  assert.equal(body.uploadPreset, "camiguin_market_products");
  assert.equal(body.overwrite, false);
  assert.equal(body.resourceType, "image");
  assert.equal(body.uploadUrl, `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
  assert.match(body.signature, /^[0-9a-f]{40}$/);
  assert.ok(Number.isInteger(body.timestamp));

  // The app must be able to send exactly these values back to Cloudinary.
  assert.equal(
    body.signature,
    expectedSignature({
      folder: body.folder,
      overwrite: "false",
      public_id: body.publicId,
      timestamp: String(body.timestamp),
      upload_preset: body.uploadPreset,
    }),
  );
});

test("the public id is unique per call and lives under the caller's uid", async () => {
  const { env } = stub();

  const first = await call(env, {});
  const second = await call(env, {});

  assert.ok(first.body.publicId.startsWith("u1/"));
  assert.ok(second.body.publicId.startsWith("u1/"));
  assert.notEqual(first.body.publicId, second.body.publicId);
  assert.notEqual(first.body.signature, second.body.signature);
});

test("the API secret never appears in the response", async () => {
  const { env } = stub();

  const { body } = await call(env, {});

  const raw = JSON.stringify(body);
  assert.equal(raw.includes(SECRET), false);
  assert.equal("apiSecret" in body, false);
  assert.equal("signature_secret" in body, false);
});

test("a tampered secret produces a different signature", async () => {
  const { env } = stub();

  const { body } = await call(env, {});
  const signed = expectedSignature({
    folder: body.folder,
    overwrite: "false",
    public_id: body.publicId,
    timestamp: String(body.timestamp),
    upload_preset: body.uploadPreset,
  });
  const wrong = createHash("sha1")
    .update(`folder=${body.folder}&overwrite=false&public_id=${body.publicId}` +
      `&timestamp=${body.timestamp}&upload_preset=${body.uploadPreset}wrong-secret`)
    .digest("hex");

  assert.equal(body.signature, signed);
  assert.notEqual(body.signature, wrong);
});

test("missing credentials fail closed with 503, never unsigned", async () => {
  const { env } = stub({ cloudinary: false });

  assert.deepEqual(await call(env, {}), {
    status: 503,
    body: { error: "media_not_configured" },
  });

  // A partial configuration is not enough either.
  env.CLOUDINARY_CLOUD_NAME = CLOUD;
  env.CLOUDINARY_API_KEY = API_KEY;
  assert.equal((await call(env, {})).status, 503);
});

test("video uploads are signed against the video endpoint", async () => {
  const { env } = stub();

  const { status, body } = await call(env, { resourceType: "video" });

  assert.equal(status, 200);
  assert.equal(body.resourceType, "video");
  assert.equal(body.uploadUrl, `https://api.cloudinary.com/v1_1/${CLOUD}/video/upload`);
});

test("an unknown resource type and the wrong method are refused", async () => {
  const { env } = stub();

  assert.deepEqual(await call(env, { resourceType: "raw" }), {
    status: 400,
    body: { error: "unsupported_resource_type" },
  });
  assert.equal((await call(env, undefined, { method: "GET" })).status, 405);
  assert.deepEqual(await call(env, "{not json", { raw: true }), {
    status: 400,
    body: { error: "bad_json" },
  });
});
