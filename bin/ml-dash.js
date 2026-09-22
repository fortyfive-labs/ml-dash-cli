#!/usr/bin/env node
// npm channel entry point. The R2 channel compiles src/index.ts into a
// single-file binary with `bun build --compile` instead; both run the same
// TypeScript, so there is no second implementation to drift.
import "../dist/index.js";
