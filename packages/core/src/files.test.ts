import { describe, expect, test } from "bun:test";
import {
  describeAllowedTypes,
  expiryRequired,
  formatFileSize,
  isAllowedMime,
  MAX_FILE_SIZE_BYTES,
  requiredVerificationKinds,
  resolveUploadMime,
  validateUpload,
} from "./files";

describe("file rules", () => {
  test("SDS accepts PDF only (US-303)", () => {
    expect(isAllowedMime("SDS", "application/pdf")).toBe(true);
    expect(isAllowedMime("SDS", "image/png")).toBe(false);
  });

  test("order documents accept office formats (US-501)", () => {
    expect(
      isAllowedMime(
        "PROFORMA_INVOICE",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
    expect(isAllowedMime("PROFORMA_INVOICE", "application/zip")).toBe(false);
  });

  test("licence kinds require expiry dates (US-102)", () => {
    expect(expiryRequired("TRADING_LICENCE")).toBe(true);
    expect(expiryRequired("GMP_CERTIFICATE")).toBe(true);
    expect(expiryRequired("CERTIFICATE_OF_INCORPORATION")).toBe(false);
  });

  test("manufacturers need manufacturing licence + GMP in the checklist", () => {
    expect(requiredVerificationKinds("FINISHED_PRODUCT_MANUFACTURER")).toContain("GMP_CERTIFICATE");
    expect(requiredVerificationKinds("SUPPLIER")).not.toContain("GMP_CERTIFICATE");
  });
});

const file = (name: string, type: string, size: number) => ({ name, type, size });
const MB = 1024 * 1024;

describe("upload gate (US-102)", () => {
  test("accepts a valid PDF under the limit", () => {
    expect(validateUpload("TRADING_LICENCE", file("licence.pdf", "application/pdf", 2 * MB))).toBe(
      null,
    );
  });

  test("rejects a 15MB file with a file-size error naming both sizes", () => {
    const message = validateUpload("TAX_ID", file("scan.pdf", "application/pdf", 15 * MB));
    expect(message).toBe("That file is 15MB — the limit is 10MB");
  });

  test("a file exactly on the limit is still accepted", () => {
    expect(validateUpload("TAX_ID", file("scan.pdf", "application/pdf", MAX_FILE_SIZE_BYTES))).toBe(
      null,
    );
  });

  test("rejects .exe with an unsupported-file-type error, however it is labelled", () => {
    const expected = "Unsupported file type — upload a PDF, JPG or PNG file";
    // Chrome/Windows reports this MIME; Linux/Firefox often reports nothing.
    expect(validateUpload("TAX_ID", file("setup.exe", "application/x-msdownload", MB))).toBe(
      expected,
    );
    expect(validateUpload("TAX_ID", file("setup.exe", "", MB))).toBe(expected);
    // …and claiming to be a PDF does not help it either.
    expect(validateUpload("TAX_ID", file("setup.exe", "application/pdf", MB))).toBe(expected);
  });

  test("rejects an empty file", () => {
    expect(validateUpload("TAX_ID", file("empty.pdf", "application/pdf", 0))).toBe(
      "That file is empty — choose a different file",
    );
  });

  test("type rules stay per-kind: a PNG is fine for a licence, not for an SDS", () => {
    expect(validateUpload("TRADING_LICENCE", file("cert.png", "image/png", MB))).toBe(null);
    expect(validateUpload("SDS", file("sheet.png", "image/png", MB))).toBe(
      "Unsupported file type — upload a PDF file",
    );
  });

  test("resolves the MIME from the extension when the browser reports none", () => {
    // Without this the declared content type falls back to octet-stream and the
    // upload contract rejects a perfectly good PDF.
    expect(resolveUploadMime("TAX_ID", "licence.pdf", "")).toBe("application/pdf");
    expect(resolveUploadMime("TAX_ID", "licence.PDF", "application/octet-stream")).toBe(
      "application/pdf",
    );
    expect(resolveUploadMime("TAX_ID", "photo.jpeg", "image/jpg")).toBe("image/jpeg");
    expect(resolveUploadMime("TAX_ID", "setup.exe", "")).toBe(null);
  });

  test("describes the accepted types for the picker hint", () => {
    expect(describeAllowedTypes("TRADING_LICENCE")).toBe("PDF, JPG or PNG");
    expect(describeAllowedTypes("SDS")).toBe("PDF");
    expect(describeAllowedTypes("COMPANY_LOGO")).toBe("JPG or PNG");
  });

  test("sizes read the way a person would write them", () => {
    expect(formatFileSize(MAX_FILE_SIZE_BYTES)).toBe("10MB");
    expect(formatFileSize(15 * MB)).toBe("15MB");
    expect(formatFileSize(2.5 * MB)).toBe("2.5MB");
    expect(formatFileSize(400 * 1024)).toBe("400KB");
  });
});
