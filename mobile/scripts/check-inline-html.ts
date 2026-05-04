#!/usr/bin/env bun
// Parse the inline <script> bodies emitted by `terminal-html.ts` and
// `file-viewer-html.ts` and fail the build if either doesn't tokenize as
// valid JavaScript.
//
// The HTML strings are TS template literals, so escape sequences like `\n`
// get expanded at template-build time; a single missing backslash inside a
// string literal there breaks the entire <script> tag and leaves Android
// WebView staring at a non-running IIFE. v0.0.7 through v0.0.21 shipped
// exactly that bug — this guard exists so it can't recur silently.

import { parse } from "@babel/parser";

import { fileViewerHtml } from "../src/lib/file-viewer-html";
import { terminalHtml } from "../src/lib/terminal-html";

const cases: { name: string; html: string }[] = [
  { name: "terminalHtml", html: terminalHtml },
  { name: "fileViewerHtml", html: fileViewerHtml },
];

let failed = false;
for (const { name, html } of cases) {
  // Validate every <script>…</script> block whose body isn't the empty
  // src-only form. The viewer pulls highlight.js with `<script src=…>` and
  // hosts its own IIFE inline; we want to parse the IIFE.
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((body) => body.trim().length > 0);
  if (blocks.length === 0) {
    console.error(`check-inline-html: no inline <script> body found in ${name}`);
    failed = true;
    continue;
  }
  for (const [i, body] of blocks.entries()) {
    try {
      parse(body, { sourceType: "script" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`check-inline-html: ${name} block #${i} failed to parse: ${msg}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
