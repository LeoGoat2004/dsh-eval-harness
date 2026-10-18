# dsh-eval-harness（中文）

[English](README.md) | 中文

面向 DSH 的评测插件：用你确认过的 DSH Harness 跑 benchmark。它按声明式 manifest 执行 benchmark，
保留完整 session trace，与 benchmark 自带的验证器对齐，并生成独立的 HTML 报告，说明这次运行
失败在哪一步、归因到哪一层：模型、Harness、benchmark 还是环境。

## 环境要求

- DSH `0.2.1-rc.2`
- Node.js `>= 22.19`
- DSH profile 里已经配置好要评测的模型 provider
- 本地有 benchmark 检出，以及描述它的 manifest；它的环境需求会在运行前检查

## 安装

```bash
git clone <repository-url>
cd dsh-eval-harness
npm --prefix dsh-eval-harness install
npm --prefix dsh-eval-harness/dashboard install
npm --prefix dsh-eval-harness run build
dsh plugin --profile <profile> add ./dsh-eval-harness/packages/dsh-eval-harness
```

把 `<profile>` 换成你的 DSH profile 名（通常是 `desktop`），然后重启 DSH。

## 使用流程

1. **`eval_preflight`** —— 和你确认 Harness、模型与 benchmark；检查环境是否满足声明的需求；
   审计 profile 的隔离风险。它返回内容寻址的 `planDigest`，覆盖 manifest、确认的 profile、
   benchmark 检出与不含密钥的模型 route。
2. **`eval_manifest`** —— 校验 benchmark manifest；可选执行红绿检查（stub 必须失败，官方参考解必须通过）。
3. **`eval_run`** —— 在后台启动评测，必须携带 preflight 返回的 `planDigest`；确认内容变化会被拒绝。
   被测对象三种模式：`faithful-snapshot`（profile 原样使用）、`isolated-snapshot`（追加隔离/模型行，
   交互式 app bundle 换成 headless app，完整 mutation diff 入库；`profile-snapshot` 为别名）或固定最小对照
   `minimal-control`。容器模式下 agent 与 verifier 是两个容器：verifier 只看到一次性产物副本，
   报告记录 grader 可见性审计；verifier 引导阶段的瞬时失败在无法给出判据时会自动重试一次
   （manifest `verifyRetries`，0–3）。
4. **`eval_status`** —— 查询进度，获取 run 目录、报告路径与看板路径。
   job 记录跨重启保留；重启时仍在 running 的 job 会显示为 `interrupted`。
   对使用自定义 outputDir 的 run，传 `outputDir` 即可读取该目录下的 job 记录。

报告写在 `<run-dir>/dashboard/index.html`；安装后的插件同样能生成看板，不依赖开发目录。

接入新 benchmark 时：DSH agent 会读取 benchmark 结构并生成对应的 manifest，先校验（可做红绿检查）
再运行；随后按 manifest 声明的环境进行检查，环境就绪即可开始评测。

## 许可证

MIT
