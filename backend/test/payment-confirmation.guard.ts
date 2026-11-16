// Pure test guard: no database client, environment loading, or provisioning.
export const PAYMENT_TARGET = {
  host: '127.0.0.1', port: 62432, database: 'text_to_voice_payment_it',
} as const;

export interface PaymentIdentity {
  database_name: string; schema_name: string; server_host: string;
  server_port: number; cluster_id: string; directory: string;
  database_oid: string; owner_oid: string; role_oid: string;
  role_name: string; session_role: string; marker: string; version: number;
  statement_ms: number; lock_ms: number; idle_ms: number; transaction_ms: number;
}
export interface PaymentManifest {
  runId: string; clusterId: string; databaseOid: string; ownerOid: string;
  roleOid: string; role: string; marker: string;
}
const fail = (): never => { throw new Error('PAYMENT_IT_IDENTITY_REFUSED'); };
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v) && BigInt(v) <= 4294967295n;
export function parseManifest(raw: string | undefined): PaymentManifest {
  let value: unknown;
  try { value = JSON.parse(raw ?? ''); } catch { return fail(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const m = value as Record<string, unknown>;
  const keys = ['runId','clusterId','databaseOid','ownerOid','roleOid','role','marker'];
  if (Object.keys(m).length !== keys.length || keys.some(k => !Object.hasOwn(m,k))) return fail();
  if (typeof m.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.runId) ||
      typeof m.clusterId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(m.clusterId) || BigInt(m.clusterId) > 18446744073709551615n ||
      !oid(m.databaseOid) || !oid(m.ownerOid) || !oid(m.roleOid) || m.ownerOid === m.roleOid ||
      m.role !== 'ttv_payment_it_writer_' + m.runId.slice(0,8) ||
      m.marker !== 'payment-it:' + m.runId) return fail();
  return m as unknown as PaymentManifest;
}
export function validateUrl(raw: string | undefined, m: PaymentManifest): string {
  try {
    const u = new URL(raw ?? '');
    if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== PAYMENT_TARGET.host || u.port !== String(PAYMENT_TARGET.port) ||
        u.pathname !== '/' + PAYMENT_TARGET.database || decodeURIComponent(u.username) !== m.role || !u.password || u.search || u.hash) return fail();
    // Server-side bounds apply to every connection opened by the Prisma pool.
    u.searchParams.set('options', '-c statement_timeout=5000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=5000 -c transaction_timeout=8000');
    u.searchParams.set('application_name', 'payment-it:' + m.runId);
    u.searchParams.set('connect_timeout', '5');
    return u.toString();
  } catch { return fail(); }
}
export function verifyIdentity(rows: PaymentIdentity[], m: PaymentManifest): void {
  if (!Array.isArray(rows) || rows.length !== 1) return fail();
  const r = rows[0];
  if (!r || r.database_name !== PAYMENT_TARGET.database || r.schema_name !== 'public' || r.server_host !== PAYMENT_TARGET.host || r.server_port !== PAYMENT_TARGET.port ||
      r.cluster_id !== m.clusterId || r.database_oid !== m.databaseOid || r.owner_oid !== m.ownerOid || r.role_oid !== m.roleOid ||
      r.role_name !== m.role || r.session_role !== m.role || r.marker !== m.marker || !Number.isInteger(r.version) || r.version < 170000 || r.version >= 180000 ||
      r.statement_ms !== 5000 || r.lock_ms !== 3000 || r.idle_ms !== 5000 || r.transaction_ms !== 8000 ||
      typeof r.directory !== 'string' || r.directory.replaceAll('\\','/').toLowerCase() !== ('d:/text-to-voice-payment-it/' + m.runId + '/pgdata')) return fail();
}

// Monotonic latch. Timeout cannot undo an already submitted transaction:
// preserve its evidence, forbid subsequent operations, never retry or cleanup.
export function createStopGate() {
  let stopped = false;
  let uncertain = false;
  const pending = new Set<Promise<unknown>>();
  const stop = () => { stopped = true; };
  const check = () => { if (stopped) throw new Error('PAYMENT_IT_STOPPED'); };
  return {
    stop, check,
    status: () => ({ status: uncertain ? 'UNKNOWN' : stopped ? 'STOPPED' : 'OPEN', readiness: 'NOT_READY', pending: pending.size }),
    async settle(budgetMs = 10000): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            uncertain = true; stop(); reject(new Error('PAYMENT_IT_TRANSACTION_OUTCOME_UNKNOWN'));
          }, budgetMs); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      // A timed-out operation may already have committed: never infer rollback.
      if (uncertain) throw new Error('PAYMENT_IT_TRANSACTION_OUTCOME_UNKNOWN');
    },
    async run(body: () => Promise<void>, budgetMs = 25000): Promise<void> {
      check();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(body),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { uncertain = true; stop(); reject(new Error('PAYMENT_IT_TIMEOUT')); }, budgetMs);
          }),
        ]);
      } catch (error) { stop(); throw error; }
      finally { if (timer) clearTimeout(timer); }
    },
    async write<T>(identity: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
      check();
      try { await identity(); } catch { stop(); throw new Error('PAYMENT_IT_IDENTITY_REFUSED'); }
      check();
      const work = Promise.resolve().then(() => { check(); return operation(); });
      pending.add(work);
      try { return await work; }
      catch (error) {
        // P2002 is an intentional unique-constraint rollback in this suite.
        // Unknown client/transport errors must not be mistaken for business rejection.
        const e = error as { code?: unknown; getStatus?: unknown } | null;
        if (!e || (e.code !== 'P2002' && typeof e.getStatus !== 'function')) {
          uncertain = true; stop();
          throw new Error('PAYMENT_IT_TRANSACTION_OUTCOME_UNKNOWN');
        }
        throw error;
      } finally { pending.delete(work); }
    },
  };
}
