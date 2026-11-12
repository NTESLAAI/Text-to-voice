'use strict';
// SELECT-only session inspector; importing this module does not connect.
const { isIP } = require('node:net');
const TARGET = 'ttv_surplus_it_f646e091562849a38743a12b41e8ec2f';
const roles = [
  'postgres',
  'ttv_surplus_lifecycle',
  'ttv_surplus_writer',
  'ttv_surplus_reader',
];
const applications = [
  'psql',
  'pgAdmin 4',
  'ttv-surplus-session-inspection',
  'ttv-surplus-explicit-orphan-cleanup',
  'ttv-surplus-temp-control',
  'ttv-surplus-temp-inspection',
  'ttv-surplus-target-inspection',
  'ttv-surplus-readonly-connection-check',
  'ttv-surplus-migration-verifier',
];
const backendTypes = [
  'client backend',
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
];
const states = [
  'active',
  'idle',
  'idle in transaction',
  'idle in transaction (aborted)',
  'fastpath function call',
  'disabled',
];
const waitTypes = [
  'Activity',
  'BufferPin',
  'Client',
  'Extension',
  'IO',
  'IPC',
  'Lock',
  'LWLock',
  'Timeout',
];
const eventName = (value) =>
  value === null
    ? null
    : typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(value)
      ? value
      : 'REDACTED';
const timestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);
const validOid = (value) =>
  typeof value === 'string' && /^[1-9][0-9]*$/.test(value);

// Pure comparison only. A vanished PID never becomes a confirmed background.
function compareSessionSnapshots(previous, current) {
  if (
    !previous ||
    !current ||
    previous.cluster !== '7703979600700924132' ||
    !timestamp(previous.observedAt) ||
    !timestamp(current.observedAt) ||
    current.observedAt < previous.observedAt ||
    !timestamp(previous.postmasterStart) ||
    !timestamp(current.postmasterStart) ||
    previous.cluster !== current.cluster ||
    previous.postmasterStart !== current.postmasterStart
  )
    return { status: 'SNAPSHOT_SCOPE_UNKNOWN', backends: [] };
  const backends = [];
  for (const before of previous.sessions ?? []) {
    const matches = (current.sessions ?? []).filter(
      (row) => row.pid === before.pid,
    );
    const after = matches[0];
    const status =
      matches.length === 0
        ? 'NOT_OBSERVED_LATER'
        : matches.length !== 1 ||
            !timestamp(before.backend_start) ||
            !timestamp(after.backend_start) ||
            !before.backendIdentity ||
            !after.backendIdentity
          ? 'IDENTITY_UNKNOWN'
          : before.backend_start !== after.backend_start
            ? 'PID_REUSED'
            : before.backendIdentity === after.backendIdentity
              ? 'SAME_BACKEND'
              : 'IDENTITY_UNKNOWN';
    backends.push({ pid: before.pid, status });
  }
  return { status: 'COMPARISON_ONLY', backends };
}
const DIAGNOSTIC_FIELDS = new Set([
  'mode',
  'url_format',
  'url_encoding',
  'host',
  'port',
  'database',
  'username',
  'credential_presence',
  'identity_row',
  'current_user',
  'session_user',
  'admin_attribute',
  'server_address',
  'server_port',
  'cluster_id',
  'data_directory',
  'session_read_only',
  'transaction_read_only',
  'backend_pid',
  'connection_state',
]);
function urlMismatchFields(raw, expectedRole) {
  const fields = ['url_format'];
  if (typeof raw !== 'string') return fields;
  if (/%(?![0-9a-f]{2})/i.test(raw)) fields.push('url_encoding');
  try {
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1') fields.push('host');
    if (url.port !== '55432') fields.push('port');
    if (url.pathname !== '/postgres') fields.push('database');
    if (!url.password) fields.push('credential_presence');
    if (decodeURIComponent(url.username) !== expectedRole)
      fields.push('username');
  } catch {
    /* Never attach the exception or input. */
  }
  return fields;
}
function failure(reason, phase, fields) {
  const error = new Error(reason);
  error.safeReason = reason;
  if (['URL_VALIDATION', 'SERVER_IDENTITY'].includes(phase)) {
    error.safePhase = phase;
    error.safeFields = fields.filter((field) => DIAGNOSTIC_FIELDS.has(field));
  }
  throw error;
}
async function inspectSessions(raw, { Client, mode = 'LIFECYCLE' }) {
  let client,
    lost = false;
  let result = { status: 'UNKNOWN', reason: 'INSPECTION_FAILED' };
  try {
    if (!['LIFECYCLE', 'TEST_ADMIN', 'OBSERVER'].includes(mode))
      failure('IDENTITY_MISMATCH', 'URL_VALIDATION', ['mode']);
    const expectedRole =
      mode === 'TEST_ADMIN'
        ? 'postgres'
        : mode === 'OBSERVER'
          ? 'ttv_surplus_observer'
          : 'ttv_surplus_lifecycle';
    if (
      typeof raw !== 'string' ||
      !/^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\/postgres$/.test(
        raw,
      ) ||
      /[\s\\?#]/.test(raw) ||
      /%(?![0-9a-f]{2})/i.test(raw)
    )
      failure(
        'IDENTITY_MISMATCH',
        'URL_VALIDATION',
        urlMismatchFields(raw, expectedRole),
      );
    const url = new URL(raw);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '55432' ||
      url.pathname !== '/postgres' ||
      url.search ||
      url.hash ||
      !url.password ||
      decodeURIComponent(url.username) !== expectedRole
    )
      failure(
        'IDENTITY_MISMATCH',
        'URL_VALIDATION',
        urlMismatchFields(raw, expectedRole),
      );
    client = new Client({
      connectionString: url.toString(),
      options:
        '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000',
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      application_name: 'ttv-surplus-session-inspection',
    });
    client.on('error', () => {
      lost = true;
    });
    await client.connect();
    const identity = (
      await client.query(`SELECT current_user AS role, session_user AS session_role,
      current_database() AS db, host(inet_server_addr()) AS host, inet_server_port()::text AS port,
      pg_backend_pid()::text AS self_pid,
      to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS postmaster_start,
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
      (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
      current_setting('data_directory') AS directory,
      current_setting('is_superuser') AS is_superuser,
      current_setting('default_transaction_read_only') AS session_ro,
      current_setting('transaction_read_only') AS tx_ro`)
    ).rows[0];
    if (
      !identity ||
      identity.role !== expectedRole ||
      (mode === 'TEST_ADMIN' && identity.is_superuser !== 'on') ||
      identity.session_role !== identity.role ||
      identity.db !== 'postgres' ||
      identity.host !== '127.0.0.1' ||
      identity.port !== '55432' ||
      identity.cluster !== '7703979600700924132' ||
      typeof identity.directory !== 'string' ||
      identity.directory
        .replaceAll('\\', '/')
        .replace(/\/+$/, '')
        .toLowerCase() !== 'd:/text-to-voice/pg-test-cluster' ||
      identity.session_ro !== 'on' ||
      identity.tx_ro !== 'on' ||
      typeof identity.self_pid !== 'string' ||
      !/^[1-9][0-9]*$/.test(identity.self_pid) ||
      lost
    ) {
      const fields = [];
      if (!identity) fields.push('identity_row');
      else {
        if (identity.role !== expectedRole) fields.push('current_user');
        if (mode === 'TEST_ADMIN' && identity.is_superuser !== 'on')
          fields.push('admin_attribute');
        if (identity.session_role !== identity.role)
          fields.push('session_user');
        if (identity.db !== 'postgres') fields.push('database');
        if (identity.host !== '127.0.0.1') fields.push('server_address');
        if (identity.port !== '55432') fields.push('server_port');
        if (identity.cluster !== '7703979600700924132')
          fields.push('cluster_id');
        if (
          typeof identity.directory !== 'string' ||
          identity.directory
            .replaceAll('\\', '/')
            .replace(/\/+$/, '')
            .toLowerCase() !== 'd:/text-to-voice/pg-test-cluster'
        )
          fields.push('data_directory');
        if (identity.session_ro !== 'on') fields.push('session_read_only');
        if (identity.tx_ro !== 'on') fields.push('transaction_read_only');
        if (
          typeof identity.self_pid !== 'string' ||
          !/^[1-9][0-9]*$/.test(identity.self_pid)
        )
          fields.push('backend_pid');
      }
      if (lost) fields.push('connection_state');
      failure('IDENTITY_MISMATCH', 'SERVER_IDENTITY', fields);
    }
    if (mode === 'OBSERVER') {
      const visibility = await client.query(
        "SELECT pg_catalog.pg_has_role('pg_read_all_stats', 'USAGE') AS stats_usage",
      );
      if (visibility.rows?.length !== 1) failure('INVALID_METADATA');
      if (visibility.rows[0].stats_usage === false)
        failure('INSUFFICIENT_PRIVILEGE');
      if (visibility.rows[0].stats_usage !== true) failure('INVALID_METADATA');
    }
    // No query text. Visibility is assessed per backend, without granting rights.
    const rows = (
      await client.query(`SELECT pid::text AS pid, datid::text AS database_oid, usesysid::text AS role_oid,
      to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,
      datname, usename, application_name, host(client_addr) AS client_addr,
      backend_type, state, wait_event_type, wait_event,
      pg_catalog.pg_has_role('pg_read_all_stats', 'USAGE') OR
        CASE WHEN usesysid IS NULL THEN false ELSE
          pg_catalog.pg_has_role(usesysid, 'USAGE') END AS can_observe
      FROM pg_catalog.pg_stat_activity ORDER BY pid`)
    ).rows;
    let unknown = false,
      selfCount = 0,
      targetCount = 0,
      otherCount = 0,
      otherBackgroundCount = 0,
      unclassifiedCount = 0,
      targetCountUnknown = false;
    const sessions = rows.map((row) => {
      if (typeof row.pid !== 'string' || !/^[1-9][0-9]*$/.test(row.pid))
        failure('INVALID_METADATA');
      const self = row.pid === identity.self_pid;
      const clientBackend = row.backend_type === 'client backend';
      const knownBackend = backendTypes.includes(row.backend_type);
      const observable = row.can_observe === true;
      const complete =
        knownBackend &&
        observable &&
        timestamp(identity.postmaster_start) &&
        timestamp(identity.observed_at) &&
        timestamp(row.backend_start) &&
        (row.database_oid === null || validOid(row.database_oid)) &&
        (row.role_oid === null || validOid(row.role_oid)) &&
        (!clientBackend ||
          (validOid(row.database_oid) &&
            validOid(row.role_oid) &&
            states.includes(row.state)));
      if (
        !knownBackend ||
        !observable ||
        (clientBackend && !states.includes(row.state)) ||
        !complete
      )
        unknown = true;
      if (self) selfCount++;
      if (
        row.database_oid !== null &&
        (typeof row.database_oid !== 'string' ||
          !/^[1-9][0-9]*$/.test(row.database_oid))
      ) {
        targetCountUnknown = true;
        unknown = true;
      }
      if (row.database_oid === '16393') targetCount++;
      if (!self && clientBackend) otherCount++;
      if (!self && complete && !clientBackend) otherBackgroundCount++;
      if (!self && !complete) unclassifiedCount++;
      const database =
        row.datname === null
          ? null
          : ['postgres', 'template0', 'template1', TARGET].includes(
                row.datname,
              ) || /^ttv_surplus_it_[0-9a-f]{32}$/.test(row.datname)
            ? row.datname
            : 'OTHER_DATABASE_REDACTED';
      return {
        pid: row.pid,
        database_oid: validOid(row.database_oid) ? row.database_oid : null,
        role_oid: validOid(row.role_oid) ? row.role_oid : null,
        backend_start: timestamp(row.backend_start) ? row.backend_start : null,
        backendIdentity: complete
          ? `${identity.cluster}|${identity.postmaster_start}|${row.pid}|${row.backend_start}`
          : null,
        datname: database,
        usename:
          row.usename === null
            ? null
            : roles.includes(row.usename) ||
                (mode === 'OBSERVER' && row.usename === 'ttv_surplus_observer')
              ? row.usename
              : 'OTHER_ROLE_REDACTED',
        application_name:
          row.application_name === ''
            ? ''
            : applications.includes(row.application_name)
              ? row.application_name
              : 'OTHER_APPLICATION_REDACTED',
        client_addr:
          row.client_addr === null
            ? null
            : typeof row.client_addr === 'string' && isIP(row.client_addr)
              ? row.client_addr
              : 'UNKNOWN',
        backend_type: knownBackend ? row.backend_type : 'UNKNOWN',
        state: !observable
          ? 'UNKNOWN'
          : row.state === null && !clientBackend
            ? null
            : states.includes(row.state)
              ? row.state
              : 'UNKNOWN',
        wait_event_type: !observable
          ? 'UNKNOWN'
          : row.wait_event_type === null
            ? null
            : waitTypes.includes(row.wait_event_type)
              ? row.wait_event_type
              : 'UNKNOWN',
        wait_event: !observable ? 'UNKNOWN' : eventName(row.wait_event),
        kind: self
          ? 'SELF'
          : !complete
            ? 'UNKNOWN'
            : clientBackend
              ? 'OTHER_CLIENT'
              : knownBackend
                ? 'BACKGROUND'
                : 'UNKNOWN',
        classification: self
          ? 'SELF'
          : !complete
            ? 'UNCLASSIFIED'
            : clientBackend
              ? 'VERIFIED_CLIENT'
              : knownBackend
                ? 'VERIFIED_BACKGROUND'
                : 'UNCLASSIFIED',
        database_scope:
          row.datname === TARGET
            ? 'TARGET'
            : row.datname === 'postgres'
              ? 'POSTGRES'
              : row.datname === null
                ? 'NONE'
                : 'OTHER_DATABASE',
        observation: observable ? 'VISIBLE' : 'UNKNOWN',
      };
    });
    if (selfCount !== 1) unknown = true;
    result = {
      status: unknown ? 'UNKNOWN' : 'PASS',
      reason: unknown ? 'OBSERVATION_INCOMPLETE' : 'SESSION_SNAPSHOT_READ',
      selfPid: identity.self_pid,
      cluster: identity.cluster,
      postmasterStart: timestamp(identity.postmaster_start)
        ? identity.postmaster_start
        : null,
      observedAt: timestamp(identity.observed_at) ? identity.observed_at : null,
      targetSessions: targetCountUnknown ? 'UNKNOWN' : targetCount,
      // Backend type, not state/user/address/NULL, establishes the client count.
      // Incomplete detailed observation does not erase a verified client lower bound.
      otherSessions:
        unclassifiedCount || selfCount !== 1 ? 'UNKNOWN' : otherCount,
      verifiedOtherClients: otherCount,
      verifiedOtherBackgrounds: otherBackgroundCount,
      unclassifiedOtherBackends: unclassifiedCount,
      sessions,
    };
  } catch (error) {
    result = {
      status: error.safeReason === 'IDENTITY_MISMATCH' ? 'FAIL' : 'UNKNOWN',
      reason:
        error.safeReason ||
        (error.code === '42501'
          ? 'INSUFFICIENT_PRIVILEGE'
          : 'QUERY_OR_CONNECTION_FAILED'),
      ...(error.safeReason === 'IDENTITY_MISMATCH' &&
      ['URL_VALIDATION', 'SERVER_IDENTITY'].includes(error.safePhase)
        ? {
            phase: error.safePhase,
            fields: Array.isArray(error.safeFields)
              ? error.safeFields.filter((field) => DIAGNOSTIC_FIELDS.has(field))
              : [],
          }
        : {}),
    };
  } finally {
    if (client) {
      let timer;
      try {
        await Promise.race([
          client.end(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('CLOSE_TIMEOUT')), 3000);
          }),
        ]);
      } catch {
        try {
          client.unref();
        } catch {}
        result = { status: 'UNKNOWN', reason: 'CONNECTION_CLOSE_FAILED' };
      } finally {
        clearTimeout(timer);
      }
    }
    if (lost) result = { status: 'UNKNOWN', reason: 'CONNECTION_LOST' };
  }
  return result;
}
module.exports = { inspectSessions, compareSessionSnapshots };
if (require.main === module) {
  (async () => {
    const { Client } = require('pg');
    let result;
    try {
      result = await inspectSessions(process.env.SURPLUS_SESSION_URL, {
        Client,
        mode: process.env.SURPLUS_SESSION_MODE || 'LIFECYCLE',
      });
    } finally {
      delete process.env.SURPLUS_SESSION_URL;
      delete process.env.SURPLUS_SESSION_MODE;
    }
    process.stdout.write(JSON.stringify(result));
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  })().catch(() => {
    process.stdout.write(
      JSON.stringify({ status: 'UNKNOWN', reason: 'INSPECTION_FAILED' }),
    );
    process.exitCode = 1;
  });
}
