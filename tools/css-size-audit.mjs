import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { brotliCompressSync, gzipSync } from "node:zlib";

const STYLESHEET_PATH = "styles/skjaldborg.css";
const RAW_EXPANDED_WARNING_KB = 160;
const RAW_COMPRESSED_WARNING_KB = 120;
const GZIP_WARNING_KB = 25;

const root = process.cwd();
const stylesheet = join(root, STYLESHEET_PATH);

if (!existsSync(stylesheet)) {
  console.warn(`CSS size audit warning: missing ${STYLESHEET_PATH}.`);
  process.exit(0);
}

const css = readFileSync(stylesheet);
const gzip = gzipSync(css);
const brotli = brotliCompressSync(css);
const looksCompressed = !/\n\s{2,}[.#:@\w-]/u.test(css.toString("utf8"));
const rawBudgetKb = looksCompressed ? RAW_COMPRESSED_WARNING_KB : RAW_EXPANDED_WARNING_KB;

const rows = [
  ["raw", css.length],
  ["gzip", gzip.length],
  ["brotli", brotli.length]
];

console.log(`CSS size audit for ${STYLESHEET_PATH}:`);
for (const [label, bytes] of rows) {
  console.log(`- ${label}: ${bytes} bytes (${formatKb(bytes)} KB)`);
}
console.log(`- detected mode: ${looksCompressed ? "compressed/release" : "expanded/dev"}`);

if (css.length > kib(rawBudgetKb)) {
  console.warn(`CSS size audit warning: raw CSS exceeds ${rawBudgetKb} KB budget.`);
}
if (gzip.length > kib(GZIP_WARNING_KB)) {
  console.warn(`CSS size audit warning: gzip CSS exceeds ${GZIP_WARNING_KB} KB budget.`);
}

function kib(kb) {
  return kb * 1024;
}

function formatKb(bytes) {
  return (bytes / 1024).toFixed(2);
}
