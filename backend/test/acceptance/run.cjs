'use strict';
// No provisioning, CREATE/DROP DATABASE, role changes or automatic cleanup.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const g = require('./guard.cjs');
const root = path.resolve(__dirname, '../..');
function child(executable, args, packet, extra = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cp = spawn(executable, args, {
      cwd: root,
      windowsHide: true,
      env: { ...g.osEnvironment(), ...extra },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      settled = true;
      cp.kill();
      reject(new Error('CHILD_TIMEOUT_OUTCOME_UNKNOWN'));
    }, 180000);
    // Always drain both streams; never forward unfiltered errors or test details.
    let count = 0,
      safeOutput = '';
    for (const stream of [cp.stdout, cp.stderr])
      stream.on('data', (data) => {
        count += data.length;
        if (count > 8 * 1024 * 1024) cp.kill();
      });
    const versionCheck = args.length === 1 && args[0] === '--version';
    if (args[0] === path.join(__dirname, 'test-worker.cjs') || versionCheck)
      cp.stdout.on('data', (data) => {
        if (safeOutput.length < 8192) safeOutput += data.toString('utf8');
      });
    const ignoreBrokenPipe = () => {};
    cp.stdin.on('error', ignoreBrokenPipe);
    cp.stdio[3].on('error', ignoreBrokenPipe);
    cp.stdin.end(JSON.stringify(packet));
    cp.stdio[3].end(JSON.stringify(packet));
    cp.once('error', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error('CHILD_START_FAILED'));
      }
    });
    cp.once('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (count > 8 * 1024 * 1024) return reject(new Error('CHILD_FAILED'));
        if (args[0] === path.join(__dirname, 'test-worker.cjs')) {
          try {
            const r = JSON.parse(safeOutput);
            if (
              Object.keys(r).sort().join(',') === 'code,readiness,status' &&
              r.status === 'UNKNOWN' &&
              r.readiness === 'NOT_READY' &&
              g.TEST_FAILURE_CODES.includes(r.code)
            ) {
              return reject(new Error(r.code));
            }
            g.insist(
              Object.keys(r).sort().join(',') ===
                'code,failed,failedCases,passed,readiness,skipped,status,total' &&
                ['VERIFIED', 'UNKNOWN'].includes(r.status) &&
                r.readiness === 'NOT_READY' &&
                r.code ===
                  (r.status === 'VERIFIED'
                    ? 'ACCEPTANCE_TEST_PASS'
                    : 'ACCEPTANCE_TEST_FAILED'),
            );
            g.insist(
              ['total', 'passed', 'failed', 'skipped'].every(
                (k) => Number.isSafeInteger(r[k]) && r[k] >= 0 && r[k] <= 1000,
              ) &&
                r.total === g.TEST_IDS.length &&
                r.passed + r.failed + r.skipped === r.total &&
                Array.isArray(r.failedCases) &&
                r.failedCases.length === r.failed &&
                new Set(r.failedCases).size === r.failedCases.length &&
                r.failedCases.every((id) => g.TEST_IDS.includes(id)),
            );
            if (r.status === 'VERIFIED')
              g.insist(
                code === 0 &&
                  r.passed === r.total &&
                  r.failed === 0 &&
                  r.skipped === 0,
              );
            else g.insist(code !== 0 && (r.failed > 0 || r.skipped > 0));
            return resolve({
              total: r.total,
              passed: r.passed,
              failed: r.failed,
              skipped: r.skipped,
              failedCases: r.failedCases,
            });
          } catch {
            return reject(new Error('TEST_REPORT_UNVERIFIED'));
          }
        }
        if (code !== 0) return reject(new Error('CHILD_FAILED'));
        if (
          versionCheck &&
          !/^pg_(?:dump|restore) \(PostgreSQL\) 17\.[0-9]+(?:\s|$)/.test(
            safeOutput,
          )
        )
          return reject(new Error('POSTGRES_BINARY_VERSION_UNVERIFIED'));
        resolve();
      }
    });
  });
}
function migrations() {
  const dir = path.join(root, 'prisma/migrations');
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  g.insist(
    names.length === 26 &&
      names[23] === '20261103000000_add_payment_surplus_handling' &&
      names[24] === '20261106000000_add_user_auth_version' &&
      names[25] === '20261106010000_add_store_verification_ledger',
    'MIGRATION_INVENTORY_CHANGED',
  );
  return { dir, names };
}
async function migration(packet) {
  const inv = migrations(),
    kind = packet.action === 'migrate-cold' ? 'cold' : 'upgrade';
  const c = await g.verifiedClient(packet, kind, 'owner');
  try {
    const exists = await c.query(
      `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present`,
    );
    if (packet.action !== 'upgrade-final') {
      g.insist(exists.rows[0].present === false, 'EMPTY_DATABASE_REQUIRED');
      const inventory = await c.query(`SELECT
        (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') +
        (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS n`);
      g.insist(
        inventory.rows.length === 1 && Number(inventory.rows[0].n) === 0,
        'EMPTY_DATABASE_REQUIRED',
      );
    } else {
      g.insist(exists.rows[0].present === true, 'UPGRADE_BASE_REQUIRED');
      const prior = await c.query(
        'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name',
      );
      g.insist(
        prior.rows.length === 24 &&
          prior.rows.every(
            (r, i) =>
              r.migration_name === inv.names[i] &&
              r.finished_at &&
              !r.rolled_back_at,
          ),
        'UPGRADE_BASE_UNVERIFIED',
      );
    }
  } finally {
    await c.end();
  }
  if (packet.action === 'upgrade-base') {
    const destination = path.join(
      'D:/text-to-voice-it',
      packet.manifest.runId,
      'migrations-base',
    );
    fs.mkdirSync(destination); // Never merge with a previous run's files.
    fs.copyFileSync(
      path.join(inv.dir, 'migration_lock.toml'),
      path.join(destination, 'migration_lock.toml'),
    );
    for (const name of inv.names.slice(0, 24)) {
      fs.mkdirSync(path.join(destination, name));
      fs.copyFileSync(
        path.join(inv.dir, name, 'migration.sql'),
        path.join(destination, name, 'migration.sql'),
      );
    }
  }
  await child(
    process.execPath,
    [
      path.join(root, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      path.join(root, 'prisma.acceptance.config.ts'),
    ],
    packet,
  );
  const post = await g.verifiedClient(packet, kind, 'owner');
  try {
    const rows = await post.query(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name',
    );
    const wanted = inv.names.slice(
      0,
      packet.action === 'upgrade-base' ? 24 : 26,
    );
    g.insist(
      rows.rows.length === wanted.length &&
        rows.rows.every(
          (r, i) =>
            r.migration_name === wanted[i] &&
            r.finished_at &&
            !r.rolled_back_at &&
            r.checksum ===
              g.hash(
                fs.readFileSync(path.join(inv.dir, wanted[i], 'migration.sql')),
              ),
        ),
      'MIGRATION_HISTORY_UNVERIFIED',
    );
    if (packet.action === 'upgrade-base') {
      // Synthetic pre-upgrade rows: no passwords, tokens or customer data.
      await post.query('BEGIN');
      await post.query(
        `INSERT INTO "User" (id,email,"updatedAt") VALUES ($1,$2,NOW())`,
        [packet.manifest.runId, 'upgrade@example.invalid'],
      );
      await post.query(
        `INSERT INTO "Plan" (id,code,name,price,"durationDays","characterLimit","updatedAt") VALUES ($1,'BASIC','Synthetic',100,7,173,NOW())`,
        [packet.manifest.runId],
      );
      await post.query(
        `INSERT INTO "Subscription" (id,"userId","planId","startedAt","expiresAt",status,"characterLimit","updatedAt") VALUES ($1,$1,$1,NOW(),NOW()+interval '7 days','ACTIVE',173,NOW())`,
        [packet.manifest.runId],
      );
      await post.query('COMMIT');
    }
    if (packet.action === 'upgrade-final') {
      const row = await post.query(
        `SELECT u."authVersion",s."billingSource",s."characterLimit",p.price FROM "User" u JOIN "Subscription" s ON s."userId"=u.id JOIN "Plan" p ON p.id=s."planId" WHERE u.id=$1`,
        [packet.manifest.runId],
      );
      g.insist(
        row.rows.length === 1 &&
          row.rows[0].authVersion === 0 &&
          row.rows[0].billingSource === 'WEB' &&
          row.rows[0].characterLimit === 173 &&
          row.rows[0].price === 100,
        'UPGRADE_DATA_CHANGED',
      );
    }
  } finally {
    await post.end();
  }
}
async function backup(packet) {
  const source = await g.verifiedClient(packet, 'cold', 'owner');
  try {
    const synthetic = await source.query(
      `SELECT count(*)::int AS n, bool_and(email LIKE '%@example.invalid') AS safe FROM public."User"`,
    );
    g.insist(
      synthetic.rows[0].n > 0 &&
        synthetic.rows[0].n <= 500 &&
        synthetic.rows[0].safe === true,
      'SYNTHETIC_DATA_UNVERIFIED',
    );
  } finally {
    await source.end();
  }
  const destination = await g.verifiedClient(packet, 'restored', 'owner');
  try {
    const tables = await destination.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
    );
    g.insist(tables.rows[0].n === 0, 'RESTORE_DESTINATION_NOT_EMPTY');
  } finally {
    await destination.end();
  }
  const file = path.join(
    'D:/text-to-voice-it',
    packet.manifest.runId,
    'synthetic.dump',
  );
  g.insist(!fs.existsSync(file), 'BACKUP_ALREADY_EXISTS');
  const bin = 'C:/Program Files/PostgreSQL/17/bin';
  for (const binary of ['pg_dump.exe', 'pg_restore.exe'])
    await child(path.join(bin, binary), ['--version'], packet);
  const url = new URL(packet.credentials.owner),
    role = packet.manifest.roles.owner.name;
  const common = [
    '--host=127.0.0.1',
    '--port=56432',
    `--username=${role}`,
    '--no-password',
  ];
  const secretEnv = {
    PGPASSWORD: decodeURIComponent(url.password),
    PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c statement_timeout=60000 -c lock_timeout=5000',
  };
  await child(
    path.join(bin, 'pg_dump.exe'),
    [
      ...common,
      '--format=custom',
      '--file=' + file,
      '--dbname=' + packet.manifest.databases.cold.name,
    ],
    packet,
    secretEnv,
  );
  const checksum = g.hash(fs.readFileSync(file));
  const again = await g.verifiedClient(packet, 'restored', 'owner');
  await again.end();
  g.insist(g.hash(fs.readFileSync(file)) === checksum, 'ARCHIVE_CHANGED');
  await child(
    path.join(bin, 'pg_restore.exe'),
    [
      ...common,
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--dbname=' + packet.manifest.databases.restored.name,
      file,
    ],
    packet,
    secretEnv,
  );
  // Compare counts and checksums without exposing table contents.
  async function digest(kind) {
    const c = await g.verifiedClient(packet, kind, 'reader');
    try {
      await c.query('BEGIN READ ONLY');
      const result = [];
      const schema = fs.readFileSync(
        path.join(root, 'prisma/schema.prisma'),
        'utf8',
      );
      const tables = [
        ...schema.matchAll(/^model ([A-Za-z][A-Za-z0-9_]*)\s*\{/gm),
      ]
        .map((m) => m[1])
        .sort();
      const inventory = await c.query(
        `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`,
      );
      g.insist(
        JSON.stringify(inventory.rows.map((r) => r.relname).sort()) ===
          JSON.stringify([...tables, '_prisma_migrations'].sort()),
        'RESTORE_INVENTORY_MISMATCH',
      );
      for (const table of tables) {
        const limit = await c.query(
          `SELECT count(*)::int AS n FROM public."${table}"`,
        );
        g.insist(limit.rows[0].n <= 10000, 'RESTORE_ROW_LIMIT');
        const r = await c.query(
          `SELECT count(*)::text AS n, md5(COALESCE(string_agg(row_to_json(t)::text, '' ORDER BY t.id),'')) AS digest FROM public."${table}" t`,
        );
        result.push(r.rows[0]);
      }
      const history = await c.query(
        'SELECT migration_name,checksum,finished_at,rolled_back_at,applied_steps_count FROM public._prisma_migrations ORDER BY migration_name',
      );
      g.insist(
        history.rows.length === 26 &&
          history.rows.every((r) => r.finished_at && !r.rolled_back_at),
        'RESTORE_MIGRATION_UNVERIFIED',
      );
      result.push({ migrationDigest: g.hash(JSON.stringify(history.rows)) });
      await c.query('ROLLBACK');
      return JSON.stringify(result);
    } finally {
      await c.end();
    }
  }
  g.insist(
    (await digest('cold')) === (await digest('restored')),
    'RESTORE_DATA_MISMATCH',
  );
}
async function main() {
  const p = g.readPacket();
  currentAction = p.action;
  let tests;
  if (p.action === 'test')
    tests = await child(
      process.execPath,
      [path.join(__dirname, 'test-worker.cjs')],
      p,
    );
  else if (p.action === 'backup-restore') await backup(p);
  else await migration(p);
  const passed = !tests || (tests.failed === 0 && tests.skipped === 0);
  if (!passed) process.exitCode = 1;
  process.stdout.write(
    JSON.stringify({
      status: passed ? 'VERIFIED' : 'UNKNOWN',
      readiness: 'NOT_READY',
      action: p.action,
      code: passed ? 'ACCEPTANCE_STEP_PASS' : 'ACCEPTANCE_TEST_FAILED',
      ...(tests ? { tests } : {}),
    }),
  );
}
let currentAction = null;
module.exports = { child, migration, backup, migrations };
if (require.main === module)
  main().catch((error) => {
    const codes = [
      ...g.TEST_FAILURE_CODES,
      'INHERITED_CONFIGURATION_REFUSED',
      'APPROVAL_REQUIRED',
      'IDENTITY_UNVERIFIED',
      'URL_VALIDATION_FAILED',
      'CHILD_TIMEOUT_OUTCOME_UNKNOWN',
      'CHILD_START_FAILED',
      'CHILD_FAILED',
      'MIGRATION_HISTORY_UNVERIFIED',
      'UPGRADE_DATA_CHANGED',
      'RESTORE_DATA_MISMATCH',
    ];
    process.stdout.write(
      JSON.stringify({
        status: 'UNKNOWN',
        readiness: 'NOT_READY',
        action: currentAction,
        code: codes.includes(error?.message)
          ? error.message
          : 'ACCEPTANCE_STEP_FAILED',
      }),
    );
    process.exitCode = 1;
  });
