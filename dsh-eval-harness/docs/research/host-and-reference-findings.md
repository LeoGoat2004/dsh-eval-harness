# 调研归档：宿主能力与参考实现

> 来源：4 份只读调研（DSH 源码仓 `<research-checkout>/deepseek-harness` 0.2.1-alpha.1；运行中 Host 0.2.0-rc.2 的 `cordis_inspect`；旧参考插件 `<local-workspace>/dsh-eval-longrun/third-party/dsh-eval-harness` v0.6.0；旧外置插件项目 `<local-workspace>/dsh-researchlab`）。
> 结论摘要，细节以源码与实时探针为准。

## 1. 本机 DSH 版本（四份不一致）

| 树 | 版本 | 说明 |
|---|---|---|
| 运行中 Desktop Host | 0.2.0-rc.2 | `plugin_manager list_version_exemptions`、`list_bundles` 均为 0.2.0-rc.2 |
| managed runtime | 0.2.0-rc.2 | `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` |
| 全局 npm CLI | 0.1.1-rc.2 | PATH 上的 `dsh`；会硬拒 `--profile desktop` |
| 源码仓 | 0.2.1-alpha.1 | 仅作参考，不保证与运行时不符合同一修订 |

## 2. 插件与安装

- 插件 = Cordis 模块，导出 `apply(ctx, config)` 或 `export default {name, inject, apply}` 或 class；`Config` 必须是 `@deepseek-ai/schemastery` 的 Schema。
- bundle 在 `package.json` 声明 `dsh.bundle.patch`；patch 是 YAML 数组，行 `name` 是包名；`insert` 不去重。
- 安装到运行中 Host：`plugin_manager install_bundle` + 绝对路径（唯一支持 `desktop` 的路径）；profile 中为 pnpm `link:` junction。
- DSH peer 范围为 `"*"` 或省略；`^0.2.0` 不匹配 `0.2.0-rc.2`。
- profile 合成顺序：bundle patch 列表 → profile `cordis.patch.yml` → home patch → `--patch` 覆盖；后层按行整体替换 `config`，不深合并。

## 3. trace / 会话

- 会话日志是按帧追加的 JSONL：`<root>/--<cwd编码>--/<id>/session.vN.jsonl[.zstd]`；`compression: none` 时外部可直接逐行读。
- 当前 writer 版本 4（`SESSION_FORMAT_VERSION`），已发布版本 3；解码必须走 format catalog，不硬编码。
- 0.2.x 实测事件含：`request/header`（provider/model/工具清单）、`request/context`、`turn/start|end`、`step/start|end`、`tool/call`、`tool/result`（0.2.x 为 `text` 分块，无 `isError`）、`assistant/message`、`assistant/attempt`（失败码）、`llm/retry`、`llm/retry-started`、`compaction/*`、`approval/*`、`sandbox/mode`、`permission/preset`、`subagent/*`。
- 进程内读取：`ctx.sessionQuery.readSession(id)`（可重放校验）；遥测是 best-effort，不是 trace 存储；`session-log-export` 只产出浏览器下载。

## 4. 驱动与配置 A/B

- SDK 是首选驱动面：`profile` + 有序 `patches` + `provider/model/reasoningEffort/maxTokens` 为启动参数；一个运行时多会话，`session.event` 覆盖全部会话（含 subagent），有 `subagent.started/finished` 谱系。限制：无 mid-turn cancel、prompt 只回执。
- headless `--json` 有 8 KiB/字符串、32 KiB/行截断，无计时与用量 → 只做烟测。
- ACP 备选（标准协议、会话生命周期完整），但读不回历史 transcript。
- 模型固定臂：`@deepseek-ai/dsh-llm-replay` 普通可挂载插件，回放录制 JSONL；fixture 必须被完全消费，调用次数变化会 fail-loud（因此只覆盖调用数不变的配置对比，其余用真实模型重复采样）。
- 配置维度：bundle 栈、preset（standard/ptc/minimal/cordis）、`tools.mode`（native/ptc/both）、permission preset 与 sandbox 模式、compaction、guard、`maxParallelToolCalls`、persona、`maxTokens`。

## 5. 隔离

- DSH sandbox 是同世界文件限制（Windows ACL 路径为 `partial`），**不是安全边界**；容器/VM/远程需替换能力实现，DSH 不提供容器 provider。
- 已验证的隔离配方：`mkdtemp` 工作目录 + `cp(seed → cwd)` + 私有 `DSH_HOME`/`DSH_AGENTS_HOME`/sessions root + 清空代理变量（`test-support/session-snapshot`）。
- 无内置 git worktree 隔离；远程 POSIX 可用 `sandbox-ssh`/`fs-ssh`/`subprocess-ssh`。

## 6. 旧参考实现 v0.6.0（BiBoyang/dsh-eval-harness）

- 形态：Cordis bundle + 4 个工具（`eval_run`/`eval_gate`/`eval_judge_validate`/`eval_tps_run`）+ 1 个 skill；`runner.ts` 驱动真实 headless `dsh` 子进程，从落盘 session 读 trace。
- 局限（相对本目标）：无 benchmark 适配器；trace 只解析 5 类帧并丢弃 `turn`/`step`；报告无 provider/model 字段；无配置臂；无归一化结果信封；非 mock 模式继承真实 `DSH_HOME`；Windows 进程树 kill 未实现。
- 0.2.x 漂移实测：`tool/result` 由 `tool-result`+`isError` 变为 `text` 分块 → 其 `tool_result_contains` / `no_tool_errors` / `toolErrorRecoveries` 在 0.2.x 静默失效。
- 可复用：zstd 多帧读取、会话发现（`delegationDepth` 定序）、per-attempt 目录隔离、reliability 数学、gate 协议。
- 事故约束：进程孤儿导致 34 分钟挂起（Windows 需 `taskkill /T /F` 或 Job object）；pnpm 11 拦截构建产生「装了但死」；包名 ≠ 仓库名；run 产物放在 pnpm workspace 内会污染 `pnpm-lock.yaml`；归因曾因缺对照臂被推翻。

## 6.5 参考实现 dsh-eval（`reference/dsh-eval`）

- 来源：`hccccc01333/dsh-eval`，commit `47f39d7`，npm 0.3.0，MIT；只读参考。
- 形态：CLI 优先（`dsh eval run/report/compare/import`），通过 `dsh-cmdline` 注册命令；bundle patch 只插一行。
- benchmark = YAML 文档（name/model/profile/command/trials/timeout/seed/cases/pricing/judge/replay），case = prompt + 可选 workspace + expected（tool / check 脚本）；无外部 benchmark 适配器。
- 每个 case×trial：私有临时目录 + workspace 副本 + 私有 `DSH_HOME` + overlay 强制 plain JSONL 与 workspace-write；起 headless `dsh` 子进程，超时只杀直接子进程（Windows 后代可能存活）。
- trace：用 `@deepseek-ai/dsh-session` 的 `decodeStorageRecord` 解码 + seq 连续性校验；子会话日志按 event time 合并。
- 指标：turns / steps / toolCalls / toolResults / toolSuccess / invalidToolCalls / retries / token 四桶 / contextTokens / llmMs / toolMs / ttftMs / latencyMs / cost。
- 打分：脚本 check（exit 0）+ expected tool 命中 + 可选 LLM judge；支持 keyless replay 与跨 harness 导入（codex / claude-code）。
- 缺口（正是本项目的命题）：无真实 benchmark 适配器、无 UI（roadmap 未做）、无 step 级首错 / 传播 / 恢复 / 模型 vs harness 归因、无 Docker 隔离。
- 版本：peers 为 `0.1.0-rc.6`，运行中为 `0.2.0-rc.2`，事件形态已漂移 → 只作写法参考，不作契约。

## 7. Loader 行解析与安装形态（M0 实测）

- 行解析基准：`app-boot` 的 `walk()` 以 `<profile>/cordis.yml` 的 file URL 作为 base 调 `loader.import(row.name, baseUrl)`；bundle patch 的行被拍平进同一层，**不会**按 bundle 包目录解析。
- 结论：外置 bundle 的行 `name` 必须能从 profile 目录解析到。可行形态是「bundle 包名 = 插件包名」，由 `plugin_manager install_bundle` 以 pnpm `link:` 装进 profile。
- 被否决的形态：bundle 内 `node_modules/<member>` vendor 成员包 —— loader 解析不到；且 npm workspaces 每次 `npm install` 会清理包级 `node_modules` 里的非声明目录。
- Node ESM 的 package.json / exports 解析结果在进程内缓存：改 `main` 或 `exports` 后热重载不生效，必须重启宿主。
- 本项目采用单包结构：`packages/dsh-eval-harness` 同时是 bundle（`dsh.bundle.patch`）与插件（`main: lib/index.js`，命名导出 `name` / `inject` / `Config` / `apply`）。
- 评测运行时：workspace devDependency `@deepseek-ai/dsh@0.2.0-rc.2`（自带完整 261 个 `@deepseek-ai/*` 包与 CLI），临时 `DSH_HOME` + `--from-default-profile headless` 可离线验证 bundle 安装与合成。

## 8. 旧外置插件开发闭环（dsh-researchlab）

- 两级目录：项目根只放开发信息；`<project>\dsh-researchlab\` 为 workspace 根；`packages/dsh-researchlab` 为 bundle 层，`packages/dsh-<cap>` 为成员层。
- 本地安装是 `link:`，pnpm 不装属依赖 → 套件必须 vendor 成员（复制 `lib/`，宿主包用 junction）。
- 脚本链：`link` → `typecheck` → `build`（tsc 逐成员 + vendor）→ `test`（命名契约与纪律）→ `test:import`（真挂载）。
- 激活验证：`plugin_manager list_bundles` → `Config.listConfigs` 状态 → 真工具调用 → 冷启动复验。
