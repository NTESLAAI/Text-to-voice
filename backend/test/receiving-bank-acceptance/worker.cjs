'use strict';
const g = require('./guard.cjs'),
  path = require('node:path');
(async () => {
  const p = g.readPacket();
  g.insist(p.action === 'test');
  for (const role of ['writer', 'reader']) {
    const c = await g.verifiedClient(p, role);
    try {
      if (role === 'writer') {
        const r = await c.query(
          'SELECT count(*)::integer AS n FROM public."User"',
        );
        g.insist(r.rows[0].n === 3, 'BANK_DATABASE_NOT_EMPTY');
      }
    } finally {
      await c.end();
    }
  }
  const { results } = await require('jest').runCLI(
    {
      config: path.join(__dirname, 'jest.config.cjs'),
      runInBand: true,
      silent: true,
    },
    [path.join(__dirname, 'jest.config.cjs')],
  );
  const report = g.summary(results);
  process.stdout.write(JSON.stringify(report));
  if (report.status !== 'VERIFIED') process.exitCode = 1;
})().catch(() => {
  process.stdout.write(
    JSON.stringify({
      status: 'UNKNOWN',
      readiness: 'NOT_READY',
      code: 'BANK_WORKER_FAILED',
    }),
  );
  process.exitCode = 1;
});
