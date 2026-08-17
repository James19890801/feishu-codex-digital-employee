# 钉钉 DWS Channel 小白部署指南

本项目的小白用户主路径是钉钉，不是飞书或其他通道。小白用户可以假设电脑上没有
Node.js、Python、pnpm、Homebrew，也没有管理员权限。

## 小白用户只需做一件事

把本 GitHub 链接丢给 WorkBuddy、Qoder Work 或其他可操作项目的 AI Coding 工具，
再发这句话：

> 请严格按仓库 AGENTS.md 完成本机安装。我要接入的是钉钉 DWS Channel，不是飞书或其他通道。请自动补齐环境、安装和启动服务、引导我完成本人钉钉 OAuth、验证 DWS 事件流和 AI Runtime，并打开本地 Dashboard。不要让我自己复制终端命令；只在必须由我登录、授权或选择消息范围时暂停。

AI 工具应该继续执行，直到给出分项验收结果，而不是只克隆仓库或只打开
README。

## 安装器会自动做什么

- 识别 macOS、Windows 或 Linux 和 CPU 架构。
- 没有合格 Node.js 时，下载官方 Node.js `22.23.2` 便携版，并使用官方 SHA-256
  清单校验。安装在当前用户目录，不需要管理员权限。
- 使用项目固定的 pnpm 版本安装生产依赖。Python 只用于可选文档能力，不是首次
  启动的前置。
- 安装固定版本的独立 `dingtalk-workspace-cli` (`dws`)，禁止 Wukong 和
  LegacyBridge 路径。
- 创建当前用户级服务：macOS 使用 LaunchAgent，Windows 使用当前用户计划任务，
  Linux 使用 systemd user service。
- 初始配置失败关闭：钉钉授权前不启用，飞书、企业微信、个人微信、自动学习、
  关系记忆和外部写入都默认关闭。
- 尝试打开钉钉 OAuth。登录成功后自动写入当前 Profile、启用 `event-stream`并重启
  主服务。
- 对 Dashboard 校验安装 ID、build SHA、安装目录、主进程 PID 和 SQLite integrity，
  不会把其他程序占用同一端口误报为成功。

## 钉钉授权说明

DWS 使用小白用户自己的钉钉 OAuth 登录，不需要把密码、短信验证码或 Token 交给
项目。`DWS_CHANNEL` 是受控组织可能要求的渠道归因码：

- 普通组织留空即可。
- 只有返回 `CHANNEL_REQUIRED` 等组织策略错误时，才向组织管理员索取与
  当前宿主/业务匹配的已登记渠道码。
- 渠道码不是密钥，但也不能随机尝试或借用其他产品的码。

## 安全的消息范围

程序首次安装后的 `authorizedChatIds` 是 `__SETUP_REQUIRED__`，因此不会自动回复
任何钉钉会话。AI 工具必须请小白用户明确选择：

- 只授权具体的测试私聊/测试群（更安全）；或
- 明确开启所有单聊与群里对本人的 `@` 触发。

自动通信黑名单使用稳定的钉钉 ID，在入队前、队列消费前和每次外发前都会
再次拦截。

## 验收时不要误判

Dashboard 会分开显示：

1. DWS CLI 已安装；
2. 钉钉已登录；
3. Profile 已选；
4. DWS Channel 归因码是留空（普通组织）还是已配置（受控组织）；
5. DWS 个人事件流已出现 `[event] ready`；
6. WorkBuddy / Qoder Work 等 AI Runtime 已完成一次真实无工具文本调用；
7. 受控测试消息已入站并回复。

真实消息验收要让另一个受控钉钉账号发私聊，或在受控测试群中 `@` 小白用户。
DWS 会过滤当前用户自己发的消息，所以“自己发给自己”不能证明事件流可用。

本地面板地址：`http://127.0.0.1:17655/?setup=dingtalk`。
