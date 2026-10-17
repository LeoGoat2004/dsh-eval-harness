# dsh-eval-harness

English | [中文](README.zh.md)

Diagnostic evaluation plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
run a benchmark against a DSH setup you confirm, keep the full trace, and get a report that shows where it
failed and whether the cause was the model, the Harness, the benchmark, or the environment.

## Install

```bash
git clone <repository-url>
cd dsh-eval-harness
npm --prefix dsh-eval-harness install
npm --prefix dsh-eval-harness run build
dsh plugin --profile <profile> add ./dsh-eval-harness
```

Replace `<profile>` with your DSH profile name (the Desktop profile is usually `desktop`). You can also
install the `dsh-eval-harness` folder through the plugin manager (`install bundle`) instead of the last
command. Restart DSH after installing.

## Use

Open DSH and ask the agent to run an evaluation. The plugin calls `eval_preflight` first to confirm the
Harness, the model and the benchmark with you, and reports anything the environment is missing. Then the
agent runs the evaluation and the report is written to `runs/<run-id>/dashboard/index.html`.

## Requirements

- DSH `0.2.x`, Node.js `>= 20`
- A DSH profile with the model provider you want to evaluate already configured
- A benchmark described by a declarative manifest (host or container execution); its environment
  requirements are declared by the manifest and checked before a run

## License

MIT
