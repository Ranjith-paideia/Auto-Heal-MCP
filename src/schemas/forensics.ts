import { z } from 'zod';

export const NetworkFailureSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number(),
  responseBodySnippet: z.string(),
  timestamp: z.number(),
});

export type NetworkFailure = z.infer<typeof NetworkFailureSchema>;

export const ConsoleErrorSchema = z.object({
  type: z.string(),
  text: z.string(),
  timestamp: z.number(),
});

export type ConsoleError = z.infer<typeof ConsoleErrorSchema>;

export const ForensicBundleSchema = z.object({
  testTitle: z.string(),
  filePath: z.string(),
  line: z.number(),
  status: z.string(),
  errorMessage: z.string(),
  errorStack: z.string(),
  ariaSnapshot: z.string(),
  errorContext: z.string(),
  firstPartyNetworkErrors: z.array(NetworkFailureSchema),
  pageErrors: z.array(z.string()),
  consoleErrors: z.array(ConsoleErrorSchema),
  chaosMode: z.string(),
  timestamp: z.number(),
});

export type ForensicBundle = z.infer<typeof ForensicBundleSchema>;

export const ClassificationVerdictSchema = z.object({
  verdict: z.enum(['LOCATOR_DRIFT', 'APP_BUG', 'ASSERTION_MISMATCH', 'UNKNOWN']),
  allowHealing: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});

export type ClassificationVerdict = z.infer<typeof ClassificationVerdictSchema>;

export const ForensicReportSchema = z.object({
  bundle: ForensicBundleSchema,
  classification: ClassificationVerdictSchema,
});

export type ForensicReport = z.infer<typeof ForensicReportSchema>;
