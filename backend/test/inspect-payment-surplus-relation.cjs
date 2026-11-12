'use strict';
// Independent, fixed-target metadata inspection. Importing never loads pg/connects.
const { isDeepStrictEqual } = require('node:util');
const { DatabaseError } = require('pg-protocol');
const TARGET = '12104';
const ROOTS = [
  'ttv_surplus_lifecycle',
  'ttv_surplus_writer',
  'ttv_surplus_reader',
];
const LIMIT = 200;
const BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const IDENTITY = `SELECT current_user AS role,session_user AS session_role,
 current_database() AS db,host(inet_server_addr()) AS host,inet_server_port()::text AS port,
 pg_backend_pid()::text AS pid,(SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
 current_setting('data_directory') AS directory,current_setting('default_transaction_read_only') AS session_ro,
 current_setting('transaction_read_only') AS tx_ro,
 (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid`;
// No definitions, expressions, arguments, comments, query text or table data.
const SQL = {
  relation: `SELECT c.oid::text AS oid,n.oid::text AS schema_oid,n.nspname::text AS schema_name,
 c.relname::text AS name,c.relkind::text AS kind,c.relowner::text AS owner_oid,
 c.relacl IS NULL AS default_acl,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,
 c.relhasrules AS has_rules,c.relhastriggers AS has_triggers,
 COALESCE('security_invoker=true'=ANY(c.reloptions),false) AS security_invoker
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE c.oid=12104 LIMIT 2`,
  roles: `SELECT r.oid::text AS oid,r.rolname::text AS internal_name,r.rolsuper AS superuser,
 r.rolbypassrls AS bypass_rls,pg_catalog.has_schema_privilege(r.oid,c.relnamespace,'USAGE') AS schema_usage,
 pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE') AS table_update,
 pg_catalog.has_any_column_privilege(r.oid,c.oid,'UPDATE') AS column_update,
 pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE') AS owner_usage,
 pg_catalog.pg_has_role(r.oid,c.relowner,'SET') AS owner_set,
 pg_catalog.pg_has_role(r.oid,'pg_write_all_data','USAGE') AS write_all_usage,
 pg_catalog.pg_has_role(r.oid,'pg_write_all_data','SET') AS write_all_set
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
 WHERE c.oid=12104 AND r.rolname IN ('ttv_surplus_lifecycle','ttv_surplus_writer','ttv_surplus_reader') ORDER BY r.oid LIMIT 4`,
  columns: `SELECT a.attnum::int AS attnum,a.attacl IS NULL AS default_acl
 FROM pg_catalog.pg_attribute a WHERE a.attrelid=12104 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 201`,
  acl: `SELECT 'RELATION'::text AS scope,0::int AS attnum,a.grantor::text AS grantor_oid,
 a.grantee::text AS grantee_oid,a.is_grantable AS grantable FROM pg_catalog.pg_class c
 CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
 WHERE c.oid=12104 AND a.privilege_type='UPDATE'
 UNION ALL SELECT 'COLUMN'::text,a.attnum::int,x.grantor::text,x.grantee::text,x.is_grantable
 FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
 WHERE a.attrelid=12104 AND a.attnum>0 AND NOT a.attisdropped AND x.privilege_type='UPDATE'
 ORDER BY scope,attnum,grantor_oid,grantee_oid LIMIT 201`,
  memberships: `SELECT r.oid::text AS role_oid,t.oid::text AS target_oid,
 pg_catalog.pg_has_role(r.oid,t.oid,'MEMBER') AS member,
 pg_catalog.pg_has_role(r.oid,t.oid,'USAGE') AS usage,
 pg_catalog.pg_has_role(r.oid,t.oid,'SET') AS settable
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_roles t
 WHERE r.rolname IN ('ttv_surplus_lifecycle','ttv_surplus_writer','ttv_surplus_reader') ORDER BY r.oid,t.oid LIMIT 201`,
  rules: `SELECT oid::text AS oid,ev_type::text AS event,ev_enabled::text AS enabled,is_instead AS instead
 FROM pg_catalog.pg_rewrite WHERE ev_class=12104 ORDER BY oid LIMIT 201`,
  triggers: `SELECT t.oid::text AS oid,t.tgfoid::text AS function_oid,t.tgtype::int AS type_mask,
 t.tgenabled::text AS enabled,t.tgisinternal AS internal,p.prosecdef AS security_definer
 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
 WHERE t.tgrelid=12104 ORDER BY t.oid LIMIT 201`,
  policies: `SELECT p.oid::text AS oid,p.polcmd::text AS command,p.polpermissive AS permissive,
 r.role_oid::text AS role_oid,p.polqual IS NOT NULL AS has_qual,p.polwithcheck IS NOT NULL AS has_check
 FROM pg_catalog.pg_policy p CROSS JOIN LATERAL unnest(p.polroles) r(role_oid)
 WHERE p.polrelid=12104 ORDER BY p.oid,r.role_oid LIMIT 201`,
};
// Independent catalog cardinalities catch missing/truncated result sets, including zero rows.
const INVENTORY_GROUPS = Object.freeze([
  'relation',
  'roles',
  'columns',
  'acl',
  'memberships',
  'rules',
  'triggers',
  'policies',
]);
const INVENTORY = Object.freeze(
  Object.fromEntries(
    INVENTORY_GROUPS.map((key) => [
      key,
      `SELECT count(*)::int AS count FROM (${SQL[key].replace(/ LIMIT \d+$/, '')}) inventory_${key}`,
    ]),
  ),
);
// Derive both branches verbatim; the original SQL.acl and its ORDER BY stay untouched.
const ACL_BODY = SQL.acl.replace(
  / ORDER BY scope,attnum,grantor_oid,grantee_oid LIMIT 201$/,
  '',
);
const ACL_BRANCHES = ACL_BODY.split('\n UNION ALL ');
const ACL_STEPS = Object.freeze([
  'RELATION_BRANCH',
  'COLUMN_BRANCH',
  'UNION_ORDERED',
]);
const ACL_DIAGNOSTIC = Object.freeze({
  RELATION_BRANCH: `SELECT count(*)::int AS count FROM (${ACL_BRANCHES[0]}) diagnostic_relation`,
  COLUMN_BRANCH: `SELECT count(*)::int AS count FROM (${ACL_BRANCHES[1]}) diagnostic_column`,
  UNION_ORDERED: INVENTORY.acl,
});
const SCHEMAS = {
  relation: {
    oid: 'target',
    schema_oid: 'oid',
    schema_name: 'name',
    name: 'name',
    kind: 'enum:r|p|v|m|f',
    owner_oid: 'oid',
    default_acl: 'bool',
    rls: 'bool',
    force_rls: 'bool',
    has_rules: 'bool',
    has_triggers: 'bool',
    security_invoker: 'bool',
  },
  roles: {
    oid: 'oid',
    superuser: 'bool',
    bypass_rls: 'bool',
    schema_usage: 'bool',
    table_update: 'bool',
    column_update: 'bool',
    owner_usage: 'bool',
    owner_set: 'bool',
    write_all_usage: 'bool',
    write_all_set: 'bool',
  },
  columns: { attnum: 'positive', default_acl: 'bool' },
  acl: {
    scope: 'enum:RELATION|COLUMN',
    attnum: 'count',
    grantor_oid: 'oid',
    grantee_oid: 'aclOid',
    grantable: 'bool',
  },
  memberships: {
    role_oid: 'oid',
    target_oid: 'oid',
    member: 'bool',
    usage: 'bool',
    settable: 'bool',
  },
  rules: {
    oid: 'oid',
    event: 'enum:1|2|3|4',
    enabled: 'enum:O|D|R|A',
    instead: 'bool',
  },
  triggers: {
    oid: 'oid',
    function_oid: 'oid',
    type_mask: 'count',
    enabled: 'enum:O|D|R|A',
    internal: 'bool',
    security_definer: 'bool',
  },
  policies: {
    oid: 'oid',
    command: 'enum:r|a|w|d|*',
    permissive: 'bool',
    role_oid: 'aclOid',
    has_qual: 'bool',
    has_check: 'bool',
  },
  sources: {
    role_oid: 'oid',
    scope: 'enum:RELATION|COLUMN',
    attnum: 'count',
    grantee_oid: 'aclOid',
    grantor_oid: 'oid',
    public: 'bool',
    direct: 'bool',
    inherited: 'bool',
    settable: 'bool',
    grantable: 'bool',
  },
};
const CODES = [
  'METADATA_VERIFIED',
  'IDENTITY_MISMATCH',
  'INVALID_METADATA',
  'RELATION_NOT_FOUND',
  'ROW_LIMIT_EXCEEDED',
  'SNAPSHOT_CHANGED',
  'UNATTRIBUTED_UPDATE',
  'INSUFFICIENT_PRIVILEGE',
  'INSPECTION_FAILED',
  'TIMEOUT',
  'CONNECTION_LOST',
  'CLOSE_FAILED',
  'REPORT_VALIDATION_FAILED',
  'AUTHENTICATION_FAILED',
  'CONNECTION_FAILED',
  'SQL_SYNTAX_ERROR',
  'UNDEFINED_COLUMN',
  'UNDEFINED_FUNCTION',
  'UNDEFINED_RELATION',
  'QUERY_CANCELED',
  'TRANSACTION_FAILED',
  'UNCLASSIFIED_DATABASE_ERROR',
  'CATALOG_FAILED',
  'DEPENDENCY_FAILED',
  'PROCESS_START_FAILED',
  'WRAPPER_TIMEOUT',
  'OUTPUT_READ_FAILED',
  'CREDENTIAL_INPUT_FAILED',
  'VALIDATOR_START_FAILED',
  'VALIDATOR_TIMEOUT',
  'JAVASCRIPT_ERROR',
  'INVALID_PARAMETER_VALUE',
  'ACL_DIAGNOSTIC_VERIFIED',
];
const PHASES = [
  'ACL_DIAGNOSTIC',
  'URL_VALIDATION',
  'CONNECT',
  'BEGIN_READ_ONLY',
  'IDENTITY',
  'INVENTORY',
  'CATALOG_RELATION',
  'CATALOG_ROLES',
  'CATALOG_COLUMNS',
  'CATALOG_ACL',
  'CATALOG_MEMBERSHIP',
  'CATALOG_RULES_TRIGGERS',
  'CATALOG_POLICIES',
  'COMPARE',
  'ROLLBACK',
  'CLOSE',
  'OUTPUT_VALIDATION',
  'CREDENTIAL_INPUT',
  'PROCESS_START',
  'PROCESS_WAIT',
  'OUTPUT_READ',
  'DEPENDENCY_LOAD',
];
const CATALOG_PHASES = {
  relation: 'CATALOG_RELATION',
  roles: 'CATALOG_ROLES',
  columns: 'CATALOG_COLUMNS',
  acl: 'CATALOG_ACL',
  memberships: 'CATALOG_MEMBERSHIP',
  rules: 'CATALOG_RULES_TRIGGERS',
  triggers: 'CATALOG_RULES_TRIGGERS',
  policies: 'CATALOG_POLICIES',
};
// Only these exact SQLSTATEs can cross the output boundary. Never output message/detail/hint.
const SQLSTATES = Object.freeze({
  22023: 'INVALID_PARAMETER_VALUE',
  '28P01': 'AUTHENTICATION_FAILED',
  28000: 'AUTHENTICATION_FAILED',
  42601: 'SQL_SYNTAX_ERROR',
  42703: 'UNDEFINED_COLUMN',
  42883: 'UNDEFINED_FUNCTION',
  '42P01': 'UNDEFINED_RELATION',
  42501: 'INSUFFICIENT_PRIVILEGE',
  57014: 'QUERY_CANCELED',
  25006: 'TRANSACTION_FAILED',
  '25P02': 'TRANSACTION_FAILED',
  '08000': 'CONNECTION_FAILED',
  '08001': 'CONNECTION_FAILED',
  '08003': 'CONNECTION_FAILED',
  '08004': 'CONNECTION_FAILED',
  '08006': 'CONNECTION_FAILED',
  '08007': 'CONNECTION_FAILED',
  '08P01': 'CONNECTION_FAILED',
});
function diagnostic(error, phase, identityStatus, inventoryGroup, aclStep) {
  let code, sqlstate;
  if (
    error instanceof DatabaseError &&
    typeof error.code === 'string' &&
    Object.hasOwn(SQLSTATES, error.code)
  ) {
    sqlstate = error.code;
    code = SQLSTATES[sqlstate];
  } else if (error instanceof DatabaseError) {
    code = 'UNCLASSIFIED_DATABASE_ERROR';
  } else if (
    CODES.includes(error?.safeCode) &&
    error.safeCode !== 'METADATA_VERIFIED'
  ) {
    code = error.safeCode;
  } else if (
    phase === 'CONNECT' &&
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ETIMEDOUT',
    ].includes(error?.code)
  )
    code = 'CONNECTION_FAILED';
  else if (phase === 'OUTPUT_VALIDATION') code = 'REPORT_VALIDATION_FAILED';
  else code = 'JAVASCRIPT_ERROR';
  return unknown(
    code,
    phase,
    identityStatus,
    sqlstate,
    inventoryGroup,
    aclStep,
  );
}
function fail(code) {
  const e = new Error(code);
  e.safeCode = code;
  throw e;
}
function ensure(ok, code = 'INVALID_METADATA') {
  if (!ok) fail(code);
}
function object(v, keys) {
  ensure(v && typeof v === 'object' && !Array.isArray(v));
  ensure(
    Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
  );
}
function value(v, type) {
  let valid = false;
  if (type === 'bool') valid = typeof v === 'boolean';
  if (type === 'oid' || type === 'aclOid')
    valid =
      typeof v === 'string' &&
      /^(0|[1-9][0-9]*)$/.test(v) &&
      BigInt(v) <= 4294967295n &&
      (type === 'aclOid' || v !== '0');
  if (type === 'target') valid = v === TARGET;
  if (type === 'count' || type === 'positive')
    valid =
      Number.isSafeInteger(v) &&
      v >= (type === 'positive' ? 1 : 0) &&
      v <= 65535;
  // Identifier output only; unusual identifiers fail closed rather than being echoed.
  if (type === 'name')
    valid = typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(v);
  if (type.startsWith('enum:'))
    valid = typeof v === 'string' && type.slice(5).split('|').includes(v);
  ensure(valid);
  return v;
}
function row(v, schema) {
  object(v, Object.keys(schema));
  return Object.fromEntries(
    Object.entries(schema).map(([key, type]) => [key, value(v[key], type)]),
  );
}
function validateUrl(raw) {
  ensure(
    typeof raw === 'string' &&
      /^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\/postgres$/.test(
        raw,
      ) &&
      !/[\s\\?#]/.test(raw) &&
      !/%(?![0-9a-f]{2})/i.test(raw),
    'IDENTITY_MISMATCH',
  );
  let u;
  try {
    u = new URL(raw);
    ensure(decodeURIComponent(u.username) === ROOTS[0], 'IDENTITY_MISMATCH');
  } catch {
    fail('IDENTITY_MISMATCH');
  }
  ensure(
    u.hostname === '127.0.0.1' &&
      u.port === '55432' &&
      u.pathname === '/postgres' &&
      u.password &&
      !u.search &&
      !u.hash,
    'IDENTITY_MISMATCH',
  );
  return u.toString();
}
function identity(rows) {
  ensure(Array.isArray(rows) && rows.length === 1, 'IDENTITY_MISMATCH');
  const r = rows[0];
  ensure(
    r.role === ROOTS[0] &&
      r.session_role === ROOTS[0] &&
      r.db === 'postgres' &&
      r.database_oid === '5' &&
      r.host === '127.0.0.1' &&
      r.port === '55432' &&
      r.cluster === '7703979600700924132' &&
      typeof r.directory === 'string' &&
      r.directory.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() ===
        'd:/text-to-voice/pg-test-cluster' &&
      r.session_ro === 'on' &&
      r.tx_ro === 'on' &&
      typeof r.pid === 'string' &&
      /^[1-9][0-9]*$/.test(r.pid),
    'IDENTITY_MISMATCH',
  );
}
function sources(data) {
  return data.roles.flatMap((r) =>
    data.acl
      .map((a) => {
        const m = data.memberships.find(
          (m) => m.role_oid === r.oid && m.target_oid === a.grantee_oid,
        );
        ensure(a.grantee_oid === '0' || m);
        return {
          role_oid: r.oid,
          scope: a.scope,
          attnum: a.attnum,
          grantee_oid: a.grantee_oid,
          grantor_oid: a.grantor_oid,
          public: a.grantee_oid === '0',
          direct: a.grantee_oid === r.oid,
          inherited:
            a.grantee_oid !== '0' && a.grantee_oid !== r.oid && m.usage,
          settable: a.grantee_oid !== '0' && m.settable,
          grantable: a.grantable,
        };
      })
      .filter((s) => s.public || s.direct || s.inherited || s.settable),
  );
}
function consistent(d) {
  ensure(
    d.relation.length === 1 && d.roles.length === 3 && d.columns.length > 0,
  );
  const roots = d.roles.map((r) => r.oid);
  ensure(new Set(roots).size === 3);
  for (const category of Object.keys(SQL)) {
    const keys = d[category].map((r) =>
      category === 'acl'
        ? [r.scope, r.attnum, r.grantee_oid, r.grantor_oid].join(':')
        : category === 'memberships'
          ? r.role_oid + ':' + r.target_oid
          : category === 'policies'
            ? r.oid + ':' + r.role_oid
            : category === 'columns'
              ? r.attnum
              : r.oid,
    );
    ensure(new Set(keys).size === keys.length);
  }
  const perRole = roots.map((oid) =>
    d.memberships
      .filter((m) => m.role_oid === oid)
      .map((m) => m.target_oid)
      .sort(),
  );
  ensure(
    perRole[0].length >= 3 &&
      perRole.every((ids) => isDeepStrictEqual(ids, perRole[0])) &&
      d.memberships.every((m) => roots.includes(m.role_oid)),
  );
  for (const oid of roots) ensure(perRole[0].includes(oid));
  const rel = d.relation[0];
  ensure(perRole[0].includes(rel.owner_oid));
  ensure(
    rel.has_rules === d.rules.length > 0 &&
      rel.has_triggers === d.triggers.length > 0,
  );
  for (const a of d.acl)
    ensure(
      a.scope === 'RELATION'
        ? a.attnum === 0
        : d.columns.some((c) => c.attnum === a.attnum),
    );
  for (const r of d.roles) {
    const owner = d.memberships.find(
      (m) => m.role_oid === r.oid && m.target_oid === rel.owner_oid,
    );
    ensure(r.owner_usage === owner.usage && r.owner_set === owner.settable);
    const ss = d.sources.filter(
      (s) => s.role_oid === r.oid && (s.public || s.direct || s.inherited),
    );
    // Owner has implicit grant authority, not necessarily an unrevoked UPDATE ACL.
    const table =
      ss.some((s) => s.scope === 'RELATION') ||
      r.superuser ||
      r.write_all_usage;
    const column = table || ss.some((s) => s.scope === 'COLUMN');
    ensure(
      r.table_update === table && r.column_update === column,
      'UNATTRIBUTED_UPDATE',
    );
  }
  ensure(isDeepStrictEqual(d.sources, sources(d)));
}
function unknown(
  code,
  phase = 'OUTPUT_VALIDATION',
  identityStatus = 'UNVERIFIED',
  sqlstate,
  inventoryGroup,
  aclStep,
) {
  return {
    status: 'UNKNOWN',
    readiness: 'NOT_READY',
    code:
      CODES.includes(code) && code !== 'METADATA_VERIFIED'
        ? code
        : 'INSPECTION_FAILED',
    phase: PHASES.includes(phase) ? phase : 'OUTPUT_VALIDATION',
    identityStatus: identityStatus === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
    ...(phase === 'INVENTORY' && INVENTORY_GROUPS.includes(inventoryGroup)
      ? { inventoryGroup }
      : {}),
    ...(phase === 'ACL_DIAGNOSTIC' && ACL_STEPS.includes(aclStep)
      ? { aclStep }
      : {}),
    ...(typeof sqlstate === 'string' && Object.hasOwn(SQLSTATES, sqlstate)
      ? { sqlstate }
      : {}),
  };
}
function validateReport(report) {
  if (report?.status === 'UNKNOWN') {
    object(report, [
      'status',
      'readiness',
      'code',
      'phase',
      'identityStatus',
      ...(Object.hasOwn(report, 'sqlstate') ? ['sqlstate'] : []),
      ...(Object.hasOwn(report, 'inventoryGroup') ? ['inventoryGroup'] : []),
      ...(Object.hasOwn(report, 'aclStep') ? ['aclStep'] : []),
    ]);
    ensure(
      report.readiness === 'NOT_READY' &&
        CODES.includes(report.code) &&
        !['METADATA_VERIFIED', 'ACL_DIAGNOSTIC_VERIFIED'].includes(report.code),
    );
    ensure(
      PHASES.includes(report.phase) &&
        ['VERIFIED', 'UNVERIFIED'].includes(report.identityStatus),
    );
    ensure(
      report.phase === 'INVENTORY'
        ? INVENTORY_GROUPS.includes(report.inventoryGroup)
        : !Object.hasOwn(report, 'inventoryGroup'),
    );
    ensure(
      report.phase === 'ACL_DIAGNOSTIC'
        ? ACL_STEPS.includes(report.aclStep) &&
            report.identityStatus === 'VERIFIED'
        : !Object.hasOwn(report, 'aclStep'),
    );
    if (
      [
        'URL_VALIDATION',
        'CONNECT',
        'BEGIN_READ_ONLY',
        'IDENTITY',
        'CREDENTIAL_INPUT',
        'PROCESS_START',
        'PROCESS_WAIT',
        'OUTPUT_READ',
        'DEPENDENCY_LOAD',
      ].includes(report.phase)
    )
      ensure(report.identityStatus === 'UNVERIFIED');
    if (
      report.phase === 'INVENTORY' ||
      report.phase.startsWith('CATALOG_') ||
      ['COMPARE', 'ROLLBACK'].includes(report.phase)
    )
      ensure(report.identityStatus === 'VERIFIED');
    if (Object.hasOwn(report, 'sqlstate'))
      ensure(
        typeof report.sqlstate === 'string' &&
          Object.hasOwn(SQLSTATES, report.sqlstate) &&
          SQLSTATES[report.sqlstate] === report.code,
      );
    return unknown(
      report.code,
      report.phase,
      report.identityStatus,
      report.sqlstate,
      report.inventoryGroup,
      report.aclStep,
    );
  }
  if (report?.code === 'ACL_DIAGNOSTIC_VERIFIED') {
    object(report, [
      'status',
      'readiness',
      'code',
      'phase',
      'identityStatus',
      'aclStep',
      'snapshotMatched',
    ]);
    ensure(
      report.status === 'VERIFIED' &&
        report.readiness === 'NOT_READY' &&
        report.phase === 'ACL_DIAGNOSTIC' &&
        report.identityStatus === 'VERIFIED' &&
        report.aclStep === 'UNION_ORDERED' &&
        report.snapshotMatched === true,
    );
    return {
      status: 'VERIFIED',
      readiness: 'NOT_READY',
      code: 'ACL_DIAGNOSTIC_VERIFIED',
      phase: 'ACL_DIAGNOSTIC',
      identityStatus: 'VERIFIED',
      aclStep: 'UNION_ORDERED',
      snapshotMatched: true,
    };
  }
  object(report, [
    'status',
    'readiness',
    'code',
    'database_oid',
    'snapshotMatched',
    'counts',
    'data',
    'phase',
    'identityStatus',
  ]);
  ensure(
    report.status === 'VERIFIED' &&
      report.readiness === 'NOT_READY' &&
      report.code === 'METADATA_VERIFIED' &&
      report.database_oid === '5' &&
      report.snapshotMatched === true,
  );
  ensure(
    report.phase === 'OUTPUT_VALIDATION' &&
      report.identityStatus === 'VERIFIED',
  );
  object(report.data, Object.keys(SCHEMAS));
  object(report.counts, Object.keys(SCHEMAS));
  const data = {},
    counts = {};
  for (const [key, schema] of Object.entries(SCHEMAS)) {
    ensure(
      Array.isArray(report.data[key]) &&
        report.data[key].length <= (key === 'sources' ? LIMIT * 3 : LIMIT),
    );
    data[key] = report.data[key].map((r) => row(r, schema));
    ensure(report.counts[key] === data[key].length);
    counts[key] = data[key].length;
  }
  consistent(data);
  return {
    status: 'VERIFIED',
    readiness: 'NOT_READY',
    code: 'METADATA_VERIFIED',
    phase: 'OUTPUT_VALIDATION',
    identityStatus: 'VERIFIED',
    database_oid: '5',
    snapshotMatched: true,
    counts,
    data,
  };
}
function safeJson(report) {
  try {
    return JSON.stringify(validateReport(report));
  } catch {
    return JSON.stringify(unknown('REPORT_VALIDATION_FAILED'));
  }
}
async function deadline(task, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error('TIMEOUT');
          e.safeCode = 'TIMEOUT';
          reject(e);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function inspect(raw, { Client, aclDiagnostic = false }) {
  let client,
    lost = false,
    lostPhase,
    lostGroup,
    inventoryGroup,
    aclStep,
    lostStep,
    phase = 'URL_VALIDATION',
    identityStatus = 'UNVERIFIED',
    result = unknown('INSPECTION_FAILED');
  const query = async (sql) => {
    ensure(!lost, 'CONNECTION_LOST');
    const result = await deadline(() => client.query(sql), 5000);
    ensure(!lost, 'CONNECTION_LOST');
    return result;
  };
  try {
    ensure(typeof aclDiagnostic === 'boolean');
    const url = validateUrl(raw);
    phase = 'CONNECT';
    client = new Client({
      connectionString: url,
      options:
        '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=15000',
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      application_name: 'ttv-surplus-relation-inspection',
    });
    client.on('error', () => {
      lost = true;
      lostPhase ??= phase;
      lostGroup ??= inventoryGroup;
      lostStep ??= aclStep;
    });
    await deadline(() => client.connect(), 5000);
    phase = 'BEGIN_READ_ONLY';
    await query(BEGIN);
    phase = 'IDENTITY';
    identity((await query(IDENTITY)).rows);
    identityStatus = 'VERIFIED';
    if (aclDiagnostic) {
      phase = 'ACL_DIAGNOSTIC';
      ensure(ACL_BRANCHES.length === 2 && ACL_BODY !== SQL.acl);
      const counts = {};
      for (let sample = 0; sample < 2; sample++) {
        for (const step of ACL_STEPS) {
          aclStep = step;
          const rows = (await query(ACL_DIAGNOSTIC[step])).rows;
          ensure(Array.isArray(rows) && rows.length === 1);
          const { count } = row(rows[0], { count: 'count' });
          ensure(count <= LIMIT, 'ROW_LIMIT_EXCEEDED');
          if (sample === 0) counts[step] = count;
          else ensure(count === counts[step], 'SNAPSHOT_CHANGED');
        }
        ensure(
          counts.UNION_ORDERED ===
            counts.RELATION_BRANCH + counts.COLUMN_BRANCH,
        );
      }
      phase = 'IDENTITY';
      identityStatus = 'UNVERIFIED';
      identity((await query(IDENTITY)).rows);
      identityStatus = 'VERIFIED';
      phase = 'ROLLBACK';
      await query('ROLLBACK');
      phase = 'OUTPUT_VALIDATION';
      result = validateReport({
        status: 'VERIFIED',
        readiness: 'NOT_READY',
        code: 'ACL_DIAGNOSTIC_VERIFIED',
        phase: 'ACL_DIAGNOSTIC',
        identityStatus,
        aclStep: 'UNION_ORDERED',
        snapshotMatched: true,
      });
    } else {
      phase = 'INVENTORY';
      const inventory = {};
      for (const group of INVENTORY_GROUPS) {
        inventoryGroup = group;
        const rows = (await query(INVENTORY[group])).rows;
        ensure(Array.isArray(rows) && rows.length === 1);
        const result = row(rows[0], { count: 'count' });
        ensure(result.count <= LIMIT, 'ROW_LIMIT_EXCEEDED');
        inventory[group] = result.count;
      }
      inventoryGroup = undefined;
      async function sample() {
        const data = {};
        for (const [key, sql] of Object.entries(SQL)) {
          phase = CATALOG_PHASES[key];
          const rows = (await query(sql)).rows;
          ensure(Array.isArray(rows));
          ensure(rows.length <= LIMIT, 'ROW_LIMIT_EXCEEDED');
          ensure(rows.length === inventory[key]);
          if (key === 'relation')
            ensure(rows.length === 1, 'RELATION_NOT_FOUND');
          if (key === 'roles') {
            ensure(
              rows.length === 3 &&
                new Set(rows.map((r) => r.internal_name)).size === 3 &&
                rows.every((r) => ROOTS.includes(r.internal_name)),
            );
            data[key] = rows.map((r) => {
              const copy = { ...r };
              delete copy.internal_name;
              return row(copy, SCHEMAS[key]);
            });
          } else data[key] = rows.map((r) => row(r, SCHEMAS[key]));
        }
        phase = 'COMPARE';
        data.sources = sources(data);
        consistent(data);
        return data;
      }
      const first = await sample(),
        second = await sample();
      phase = 'COMPARE';
      ensure(isDeepStrictEqual(first, second), 'SNAPSHOT_CHANGED');
      phase = 'IDENTITY';
      identityStatus = 'UNVERIFIED';
      identity((await query(IDENTITY)).rows);
      identityStatus = 'VERIFIED';
      phase = 'ROLLBACK';
      await query('ROLLBACK');
      phase = 'OUTPUT_VALIDATION';
      result = validateReport({
        status: 'VERIFIED',
        readiness: 'NOT_READY',
        code: 'METADATA_VERIFIED',
        phase: 'OUTPUT_VALIDATION',
        identityStatus: 'VERIFIED',
        database_oid: '5',
        snapshotMatched: true,
        counts: Object.fromEntries(
          Object.entries(first).map(([k, v]) => [k, v.length]),
        ),
        data: first,
      });
    }
  } catch (error) {
    result = diagnostic(error, phase, identityStatus, inventoryGroup, aclStep);
    // Close rolls back any open read-only transaction; do not issue further SQL after failure.
  } finally {
    if (client) {
      try {
        phase = 'CLOSE';
        await deadline(() => client.end(), 3000);
      } catch {
        try {
          client.unref();
        } catch {}
        result = unknown('CLOSE_FAILED', 'CLOSE', identityStatus);
      }
    }
    if (lost)
      result = unknown(
        'CONNECTION_LOST',
        lostPhase || 'CLOSE',
        identityStatus,
        undefined,
        lostGroup,
        lostStep,
      );
  }
  return result;
}
module.exports = {
  inspect,
  safeJson,
  validateReport,
  validateUrl,
  SQL,
  SCHEMAS,
  BEGIN,
  IDENTITY,
  INVENTORY,
  INVENTORY_GROUPS,
  diagnostic,
  PHASES,
  SQLSTATES,
  ACL_STEPS,
  ACL_DIAGNOSTIC,
};
if (require.main === module) {
  let cliPhase = 'OUTPUT_VALIDATION';
  (async () => {
    if (process.argv.length === 3 && process.argv[2] === '--validate-report') {
      // Offline output firewall. No pg import or credential environment in this branch.
      let raw = '';
      for await (const chunk of process.stdin) {
        raw += chunk;
        ensure(raw.length <= 1048576);
      }
      const json = safeJson(JSON.parse(raw));
      process.stdout.write(json);
      process.exitCode = JSON.parse(json).status === 'VERIFIED' ? 0 : 1;
      return;
    }
    cliPhase = 'URL_VALIDATION';
    const aclDiagnostic =
      process.argv.length === 3 && process.argv[2] === '--acl-diagnostic';
    ensure(process.argv.length === 2 || aclDiagnostic);
    const raw = process.env.SURPLUS_RELATION_URL;
    delete process.env.SURPLUS_RELATION_URL;
    validateUrl(raw); // Before loading pg, no fallback.
    cliPhase = 'DEPENDENCY_LOAD';
    let Client;
    try {
      ({ Client } = require('pg'));
    } catch {
      fail('DEPENDENCY_FAILED');
    }
    const json = safeJson(await inspect(raw, { Client, aclDiagnostic }));
    process.stdout.write(json);
    process.exitCode = JSON.parse(json).status === 'VERIFIED' ? 0 : 1;
  })().catch((error) => {
    process.stdout.write(safeJson(diagnostic(error, cliPhase, 'UNVERIFIED')));
    process.exitCode = 1;
  });
}
