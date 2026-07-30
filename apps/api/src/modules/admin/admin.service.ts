import { Injectable } from "@nestjs/common";
import type { VerificationDecision } from "@pharmachain/core";
import { requiredVerificationKinds } from "@pharmachain/core";
import type { CompanyRole } from "@pharmachain/db";
import { Prisma, prisma } from "@pharmachain/db";
import {
  genericEventEmail,
  passwordResetEmail,
  verificationDecisionEmail,
} from "@pharmachain/email";
import { notify } from "@pharmachain/notifications";
import { badRequest, conflict, forbidden, notFound } from "../../common/errors";
import { env } from "../../env";
import { hashToken, randomToken } from "../../lib/crypto";
import { buildVerificationChecklist, describeBlocking } from "../company/verification-checklist";
import { sendEmailTo } from "../shared/mailer";

const THREE_YEARS_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

// Serializable so concurrent role changes cannot strip a company's last
// active admin (surfaces as a retryable 409 via the P2034 mapping).
const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

@Injectable()
export class AdminService {
  /** Company detail + the automated document checks admins see (US-103). */
  async companyDetail(companyId: string) {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, status: true, lastLoginAt: true },
            },
          },
        },
      },
    });
    if (!company) throw notFound("Company not found");

    const documents = await prisma.document.findMany({
      where: {
        ownerCompanyId: companyId,
        status: { in: ["ACTIVE", "SUPERSEDED"] },
        uploadCompletedAt: { not: null },
        kind: {
          in: [
            "CERTIFICATE_OF_INCORPORATION",
            "TRADING_LICENCE",
            "TAX_ID",
            "IMPORT_EXPORT_LICENCE",
            "MANUFACTURING_LICENCE",
            "GMP_CERTIFICATE",
            "OTHER_COMPLIANCE",
          ],
        },
      },
      orderBy: [{ kind: "asc" }, { version: "desc" }],
      include: { uploadedBy: { select: { name: true } } },
    });

    const now = Date.now();
    const checks = requiredVerificationKinds(company.type).map((kind) => {
      const doc = documents.find((d) => d.kind === kind && d.status === "ACTIVE");
      return {
        kind,
        present: Boolean(doc),
        notExpired: doc ? !doc.expiresAt || doc.expiresAt.getTime() > now : false,
        scanClean: doc ? doc.scanStatus === "CLEAN" : false,
        documentId: doc?.id ?? null,
        expiresAt: doc?.expiresAt ?? null,
      };
    });

    return {
      company,
      documents,
      checks,
      checksPass: checks.every((c) => c.present && c.notExpired),
    };
  }

  /** Approve/reject with a conditional update — safe when two admins review
   *  the same company concurrently (US-103 TC4). */
  async decideVerification(adminId: string, companyId: string, decision: VerificationDecision) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw notFound("Company not found");

    const approve = decision.decision === "APPROVE";
    // US-103: approval is a compliance control, not a formality — a company
    // cannot be verified while a mandatory document is absent or expired. The
    // blocked kinds are named so the admin knows what to chase.
    if (approve) {
      const { blocking } = await buildVerificationChecklist(companyId);
      if (blocking.length > 0) {
        throw badRequest(
          `Cannot approve — mandatory documents outstanding: ${describeBlocking(blocking)}`,
        );
      }
    }
    const result = await prisma.company.updateMany({
      where: {
        id: companyId,
        verificationStatus: { in: ["PENDING_VERIFICATION", "EXPIRED_DOCUMENT"] },
      },
      data: approve
        ? {
            verificationStatus: "VERIFIED",
            verifiedAt: new Date(),
            verifiedById: adminId,
            reverificationDueAt: new Date(Date.now() + THREE_YEARS_MS),
            rejectionReason: null,
          }
        : {
            verificationStatus: "REJECTED",
            rejectionReason: decision.reason,
          },
    });
    if (result.count === 0) {
      throw conflict("This company is not awaiting verification (possibly already reviewed)");
    }

    // US-103: company users notified in-app and by email
    await notify({
      companyId,
      type: "VERIFICATION_DECISION",
      title: approve ? "Company verified 🎉" : "Verification rejected",
      body: approve
        ? "Your company has been verified. You now have full marketplace access."
        : `Verification was rejected: ${decision.reason ?? ""}. Correct the issues and resubmit.`,
      href: "/company/verification",
      emailContent: verificationDecisionEmail({
        companyName: company.name,
        approved: approve,
        reason: decision.reason,
        appUrl: env.APP_URL,
      }),
    });

    return { previousStatus: company.verificationStatus, approved: approve };
  }

  private async loadUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { membership: true },
    });
    if (!user) throw notFound("User not found");
    return user;
  }

  // Super-admin overrides (US-203) — every action carries a mandatory reason.

  async adminResetPassword(userId: string) {
    const user = await this.loadUser(userId);
    const token = randomToken();
    await prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    await sendEmailTo(
      user.email,
      passwordResetEmail({ url: `${env.APP_URL}/reset-password?token=${token}` }),
    );
    return user;
  }

  async adminSetUserStatus(userId: string, active: boolean) {
    const user = await this.loadUser(userId);
    const updated = await prisma.user.update({
      where: { id: userId },
      data: active
        ? { status: "ACTIVE", deactivatedAt: null }
        : { status: "DEACTIVATED", deactivatedAt: new Date(), sessionVersion: { increment: 1 } },
    });
    await sendEmailTo(
      user.email,
      genericEventEmail({
        title: active ? "Your account was reactivated" : "Your account was deactivated",
        body: "A platform administrator changed your account status. Contact support if unexpected.",
      }),
    );
    return updated;
  }

  async adminReassignRole(userId: string, role: CompanyRole) {
    const user = await this.loadUser(userId);
    if (!user.membership) throw conflict("This user has no company membership");
    const oldRole = user.membership.role;
    const membership = user.membership;
    const updated = await prisma.$transaction(async (tx) => {
      if (membership.role === "COMPANY_ADMIN" && role !== "COMPANY_ADMIN") {
        const otherAdmins = await tx.companyUserRole.count({
          where: {
            companyId: membership.companyId,
            role: "COMPANY_ADMIN",
            userId: { not: userId },
            user: { status: "ACTIVE" },
          },
        });
        if (otherAdmins === 0) {
          throw forbidden("A company must keep at least one active Company Admin");
        }
      }
      return tx.companyUserRole.update({ where: { userId }, data: { role } });
    }, SERIALIZABLE);
    await notify({
      userIds: [userId],
      type: "ACCOUNT_UPDATE",
      title: "Your role was changed by a platform administrator",
      body: `Your role is now ${role}.`,
      href: "/account",
      emailContent: genericEventEmail({
        title: "Your PharmaChain role changed",
        body: `A platform administrator changed your role to ${role}.`,
      }),
    });
    return { oldRole, updated };
  }

  /** GDPR anonymization (US-1003): personal data tombstoned; business records
   *  (RFQs, orders, audit) survive attributed to "Deleted User". */
  async anonymizeUser(adminId: string, userId: string) {
    const user = await this.loadUser(userId);
    if (user.isSuperAdmin) throw forbidden("Super admin accounts cannot be anonymized");
    const membership = user.membership;
    const anonymized = await prisma.$transaction(async (tx) => {
      if (membership?.role === "COMPANY_ADMIN") {
        const otherAdmins = await tx.companyUserRole.count({
          where: {
            companyId: membership.companyId,
            role: "COMPANY_ADMIN",
            userId: { not: userId },
            user: { status: "ACTIVE" },
          },
        });
        if (otherAdmins === 0) {
          throw conflict("Reassign another Company Admin before anonymizing this user");
        }
      }
      const anonymized = await tx.user.update({
        where: { id: userId },
        data: {
          email: `deleted-${userId}@anonymized.invalid`,
          name: "Deleted User",
          passwordHash: null,
          whatsappNumber: null,
          whatsappVerifiedAt: null,
          status: "DEACTIVATED",
          deactivatedAt: new Date(),
          anonymizedAt: new Date(),
          sessionVersion: { increment: 1 },
        },
      });
      await tx.dataDeletionRequest.updateMany({
        where: { userId, status: "PENDING" },
        data: { status: "COMPLETED", completedById: adminId, completedAt: new Date() },
      });
      // Strip PII from historical login records; keep the rows for audit counts.
      await tx.loginActivity.updateMany({
        where: { userId },
        data: { email: "anonymized", ip: null, userAgent: null },
      });
      // Invitations addressed to this email also carry PII.
      await tx.invite.updateMany({
        where: { email: user.email },
        data: { email: `deleted-${userId}@anonymized.invalid` },
      });
      // Deliberately retained: AuditLog.actorEmail (legal-basis audit trail,
      // US-903) and Company.primaryContact* (company business record, owned
      // by the company rather than the user).
      return anonymized;
    }, SERIALIZABLE);
    return { before: { email: user.email }, anonymized };
  }
}
