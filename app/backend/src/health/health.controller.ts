import { Controller, Get, Res, Headers } from "@nestjs/common";
import { ApiOperation, ApiTags, ApiResponse } from "@nestjs/swagger";
import { Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { createHash } from "crypto";

import { HealthService } from "./health.service";
import { HealthResponseDto, ReadyResponseDto } from "./health-response.dto";
import { PublicStatusResponseDto } from "./public-status.dto";
import { ApiErrorResponse } from "../common/decorators/api-error-response.decorator";

@ApiTags("health")
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("health/live")
  @ApiOperation({
    summary: "Liveness check",
    description: "Returns 200 when the application process is running.",
  })
  @ApiResponse({ status: 200, schema: { example: { status: "ok" } } })
  getLiveness(@Res() res: Response) {
    return res.status(200).json({ status: "ok" });
  }

  @Get("health")
  @ApiOperation({
    summary: "Health check",
    description:
      "Returns application health status (shallow). Used for liveness probes.",
  })
  @ApiResponse({ status: 200, type: HealthResponseDto })
  @ApiErrorResponse(500, { description: "Unexpected internal error" })
  async getHealth(@Res() res: Response) {
    const result = await this.healthService.getHealthStatus();
    return res.status(200).json(result);
  }

  @Get(["ready", "health/ready"])
  @ApiOperation({
    summary: "Readiness check",
    description:
      "Returns application readiness status including dependency checks (Supabase, environment). Used for readiness probes.",
  })
  @ApiResponse({ status: 200, type: ReadyResponseDto })
  @ApiResponse({
    status: 503,
    type: ReadyResponseDto,
    description: "Service not ready",
  })
  async getReadiness(@Res() res: Response) {
    const result = await this.healthService.getReadinessStatus();

    if (!result.ready) {
      return res.status(503).json(result);
    }

    return res.status(200).json(result);
  }

  @Get("health/post-deploy")
  @ApiOperation({
    summary: "Post-deploy verification check",
    description:
      "Lightweight endpoint polled by the deployment script after a rollout. Returns 200 only when all dependencies are healthy; otherwise 503 with the names of failing dependencies. Used to trigger automated rollback.",
  })
  @ApiResponse({ status: 200, type: ReadyResponseDto })
  @ApiResponse({
    status: 503,
    type: ReadyResponseDto,
    description: "One or more dependencies unhealthy; rollback should be triggered",
  })
  async getPostDeployVerification(@Res() res: Response) {
    const result = await this.healthService.getReadinessStatus();

    if (!result.ready) {
      return res.status(503).json(result);
    }

    return res.status(200).json(result);
  }

  @Get("status")
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 requests per minute for public status
  @ApiOperation({
    summary: "Public status page",
    description:
      "Returns a minimal, cacheable status suitable for a public status page. No sensitive details exposed.",
  })
  @ApiResponse({ status: 200, type: PublicStatusResponseDto })
  async getPublicStatus(
    @Res() res: Response,
    @Headers("if-none-match") ifNoneMatch?: string,
  ) {
    const result = await this.healthService.getPublicStatus();

    // Generate ETag based on response content
    const etag = createHash("md5")
      .update(JSON.stringify(result))
      .digest("hex")
      .substring(0, 16);

    // Check if client has cached version
    if (ifNoneMatch && ifNoneMatch.includes(etag)) {
      return res.status(304).send();
    }

    // Set caching headers
    res.set("Cache-Control", "public, max-age=30, s-maxage=60"); // Cache for 30s client-side, 60s CDN
    res.set("ETag", `"${etag}"`);

    return res.status(200).json(result);
  }
}
