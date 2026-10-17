# dsh-eval-harness（中文说明）

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**诊断评测插件**。
它用「确认过的 DSH 配置 + 确认过的模型」跑一个 benchmark，保留完整 DSH trace，与 benchmark 原生
验证器对齐，产出可独立打开的 HTML 报告。

目的不是跑分，而是回答：*agent 从哪一步开始出错、这是模型问题还是 Harness 问题、错误如何传播、
是否尝试恢复、不同 Harness 配置为何产生不同结果。*

## 状态

`v0.1.0` —— 可在**用户自备环境**上做单模型、单 benchmark 的诊断评测。

## 功能

- **运行前三件事确认**：harness（profile + 版本）、模型（provider + model）、benchmark（名称 + 语言 +
  revision + 显式任务列表）；全部显式，无默认。
- **模型真正生效**：选定的 provider/model 写入隔离的 eval profile，跑完再用 trace 的
  `request/header` 校验实际模型（`report.json.modelVerification`）。
- **环境纯净**：禁用用户/项目的 skills 与指令文件，agent 只能看到 benchmark workspace；trace 会扫描
  用户 home 路径泄漏（`report.json.isolation`）。
- **熔断**：每任务限制步数与连续重复工具调用，命中即停止并记录原因，避免空转烧 token。
- **环境预检**：benchmark 适配器声明运行环境需求（如 `python`、`pytest`），插件只探测与记录，**不安装**。
- **归因分层**：每条 finding 标注 `harness` / `environment` / `benchmark` / `adapter`，避免把实验环境
  问题当成 DSH 缺陷。
- **独立看板**：单个离线 HTML，包含运行摘要、DSH 运行指标、benchmark 结果、逐任务执行链。

## 环境要求

- DSH `0.2.x`（开发基准为 `0.2.0-rc.2`）。
- Node.js `>= 20` 与 npm。
- 一个**已配置好模型 provider** 的 DSH profile（例如 `llm-pi-ai` 行里的 provider + `apiKeyEnv`），
  以及环境或 `~/.dsh/.credentials.yaml` 中对应的凭据。
- 适配器声明的 benchmark 工具链（Aider Python 任务需要 `python` 与 `pytest`）。

## 安装

### 作为 DSH bundle（Desktop）

用插件管理器安装到 profile，然后重启 Harness：

```text
plugin_manager  action=install_bundle  target=<path-to-package>
```

或用 profile CLI：

```bash
dsh plugin --profile <PROFILE> add <path-to-package>
```

安装后重启宿主，让 loader 重新读取 bundle。

### 从源码（开发）

```bash
cd <path-to-package>
npm install
npm run typecheck
npm run build
npm test
npm run test:pipeline        # 端到端管线自检，不消耗 API
```

## 使用

### 1. 预检：确认三件事

评测前，agent 必须先调用 `eval_preflight`：

```text
eval_preflight {
  harnessProfile: "<profile 目录或 ~/.dsh/profiles 下的名字>",
  dshVersion: "<被测版本>",
  provider: "siliconflow",
  model: "Qwen/Qwen3-8B",
  benchmark: "aider-polyglot",
  language: "python",
  revision: "<pin 的 commit>",
  tasks: ["transpose", "wordy"]
}
```

工具会从该 profile 解析模型配置、探测 benchmark 环境需求与模型凭据，返回 plan。
`ready=false`：按提示先配环境，然后再次调用；`ready=true`：把 plan 呈现给用户，用户确认后再开始评测。

### 2. 跑一次评测

```bash
npm run run:eval -- \
  --harness-profile <PROFILE> \
  --provider siliconflow \
  --model Qwen/Qwen3-8B \
  --benchmark aider-polyglot \
  --language python \
  --benchmark-root <benchmark checkout 路径> \
  --tasks transpose,wordy,two-bucket \
  --timeout 600000 \
  --max-steps 120 \
  --max-identical-tool-calls 4 \
  --permission-mode workspace-write
```

所有取值显式给出；benchmark、任务、模型、环境都没有默认值。

### 3. 读报告

```text
runs/<run-id>/
  run.json          # manifest、模型目标、环境事实、限制
  preflight.json    # 环境检查结果
  report.json       # 汇总、模型一致性校验、隔离结果
  tasks/            # 每任务 workspace、原始 trace、事件、指标、checks
  dashboard/index.html
```

`run.json`、`report.json`、`dashboard/index.html` 是可分享产物；原始 trace 保持原样。

## 归因方式

工具失败与 turn 失败会归组为 finding，并带 layer：

| layer | 含义 | 示例 |
|---|---|---|
| `harness` | DSH Harness 行为 | 非交互评测下审批不可用 |
| `environment` | 评测环境 | 沙箱 ACL 预处理失败、provider 限流、网络出口 |
| `benchmark` | benchmark 自身 | 验证器自身错误 |
| `adapter` | 本插件 | 任务物化问题 |

无法识别的失败保留在 `harness` 并标注未细分，不做猜测。

## 当前限制

- 只有一个 benchmark 适配器：`aider-polyglot`（Python 轨道）。
- 评测只能从 CLI 启动，还没有 `eval_run` 工具。
- 单个 run 一份报告，暂不支持跨 run 对比看板。
- 传播/恢复分析目前只提供 trace 证据，还没有自动化的结论叙述。
- 执行环境由用户提供，插件只记录不搭建。Windows 上若账户对工作区所在盘缺少 ACL 权限，
  `workspace-write` 可能失败；可改用 `danger-full-access` 或换成有完整控制权的路径，并如实记录。

## 文档

- [`docs/run-pipeline.md`](docs/run-pipeline.md) —— 流程阶段、确认门禁、隔离、失败分层。
- [`docs/run-artifacts.md`](docs/run-artifacts.md) —— 产物布局与数据契约。
- [`docs/dashboard-design.md`](docs/dashboard-design.md) —— 看板信息架构。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
