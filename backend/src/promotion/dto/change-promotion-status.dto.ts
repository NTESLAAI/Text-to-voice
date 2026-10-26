import { IsEnum } from 'class-validator';
import { PromotionStatus } from '../../../generated/prisma/client';

export class ChangePromotionStatusDto {
  @IsEnum(PromotionStatus)
  status!: PromotionStatus;
}
