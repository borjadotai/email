#!/usr/bin/env node
import { spawn } from "node:child_process";

const steps = [
  ["Syntax check package smoke", process.execPath, ["--check", "scripts/smoke-carta-package-install.mjs"]],
  ["Syntax check relay smoke", process.execPath, ["--check", "scripts/smoke-carta-relay-e2e.mjs"]],
  ["Server and CLI tests", "npm", ["test"]],
  ["Relay tests", "npm", ["run", "relay:test"]],
  ["Installed package smoke", "npm", ["run", "smoke:package"]],
  ["Relay first-run smoke", "npm", ["run", "smoke:relay:e2e"]],
  ["Pack CLI tarball", "npm", ["run", "package:cli"]],
  ["Whitespace diff check", "git", ["diff", "--check"]]
];

for (const [label, command, args] of steps) {
  await runStep(label, command, args);
}

await secretDiffScan();

console.log("\nCarta CLI verification complete.");

function runStep(label, command, args) {
  return new Promise((resolveStep, rejectStep) => {
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", rejectStep);
    child.on("close", code => {
      if (code === 0) {
        resolveStep();
      } else {
        rejectStep(new Error(`${label} failed with exit code ${code}.`));
      }
    });
  });
}

async function secretDiffScan() {
  console.log("\n==> Secret diff scan");
  const diff = await capture("git", ["diff", "--", ".", ":!.env", ":!.env.*"]);
  const pattern = /GOCSPX|BEGIN PRIVATE KEY|602828839442|APNS_KEY_ID=|APNS_TEAM_ID=/u;
  if (pattern.test(diff.stdout)) {
    throw new Error("Secret-like material was found in the git diff.");
  }
  console.log("No Google/APNs secret material found in git diff.");
}

function capture(command, args) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", rejectCapture);
    child.on("close", code => {
      if (code === 0) {
        resolveCapture({ stdout, stderr });
      } else {
        rejectCapture(new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderr || stdout}`));
      }
    });
  });
}
