"use client";

import type { DocumentKind } from "@pharmachain/core";
import {
  ALLOWED_MIMES,
  describeAllowedTypes,
  expiryRequired,
  validateUpload,
} from "@pharmachain/core";
import { Button } from "@pharmachain/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@pharmachain/ui/components/dialog";
import { Input } from "@pharmachain/ui/components/input";
import { Label } from "@pharmachain/ui/components/label";
import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api/http";
import { type UploadLinks, uploadDocument } from "@/lib/upload";

/** Reusable presigned-upload dialog: pick file (+ expiry when the kind
 *  requires it) → PUT to storage → complete. Refreshes the page after. */
export function UploadButton({
  kind,
  label,
  links,
  replacesDocumentId,
  variant = "outline",
  size = "sm",
}: {
  kind: DocumentKind;
  label: string;
  links?: UploadLinks;
  replacesDocumentId?: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  // Size/type rejection shown inline — `accept` only filters the file picker,
  // and the user can always switch it back to "All files".
  const [rejected, setRejected] = useState<string | null>(null);
  const needsExpiry = expiryRequired(kind);
  const accept = ALLOWED_MIMES[kind].join(",");

  function pick(picked: File | null) {
    setFile(picked);
    setRejected(picked ? validateUpload(kind, picked) : null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || rejected) return;
    setBusy(true);
    try {
      await uploadDocument({
        file,
        kind,
        expiresAt: needsExpiry || expiresAt ? expiresAt : undefined,
        replacesDocumentId,
        links,
      });
      toast.success(`${file.name} uploaded`);
      setOpen(false);
      pick(null);
      setExpiresAt("");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size}>
          <Upload className="size-3.5" /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            {describeAllowedTypes(kind)}, max 10MB.{" "}
            {needsExpiry ? "Licence documents require an expiry date." : ""}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`file-${kind}`}>File</Label>
            <Input
              id={`file-${kind}`}
              type="file"
              accept={accept}
              required
              aria-invalid={rejected ? true : undefined}
              aria-describedby={rejected ? `file-error-${kind}` : undefined}
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            {rejected && (
              <p id={`file-error-${kind}`} role="alert" className="text-sm text-destructive">
                {rejected}
              </p>
            )}
          </div>
          {(needsExpiry || kind === "GMP_CERTIFICATE") && (
            <div className="grid gap-2">
              <Label htmlFor={`expiry-${kind}`}>Expiry date</Label>
              <Input
                id={`expiry-${kind}`}
                type="date"
                required={needsExpiry}
                min={new Date().toISOString().slice(0, 10)}
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy || !file || rejected !== null}>
              {busy ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
