# runner-gate-test

Fixtures for the runner-dispatch gate tests.

This repository holds the workflows that the gate tests of [runner-dispatch](https://github.com/mark1russell7/runner-dispatch) use. A test opens a pull request from a fork, starts one round of the dispatcher, and records what each job does. Each machine of a round is a folder and a runner on a GitHub machine. Thus a test needs no machine of its own.

## The tests

| Test | What it does | The expected result |
| --- | --- | --- |
| T1 | A job of a fork names the run label of its own run. | The dispatcher refuses the run for trust. No runner starts, and the step of the job does not start. |
| T2 | A job of a fork names the run label of a trusted run. | The fork job can take the runner of the trusted run. Then the check on the machine stops it before its first step. A second round serves the trusted job. |
| T4 | A job of `pull_request_target` and a job of `workflow_run` name their run labels. | The dispatcher refuses each event. No runner starts. |

## The workflows

| File | Trigger | What it does |
| --- | --- | --- |
| `round.yml` | `workflow_dispatch` | It does one round of the dispatcher, then it starts the runners of the round. |
| `trusted.yml` | `workflow_dispatch` | It waits for the input `hold`, then its job `target` asks for a runner. |
| `fork-probe.yml` | `pull_request` | Its job asks for a runner only on a pull request from a fork. |
| `t4-target.yml` | `pull_request_target` | Its job asks for a runner. It has no checkout, no secret and the permissions `{}`. |
| `t4-run.yml` | `workflow_run` | Its job asks for a runner after a run of `fork-probe.yml`. It has the same limits. |
| `ci.yml` | `pull_request` | It runs the guard test. |

Each workflow and each job has the permissions `{}`. Each action has a pin to a commit.

## The round

The workflow `round.yml` has one job. Its steps come in this order:

1. The job checks out this repository and a fixed commit of the dispatcher.
2. The job gets the runner program and checks its SHA-256 sum.
3. The step `Do a round` runs the dispatcher with the token. The dispatcher writes one folder for each machine.
4. The step `Start the runners` starts the runner program of each folder. This step has no secret.
5. The job keeps the records of the round as an artifact for 30 days.

The step `Do a round` is the only step with the token. No step with a secret comes after `Start the runners`.

## The token

The secret `GATE_RUNNER_TOKEN` is a fine-grained personal access token with these terms:

- It is for this one repository only.
- It has the permission Administration write, to make the configuration of a just-in-time runner.
- It has the permission Actions read, to read the queued runs and jobs.
- Its end date is 7 days or less after the date it is made.

Revoke the token after the tests.

## The blast radius

The round runs on a machine of GitHub. The runners of the round start on the same machine, in the step `Start the runners`. A runner gets only `PATH`, `HOME`, `USER`, `LANG` and `TMPDIR`. Thus it gets no secret in its environment.

This does not isolate the token fully. The outer worker of the machine holds the secrets of the job in its memory for the whole job. A job on the machine can use `sudo`, so it can read that memory. Thus a job of a fork that operates on a runner of the round can read the token.

With the token, a job of a fork can make runners and read the runs of this repository only. The token stops at its end date, after 7 days or less.

The check on the machine stops a job of another run before its first step. Test T2 examines this check. The dispatcher refuses a fork, `pull_request_target` and `workflow_run` before it makes a machine. Tests T1 and T4 examine these refusals.

## The guard

The test `test/guard.test.ts` reads each workflow with `parseWorkflow` of [`@mark1russell7/conventions`](https://www.npmjs.com/package/@mark1russell7/conventions). This function reads the YAML with a parser, not with line patterns. The guard `test/guard.ts` gives a fault for each broken rule:

| Rule | The rule holds when |
| --- | --- |
| `parses` | The file is one YAML 1.2 document with no fault. |
| `permissions` | The workflow has the permissions `{}`, and each job has no permissions or `{}`. |
| `privileged-checkout` | A workflow of `pull_request_target` or `workflow_run` has no checkout. |
| `privileged-secrets` | A workflow of `pull_request_target` or `workflow_run` reads no secret. |
| `privileged-calls` | A workflow of `pull_request_target` or `workflow_run` calls no workflow and no action. |
| `secret-triggers` | A workflow that reads a secret starts only by `workflow_dispatch`. |
| `starter-order` | No secret is in the step `Start the runners`, in a step after it, or in the `env` of its job or workflow. |

The test also plants each fault in a small workflow and checks that the guard refuses it.

This repository has no shared CI workflows. Each workflow here must pass the guard, and shared workflows can have other triggers and secrets.

## The orchestrator

The script `scripts/gate.mjs` runs a test from start to end with the GitHub CLI:

```sh
node scripts/gate.mjs t1 --fork <owner>/<repo> --out <folder>
node scripts/gate.mjs t2 --fork <owner>/<repo> --out <folder>
```

- The command `t1` runs T1, then T4 on the runs of the same pull request.
- The command `t2` runs T2. It changes only the `runs-on` line of `fork-probe.yml` on the branch of the fork.
- The script approves a run only when its head repository is the fork and its head commit is a commit that the script pushed.
- At the end, the script cancels each open run of the test, closes the pull request and removes the branch of the fork.
- The script writes one record of JSON with the runs, the rounds, the jobs and the verdict of each test.

The pure parts of the script are in `scripts/gate-lib.mjs`. The test `test/gate-lib.test.ts` examines them.

## Run the tests

```sh
pnpm install
pnpm test
```

## License

[MIT](LICENSE)
