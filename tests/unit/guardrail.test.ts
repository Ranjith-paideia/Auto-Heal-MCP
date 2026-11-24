import assert from 'node:assert/strict';
import { validateAstPatch } from '../../src/guardrail/astGuardrail.js';
import { createUnifiedPatch } from '../../src/healer/patchVerifier.js';

console.log('Running AST Guardrail Unit Tests...');

// Baseline valid Page Object code
const basePageObject = `import type { Locator, Page } from '@playwright/test';

export class CheckoutPage {
  readonly page: Page;
  readonly promoInput: Locator;
  readonly applyPromoButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.promoInput = page.locator('#promo-input');
    this.applyPromoButton = page.locator('[data-testid="apply-promo-btn"]');
  }

  async applyPromo(code: string): Promise<void> {
    await this.promoInput.fill(code);
    await this.applyPromoButton.click();
  }
}
`;

// Baseline test file with assertions
const baseSpec = `import { test, expect } from '@playwright/test';

test('sample checkout flow', async ({ page }) => {
  await expect(page.locator('#order-total')).toHaveText('$99.00');
  await expect(page.locator('#promo-status')).toHaveText('Promo Applied');
});
`;

// Case 1: Valid single-line locator replacement in a Page Object class -> passed: true
const validPatchedPageObject = basePageObject.replace(
  `this.applyPromoButton = page.locator('[data-testid="apply-promo-btn"]');`,
  `this.applyPromoButton = page.getByRole('button', { name: 'Apply Promo' });`
);
const res1 = validateAstPatch(basePageObject, validPatchedPageObject, 'CheckoutPage.ts');
assert.equal(res1.passed, true, 'Case 1: Expected valid locator replacement to pass');
assert.equal(res1.violations.length, 0);
console.log('✓ Case 1: Valid single-line locator replacement passed');

// Case 2: Deleting an expect(...) assertion -> passed: false
const deletedAssertionSpec = `import { test, expect } from '@playwright/test';

test('sample checkout flow', async ({ page }) => {
  await expect(page.locator('#order-total')).toHaveText('$99.00');
});
`;
const res2 = validateAstPatch(baseSpec, deletedAssertionSpec, 'sample.spec.ts');
assert.equal(res2.passed, false, 'Case 2: Expected deleting assertion to fail');
assert.ok(res2.violations.some((v) => v.includes('Total assertion count reduced') || v.includes('Assertion mutated or deleted')));
console.log('✓ Case 2: Deleting an expect(...) assertion rejected');

// Case 3: Deleting one of two duplicate expect(...) assertions -> passed: false
const duplicateSpec = `import { test, expect } from '@playwright/test';

test('sample checkout flow', async ({ page }) => {
  await expect(page.locator('#status')).toHaveText('OK');
  await expect(page.locator('#status')).toHaveText('OK');
});
`;
const singleSpec = `import { test, expect } from '@playwright/test';

test('sample checkout flow', async ({ page }) => {
  await expect(page.locator('#status')).toHaveText('OK');
});
`;
const res3 = validateAstPatch(duplicateSpec, singleSpec, 'duplicate.spec.ts');
assert.equal(res3.passed, false, 'Case 3: Expected deleting duplicate assertion to fail');
assert.ok(res3.violations.some((v) => v.includes('Assertion mutated or deleted') || v.includes('assertion count reduced')));
console.log('✓ Case 3: Deleting one of two duplicate expect(...) assertions rejected');

// Case 4: Weakening/mutating an expect(...) value ('$99.00' -> '$199.00') -> passed: false
const mutatedSpec = baseSpec.replace("'$99.00'", "'$199.00'");
const res4 = validateAstPatch(baseSpec, mutatedSpec, 'sample.spec.ts');
assert.equal(res4.passed, false, 'Case 4: Expected mutated assertion value to fail');
assert.ok(res4.violations.some((v) => v.includes('Assertion mutated or deleted')));
console.log('✓ Case 4: Weakening/mutating an expect(...) value rejected');

// Case 5: Introducing test.skip(...) -> passed: false
const skippedSpec = baseSpec.replace(`test('sample checkout flow'`, `test.skip('sample checkout flow'`);
const res5 = validateAstPatch(baseSpec, skippedSpec, 'sample.spec.ts');
assert.equal(res5.passed, false, 'Case 5: Expected introducing test.skip to fail');
assert.ok(res5.violations.some((v) => v.includes('Test weakening introduced')));
console.log('✓ Case 5: Introducing test.skip(...) rejected');

// Case 6: Introducing an XPath locator (//button[@id="pay"]) or extra .first() -> passed: false
const xpathPatchedPageObject = basePageObject.replace(
  `this.applyPromoButton = page.locator('[data-testid="apply-promo-btn"]');`,
  `this.applyPromoButton = page.locator('//button[@id="pay"]');`
);
const res6 = validateAstPatch(basePageObject, xpathPatchedPageObject, 'CheckoutPage.ts');
assert.equal(res6.passed, false, 'Case 6: Expected XPath locator to fail');
assert.ok(res6.violations.some((v) => v.includes('XPath')));

const positionalPatchedPageObject = basePageObject.replace(
  `this.applyPromoButton = page.locator('[data-testid="apply-promo-btn"]');`,
  `this.applyPromoButton = page.locator('button').first();`
);
const res6b = validateAstPatch(basePageObject, positionalPatchedPageObject, 'CheckoutPage.ts');
assert.equal(res6b.passed, false, 'Case 6: Expected positional locator to fail');
assert.ok(res6b.violations.some((v) => v.includes('positional locator')));
console.log('✓ Case 6: Introducing XPath or positional locator rejected');

// Case 7: Invalid TypeScript syntax -> passed: false
const invalidSyntaxPageObject = basePageObject + `\nthis is invalid syntax !!!;;;`;
const res7 = validateAstPatch(basePageObject, invalidSyntaxPageObject, 'CheckoutPage.ts');
assert.equal(res7.passed, false, 'Case 7: Expected invalid syntax to fail');
assert.ok(res7.violations.some((v) => v.includes('Syntax error')));
console.log('✓ Case 7: Invalid TypeScript syntax rejected');

// Patch creation test: verifying createUnifiedPatch produces valid headers
const patch = createUnifiedPatch('benchmark/pages/CheckoutPage.ts', basePageObject, validPatchedPageObject);
assert.ok(patch.includes('--- a/benchmark/pages/CheckoutPage.ts'), 'Patch header must contain --- a/');
assert.ok(patch.includes('+++ b/benchmark/pages/CheckoutPage.ts'), 'Patch header must contain +++ b/');
assert.ok(patch.includes('@@ '), 'Patch header must contain @@ ');
assert.ok(patch.includes('-    this.applyPromoButton = page.locator(\'[data-testid="apply-promo-btn"]\');'));
assert.ok(patch.includes('+    this.applyPromoButton = page.getByRole(\'button\', { name: \'Apply Promo\' });'));
console.log('✓ Patch creation test passed');

console.log('All 7 AST guardrail cases + patch creation verified successfully!');
