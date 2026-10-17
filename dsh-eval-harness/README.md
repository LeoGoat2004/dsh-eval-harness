# dsh-eval-harness

English | [中文](README.zh.md)

A DSH plugin for running benchmark evaluations against a DSH setup you confirm. It executes a
benchmark through a declarative manifest, keeps the full session trace, aligns it with the
benchmark's own verifier, and writes a standalone HTML report that shows where a run failed and
which layer owns the failure: model, Harness, benchmark, or environment.

## Requirements

- DSH `0.2.x`
- Node.js `>= 22.19`
- A DSH profile with the model provider you want to evaluate already configured
- A local benchmark checkout plus a manifest describing it; the benchmark's environment is
  provided by you or the Harness — the plugin only declares, checks and records it

## Install

```bash
git clone <repository-url>
cd dsh-eval-harness
npm --prefix dsh-eval-harness install
npm --prefix dsh-eval-harness run build
dsh plugin --profile <profile> add ./dsh-eval-harness/packages/dsh-eval-harness
```

Set `<profile>` to your DSH profile name (usually `desktop`), then restart DSH.

## Usage

1. **`eval_preflight`** — confirm the Harness, the model and the benchmark; probe declared
   environment requirements; audit the profile for isolation risks. Missing requirements are
   reported, not installed.
2. **`eval_manifest`** — validate the benchmark manifest; optionally run its red/green check
   (a stub must fail, the official reference must pass).
3. **`eval_run`** — start one evaluation in the background and return a job token.
4. **`eval_status`** — check progress and get the run directory, report path and dashboard path.

The report is written to `<run-dir>/dashboard/index.html`.

A benchmark runs on the host or inside a container as declared by its manifest. The plugin never
pulls or builds images, installs dependencies, or edits the benchmark: an environment that does not
match the manifest is reported and the run is refused.

## License

MIT
