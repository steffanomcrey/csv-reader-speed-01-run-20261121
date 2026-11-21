// SPDX-License-Identifier: MIT
// Driver for the csv-reader-speed-01 entry. It loads every case from the
// input directory, answers each one alone through run() in solve.js, and
// writes the answers, in the cases' order, to the output directory. The
// input and output directories come from MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR when set, and default to /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Keep V8's incremental marking off for the whole run, set before solve.js
// is loaded so the parser runs under the same flag the house baseline uses.
setFlagsFromString('--no-incremental-marking');

/** run(), loaded from the entry's own solve.js module. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Preflight: the case file must parse to an array, or there is nothing to run.
const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];
if (!Array.isArray(cases)) throw new Error('cases.json did not parse to an array');

mkdirSync(outputDir, { recursive: true });
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
