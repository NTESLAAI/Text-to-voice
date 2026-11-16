'use strict';
const path = require('node:path'),
  g = require('./guard.cjs');
(async () => {
  const p = g.readPacket();
  g.insist(p.action === 'test');
  require('./setup.cjs');
  const [account, key] = process.argv.slice(2);
  g.insist(
    /^[0-9a-f-]{36}$/.test(account) &&
      /^(SYNTHETIC_MP_|LEGACY-)[A-Za-z0-9_-]+$/.test(key),
  );
  const checked = await g.verifiedClient(p, 'writer');
  await checked.end();
  const { PrismaClient } = require('../../dist/generated/prisma/client.js'),
    { PrismaPg } = require('@prisma/adapter-pg'),
    { Pool } = require('pg');
  const db = new PrismaClient({
    adapter: new PrismaPg(
      new Pool({
        ...g.connection(p, 'writer'),
        application_name:
          'ttv-bank:' + p.manifest.runId + ':writer:node-' + process.pid,
        max: 2,
      }),
    ),
    transactionOptions: { maxWait: 10000, timeout: 15000 },
  });
  try {
    const {
        PaymentTransactionService,
      } = require('../../dist/src/payment/payment-transaction.service.js'),
      { PaymentService } = require('../../dist/src/payment/payment.service.js');
    const {
      CommercialControlService,
    } = require('../../dist/src/commercial-control/commercial-control.service.js');
    const { ConfigService } = require('@nestjs/config');
    const control = new CommercialControlService(
      new ConfigService({ PAYMENTS_ENABLED: 'true' }),
    );
    const service = new PaymentTransactionService(
      db,
      new PaymentService(db, control),
    );
    try {
      const r = await service.recordBankTransaction({
        receivingBankAccountId: account,
        providerTransactionId: key,
        amount: 10,
        currency: 'VND',
        receivedAt: '2026-01-01T00:00:00.000Z',
        reference: 'Synthetic MP',
        note: 'Synthetic MP',
      });
      process.stdout.write(
        JSON.stringify({
          status: 'RECORDED',
          receiptId: r.id,
          processId: process.pid,
        }),
      );
    } catch (e) {
      const allowed = [
        'LEGACY_RECEIPT_REVIEW_REQUIRED',
        'BANK_RECEIPT_DUPLICATE_CONFLICT',
        'BANK_ACCOUNT_INACTIVE',
        'SEPAY_PRIMARY_MANUAL_RECEIPT_REFUSED',
      ];
      if (!allowed.includes(e?.message)) throw e;
      process.stdout.write(
        JSON.stringify({
          status: 'REFUSED',
          code: e.message,
          processId: process.pid,
        }),
      );
    }
  } finally {
    await db.$disconnect();
  }
})().catch(() => {
  process.stdout.write(
    JSON.stringify({ status: 'UNKNOWN', code: 'BANK_PROCESS_FAILED' }),
  );
  process.exitCode = 1;
});
