import assert from 'node:assert/strict';
import {
  abstractPrivateKnowledge,
  isExcludedKnowledgePath,
  isLikelyKnowledgeHtml,
  isSafeKnowledgeEvidence,
  opaqueSourceHandle,
} from './local-wiki-policy.mjs';

assert.equal(isExcludedKnowledgePath('/Users/test/Documents/articles/ai-flow.html'), false);
assert.equal(isExcludedKnowledgePath('/Users/test/project/node_modules/pkg/index.html'), true);
assert.equal(isExcludedKnowledgePath('/Users/test/project/dist/index.html'), true);
assert.equal(isExcludedKnowledgePath('/Users/test/Library/Application Support/browser/page.html'), true);
assert.equal(isExcludedKnowledgePath('/Users/test/.ssh/private.html'), true);
assert.equal(isExcludedKnowledgePath('/Users/test/Documents/xwechat_files/cache/page.html'), true);

assert.equal(isLikelyKnowledgeHtml({
  path: '/Users/test/Documents/articles/ai-flow.html',
  html: '<html><head><title>AI进入流程之后</title></head><body><button>一键复制</button><article><h1>AI进入流程之后</h1><p>这是一篇完整的专业文章，讨论组织、流程与人工智能如何协同。</p></article></body></html>',
}), true);
assert.equal(isLikelyKnowledgeHtml({
  path: '/Users/test/project/coverage/index.html',
  html: '<html><body><table><tr><td>coverage</td></tr></table></body></html>',
}), false);

const redacted = abstractPrivateKnowledge(`
客户：星河制造有限公司
合作项目：灯塔转型计划
联系人：张三，电话 13800138000，邮箱 zhangsan@example.com
我们在该客户现场总结出：流程中的 AI 必须先明确责任边界，再设计人机协同。
`);
assert.doesNotMatch(redacted.text, /星河|灯塔|张三|13800138000|zhangsan|example\.com/);
assert.match(redacted.text, /某企业|某项目/);
assert.match(redacted.text, /责任边界/);
assert.equal(redacted.safe, true);
assert.ok(redacted.redactionCount >= 4);

const handle = opaqueSourceHandle('/Users/test/Documents/客户A/项目复盘.html');
assert.match(handle, /^src_[a-f0-9]{16}$/);
assert.doesNotMatch(handle, /客户|项目|Users/);
assert.equal(handle, opaqueSourceHandle('/Users/test/Documents/客户A/项目复盘.html'));

assert.equal(isSafeKnowledgeEvidence('AI进入流程后，需要重新设计目标和责任。'), true);
assert.equal(isSafeKnowledgeEvidence('某客户项目的合同与联系人需要跟进。'), false);
assert.equal(isSafeKnowledgeEvidence('请查看 /Users/test/Documents/private.html'), false);

console.log('LOCAL_WIKI_POLICY_TEST_OK');
