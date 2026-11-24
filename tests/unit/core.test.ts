import assert from 'node:assert/strict';
import { redactString } from '../../src/core/redactor.js';
import { classifyFailure } from '../../src/core/classifier.js';
import type { ForensicBundle } from '../../src/schemas/forensics.js';

function makeBaseBundle(overrides: Partial<ForensicBundle> = {}): ForensicBundle {
  return {
    testTitle: 'checkout.spec.ts > complete checkout flow',
    filePath: 'benchmark/tests/checkout.spec.ts',
    line: 10,
    status: 'failed',
    errorMessage: '',
    errorStack: '',
    ariaSnapshot: '',
    errorContext: '',
    firstPartyNetworkErrors: [],
    pageErrors: [],
    consoleErrors: [],
    chaosMode: 'none',
    timestamp: Date.now(),
    ...overrides,
  };
}

// 1. Redactor tests
console.log('Testing redactString...');
const rawSample =
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID | Authorization: Basic secret | Cookie: session_id=abc123 | Set-Cookie: user=admin; HttpOnly | api_key=xyz123&token=secrettoken | user@example.com | 4111 2222 3333 4444 | 4111222233334444';

const redacted = redactString(rawSample);
assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
assert.ok(redacted.includes('Bearer [REDACTED]'));
assert.ok(!redacted.includes('Basic secret'));
assert.ok(redacted.includes('Authorization: [REDACTED]'));
assert.ok(!redacted.includes('session_id=abc123'));
assert.ok(redacted.includes('Cookie: [REDACTED]'));
assert.ok(!redacted.includes('user=admin'));
assert.ok(redacted.includes('Set-Cookie: [REDACTED]'));
assert.ok(!redacted.includes('api_key=xyz123'));
assert.ok(!redacted.includes('token=secrettoken'));
assert.ok(redacted.includes('api_key=[REDACTED]'));
assert.ok(redacted.includes('token=[REDACTED]'));
assert.ok(!redacted.includes('user@example.com'));
assert.ok(redacted.includes('[REDACTED]'));
assert.ok(!redacted.includes('4111 2222 3333 4444'));
assert.ok(!redacted.includes('4111222233334444'));
console.log('✓ Redactor tests passed.');

// 2. Classifier tests
console.log('Testing classifyFailure...');

// Case 1: HTTP 500 (APP_BUG)
const http500Bundle = makeBaseBundle({
  firstPartyNetworkErrors: [
    {
      url: 'http://127.0.0.1:4000/api/checkout',
      method: 'POST',
      status: 500,
      responseBodySnippet: '{"error":"Payment gateway timeout"}',
      timestamp: Date.now(),
    },
  ],
  errorMessage: "Error: expect(locator).toContainText() timed out waiting for 'Order Confirmed'",
});
const verdict1 = classifyFailure(http500Bundle);
assert.equal(verdict1.verdict, 'APP_BUG');
assert.equal(verdict1.allowHealing, false);
assert.equal(verdict1.confidence, 0.95);
console.log('✓ Case 1 (HTTP 500 -> APP_BUG) passed.');

// Case 2: pageerror (APP_BUG)
const pageErrorBundle = makeBaseBundle({
  pageErrors: ['TypeError: Payment processor crashed: undefined submit\n    at HTMLButtonElement.<anonymous>'],
  errorMessage: 'Error: page.waitForTimeout',
});
const verdict2 = classifyFailure(pageErrorBundle);
assert.equal(verdict2.verdict, 'APP_BUG');
assert.equal(verdict2.allowHealing, false);
assert.equal(verdict2.confidence, 0.95);
console.log('✓ Case 2 (pageerror -> APP_BUG) passed.');

// Case 3: toHaveText value mismatch (ASSERTION_MISMATCH)
const assertionMismatchBundle = makeBaseBundle({
  errorMessage: `Error: expect(received).toHaveText(expected)\n\nExpected string: "$99.00"\nReceived string: "$199.00"`,
});
const verdict3 = classifyFailure(assertionMismatchBundle);
assert.equal(verdict3.verdict, 'ASSERTION_MISMATCH');
assert.equal(verdict3.allowHealing, false);
assert.equal(verdict3.confidence, 0.9);
console.log('✓ Case 3 (toHaveText mismatch -> ASSERTION_MISMATCH) passed.');

// Case 4: toHaveText with element(s) not found (LOCATOR_DRIFT)
const elementNotFoundBundle = makeBaseBundle({
  errorMessage: `Error: expect(locator).toHaveText(expected)\n\nLocator: locator('#promo-input')\nExpected: "SAVE10"\nCall log:\n  - waiting for locator('#promo-input')\n  - element(s) not found`,
});
const verdict4 = classifyFailure(elementNotFoundBundle);
assert.equal(verdict4.verdict, 'LOCATOR_DRIFT');
assert.equal(verdict4.allowHealing, true);
assert.equal(verdict4.confidence, 0.85);
console.log('✓ Case 4 (element(s) not found -> LOCATOR_DRIFT) passed.');

// Case 5: locator timeout (LOCATOR_DRIFT)
const locatorTimeoutBundle = makeBaseBundle({
  errorMessage: `TimeoutError: locator.click: Timeout 4000ms exceeded.\nCall log:\n  - waiting for locator('[data-testid="apply-promo-btn"]')`,
});
const verdict5 = classifyFailure(locatorTimeoutBundle);
assert.equal(verdict5.verdict, 'LOCATOR_DRIFT');
assert.equal(verdict5.allowHealing, true);
assert.equal(verdict5.confidence, 0.85);
console.log('✓ Case 5 (locator timeout -> LOCATOR_DRIFT) passed.');

console.log('All unit tests passed successfully!');
