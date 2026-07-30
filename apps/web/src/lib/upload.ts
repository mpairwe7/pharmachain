"use client";

import type { DocumentKind } from "@pharmachain/core";
import { resolveUploadMime, validateUpload } from "@pharmachain/core";
import { api } from "@/lib/api/browser";
import { ApiClientError } from "@/lib/api/http";

export interface UploadLinks {
  listingId?: string;
  rfqId?: string;
  quotationId?: string;
  orderId?: string;
}

interface UploadRequested {
  document: { id: string; kind: string; fileName: string };
}

/** Thrown for a file the user picked that we reject without calling the API. */
export class UnacceptableFileError extends Error {}

/**
 * Browser upload flow: reserve the document → PUT the bytes to the API through
 * the same-origin proxy → confirm completion (triggers the scan stub +
 * versioning).
 *
 * The bytes deliberately do NOT go straight to object storage. A presigned PUT
 * from the page needs a CORS rule on the bucket for the app origin and needs
 * the storage endpoint to be publicly reachable over https; when either is
 * missing the browser reports only an opaque "NetworkError when attempting to
 * fetch resource" with nothing server-side to debug from.
 */
export async function uploadDocument(args: {
  file: File;
  kind: DocumentKind;
  expiresAt?: string;
  replacesDocumentId?: string;
  links?: UploadLinks;
}): Promise<{ id: string; fileName: string }> {
  const { file, kind, expiresAt, replacesDocumentId, links } = args;

  // Last line of defence for size and type: the pickers check too, so a bad
  // file is reported instantly, but no call site can skip the gate from here.
  const rejection = validateUpload(kind, file);
  if (rejection) throw new UnacceptableFileError(rejection);
  // Non-null: validateUpload already proved the type resolves for this kind.
  const contentType = resolveUploadMime(kind, file.name, file.type) as string;

  const requested = await api.post<UploadRequested>("/documents/request-upload", {
    fileName: file.name,
    contentType,
    size: file.size,
    kind,
    expiresAt,
    replacesDocumentId,
    ...links,
  });

  const put = await fetch(`/api/proxy/documents/${requested.document.id}/content`, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    cache: "no-store",
    body: file,
  });
  if (!put.ok) {
    const detail = await put
      .json()
      .then((b: { error?: { message?: string } }) => b.error?.message)
      .catch(() => undefined);
    throw new ApiClientError(
      put.status,
      "UPLOAD_FAILED",
      detail ?? `Upload failed (${put.status})`,
    );
  }

  const completed = await api.post<{ id: string; fileName: string }>(
    `/documents/${requested.document.id}/complete`,
  );
  return { id: completed.id, fileName: completed.fileName };
}

export async function downloadDocument(documentId: string): Promise<void> {
  const { url } = await api.get<{ url: string }>(`/documents/${documentId}/download-url`);
  window.open(url, "_blank", "noopener");
}
