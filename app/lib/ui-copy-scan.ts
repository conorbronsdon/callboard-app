/**
 * Guard: no internal planning vocabulary in user-visible copy.
 *
 * The app is judged by someone who reads the screens, not the backlog. A screen
 * that says "WS6 — REAL-TIME DASHBOARD" or "Run `npm run seed`" reads as a build
 * log, so those tokens are banned from anything a browser renders.
 *
 * WHY AN AST WALK AND NOT A GREP. A plain grep over the source flags the doc
 * comments that explain the rule, and a grep over the built bundle needs a build
 * to have happened. So this parses each module and collects only the nodes whose
 * text can reach a page: string literals, template-literal text, and JSX text.
 * Comments are dropped by the parser, and import specifiers are skipped — a
 * module path like `~/components/ClientOnly` is not copy.
 *
 * The scanner itself is proved in `ui-copy-scan.test.ts` with a must-fire
 * fixture and a must-not-fire fixture for every rule, so its silence means
 * something.
 */
import ts from "typescript";

export interface BannedToken {
  id: string;
  pattern: RegExp;
  why: string;
}

/**
 * Every entry is a phrase that means something to this repo's authors and
 * nothing to a user. Patterns are deliberately narrow (uppercase `DECISIONS`,
 * `WS` followed by a digit) so ordinary prose — "decisions become real" — is not
 * caught.
 */
export const BANNED_TOKENS: BannedToken[] = [
  { id: "workstream", pattern: /\bWS\d/, why: "workstream number" },
  { id: "plan-doc", pattern: /PLAN\.md/, why: "planning doc" },
  { id: "decisions-doc", pattern: /DECISIONS/, why: "decision log" },
  { id: "reviewer-name", pattern: /\bswyx\b/i, why: "internal reviewer name" },
  { id: "wrangler", pattern: /\bwrangler\b/i, why: "build tooling" },
  { id: "dnd-kit", pattern: /\bdnd-kit\b/i, why: "implementation library" },
  { id: "client-only", pattern: /\bClientOnly\b/, why: "internal component name" },
  { id: "column-name", pattern: /\bstarts_at\b/, why: "database column name" },
  { id: "npm-script", pattern: /\bnpm run\b/, why: "developer command" },
];

export interface CopyNode {
  line: number;
  text: string;
}

export interface CopyHit extends CopyNode {
  token: string;
  why: string;
}

/** True when this string literal is a module path rather than copy. */
function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isImportTypeNode(parent)) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    const callee = parent.expression.getText?.() ?? "";
    if (callee === "require" || callee === "import") return true;
  }
  return false;
}

/**
 * Every piece of text in `source` that can end up on a rendered page.
 * Comments are never included — the parser discards them.
 */
export function extractUserCopy(source: string, fileName = "module.tsx"): CopyNode[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const out: CopyNode[] = [];
  const push = (node: ts.Node, text: string) => {
    if (!text.trim()) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    out.push({ line: line + 1, text });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node)) push(node, node.text);
    } else if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      push(node, node.text);
    } else if (ts.isJsxText(node)) {
      push(node, node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return out;
}

/** Banned tokens found in the user-visible copy of one module. */
export function scanUiCopy(source: string, fileName = "module.tsx"): CopyHit[] {
  const hits: CopyHit[] = [];
  for (const node of extractUserCopy(source, fileName)) {
    for (const token of BANNED_TOKENS) {
      if (token.pattern.test(node.text)) {
        hits.push({ ...node, token: token.id, why: token.why });
      }
    }
  }
  return hits;
}
