// The pure parts of the orchestrator of the gate tests: the label of test T2, the rule of an approval, the facts of a job,
// the lines of a round and the verdict of each test. The file scripts/gate.mjs does the calls of the GitHub CLI.

/** This is the line of the label in .github/workflows/fork-probe.yml. For test T2, the orchestrator changes only this line. */
export const LABEL_LINE = "    runs-on: run-${{ github.run_id }}-${{ github.run_attempt }}";

/** This is the name of the one step of each probe job. The step tells that the job operates. */
export const PROBE_STEP = "Tell the run";

const RUN_LABEL = /^run-[1-9]\d{0,19}-[1-9]\d{0,3}$/;

/** This is the `run-name` line of .github/workflows/t4-run.yml. */
export const AFTER_LINE = "run-name: T4 workflow_run after ${{ github.event.workflow_run.id }}";

/**
 * This function gives the name of the run of t4-run.yml that the end of a run starts.
 * The head of a run of `workflow_run` is the default branch, so only this name links the two runs.
 *
 * @param {number} runId - The id of the run that ended, a run of fork-probe.yml
 * @returns {string} The display title of the run of t4-run.yml
 */
export function afterTitle(runId) {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error(`The run id ${String(runId)} is not a positive integer.`);
  return `T4 workflow_run after ${String(runId)}`;
}

/**
 * This function gives the text of fork-probe.yml with a fixed run label in place of the label of its own run.
 *
 * @param {string} text - The text of fork-probe.yml
 * @param {string} label - The run label of a trusted run, as `run-<id>-<try>`
 * @returns {string} The changed text
 * @throws {Error} When the label has a bad shape, or the text does not have the line of the label one time
 */
export function withLabel(text, label) {
  if (!RUN_LABEL.test(label)) throw new Error(`The label ${JSON.stringify(label)} is not a run label run-<id>-<try>.`);
  const lines = text.split("\n");
  const at = lines.flatMap((line, index) => (line.replace(/\r$/, "") === LABEL_LINE ? [index] : []));
  if (at.length !== 1) throw new Error(`The text has the line of the label ${at.length} times, not one time.`);
  const cr = lines[at[0]].endsWith("\r") ? "\r" : "";
  lines[at[0]] = `    runs-on: ${label}${cr}`;
  return lines.join("\n");
}

/**
 * This function tells if the orchestrator can approve a run. It approves only a run of a pull request whose head
 * repository is the test fork, and whose head commit is a commit that the orchestrator pushed.
 *
 * @param {{ event?: unknown, head_sha?: unknown, head_repository?: { full_name?: unknown } | null }} run - A run from the API
 * @param {{ fork: string, pushed: readonly string[] }} test - The fork and the commits of this test
 * @returns {boolean} `true` only when each condition holds
 */
export function mayApprove(run, test) {
  const head = run?.head_repository?.full_name;
  return (
    run?.event === "pull_request" &&
    typeof head === "string" &&
    head.toLowerCase() === test.fork.toLowerCase() &&
    typeof run.head_sha === "string" &&
    test.pushed.includes(run.head_sha)
  );
}

/**
 * This function keeps the facts of a job of the API that a record needs.
 *
 * @param {Record<string, any>} job - A job from `GET /repos/{repo}/actions/runs/{id}/jobs`
 */
export function jobFacts(job) {
  return {
    id: job.id,
    run: job.run_id,
    attempt: job.run_attempt,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion ?? null,
    labels: job.labels ?? [],
    runner: job.runner_name || null,
    steps: (job.steps ?? []).map((step) => ({ name: step.name, status: step.status, conclusion: step.conclusion ?? null })),
  };
}

/**
 * This function tells if the probe step of a job started. A step that the API does not list, or that has the
 * conclusion `skipped`, did not start.
 *
 * @param {ReturnType<typeof jobFacts>} job - The facts of the job
 */
export function probeStarted(job) {
  return job.steps.some((step) => step.name === PROBE_STEP && step.conclusion !== "skipped" && step.status !== "queued" && step.status !== "pending");
}

/**
 * This function reads the lines of JSON of a round from the log of its job. Each line of the log can start with a time.
 *
 * @param {string} log - The text of the log of the job
 * @returns {Array<Record<string, any>>} The lines with a field `event`, in their order
 */
export function roundLines(log) {
  const out = [];
  for (const raw of log.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, "");
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && typeof value.event === "string") out.push(value);
    } catch {
      // A line that is not JSON is a line of the runner or of a tool, not of the dispatcher.
    }
  }
  return out;
}

/**
 * This function gives the waits and the machines of the passes of a round for one run.
 *
 * @param {Array<Record<string, any>>} lines - The lines of the round
 * @param {number} runId - The id of the run
 */
export function runInRound(lines, runId) {
  const passes = lines.filter((line) => line.event === "pass");
  const waits = passes.flatMap((line) => line.report?.waits ?? []).filter((wait) => wait?.run?.runId === runId);
  const made = passes.flatMap((line) => line.report?.made ?? []).filter((machine) => machine?.runId === runId);
  const round = lines.find((line) => line.event === "round")?.result ?? null;
  return { reasons: [...new Set(waits.map((wait) => wait.reason))].sort(), texts: [...new Set(waits.map((wait) => wait.text))], made: made.length, round };
}

/**
 * This function gives the verdict of test T1 or of one run of test T4: the dispatcher refuses the run for trust, and
 * the job gets no runner and starts no step.
 *
 * @param {ReturnType<typeof jobFacts>} job - The facts of the job at the end of the test
 * @param {ReturnType<typeof runInRound>} seen - The run in the round
 */
export function refusedVerdict(job, seen) {
  const checks = {
    readByRound: seen.reasons.length > 0 || seen.made > 0,
    reasonTrust: seen.reasons.length === 1 && seen.reasons[0] === "trust",
    noMachine: seen.made === 0,
    noRunner: job.runner === null,
    noStep: !probeStarted(job),
  };
  return { pass: Object.values(checks).every(Boolean), read: checks.readByRound, checks };
}

/**
 * This function gives the verdict of test T2. The fork job names the run label of the trusted run.
 *
 * - When the fork job took the runner, the check refused it: the job has the conclusion failure and its step did not start.
 * - In each case, the probe step of the fork job did not start, and the trusted job ends with success on a runner.
 * - The dispatcher made no machine for the fork run.
 *
 * @param {{ fork: ReturnType<typeof jobFacts>, trusted: ReturnType<typeof jobFacts>, forkSeen: Array<ReturnType<typeof runInRound>> }} facts - The facts at the end of the test
 */
export function labelVerdict(facts) {
  const tookRunner = facts.fork.runner !== null;
  const checks = {
    forkStepNotStarted: !probeStarted(facts.fork),
    forkRefusedOnRunner: !tookRunner || facts.fork.conclusion === "failure",
    noMachineForFork: facts.forkSeen.every((seen) => seen.made === 0),
    trustedSuccess: facts.trusted.conclusion === "success" && facts.trusted.runner !== null,
  };
  // A test where the fork job did not take the runner does not exercise the check on the machine. It is no read of that layer.
  return { pass: Object.values(checks).every(Boolean), forkTookRunner: tookRunner, checks };
}
