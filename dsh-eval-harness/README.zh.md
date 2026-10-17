# dsh-eval-harness（中文）

[English](README.md) | 中文

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**诊断评测插件**。
它用你确认过的 DSH 配置跑一个 benchmark，保留完整 trace，并生成一份可以直接打开的 HTML 报告。

> **开发阶段。** 插件已可用，但接口、产物格式与报告格式可能变化。

## 它能做什么

- **先确认三件事**：harness（profile + 版本）、模型（provider + model）、benchmark（名称 + revision +
  显式任务列表），全部显式，没有默认值。
- **评测环境干净**：用户级 skills 与指令文件不会进入 episode，agent 只能看到 benchmark workspace。
- **模型真的生效**：选定的 provider/model 写进本次运行，并用 trace 里的真实请求头校验。
- **失败有归因**：每条问题标注 `harness` / `environment` / `benchmark` / `adapter`，不会把实验环境问题
  算到 DSH 头上。
- **一份报告**：运行摘要、DSH 运行指标、benchmark 结果、逐任务执行链。

## 环境要求

- DSH `0.2.x`
- Node.js `>= 20`
- 一个已经配置好模型 provider（如 `siliconflow`）及其凭据的 DSH profile
- 适配器声明的 benchmark 工具链（Aider Python 需要 `python` 与 `pytest`）

## 安装

```bash
git clone https://github.com/LeoGoat2004/dsh-eval-harness.git
cd dsh-eval-harness/dsh-eval-harness
npm install
npm run build
```

然后从仓库根目录把构建好的 bundle 安装到你的 DSH profile：

```bash
cd ..
dsh plugin --profile <PROFILE> add ./dsh-eval-harness
```

也可以让 DSH agent 用 `plugin_manager action=install_bundle` 安装该 `dsh-eval-harness` 文件夹的绝对路径。
安装后重启 DSH。

## 快速开始

1. **确认三件事**：agent 调用 `eval_preflight`，传入 harness profile、provider/model、benchmark 名称/
   revision 和显式任务；缺失环境会列出，配置好后再次调用，直到就绪。
2. **启动一次评测**（所有取值显式，无默认）。benchmark 可以克隆到插件旁边：

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

3. **打开报告**：`runs/<run-id>/dashboard/index.html`。

## 当前状态

- 已支持 benchmark：`aider-polyglot`（Python 轨道）。
- 评测从 CLI 启动，暂不支持对话内一键运行。
- 每个 run 一份报告，跨 run 对比还在计划中。
- 执行环境由你提供，插件只记录不搭建。

## 文档

- [流程与确认门禁](docs/run-pipeline.md)
- [运行产物](docs/run-artifacts.md)
- [看板设计](docs/dashboard-design.md)

## 许可证

MIT
