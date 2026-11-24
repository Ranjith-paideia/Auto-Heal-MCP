import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ForensicReportSchema } from '../src/schemas/forensics.js';
import { runHealerPipeline } from '../src/healer/patchVerifier.js';

const chaosMode = process.argv[2];
if (!chaosMode) {
  console.error('Usage: tsx scripts/run-day2-demo.ts <chaos-mode>');
  process.exit(1);
}

console.log(`\n======================================================`);
console.log(`[Auto-Heal-MCP Day 2 Healer Demo] Running mode: ${chaosMode}`);
console.log(`======================================================\n`);

// Run checkout.spec.ts explicitly to generate failure forensics
const testProcess = spawnSync(
  'npx',
  ['playwright', 'test', 'benchmark/tests/checkout.spec.ts'],
  {
    shell: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      CHAOS_MODE: chaosMode,
    },
  }
);

console.log(`\nPlaywright test finished with exit code: ${testProcess.status}`);

const reportPath = path.resolve(process.cwd(), '.veriheal', 'latest-forensics.json');

if (!fs.existsSync(reportPath)) {
  console.log(`Test passed completely (no failure forensics generated, no failure to heal).`);
  process.exit(1);
}

try {
  const fileContent = fs.readFileSync(reportPath, 'utf-8');
  const rawReport = JSON.parse(fileContent);
  const validatedReport = ForensicReportSchema.parse(rawReport);

  const outcome = await runHealerPipeline(validatedReport, process.cwd());

  console.log(`\n======================================================`);
  console.log(`                   HEALING OUTCOME                    `);
  console.log(`======================================================`);
  console.table([
    {
      'Chaos Mode': outcome.chaosMode,
      Verdict: outcome.verdict,
      Status: outcome.status,
      Mode: outcome.mode,
      'Target File': outcome.targetFile ?? 'none',
      'Blast Radius Specs': outcome.blastRadiusSpecs.join(', ') || 'none',
      'Patch Path': outcome.patchPath ?? 'none',
    },
  ]);

  if (outcome.oldSnippet) {
    console.log(`Old Snippet:`);
    console.log(`  ${outcome.oldSnippet.trim()}`);
  }
  if (outcome.newSnippet) {
    console.log(`New Snippet:`);
    console.log(`  ${outcome.newSnippet.trim()}`);
  }
  if (outcome.violations.length > 0) {
    console.log(`Violations:`);
    for (const v of outcome.violations) {
      console.log(`  - ${v}`);
    }
  }
  console.log(`Reasoning:`);
  console.log(`  ${outcome.reasoning}`);
  console.log(`======================================================\n`);

  if (outcome.status === 'HEALED' && outcome.patchPath) {
    const absPatch = path.resolve(process.cwd(), outcome.patchPath);
    if (fs.existsSync(absPatch)) {
      console.log(`Generated Unified Patch (${outcome.patchPath}):\n`);
      console.log(fs.readFileSync(absPatch, 'utf-8'));
    }
  }
} catch (err) {
  console.error('Failed to run healer pipeline:', err);
  process.exit(1);
}
