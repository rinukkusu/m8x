import assert from 'node:assert/strict';
import test from 'node:test';

import { errorFingerprint, normaliseErrorMessage } from './fingerprint.js';

/** Grouping failures that are the same problem, and separating ones that are not. */

test('run-specific detail is normalised out of error messages', () => {
  const a = normaliseErrorMessage('GET /orders/8842 returned 500 at 2026-01-02T03:04:05Z');
  const b = normaliseErrorMessage('GET /orders/119 returned 500 at 2026-03-09T11:12:13Z');
  assert.equal(a, b);
});

test('the same failure in two runs shares a fingerprint', () => {
  const first = errorFingerprint({
    nodeType: 'action.httpRequest',
    errorType: 'HttpError500',
    message: 'GET /orders/1 returned 500 Internal Server Error',
  });
  const second = errorFingerprint({
    nodeType: 'action.httpRequest',
    errorType: 'HttpError500',
    message: 'GET /orders/999 returned 500 Internal Server Error',
  });
  assert.equal(first, second);
});

test('different status codes are different problems', () => {
  const notFound = errorFingerprint({
    nodeType: 'action.httpRequest',
    errorType: 'HttpError404',
    message: 'GET /orders/1 returned 404 Not Found',
  });
  const serverError = errorFingerprint({
    nodeType: 'action.httpRequest',
    errorType: 'HttpError500',
    message: 'GET /orders/1 returned 500 Internal Server Error',
  });
  assert.notEqual(notFound, serverError);
});

test('the same message from different node types does not merge', () => {
  const fromHttp = errorFingerprint({ nodeType: 'action.httpRequest', errorType: 'TimeoutError', message: 'timed out' });
  const fromCode = errorFingerprint({ nodeType: 'action.code', errorType: 'TimeoutError', message: 'timed out' });
  assert.notEqual(fromHttp, fromCode);
});
