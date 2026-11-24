import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ForensicBundle } from '../schemas/forensics.js';
import type { PatchProposal } from '../schemas/healing.js';

export interface FailingLocatorContext {
  targetFile: string;
  failingLine: string;
  receiverPrefix: string;
}

/**
 * Normalizes quotes and whitespace to facilitate resilient string matching between
 * Playwright's reported error log and TypeScript source code.
 */
function normalizeForComparison(str: string): string {
  return str
    .replace(/["'`]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts candidate locator substrings or patterns from Playwright error messages.
 */
function extractLocatorPatterns(errorMessage: string): string[] {
  const patterns: string[] = [];

  // 1. locator('...') or locator("...")
  const locatorMatches = errorMessage.matchAll(/locator\((['"`])([\s\S]*?)\1\)/g);
  for (const m of locatorMatches) {
    patterns.push(`locator(${JSON.stringify(m[2])})`);
    patterns.push(m[0]);
    patterns.push(m[2]); // raw selector inside locator(...)
  }

  // 2. getByRole(...), getByTestId(...), getByLabel(...), getByPlaceholder(...), getByText(...)
  const getByMatches = errorMessage.matchAll(/(getBy[A-Za-z]+)\(([\s\S]*?)\)/g);
  for (const m of getByMatches) {
    patterns.push(m[0]);
  }

  // 3. Look for "waiting for locator('...')" or "waiting for getBy..."
  const waitingMatches = errorMessage.matchAll(/waiting for ([\s\S]+?)(?:\n|$)/g);
  for (const m of waitingMatches) {
    patterns.push(m[1].trim());
  }

  return patterns;
}

/**
 * Resolves the exact workspace source file and line where the failing Playwright locator is defined.
 */
export function resolveFailingLocatorContext(
  bundle: ForensicBundle,
  workspaceRoot: string
): FailingLocatorContext | null {
  const patterns = extractLocatorPatterns(bundle.errorMessage);
  if (patterns.length === 0) {
    return null;
  }

  // 2. Build an ordered list of candidate .ts files:
  // First: all .ts files under benchmark/pages/
  const candidateFiles: string[] = [];
  const pagesDir = path.resolve(workspaceRoot, 'benchmark/pages');
  if (fs.existsSync(pagesDir)) {
    const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      candidateFiles.push(path.join(pagesDir, f));
    }
  }

  // Second: any workspace .ts files referenced in bundle.errorStack (excluding node_modules)
  const stackLines = bundle.errorStack.split('\n');
  for (const sLine of stackLines) {
    const match = sLine.match(/(?:at\s+|[\s(])([A-Za-z]:\\[^:()]+\.ts|\/[^:()]+\.ts|\.[\\/][^:()]+\.ts)(?::(\d+))?/);
    if (match) {
      const filePath = path.resolve(workspaceRoot, match[1]);
      if (
        fs.existsSync(filePath) &&
        !filePath.includes('node_modules') &&
        !candidateFiles.includes(filePath)
      ) {
        candidateFiles.push(filePath);
      }
    }
  }

  // Also include bundle.filePath if not already present
  if (bundle.filePath) {
    const bp = path.resolve(workspaceRoot, bundle.filePath);
    if (fs.existsSync(bp) && !candidateFiles.includes(bp)) {
      candidateFiles.push(bp);
    }
  }

  // 3. Search each candidate file line-by-line using quote-normalized matching
  for (const absFile of candidateFiles) {
    const content = fs.readFileSync(absFile, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const normLine = normalizeForComparison(line);

      for (const pattern of patterns) {
        const normPattern = normalizeForComparison(pattern);
        if (normPattern.length > 3 && normLine.includes(normPattern)) {
          // Detect receiverPrefix
          let receiverPrefix = 'this.page.';
          if (line.includes('this.page.')) {
            receiverPrefix = 'this.page.';
          } else if (line.includes('page.')) {
            receiverPrefix = 'page.';
          }

          const relativePath = path
            .relative(workspaceRoot, absFile)
            .replace(/\\/g, '/');

          return {
            targetFile: relativePath,
            failingLine: line,
            receiverPrefix,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Minimal interface for interactive ARIA node extracted from ariaSnapshot.
 */
interface AriaNode {
  role: string;
  name: string;
}

/**
 * Parses interactive ARIA nodes from ariaSnapshot.
 */
function parseAriaNodes(ariaSnapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  // Example lines:
  // - button "Apply Promo"
  // - textbox "Promo Code"
  // - checkbox "Express Shipping"
  // - button "Complete Order"
  const lines = ariaSnapshot.split('\n');
  const regex = /-\s*(button|textbox|checkbox|link|combobox)\s*"([^"]+)"/i;

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      nodes.push({
        role: match[1].toLowerCase(),
        name: match[2].trim(),
      });
    }
  }

  return nodes;
}

const OllamaResponseSchema = z.object({
  canHeal: z.boolean(),
  newSnippet: z.string(),
  reasoning: z.string(),
});

/**
 * Proposes a locator patch using live Ollama or deterministic ARIA semantic fallback.
 * Strictly adheres to rule: NEVER read or branch on bundle.chaosMode!
 */
export async function proposeLocatorPatch(
  bundle: ForensicBundle,
  workspaceRoot: string
): Promise<PatchProposal> {
  const context = resolveFailingLocatorContext(bundle, workspaceRoot);
  if (!context) {
    return {
      canHeal: false,
      targetFile: '',
      oldSnippet: '',
      newSnippet: '',
      reasoning: 'Could not resolve failing locator line in workspace source files.',
      mode: 'deterministic-fallback',
    };
  }

  const { targetFile, failingLine, receiverPrefix } = context;

  // 2. Read configuration from environment variables
  const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
  const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';

  let canUseOllama = false;

  // 3. Health & Model Availability Check
  try {
    const modelsRes = await fetch(`${ollamaBaseUrl}/models`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });

    if (modelsRes.ok) {
      const data = (await modelsRes.json()) as { data?: Array<{ id: string }> };
      if (Array.isArray(data?.data)) {
        const hasModel = data.data.some(
          (m) =>
            m.id === ollamaModel ||
            m.id.startsWith(ollamaModel + ':') ||
            m.id.split(':')[0] === ollamaModel.split(':')[0]
        );
        if (hasModel) {
          canUseOllama = true;
        }
      }
    }
  } catch {
    // Ollama not running or unreachable
    canUseOllama = false;
  }

  // 4. Live Ollama Single-Shot Path
  if (canUseOllama) {
    try {
      const prompt = `You are an automated Playwright test repair agent.
The following Playwright test locator failed.

FAILING SOURCE LINE:
\`\`\`typescript
${failingLine}
\`\`\`

RECEIVER PREFIX:
${receiverPrefix}

PLAYWRIGHT ERROR MESSAGE:
${bundle.errorMessage.slice(0, 800)}

PAGE ACCESSIBILITY TREE (ARIA SNAPSHOT):
\`\`\`yaml
${bundle.ariaSnapshot.slice(0, 3000)}
\`\`\`

INSTRUCTIONS:
- You must return ONLY a JSON object with keys:
  {
    "canHeal": boolean,
    "newSnippet": string,
    "reasoning": string
  }
- If healing is safe, "newSnippet" MUST be the complete single replacement line preserving the exact leading indentation, exact LHS assignment, exact receiver ('${receiverPrefix}'), and trailing semicolon of the failing line.
- Update ONLY the Playwright locator call to a resilient semantic locator (getByRole, getByLabel, getByPlaceholder, or getByTestId).
- CRITICAL SAFETY RULE: Never map a payment/submit/checkout control onto a Cancel, Back, Close, or Delete button. If the intended control is missing from ariaSnapshot, you MUST return "canHeal": false and "newSnippet": "".`;

      const response = await fetch(`${ollamaBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You output only strict JSON without explanations or markdown formatting outside JSON.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      if (response.ok) {
        const completion = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const rawContent = completion.choices?.[0]?.message?.content ?? '';
        const cleaned = rawContent
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();

        const parsed = OllamaResponseSchema.safeParse(JSON.parse(cleaned));
        if (parsed.success) {
          let { canHeal, newSnippet, reasoning } = parsed.data;
          if (canHeal && newSnippet && newSnippet.trim() !== failingLine.trim()) {
            // Guarantee leading whitespace of failingLine is preserved
            const leadingSpaces = failingLine.match(/^\s*/)?.[0] ?? '';
            if (!newSnippet.startsWith(leadingSpaces)) {
              newSnippet = leadingSpaces + newSnippet.trimStart();
            }
            if (!newSnippet.trimEnd().endsWith(';')) {
              newSnippet = newSnippet.trimEnd() + ';';
            }

            return {
              canHeal: true,
              targetFile,
              oldSnippet: failingLine,
              newSnippet,
              reasoning: `Ollama (${ollamaModel}): ${reasoning}`,
              mode: 'ollama-live',
            };
          }
        }
      }
    } catch (err) {
      console.warn(`[Auto-Heal-MCP] Ollama live heal failed or timed out. Falling back to deterministic ARIA matcher. Reason:`, err);
    }
  }

  // 5. Deterministic ARIA Semantic Fallback
  const ariaNodes = parseAriaNodes(bundle.ariaSnapshot);
  const failingLower = (failingLine + ' ' + bundle.errorMessage).toLowerCase();

  // Helper to construct replacement line
  const buildReplacement = (newLocatorCall: string): string => {
    // Preserve leading whitespace and LHS up to the locator call
    // e.g. "    this.promoInput = page.locator('#promo-input');"
    // ->   "    this.promoInput = page.getByRole('textbox', { name: 'Promo Code' });"
    const match = failingLine.match(/^(\s*(?:(?:readonly\s+)?[\w$]+\s*=\s*)?)(.*?);?\s*$/);
    if (!match) {
      return failingLine;
    }
    const prefix = match[1];
    // Find where receiver occurs (e.g. this.page. or page.)
    const receiverIndex = failingLine.indexOf(receiverPrefix);
    if (receiverIndex !== -1) {
      const lhsWithReceiver = failingLine.substring(0, receiverIndex + receiverPrefix.length);
      return `${lhsWithReceiver}${newLocatorCall};`;
    }
    return `${prefix}${receiverPrefix}${newLocatorCall};`;
  };

  // Rule A: Promo / coupon input
  if (failingLower.includes('promo') || failingLower.includes('coupon')) {
    if (
      failingLower.includes('input') ||
      failingLower.includes('textbox') ||
      failingLower.includes('placeholder') ||
      failingLower.includes('field')
    ) {
      const promoNode = ariaNodes.find(
        (n) => n.role === 'textbox' && /promo|coupon|discount/i.test(n.name)
      );
      if (promoNode) {
        return {
          canHeal: true,
          targetFile,
          oldSnippet: failingLine,
          newSnippet: buildReplacement(`getByRole('textbox', { name: '${promoNode.name}' })`),
          reasoning: `Resolved failing promo input to semantic ARIA textbox "${promoNode.name}".`,
          mode: 'deterministic-fallback',
        };
      }
    }
  }

  // Rule B: Apply promo button
  if (
    failingLower.includes('apply-promo') ||
    failingLower.includes('apply_promo') ||
    (failingLower.includes('apply') && (failingLower.includes('promo') || failingLower.includes('btn') || failingLower.includes('button')))
  ) {
    const applyBtnNode = ariaNodes.find(
      (n) => n.role === 'button' && /apply.*promo|apply.*discount/i.test(n.name)
    );
    if (applyBtnNode) {
      return {
        canHeal: true,
        targetFile,
        oldSnippet: failingLine,
        newSnippet: buildReplacement(`getByRole('button', { name: '${applyBtnNode.name}' })`),
        reasoning: `Resolved failing apply promo button to semantic ARIA button "${applyBtnNode.name}".`,
        mode: 'deterministic-fallback',
      };
    }
  }

  // Rule C: Express shipping checkbox
  if (failingLower.includes('express') || failingLower.includes('shipping')) {
    const checkboxNode = ariaNodes.find(
      (n) => n.role === 'checkbox' && /express|shipping/i.test(n.name)
    );
    if (checkboxNode) {
      return {
        canHeal: true,
        targetFile,
        oldSnippet: failingLine,
        newSnippet: buildReplacement(`getByRole('checkbox', { name: '${checkboxNode.name}' })`),
        reasoning: `Resolved failing shipping checkbox to semantic ARIA checkbox "${checkboxNode.name}".`,
        mode: 'deterministic-fallback',
      };
    }
  }

  // Rule D: Pay / checkout button
  if (failingLower.includes('pay') || failingLower.includes('checkout')) {
    // Pay/checkout button -> match ARIA button whose name matches /pay|complete order|checkout|place order|submit order/i
    // AND explicitly EXCLUDE any button matching /cancel|back|close|delete|remove/i.
    const payNode = ariaNodes.find(
      (n) =>
        n.role === 'button' &&
        /pay|complete order|checkout|place order|submit order/i.test(n.name) &&
        !/cancel|back|close|delete|remove/i.test(n.name)
    );
    if (payNode) {
      return {
        canHeal: true,
        targetFile,
        oldSnippet: failingLine,
        newSnippet: buildReplacement(`getByRole('button', { name: '${payNode.name}' })`),
        reasoning: `Resolved failing payment button to semantic ARIA button "${payNode.name}".`,
        mode: 'deterministic-fallback',
      };
    }
    // If no matching payment button exists in ariaSnapshot, return canHeal: false
    return {
      canHeal: false,
      targetFile,
      oldSnippet: failingLine,
      newSnippet: '',
      reasoning: 'Intended payment/checkout button missing from accessibility tree (destructive Cancel button rejected).',
      mode: 'deterministic-fallback',
    };
  }

  // Generic fallback if any interactive node matches
  return {
    canHeal: false,
    targetFile,
    oldSnippet: failingLine,
    newSnippet: '',
    reasoning: 'No safe deterministic ARIA semantic candidate identified.',
    mode: 'deterministic-fallback',
  };
}
