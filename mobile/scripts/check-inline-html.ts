#!/usr/bin/env bun
// Parse the inline <script> body emitted by `terminal-html.ts` and fail
// the build if it doesn't tokenize as valid JavaScript.
//
// The HTML is a TS template literal, so escape sequences like `\n` get
// expanded at template-build time; a single missing backslash inside a
// string literal there breaks the entire <script> tag and leaves Android
// WebView staring at a non-running IIFE. v0.0.7 through v0.0.21 shipped
// exactly that bug — this guard exists so it can't recur silently.

import { parse } from "@babel/parser";

import { terminalHtml } from "../src/lib/terminal-html";

const match = terminalHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!match) {
  console.error("check-inline-html: could not locate inline <script> block in terminalHtml");
  process.exit(1);
}

try {
  parse(match[1], { sourceType: "script" });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`check-inline-html: terminalHtml inline <script> failed to parse: ${msg}`);
  process.exit(1);
}
