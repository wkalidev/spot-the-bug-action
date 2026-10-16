import * as core from "@actions/core";
import * as github from "@actions/github";
import { cleanDescription, explain, extractFunction, slitherWikiUrl } from "./explanations.js";
import type { Finding, FindingsSummary, Severity } from "./findings.js";

type Octokit = ReturnType<typeof github.getOctokit>;

export const COMMENT_MARKER = "<!-- spot-the-bug -->";
export const MAX_ROWS = 30;
/** GitHub rejects comments over 65536 characters; leave room for the tables. */
export const MAX_RAW_LENGTH = 40_000;

const SEVERITY_ICONS: Record<Severity, string> = {
  High: "🔴",
  Medium: "🟠",
  Low: "🟡",
  Informational: "ℹ️",
  Optimization: "⚡",
};

const FOOTER =
  "<sub>Scanned by [Spot the Bug](https://github.com/wkalidev/spot-the-bug-action) · " +
  "Need a full audit? hello@wkalidev.com</sub>";

export interface LinkContext {
  serverUrl: string;
  owner: string;
  repo: string;
  sha: string;
}

export interface RenderOptions {
  /** Wiki URL reported by Slither for each check id. */
  wikiUrls?: ReadonlyMap<string, string>;
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, "\\$&");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function blobUrl(file: string, line: number, link: LinkContext): string {
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  const anchor = line > 0 ? `#L${line}` : "";
  return `${link.serverUrl}/${link.owner}/${link.repo}/blob/${link.sha}/${encodedPath}${anchor}`;
}

function renderLocation(finding: Finding, link: LinkContext): string {
  if (!finding.file) return "—";
  const name = finding.file.slice(finding.file.lastIndexOf("/") + 1);
  const label = finding.line > 0 ? `${name}:${finding.line}` : name;
  return `[\`${label}\`](${blobUrl(finding.file, finding.line, link)})`;
}

/**
 * Plain-English title and affected function for known checks, or the cleaned
 * Slither text otherwise. Linked to the Slither wiki when its URL is known.
 */
export function renderIssue(finding: Finding, options: RenderOptions = {}): string {
  const explanation = explain(finding.id);
  const text = explanation?.title ?? (cleanDescription(finding.description) || finding.id);
  const wikiUrl = slitherWikiUrl(options.wikiUrls?.get(finding.id));
  const tooltip = explanation ? ` "${explanation.why.replace(/"/g, "'")}"` : "";
  const label = wikiUrl ? `[${escapeLinkText(text)}](${wikiUrl}${tooltip})` : text;
  if (!explanation) return label;

  const fn = extractFunction(finding.description);
  return fn ? `**${label}** — \`${fn}\`` : `**${label}**`;
}

function renderRow(finding: Finding, link: LinkContext, options: RenderOptions): string {
  const severity = `${SEVERITY_ICONS[finding.severity]} ${finding.severity}`;
  const issue = escapeCell(renderIssue(finding, options));
  return `| ${severity} | ${issue} | ${renderLocation(finding, link)} |`;
}

/** A findings table capped at MAX_ROWS rows, followed by the remainder count. */
function renderTable(findings: Finding[], link: LinkContext, options: RenderOptions): string[] {
  const lines = ["| Severity | Issue | Location |", "| --- | --- | --- |"];
  for (const finding of findings.slice(0, MAX_ROWS)) {
    lines.push(renderRow(finding, link, options));
  }
  if (findings.length > MAX_ROWS) {
    lines.push("", `…and ${findings.length - MAX_ROWS} more`);
  }
  return lines;
}

/**
 * Collapsed code block with the full Slither descriptions, so nothing is lost
 * by the short table. Capped at MAX_RAW_LENGTH to stay under GitHub's limit.
 */
export function renderRawOutput(findings: Finding[]): string[] {
  let raw = findings
    .map((f) => {
      const location = f.file ? ` ${f.file}${f.line > 0 ? `:${f.line}` : ""}` : "";
      return `[${f.severity}] ${f.id}${location}\n${f.description}`;
    })
    .join("\n\n");
  if (raw.length > MAX_RAW_LENGTH) {
    raw = `${raw.slice(0, MAX_RAW_LENGTH).trimEnd()}\n…(truncated)`;
  }
  // The fence must be longer than any backtick run inside the descriptions.
  const longestRun = Math.max(0, ...(raw.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [
    "<details>",
    "<summary>Raw Slither output</summary>",
    "",
    `${fence}text`,
    raw,
    fence,
    "",
    "</details>",
  ];
}

export function renderComment(
  summary: FindingsSummary,
  link: LinkContext,
  options: RenderOptions = {},
): string {
  const total = summary.reported.length;
  const lines: string[] = [COMMENT_MARKER];

  if (total === 0) {
    lines.push("## ✅ Spot the Bug — no issues found in changed files");
  } else {
    const noun = total === 1 ? "finding" : "findings";
    lines.push(`## 🔍 Spot the Bug — ${total} ${noun} in changed files`);
  }
  lines.push("");
  lines.push(
    `🔴 High: **${summary.counts.High}** · 🟠 Medium: **${summary.counts.Medium}** · ` +
      `🟡 Low: **${summary.counts.Low}**`,
  );

  const hidden = summary.informationalCount + summary.optimizationCount;
  if (hidden > 0) {
    lines.push("");
    lines.push(
      `<sub>Not shown: ${summary.informationalCount} informational, ` +
        `${summary.optimizationCount} optimization.</sub>`,
    );
  }

  // High and Medium stay visible; Low findings are collapsed below them,
  // unless they are the only findings, in which case they are shown directly.
  const prominent = summary.reported.filter((f) => f.severity !== "Low");
  const low = summary.reported.filter((f) => f.severity === "Low");

  if (prominent.length > 0) {
    lines.push("");
    lines.push(...renderTable(prominent, link, options));
  }
  if (low.length > 0 && prominent.length === 0) {
    lines.push("");
    lines.push(...renderTable(low, link, options));
  } else if (low.length > 0) {
    const noun = low.length === 1 ? "finding" : "findings";
    lines.push("");
    lines.push("<details>");
    lines.push(`<summary>🟡 ${low.length} low-severity ${noun}</summary>`);
    lines.push("");
    lines.push(...renderTable(low, link, options));
    lines.push("");
    lines.push("</details>");
  }
  if (total > 0) {
    lines.push("");
    lines.push(...renderRawOutput(summary.reported));
  }

  lines.push("");
  lines.push(FOOTER);
  return lines.join("\n") + "\n";
}

/**
 * Create the summary comment on the pull request, or update the existing one
 * that carries the hidden marker.
 */
export async function upsertComment(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  issueNumber: number,
  body: string,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
    core.info(`Updated summary comment ${existing.html_url}`);
  } else {
    const { data } = await octokit.rest.issues.createComment({
      ...repo,
      issue_number: issueNumber,
      body,
    });
    core.info(`Created summary comment ${data.html_url}`);
  }
}
