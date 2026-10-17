# dsh-eval-harness（中文）

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的诊断评测插件：
用你确认过的 DSH 配置跑一个 benchmark，保留完整 trace，并生成报告，说明失败发生在哪一步、是模型、
Harness、benchmark 还是环境的问题。

## 安装

```bash
git clone <repository-url>
cd dsh-eval-harness
npm --prefix dsh-eval-harness install
npm --prefix dsh-eval-harness run build
dsh plugin --profile <profile> add ./dsh-eval-harness/packages/dsh-eval-harness
```

把 `<profile>` 换成你的 DSH profile 名（Desktop 版通常是 `desktop`）。最后一条命令也可以改成在插件
管理器里把 `dsh-eval-harness` 目录作为 bundle 安装。安装后重启 DSH。

## 使用

打开 DSH，让 agent 运行评测即可。插件会先调用 `eval_preflight`，和你确认 harness、模型与 benchmark，
并检查环境是否就绪；之后由 agent 执行评测，报告写在 `runs/<run-id>/dashboard/index.html`。

## 环境要求

- DSH `0.2.x`，Node.js `>= 20`
- DSH profile 里已经配置好要评测的模型 provider
- 有一个由声明式 manifest 描述的 benchmark（host 或 container 执行）；环境要求由 manifest 声明，
  运行前由插件检查

## 许可证

MIT
