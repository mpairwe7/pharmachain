import { DOCUMENT_KIND_LABELS, requiredVerificationKinds } from "@pharmachain/core";
import { prisma } from "@pharmachain/db";

const EXPIRING_SOON_DAYS = 30;

const CHECKLIST_KINDS = [
  "CERTIFICATE_OF_INCORPORATION",
  "TRADING_LICENCE",
  "TAX_ID",
  "IMPORT_EXPORT_LICENCE",
  "MANUFACTURING_LICENCE",
  "GMP_CERTIFICATE",
  "OTHER_COMPLIANCE",
] as const;

export type ChecklistItemStatus = "MISSING" | "UPLOADED" | "EXPIRING_SOON" | "EXPIRED";

export interface ChecklistItem {
  kind: (typeof CHECKLIST_KINDS)[number];
  status: ChecklistItemStatus;
  documentId: string | null;
  fileName: string | null;
  expiresAt: Date | null;
  version: number | null;
}

/**
 * Current state of a company's verification documents (US-102/103/105).
 *
 * Shared deliberately: the company's own status page and the admin's approval
 * gate must agree on what "complete" means, or an admin can approve a company
 * the checklist still shows as incomplete.
 */
export async function buildVerificationChecklist(companyId: string): Promise<{
  companyType: Awaited<ReturnType<typeof prisma.company.findUniqueOrThrow>>["type"];
  required: ChecklistItem[];
  additional: Array<{
    kind: string;
    documentId: string;
    fileName: string;
    expiresAt: Date | null;
    version: number;
  }>;
  complete: boolean;
  blocking: ChecklistItem[];
}> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const docs = await prisma.document.findMany({
    where: {
      ownerCompanyId: companyId,
      status: "ACTIVE",
      uploadCompletedAt: { not: null },
      kind: { in: [...CHECKLIST_KINDS] },
    },
    // createdAt breaks the tie: two documents of the same kind can share a
    // version (an upload that did not go through the replace flow), and
    // without it which one the checklist shows is arbitrary.
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
  });

  const now = Date.now();
  const soon = now + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;

  const required: ChecklistItem[] = requiredVerificationKinds(company.type).map((kind) => {
    const doc = docs.find((d) => d.kind === kind);
    let status: ChecklistItemStatus = "MISSING";
    if (doc) {
      status = "UPLOADED";
      if (doc.expiresAt) {
        if (doc.expiresAt.getTime() < now) status = "EXPIRED";
        else if (doc.expiresAt.getTime() < soon) status = "EXPIRING_SOON";
      }
    }
    return {
      kind,
      status,
      documentId: doc?.id ?? null,
      fileName: doc?.fileName ?? null,
      expiresAt: doc?.expiresAt ?? null,
      version: doc?.version ?? null,
    };
  });

  const additional = docs
    .filter((d) => !required.some((r) => r.documentId === d.id))
    .map((d) => ({
      kind: d.kind,
      documentId: d.id,
      fileName: d.fileName,
      expiresAt: d.expiresAt,
      version: d.version,
    }));

  const blocking = selectBlocking(required);

  return {
    companyType: company.type,
    required,
    additional,
    complete: blocking.length === 0,
    blocking,
  };
}

/**
 * Items that must not pass approval. An expiring-soon licence is still valid;
 * a missing or already-expired one is not.
 */
export function selectBlocking(required: ChecklistItem[]): ChecklistItem[] {
  return required.filter((r) => r.status === "MISSING" || r.status === "EXPIRED");
}

/** Human-readable list for the message an admin sees when approval is blocked. */
export function describeBlocking(blocking: ChecklistItem[]): string {
  return blocking
    .map((b) => {
      const label = DOCUMENT_KIND_LABELS[b.kind] ?? b.kind;
      return b.status === "EXPIRED" ? `${label} (expired)` : `${label} (missing)`;
    })
    .join(", ");
}
