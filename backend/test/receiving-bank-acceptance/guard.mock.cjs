'use strict';
// Synthetic fixtures only. No pg.Client is instantiated or network opened.
const { test } = require('node:test'),
  a = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const g = require('./guard.cjs');
const runId = '12345678-1234-4123-8123-123456789abc';
function packet() {
  return {
    manifest: {
      version: 1,
      runId,
      clusterId: '8000000000000000000',
      dataDirectory: 'D:/text-to-voice-bank-it/' + runId + '/pgdata',
      roles: Object.fromEntries(
        ['owner', 'writer', 'reader'].map((r, i) => [
          r,
          { name: 'ttv_bank_' + r + '_12345678', oid: String(20000 + i) },
        ]),
      ),
      database: {
        name: 'ttv_bank_it_' + runId.replaceAll('-', ''),
        oid: '20003',
        ownerOid: '20000',
        markerSha256: g.hash('synthetic-marker'),
      },
    },
    credentials: Object.fromEntries(
      ['owner', 'writer', 'reader'].map((r) => [
        r,
        'postgresql://ttv_bank_' +
          r +
          '_12345678:synthetic-only@127.0.0.1:61432/postgres',
      ]),
    ),
    action: 'test',
    approval: 'APPROVE ' + runId + ' test',
  };
}
function identity(p, role = 'owner') {
  return {
    db: p.manifest.database.name,
    role: p.manifest.roles[role].name,
    session_role: p.manifest.roles[role].name,
    host: '127.0.0.1',
    port: '61432',
    cluster: p.manifest.clusterId,
    directory: p.manifest.dataDirectory,
    version: '170011',
    ro: 'on',
    oid: '20003',
    owner_oid: '20000',
    role_oid: p.manifest.roles[role].oid,
    marker: 'synthetic-marker',
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  };
}
test('valid isolated synthetic packet', () => {
  a.equal(g.validate(packet(), {}).action, 'test');
});
test('reader defaults to READ ONLY outside explicit snapshot helpers', () => {
  a.equal(
    g.connection(packet(), 'reader').options,
    '-c default_transaction_read_only=on',
  );
});
for (const port of [5432, 55432, 56432, 57432, 58432, 59432, 60432, 61433])
  test('reject port ' + port, () => {
    const p = packet();
    p.credentials.writer = p.credentials.writer.replace(':61432', ':' + port);
    a.throws(() => g.validate(p, {}));
  });
for (const key of [
  'DATABASE_URL',
  'DIRECT_URL',
  'SHADOW_DATABASE_URL',
  'PGHOST',
  'PGPASSWORD',
  'NODE_OPTIONS',
  'NODE_PATH',
])
  test('reject inherited ' + key, () =>
    a.throws(() => g.validate(packet(), { [key]: 'synthetic' })),
  );
for (const field of [
  'approval',
  'action',
  'directory',
  'role',
  'oid',
  'owner',
  'marker',
  'extra',
])
  test('reject bad packet ' + field, () => {
    const p = packet();
    if (field === 'approval') p.approval = 'old';
    if (field === 'action') p.action = 'cleanup';
    if (field === 'directory')
      p.manifest.dataDirectory = 'D:/text-to-voice/pg-test-cluster';
    if (field === 'role') p.manifest.roles.writer.name = 'postgres';
    if (field === 'oid')
      p.manifest.roles.writer.oid = p.manifest.roles.reader.oid;
    if (field === 'owner') p.manifest.database.ownerOid = '10';
    if (field === 'marker') p.manifest.database.markerSha256 = 'x';
    if (field === 'extra') p.extra = true;
    a.throws(() => g.validate(p, {}));
  });
for (const cluster of [
  '7703979600700924132',
  '7705385611083166840',
  '7707309925263158624',
])
  test('reject existing cluster ' + cluster, () => {
    const p = packet();
    p.manifest.clusterId = cluster;
    a.throws(() => g.validate(p, {}));
  });
for (const field of [
  'db',
  'role',
  'session_role',
  'host',
  'port',
  'cluster',
  'directory',
  'version',
  'ro',
  'oid',
  'owner_oid',
  'role_oid',
  'marker',
  'rolsuper',
  'rolcreatedb',
  'rolcreaterole',
  'rolreplication',
  'rolbypassrls',
])
  test('identity fails closed ' + field, () => {
    const p = packet(),
      r = identity(p);
    r[field] = typeof r[field] === 'boolean' ? true : 'MISMATCH';
    a.throws(() => g.compare(r, p, 'owner'), /BANK_IDENTITY_UNVERIFIED/);
  });
test('verified client begins READ ONLY before identity; reader denied writes', async () => {
  const p = packet(),
    queries = [];
  let closed = false;
  class Mock {
    async connect() {}
    async query(q) {
      queries.push(q);
      if (q.startsWith('SELECT current_database'))
        return { rows: [identity(p, 'reader')] };
      if (q.startsWith('SELECT NOT')) return { rows: [{ safe: false }] };
      return { rows: [] };
    }
    async end() {
      closed = true;
    }
  }
  await a.rejects(
    g.verifiedClient(p, 'reader', Mock),
    /BANK_READER_WRITE_CAPABILITY/,
  );
  a.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  a.equal(closed, true);
});
test('timeout closes client and never produces VERIFIED', async () => {
  let closed = false;
  class Mock {
    async connect() {}
    async query() {
      throw new Error('synthetic-timeout');
    }
    async end() {
      closed = true;
    }
  }
  await a.rejects(g.verifiedClient(packet(), 'owner', Mock));
  a.equal(closed, true);
});
function result() {
  return {
    success: true,
    numTotalTests: 18,
    numPassedTests: 18,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [
      {
        testResults: g.IDS.map((id) => ({
          title: id + ' synthetic',
          status: 'passed',
        })),
      },
    ],
  };
}
test('all mandatory cases required; readiness never READY', () => {
  const r = g.summary(result());
  a.equal(r.status, 'VERIFIED');
  a.equal(r.readiness, 'NOT_READY');
});
for (const kind of ['missing', 'duplicate', 'skipped', 'failed'])
  test('reject incomplete result ' + kind, () => {
    const r = result();
    if (kind === 'missing') r.testResults[0].testResults.pop();
    if (kind === 'duplicate')
      r.testResults[0].testResults[0].title = 'BANK02 duplicate';
    if (kind === 'skipped') r.numPendingTests = 1;
    if (kind === 'failed') r.success = false;
    a.equal(g.summary(r).status, 'UNKNOWN');
  });
test('only dedicated test selected, no inherited old runner', () => {
  const c = require('./jest.config.cjs');
  a.deepEqual(c.testMatch, [
    '<rootDir>/test/receiving-bank-acceptance/integration.bank.ts',
  ]);
  const s = fs.readFileSync(
    path.join(__dirname, 'integration.bank.ts'),
    'utf8',
  );
  for (const id of g.IDS)
    a.equal(
      (s.match(new RegExp("scenario\\(\\s*'" + id + ' ', 'g')) || []).length,
      1,
    );
  a.match(s, /pg_blocking_pids/);
  a.match(s, /wait_event_type='Lock'/);
});
test('output summary excludes synthetic sentinel exceptions', () => {
  const r = result();
  r.rawException = 'SENSITIVE_SENTINEL';
  a.equal(JSON.stringify(g.summary(r)).includes('SENSITIVE_SENTINEL'), false);
});

test('corrective migration changes only the conflicting variable, retaining all policy checks', () => {
  const old = fs.readFileSync(
    path.join(
      __dirname,
      '../../prisma/migrations/20261113010000_enforce_receiving_bank_policy/migration.sql',
    ),
    'utf8',
  );
  const fix = fs.readFileSync(
    path.join(
      __dirname,
      '../../prisma/migrations/20261114000000_fix_bank_payment_guard_alias/migration.sql',
    ),
    'utf8',
  );
  const original = old
    .slice(
      old.indexOf('CREATE FUNCTION "bank_payment_guard"'),
      old.indexOf('CREATE TRIGGER "Payment_bank_guard"'),
    )
    .trim();
  const replacement = fix
    .slice(
      fix.indexOf('CREATE OR REPLACE FUNCTION'),
      fix.lastIndexOf('COMMIT;'),
    )
    .trim();
  a.equal(
    replacement
      .replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
      .replaceAll('target_account', 'a'),
    original,
  );
  a.match(fix, /BEGIN;/);
  a.match(fix, /lock_timeout/);
  a.match(fix, /COMMIT;/);
  a.doesNotMatch(replacement, /DECLARE a /);
});
test('failure summary distinguishes the first failure from stopped cases without leaking messages', () => {
  const r = result();
  r.success = false;
  r.numPassedTests = 5;
  r.numFailedTests = 13;
  r.testResults[0].testResults.forEach((t, i) => {
    if (i >= 5) {
      t.status = 'failed';
      t.failureMessages = [
        i === 5 ? 'SENSITIVE_SENTINEL' : 'BANK_STOPPED_AFTER_FAILURE',
      ];
    }
  });
  const s = g.summary(r);
  a.equal(s.firstFailedCase, 'BANK06');
  a.equal(s.blockedCases.length, 12);
  a.equal(JSON.stringify(s).includes('SENSITIVE_SENTINEL'), false);
});
test('cold and enforcement stages require the new corrective migration', () => {
  const s = fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8');
  a.match(s, /all.length === 29/);
  a.match(s, /enforce: 29, cold: 29/);
  a.match(s, /20261114000000_fix_bank_payment_guard_alias/);
});
