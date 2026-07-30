import { type APIResponse, expect, type Page, test } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  API_PATH,
  apiOrigin,
  firstId,
  DEMO_PASSWORD as PASSWORD,
  signIn,
} from "./helpers";

/**
 * Endpoint coverage against the deployed app: sign in per role through the UI
 * (real Auth.js session cookie), then exercise every API GET plus
 * negative auth / RBAC / validation paths. Read-only — the mutation lifecycle
 * is covered by golden-path.spec.ts.
 */

async function ok(page: Page, path: string): Promise<APIResponse> {
  const res = await page.request.get(`${API_PATH}${path}`);
  expect(res.status(), `GET ${path}`).toBe(200);
  return res;
}

test.describe
  .serial("Deployed API — company user (buyer, OPERATIONS)", () => {
    let page: Page;
    test.beforeAll(async ({ browser }) => {
      page = await signIn(browser, "ops@nilepharma.demo", PASSWORD);
    });
    test.afterAll(async () => page?.context().close());

    test("identity + dashboard", async () => {
      const me = await (await ok(page, "/auth/me")).json();
      expect(me.email).toBe("ops@nilepharma.demo");
      expect(me.membership?.companyName).toBe("Nile Pharma Industries");
      const dash = await (await ok(page, "/dashboard/summary")).json();
      expect(dash.scope).toBe("company");
    });

    test("catalogue + marketplace", async () => {
      await ok(page, "/catalogue");
      await ok(page, "/catalogue/categories");
      await ok(page, "/catalogue/exchange-rates");
      const search = await (await ok(page, "/catalogue/search?page=1")).json();
      expect(search).toHaveProperty("items");
      expect(search).toHaveProperty("totalPages");
    });

    test("rfqs + quote inbox (paginated)", async () => {
      const rfqs = await (await ok(page, "/rfqs?page=1")).json();
      expect(rfqs).toHaveProperty("items");
      await ok(page, "/rfqs/inbox?page=1");
      const id = await firstId(page, "/rfqs?page=1");
      if (id) {
        await ok(page, `/rfqs/${id}`);
        await ok(page, `/rfqs/${id}/quotations`);
      }
    });

    test("orders + shipment documents", async () => {
      const orders = await (await ok(page, "/orders?page=1")).json();
      expect(orders).toHaveProperty("items");
      const id = orders.items?.[0]?.id;
      if (id) {
        await ok(page, `/orders/${id}`);
        await ok(page, `/orders/${id}/documents`);
      }
    });

    test("company workspace (OPERATIONS scope)", async () => {
      await ok(page, "/companies/me");
      await ok(page, "/companies/me/usage");
      await ok(page, "/companies/me/verification");
      // RBAC: member management is COMPANY_ADMIN-only (members:manage)
      for (const path of ["/companies/me/members", "/companies/me/invites"]) {
        const res = await page.request.get(`${API_PATH}${path}`);
        expect(res.status(), `OPERATIONS denied ${path}`).toBe(403);
      }
    });

    test("documents + boms + messaging + notifications + billing", async () => {
      await ok(page, "/documents");
      await ok(page, "/threads");
      await ok(page, "/notifications?page=1");
      await ok(page, "/notifications/unread-count");
      await ok(page, "/notifications/preferences");
      await ok(page, "/billing/credit-requests");
      await ok(page, "/announcements/active");
      const threadId = await firstId(page, "/threads");
      if (threadId) await ok(page, `/threads/${threadId}/messages`);
      // /boms is scoped to a product listing the company owns.
      const mine = await (await ok(page, "/catalogue")).json();
      const product = (Array.isArray(mine) ? mine : (mine.items ?? [])).find(
        (l: { kind: string }) => l.kind === "FINISHED_PRODUCT",
      );
      if (product) await ok(page, `/boms?productListingId=${product.id}`);
    });

    test("RBAC: company user is denied admin endpoints", async () => {
      for (const path of ["/admin/stats", "/admin/companies", "/admin/audit-logs"]) {
        const res = await page.request.get(`${API_PATH}${path}`);
        expect([401, 403], `admin guard on ${path}`).toContain(res.status());
      }
    });
  });

test.describe
  .serial("Deployed API — company admin (members:manage)", () => {
    let page: Page;
    test.beforeAll(async ({ browser }) => {
      page = await signIn(browser, "admin@nilepharma.demo", PASSWORD);
    });
    test.afterAll(async () => page?.context().close());

    test("member + invite management endpoints", async () => {
      await ok(page, "/companies/me/members");
      await ok(page, "/companies/me/invites");
    });
  });

test.describe
  .serial("Deployed API — super admin", () => {
    let page: Page;
    test.beforeAll(async ({ browser }) => {
      page = await signIn(browser, "admin@pharmachain.local", ADMIN_PASSWORD);
    });
    test.afterAll(async () => page?.context().close());

    test("platform admin endpoints", async () => {
      const me = await (await ok(page, "/auth/me")).json();
      expect(me.isSuperAdmin).toBe(true);
      const stats = await (await ok(page, "/admin/stats")).json();
      expect(stats).toHaveProperty("totalCompanies");
      await ok(page, "/admin/companies");
      await ok(page, "/admin/credit-requests");
      await ok(page, "/admin/data-deletion-requests");
      await ok(page, "/admin/announcements");
      await ok(page, "/admin/parameters");
      await ok(page, "/admin/exchange-rates");
      await ok(page, "/admin/login-activity");
      await ok(page, "/admin/audit-logs");
      const companyId = await firstId(page, "/admin/companies");
      if (companyId) await ok(page, `/admin/companies/${companyId}`);
    });
  });

test.describe("Deployed API — negative paths (no auth)", () => {
  test("protected endpoints reject anonymous callers with the error envelope", async ({
    request,
    baseURL,
  }) => {
    for (const path of ["/auth/me", "/rfqs", "/orders", "/admin/stats", "/dashboard/summary"]) {
      const res = await request.get(`${apiOrigin(baseURL)}${path}`);
      expect(res.status(), `anon ${path}`).toBe(401);
      const body = await res.json();
      expect(body.error?.code).toBe("UNAUTHORIZED");
    }
  });

  test("validation error envelope on malformed login", async ({ request, baseURL }) => {
    const res = await request.post(`${apiOrigin(baseURL)}/auth/login`, {
      data: { email: "not-an-email" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error?.code).toBe("VALIDATION_ERROR");
  });

  test("bad credentials are rejected without leaking which factor", async ({
    request,
    baseURL,
  }) => {
    const res = await request.post(`${apiOrigin(baseURL)}/auth/login`, {
      headers: { "x-client-ip": "203.0.113.77" },
      data: { email: "ops@nilepharma.demo", password: "wrong-password" },
    });
    expect(res.status()).toBe(401);
  });

  test("health + readiness are public", async ({ request, baseURL }) => {
    expect((await request.get(`${apiOrigin(baseURL)}/health`)).status()).toBe(200);
    expect((await request.get(`${apiOrigin(baseURL)}/health/ready`)).status()).toBe(200);
  });
});
