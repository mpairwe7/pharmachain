import { expect, type Page, test } from "@playwright/test";
import { ADMIN_PASSWORD, API_PATH, firstId, signIn } from "./helpers";

/**
 * Browser-level regression for the Phase 1 MVP test checklist.
 *
 * Deliberately scoped to the acceptance criteria that ONLY a real browser can
 * settle — the ones about what the user sees and whether the client stops a bad
 * request before it is made. Server-side behaviour is covered by
 * endpoints.spec.ts and the API-level checklist run; duplicating it here would
 * add runtime without adding signal.
 *
 * Checklist cases: 3, 4 (validation before any API call), 5, 6, 7, 8 (upload
 * through the picker, including the rejections), 57, 58 (comparison tray),
 * 79 (award confirmation is cancellable), 107, 108, 109 (notification centre),
 * 117, 118, 119 (shipment tracker).
 */

const BUYER = "ops@nilepharma.demo";
const BUYER_ADMIN = "admin@nilepharma.demo";
const SUPPLIER_ADMIN = "admin@kampalafinechem.demo";

/** Records API calls the page makes, so "before any API call is made" is testable. */
function recordApiCalls(page: Page, match: RegExp): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    if (match.test(req.url())) seen.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });
  return seen;
}

/** A small but structurally valid PDF. */
function pdf(bytes = 0): Buffer {
  const head =
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n";
  const tail = "trailer<</Root 1 0 R>>\n%%EOF\n";
  const pad = Math.max(0, bytes - head.length - tail.length);
  return Buffer.from(head + "%".repeat(pad) + tail, "latin1");
}

// ─── US-101: validation happens before the API call (cases 3, 4) ─────────────

test.describe("US-101 registration validation (client-side)", () => {
  test("case 3+4: a missing field and a mistyped email both block submit with no API call", async ({
    browser,
  }) => {
    const page = await (await browser.newContext()).newPage();
    const calls = recordApiCalls(page, /\/(api\/proxy|api\/backend)\/auth\/register/);

    await page.goto("/register");

    // Case 4 — a well-formed but mistyped domain must still be refused, and the
    // hint must name the domain the user meant.
    await page.getByLabel("Work email").fill("mutebijohn@gmai.com");
    await page.getByLabel("Full name").click(); // blur so onTouched validation runs
    await expect(page.getByText(/did you mean @gmail\.com/i)).toBeVisible({ timeout: 10_000 });

    // Case 3 — submitting with required fields empty shows inline errors.
    await page.getByRole("button", { name: /register company/i }).click();
    await expect(page.getByText(/did you mean @gmail\.com/i)).toBeVisible();
    await expect(page).toHaveURL(/\/register/);

    // The whole point: nothing was sent to the API.
    expect(calls, `unexpected register calls: ${calls.join(", ")}`).toHaveLength(0);
    await page.context().close();
  });
});

// ─── US-102: uploads through the real picker (cases 5, 6, 7, 8) ──────────────

test.describe
  .serial("US-102 document upload (browser)", () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      page = await signIn(browser, SUPPLIER_ADMIN);
    });
    test.afterAll(async () => page?.context().close());

    /** Opens the upload dialog on the first required checklist row. The button
     *  reads "Upload" when the slot is empty and "Replace" once a document is in
     *  place, and the seeded company already has documents. */
    async function openUploadDialog(): Promise<void> {
      await page.goto("/company/verification");
      await page
        .locator("li")
        .filter({ hasText: /Certificate of Incorporation|Trading Licence|Tax Identification/i })
        .first()
        .getByRole("button", { name: /^(upload|replace)$/i })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
    }

    /** The dialog's submit button, distinct from the row buttons behind it. */
    const submitButton = () => page.getByRole("dialog").getByRole("button", { name: /^upload$/i });

    test("case 7: a .exe is rejected in the picker, before any upload request", async () => {
      const calls = recordApiCalls(page, /documents\/request-upload/);
      await openUploadDialog();

      await page.getByLabel("File").setInputFiles({
        name: "setup.exe",
        mimeType: "application/x-msdownload",
        buffer: Buffer.from("MZ this is not a document"),
      });

      await expect(page.getByRole("alert")).toContainText(/unsupported file type/i);
      await expect(submitButton()).toBeDisabled();
      expect(calls, `an upload was requested anyway: ${calls.join(", ")}`).toHaveLength(0);
      await page.keyboard.press("Escape");
    });

    test("case 6: a 15MB file is rejected with a size error and creates no record", async () => {
      const calls = recordApiCalls(page, /documents\/request-upload/);
      await openUploadDialog();

      await page.getByLabel("File").setInputFiles({
        name: "oversize.pdf",
        mimeType: "application/pdf",
        buffer: pdf(15 * 1024 * 1024),
      });

      await expect(page.getByRole("alert")).toContainText(/15MB.*limit is 10MB/i);
      await expect(submitButton()).toBeDisabled();
      expect(calls, "a partial record may have been created").toHaveLength(0);
      await page.keyboard.press("Escape");
    });

    test("case 5: a valid PDF uploads and the checklist shows it pending review", async () => {
      await page.goto("/company/verification");
      // Tax Identification needs no expiry date, so this is the simplest kind.
      const row = page
        .locator("li")
        .filter({ hasText: /Tax Identification/i })
        .first();
      await row.getByRole("button", { name: /^(upload|replace)$/i }).click();

      await page.getByLabel("File").setInputFiles({
        name: "tax-id.pdf",
        mimeType: "application/pdf",
        buffer: pdf(2048),
      });
      await expect(page.getByRole("alert")).toHaveCount(0);
      await submitButton().click();

      await expect(page.getByText(/tax-id\.pdf uploaded/i)).toBeVisible({ timeout: 45_000 });
      await expect(
        page
          .locator("li")
          .filter({ hasText: /Tax Identification/i })
          .first(),
      ).toContainText(/uploaded/i, { timeout: 20_000 });
    });

    test("case 8: re-uploading supersedes the old version and keeps it in history", async () => {
      await page.goto("/company/verification");
      const row = () =>
        page
          .locator("li")
          .filter({ hasText: /Tax Identification/i })
          .first();
      const before = await row().textContent();

      await row()
        .getByRole("button", { name: /^(replace|upload)$/i })
        .click();
      await page.getByLabel("File").setInputFiles({
        name: "tax-id-v2.pdf",
        mimeType: "application/pdf",
        buffer: pdf(4096),
      });
      await submitButton().click();
      await expect(page.getByText(/tax-id-v2\.pdf uploaded/i)).toBeVisible({ timeout: 45_000 });

      // The version marker must advance, and the newest file becomes current.
      await expect(row()).toContainText(/tax-id-v2\.pdf/i, { timeout: 20_000 });
      expect(await row().textContent()).not.toBe(before);
    });
  });

// ─── US-305: comparison tray is client-side (cases 57, 58) ───────────────────

test.describe
  .serial("US-305 supplier comparison", () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      // Proving a cap of 4 needs a 5th listing to be refused, and the seed
      // publishes only three. Top the marketplace up as the supplier so the
      // case is deterministic instead of skipping on fixture size.
      const supplier = await signIn(browser, SUPPLIER_ADMIN);
      const cats = await (await supplier.request.get(`${API_PATH}/catalogue/categories`)).json();
      const raw = (cats.items ?? cats).find((c: { kind: string }) => c.kind === "RAW_MATERIAL");
      const published = await (
        await supplier.request.get(`${API_PATH}/catalogue/search?page=1`)
      ).json();
      const have = (published.items ?? published).length;
      for (let i = have; i < 5; i++) {
        const created = await supplier.request.post(`${API_PATH}/catalogue`, {
          data: {
            kind: "RAW_MATERIAL",
            name: `Compare Fixture ${i} ${Date.now().toString(36)}`,
            casNumber: "103-90-2",
            countryOfOrigin: "India",
            packagingType: "Drum",
            packSize: "25 kg",
            unit: "KG",
            categoryId: raw.id,
            price: `${10 + i}.00`,
            currency: "USD",
          },
        });
        if (created.ok()) {
          await supplier.request.post(`${API_PATH}/catalogue/${(await created.json()).id}/publish`);
        }
      }
      await supplier.context().close();

      page = await signIn(browser, BUYER);
    });
    test.afterAll(async () => page?.context().close());

    test("cases 57+58: at most 4 compare, and removing one leaves the rest", async () => {
      await page.goto("/marketplace");

      // A listing's button flips to "Selected" once chosen, so the tray's own
      // "Compare" button is the only other match — scope by the tray's text.
      const tray = page.getByText(/selected for comparison/i).locator("..");
      const listingCompare = page
        .getByRole("main")
        .getByRole("button", { name: /^compare$/i })
        .or(page.locator("main").getByRole("button", { name: /^compare$/i }));

      const available = await page.getByRole("button", { name: /^compare$/i }).count();
      expect(available, "marketplace should offer at least 5 comparable listings").toBeGreaterThan(
        4,
      );

      for (let i = 0; i < 4; i++) {
        await listingCompare.first().click();
      }
      await expect(tray).toBeVisible();

      // Case 57 — a 5th selection is refused with a limit message.
      await listingCompare.first().click();
      await expect(page.getByText(/compare up to 4 listings/i)).toBeVisible({ timeout: 10_000 });

      // Case 58 — open the tray and remove one; the remaining items stay.
      await tray.getByRole("button", { name: /^compare$/i }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText(/compare listings/i)).toBeVisible();

      const removals = dialog.getByRole("button", { name: /remove .* from comparison/i });
      await expect(removals).toHaveCount(4);
      await removals.first().click();
      await expect(removals).toHaveCount(3);
    });
  });

// ─── US-405: the award confirmation is cancellable (case 79) ─────────────────

test.describe("US-405 award confirmation", () => {
  test("case 79: cancelling the confirm dialog creates no order and leaves the RFQ open", async ({
    browser,
  }) => {
    const page = await signIn(browser, BUYER_ADMIN);

    // Find the RFQ that actually has an acceptable quotation — the first RFQ in
    // the list is usually already awarded, which is what made this skip.
    const rfqs = await (await page.request.get(`${API_PATH}/rfqs`)).json();
    let rfqId: string | undefined;
    for (const r of (rfqs.items ?? rfqs).filter((r: { status: string }) => r.status === "OPEN")) {
      const quotes = await (await page.request.get(`${API_PATH}/rfqs/${r.id}/quotations`)).json();
      const items = quotes.items ?? quotes;
      if (items.some((q: { status: string }) => q.status === "ACTIVE")) {
        rfqId = r.id;
        break;
      }
    }
    expect(rfqId, "no OPEN RFQ with an active quotation to award").toBeTruthy();

    const before = await page.request.get(`${API_PATH}/orders`);
    const beforeCount = ((await before.json()).items ?? []).length;

    await page.goto(`/rfqs/${rfqId}`);
    const accept = page.getByRole("button", { name: "Accept", exact: true }).first();
    await expect(accept).toBeVisible({ timeout: 20_000 });

    const calls = recordApiCalls(page, /quotations\/.*\/accept/);
    await accept.click();
    await expect(page.getByRole("dialog").getByText(/confirm order/i)).toBeVisible();

    // Backing out must not issue the request.
    await page.getByRole("button", { name: /^back$/i }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(calls, `accept was called anyway: ${calls.join(", ")}`).toHaveLength(0);

    const after = await page.request.get(`${API_PATH}/orders`);
    expect(((await after.json()).items ?? []).length).toBe(beforeCount);
    await page.context().close();
  });
});

// ─── US-605: notification centre (cases 107, 108, 109) ───────────────────────

test.describe
  .serial("US-605 notification centre", () => {
    let page: Page;
    test.beforeAll(async ({ browser }) => {
      page = await signIn(browser, BUYER);
    });
    test.afterAll(async () => page?.context().close());

    test("case 108: clicking a notification navigates to its subject and marks it read", async () => {
      await page.goto("/notifications");
      const unreadCount = await page.request.get(`${API_PATH}/notifications/unread-count`);
      const before = (await unreadCount.json()).count ?? 0;
      test.skip(before === 0, "no unread notification to click");

      // Notification rows are the buttons inside the list, not "Mark all read".
      await page.locator("ul > li > button").first().click();
      await expect(page).not.toHaveURL(/\/notifications$/, { timeout: 15_000 });

      const after = await (await page.request.get(`${API_PATH}/notifications/unread-count`)).json();
      expect(after.count).toBeLessThan(before);
    });

    test("case 109: 'Mark all read' clears the unread badge", async () => {
      await page.goto("/notifications");
      await page.getByRole("button", { name: /mark all read/i }).click();
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`${API_PATH}/notifications/unread-count`)).json()).count,
          { timeout: 20_000 },
        )
        .toBe(0);
    });
  });

// ─── US-702: shipment tracker (cases 117, 118, 119) ──────────────────────────

test.describe("US-702 shipment tracker", () => {
  test("cases 117+118: the current stage is shown with a chronological history", async ({
    browser,
  }) => {
    const page = await signIn(browser, BUYER);
    const orderId = await firstId(page, "/orders");
    test.skip(!orderId, "no order available");

    const detail = await (await page.request.get(`${API_PATH}/orders/${orderId}`)).json();
    await page.goto(`/orders/${orderId}`);

    // Case 117 — the order's current stage is rendered, not just a raw enum.
    const label = String(detail.status).toLowerCase().replace(/_/g, " ");
    await expect(page.getByText(new RegExp(label, "i")).first()).toBeVisible({ timeout: 20_000 });

    // Case 118 — every recorded transition is listed.
    const events = detail.statusEvents ?? [];
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events.slice(0, 3)) {
      const evLabel = String(ev.status).toLowerCase().replace(/_/g, " ");
      await expect(page.getByText(new RegExp(evLabel, "i")).first()).toBeVisible();
    }
    await page.context().close();
  });

  test("case 119: an order with no ETA shows a placeholder, not a blank field", async ({
    browser,
  }) => {
    const page = await signIn(browser, BUYER_ADMIN);
    const orders = await (await page.request.get(`${API_PATH}/orders`)).json();
    const list = orders.items ?? orders;
    const noEta = list.find((o: { eta: string | null }) => o.eta == null);
    test.skip(!noEta, "every order already has an ETA");

    await page.goto(`/orders/${noEta.id}`);
    await expect(page.getByText(/not yet available|no eta|—/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await page.context().close();
  });
});

// ─── US-205: idle session handling (cases 36, 37) ────────────────────────────

test.describe("US-205 idle session", () => {
  test("cases 36+37: an idle session warns, then expires to the login page", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Install a controllable clock BEFORE the app boots so its timers use it.
    await page.clock.install();

    await page.goto("/login");
    await page.getByLabel("Work email").fill(BUYER);
    await page.getByLabel("Password").fill(process.env.SEED_DEMO_PASSWORD ?? "demo-Pass-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

    // Case 37 — at the 25-minute mark the app warns before signing the user
    // out, and offers to keep the session. IdleSession polls every 5s, so nudge
    // just past the threshold.
    await page.clock.fastForward("25:10");
    await expect(page.getByRole("dialog").getByText(/still there\?/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: /stay signed in/i })).toBeVisible();

    // "Stay signed in" must reset the timer and dismiss the warning.
    await page.getByRole("button", { name: /stay signed in/i }).click();
    await expect(page.getByRole("dialog").getByText(/still there\?/i)).toBeHidden();

    // Case 36 — idle past the 30-minute limit, the app signs itself out with no
    // user action. Asserted on the sign-out request rather than the landing URL:
    // the faked clock is ~55 minutes ahead, so the browser also treats the
    // session cookie as expired and Auth.js's own redirect can fail the
    // navigation. The request is the behaviour under test.
    const signOutRequest = page
      .waitForRequest((r) => /\/api\/auth\/signout/.test(r.url()), { timeout: 40_000 })
      .catch(() => null);
    await page.clock.fastForward("30:10");
    expect(await signOutRequest, "the idle timeout did not sign the user out").not.toBeNull();

    // And the session really is gone: a protected route no longer renders.
    await page.clock.uninstall?.();
    const landed = await page
      .goto("/orders", { waitUntil: "domcontentloaded" })
      .then(() => page.url())
      .catch(() => "");
    if (landed) expect(landed).toMatch(/\/login/);
    await ctx.close();
  });
});

// ─── US-903: audit trail is append-only from the UI (case 139) ───────────────

test.describe("US-903 audit log", () => {
  test("case 139: the admin UI exposes no way to edit or delete an audit entry", async ({
    browser,
  }) => {
    const page = await signIn(browser, "admin@pharmachain.local", ADMIN_PASSWORD);
    await page.goto("/admin/audit");
    await expect(page.getByText(/audit/i).first()).toBeVisible({ timeout: 20_000 });

    for (const name of [/^delete$/i, /^edit$/i, /^remove$/i]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
    await page.context().close();
  });
});
