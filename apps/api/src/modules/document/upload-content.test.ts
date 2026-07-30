import { beforeAll, describe, expect, test } from "bun:test";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { MAX_FILE_SIZE_BYTES } from "@pharmachain/core";

/**
 * PUT /documents/:id/content carries a raw file body. Fastify parses only JSON
 * and urlencoded by default and answers 415 for anything else, so the route is
 * only reachable because bootstrap.ts registers a binary content-type parser.
 * These tests pin that wiring — a 415 here means every upload is broken.
 *
 * Fastify runs content-type parsing before the route handler, so the auth guard
 * rejecting with 401 is proof the body was parsed: an unparseable type never
 * gets that far.
 */

const DOC_ID = "00000000-0000-4000-8000-000000000000";
const PATH = `/documents/${DOC_ID}/content`;

let app: NestFastifyApplication;

beforeAll(async () => {
  // bun test sets NODE_ENV=test, so the production-defaults guard in env.ts
  // stays out of the way and no real storage or database is touched.
  process.env.DATABASE_URL ??= "postgresql://localhost:5432/pharmachain";
  process.env.AUTH_SECRET ??= "test-secret-at-least-16-chars";
  process.env.JOBS_IN_PROCESS = "false";
  const { createApp } = await import("../../bootstrap");
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

describe("upload content route", () => {
  test.each([
    ["application/pdf", "%PDF-1.4 test"],
    ["image/jpeg", "\xff\xd8\xff test"],
    ["image/png", "\x89PNG test"],
  ])("accepts a %s body (parsed, then 401 at the guard)", async (contentType, body) => {
    const res = await app.inject({
      method: "PUT",
      url: PATH,
      headers: { "content-type": contentType },
      payload: Buffer.from(body, "binary"),
    });
    expect(res.statusCode).not.toBe(415);
    expect(res.statusCode).toBe(401);
  });

  test("still rejects a content type no document kind allows", async () => {
    // The parser list is bounded by ALLOWED_MIMES — it is not a catch-all.
    const res = await app.inject({
      method: "PUT",
      url: PATH,
      headers: { "content-type": "application/x-msdownload" },
      payload: Buffer.from("MZ executable"),
    });
    expect(res.statusCode).toBe(415);
  });

  test("rejects a body over the file-size limit before the handler runs", async () => {
    const res = await app.inject({
      method: "PUT",
      url: PATH,
      headers: { "content-type": "application/pdf" },
      payload: Buffer.alloc(MAX_FILE_SIZE_BYTES + 2048),
    });
    expect(res.statusCode).toBe(413);
  });

  test("a file-sized body is within the raised limit", async () => {
    // Fastify's default 1MB limit would 413 this; the upload parser raises it.
    const res = await app.inject({
      method: "PUT",
      url: PATH,
      headers: { "content-type": "application/pdf" },
      payload: Buffer.alloc(8 * 1024 * 1024),
    });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(401);
  });

  test("JSON bodies keep the default 1MB cap", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/documents/request-upload",
      headers: { "content-type": "application/json" },
      payload: Buffer.concat([
        Buffer.from('{"pad":"'),
        Buffer.alloc(1024 * 1024 + 512, 0x61),
        Buffer.from('"}'),
      ]),
    });
    expect(res.statusCode).toBe(413);
  });
});
