# dsh-eval-harness

English | [中文](README.zh.md)

A DSH plugin that evaluates a confirmed DSH Harness configuration against a benchmark. It executes
a benchmark through a declarative manifest, preserves the full session trace, aligns it with the
benchmark's own verifier, and produces a standalone HTML report that identifies where a run failed
and which layer owns the failure: model, Harness, benchmark, or environment.

## What it evaluates

The subject of a run is a frozen DSH Harness configuration; the benchmark score is one output, not
the whole result.

| Dimension | Recorded / judged |
|---|---|
| Harness under test | dsh version, profile bundle stack, patch rows and model route. Isolation and app-bundle mutations are recorded in `mutationDiff`; the plan is content-addressed by `planDigest`. |
| Task outcome | The benchmark's own verifier (junit / pytest-text / exit-code). Failures before grading appear as `executionStatus` (timeout, guard stop, agent crash, corrupt trace, verifier error) and are not counted as task failures. |
| Execution behaviour | Full session trace (steps, tool calls and results, retries, subagents), token/time/tool metrics, loop-guard trips and timeouts. |
| Failure attribution | Each diagnostic carries a `layer` (model / harness / benchmark / environment / adapter / unknown), a `confidence` (confirmed / probable / possible / unresolved) and evidence pointers (task, event sequence, artifact, rule). Unclassifiable failures remain `unknown`. |
| Harness vs task | The same benchmark can run under `faithful-snapshot` (verbatim), `isolated-snapshot` (hermetic rows, interactive app swapped for headless, mutation diff recorded) or `minimal-control` (fixed base + headless). |
| Reproducibility | Measured dsh version, benchmark git HEAD/dirty, manifest SHA-256, profile hashes and container image digests. Container runs split the agent and the verifier, verify on disposable copies, and record a grader-visibility audit. |
| Output | `report.json` and a self-contained `dashboard/index.html`: run summary, DSH metrics, benchmark results and per-task checks, diagnostics with confidence, and trace pointers. |

A run provides evidence and clues. It does not rank models, and a single run does not establish
causality.

## Requirements

- DSH `0.2.1-rc.3`
- Node.js `>= 22.19`
- A DSH profile that already has the model provider under test configured
- A local benchmark checkout and a manifest describing it; the manifest's environment requirements
  are checked before a run

## Install

```bash
git clone <repository-url>
cd dsh-eval-harness
npm --prefix dsh-eval-harness install
npm --prefix dsh-eval-harness/dashboard install
npm --prefix dsh-eval-harness run build
dsh plugin --profile <profile> add ./dsh-eval-harness/packages/dsh-eval-harness
```

Replace `<profile>` with the DSH profile name (usually `desktop`), then restart DSH.

## Usage

1. **`eval_preflight`** — confirm the Harness, the model and the benchmark; check the declared
   environment requirements; audit the profile for isolation risks. It returns a content-addressed
   `planDigest` covering the manifest, the confirmed profile, the benchmark checkout and the
   non-secret model route.
2. **`eval_manifest`** — validate the benchmark manifest; optionally run its red/green check
   (a stub must fail, the official reference must pass).
3. **`eval_run`** — start the evaluation in the background. It requires the `planDigest` from
   preflight and refuses to run if the confirmed content changed. The harness under test is
   `faithful-snapshot` (profile used verbatim), `isolated-snapshot` (isolation/model rows added,
   interactive app bundles swapped for the headless app, full mutation diff recorded;
   `profile-snapshot` remains an alias) or the fixed `minimal-control`.
   In container mode the agent and the verifier are separate containers: the verifier only sees a
   disposable artifact copy, and the report records a grader visibility audit. A transient verifier
   bootstrap failure is retried once when it leaves no usable judgement (`verifyRetries`, 0–3).
4. **`eval_status`** — check progress and get the run directory, report path and dashboard path.
   Job records survive a restart; a job that was running is reported as `interrupted`. Pass
   `outputDir` to read job records from a run started with a custom output directory.

The report is written to `<run-dir>/dashboard/index.html` and is also produced from an installed
package, not only from a development checkout.

Adding a new benchmark: the DSH agent inspects the benchmark and generates its manifest, which is
validated (optionally with a red/green check) before any run. The environment is then checked
against what the manifest declares; once it is ready, the evaluation starts.

## License

MIT
