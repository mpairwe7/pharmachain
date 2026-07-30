"use client";

import type { DocumentKind } from "@pharmachain/core";
import { ALLOWED_MIMES, validateUpload } from "@pharmachain/core";
import { Button } from "@pharmachain/ui/components/button";
import { Input } from "@pharmachain/ui/components/input";
import { AlertCircle, Loader2, Paperclip, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api/http";
import { uploadDocument } from "@/lib/upload";

const MAX_ATTACHMENTS = 5; // mirrors the .max(5) on the RFQ/quotation schemas

interface Attachment {
  id: string;
  fileName: string;
}

/**
 * Optional-attachment picker for the RFQ and quotation forms (US-401/US-403).
 * Each file is uploaded straight to storage unlinked; the resulting document IDs
 * are reported to the parent form via `onChange`, and the server links them to
 * the RFQ/quotation on submit. Eligible counterparties can then download them.
 */
export function AttachmentPicker({
  kind,
  value,
  onChange,
  disabled,
}: {
  kind: DocumentKind;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  // US-602: per-file progress & failure state, not just a global busy flag.
  const [uploading, setUploading] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    if (value.length >= MAX_ATTACHMENTS) {
      toast.error(`Up to ${MAX_ATTACHMENTS} attachments`);
      return;
    }
    const rejection = validateUpload(kind, file);
    if (rejection) {
      toast.error(rejection);
      return;
    }
    setBusy(true);
    setUploading(file.name);
    setFailed(null);
    try {
      const doc = await uploadDocument({ file, kind });
      setItems((prev) => [...prev, doc]);
      onChange([...value, doc.id]);
    } catch (err) {
      setFailed(file.name);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      setUploading(null);
    }
  }

  function remove(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    onChange(value.filter((v) => v !== id));
  }

  return (
    <div className="grid gap-2">
      {(items.length > 0 || uploading || failed) && (
        <ul className="grid gap-1">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-2 text-sm">
              <Paperclip className="size-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">{i.fileName}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => remove(i.id)}
                disabled={disabled}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
          {uploading && (
            <li className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="flex-1 truncate">{uploading}</span>
              <span className="text-xs">uploading…</span>
            </li>
          )}
          {failed && (
            <li className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="size-3.5" />
              <span className="flex-1 truncate">{failed}</span>
              <span className="text-xs">failed — pick it again to retry</span>
            </li>
          )}
        </ul>
      )}
      <Input
        ref={inputRef}
        type="file"
        accept={ALLOWED_MIMES[kind].join(",")}
        disabled={disabled || busy || value.length >= MAX_ATTACHMENTS}
        onChange={onPick}
      />
      <p className="text-xs text-muted-foreground">
        {busy ? "Uploading…" : `Optional · up to ${MAX_ATTACHMENTS} files, max 10MB each`}
      </p>
    </div>
  );
}
