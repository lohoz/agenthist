<div align="center">
  <h1>AgentHist</h1>
  <p><strong>本地编程 Agent 的历史管理、迁移、转换与跨会话经验提炼工具。</strong></p>
  <p><a href="README.md">English</a> | 简体中文</p>
  <p>
    <a href="https://www.npmjs.com/package/agenthist"><img alt="npm" src="https://img.shields.io/npm/v/agenthist?label=npm"></a>
    <a href="https://github.com/lohoz/agenthist/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue"></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  </p>
</div>

## Overview

AgentHist 集中整理受支持的编程 Agent 会话，提供查看、搜索、导出和选择性导入，并支持同工具跨机器迁移与跨 Agent 转换。

它还能从多个会话中发现反复出现的要求、偏好和工作方法，结合原始证据整理为可进一步筛选、合并和改写的经验候选。增量处理与分级模型调用可以减少重复分析的开销。

## ✨ Highlights

- **统一历史**：扫描受支持的 Agent，在一个入口中查看、搜索和整理会话。
- **选择性迁移**：按 Agent 或会话导出，在目标机器上预览并选择需要恢复的内容。
- **跨 Agent 转换**：导入时选择目标 Agent，逐会话报告保留、省略和重建的内容。
- **安全写入**：识别重复会话，在写入前报告冲突，并通过 transaction 支持恢复和回滚。
- **跨会话经验提炼**：发现长期使用 Agent 时反复出现的要求和工作方法，保留原文证据与未归类样本。

## 🤖 支持的 Agent

| Agent | 查看与搜索 | 同工具迁移 | 转换到其他 Agent |
| --- | --- | --- | --- |
| Codex | ✓ | ✓ | ✓ |
| Claude Code | ✓ | ✓ | ✓ |
| OpenCode | ✓ | ✓ | ✓ |
| Pi | ✓ | ✓ | ✓ |

## 📦 安装

需要 Node.js 24。

```bash
npm install -g agenthist
```

也可以直接使用 npx：

```bash
npx agenthist --help
```

## 让 Agent 使用 AgentHist

安装一份简洁的使用说明，让受支持的 Agent 在需要管理、迁移或提炼历史时选择合适的 AgentHist 命令：

```bash
agenthist skill install
```

默认安装到全部受支持的 Agent，也可以重复使用 `--agent` 只选择其中一部分。使用 `agenthist skill uninstall` 移除，完整用法见 [`agenthist skill`](docs/commands/skill.md)。

## ⌨️ 命令

| 命令 | 用途 |
| --- | --- |
| [`doctor`](docs/commands/doctor.md) | 检查本机的 Agent 历史位置 |
| [`scan`](docs/commands/scan.md) | 更新 AgentHist 历史库 |
| [`history`](docs/commands/history.md) | 查看、搜索和整理会话 |
| [`export`](docs/commands/export.md) | 导出 `.agenthist` 文件 |
| [`inspect`](docs/commands/inspect.md) | 查看导出文件中的内容 |
| [`import`](docs/commands/import.md) | 恢复会话或转换到另一个 Agent |
| [`experience`](docs/commands/experience.md) | 从历史中提炼跨会话经验 |
| [`skill`](docs/commands/skill.md) | 安装或移除 AgentHist 使用说明 |
| [`codex provider`](docs/commands/codex-provider.md) | 整理 Codex 会话的 provider |
| [`transaction`](docs/commands/transaction.md) | 查看、回滚和恢复写入操作 |

完整索引见[命令参考](docs/commands/README.md)。

## 🗂️ 管理历史

首次使用时检查本机历史位置：

```bash
agenthist doctor
```

扫描完成后即可查看和搜索：

```bash
agenthist scan
agenthist history list
agenthist history search "关键词"
agenthist history show <session-ref>
```

`scan` 会把已发现的历史复制到 AgentHist 的本地历史库。之后可以随时重新运行，加入新产生的会话。

`session-ref` 是 AgentHist 生成的会话唯一标识，例如 `ahsr1_codex_ck1_7d4c...`，可在 `history list` 或 `history search` 中查看。

## 🔄 迁移与转换

在源机器上更新历史库并导出：

```bash
agenthist scan
agenthist export -o backup.agenthist
```

`export` 默认包含全部会话。只迁移部分内容时，可以按 Agent 或 `session-ref` 筛选：

```bash
agenthist export --agent codex -o codex.agenthist
agenthist export --session <session-ref> -o selected.agenthist
```

把文件复制到目标机器后运行：

```bash
agenthist inspect backup.agenthist
agenthist import backup.agenthist
```

`import` 会打开交互界面，用于选择会话、目标 Agent、工作区路径和最终写入计划。默认选择全部会话，并恢复到各自的来源 Agent。

### 工作区路径

会话记录了原工作区。目标机器上的目录不同，可以在交互界面中重新选择，也可以提供路径映射：

```bash
agenthist import backup.agenthist --dry-run \
  --map-path /home/alice/projects=/Users/alice/work
```

目标目录必须存在。Windows 与 Linux/macOS 之间迁移时需要映射路径。

### 转换 Agent

交互界面可以为每个会话选择目标 Agent。脚本中使用 `--to` 批量转换，先预览，再用相同参数写入：

```bash
agenthist import backup.agenthist --to claude --dry-run
agenthist import backup.agenthist --to claude --apply
```

原生迁移保留 Agent 的原始记录。跨 Agent 转换会在写入前列出省略或重建的内容；无法可靠转换的会话不会写入。

完整用法见 [`agenthist import`](docs/commands/import.md)。

## 🧠 经验提炼

从多个会话中寻找反复出现的要求、偏好和工作方法，并保留每项候选的来源证据。

### 选择历史

```bash
agenthist experience --all --dry-run
agenthist experience --workspace ../api --workspace ../web --dry-run
agenthist experience --session <session-ref> --dry-run
```

可以处理全部历史、一个或多个工作区，也可以指定会话。`--dry-run` 会显示处理范围、模型请求数和预计 token，不连接模型。

### 配置模型

首次使用时，AgentHist 会通过受支持的本地 Agent CLI 发送一条不含历史的请求，并将第一个可用的 CLI 写入 `.env.agenthist`；都不可用时生成 API 配置模板。

指定本机已经配置好的 Agent CLI：

```dotenv
AGENTHIST_EXPERIENCE_BACKEND=codex # 也可使用其他受支持的 Agent CLI
```

默认使用该 Agent CLI 的默认模型；需要指定模型时，再配置 `AGENTHIST_EXPERIENCE_FAST_MODEL` 或 `AGENTHIST_EXPERIENCE_DEEP_MODEL`。

使用 OpenAI 兼容 API：

```dotenv
AGENTHIST_EXPERIENCE_BACKEND=api
AGENTHIST_EXPERIENCE_BASE_URL=https://example.com/v1
AGENTHIST_EXPERIENCE_API_KEY=your-key
AGENTHIST_EXPERIENCE_FAST_MODEL=fast-model

# 可选
AGENTHIST_EXPERIENCE_DEEP_MODEL=deep-model
```

fast model 提取证据，可选的 deep model 整理跨会话候选；未配置 deep model 时，两步都使用 fast model。

```bash
agenthist experience model check
```

该命令检查所选后端，不发送历史内容。完整设置见 [`agenthist experience`](docs/commands/experience.md)。

### 输出结果

确认范围和模型后运行：

```bash
agenthist experience --all
```

默认在当前目录创建 `agenthist-experience-*`：

| 文件 | 内容 |
| --- | --- |
| `review.md` | 待确认的经验候选、支持证据、原文引用和审核 prompt |
| `audit.md` | 未进入候选组的证据 |

新建会话并提供整个结果目录，即可对照 `review.md` 与 `audit.md` 筛选、合并、改写或拒绝经验候选。

重复运行会复用未变化会话的本地索引和模型缓存。范围选择、模型变量和输入预算见 [`agenthist experience`](docs/commands/experience.md)。

## 使用提示

- `.agenthist` 保存聊天内容和相关历史数据，请像保管原始聊天记录一样保管它；
- AgentHist 处理历史记录，不包含 Base URL、API Key、Token、OAuth 等连接信息；
- `agenthist help <command>` 可以查看终端内帮助。

常见疑问见 [FAQ](docs/faq.md)。

## 从源码运行

在项目目录中执行：

```bash
npm ci
npm run build
npm link
agenthist --help
```

## License

[MIT](LICENSE)
