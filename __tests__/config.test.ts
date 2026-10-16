import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPathExcluder,
  DEFAULT_CONFIG_FILE,
  loadConfig,
  MAX_CONFIG_BYTES,
  parseConfig,
} from "../src/config.js";

const FULL_CONFIG = `
version: 1
detectors:
  exclude: [timestamp, solc-version]
severity:
  missing-zero-check: high
  reentrancy-benign: Informational
paths:
  exclude: ["test/**", "script/**"]
explanations:
  reentrancy-eth:
    title: Vault can be drained by re-entering withdraw()
    why: Balance is zeroed after the ETH transfer.
fail-on: Medium
`;

describe("parseConfig", () => {
  it("parses every section", () => {
    const config = parseConfig(FULL_CONFIG);

    expect(config.detectors).toEqual({ exclude: ["timestamp", "solc-version"] });
    expect(config.severity).toEqual(
      new Map([
        ["missing-zero-check", "High"],
        ["reentrancy-benign", "Informational"],
      ]),
    );
    expect(config.pathExclude).toEqual(["test/**", "script/**"]);
    expect(config.explanations.get("reentrancy-eth")).toEqual({
      title: "Vault can be drained by re-entering withdraw()",
      why: "Balance is zeroed after the ETH transfer.",
    });
    expect(config.failOn).toBe("medium");
  });

  it("accepts a minimal config with defaults", () => {
    const config = parseConfig("version: 1\n");

    expect(config.detectors).toEqual({});
    expect(config.severity.size).toBe(0);
    expect(config.pathExclude).toEqual([]);
    expect(config.explanations.size).toBe(0);
    expect(config.failOn).toBeUndefined();
  });

  it("accepts detectors.only", () => {
    expect(parseConfig("version: 1\ndetectors: { only: [reentrancy-eth] }").detectors).toEqual({
      only: ["reentrancy-eth"],
    });
  });

  it("names the file in every error", () => {
    expect(() => parseConfig("version: 2", "ci/spot.yml")).toThrow(
      "Invalid config file ci/spot.yml: version: expected 1.",
    );
  });

  it.each([
    ["an empty file", "", /the file is empty/],
    ["a list at the top level", "- version: 1", /expected a mapping/],
    ["a missing version", "detectors: {}", /version: expected 1/],
    ["a string version", 'version: "1"', /version: expected 1/],
    ["an unknown top-level key", "version: 1\nseverities: {}", /unknown key "severities"/],
    [
      "an unknown nested key",
      "version: 1\npaths: { include: [a] }",
      /paths: unknown key "include"/,
    ],
    [
      "both only and exclude",
      "version: 1\ndetectors: { only: [a], exclude: [b] }",
      /either "only" or "exclude"/,
    ],
    ["an empty detector list", "version: 1\ndetectors: { exclude: [] }", /at least one/],
    [
      "a detector id that is a flag",
      "version: 1\ndetectors: { exclude: [--json] }",
      /not a Slither detector id/,
    ],
    [
      "a non-string detector id",
      "version: 1\ndetectors: { exclude: [1] }",
      /exclude\[0\]: expected a detector id/,
    ],
    [
      "an unknown severity",
      "version: 1\nseverity: { timestamp: critical }",
      /severity.timestamp: expected one of/,
    ],
    [
      "a prototype key",
      "version: 1\nseverity: { __proto__: high }",
      /"__proto__" is not a Slither detector id/,
    ],
    ["an unknown fail-on", "version: 1\nfail-on: critical", /fail-on: expected one of/],
    [
      "an absolute glob",
      'version: 1\npaths: { exclude: ["/etc/**"] }',
      /relative to the repository root/,
    ],
    ["a glob leaving the repo", 'version: 1\npaths: { exclude: ["../x/**"] }', /cannot leave it/],
    ["a backslash glob", 'version: 1\npaths: { exclude: ["test\\\\**"] }', /forward slashes/],
    ["an empty glob", 'version: 1\npaths: { exclude: [""] }', /expected a glob/],
    [
      "a multi-line explanation",
      'version: 1\nexplanations: { timestamp: { title: "a\\nb", why: c } }',
      /explanations.timestamp.title: expected a single line/,
    ],
    [
      "a missing explanation field",
      "version: 1\nexplanations: { timestamp: { title: a } }",
      /explanations.timestamp.why: expected non-empty text/,
    ],
    [
      "an extra explanation field",
      "version: 1\nexplanations: { timestamp: { title: a, why: b, link: c } }",
      /explanations.timestamp: unknown key "link"/,
    ],
  ])("rejects %s", (_name, source, message) => {
    expect(() => parseConfig(source)).toThrow(message);
  });

  it("rejects explanations longer than the comment allows", () => {
    const source = `version: 1\nexplanations: { timestamp: { title: "${"x".repeat(91)}", why: b } }`;
    expect(() => parseConfig(source)).toThrow(/at most 90 characters/);
  });

  it("rejects too many entries", () => {
    const ids = Array.from({ length: 201 }, (_, i) => `d${i}`).join(", ");
    expect(() => parseConfig(`version: 1\ndetectors: { exclude: [${ids}] }`)).toThrow(
      /at most 200 entries/,
    );
  });

  it("reports YAML syntax errors with their position and without the file content", () => {
    const error = (() => {
      try {
        parseConfig("version: 1\ndetectors: [secret-value");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toMatch(
      /^Invalid config file \.spot-the-bug\.yml: .* at line 2, column \d+$/,
    );
    expect(error?.message).not.toContain("secret-value");
  });

  it("rejects duplicate keys", () => {
    expect(() => parseConfig("version: 1\nversion: 1")).toThrow(/Map keys must be unique/);
  });

  it.each([
    ["a JavaScript function tag", 'version: 1\nfail-on: !!js/function "function () { return 1 }"'],
    ["a custom tag", "version: 1\nfail-on: !env HOME"],
  ])("rejects %s instead of resolving it", (_name, source) => {
    expect(() => parseConfig(source)).toThrow(/Unresolved tag/);
  });

  it("stops alias expansion bombs", () => {
    const source = [
      "version: 1",
      "a: &a [x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "e: [*d, *d, *d, *d, *d, *d, *d, *d, *d]",
    ].join("\n");
    expect(() => parseConfig(source)).toThrow(/too many YAML aliases/);
  });

  it("does not treat merge keys as merges", () => {
    expect(() => parseConfig("version: 1\n<<: { fail-on: none }")).toThrow(/unknown key "<<"/);
  });
});

describe("loadConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "spot-the-bug-config-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when the default file does not exist", () => {
    expect(loadConfig("", root)).toBeUndefined();
  });

  it("loads the default file from the repository root", () => {
    writeFileSync(path.join(root, DEFAULT_CONFIG_FILE), "version: 1\nfail-on: low\n");

    expect(loadConfig("  ", root)).toMatchObject({
      file: ".spot-the-bug.yml",
      config: { failOn: "low" },
    });
  });

  it("loads an explicit path with normalized separators", () => {
    mkdirSync(path.join(root, "ci"));
    writeFileSync(path.join(root, "ci", "spot.yml"), "version: 1\n");

    expect(loadConfig("./ci\\spot.yml", root)?.file).toBe("ci/spot.yml");
  });

  it("fails when an explicit path does not exist", () => {
    expect(() => loadConfig("ci/spot.yml", root)).toThrow(
      'Config file "ci/spot.yml" was not found.',
    );
  });

  it("fails on an invalid default file instead of ignoring it", () => {
    writeFileSync(path.join(root, DEFAULT_CONFIG_FILE), "version: 1\nfail_on: low\n");

    expect(() => loadConfig("", root)).toThrow(
      /Invalid config file \.spot-the-bug\.yml: unknown key "fail_on"/,
    );
  });

  it.each(["../outside.yml", "ci/../../outside.yml"])(
    "rejects %s outside the repository",
    (input) => {
      expect(() => loadConfig(input, root)).toThrow(/outside the repository/);
    },
  );

  it("rejects absolute paths", () => {
    expect(() => loadConfig(path.join(root, DEFAULT_CONFIG_FILE), root)).toThrow(
      /relative to the repository root/,
    );
  });

  it("rejects a directory", () => {
    mkdirSync(path.join(root, "ci"));
    expect(() => loadConfig("ci", root)).toThrow('Config file "ci" is not a file.');
  });

  it("rejects files over the size limit before reading them", () => {
    writeFileSync(
      path.join(root, DEFAULT_CONFIG_FILE),
      `version: 1\n#${"x".repeat(MAX_CONFIG_BYTES)}`,
    );
    expect(() => loadConfig("", root)).toThrow(/larger than 64 KB/);
  });

  it("rejects a symbolic link that leaves the repository", (ctx) => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "spot-the-bug-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.yml"), "version: 1\n");
      try {
        symlinkSync(path.join(outside, "secret.yml"), path.join(root, DEFAULT_CONFIG_FILE));
      } catch {
        ctx.skip(); // Creating symbolic links needs extra privileges on Windows.
      }
      expect(() => loadConfig("", root)).toThrow(/links outside the repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("createPathExcluder", () => {
  const excluded = createPathExcluder(["test/**", "script/*.sol", "**/mocks/**"]);

  it("excludes a finding whose only file matches", () => {
    expect(excluded(["test/Vault.t.sol"])).toBe(true);
    expect(excluded(["src/mocks/Token.sol"])).toBe(true);
    expect(excluded(["script/Deploy.sol"])).toBe(true);
  });

  it("keeps a finding whose file does not match", () => {
    expect(excluded(["src/Vault.sol"])).toBe(false);
    expect(excluded(["script/deploy/Deploy.sol"])).toBe(false);
  });

  it("keeps a multi-file finding unless every file matches", () => {
    expect(excluded(["test/Attacker.sol", "src/Vault.sol"])).toBe(false);
    expect(excluded(["src/Vault.sol", "test/Attacker.sol"])).toBe(false);
    expect(excluded(["test/Attacker.sol", "src/mocks/Token.sol"])).toBe(true);
  });

  it("never excludes a finding without a known file", () => {
    expect(excluded([])).toBe(false);
  });

  it("matches dot directories and Windows separators", () => {
    expect(createPathExcluder(["**/*.sol"])([".github/x/A.sol"])).toBe(true);
    expect(excluded(["test\\Vault.t.sol"])).toBe(true);
  });

  it("excludes nothing without globs", () => {
    expect(createPathExcluder([])(["test/Vault.t.sol"])).toBe(false);
  });
});
