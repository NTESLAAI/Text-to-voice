import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class VerifyBankReceiptDto {
  // Internal statement/document locator, never a password or uploaded statement.
  // Optional ONLY for an existing authenticated SePay receipt; manual service
  // validation still requires it before stamping MANUAL_ADMIN evidence.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
  evidenceReference?: string;
}
