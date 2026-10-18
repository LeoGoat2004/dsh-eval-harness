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
   environment requirements; audit the profile for isolation risks. It returns a `planDigest` that
   pins the confirmed setup.
2. **`eval_manifest`** — validate the benchmark manifest; optionally run its red/green check
   (a stub must fail, the official reference must pass).
3. **`eval_run`** — start the evaluation in the background. It requires the `planDigest` from
   preflight, and runs either the confirmed profile as a frozen snapshot (`profile-snapshot`) or
   the fixed minimal control arm (`minimal-control`).
4. **`eval_status`** — check progress and get the run directory, report path and dashboard path.

The report is written to `<run-dir>/dashboard/index.html` and is also produced from an installed
package, not only from a development checkout.

Adding a new benchmark: the DSH agent inspects the benchmark and generates its manifest, which is
validated (optionally with a red/green check) before any run. The environment is then checked
against what the manifest declares; once it is ready, the evaluation starts.

## License

MIT
