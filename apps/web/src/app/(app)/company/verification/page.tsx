import { DOCUMENT_KIND_LABELS, type DocumentKind } from "@pharmachain/core";
import { Alert, AlertDescription, AlertTitle } from "@pharmachain/ui/components/alert";
import { Badge } from "@pharmachain/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@pharmachain/ui/components/card";
import { DocumentChip } from "@/components/document-chip";
import { PageHeader } from "@/components/page-header";
import { VerificationStatusBadge } from "@/components/status-badge";
import { UploadButton } from "@/components/upload-button";
import { apiServer } from "@/lib/api/server";
import type { VerificationChecklist } from "@/lib/api/types";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Verification" };

function ItemStatusBadge({ status, awaitingReview }: { status: string; awaitingReview: boolean }) {
  switch (status) {
    case "MISSING":
      return <Badge variant="destructive">missing</Badge>;
    case "EXPIRED":
      return <Badge variant="destructive">expired</Badge>;
    case "EXPIRING_SOON":
      return <Badge variant="warning">expiring soon</Badge>;
    default:
      // US-102: an uploaded document still has to be reviewed. A bare
      // "uploaded" reads as "accepted", which it is not yet.
      return awaitingReview ? (
        <Badge variant="info">uploaded, pending review</Badge>
      ) : (
        <Badge variant="success">uploaded</Badge>
      );
  }
}

export default async function VerificationPage() {
  const api = await apiServer();
  const checklist = await api.get<VerificationChecklist>("/companies/me/verification");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Verification"
        description="Upload the required documents; the platform team reviews them (US-102/105). Re-uploads create a new version — prior versions are retained."
      >
        <VerificationStatusBadge status={checklist.verificationStatus} />
      </PageHeader>

      {checklist.verificationStatus === "REJECTED" && checklist.rejectionReason && (
        <Alert variant="destructive">
          <AlertTitle>Verification rejected</AlertTitle>
          <AlertDescription>
            {checklist.rejectionReason} — re-upload the corrected documents; your company returns to
            the review queue automatically.
          </AlertDescription>
        </Alert>
      )}
      {checklist.verificationStatus === "VERIFIED" && (
        <Alert>
          <AlertTitle>Verified {fmtDate(checklist.verifiedAt)}</AlertTitle>
          <AlertDescription>
            Re-verification due {fmtDate(checklist.reverificationDueAt)}. Keep licences current — an
            expired document flags your company until it is replaced.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Required documents</CardTitle>
          <CardDescription>
            PDF, JPG or PNG, max 10MB. Licences require an expiry date.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {checklist.required.map((item) => (
              <li key={item.kind} className="flex flex-wrap items-center gap-2 py-2.5">
                <div className="min-w-52 flex-1">
                  <p className="text-sm font-medium">
                    {DOCUMENT_KIND_LABELS[item.kind as DocumentKind]}
                  </p>
                  {item.documentId && item.fileName && (
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <DocumentChip id={item.documentId} fileName={item.fileName} />
                      <span className="text-xs text-muted-foreground">
                        v{item.version}
                        {item.expiresAt ? ` · expires ${fmtDate(item.expiresAt)}` : ""}
                      </span>
                    </div>
                  )}
                </div>
                <ItemStatusBadge
                  status={item.status}
                  awaitingReview={checklist.verificationStatus === "PENDING_VERIFICATION"}
                />
                <UploadButton
                  kind={item.kind as DocumentKind}
                  label={item.documentId ? "Replace" : "Upload"}
                  replacesDocumentId={item.documentId ?? undefined}
                />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm">Additional documents</CardTitle>
            <CardDescription>Optional supporting compliance documents.</CardDescription>
          </div>
          <UploadButton kind="OTHER_COMPLIANCE" label="Upload document" />
        </CardHeader>
        <CardContent>
          {checklist.additional.length === 0 ? (
            <p className="text-sm text-muted-foreground">None uploaded.</p>
          ) : (
            <ul className="space-y-1.5">
              {checklist.additional.map((doc) => (
                <li key={doc.documentId} className="flex flex-wrap items-center gap-2 text-sm">
                  <DocumentChip id={doc.documentId} fileName={doc.fileName} />
                  <span className="text-xs text-muted-foreground">
                    {DOCUMENT_KIND_LABELS[doc.kind as DocumentKind]} · v{doc.version}
                    {doc.expiresAt ? ` · expires ${fmtDate(doc.expiresAt)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
