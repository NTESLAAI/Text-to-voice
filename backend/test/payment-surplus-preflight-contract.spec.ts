import { createPreflightRun } from './payment-surplus-preflight-contract.cjs';

const context = {
  runId: '11111111-1111-4111-8111-111111111111',
  mode: 'READ_TESTS',
  target: `ttv_surplus_it_${'a'.repeat(32)}`,
  runnerPid: 123,
  challenge: 'b'.repeat(64),
  observationMode: 'OBSERVER',
};
function setup() {
  let time = 0;
  const gate = createPreflightRun(context, () => time);
  const link = {
    version: 1,
    runId: context.runId,
    mode: context.mode,
    target: context.target,
  };
  const stamp = { ...link, verification: 'VERIFIED', collectedAt: 1 };
  const approval = {
    ...link,
    challenge: context.challenge,
    confirmRun: true,
    confirmExclusive: true,
  };
  const start = '2026-11-06T01:00:00.123456Z';
  const backend = (pid: string, classification: string, role_oid: string) => ({
    pid,
    classification,
    backend_start: start,
    database_oid: '5',
    role_oid,
    usename: pid === '20' ? 'ttv_surplus_observer' : 'ttv_surplus_lifecycle',
    observation: 'VISIBLE',
    backendIdentity: `7703979600700924132|${start}|${pid}|${start}`,
  });
  const evidence: any = {
    ...link,
    identity: {
      ...stamp,
      host: '127.0.0.1',
      port: '55432',
      database: 'postgres',
      cluster: '7703979600700924132',
      directory: 'D:/text-to-voice/pg-test-cluster',
      postmasterStart: start,
    },
    roles: {
      ...stamp,
      lifecycleOid: '101',
      writerOid: '102',
      readerOid: '103',
      existingRunnerChecksPassed: true,
    },
    metadata: {
      ...stamp,
      scope: 'POSTGRES_ACL_AND_CLUSTER_DATABASES',
      blockers: [],
      roleOids: ['101', '102', '103'],
      databaseOid: '5',
      snapshotMatched: true,
    },
    sessions: {
      ...stamp,
      observationMode: 'OBSERVER',
      expectedConnections: [
        { pid: '10', backend_start: start, database_oid: '5', role_oid: '101' },
      ],
      snapshot: {
        status: 'PASS',
        reason: 'SESSION_SNAPSHOT_READ',
        cluster: '7703979600700924132',
        postmasterStart: start,
        observedAt: start,
        selfPid: '20',
        unclassifiedOtherBackends: 0,
        verifiedOtherClients: 1,
        verifiedOtherBackgrounds: 5,
        otherSessions: 1,
        targetSessions: 0,
        sessions: [
          backend('20', 'SELF', '104'),
          backend('10', 'VERIFIED_CLIENT', '101'),
          ...Array.from({ length: 5 }, (_, i) =>
            backend(String(30 + i), 'VERIFIED_BACKGROUND', '104'),
          ),
        ],
      },
    },
  };
  return {
    gate,
    approval,
    evidence,
    tick: (n: number) => {
      time = n;
    },
  };
}
function attempt(
  s: ReturnType<typeof setup>,
  open = true,
  interrupted = false,
) {
  const create = jest.fn();
  const decision = s.gate.evaluate(s.evidence, open, interrupted);
  if (decision.readiness === 'READY') {
    s.gate.consume(open, interrupted);
    create();
  }
  return { decision, create };
}
describe('Pure single-run preflight, mock evidence only', () => {
  it('WRITE_TESTS and explicitly selected TEST_ADMIN remain separate run contexts', () => {
    let time = 0;
    const s = setup();
    const run = {
      ...context,
      mode: 'WRITE_TESTS',
      observationMode: 'TEST_ADMIN',
    };
    const gate = createPreflightRun(run, () => time);
    gate.approve({ ...s.approval, mode: 'WRITE_TESTS' });
    s.evidence.mode = 'WRITE_TESTS';
    for (const key of ['identity', 'roles', 'metadata', 'sessions'])
      s.evidence[key].mode = 'WRITE_TESTS';
    s.evidence.sessions.observationMode = 'TEST_ADMIN';
    s.evidence.sessions.snapshot.sessions[0].usename = 'postgres';
    time = 2;
    expect(gate.evaluate(s.evidence, true, false).readiness).toBe('READY');
    gate.consume(true, false);
  });
  it('rejects a historical approval from another run and evidence older than ten seconds', () => {
    const s = setup();
    const other = createPreflightRun(
      { ...context, runId: '22222222-2222-4222-8222-222222222222' },
      () => 0,
    );
    expect(() => other.approve(s.approval)).toThrow(
      'PREFLIGHT_APPROVAL_INVALID',
    );
    s.gate.approve(s.approval);
    s.tick(10001);
    expect(attempt(s).create).not.toHaveBeenCalled();
  });
  it('accepts five verified backgrounds, consumes once before simulated CREATE', () => {
    const s = setup();
    s.gate.approve(s.approval);
    s.tick(2);
    const r = attempt(s);
    expect(r.create).toHaveBeenCalledTimes(1);
    expect(() => s.gate.consume(true, false)).toThrow(
      'PREFLIGHT_ALREADY_CONSUMED',
    );
  });
  it('does not authorize from an approval environment flag or caller supplied READY', () => {
    const s = setup();
    s.tick(2);
    s.evidence.readiness = 'READY';
    expect(attempt(s).create).not.toHaveBeenCalled();
  });
  it.each([
    'runId',
    'mode',
    'target',
    'challenge',
    'confirmRun',
    'confirmExclusive',
    'version',
  ])('rejects wrong approval %s', (field) => {
    const s = setup();
    expect(() => s.gate.approve({ ...s.approval, [field]: 'WRONG' })).toThrow();
    s.tick(2);
    expect(attempt(s).create).not.toHaveBeenCalled();
  });
  it('rejects late approval and does not accept it twice', () => {
    const s = setup();
    s.tick(120000);
    expect(() => s.gate.approve(s.approval)).toThrow(
      'PREFLIGHT_APPROVAL_TIMEOUT',
    );
    const other = setup();
    other.gate.approve(other.approval);
    expect(() => other.gate.approve(other.approval)).toThrow();
  });
  const mutations: Array<[string, (e: any) => void]> = [
    ['missing identity', (e) => delete e.identity],
    ['wrong run', (e) => (e.runId = 'wrong')],
    ['wrong mode', (e) => (e.mode = 'WRITE_TESTS')],
    ['wrong target', (e) => (e.target = 'text_to_voice')],
    ...['identity', 'roles', 'metadata', 'sessions'].map(
      (k) =>
        [`${k} UNKNOWN`, (e: any) => (e[k].verification = 'UNKNOWN')] as [
          string,
          (e: any) => void,
        ],
    ),
    ...['host', 'port', 'database', 'cluster', 'directory'].map(
      (k) =>
        [`identity ${k}`, (e: any) => (e.identity[k] = 'WRONG')] as [
          string,
          (e: any) => void,
        ],
    ),
    ['stale evidence', (e) => (e.identity.collectedAt = -1)],
    ['future evidence', (e) => (e.sessions.collectedAt = 99)],
    ['extra field', (e) => (e.SENTINEL = 'MOCK_SECRET')],
    ['role OID mismatch', (e) => (e.metadata.roleOids[0] = '999')],
    [
      'role checks missing',
      (e) => (e.roles.existingRunnerChecksPassed = false),
    ],
    ['snapshot false', (e) => (e.metadata.snapshotMatched = false)],
    [
      'orphan CREATE blocker',
      (e) =>
        (e.metadata.blockers = ['TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE']),
    ],
    [
      'TEMP blocker',
      (e) => (e.metadata.blockers = ['ACL_TEMP_PRIVILEGE_PRESENT']),
    ],
    [
      'unknown blocker',
      (e) => (e.metadata.blockers = ['MOCK_UNKNOWN_BLOCKER']),
    ],
    ['NULL blocker', (e) => (e.metadata.blockers = null)],
    ['sessions missing', (e) => (e.sessions.snapshot = null)],
    [
      'unknown backend',
      (e) => (e.sessions.snapshot.unclassifiedOtherBackends = 1),
    ],
    [
      'masked backend',
      (e) => (e.sessions.snapshot.sessions[2].classification = 'UNCLASSIFIED'),
    ],
    [
      'postmaster changed',
      (e) =>
        (e.sessions.snapshot.postmasterStart = '2026-11-06T02:00:00.123456Z'),
    ],
    ['missing self', (e) => e.sessions.snapshot.sessions.shift()],
    ['duplicate PID', (e) => (e.sessions.snapshot.sessions[2].pid = '10')],
    [
      'reused PID',
      (e) =>
        (e.sessions.expectedConnections[0].backend_start =
          '2026-11-06T02:00:00.123456Z'),
    ],
    [
      'other client',
      (e) =>
        (e.sessions.snapshot.sessions[2].classification = 'VERIFIED_CLIENT'),
    ],
    [
      'missing observation',
      (e) => (e.sessions.snapshot.sessions[2].observation = 'UNKNOWN'),
    ],
    [
      'wrong observer',
      (e) => (e.sessions.snapshot.sessions[0].usename = 'postgres'),
    ],
    ['bad counts', (e) => (e.sessions.snapshot.verifiedOtherBackgrounds = 0)],
  ];
  it.each(mutations)('NO-GO sends zero CREATE: %s', (_label, mutate) => {
    const s = setup();
    s.gate.approve(s.approval);
    s.tick(2);
    mutate(s.evidence);
    const r = attempt(s);
    expect(r.create).not.toHaveBeenCalled();
    expect(r.decision.readiness).toBe('NOT_READY');
    expect(JSON.stringify(r.decision)).not.toContain('MOCK_SECRET');
  });
  it.each([
    [false, false],
    [true, true],
  ])('closed channel or interrupted run cannot CREATE', (open, interrupted) => {
    const s = setup();
    s.gate.approve(s.approval);
    s.tick(2);
    expect(attempt(s, open, interrupted).create).not.toHaveBeenCalled();
  });
  it.each(['expire', 'revoke', 'interrupt', 'channel'])(
    'invalidates READY before CREATE: %s',
    (reason) => {
      const s = setup();
      s.gate.approve(s.approval);
      s.tick(2);
      expect(s.gate.evaluate(s.evidence, true, false).readiness).toBe('READY');
      if (reason === 'expire') s.tick(1002);
      if (reason === 'revoke') s.gate.revoke();
      const create = jest.fn();
      expect(() => {
        s.gate.consume(reason !== 'channel', reason === 'interrupt');
        create();
      }).toThrow();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it('failed CREATE cannot reuse the consumed decision or transfer it to another run', () => {
    const s = setup();
    s.gate.approve(s.approval);
    s.tick(2);
    s.gate.evaluate(s.evidence, true, false);
    s.gate.consume(true, false);
    expect(() => s.gate.consume(true, false)).toThrow();
    const next = setup();
    expect(() => next.gate.consume(true, false)).toThrow('PREFLIGHT_NOT_READY');
  });
});
