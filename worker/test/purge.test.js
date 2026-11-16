/**
 * Tests for the scheduled purge: expired perishable listings are hidden, their
 * media is removed (Cloudinary by public ID, R2 for older photos), and only
 * then is the Firestore document deleted.
 *
 * Everything runs against a stubbed Firestore/R2/Cloudinary, so no credentials
 * and no emulator are needed. Run with: npm test  (inside `worker/`)
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import worker from "../index.js";

const PROJECT = "demo-camiguin";
const PHOTO = "https://worker.example/i";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" });

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** One `listings` document as the REST API returns it. */
function firestoreDoc({
  id,
  isPerishable = true,
  expiresAt,
  photos = [],
  cloudinaryPublicIds = [],
  cloudinaryVideoPublicIds = [],
  cleanupAttempts = 0,
}) {
  const fields = {
    isPerishable: { booleanValue: isPerishable },
    expiresAt: { integerValue: String(expiresAt) },
    imageUrl: { stringValue: photos[0] || "" },
    imageUrls: { arrayValue: { values: photos.map((url) => ({ stringValue: url })) } },
    cloudinaryPublicIds: {
      arrayValue: { values: cloudinaryPublicIds.map((id) => ({ stringValue: id })) },
    },
    cloudinaryVideoPublicIds: {
      arrayValue: { values: cloudinaryVideoPublicIds.map((id) => ({ stringValue: id })) },
    },
    cleanupAttempts: { integerValue: String(cleanupAttempts) },
  };
  return {
    document: {
      name: `projects/${PROJECT}/databases/(default)/documents/listings/${id}`,
      fields,
    },
  };
}

const now = Date.now();
const expired = (id, photos = [], cloudinaryPublicIds = []) =>
  firestoreDoc({ id, expiresAt: now - 60_000, photos, cloudinaryPublicIds });

/**
 * Stub the Google + Cloudinary endpoints. `pages` is what each `runQuery`
 * call returns; `failDeletes` lists document ids whose DELETE answers 500;
 * `failPhotoKeys` lists R2 keys whose delete throws; `failCloudinary` lists
 * public IDs Cloudinary refuses to delete.
 */
function stub({
  pages = [],
  failDeletes = [],
  failPhotoKeys = [],
  failCloudinary = [],
  serviceAccount = true,
  cloudinary = false,
} = {}) {
  const deletedDocs = [];
  const deletedPhotos = [];
  const patches = [];
  const cloudinaryDeletes = [];
  const events = [];
  const calls = { runQuery: 0, queries: [] };

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);

    if (href.includes("oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "stub-access-token", expires_in: 3600 });
    }

    if (href.includes(":runQuery")) {
      const query = JSON.parse(init.body);
      calls.queries.push(query);
      const page = pages[calls.runQuery] || [];
      calls.runQuery += 1;
      return jsonResponse(page);
    }

    if (init.method === "PATCH" && href.includes("/documents/listings/")) {
      const id = href.split("/documents/listings/")[1].split("?")[0];
      patches.push({ id, fields: JSON.parse(init.body).fields, mask: href.split("?")[1] });
      events.push(`patch:${id}`);
      return jsonResponse({ name: `listings/${id}` });
    }

    if (init.method === "DELETE" && href.includes("/documents/listings/")) {
      const id = href.split("/documents/listings/")[1];
      deletedDocs.push(id);
      events.push(`delete:${id}`);
      return new Response("", { status: failDeletes.includes(id) ? 500 : 200 });
    }

    if (href.includes("api.cloudinary.com")) {
      const raw = href.split("public_ids=")[1] || "";
      const ids = decodeURIComponent(raw).split(",").filter(Boolean);
      cloudinaryDeletes.push(...ids);
      for (const id of ids) events.push(`cloud:${id}`);
      if (ids.some((id) => failCloudinary.includes(id))) {
        return new Response('{"error":{"message":"delete failed"}}', { status: 400 });
      }
      return jsonResponse({
        deleted: Object.fromEntries(ids.map((id) => [id, "deleted"])),
      });
    }

    throw new Error(`unexpected fetch: ${href}`);
  };

  const env = {
    IMAGES: {
      async delete(key) {
        deletedPhotos.push(key);
        if (failPhotoKeys.includes(key)) throw new Error("R2 unavailable");
      },
    },
  };

  if (serviceAccount) {
    env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
      project_id: PROJECT,
      client_email: "worker@demo-camiguin.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY,
    });
  }

  if (cloudinary) {
    env.CLOUDINARY_CLOUD_NAME = "camiguin-market";
    env.CLOUDINARY_API_KEY = "123456789012345";
    env.CLOUDINARY_API_SECRET = "purge-test-secret";
  }

  return { env, deletedDocs, deletedPhotos, patches, cloudinaryDeletes, events, calls };
}

/** Run the cron handler and wait for the work it scheduled. */
function runScheduled(env) {
  return new Promise((resolve, reject) => {
    worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now() },
      env,
      { waitUntil: (promise) => promise.then(resolve, reject), passThroughOnException() {} },
    );
  });
}

test("without the service account nothing is touched", async () => {
  const { env, deletedDocs, deletedPhotos, patches, calls } = stub({
    serviceAccount: false,
  });

  await runScheduled(env);

  assert.deepEqual(deletedDocs, []);
  assert.deepEqual(deletedPhotos, []);
  assert.deepEqual(patches, []);
  assert.equal(calls.runQuery, 0);
});

test("deletes expired perishable listings and their photos", async () => {
  const { env, deletedDocs, deletedPhotos, calls } = stub({
    pages: [
      [
        expired("fish", [`${PHOTO}/listing_images/u1/fish.jpg`, `${PHOTO}/listing_images/u1/fish-2.jpg`]),
        expired("fruit", [`${PHOTO}/listing_images/u2/fruit%20bowl.jpg`]),
        // Still fresh: must stay.
        firestoreDoc({ id: "fresh", expiresAt: now + 3_600_000, photos: [`${PHOTO}/listing_images/u3/fresh.jpg`] }),
        // No expiration at all (non-perishable): must stay.
        firestoreDoc({ id: "durable", isPerishable: false, expiresAt: 0, photos: [`${PHOTO}/listing_images/u4/durable.jpg`] }),
      ],
    ],
  });

  await runScheduled(env);

  assert.deepEqual(deletedDocs, ["fish", "fruit"]);
  assert.deepEqual(deletedPhotos, [
    "listing_images/u1/fish.jpg",
    "listing_images/u1/fish-2.jpg",
    "listing_images/u2/fruit bowl.jpg",
  ]);
  assert.equal(calls.runQuery, 1);
});

test("the query only selects a past expiration range", async () => {
  const { env, calls } = stub({ pages: [[]] });

  await runScheduled(env);

  const filters = calls.queries[0].structuredQuery.where.compositeFilter.filters;
  assert.deepEqual(
    filters.map((f) => [f.fieldFilter.field.fieldPath, f.fieldFilter.op]),
    [
      ["expiresAt", "GREATER_THAN"],
      ["expiresAt", "LESS_THAN_OR_EQUAL"],
    ],
  );
  assert.equal(filters[0].fieldFilter.value.integerValue, "0");
  assert.ok(Number(filters[1].fieldFilter.value.integerValue) >= now);
});

test("a listing without an expiration is never selected or deleted", async () => {
  const { env, deletedDocs, patches, calls } = stub({
    pages: [
      [firestoreDoc({ id: "durable", isPerishable: false, expiresAt: 0 })],
    ],
  });

  await runScheduled(env);

  assert.equal(calls.runQuery, 1);
  assert.deepEqual(deletedDocs, []);
  assert.deepEqual(patches, []);
});

test("photo URLs are deduplicated and only listing_images keys are removed", async () => {
  const { env, deletedPhotos } = stub({
    pages: [
      [
        firestoreDoc({
          id: "dup",
          expiresAt: now - 1_000,
          photos: [
            `${PHOTO}/listing_images/u1/same.jpg`,
            `${PHOTO}/listing_images/u1/same.jpg`,
            "https://elsewhere.example/not-r2.jpg",
            "https://worker.example/i/other_folder/keep.jpg",
          ],
        }),
      ],
    ],
  });

  await runScheduled(env);

  assert.deepEqual(deletedPhotos, ["listing_images/u1/same.jpg"]);
});

test("Cloudinary assets are deleted by public ID before the document", async () => {
  const { env, deletedDocs, cloudinaryDeletes, events, patches } = stub({
    cloudinary: true,
    pages: [
      [
        expired("food", [], ["u1/food-photo-1", "u1/food-photo-2"]),
      ],
    ],
  });

  await runScheduled(env);

  assert.deepEqual(cloudinaryDeletes, ["u1/food-photo-1", "u1/food-photo-2"]);
  assert.deepEqual(deletedDocs, ["food"]);

  // The document is hidden first, then its media goes, then the document goes.
  const hide = events.indexOf("patch:food");
  const media = events.indexOf("cloud:u1/food-photo-1");
  const docDelete = events.indexOf("delete:food");
  assert.ok(hide >= 0 && media > hide && docDelete > media);

  assert.equal(
    patches[0].fields.cleanupState.stringValue,
    "purging",
    "the listing is hidden while its media is being removed",
  );
});

test("a failed Cloudinary delete keeps the document and records the failure", async () => {
  const { env, deletedDocs, patches } = stub({
    cloudinary: true,
    pages: [[expired("stuck", [], ["u1/stuck-1"])]],
    failCloudinary: ["u1/stuck-1"],
  });

  await runScheduled(env);

  // The document survives so the next run can retry the media.
  assert.deepEqual(deletedDocs, []);
  const failed = patches.find(
    (p) => p.fields.cleanupState?.stringValue === "media_failed",
  );
  assert.ok(failed, "cleanupState is set to media_failed");
  assert.equal(failed.fields.cleanupAttempts.integerValue, "1");
});

test("a failed retry increments the attempt counter", async () => {
  const { env, patches } = stub({
    cloudinary: true,
    pages: [
      [firestoreDoc({
        id: "again",
        expiresAt: now - 60_000,
        cloudinaryPublicIds: ["u1/again-1"],
        cleanupAttempts: 2,
      })],
    ],
    failCloudinary: ["u1/again-1"],
  });

  await runScheduled(env);

  const failed = patches.find(
    (p) => p.fields.cleanupState?.stringValue === "media_failed",
  );
  assert.equal(failed.fields.cleanupAttempts.integerValue, "3");
});

test("a failed document delete happens only after its media is gone", async () => {
  const { env, deletedDocs, deletedPhotos } = stub({
    pages: [
      [
        expired("stuck", [`${PHOTO}/listing_images/u1/stuck.jpg`]),
        expired("gone", [`${PHOTO}/listing_images/u2/gone.jpg`]),
      ],
    ],
    failDeletes: ["stuck"],
  });

  await runScheduled(env);

  // Both were attempted, and both lost their media: media is never kept for a
  // listing whose document delete failed.
  assert.deepEqual(deletedDocs.sort(), ["gone", "stuck"]);
  assert.deepEqual(deletedPhotos.sort(), [
    "listing_images/u1/stuck.jpg",
    "listing_images/u2/gone.jpg",
  ]);
});

test("a failing R2 delete keeps that listing for the next run", async () => {
  const { env, deletedDocs, deletedPhotos, patches } = stub({
    pages: [
      [expired("a", [`${PHOTO}/listing_images/u1/a.jpg`, `${PHOTO}/listing_images/u1/b.jpg`])],
    ],
    failPhotoKeys: ["listing_images/u1/a.jpg"],
  });

  await runScheduled(env);

  assert.deepEqual(deletedDocs, []);
  assert.equal(deletedPhotos.length, 2);
  assert.ok(
    patches.some((p) => p.fields.cleanupState?.stringValue === "media_failed"),
    "the partial failure is recorded so it is retried",
  );
});

test("nothing deletable means one query and no deletes", async () => {
  const { env, deletedDocs, calls } = stub({
    pages: [[firestoreDoc({ id: "fresh", expiresAt: now + 10_000 })]],
  });

  await runScheduled(env);

  assert.equal(calls.runQuery, 1);
  assert.deepEqual(deletedDocs, []);
});

test("a run that cannot delete anything stops after one batch", async () => {
  const { env, deletedDocs, calls } = stub({
    pages: [[expired("x"), expired("y")]],
    failDeletes: ["x", "y"],
  });

  await runScheduled(env);

  assert.equal(calls.runQuery, 1);
  assert.deepEqual(deletedDocs.sort(), ["x", "y"]);
});

test("a full batch is followed by another query until the backlog is empty", async () => {
  // The Worker fetches 200 documents at a time.
  const bigPage = Array.from({ length: 200 }, (_, i) => expired(`bulk${i}`));
  const { env, deletedDocs, calls } = stub({
    pages: [bigPage, [expired("tail1"), expired("tail2")], []],
  });

  await runScheduled(env);

  assert.equal(calls.runQuery, 2);
  assert.equal(deletedDocs.length, 202);
});

test("a spare page after a short batch is not fetched", async () => {
  const { env, calls } = stub({ pages: [[expired("only")], []] });

  await runScheduled(env);

  assert.equal(calls.runQuery, 1);
});
