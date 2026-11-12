import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  Max,
  Length,
  Matches,
} from 'class-validator';

export class SepayWebhookDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
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
  @Max(Number.MAX_SAFE_INTEGER)
  transferAmount!: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsInt()
  @Min(0)
  accumulated!: number;

  @IsOptional()
  @IsString()
  referenceCode?: string | null;
}
