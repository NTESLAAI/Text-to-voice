'use strict';
// Independent orphan cleanup. Imports never connect; default operation is DRY-RUN.
const { createHash } = require('node:crypto');
const TARGET = Object.freeze({
  name: 'ttv_surplus_it_f646e091562849a38743a12b41e8ec2f',
  oid: '16393',
  owner: 'ttv_surplus_writer',
  ownerOid: '16389',
  fingerprint:
    '2503a0a7006f4750f386396ecace600286d21a7243ce4566e0fd9005291ce5c6',
  cluster: '7703979600700924132',
  directory: 'd:/text-to-voice/pg-test-cluster',
});
const approval = `DELETE:${TARGET.name}:${TARGET.oid}:${TARGET.fingerprint}:ORIGIN_UNVERIFIED`;
const normalize = (value) =>
  value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
function refuse(reason) {
  const error = new Error(reason);
  error.cleanupReason = reason;
  throw error;
}
async function deadline(operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const clusterColumns = `current_database() AS db, current_user AS role,
  session_user AS session_role, host(inet_server_addr()) AS host,
  inet_server_port()::text AS port,
  (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
  current_setting('data_directory') AS directory,
  current_setting('default_transaction_read_only') AS session_ro,
  current_setting('transaction_read_only') AS tx_ro`;
// Closed allowlist: a NULL or new/unrecognized type is never assumed background.
const confirmedBackgroundTypes = [
  'autovacuum launcher',
  'autovacuum worker',
  'background writer',
  'checkpointer',
  'walwriter',
  'walsender',
  'walreceiver',
  'logical replication launcher',
  'logical replication worker',
  'parallel worker',
  'background worker',
  'standalone backend',
  'archiver',
  'startup',
  'walsummarizer',
]
  .map((type) => `'${type}'`)
  .join(',');
const sessionCountSql = (targetOid) => `SELECT
  count(*) FILTER (WHERE datid=${targetOid})::text AS target_sessions,
  count(*) FILTER (WHERE backend_type='client backend')::text AS other_sessions,
  count(*) FILTER (WHERE datid=${targetOid} AND backend_type='client backend')::text AS target_client_sessions,
  count(*) FILTER (WHERE datid IS DISTINCT FROM ${targetOid} AND backend_type='client backend')::text AS other_confirmed_client_sessions,
  count(*) FILTER (WHERE backend_type IN (${confirmedBackgroundTypes}))::text AS confirmed_background,
  count(*) FILTER (WHERE backend_type IS NULL OR backend_type NOT IN ('client backend',${confirmedBackgroundTypes}))::text AS unclassified_backends,
  count(*)::text AS observed_backends
  FROM pg_catalog.pg_stat_activity WHERE pid<>pg_backend_pid()`;
function sessionCounts(row) {
  const keys = [
    'target_sessions',
    'other_sessions',
    'target_client_sessions',
    'other_confirmed_client_sessions',
    'confirmed_background',
    'unclassified_backends',
    'observed_backends',
  ];
  if (
    !row ||
    keys.some(
      (key) => typeof row[key] !== 'string' || !/^[0-9]+$/.test(row[key]),
    )
  )
    return undefined;
  const n = Object.fromEntries(keys.map((key) => [key, BigInt(row[key])]));
  if (
    n.target_client_sessions + n.other_confirmed_client_sessions !==
      n.other_sessions ||
    n.other_sessions + n.confirmed_background + n.unclassified_backends !==
      n.observed_backends ||
    n.target_client_sessions > n.target_sessions ||
    n.target_sessions > n.observed_backends
  )
    return undefined;
  return row;
}
function checkCluster(row, readOnly) {
  if (
    !row ||
    row.db !== 'postgres' ||
    row.role !== 'ttv_surplus_lifecycle' ||
    row.session_role !== 'ttv_surplus_lifecycle' ||
    row.host !== '127.0.0.1' ||
    row.port !== '55432' ||
    row.cluster !== TARGET.cluster ||
    typeof row.directory !== 'string' ||
    normalize(row.directory) !== TARGET.directory ||
    row.session_ro !== (readOnly ? 'on' : 'off') ||
    row.tx_ro !== (readOnly ? 'on' : 'off')
  ) {
    refuse('CLUSTER_IDENTITY_MISMATCH');
  }
}

async function cleanup(
  raw,
  options = {},
  { Client, hashMarker = fingerprint } = {},
) {
  let client,
    lost = false,
    dropStarted = false;
  let result = { status: 'DROP_REFUSED', reason: 'PRECHECK_FAILED' };
  const query = (...args) => deadline(() => client.query(...args));
  async function verify(readOnly) {
    const row = (
      await query(
        `SELECT ${clusterColumns},
      d.datname AS name, d.oid::text AS oid, d.datdba::text AS owner_oid,
      pg_catalog.pg_get_userbyid(d.datdba) AS owner,
      pg_catalog.shobj_description(d.oid, 'pg_database') AS marker,
      pg_catalog.pg_has_role(r.oid, d.datdba, 'USAGE') AS can_manage,
      r.rolsuper, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      s.target_sessions, s.other_sessions, s.target_client_sessions,
      s.other_confirmed_client_sessions, s.confirmed_background, s.unclassified_backends, s.observed_backends
      FROM pg_catalog.pg_database d
      JOIN pg_catalog.pg_roles r ON r.rolname=current_user
      CROSS JOIN LATERAL (${sessionCountSql('$2::oid')}) s WHERE d.datname=$1`,
        [TARGET.name, TARGET.oid],
      )
    ).rows[0];
    checkCluster(row, readOnly);
    if (
      row.name !== TARGET.name ||
      !/^ttv_surplus_it_[0-9a-f]{32}$/.test(row.name) ||
      row.oid !== TARGET.oid ||
      row.owner !== TARGET.owner ||
      row.owner_oid !== TARGET.ownerOid
    ) {
      refuse('DATABASE_IDENTITY_MISMATCH');
    }
    if (
      typeof row.marker !== 'string' ||
      !/^ttv-surplus-it:[0-9a-f]{64}$/.test(row.marker) ||
      hashMarker(row.marker) !== TARGET.fingerprint
    )
      refuse('MARKER_FINGERPRINT_MISMATCH');
    if (
      row.can_manage !== true ||
      row.rolsuper !== false ||
      row.rolcreaterole !== false ||
      row.rolreplication !== false ||
      row.rolbypassrls !== false
    )
      refuse('ROLE_PRIVILEGES_MISMATCH');
    if (!sessionCounts(row)) refuse('SESSION_STATE_UNKNOWN');
    if (row.unclassified_backends !== '0')
      refuse('UNCLASSIFIED_BACKENDS_PRESENT');
    if (row.target_sessions !== '0') refuse('TARGET_HAS_SESSIONS');
    if (row.other_sessions !== '0') refuse('EXCLUSIVE_ACCESS_UNVERIFIED');
    if (lost) refuse('CONNECTION_LOST');
  }
  async function inspectDryRun() {
    const row = (
      await query(
        `SELECT ${clusterColumns},
      d.datname AS name, d.oid::text AS oid, d.datdba::text AS owner_oid,
      pg_catalog.pg_get_userbyid(d.datdba) AS owner,
      pg_catalog.shobj_description(d.oid, 'pg_database') AS marker,
      pg_catalog.pg_has_role(r.oid, d.datdba, 'USAGE') AS can_manage,
      r.rolsuper, r.rolcreaterole, r.rolreplication, r.rolbypassrls
      FROM pg_catalog.pg_database d
      JOIN pg_catalog.pg_roles r ON r.rolname=current_user WHERE d.datname=$1`,
        [TARGET.name],
      )
    ).rows[0];
    checkCluster(row, true);
    if (
      row.name !== TARGET.name ||
      row.oid !== TARGET.oid ||
      row.owner !== TARGET.owner ||
      row.owner_oid !== TARGET.ownerOid
    )
      refuse('DATABASE_IDENTITY_MISMATCH');
    if (
      typeof row.marker !== 'string' ||
      !/^ttv-surplus-it:[0-9a-f]{64}$/.test(row.marker) ||
      hashMarker(row.marker) !== TARGET.fingerprint
    )
      refuse('MARKER_FINGERPRINT_MISMATCH');
    const blockers = [];
    if (
      row.can_manage !== true ||
      row.rolsuper !== false ||
      row.rolcreaterole !== false ||
      row.rolreplication !== false ||
      row.rolbypassrls !== false
    )
      blockers.push('ROLE_PRIVILEGES_MISMATCH');
    let targetSessions = 'UNKNOWN',
      otherSessions = 'UNKNOWN',
      sessionStatus = 'UNKNOWN';
    let counts;
    try {
      const sessions = (await query(sessionCountSql('$1::oid'), [TARGET.oid]))
        .rows[0];
      counts = sessionCounts(sessions);
      if (counts) {
        targetSessions = counts.target_sessions;
        otherSessions =
          counts.unclassified_backends === '0'
            ? counts.other_sessions
            : 'UNKNOWN';
        sessionStatus =
          counts.unclassified_backends === '0'
            ? 'READ_OK'
            : 'OBSERVATION_INCOMPLETE';
      }
    } catch (error) {
      sessionStatus =
        error.code === '42501' ? 'INSUFFICIENT_PRIVILEGE' : 'QUERY_FAILED';
    }
    if (!counts) blockers.push('SESSION_STATE_UNKNOWN');
    else {
      if (counts.unclassified_backends !== '0')
        blockers.push('UNCLASSIFIED_BACKENDS_PRESENT');
      if (targetSessions !== '0') blockers.push('TARGET_HAS_SESSIONS');
      if (counts.other_sessions !== '0')
        blockers.push('OTHER_CLIENT_SESSIONS_PRESENT');
    }
    if (lost) refuse('CONNECTION_LOST');
    return {
      status: 'DRY_RUN_REPORT',
      reason: 'READONLY_INSPECTION_COMPLETED',
      report: {
        host: '127.0.0.1',
        port: '55432',
        cluster: TARGET.cluster,
        directory: TARGET.directory,
        database: TARGET.name,
        oid: TARGET.oid,
        owner: TARGET.owner,
        ownerOid: TARGET.ownerOid,
        fingerprint: TARGET.fingerprint,
        origin: 'UNVERIFIED',
        targetSessions,
        otherSessions,
        sessionStatus,
        TARGET_CLIENT_SESSIONS: counts?.target_client_sessions ?? 'UNKNOWN',
        OTHER_CONFIRMED_CLIENT_SESSIONS:
          counts?.other_confirmed_client_sessions ?? 'UNKNOWN',
        CONFIRMED_BACKGROUND: counts?.confirmed_background ?? 'UNKNOWN',
        UNCLASSIFIED_BACKENDS: counts?.unclassified_backends ?? 'UNKNOWN',
        readiness: blockers.length
          ? 'NOT_READY'
          : 'READY_FOR_SEPARATE_APPROVAL',
        blockers,
        pending: [
          'SEPARATE_EXECUTE_APPROVAL_REQUIRED',
          'UNVERIFIED_ORIGIN_ACK_REQUIRED',
          'OPERATOR_EXCLUSIVITY_CONFIRMATION_REQUIRED',
        ],
      },
    };
  }
  try {
    const mode = options.mode === undefined ? 'DRY-RUN' : options.mode;
    if (!['DRY-RUN', 'EXECUTE'].includes(mode)) refuse('INVALID_MODE');
    if (
      mode === 'EXECUTE' &&
      (options.approval !== approval ||
        options.acknowledgeOrigin !== true ||
        options.confirmExclusive !== true)
    )
      refuse('EXECUTE_NOT_APPROVED');
    if (
      typeof raw !== 'string' ||
      !/^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\/postgres$/.test(
        raw,
      ) ||
      /[\s\\?#]/.test(raw) ||
      /%(?![0-9a-f]{2})/i.test(raw)
    )
      refuse('URL_REJECTED');
    let url;
    try {
      url = new URL(raw);
    } catch {
      refuse('URL_REJECTED');
    }
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '55432' ||
      url.pathname !== '/postgres' ||
      url.search ||
      url.hash ||
      !url.password ||
      decodeURIComponent(url.username) !== 'ttv_surplus_lifecycle'
    )
      refuse('URL_REJECTED');
    client = new Client({
      connectionString: url.toString(),
      options:
        '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000',
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      application_name: 'ttv-surplus-explicit-orphan-cleanup',
    });
    client.on('error', () => {
      lost = true;
    });
    await deadline(() => client.connect());
    if (mode === 'DRY-RUN') {
      result = await inspectDryRun();
    } else {
      await verify(true);
      // Only this session changes mode, after explicit orphan-specific approval.
      await query('SET default_transaction_read_only = off');
      await verify(false); // Metadata and all session groups in one final SELECT.
      // No retry, FORCE, wildcard, backend termination or asynchronous work here.
      dropStarted = true;
      try {
        // Exact fixed identifier; no URL, input value or pattern is interpolated.
        await query(
          'DROP DATABASE "ttv_surplus_it_f646e091562849a38743a12b41e8ec2f"',
        );
      } catch (error) {
        if (
          ['42501', '55006', '3D000', '57014', '55P03'].includes(error.code)
        ) {
          result = { status: 'DROP_FAILED', reason: 'SERVER_REJECTED_DROP' };
        } else {
          result = {
            status: 'DROP_OUTCOME_UNKNOWN',
            reason: 'DROP_NOT_CONFIRMED',
          };
        }
        const failure = new Error('DROP_NOT_CONFIRMED');
        failure.dropResult = result;
        throw failure;
      }
      checkCluster((await query(`SELECT ${clusterColumns}`)).rows[0], false);
      const remaining = await query(
        `SELECT oid::text, datname FROM pg_catalog.pg_database
        WHERE datname=$1 OR oid=$2::oid`,
        [TARGET.name, TARGET.oid],
      );
      if (remaining.rows.length || lost) refuse('POSTCHECK_NOT_CONFIRMED');
      result = { status: 'CLEANUP_PASS', reason: 'NAME_AND_OID_ABSENT' };
    }
  } catch (error) {
    result = error.dropResult || {
      status: dropStarted ? 'DROP_OUTCOME_UNKNOWN' : 'DROP_REFUSED',
      reason:
        error.cleanupReason ||
        (error.code === '42501'
          ? 'INSUFFICIENT_PRIVILEGE'
          : 'QUERY_OR_CONNECTION_FAILED'),
    };
  } finally {
    if (client) {
      try {
        await deadline(() => client.end());
      } catch {
        try {
          client.unref();
        } catch {
          /* Never terminate a database backend. */
        }
        result = {
          status: dropStarted ? 'DROP_OUTCOME_UNKNOWN' : 'DROP_REFUSED',
          reason: 'CONNECTION_CLOSE_FAILED',
        };
      }
    }
    if (lost)
      result = {
        status: dropStarted ? 'DROP_OUTCOME_UNKNOWN' : 'DROP_REFUSED',
        reason: 'CONNECTION_LOST',
      };
  }
  return result;
}
module.exports = { cleanup };
if (require.main === module) {
  (async () => {
    const { Client } = require('pg');
    let result;
    try {
      result = await cleanup(
        process.env.SURPLUS_ORPHAN_URL,
        {
          mode: process.env.SURPLUS_ORPHAN_MODE,
          approval: process.env.SURPLUS_ORPHAN_APPROVAL,
          acknowledgeOrigin: process.env.SURPLUS_ORPHAN_ACK_ORIGIN === '1',
          confirmExclusive: process.env.SURPLUS_ORPHAN_EXCLUSIVE === '1',
        },
        { Client },
      );
    } finally {
      delete process.env.SURPLUS_ORPHAN_URL;
      delete process.env.SURPLUS_ORPHAN_APPROVAL;
    }
    process.stdout.write(JSON.stringify(result));
    process.exitCode = ['DRY_RUN_REPORT', 'CLEANUP_PASS'].includes(
      result.status,
    )
      ? 0
      : 1;
  })().catch(() => {
    process.stdout.write(
      JSON.stringify({
        status: 'DROP_OUTCOME_UNKNOWN',
        reason: 'UNEXPECTED_PROCESS_FAILURE',
      }),
    );
    process.exitCode = 1;
  });
}
