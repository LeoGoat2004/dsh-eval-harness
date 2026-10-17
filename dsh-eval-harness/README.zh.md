# dsh-eval-harness（中文）

[English](README.md) | 中文

面向 DSH 的评测插件：用你确认过的 DSH 配置跑 benchmark。它按声明式 manifest 执行 benchmark，
保留完整 session trace，与 benchmark 自带的验证器对齐，并生成独立的 HTML 报告，说明这次运行
失败在哪一步、归因到哪一层：模型、Harness、benchmark 还是环境。

## 环境要求

- DSH `0.2.x`
- Node.js `>= 22.19`
- DSH profile 里已经配置好要评测的模型 provider
- 本地有 benchmark 检出，以及描述它的 manifest；benchmark 的运行环境由你或 Harness 提供，
  插件只声明、检查并记录

## 安装

```bash
git clone <repository-url>
cd dsh-eval-harness
npm --prefix dsh-eval-harness install
npm --prefix dsh-eval-harness run build
dsh plugin --profile <profile> add ./dsh-eval-harness/packages/dsh-eval-harness
```

把 `<profile>` 换成你的 DSH profile 名（通常是 `desktop`），然后重启 DSH。

## 使用流程

1. **`eval_preflight`** —— 和你确认 Harness、模型与 benchmark；探测 manifest 声明的环境需求；
   审计 profile 的隔离风险。缺失的环境只报告，不安装。
2. **`eval_manifest`** —— 校验 benchmark manifest；可选执行红绿检查（stub 必须失败，官方参考解必须通过）。
3. **`eval_run`** —— 在后台启动一次评测，返回 job token。
4. **`eval_status`** —— 查询进度，获取 run 目录、报告路径与看板路径。

报告写在 `<run-dir>/dashboard/index.html`。

接入新 benchmark 时：DSH agent 会读取 benchmark 结构并生成对应的 manifest，先校验（可做红绿检查）
再运行；随后按 manifest 声明的环境进行检查，环境就绪即可开始评测。

## 许可证

MIT
