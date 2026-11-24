/**
 * The guard of the workflows of this repository. It examines the facts that `parseWorkflow` of
 * `@mark1russell7/conventions` reads with the YAML parser, and it gives one fault for each broken rule.
 *
 * The rules:
 *
 * - `parses`: the file parses as one YAML 1.2 document. A file with a fault gets no other rule.
 * - `permissions`: the workflow has the permissions `{}`, and each job has no permissions or `{}`. A job of
 *   {@link HOSTED_JOBS} can have the scopes of its record.
 * - `privileged-checkout`: a workflow with a privileged trigger has no checkout.
 * - `privileged-secrets`: a workflow with a privileged trigger reads no secret.
 * - `privileged-calls`: a workflow with a privileged trigger calls no workflow and no action. Their steps are out of sight of the guard.
 * - `secret-triggers`: a workflow that reads a secret starts only by `workflow_dispatch`.
 * - `starter-order`: no step with a secret comes at or after the step that starts the runners, and the job and the
 *   workflow read no secret outside the steps before it.
 *
 * A limit of `starter-order`: the facts give the secrets of a job with the secrets of its steps. Thus a secret in the
 * `env` of the job and in a step before the start, with the same name, passes. The rule cannot see it until the reader
 * gives the secrets of the `env` of a job apart. The blast radius of the README is the same in each case: the outer
 * job has the token in its memory for the whole job.
 *
 * A limit of `permissions`: the reader gives no runner of a job (`runs-on`). Thus the guard cannot tell a job on a
 * runner of GitHub from a job on a runner of the pool. {@link HOSTED_JOBS} names each job on a runner of GitHub that
 * needs a scope. The list ends when the reader gives the runner of a job: the rule then examines the runner.
 */
import type { ParsedWorkflow, WorkflowPermissions } from "@mark1russell7/conventions";

/** These triggers run with the token and the secrets of the base repository, also for a pull request from a fork. */
export const PRIVILEGED_TRIGGERS: readonly string[] = ["pull_request_target", "workflow_run"];

/** This is the name of the step that starts the runners. A job of a fork can operate in it. */
export const STARTER_STEP = "Start the runners";

/** This record is one broken rule of one workflow. */
export interface GuardFault {
  readonly file: string;
  readonly rule: string;
  readonly problem: string;
}

/** This function tells if the permissions give no scope: the record `{}`. */
function isNoScope(permissions: WorkflowPermissions): boolean {
  return permissions !== null && typeof permissions === "object" && Object.keys(permissions).length === 0;
}

/** This record is one job of a standard workflow on a runner of GitHub, with the most permissions of its work. */
export interface HostedJob {
  readonly file: string;
  readonly job: string;
  readonly permissions: Readonly<Record<string, string>>;
}

/**
 * These jobs run on a runner of GitHub, not on a runner of the pool, and their work needs scopes. The guard passes each
 * one with no scope and no level that its record does not have. A workflow with a privileged trigger gets no such job.
 *
 * - `security-ok` of `security.yml`: the security scans of the template. The scope `security-events: write` uploads the
 *   results, and `actions: read` lets the upload read the run.
 */
export const HOSTED_JOBS: readonly HostedJob[] = [
  { file: "security.yml", job: "security-ok", permissions: { contents: "read", "security-events": "write", actions: "read" } },
];

/** This function tells if the permissions are a record with no scope and no level that `most` does not have. */
function isWithin(permissions: WorkflowPermissions, most: Readonly<Record<string, string>>): boolean {
  if (permissions === null || typeof permissions !== "object") return false;
  const record = permissions;
  return Object.keys(record).every((scope) => Object.hasOwn(most, scope) && record[scope] === most[scope]);
}

/** This function tells if an action is the checkout action, in each form of its name. */
function isCheckout(uses: string): boolean {
  return /^actions\/checkout(?:@|$)/i.test(uses.trim());
}

/**
 * This function examines one workflow, and it gives the faults in the order of the rules.
 *
 * @param workflow - The facts of the workflow, from `parseWorkflow`
 * @returns The faults, or an empty list
 */
export function guardWorkflow(workflow: ParsedWorkflow): GuardFault[] {
  const faults: GuardFault[] = [];
  const add = (rule: string, problem: string): void => {
    faults.push({ file: workflow.file, rule, problem });
  };
  for (const fault of workflow.faults) add("parses", `Line ${fault.line}: ${fault.message}`);
  if (workflow.faults.length > 0) return faults;

  if (!isNoScope(workflow.permissions)) add("permissions", `The workflow has the permissions ${JSON.stringify(workflow.permissions)}, not {}.`);
  const privileged = workflow.triggers.filter((trigger) => PRIVILEGED_TRIGGERS.includes(trigger));
  for (const job of workflow.jobs) {
    if (job.permissions === null || isNoScope(job.permissions)) continue;
    // A privileged trigger gives the token of the base repository to a pull request from a fork, so it gets no hosted job.
    const hosted = privileged.length === 0 ? HOSTED_JOBS.find((each) => each.file === workflow.file && each.job === job.id) : undefined;
    if (hosted !== undefined && isWithin(job.permissions, hosted.permissions)) continue;
    const most = hosted === undefined ? "" : ` and not within ${JSON.stringify(hosted.permissions)}`;
    add("permissions", `The job ${job.id} has the permissions ${JSON.stringify(job.permissions)}, not {}${most}.`);
  }

  if (privileged.length > 0) {
    const name = privileged.join(" and ");
    for (const job of workflow.jobs) {
      for (const step of job.steps) if (isCheckout(step.uses)) add("privileged-checkout", `The step "${step.label}" of the job ${job.id} has a checkout, and the workflow starts on ${name}.`);
    }
    const secrets = [...new Set([...workflow.secrets, ...workflow.jobs.flatMap((job) => [...job.secrets, ...job.steps.flatMap((step) => step.secrets)])])].sort();
    if (secrets.length > 0) add("privileged-secrets", `The workflow reads the secrets ${secrets.join(", ")}, and it starts on ${name}.`);
    for (const job of workflow.jobs) {
      if (job.uses !== "") add("privileged-calls", `The job ${job.id} calls ${job.uses}, and the workflow starts on ${name}.`);
      for (const step of job.steps) if (step.uses !== "" && !isCheckout(step.uses)) add("privileged-calls", `The step "${step.label}" of the job ${job.id} uses ${step.uses}, and the workflow starts on ${name}.`);
    }
  }

  const readsSecrets = workflow.secrets.length > 0 || workflow.jobs.some((job) => job.secrets.length > 0 || job.steps.some((step) => step.secrets.length > 0));
  const others = workflow.triggers.filter((trigger) => trigger !== "workflow_dispatch");
  if (readsSecrets && (others.length > 0 || workflow.triggers.length === 0)) {
    add("secret-triggers", `The workflow reads a secret, and it starts on ${workflow.triggers.join(", ") || "no trigger"}, not only on workflow_dispatch.`);
  }

  for (const job of workflow.jobs) {
    const start = job.steps.findIndex((step) => step.label === STARTER_STEP);
    if (start < 0) continue;
    for (const step of job.steps.slice(start)) {
      if (step.secrets.length > 0) add("starter-order", `The step "${step.label}" of the job ${job.id} reads a secret, and it is not before the step "${STARTER_STEP}".`);
    }
    // A secret of the env of the job or of the workflow goes to each step, the start of the runners too.
    const before = new Set(job.steps.slice(0, start).flatMap((step) => step.secrets));
    const wide = [...new Set([...workflow.secrets.filter((name) => !workflow.jobs.some((other) => other.secrets.includes(name))), ...job.secrets])].filter((name) => !before.has(name));
    if (wide.length > 0) add("starter-order", `The job ${job.id} or its workflow reads the secrets ${wide.sort().join(", ")} outside the steps before "${STARTER_STEP}".`);
  }
  return faults;
}
