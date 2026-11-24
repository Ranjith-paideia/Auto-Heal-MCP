import { test, expect } from '../../src/reporter/forensicFixture.js';
import { CheckoutPage } from '../pages/CheckoutPage.js';

test('checkout smoke validation', async ({ page }) => {
  const chaosMode = process.env.CHAOS_MODE ?? 'none';
  const checkoutPage = new CheckoutPage(page);

  // 1) Navigate to /?chaos=<mode>
  await checkoutPage.goto(chaosMode);

  // 2) Verify $99.00 order total is displayed
  await expect(checkoutPage.orderTotal).toHaveText('$99.00');

  // 3) Enter promo code "SAVE10", apply it, assert "Promo Applied"
  await checkoutPage.applyPromo('SAVE10');
  await expect(checkoutPage.promoStatus).toHaveText('Promo Applied');

  // 4) Check Express Shipping option
  await checkoutPage.checkExpressShipping();
});
