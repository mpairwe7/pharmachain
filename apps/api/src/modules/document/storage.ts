import { AwsClient } from "aws4fetch";
import { env } from "../../env";

// aws4fetch signs with WebCrypto — tiny and Bun-native. Path-style URLs work
// for MinIO, Cloudflare R2 and AWS S3 alike.
const client = new AwsClient({
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  region: env.S3_REGION,
  service: "s3",
});

const GET_EXPIRES_SECONDS = 120;

export function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 120);
}

export function buildStorageKey(companyId: string, fileName: string): string {
  // Non-guessable, non-sequential keys (US-503)
  return `${companyId}/${crypto.randomUUID()}/${sanitizeFileName(fileName)}`;
}

function objectUrl(key: string): URL {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`${env.S3_ENDPOINT}/${env.S3_BUCKET}/${encoded}`);
}

const STORAGE_OP_TIMEOUT_MS = 10_000;

/**
 * Writes an object server-side — user uploads (via PUT :id/content) and
 * platform-generated files (invoice PDFs) both land here. Uploads are
 * deliberately not presigned to the browser: that requires a CORS rule on the
 * bucket and a publicly reachable endpoint, and fails with an opaque network
 * error when either is missing.
 */
export async function putObject(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const res = await client.fetch(objectUrl(key).toString(), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    // Copy into a fresh ArrayBuffer: BodyInit rejects Uint8Array<ArrayBufferLike>
    body: bytes.slice().buffer as ArrayBuffer,
    signal: AbortSignal.timeout(STORAGE_OP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`putObject failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

/**
 * Server-side existence/size/type check for a presigned upload. A presigned
 * PUT cannot enforce the declared size, so completeUpload verifies what
 * actually landed before the document becomes visible.
 */
export async function statObject(
  key: string,
): Promise<{ size: number; contentType: string | null } | null> {
  const res = await client.fetch(objectUrl(key).toString(), {
    method: "HEAD",
    signal: AbortSignal.timeout(STORAGE_OP_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`storage HEAD responded ${res.status}`);
  return {
    size: Number(res.headers.get("content-length") ?? "0"),
    contentType: res.headers.get("content-type"),
  };
}

/** Removes an object (idempotent — a missing key is not an error). */
export async function deleteObject(key: string): Promise<void> {
  const res = await client.fetch(objectUrl(key).toString(), {
    method: "DELETE",
    signal: AbortSignal.timeout(STORAGE_OP_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`storage DELETE responded ${res.status}`);
  }
}

export async function presignDownload(
  key: string,
  fileName: string,
): Promise<{ url: string; expiresIn: number }> {
  const url = objectUrl(key);
  url.searchParams.set("X-Amz-Expires", String(GET_EXPIRES_SECONDS));
  url.searchParams.set(
    "response-content-disposition",
    `attachment; filename="${sanitizeFileName(fileName)}"`,
  );
  const signed = await client.sign(new Request(url, { method: "GET" }), {
    aws: { signQuery: true },
  });
  return { url: signed.url, expiresIn: GET_EXPIRES_SECONDS };
}
