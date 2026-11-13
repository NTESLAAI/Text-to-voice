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
      dataDirectory: 'D:/text-to-voice-rc17-it/' + runId + '/pgdata',
      roles: Object.fromEntries(
        ['owner', 'writer', 'reader'].map((r, i) => [
          r,
          { name: 'ttv_rcr_' + r + '_12345678', oid: String(20000 + i) },
        ]),
      ),
      database: {
        name: 'ttv_rcr_it_' + runId.replaceAll('-', ''),
        oid: '20003',
        ownerOid: '20000',
        markerSha256: g.hash('synthetic-marker'),
      },
    },
    credentials: Object.fromEntries(
      ['owner', 'writer', 'reader'].map((r) => [
        r,
        'postgresql://ttv_rcr_' +
          r +
          '_12345678:synthetic-only@127.0.0.1:58432/postgres',
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
    port: '58432',
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
for (const port of [5432, 55432, 56432, 57432, 58433])
  test('reject port ' + port, () => {
    const p = packet();
    p.credentials.writer = p.credentials.writer.replace(':58432', ':' + port);
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
    a.throws(() => g.compare(r, p, 'owner'), /RCR_IDENTITY_UNVERIFIED/);
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
    /RCR_READER_WRITE_CAPABILITY/,
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
    numTotalTests: 12,
    numPassedTests: 12,
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
      r.testResults[0].testResults[0].title = 'RCR02 duplicate';
    if (kind === 'skipped') r.numPendingTests = 1;
    if (kind === 'failed') r.success = false;
    a.equal(g.summary(r).status, 'UNKNOWN');
  });
test('only dedicated test selected, no inherited old runner', () => {
  const c = require('./jest.config.cjs');
  a.deepEqual(c.testMatch, [
    '<rootDir>/test/rc17-acceptance/integration.rc17.ts',
  ]);
  const s = fs.readFileSync(
    path.join(__dirname, 'integration.rc17.ts'),
    'utf8',
  );
  for (const id of g.IDS)
    a.equal((s.match(new RegExp("it\\('" + id + ' ', 'g')) || []).length, 1);
  a.match(s, /pg_blocking_pids/);
  a.match(s, /wait_event_type='Lock'/);
});
test('output summary excludes synthetic sentinel exceptions', () => {
  const r = result();
  r.rawException = 'SENSITIVE_SENTINEL';
  a.equal(JSON.stringify(g.summary(r)).includes('SENSITIVE_SENTINEL'), false);
});
