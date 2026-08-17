# AI Coding 小白部署指令

当用户要求安装、升级、修复或验收本项目时，必须在当前 WorkBuddy、Qoder Work
或其他 AI Coding 会话中推进到可验收状态。不要让小白用户自己复制命令、
安装 Homebrew/pnpm/Python，也不要要求管理员权限。

## 唯一学员主路径

钉钉 → 项目随包安装的独立 `dingtalk-workspace-cli` (`dws`) → DWS Channel 个人事件流
→ James 本地服务 → 当前可用的 AI Runtime。飞书、企业微信、个人微信和其他通道
默认关闭，不得作为学员安装的替代路径。禁止使用 Wukong 或 LegacyBridge。

## 必须完成的流程

1. 识别 macOS、Windows 或 Linux，以及 CPU 架构。
2. 先检测 Node.js `>=22.13.0` 且能加载 `node:sqlite`。如果没有：
   - macOS/Linux 运行仓库根目录 `install.command`；
   - Windows 运行仓库根目录 `install.ps1`。
   入口会下载并校验官方便携 Node，不写系统目录。
3. 已有合格 Node 时，从仓库根目录运行 `node ./install.mjs`。
4. 安装器会安装固定版本 DWS、注册当前用户服务、启动 Dashboard，并尝试打开
   钉钉 OAuth。只在用户本人登录、操作系统权限或范围授权时暂停，每次只请用户
   做一个具体动作，完成后继续。
5. 如果输出 `DINGTALK_SETUP_PENDING`，立即运行输出的 `DINGTALK_SETUP_COMMAND`，不要把命令
   丢给用户。
6. `DWS_CHANNEL` 是受控组织的渠道归因码，普通组织留空。只能填组织管理员明确
   授权给当前宿主/业务的码；不得试猜、轮询渠道表或伪装成其他产品。
7. 检测 WorkBuddy、Qoder Work、Qoder、CodeBuddy 和 Codex 的真实 headless CLI。不得要求
   Codex，也不得把“桌面 App 存在”当成“后台运行时可用”。必须完成一次无工具的
   真实文本调用才能标记 real-call-ready。
8. 请用户明确选择自动处理范围。默认的 `__SETUP_REQUIRED__` 不会回复任何会话；
   只在用户明确授权后，才可将精确的 `enterpriseChat:user:<id>` / `enterpriseChat:group:<id>`
   写入 `authorizedChatIds`，或由用户明确开启 `allowAllChats`。
9. 运行已安装目录中的 `npm run verify:install` 和 `npm run check:dingtalk`。源码树有完整依赖时
   另外运行 `npm run test:beginner-install`。
10. 打开 `http://127.0.0.1:17655/?setup=dingtalk`。必须核对安装 ID、build SHA、
    安装目录、主进程 PID 和 SQLite integrity；不得把端口上任意 `2xx` 当成安装成功。
11. 真实收消息验收必须由另一个受控钉钉账号私聊，或在受控测试群明确 `@`
    当前用户。DWS 会过滤当前用户自己发的消息，所以“发给自己”不是有效验收。

## 完成口径

最终报告必须分开说明：安装器通过、主服务在线、Dashboard 在线、DWS 已安装、
钉钉已认证、Profile 已选、DWS event-stream 已就绪、AI Runtime 真实调用通过、
受控消息已收到和已回复。没有证据的项必须标记“待完成”，不得统称“部署成功”。
