# 运行流程

> 一次 run = 一个 Benchmark × 当前 DSH 配置（专用 eval profile）× 单次运行。
> 所有取值必须由用户显式给出，没有默认。

## 阶段

**第 0 步（模型可见，必须先做）：`eval_preflight` —— 先确认三件事，再配环境**

评测开始前，agent 必须显式给出并让用户确认三件事：

1. **哪个 harness**：`harnessProfile`（从用户 profile 解析模型配置）+ `dshVersion`；
2. **哪个模型**：`provider` + `model`（如 `siliconflow` + `Qwen/Qwen3-8B`），从该 profile 的 `llm-pi-ai` / `llm-deepseek` 行解析出 `api` / `baseURL` / `apiKeyEnv`；
3. **哪个 benchmark**：`benchmark` + `language` + `revision` + 显式 `tasks` 列表。

工具行为：

- 校验三组参数、解析模型配置，返回一份 **plan**（harness / model / benchmark 三项摘要）；
- 探测 benchmark **声明**的环境需求（如 `python`、`pytest`）与模型凭据；
- `ready=false` 时返回 `missing[]` + `credential`，agent 按说明在评测环境里配置后**再次调用**，直到 `ready=true`；
- `ready=true` 时返回 plan，要求 agent **把 plan 交给用户确认**；确认后才能开始评测；
- 插件只声明与检测，**不安装**任何东西；环境选 local / Docker / 远程由用户决定。

run 脚本（`run:eval`）以同一组显式参数启动；模型在 eval profile 里通过 `agent-default-model` + provider 行真正**钉住**，跑完从 trace 的 `request/header` 校验实际模型与声明一致（`report.json.modelVerification`）。

| # | 阶段 | 输入 | 产出 | 失败语义 |
|---|---|---|---|---|
| 0 | 运行定义 | 用户指定 bench / revision / 范围 / 配置 / 模型 / 环境 / 超时 / 输出目录 | `run.json`（manifest + 配置哈希） | 字段缺失或配置无效 → 拒绝启动 |
| 1 | Benchmark 获取与物化 | adapter + 数据集 revision | `tasks.jsonl` + 校验和 | 网络 / 校验失败 → run 级 error |
| 2 | eval profile 物化 | 被测层栈快照 + eval-only 行 | 私有 `DSH_HOME` 下的 profile + `dump-config` | 物化失败 → run 级 error |
| 3 | 环境预检（benchmark 需求） | adapter 声明的环境需求 | `preflight.json` + 探测结果入 manifest | 不满足 → 拒绝启动并提示先配环境 |
| 4 | 执行 episode | task prompt + profile | session id、退出原因、trace 路径、耗时 | 超时 / 崩溃 → 采集已落盘 trace |
| 5 | trace 采集 | 落盘 JSONL | 原始 trace + 归一化事件流 + 固定指标 | trace 缺失 → 标记，不编造 |
| 6 | Benchmark 验证 | workspace + 原生验证器 | `checks[]`（id / pass / evidence / source）+ 分数 | 验证器自身失败 → 标 `unverified`，不算任务失败 |
| 7 | 对齐与诊断 | checks + trace + 任务要求 | `findings[]`（首错 / 传播 / 恢复 / 可疑组件，带 layer） | 缺证据 → `unresolved` |
| 8 | 报告与看板 | 全部产物 | 归一化信封 + 静态 Web 看板 | 渲染失败 → 报告 JSON 仍可用 |
| 9 | 归档与复现 | run 目录 | checksum + 重跑命令 + 清理策略 | — |

## 运行定义（必填，无默认）

| 字段 | 含义 | 约束 |
|---|---|---|
| `benchmark` | Benchmark 名称 | 必须显式 |
| `revision` | 数据集 commit / 版本 | 必须 pin |
| `tasks` | 全部 / 子集 / 列表 | **必须显式**，禁止默认全部或默认 limit |
| `harness` | 被测层栈来源：profile + dsh 版本 | 必须显式 |
| `model` | provider + model，从 profile 解析 api / baseURL / apiKeyEnv | 必须显式 |
| `backend` | 环境由用户选定（local / Docker / 远程），插件只记录类型 | 必须显式，无回退 |
| `timeout` / `concurrency` / `retries` | 执行参数 | 必须显式 |
| `output` | run 目录 | 必须显式 |

## 专用 eval profile

- **是什么**：普通 DSH profile，为本次 run 物化在私有 `DSH_HOME/profiles/<name>`；不是隐藏机制。
- **内容**：被测 bundle 栈 + 被测 patch 层（快照）+ eval-only 行（私有 sessions root、`compression: none`、关遥测、关 hmr、固定权限预设）。
- **记录**：`--dump-config` 结果与哈希写进 `run.json`；层栈变化就是新 run。
- **为什么**：desktop profile 由 Electron 独占、带 UI 行、热载、sessions 落用户目录，不能作为可复现实验载体。

## 环境：由用户 / DSH 提供，插件只声明与探测

插件**不搭建、不编排、不强制**运行环境——local、Docker、远程 SSH 都由用户按自己的 DSH 配置决定。

- **适配器声明**：每个 benchmark 提供 `environment` 需求清单（如 python、pytest），含检测命令与失败说明。
- **preflight 探测**：按清单逐项执行探针，结果写 `preflight.json` 与 `run.json.environment.requirements`；任一项失败 → **拒绝启动**，错误信息直接说明"先配置什么"。
- **不安装**：插件不会安装依赖、拉镜像或改系统配置；缺什么由用户补齐后重跑。
- **安全边界不在插件职责内**：选哪个 benchmark、在什么环境跑，是用户的选择；插件只记录环境事实。
- 环境事实（后端类型、平台/Node、沙箱/审批、网络策略、需求探测结果）入 manifest，保证"结果差异"可解释。

## 环境纯净（hermetic prompt）：评测 profile 的硬性隔离

被测 episode 的输入只能来自任务本身，不得混入宿主用户环境。eval profile 强制覆写：

| 行 | 配置 | 作用 |
|---|---|---|
| `skill-filesystem` | `includeDefaultRoots: false`、`customSkillDirs: []`、`watch: false` | 不扫描项目根 / `~/.agents/skills` 用户根，skill catalog 为空 |
| `agent-instructions` | `maxBytes: 0` | 关闭用户/项目 `AGENTS.md` 发现 |
| `credentials` / `authorization` / `deepseek-account` | `disabled: true` | 凭据只经子进程环境传入，不读用户 home 凭据 |

**两道检测**（不只靠配置自觉）：

1. **trace 泄漏检测**（代码强制）：每任务扫描原始事件，若出现用户 home 路径 → `task.json.homeLeaks` + `report.json.isolation`（只记序号/类型，不记路径）；看板"评测环境"显示"用户 home 泄漏"，非 clean 时红色告警。
2. **契约断言**（代码强制）：`npm run test:pipeline` 断言 eval profile 含上述隔离配置且 `report.isolation.clean === true`。

Docker 不是必要条件：这些用户级读取面在 profile 配置层即可关闭；Docker 的价值是"整体 host 兜底"，但只有不挂载用户 home 时才成立。

## 失败分层

- **run 级**：获取 benchmark、配置 / 物化、镜像不可用 → 不进入任务循环。
- **任务级**：环境准备、执行超时、trace 缺失、验证器失败 → 记录并继续，看板可见。
- 所有失败都是数据，必须带阶段、错误码、可操作信息。

## 产物布局

```
runs/<run-id>/
  run.json              # manifest、配置哈希、全部显式取值
  tasks.jsonl           # 任务实例
  profile/              # eval profile 快照 + dump-config
  <task>/workspace/     # 任务工作区（保留策略可选）
  <task>/trace/         # 原始 session.vN.jsonl
  <task>/events.jsonl   # 归一化事件流
  <task>/metrics.json   # 固定指标
  <task>/checks.json    # benchmark 验证结果
  <task>/findings.json  # 诊断结论
  report.json           # 归一化信封
  dashboard/            # 静态看板
```

## 环境预检与环境事实（run 前置）

每次 run 在任何 episode 之前执行 preflight，结果写入 `preflight.json` 并进入 `run.json` / `report.json`：

- **必过项**：输出目录可写、dsh launcher 存在、benchmark revision 已 pin、模型凭据存在、任务列表显式。
- **记录项**：后端（local/docker）、平台与 Node 版本、工作区根、私有 `DSH_HOME`、profile、沙箱模式、审批策略、网络策略（direct / proxy-configured）。
- 任一必过项失败 → **拒绝启动**，不消耗 API，错误信息列出失败项。

## 归因分层（findings.layer）

每条 finding 必须带 `layer`，避免把实验室问题报成 DSH 缺陷：

| layer | 含义 | 示例 |
|---|---|---|
| `harness` | 被测 DSH Harness 侧 | 非交互审批链路不可用、工具执行失败 |
| `environment` | 评测环境侧 | 宿主文件系统权限导致沙箱预处理失败、网络出口不可用 |
| `benchmark` | Benchmark 侧 | 验证器自身失败、题面/测试问题 |
| `adapter` | 适配器侧 | 任务物化、prompt 组装、路径解析错误 |

分类由插件内 `src/run/attribution.ts` 的 `classifyToolFailure` 统一给出，看板与后续工具共用同一份规则。默认保守：无法识别的失败归 `harness`，但标注 note 说明未细分。

## 可复现锁

dsh 版本、benchmark revision、镜像 digest、配置哈希、模型与参数、adapter 版本全部入 `run.json`；任一不一致 → 拒绝运行。环境事实（workspace 根、沙箱/审批/网络策略）同样入库，保证"结果差异"可被解释。
