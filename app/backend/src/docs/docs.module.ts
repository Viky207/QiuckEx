import { Module } from "@nestjs/common";
import { DocsController } from "./docs.controller";
import { DocsContentService } from "./docs-content.service";

/**
 * Provides the POST /docs/json endpoint that exports the validated OpenAPI
 * specification (used by the CI spec-divergence check), along with the
 * troubleshooting guide (keyed by stable API error codes) and the field-level
 * privacy and retention reference served by the docs controller.
 */
@Module({
  controllers: [DocsController],
  providers: [DocsContentService],
  exports: [DocsContentService],
})
export class DocsModule {}