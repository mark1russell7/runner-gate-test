import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AFTER_LINE,
  afterTitle,
  jobFacts,
  labelVerdict,
  mayApprove,
  PROBE_STEP,
  probeStarted,
  refusedVerdict,
  roundLines,
  runInRound,
  TOKEN_DAYS,
  tokenFresh,
  tokenRefused,
} from "../scripts/gate-lib.mjs";

const fork = "gate-fork-owner/runner-gate-test";
const pushed = ["a".repeat(40)];

describe("mayApprove", () => {
  const run = { event: "pull_request", head_sha: pushed[0], head_repository: { full_name: fork } };

  it("approves a run of the fork on a pushed commit", () => {
    expect(mayApprove(run, { fork, pushed })).toBe(true);
    expect(mayApprove({ ...run, head_repository: { full_name: fork.toUpperCase() } }, { fork, pushed })).toBe(true);
  });

  it("refuses each other run", () => {
    expect(mayApprove({ ...run, head_sha: "b".repeat(40) }, { fork, pushed })).toBe(false);
    expect(mayApprove({ ...run, head_repository: { full_name: "someone/runner-gate-test" } }, { fork, pushed })).toBe(false);
    expect(mayApprove({ ...run, head_repository: null }, { fork, pushed })).toBe(false);
    expect(mayApprove({ ...run, event: "pull_request_target" }, { fork, pushed })).toBe(false);
    expect(mayApprove({ ...run, head_sha: undefined }, { fork, pushed: [] })).toBe(false);
  });
});

const job = (over: Record<string, unknown> = {}) =>
  jobFacts({ id: 7, run_id: 70, run_attempt: 1, name: "Probe", status: "queued", conclusion: null, labels: ["run-70-1"], runner_name: "", steps: [], ...over });

const pass = (waits: unknown[], made: unknown[] = []) => JSON.stringify({ event: "pass", report: { waits, made }, machines: made.length, jobs: 1 });

describe("the lines of a round", () => {
  it("reads the JSON lines of the dispatcher, with or without a time", () => {
    const log = [
      "2026-11-21T20:01:02.1234567Z ##[group]Run node dispatch/bin.ts",
      `2026-11-21T20:01:03.0000000Z ${pass([{ run: { repository: "o/r", runId: 70, runAttempt: 1 }, jobs: 1, reason: "trust", text: "t" }])}`,
      `${JSON.stringify({ event: "round", result: { settled: true } })}\r`,
      "{not json",
      JSON.stringify({ no: "event" }),
    ].join("\n");
    const lines = roundLines(log);
    expect(lines.map((line) => line.event)).toEqual(["pass", "round"]);
    expect(runInRound(lines, 70)).toEqual({ reasons: ["trust"], texts: ["t"], made: 0, round: { settled: true }, tokenRefused: false });
    expect(runInRound(lines, 71)).toMatchObject({ reasons: [], made: 0 });
  });
});

// The dispatcher puts the text of an error in quotes, as in the record of a round on 2026-11-21.
const failed = (status: number) =>
  JSON.stringify({ event: "pass", report: { waits: [], made: [], failures: [{ request: "view", text: `"GitHub answered the list /repos/o/r/actions/runs with the status ${status}."` }] } });

describe("the token", () => {
  const setAt = "2026-11-22T01:10:31Z";
  const set = Date.parse(setAt);
  const hours = (count: number) => count * 3_600_000;

  it("lets a test start when the token can stay valid until its end", () => {
    expect(tokenFresh(setAt, set + hours(24), hours(2))).toMatchObject({ ok: true, latestEnd: "2026-11-29T01:10:31.000Z" });
    expect(tokenFresh(setAt, set + TOKEN_DAYS * hours(24) - hours(2), hours(2)).ok).toBe(true);
  });

  it("stops a test that can end after the token", () => {
    const late = tokenFresh(setAt, set + TOKEN_DAYS * hours(24) - hours(1), hours(2));
    expect(late.ok).toBe(false);
    expect(late.text).toMatch(/no read/);
    expect(() => tokenFresh("not a time", set, 0)).toThrow(/not a time/);
  });

  it("finds a round where GitHub refused the token", () => {
    expect(tokenRefused(roundLines(failed(401)))).toBe(true);
    expect(tokenRefused(roundLines(failed(403)))).toBe(true);
    expect(tokenRefused(roundLines(failed(404)))).toBe(false);
    expect(tokenRefused(roundLines(failed(4010)))).toBe(false);
    expect(tokenRefused(roundLines(pass([])))).toBe(false);
  });

  it("makes a round with a refused token no read, never a pass", () => {
    const refused = { ...runInRound(roundLines(pass([{ run: { runId: 70 }, jobs: 1, reason: "trust", text: "t" }])), 70), tokenRefused: true };
    expect(refusedVerdict(job(), refused)).toMatchObject({ pass: false, read: false });
    const taken = job({ status: "completed", conclusion: "failure", runner_name: "gate-1" });
    const trusted = job({ id: 8, run_id: 80, name: "Target", status: "completed", conclusion: "success", runner_name: "gate-2" });
    const seen = runInRound(roundLines(failed(401)), 70);
    expect(labelVerdict({ fork: taken, trusted, forkSeen: [seen] })).toMatchObject({ pass: false, read: false });
  });
});

describe("refusedVerdict", () => {
  const refused = runInRound(roundLines(pass([{ run: { runId: 70 }, jobs: 1, reason: "trust", text: "t" }])), 70);

  it("passes a run that waits for trust, with no runner and no step", () => {
    expect(refusedVerdict(job({ status: "completed", conclusion: "cancelled" }), refused)).toMatchObject({ pass: true, read: true });
  });

  it("gives no read when the round did not see the run", () => {
    expect(refusedVerdict(job(), runInRound([], 70))).toMatchObject({ pass: false, read: false });
  });

  it("fails a run with a machine, a runner, a started step or another reason", () => {
    const made = runInRound(roundLines(pass([], [{ runId: 70, name: "gate-1" }])), 70);
    expect(refusedVerdict(job(), made).pass).toBe(false);
    expect(refusedVerdict(job({ runner_name: "gate-1" }), refused).pass).toBe(false);
    expect(refusedVerdict(job({ steps: [{ name: PROBE_STEP, status: "completed", conclusion: "success" }] }), refused).pass).toBe(false);
    const label = runInRound(roundLines(pass([{ run: { runId: 70 }, jobs: 1, reason: "label", text: "l" }])), 70);
    expect(refusedVerdict(job(), label).pass).toBe(false);
  });
});

describe("labelVerdict", () => {
  const trusted = job({ id: 8, run_id: 80, name: "Target", status: "completed", conclusion: "success", runner_name: "gate-2" });
  const none = [runInRound([], 70)];

  it("passes when the fork job took the runner and the check refused it before its step", () => {
    const taken = job({ status: "completed", conclusion: "failure", runner_name: "gate-1", steps: [{ name: "Set up job", status: "completed", conclusion: "failure" }] });
    expect(labelVerdict({ fork: taken, trusted, forkSeen: none })).toMatchObject({ pass: true, forkTookRunner: true });
  });

  it("passes with no read of the check when the trusted job took the runner first", () => {
    expect(labelVerdict({ fork: job({ status: "completed", conclusion: "cancelled" }), trusted, forkSeen: none })).toMatchObject({ pass: true, forkTookRunner: false });
  });

  it("fails when the step of the fork job started, or the trusted job did not end with success", () => {
    const ran = job({ status: "completed", conclusion: "success", runner_name: "gate-1", steps: [{ name: PROBE_STEP, status: "completed", conclusion: "success" }] });
    expect(probeStarted(ran)).toBe(true);
    expect(labelVerdict({ fork: ran, trusted, forkSeen: none }).pass).toBe(false);
    expect(labelVerdict({ fork: job(), trusted: { ...trusted, conclusion: "cancelled" }, forkSeen: none }).pass).toBe(false);
  });
});

describe("the run of t4-run.yml after a run", () => {
  it("has the name that the orchestrator finds", () => {
    const lines = readFileSync(new URL("../.github/workflows/t4-run.yml", import.meta.url), "utf8").split(/\r?\n/);
    expect(lines.filter((line) => line === AFTER_LINE)).toHaveLength(1);
    // GitHub puts the id of the run that ended in place of the expression.
    expect(AFTER_LINE.replace("run-name: ", "").replace("${{ github.event.workflow_run.id }}", "44970582338")).toBe(afterTitle(44970582338));
  });

  it("refuses an id that is not a positive integer", () => {
    expect(() => afterTitle(0)).toThrow(/positive integer/);
    expect(() => afterTitle(1.5)).toThrow(/positive integer/);
    expect(() => afterTitle(Number.NaN)).toThrow(/positive integer/);
  });
});
