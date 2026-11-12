'use strict';
// Fixed catalog SELECTs only. Invoked on the already identity-verified connection.
const ROOTS =
  "r.rolname IN ('ttv_surplus_lifecycle','ttv_surplus_writer','ttv_surplus_reader')";
const RELATIONS = "c.relkind IN ('r','p','v','m','f')";
const publicPrivilege = (acl, owner, type, privilege) =>
  `EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(${acl},pg_catalog.acldefault('${type}',${owner}))) a WHERE a.grantee=0 AND a.privilege_type='${privilege}')`;
const PUBLIC_FUNCTION = publicPrivilege(
  'p.proacl',
  'p.proowner',
  'f',
  'EXECUTE',
);
const roleSql = `SELECT r.oid::text AS role_oid,r.rolname AS internal_name,r.rolcanlogin AS login,r.rolinherit AS inherit,
 r.rolsuper AS superuser,r.rolcreatedb AS create_database,r.rolcreaterole AS create_role,
 r.rolreplication AS replication,r.rolbypassrls AS bypass_rls,
 pg_catalog.pg_has_role(r.oid,'pg_read_all_stats','MEMBER') AS stats_member,
 pg_catalog.pg_has_role(r.oid,'pg_read_all_stats','USAGE') AS stats_usage,
 pg_catalog.pg_has_role(r.oid,'pg_read_all_stats','SET') AS stats_set,
 pg_catalog.pg_has_role(r.oid,'pg_read_all_settings','USAGE') AS settings_usage
 FROM pg_catalog.pg_roles r WHERE ${ROOTS} ORDER BY r.oid`;
const transactionSql = `SELECT current_setting('transaction_isolation') AS isolation,
 current_setting('transaction_read_only') AS read_only,current_setting('default_transaction_read_only') AS default_read_only,
 pg_backend_pid()::text AS backend_pid,pg_current_snapshot()::text AS snapshot,
 current_database()='postgres' AS correct_database,current_user::regrole::oid::text AS current_role_oid,
 (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid`;
const evidenceTargetSql = `SELECT c.oid::text AS object_oid,c.relnamespace::text AS schema_oid,
 n.nspname::text AS schema_name,c.relname::text AS relation_name,c.relkind::text AS relkind,c.relowner::text AS owner_oid
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='pg_catalog' AND c.relname='pg_settings' ORDER BY c.oid`;
const evidenceGrantSql = `SELECT 'RELATION'::text AS scope,0::int AS attnum,
 a.grantor::text AS grantor_oid,a.grantee::text AS grantee_oid,a.is_grantable AS grantable
 FROM pg_catalog.pg_class c CROSS JOIN LATERAL
 pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
 WHERE c.oid=pg_catalog.to_regclass('pg_catalog.pg_settings') AND a.privilege_type='UPDATE'
 UNION ALL SELECT 'COLUMN'::text,p.attnum::int,a.grantor::text,a.grantee::text,a.is_grantable
 FROM pg_catalog.pg_attribute p CROSS JOIN LATERAL pg_catalog.aclexplode(p.attacl) a
 WHERE p.attrelid=pg_catalog.to_regclass('pg_catalog.pg_settings') AND p.attnum>0 AND NOT p.attisdropped AND a.privilege_type='UPDATE'
 ORDER BY scope,attnum,grantor_oid,grantee_oid`;
const evidenceRoleSql = `SELECT r.oid::text AS role_oid,
 pg_catalog.pg_has_role(r.oid,'pg_write_all_data','USAGE') AS write_all_usage,
 pg_catalog.pg_has_role(r.oid,'pg_write_all_data','SET') AS write_all_set
 FROM pg_catalog.pg_roles r WHERE ${ROOTS} ORDER BY r.oid`;
const inventorySql = `SELECT
 current_database()='postgres' AS correct_database,
 (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid,
 current_user::regrole::oid::text AS current_role_oid,
 (SELECT count(*)::text FROM pg_catalog.pg_roles r WHERE ${ROOTS}) AS roots,
 (SELECT count(*)::text FROM pg_catalog.pg_roles) AS all_roles,
 (SELECT count(*)::text FROM pg_catalog.pg_namespace) AS schemas,
 (SELECT count(*)::text FROM pg_catalog.pg_class c WHERE ${RELATIONS}) AS relations,
 (SELECT count(*)::text FROM pg_catalog.pg_class c WHERE c.relkind='S') AS sequences,
 (SELECT count(*)::text FROM pg_catalog.pg_auth_members) AS edges,
 (SELECT count(*)::text FROM pg_catalog.pg_proc p WHERE p.prosecdef AND p.prokind IN ('f','p') AND ${PUBLIC_FUNCTION}) AS definers,
 (SELECT count(*)::text FROM (${evidenceTargetSql}) evidence_target_count) AS evidence_targets,
 (SELECT count(*)::text FROM (${evidenceGrantSql}) evidence_grant_count) AS evidence_grants`;
const functionSql = `SELECT r.oid::text AS role_oid,p.oid::text AS object_oid,p.proowner::text AS owner_oid,
 p.pronamespace::text AS schema_oid,p.proacl IS NULL AS default_acl,
 pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE') AS effective_execute,
 pg_catalog.has_schema_privilege(r.oid,p.pronamespace,'USAGE') AS schema_usage,
 CASE WHEN p.oid IS NULL THEN NULL ELSE ${PUBLIC_FUNCTION} END AS public_execute,
 p.proacl::text AS internal_acl
 FROM pg_catalog.pg_roles r CROSS JOIN (VALUES ('pg_catalog.pg_control_system()'),
 ('pg_catalog.current_setting(text)'),('pg_catalog.current_setting(text,boolean)')) v(signature)
 LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(v.signature)
 WHERE ${ROOTS} ORDER BY r.oid,v.signature`;
const databaseSql = `SELECT r.oid::text AS role_oid,d.oid::text AS object_oid,d.datdba::text AS owner_oid,
 d.datacl IS NULL AS default_acl,
 pg_catalog.has_database_privilege(r.oid,d.oid,'CONNECT') AS effective_connect,
 pg_catalog.has_database_privilege(r.oid,d.oid,'CREATE') AS effective_create,
 pg_catalog.has_database_privilege(r.oid,d.oid,'TEMP') AS effective_temp,
 ${publicPrivilege('d.datacl', 'd.datdba', 'd', 'CONNECT')} AS public_connect,
 ${publicPrivilege('d.datacl', 'd.datdba', 'd', 'CREATE')} AS public_create,
 ${publicPrivilege('d.datacl', 'd.datdba', 'd', 'TEMPORARY')} AS public_temp,
 pg_catalog.pg_has_role(r.oid,d.datdba,'USAGE') AS owner_usage,
 pg_catalog.pg_has_role(r.oid,d.datdba,'SET') AS owner_set,d.datacl::text AS internal_acl
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_database d
 WHERE ${ROOTS} AND d.datname='postgres' ORDER BY r.oid,d.oid`;
const schemaSql = `SELECT r.oid::text AS role_oid,n.oid::text AS object_oid,n.nspowner::text AS owner_oid,
 n.nspacl IS NULL AS default_acl,pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE') AS effective_usage,
 pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE') AS effective_create,
 ${publicPrivilege('n.nspacl', 'n.nspowner', 'n', 'USAGE')} AS public_usage,
 ${publicPrivilege('n.nspacl', 'n.nspowner', 'n', 'CREATE')} AS public_create,
 pg_catalog.pg_has_role(r.oid,n.nspowner,'USAGE') AS owner_usage,
 pg_catalog.pg_has_role(r.oid,n.nspowner,'SET') AS owner_set,n.nspacl::text AS internal_acl
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_namespace n WHERE ${ROOTS} ORDER BY r.oid,n.oid`;
const membershipSql = `SELECT r.oid::text AS role_oid,t.oid::text AS object_oid,
 pg_catalog.pg_has_role(r.oid,t.oid,'MEMBER') AS member,
 pg_catalog.pg_has_role(r.oid,t.oid,'USAGE') AS usage,
 pg_catalog.pg_has_role(r.oid,t.oid,'SET') AS settable
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_roles t WHERE ${ROOTS} ORDER BY r.oid,t.oid`;
const edgeSql = `SELECT roleid::text AS object_oid,member::text AS role_oid,grantor::text AS grantor_oid,
 admin_option AS admin,inherit_option AS inherit,set_option AS settable
 FROM pg_catalog.pg_auth_members ORDER BY roleid,member,grantor`;
const relationSql = `SELECT r.oid::text AS role_oid,c.oid::text AS object_oid,c.relowner::text AS owner_oid,
 c.relnamespace::text AS schema_oid,c.relacl IS NULL AS default_acl,
 pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE') AS owner_usage,
 pg_catalog.pg_has_role(r.oid,c.relowner,'SET') AS owner_set,
 pg_catalog.has_schema_privilege(r.oid,c.relnamespace,'USAGE') AS schema_usage,
 pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT') AS table_insert,
 pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE') AS table_update,
 pg_catalog.has_table_privilege(r.oid,c.oid,'DELETE') AS table_delete,
 pg_catalog.has_table_privilege(r.oid,c.oid,'TRUNCATE') AS table_truncate,
 pg_catalog.has_table_privilege(r.oid,c.oid,'REFERENCES') AS table_references,
 pg_catalog.has_table_privilege(r.oid,c.oid,'TRIGGER') AS table_trigger,
 pg_catalog.has_table_privilege(r.oid,c.oid,'MAINTAIN') AS table_maintain,
 pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT') AS column_insert,
 pg_catalog.has_any_column_privilege(r.oid,c.oid,'UPDATE') AS column_update,
 c.relacl::text AS internal_acl,
 (SELECT string_agg(a.attnum::text||':'||a.attacl::text,',' ORDER BY a.attnum)
 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped AND a.attnum>0 AND a.attacl IS NOT NULL) AS internal_column_acl
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c WHERE ${ROOTS} AND ${RELATIONS} ORDER BY r.oid,c.oid`;
const sequenceSql = `SELECT r.oid::text AS role_oid,c.oid::text AS object_oid,c.relowner::text AS owner_oid,
 c.relnamespace::text AS schema_oid,c.relacl IS NULL AS default_acl,
 pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE') AS effective_usage,
 pg_catalog.has_sequence_privilege(r.oid,c.oid,'UPDATE') AS effective_update,
 pg_catalog.pg_has_role(r.oid,c.relowner,'USAGE') AS owner_usage,
 pg_catalog.pg_has_role(r.oid,c.relowner,'SET') AS owner_set,c.relacl::text AS internal_acl
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c WHERE ${ROOTS} AND c.relkind='S' ORDER BY r.oid,c.oid`;
const definerSql = `SELECT r.oid::text AS role_oid,p.oid::text AS object_oid,p.proowner::text AS owner_oid,
 p.pronamespace::text AS schema_oid,p.proacl IS NULL AS default_acl,
 pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE') AS effective_execute,
 pg_catalog.has_schema_privilege(r.oid,p.pronamespace,'USAGE') AS schema_usage,
 ${PUBLIC_FUNCTION} AS public_execute,p.proacl::text AS internal_acl
 FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_proc p
 WHERE ${ROOTS} AND p.prosecdef AND p.prokind IN ('f','p') AND ${PUBLIC_FUNCTION} ORDER BY r.oid,p.oid`;

const definitions = {
  roles: [
    roleSql,
    'ROLE',
    ['role_oid'],
    [
      'login',
      'inherit',
      'superuser',
      'create_database',
      'create_role',
      'replication',
      'bypass_rls',
      'stats_member',
      'stats_usage',
      'stats_set',
      'settings_usage',
    ],
  ],
  functions: [
    functionSql,
    'FUNCTION',
    ['role_oid', 'object_oid', 'owner_oid', 'schema_oid'],
    ['default_acl', 'effective_execute', 'schema_usage', 'public_execute'],
  ],
  databases: [
    databaseSql,
    'DATABASE',
    ['role_oid', 'object_oid', 'owner_oid'],
    [
      'default_acl',
      'effective_connect',
      'effective_create',
      'effective_temp',
      'public_connect',
      'public_create',
      'public_temp',
      'owner_usage',
      'owner_set',
    ],
  ],
  schemas: [
    schemaSql,
    'SCHEMA',
    ['role_oid', 'object_oid', 'owner_oid'],
    [
      'default_acl',
      'effective_usage',
      'effective_create',
      'public_usage',
      'public_create',
      'owner_usage',
      'owner_set',
    ],
  ],
  memberships: [
    membershipSql,
    'ROLE_MEMBERSHIP',
    ['role_oid', 'object_oid'],
    ['member', 'usage', 'settable'],
  ],
  edges: [
    edgeSql,
    'MEMBERSHIP_EDGE',
    ['role_oid', 'object_oid', 'grantor_oid'],
    ['admin', 'inherit', 'settable'],
  ],
  relations: [
    relationSql,
    'RELATION',
    ['role_oid', 'object_oid', 'owner_oid', 'schema_oid'],
    [
      'default_acl',
      'owner_usage',
      'owner_set',
      'schema_usage',
      'table_insert',
      'table_update',
      'table_delete',
      'table_truncate',
      'table_references',
      'table_trigger',
      'table_maintain',
      'column_insert',
      'column_update',
    ],
  ],
  sequences: [
    sequenceSql,
    'SEQUENCE',
    ['role_oid', 'object_oid', 'owner_oid', 'schema_oid'],
    [
      'default_acl',
      'effective_usage',
      'effective_update',
      'owner_usage',
      'owner_set',
    ],
  ],
  definers: [
    definerSql,
    'SECURITY_DEFINER',
    ['role_oid', 'object_oid', 'owner_oid', 'schema_oid'],
    ['default_acl', 'effective_execute', 'schema_usage', 'public_execute'],
  ],
};
const oid = (v) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);
function fail(code) {
  const e = new Error(code);
  e.safeReason = code;
  throw e;
}
function ensure(ok, code = 'ACL_INCOMPLETE_RESULT') {
  if (!ok) fail(code);
}

async function inspectAcl(query, expectedRoles, transaction) {
  ensure(
    transaction?.owner === 'METADATA_CLIENT' && oid(transaction.backendPid),
    'ACL_TRANSACTION_INVALID',
  );
  const expectedOids = expectedRoles.map((r) => r.oid).sort();
  const expectedCurrent = expectedRoles.find(
    (r) => r.rolname === 'ttv_surplus_lifecycle',
  )?.oid;
  ensure(
    expectedOids.length === 3 &&
      new Set(expectedOids).size === 3 &&
      expectedOids.every(oid) &&
      oid(expectedCurrent),
    'ACL_ROLE_OID_MISMATCH',
  );
  async function verifyTransaction(previous) {
    const rows = (await query(transactionSql)).rows;
    ensure(Array.isArray(rows) && rows.length === 1, 'ACL_TRANSACTION_INVALID');
    const r = rows[0];
    ensure(
      r.isolation === 'repeatable read' &&
        r.read_only === 'on' &&
        r.default_read_only === 'on' &&
        r.backend_pid === transaction.backendPid &&
        r.correct_database === true &&
        r.database_oid === '5' &&
        r.current_role_oid === expectedCurrent &&
        typeof r.snapshot === 'string' &&
        /^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(r.snapshot),
      'ACL_TRANSACTION_INVALID',
    );
    if (previous)
      ensure(
        JSON.stringify(r) === JSON.stringify(previous),
        'ACL_SNAPSHOT_CHANGED',
      );
    return r;
  }
  const tx = await verifyTransaction();
  async function sample(previousInventory) {
    const inventoryRows = (await query(inventorySql)).rows;
    ensure(inventoryRows.length === 1);
    const inventory = inventoryRows[0];
    ensure(inventory.correct_database === true, 'ACL_SCOPE_MISMATCH');
    if (previousInventory)
      ensure(
        JSON.stringify(inventory) === JSON.stringify(previousInventory),
        'ACL_SNAPSHOT_CHANGED',
      );
    ensure(inventory.database_oid === tx.database_oid, 'ACL_SCOPE_MISMATCH');
    ensure(
      oid(inventory.database_oid) &&
        inventory.current_role_oid === expectedCurrent,
      'ACL_ROLE_OID_MISMATCH',
    );
    for (const k of [
      'roots',
      'all_roles',
      'schemas',
      'relations',
      'sequences',
      'edges',
      'definers',
      'evidence_targets',
      'evidence_grants',
    ])
      ensure(
        typeof inventory[k] === 'string' &&
          /^\d+$/.test(inventory[k]) &&
          Number.isSafeInteger(Number(inventory[k])),
      );
    ensure(
      inventory.roots === '3' &&
        Number(inventory.schemas) > 0 &&
        Number(inventory.relations) > 0,
    );
    ensure(
      inventory.evidence_targets === '1' &&
        Number(inventory.evidence_grants) <= 256,
      'ACL_EVIDENCE_INVALID',
    );
    const expectedCounts = {
      roles: 3,
      functions: 9,
      databases: 3,
      schemas: 3 * Number(inventory.schemas),
      memberships: 3 * Number(inventory.all_roles),
      edges: Number(inventory.edges),
      relations: 3 * Number(inventory.relations),
      sequences: 3 * Number(inventory.sequences),
      definers: 3 * Number(inventory.definers),
    };
    const raw = {},
      filtered = {};
    for (const [
      category,
      [sql, objectType, oidFields, boolFields],
    ] of Object.entries(definitions)) {
      const rows = (await query(sql)).rows;
      ensure(Array.isArray(rows) && rows.length === expectedCounts[category]);
      const keys = new Set();
      filtered[category] = rows.map((r) => {
        if (category === 'databases')
          ensure(r.object_oid === inventory.database_oid, 'ACL_SCOPE_MISMATCH');
        if (category === 'roles')
          ensure(
            expectedRoles.some(
              (e) => e.rolname === r.internal_name && e.oid === r.role_oid,
            ),
            'ACL_ROLE_OID_MISMATCH',
          );
        for (const key of oidFields)
          ensure(
            oid(r[key]),
            category === 'functions'
              ? 'ACL_FUNCTION_UNRESOLVED'
              : 'ACL_INCOMPLETE_RESULT',
          );
        for (const key of boolFields) ensure(typeof r[key] === 'boolean');
        if (category !== 'edges')
          ensure(expectedOids.includes(r.role_oid), 'ACL_ROLE_OID_MISMATCH');
        const key = oidFields
          .filter((k) => !['owner_oid', 'schema_oid'].includes(k))
          .map((k) => r[k])
          .join(':');
        ensure(!keys.has(key));
        keys.add(key);
        return {
          objectType,
          ...Object.fromEntries(
            [...oidFields, ...boolFields].map((k) => [k, r[k]]),
          ),
        };
      });
      raw[category] = rows;
    }
    ensure(
      JSON.stringify(filtered.roles.map((r) => r.role_oid).sort()) ===
        JSON.stringify(expectedOids),
      'ACL_ROLE_OID_MISMATCH',
    );
    // Completeness per role, not merely total count.
    for (const category of [
      'functions',
      'databases',
      'schemas',
      'memberships',
      'relations',
      'sequences',
      'definers',
    ]) {
      const perRole = expectedCounts[category] / 3;
      for (const roleOid of expectedOids)
        ensure(
          filtered[category].filter((r) => r.role_oid === roleOid).length ===
            perRole,
        );
    }
    const targetRows = (await query(evidenceTargetSql)).rows;
    const grantRows = (await query(evidenceGrantSql)).rows;
    const wideRows = (await query(evidenceRoleSql)).rows;
    ensure(
      Array.isArray(targetRows) &&
        targetRows.length === 1 &&
        Array.isArray(grantRows) &&
        grantRows.length === Number(inventory.evidence_grants) &&
        Array.isArray(wideRows) &&
        wideRows.length === 3,
      'ACL_EVIDENCE_INVALID',
    );
    const target = targetRows[0];
    ensure(
      ['object_oid', 'schema_oid', 'owner_oid'].every((k) => oid(target[k])) &&
        target.schema_name === 'pg_catalog' &&
        target.relation_name === 'pg_settings' &&
        target.relkind === 'v',
      'ACL_EVIDENCE_INVALID',
    );
    const identity = Object.fromEntries(
      [
        'object_oid',
        'schema_oid',
        'schema_name',
        'relation_name',
        'relkind',
        'owner_oid',
      ].map((k) => [k, target[k]]),
    );
    const grants = grantRows.map((r) => {
      ensure(
        ['RELATION', 'COLUMN'].includes(r.scope) &&
          Number.isSafeInteger(r.attnum) &&
          (r.scope === 'RELATION' ? r.attnum === 0 : r.attnum > 0) &&
          oid(r.grantor_oid) &&
          (r.grantee_oid === '0' || oid(r.grantee_oid)) &&
          typeof r.grantable === 'boolean',
        'ACL_EVIDENCE_INVALID',
      );
      return Object.fromEntries(
        ['scope', 'attnum', 'grantor_oid', 'grantee_oid', 'grantable'].map(
          (k) => [k, r[k]],
        ),
      );
    });
    ensure(
      new Set(
        grants.map((r) =>
          [r.scope, r.attnum, r.grantor_oid, r.grantee_oid].join(':'),
        ),
      ).size === grants.length,
      'ACL_EVIDENCE_INVALID',
    );
    const evidenceRoles = wideRows.map((r) => {
      ensure(
        expectedOids.includes(r.role_oid) &&
          typeof r.write_all_usage === 'boolean' &&
          typeof r.write_all_set === 'boolean',
        'ACL_EVIDENCE_INVALID',
      );
      const relation = filtered.relations.find(
        (a) => a.role_oid === r.role_oid && a.object_oid === target.object_oid,
      );
      ensure(
        relation &&
          relation.owner_oid === target.owner_oid &&
          relation.schema_oid === target.schema_oid,
        'ACL_EVIDENCE_INVALID',
      );
      return {
        role_oid: r.role_oid,
        write_all_usage: r.write_all_usage,
        write_all_set: r.write_all_set,
      };
    });
    ensure(
      new Set(evidenceRoles.map((r) => r.role_oid)).size === 3,
      'ACL_EVIDENCE_INVALID',
    );
    const paths = evidenceRoles.flatMap((r) =>
      grants.map((g) => {
        const m = filtered.memberships.find(
          (m) => m.role_oid === r.role_oid && m.object_oid === g.grantee_oid,
        );
        ensure(g.grantee_oid === '0' || m, 'ACL_EVIDENCE_INVALID');
        return {
          role_oid: r.role_oid,
          scope: g.scope,
          attnum: g.attnum,
          grantor_oid: g.grantor_oid,
          grantee_oid: g.grantee_oid,
          public: g.grantee_oid === '0',
          direct: g.grantee_oid === r.role_oid,
          inherited:
            g.grantee_oid !== '0' && g.grantee_oid !== r.role_oid && m.usage,
          settable: g.grantee_oid !== '0' && m.settable,
          grantable: g.grantable,
        };
      }),
    );
    for (const r of evidenceRoles) {
      const relation = filtered.relations.find(
        (a) => a.role_oid === r.role_oid && a.object_oid === target.object_oid,
      );
      const owner = filtered.memberships.find(
        (m) => m.role_oid === r.role_oid && m.object_oid === target.owner_oid,
      );
      ensure(
        owner &&
          owner.usage === relation.owner_usage &&
          owner.settable === relation.owner_set,
        'ACL_EVIDENCE_INVALID',
      );
      const usable = paths.filter(
        (p) =>
          p.role_oid === r.role_oid && (p.public || p.direct || p.inherited),
      );
      const baseline = filtered.roles.find((a) => a.role_oid === r.role_oid);
      const tableUpdate =
        baseline.superuser ||
        r.write_all_usage ||
        usable.some((p) => p.scope === 'RELATION');
      ensure(
        relation.table_update === tableUpdate &&
          relation.column_update ===
            (tableUpdate || usable.some((p) => p.scope === 'COLUMN')),
        'ACL_EVIDENCE_INVALID',
      );
    }
    const evidence = {
      transaction: {
        owner: 'METADATA_CLIENT',
        isolation: 'repeatable read',
        readOnly: true,
        sameSnapshot: true,
      },
      database_oid: inventory.database_oid,
      identity,
      counts: { grants: grants.length, paths: paths.length, roles: 3 },
      grants,
      paths,
      roles: evidenceRoles,
    };
    raw.evidence = { targetRows, grantRows, wideRows };
    return { inventory, raw, filtered, expectedCounts, evidence };
  }
  const first = await sample();
  const second = await sample(first.inventory);
  ensure(
    JSON.stringify({ inventory: first.inventory, rows: first.raw }) ===
      JSON.stringify({ inventory: second.inventory, rows: second.raw }),
    'ACL_SNAPSHOT_CHANGED',
  );
  await verifyTransaction(tx);
  return {
    status: 'VERIFIED',
    database_oid: first.inventory.database_oid,
    snapshotMatched: true,
    counts: first.expectedCounts,
    objects: first.filtered,
    evidence: first.evidence,
  };
}
module.exports = { inspectAcl };
