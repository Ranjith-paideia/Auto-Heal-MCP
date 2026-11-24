import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ForensicReportSchema } from '../src/schemas/forensics.js';
import { runHealerPipeline } from '../src/healer/patchVerifier.js';

if (process.argv.includes('--offline')) {
  process.env.VERIHEAL_OFFLINE = '1';
}

const isOffline = process.env.VERIHEAL_OFFLINE === '1' || process.env.VERIHEAL_OFFLINE === 'true';

console.log('\n======================================================');
console.log(`[Auto-Heal-MCP] 8-Scenario Chaos Benchmark Evaluation`);
console.log(`Mode: ${isOffline ? 'OFFLINE (Semantic ARIA deterministic fallback)' : 'ONLINE (Ollama + ARIA fallback)'}`);
console.log('======================================================\n');

// 1. Snapshot benchmark/pages/CheckoutPage.ts content before benchmark starts
const checkoutPagePath = path.resolve(process.cwd(), 'benchmark/pages/CheckoutPage.ts');
const originalCheckoutContent = fs.readFileSync(checkoutPagePath, 'utf-8');

// 2. Preflight Baseline
console.log('Running Preflight Baseline (CHAOS_MODE=none)...');
const baselineRun = spawnSync('npx', ['playwright', 'test'], {
  shell: process.platform === 'win32',
  stdio: 'pipe',
  encoding: 'utf-8',
  env: {
    ...process.env,
    CHAOS_MODE: 'none',
  },
});

if (baselineRun.status !== 0) {
  console.error('FATAL: Preflight baseline failed! Tests must pass in baseline mode.');
  console.error(baselineRun.stdout);
  console.error(baselineRun.stderr);
  process.exit(1);
}
console.log('✓ Preflight baseline passed cleanly (100% green)\n');

interface ScenarioConfig {
  mode: string;
  category: 'UI_REFACTOR' | 'APP_BUG';
}

const scenarios: ScenarioConfig[] = [
  // 4 UI Refactors (expect HEALED + .patch emitted)
  { mode: 'rename-testid', category: 'UI_REFACTOR' },
  { mode: 'rename-button', category: 'UI_REFACTOR' },
  { mode: 'change-input-id', category: 'UI_REFACTOR' },
  { mode: 'wrap-dom', category: 'UI_REFACTOR' },

  // 4 P0 App Bugs (expect status !== HEALED + NO .patch emitted)
  { mode: 'api-500', category: 'APP_BUG' },
  { mode: 'delete-pay-btn', category: 'APP_BUG' },
  { mode: 'js-crash', category: 'APP_BUG' },
  { mode: 'wrong-total', category: 'APP_BUG' },
];

interface ScenarioResult {
  scenario: string;
  category: 'UI_REFACTOR' | 'APP_BUG';
  verdict: string;
  status: string;
  mode: string;
  blastSpecs: string;
  durationMs: number;
  result: 'PASS' | 'FAIL';
  patchExists: boolean;
  reasoning: string;
}

const results: ScenarioResult[] = [];

for (const sc of scenarios) {
  const startTime = Date.now();
  console.log(`[Evaluation] Running scenario: ${sc.mode} (${sc.category})...`);

  // 1) Remove any stale patch
  const patchFile = path.resolve(process.cwd(), '.veriheal', 'patches', `${sc.mode}.patch`);
  if (fs.existsSync(patchFile)) {
    fs.unlinkSync(patchFile);
  }

  // 2) Run playwright test benchmark/tests/checkout.spec.ts with CHAOS_MODE
  const testRun = spawnSync(
    'npx',
    ['playwright', 'test', 'benchmark/tests/checkout.spec.ts'],
    {
      shell: process.platform === 'win32',
      stdio: 'pipe',
      encoding: 'utf-8',
      env: {
        ...process.env,
        CHAOS_MODE: sc.mode,
      },
    }
  );

  const reportPath = path.resolve(process.cwd(), '.veriheal', 'latest-forensics.json');

  if (testRun.status === 0 || !fs.existsSync(reportPath)) {
    const durationMs = Date.now() - startTime;
    results.push({
      scenario: sc.mode,
      category: sc.category,
      verdict: 'NONE',
      status: 'UNEXPECTED_PASS',
      mode: 'none',
      blastSpecs: 'none',
      durationMs,
      result: 'FAIL',
      patchExists: false,
      reasoning: 'Test unexpectedly passed or failed to generate forensics report',
    });
    continue;
  }

  try {
    const reportRaw = fs.readFileSync(reportPath, 'utf-8');
    const report = ForensicReportSchema.parse(JSON.parse(reportRaw));

    // Run healer pipeline
    const outcome = await runHealerPipeline(report, process.cwd());
    const durationMs = Date.now() - startTime;
    const patchExists = fs.existsSync(patchFile);

    const isPassed =
      sc.category === 'UI_REFACTOR'
        ? outcome.status === 'HEALED' && patchExists
        : outcome.status !== 'HEALED' && !patchExists;

    results.push({
      scenario: sc.mode,
      category: sc.category,
      verdict: outcome.verdict,
      status: outcome.status,
      mode: outcome.mode,
      blastSpecs: outcome.blastRadiusSpecs.join(', ') || 'none',
      durationMs,
      result: isPassed ? 'PASS' : 'FAIL',
      patchExists,
      reasoning: outcome.reasoning,
    });
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    results.push({
      scenario: sc.mode,
      category: sc.category,
      verdict: 'ERROR',
      status: 'PIPELINE_ERROR',
      mode: 'none',
      blastSpecs: 'none',
      durationMs,
      result: 'FAIL',
      patchExists: false,
      reasoning: String(err.message || err),
    });
  }
}

// Assert CheckoutPage.ts is still byte-for-byte identical
const currentCheckoutContent = fs.readFileSync(checkoutPagePath, 'utf-8');
const fileIntegrityMaintained = currentCheckoutContent === originalCheckoutContent;

// Metrics calculation
const refactorResults = results.filter((r) => r.category === 'UI_REFACTOR');
const bugResults = results.filter((r) => r.category === 'APP_BUG');

const refactorsHealed = refactorResults.filter((r) => r.result === 'PASS').length;
const bugsBlocked = bugResults.filter((r) => r.result === 'PASS').length;
const falseGreens = bugResults.filter((r) => r.status === 'HEALED' || r.patchExists).length;
const overallAccuracy = (refactorsHealed + bugsBlocked) / results.length;

// Print Table
console.log('\n======================================================');
console.log('                 CHAOS BENCHMARK RESULTS              ');
console.log('======================================================');
console.table(
  results.map((r) => ({
    Scenario: r.scenario,
    Category: r.category,
    Verdict: r.verdict,
    Status: r.status,
    Mode: r.mode,
    'Blast Specs': r.blastSpecs,
    'Duration (ms)': r.durationMs,
    Result: r.result,
  }))
);

console.log('Summary Metrics:');
console.log(`  - Refactors Healed:     ${refactorsHealed} / 4 (${((refactorsHealed / 4) * 100).toFixed(1)}%)`);
console.log(`  - P0 Bugs Blocked:      ${bugsBlocked} / 4 (${((bugsBlocked / 4) * 100).toFixed(1)}%)`);
console.log(`  - False-Green Count:    ${falseGreens} / 4 (${((falseGreens / 4) * 100).toFixed(1)}%) [Gate: MUST BE 0]`);
console.log(`  - Overall Accuracy:     ${(overallAccuracy * 100).toFixed(1)}%`);
console.log(`  - Disk File Integrity:  ${fileIntegrityMaintained ? 'PASSED (Zero disk drift)' : 'FAILED'}`);
console.log('======================================================\n');

// Write scorecard JSON
const scorecard = {
  timestamp: new Date().toISOString(),
  offlineMode: isOffline,
  metrics: {
    refactorsHealed: `${refactorsHealed}/4`,
    bugsBlocked: `${bugsBlocked}/4`,
    falseGreens: `${falseGreens}/4`,
    overallAccuracy: `${(overallAccuracy * 100).toFixed(1)}%`,
    fileIntegrityMaintained,
  },
  scenarios: results,
};

const verihealDir = path.resolve(process.cwd(), '.veriheal');
if (!fs.existsSync(verihealDir)) {
  fs.mkdirSync(verihealDir, { recursive: true });
}
fs.writeFileSync(
  path.join(verihealDir, 'eval-scorecard.json'),
  JSON.stringify(scorecard, null, 2),
  'utf-8'
);

// Exit condition: all 8/8 pass, falseGreens === 0, file integrity maintained
const allPassed = results.every((r) => r.result === 'PASS');
if (allPassed && falseGreens === 0 && fileIntegrityMaintained) {
  console.log('✓ Chaos benchmark evaluation completed with 100% success and 0% false-greens.');
  process.exit(0);
} else {
  console.error('✗ Chaos benchmark evaluation FAILED gate requirements.');
  process.exit(1);
}
