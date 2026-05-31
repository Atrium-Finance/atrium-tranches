// Parses coverage/lcov.info emitted by `hardhat test --coverage`.
// Hardhat 3.x native coverage emits LINE data only (DA: records); no branch
// or function records. Branch/function thresholds will be added once
// hardhat-coverage gains BRDA/FN support, or once solidity-coverage
// publishes a Hardhat 3-compatible release.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LCOV_PATH = path.join(__dirname, "..", "coverage", "lcov.info");

const THRESHOLDS = {
  lines: 95,
};

if (!fs.existsSync(LCOV_PATH)) {
  console.error("coverage/lcov.info not found — did `hardhat test --coverage` run?");
  process.exit(1);
}

const lcov = fs.readFileSync(LCOV_PATH, "utf8");
const skipFilesRe = /^contracts\/(mocks|interfaces|test)\//;

let totalHit = 0;
let totalFound = 0;

for (const record of lcov.split("end_of_record")) {
  const sfMatch = record.match(/SF:(.+)/);
  if (!sfMatch) continue;
  const file = sfMatch[1].trim();
  if (skipFilesRe.test(file)) continue;

  const lhMatch = record.match(/LH:(\d+)/);
  const lfMatch = record.match(/LF:(\d+)/);
  if (!lhMatch || !lfMatch) continue;

  totalHit += Number(lhMatch[1]);
  totalFound += Number(lfMatch[1]);
}

if (totalFound === 0) {
  console.error("✗ lines: denominator is 0 — coverage instrumentation broken");
  process.exit(1);
}

const actual = (totalHit / totalFound) * 100;
const target = THRESHOLDS.lines;

if (actual < target) {
  console.error(`✗ lines: ${actual.toFixed(2)}% < ${target}% (${totalHit}/${totalFound})`);
  process.exit(1);
}

console.log(`✓ lines: ${actual.toFixed(2)}% >= ${target}% (${totalHit}/${totalFound})`);
