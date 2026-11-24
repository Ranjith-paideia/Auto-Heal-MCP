import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ForensicBundle } from '../src/schemas/forensics.js';

console.log('Running End-to-End MCP Stdio Verification Suite...');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/mcp/server.ts'],
  cwd: process.cwd(),
  stderr: 'pipe',
});

const client = new Client(
  {
    name: 'auto-heal-mcp-test-client',
    version: '1.0.0',
  },
  {
    capabilities: {},
  }
);

try {
  await client.connect(transport);
  console.log('✓ Connected to MCP server over stdio');

  // Check 1: listTools() returns the exact 4 tools
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name).sort();
  const expectedTools = [
    'classify_failure',
    'get_latest_forensics',
    'validate_ast_patch',
    'verify_patch_blast_radius',
  ];
  assert.deepEqual(toolNames, expectedTools, 'Must expose exact 4 deterministic tools');
  console.log('✓ Check 1 passed: listTools() returned exact 4 tools');

  // Check 2: get_latest_forensics
  const reportPath = path.resolve(process.cwd(), '.veriheal', 'latest-forensics.json');
  if (!fs.existsSync(reportPath)) {
    console.log('Generating baseline forensics for test via api-500...');
    spawnSync('npx', ['playwright', 'test', 'benchmark/tests/checkout.spec.ts'], {
      shell: process.platform === 'win32',
      stdio: 'pipe',
      env: {
        ...process.env,
        CHAOS_MODE: 'api-500',
      },
    });
  }

  const forensicsRes: any = await client.callTool({
    name: 'get_latest_forensics',
    arguments: {},
  });
  assert.ok(forensicsRes.content?.[0]?.text, 'get_latest_forensics must return text content');
  const forensicsData = JSON.parse(forensicsRes.content[0].text);
  assert.equal(forensicsData.found, true, 'Forensics report should be found');
  assert.ok(forensicsData.report?.classification?.verdict, 'Report classification verdict must be defined');
  console.log('✓ Check 2 passed: get_latest_forensics returned valid report');

  // Check 3: classify_failure with synthetic HTTP 500 ForensicBundle
  const syntheticBundle: ForensicBundle = {
    testTitle: 'checkout.spec.ts > complete checkout flow',
    filePath: 'benchmark/tests/checkout.spec.ts',
    line: 23,
    status: 'failed',
    errorMessage: "Error: expect(locator).toContainText() timed out waiting for 'Order Confirmed'",
    errorStack: 'Error: expect(locator).toContainText() timed out',
    ariaSnapshot: '- button "Pay Now"',
    errorContext: '',
    firstPartyNetworkErrors: [
      {
        url: 'http://127.0.0.1:5000/api/checkout',
        method: 'POST',
        status: 500,
        responseBodySnippet: '{"error":"Payment gateway timeout"}',
        timestamp: Date.now(),
      },
    ],
    pageErrors: [],
    consoleErrors: [],
    chaosMode: 'api-500',
    timestamp: Date.now(),
  };

  const classifyRes: any = await client.callTool({
    name: 'classify_failure',
    arguments: {
      bundle: syntheticBundle,
    },
  });
  const classifyData = JSON.parse(classifyRes.content[0].text);
  assert.equal(classifyData.verdict, 'APP_BUG', 'HTTP 500 network error must classify as APP_BUG');
  assert.equal(classifyData.allowHealing, false, 'APP_BUG must not allow healing');
  console.log('✓ Check 3 passed: classify_failure correctly classified APP_BUG (allowHealing: false)');

  // Check 4: validate_ast_patch with mutating assertion value ($99.00 -> $199.00)
  const originalCode = `import { test, expect } from '@playwright/test';\ntest('checkout', async ({ page }) => {\n  await expect(page.locator('#total')).toHaveText('$99.00');\n});`;
  const mutatedCode = `import { test, expect } from '@playwright/test';\ntest('checkout', async ({ page }) => {\n  await expect(page.locator('#total')).toHaveText('$199.00');\n});`;

  const astRes: any = await client.callTool({
    name: 'validate_ast_patch',
    arguments: {
      originalSource: originalCode,
      patchedSource: mutatedCode,
      fileName: 'checkout.spec.ts',
    },
  });
  const astData = JSON.parse(astRes.content[0].text);
  assert.equal(astData.passed, false, 'Mutated assertion value must fail AST guardrail');
  assert.ok(astData.violations.length > 0, 'Violations array must be populated');
  console.log('✓ Check 4 passed: validate_ast_patch rejected weakened assertion');

  // Check 5: verify_patch_blast_radius
  // 5a: Path-traversal check
  const traversalRes: any = await client.callTool({
    name: 'verify_patch_blast_radius',
    arguments: {
      targetFile: '../outside.ts',
      oldSnippet: 'const a = 1;',
      newSnippet: 'const a = 2;',
      chaosMode: 'rename-testid',
      emitPatch: false,
    },
  });
  const traversalData = JSON.parse(traversalRes.content[0].text);
  assert.equal(traversalData.verified, false, 'Path traversal must be rejected');
  assert.equal(traversalData.status, 'REJECTED_BY_VERIFIER');
  console.log('✓ Check 5a passed: verify_patch_blast_radius rejected path traversal safely');

  // 5b: Positive verification check
  const checkoutPagePath = path.resolve(process.cwd(), 'benchmark/pages/CheckoutPage.ts');
  const diskBefore = fs.readFileSync(checkoutPagePath, 'utf-8');

  const oldSnippet = `    this.applyPromoButton = page.locator('[data-testid="apply-promo-btn"]');`;
  const newSnippet = `    this.applyPromoButton = page.getByRole('button', { name: 'Apply Promo' });`;

  const verifyRes: any = await client.callTool({
    name: 'verify_patch_blast_radius',
    arguments: {
      targetFile: 'benchmark/pages/CheckoutPage.ts',
      oldSnippet,
      newSnippet,
      chaosMode: 'rename-testid',
      emitPatch: false,
    },
  });
  const verifyData = JSON.parse(verifyRes.content[0].text);
  assert.equal(verifyData.verified, true, 'Patch should verify against blast-radius specs');
  assert.equal(verifyData.status, 'HEALED');
  assert.equal(verifyData.blastRadiusSpecs.length, 2, 'Should detect both checkout.spec.ts and checkout-smoke.spec.ts');
  assert.ok(
    verifyData.unifiedDiff.includes('--- a/benchmark/pages/CheckoutPage.ts'),
    'Unified diff must include target path'
  );

  const diskAfter = fs.readFileSync(checkoutPagePath, 'utf-8');
  assert.equal(diskAfter, diskBefore, 'CheckoutPage.ts on disk must be byte-for-byte unchanged after verification');
  console.log('✓ Check 5b passed: verify_patch_blast_radius verified patch with zero disk corruption');

  console.log('\nAll 5 MCP stdio verification checks passed successfully!');
} finally {
  await client.close().catch(() => {});
}
