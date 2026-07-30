import type { ScanStatus } from "@pharmachain/db";

/**
 * Virus-scanning stub (acceptance criterion #6). The contract is final; the
 * implementation is a placeholder. Production wiring options:
 *  - ClamAV sidecar: stream the object through clamd and map the verdict
 *  - Bucket-event scanning (R2 event notifications → Cloudflare Worker)
 *    updating scanStatus asynchronously
 * Documents remain visible with scanStatus PENDING/CLEAN; INFECTED documents
 * should be quarantined (status DELETED + owner notified) by the real hook.
 */
export async function scanUploadedObject(_storageKey: string): Promise<ScanStatus> {
  return "CLEAN";
}
