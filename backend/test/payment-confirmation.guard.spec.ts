import { createStopGate, parseManifest, validateUrl, verifyIdentity, type PaymentIdentity } from './payment-confirmation.guard';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Synthetic identities are unit fixtures, never provisioning evidence.
const manifest = { runId: '11111111-1111-4111-8111-111111111111', clusterId: '123456789', databaseOid: '17000', ownerOid: '17001', roleOid: '17002', role: 'ttv_payment_it_writer_11111111', marker: 'payment-it:11111111-1111-4111-8111-111111111111' };
const identity: PaymentIdentity = { database_name: 'text_to_voice_payment_it', schema_name: 'public', server_host: '127.0.0.1', server_port: 62432, cluster_id: manifest.clusterId, directory: 'D:\\text-to-voice-payment-it\\' + manifest.runId + '\\pgdata', database_oid: manifest.databaseOid, owner_oid: manifest.ownerOid, role_oid: manifest.roleOid, role_name: manifest.role, session_role: manifest.role, marker: manifest.marker, version: 170011, statement_ms: 5000, lock_ms: 3000, idle_ms: 5000, transaction_ms: 8000 };
const url = 'postgresql://' + manifest.role + ':synthetic-only@127.0.0.1:62432/text_to_voice_payment_it';
describe('Fixed payment guard (mock only)', () => {
  it('accepts a complete matching synthetic identity', () => {
    verifyIdentity([identity], parseManifest(JSON.stringify(manifest)));
    expect(new URL(validateUrl(url, manifest)).searchParams.get('options')).toContain('statement_timeout=5000');
  });
  it.each([undefined, '', '{}', 'null', JSON.stringify({ ...manifest, extra: 'sentinel' }), JSON.stringify({ ...manifest, roleOid: '0' }), JSON.stringify({ ...manifest, clusterId: null })])('rejects missing/invalid manifest %#', raw => {
    expect(() => parseManifest(raw)).toThrow('PAYMENT_IT_IDENTITY_REFUSED');
  });
  it.each(Object.keys(identity))('rejects missing or mismatched %s', key => {
    expect(() => verifyIdentity([{ ...identity, [key]: null }], manifest)).toThrow('PAYMENT_IT_IDENTITY_REFUSED');
    expect(() => verifyIdentity([{ ...identity, [key]: 'mismatch' }], manifest)).toThrow('PAYMENT_IT_IDENTITY_REFUSED');
  });
  it.each([{ rows: [] }, { rows: [identity, identity] }])('rejects incomplete/duplicate rows %#', ({ rows }) => expect(() => verifyIdentity(rows, manifest)).toThrow());
  it.each(['5432','55432','56432','57432','58432','60432','61432'])('refuses port %s', port => expect(() => validateUrl(url.replace(':62432', ':' + port), manifest)).toThrow());
  it.each([url.replace('127.0.0.1','localhost'), url.replace('text_to_voice_payment_it','text_to_voice'), url + '?options=unsafe', url.replace(manifest.role,'postgres'), 'SENSITIVE_SENTINEL'])('rejects URL without echoing input %#', value => {
    expect(() => validateUrl(value, manifest)).toThrow('PAYMENT_IT_IDENTITY_REFUSED');
  });
  it('stops subsequent scenario bodies after the first assertion error', async () => {
    const gate = createStopGate(), next = jest.fn();
    await expect(gate.run(async () => { throw new Error('assertion'); })).rejects.toThrow('assertion');
    await expect(gate.run(next)).rejects.toThrow('PAYMENT_IT_STOPPED');
    expect(next).not.toHaveBeenCalled();
  });
  it('latches timeout before the next scenario and blocks delayed writes', async () => {
    jest.useFakeTimers();
    try {
      const gate = createStopGate(), write = jest.fn();
      let resume!: () => void;
      const wait = new Promise<void>(resolve => { resume = resolve; });
      const run = gate.run(async () => { await wait; await gate.write(async () => undefined, write); }, 10);
      const assertion = expect(run).rejects.toThrow('PAYMENT_IT_TIMEOUT');
      await jest.advanceTimersByTimeAsync(10);
      await assertion;
      resume();
      await Promise.resolve(); await Promise.resolve();
      await expect(gate.run(async () => undefined)).rejects.toThrow('PAYMENT_IT_STOPPED');
      expect(write).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });
  it('rechecks latch after identity and fails closed on metadata errors', async () => {
    const gate = createStopGate(), write = jest.fn();
    await expect(gate.write(async () => { gate.stop(); }, write)).rejects.toThrow('PAYMENT_IT_STOPPED');
    expect(write).not.toHaveBeenCalled();
    const other = createStopGate();
    await expect(other.write(async () => { throw new Error('SENSITIVE_SENTINEL'); }, write)).rejects.toThrow('PAYMENT_IT_IDENTITY_REFUSED');
    await expect(other.run(async () => undefined)).rejects.toThrow('PAYMENT_IT_STOPPED');
  });
  it('binds all six integration cases to the same stop gate', () => {
    const source = readFileSync(join(__dirname, 'payment-confirmation.integration.e2e-spec.ts'), 'utf8');
    expect(source.match(/  scenario\('/g)).toHaveLength(6);
    expect(source).toContain('gate.run(body)');
    expect(source).toContain('gate.write(assertDatabase, operation)');
    expect(source).toContain('$allOperations({ args, query })');
    expect(source).toContain('gate.check();');
    expect(source).not.toMatch(/it\.concurrent|test\.concurrent/);
  });
  it.each(['statement_ms', 'lock_ms', 'idle_ms', 'transaction_ms'])('refuses an ineffective %s', field => {
    expect(() => verifyIdentity([{ ...identity, [field]: 0 }], manifest)).toThrow('PAYMENT_IT_IDENTITY_REFUSED');
  });
  it('keeps a late committed mock operation UNKNOWN and never infers rollback', async () => {
    jest.useFakeTimers();
    try {
      const gate = createStopGate();
      let finish!: () => void;
      const work = new Promise<void>(resolve => { finish = resolve; });
      const run = gate.run(async () => { await gate.write(async () => undefined, () => work); }, 10);
      const assertion = expect(run).rejects.toThrow('PAYMENT_IT_TIMEOUT');
      await jest.advanceTimersByTimeAsync(10); await assertion;
      expect(gate.status()).toMatchObject({ status: 'UNKNOWN', readiness: 'NOT_READY', pending: 1 });
      finish(); await work; await Promise.resolve(); await Promise.resolve();
      await expect(gate.settle()).rejects.toThrow('PAYMENT_IT_TRANSACTION_OUTCOME_UNKNOWN');
      expect(gate.status().status).toBe('UNKNOWN');
    } finally { jest.useRealTimers(); }
  });
  it('bounds settlement of an unresolved transaction', async () => {
    jest.useFakeTimers();
    try {
      const gate = createStopGate();
      void gate.write(async () => undefined, () => new Promise<void>(() => {}));
      await Promise.resolve(); await Promise.resolve();
      const waiting = expect(gate.settle(10)).rejects.toThrow('PAYMENT_IT_TRANSACTION_OUTCOME_UNKNOWN');
      await jest.advanceTimersByTimeAsync(10); await waiting;
      expect(gate.status().status).toBe('UNKNOWN');
      await expect(gate.run(async () => undefined)).rejects.toThrow('PAYMENT_IT_STOPPED');
    } finally { jest.useRealTimers(); }
  });
  it('treats unknown transport errors as uncertain without exposing details', async () => {
    const gate = createStopGate();
    await expect(gate.write(async () => undefined, async () => { throw new Error('SENSITIVE_SENTINEL'); })).rejects.toThrow('PAYMENT_IT_TRANSACTION_OUTCOME_UNKNOWN');
    expect(gate.status().status).toBe('UNKNOWN');
    await expect(gate.run(async () => undefined)).rejects.toThrow('PAYMENT_IT_STOPPED');
  });
});
