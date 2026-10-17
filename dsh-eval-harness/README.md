# dsh-eval-harness

A diagnostic evaluation plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
It runs a benchmark against a **confirmed** DSH configuration and a **confirmed** model, records the complete
DSH trace, aligns it with the benchmark's native verifier, and produces a standalone HTML report.

The goal is not scoring. It is to answer: *where did the agent first go wrong, was that a model or a Harness
problem, how did the error propagate, did the agent try to recover, and why do different Harness
configurations produce different results?*

## Status

`v0.1.0` – usable for single-model, single-benchmark diagnostic runs on a user-provided environment.

## Features

- **Three confirmation gates before anything runs** – Harness profile + version, provider + model, benchmark
  name + language + revision + explicit task list. Nothing is defaulted.
- **Model is actually pinned** – the chosen provider/model is written into the isolated eval profile, then
  verified against the real `request/header` in the trace (`report.json.modelVerification`).
- **Hermetic episodes** – user/project skills and instruction files are disabled; the agent sees only the
  benchmark workspace. Traces are scanned for user-home paths (`report.json.isolation`).
- **Loop guard** – per-episode limits on steps and repeated identical tool calls stop runaway episodes
  instead of burning the whole timeout budget.
- **Environment preflight** – the benchmark declares its runtime requirements (e.g. `python`, `pytest`); the
  plugin only probes and reports, it never installs anything.
- **Attribution layers** – every finding is classified as `harness` / `environment` / `benchmark` / `adapter`
  so a lab-side problem is never reported as a DSH defect.
- **Standalone dashboard** – a single offline HTML file with run summary, DSH runtime metrics, benchmark
  results, and a per-task execution timeline.

## Requirements

- DSH `0.2.x` (the plugin is developed against `0.2.0-rc.2`).
- Node.js `>= 20` and npm.
- A DSH profile that already configures the model provider you want to evaluate (e.g. a `llm-pi-ai`
  provider entry with `apiKeyEnv`), and the corresponding credential in the environment or
  `~/.dsh/.credentials.yaml`.
- Benchmark tooling declared by the adapter (for Aider Python tasks: `python` and `pytest`).

## Install

### As a DSH bundle (Desktop)

Install the package into your profile with the plugin manager, then restart the Harness host:

```text
plugin_manager  action=install_bundle  target=<path-to-package>
```

Or with the profile CLI:

```bash
dsh plugin --profile <PROFILE> add <path-to-package>
```

Restart the host after installation so the loader re-reads the bundle.

### From source (development)

```bash
cd <path-to-package>
npm install
npm run typecheck
npm run build
npm test
npm run test:pipeline        # end-to-end pipeline check, no API calls
```

## Usage

### 1. Preflight: confirm the three decisions

Before an evaluation, the agent must call the `eval_preflight` tool with all three confirmations:

```text
eval_preflight {
  harnessProfile: "<profile dir or name under ~/.dsh/profiles>",
  dshVersion: "<version under test>",
  provider: "siliconflow",
  model: "Qwen/Qwen3-8B",
  benchmark: "aider-polyglot",
  language: "python",
  revision: "<pinned commit>",
  tasks: ["transpose", "wordy"]
}
```

The tool resolves the model from that profile, probes the benchmark's environment requirements and the model
credential, and returns a plan. `ready=false` means: configure the missing pieces, then call it again.
`ready=true` means: show the plan to the user and wait for confirmation before running.

### 2. Run one evaluation

```bash
npm run run:eval -- \
  --harness-profile <PROFILE> \
  --provider siliconflow \
  --model Qwen/Qwen3-8B \
  --benchmark aider-polyglot \
  --language python \
  --benchmark-root <path-to-benchmark-checkout> \
  --tasks transpose,wordy,two-bucket \
  --timeout 600000 \
  --max-steps 120 \
  --max-identical-tool-calls 4 \
  --permission-mode workspace-write
```

Every value is explicit; there are no defaults for benchmark, tasks, model, or environment.

### 3. Read the report

```text
runs/<run-id>/
  run.json          # manifest, model target, environment facts, limits
  preflight.json    # environment checks
  report.json       # totals, model verification, isolation result
  tasks/            # per-task workspace, raw trace, events, metrics, checks
  dashboard/index.html
```

`run.json`, `report.json` and `dashboard/index.html` are the shareable artifacts; raw traces stay untouched.

## How attribution works

Each tool failure and each failed turn is grouped into a finding with a layer:

| Layer | Meaning | Examples |
|---|---|---|
| `harness` | DSH Harness behaviour | approval unavailable in non-interactive runs |
| `environment` | Evaluation environment | sandbox ACL provisioning, provider rate limits, network egress |
| `benchmark` | Benchmark itself | verifier errors |
| `adapter` | This plugin | task materialization problems |

Unrecognized failures stay `harness` and are marked as unclassified rather than guessed.

## Current limitations

- One benchmark adapter: `aider-polyglot` (Python track).
- Runs are started from the CLI; there is no `eval_run` tool yet.
- Single run per report; no cross-run comparison dashboard yet.
- Propagation/recovery analysis is limited to trace evidence; no automated narrative yet.
- The user provides the execution environment; the plugin records it rather than provisioning it.
  On Windows, `workspace-write` sandbox provisioning can fail on drives where the account lacks the
  required ACL rights; use `danger-full-access` or a workspace path with full control, and record it.

## Documentation

- [`docs/run-pipeline.md`](docs/run-pipeline.md) – pipeline stages, confirmations, isolation, failure layers.
- [`docs/run-artifacts.md`](docs/run-artifacts.md) – artifact layout and data contract.
- [`docs/dashboard-design.md`](docs/dashboard-design.md) – dashboard information architecture.

## License

MIT – see [LICENSE](LICENSE).
