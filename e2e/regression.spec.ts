import { expect, test } from "@playwright/test";
import { apiOrigin } from "./helpers";

/** Behavioral regression against the deployed app: hardening properties that
 *  must not silently regress (security headers, throttling, error envelopes,
 *  no server/tech fingerprint). */

test("security headers from helmet are present on API responses", async ({ request, baseURL }) => {
  const res = await request.get(`${apiOrigin(baseURL)}/health`);
  const h = res.headers();
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]?.toLowerCase()).toBe("sameorigin");
  expect(h).toHaveProperty("x-request-id");
});

test("web app does not leak the x-powered-by fingerprint", async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/login`);
  expect(res.headers()["x-powered-by"]).toBeUndefined();
});

// The API honours x-client-ip only from the web tier, which proves itself
// with x-proxy-secret (the deployment's AUTH_SECRET). With the secret the
// suite can pin fresh client IPs the way real browser traffic gets them.
const PROXY_SECRET = process.env.E2E_PROXY_SECRET ?? process.env.AUTH_SECRET ?? "";

test("OTP request is throttled per client IP (10 / 15 min)", async ({ request, baseURL }) => {
  test.skip(!PROXY_SECRET, "set E2E_PROXY_SECRET (deployment AUTH_SECRET) to pin client IPs");
  const ip = `198.51.100.${Math.floor(Date.now() % 200) + 1}`;
  const codes: number[] = [];
  for (let i = 0; i < 13; i++) {
    const res = await request.post(`${apiOrigin(baseURL)}/auth/otp/request`, {
      headers: { "x-client-ip": ip, "x-proxy-secret": PROXY_SECRET },
      data: { email: "throttle-probe@example.com" },
    });
    codes.push(res.status());
  }
  // A fresh bucket: first requests succeed, then the limiter returns 429 —
  // and the 429 must hold across serverless instances (shared storage).
  expect(codes.filter((c) => c === 200).length).toBeGreaterThan(0);
  expect(codes).toContain(429);
});

test("x-client-ip spoofing cannot rotate rate-limit buckets", async ({ request, baseURL }) => {
  // Without the proxy secret the header must be ignored: 13 requests wearing
  // 13 different fake IPs all land in the caller's real bucket and trip the
  // 10/15-min limit. (If the header were trusted, every request would get its
  // own bucket and all 13 would return 200.)
  const codes: number[] = [];
  for (let i = 0; i < 13; i++) {
    const res = await request.post(`${apiOrigin(baseURL)}/auth/otp/request`, {
      headers: { "x-client-ip": `203.0.113.${i + 1}` },
      data: { email: "spoof-probe@example.com" },
    });
    codes.push(res.status());
  }
  expect(codes).toContain(429);
});

test("unknown route returns the JSON error envelope, not an HTML stack", async ({
  request,
  baseURL,
}) => {
  const res = await request.get(`${apiOrigin(baseURL)}/does-not-exist`);
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body).toHaveProperty("error");
  expect(body.error).toHaveProperty("code");
});

test("account enumeration is not possible on OTP request", async ({ request, baseURL }) => {
  // The security property is indistinguishability: a known and an unknown
  // account must produce identical responses — whether the bucket is fresh
  // (both 200) or hot from the throttle tests above (both 429).
  const headers = PROXY_SECRET
    ? { "x-client-ip": "198.51.100.240", "x-proxy-secret": PROXY_SECRET }
    : {};
  const unknown = await request.post(`${apiOrigin(baseURL)}/auth/otp/request`, {
    headers,
    data: { email: "definitely-not-a-user@example.com" },
  });
  const known = await request.post(`${apiOrigin(baseURL)}/auth/otp/request`, {
    headers,
    data: { email: "ops@nilepharma.demo" },
  });
  expect(unknown.status()).toBe(known.status());
  expect(await unknown.text()).toBe(await known.text());
});
