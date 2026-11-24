import { test, expect } from '../../src/reporter/forensicFixture.js';
import { CheckoutPage } from '../pages/CheckoutPage.js';

test('complete checkout flow', async ({ page, serverUrl }) => {
  const chaosMode = process.env.CHAOS_MODE ?? 'none';
  const checkoutPage = new CheckoutPage(page);

  // 1) Navigate to /?chaos=<mode>
  await checkoutPage.goto(chaosMode);

  // 2) Fill promo code "SAVE10", click Apply Promo, assert "Promo Applied"
  await checkoutPage.applyPromo('SAVE10');
  await expect(checkoutPage.promoStatus).toHaveText('Promo Applied');

  // 3) Check Express Shipping checkbox
  await checkoutPage.checkExpressShipping();

  // 4) Assert orderTotal has text "$99.00"
  await expect(checkoutPage.orderTotal).toHaveText('$99.00');

  // 5) Click Pay button and assert orderConfirmation contains "Order Confirmed"
  await checkoutPage.pay();
  await expect(checkoutPage.orderConfirmation).toContainText('Order Confirmed');
});
