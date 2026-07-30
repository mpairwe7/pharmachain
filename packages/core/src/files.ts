import type { CompanyType, DocumentKind } from "./enums";

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB across all upload contexts
export const MAX_MESSAGE_ATTACHMENTS = 5;

const PDF = "application/pdf";
const JPG = "image/jpeg";
const PNG = "image/png";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Verification documents: PDF/JPG/PNG (US-102). SDS: PDF only (US-303).
// Order documents & message attachments: PDF/JPG/PNG/DOCX/XLSX (US-501/602).
const VERIFICATION_MIMES = [PDF, JPG, PNG] as const;
const OFFICE_MIMES = [PDF, JPG, PNG, DOCX, XLSX] as const;

export const ALLOWED_MIMES: Record<DocumentKind, readonly string[]> = {
  CERTIFICATE_OF_INCORPORATION: VERIFICATION_MIMES,
  TRADING_LICENCE: VERIFICATION_MIMES,
  TAX_ID: VERIFICATION_MIMES,
  IMPORT_EXPORT_LICENCE: VERIFICATION_MIMES,
  MANUFACTURING_LICENCE: VERIFICATION_MIMES,
  GMP_CERTIFICATE: VERIFICATION_MIMES,
  OTHER_COMPLIANCE: VERIFICATION_MIMES,
  PROFORMA_INVOICE: OFFICE_MIMES,
  CERTIFICATE_OF_ANALYSIS: OFFICE_MIMES,
  QUALITY_CERTIFICATE: OFFICE_MIMES,
  SHIPPING_INSTRUCTIONS: OFFICE_MIMES,
  BILL_OF_LADING: OFFICE_MIMES,
  AIR_WAYBILL: OFFICE_MIMES,
  COMMERCIAL_INVOICE: OFFICE_MIMES,
  PACKING_LIST: OFFICE_MIMES,
  CERTIFICATE_OF_ORIGIN: OFFICE_MIMES,
  CUSTOMS_DECLARATION: OFFICE_MIMES,
  DANGEROUS_GOODS_DECLARATION: OFFICE_MIMES,
  PHYTOSANITARY_CERTIFICATE: OFFICE_MIMES,
  TAX_WORKSHEET: OFFICE_MIMES,
  PROOF_OF_DELIVERY_PHOTO: [JPG, PNG],
  SDS: [PDF],
  RFQ_ATTACHMENT: OFFICE_MIMES,
  QUOTATION_ATTACHMENT: OFFICE_MIMES,
  MESSAGE_ATTACHMENT: OFFICE_MIMES,
  COMPANY_LOGO: [JPG, PNG],
  OTHER: OFFICE_MIMES,
};

export function isAllowedMime(kind: DocumentKind, mime: string): boolean {
  return ALLOWED_MIMES[kind].includes(mime);
}

// Extensions we can map to an accepted MIME type. `File.type` from the browser
// is not trustworthy on its own — it is empty for plenty of ordinary files and
// OS-dependent for others — so uploads are gated on the extension too.
const EXTENSION_MIMES: Record<string, string> = {
  pdf: PDF,
  jpg: JPG,
  jpeg: JPG,
  png: PNG,
  docx: DOCX,
  xlsx: XLSX,
};

const MIME_LABELS: Record<string, string> = {
  [PDF]: "PDF",
  [JPG]: "JPG",
  [PNG]: "PNG",
  [DOCX]: "DOCX",
  [XLSX]: "XLSX",
};

/** "PDF, JPG or PNG" — for the accept hint and the rejection message. */
export function describeAllowedTypes(kind: DocumentKind): string {
  const labels = ALLOWED_MIMES[kind].map((m) => MIME_LABELS[m] ?? m);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * The MIME type to declare for a file, or null when it is not an accepted type
 * for `kind`. The extension must map to an accepted type, and a browser-reported
 * type must agree with it when the browser gives a specific one — so a `.exe` is
 * rejected whether or not the browser labels it, and a PDF whose `File.type`
 * came through empty is still declared `application/pdf` rather than
 * `application/octet-stream` (which the upload contract would then reject).
 */
export function resolveUploadMime(
  kind: DocumentKind,
  fileName: string,
  reportedType: string,
): string | null {
  const byExtension = EXTENSION_MIMES[extensionOf(fileName)];
  if (!byExtension || !isAllowedMime(kind, byExtension)) return null;
  const reported = reportedType.split(";")[0]?.trim().toLowerCase() ?? "";
  // "" and application/octet-stream both mean "the browser doesn't know" —
  // fall back to the extension. Anything else has to match it.
  const unknown = reported === "" || reported === "application/octet-stream";
  if (!unknown && reported !== byExtension) {
    // image/jpg is a long-standing alias for image/jpeg.
    if (!(byExtension === JPG && reported === "image/jpg")) return null;
  }
  return byExtension;
}

export function formatFileSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) {
    const rounded = Math.round(mb * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * The single size-and-type gate for uploads (US-102), shared by every file
 * picker and re-run server-side. Returns a message to show the user, or null
 * when the file is acceptable. Clients must call this BEFORE requesting an
 * upload so a rejected file never creates a partial document record.
 */
export function validateUpload(
  kind: DocumentKind,
  file: { name: string; type: string; size: number },
): string | null {
  if (file.size <= 0) return "That file is empty — choose a different file";
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `That file is ${formatFileSize(file.size)} — the limit is ${formatFileSize(
      MAX_FILE_SIZE_BYTES,
    )}`;
  }
  if (!resolveUploadMime(kind, file.name, file.type)) {
    return `Unsupported file type — upload a ${describeAllowedTypes(kind)} file`;
  }
  return null;
}

// Company verification kinds (uploaded pre-verification, reviewed by admins).
export const VERIFICATION_DOCUMENT_KINDS = [
  "CERTIFICATE_OF_INCORPORATION",
  "TRADING_LICENCE",
  "TAX_ID",
  "IMPORT_EXPORT_LICENCE",
  "MANUFACTURING_LICENCE",
  "GMP_CERTIFICATE",
  "OTHER_COMPLIANCE",
] as const satisfies readonly DocumentKind[];
export type VerificationDocumentKind = (typeof VERIFICATION_DOCUMENT_KINDS)[number];

// Licence-type documents must carry an expiry date (US-102).
export const EXPIRY_REQUIRED_KINDS = [
  "TRADING_LICENCE",
  "IMPORT_EXPORT_LICENCE",
  "MANUFACTURING_LICENCE",
  "GMP_CERTIFICATE",
] as const satisfies readonly DocumentKind[];

// Order-scoped procurement + logistics documents (US-501, Phase 2 §2).
export const ORDER_DOCUMENT_KINDS = [
  "PROFORMA_INVOICE",
  "CERTIFICATE_OF_ANALYSIS",
  "QUALITY_CERTIFICATE",
  "SHIPPING_INSTRUCTIONS",
  "BILL_OF_LADING",
  "AIR_WAYBILL",
  "COMMERCIAL_INVOICE",
  "PACKING_LIST",
  "CERTIFICATE_OF_ORIGIN",
  "CUSTOMS_DECLARATION",
  "DANGEROUS_GOODS_DECLARATION",
  "PHYTOSANITARY_CERTIFICATE",
  "TAX_WORKSHEET",
  "PROOF_OF_DELIVERY_PHOTO",
  "OTHER",
] as const satisfies readonly DocumentKind[];

// Mandatory checklist per company type. Manufacturers additionally need a
// manufacturing licence and GMP certificate before approval.
export function requiredVerificationKinds(type: CompanyType): readonly VerificationDocumentKind[] {
  const base: VerificationDocumentKind[] = [
    "CERTIFICATE_OF_INCORPORATION",
    "TRADING_LICENCE",
    "TAX_ID",
  ];
  if (type === "RAW_MATERIAL_MANUFACTURER" || type === "FINISHED_PRODUCT_MANUFACTURER") {
    base.push("MANUFACTURING_LICENCE", "GMP_CERTIFICATE");
  }
  return base;
}

export function isVerificationKind(kind: DocumentKind): kind is VerificationDocumentKind {
  return (VERIFICATION_DOCUMENT_KINDS as readonly DocumentKind[]).includes(kind);
}

export function expiryRequired(kind: DocumentKind): boolean {
  return (EXPIRY_REQUIRED_KINDS as readonly DocumentKind[]).includes(kind);
}
