#!/usr/bin/env node
// Prepare Pi's local JSON files without expanding credentials.

import { chmodSync, existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";

function readObject(path) {
  const text = readFileSync(path, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // Node's JSON errors may include document contents, including credentials.
    throw new Error(`Invalid JSON: ${path}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected JSON object: ${path}`);
  }
  return value;
}

function desiredFiles(source, target) {
  const settings = readObject(join(source, "settings.json"));
  const currentPath = join(target, "settings.json");
  const current = existsSync(currentPath) ? readObject(currentPath) : {};
  // Only declared top-level fields are managed; arrays are replaced, not merged.
  const merged = { ...current, ...settings };
  const models = readObject(join(source, "models.json"));
  for (const [name, variable] of [
    ["anthropic", "ANTHROPIC_BASE_URL"],
    ["openai", "OPENAI_BASE_URL"],
  ]) {
    const url = (process.env[variable] ?? "").trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${variable} must be an exported, absolute HTTP(S) URL`);
    }
    if (!/^https?:\/\//i.test(url) || !parsed.hostname || url.includes("$")) {
      throw new Error(`${variable} must be an exported, absolute HTTP(S) URL`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || /@/.test(url.split("/")[2] ?? "")) {
      throw new Error(`${variable} must not contain credentials, a query, or a fragment`);
    }
    models.providers[name].baseUrl = url;
  }
  // Validate linked configuration too, before changing any managed file.
  readObject(join(source, "mcp-adapter.json"));
  readObject(join(source, "sol-pi.json"));
  readObject(join(source, "pi-permission-system.json"));
  return { "settings.json": merged, "models.json": models };
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      source: { type: "string" },
      "target-dir": { type: "string" },
      "output-dir": { type: "string" },
    },
    allowPositionals: true,
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !["prepare", "diff"].includes(command) || !values.source || !values["target-dir"]) {
    throw new Error("Usage: pi_settings.mjs <prepare|diff> --source PATH --target-dir PATH [--output-dir PATH]");
  }
  if (command === "prepare" && !values["output-dir"]) {
    throw new Error("prepare requires --output-dir");
  }
  const target = values["target-dir"];
  for (const name of ["settings.json", "models.json"]) {
    const path = join(target, name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stats.isDirectory() || (stats.isSymbolicLink() && (!existsSync(path) || statSync(path).isDirectory()))) {
      throw new Error(`Expected readable file or absent path: ${path}`);
    }
  }
  const files = desiredFiles(values.source, target);
  if (command === "prepare") {
    for (const [name, value] of Object.entries(files)) {
      const path = join(values["output-dir"], name);
      writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    }
    return 0;
  }
  let changed = false;
  for (const [name, value] of Object.entries(files)) {
    const path = join(target, name);
    const equal = existsSync(path) && !lstatSync(path).isSymbolicLink() && statSync(path).isFile()
      && isDeepStrictEqual(readObject(path), value);
    console.log(`[${equal ? "OK" : "DIFF"}] ${path}`);
    changed ||= !equal;
  }
  return Number(changed);
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 2;
}
