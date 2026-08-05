# 钉钉文档实时读取回归记录

日期：2026-08-05  
范围：AIPR0S 钉钉实时消息中的文档链接读取、本人文档搜索、授权边界、回答 grounding、公共网页读取隔离及本地部署前回归。

## 结论

- 钉钉消息按通道进入 DWS 文档适配器，不调用飞书资料搜索。
- 当前消息中明确提供的钉钉文档链接可由任意发送者触发只读；非本人无链接时不会执行账号级关键词搜索。
- 本人可通过标题或关键词使用 `drive search` 搜索，并对命中文档执行 `doc read`。
- 读取成功时，正文、标题和钉钉来源作为本轮回答依据；读取失败时只生成钉钉失败提示，不猜测正文。
- 钉钉内部文档 URL 不再进入公共网页读取器。

## 自动化回归

在隔离工作树执行以下完整命令，最终退出码均为 0：

```text
npm test
npm run check
npm run test:distribution-package
npm run test:dws-deployment-policy
git diff --check
```

关键结果：

- `DINGTALK_KNOWLEDGE_TEST_OK`
- `KNOWLEDGE_ROUTER_TEST_OK`
- `WEB_READER_TEST_OK`
- `MULTIMODAL_PIPELINE_TEST_OK`
- `MECHANISM_ACCEPTANCE_OK 89`，89/89 通过
- `JAMES_MACOS_APP_BUNDLE_TEST_OK`
- `CONFIG_OK runtime=codex`
- `PYTHON_HELPERS_OK`
- `DISTRIBUTION_PACKAGE_TEST_OK`
- `DWS_DEPLOYMENT_POLICY_TEST_OK`

覆盖了精确 host/path 识别、重复链接、伪造 host、直接读取、本人搜索、非本人禁止账号级搜索、目录显式授权、最多三份文档、单文档与总字符上限、部分失败、全部失败、空正文、node 不匹配、钉钉/飞书通道隔离以及内部 URL 的公共网页隔离。

## 真实 DWS 验收

验收使用数字人平台配置的绝对 DWS 二进制、Profile 和命令级 Channel，未使用 PATH 中的其他 DWS，也未打印配置值。

- 操作系统：Darwin
- DWS 版本：1.0.56
- 认证：已认证，access token 与 refresh token 状态有效
- `drive search --query`：成功，`doc_results.documents` 命中 1 份
- 文档标题：`会话级文件直传接口`
- node ID：`14lgGw3P8vxjwogPCgQMwPNnV5daZ90D`
- `doc read`：`success=true`，标题和 node ID 一致，正文非空
- 真实适配器：`source=dingtalk`，`documentCount=1`，`failureCount=0`，正文非空
- 真实通道路由与 grounding：正文已注入钉钉资料提示，飞书 resolver 调用数为 0，未包含飞书降级提示

真实文档正文、DWS Channel、Profile、Token 和本机配置均未写入本记录或 Git。

## 权限和审计复查

- 任意发送者只能通过当前消息中的显式钉钉文档链接触发该链接读取。
- 只有账号本人可执行账号级关键词搜索。
- 非本人无链接请求只允许读取知识目录中 `status=active` 且 `readerIds` 明确包含发送者的 `dingtalk_doc`。
- 单次最多读取 3 份文档；正文按单文档和总上下文上限截断。
- 审计仅记录成功文档数、失败数、not-found 和 unavailable 布尔值，不记录正文或凭证。
- 功能保持只读，不修改文档、权限或对外转发。

## 尚待同次交付完成的运行态证据

本记录提交后将从主项目目录合并并重装 LaunchAgent，再执行运行态健康检查和 Codeup 远端 SHA 回读。若运行态或远端回读失败，不得把本次交付报告为完成。
