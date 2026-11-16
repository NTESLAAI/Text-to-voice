import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../src/payment/payment.service';
import { CommercialControlService } from '../src/commercial-control/commercial-control.service';
import type { PrismaService } from '../src/prisma/prisma.service';

// In-memory mocks only: no Prisma constructor, connection or SQL execution.
describe('Promotion reuse service branch (mock evidence only)', () => {
  function setup(activePaid = 0) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      payment: { findUnique: jest.fn().mockResolvedValue({
        id: 'synthetic-payment', userId: 'synthetic-user', status: 'PENDING',
        provider: 'BANK_TRANSFER', receivingBankAccountId: 'synthetic-bank',
        amount: 100, currency: 'VND', promotionIdSnapshot: 'synthetic-promotion',
        plan: { name: 'Synthetic', price: 100, durationDays: 7, characterLimit: 10 },
      }), update: jest.fn() },
      paymentTransaction: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 100 } }) },
      subscription: { count: jest.fn().mockResolvedValue(activePaid), findFirst: jest.fn(), create: jest.fn() },
      quotaLot: { create: jest.fn() },
      promotionRedemption: { findUnique: jest.fn().mockResolvedValue({ id: 'synthetic-redemption' }), create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((body: (client: typeof tx) => Promise<unknown>) => body(tx)) };
    const service = new PaymentService(prisma as unknown as PrismaService,
      new CommercialControlService(new ConfigService({ PAYMENTS_ENABLED: 'true' })));
    return { service, tx };
  }
  it('reaches the existing-redemption branch after passing the active-paid check', async () => {
    const { service, tx } = setup();
    await expect(service.confirmPayment('synthetic-payment')).rejects.toThrow('Bạn đã sử dụng chương trình khuyến mại này.');
    expect(tx.subscription.count).toHaveBeenCalledTimes(1);
    expect(tx.promotionRedemption.findUnique).toHaveBeenCalledWith({ where: { userId_promotionId: { userId: 'synthetic-user', promotionId: 'synthetic-promotion' } } });
    expect(tx.subscription.findFirst).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
    expect(tx.promotionRedemption.create).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
  it('distinguishes the earlier active-paid rejection from promotion reuse', async () => {
    const { service, tx } = setup(1);
    await expect(service.confirmPayment('synthetic-payment')).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
    expect(tx.promotionRedemption.findUnique).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
  });
});
