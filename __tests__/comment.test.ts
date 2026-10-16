import { describe, expect, it, vi } from "vitest";
import {
  COMMENT_MARKER,
  MAX_RAW_LENGTH,
  MAX_ROWS,
  blobUrl,
  renderComment,
  renderIssue,
  renderNoSolidityComment,
  renderRawOutput,
  updateExistingComment,
  upsertComment,
} from "../src/comment.js";
import { summarizeFindings, type Finding, type FindingsSummary } from "../src/findings.js";
import { ALL_FILES, PATH_CONTEXT, changedFiles, loadFixture, loadReport } from "./helpers.js";

const LINK = {
  serverUrl: "https://github.com",
  owner: "acme",
  repo: "demo",
  sha: "abc123",
};

describe("renderComment", () => {
  it("renders findings from the fixture", () => {
    const { detectors, wikiUrls } = loadReport();
    const summary = summarizeFindings(detectors, ALL_FILES, PATH_CONTEXT);
    const body = renderComment(summary, LINK, { wikiUrls });

    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("## 🔍 Spot the Bug — 8 findings in changed files");
    expect(body).toContain("🔴 High: **4** · 🟠 Medium: **1** · 🟡 Low: **3**");
    expect(body).toContain("Not shown: 1 informational, 1 optimization.");
    expect(body).toContain("| Severity | Issue | Location |");
    expect(body).toContain(
      "| 🔴 High | **[Reentrancy can drain ETH](https://github.com/crytic/slither/wiki/Detector-Documentation#reentrancy-vulnerabilities-1 " +
        '"State is updated after an external call, so a callback can withdraw again.")** — `ReentrantBank.withdraw` | ' +
        "[`ReentrantBank.sol:16`](https://github.com/acme/demo/blob/abc123/src/vulns/ReentrantBank.sol#L16) |",
    );
    expect(body).not.toContain("low-level-calls");
    expect(body).not.toContain("immutable-states");
    expect(body).toContain(
      "<sub>Scanned by [Spot the Bug](https://github.com/wkalidev/spot-the-bug-action) · Need a full audit? hello@wkalidev.com</sub>",
    );
    expect(body).toMatchSnapshot();
  });

  it("shows the file name only in the location", () => {
    const summary = summarizeFindings(loadFixture(), ALL_FILES, PATH_CONTEXT);
    expect(renderComment(summary, LINK)).not.toContain("[`src/");
  });

  it("keeps Slither's source paths and broken endings out of the tables", () => {
    const summary = summarizeFindings(loadFixture(), ALL_FILES, PATH_CONTEXT);
    const rows = renderComment(summary, LINK)
      .split("\n")
      .filter((l) => /^\| (🔴|🟠|🟡)/u.test(l));
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row).not.toMatch(/\.sol#\d/);
      expect(row).not.toMatch(/ (on|by) :/);
    }
  });

  it("renders the clean state", () => {
    const summary = summarizeFindings(loadFixture(), changedFiles("src/Other.sol"), PATH_CONTEXT);
    const body = renderComment(summary, LINK);
    expect(body).toContain("## ✅ Spot the Bug — no issues found in changed files");
    expect(body).not.toContain("| Severity |");
    expect(body).not.toContain("Not shown");
  });

  it("uses the singular for one finding", () => {
    const summary = summarizeFindings(
      loadFixture(),
      changedFiles("src/vulns/TxOriginWallet.sol"),
      PATH_CONTEXT,
    );
    expect(renderComment(summary, LINK)).toContain("— 1 finding in changed files");
  });

  it("caps the table and reports the remainder", () => {
    const finding: Finding = {
      id: "missing-zero-check",
      severity: "Low",
      confidence: "Medium",
      file: "src/A.sol",
      line: 1,
      description: "desc",
    };
    const reported = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ ...finding, line: i + 1 }));
    const summary: FindingsSummary = {
      reported,
      counts: { High: 0, Medium: 0, Low: reported.length },
      informationalCount: 0,
      optimizationCount: 0,
    };
    const body = renderComment(summary, LINK);
    const rows = body.split("\n").filter((l) => l.startsWith("| 🟡 Low"));
    expect(rows).toHaveLength(MAX_ROWS);
    expect(body).toContain("…and 5 more");
  });

  it("collapses low-severity findings below high and medium ones", () => {
    const summary = summarizeFindings(loadFixture(), ALL_FILES, PATH_CONTEXT);
    const body = renderComment(summary, LINK);
    const details = body.indexOf("<details>\n<summary>🟡 3 low-severity findings</summary>\n\n|");
    expect(details).toBeGreaterThan(body.indexOf("| 🟠 Medium"));
    expect(body.indexOf("| 🟡 Low")).toBeGreaterThan(details);
    expect(body.indexOf("</details>")).toBeGreaterThan(body.lastIndexOf("| 🟡 Low"));
  });

  it("shows the low table expanded when all findings are low", () => {
    const summary = summarizeFindings(
      loadFixture(),
      changedFiles("src/vulns/ArbitrarySend.sol"),
      PATH_CONTEXT,
    );
    const lowOnly = { ...summary, reported: summary.reported.filter((f) => f.severity === "Low") };
    const body = renderComment(lowOnly, LINK);
    expect(body.split("| Severity | Issue | Location |")).toHaveLength(2);
    expect(body).toContain("| 🟡 Low");
    expect(body).not.toContain("low-severity");
    // The only <details> left is the raw Slither output, after the table.
    expect(body.split("<details>")).toHaveLength(2);
    expect(body.indexOf("<details>")).toBeGreaterThan(body.lastIndexOf("| 🟡 Low"));
    expect(body.indexOf("<summary>Raw Slither output</summary>")).toBeGreaterThan(0);
  });

  it("escapes pipes and newlines in descriptions", () => {
    const summary: FindingsSummary = {
      reported: [
        {
          id: "x",
          severity: "High",
          confidence: "High",
          file: "",
          line: 0,
          description: "a | b",
        },
      ],
      counts: { High: 1, Medium: 0, Low: 0 },
      informationalCount: 0,
      optimizationCount: 0,
    };
    expect(renderComment(summary, LINK)).toContain("| 🔴 High | a \\| b | — |");
  });

  it("keeps every row on a single line", () => {
    const summary = summarizeFindings(loadFixture(), ALL_FILES, PATH_CONTEXT);
    const rows = renderComment(summary, LINK)
      .split("\n")
      .filter((l) => /^\| (🔴|🟠|🟡)/u.test(l));
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.split(/(?<!\\)\|/)).toHaveLength(5);
  });
});

const FINDING: Finding = {
  id: "arbitrary-send-eth",
  severity: "High",
  confidence: "Medium",
  file: "src/vulns/ArbitrarySend.sol",
  line: 22,
  description:
    "ArbitrarySend.sweepFees(address) (src/vulns/ArbitrarySend.sol#22-26) sends eth to arbitrary user",
};

describe("renderRawOutput", () => {
  it("keeps the full descriptions in a collapsed code block", () => {
    const summary = summarizeFindings(loadFixture(), ALL_FILES, PATH_CONTEXT);
    const body = renderComment(summary, LINK);
    const raw = body.slice(body.indexOf("<summary>Raw Slither output</summary>"));
    expect(raw).toContain(
      "\n\n[High] reentrancy-eth src/vulns/ReentrantBank.sol:16\nReentrancy in ReentrantBank.withdraw()",
    );
    expect(raw).toContain("can be used in cross function reentrancies:");
    expect(raw).toContain("lacks a zero-check on :\n\t\t- to.transfer(amount)");
    expect(raw.indexOf("</details>")).toBeGreaterThan(raw.indexOf("\n```\n"));
  });

  it("is omitted in the clean state", () => {
    const summary = summarizeFindings(loadFixture(), changedFiles("src/Other.sol"), PATH_CONTEXT);
    expect(renderComment(summary, LINK)).not.toContain("Raw Slither output");
  });

  it("uses a fence longer than any backtick run in the descriptions", () => {
    const lines = renderRawOutput([{ ...FINDING, description: "uses ```` inside" }]);
    expect(lines).toContain("`````text");
    expect(lines).toContain("`````");
  });

  it("truncates very long output", () => {
    const lines = renderRawOutput([{ ...FINDING, description: "x".repeat(MAX_RAW_LENGTH * 2) }]);
    const raw = lines.join("\n");
    expect(raw.length).toBeLessThan(MAX_RAW_LENGTH + 200);
    expect(raw).toContain("…(truncated)");
  });
});

describe("renderIssue", () => {
  it("uses the plain-English title and the function without parameters", () => {
    expect(renderIssue(FINDING)).toBe(
      "**Anyone can send the contract's ETH** — `ArbitrarySend.sweepFees`",
    );
  });

  it("links the title to the Slither wiki with the explanation as tooltip", () => {
    const wikiUrls = new Map([
      [
        "arbitrary-send-eth",
        "https://github.com/crytic/slither/wiki/Detector-Documentation#functions-that-send-ether-to-arbitrary-destinations",
      ],
    ]);
    expect(renderIssue(FINDING, { wikiUrls })).toBe(
      "**[Anyone can send the contract's ETH](https://github.com/crytic/slither/wiki/Detector-Documentation#functions-that-send-ether-to-arbitrary-destinations " +
        '"A public function forwards ETH to a caller-controlled address.")** — `ArbitrarySend.sweepFees`',
    );
  });

  it("omits the function when the description names none", () => {
    expect(renderIssue({ ...FINDING, description: "Something odd" })).toBe(
      "**Anyone can send the contract's ETH**",
    );
  });

  it("falls back to the cleaned Slither text for unknown checks", () => {
    const finding = {
      ...FINDING,
      id: "some-new-check",
      description: "Foo.bar(uint256) (src/Foo.sol#1-5) does something wrong on :\n\t- detail",
    };
    expect(renderIssue(finding)).toBe("Foo.bar(uint256) does something wrong");
  });

  it("escapes brackets when linking fallback text", () => {
    const finding = {
      ...FINDING,
      id: "some-new-check",
      description: "Writes balances[msg.sender] (src/Foo.sol#3)",
    };
    expect(renderIssue(finding, { wikiUrls: new Map([["some-new-check", "https://x/#a"]]) })).toBe(
      "[Writes balances\\[msg.sender\\]](https://github.com/crytic/slither/wiki/Detector-Documentation#a)",
    );
  });
});

describe("blobUrl", () => {
  it("encodes path segments and omits the anchor without a line", () => {
    expect(blobUrl("src/My Contract.sol", 0, LINK)).toBe(
      "https://github.com/acme/demo/blob/abc123/src/My%20Contract.sol",
    );
  });
});

describe("renderNoSolidityComment", () => {
  it("is a short marked comment with the footer", () => {
    const body = renderNoSolidityComment();
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("## ✅ Spot the Bug — no Solidity files changed in this PR anymore");
    expect(body).toContain("<sub>Scanned by [Spot the Bug]");
    expect(body).not.toContain("| Severity |");
  });
});

function fakeOctokit(comments: { id: number; body?: string; html_url: string }[]) {
  const updateComment = vi.fn().mockResolvedValue({});
  const createComment = vi.fn().mockResolvedValue({ data: { html_url: "https://x/new" } });
  const octokit = {
    paginate: vi.fn().mockResolvedValue(comments),
    rest: { issues: { listComments: vi.fn(), updateComment, createComment } },
  } as unknown as Parameters<typeof updateExistingComment>[0];
  return { octokit, updateComment, createComment };
}

const REPO = { owner: "acme", repo: "demo" };

describe("updateExistingComment", () => {
  it("updates the comment that carries the marker", async () => {
    const { octokit, updateComment, createComment } = fakeOctokit([
      { id: 1, body: "unrelated", html_url: "https://x/1" },
      { id: 2, body: `${COMMENT_MARKER}\nold report`, html_url: "https://x/2" },
    ]);
    await expect(updateExistingComment(octokit, REPO, 7, "new body")).resolves.toBe(true);
    expect(updateComment).toHaveBeenCalledWith({ ...REPO, comment_id: 2, body: "new body" });
    expect(createComment).not.toHaveBeenCalled();
  });

  it("creates nothing when there is no marked comment", async () => {
    const { octokit, updateComment, createComment } = fakeOctokit([
      { id: 1, body: "unrelated", html_url: "https://x/1" },
    ]);
    await expect(updateExistingComment(octokit, REPO, 7, "new body")).resolves.toBe(false);
    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe("upsertComment", () => {
  it("creates the comment when there is no marked comment", async () => {
    const { octokit, updateComment, createComment } = fakeOctokit([]);
    await upsertComment(octokit, REPO, 7, "body");
    expect(createComment).toHaveBeenCalledWith({ ...REPO, issue_number: 7, body: "body" });
    expect(updateComment).not.toHaveBeenCalled();
  });
});
