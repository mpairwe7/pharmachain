import { type Browser, expect, type Page, test } from "@playwright/test";
import { ADMIN_PASSWORD, API_PATH, DEMO_PASSWORD as PASSWORD, signIn } from "./helpers";

/**
 * Phase 1 golden path against the seeded demo stack (see e2e/README.md):
 * buyer raises an RFQ → supplier quotes from the inbox → buyer accepts and an
 * order is created → seller advances shipment → buyer sees the new stage.
 *
 * Each persona gets its own browser context (isolated cookies), which mirrors
 * reality and avoids sign-out choreography.
 */
const BUYER_EMAIL = "ops@nilepharma.demo";
const SELLER_EMAIL = "ops@kampalafinechem.demo";

const RUN_TAG = `E2E-${Date.now().toString(36).toUpperCase()}`;
const RFQ_TITLE = `Ibuprofen BP (API) — 250 kg ${RUN_TAG}`;

/** Request a paid credit as the company admin, returning the request id. */
async function requestCredit(
  browser: Browser,
  email: string,
  kind: "RFQ" | "QUOTATION",
): Promise<string> {
  const page = await signIn(browser, email);
  const res = await page.request.post(`${API_PATH}/billing/credit-requests`, {
    data: { kind, count: 2 },
  });
  expect(res.ok(), `credit request (${kind}) for ${email}`).toBeTruthy();
  const body = await res.json();
  await page.context().close();
  return body.id as string;
}

test.describe
  .serial("Phase 1 golden path", () => {
    let rfqUrl: string;
    let orderUrl: string;

    test("credit top-up keeps the demo inside its freemium allowance (US-907)", async ({
      browser,
    }) => {
      // Each run consumes one RFQ and one quotation from the shared demo
      // companies' monthly freemium allowance, so repeated runs would dry it
      // up mid-month and fail at "Publish RFQ". Buying credits through the
      // real US-907 flow is both the fix and a live test of that flow:
      // company admin requests → PENDING_PAYMENT → super admin confirms →
      // the current month's limit rises immediately.
      const rfqCreditId = await requestCredit(browser, "admin@nilepharma.demo", "RFQ");
      const quoteCreditId = await requestCredit(browser, "admin@kampalafinechem.demo", "QUOTATION");

      const admin = await signIn(browser, "admin@pharmachain.local", ADMIN_PASSWORD);
      for (const id of [rfqCreditId, quoteCreditId]) {
        const res = await admin.request.post(`${API_PATH}/admin/credit-requests/${id}/decide`, {
          data: { decision: "CONFIRM" },
        });
        expect(res.ok(), `confirm credit request ${id}`).toBeTruthy();
      }
      await admin.context().close();
    });

    test("buyer signs in and raises an RFQ", async ({ browser }) => {
      const page = await signIn(browser, BUYER_EMAIL);

      await page.goto("/rfqs/new");
      await page.getByLabel("Product / material required").fill(RFQ_TITLE);
      await page.getByLabel("Quantity").fill("250");
      await page.getByLabel("Unit").fill("kg");
      const deadline = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await page.getByLabel("Response deadline").fill(deadline);
      await page.getByRole("button", { name: /publish rfq/i }).click();

      await expect(page).toHaveURL(/\/rfqs\/[0-9a-f-]{36}/, { timeout: 20_000 });
      await expect(page.getByText(RFQ_TITLE).first()).toBeVisible();
      rfqUrl = new URL(page.url()).pathname;
      await page.context().close();
    });

    test("supplier finds the RFQ in the quote inbox and quotes", async ({ browser }) => {
      const page = await signIn(browser, SELLER_EMAIL);

      await page.goto("/quotes");
      const row = page.getByRole("row", { name: new RegExp(RUN_TAG) });
      await expect(row).toBeVisible();
      await row.getByRole("link").first().click();

      await expect(page.getByText(/submit a quotation/i)).toBeVisible();
      await page.getByLabel(/unit price/i).fill("13.75");
      await page.getByRole("button", { name: /submit quotation/i }).click();
      await expect(page.getByText(/your quotation \(v1\)/i)).toBeVisible({ timeout: 20_000 });
      await page.context().close();
    });

    test("buyer accepts the quotation and an order is created", async ({ browser }) => {
      const page = await signIn(browser, BUYER_EMAIL);

      await page.goto(rfqUrl);
      await page.getByRole("button", { name: "Accept", exact: true }).click();
      await page.getByRole("button", { name: /accept & create order/i }).click();

      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/, { timeout: 20_000 });
      await expect(page.getByText(/order confirmed/i).first()).toBeVisible();
      orderUrl = new URL(page.url()).pathname;
      await page.context().close();
    });

    test("seller advances the shipment one stage", async ({ browser }) => {
      const page = await signIn(browser, SELLER_EMAIL);

      await page.goto(orderUrl);
      await page.getByRole("button", { name: /advance to pickup scheduled/i }).click();
      // Exact: the logistics panel adds a "Location note" input to this page, so
      // a substring match on "Note" is ambiguous.
      await page.getByLabel("Note", { exact: true }).fill("Pickup booked with forwarder (e2e)");
      await page.getByRole("button", { name: /update status/i }).click();
      await expect(page.getByText(/status updated to pickup scheduled/i)).toBeVisible({
        timeout: 20_000,
      });
      await page.context().close();
    });

    test("buyer sees the new shipment stage and history", async ({ browser }) => {
      const page = await signIn(browser, BUYER_EMAIL);

      await page.goto(orderUrl);
      await expect(page.getByText(/pickup scheduled/i).first()).toBeVisible();
      await expect(page.getByText(/pickup booked with forwarder \(e2e\)/i)).toBeVisible();
      await page.context().close();
    });
  });
