'use strict';
// Reuse the existing identity + session inspector on the SAME verified connection.
// Importing this module does not load pg or connect. No application URL fallback.
const { createHash } = require('node:crypto');
const { inspectSessions } = require('./inspect-payment-surplus-sessions.cjs');
const { inspectAcl } = require('./inspect-payment-surplus-acl.cjs');
const ORPHAN = Object.freeze({
  name: 'ttv_surplus_it_f646e091562849a38743a12b41e8ec2f',
  oid: '16393',
  owner: 'ttv_surplus_writer',
  ownerOid: '16389',
  fingerprint:
    '2503a0a7006f4750f386396ecace600286d21a7243ce4566e0fd9005291ce5c6',
});
const ROLES = [
  'ttv_surplus_lifecycle',
  'ttv_surplus_writer',
  'ttv_surplus_reader',
];
const ROLE_SQL = `SELECT oid::text, rolname, rolcanlogin, rolcreatedb, rolsuper,
  rolcreaterole, rolreplication, rolbypassrls, rolinherit,
  pg_catalog.pg_has_role(oid,'pg_read_all_stats','MEMBER') AS stats_member,
  pg_catalog.pg_has_role(oid,'pg_read_all_stats','USAGE') AS stats_usage,
  pg_catalog.pg_has_role(oid,'pg_read_all_stats','SET') AS stats_set,
  pg_catalog.pg_has_role(oid,'pg_monitor','MEMBER') AS monitor_member,
  pg_catalog.pg_has_role(oid,'pg_monitor','USAGE') AS monitor_usage,
  pg_catalog.pg_has_role(oid,'pg_monitor','SET') AS monitor_set,
  pg_catalog.pg_has_role(oid,'pg_read_all_settings','MEMBER') AS settings_member,
  pg_catalog.pg_has_role(oid,'pg_read_all_settings','USAGE') AS settings_usage,
  pg_catalog.pg_has_role(oid,'pg_read_all_settings','SET') AS settings_set
  FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`;
const DATABASE_SQL = `SELECT d.datname, d.oid::text, d.datdba::text AS owner_oid,
  pg_catalog.pg_get_userbyid(d.datdba) AS owner, d.datacl IS NULL AS acl_default,
  pg_catalog.has_database_privilege($1::oid,d.oid,'CREATE') AS writer_create,
  pg_catalog.has_database_privilege($2::oid,d.oid,'CREATE') AS reader_create,
  pg_catalog.shobj_description(d.oid,'pg_database') AS marker
  FROM pg_catalog.pg_database d ORDER BY d.datname`;
const ACL_SQL = `SELECT d.oid::text AS database_oid, a.grantor::text AS grantor_oid,
  a.grantee::text AS grantee_oid, g.rolname AS grantor, r.rolname AS grantee,
  a.privilege_type, a.is_grantable
  FROM pg_catalog.pg_database d
  CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a
  LEFT JOIN pg_catalog.pg_roles g ON g.oid=a.grantor
  LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
  ORDER BY d.oid,a.grantee,a.privilege_type`;
const oid = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
const roleName = (value) =>
  ['postgres', ...ROLES].includes(value) ? value : 'OTHER_ROLE_REDACTED';
const databaseName = (value) =>
  [
    'postgres',
    'template0',
    'template1',
    'text_to_voice',
    'text_to_voice_test',
  ].includes(value) ||
  (typeof value === 'string' && /^ttv_surplus_it_[0-9a-f]{32}$/.test(value))
    ? value
    : 'OTHER_DATABASE_REDACTED';
function ensure(ok) {
  if (!ok) {
    const error = new Error('INVALID_METADATA');
    error.safeReason = 'INVALID_METADATA';
    throw error;
  }
}
async function bounded(task, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('ACL_TRANSACTION_TIMEOUT')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Narrow policy B: privilege shape only, never proof that a view definition is unmodified.
function classifyAclWrites(report) {
  let eligible = false;
  try {
    const e = report.evidence,
      id = e.identity,
      roots = report.objects.roles.map((r) => r.role_oid);
    eligible =
      report.status === 'VERIFIED' &&
      report.snapshotMatched === true &&
      report.database_oid === '5' &&
      e.database_oid === '5' &&
      e.transaction.owner === 'METADATA_CLIENT' &&
      e.transaction.isolation === 'repeatable read' &&
      e.transaction.readOnly === true &&
      e.transaction.sameSnapshot === true &&
      id.schema_name === 'pg_catalog' &&
      id.relation_name === 'pg_settings' &&
      id.relkind === 'v' &&
      id.schema_oid === '11' &&
      id.owner_oid === '10' &&
      oid(id.object_oid) &&
      roots.length === 3 &&
      new Set(roots).size === 3 &&
      roots.every(oid) &&
      Object.keys(report.counts).length === 9 &&
      Object.entries(report.counts).every(
        ([k, n]) =>
          Array.isArray(report.objects[k]) &&
          Number.isSafeInteger(n) &&
          n === report.objects[k].length,
      ) &&
      e.counts.roles === 3 &&
      e.roles.length === 3 &&
      new Set(e.roles.map((r) => r.role_oid)).size === 3 &&
      e.counts.grants === 2 &&
      e.grants.length === 2 &&
      e.counts.paths === 6 &&
      e.paths.length === 6 &&
      e.grants.every(
        (g) =>
          g.scope === 'RELATION' &&
          g.attnum === 0 &&
          g.grantor_oid === '10' &&
          ['0', '10'].includes(g.grantee_oid) &&
          g.grantable === false,
      ) &&
      new Set(e.grants.map((g) => g.grantee_oid)).size === 2 &&
      roots.every((root) => {
        const role = report.objects.roles.find((r) => r.role_oid === root);
        const wide = e.roles.find((r) => r.role_oid === root);
        const targets = report.objects.relations.filter(
          (r) => r.role_oid === root && r.object_oid === id.object_oid,
        );
        const owners = report.objects.memberships.filter(
          (m) => m.role_oid === root && m.object_oid === id.owner_oid,
        );
        if (
          role.superuser !== false ||
          !wide ||
          wide.write_all_usage !== false ||
          wide.write_all_set !== false ||
          targets.length !== 1 ||
          owners.length !== 1 ||
          owners[0].usage !== false ||
          owners[0].settable !== false
        )
          return false;
        const r = targets[0];
        if (
          r.schema_oid !== id.schema_oid ||
          r.owner_oid !== id.owner_oid ||
          r.default_acl !== false ||
          r.schema_usage !== true ||
          r.table_update !== true ||
          r.column_update !== true ||
          r.owner_usage !== false ||
          r.owner_set !== false
        )
          return false;
        const other = [
          'table_insert',
          'table_delete',
          'table_truncate',
          'table_references',
          'table_trigger',
          'table_maintain',
          'column_insert',
        ];
        if (!other.every((k) => r[k] === false)) return false;
        return ['0', '10'].every((grantee) => {
          const paths = e.paths.filter(
            (p) => p.role_oid === root && p.grantee_oid === grantee,
          );
          return (
            paths.length === 1 &&
            paths[0].scope === 'RELATION' &&
            paths[0].attnum === 0 &&
            paths[0].grantor_oid === '10' &&
            paths[0].grantable === false &&
            paths[0].public === (grantee === '0') &&
            paths[0].direct === false &&
            paths[0].inherited === false &&
            paths[0].settable === false
          );
        });
      });
  } catch {
    eligible = false;
  }
  const relations = report?.objects?.relations;
  const sequences = report?.objects?.sequences;
  const blocked =
    !Array.isArray(relations) ||
    !Array.isArray(sequences) ||
    relations.some((r) =>
      Object.entries(r).some(
        ([k, v]) =>
          (k.startsWith('table_') ||
            k.startsWith('column_') ||
            k === 'owner_usage' ||
            k === 'owner_set') &&
          v === true &&
          !(
            eligible &&
            r.object_oid === report.evidence.identity.object_oid &&
            ['table_update', 'column_update'].includes(k)
          ),
      ),
    ) ||
    sequences.some(
      (r) =>
        r.effective_usage || r.effective_update || r.owner_usage || r.owner_set,
    );
  return {
    blocked,
    warnings: eligible
      ? [
          {
            code: 'PG_SETTINGS_DEFAULT_PUBLIC_UPDATE',
            database_oid: '5',
            object_oid: report.evidence.identity.object_oid,
            role_oids: report.objects.roles.map((r) => r.role_oid).sort(),
          },
        ]
      : [],
  };
}

async function collectMetadataData(raw, { Client, aclMode = false }) {
  let metadata;
  let aclReport;
  let aclError;
  let verifiedIdentity;
  // The delegate calls pg_stat_activity only AFTER validating endpoint, role,
  // cluster, data directory, read-only and backend PID. Capture catalog metadata
  // at that point; do not open a second connection or broaden privileges.
  class MetadataClient extends Client {
    transactionState = 'NEW';
    connectionLost = false;
    identityPid;
    async connect() {
      ensure(this.transactionState === 'NEW');
      await super.connect();
      if (aclMode) {
        this.on('error', () => {
          this.connectionLost = true;
          metadata = undefined;
          aclReport = undefined;
        });
        this.transactionState = 'OPENING';
        try {
          await bounded(
            () =>
              super.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
            5000,
          );
          this.transactionState = 'OPEN';
        } catch {
          aclError = { code: 'ACL_TRANSACTION_INVALID' };
          throw new Error('ACL_TRANSACTION_INVALID');
        }
      }
    }
    async rollbackOwned(milliseconds) {
      if (this.transactionState !== 'OPEN') return;
      this.transactionState = 'ENDING';
      try {
        await bounded(() => super.query('ROLLBACK'), milliseconds);
        this.transactionState = 'ROLLED_BACK';
      } catch {
        this.transactionState = 'UNCERTAIN';
        metadata = undefined;
        aclReport = undefined;
        aclError = { code: 'ACL_TRANSACTION_INVALID' };
        throw new Error('ACL_TRANSACTION_INVALID');
      }
    }
    async end() {
      if (!aclMode) return super.end();
      let failure;
      try {
        await this.rollbackOwned(1000);
      } catch (e) {
        failure = e;
      }
      try {
        await bounded(() => super.end(), 1500);
      } catch (e) {
        failure = e;
        try {
          this.unref();
        } catch {}
      }
      if (
        this.transactionState !== 'ROLLED_BACK' ||
        failure ||
        this.connectionLost
      ) {
        metadata = undefined;
        aclReport = undefined;
        if (failure) throw new Error('ACL_TRANSACTION_CLOSE_FAILED');
      }
      this.transactionState = 'CLOSED';
    }
    async query(sql, parameters) {
      try {
        ensure(
          typeof sql === 'string' &&
            /^SELECT\s/i.test(sql) &&
            !sql.includes(';'),
        );
        if (aclMode)
          ensure(this.transactionState === 'OPEN' && !this.connectionLost);
        if (sql.includes('FROM pg_catalog.pg_stat_activity') && !metadata) {
          const roleRows = (await super.query(ROLE_SQL, [ROLES])).rows;
          ensure(
            roleRows.length === 3 &&
              new Set(roleRows.map((r) => r.rolname)).size === 3,
          );
          for (const row of roleRows) {
            ensure(ROLES.includes(row.rolname) && oid(row.oid));
            for (const key of [
              'rolcanlogin',
              'rolcreatedb',
              'rolsuper',
              'rolcreaterole',
              'rolreplication',
              'rolbypassrls',
              'rolinherit',
              'stats_member',
              'stats_usage',
              'stats_set',
              'monitor_member',
              'monitor_usage',
              'monitor_set',
              'settings_member',
              'settings_usage',
              'settings_set',
            ])
              ensure(typeof row[key] === 'boolean');
          }
          const writer = roleRows.find((r) => r.rolname === ROLES[1]);
          const reader = roleRows.find((r) => r.rolname === ROLES[2]);
          const dbRows = (
            await super.query(DATABASE_SQL, [writer.oid, reader.oid])
          ).rows;
          ensure(dbRows.length > 0);
          const databases = dbRows.map((r) => {
            ensure(
              oid(r.oid) &&
                oid(r.owner_oid) &&
                typeof r.datname === 'string' &&
                typeof r.owner === 'string' &&
                typeof r.writer_create === 'boolean' &&
                typeof r.reader_create === 'boolean' &&
                typeof r.acl_default === 'boolean' &&
                (r.marker === null || typeof r.marker === 'string'),
            );
            return {
              name: databaseName(r.datname),
              oid: r.oid,
              owner: roleName(r.owner),
              ownerOid: r.owner_oid,
              aclSource: r.acl_default ? 'DEFAULT' : 'EXPLICIT',
              writerCreate: r.writer_create,
              readerCreate: r.reader_create,
              markerFormat:
                r.marker === null
                  ? 'ABSENT'
                  : /^ttv-surplus-it:[0-9a-f]{64}$/.test(r.marker)
                    ? 'HARNESS_FORMAT'
                    : 'OTHER',
              markerSha256:
                r.marker === null
                  ? null
                  : createHash('sha256').update(r.marker).digest('hex'),
            };
          });
          const aclRows = (await super.query(ACL_SQL)).rows;
          const acl = aclRows.map((r) => {
            ensure(
              oid(r.database_oid) &&
                databases.some((d) => d.oid === r.database_oid) &&
                oid(r.grantor_oid) &&
                (r.grantee_oid === '0' || oid(r.grantee_oid)) &&
                ['CREATE', 'CONNECT', 'TEMPORARY'].includes(r.privilege_type) &&
                typeof r.is_grantable === 'boolean',
            );
            return {
              databaseOid: r.database_oid,
              grantorOid: r.grantor_oid,
              grantor: roleName(r.grantor),
              granteeOid: r.grantee_oid,
              grantee: r.grantee_oid === '0' ? 'PUBLIC' : roleName(r.grantee),
              privilege: r.privilege_type,
              grantable: r.is_grantable,
            };
          });
          const orphanRows = dbRows.filter(
            (r) => r.datname === ORPHAN.name || r.oid === ORPHAN.oid,
          );
          let orphan = 'ABSENT_AT_SNAPSHOT';
          if (orphanRows.length) {
            const r = orphanRows[0];
            orphan =
              orphanRows.length === 1 &&
              r.datname === ORPHAN.name &&
              r.oid === ORPHAN.oid &&
              r.owner === ORPHAN.owner &&
              r.owner_oid === ORPHAN.ownerOid &&
              r.marker !== null &&
              /^ttv-surplus-it:[0-9a-f]{64}$/.test(r.marker) &&
              createHash('sha256').update(r.marker).digest('hex') ===
                ORPHAN.fingerprint
                ? 'CURRENT_IDENTITY_VERIFIED'
                : 'IDENTITY_CHANGED_OR_UNVERIFIED';
          }
          metadata = {
            databases,
            acl,
            orphan,
            origin: 'UNVERIFIED',
            roles: roleRows.map((r) => ({
              name: r.rolname,
              oid: r.oid,
              login: r.rolcanlogin,
              createDb: r.rolcreatedb,
              superuser: r.rolsuper,
              createRole: r.rolcreaterole,
              replication: r.rolreplication,
              bypassRls: r.rolbypassrls,
              inherit: r.rolinherit,
              observationRights: {
                pg_read_all_stats: {
                  MEMBER: r.stats_member,
                  USAGE: r.stats_usage,
                  SET: r.stats_set,
                },
                pg_monitor: {
                  MEMBER: r.monitor_member,
                  USAGE: r.monitor_usage,
                  SET: r.monitor_set,
                },
                pg_read_all_settings: {
                  MEMBER: r.settings_member,
                  USAGE: r.settings_usage,
                  SET: r.settings_set,
                },
              },
              fullStatsEffective: r.stats_usage,
            })),
          };
        }
        if (
          aclMode &&
          sql.includes('FROM pg_catalog.pg_stat_activity') &&
          !aclReport
        ) {
          try {
            const roles = await super.query(ROLE_SQL, [ROLES]);
            if (!(
              roles.rows.length === metadata.roles.length &&
              roles.rows.every((r) =>
                metadata.roles.some(
                  (m) => m.name === r.rolname && m.oid === r.oid,
                ),
              )
            )) {
              const mismatch = new Error('ACL_ROLE_OID_MISMATCH');
              mismatch.safeReason = 'ACL_ROLE_OID_MISMATCH';
              throw mismatch;
            }
            aclReport = await inspectAcl(
              (statement) => {
                ensure(
                  this.transactionState === 'OPEN' &&
                    !this.connectionLost &&
                    typeof statement === 'string' &&
                    /^SELECT\s/i.test(statement) &&
                    !statement.includes(';'),
                );
                return super.query(statement);
              },
              roles.rows,
              { owner: 'METADATA_CLIENT', backendPid: this.identityPid },
            );
          } catch (error) {
            const codes = new Set([
              'ACL_INCOMPLETE_RESULT',
              'ACL_ROLE_OID_MISMATCH',
              'ACL_FUNCTION_UNRESOLVED',
              'ACL_SNAPSHOT_CHANGED',
              'ACL_SCOPE_MISMATCH',
              'ACL_TRANSACTION_INVALID',
              'ACL_EVIDENCE_INVALID',
            ]);
            aclError = {
              code: codes.has(error.safeReason)
                ? error.safeReason
                : 'ACL_CATALOG_QUERY_FAILED',
              ...(/^[0-9A-Z]{5}$/.test(error.code ?? '')
                ? { sqlstate: error.code }
                : {}),
            };
            const safe = new Error(aclError.code);
            safe.safeReason = aclError.code;
            throw safe;
          }
        }
        const result = await super.query(sql, parameters);
        if (aclMode && sql.includes('AS self_pid')) {
          this.identityPid = result.rows[0]?.self_pid;
          verifiedIdentity = result.rows[0];
        }
        if (aclMode && sql.includes('FROM pg_catalog.pg_stat_activity'))
          await this.rollbackOwned(5000);
        return result;
      } catch (error) {
        if (aclMode) {
          metadata = undefined;
          aclReport = undefined;
          try {
            await this.rollbackOwned(1000);
          } catch {}
        }
        throw error;
      }
    }
  }
  const sessions = await inspectSessions(raw, { Client: MetadataClient });
  return { metadata, aclReport, aclError, sessions, verifiedIdentity };
}

function metadataConditions(metadata, aclReport) {
  const blockers = [];
  let warnings = [];
  if (metadata) {
    if (metadata.databases.some((d) => d.writerCreate || d.readerCreate))
      blockers.push('TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE');
    if (metadata.orphan === 'IDENTITY_CHANGED_OR_UNVERIFIED')
      blockers.push('ORPHAN_IDENTITY_UNVERIFIED');
    if (
      metadata.roles.some(
        (r) =>
          !r.login ||
          r.superuser ||
          r.createRole ||
          r.replication ||
          r.bypassRls ||
          (r.name !== ROLES[0] && r.createDb),
      ) ||
      !metadata.roles.find((r) => r.name === ROLES[0]).createDb
    )
      blockers.push('ROLE_ATTRIBUTES_UNSAFE');
  }
  if (aclReport) {
    if (aclReport.objects.databases.some((r) => r.effective_temp))
      blockers.push('ACL_TEMP_PRIVILEGE_PRESENT');
    if (
      aclReport.objects.schemas.some(
        (r) => r.effective_create || r.owner_usage || r.owner_set,
      )
    )
      blockers.push('ACL_SCHEMA_CREATE_OR_OWNERSHIP_PRESENT');
    const classification = classifyAclWrites(aclReport);
    warnings = classification.warnings;
    if (classification.blocked) blockers.push('ACL_WRITE_CAPABILITIES_PRESENT');
    if (aclReport.objects.definers.length)
      blockers.push('PUBLIC_SECURITY_DEFINER_REVIEW_REQUIRED');
  }

  return { blockers, warnings };
}

// A separate scoped result, never an upgrade of an UNKNOWN standalone report.
// Reuses the same identity guard, SQL, owned read-only transaction and close checks.
async function collectPreflightMetadata(raw, { Client }) {
  const data = await collectMetadataData(raw, { Client, aclMode: true });
  const { metadata, aclReport, aclError, sessions, verifiedIdentity } = data;
  if (
    !metadata ||
    !aclReport ||
    !verifiedIdentity ||
    aclError ||
    !['SESSION_SNAPSHOT_READ', 'OBSERVATION_INCOMPLETE'].includes(
      sessions.reason,
    )
  ) {
    return { verification: 'UNKNOWN', blockers: ['METADATA_UNVERIFIED'] };
  }
  return {
    verification: 'VERIFIED',
    scope: 'POSTGRES_ACL_AND_CLUSTER_DATABASES',
    identity: verifiedIdentity,
    metadata,
    checks: aclReport,
    blockers: metadataConditions(metadata, aclReport).blockers,
  };
}

async function inspectMetadata(raw, { Client, aclMode = false }) {
  const { metadata, aclReport, aclError, sessions } = await collectMetadataData(
    raw,
    { Client, aclMode },
  );

  const blockers = ['EXCLUSIVE_OPERATION_NOT_CONFIRMED'];
  let warnings = [];
  if (!metadata) blockers.push('METADATA_UNVERIFIED');
  if (sessions.status !== 'PASS')
    blockers.push('SESSION_OR_IDENTITY_UNVERIFIED');
  if (sessions.verifiedOtherClients > 0)
    blockers.push('OTHER_CLIENT_SESSIONS_PRESENT');
  if (sessions.unclassifiedOtherBackends > 0)
    blockers.push('UNCLASSIFIED_BACKENDS_PRESENT');
  const conditions = metadataConditions(metadata, aclReport);
  blockers.push(...conditions.blockers);
  warnings = conditions.warnings;
  if (aclMode)
    return {
      verification:
        aclReport && sessions.status === 'PASS' ? 'VERIFIED' : 'UNKNOWN',
      readiness: 'NOT_READY',
      code:
        aclError?.code ??
        (sessions.status === 'PASS' ? 'ACL_READ_VERIFIED' : sessions.reason),
      ...(aclError?.sqlstate ? { sqlstate: aclError.sqlstate } : {}),
      ...(sessions.phase
        ? { phase: sessions.phase, fields: sessions.fields }
        : {}),
      blockers,
      warnings,
      checks: aclReport ?? null,
      blockingDatabaseOids:
        metadata?.databases
          .filter((d) => d.writerCreate || d.readerCreate)
          .map((d) => d.oid) ?? [],
      sessionCheck: {
        status: sessions.status === 'PASS' ? 'VERIFIED' : 'UNKNOWN',
        otherClients: sessions.verifiedOtherClients ?? null,
        backgrounds: sessions.verifiedOtherBackgrounds ?? null,
        unclassified: sessions.unclassifiedOtherBackends ?? null,
      },
    };
  return {
    verification:
      metadata && sessions.status === 'PASS' ? 'VERIFIED' : 'UNKNOWN',
    readiness: 'NOT_READY',
    reason: sessions.reason,
    ...(sessions.phase
      ? { phase: sessions.phase, fields: sessions.fields }
      : {}),
    blockers,
    metadata: metadata ?? null,
    sessions,
  };
}
module.exports = {
  inspectMetadata,
  classifyAclWrites,
  collectPreflightMetadata,
};
if (require.main === module) {
  (async () => {
    const { Client } = require('pg');
    let result;
    try {
      result = await inspectMetadata(process.env.SURPLUS_METADATA_URL, {
        Client,
        aclMode: process.env.SURPLUS_METADATA_ACL === '1',
      });
    } finally {
      delete process.env.SURPLUS_METADATA_URL;
      delete process.env.SURPLUS_METADATA_ACL;
    }
    process.stdout.write(JSON.stringify(result));
    // An inspection never authorizes a harness run. Exit success means metadata verified only.
    process.exitCode = result.verification === 'VERIFIED' ? 0 : 1;
  })().catch(() => {
    process.stdout.write(
      JSON.stringify({
        verification: 'UNKNOWN',
        readiness: 'NOT_READY',
        reason: 'INSPECTION_FAILED',
        blockers: ['METADATA_UNVERIFIED'],
        metadata: null,
      }),
    );
    process.exitCode = 1;
  });
}
