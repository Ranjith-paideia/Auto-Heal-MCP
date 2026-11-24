import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ForensicReportSchema, ForensicBundleSchema } from '../schemas/forensics.js';
import { classifyFailure } from '../core/classifier.js';
import { validateAstPatch } from '../guardrail/astGuardrail.js';
import { verifyCandidatePatch } from '../healer/patchVerifier.js';

// Lock workspace root at startup (do NOT accept arbitrary workspaceRoot paths from tool inputs)
const WORKSPACE_ROOT = path.resolve(process.env.AUTO_HEAL_WORKSPACE_ROOT ?? process.cwd());

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'auto-heal-mcp',
    version: '1.0.0',
  });

  // Tool 1: get_latest_forensics
  server.tool(
    'get_latest_forensics',
    'Read and validate the latest redacted Playwright failure forensic bundle and classification from .veriheal/latest-forensics.json.',
    {},
    async () => {
      try {
        const reportPath = path.resolve(WORKSPACE_ROOT, '.veriheal', 'latest-forensics.json');
        if (!fs.existsSync(reportPath)) {
          const payload = {
            found: false,
            message:
              'No forensic report found at .veriheal/latest-forensics.json. Run a failing Playwright test first.',
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          };
        }

        const raw = fs.readFileSync(reportPath, 'utf-8');
        const report = ForensicReportSchema.parse(JSON.parse(raw));
        const payload = {
          found: true,
          report,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err.message || String(err) }, null, 2),
            },
          ],
        };
      }
    }
  );

  // Tool 2: classify_failure
  server.tool(
    'classify_failure',
    'Run the deterministic policy classifier (APP_BUG vs ASSERTION_MISMATCH vs LOCATOR_DRIFT) on a forensic bundle.',
    {
      bundle: ForensicBundleSchema,
    },
    async (args) => {
      try {
        const verdict = classifyFailure(args.bundle);
        return {
          content: [{ type: 'text', text: JSON.stringify(verdict, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err.message || String(err) }, null, 2),
            },
          ],
        };
      }
    }
  );

  // Tool 3: validate_ast_patch
  server.tool(
    'validate_ast_patch',
    'Validate a candidate TypeScript patch using the TypeScript Compiler API AST guardrail (syntax, assertion preservation, no test skipping, no XPath/positional locators, structural preservation).',
    {
      originalSource: z.string(),
      patchedSource: z.string(),
      fileName: z.string().optional(),
    },
    async (args) => {
      try {
        const result = validateAstPatch(
          args.originalSource,
          args.patchedSource,
          args.fileName ?? 'patch.ts'
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err.message || String(err) }, null, 2),
            },
          ],
        };
      }
    }
  );

  // Tool 4: verify_patch_blast_radius
  server.tool(
    'verify_patch_blast_radius',
    'Safely verify a candidate single-snippet locator patch against all dependent Playwright specs using AST validation and guaranteed in-memory file restoration.',
    {
      targetFile: z.string(),
      oldSnippet: z.string(),
      newSnippet: z.string(),
      chaosMode: z.string().default('none'),
      emitPatch: z.boolean().default(false),
    },
    async (args) => {
      try {
        const result = verifyCandidatePatch({
          targetFile: args.targetFile,
          oldSnippet: args.oldSnippet,
          newSnippet: args.newSnippet,
          chaosMode: args.chaosMode,
          workspaceRoot: WORKSPACE_ROOT,
          emitPatch: args.emitPatch,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: err.message || String(err) }, null, 2),
            },
          ],
        };
      }
    }
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[auto-heal-mcp] Deterministic MCP server running on stdio');
}

// Wrap top-level main
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('[auto-heal-mcp] Fatal error:', err);
    process.exit(1);
  });
}

function fileURLToPath(url: string): string {
  return new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}
