# James Codeup / DWS 发布回归报告

## 发布结论

- Codeup 仓库：<https://code.alibaba-inc.com/james/local-digital-human>
- 仓库可见性：阿里内部私有仓库
- 唯一开发者：阿充（James Feng）
- 运行时：用户本机 Codex Runtime
- 钉钉通道：独立 DWS `event-stream`
- 悟空通道：部署策略硬禁用
- 交付方式：直接推送 Codeup，不生成 ZIP

## 发布范围

本次发布覆盖专业项目首页、AI Coding 安装说明、贡献与安全策略、版本记录、唯一开发者治理、独立 DWS 路径校验，以及 event-stream-only 运行时约束。

发布提交明确排除工作区中与本次交付无关的用户自有改动：两份人工接管源码改动与一份本地产品全景介绍文档。

## 环境核验

| 项目 | 结果 |
| --- | --- |
| 操作系统 | macOS / Darwin |
| DWS 版本 | `v1.0.55` |
| DWS 身份 | 已登录阿里巴巴企业账号 |
| DWS 可执行文件 | 独立 `dingtalk-workspace-cli`，非悟空代理路径 |
| 通道策略 | 仅允许 `event-stream` |

## 自动化验证

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 完整测试套件 | `npm test` | 87/87 通过，0 失败 |
| 配置与辅助程序检查 | `npm run check` | 通过 |
| AI Coding 安装验证 | `node scripts/install-aicoding.test.mjs` | 通过 |
| 分发边界验证 | `node scripts/distribution-package.test.mjs` | 通过 |
| DWS 部署策略 | `node scripts/dws-deployment-policy.test.mjs` | 通过 |
| 运行时通道约束 | `node src/runtime-mode.test.mjs` | 通过 |

## 关键边缘场景

- 配置为 `wukong-polling` 时启动失败，并给出明确的 event-stream-only 错误。
- DWS 可执行文件路径或符号链接最终指向悟空目录时，安装失败。
- 新安装会写入经过真实路径解析的独立 DWS 绝对路径；升级不会覆盖用户已有本地配置。
- 分发产物只允许唯一开发者“阿充”，授权恢复材料只生成 James Feng 一份。
- 公开开发者标识可进入发布内容；本机账号、密钥、会话和其他本地配置仍被隐私扫描拦截。
- 黑名单自动回复和自动通知保持硬拦截；只有用户明确授权的手动发送可以例外放行。

## 未执行事项

- 未生成或发布 ZIP 包。
- 本次发布验证没有发送真实钉钉消息，避免把仓库发布回归与业务消息副作用混在一起。
