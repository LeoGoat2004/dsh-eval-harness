# 运行产物约定

> 一次 run 的全部产物落在 `runs\<run-id>\`，位于项目根、**在任何 pnpm workspace 之外**。
> `run.json` 是唯一入口；`report.json` 是看板唯一数据源；原始 trace 只读不改。

## 目录

```
plugins\dsh-eval-harness\
├─ benchmarks\<bench>\      # 数据集缓存：git clone，pin commit，只读（不进 run 目录）
├─ runs\<run-id>\           # 单次 run 全部产物（gitignore）
└─ dsh-eval-harness\        # 插件代码（pnpm workspace）
```

`run-id` 格式：`<benchmark-slug>__<scope-slug>__<UTC 时间戳>`，例如
`aider-polyglot__py34__20261016T093000Z`。

## 每次 run 的目录树

```
runs\<run-id>\
├─ run.json                  # 运行清单：显式取值、benchmark commit、配置哈希、各版本
├─ run.log                   # 编排日志（阶段切换、错误）
├─ tasks.jsonl               # 任务实例列表
├─ profile\                  # 专用 eval profile 快照
│  ├─ package.json / cordis.yml / cordis.patch.yml
│  └─ dump-config.yml        # 合成后的完整配置
├─ dsh-home\                 # 本次 run 的私有 DSH_HOME（含 profiles/eval）
├─ report.json               # 归一化信封（看板数据源）
├─ dashboard\                # 静态看板
│  ├─ index.html
│  └─ assets\
└─ tasks\
   └─ <序号>-<任务名>\
      ├─ task.json           # 任务元数据：状态、耗时、session id、验证命令
      ├─ workspace\          # agent 工作区（跑完原样保留，作为证据）
      ├─ trace\              # 原始 DSH trace
      │  ├─ session.vN.jsonl       # 主会话
      │  └─ session.<n>.vN.jsonl   # 子会话（有 subagent 时）
      ├─ events.jsonl        # 归一化事件流
      ├─ metrics.json        # 固定指标
      ├─ checks.json         # benchmark 验证结果（逐测试 pass/fail）
      ├─ findings.json       # 诊断结论（首错、传播、恢复、可疑组件）
      ├─ agent\
      │  ├─ stdout.log
      │  └─ stderr.log
      ├─ container.log       # 仅 Docker 后端
      └─ verify\             # benchmark 验证器运行
         ├─ workspace\       # 工作区副本 + 注入的测试
         ├─ pytest.log       # 验证器原始输出
         └─ junit.xml        # 逐测试结果 → checks.json 来源
```

## 文件职责与产出阶段

| 文件 | 阶段 | 内容 | 保留 |
|---|---|---|---|
| `run.json` | 0 运行定义 | 必填字段、benchmark commit、配置哈希、版本 | 永久 |
| `tasks.jsonl` | 1 获取与物化 | 任务实例 | 永久 |
| `profile\*`、`dump-config.yml` | 2 eval profile 物化 | 被测层栈快照 | 永久 |
| `dsh-home\` | 2 物化 | 私有 DSH_HOME、eval profile 实体 | 永久 |
| `tasks\*\task.json` | 3–5 | 状态、耗时、session id | 永久 |
| `tasks\*\workspace\` | 4 执行 | agent 工作区（含其修改） | 默认保留，可关 |
| `tasks\*\trace\*.jsonl` | 4–5 | 原始 trace | 永久，只读 |
| `tasks\*\events.jsonl` | 5 采集 | 归一化事件流 | 永久（可重算） |
| `tasks\*\metrics.json` | 5 采集 | 固定指标 | 永久（可重算） |
| `tasks\*\checks.json` | 6 验证 | benchmark 原生测试结果 | 永久 |
| `tasks\*\verify\*` | 6 验证 | 验证器工作区与原始输出 | 永久 |
| `tasks\*\findings.json` | 7 诊断 | 证据链（指向事件 seq） | 永久 |
| `tasks\*\agent\*.log` | 4 执行 | 被测进程输出 | 永久 |
| `tasks\*\container.log` | 3–4 | Docker 后端容器输出 | 永久 |
| `report.json` | 8 报告 | 归一化信封 | 永久 |
| `dashboard\` | 8 报告 | 静态看板 | 永久 |

## 规则

1. **测试不进 agent 工作区**：题面与起始代码给 agent；测试留在验证侧，验证时才注入 `verify\workspace\`，避免泄题。
2. **验证不污染证据**：`workspace\` 是 agent 跑完的原样；测试在副本里跑，`junit.xml` 每个测试映射为一条 `check`。
3. **trace 按任务隔离**：eval profile 的 overlay 把 sessions root 指向 `tasks\<task>\trace`，`compression: none`；子会话同目录。
4. **Docker 同构**：目录不变，`workspace\`、`trace\` 挂载进容器；`run.json` 记录镜像 digest，不保存镜像本身。
5. **不落盘敏感信息**：模型凭据只经环境变量注入子进程，不写进任何产物。
6. **删除是显式的**：`workspace\` 默认保留；清理只允许删除 `runs\<run-id>\` 内已被确认的普通路径，不跟随 junction。
7. **路径长度**：任务目录用 `<序号>-<任务名>`，run-id 短，避免 Windows 260 字符限制。

## 保留策略

- 默认全部保留（任务数据集为 KB 级，trace 为 MB 级）。
- 可选：`workspace\`、`verify\workspace\`、`dsh-home\cache\` 按 run 参数删除或归档。
- `benchmarks\<bench>\` 是共享缓存，跨 run 复用，按 commit 冻结。
