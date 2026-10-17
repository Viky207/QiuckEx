import { Module } from "@nestjs/common";
import { HorizonService } from "../transactions/horizon.service";
import { PaymentsController } from "./payments.controller";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { ApiKeyGuard } from "../auth/guards/api-key.guard";

@Module({
  imports: [ApiKeysModule],
  controllers: [PaymentsController],
  providers: [HorizonService, ApiKeyGuard],
  exports: [],
})
export class PaymentsModule {}
