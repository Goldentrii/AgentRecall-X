// packages/mcp-server/test/lib/fence-ast.mjs
//
// P1 fence-completeness harness (TOW2-388) — generic TypeScript-source
// surface extractors, shared by the CLI and SDK discovery modules.
//
// Why AST instead of plain grep: a naive `grep 'case "'` would also match
// string literals inside comments/docstrings, and can't isolate "the text
// belonging to THIS case" from "the text belonging to the NEXT case" for
// the fenced-source check below. Parsing gives us exact node boundaries.
//
// Kept deliberately small and dependency-light: only the `typescript`
// package (already a devDependency of every workspace, used by `tsc`
// itself) is used, imported dynamically so this file works whether it's
// invoked as ESM from node's test runner.

import * as fs from "node:fs";

/** Lazily import the TypeScript compiler API (avoids a static ESM/CJS interop footgun). */
async function ts() {
  return (await import("typescript")).default ?? (await import("typescript"));
}

/**
 * Parse a TS/JS source file and return { sourceFile, text, ts }.
 * Throws if the file does not exist — callers should decide whether a
 * missing file is a hard failure (real source) or an expected fixture path.
 */
export async function parseFile(filePath) {
  const tsLib = await ts();
  const text = fs.readFileSync(filePath, "utf-8");
  const sourceFile = tsLib.createSourceFile(filePath, text, tsLib.ScriptTarget.Latest, true, tsLib.ScriptKind.TS);
  return { sourceFile, text, tsLib };
}

/**
 * Does `text` contain a call that this codebase's convention recognizes as
 * "this block was fenced"? Always accepts a direct `fenceMemory(...)` call
 * (the choke-point primitive itself). `trustedWrappers` names additional
 * per-channel helper functions whose OWN body is verified ONCE, separately
 * (see fence-completeness.test.mjs's "wrapper self-check" tests), to
 * actually call fenceMemory internally — e.g. the CLI's `outputFenced()`
 * or the SDK's `withFenced()`/`fenceString()`/`fenceRoomMeta()`. Trusting
 * call sites that use a SELF-VERIFIED wrapper is sound, not a "wrapper
 * that silently doesn't fence" loophole — that loophole is exactly what
 * the wrapper self-check test closes.
 * Word-boundary matched so `someFenceMemoryLookalike(` doesn't false-positive
 * and `.fenceMemory(`/`core.fenceMemory(` (namespaced call sites) still match.
 */
export function textCallsFence(text, trustedWrappers = ["outputFenced"]) {
  const names = ["fenceMemory", ...trustedWrappers];
  return names.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
}

/**
 * Walk `node` and all descendants, yielding every node (simple recursive
 * generator — small files, no need for anything fancier).
 */
function* walk(node, tsLib) {
  yield node;
  const children = [];
  // IMPORTANT: forEachChild treats a truthy callback return as "stop
  // traversing, return this value" (visitor short-circuit semantics, same
  // family as Array#find). `(c) => children.push(c)` returns the new
  // array length — truthy from the first push onward — which silently
  // stops traversal after ONE child at every level. Block body avoids
  // this (implicit `undefined` return keeps forEachChild visiting all
  // children). Use `tsLib.forEachChild(node, cb)` (the free function),
  // not `node.forEachChild(cb)` — the same short-circuit trap applies to
  // both call forms, but the free function is the documented public API.
  tsLib.forEachChild(node, (c) => { children.push(c); });
  for (const c of children) yield* walk(c, tsLib);
}

/**
 * Extract top-level `switch (<discriminantName>) { case "a": ...; case "b": ... }`
 * cases from a source file. Returns an array of
 *   { id: string, text: string, start: number, end: number }
 * where `text` is the exact source slice of that CaseClause (used by the
 * completeness test to check whether `fenceMemory`/`outputFenced` appears
 * inside it). Only the FIRST switch statement whose discriminant identifier
 * matches `discriminantName` is used (this file has exactly one dispatch
 * switch on `command`, verified in the completeness test itself so a
 * refactor that removes/renames it fails loudly rather than silently
 * discovering zero surfaces).
 */
export async function extractSwitchCases(filePath, discriminantName) {
  const { sourceFile, text, tsLib } = await parseFile(filePath);
  let target = null;
  for (const node of walk(sourceFile, tsLib)) {
    if (tsLib.isSwitchStatement(node) && tsLib.isIdentifier(node.expression) && node.expression.text === discriminantName) {
      target = node;
      break;
    }
  }
  if (!target) return { cases: [], found: false };
  const cases = [];
  for (const clause of target.caseBlock.clauses) {
    if (tsLib.isCaseClause(clause) && tsLib.isStringLiteralLike(clause.expression)) {
      cases.push({
        id: clause.expression.text,
        text: text.slice(clause.pos, clause.end),
        start: clause.pos,
        end: clause.end,
      });
    }
    // `case "insight": case "recall": { ... }` — a fallthrough clause with
    // an empty statement list shares the NEXT clause's body. Handle by
    // looking ahead once the whole clause list has been walked (see below).
  }
  // Fallthrough fix-up: any clause with an empty `statements` list (a bare
  // `case "x":` immediately followed by another case) shares the body of
  // the next clause that DOES have statements — reuse that text so the
  // fenced-check still inspects real code, not an empty slice.
  const clauseNodes = target.caseBlock.clauses.filter((c) => tsLib.isCaseClause(c) && tsLib.isStringLiteralLike(c.expression));
  for (let i = 0; i < clauseNodes.length; i++) {
    if (clauseNodes[i].statements.length === 0) {
      for (let j = i + 1; j < clauseNodes.length; j++) {
        if (clauseNodes[j].statements.length > 0) {
          cases[i] = { ...cases[i], text: text.slice(clauseNodes[j].pos, clauseNodes[j].end) };
          break;
        }
      }
    }
  }
  return { cases, found: true };
}

/**
 * Best-effort SECOND-LEVEL sub-action discovery within an already-isolated
 * top-level case's text. This codebase's sub-dispatch convention (verified
 * across `packages/cli/src/index.ts`) is either:
 *   - `const sub = rest[0]; switch (sub) { case "x": ... }`, or
 *   - `const sub = rest[0]; if (sub === "x") { ... } else if (sub === "y") { ... }`
 * Rather than re-parsing per-command AST shapes (switch vs if/else-if are
 * structurally different node types), this is intentionally a TEXT-WINDOW
 * heuristic: find every `sub === "literal"` / `case "literal":` occurrence
 * (in source order) and take the text between it and the START of the NEXT
 * such occurrence (or the end of the case) as that sub-action's body for
 * the fenced-check. This is a deliberate, documented approximation — see
 * fence-completeness.test.mjs's header comment for the CHALLENGE writeup —
 * not a claim of full AST precision at this level.
 */
export function extractSubActions(caseText, topId) {
  const re = /\bsub\s*===\s*"([a-zA-Z0-9_.-]+)"|case\s*"([a-zA-Z0-9_.-]+)"\s*:/g;
  const rawMatches = [];
  let m;
  while ((m = re.exec(caseText)) !== null) {
    rawMatches.push({ literal: m[1] ?? m[2], index: m.index });
  }
  // The case text SLICE begins at (and includes) the enclosing top-level
  // clause's own `case "<topId>":` header token, often preceded by a
  // leading banner comment (this file's `// --- ar <cmd> --- ...` style —
  // comments attach as LEADING TRIVIA of the clause, so `clause.pos`
  // starts before them). That header always matches the SAME regex (it's
  // a `case "literal":` too) and would otherwise be misread as a
  // same-named, self-referential "sub-action" — or, for a fallthrough
  // clause whose empty body was fixed up to reuse the NEXT sibling's text
  // (e.g. `case "insight": case "recall": {...}`), a MISMATCHED-literal
  // phantom, since the reused text's own header names the sibling, not
  // `topId`. Detect it via EITHER signal (either is sufficient):
  //   (a) POSITIONAL — nothing but whitespace/comments precedes the first
  //       match. A genuine nested dispatch can never be the very first
  //       token of a case body (there is always at least
  //       `const sub = rest[0];` or similar setup first).
  //   (b) LITERAL — the first match's literal equals `topId` itself (the
  //       comment-stripped-prefix check in (a) can still see non-empty
  //       leftover text from an unusually-formatted banner; this is the
  //       belt-and-suspenders fallback for exactly that case).
  const stripComments = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const isOwnHeader =
    rawMatches.length > 0 &&
    (stripComments(caseText.slice(0, rawMatches[0].index)).trim() === "" || rawMatches[0].literal === topId);
  const matches = isOwnHeader ? rawMatches.slice(1) : rawMatches;
  if (matches.length === 0) return [];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const startIdx = matches[i].index;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : caseText.length;
    out.push({ id: `${topId}.${matches[i].literal}`, text: caseText.slice(startIdx, endIdx) });
  }
  return out;
}

/**
 * Extract public method members of `class <className>` in a source file.
 * Returns { id: "ClassName.methodName", text }. Skips the constructor and
 * anything explicitly marked `private`/`protected`. Getters (`get x()`) are
 * returned too (id "ClassName.x"), separately from any nested object-literal
 * methods they return (see extractGetterSubMethods for those).
 */
export async function extractClassMethods(filePath, className) {
  const { sourceFile, text, tsLib } = await parseFile(filePath);
  let klass = null;
  for (const node of walk(sourceFile, tsLib)) {
    if (tsLib.isClassDeclaration(node) && node.name?.text === className) {
      klass = node;
      break;
    }
  }
  if (!klass) return { methods: [], getters: [], found: false };
  const methods = [];
  const getters = [];
  for (const member of klass.members) {
    const isPrivateOrProtected = (member.modifiers ?? []).some(
      (mod) => mod.kind === tsLib.SyntaxKind.PrivateKeyword || mod.kind === tsLib.SyntaxKind.ProtectedKeyword,
    );
    if (isPrivateOrProtected) continue;
    if (tsLib.isConstructorDeclaration(member)) continue;
    if (tsLib.isMethodDeclaration(member) && member.name && tsLib.isIdentifier(member.name)) {
      methods.push({ id: `${className}.${member.name.text}`, text: text.slice(member.pos, member.end) });
    } else if (tsLib.isGetAccessorDeclaration(member) && member.name && tsLib.isIdentifier(member.name)) {
      getters.push({ name: member.name.text, node: member, text: text.slice(member.pos, member.end) });
    }
  }
  return { methods, getters, found: true, text, tsLib };
}

/**
 * Find a top-level (module-scope) `function <name>(...) { ... }` declaration
 * and return its full source text, or null if not found. AST-based rather
 * than regex: a regex anchored on `function name(` breaks the moment the
 * function has generic type parameters (`function withFenced<T>(...)`) or
 * an inline object-literal return-type annotation containing its OWN `{`
 * before the real body brace (`function withFenced(...): T & { x: string } {`)
 * — both true of this codebase's actual wrapper helpers, and exactly the
 * kind of "looked reasonable, silently matched the wrong brace" bug this
 * harness exists to not reproduce.
 */
export async function extractTopLevelFunction(filePath, functionName) {
  const { sourceFile, text, tsLib } = await parseFile(filePath);
  for (const node of walk(sourceFile, tsLib)) {
    if (tsLib.isFunctionDeclaration(node) && node.name?.text === functionName) {
      return text.slice(node.pos, node.end);
    }
  }
  return null;
}

/**
 * Given a getter's AST node (from extractClassMethods's `getters` array)
 * whose body `return`s an object literal of method-like properties (this
 * codebase's `get palace()` / `get graph()` convention — see
 * agent-recall.ts), extract each property as its own surface:
 *   id = "ClassName.getterName.propName"
 * Handles both `prop: (...) => expr` (ArrowFunction) and shorthand
 * `{ readGraph, addEdge }` (references to top-level imported functions —
 * these have no local body text to scan for fenceMemory, so the completeness
 * test resolves them against the IMPORTED function's OWN source instead;
 * see fence-manifest.mjs's `file` override for those entries).
 */
export function extractGetterSubMethods(getterNode, className, getterName, text, tsLib) {
  const out = [];
  let objLiteral = null;
  for (const stmt of getterNode.body?.statements ?? []) {
    if (tsLib.isReturnStatement(stmt) && stmt.expression && tsLib.isObjectLiteralExpression(stmt.expression)) {
      objLiteral = stmt.expression;
      break;
    }
  }
  if (!objLiteral) return out;
  for (const prop of objLiteral.properties) {
    if (tsLib.isPropertyAssignment(prop) && prop.name && tsLib.isIdentifier(prop.name)) {
      out.push({
        id: `${className}.${getterName}.${prop.name.text}`,
        text: text.slice(prop.pos, prop.end),
        isShorthandRef: tsLib.isIdentifier(prop.initializer),
        refName: tsLib.isIdentifier(prop.initializer) ? prop.initializer.text : null,
      });
    } else if (tsLib.isShorthandPropertyAssignment(prop) && prop.name) {
      out.push({
        id: `${className}.${getterName}.${prop.name.text}`,
        text: text.slice(prop.pos, prop.end),
        isShorthandRef: true,
        refName: prop.name.text,
      });
    }
  }
  return out;
}
