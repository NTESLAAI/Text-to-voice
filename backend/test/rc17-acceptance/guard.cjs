'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const IDS = Object.freeze(
  Array.from({ length: 12 }, (_, i) => 'RCR' + String(i + 1).padStart(2, '0')),
);
const normalize = (s) =>
  String(s).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
function insist(ok, code = 'RCR_CONFIGURATION_REFUSED') {
  if (!ok) throw new Error(code);
}
function exact(x, keys) {
  insist(
    x &&
      typeof x === 'object' &&
      !Array.isArray(x) &&
      Object.keys(x).length === keys.length &&
      keys.every((k) => Object.hasOwn(x, k)),
  );
}
const oid = (s) =>
  typeof s === 'string' &&
  /^[1-9][0-9]{0,9}$/.test(s) &&
  BigInt(s) <= 4294967295n;
function validate(p, env = process.env) {
  insist(
    !Object.keys(env).some((k) =>
      /^(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|PG.*|NODE_OPTIONS|NODE_PATH)$/i.test(
        k,
      ),
    ),
    'RCR_INHERITED_CONFIGURATION_REFUSED',
  );
  exact(p, ['manifest', 'credentials', 'action', 'approval']);
  const m = p.manifest;
  exact(m, [
    'version',
    'runId',
    'clusterId',
    'dataDirectory',
    'roles',
    'database',
  ]);
  insist(
    m.version === 1 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        m.runId,
      ),
  );
  insist(
    typeof m.clusterId === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(m.clusterId) &&
      BigInt(m.clusterId) <= 18446744073709551615n &&
      ![
        '7703979600700924132',
        '7705385611083166840',
        '7707309925263158624',
        '7707317834512280392',
      ].includes(m.clusterId),
  );
  insist(
    normalize(m.dataDirectory) ===
      'd:/text-to-voice-rc17-it/' + m.runId + '/pgdata',
  );
  insist(
    ['migrate', 'test'].includes(p.action) &&
      p.approval === 'APPROVE ' + m.runId + ' ' + p.action,
    'RCR_APPROVAL_REFUSED',
  );
  exact(m.roles, ['owner', 'writer', 'reader']);
  exact(p.credentials, ['owner', 'writer', 'reader']);
  for (const r of ['owner', 'writer', 'reader']) {
    exact(m.roles[r], ['name', 'oid']);
    insist(
      m.roles[r].name === 'ttv_rcr_' + r + '_' + m.runId.slice(0, 8) &&
        oid(m.roles[r].oid),
    );
    const raw = p.credentials[r];
    insist(
      typeof raw === 'string' && raw.length < 4096 && !/[\s\\]/.test(raw),
      'RCR_URL_REFUSED',
    );
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('RCR_URL_REFUSED');
    }
    insist(
      ['postgres:', 'postgresql:'].includes(u.protocol) &&
        u.hostname === '127.0.0.1' &&
        u.port === '58432' &&
        u.pathname === '/postgres' &&
        !u.search &&
        !u.hash &&
        decodeURIComponent(u.username) === m.roles[r].name &&
        Boolean(u.password),
      'RCR_URL_REFUSED',
    );
  }
  insist(new Set(Object.values(m.roles).map((r) => r.oid)).size === 3);
  exact(m.database, ['name', 'oid', 'ownerOid', 'markerSha256']);
  insist(
    m.database.name === 'ttv_rcr_it_' + m.runId.replaceAll('-', '') &&
      oid(m.database.oid) &&
      m.database.ownerOid === m.roles.owner.oid &&
      /^[0-9a-f]{64}$/.test(m.database.markerSha256),
  );
  return p;
}
function osEnvironment() {
  const allowed = new Set([
    'SYSTEMROOT',
    'WINDIR',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'COMSPEC',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => allowed.has(k.toUpperCase())),
  );
}
function connection(p, role) {
  validate(p);
  insist(['owner', 'writer', 'reader'].includes(role));
  const u = new URL(p.credentials[role]);
  u.pathname = '/' + p.manifest.database.name;
  return {
    connectionString: u.toString(),
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    statement_timeout: 10000,
    lock_timeout: 8000,
    application_name: 'ttv-rcr:' + p.manifest.runId + ':' + role,
  };
}
const identitySQL = `SELECT current_database() AS db,current_user AS role,session_user AS session_role,
 host(inet_server_addr()) AS host,inet_server_port()::text AS port,
 (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
 current_setting('data_directory') AS directory,current_setting('server_version_num') AS version,
 current_setting('transaction_read_only') AS ro,d.oid::text AS oid,d.datdba::text AS owner_oid,
 r.oid::text AS role_oid,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
 pg_catalog.shobj_description(d.oid,'pg_database') AS marker
 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;
function compare(row, p, role) {
  const m = p.manifest,
    d = m.database,
    r = m.roles[role];
  insist(
    row &&
      row.db === d.name &&
      row.role === r.name &&
      row.session_role === r.name &&
      row.host === '127.0.0.1' &&
      row.port === '58432' &&
      row.cluster === m.clusterId &&
      normalize(row.directory) === normalize(m.dataDirectory) &&
      /^17[0-9]{4}$/.test(row.version) &&
      row.ro === 'on' &&
      row.oid === d.oid &&
      row.owner_oid === d.ownerOid &&
      row.role_oid === r.oid &&
      typeof row.marker === 'string' &&
      hash(row.marker) === d.markerSha256 &&
      [
        'rolsuper',
        'rolcreatedb',
        'rolcreaterole',
        'rolreplication',
        'rolbypassrls',
      ].every((k) => row[k] === false),
    'RCR_IDENTITY_UNVERIFIED',
  );
}
async function verifiedClient(p, role, C = require('pg').Client) {
  const c = new C(connection(p, role));
  let good = false;
  try {
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows = await c.query(identitySQL);
    insist(rows.rows.length === 1, 'RCR_IDENTITY_UNVERIFIED');
    compare(rows.rows[0], p, role);
    if (role === 'reader') {
      const rights =
        await c.query(`SELECT NOT has_schema_privilege('public','CREATE') AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (
       (c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN') OR has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))) OR
       (c.relkind='S' AND has_sequence_privilege(c.oid,'USAGE,UPDATE')) OR
       pg_has_role(current_user,c.relowner,'USAGE') OR pg_has_role(current_user,c.relowner,'SET'))) AS safe`);
      insist(
        rights.rows.length === 1 && rights.rows[0].safe === true,
        'RCR_READER_WRITE_CAPABILITY',
      );
    }
    await c.query('ROLLBACK');
    good = true;
    return c;
  } finally {
    if (!good) await c.end().catch(() => {});
  }
}
function readPacket(fd = 0) {
  const raw = fs.readFileSync(fd, 'utf8');
  insist(raw.length <= 32768);
  return validate(JSON.parse(raw));
}
function summary(results) {
  const rows = results.testResults.flatMap((s) =>
    s.testResults.map((t) => ({
      id: /^(RCR\d{2})\b/.exec(t.title)?.[1],
      status: t.status,
    })),
  );
  const passed =
    results.success === true &&
    results.numTotalTests === 12 &&
    results.numPendingTests === 0 &&
    results.numFailedTests === 0 &&
    rows.length === 12 &&
    IDS.every(
      (id) =>
        rows.filter((r) => r.id === id && r.status === 'passed').length === 1,
    );
  return {
    status: passed ? 'VERIFIED' : 'UNKNOWN',
    readiness: 'NOT_READY',
    code: passed ? 'RCR_TEST_PASS' : 'RCR_TEST_FAILED',
    total: results.numTotalTests,
    passed: results.numPassedTests,
    failed: results.numFailedTests,
    skipped: results.numPendingTests,
    failedCases: IDS.filter((id) =>
      rows.some((r) => r.id === id && r.status === 'failed'),
    ),
  };
}
module.exports = {
  IDS,
  normalize,
  hash,
  insist,
  validate,
  osEnvironment,
  connection,
  compare,
  verifiedClient,
  readPacket,
  summary,
};
if (require.main === module)
  (async () => {
    const p = readPacket();
    const c = await verifiedClient(p, 'owner');
    await c.end();
    process.stdout.write('IDENTITY_VERIFIED');
  })().catch(() => {
    process.exitCode = 1;
  });
