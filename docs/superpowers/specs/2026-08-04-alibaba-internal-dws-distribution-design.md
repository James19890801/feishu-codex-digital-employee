# 阿里内部 DWS 发行包设计

## 目标

生成一个供阿里内部同学通过 AI Coding 一键安装的 macOS 发行包。发行方只保留一位开发者“阿充”；每位安装者仍是自己数字人的操作者，不继承阿充的账号、身份、记忆或凭据。钉钉消息链路固定使用独立 DWS Channel 的 event-stream，不使用悟空，不自动降级到悟空。

## 发行身份

- 唯一开发者和维护者：`阿充`。
- `package.json` 与发行清单都保存该开发者信息，发行清单使用单元素 `developers` 数组，禁止出现第二位开发者。
- 开发者身份与 `ownerDisplayName`、`ownerRole`、`ownerAliases` 分离。安装者首次配置时填写自己的操作者身份。
- 安装包不得包含阿充的 OpenDingTalkId、工号、手机号、DWS Profile、DWS Channel、Token、黑名单、聊天记录、记忆或知识文件。

## 钉钉通道

- 新安装的 `dingtalkEnabled` 默认为 `true`。
- `dingtalkTransport` 固定为 `event-stream`。
- 运行时配置校验只接受 `event-stream`；任何 `wukong-polling` 配置都立即失败，且不得自动回退到桌面控制、悟空或其他消息通道。
- DWS 二进制、Profile 和 Channel 由安装者本机提供。安装包不分发 DWS 二进制，不保存任何认证结果。
- 安装器优先使用显式 `JAMES_DWS_BIN`，否则探测允许的独立 DWS 路径；解析后的路径如果位于悟空目录或名称表明是 Wukong 包装器，则拒绝。
- DWS 缺失或认证失败时必须明确显示未就绪，不得把通道标记为连接成功。

## 部署说明

`AI_CODING_INSTALL.md` 必须写清：

1. 适用范围是阿里内部 macOS 与 AI Coding。
2. 唯一开发者为阿充，安装者身份彼此隔离。
3. 安装前需要可独立执行的 DWS CLI；不安装、不启动、不依赖悟空。
4. 安装后由本人完成 DWS 登录，并在 Dashboard 填写自己的 Profile、Channel 和操作者身份。
5. 验收必须检查配置 transport、DWS 认证、event-stream ready、Dashboard 健康状态；不以进程存在代替通道可用。
6. 明确禁止 `wukong-polling` 及任何自动降级。

## 安全和失败策略

- 新安装仍保持飞书、企业微信、个人微信、1A、Multica 和许可强制关闭。
- 在 DWS 尚未登录或 Channel 尚未配置前，不允许发送消息或自动通知。
- 任何含 Wukong 路径或 transport 的部署配置都失败关闭。
- 升级安装继续保留现有本地配置、Persona、Bible 与数据；如果旧配置使用 `wukong-polling`，升级后核心服务不得启动，并给出迁移到 `event-stream` 的明确错误。

## 验收标准

1. 发行清单中 `developers` 严格等于 `["阿充"]`。
2. 新安装配置中 `dingtalkEnabled=true`、`dingtalkTransport="event-stream"`。
3. `wukong-polling` 配置被单元测试证明会失败。
4. 安装器测试证明合法独立 DWS 路径被写入，悟空路径被拒绝。
5. 通用发行包隐私扫描不包含阿充个人账号和本机配置值。
6. 完整测试、安装器回归、ZIP checksum、解压回读和发行包隐私扫描全部通过。

## 非目标

- 不把阿充固定为所有安装实例的操作者。
- 不捆绑 DWS、Codex Token 或企业账号认证。
- 不在安装期间发送真实钉钉消息。
- 不增加悟空兜底、桌面自动化兜底或第二条消息通道。
