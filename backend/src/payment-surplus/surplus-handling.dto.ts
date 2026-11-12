import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateSurplusHandlingDto {
  @IsIn(['REFUND', 'CREDIT'])
  action!: 'REFUND' | 'CREDIT';

  @IsString()
  @Matches(/^\d{1,14}(?:\.\d{1,6})?$/)
  amount!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  note!: string;
}

export class CompleteSurplusHandlingDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  confirmation!: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  externalReference?: string;
}

export class CancelSurplusHandlingDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  note!: string;
}
