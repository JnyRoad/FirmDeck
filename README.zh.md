<div align="center">

<img src="packaging/assets/staffdeck.png" alt="StaffDeck 标志" width="150" />

# StaffDeck：构建、管理并持续进化企业数字员工


[English](./README.md) | **简体中文**
<p>
  <a href="#快速开始"><img alt="快速开始" src="https://img.shields.io/badge/快速开始-跑通首个_Demo-111111?style=for-the-badge" /></a>
  <a href="docs/tutorial.md"><img alt="使用教程" src="https://img.shields.io/badge/使用教程-StaffDeck-111111?style=for-the-badge" /></a>
  <a href="docs/api_spec.md"><img alt="API 参考" src="https://img.shields.io/badge/API-参考-111111?style=for-the-badge" /></a>
  <a href="https://github.com/OpenBMB/StaffDeck/issues"><img alt="问题反馈" src="https://img.shields.io/badge/问题反馈-Issues-111111?style=for-the-badge" /></a>
</p>

</div>

StaffDeck 为企业加速从数字化向智能化转型。

NEU-ModelBest Data Intelligence Joint Lab


## 更新日志

- 📌 **置顶 · 2026-07-15**：StaffDeck正式开源！欢迎大家使用反馈与Star支持。

# 💡 关于StaffDeck

StaffDeck是一套面向企业的数字员工构建与管理平台，帮助专业员工将工作经验、业务流程和判断标准固化为可以持续工作的数字员工，接手重复性任务，并将个人能力沉淀为可复用、可迭代、可追溯的组织资产。StaffDeck由[东北大学-面壁智能数据智能联合实验室](https://neuir.github.io/)，[清华大学THUNLP实验室](https://nlp.csai.tsinghua.edu.cn/)，[面壁智能](https://modelbest.cn/)，[OpenBMB](https://www.openbmb.cn/home)与[AI9Stars](https://github.com/AI9Stars)联合研发，面向希望将 AI 从个人效率工具升级为组织生产力的企业与机构。

## 核心亮点

- 🧑‍💼 **数字员工，而非通用机器人**：按员工隔离岗位描述、能力资源、会话、记忆与运营记录。
- 📚 **有依据的企业知识**：解析文档、检索相关上下文，并在回答中保留可追溯的引用来源。
- 🧩 **知识 + 通用技能 + SOP**：一次请求可以组合需要的能力，而非被限制为单一执行模式。
- 🔌 **真实工具执行**：通过 HTTP、MCP、内置工具和动态生成的技能 Runner 连接企业服务。
- ⏰ **定时与排队任务**：支持一次性或周期任务，并在刷新后保留聊天 Buffer 中的排队请求。
- 🔎 **全过程可观测**：将意图、路由、技能、工具、校验与回答事件流式写入每轮执行记录。
- 🤝 **Human-in-the-loop**：支持暂停、取消、转人工、待回答和人工审核，避免高风险动作完全自动决策。
- 🔐 **基于角色的治理**：区分广场资源、创建者归属、员工访问范围与仅管理员可用的操作。

## Agent 一键部署

将下面的 Prompt 粘贴给有仓库权限的 Cursor、Claude Code 或 Codex：

```text
阅读 https://raw.githubusercontent.com/OpenBMB/StaffDeck/main/README.zh.md。
克隆 OpenBMB/StaffDeck 私有仓库，准备 Python 3.11 和 Node.js 20，创建
backend/.venv，安装前后端依赖，将 backend/.env.example 复制为
backend/.env；缺少 OpenAI 兼容模型地址或 API Key 时向我询问；运行
DETACH=1 scripts/dev_up.sh，并验证 /api/health 和 /workspace/gallery 后再报告完成。
```

由于仓库为私有仓库，以上 Raw URL 同样需要 GitHub 身份验证。

## 目录

- [StaffDeck：构建、管理并持续进化企业数字员工](#staffdeck构建管理并持续进化企业数字员工)
  - [更新日志](#更新日志)
- [💡 关于StaffDeck](#-关于staffdeck)
  - [核心亮点](#核心亮点)
  - [Agent 一键部署](#agent-一键部署)
  - [目录](#目录)
  - [快速开始](#快速开始)
    - [环境要求](#环境要求)
    - [1. 克隆并安装](#1-克隆并安装)
    - [2. 配置模型](#2-配置模型)
    - [3. 启动 Web Demo](#3-启动-web-demo)
    - [4. 验证安装](#4-验证安装)
    - [常用命令](#常用命令)
  - [配置说明](#配置说明)
  - [核心流程](#核心流程)
  - [项目结构](#项目结构)
  - [开发与验证](#开发与验证)
  - [常见问题](#常见问题)
  - [路线图](#路线图)
  - [参与贡献](#参与贡献)
  - [风险与限制](#风险与限制)
  - [引用](#引用)
  - [许可证](#许可证)
  - [致谢](#致谢)

## 快速开始

### 环境要求

- 使用开发脚本时需要 macOS、Linux 或 WSL
- Python **3.11+**
- Node.js **20+** 与 npm
- OpenAI Chat Completions 兼容的模型接口和 API Key
- 应用本身不要求 CUDA；硬件要求由所选择的模型服务决定

### 1. 克隆并安装

```bash
git clone https://github.com/OpenBMB/StaffDeck.git
cd StaffDeck

python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -e "backend[dev]"
npm --prefix frontend-enterprise ci
cp backend/.env.example backend/.env
```

### 2. 配置模型

首次启动前编辑 `backend/.env`：

```dotenv
APP_SECRET="请替换为足够长的随机字符串"
DEMO_MODEL_BASE_URL="https://你的OpenAI兼容接口/v1"
DEMO_MODEL_NAME="你的模型名"
DEMO_MODEL_API_KEY="你的API-Key"
```

API Key 用于创建初始模型配置，存入数据库前会被加密。请勿提交 `backend/.env`。服务启动后也可以在**管理员 → 模型配置**中管理模型服务。

### 3. 启动 Web Demo

```bash
DETACH=1 scripts/dev_up.sh
```

脚本会构建 StaffDeck 前端，并由一个 FastAPI 进程在 `5173` 端口同时提供 UI、API 与 Swagger 文档。

### 4. 验证安装

```bash
curl http://127.0.0.1:5173/api/health
```

预期输出：

```json
{"status":"ok"}
```

打开 [http://127.0.0.1:5173/workspace/gallery](http://127.0.0.1:5173/workspace/gallery)，选择一个数字员工并发送首条消息。回答和执行记录应该在同一个对话轮次中流式显示。

### 常用命令

```bash
scripts/dev_status.sh       # 查看服务状态
scripts/dev_down.sh         # 停止本地服务
scripts/dev_up.sh           # 前台运行
```

> 完整说明 → [StaffDeck 使用教程](docs/tutorial.md)

## 配置说明

主要环境变量见 [`backend/.env.example`](backend/.env.example)。

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `APP_SECRET` | 加密模型凭据，非本地环境必须替换 | `change-me-in-development` |
| `DEMO_MODEL_BASE_URL` | 首次启动时创建模型配置所用的 OpenAI 兼容接口 | Demo 地址 |
| `DEMO_MODEL_NAME` | 初始模型标识 | `qwen3.6-27b` |
| `DEMO_MODEL_API_KEY` | 可选的初始模型 API Key | 空 |
| `TOOL_TIMEOUT_SECONDS` | HTTP 工具超时 | `8` |
| `GENERAL_SKILL_RUNTIME_PYTHON` | 通用技能 Runner 使用的 Python | 自动探测 |
| `GENERAL_SKILL_RUNTIME_PACKAGES` | 独立技能运行时校验或安装的依赖 | `requests,httpx` |

StaffDeck 支持可配置的 OpenAI 兼容模型服务，不在仓库中捆绑模型权重。上下文长度、多模态能力、输出限制和硬件需求取决于所选模型服务。



## 核心流程

1. **创建数字员工**：设置职位、岗位边界、服务风格、创建者与访问范围。
2. **配置员工能力**：从广场复制或自行创建知识库、通用技能、SOP 与工具，不修改广场原件。
3. **发起会话**：从数字员工广场或员工列表进入；发送首条消息后持久化正式 Session。
4. **执行并观测**：在执行记录中查看流式意图、检索、技能、工具、校验和回答事件。
5. **必要时介入**：继续排队请求、取消运行、转人工或处理待回答内容。
6. **持续运营**：利用记忆、反馈、对话日志和定时任务长期优化员工能力。

## 项目结构

```text
StaffDeck/
├── backend/                  # FastAPI 接口、Agent 运行时、存储与任务 Worker
├── frontend-enterprise/      # React/TypeScript StaffDeck 工作台
├── docs/                     # 教程、API、Schema 与示例流程
├── scripts/                  # 单端口服务生命周期与校验脚本
├── packaging/                # macOS、Linux 与 Windows 打包资源
├── README.md                 # English
└── README.zh.md              # 简体中文
```

## 开发与验证

```bash
# 后端测试
cd backend
.venv/bin/python -m pytest tests

# 前端 i18n 检查与生产构建
cd ../frontend-enterprise
npm run i18n:check
npm run build
```

修改 UI 后必须验证 `/workspace/*` 与 `/enterprise/*` 下的真实挂载路由，不能只测试孤立组件。

## 常见问题

<details>
<summary><strong>页面可以打开，但数字员工不回答。</strong></summary>

检查所选模型配置、API Key、模型名和模型服务网络。随后查看执行记录与 `.dev/logs/app.log`，定位模型服务返回的具体错误。
</details>

<details>
<summary><strong>5173 端口已被占用。</strong></summary>

先运行 `scripts/dev_down.sh`。若监听进程不属于 StaffDeck，应先确认其用途；只有确定可以终止时才使用 `FORCE_PORTS=1 scripts/dev_up.sh`。
</details>

<details>
<summary><strong>没有本地 GPU 可以运行吗？</strong></summary>

可以。应用调用 OpenAI 兼容模型接口，GPU 要求由你自行部署或使用的模型服务决定。
</details>

<details>
<summary><strong>为什么普通用户可以使用广场资源，但不能编辑？</strong></summary>

广场资源是可复用模板。普通用户可将有权限的资源复制或绑定到自己的员工，原始资源仍由创建者与管理员权限保护。
</details>

## 路线图

- [ ] 群聊，多数字员工沟通/分工
- [ ] 更多企业连接器与经过审核的广场资源
- [ ] 面向高风险工具动作的细粒度审批策略

路线优先级由真实部署需求驱动。请通过 [Issue](https://github.com/OpenBMB/StaffDeck/issues) 提供可复现的场景和预期行为。

## 参与贡献

欢迎获得仓库权限的协作者参与：

- 提交可复现的 Bug 与权限问题
- 提议数字员工、知识、技能、SOP 或工具流程
- 提交范围清晰、包含测试与浏览器校验的 PR
- 改进文档和中英翻译

请保留工作区中与任务无关的修改，根据影响范围补充测试，并在 PR 中写明完成 UI 校验的路由与用户角色。

## 风险与限制

- 模型回答可能不正确、不完整或不一致；执行记录可以提高可审计性，但不能保证结论正确。
- 知识检索效果受原始文档质量、解析、索引、权限与模型能力共同影响。
- 外部工具与生成的 Runner 可能产生真实副作用。应使用最小权限凭据，并为高风险动作配置人工审批。
- 定时任务依赖持续运行的 Worker 与正确的用户时区设置。
- 本项目不能替代法律、医疗、金融、安全及其他受监管领域的专业审核。
- 未获得适当授权、隐私保护与人工监督时，不得使用本平台处理数据或自动作出重要决定。

## 引用

在内部研究或经授权的公开材料中使用 StaffDeck 时，可引用：

```bibtex
@software{StaffDeck2026,
  title  = {StaffDeck: Build, Run, and Govern Enterprise Digital Employees},
  author = {OpenBMB},
  year   = {2026},
  url    = {https://github.com/OpenBMB/StaffDeck}
}
```

```bibtex
@article{chen2025ultrarag,
  title={UltraRAG: A Modular and Automated Toolkit for Adaptive Retrieval-Augmented Generation},
  author={Chen, Yuxuan and Guo, Dewen and Mei, Sen and Li, Xinze and Chen, Hao and Li, Yishan and Wang, Yixuan and Tang, Chaoyue and Wang, Ruobing and Wu, Dingjun and others},
  journal={arXiv preprint arXiv:2504.08761},
  year={2025}
}
```

## 许可证

本项目基于 GNU Affero General Public License v3.0 开源。

## 致谢

StaffDeck 由 [OpenBMB](https://www.openbmb.cn/) 生态孵化。
