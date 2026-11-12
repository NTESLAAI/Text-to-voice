import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  GUARDS_METADATA,
  PATH_METADATA,
  METHOD_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin/admin.guard';
import { PaymentSurplusController } from './payment-surplus.controller';
import { PaymentSurplusService } from './payment-surplus.service';

describe('PaymentSurplusController', () => {
  it('exposes GET /admin/payments/:paymentId/surplus with JWT then AdminGuard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PaymentSurplusController)).toBe(
      'admin/payments',
    );
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        PaymentSurplusController.prototype.getSurplus,
      ),
    ).toBe(':paymentId/surplus');
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        PaymentSurplusController.prototype.getSurplus,
      ),
    ).toBe(RequestMethod.GET);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PaymentSurplusController),
    ).toEqual([JwtAuthGuard, AdminGuard]);
  });

  it('passes paymentId to the read service', async () => {
    const result = { paymentId: 'payment-1', availableSurplus: '10' };
    const getSurplus = jest.fn().mockResolvedValue(result);
    const controller = new PaymentSurplusController({
      getSurplus,
    } as unknown as PaymentSurplusService);
    expect(await controller.getSurplus('payment-1')).toBe(result);
    expect(getSurplus).toHaveBeenCalledWith('payment-1');
  });

  it.each([undefined, { role: 'USER' }])(
    'rejects a non-admin user %p',
    (user) => {
      const context = {
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      } as unknown as ExecutionContext;
      expect(() => new AdminGuard().canActivate(context)).toThrow(
        ForbiddenException,
      );
    },
  );

  it('allows an admin through AdminGuard', () => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user: { role: 'ADMIN' } }) }),
    } as unknown as ExecutionContext;
    expect(new AdminGuard().canActivate(context)).toBe(true);
  });

  it('passes authenticated actor and idempotency key to all write methods', async () => {
    const service = {
      createHandling: jest.fn(),
      completeHandling: jest.fn(),
      cancelHandling: jest.fn(),
    };
    const controller = new PaymentSurplusController(
      service as unknown as PaymentSurplusService,
    );
    const req = { user: { userId: 'admin' } };
    const dto = {
      action: 'CREDIT' as const,
      amount: '1',
      note: 'Record credit',
    };
    controller.create('p', 'key', dto, req);
    expect(service.createHandling).toHaveBeenCalledWith(
      'p',
      'key',
      dto,
      'admin',
    );
    controller.complete('p', 'h', { confirmation: 'Recorded' }, req);
    expect(service.completeHandling).toHaveBeenCalledWith(
      'p',
      'h',
      { confirmation: 'Recorded' },
      'admin',
    );
    controller.cancel('p', 'h', { note: 'Mistake' }, req);
    expect(service.cancelHandling).toHaveBeenCalledWith(
      'p',
      'h',
      { note: 'Mistake' },
      'admin',
    );
    for (const method of ['create', 'complete', 'cancel'] as const) {
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          PaymentSurplusController.prototype[method],
        ),
      ).toBe(RequestMethod.POST);
    }
  });
});
