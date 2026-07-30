import fs from "node:fs";
import path from "node:path";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

/**
 * Shared e2e plumbing.
 *
 * The API is reachable by two different routes depending on how the stack is
 * running, and the specs need both:
 *
 *  - **API_PATH** — a same-origin path used from a signed-in browser context,
 *    so the Auth.js session cookie rides along. Deployed, the API is mounted
 *    inside this deployment at `/api/backend`. Running locally it is a separate
 *    server, reached through the web app's `/api/proxy` (which converts the
 *    cookie into the Bearer token the API expects).
 *
 *  - **apiOrigin()** — an absolute base for the few assertions that must reach
 *    the API *without* the web proxy in the way: helmet's security headers, the
 *    trusted-proxy IP rules and the raw JSON error envelope. The proxy forwards
 *    only `content-type`, so those headers never survive it.
 *
 * Defaults target a deployed stack, so nothing changes for existing CI usage.
 * For a local stack set:
 *   E2E_API_PATH=/api/proxy  E2E_API_ORIGIN=http://127.0.0.1:3001
 */
export const API_PATH = process.env.E2E_API_PATH ?? "/api/backend";

export function apiOrigin(baseURL: string | undefined): string {
  return process.env.E2E_API_ORIGIN ?? `${baseURL ?? ""}${API_PATH}`;
}

export const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "demo-Pass-1";
export const ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? "admin-ChangeMe-1";

export const ERROR_BOUNDARY = /Something went wrong loading this page/i;

/**
 * Signs in through the real login form once per role, then hands out fresh
 * contexts seeded with that session.
 *
 * The API throttles logins at 40 per 15 minutes per client IP — a real control
 * (regression.spec.ts asserts it). A suite that signed in for every describe
 * block tripped its own limiter and failed with unexplained login timeouts, so
 * the session is captured once and reused. Each caller still gets an isolated
 * context; only the credential round-trip is shared.
 */
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

// Cached on disk, not just in memory: Playwright restarts its worker process
// after a failure, which would drop an in-memory cache and start signing in
// again. Reused for less than the 30-minute session lifetime.
const SESSION_DIR = path.join(process.cwd(), "test-results", ".auth");
const SESSION_TTL_MS = 20 * 60 * 1000;

function sessionFile(email: string): string {
  return path.join(SESSION_DIR, `${email.replace(/[^a-z0-9]/gi, "_")}.json`);
}

function readCachedSession(email: string): StorageState | null {
  try {
    const file = sessionFile(email);
    if (Date.now() - fs.statSync(file).mtimeMs > SESSION_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as StorageState;
  } catch {
    return null;
  }
}

async function captureSession(
  browser: Browser,
  email: string,
  password: string,
): Promise<StorageState> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  const state = await ctx.storageState();
  await ctx.close();
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(sessionFile(email), JSON.stringify(state));
  return state;
}

export async function signIn(
  browser: Browser,
  email: string,
  password: string = DEMO_PASSWORD,
): Promise<Page> {
  const openWith = async (state: StorageState) =>
    (await browser.newContext({ storageState: state })).newPage();

  const cached = readCachedSession(email);
  if (cached) {
    const page = await openWith(cached);
    await page.goto("/dashboard");
    // A cached session can still be revoked (deactivation, sessionVersion
    // bump). If it bounced to /login, fall through to a real sign-in.
    if (/\/dashboard/.test(page.url())) return page;
    await page.context().close();
  }

  const page = await openWith(await captureSession(browser, email, password));
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  return page;
}

/** Signs in without touching the cache — for tests that need the login form
 *  itself, or a session created after some clock/state manipulation. */
export async function signInFresh(
  browser: Browser,
  email: string,
  password: string = DEMO_PASSWORD,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
  return page;
}

/** Navigate and assert: page loaded, no error boundary, expected content shown. */
export async function visit(page: Page, path: string, expected: RegExp | string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(ERROR_BOUNDARY)).toHaveCount(0);
  await expect(page.getByText(expected).first()).toBeVisible({ timeout: 15_000 });
}

/** First id from a list endpoint, or undefined when the list is empty. */
export async function firstId(page: Page, path: string, key = "id"): Promise<string | undefined> {
  const res = await page.request.get(`${API_PATH}${path}`);
  if (res.status() !== 200) return undefined;
  const body = await res.json();
  const arr = Array.isArray(body) ? body : (body.items ?? []);
  return arr[0]?.[key];
}
