# James 阿里内部 macOS 部署指南

本发行包供阿里内部同学在 macOS 的 AI Coding 工具中安装。唯一开发者和维护者是**阿充**；每位安装者仍使用自己的数字人身份、DWS Profile、Channel 和企业账号认证。

## 部署原则

- 钉钉只走独立 DWS CLI 的 `event-stream`。
- 不安装、不启动、不依赖悟空，不允许 `wukong-polling`，也不做悟空兜底。
- 安装包不携带阿充或其他人的账号、Token、OpenDingTalkId、工号、Profile、Channel、聊天、记忆、知识或黑名单。
- 新安装默认启用钉钉 DWS；飞书、企业微信、个人微信、1A、Multica 和其他外部写入默认关闭。
- 在本人身份、DWS 认证、Channel 和授权范围配置完成前，不应开启自动回复。

## 环境要求

1. 受管 macOS 与阿里内部账号。
2. Node.js `22.5.0` 或更高版本。
3. AI Coding 工具或等价终端。
4. 独立安装的 DWS CLI，不能位于 `.real/.bin/dws` 等悟空目录，也不能是名称包含 Wukong 的包装器。
5. 可无头运行的本地 AI CLI Runtime，推荐 Codex。

## 第一步：准备独立 DWS

```zsh
npm install -g dingtalk-workspace-cli@1.0.55
dws --version
dws auth login
dws auth status --format json
```

认证结果必须明确显示当前账号已登录且 Token 有效。进程存在或 `doctor` 通过不能代替真实认证。

记录 DWS 绝对路径：

```zsh
command -v dws
```

如果输出路径位于悟空目录或通过软链接解析到悟空目录，本安装器会拒绝。请安装独立 DWS CLI。

## 第二步：一键安装

解压发行 ZIP，在 AI Coding 终端进入解压目录，只运行：

```zsh
JAMES_DWS_BIN="$(command -v dws)" zsh ./install.command
```

如果 DWS 已位于以下标准位置，可以省略 `JAMES_DWS_BIN`：

```text
~/.npm-global/bin/dws
~/.local/bin/dws-official
~/.local/bin/dws
```

安装器会：

1. 校验 `SHA256SUMS` 中的全部 payload 文件。
2. 校验唯一开发者元数据。
3. 解析并验证独立 DWS 可执行文件，拒绝悟空路径。
4. 把程序安装到当前 macOS 用户目录。
5. 首装时生成不含个人数据的配置、Persona、Bible 和空知识目录。
6. 升级时保留现有 `config.local.json`、Persona、Bible 和 `data/`。
7. 注册核心服务与 Dashboard 的 LaunchAgent。
8. 验证 Dashboard 后打开 `http://127.0.0.1:17655/`。
9. 任一步骤失败时终止或回滚到升级前目录。

## 第三步：配置自己的数字人

在本机 Dashboard 中填写并保存：

- 操作者姓名、角色和别名。
- 自己的 DWS Profile。
- 自己的 DWS Channel。
- 自己的 OpenDingTalkId。
- 允许自动处理的会话范围。
- 自动通信黑名单。
- 实际可用的 AI Runtime。

这些值只保存在当前机器，不会回写到发行包或 Git。

配置必须保持：

```json
{
  "dingtalkEnabled": true,
  "dingtalkTransport": "event-stream"
}
```

任何 `wukong-polling` 配置都会在服务启动前失败，错误信息会要求迁移到 `event-stream`。

## 第四步：连接验收

在安装目录执行：

```zsh
npm run check
npm test
npm run health
```

验收至少包含：

- DWS CLI 路径为允许的独立安装路径。
- `dingtalkTransport=event-stream`。
- DWS `authenticated=true`。
- DWS event-stream 已出现 ready，Dashboard 显示 `connected=true`。
- AI Runtime 已选中且最近一次真实调用成功。
- SQLite integrity 为 `ok`。
- pending、processing、failed、dead 没有异常积压。
- 黑名单联系人不会自动回复或收到自动通知。
- 群聊只有明确 `@` 才触发。

不要通过给真实联系人发送无关消息来验收。优先使用单元测试、机制验收和本人受控自聊；任何真实外发都需要明确授权和送达回执。

## 常见失败

### `Wukong is not allowed`

DWS 路径位于悟空目录、软链接最终指向悟空，或可执行文件名含 Wukong。安装独立 DWS 后重新传入绝对路径。

### `A standalone DWS CLI is required`

安装器没有找到允许的 DWS。执行 `command -v dws`，确认文件可执行，然后通过 `JAMES_DWS_BIN` 显式传入。

### DWS 已安装但 Dashboard 未连接

先运行：

```zsh
dws auth status --format json
```

再核对本人 Profile、Channel 和 event-stream 权限。未认证、Channel 错误或事件权限不足都必须显示为未就绪，不能当作“没有消息”。

### AI Runtime 显示已安装但不可用

“已检测”只代表本机存在程序。需要执行真实 Runtime 冒烟并检查认证、模型、网络、工作目录和权限。

### 升级后旧配置无法启动

如果旧配置仍使用 `wukong-polling`，将其迁移为 `event-stream` 并配置独立 DWS；系统不会自动降级或改走其他通道。

## 隐私和安全

- Dashboard 只绑定本机回环地址，但所选 AI Runtime、DWS 和 1A 仍可能访问企业或云端服务。
- 不要把 `config.local.json`、数据库、日志、Token、聊天原文或个人标识提交到仓库。
- 不要把同事消息用于未经授权的长期记忆或全企业聊天归档。
- 高风险写操作必须经过 Owner 校验和明确确认。
- 自动通信黑名单默认硬拦截，只有操作者明确授权的单次手动发送可以越过。

项目原理、完整机制与卖点见 [README.md](README.md)。
