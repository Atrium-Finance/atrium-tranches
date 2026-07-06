// Per-file line-coverage check against coverage/lcov.info.
// Hardhat 3.x native coverage emits LINE data only; this script enforces
// 100% line coverage on the spec-18 critical-path files. Branch coverage
// is unavailable until hardhat-coverage gains BRDA support.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LCOV_PATH = path.join(__dirname, "..", "coverage", "lcov.info");

const CRITICAL_FILES = [
  "contracts/core/Accounting.sol",
  "contracts/core/PrimeCDO.sol",
  "contracts/vaults/Tranche.sol",
  "contracts/strategies/usda/USDAStrategy.sol",
  "contracts/core/cooldown/ERC20Cooldown.sol",
  "contracts/strategies/usda/AaveAprPairProvider.sol",
];

if (!fs.existsSync(LCOV_PATH)) {
  console.error("coverage/lcov.info not found — did `hardhat test --coverage` run?");
  process.exit(1);
}

const lcov = fs.readFileSync(LCOV_PATH, "utf8");
const perFile = new Map();

for (const record of lcov.split("end_of_record")) {
  const sfMatch = record.match(/SF:(.+)/);
  if (!sfMatch) continue;
  const file = sfMatch[1].trim();

  const lhMatch = record.match(/LH:(\d+)/);
  const lfMatch = record.match(/LF:(\d+)/);
  if (!lhMatch || !lfMatch) continue;

  perFile.set(file, { hit: Number(lhMatch[1]), found: Number(lfMatch[1]) });
}

let failed = false;

for (const file of CRITICAL_FILES) {
  const data = perFile.get(file);
  if (!data) {
    console.warn(`  no coverage data for ${file}`);
    continue;
  }

  if (data.found === 0) {
    console.error(`✗ ${file}: denominator is 0`);
    failed = true;
    continue;
  }

  const pct = (data.hit / data.found) * 100;
  if (pct < 100) {
    console.error(`✗ ${file}: line coverage ${pct.toFixed(2)}% < 100%`);
    console.error(`  uncovered lines: ${data.found - data.hit}`);
    failed = true;
  } else {
    console.log(`✓ ${file}: 100% line (${data.hit}/${data.found})`);
  }
}

if (failed) {
  console.error("\nCritical-path line coverage failed.");
  process.exit(1);
}
