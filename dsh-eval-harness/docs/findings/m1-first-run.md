# M1 首次真实评测记录（2026-10-17）

> 结论先行：benchmark 侧 **3/3 通过**，但 trace 侧记录到 **15 次工具级失败**（沙箱 ACL、网络、审批、workflow），全部被 agent 用替代路径绕过。**只看分数会完全看不到这些 Harness 问题**——这正是本项目要回答的问题。

## 运行清单

| 项 | 值 |
|---|---|
| Benchmark | Aider-AI/polyglot-benchmark，commit `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f` |
| 语言 / 任务 | python / `transpose`、`wordy`、`two-bucket`（显式指定） |
| DSH | `0.2.0-rc.2`；eval profile `eval-m1`（base + headless，私有 `DSH_HOME`，sessions 明文 JSONL） |
| 模型 | deepseek-official / deepseek-flash |
| 后端 | local（Windows） |
| 时间 / token | 319.6s / 975,756 tokens（cacheRead 为主） |
| 产物 | `runs/aider-polyglot__python3__20261017T034841Z/` |

## 结果

| 任务 | 状态 | checks | steps | tool calls | tool errors | tokens | llmMs | toolMs |
|---|---|---|---|---|---|---|---|---|
| transpose | passed | 12/12 | 11 | 15 | 6 | 354,987 | 89,751 | 64,681 |
| wordy | passed | 25/25 | 13 | 12 | 5 | 283,452 | 50,679 | 25,211 |
| two-bucket | passed | 9/9 | 13 | 13 | 5 | 337,317 | 95,422 | 1,846 |

## Harness 侧异常（分数之外）

1. **`workspace-write` 沙箱 ACL 授权失败（12 次 / 全部 pwsh 调用）**
   `Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)`。
   每次 `pwsh` 工具调用都在沙箱初始化阶段失败，agent 无法执行任何 shell 命令；它改用手写代码 + 只读工具完成任务。
   影响：benchmark 任务在真实环境下本应允许跑测试迭代，这次完全做不到；分数通过掩盖了环境缺陷。
2. **网络出口不可用（2 次 web_fetch）**：`TypeError: fetch failed`；agent 改为纯推理。
3. **审批链路不可用（1 次）**：agent 尝试把沙箱升级到 `danger-full-access`，返回 `requires approval, but no approval …`；非交互评测里没有审批者。
4. **workflow 工具失败（1 次）**：two-bucket 内 `workflow` 调用报错（trace 中有原始帧）。

## 复现

```powershell
cd plugins\dsh-eval-harness\dsh-eval-harness
npm run run:eval -- --benchmark-root "..\benchmarks\aider-polyglot" --tasks transpose,wordy,two-bucket --timeout 600000
# 采集器修复后离线重算指标（不消耗 API）：
node scripts/recompute-metrics.mjs --run "..\runs\<run-id>"
```

## 待验证的假设

- ACL 失败是否只发生在 `G:` 盘（换到 `<TEMP>` 输出目录再跑同一任务对比）。
- 把 eval profile 改成 `danger-full-access` 后，pwsh 是否恢复、任务轨迹与 token 如何变化（这就是第一个受控 A/B 实验）。
- 网络失败是环境（代理未注入）还是能力缺陷；评测容器应显式配置出口策略。
