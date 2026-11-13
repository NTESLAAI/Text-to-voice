'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { spawn } = require('node:child_process'),
  g = require('./guard.cjs');
async function child(file, args, p, timeout = 180000) {
  return new Promise((resolve, reject) => {
    let out = '',
      err = '',
      settled = false;
    const c = spawn(process.execPath, [file, ...args], {
      cwd: path.resolve(__dirname, '../..'),
      env: g.osEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      c.kill();
      finish(new Error('RCR_CHILD_TIMEOUT_OUTCOME_UNKNOWN'));
    }, timeout);
    for (const s of [c.stdin, c.stdio[3]]) s.on('error', () => {});
    c.stdout.on('data', (b) => {
      out += b;
      if (out.length > 8 * 1024 * 1024) {
        c.kill();
        finish(new Error('RCR_CHILD_OUTPUT_LIMIT'));
      }
    });
    c.stderr.on('data', (b) => {
      err += b;
      if (err.length > 8 * 1024 * 1024) {
        c.kill();
        finish(new Error('RCR_CHILD_OUTPUT_LIMIT'));
      }
    });
    c.once('error', () => finish(new Error('RCR_CHILD_START_FAILED')));
    c.once('close', (code) => finish(null, { code, out, err }));
    c.stdin.end(JSON.stringify(p));
    c.stdio[3].end(JSON.stringify(p));
  });
}
(async () => {
  const p = g.readPacket();
  let c = await g.verifiedClient(p, 'owner');
  try {
    const rows = await c.query(
      "SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'",
    );
    if (p.action === 'migrate')
      g.insist(rows.rowCount === 0, 'RCR_DATABASE_NOT_EMPTY');
  } finally {
    await c.end();
  }
  if (p.action === 'migrate') {
    const dir = path.resolve(__dirname, '../../prisma/migrations');
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    g.insist(names.length === 26, 'RCR_MIGRATION_INVENTORY_CHANGED');
    const result = await child(
      path.resolve(__dirname, '../../node_modules/prisma/build/index.js'),
      [
        'migrate',
        'deploy',
        '--config',
        path.join(__dirname, 'prisma.config.ts'),
      ],
      p,
    );
    g.insist(result.code === 0, 'RCR_MIGRATION_FAILED');
    c = await g.verifiedClient(p, 'owner');
    try {
      const rows = (
        await c.query(
          'SELECT migration_name,checksum,finished_at,rolled_back_at FROM public."_prisma_migrations" ORDER BY migration_name',
        )
      ).rows;
      g.insist(
        rows.length === 26 &&
          rows.every(
            (r, i) =>
              r.migration_name === names[i] &&
              r.finished_at &&
              !r.rolled_back_at &&
              r.checksum ===
                g.hash(
                  fs.readFileSync(
                    path.join(dir, r.migration_name, 'migration.sql'),
                  ),
                ),
          ),
        'RCR_MIGRATION_HISTORY_FAILED',
      );
    } finally {
      await c.end();
    }
    process.stdout.write(
      JSON.stringify({
        status: 'VERIFIED',
        readiness: 'NOT_READY',
        code: 'RCR_MIGRATION_PASS',
        migrations: 26,
      }),
    );
  } else {
    const result = await child(
      path.join(__dirname, 'worker.cjs'),
      [],
      p,
      210000,
    );
    const r = JSON.parse(result.out);
    g.insist(
      Object.keys(r).every((k) =>
        [
          'status',
          'readiness',
          'code',
          'total',
          'passed',
          'failed',
          'skipped',
          'failedCases',
        ].includes(k),
      ) &&
        r.readiness === 'NOT_READY' &&
        ['VERIFIED', 'UNKNOWN'].includes(r.status) &&
        ['RCR_TEST_PASS', 'RCR_TEST_FAILED', 'RCR_WORKER_FAILED'].includes(
          r.code,
        ),
      'RCR_REPORT_UNVERIFIED',
    );
    if (r.status === 'VERIFIED')
      g.insist(
        result.code === 0 &&
          r.total === 12 &&
          r.passed === 12 &&
          r.failed === 0 &&
          r.skipped === 0 &&
          Array.isArray(r.failedCases) &&
          r.failedCases.length === 0,
        'RCR_REPORT_UNVERIFIED',
      );
    else {
      g.insist(
        !r.failedCases ||
          (Array.isArray(r.failedCases) &&
            r.failedCases.every((id) => g.IDS.includes(id))),
        'RCR_REPORT_UNVERIFIED',
      );
      process.exitCode = 1;
    }
    process.stdout.write(JSON.stringify(r));
  }
})().catch((e) => {
  const allowed = [
    'RCR_CONFIGURATION_REFUSED',
    'RCR_INHERITED_CONFIGURATION_REFUSED',
    'RCR_APPROVAL_REFUSED',
    'RCR_URL_REFUSED',
    'RCR_IDENTITY_UNVERIFIED',
    'RCR_READER_WRITE_CAPABILITY',
    'RCR_DATABASE_NOT_EMPTY',
    'RCR_MIGRATION_INVENTORY_CHANGED',
    'RCR_MIGRATION_FAILED',
    'RCR_MIGRATION_HISTORY_FAILED',
    'RCR_CHILD_TIMEOUT_OUTCOME_UNKNOWN',
    'RCR_CHILD_START_FAILED',
    'RCR_CHILD_OUTPUT_LIMIT',
    'RCR_REPORT_UNVERIFIED',
  ];
  process.stdout.write(
    JSON.stringify({
      status: 'UNKNOWN',
      readiness: 'NOT_READY',
      code: allowed.includes(e?.message) ? e.message : 'RCR_RUN_FAILED',
    }),
  );
  process.exitCode = 1;
});
