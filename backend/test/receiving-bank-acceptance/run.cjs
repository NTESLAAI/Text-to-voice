'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { spawn } = require('node:child_process'),
  g = require('./guard.cjs'),
  legacy = require('./legacy.cjs');
let phase = 'CONFIGURATION';
function child(file, args, p) {
  return new Promise((resolve, reject) => {
    let out = '',
      err = '',
      done = false;
    const c = spawn(process.execPath, [file, ...args], {
      cwd: path.resolve(__dirname, '../..'),
      env: g.osEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      c.kill();
      finish(new Error('BANK_CHILD_TIMEOUT_OUTCOME_UNKNOWN'));
    }, 240000);
    function finish(e, v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      e ? reject(e) : resolve(v);
    }
    for (const s of [c.stdin, c.stdio[3]]) s.on('error', () => {});
    c.stdout.on('data', (b) => {
      out += b;
      if (out.length > 8e6) {
        c.kill();
        finish(new Error('BANK_OUTPUT_LIMIT'));
      }
    });
    c.stderr.on('data', (b) => {
      err += b;
      if (err.length > 8e6) {
        c.kill();
        finish(new Error('BANK_OUTPUT_LIMIT'));
      }
    });
    c.on('error', () => finish(new Error('BANK_CHILD_START_FAILED')));
    c.on('close', (code) => finish(null, { code, out, err }));
    for (const s of [c.stdin, c.stdio[3]]) s.end(JSON.stringify(p));
  });
}
(async () => {
  const p = g.readPacket(),
    root = path.dirname(p.manifest.dataDirectory);
  phase = 'IDENTITY';
  let c = await g.verifiedClient(p, 'owner');
  if (p.action === 'legacy') {
    try {
      await legacy.create(p, c);
    } finally {
      await c.end();
    }
    process.stdout.write(
      JSON.stringify({
        status: 'VERIFIED',
        readiness: 'NOT_READY',
        code: 'BANK_LEGACY_FIXTURE_PASS',
      }),
    );
    return;
  }
  if (p.action === 'test') {
    await c.end();
    phase = 'INTEGRATION';
    const result = await child(path.join(__dirname, 'worker.cjs'), [], p);
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
          'firstFailedCase',
          'blockedCases',
        ].includes(k),
      ) &&
        r.readiness === 'NOT_READY' &&
        ['BANK_TEST_PASS', 'BANK_TEST_FAILED', 'BANK_WORKER_FAILED'].includes(
          r.code,
        ),
    );
    if (r.code !== 'BANK_WORKER_FAILED') {
      g.insist(
        (r.firstFailedCase === null || g.IDS.includes(r.firstFailedCase)) &&
          Array.isArray(r.blockedCases) &&
          new Set(r.blockedCases).size === r.blockedCases.length &&
          r.blockedCases.every(
            (id) => g.IDS.includes(id) && r.failedCases.includes(id),
          ) &&
          !r.blockedCases.includes(r.firstFailedCase),
      );
    }
    if (r.status === 'VERIFIED')
      g.insist(
        result.code === 0 &&
          r.total === 18 &&
          r.passed === 18 &&
          r.failed === 0 &&
          r.skipped === 0 &&
          r.failedCases.length === 0,
      );
    else process.exitCode = 1;
    process.stdout.write(JSON.stringify(r));
    return;
  }
  phase = 'MIGRATION_PREFLIGHT';
  const dir = path.resolve(__dirname, '../../prisma/migrations'),
    all = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort();
  g.insist(
    all.length === 29 &&
      all[26] === '20261113000000_add_receiving_bank_account' &&
      all[27] === '20261113010000_enforce_receiving_bank_policy' &&
      all[28] === '20261114000000_fix_bank_payment_guard_alias',
  );
  const count = { base: 26, expand: 27, enforce: 29, cold: 29 }[p.action];
  g.insist(count);
  try {
    if (['base', 'cold'].includes(p.action))
      g.insist(
        (
          await c.query(
            "SELECT count(*)::integer AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'",
          )
        ).rows[0].n === 0,
      );
    else {
      const n = (
        await c.query(
          'SELECT count(*)::integer AS n FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
        )
      ).rows[0].n;
      g.insist(n === (p.action === 'expand' ? 26 : 27));
      const baseline = JSON.parse(
        fs.readFileSync(path.join(root, 'legacy-baseline.json'), 'utf8'),
      );
      await legacy.compare(c, baseline);
      if (p.action === 'enforce')
        g.insist(
          JSON.parse(
            fs.readFileSync(path.join(root, 'expand-fence.json'), 'utf8'),
          ).status === 'VERIFIED',
        );
    }
  } finally {
    await c.end();
  }
  const stage = path.join(root, 'migrations-' + p.action);
  g.insist(!fs.existsSync(stage));
  fs.mkdirSync(stage);
  fs.writeFileSync(
    path.join(stage, 'migration_lock.toml'),
    'provider = "postgresql"\n',
    { flag: 'wx' },
  );
  for (const name of all.slice(0, count)) {
    fs.mkdirSync(path.join(stage, name));
    fs.copyFileSync(
      path.join(dir, name, 'migration.sql'),
      path.join(stage, name, 'migration.sql'),
      fs.constants.COPYFILE_EXCL,
    );
  }
  phase = 'MIGRATION_EXECUTION';
  const result = await child(
    path.resolve(__dirname, '../../node_modules/prisma/build/index.js'),
    ['migrate', 'deploy', '--config', path.join(__dirname, 'prisma.config.ts')],
    p,
  );
  if (result.code !== 0) {
    const known = /P30(?:18|09|06)/.exec(result.err)?.[0] || null;
    const db = /Database error code:\s*([0-9A-Z]{5})/.exec(result.err)?.[1];
    process.stdout.write(
      JSON.stringify({
        status: 'UNKNOWN',
        readiness: 'NOT_READY',
        code: 'BANK_MIGRATION_FAILED',
        phase,
        stage: p.action,
        prismaCode: known,
        sqlstate: [
          '23514',
          '42601',
          '42703',
          '42883',
          '42501',
          '55P03',
          '57014',
        ].includes(db)
          ? db
          : null,
      }),
    );
    process.exitCode = 1;
    return;
  }
  phase = 'MIGRATION_POSTCHECK';
  c = await g.verifiedClient(p, 'owner');
  try {
    const rows = (
      await c.query(
        'SELECT migration_name,checksum,finished_at,rolled_back_at FROM public."_prisma_migrations" ORDER BY migration_name',
      )
    ).rows;
    g.insist(
      rows.length === count &&
        rows.every(
          (r, i) =>
            r.migration_name === all[i] &&
            r.finished_at &&
            !r.rolled_back_at &&
            r.checksum ===
              g.hash(
                fs.readFileSync(
                  path.join(dir, r.migration_name, 'migration.sql'),
                ),
              ),
        ),
    );
    if (['expand', 'enforce'].includes(p.action))
      await legacy.compare(
        c,
        JSON.parse(
          fs.readFileSync(path.join(root, 'legacy-baseline.json'), 'utf8'),
        ),
      );
  } finally {
    await c.end();
  }
  if (p.action === 'expand') await legacy.fence(p);
  process.stdout.write(
    JSON.stringify({
      status: 'VERIFIED',
      readiness: 'NOT_READY',
      code: 'BANK_MIGRATION_PASS',
      stage: p.action,
      migrations: count,
    }),
  );
})().catch((e) => {
  const allow = [
    'BANK_CONFIGURATION_REFUSED',
    'BANK_IDENTITY_UNVERIFIED',
    'BANK_READER_WRITE_CAPABILITY',
    'BANK_LEGACY_CHANGED',
    'BANK_ROLLOUT_FENCE_FAILED',
    'BANK_CHILD_TIMEOUT_OUTCOME_UNKNOWN',
  ];
  process.stdout.write(
    JSON.stringify({
      status: 'UNKNOWN',
      readiness: 'NOT_READY',
      code: allow.includes(e?.message) ? e.message : 'BANK_STEP_FAILED',
      phase,
    }),
  );
  process.exitCode = 1;
});
