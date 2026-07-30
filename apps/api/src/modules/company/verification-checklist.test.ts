import { describe, expect, test } from "bun:test";
import {
  type ChecklistItem,
  type ChecklistItemStatus,
  describeBlocking,
  selectBlocking,
} from "./verification-checklist";

const item = (kind: ChecklistItem["kind"], status: ChecklistItemStatus): ChecklistItem => ({
  kind,
  status,
  documentId: status === "MISSING" ? null : "doc-id",
  fileName: status === "MISSING" ? null : `${kind}.pdf`,
  expiresAt: null,
  version: status === "MISSING" ? null : 1,
});

describe("verification approval gate (US-103)", () => {
  test("a complete checklist blocks nothing", () => {
    const required = [
      item("CERTIFICATE_OF_INCORPORATION", "UPLOADED"),
      item("TRADING_LICENCE", "UPLOADED"),
      item("TAX_ID", "UPLOADED"),
    ];
    expect(selectBlocking(required)).toEqual([]);
  });

  test("a missing mandatory document blocks approval", () => {
    // Regression: approval used to check only the company's current status, so a
    // company with no documents at all could be verified.
    const required = [
      item("CERTIFICATE_OF_INCORPORATION", "MISSING"),
      item("TRADING_LICENCE", "MISSING"),
      item("TAX_ID", "MISSING"),
    ];
    expect(selectBlocking(required).map((b) => b.kind)).toEqual([
      "CERTIFICATE_OF_INCORPORATION",
      "TRADING_LICENCE",
      "TAX_ID",
    ]);
  });

  test("an already-expired licence blocks approval", () => {
    const required = [item("TRADING_LICENCE", "EXPIRED"), item("TAX_ID", "UPLOADED")];
    expect(selectBlocking(required).map((b) => b.kind)).toEqual(["TRADING_LICENCE"]);
  });

  test("an expiring-soon licence is still valid and does not block", () => {
    const required = [item("TRADING_LICENCE", "EXPIRING_SOON"), item("TAX_ID", "UPLOADED")];
    expect(selectBlocking(required)).toEqual([]);
  });

  test("the message names each outstanding document and why", () => {
    const message = describeBlocking([
      item("CERTIFICATE_OF_INCORPORATION", "MISSING"),
      item("TRADING_LICENCE", "EXPIRED"),
    ]);
    expect(message).toBe("Certificate of Incorporation (missing), Trading Licence (expired)");
  });
});
