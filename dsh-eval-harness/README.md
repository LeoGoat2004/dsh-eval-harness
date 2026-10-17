# dsh-eval-harness

English | [中文](README.zh.md)

Diagnostic evaluation plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
run a benchmark against a DSH setup you confirm, keep the full trace, and get a report that shows where it
failed and whether the cause was the model, the Harness, the benchmark, or the environment.

**Status: early development.** Only `aider-polyglot` (Python) is supported today, and the report format may
change.

## Install

```bash
git clone https://github.com/LeoGoat2004/dsh-eval-harness.git
cd dsh-eval-harness/dsh-eval-harness
npm install && npm run build
```

Then install the built folder as a DSH bundle (plugin manager → install bundle) and restart DSH.

## Use

Open DSH and ask the agent to run an evaluation. The plugin first calls `eval_preflight` to confirm the
Harness, the model and the benchmark with you, and reports anything the environment is missing. After that,
the agent runs the evaluation and opens the report in `runs/<run-id>/dashboard/index.html`.

## Requirements

- DSH `0.2.x`, Node.js `>= 20`
- A DSH profile with the model provider you want to evaluate already configured
- A local benchmark checkout plus the tools its adapter needs (Aider Python: `python`, `pytest`)

## License

MIT
