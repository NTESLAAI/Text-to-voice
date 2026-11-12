'use strict';
// Pure contract: no database, environment reads or child processes.
const WRITE_CASES = Object.freeze([
  'WRITE_AUTH',
  'WRITE_VALIDATION',
  'WRITE_PAID_ONLY',
  'WRITE_REFUND',
  'WRITE_CREDIT',
  'WRITE_CANCEL',
  'WRITE_IDEMPOTENT',
  'WRITE_KEY_CONFLICT',
  'WRITE_CONCURRENT_KEY',
  'WRITE_CONCURRENT_OVERALLOC',
  'WRITE_CONCURRENT_TRANSITION',
  'WRITE_AUDIT_REPLAY',
  'WRITE_DECIMAL_SNAPSHOT',
  'WRITE_READONLY_OBSERVER',
  'WRITE_POSTCHECK',
]);
function testSummary(summary, writeMode) {
  const required = [
    '401',
    '403',
    '404',
    '200',
    ...(writeMode ? WRITE_CASES : []),
  ];
  const assertions =
    summary?.testResults?.flatMap((s) => s.assertionResults ?? []) ?? [];
  const cases = required.map((id) => {
    const matches = assertions.filter(
      (t) => t.title === id || t.title.startsWith(`${id} — `),
    );
    return {
      http: id,
      status:
        matches.length === 1 &&
        ['passed', 'failed', 'pending', 'todo'].includes(matches[0].status)
          ? matches[0].status
          : 'not-run',
    };
  });
  return {
    cases,
    passed:
      summary?.success === true &&
      summary.numTotalTests === required.length &&
      summary.numPassedTests === required.length &&
      summary.numPendingTests === 0 &&
      assertions.length === required.length &&
      cases.every((c) => c.status === 'passed'),
  };
}
module.exports = { WRITE_CASES, testSummary };
