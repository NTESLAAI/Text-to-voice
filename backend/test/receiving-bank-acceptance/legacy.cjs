'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto'),
  g = require('./guard.cjs');
async function snapshot(c, columns) {
  if (!columns) {
    columns = {};
    const rows = (
      await c.query(
        "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name<>'_prisma_migrations' ORDER BY table_name,ordinal_position",
      )
    ).rows;
    for (const r of rows) (columns[r.table_name] ??= []).push(r.column_name);
  }
  const data = {};
  for (const [table, cols] of Object.entries(columns)) {
    g.insist(
      /^[A-Za-z][A-Za-z0-9_]*$/.test(table) &&
        cols.every((x) => /^[A-Za-z][A-Za-z0-9_]*$/.test(x)),
    );
    data[table] = (
      await c.query(
        'SELECT row_to_json(t)::text AS value FROM (SELECT ' +
          cols.map((x) => '"' + x + '"').join(',') +
          ' FROM public."' +
          table +
          '") t ORDER BY value',
      )
    ).rows.map((x) => JSON.parse(x.value));
  }
  return { columns, data };
}
async function compare(c, baseline, allowCancel = false) {
  const current = await snapshot(c, baseline.columns);
  for (const [table, rows] of Object.entries(baseline.data))
    for (const row of rows) {
      const now = current.data[table].find((x) => x.id === row.id);
      g.insist(now, 'BANK_LEGACY_ROW_MISSING');
      if (
        allowCancel &&
        table === 'PaymentSurplusHandling' &&
        row.status === 'PENDING'
      ) {
        g.insist(
          now.status === 'CANCELLED' &&
            now.amount === row.amount &&
            now.currency === row.currency &&
            now.idempotencyKey === row.idempotencyKey &&
            now.createdById === row.createdById &&
            now.cancelledById &&
            now.cancelledAt,
          'BANK_LEGACY_CANCEL_UNVERIFIED',
        );
        const ignored = new Set([
          'status',
          'note',
          'cancelledById',
          'cancelledAt',
          'updatedAt',
        ]);
        for (const k of Object.keys(row))
          if (!ignored.has(k))
            g.insist(
              JSON.stringify(now[k]) === JSON.stringify(row[k]),
              'BANK_LEGACY_CHANGED',
            );
      } else
        g.insist(
          JSON.stringify(now) === JSON.stringify(row),
          'BANK_LEGACY_CHANGED',
        );
    }
}
async function create(p, c) {
  const root = path.dirname(p.manifest.dataDirectory),
    file = path.join(root, 'legacy-baseline.json');
  g.insist(!fs.existsSync(file));
  g.insist(
    (await c.query('SELECT count(*)::integer AS n FROM public."User"')).rows[0]
      .n === 0,
  );
  const admin = randomUUID(),
    paidUser = randomUUID(),
    freeUser = randomUUID(),
    freePlan = randomUUID(),
    paidPlan = randomUUID();
  const payments = [];
  await c.query('BEGIN');
  try {
    for (const [id, role] of [
      [admin, 'ADMIN'],
      [paidUser, 'USER'],
      [freeUser, 'USER'],
    ])
      await c.query(
        'INSERT INTO public."User" (id,email,role,"updatedAt") VALUES ($1,$2,$3,now())',
        [id, id + '@example.invalid', role],
      );
    for (const [id, code, price, chars] of [
      [freePlan, 'FREE', 0, 17],
      [paidPlan, 'BASIC', 100, 173],
    ])
      await c.query(
        'INSERT INTO public."Plan" (id,code,name,price,"durationDays","characterLimit","updatedAt") VALUES ($1,$2,$3,$4,7,$5,now())',
        [id, code, 'Synthetic ' + code, price, chars],
      );
    for (const [user, plan, chars] of [
      [paidUser, paidPlan, 173],
      [freeUser, freePlan, 17],
    ]) {
      const id = randomUUID();
      await c.query(
        'INSERT INTO public."Subscription" (id,"userId","planId",status,"startedAt","expiresAt","characterLimit","updatedAt") VALUES ($1,$2,$3,\'ACTIVE\',now(),now()+interval \'1 day\',$4,now())',
        [id, user, plan, chars],
      );
      await c.query(
        'INSERT INTO public."QuotaLot" (id,"subscriptionId","charactersGranted","charactersRemaining","expiresAt","updatedAt") VALUES ($1,$2,$3,$3,now()+interval \'1 day\',now())',
        [randomUUID(), id, chars],
      );
    }
    for (const status of ['PAID', 'PENDING'])
      for (const receiptStatus of ['UNMATCHED', 'RECEIVED', 'MATCHED']) {
        const id = randomUUID(),
          receiptId = randomUUID(),
          key = 'LEGACY-' + status + '-' + receiptStatus;
        await c.query(
          'INSERT INTO public."Payment" (id,"userId","planId",amount,status,provider,"paidAt","updatedAt") VALUES ($1,$2,$3,100,$4,\'BANK_TRANSFER\',CASE WHEN $4=\'PAID\' THEN now() ELSE NULL END,now())',
          [id, status === 'PAID' ? paidUser : freeUser, paidPlan, status],
        );
        await c.query(
          'INSERT INTO public."PaymentTransaction" (id,"paymentId",provider,"providerTransactionId",amount,status,"matchedAt","updatedAt") VALUES ($1,$2,\'BANK_TRANSFER\',$3,140,$4,CASE WHEN $4=\'MATCHED\' THEN now() ELSE NULL END,now())',
          [receiptId, id, key, receiptStatus],
        );
        payments.push({ id, receiptId, status, receiptStatus, key });
      }
    const paymentId = payments.find(
      (x) => x.status === 'PAID' && x.receiptStatus === 'MATCHED',
    ).id;
    const pendingHandling = randomUUID(),
      completedHandling = randomUUID();
    for (const [id, status, amount] of [
      [pendingHandling, 'PENDING', 20],
      [completedHandling, 'COMPLETED', 10],
    ])
      await c.query(
        'INSERT INTO public."PaymentSurplusHandling" (id,"paymentId",action,status,amount,currency,"idempotencyKey",note,"createdById","completedById","completedAt","updatedAt") VALUES ($1,$2,\'REFUND\',$3::"PaymentSurplusStatus",$4,\'VND\',$5,\'Synthetic legacy handling\',$6,CASE WHEN $3=\'COMPLETED\' THEN $6 ELSE NULL END,CASE WHEN $3=\'COMPLETED\' THEN now() ELSE NULL END,now())',
        [id, paymentId, status, amount, randomUUID(), admin],
      );
    await c.query('COMMIT');
    const baseline = await snapshot(c);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          synthetic: true,
          runId: p.manifest.runId,
          admin,
          paidUser,
          freeUser,
          freePlan,
          paidPlan,
          payments,
          pendingHandling,
          completedHandling,
          ...baseline,
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function fence(p) {
  const root = path.dirname(p.manifest.dataDirectory),
    b = JSON.parse(
      fs.readFileSync(path.join(root, 'legacy-baseline.json'), 'utf8'),
    );
  const c = await g.verifiedClient(p, 'writer');
  try {
    const queries = [
      [
        'INSERT_PAYMENT',
        'INSERT INTO public."Payment" (id,"userId","planId",amount,status,provider,"updatedAt") VALUES ($1,$2,$3,100,\'PENDING\',\'BANK_TRANSFER\',now())',
        [randomUUID(), b.freeUser, b.paidPlan],
      ],
      [
        'UPDATE_RECEIPT',
        'UPDATE public."PaymentTransaction" SET status=\'MATCHED\' WHERE id=$1',
        [b.payments[0].receiptId],
      ],
      [
        'DELETE_RECEIPT',
        'DELETE FROM public."PaymentTransaction" WHERE id=$1',
        [b.payments[0].receiptId],
      ],
    ];
    const results = [];
    for (const [step, sql, args] of queries) {
      let code = '';
      await c.query('BEGIN');
      try {
        await c.query(sql, args);
      } catch (e) {
        code = e.code;
      } finally {
        await c.query('ROLLBACK');
      }
      g.insist(code === '23514', 'BANK_ROLLOUT_FENCE_FAILED');
      results.push({ step, sqlstate: code });
    }
    await compare(c, b);
    fs.writeFileSync(
      path.join(root, 'expand-fence.json'),
      JSON.stringify(
        { status: 'VERIFIED', runId: p.manifest.runId, results },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  } finally {
    await c.end();
  }
}
module.exports = { snapshot, compare, create, fence };
