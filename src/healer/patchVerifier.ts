import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ForensicReport } from '../schemas/forensics.js';
import { HealingOutcomeSchema, type HealingOutcome } from '../schemas/healing.js';
import { proposeLocatorPatch } from './ollamaClient.js';
import { validateAstPatch } from '../guardrail/astGuardrail.js';

/**
 * Scans benchmark/tests/ for all *.spec.ts files that import the target file's base module.
 */
export function findBlastRadiusSpecs(targetFile: string, workspaceRoot: string): string[] {
  const specs: string[] = [];
  const testsDir = path.resolve(workspaceRoot, 'benchmark/tests');

  if (!fs.existsSync(testsDir)) {
    return specs;
  }

  // Base module name (e.g. "CheckoutPage" from "benchmark/pages/CheckoutPage.ts")
  const targetBaseName = path.basename(targetFile, path.extname(targetFile));

  const entries = fs.readdirSync(testsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      const absSpec = path.join(testsDir, entry.name);
      const relativeSpec = path.relative(workspaceRoot, absSpec).replace(/\\/g, '/');

      if (targetFile.replace(/\\/g, '/') === relativeSpec) {
        specs.push(relativeSpec);
        continue;
      }

      const content = fs.readFileSync(absSpec, 'utf-8');
      if (
        content.includes(targetBaseName) ||
        content.includes(targetFile) ||
        content.includes(targetFile.replace(/\\/g, '/'))
      ) {
        specs.push(relativeSpec);
      }
    }
  }

  return specs.sort();
}

/**
 * Generates a standard unified diff with POSIX paths and accurate hunk headers.
 */
export function createUnifiedPatch(
  relativeFilePath: string,
  originalContent: string,
  patchedContent: string
): string {
  const posixPath = relativeFilePath.replace(/\\/g, '/');
  const originalLines = originalContent.split(/\r?\n/);
  const patchedLines = patchedContent.split(/\r?\n/);

  // Find the changed line (assuming single contiguous block or single line edit)
  let changeStart = -1;
  for (let i = 0; i < Math.max(originalLines.length, patchedLines.length); i++) {
    if (originalLines[i] !== patchedLines[i]) {
      changeStart = i;
      break;
    }
  }

  if (changeStart === -1) {
    return '';
  }

  // Context: up to 3 lines before and after
  const contextBefore = Math.max(0, changeStart - 3);
  const contextAfterOld = Math.min(originalLines.length, changeStart + 4);
  const contextAfterNew = Math.min(patchedLines.length, changeStart + 4);

  const oldCount = contextAfterOld - contextBefore;
  const newCount = contextAfterNew - contextBefore;

  const header = `--- a/${posixPath}\n+++ b/${posixPath}\n@@ -${contextBefore + 1},${oldCount} +${contextBefore + 1},${newCount} @@\n`;

  const hunkLines: string[] = [];
  for (let i = contextBefore; i < changeStart; i++) {
    hunkLines.push(` ${originalLines[i]}`);
  }
  hunkLines.push(`-${originalLines[changeStart]}`);
  hunkLines.push(`+${patchedLines[changeStart]}`);
  for (let i = changeStart + 1; i < contextAfterOld; i++) {
    hunkLines.push(` ${originalLines[i]}`);
  }

  return header + hunkLines.join('\n') + '\n';
}

/**
 * Executes the complete Auto-Heal-MCP Gate 1 through Gate 6 pipeline.
 */
export async function runHealerPipeline(
  report: ForensicReport,
  workspaceRoot: string
): Promise<HealingOutcome> {
  const chaosMode = report.bundle.chaosMode;
  const verdict = report.classification.verdict;

  // Gate 1 — Classifier
  if (!report.classification.allowHealing) {
    return HealingOutcomeSchema.parse({
      chaosMode,
      verdict,
      status: 'BLOCKED_BY_CLASSIFIER',
      mode: 'none',
      targetFile: null,
      oldSnippet: null,
      newSnippet: null,
      patchPath: null,
      blastRadiusSpecs: [],
      violations: [],
      reasoning: report.classification.reasons.join('; '),
    });
  }

  // Gate 2 — Proposal
  const proposal = await proposeLocatorPatch(report.bundle, workspaceRoot);
  if (!proposal.canHeal || !proposal.targetFile) {
    return HealingOutcomeSchema.parse({
      chaosMode,
      verdict,
      status: 'NO_CANDIDATE',
      mode: proposal.mode,
      targetFile: proposal.targetFile || null,
      oldSnippet: proposal.oldSnippet || null,
      newSnippet: proposal.newSnippet || null,
      patchPath: null,
      blastRadiusSpecs: [],
      violations: [],
      reasoning: proposal.reasoning,
    });
  }

  const absTarget = path.resolve(workspaceRoot, proposal.targetFile);
  if (!fs.existsSync(absTarget)) {
    return HealingOutcomeSchema.parse({
      chaosMode,
      verdict,
      status: 'NO_CANDIDATE',
      mode: proposal.mode,
      targetFile: proposal.targetFile,
      oldSnippet: proposal.oldSnippet,
      newSnippet: proposal.newSnippet,
      patchPath: null,
      blastRadiusSpecs: [],
      violations: [`Target file does not exist: ${proposal.targetFile}`],
      reasoning: `Target file ${proposal.targetFile} could not be resolved on disk.`,
    });
  }

  const originalContent = fs.readFileSync(absTarget, 'utf-8');

  // Gate 3 — Exact Single-Match Safety Check
  const occurrences = originalContent.split(proposal.oldSnippet).length - 1;
  if (occurrences !== 1) {
    const violation = `Target snippet must occur exactly once in target file (found ${occurrences})`;
    return HealingOutcomeSchema.parse({
      chaosMode,
      verdict,
      status: 'BLOCKED_BY_AST',
      mode: proposal.mode,
      targetFile: proposal.targetFile,
      oldSnippet: proposal.oldSnippet,
      newSnippet: proposal.newSnippet,
      patchPath: null,
      blastRadiusSpecs: [],
      violations: [violation],
      reasoning: violation,
    });
  }

  // Gate 4 — AST Guardrail
  const patchedContent = originalContent.replace(proposal.oldSnippet, proposal.newSnippet);
  const astResult = validateAstPatch(originalContent, patchedContent, proposal.targetFile);
  if (!astResult.passed) {
    return HealingOutcomeSchema.parse({
      chaosMode,
      verdict,
      status: 'BLOCKED_BY_AST',
      mode: proposal.mode,
      targetFile: proposal.targetFile,
      oldSnippet: proposal.oldSnippet,
      newSnippet: proposal.newSnippet,
      patchPath: null,
      blastRadiusSpecs: [],
      violations: astResult.violations,
      reasoning: `AST guardrail rejected patch: ${astResult.violations.join('; ')}`,
    });
  }

  // Gate 5 — Safe Apply & Blast-Radius Verification (No Git Worktrees)
  const blastRadiusSpecs = findBlastRadiusSpecs(proposal.targetFile, workspaceRoot);

  let verificationPassed = false;
  let verificationOutput = '';

  try {
    fs.writeFileSync(absTarget, patchedContent, 'utf-8');

    // Run Playwright with --reporter=list so forensicReporter is not invoked
    const playResult = spawnSync(
      'npx',
      ['playwright', 'test', ...blastRadiusSpecs, '--reporter=list'],
      {
        cwd: workspaceRoot,
        shell: true,
        encoding: 'utf-8',
        env: {
          ...process.env,
          CHAOS_MODE: chaosMode,
        },
      }
    );

    verificationPassed = playResult.status === 0;
    verificationOutput = (playResult.stdout || '') + (playResult.stderr || '');
  } finally {
    // ALWAYS restore originalContent byte-for-byte
    fs.writeFileSync(absTarget, originalContent, 'utf-8');
  }

  // Gate 6 — Emit Verified Patch
  if (verificationPassed) {
    const patchesDir = path.resolve(workspaceRoot, '.veriheal', 'patches');
    if (!fs.existsSync(patchesDir)) {
      fs.mkdirSync(patchesDir, { recursive: true });
    }

    const patchPath = `.veriheal/patches/${chaosMode}.patch`;
    const absPatchPath = path.resolve(workspaceRoot, patchPath);
    const unifiedDiff = createUnifiedPatch(proposal.targetFile, originalContent, patchedContent);
    fs.writeFileSync(absPatchPath, unifiedDiff, 'utf-8');

    return HealingOutcomeSchema.parse({
      chaosMode,
      verdict,
      status: 'HEALED',
      mode: proposal.mode,
      targetFile: proposal.targetFile,
      oldSnippet: proposal.oldSnippet,
      newSnippet: proposal.newSnippet,
      patchPath,
      blastRadiusSpecs,
      violations: [],
      reasoning: proposal.reasoning,
    });
  }

  return HealingOutcomeSchema.parse({
    chaosMode,
    verdict,
    status: 'REJECTED_BY_VERIFIER',
    mode: proposal.mode,
    targetFile: proposal.targetFile,
    oldSnippet: proposal.oldSnippet,
    newSnippet: proposal.newSnippet,
    patchPath: null,
    blastRadiusSpecs,
    violations: [],
    reasoning: `Verification failed on blast-radius specs: ${verificationOutput.slice(0, 300)}`,
  });
}
