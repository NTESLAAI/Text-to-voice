'use strict';
const crypto = require('node:crypto');
const ACTIONS = Object.freeze([
  'migrate-cold',
  'upgrade-base',
  'upgrade-final',
  'test',
  'backup-restore',
]);
const TEST_IDS = Object.freeze([
  'A01',
  'A02',
  'A03',
  'A04',
  'A05',
  'A06',
  'A07',
  'A08:APPLE',
  'A08:GOOGLE',
  'A09',
  'A10',
  'A11',
  'A12',
  'A13',
]);
const TEST_FAILURE_CODES = Object.freeze([
  'JEST_MULTIPLE_CONFIGURATIONS',
  'JEST_CLI_TYPE_ERROR',
  'JEST_RESULT_SUMMARY_TYPE_ERROR',
  'JEST_ZERO_TESTS_UNCLASSIFIED',
  'JEST_DOTENV_IMPORT_REFUSED',
  'JEST_FD_READ_FAILED',
  'JEST_MODULE_NOT_FOUND',
  'JEST_ESM_REQUIRE_FAILED',
  'JEST_TRANSFORM_FAILED',
  'JEST_UNCLASSIFIED_BOOTSTRAP_FAILURE',
  'ACCEPTANCE_DATABASE_NOT_EMPTY',
]);
function safeTestFailure(text) {
  const s = typeof text === 'string' ? text : '';
  if (/Multiple configurations/.test(s)) return 'JEST_MULTIPLE_CONFIGURATIONS';
  if (/APPLICATION_BOOTSTRAP_REFUSED/.test(s))
    return 'JEST_DOTENV_IMPORT_REFUSED';
  if (/EBADF|EINVAL.*read|bad file descriptor/.test(s))
    return 'JEST_FD_READ_FAILED';
  if (/Cannot find module|MODULE_NOT_FOUND/.test(s))
    return 'JEST_MODULE_NOT_FOUND';
  if (
    /ERR_REQUIRE_ESM|Must use import|Unexpected token ['"]?export|Cannot use import statement/.test(
      s,
    )
  )
    return 'JEST_ESM_REQUIRE_FAILED';
  if (/TS[0-9]{4}:|SyntaxError|Jest encountered an unexpected token/.test(s))
    return 'JEST_TRANSFORM_FAILED';
  return 'JEST_UNCLASSIFIED_BOOTSTRAP_FAILURE';
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const oid = (x) =>
  typeof x === 'string' &&
  /^[1-9][0-9]{0,9}$/.test(x) &&
  BigInt(x) <= 4294967295n;
const hash = (x) => crypto.createHash('sha256').update(x).digest('hex');
const normalize = (x) =>
  String(x).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
function insist(ok, code = 'ACCEPTANCE_CONFIGURATION_INVALID') {
  if (!ok) throw new Error(code);
}
function exact(value, keys) {
  insist(value && typeof value === 'object' && !Array.isArray(value));
  insist(
    Object.keys(value).length === keys.length &&
      Object.keys(value).every((k) => keys.includes(k)),
  );
}
function cleanEnvironment(env) {
  insist(
    !Object.keys(env).some((k) =>
      /^(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|PG.*|NODE_OPTIONS|NODE_PATH)$/i.test(
        k,
      ),
    ),
    'INHERITED_CONFIGURATION_REFUSED',
  );
}
function validate(packet, env = process.env) {
  cleanEnvironment(env);
  exact(packet, ['manifest', 'credentials', 'action', 'approval']);
  const m = packet.manifest;
  exact(m, [
    'version',
    'runId',
    'clusterId',
    'dataDirectory',
    'roles',
    'databases',
  ]);
  insist(m.version === 1 && UUID.test(m.runId));
  insist(
    typeof m.clusterId === 'string' &&
      /^[1-9][0-9]{0,19}$/.test(m.clusterId) &&
      BigInt(m.clusterId) <= 18446744073709551615n &&
      m.clusterId !== '7703979600700924132',
  );
  insist(
    normalize(m.dataDirectory) === `d:/text-to-voice-it/${m.runId}/pgdata`,
  );
  insist(
    ACTIONS.includes(packet.action) &&
      packet.approval === `APPROVE ${m.runId} ${packet.action}`,
    'APPROVAL_REQUIRED',
  );
  exact(m.roles, ['owner', 'writer', 'reader']);
  exact(m.databases, ['cold', 'upgrade', 'restored']);
  exact(packet.credentials, ['owner', 'writer', 'reader']);
  for (const role of ['owner', 'writer', 'reader']) {
    const r = m.roles[role];
    exact(r, ['name', 'oid']);
    insist(r.name === `ttv_it_${role}_${m.runId.slice(0, 8)}` && oid(r.oid));
    const raw = packet.credentials[role];
    insist(typeof raw === 'string' && raw.length < 4096 && !/[\s\\]/.test(raw));
    insist(
      /^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:56432\/postgres$/.test(raw),
      'URL_VALIDATION_FAILED',
    );
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('URL_VALIDATION_FAILED');
    }
    insist(
      ['postgres:', 'postgresql:'].includes(u.protocol) &&
        u.hostname === '127.0.0.1' &&
        u.port === '56432' &&
        u.pathname === '/postgres' &&
        !u.search &&
        !u.hash &&
        decodeURIComponent(u.username) === r.name &&
        Boolean(u.password),
      'URL_VALIDATION_FAILED',
    );
  }
  insist(new Set(Object.values(m.roles).map((r) => r.oid)).size === 3);
  for (const kind of ['cold', 'upgrade', 'restored']) {
    const d = m.databases[kind];
    exact(d, ['name', 'oid', 'ownerOid', 'markerSha256']);
    insist(
      d.name === `ttv_it_${kind}_${m.runId.replaceAll('-', '')}` &&
        oid(d.oid) &&
        d.ownerOid === m.roles.owner.oid &&
        /^[0-9a-f]{64}$/.test(d.markerSha256),
    );
  }
  insist(new Set(Object.values(m.databases).map((d) => d.oid)).size === 3);
  return packet;
}
function connection(packet, kind, role) {
  insist(
    ['cold', 'upgrade', 'restored'].includes(kind) &&
      ['owner', 'writer', 'reader'].includes(role),
  );
  const u = new URL(packet.credentials[role]);
  u.pathname = '/' + packet.manifest.databases[kind].name;
  return {
    connectionString: u.toString(),
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    statement_timeout: 8000,
    lock_timeout: 5000,
    application_name: `ttv-it:${packet.manifest.runId}:${role}`,
  };
}
const identitySQL = `SELECT current_database() AS db, current_user AS role, session_user AS session_role,
 host(inet_server_addr()) AS host, inet_server_port()::text AS port,
 (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
 current_setting('data_directory') AS directory, current_setting('server_version_num') AS version,
 current_setting('transaction_read_only') AS ro,
 d.oid::text AS oid, d.datdba::text AS owner_oid, r.oid::text AS role_oid,
 r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
 pg_catalog.shobj_description(d.oid,'pg_database') AS marker
 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname=current_user
 WHERE d.datname=current_database()`;
function compare(row, p, kind, role) {
  const m = p.manifest,
    d = m.databases[kind],
    r = m.roles[role];
  insist(
    row &&
      row.db === d.name &&
      row.role === r.name &&
      row.session_role === r.name &&
      row.host === '127.0.0.1' &&
      row.port === '56432' &&
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
    'IDENTITY_UNVERIFIED',
  );
}
async function verifiedClient(packet, kind, role, Client) {
  validate(packet);
  const C = Client || require('pg').Client;
  const c = new C(connection(packet, kind, role));
  let good = false;
  try {
    await c.connect();
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await c.query(identitySQL);
    insist(result.rows.length === 1, 'IDENTITY_UNVERIFIED');
    compare(result.rows[0], packet, kind, role);
    if (role === 'reader') {
      const rights = await c.query(`SELECT NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND (
          has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES,MAINTAIN') OR
          has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES') OR
          pg_has_role(current_user,c.relowner,'USAGE') OR pg_has_role(current_user,c.relowner,'SET'))
      ) AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='S' AND (
          has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE') OR
          pg_has_role(current_user,c.relowner,'USAGE') OR pg_has_role(current_user,c.relowner,'SET'))
      ) AS safe`);
      insist(
        rights.rows.length === 1 && rights.rows[0].safe === true,
        'READER_WRITE_CAPABILITY_REFUSED',
      );
    }
    await c.query('ROLLBACK');
    good = true;
    return c;
  } finally {
    if (!good) await c.end().catch(() => {});
  }
}
function osEnvironment() {
  const keys = new Set([
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
    Object.entries(process.env).filter(([k]) => keys.has(k.toUpperCase())),
  );
}
function readPacket(fd = 0) {
  const raw = require('node:fs').readFileSync(fd, 'utf8');
  insist(raw.length <= 32768);
  return validate(JSON.parse(raw));
}
module.exports = {
  TEST_FAILURE_CODES,
  safeTestFailure,
  TEST_IDS,
  ACTIONS,
  validate,
  connection,
  compare,
  verifiedClient,
  osEnvironment,
  readPacket,
  hash,
  insist,
  normalize,
};
if (require.main === module) {
  (async () => {
    const p = readPacket();
    const kind = p.action === 'migrate-cold' ? 'cold' : 'upgrade';
    const c = await verifiedClient(p, kind, 'owner');
    await c.end();
    process.stdout.write('IDENTITY_VERIFIED');
  })().catch(() => {
    process.exitCode = 1;
  });
}
