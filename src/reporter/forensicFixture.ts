import { test as baseTest, expect } from '@playwright/test';
import { startChaosServer } from '../../benchmark/app/server.js';
import type { NetworkFailure, ConsoleError } from '../schemas/forensics.js';

interface ForensicWorkerFixtures {
  serverUrl: string;
}

export const test = baseTest.extend<{}, ForensicWorkerFixtures>({
  // Worker-scoped fixture serverUrl starting startChaosServer() on port 0 and closing it in teardown
  serverUrl: [
    async ({}, use) => {
      const server = await startChaosServer();
      await use(server.url);
      await server.close();
    },
    { scope: 'worker' },
  ],

  baseURL: async ({ serverUrl }, use) => {
    await use(serverUrl);
  },

  page: async ({ page, serverUrl }, use, testInfo) => {
    const firstPartyNetworkErrors: NetworkFailure[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: ConsoleError[] = [];
    const pendingReads: Promise<void>[] = [];

    // First-party network errors ONLY (res.url().startsWith(serverUrl) && res.status() >= 400)
    page.on('response', (res) => {
      if (res.url().startsWith(serverUrl) && res.status() >= 400) {
        const readPromise = res
          .text()
          .catch(() => '<unavailable>')
          .then((bodySnippet) => {
            firstPartyNetworkErrors.push({
              url: res.url(),
              method: res.request().method(),
              status: res.status(),
              responseBodySnippet: bodySnippet.slice(0, 1000),
              timestamp: Date.now(),
            });
          });
        pendingReads.push(readPromise);
      }
    });

    // Uncaught pageerror exceptions (err.stack || err.message)
    page.on('pageerror', (err) => {
      pageErrors.push(err.stack || err.message);
    });

    // console messages of type 'error'
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push({
          type: msg.type(),
          text: msg.text(),
          timestamp: Date.now(),
        });
      }
    });

    await use(page);

    // Track all async res.text().catch(...) promises and await Promise.allSettled(pendingReads) before teardown
    await Promise.allSettled(pendingReads);

    // When testInfo.status !== testInfo.expectedStatus, capture ariaSnapshot and attach veriheal-telemetry
    if (testInfo.status !== testInfo.expectedStatus) {
      const ariaSnapshot = await page
        .locator('body')
        .ariaSnapshot()
        .catch(() => '');

      const chaosMode = process.env.CHAOS_MODE ?? 'none';

      const telemetry = {
        firstPartyNetworkErrors,
        pageErrors,
        consoleErrors,
        ariaSnapshot,
        chaosMode,
      };

      await testInfo.attach('veriheal-telemetry', {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(telemetry)),
      });
    }
  },
});

export { expect };
