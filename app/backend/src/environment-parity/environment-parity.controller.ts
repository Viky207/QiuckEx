import { Controller, Get, Logger } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import {
  EnvironmentParityService,
  ParityCheckResult,
} from "./environment-parity.service";
import {
  DeployFreezeService,
  DeployFreezeState,
} from "./deploy-freeze.service";
import {
  BlueGreenSwitchService,
  BlueGreenSwitchStatus,
} from "./blue-green-switch.service";

interface ParityStatusResponse {
  success: boolean;
  data: {
    checks: ParityCheckResult[];
    summary: {
      total: number;
      passed: number;
      failed: number;
      warnings: number;
    };
  };
}

interface HealthResponse {
  success: boolean;
  data: {
    healthy: boolean;
    failedChecks: number;
    totalChecks: number;
  };
}

interface DeployFreezeResponse {
  success: boolean;
  data: DeployFreezeState;
}

interface SwitchStatusResponse {
  success: boolean;
  data: BlueGreenSwitchStatus;
}

@ApiTags("Environment Parity")
@Controller("api/environment-parity")
export class EnvironmentParityController {
  private readonly logger = new Logger(EnvironmentParityController.name);

  constructor(
    private readonly parityService: EnvironmentParityService,
    private readonly deployFreezeService: DeployFreezeService,
    private readonly blueGreenSwitchService: BlueGreenSwitchService,
  ) {}

  @Get("status")
  @ApiOperation({ summary: "Get environment parity check status" })
  @ApiResponse({ status: 200, description: "Returns parity check results" })
  getParityStatus(): ParityStatusResponse {
    const results = this.parityService.getResults();

    return {
      success: true,
      data: {
        checks: results,
        summary: {
          total: results.length,
          passed: results.filter((r) => r.status === "pass").length,
          failed: results.filter((r) => r.status === "fail").length,
          warnings: results.filter((r) => r.status === "warning").length,
        },
      },
    };
  }

  @Get("health")
  @ApiOperation({ summary: "Quick health check for environment parity" })
  @ApiResponse({ status: 200, description: "Returns health status" })
  getHealth(): HealthResponse {
    const results = this.parityService.getResults();
    const failed = results.filter((r) => r.status === "fail").length;

    return {
      success: true,
      data: {
        healthy: failed === 0,
        failedChecks: failed,
        totalChecks: results.length,
      },
    };
  }

  @Get("deploy-freeze")
  @ApiOperation({
    summary: "Get the current deploy freeze (deployment hold) state",
    description:
      "Reports whether automatic production promotion is held, who set the hold, and any audited overrides.",
  })
  @ApiResponse({ status: 200, description: "Returns deploy freeze state" })
  getDeployFreeze(): DeployFreezeResponse {
    return {
      success: true,
      data: this.deployFreezeService.getState(),
    };
  }

  @Get("switch-status")
  @ApiOperation({
    summary: "Get blue-green traffic switch status",
    description:
      "Reports the currently active slot, the readiness of the target slot, and the outcome of the last switch attempt.",
  })
  @ApiResponse({ status: 200, description: "Returns switch status" })
  getSwitchStatus(): SwitchStatusResponse {
    return {
      success: true,
      data: this.blueGreenSwitchService.getStatus(),
    };
  }
}
