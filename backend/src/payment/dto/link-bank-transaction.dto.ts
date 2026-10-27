import { IsUUID } from 'class-validator';

export class LinkBankTransactionDto {
  @IsUUID()
  paymentId!: string;
}
