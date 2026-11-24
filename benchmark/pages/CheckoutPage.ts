import type { Locator, Page } from '@playwright/test';

export class CheckoutPage {
  readonly page: Page;
  readonly promoInput: Locator;
  readonly applyPromoButton: Locator;
  readonly promoStatus: Locator;
  readonly expressShippingCheckbox: Locator;
  readonly orderTotal: Locator;
  readonly payButton: Locator;
  readonly orderConfirmation: Locator;

  constructor(page: Page) {
    this.page = page;
    this.promoInput = page.locator('#promo-input');
    this.applyPromoButton = page.locator('[data-testid="apply-promo-btn"]');
    this.promoStatus = page.locator('[data-testid="promo-status"]');
    this.expressShippingCheckbox = page.locator('.shipping-options > input.express-toggle');
    this.orderTotal = page.locator('[data-testid="order-total"]');
    this.payButton = page.getByRole('button', { name: 'Pay Now' });
    this.orderConfirmation = page.locator('[data-testid="order-confirmation"]');
  }

  async goto(chaosMode = 'none'): Promise<void> {
    const query = chaosMode !== 'none' ? `?chaos=${encodeURIComponent(chaosMode)}` : '';
    await this.page.goto(`/${query}`);
  }

  async applyPromo(code: string): Promise<void> {
    await this.promoInput.fill(code);
    await this.applyPromoButton.click();
  }

  async checkExpressShipping(): Promise<void> {
    await this.expressShippingCheckbox.check();
  }

  async pay(): Promise<void> {
    await this.payButton.click();
  }
}
