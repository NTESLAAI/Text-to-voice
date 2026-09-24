import { IsIn, IsString } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  @IsIn(['BASIC', 'PRO', 'BUSINESS'])
  planCode!: string;
}