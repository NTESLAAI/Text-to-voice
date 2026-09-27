import { IsIn, IsOptional, IsString } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  @IsIn(['BASIC', 'PRO', 'BUSINESS'])
  planCode!: string;

  @IsOptional()
  @IsString()
  @IsIn(['TRANSFER_QUOTA', 'CONVERT_TO_CREDIT'])
  upgradeOption?: string;
}
