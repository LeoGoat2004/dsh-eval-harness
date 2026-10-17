# dsh-eval-harness

English | [中文](README.zh.md)

A diagnostic evaluation plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
It runs a benchmark against a DSH setup you confirm, keeps the full DSH trace, and turns the result into a
standalone HTML report.

> **Early development.** The plugin works, but interfaces, artifacts and the report format may change.

## What it does

- **You confirm three things first** – harness (profile + version), model (provider + model), and benchmark
  (name + revision + explicit tasks). Nothing is defaulted.
- **Runs are hermetic** – no user skills or instruction files leak into the episode; the agent only sees the
  benchmark workspace.
- **The model really is the model** – the chosen provider/model is written into the run and verified against
  the actual request headers in the trace.
- **Every failure gets a layer** – `harness` / `environment` / `benchmark` / `adapter`, so a lab problem is
  never blamed on DSH.
- **One report file** – run summary, DSH runtime metrics, benchmark results, per-task execution timeline.

## Requirements

- DSH `0.2.x`
- Node.js `>= 20`
- A DSH profile that already configures the model provider you want to evaluate (for example a
  `siliconflow` provider entry) and its credential
- Benchmark tooling declared by the adapter (Aider Python: `python` and `pytest`)

## Install

```bash
git clone https://github.com/LeoGoat2004/dsh-eval-harness.git
cd dsh-eval-harness/dsh-eval-harness
npm install
npm run build
```

Then install the built bundle into your DSH profile (from the repository root):

```bash
cd ..
dsh plugin --profile <PROFILE> add ./dsh-eval-harness
```

You can also ask the DSH agent to install it with `plugin_manager action=install_bundle` and the absolute
path of that `dsh-eval-harness` folder. Restart DSH afterwards.

## Quick start

1. **Confirm the three decisions** – the agent calls `eval_preflight` with the harness profile, provider/model,
   benchmark name/revision and explicit tasks. It reports missing environment pieces; fix them and call it
   again until it is ready.
2. **Start a run** (all values are explicit; there are no defaults). The benchmark checkout can be cloned next
   to the plugin:

```bash
git clone https://github.com/Aider-AI/polyglot-benchmark.git
npm run run:eval -- \
  --harness-profile <PROFILE> \
  --provider siliconflow \
  --model Qwen/Qwen3-8B \
  --benchmark aider-polyglot \
  --language python \
  --benchmark-root ../polyglot-benchmark \
  --tasks transpose,wordy \
  --timeout 600000 \
  --max-steps 120 \
  --max-identical-tool-calls 4 \
  --permission-mode workspace-write
```

3. **Open the report** – `runs/<run-id>/dashboard/index.html`.

## Current status

- Supported benchmark: `aider-polyglot` (Python track).
- Runs are started from the CLI; there is no one-click in-chat run yet.
- One report per run; cross-run comparison is planned.
- You provide the execution environment; the plugin records it but does not provision it.
- Design documents are kept outside the public repository during development.

## License

MIT
