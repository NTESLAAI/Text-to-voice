'use strict';
const path = require('node:path');
const fs = require('node:fs');
const g = require('./guard.cjs');
let phase = 'INPUT';
async function main() {
  const p = g.readPacket();
  g.insist(p.action === 'test');
  phase = 'IDENTITY';
  for (const role of ['writer', 'reader']) {
    const c = await g.verifiedClient(p, 'cold', role);
    if (role === 'writer') {
      await c.query('BEGIN READ ONLY');
      try {
        const r = await c.query('SELECT count(*)::int AS n FROM public."User"');
        g.insist(
          r.rows.length === 1 && r.rows[0].n === 0,
          'ACCEPTANCE_DATABASE_NOT_EMPTY',
        );
      } finally {
        await c.query('ROLLBACK');
      }
    }
    await c.end();
  }
  const directory = path.join(
    'D:/text-to-voice-it',
    p.manifest.runId,
    'audio-workspace-' + require('node:crypto').randomUUID(),
  );
  fs.mkdirSync(directory);
  process.chdir(directory);
  phase = 'JEST';
  const { results } = await require('jest').runCLI(
    {
      config: path.join(__dirname, 'jest.config.cjs'),
      runInBand: true,
      silent: true,
    },
    [path.join(__dirname, 'jest.config.cjs')],
  );
  phase = 'RESULT_SUMMARY';
  if (results.numTotalTests === 0) {
    const text = results.testResults
      .map((s) => s.failureMessage || '')
      .join('\n');
    process.stdout.write(
      JSON.stringify({
        status: 'UNKNOWN',
        readiness: 'NOT_READY',
        code:
          g.safeTestFailure(text) === 'JEST_UNCLASSIFIED_BOOTSTRAP_FAILURE'
            ? 'JEST_ZERO_TESTS_UNCLASSIFIED'
            : g.safeTestFailure(text),
      }),
    );
    process.exitCode = 1;
    return;
  }
  // Never emit assertion payloads, error messages, fixture data or stack traces.
  const observed = results.testResults
    .flatMap((s) =>
      s.testResults.map((t) => {
        const match = /^(A[0-9]{2})(?: (APPLE|GOOGLE))?/.exec(t.title);
        return match ? match[1] + (match[2] ? ':' + match[2] : '') : 'UNKNOWN';
      }),
    )
    .sort();
  const expected = [
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
  ].sort();
  const passed =
    results.success &&
    results.numPendingTests === 0 &&
    results.numFailedTests === 0 &&
    results.numTotalTests === 14 &&
    JSON.stringify(observed) === JSON.stringify(expected);
  const failedCases = results.testResults.flatMap((s) =>
    s.testResults
      .filter((t) => t.status === 'failed')
      .map((t) => {
        const m = /^(A[0-9]{2})(?: (APPLE|GOOGLE))?/.exec(t.title);
        const id = m ? m[1] + (m[2] ? ':' + m[2] : '') : 'UNKNOWN';
        return g.TEST_IDS.includes(id) ? id : 'UNKNOWN';
      }),
  );
  process.stdout.write(
    JSON.stringify({
      status: passed ? 'VERIFIED' : 'UNKNOWN',
      readiness: 'NOT_READY',
      code: passed ? 'ACCEPTANCE_TEST_PASS' : 'ACCEPTANCE_TEST_FAILED',
      total: results.numTotalTests,
      passed: results.numPassedTests,
      failed: results.numFailedTests,
      skipped: results.numPendingTests,
      failedCases,
    }),
  );
  process.exitCode = passed ? 0 : 1;
}
main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      status: 'UNKNOWN',
      readiness: 'NOT_READY',
      code: g.TEST_FAILURE_CODES.includes(error?.message)
        ? error.message
        : error?.name === 'TypeError' && phase === 'JEST'
          ? 'JEST_CLI_TYPE_ERROR'
          : error?.name === 'TypeError' && phase === 'RESULT_SUMMARY'
            ? 'JEST_RESULT_SUMMARY_TYPE_ERROR'
            : phase === 'JEST'
              ? g.safeTestFailure(error?.message)
              : 'ACCEPTANCE_TEST_START_FAILED',
    }),
  );
  process.exitCode = 1;
});
