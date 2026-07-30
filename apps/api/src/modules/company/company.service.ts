import { Injectable } from "@nestjs/common";
import type { CompanyProfileUpdate } from "@pharmachain/core";
import { COMPANY_ROLE_LABELS, PARAM_KEYS } from "@pharmachain/core";
import type { CompanyRole } from "@pharmachain/db";
import { Prisma, prisma } from "@pharmachain/db";
import { genericEventEmail } from "@pharmachain/email";
import { notify } from "@pharmachain/notifications";
import { conflict, forbidden, notFound } from "../../common/errors";
import { getIntParam } from "../../lib/params";
import { createInviteToken, inviteEmailContent } from "../auth/invite-tokens";
import { sendEmailTo } from "../shared/mailer";
import { buildVerificationChecklist } from "./verification-checklist";

// Last-admin checks are check-then-act; serializable isolation turns a
// concurrent demote/deactivate race into a retryable 409 (P2034) instead of
// leaving a company with zero admins.
const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

@Injectable()
export class CompanyService {
  async getMyCompany(companyId: string) {
    return prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      include: {
        _count: {
          select: {
            members: true,
            listings: { where: { status: "PUBLISHED" } },
          },
        },
      },
    });
  }

  /** Checklist backing US-102/105 and the admin's automated checks (US-103).
   *  Shares buildVerificationChecklist with the admin approval gate so the two
   *  cannot disagree about what a complete checklist is. */
  async verificationChecklist(companyId: string) {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const { required, additional, complete } = await buildVerificationChecklist(companyId);
    return {
      verificationStatus: company.verificationStatus,
      rejectionReason: company.rejectionReason,
      verifiedAt: company.verifiedAt,
      reverificationDueAt: company.reverificationDueAt,
      required,
      additional,
      complete,
    };
  }

  async updateProfile(companyId: string, input: CompanyProfileUpdate) {
    const before = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const after = await prisma.company.update({
      where: { id: companyId },
      data: {
        profileDescription: input.description,
        countriesOfOperation: input.countriesOfOperation,
        displayedCertifications: input.displayedCertifications,
        website: input.website === "" ? null : input.website,
        primaryContactPhone: input.contactPhone,
      },
    });
    return {
      after,
      diff: {
        old: {
          profileDescription: before.profileDescription,
          countriesOfOperation: before.countriesOfOperation,
          displayedCertifications: before.displayedCertifications,
          website: before.website,
        },
        new: {
          profileDescription: after.profileDescription,
          countriesOfOperation: after.countriesOfOperation,
          displayedCertifications: after.displayedCertifications,
          website: after.website,
        },
      },
    };
  }

  async publishProfile(companyId: string) {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    // US-301: publish requires VERIFIED
    if (company.verificationStatus !== "VERIFIED") {
      throw forbidden("Your company must be verified before publishing its profile");
    }
    return prisma.company.update({
      where: { id: companyId },
      data: { profileStatus: "PUBLISHED", profilePublishedAt: new Date() },
    });
  }

  async listMembers(companyId: string) {
    return prisma.companyUserRole.findMany({
      where: { companyId },
      include: {
        user: {
          select: { id: true, name: true, email: true, status: true, lastLoginAt: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  private async assertNotLastAdmin(
    tx: Prisma.TransactionClient,
    companyId: string,
    targetUserId: string,
  ) {
    const target = await tx.companyUserRole.findUnique({ where: { userId: targetUserId } });
    if (!target || target.companyId !== companyId) throw notFound("Member not found");
    if (target.role === "COMPANY_ADMIN") {
      const otherAdmins = await tx.companyUserRole.count({
        where: {
          companyId,
          role: "COMPANY_ADMIN",
          userId: { not: targetUserId },
          user: { status: "ACTIVE" },
        },
      });
      if (otherAdmins === 0) {
        throw forbidden("A company must keep at least one active Company Admin");
      }
    }
    return target;
  }

  async updateMemberRole(companyId: string, targetUserId: string, role: CompanyRole) {
    const result = await prisma.$transaction(async (tx) => {
      const target = await this.assertNotLastAdmin(tx, companyId, targetUserId);
      const updated = await tx.companyUserRole.update({
        where: { userId: targetUserId },
        data: { role },
      });
      return { oldRole: target.role, updated };
    }, SERIALIZABLE);
    await notify({
      userIds: [targetUserId],
      type: "ACCOUNT_UPDATE",
      title: "Your role changed",
      body: `Your role is now ${COMPANY_ROLE_LABELS[role]}.`,
      href: "/account",
    });
    return result;
  }

  async deactivateMember(companyId: string, targetUserId: string) {
    const user = await prisma.$transaction(async (tx) => {
      await this.assertNotLastAdmin(tx, companyId, targetUserId);
      return tx.user.update({
        where: { id: targetUserId },
        // sessionVersion bump terminates active sessions immediately (US-202)
        data: {
          status: "DEACTIVATED",
          deactivatedAt: new Date(),
          sessionVersion: { increment: 1 },
        },
      });
    }, SERIALIZABLE);
    await sendEmailTo(
      user.email,
      genericEventEmail({
        title: "Your PharmaChain access was deactivated",
        body: "Your account was deactivated by your Company Admin. Contact them if you believe this is an error.",
      }),
    );
    return user;
  }

  async reactivateMember(companyId: string, targetUserId: string) {
    const target = await prisma.companyUserRole.findUnique({ where: { userId: targetUserId } });
    if (!target || target.companyId !== companyId) throw notFound("Member not found");
    return prisma.user.update({
      where: { id: targetUserId },
      data: { status: "ACTIVE", deactivatedAt: null },
    });
  }

  async createInvite(args: {
    companyId: string;
    companyName: string;
    email: string;
    role: CompanyRole;
    invitedById: string;
  }) {
    const email = args.email.toLowerCase();
    const existingUser = await prisma.user.findUnique({
      where: { email },
      include: { membership: true },
    });
    // US-201 TC4: an email already active in a company is rejected
    if (existingUser?.membership) {
      throw conflict("This email is already registered to a company on PharmaChain");
    }
    const pending = await prisma.invite.findFirst({
      where: {
        companyId: args.companyId,
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (pending) throw conflict("An invitation for this email is already pending");

    const userLimit = await getIntParam(PARAM_KEYS.COMPANY_USER_LIMIT);
    if (userLimit > 0) {
      const [activeMembers, pendingInvites] = await Promise.all([
        prisma.companyUserRole.count({
          where: { companyId: args.companyId, user: { status: { not: "DEACTIVATED" } } },
        }),
        prisma.invite.count({
          where: {
            companyId: args.companyId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        }),
      ]);
      if (activeMembers + pendingInvites >= userLimit) {
        throw forbidden(`Your plan allows at most ${userLimit} users`);
      }
    }

    const { token, tokenHash, expiresAt } = createInviteToken();
    const invite = await prisma.invite.create({
      data: {
        companyId: args.companyId,
        email,
        role: args.role,
        tokenHash,
        invitedById: args.invitedById,
        expiresAt,
      },
    });
    await sendEmailTo(
      email,
      inviteEmailContent(args.companyName, COMPANY_ROLE_LABELS[args.role], token),
    );
    return invite;
  }

  async listInvites(companyId: string) {
    return prisma.invite.findMany({
      where: { companyId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
  }

  async revokeInvite(companyId: string, inviteId: string) {
    const invite = await prisma.invite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.companyId !== companyId) throw notFound("Invitation not found");
    if (invite.acceptedAt) throw conflict("Invitation was already accepted");
    return prisma.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } });
  }

  async findCompanyPublic(companyId: string) {
    const company = await prisma.company.findFirst({
      where: { id: companyId, verificationStatus: "VERIFIED", profileStatus: "PUBLISHED" },
      select: {
        id: true,
        name: true,
        type: true,
        country: true,
        website: true,
        subscriptionTier: true,
        profileDescription: true,
        countriesOfOperation: true,
        displayedCertifications: true,
        verificationStatus: true,
        verifiedAt: true,
        _count: { select: { listings: { where: { status: "PUBLISHED" } } } },
      },
    });
    if (!company) throw notFound("Company profile not found");
    const logo = await prisma.document.findFirst({
      where: {
        ownerCompanyId: companyId,
        kind: "COMPANY_LOGO",
        status: "ACTIVE",
        uploadCompletedAt: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return { ...company, logoDocumentId: logo?.id ?? null };
  }
}
