import { Controller, Post, Res } from "@nestjs/common";
import { ApiExcludeController, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { OpenApiDocumentHolder } from "../common/swagger/openapi-document.holder";

/**
 * Exports the validated OpenAPI JSON specification used by CI to detect spec
 * divergence. Returns a copy of the document produced during bootstrap.
 *
 * The canonical payment intent lifecycle documentation lives in
 * `docs/payment-intent-lifecycle.md` and is derived from the implemented
 * link-state-machine and transaction types. It is intentionally kept as a
 * static markdown document rather than being served from this controller so
 * that client and operator docs share a single source of truth.
 */
@ApiTags("docs")
@ApiExcludeController()
@Controller("docs")
export class DocsController {
  @Post("json")
  exportSpec(@Res() res: Response) {
    const document = OpenApiDocumentHolder.get().get();
    if (!document) {
      return res.status(503).json({
        code: "SPEC_NOT_READY",
        message: "OpenAPI document has not been generated yet.",
      });
    }
    return res.status(200).json(document);
  }
}