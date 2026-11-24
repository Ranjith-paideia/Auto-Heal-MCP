import { z } from 'zod';

export const PatchProposalSchema = z.object({
  canHeal: z.boolean(),
  targetFile: z.string(), // POSIX workspace-relative path, e.g. benchmark/pages/CheckoutPage.ts; empty string if unresolved
  oldSnippet: z.string(), // exact single line from targetFile, empty string if canHeal is false
  newSnippet: z.string(), // exact replacement line preserving indentation, LHS assignment, receiver page./this.page., and trailing semicolon; empty string if canHeal is false
  reasoning: z.string(),
  mode: z.enum(['ollama-live', 'deterministic-fallback']),
});

export type PatchProposal = z.infer<typeof PatchProposalSchema>;

export const AstGuardrailResultSchema = z.object({
  passed: z.boolean(),
  violations: z.array(z.string()),
  assertionsBefore: z.number().int().nonnegative(),
  assertionsAfter: z.number().int().nonnegative(),
});

export type AstGuardrailResult = z.infer<typeof AstGuardrailResultSchema>;

export const HealingOutcomeSchema = z.object({
  chaosMode: z.string(),
  verdict: z.enum(['LOCATOR_DRIFT', 'APP_BUG', 'ASSERTION_MISMATCH', 'UNKNOWN']),
  status: z.enum([
    'HEALED',
    'BLOCKED_BY_CLASSIFIER',
    'BLOCKED_BY_AST',
    'NO_CANDIDATE',
    'REJECTED_BY_VERIFIER',
  ]),
  mode: z.enum(['ollama-live', 'deterministic-fallback', 'none']),
  targetFile: z.string().nullable(),
  oldSnippet: z.string().nullable(),
  newSnippet: z.string().nullable(),
  patchPath: z.string().nullable(),
  blastRadiusSpecs: z.array(z.string()),
  violations: z.array(z.string()),
  reasoning: z.string(),
});

export type HealingOutcome = z.infer<typeof HealingOutcomeSchema>;
