import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ForensicReport } from '../schemas/forensics.js';
import { HealingOutcomeSchema, type HealingOutcome } from '../schemas/healing.js';
import { proposeLocatorPatch } from './ollamaClient.js';
import { validateAstPatch } from '../guardrail/astGuardrail.js';

export interface SafeWorkspacePathResult {
  ok: true;
  absPath: string;
  posixRelative: string;
}

export interface SafeWorkspacePathError {
  ok: false;
  error: string;
}

/**
 * Validates that a target file path is safely contained within workspaceRoot and is a valid TypeScript file.
 */
export function resolveSafeWorkspacePath(
  workspaceRoot: string,
  relativePath: string
): SafeWorkspacePathResult | SafeWorkspacePathError {
  if (!relativePath || relativePath.includes('\0')) {
    return { ok: false, error: 'Invalid file path: empty or contains null bytes' };
  }

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);
  const rel = path.relative(resolvedRoot, resolvedTarget);

  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `Path traversal or outside workspace: ${relativePath}` };
  }

  const posixRelative = rel.replace(/\\/g, '/');

  // Reject .git, node_modules, or non-.ts files
  if (
    posixRelative.startsWith('.git/') ||
    posixRelative.includes('/.git/') ||
    posixRelative.startsWith('node_modules/') ||
    posixRelative.includes('/node_modules/') ||
    !posixRelative.endsWith('.ts')
  ) {
    return {
      ok: false,
      error: `Access denied for path (must be a workspace .ts file, not .git or node_modules): ${posixRelative}`,
    };
  }

  return {
    ok: true,
    absPath: resolvedTarget,
    posixRelative,
  };
}

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

  // Find the changed line
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

export interface VerifyCandidatePatchParams {
  targetFile: string;
  oldSnippet: string;
  newSnippet: string;
  chaosMode: string;
  workspaceRoot: string;
  emitPatch?: boolean;
}

export interface PatchVerificationResult {
  verified: boolean;
  status: 'HEALED' | 'BLOCKED_BY_AST' | 'REJECTED_BY_VERIFIER';
  targetFile: string;
  blastRadiusSpecs: string[];
  violations: string[];
  patchPath: string | null;
  unifiedDiff: string | null;
  reasoning: string;
}

/**
 * Reusable, safe, in-memory patch verifier against Playwright blast-radius specs.
 */
export function verifyCandidatePatch(params: VerifyCandidatePatchParams): PatchVerificationResult {
  const { targetFile, oldSnippet, newSnippet, chaosMode, workspaceRoot, emitPatch } = params;

  // 1) Validate targetFile via resolveSafeWorkspacePath
  const pathCheck = resolveSafeWorkspacePath(workspaceRoot, targetFile);
  if (!pathCheck.ok) {
    return {
      verified: false,
      status: 'REJECTED_BY_VERIFIER',
      targetFile,
      blastRadiusSpecs: [],
      violations: [pathCheck.error],
      patchPath: null,
      unifiedDiff: null,
      reasoning: pathCheck.error,
    };
  }

  const { absPath, posixRelative } = pathCheck;

  // 2) Verify file exists on disk, oldSnippet non-empty, differs from newSnippet, occurs exactly once
  if (!fs.existsSync(absPath)) {
    const err = `Target file does not exist: ${posixRelative}`;
    return {
      verified: false,
      status: 'REJECTED_BY_VERIFIER',
      targetFile: posixRelative,
      blastRadiusSpecs: [],
      violations: [err],
      patchPath: null,
      unifiedDiff: null,
      reasoning: err,
    };
  }

  const originalContent = fs.readFileSync(absPath, 'utf-8');

  if (!oldSnippet || oldSnippet.trim() === '') {
    const err = 'oldSnippet must not be empty';
    return {
      verified: false,
      status: 'BLOCKED_BY_AST',
      targetFile: posixRelative,
      blastRadiusSpecs: [],
      violations: [err],
      patchPath: null,
      unifiedDiff: null,
      reasoning: err,
    };
  }

  if (oldSnippet.trim() === newSnippet.trim()) {
    const err = 'newSnippet must differ from oldSnippet';
    return {
      verified: false,
      status: 'BLOCKED_BY_AST',
      targetFile: posixRelative,
      blastRadiusSpecs: [],
      violations: [err],
      patchPath: null,
      unifiedDiff: null,
      reasoning: err,
    };
  }

  const occurrences = originalContent.split(oldSnippet).length - 1;
  if (occurrences !== 1) {
    const err = `Target snippet must occur exactly once in target file (found ${occurrences})`;
    return {
      verified: false,
      status: 'BLOCKED_BY_AST',
      targetFile: posixRelative,
      blastRadiusSpecs: [],
      violations: [err],
      patchPath: null,
      unifiedDiff: null,
      reasoning: err,
    };
  }

  // 3) Build patchedContent and run AST guardrail
  const patchedContent = originalContent.replace(oldSnippet, newSnippet);
  const astResult = validateAstPatch(originalContent, patchedContent, posixRelative);
  if (!astResult.passed) {
    return {
      verified: false,
      status: 'BLOCKED_BY_AST',
      targetFile: posixRelative,
      blastRadiusSpecs: [],
      violations: astResult.violations,
      patchPath: null,
      unifiedDiff: null,
      reasoning: `AST guardrail rejected patch: ${astResult.violations.join('; ')}`,
    };
  }

  // 4) Compute blastRadiusSpecs
  const blastRadiusSpecs = findBlastRadiusSpecs(posixRelative, workspaceRoot);
  if (blastRadiusSpecs.length === 0) {
    const err = 'No dependent Playwright spec files cover this target file.';
    return {
      verified: false,
      status: 'REJECTED_BY_VERIFIER',
      targetFile: posixRelative,
      blastRadiusSpecs: [],
      violations: [err],
      patchPath: null,
      unifiedDiff: null,
      reasoning: err,
    };
  }

  // 5) Safe temporary apply & silent Playwright execution
  let verificationPassed = false;
  let verificationOutput = '';

  try {
    fs.writeFileSync(absPath, patchedContent, 'utf-8');

    const playResult = spawnSync(
      'npx',
      ['playwright', 'test', ...blastRadiusSpecs, '--reporter=list'],
      {
        cwd: workspaceRoot,
        shell: process.platform === 'win32',
        stdio: 'pipe',
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
    fs.writeFileSync(absPath, originalContent, 'utf-8');
  }

  // 6) If Playwright exits 0
  if (verificationPassed) {
    const unifiedDiff = createUnifiedPatch(posixRelative, originalContent, patchedContent);
    let patchPath: string | null = null;

    if (emitPatch === true) {
      if (!/^[a-zA-Z0-9_-]+$/.test(chaosMode)) {
        return {
          verified: false,
          status: 'REJECTED_BY_VERIFIER',
          targetFile: posixRelative,
          blastRadiusSpecs,
          violations: [`Invalid chaosMode for patch filename: "${chaosMode}"`],
          patchPath: null,
          unifiedDiff,
          reasoning: `Invalid chaosMode for patch emission: "${chaosMode}"`,
        };
      }

      const patchesDir = path.resolve(workspaceRoot, '.veriheal', 'patches');
      if (!fs.existsSync(patchesDir)) {
        fs.mkdirSync(patchesDir, { recursive: true });
      }

      patchPath = `.veriheal/patches/${chaosMode}.patch`;
      const absPatchPath = path.resolve(workspaceRoot, patchPath);
      fs.writeFileSync(absPatchPath, unifiedDiff, 'utf-8');
    }

    return {
      verified: true,
      status: 'HEALED',
      targetFile: posixRelative,
      blastRadiusSpecs,
      violations: [],
      patchPath,
      unifiedDiff,
      reasoning: 'Patch verified successfully against blast-radius specs.',
    };
  }

  // 7) If Playwright exits non-zero
  return {
    verified: false,
    status: 'REJECTED_BY_VERIFIER',
    targetFile: posixRelative,
    blastRadiusSpecs,
    violations: [],
    patchPath: null,
    unifiedDiff: null,
    reasoning: `Verification failed on blast-radius specs: ${verificationOutput.slice(0, 600)}`,
  };
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

  // Delegate Gates 3–6 to reusable verifyCandidatePatch
  const verification = verifyCandidatePatch({
    targetFile: proposal.targetFile,
    oldSnippet: proposal.oldSnippet,
    newSnippet: proposal.newSnippet,
    chaosMode,
    workspaceRoot,
    emitPatch: true,
  });

  return HealingOutcomeSchema.parse({
    chaosMode,
    verdict,
    status: verification.status,
    mode: proposal.mode,
    targetFile: verification.targetFile,
    oldSnippet: proposal.oldSnippet,
    newSnippet: proposal.newSnippet,
    patchPath: verification.patchPath,
    blastRadiusSpecs: verification.blastRadiusSpecs,
    violations: verification.violations,
    reasoning: verification.verified ? proposal.reasoning : verification.reasoning,
  });
}
