#!/usr/bin/env node
// Checks or refreshes generated release artifacts before a release publish.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runManagedCommand } from "./lib/managed-child-process.mjs";
import { parseReleaseVersion } from "./lib/npm-publish-plan.mjs";

const parsedArgs = parseArgs(process.argv.slice(2));
const fix = parsedArgs.fix;

// Extended-stable evidence reuse validates npm-owned version stamps without
// importing the newer native-app release graph into the 6.x release branch.
if (parsedArgs.npmVersionsOnly) {
  const errors = collectNpmVersionErrors();
  if (errors.length !== 0) {
    for (const error of errors) {
      console.error(`[release-preflight] npm version metadata: ${error}`);
    }
    process.exit(1);
  }
  console.log("[release-preflight] npm version metadata OK");
  process.exit(0);
}

const fixCommands = [
  { name: "plugin versions", args: ["plugins:sync"] },
  { name: "npm shrinkwraps", args: ["deps:shrinkwrap:changed:generate"] },
  { name: "plugin inventory", args: ["plugins:inventory:gen"] },
  { name: "base config schema", args: ["config:schema:gen"] },
  { name: "bundled channel config metadata", args: ["config:channels:gen"] },
  { name: "config docs baseline", args: ["config:docs:gen"] },
  { name: "plugin SDK exports", args: ["plugin-sdk:sync-exports"] },
  { name: "plugin SDK API baseline", args: ["plugin-sdk:api:gen"] },
];

const checkCommands = [
  { name: "root dependency ownership", args: ["deps:root-ownership:check"] },
  { name: "npm shrinkwraps", args: ["deps:shrinkwrap:check"] },
  { name: "plugin versions", args: ["plugins:sync:check"] },
  { name: "plugin inventory", args: ["plugins:inventory:check"] },
  { name: "base config schema", args: ["config:schema:check"] },
  { name: "bundled channel config metadata", args: ["config:channels:check"] },
  { name: "config docs baseline", args: ["config:docs:check"] },
  { name: "plugin SDK exports", args: ["plugin-sdk:check-exports"] },
  { name: "plugin SDK API baseline", args: ["plugin-sdk:api:check"] },
  { name: "plugin SDK surface budget", args: ["plugin-sdk:surface:check"] },
];

if (fix) {
  console.log("[release-preflight] refreshing generated release artifacts");
  const failed = await runSerial(fixCommands);
  if (failed.length !== 0) {
    printFailures("release preflight refresh failed", failed);
    process.exit(1);
  }
}

console.log("[release-preflight] checking release generated artifacts and manifests");
const failed = await runAll(checkCommands);
if (failed.length !== 0) {
  printFailures("release preflight found drift", failed);
  console.error(
    "\nRun `pnpm release:prep` if the version/config/API changes are intentional, then commit the generated files.",
  );
  process.exit(1);
}
console.log("[release-preflight] OK");

async function runSerial(commands) {
  const failedValue = [];
  for (const command of commands) {
    const status = await runCommand(command);
    if (status !== 0) {
      failedValue.push({ ...command, status });
      break;
    }
  }
  return failedValue;
}

async function runAll(commands) {
  const failedLocal = [];
  for (const command of commands) {
    const status = await runCommand(command);
    if (status !== 0) {
      failedLocal.push({ ...command, status });
    }
  }
  return failedLocal;
}

async function runCommand(command) {
  console.log(`\n[release-preflight] ${command.name}: pnpm ${command.args.join(" ")}`);
  try {
    return await runManagedCommand({
      args: command.args,
      bin: "pnpm",
    });
  } catch (error) {
    console.error(error);
    return 1;
  }
}

function printFailures(title, failures) {
  console.error(`\n${title}:`);
  for (const failure of failures) {
    console.error(`- ${failure.name}: exit ${failure.status} (pnpm ${failure.args.join(" ")})`);
  }
}

function collectNpmVersionErrors(rootDir = resolve(".")) {
  const packageJsonPath = resolve(rootDir, "package.json");
  let rootVersion;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    rootVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  } catch (error) {
    return [`unable to read package.json: ${formatError(error)}`];
  }
  if (!parseReleaseVersion(rootVersion)) {
    return [`package.json has invalid release version ${JSON.stringify(rootVersion)}`];
  }

  const errors = [];
  const extensionsDir = resolve(rootDir, "extensions");
  let entries;
  try {
    entries = readdirSync(extensionsDir, { withFileTypes: true });
  } catch (error) {
    return [`unable to read extensions directory: ${formatError(error)}`];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginPackagePath = resolve(extensionsDir, entry.name, "package.json");
    if (!existsSync(pluginPackagePath)) {
      continue;
    }
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(pluginPackagePath, "utf8"));
    } catch (error) {
      errors.push(`unable to read extensions/${entry.name}/package.json: ${formatError(error)}`);
      continue;
    }
    if (packageJson.openclaw?.release?.publishToNpm !== true) {
      continue;
    }
    if (packageJson.version !== rootVersion) {
      errors.push(
        `extensions/${entry.name}/package.json version is ${JSON.stringify(packageJson.version)}; expected ${JSON.stringify(rootVersion)}`,
      );
    }
  }
  return errors;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  let check = false;
  let wantsFix = false;
  let npmVersionsOnly = false;
  for (const arg of argv) {
    if (arg === "--help") {
      printUsage(console.log);
      process.exit(0);
    }
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--fix") {
      wantsFix = true;
      continue;
    }
    if (arg === "--npm-versions-only") {
      npmVersionsOnly = true;
      continue;
    }
    console.error(`Unknown release preflight argument: ${arg}`);
    printUsage(console.error);
    process.exit(1);
  }
  if (wantsFix && check) {
    console.error("Use either --fix or --check, not both.");
    process.exit(1);
  }
  if (npmVersionsOnly && (wantsFix || check)) {
    console.error("Use --npm-versions-only without --fix or --check.");
    process.exit(1);
  }
  return { fix: wantsFix, npmVersionsOnly };
}

function printUsage(writeLine) {
  writeLine("Usage: node scripts/release-preflight.mjs [--check|--fix]");
  writeLine("       node scripts/release-preflight.mjs --npm-versions-only");
  writeLine("");
  writeLine("  --check  verify generated release artifacts without writing changes (default)");
  writeLine("  --fix    refresh generated release artifacts, then verify them");
  writeLine("  --npm-versions-only  verify root and publishable plugin versions, no commands");
}
