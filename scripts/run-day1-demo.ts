import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ForensicReportSchema } from '../src/schemas/forensics.js';

const chaosMode = process.argv[2] ?? 'none';
console.log(`\n======================================================`);
console.log(`[Auto-Heal-MCP Day 1 Demo] Running mode: ${chaosMode}`);
console.log(`======================================================\n`);

// Run Playwright test; do NOT crash on non-zero exit code because chaos failures are expected!
const testProcess = spawnSync('npx', ['playwright', 'test', 'benchmark/tests/checkout.spec.ts'], {
  shell: true,
  stdio: 'inherit',
  env: {
    ...process.env,
    CHAOS_MODE: chaosMode,
  },
});

console.log(`\nPlaywright test finished with exit code: ${testProcess.status}`);

const reportPath = path.resolve(process.cwd(), '.veriheal', 'latest-forensics.json');

if (!fs.existsSync(reportPath)) {
  if (testProcess.status === 0) {
    console.log(`Test passed completely (no failure forensics generated).`);
    process.exit(0);
  } else {
    console.error(`ERROR: Expected forensics report at ${reportPath}, but none was found!`);
    process.exit(1);
  }
}

try {
  const fileContent = fs.readFileSync(reportPath, 'utf-8');
  const rawReport = JSON.parse(fileContent);
  const validatedReport = ForensicReportSchema.parse(rawReport);

  const { bundle, classification } = validatedReport;

  console.log(`\n======================================================`);
  console.log(`               FORENSIC CLASSIFICATION                `);
  console.log(`======================================================`);
  console.table([
    {
      'Chaos Mode': bundle.chaosMode,
      'First-Party Network Errors': bundle.firstPartyNetworkErrors.length,
      'Page Errors': bundle.pageErrors.length,
      Verdict: classification.verdict,
      'Allow Healing': classification.allowHealing,
      Confidence: classification.confidence,
    },
  ]);
  console.log(`Reasons:`);
  for (const reason of classification.reasons) {
    console.log(`  - ${reason}`);
  }
  if (bundle.firstPartyNetworkErrors.length > 0) {
    console.log(`Network Failures:`);
    for (const netErr of bundle.firstPartyNetworkErrors) {
      console.log(`  * ${netErr.method} ${netErr.url} -> HTTP ${netErr.status}`);
      console.log(`    Response snippet: ${netErr.responseBodySnippet}`);
    }
  }
  if (bundle.pageErrors.length > 0) {
    console.log(`Page Errors:`);
    for (const pErr of bundle.pageErrors) {
      console.log(`  * ${pErr}`);
    }
  }
  console.log(`======================================================\n`);
} catch (err) {
  console.error(`Failed to parse or validate forensic report schema:`, err);
  process.exit(1);
}
