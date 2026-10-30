import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class SepayWebhookDto {
  @IsInt()
  @Min(1)
  id!: number;

  @IsString()
  @IsNotEmpty()
  gateway!: string;

  @IsString()
  @IsNotEmpty()
  transactionDate!: string;

  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  @IsOptional()
  @IsString()
  subAccount?: string | null;

  @IsOptional()
  @IsString()
  code?: string | null;

  @IsString()
  content!: string;

  @IsString()
  @IsIn(['in', 'out'])
  transferType!: string;

  @IsInt()
  @Min(1)
  transferAmount!: number;

  @IsInt()
  @Min(0)
  accumulated!: number;

  @IsString()
  referenceCode!: string;
}
