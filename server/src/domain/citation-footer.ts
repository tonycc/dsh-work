/**
 * 平台在回答末尾追加的资料页脚（企业知识与受控记忆）。
 *
 * 页脚随回答存入消息，下一轮又作为对话历史发给模型；模型会照着历史格式自己写一段“本次检索到的资料”，
 * 平台再追加一次，员工就看到两段且编号可能不一致（2026-11-12 KO8/KO9 对比：39 个回答中 11 个）。
 * 因此历史发给模型前去掉页脚，平台追加页脚前也先去掉模型自己写在末尾的同类段落。
 */
export const knowledgeFooterHeading = '本次检索到的资料'
export const memoryFooterHeading = '受控记忆参考（非权威业务事实）'

export const knowledgeFooterNotes = {
  noMatch: '已查询所添加的知识库，没有找到相关内容，本次回答未引用企业知识。',
  agentNotPermitted: '当前 AI 同事未开通企业知识，本次未使用所添加的知识库。',
  unavailable: '企业知识库暂不可用，本次回答未引用企业知识。',
  skipped: (name: string) => `知识库“${name}”你已无权查看，本次未使用。`,
  moved: (name: string) => `知识库“${name}”的连接已更换，暂不可用，本次未使用；如需继续使用请联系管理员。`,
}

const knowledgeFooterPatterns: RegExp[] = [
  new RegExp(`^${knowledgeFooterHeading}(\\n- 【\\d+】.*)+$`),
  new RegExp(`^${escape(knowledgeFooterNotes.noMatch)}$`),
  new RegExp(`^${escape(knowledgeFooterNotes.agentNotPermitted)}$`),
  new RegExp(`^${escape(knowledgeFooterNotes.unavailable)}$`),
  /^知识库“[^”\n]*”你已无权查看，本次未使用。$/,
  /^知识库“[^”\n]*”的连接已更换，暂不可用，本次未使用；如需继续使用请联系管理员。$/,
]
const memoryFooterPatterns: RegExp[] = [new RegExp(`^${escape(memoryFooterHeading)}(\\n- 【M\\d+】.*)+$`)]

/** 去掉回答末尾连续的企业知识页脚段落（平台追加的或模型照抄的）。 */
export function stripKnowledgeFooter(content: string): string {
  return stripTrailing(content, knowledgeFooterPatterns)
}

/** 去掉回答末尾连续的企业知识与受控记忆页脚段落，用于把历史回答发给模型之前。 */
export function stripCitationFooters(content: string): string {
  return stripTrailing(content, [...knowledgeFooterPatterns, ...memoryFooterPatterns])
}

function stripTrailing(content: string, patterns: RegExp[]): string {
  const paragraphs = content.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/)
  let end = paragraphs.length
  while (end > 0 && patterns.some(pattern => pattern.test(paragraphs[end - 1]!.trim()))) end -= 1
  return end === paragraphs.length ? content : paragraphs.slice(0, end).join('\n\n').trimEnd()
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
