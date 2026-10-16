import { Type } from "class-transformer";
import { IsInt, Matches, Max, Min } from "class-validator";

export class InAppNotificationQueryDto {
  @Matches(/^G[A-Z2-7]{55}$/)
  publicKey: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}