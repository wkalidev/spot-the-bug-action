import * as core from "@actions/core";
import * as github from "@actions/github";
import * as path from "node:path";
import { getChangedFiles, isPullRequestEvent } from "./changed-files.js";
import {
  renderComment,
  renderNoSolidityComment,
  updateExistingComment,
  upsertComment,
} from "./comment.js";
import { summarizeFindings } from "./findings.js";
import { runSlither } from "./slither.js";
import { countAtOrAbove, parseFailOn, shouldFail } from "./threshold.js";

export const NO_SOLIDITY_SUMMARY = "Spot the Bug: No Solidity files changed — nothing to scan";

function setZeroOutputs(): void {
  core.setOutput("findings-count", 0);
  core.setOutput("high-count", 0);
}

export async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const workingDirectoryInput = core.getInput("working-directory") || ".";
  const slitherArgs = core.getInput("slither-args");
  // Validate early so a typo does not surface only after a long scan.
  const failOn = parseFailOn(core.getInput("fail-on"));

  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  const workingDirectory = path.resolve(repoRoot, workingDirectoryInput);

  const octokit = github.getOctokit(token);
  const context = github.context;

  const pullRequest = isPullRequestEvent(context) ? context.payload.pull_request : undefined;

  const changed = await getChangedFiles(octokit, context);
  if (!changed.all && changed.files.size === 0) {
    core.info("No Solidity files changed in this pull request. Nothing to scan.");
    // Never post a new comment here, but replace an earlier report so it does not go stale.
    if (pullRequest) {
      try {
        await updateExistingComment(
          octokit,
          context.repo,
          pullRequest.number,
          renderNoSolidityComment(),
        );
      } catch (error) {
        core.warning(
          `Could not update the PR comment: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await core.summary.addRaw(`${NO_SOLIDITY_SUMMARY}\n`).write();
    }
    setZeroOutputs();
    return;
  }

  const { detectors, wikiUrls } = await runSlither(workingDirectory, slitherArgs);
  core.info(`Slither reported ${detectors.length} detector results.`);

  const summary = summarizeFindings(detectors, changed, {
    repoRoot,
    workingDirectory: path.relative(repoRoot, workingDirectory) || ".",
  });
  core.info(
    `Findings in scope: ${summary.counts.High} high, ${summary.counts.Medium} medium, ` +
      `${summary.counts.Low} low, ${summary.informationalCount} informational, ` +
      `${summary.optimizationCount} optimization.`,
  );

  const body = renderComment(
    summary,
    {
      serverUrl: context.serverUrl,
      ...context.repo,
      sha: (pullRequest?.head as { sha?: string } | undefined)?.sha ?? context.sha,
    },
    { wikiUrls },
  );

  if (pullRequest) {
    try {
      await upsertComment(octokit, context.repo, pullRequest.number, body);
    } catch (error) {
      // Typical cause: fork PRs with a read-only token. Do not hide the scan result.
      core.warning(
        `Could not post the PR comment (does the job have "pull-requests: write"?): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary.addRaw(body).write();
  }

  core.setOutput("findings-count", summary.reported.length);
  core.setOutput("high-count", summary.counts.High);

  if (shouldFail(summary.counts, failOn)) {
    core.setFailed(
      `Spot the Bug found ${countAtOrAbove(summary.counts, failOn)} finding(s) ` +
        `at or above "${failOn}" severity in changed files.`,
    );
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
