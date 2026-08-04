# 参与 James 开发

James 是阿里内部使用的 Local-first AI 数字人项目，唯一维护者是阿充（James Feng）。欢迎通过 Codeup Issue 和 Merge Request 提交可复现、可验证、边界清晰的改进。

## 开发原则

1. 先说明用户问题和成功标准，再修改实现。
2. 新功能和缺陷修复遵循红—绿—重构：测试必须先失败，再提交最小实现。
3. 权限、身份、会话、外发和业务写入不能只依赖 Prompt，必须有确定性代码门禁。
4. 不把认证失败、数据源不可读或未执行描述成“没有数据”或“已完成”。
5. DWS 只允许 `event-stream`；不得增加悟空、Wukong polling、桌面自动化或静默降级。
6. 不提交个人配置、聊天、数据库、日志、Token、恢复材料、黑名单和本机绝对路径。

## 本地检查

```zsh
pnpm install
npm run check
npm test
npm run test:distribution-package
npm run test:install-aicoding
```

## Merge Request 要求

- 标题说明用户可见的结果。
- 描述包含背景、修改范围、权限/隐私影响、失败路径和验证证据。
- 关联对应 1A 工作项（如果存在）。
- 附上失败测试与修复后通过结果。
- 不在 MR、评论、日志或截图中暴露企业敏感信息。
- 评审意见由评审人确认后关闭，不代替评审人自动 resolve。

## 提交信息

使用清晰的语义前缀：`feat:`、`fix:`、`docs:`、`test:`、`refactor:`、`chore:`。

一个提交应当表达一个可独立评审的结果；不要混入与目标无关的格式化或个人工作区文件。
