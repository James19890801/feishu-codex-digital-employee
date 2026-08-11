# AI Coding macOS 一键安装包设计

## 1. 目标

交付一个可直接发给其他人的 macOS ZIP 安装包。对方解压后，在 Codex、Qoder 或其他能执行本地命令的 AI Coding 工具中只需运行：

```bash
zsh ./install.command
```

该命令完成源码安装、依赖检查、安全初始化、LaunchAgent 注册、服务启动和健康验收，最后打开本机 Dashboard。

“一键安装”不包括代替新用户完成企业 OAuth、输入验证码、选择授权会话或提供个人语料。这些是不能代理的用户授权边界。

## 2. 交付形态

产物目录为 `dist/personal-digital-human-macos-<version>/`，并生成同名 ZIP：

```text
personal-digital-human-macos-<version>/
├── install.command
├── AI_CODING_INSTALL.md
├── release-manifest.json
├── SHA256SUMS
└── payload/
    ├── src/
    ├── dashboard/
    ├── scripts/
    ├── templates/
    ├── config.distribution.json
    ├── package.json
    ├── pnpm-lock.yaml
    ├── pnpm-workspace.yaml
    └── requirements.txt
```

ZIP 只是便携容器，不把源码伪装成签名 `.pkg`。本轮不引入 Apple 开发者证书、公证或自动更新服务。

最终实现只打包本机运行时实际需要的 `src`、Dashboard、安装/健康脚本和空模板；云端许可 Worker、macOS App 构建源码及其测试不进入面向最终用户的 ZIP。

## 3. 安装流程

`install.command` 执行以下有界流程：

1. 确认系统为 macOS，确认 CPU 架构和当前用户目录。
2. 优先使用 AI Coding 工具已提供的 Node.js，其次使用 `PATH` 中的 Node.js；版本必须不低于 `22.5.0`。
3. 校验 `SHA256SUMS`，任一 payload 文件不匹配就立即停止。
4. 将 payload 安装到 `~/Library/Application Support/AchongDigitalHuman`。升级时保留该目录中的 `config.local.json`、`PERSONA.md`、`BIBLE.md` 和 `data/`。
5. 使用 `pnpm install --frozen-lockfile` 安装 Node 依赖；若本机没有 pnpm，通过 Corepack 启用锁定版本，不全局安装未锁定依赖。
6. 在安装目录内建立专用 Python virtualenv 并安装 `requirements.txt`，不修改系统 Python。
7. 首次安装时，从发行模板生成本地配置和 Persona/Bible。所有 IM 通道、1A 和外部写入默认关闭，授权会话使用不可命中的安全占位值，确保未配置时零自动回复。
8. 探测 Codex、Qoder 或 CodeBuddy 的无界面运行时；至少一个可用才启动核心服务。
9. 仅注册本产品的主服务和 Dashboard LaunchAgent，不修改其他服务、shell profile 或全局环境变量。
10. 运行配置校验、运行时探针和 Dashboard 健康检查，然后打开 `http://127.0.0.1:17655/`。

安装脚本必须支持幂等重跑。任一步失败时保留旧安装和用户数据，并输出确切失败步骤；不得在失败后宣称已安装。

## 4. 安全初始状态

`config.distribution.json` 与阿充本机配置完全分离：

- `feishuEnabled=false`
- `dingtalkEnabled=false`
- `wecomEnabled=false`
- `geweEnabled=false`
- `a1Enabled=false`
- `multicaEnabled=false`
- `allowAllChats=false`
- `authorizedChatIds=["__SETUP_REQUIRED__"]`
- `digitalTwinLabel=""`
- `aiRuntime="auto"`
- 不包含 profile、OpenDingTalkId、`DWS_CHANNEL`、组织 ID、手机号、密钥或任何本机授权结果。项目自身的 1A 路由能力可随源码保留，但在新安装中默认关闭。

Dashboard 可用但通道处于“待配置”。用户必须在本机完成自己的身份、消息范围和通道授权，才能产生第一条自动回复。

## 5. 隐私与分发物边界

打包使用明确允许清单，不依赖 `.gitignore` 作为唯一安全边界。分发物禁止包含：

- `.git/`、`node_modules/`、`dist/`、`.worktrees/`、任何构建缓存。
- `config.local.json`、本机 Persona/Bible、Keychain 导出、邀请码、恢复包或 Founder 材料。
- `data/`、SQLite/WAL/SHM、聊天记录、会议记录、审计记录、备份和任何日志。
- `knowledge-catalog.json`、`knowledge-source-manifest.json`、本机文档路径或个人知识索引。
- 阿充的通讯录 ID、DWS profile、渠道码、黑名单、语气样本、内部对话和个人专属链接。
- 项目设计/回归文档中的个人身份、工号、OpenDingTalkId、回执 ID 或内部仓库地址。

构建后执行二次扫描：路径级禁止清单 + 内容级敏感模式扫描。扫描命中时不生成 ZIP。

## 6. AI Coding 使用说明

`AI_CODING_INSTALL.md` 首屏只提供三件事：

1. 把解压目录交给 AI Coding 工具。
2. 要求工具运行 `zsh ./install.command`。
3. 安装完成后打开本地 Dashboard，完成属于新用户的授权。

说明必须明确：不要把密钥、验证码或聊天记录粘贴给 AI Coding 模型；OAuth 由用户在终端/浏览器中自行完成。

## 7. 验收与回归

发布前必须通过：

1. 现有 `npm run check` 和 `npm test`。
2. 打包单测：允许清单、禁止文件、敏感内容、manifest 和 checksum。
3. 安装单测：首装、重跑、升级保留用户数据、校验和失败回滚。
4. 在与当前工作目录隔离的临时目录解压 ZIP，使用测试专用 HOME 和 launchctl stub 运行 `install.command`。
5. 新安装必须生成安全默认配置，不包含阿充数据，不发送任何消息或创建 1A 需求。
6. 两个 LaunchAgent plist 只指向新安装目录，并绑定 `127.0.0.1`。
7. 最终 ZIP 再次解压回读，生成文件数、字节数、SHA-256 和隐私扫描报告。

## 8. 不在本轮范围

- Windows 或 Linux 服务安装。
- Apple 签名 `.pkg`、公证、DMG 美化或自动更新。
- 为新用户代理 OAuth、分发阿充凭据或复制阿充个人知识。
- 把阿充专用的四人黑名单写入通用源码包。
- 把本地 Dashboard 暴露到公网。
