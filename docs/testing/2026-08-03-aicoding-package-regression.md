# AI Coding macOS 发行包回归报告

## 结论

发行包通过源码门禁、白名单打包、隐私扫描、逐文件 checksum、ZIP 解压回读、隔离 HOME 安装和当前本机运行时健康检查。最终交付物不会在首次安装后自动回复、发送通知或写入 1A；所有通道和外部写入默认关闭。

## 最终产物

- 文件：`dist/personal-digital-human-macos-1.0.0.zip`
- SHA-256：`f6edd483d985d5b5a424f8403cc328439d10ec7c8e80ddd391ea93c3070154a4`
- Payload 文件数：100
- Payload 字节数：858669
- 安装入口：`zsh ./install.command`

## 已通过

1. `npm run check`：通过，包括 Node 语法、Swift 类型检查、当前配置和 Python helper 检查。
2. `npm test`：通过；机制验收 87/87，失败 0。
3. `npm run test:install-service`：通过。
4. 发行默认值测试：飞书、钉钉、企业微信、个人微信、1A、Multica 和许可强制均关闭；`allowAllChats=false`；授权会话为不可命中的安全占位值。
5. 打包器测试：只复制显式白名单；排除 `.git`、`node_modules`、测试、文档、本机配置、Persona/Bible、知识索引、数据、SQLite、日志和恢复材料。
6. 最终 ZIP 解压后，`SHA256SUMS` 中 100 个 payload 文件全部校验通过。
7. 最终解压目录二次隐私扫描：`ok=true`，违规 0；本机 4 位受保护联系人的姓名、工号和 OpenID 均未进入通用发行包。
8. 隔离 HOME 安装：返回 `INSTALL_OK`；生成安全配置、Persona、Bible 和空知识目录；仅发生 2 次 LaunchAgent bootstrap。
9. 安装器回归：首装、幂等重跑、用户配置/Persona/Bible/data 保留、payload 篡改拒绝、服务注册失败回滚全部通过。
10. 当前本机运行时：`healthy=true`、`issues=[]`；钉钉已安装/认证/连接；飞书关闭；AI 运行时选中 Codex；1A pending/dead 均为 0。

## 失败后已修复

- 操作者身份、问候、隐私边界、会话风格和 Dashboard 最初仍有个人硬编码；由失败用例定位后统一改为本地配置驱动。
- DWS 历史读取最初只接受单一本机绝对路径；已改为接受标准绝对 `dws` 可执行文件，同时拒绝 Wukong 和合成转发路径。
- 安全发行模板和一键安装入口最初不存在；已补齐并通过红绿测试。
- 首次真实打包时，隐私扫描命中个人开发者文案和个人微信提及名；已改为通用文案/配置化入口后重新构建并通过。
- 安装器 checksum 篡改和 LaunchAgent 失败场景已确认分别拒绝安装和恢复旧目录。
- 自动通信黑名单原先只停留在产品约定、没有进入运行时；现已增加入站队列拦截与发送前最终拦截，只有操作者明确授权的手动发送允许越过，通用发行包保持空名单。

## 明确未执行

- 未在一台全新 Mac 上真实下载全部 Node/Python 依赖；隔离验收使用测试专用的依赖跳过开关，依赖安装路径由安装器单测和现有依赖锁文件覆盖。
- 未代替新用户完成 Codex、DWS 或企业通道 OAuth，也未输入验证码。
- 未使用隔离包发送真实 IM 消息、自动通知或创建/更新 1A 工作项。
- 本次为验证黑名单修复，已重启当前机器的真实核心 LaunchAgent；隔离安装器回归仍使用可审计的 launchctl stub。
