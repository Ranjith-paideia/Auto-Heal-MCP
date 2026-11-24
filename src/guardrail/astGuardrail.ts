import ts from 'typescript';
import type { AstGuardrailResult } from '../schemas/healing.js';

/**
 * Validates that an automated patch does not degrade test integrity, syntax, or structure.
 */
export function validateAstPatch(
  originalSource: string,
  patchedSource: string,
  fileName = 'patch.ts'
): AstGuardrailResult {
  const violations: string[] = [];

  // Helper to extract assertions from AST
  const countAssertions = (sourceFile: ts.SourceFile): Map<string, number> => {
    const assertions = new Map<string, number>();

    const startsWithExpect = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node)) {
        return node.text === 'expect';
      }
      if (ts.isCallExpression(node)) {
        return startsWithExpect(node.expression);
      }
      if (ts.isPropertyAccessExpression(node)) {
        return startsWithExpect(node.expression);
      }
      return false;
    };

    const isOuterAssertionCall = (node: ts.CallExpression): boolean => {
      if (!startsWithExpect(node)) {
        return false;
      }
      // Outermost means the node is not the expression of an enclosing ts.PropertyAccessExpression that is itself called
      const parent = node.parent;
      if (parent && ts.isPropertyAccessExpression(parent)) {
        const grandParent = parent.parent;
        if (grandParent && ts.isCallExpression(grandParent) && grandParent.expression === parent) {
          return false;
        }
      }
      return true;
    };

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isOuterAssertionCall(node)) {
        const normalized = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
        assertions.set(normalized, (assertions.get(normalized) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return assertions;
  };

  const originalAst = ts.createSourceFile(
    fileName,
    originalSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  const assertionsBeforeMap = countAssertions(originalAst);
  let assertionsBefore = 0;
  for (const count of assertionsBeforeMap.values()) {
    assertionsBefore += count;
  }

  // 1. Zero Syntax Errors:
  const transpileResult = ts.transpileModule(patchedSource, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
    },
  });

  const syntaxErrors = (transpileResult.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error
  );

  if (syntaxErrors.length > 0) {
    const errorDetails = syntaxErrors
      .map((d) => (typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText))
      .join('; ');
    violations.push(`Syntax error in patched source: ${errorDetails}`);
    return {
      passed: false,
      violations,
      assertionsBefore,
      assertionsAfter: 0,
    };
  }

  const patchedAst = ts.createSourceFile(
    fileName,
    patchedSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );

  // 2. Strict Assertion Preservation (Multiset Count):
  const assertionsAfterMap = countAssertions(patchedAst);
  let assertionsAfter = 0;
  for (const count of assertionsAfterMap.values()) {
    assertionsAfter += count;
  }

  if (assertionsAfter < assertionsBefore) {
    violations.push(
      `Total assertion count reduced: had ${assertionsBefore}, now ${assertionsAfter}`
    );
  }

  for (const [assertionText, beforeCount] of assertionsBeforeMap.entries()) {
    const afterCount = assertionsAfterMap.get(assertionText) ?? 0;
    if (afterCount < beforeCount) {
      violations.push(
        `Assertion mutated or deleted: "${assertionText}" (count reduced from ${beforeCount} to ${afterCount})`
      );
    }
  }

  // 3. No Test Weakening or Compiler Suppression:
  const countTestWeakening = (source: string, ast: ts.SourceFile): { weakening: number; suppressions: number } => {
    let weakening = 0;

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const text = node.expression.getText(ast);
        if (text === 'test.skip' || text === 'test.fixme' || text.endsWith('.skip')) {
          weakening++;
        }
      } else if (ts.isPropertyAccessExpression(node)) {
        const propText = node.getText(ast);
        if (propText === 'test.skip' || propText === 'test.fixme') {
          weakening++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    // Comments check matching @ts-ignore, @ts-nocheck, or eslint-disable
    let suppressions = 0;
    const commentRegex = /\/\*[\s\S]*?\*\/|\/\/.*/g;
    const comments = source.match(commentRegex) ?? [];
    for (const comment of comments) {
      if (/@ts-ignore|@ts-nocheck|eslint-disable/.test(comment)) {
        suppressions++;
      }
    }

    return { weakening, suppressions };
  };

  const originalCounts = countTestWeakening(originalSource, originalAst);
  const patchedCounts = countTestWeakening(patchedSource, patchedAst);

  if (patchedCounts.weakening > originalCounts.weakening) {
    violations.push('Test weakening introduced (e.g. test.skip, test.fixme, or .skip())');
  }
  if (patchedCounts.suppressions > originalCounts.suppressions) {
    violations.push('Compiler suppression comment introduced (@ts-ignore, @ts-nocheck, or eslint-disable)');
  }

  // 4. No Brittle Locators Introduced:
  // Reject newly added string starting with xpath= or //
  const getXpathLiterals = (ast: ts.SourceFile): number => {
    let count = 0;
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text;
        if (text.startsWith('xpath=') || text.startsWith('//')) {
          count++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return count;
  };

  const originalXpath = getXpathLiterals(originalAst);
  const patchedXpath = getXpathLiterals(patchedAst);
  if (patchedXpath > originalXpath) {
    violations.push('Brittle XPath locator introduced (starts with "xpath=" or "//")');
  }

  // Reject if the total count of .nth(, .first(), or .last() calls increased in patchedSource
  const countPositionalCalls = (ast: ts.SourceFile): number => {
    let count = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const methodName = node.expression.name.text;
        if (methodName === 'nth' || methodName === 'first' || methodName === 'last') {
          count++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return count;
  };

  const originalPositional = countPositionalCalls(originalAst);
  const patchedPositional = countPositionalCalls(patchedAst);
  if (patchedPositional > originalPositional) {
    violations.push(
      `Brittle positional locator introduced: .nth(), .first(), or .last() count increased from ${originalPositional} to ${patchedPositional}`
    );
  }

  // 5. Structural Preservation:
  const getStructuralSymbols = (ast: ts.SourceFile): Set<string> => {
    const symbols = new Set<string>();

    const visit = (node: ts.Node) => {
      // Top-level exported symbols
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      const isExported =
        modifiers?.some((m: ts.ModifierLike) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

      if (isExported) {
        if (ts.isClassDeclaration(node) && node.name) {
          symbols.add(`class:${node.name.text}`);
        } else if (ts.isFunctionDeclaration(node) && node.name) {
          symbols.add(`func:${node.name.text}`);
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name)) {
              symbols.add(`var:${decl.name.text}`);
            }
          }
        }
      }

      // Class members: methods, properties, getters, setters
      if (ts.isClassDeclaration(node)) {
        const className = node.name?.text ?? 'AnonymousClass';
        for (const member of node.members) {
          if (member.name && ts.isIdentifier(member.name)) {
            const memberName = member.name.text;
            if (ts.isMethodDeclaration(member)) {
              symbols.add(`method:${className}.${memberName}`);
            } else if (ts.isPropertyDeclaration(member)) {
              symbols.add(`prop:${className}.${memberName}`);
            } else if (ts.isGetAccessorDeclaration(member)) {
              symbols.add(`get:${className}.${memberName}`);
            } else if (ts.isSetAccessorDeclaration(member)) {
              symbols.add(`set:${className}.${memberName}`);
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(ast);
    return symbols;
  };

  const originalSymbols = getStructuralSymbols(originalAst);
  const patchedSymbols = getStructuralSymbols(patchedAst);

  for (const sym of originalSymbols) {
    if (!patchedSymbols.has(sym)) {
      violations.push(`Structural symbol removed: ${sym}`);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    assertionsBefore,
    assertionsAfter,
  };
}
