export class WeChatPocResponder {
  constructor({
    runtimeClient,
    state,
    personaText,
    bibleText,
    cwd,
    model = '',
    timeoutMs = 120_000,
  }) {
    if (!runtimeClient || !state || !cwd) {
      throw new Error('WeChat POC responder dependencies are required');
    }
    this.runtimeClient = runtimeClient;
    this.state = state;
    this.personaText = String(personaText || '');
    this.bibleText = String(bibleText || '');
    this.cwd = cwd;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  historyText(event) {
    const history = this.state.history(event.chatId, event.senderId, 12);
    if (!history.length) return '（这是当前微信会话的第一条消息）';
    return history.map(item => `${item.role === 'user' ? '对方' : '助理'}：${item.content}`).join('\n');
  }

  async reply(event) {
    const context = event.conversationKind === 'group'
      ? '个人微信群聊明确 @ 触发'
      : '个人微信单聊';
    const prompt = `
${this.personaText}

工作与表达标准：
1. 你通过 AIPRO 的个人微信 POC 回复消息，保持自然、简洁，不要使用客服腔。
2. 不冒充本人已经阅读、同意、承诺或完成现实动作。
3. 当前只输出一段可以直接发送的文本回复，不输出内部过程、Markdown 标题或固定落款。
4. 不执行文件、图片、支付、红包、群发、联系人管理或业务系统写入。
5. 群聊仅因明确 @ 触发；回复需要适合公开群聊语境。

数字员工 Bible：
${this.bibleText}

当前入口：${context}

最近对话：
${this.historyText(event)}

本次消息：
${String(event.text || '').slice(0, 20_000)}
`.trim();
    const result = await this.runtimeClient.run(prompt, {
      cwd: this.cwd,
      model: this.model,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 1024 * 1024,
    });
    const text = String(result?.text || '').trim();
    if (!text) throw new Error('WeChat POC AI runtime returned an empty reply');
    return text.slice(0, 3800);
  }
}
