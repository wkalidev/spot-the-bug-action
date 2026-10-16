import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const summary = {
    addRaw: vi.fn(),
    write: vi.fn(),
  };
  return {
    summary,
    core: {
      getInput: vi.fn(),
      setOutput: vi.fn(),
      setFailed: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      summary,
    },
    getChangedFiles: vi.fn(),
    upsertComment: vi.fn(),
    updateExistingComment: vi.fn(),
    runSlither: vi.fn(),
  };
});

vi.mock("@actions/core", () => mocks.core);
vi.mock("@actions/github", () => ({
  getOctokit: vi.fn(() => ({})),
  context: {
    eventName: "pull_request",
    repo: { owner: "acme", repo: "demo" },
    payload: { pull_request: { number: 1 } },
  },
}));
vi.mock("../src/changed-files.js", () => ({
  getChangedFiles: mocks.getChangedFiles,
  isPullRequestEvent: () => true,
}));
vi.mock("../src/comment.js", () => ({
  renderComment: vi.fn(() => "body"),
  renderNoSolidityComment: vi.fn(() => "no-solidity body"),
  updateExistingComment: mocks.updateExistingComment,
  upsertComment: mocks.upsertComment,
}));
vi.mock("../src/slither.js", () => ({ runSlither: mocks.runSlither }));

const INPUTS: Record<string, string> = {
  "github-token": "token",
  "working-directory": ".",
  "fail-on": "high",
  "slither-args": "",
};

/** Import main.ts, which runs the action, and wait until it sets its outputs. */
async function runAction(): Promise<typeof import("../src/main.js")> {
  vi.resetModules();
  const main = await import("../src/main.js");
  await vi.waitFor(() => expect(mocks.core.setOutput).toHaveBeenCalledWith("high-count", 0));
  return main;
}

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.core.getInput.mockImplementation((name: string) => INPUTS[name] ?? "");
    mocks.summary.addRaw.mockReturnValue(mocks.summary);
    mocks.summary.write.mockResolvedValue(mocks.summary);
    mocks.getChangedFiles.mockResolvedValue({ all: false, files: new Set() });
    mocks.updateExistingComment.mockResolvedValue(false);
    vi.stubEnv("GITHUB_STEP_SUMMARY", "/tmp/summary.md");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes a one-line job summary and no comment when no Solidity file changed", async () => {
    const { NO_SOLIDITY_SUMMARY } = await runAction();

    expect(NO_SOLIDITY_SUMMARY).toBe("Spot the Bug: No Solidity files changed — nothing to scan");
    expect(mocks.summary.addRaw).toHaveBeenCalledOnce();
    expect(mocks.summary.addRaw).toHaveBeenCalledWith(`${NO_SOLIDITY_SUMMARY}\n`);
    expect(mocks.summary.write).toHaveBeenCalledOnce();
    expect(mocks.upsertComment).not.toHaveBeenCalled();
    expect(mocks.runSlither).not.toHaveBeenCalled();
    expect(mocks.core.setOutput).toHaveBeenCalledWith("findings-count", 0);
    expect(mocks.core.setFailed).not.toHaveBeenCalled();
  });

  it("skips the job summary when GITHUB_STEP_SUMMARY is not set", async () => {
    vi.stubEnv("GITHUB_STEP_SUMMARY", "");
    await runAction();

    expect(mocks.summary.addRaw).not.toHaveBeenCalled();
    expect(mocks.upsertComment).not.toHaveBeenCalled();
    expect(mocks.core.setFailed).not.toHaveBeenCalled();
  });

  it("replaces an existing report when the PR no longer changes Solidity files", async () => {
    mocks.updateExistingComment.mockResolvedValue(true);
    const { NO_SOLIDITY_SUMMARY } = await runAction();

    expect(mocks.updateExistingComment).toHaveBeenCalledOnce();
    expect(mocks.updateExistingComment).toHaveBeenCalledWith(
      {},
      { owner: "acme", repo: "demo" },
      1,
      "no-solidity body",
    );
    expect(mocks.upsertComment).not.toHaveBeenCalled();
    expect(mocks.summary.addRaw).toHaveBeenCalledWith(`${NO_SOLIDITY_SUMMARY}\n`);
    expect(mocks.core.setFailed).not.toHaveBeenCalled();
  });

  it("creates no comment when the PR has no earlier report", async () => {
    await runAction();

    // updateExistingComment found nothing (false); nothing may create a comment instead.
    expect(mocks.updateExistingComment).toHaveBeenCalledOnce();
    expect(mocks.upsertComment).not.toHaveBeenCalled();
    expect(mocks.core.setFailed).not.toHaveBeenCalled();
  });

  it("keeps the job green when the comment cannot be updated", async () => {
    mocks.updateExistingComment.mockRejectedValue(new Error("Resource not accessible"));
    await runAction();

    expect(mocks.core.warning).toHaveBeenCalledWith(
      "Could not update the PR comment: Resource not accessible",
    );
    expect(mocks.summary.write).toHaveBeenCalledOnce();
    expect(mocks.core.setFailed).not.toHaveBeenCalled();
  });
});
