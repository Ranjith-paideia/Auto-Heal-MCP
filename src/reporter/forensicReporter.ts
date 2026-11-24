import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { ForensicReportSchema, type ForensicBundle } from '../schemas/forensics.js';
import { redactForensicBundle } from '../core/redactor.js';
import { classifyFailure } from '../core/classifier.js';

function stripAnsi(str: string): string {
  // ANSI escape code regex
  return str.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, '');
}

function readAttachmentContent(att: { body?: Buffer; path?: string }): string {
  if (att.body) {
    return att.body.toString('utf-8');
  }
  if (att.path && fs.existsSync(att.path)) {
    return fs.readFileSync(att.path, 'utf-8');
  }
  return '';
}

export default class ForensicReporter implements Reporter {
  private outputDir: string;

  constructor() {
    this.outputDir = path.resolve(process.cwd(), '.veriheal');
  }

  onBegin(_config: FullConfig, _suite: Suite): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    const reportFile = path.join(this.outputDir, 'latest-forensics.json');
    if (fs.existsSync(reportFile)) {
      fs.unlinkSync(reportFile);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed') {
      return;
    }

    const testTitle = test.titlePath().join(' > ');
    const filePath = test.location.file;
    const line = test.location.line;
    const status = result.status;

    let errorMessage = '';
    let errorStack = '';
    if (result.errors && result.errors.length > 0) {
      errorMessage = result.errors.map((e) => stripAnsi(e.message || '')).join('\n');
      errorStack = result.errors.map((e) => stripAnsi(e.stack || '')).join('\n');
    } else if (result.error) {
      errorMessage = stripAnsi(result.error.message || '');
      errorStack = stripAnsi(result.error.stack || '');
    }

    let ariaSnapshot = '';
    let errorContext = '';
    let firstPartyNetworkErrors: ForensicBundle['firstPartyNetworkErrors'] = [];
    let pageErrors: string[] = [];
    let consoleErrors: ForensicBundle['consoleErrors'] = [];
    let chaosMode = process.env.CHAOS_MODE ?? 'none';

    // Extract attachments: veriheal-telemetry and native error-context
    for (const att of result.attachments) {
      if (att.name === 'veriheal-telemetry') {
        try {
          const raw = readAttachmentContent(att);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.ariaSnapshot) ariaSnapshot = parsed.ariaSnapshot;
            if (Array.isArray(parsed.firstPartyNetworkErrors)) {
              firstPartyNetworkErrors = parsed.firstPartyNetworkErrors;
            }
            if (Array.isArray(parsed.pageErrors)) {
              pageErrors = parsed.pageErrors;
            }
            if (Array.isArray(parsed.consoleErrors)) {
              consoleErrors = parsed.consoleErrors;
            }
            if (parsed.chaosMode) {
              chaosMode = parsed.chaosMode;
            }
          }
        } catch (err) {
          console.error('Failed to parse veriheal-telemetry attachment', err);
        }
      } else if (att.name === 'error-context') {
        errorContext = readAttachmentContent(att);
      }
    }

    const rawBundle: ForensicBundle = {
      testTitle,
      filePath,
      line,
      status,
      errorMessage,
      errorStack,
      ariaSnapshot,
      errorContext,
      firstPartyNetworkErrors,
      pageErrors,
      consoleErrors,
      chaosMode,
      timestamp: Date.now(),
    };

    const redactedBundle = redactForensicBundle(rawBundle);
    const classification = classifyFailure(redactedBundle);

    const report = {
      bundle: redactedBundle,
      classification,
    };

    const validatedReport = ForensicReportSchema.parse(report);

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    const reportFile = path.join(this.outputDir, 'latest-forensics.json');
    fs.writeFileSync(reportFile, JSON.stringify(validatedReport, null, 2), 'utf-8');
  }

  onEnd(_result: FullResult): void {}
}
