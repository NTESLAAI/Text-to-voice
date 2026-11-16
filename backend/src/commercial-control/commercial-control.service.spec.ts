import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { CommercialControlService } from './commercial-control.service';

describe('CommercialControlService', () => {
  function createService(value?: string) {
    const configService = {
      get: jest.fn().mockReturnValue(value),
    } as unknown as ConfigService;

    return new CommercialControlService(configService);
  }

  it('disables payments when configuration is missing', () => {
    const service = createService();

    expect(service.isPaymentsEnabled()).toBe(false);
    expect(() => service.assertPaymentsEnabled()).toThrow(
      ServiceUnavailableException,
    );
  });

  it('disables payments when explicitly set to false', () => {
    const service = createService('false');

    expect(service.isPaymentsEnabled()).toBe(false);
    expect(() => service.assertPaymentsEnabled()).toThrow('PAYMENTS_DISABLED');
  });

  it('disables payments for invalid configuration values', () => {
    for (const value of ['1', 'yes', 'TRUE', 'enabled', '']) {
      const service = createService(value);

      expect(service.isPaymentsEnabled()).toBe(false);
      expect(() => service.assertPaymentsEnabled()).toThrow(
        ServiceUnavailableException,
      );
    }
  });

  it('enables payments only when explicitly set to true', () => {
    const service = createService('true');

    expect(service.isPaymentsEnabled()).toBe(true);
    expect(() => service.assertPaymentsEnabled()).not.toThrow();
  });

  it('accepts surrounding whitespace around true', () => {
    const service = createService(' true ');

    expect(service.isPaymentsEnabled()).toBe(true);
  });
});
