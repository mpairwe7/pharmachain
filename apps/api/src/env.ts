import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  API_PORT: z.coerce.number().int().default(3001),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  APP_URL: z.url().default("http://localhost:3000"),
  JOBS_IN_PROCESS: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  // Object storage is Cloudflare R2. R2 exposes an S3-compatible API, which is
  // why the client is an S3 signer (aws4fetch) — but the service, endpoint and
  // credentials are R2's, and "auto" is R2's required region. Dev runs MinIO
  // through the same variables as a local stand-in.
  R2_ENDPOINT: z.url().default("http://localhost:9000"),
  R2_REGION: z.string().default("auto"),
  R2_BUCKET: z.string().default("pharmachain-documents"),
  R2_ACCESS_KEY_ID: z.string().default("minioadmin"),
  R2_SECRET_ACCESS_KEY: z.string().default("minioadmin"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Report which vars are wrong — never their values.
  const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  throw new Error(`Invalid API environment configuration: ${fields}`);
}

// Refuse to boot production on development defaults — a missing variable must
// be a deploy failure, not a silent fallback to minioadmin/localhost.
if (parsed.data.NODE_ENV === "production") {
  const problems: string[] = [];
  if (parsed.data.AUTH_SECRET.length < 32)
    problems.push("AUTH_SECRET (min 32 chars in production)");
  if (parsed.data.R2_ACCESS_KEY_ID === "minioadmin")
    problems.push("R2_ACCESS_KEY_ID (dev default)");
  if (parsed.data.R2_SECRET_ACCESS_KEY === "minioadmin") {
    problems.push("R2_SECRET_ACCESS_KEY (dev default)");
  }
  // An unset R2_ENDPOINT used to fall through to the MinIO default, which the
  // key checks above do not catch when real credentials are configured. The
  // result was an API that booted fine and handed the browser presigned URLs
  // pointing at http://localhost:9000 — uploads failed with a bare network
  // error and nothing in the logs. Refuse to boot instead.
  if (parsed.data.R2_ENDPOINT.startsWith("http://localhost")) {
    problems.push("R2_ENDPOINT (dev default)");
  }
  if (!parsed.data.R2_ENDPOINT.startsWith("https://")) {
    problems.push("R2_ENDPOINT (must be https in production)");
  }
  if (parsed.data.APP_URL.startsWith("http://localhost")) problems.push("APP_URL (dev default)");
  if (problems.length > 0) {
    throw new Error(`Production environment uses development defaults: ${problems.join(", ")}`);
  }
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((o) => o.trim()),
};
