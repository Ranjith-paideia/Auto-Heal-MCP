import http from 'node:http';
import type { AddressInfo } from 'node:net';

export function renderCheckoutHtml(chaosMode: string): string {
  // 1) change-input-id: changes promo input id and label for from promo-input to coupon-code-field (keeps label "Promo Code" & placeholder).
  const isChangeInputId = chaosMode === 'change-input-id';
  const promoInputId = isChangeInputId ? 'coupon-code-field' : 'promo-input';
  const promoInputMarkup = `<label for="${promoInputId}">Promo Code</label><input id="${promoInputId}" name="promo" placeholder="Enter promo code" />`;

  // 2) rename-testid: changes Apply Promo button data-testid from apply-promo-btn to apply-discount-v2 (button still works and keeps text "Apply Promo").
  const isRenameTestid = chaosMode === 'rename-testid';
  const promoBtnTestId = isRenameTestid ? 'apply-discount-v2' : 'apply-promo-btn';
  const applyPromoMarkup = `<button type="button" data-testid="${promoBtnTestId}">Apply Promo</button>`;

  // 3) wrap-dom: wraps the express checkbox inside an extra <div class="layout-v2"> so .shipping-options > input.express-toggle breaks while checkbox still works.
  const isWrapDom = chaosMode === 'wrap-dom';
  const shippingMarkup = isWrapDom
    ? `<div class="shipping-options"><div class="layout-v2"><input type="checkbox" class="express-toggle" aria-label="Express Shipping" /></div></div>`
    : `<div class="shipping-options"><input type="checkbox" class="express-toggle" aria-label="Express Shipping" /></div>`;

  // 8) wrong-total: renders <div data-testid="order-total">$199.00</div> instead of $99.00.
  const isWrongTotal = chaosMode === 'wrong-total';
  const totalMarkup = isWrongTotal
    ? `<div data-testid="order-total">$199.00</div>`
    : `<div data-testid="order-total">$99.00</div>`;

  // 4) rename-button: changes Pay button text from "Pay Now" to "Complete Order" (keeps data-testid="pay-now-btn" and click handler working).
  // 6) delete-pay-btn: omits the Pay button completely (only "Cancel Order" remains).
  const isDeletePayBtn = chaosMode === 'delete-pay-btn';
  const isRenameButton = chaosMode === 'rename-button';
  const payBtnText = isRenameButton ? 'Complete Order' : 'Pay Now';
  const payBtnMarkup = isDeletePayBtn
    ? `<button type="button" data-testid="cancel-btn">Cancel Order</button>`
    : `<button type="button" data-testid="pay-now-btn">${payBtnText}</button><button type="button" data-testid="cancel-btn">Cancel Order</button>`;

  // 7) js-crash: clicking Pay throws an uncaught TypeError("Payment processor crashed: undefined submit") inside the click handler (without calling /api/checkout).
  const isJsCrash = chaosMode === 'js-crash';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Chaos Checkout</title>
</head>
<body>
  <h1>Checkout</h1>
  <div class="promo-section">
    ${promoInputMarkup}
    ${applyPromoMarkup}
    <span data-testid="promo-status" style="display: none;"></span>
  </div>
  ${shippingMarkup}
  ${totalMarkup}
  <div class="actions">
    ${payBtnMarkup}
  </div>
  <div data-testid="order-confirmation"></div>

  <script>
    const promoBtn = document.querySelector('[data-testid="apply-promo-btn"], [data-testid="apply-discount-v2"]');
    if (promoBtn) {
      promoBtn.addEventListener('click', () => {
        const statusEl = document.querySelector('[data-testid="promo-status"]');
        if (statusEl) {
          statusEl.textContent = 'Promo Applied';
          statusEl.style.display = 'inline';
        }
      });
    }

    const payBtn = document.querySelector('[data-testid="pay-now-btn"]');
    if (payBtn) {
      payBtn.addEventListener('click', async () => {
        const isCrash = ${JSON.stringify(isJsCrash)};
        if (isCrash) {
          throw new TypeError("Payment processor crashed: undefined submit");
        }

        try {
          const res = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: ['item_1'], amount: 99 })
          });
          const confirmationEl = document.querySelector('[data-testid="order-confirmation"]');
          if (res.ok) {
            const data = await res.json();
            if (confirmationEl) {
              confirmationEl.textContent = 'Order Confirmed: ' + data.orderId;
            }
          } else {
            if (confirmationEl) {
              confirmationEl.textContent = 'Payment Failed';
            }
          }
        } catch (err) {
          const confirmationEl = document.querySelector('[data-testid="order-confirmation"]');
          if (confirmationEl) {
            confirmationEl.textContent = 'Payment Failed';
          }
        }
      });
    }
  </script>
</body>
</html>`;
}

export function startChaosServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const chaosMode = parsedUrl.searchParams.get('chaos') ?? 'none';

      if (req.method === 'GET' && parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderCheckoutHtml(chaosMode));
        return;
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/checkout') {
        // 5) api-500: POST /api/checkout returns HTTP 500 { error: "Payment gateway timeout" }
        // Note: the client might send request with or without query param if called from page script,
        // but if chaosMode was passed in the page URL, the request can also check Referer or we check query
        const referer = req.headers['referer'] || '';
        let effectiveChaos = chaosMode;
        if (effectiveChaos === 'none' && referer) {
          try {
            const refererUrl = new URL(referer);
            effectiveChaos = refererUrl.searchParams.get('chaos') ?? 'none';
          } catch {
            // ignore
          }
        }

        if (effectiveChaos === 'api-500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payment gateway timeout' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orderId: 'ORD-1001', status: 'confirmed', total: 99 }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;
      resolve({
        url,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => {
              if (err) {
                closeReject(err);
              } else {
                closeResolve();
              }
            });
          }),
      });
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}
