import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SepayWebhookDto } from './sepay-webhook.dto';

describe('SepayWebhookDto', () => {
  const validPayload = {
    id: 12345,
    gateway: 'Vietcombank',
    transactionDate: '2026-10-30 08:00:00',
    accountNumber: '0123456789',
    subAccount: null,
    code: null,
    content: 'KH123456',
    transferType: 'in',
    transferAmount: 199000,
    accumulated: 5000000,
    referenceCode: 'FT26103012345',
  };

  async function validatePayload(payload: Record<string, unknown>) {
    const dto = plainToInstance(SepayWebhookDto, payload);
    return validate(dto);
  }

  it('accepts a valid SePay payload', async () => {
    const errors = await validatePayload(validPayload);
    expect(errors).toHaveLength(0);
  });

  it('accepts nullable code and subAccount', async () => {
    const errors = await validatePayload({
      ...validPayload,
      code: null,
      subAccount: null,
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid transferType', async () => {
    const errors = await validatePayload({
      ...validPayload,
      transferType: 'refund',
    });

    expect(errors.some((error) => error.property === 'transferType')).toBe(
      true,
    );
  });

  it('rejects a non-positive transferAmount', async () => {
    const errors = await validatePayload({
      ...validPayload,
      transferAmount: 0,
    });

    expect(errors.some((error) => error.property === 'transferAmount')).toBe(
      true,
    );
  });

  it('rejects a missing transaction ID', async () => {
    const { id, ...payloadWithoutId } = validPayload;

    const errors = await validatePayload(payloadWithoutId);

    expect(errors.some((error) => error.property === 'id')).toBe(true);
  });
  it('accepts missing or nullable referenceCode', async () => {
    const { referenceCode, ...payloadWithoutReferenceCode } = validPayload;

    const missingErrors = await validatePayload(payloadWithoutReferenceCode);

    const nullableErrors = await validatePayload({
      ...validPayload,
      referenceCode: null,
    });

    expect(missingErrors).toHaveLength(0);
    expect(nullableErrors).toHaveLength(0);
  });
});
