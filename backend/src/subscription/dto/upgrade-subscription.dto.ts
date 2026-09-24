import { IsIn, IsString } from 'class-validator';

export class UpgradeSubscriptionDto {
  @IsString()
  @IsIn(['BASIC', 'PRO', 'BUSINESS'])
  planCode!: string;
}