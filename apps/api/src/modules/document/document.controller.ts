import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  type DocumentRequestUpload,
  documentListQuerySchema,
  documentRequestUploadSchema,
  idParamSchema,
} from "@pharmachain/core";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  CurrentMembership,
  CurrentUser,
  OptionalMembership,
  RequirePermission,
  setAudit,
} from "../../common/decorators";
import { zodPipe } from "../../common/pipes/zod.pipe";
import type { AuthUser, Membership } from "../../lib/context";
import { clientIp } from "../../lib/context";
import { DocumentService } from "./document.service";

type ListQuery = z.infer<typeof documentListQuerySchema>;

@Controller("documents")
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @RequirePermission("document:write")
  @Post("request-upload")
  async requestUpload(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() membership: Membership,
    @Body(zodPipe(documentRequestUploadSchema)) body: DocumentRequestUpload,
    @Req() req: FastifyRequest,
  ) {
    const result = await this.documentService.requestUpload(user, membership, body);
    setAudit(req, {
      action: "document.upload-request",
      entityType: "Document",
      entityId: result.document.id,
      newValues: { kind: result.document.kind, fileName: result.document.fileName },
    });
    return result;
  }

  /** Raw file body → storage, server-side. Bound to the binary content-type
   *  parser registered in bootstrap.ts. */
  @RequirePermission("document:write")
  @HttpCode(200)
  @Put(":id/content")
  async uploadContent(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() membership: Membership,
    @Param(zodPipe(idParamSchema)) params: { id: string },
    @Req() req: FastifyRequest,
  ) {
    return this.documentService.uploadContent(
      user,
      membership,
      params.id,
      req.body as Buffer,
      req.headers["content-type"],
    );
  }

  @RequirePermission("document:write")
  @HttpCode(200)
  @Post(":id/complete")
  async complete(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() membership: Membership,
    @Param(zodPipe(idParamSchema)) params: { id: string },
    @Req() req: FastifyRequest,
  ) {
    const document = await this.documentService.completeUpload(user, membership, params.id);
    setAudit(req, {
      action: "document.upload-complete",
      entityType: "Document",
      entityId: document.id,
    });
    return document;
  }

  @RequirePermission("document:read")
  @Get()
  list(
    @CurrentMembership() membership: Membership,
    @Query(zodPipe(documentListQuerySchema)) query: ListQuery,
  ) {
    return this.documentService.listCompanyDocuments(membership, query);
  }

  @Get(":id/download-url")
  downloadUrl(
    @CurrentUser() user: AuthUser,
    @OptionalMembership() membership: Membership | undefined,
    @Param(zodPipe(idParamSchema)) params: { id: string },
    @Req() req: FastifyRequest,
  ) {
    return this.documentService.downloadUrl(user, membership, params.id, {
      ip: clientIp(req),
      userAgent: req.headers["user-agent"] as string | undefined,
    });
  }

  @RequirePermission("document:write")
  @Delete(":id")
  async softDelete(
    @CurrentMembership() membership: Membership,
    @Param(zodPipe(idParamSchema)) params: { id: string },
    @Req() req: FastifyRequest,
  ) {
    const document = await this.documentService.softDelete(membership, params.id);
    setAudit(req, { action: "document.delete", entityType: "Document", entityId: document.id });
    return { ok: true };
  }
}
