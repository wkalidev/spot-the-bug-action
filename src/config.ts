import { realpathSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import { parseDocument } from "yaml";
import { normalizePath } from "./changed-files.js";
import { MAX_TEXT_LENGTH, type Explanation } from "./explanations.js";
import type { Severity } from "./findings.js";
import { FAIL_ON_VALUES, type FailOn } from "./threshold.js";

/** Config file looked up at the repository root when the `config-file` input is empty. */
export const DEFAULT_CONFIG_FILE = ".spot-the-bug.yml";
export const MAX_CONFIG_BYTES = 64 * 1024;
/** Longest list accepted for `detectors.*` and `paths.exclude`. */
export const MAX_LIST_LENGTH = 200;
export const MAX_GLOB_LENGTH = 200;
/** YAML aliases allowed before parsing stops, to block "billion laughs" files. */
const MAX_ALIAS_COUNT = 100;

/** Slither check ids: lowercase words joined by hyphens. Also rules out CLI flags. */
const DETECTOR_ID = /^[a-z0-9][a-z0-9-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const SEVERITY_VALUES: Readonly<Record<string, Severity>> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Informational",
  optimization: "Optimization",
};

export interface DetectorSelection {
  /** Run only these detectors (`--detect`). */
  only?: string[];
  /** Skip these detectors (`--exclude`). */
  exclude?: string[];
}

export interface SpotTheBugConfig {
  detectors: DetectorSelection;
  /** Severity to report for a check id, replacing Slither's. */
  severity: Map<string, Severity>;
  /** Repo-relative globs; a finding is ignored when all its files match one. */
  pathExclude: string[];
  /** Plain-English text for a check id, replacing or adding to the built-in ones. */
  explanations: Map<string, Explanation>;
  failOn?: FailOn;
}

export interface LoadedConfig {
  /** Repo-relative path of the config file, with forward slashes. */
  file: string;
  config: SpotTheBugConfig;
}

class ConfigError extends Error {}

function fail(at: string, message: string): never {
  throw new ConfigError(at ? `${at}: ${message}` : message);
}

/** A config key for error messages, quoted and shortened. */
function quoteKey(key: string): string {
  return JSON.stringify(key.length > 40 ? `${key.slice(0, 39)}…` : key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinKey(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function expectRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) fail(at, "expected a mapping.");
  return value;
}

function checkKeys(record: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(at, `unknown key ${quoteKey(key)}. Expected one of: ${allowed.join(", ")}.`);
    }
  }
}

function checkDetectorId(id: string, at: string): void {
  if (!DETECTOR_ID.test(id)) {
    fail(at, `${quoteKey(id)} is not a Slither detector id (lowercase letters, digits and "-").`);
  }
}

function parseDetectorList(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) fail(at, "expected a list of detector ids.");
  if (value.length === 0) fail(at, "expected at least one detector id.");
  if (value.length > MAX_LIST_LENGTH) fail(at, `expected at most ${MAX_LIST_LENGTH} entries.`);
  return value.map((id, i) => {
    if (typeof id !== "string") fail(`${at}[${i}]`, "expected a detector id.");
    checkDetectorId(id, `${at}[${i}]`);
    return id;
  });
}

function parseDetectors(value: unknown): DetectorSelection {
  const record = expectRecord(value, "detectors");
  checkKeys(record, ["only", "exclude"], "detectors");
  if (record.only !== undefined && record.exclude !== undefined) {
    fail("detectors", 'use either "only" or "exclude", not both.');
  }
  const selection: DetectorSelection = {};
  if (record.only !== undefined) selection.only = parseDetectorList(record.only, "detectors.only");
  if (record.exclude !== undefined) {
    selection.exclude = parseDetectorList(record.exclude, "detectors.exclude");
  }
  return selection;
}

function parseSeverity(value: unknown): Map<string, Severity> {
  const record = expectRecord(value, "severity");
  const severity = new Map<string, Severity>();
  for (const [id, level] of Object.entries(record)) {
    const at = joinKey("severity", id);
    checkDetectorId(id, "severity");
    const mapped =
      typeof level === "string" && Object.hasOwn(SEVERITY_VALUES, level.trim().toLowerCase())
        ? SEVERITY_VALUES[level.trim().toLowerCase()]
        : undefined;
    if (!mapped) fail(at, `expected one of: ${Object.keys(SEVERITY_VALUES).join(", ")}.`);
    severity.set(id, mapped);
  }
  return severity;
}

function parseGlob(glob: unknown, at: string): string {
  if (typeof glob !== "string" || glob.trim() === "") fail(at, "expected a glob.");
  if (glob.length > MAX_GLOB_LENGTH) fail(at, `expected at most ${MAX_GLOB_LENGTH} characters.`);
  if (CONTROL_CHARS.test(glob) || glob.includes("\\")) {
    fail(at, "globs use forward slashes and no control characters.");
  }
  if (glob.startsWith("/") || glob.split("/").includes("..")) {
    fail(at, "globs are relative to the repository root and cannot leave it.");
  }
  return glob.trim();
}

function parsePaths(value: unknown): string[] {
  const record = expectRecord(value, "paths");
  checkKeys(record, ["exclude"], "paths");
  if (record.exclude === undefined) return [];
  if (!Array.isArray(record.exclude)) fail("paths.exclude", "expected a list of globs.");
  if (record.exclude.length > MAX_LIST_LENGTH) {
    fail("paths.exclude", `expected at most ${MAX_LIST_LENGTH} entries.`);
  }
  return record.exclude.map((glob, i) => parseGlob(glob, `paths.exclude[${i}]`));
}

function parseText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(at, "expected non-empty text.");
  if (CONTROL_CHARS.test(value)) fail(at, "expected a single line of text.");
  const text = value.trim();
  if (text.length > MAX_TEXT_LENGTH) fail(at, `expected at most ${MAX_TEXT_LENGTH} characters.`);
  return text;
}

function parseExplanations(value: unknown): Map<string, Explanation> {
  const record = expectRecord(value, "explanations");
  const explanations = new Map<string, Explanation>();
  for (const [id, entry] of Object.entries(record)) {
    checkDetectorId(id, "explanations");
    const at = joinKey("explanations", id);
    const fields = expectRecord(entry, at);
    checkKeys(fields, ["title", "why"], at);
    explanations.set(id, {
      title: parseText(fields.title, `${at}.title`),
      why: parseText(fields.why, `${at}.why`),
    });
  }
  return explanations;
}

function parseFailOnSetting(value: unknown): FailOn {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(FAIL_ON_VALUES as readonly string[]).includes(normalized)) {
    fail("fail-on", `expected one of: ${FAIL_ON_VALUES.join(", ")}.`);
  }
  return normalized as FailOn;
}

const TOP_LEVEL_KEYS = ["version", "detectors", "severity", "paths", "explanations", "fail-on"];

/** Validate parsed YAML against the version 1 schema. Unknown keys are errors. */
export function validateConfig(data: unknown): SpotTheBugConfig {
  const record = expectRecord(data, "");
  checkKeys(record, TOP_LEVEL_KEYS, "");
  if (record.version !== 1) fail("version", "expected 1.");

  const config: SpotTheBugConfig = {
    detectors: record.detectors === undefined ? {} : parseDetectors(record.detectors),
    severity: record.severity === undefined ? new Map() : parseSeverity(record.severity),
    pathExclude: record.paths === undefined ? [] : parsePaths(record.paths),
    explanations:
      record.explanations === undefined ? new Map() : parseExplanations(record.explanations),
  };
  if (record["fail-on"] !== undefined) config.failOn = parseFailOnSetting(record["fail-on"]);
  return config;
}

/**
 * Parse a config file. Only the YAML core schema is used: custom tags are
 * rejected, never resolved, and alias expansion is capped.
 */
export function parseConfig(source: string, file = DEFAULT_CONFIG_FILE): SpotTheBugConfig {
  try {
    const doc = parseDocument(source, { schema: "core", uniqueKeys: true });
    // Library messages end with a snippet of the file; keep the first line only.
    const problem = doc.errors[0] ?? doc.warnings[0];
    if (problem) fail("", problem.message.split("\n")[0]!.replace(/:$/, ""));
    let data: unknown;
    try {
      data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
    } catch {
      fail("", "too many YAML aliases.");
    }
    if (data === null || data === undefined) fail("", "the file is empty.");
    return validateConfig(data);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new Error(`Invalid config file ${file}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Load the config file named by the `config-file` input. An empty input means
 * the optional DEFAULT_CONFIG_FILE: returns undefined when it does not exist.
 * A path given explicitly must exist. Either way it must stay inside the
 * repository, symbolic links included.
 */
export function loadConfig(input: string, repoRoot: string): LoadedConfig | undefined {
  const explicit = input.trim() !== "";
  const file = normalizePath(explicit ? input.trim() : DEFAULT_CONFIG_FILE);
  if (path.isAbsolute(file) || path.win32.isAbsolute(file)) {
    throw new Error(`config-file must be relative to the repository root, got "${file}".`);
  }

  const root = realpathSync(repoRoot);
  const candidate = path.resolve(root, file);
  if (!isInside(root, candidate)) {
    throw new Error(`config-file "${file}" is outside the repository.`);
  }

  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (explicit) throw new Error(`Config file "${file}" was not found.`, { cause: error });
    return undefined;
  }
  if (!isInside(root, resolved)) {
    throw new Error(`Config file "${file}" links outside the repository.`);
  }

  const stats = statSync(resolved);
  if (!stats.isFile()) throw new Error(`Config file "${file}" is not a file.`);
  if (stats.size > MAX_CONFIG_BYTES) {
    throw new Error(`Config file "${file}" is larger than ${MAX_CONFIG_BYTES / 1024} KB.`);
  }
  return { file, config: parseConfig(readFileSync(resolved, "utf8"), file) };
}

/**
 * Build a check for `paths.exclude`: true when a finding's files all match an
 * exclude glob. A finding without any known file is never excluded.
 */
export function createPathExcluder(
  globs: readonly string[],
): (files: readonly string[]) => boolean {
  if (globs.length === 0) return () => false;
  const isMatch = picomatch([...globs], { dot: true });
  return (files) => files.length > 0 && files.every((file) => isMatch(normalizePath(file)));
}
