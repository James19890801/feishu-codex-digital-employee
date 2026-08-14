# Changelog

本文件记录面向使用者的主要变化。详细实现与验证以 Git 提交和 `docs/testing/` 为准。

## Unreleased

### Changed

- 阿里内部部署固定使用独立 DWS `event-stream`，运行时拒绝 Wukong polling。
- 唯一开发者与维护者收敛为阿充（James Feng）。
- 新安装默认启用钉钉 DWS，但不携带 Profile、Channel、账号或认证材料。
- 安装器解析独立 DWS 可执行文件，并拒绝悟空目录、Wukong 包装器及对应软链接。
- 根目录 README 重写为完整的产品、架构、机制、部署和安全说明。

### Added

- 自动通信黑名单的入站与发送前双层拦截。
- 阿里内部 DWS 部署指南、贡献规范和安全报告规范。

## 1.0.0

- Local-first 数字人核心运行时。
- 钉钉真人身份事件流、会话上下文和受控回复。
- SQLite 持久化队列、去重、会话串行、重试、死信、审计与备份。
- Persona、Bible、记忆、知识和 AI Runtime 适配。
- 1A 需求处理、回读、状态订阅与通知。
- 本地 Dashboard、配置校验、服务监督和健康检查。
