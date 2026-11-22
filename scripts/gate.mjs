#!/usr/bin/env node
// The orchestrator of the gate tests T1, T2 and T4. It drives the runs with the GitHub CLI and writes one record of JSON.
//
//   node scripts/gate.mjs t1 --fork <owner>/<repo> --out <folder>    T1, then T4 on the runs of the same pull request
//   node scripts/gate.mjs t2 --fork <owner>/<repo> --out <folder>    T2: a fork job names the run label of a trusted run
//
// The GitHub CLI uses its own login. The orchestrator approves a run only when mayApprove of gate-lib.mjs is true.
// It closes its pull request, removes its branch of the fork and cancels each run of the test that still waits.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterTitle, jobFacts, labelVerdict, mayApprove, refusedVerdict, roundLines, runInRound, withLabel } from "./gate-lib.mjs";

const USAGE = "Usage: node scripts/gate.mjs <t1|t2> --fork <owner>/<repo> --out <folder> [--repo <owner>/<repo>] [--hold <s>]";
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function parseArgs(argv) {
  const [test, ...rest] = argv;
  const options = { repo: "mark1russell7/runner-gate-test", hold: "180" };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.replace(/^--/, "");
    const value = rest[index + 1];
    if (!["fork", "out", "repo", "hold"].includes(key ?? "") || value === undefined) throw new Error(USAGE);
    options[key] = value;
  }
  if (!["t1", "t2"].includes(test) || !options.fork || !options.out) throw new Error(USAGE);
  if (!NAME.test(options.fork) || !NAME.test(options.repo)) throw new Error("The fork and the repository are names <owner>/<repo>.");
  if (!/^\d{1,3}$/.test(options.hold) || Number(options.hold) > 600) throw new Error("The hold is a whole number of seconds from 0 to 600.");
  return { test, ...options };
}

/** This function starts the GitHub CLI with an argv, and gives its stdout. The body goes to stdin as JSON. */
function gh(args, body) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: body === undefined ? undefined : JSON.stringify(body), stdio: ["pipe", "pipe", "pipe"] });
}

const api = (path) => JSON.parse(gh(["api", path]));
const send = (method, path, body) => {
  const out = gh(["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])], body);
  return out.trim() === "" ? null : JSON.parse(out);
};

/** This function asks `read` again each `every` milliseconds, until it gives a value or the limit ends. */
async function waitFor(what, read, { every = 10_000, limit = 15 * 60_000 } = {}) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > end) throw new Error(`The wait for ${what} ended after ${Math.round(limit / 1000)} s.`);
    await sleep(every);
  }
}

const runsOf = (repo, workflow, event) => api(`repos/${repo}/actions/workflows/${workflow}/runs?event=${event}&per_page=30`).workflow_runs;
const jobsOf = (repo, runId) => api(`repos/${repo}/actions/runs/${runId}/jobs?per_page=30`).jobs.map(jobFacts);

/** This function waits for a new run of a workflow whose title has the nonce of the test. */
const titledRun = (repo, workflow, event, nonce, limit) =>
  waitFor(`a run of ${workflow} for ${nonce}`, () => runsOf(repo, workflow, event).find((run) => String(run.display_title ?? "").includes(nonce)), { limit });

/** This function waits for the run of t4-run.yml that the end of a run starts. Its head is the default branch, so the match is on its name. */
const afterRun = (repo, runId, limit) =>
  waitFor(`the run of t4-run.yml after ${runId}`, () => runsOf(repo, "t4-run.yml", "workflow_run").find((run) => run.display_title === afterTitle(runId)), { limit });

/** This function waits until the job of a run asks for a runner. */
const queuedJob = (repo, runId, limit) => waitFor(`a queued job of the run ${runId}`, () => jobsOf(repo, runId).find((job) => job.status === "queued"), { limit });

/** This function starts one round and gives its run, its lines and the URL. */
async function round(repo) {
  const before = new Set(runsOf(repo, "round.yml", "workflow_dispatch").map((run) => run.id));
  send("POST", `repos/${repo}/actions/workflows/round.yml/dispatches`, { ref: "main" });
  const run = await waitFor("a new run of round.yml", () => runsOf(repo, "round.yml", "workflow_dispatch").find((each) => !before.has(each.id)), { limit: 3 * 60_000 });
  const done = await waitFor(`the end of the round ${run.id}`, () => {
    const now = api(`repos/${repo}/actions/runs/${run.id}`);
    return now.status === "completed" ? now : null;
  }, { every: 15_000, limit: 30 * 60_000 });
  const job = jobsOf(repo, run.id)[0];
  const log = job ? gh(["api", `repos/${repo}/actions/jobs/${job.id}/logs`]) : "";
  return { id: run.id, url: done.html_url, conclusion: done.conclusion, lines: roundLines(log) };
}

/** This function makes a branch of the fork from its main branch, after a sync with the base repository. */
function forkBranch(fork, branch) {
  send("POST", `repos/${fork}/merge-upstream`, { branch: "main" });
  const main = api(`repos/${fork}/git/ref/heads/main`).object.sha;
  send("POST", `repos/${fork}/git/refs`, { ref: `refs/heads/${branch}`, sha: main });
}

/** This function writes one file on a branch of the fork, and gives the sha of the new commit. */
function forkWrite(fork, branch, path, text, message) {
  let sha;
  try {
    sha = api(`repos/${fork}/contents/${path}?ref=${branch}`).sha;
  } catch {
    sha = undefined;
  }
  const body = { message, branch, content: Buffer.from(text, "utf8").toString("base64"), ...(sha ? { sha } : {}) };
  return send("PUT", `repos/${fork}/contents/${path}`, body).commit.sha;
}

/** This function approves the fork run when it waits for an approval, and only when mayApprove is true. */
async function approveIfAsked(repo, run, test, approvals) {
  const now = api(`repos/${repo}/actions/runs/${run.id}`);
  if (now.status !== "action_required" && now.status !== "waiting") return;
  if (!mayApprove(now, test)) throw new Error(`The run ${run.id} waits for an approval, but its head is not a commit of this test. The orchestrator does not approve it.`);
  send("POST", `repos/${repo}/actions/runs/${run.id}/approve`);
  approvals.push({ run: run.id, head: now.head_sha, at: new Date().toISOString() });
}

/** This function cancels each run of the list that did not end. A failure of a cancel goes to the record, not to an exception. */
function cancelOpen(repo, runIds, notes) {
  for (const id of runIds) {
    try {
      if (api(`repos/${repo}/actions/runs/${id}`).status !== "completed") send("POST", `repos/${repo}/actions/runs/${id}/cancel`);
    } catch (error) {
      notes.push(`The cancel of the run ${id} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
}

async function openPull(options, nonce, pushed, title) {
  const owner = options.fork.split("/")[0];
  const pull = send("POST", `repos/${options.repo}/pulls`, {
    title,
    head: `${owner}:gate-${options.test}-${nonce}`,
    base: "main",
    body: "A fixture pull request of the gate tests. The orchestrator closes it.",
  });
  return { number: pull.number, url: pull.html_url, pushed };
}

async function cleanUp(options, nonce, pull, notes) {
  try {
    if (pull) send("PATCH", `repos/${options.repo}/pulls/${pull.number}`, { state: "closed" });
  } catch (error) {
    notes.push(`The close of the pull request failed: ${String(error).split("\n")[0]}`);
  }
  try {
    send("DELETE", `repos/${options.fork}/git/refs/heads/gate-${options.test}-${nonce}`);
  } catch (error) {
    notes.push(`The removal of the branch of the fork failed: ${String(error).split("\n")[0]}`);
  }
}

async function testT1(options, nonce, record) {
  const branch = `gate-t1-${nonce}`;
  forkBranch(options.fork, branch);
  const pushed = [forkWrite(options.fork, branch, `probes/t1-${nonce}.txt`, `${nonce}\n`, `Gate test T1 ${nonce}`)];
  record.pull = await openPull(options, nonce, pushed, `Gate test T1 ${nonce}`);
  const probe = await titledRun(options.repo, "fork-probe.yml", "pull_request", nonce, 5 * 60_000);
  const target = await titledRun(options.repo, "t4-target.yml", "pull_request_target", nonce, 5 * 60_000);
  record.runs.push(probe.id, target.id);
  await approveIfAsked(options.repo, probe, { fork: options.fork, pushed }, record.approvals);
  await queuedJob(options.repo, probe.id, 5 * 60_000);
  await queuedJob(options.repo, target.id, 5 * 60_000);

  const first = await round(options.repo);
  record.rounds.push({ id: first.id, url: first.url, conclusion: first.conclusion, round: first.lines.find((line) => line.event === "round")?.result ?? null });
  const probeJob = jobsOf(options.repo, probe.id)[0];
  const targetJob = jobsOf(options.repo, target.id)[0];
  record.verdicts.T1 = { run: probe.id, job: probeJob, seen: runInRound(first.lines, probe.id), ...refusedVerdict(probeJob, runInRound(first.lines, probe.id)) };
  record.verdicts["T4 pull_request_target"] = { run: target.id, job: targetJob, seen: runInRound(first.lines, target.id), ...refusedVerdict(targetJob, runInRound(first.lines, target.id)) };

  // The end of the fork probe starts the workflow T4 workflow_run.
  send("POST", `repos/${options.repo}/actions/runs/${probe.id}/cancel`);
  const after = await afterRun(options.repo, probe.id, 5 * 60_000);
  record.runs.push(after.id);
  await queuedJob(options.repo, after.id, 5 * 60_000);
  const second = await round(options.repo);
  record.rounds.push({ id: second.id, url: second.url, conclusion: second.conclusion, round: second.lines.find((line) => line.event === "round")?.result ?? null });
  const afterJob = jobsOf(options.repo, after.id)[0];
  record.verdicts["T4 workflow_run"] = { run: after.id, job: afterJob, seen: runInRound(second.lines, after.id), ...refusedVerdict(afterJob, runInRound(second.lines, after.id)) };
}

async function testT2(options, nonce, record) {
  const before = new Set(runsOf(options.repo, "trusted.yml", "workflow_dispatch").map((run) => run.id));
  send("POST", `repos/${options.repo}/actions/workflows/trusted.yml/dispatches`, { ref: "main", inputs: { hold: options.hold } });
  const trusted = await waitFor("a new run of trusted.yml", () => runsOf(options.repo, "trusted.yml", "workflow_dispatch").find((run) => !before.has(run.id)), { limit: 3 * 60_000 });
  record.runs.push(trusted.id);
  const label = `run-${trusted.id}-${trusted.run_attempt ?? 1}`;
  record.label = label;

  const branch = `gate-t2-${nonce}`;
  forkBranch(options.fork, branch);
  const file = ".github/workflows/fork-probe.yml";
  const text = Buffer.from(api(`repos/${options.fork}/contents/${file}?ref=${branch}`).content, "base64").toString("utf8");
  const pushed = [forkWrite(options.fork, branch, file, withLabel(text, label), `Gate test T2 ${nonce}`)];
  record.pull = await openPull(options, nonce, pushed, `Gate test T2 ${nonce}`);
  const probe = await titledRun(options.repo, "fork-probe.yml", "pull_request", nonce, 5 * 60_000);
  record.runs.push(probe.id);
  await approveIfAsked(options.repo, probe, { fork: options.fork, pushed }, record.approvals);
  await queuedJob(options.repo, probe.id, 5 * 60_000);
  // The fork job asks first. The job target of the trusted run asks after its hold.
  const targetQueued = await waitFor("the queued job target of the trusted run", () => jobsOf(options.repo, trusted.id).find((job) => job.name === "Target" && job.status === "queued"), { limit: 15 * 60_000 });
  record.order = { forkQueued: true, targetQueued: targetQueued.id };

  const forkSeen = [];
  for (let index = 0; index < 2; index += 1) {
    const done = await round(options.repo);
    record.rounds.push({ id: done.id, url: done.url, conclusion: done.conclusion, round: done.lines.find((line) => line.event === "round")?.result ?? null });
    forkSeen.push(runInRound(done.lines, probe.id));
    const target = jobsOf(options.repo, trusted.id).find((job) => job.name === "Target");
    if (target?.status === "completed") break;
  }
  const fork = jobsOf(options.repo, probe.id)[0];
  const target = jobsOf(options.repo, trusted.id).find((job) => job.name === "Target");
  record.verdicts.T2 = { fork, trusted: target, forkSeen, ...labelVerdict({ fork, trusted: target, forkSeen }) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
  const record = { format: "gate-test-record/1", test: options.test, nonce, repo: options.repo, fork: options.fork, startedAt: new Date().toISOString(), pull: null, runs: [], approvals: [], rounds: [], verdicts: {}, notes: [] };
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const path = join(out, `${options.test}-${nonce}.json`);
  try {
    if (options.test === "t1") await testT1(options, nonce, record);
    else await testT2(options, nonce, record);
  } catch (error) {
    record.notes.push(`The test stopped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    process.exitCode = 1;
  } finally {
    cancelOpen(options.repo, record.runs, record.notes);
    await cleanUp(options, nonce, record.pull, record.notes);
    // The end of a fork probe starts one more run of T4 workflow_run, and the pull request of T2 starts a run of T4
    // pull_request_target. Each waits for a runner, so cancel them too.
    try {
      await sleep(20_000);
      const titles = new Set(record.runs.map((id) => afterTitle(id)));
      const late = [
        ...runsOf(options.repo, "t4-run.yml", "workflow_run").filter((run) => titles.has(run.display_title)),
        ...runsOf(options.repo, "t4-target.yml", "pull_request_target").filter((run) => String(run.display_title ?? "").includes(nonce)),
      ].filter((run) => !record.runs.includes(run.id));
      cancelOpen(options.repo, late.map((run) => run.id), record.notes);
    } catch (error) {
      record.notes.push(`The read of the late runs failed: ${String(error).split("\n")[0]}`);
    }
    record.endedAt = new Date().toISOString();
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(path);
  }
}

await main();
