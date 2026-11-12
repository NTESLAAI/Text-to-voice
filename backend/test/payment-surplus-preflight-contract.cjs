'use strict';
// Pure in-memory contract. No I/O, environment, database or persisted permits.
const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OID = /^[1-9][0-9]*$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const TEST = Object.freeze({
  host: '127.0.0.1',
  port: '55432',
  database: 'postgres',
  cluster: '7703979600700924132',
  directory: 'd:/text-to-voice/pg-test-cluster',
});
const CODES = Object.freeze([
  'PREFLIGHT_CONFIGURATION_INVALID',
  'PREFLIGHT_APPROVAL_INVALID',
  'PREFLIGHT_APPROVAL_TIMEOUT',
  'PREFLIGHT_CHANNEL_CLOSED',
  'PREFLIGHT_INTERRUPTED',
  'PREFLIGHT_EVIDENCE_INVALID',
  'PREFLIGHT_IDENTITY_MISMATCH',
  'PREFLIGHT_METADATA_BLOCKED',
  'PREFLIGHT_SESSION_UNEXPLAINED',
  'PREFLIGHT_EXPIRED',
  'PREFLIGHT_ALREADY_CONSUMED',
  'PREFLIGHT_NOT_READY',
]);
function check(ok, code) {
  if (!ok) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}
function keys(value, allowed) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === allowed.length &&
    Object.keys(value).every((k) => allowed.includes(k))
  );
}
function normalize(value) {
  return typeof value === 'string'
    ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    : '';
}
function createPreflightRun(context, now) {
  check(
    keys(context, [
      'runId',
      'mode',
      'target',
      'runnerPid',
      'challenge',
      'observationMode',
    ]) &&
      typeof context.runId === 'string' &&
      UUID.test(context.runId) &&
      ['READ_TESTS', 'WRITE_TESTS'].includes(context.mode) &&
      typeof context.target === 'string' &&
      /^ttv_surplus_it_[0-9a-f]{32}$/.test(context.target) &&
      Number.isSafeInteger(context.runnerPid) &&
      context.runnerPid > 0 &&
      typeof context.challenge === 'string' &&
      /^[0-9a-f]{64}$/.test(context.challenge) &&
      ['OBSERVER', 'TEST_ADMIN'].includes(context.observationMode) &&
      typeof now === 'function',
    'PREFLIGHT_CONFIGURATION_INVALID',
  );
  const run = Object.freeze({ ...context });
  const started = now();
  let last = started,
    approvedAt,
    readyAt,
    state = 'WAITING',
    revoked = false;
  const clock = () => {
    const value = now();
    check(
      Number.isFinite(value) && value >= last,
      'PREFLIGHT_EVIDENCE_INVALID',
    );
    last = value;
    return value;
  };
  check(Number.isFinite(started), 'PREFLIGHT_CONFIGURATION_INVALID');
  const linked = (e) =>
    e?.version === VERSION &&
    e.runId === run.runId &&
    e.mode === run.mode &&
    e.target === run.target;
  const linkedKeys = ['version', 'runId', 'mode', 'target'];
  const active = (channelOpen, interrupted) => {
    check(!revoked && channelOpen === true, 'PREFLIGHT_CHANNEL_CLOSED');
    check(interrupted === false, 'PREFLIGHT_INTERRUPTED');
  };
  return Object.freeze({
    request() {
      return { version: VERSION, type: 'PREFLIGHT_CHALLENGE', ...run };
    },
    approve(message) {
      check(
        state === 'WAITING' &&
          !revoked &&
          keys(message, [
            'version',
            'runId',
            'mode',
            'target',
            'challenge',
            'confirmRun',
            'confirmExclusive',
          ]) &&
          linked(message) &&
          message.challenge === run.challenge &&
          message.confirmRun === true &&
          message.confirmExclusive === true,
        'PREFLIGHT_APPROVAL_INVALID',
      );
      const time = clock();
      check(time - started < 120000, 'PREFLIGHT_APPROVAL_TIMEOUT');
      approvedAt = time;
      state = 'APPROVED';
    },
    revoke() {
      revoked = true;
      state = 'REVOKED';
    },
    evaluate(evidence, channelOpen, interrupted) {
      try {
        active(channelOpen, interrupted);
        check(state === 'APPROVED', 'PREFLIGHT_NOT_READY');
        const time = clock();
        check(time - approvedAt < 120000, 'PREFLIGHT_EXPIRED');
        check(
          keys(evidence, [
            ...linkedKeys,
            'identity',
            'roles',
            'metadata',
            'sessions',
          ]) && linked(evidence),
          'PREFLIGHT_EVIDENCE_INVALID',
        );
        for (const item of [
          evidence.identity,
          evidence.roles,
          evidence.metadata,
          evidence.sessions,
        ]) {
          check(
            linked(item) &&
              item.verification === 'VERIFIED' &&
              Number.isFinite(item.collectedAt) &&
              item.collectedAt >= approvedAt &&
              item.collectedAt <= time &&
              time - item.collectedAt < 10000,
            'PREFLIGHT_EVIDENCE_INVALID',
          );
        }
        const i = evidence.identity;
        check(
          keys(i, [
            ...linkedKeys,
            'verification',
            'collectedAt',
            'host',
            'port',
            'database',
            'cluster',
            'directory',
            'postmasterStart',
          ]) &&
            i.host === TEST.host &&
            i.port === TEST.port &&
            i.database === TEST.database &&
            i.cluster === TEST.cluster &&
            normalize(i.directory) === TEST.directory &&
            typeof i.postmasterStart === 'string' &&
            TIME.test(i.postmasterStart),
          'PREFLIGHT_IDENTITY_MISMATCH',
        );
        const r = evidence.roles;
        check(
          keys(r, [
            ...linkedKeys,
            'verification',
            'collectedAt',
            'lifecycleOid',
            'writerOid',
            'readerOid',
            'existingRunnerChecksPassed',
          ]) &&
            [r.lifecycleOid, r.writerOid, r.readerOid].every(
              (v) => typeof v === 'string' && OID.test(v),
            ) &&
            new Set([r.lifecycleOid, r.writerOid, r.readerOid]).size === 3 &&
            r.existingRunnerChecksPassed === true,
          'PREFLIGHT_EVIDENCE_INVALID',
        );
        const m = evidence.metadata;
        check(
          keys(m, [
            ...linkedKeys,
            'verification',
            'collectedAt',
            'scope',
            'blockers',
            'roleOids',
            'databaseOid',
            'snapshotMatched',
          ]) &&
            m.scope === 'POSTGRES_ACL_AND_CLUSTER_DATABASES' &&
            m.databaseOid === '5' &&
            m.snapshotMatched === true &&
            Array.isArray(m.roleOids) &&
            m.roleOids.length === 3 &&
            new Set(m.roleOids).size === 3 &&
            [r.lifecycleOid, r.writerOid, r.readerOid].every((v) =>
              m.roleOids.includes(v),
            ) &&
            Array.isArray(m.blockers),
          'PREFLIGHT_EVIDENCE_INVALID',
        );
        check(m.blockers.length === 0, 'PREFLIGHT_METADATA_BLOCKED');
        const s = evidence.sessions;
        check(
          keys(s, [
            ...linkedKeys,
            'verification',
            'collectedAt',
            'observationMode',
            'snapshot',
            'expectedConnections',
          ]) &&
            s.observationMode === run.observationMode &&
            Array.isArray(s.expectedConnections) &&
            s.expectedConnections.length === 1,
          'PREFLIGHT_EVIDENCE_INVALID',
        );
        const snap = s.snapshot;
        check(
          snap?.status === 'PASS' &&
            snap.reason === 'SESSION_SNAPSHOT_READ' &&
            snap.cluster === i.cluster &&
            snap.postmasterStart === i.postmasterStart &&
            typeof snap.observedAt === 'string' &&
            TIME.test(snap.observedAt) &&
            snap.unclassifiedOtherBackends === 0 &&
            Number.isSafeInteger(snap.verifiedOtherClients) &&
            Number.isSafeInteger(snap.verifiedOtherBackgrounds) &&
            snap.otherSessions === snap.verifiedOtherClients &&
            snap.targetSessions === 0 &&
            Array.isArray(snap.sessions),
          'PREFLIGHT_SESSION_UNEXPLAINED',
        );
        const expected = s.expectedConnections[0];
        check(
          keys(expected, [
            'pid',
            'backend_start',
            'database_oid',
            'role_oid',
          ]) &&
            typeof expected.pid === 'string' &&
            OID.test(expected.pid) &&
            typeof expected.backend_start === 'string' &&
            TIME.test(expected.backend_start) &&
            expected.database_oid === '5' &&
            expected.role_oid === r.lifecycleOid &&
            expected.pid !== snap.selfPid,
          'PREFLIGHT_EVIDENCE_INVALID',
        );
        const rows = snap.sessions;
        check(
          new Set(rows.map((row) => row.pid)).size === rows.length,
          'PREFLIGHT_SESSION_UNEXPLAINED',
        );
        const self = rows.filter((row) => row.classification === 'SELF');
        check(
          self.length === 1 &&
            self[0].pid === snap.selfPid &&
            self[0].usename ===
              (run.observationMode === 'OBSERVER'
                ? 'ttv_surplus_observer'
                : 'postgres'),
          'PREFLIGHT_SESSION_UNEXPLAINED',
        );
        for (const row of rows) {
          check(
            ['SELF', 'VERIFIED_CLIENT', 'VERIFIED_BACKGROUND'].includes(
              row.classification,
            ) &&
              row.observation === 'VISIBLE' &&
              typeof row.pid === 'string' &&
              OID.test(row.pid) &&
              typeof row.backend_start === 'string' &&
              TIME.test(row.backend_start) &&
              row.backendIdentity ===
                `${i.cluster}|${i.postmasterStart}|${row.pid}|${row.backend_start}`,
            'PREFLIGHT_SESSION_UNEXPLAINED',
          );
          if (row.classification === 'VERIFIED_CLIENT')
            check(
              Object.keys(expected).every((k) => row[k] === expected[k]),
              'PREFLIGHT_SESSION_UNEXPLAINED',
            );
        }
        check(
          rows.filter((row) => row.classification === 'VERIFIED_CLIENT')
            .length === 1 &&
            snap.verifiedOtherClients === 1 &&
            rows.filter((row) => row.classification === 'VERIFIED_BACKGROUND')
              .length === snap.verifiedOtherBackgrounds,
          'PREFLIGHT_SESSION_UNEXPLAINED',
        );
        readyAt = time;
        state = 'READY';
        return {
          version: VERSION,
          runId: run.runId,
          verification: 'VERIFIED',
          readiness: 'READY',
          code: 'PREFLIGHT_GO',
        };
      } catch (error) {
        state = 'REJECTED';
        return {
          version: VERSION,
          runId: run.runId,
          verification: [
            'PREFLIGHT_IDENTITY_MISMATCH',
            'PREFLIGHT_METADATA_BLOCKED',
          ].includes(error.safeCode)
            ? 'FAIL'
            : 'UNKNOWN',
          readiness: 'NOT_READY',
          code: CODES.includes(error.safeCode)
            ? error.safeCode
            : 'PREFLIGHT_EVIDENCE_INVALID',
        };
      }
    },
    consume(channelOpen, interrupted) {
      active(channelOpen, interrupted);
      check(state !== 'CONSUMED', 'PREFLIGHT_ALREADY_CONSUMED');
      check(state === 'READY', 'PREFLIGHT_NOT_READY');
      const time = clock();
      if (time - readyAt >= 1000 || time - approvedAt >= 120000) {
        state = 'REJECTED';
        check(false, 'PREFLIGHT_EXPIRED');
      }
      state = 'CONSUMED'; // No retry, even if CREATE fails or its outcome is unknown.
    },
  });
}
module.exports = { VERSION, CODES, createPreflightRun };
