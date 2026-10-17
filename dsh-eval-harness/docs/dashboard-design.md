# 看板设计（v1 已实现）

> 形态：**单文件静态 HTML**（`dashboard/index.html`，约 700 KB，离线可开、可直接分享）。
> 数据：由 `scripts/dashboard.mjs` 从 run 产物生成，注入为 `window.__DASHBOARD_DATA__`。
> 技术：React 19 + Vite 8 + TypeScript；**Mantine 9 设计系统**（MIT，仪表盘组件）+ Tabler 图标；
> `vite-plugin-singlefile` 内联 JS/CSS。布局为 AppShell（顶部栏 + 左侧导航 + 内容区），
> 视觉遵循 DSH UI 规范取向：中性表面色、单一靛蓝强调色、无渐变、字重 ≤ 500、统一字号层级。

## 信息架构（三模块 + 任务详情）

### 模块 1：运行摘要
- **Benchmark**：名称、语言、revision（pin 的 commit）、任务清单。
- **被测 DSH 配置**：dsh 版本、profile、provider/model、隔离后端。
- **运行清单**：开始时间、总耗时、token 总量、工具调用次数。
- **评测环境**：后端、平台/Node、沙箱/审批策略、网络策略、预检结果（旧格式 run 显示"未记录"）。

### 模块 2：DSH 运行指标
- **KPI**：turns/steps、工具调用、工具失败、token、LLM 时间、工具时间、重试、平均延迟。
- **Token 构成**：input / cache read / cache write / output / reasoning 堆叠条 + 图例。
- **运行异常**：从 trace 的失败 `tool/result` 自动归组，每条带 **layer 标签**（框架 / 环境 / 基准 / 适配器）+ 种类（sandbox-acl / network / approval / tool-error）+ 次数 + 受影响任务 + 一行归因说明；判据是"环境问题不能算成 DSH 缺陷"。
- **逐任务指标表**：步数、工具调用、工具失败、token、LLM/工具耗时、墙钟；点行进入任务详情。

### 模块 3：Benchmark 评测
- 评分环：任务通过率；副标 check 通过率。
- 逐任务：状态、checks 通过数、进度条；验证器错误（如有）。
- 判据完全来自 benchmark 自带验证器（pytest junit），不做二次评分。

### 任务详情（独立视图）
- 头部：状态、exit code、时长、是否超时。
- 迷你指标 + **执行链时间线**（tool call / tool error / turn 边界标记）。
- 验证结果逐测试列表；事件流（关键事件，可滚动）。
- 原始 trace 路径。

## 数据契约

```ts
DashboardData = {
  generatedAt, manifest{ runId, benchmark, benchmarkRevision, dshVersion, profile, model, backend },
  benchmark{ name, language, tasks[] }, totals{ tasks, passed, failed, errored, durationMs,
  totalTokens, toolCalls, toolErrors }, tasks: TaskData[], findings: Finding[]
}
TaskData = { id, status, durationMs, exitCode, timedOut, metrics, checks{ passed,total,ok,error?,items[] },
             events[], artifacts{ trace, workspace, verifyLog } }
Finding  = { kind, label, count, tasks[], confidence }
```

## 生成与使用

```powershell
npm run dashboard:app                                  # 构建看板应用（一次性，产物 dashboard/dist）
npm run run:eval -- --benchmark-root ... --tasks ...   # 跑评测，结束后自动生成看板
npm run dashboard -- --run <run-dir>                   # 已有 run 重新生成看板（不消耗 API）
```

产物：`runs/<run-id>/dashboard/index.html`（自包含，双击即可打开）。

## 设计原则

- 一页能读懂：benchmark 是什么、配置是什么、结果如何、问题在哪。
- 分数与运行证据并列：模块 3 给判定，模块 2 给「为什么/怎么跑完的」。
- 所有异常可回溯：findings 指向具体任务与失败文本。
- 离线优先：单文件、无外部网络依赖；后续接 DSH 面板时复用同一数据契约。

## 待优化（v2）

- 执行链可交互（点击事件看原始 JSON 帧、放大失败窗口）。
- 跨 run 对比视图（同一 benchmark 不同配置）。
- 视觉细节与信息密度按用户评审迭代。
