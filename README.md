# dsh-eval-harness

English | [中文](README.zh.md)

A DSH plugin for evaluating a DSH Harness you confirm. It runs a benchmark through a declarative
manifest, keeps the full session trace, aligns it with the benchmark's own verifier, and writes a
standalone HTML report that shows where a run failed and which layer owns the failure: model,
Harness, benchmark, or environment.

## Requirements

- DSH `0.2.1-rc.2`
- Node.js `>= 22.19`
- A DSH profile with the model provider you want to evaluate already configured
- A local benchmark checkout plus a manifest describing it; its environment requirements are
  checked before a run

## Install

```bash
git clone <repository-url>
cd dsh-eval-harness
npm --prefix dsh-eval-harness install
npm --prefix dsh-eval-harness/dashboard install
npm --prefix dsh-eval-harness run build
dsh plugin --profile <profile> add ./dsh-eval-harness/packages/dsh-eval-harness
```

Set `<profile>` to your DSH profile name (usually `desktop`), then restart DSH.

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
