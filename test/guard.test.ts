import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "@mark1russell7/conventions";
import { describe, expect, it } from "vitest";
import { LABEL_LINE, withLabel } from "../scripts/gate-lib.mjs";
import { guardWorkflow, PRIVILEGED_TRIGGERS, STARTER_STEP } from "./guard.ts";

const folder = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const files = readdirSync(folder).filter((name) => /\.ya?ml$/.test(name)).sort();
const read = (name: string) => parseWorkflow(name, readFileSync(join(folder, name), "utf8"));
const rulesOf = (text: string) => guardWorkflow(parseWorkflow("planted.yml", text)).map((fault) => fault.rule);

describe("the workflows of the repository", () => {
  it("has the workflows of the tests", () => {
    expect(files).toEqual(["ci.yml", "fork-probe.yml", "round.yml", "t4-run.yml", "t4-target.yml", "trusted.yml"]);
  });

  it.each(files)("%s passes the guard", (name) => {
    expect(guardWorkflow(read(name))).toEqual([]);
  });

  it("has a workflow of each privileged trigger, so test T4 reads each one", () => {
    const triggers = new Set(files.flatMap((name) => read(name).triggers));
    for (const trigger of PRIVILEGED_TRIGGERS) expect(triggers.has(trigger)).toBe(true);
  });

  it("reads the token only in the step before the start of the runners", () => {
    const round = read("round.yml");
    expect(round.triggers).toEqual(["workflow_dispatch"]);
    expect(round.secrets).toEqual(["GATE_RUNNER_TOKEN"]);
    const steps = round.jobs.flatMap((job) => job.steps);
    const withSecret = steps.filter((step) => step.secrets.length > 0);
    expect(withSecret.map((step) => [step.label, step.secrets])).toEqual([["Do a round", ["GATE_RUNNER_TOKEN"]]]);
    const labels = steps.map((step) => step.label);
    expect(labels.indexOf("Do a round")).toBeLessThan(labels.indexOf(STARTER_STEP));
    expect(labels.indexOf(STARTER_STEP)).toBeGreaterThan(0);
  });

  it("gives no other workflow a secret", () => {
    for (const name of files.filter((each) => each !== "round.yml")) expect(read(name).secrets).toEqual([]);
  });
});

const target = (steps: string, head = "permissions: {}") => `name: Planted
on:
  pull_request_target:
${head}
jobs:
  probe:
    runs-on: run-1-1
    steps:
${steps}
`;

describe("the guard refuses each planted fault", () => {
  it("passes a clean workflow of pull_request_target", () => {
    expect(rulesOf(target(`      - name: Tell the run\n        run: echo ok`))).toEqual([]);
  });

  it("refuses a checkout in the block form", () => {
    expect(rulesOf(target(`      - name: Get the code\n        uses: actions/checkout@v7`))).toEqual(["privileged-checkout"]);
  });

  it("refuses a checkout in the flow form", () => {
    expect(rulesOf(target(`      - { name: Get the code, uses: "actions/checkout@v7" }`))).toEqual(["privileged-checkout"]);
  });

  it("refuses a secret in an if, in the dot form and in the index form", () => {
    expect(rulesOf(target(`      - name: A\n        if: \${{ secrets.TOKEN != '' }}\n        run: echo a`))).toEqual(["privileged-secrets", "secret-triggers"]);
    expect(rulesOf(target(`      - name: A\n        if: \${{ secrets['TOKEN'] }}\n        run: echo a`))).toEqual(["privileged-secrets", "secret-triggers"]);
  });

  it("refuses the whole secrets context", () => {
    expect(rulesOf(target(`      - name: A\n        run: echo "\${{ toJSON(secrets) }}"`))).toEqual(["privileged-secrets", "secret-triggers"]);
  });

  it("refuses write permissions, and a workflow with no permissions key", () => {
    expect(rulesOf(target(`      - name: A\n        run: echo a`, "permissions:\n  contents: write"))).toEqual(["permissions"]);
    expect(rulesOf(target(`      - name: A\n        run: echo a`, ""))).toEqual(["permissions"]);
    expect(rulesOf(target(`      - name: A\n        run: echo a`, "permissions: read-all"))).toEqual(["permissions"]);
  });

  it("refuses the permissions of a job", () => {
    const text = target(`      - name: A\n        run: echo a`).replace("    runs-on: run-1-1", "    runs-on: run-1-1\n    permissions:\n      actions: write");
    expect(rulesOf(text)).toEqual(["permissions"]);
  });

  it("refuses a called workflow with secrets: inherit", () => {
    const text = `on: workflow_run\npermissions: {}\njobs:\n  call:\n    uses: someone/repo/.github/workflows/x.yml@v1\n    secrets: inherit\n`;
    expect(rulesOf(text)).toEqual(["privileged-secrets", "privileged-calls", "secret-triggers"]);
  });

  it("refuses an action in a privileged workflow, because its steps are out of sight", () => {
    expect(rulesOf(target(`      - name: A\n        uses: someone/action@v1`))).toEqual(["privileged-calls"]);
  });

  it("reads the list form of the triggers", () => {
    const text = `on: [push, workflow_run]\npermissions: {}\njobs:\n  a:\n    runs-on: run-1-1\n    steps:\n      - uses: actions/checkout@v7\n`;
    expect(rulesOf(text)).toEqual(["privileged-checkout"]);
  });

  it("refuses a file that does not parse, a duplicate key and YAML 1.1", () => {
    expect(rulesOf(`on: workflow_dispatch\non: pull_request_target\npermissions: {}\njobs: {}\n`)).toEqual(["parses"]);
    expect(rulesOf(`%YAML 1.1\n---\non: workflow_dispatch\npermissions: {}\njobs: {}\n`)).toContain("parses");
    expect(rulesOf(`on: [workflow_dispatch\n`)).toContain("parses");
  });

  it("refuses a secret on a trigger other than workflow_dispatch", () => {
    const text = `on: pull_request\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: A\n        env:\n          T: \${{ secrets.TOKEN }}\n        run: echo a\n`;
    expect(rulesOf(text)).toEqual(["secret-triggers"]);
  });

  it("refuses a secret in the step that starts the runners, or after it", () => {
    const steps = (at: string) =>
      `on: workflow_dispatch\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Do a round\n        env:\n          T: \${{ secrets.TOKEN }}\n        run: echo a\n${at}`;
    expect(rulesOf(steps(`      - name: ${STARTER_STEP}\n        run: echo b\n`))).toEqual([]);
    expect(rulesOf(steps(`      - name: ${STARTER_STEP}\n        run: echo b\n      - name: Late\n        env:\n          U: \${{ secrets.OTHER }}\n        run: echo c\n`))).toEqual(["starter-order", "starter-order"]);
    expect(rulesOf(steps(`      - name: ${STARTER_STEP}\n        env:\n          T: \${{ secrets.TOKEN }}\n        run: echo b\n`))).toEqual(["starter-order"]);
  });

  it("refuses a secret in the env of the job or of the workflow of the starter", () => {
    const job = `on: workflow_dispatch\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      T: \${{ secrets.WIDE }}\n    steps:\n      - name: ${STARTER_STEP}\n        run: echo b\n`;
    expect(rulesOf(job)).toEqual(["starter-order"]);
    const top = `on: workflow_dispatch\npermissions: {}\nenv:\n  T: \${{ secrets.WIDE }}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: ${STARTER_STEP}\n        run: echo b\n`;
    expect(rulesOf(top)).toEqual(["starter-order"]);
  });
});

describe("the label of test T2", () => {
  const probe = readFileSync(join(folder, "fork-probe.yml"), "utf8");

  it("changes exactly the one line of the label", () => {
    const changed = withLabel(probe, "run-123456789-1");
    const before = probe.split("\n");
    const after = changed.split("\n");
    expect(after.length).toBe(before.length);
    const diff = after.flatMap((line, index) => (line === before[index] ? [] : [[before[index], line]]));
    expect(diff).toEqual([[LABEL_LINE, "    runs-on: run-123456789-1"]]);
  });

  it("keeps a workflow that parses and passes the guard", () => {
    const changed = parseWorkflow("fork-probe.yml", withLabel(probe, "run-123456789-1"));
    expect(changed.faults).toEqual([]);
    expect(guardWorkflow(changed)).toEqual([]);
  });

  it("keeps the line ends of a file with CR LF", () => {
    const crlf = probe.replace(/\r?\n/g, "\r\n");
    expect(withLabel(crlf, "run-9-2").split("\r\n")).toContain("    runs-on: run-9-2");
  });

  it("refuses a bad label, and a text without the line one time", () => {
    expect(() => withLabel(probe, "run-1-1\n    steps: []")).toThrow(/not a run label/);
    expect(() => withLabel(probe, "self-hosted")).toThrow(/not a run label/);
    expect(() => withLabel(probe.replace(LABEL_LINE, "    runs-on: ubuntu-latest"), "run-1-1")).toThrow(/0 times/);
    expect(() => withLabel(`${probe}\n${LABEL_LINE}\n`, "run-1-1")).toThrow(/2 times/);
  });
});
