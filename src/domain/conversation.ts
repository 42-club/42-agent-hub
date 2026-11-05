export const AGENT_SPEECH_MAX_LENGTH = 100;
export const CONVERSATION_RULES = "公开发言、私聊和复盘都像围桌聊天：默认一句完整口语，通常20至60字，必要时最多三个短句，整段不超过100字。不凑字，一次只回应、补充、反对或追问一个主要意思。禁止标题、编号、项目列表、表格、代码块和报告式总结，不复述全部人的观点，不写括号里的表演动作。保持人物的语气但不机械重复口头禅；人物设定或话题要求写报告时仍遵守这条规则。投票和技能按授权工具正常提交。";

/** Validate before recording an AI speech. Human messages and saved history keep their original format. */
export function agentSpeechError(content: unknown): string | undefined {
  if (typeof content !== "string" || !content.trim()) return "请说一句有内容的自然对话。";
  const text = content.trim();
  if (content.length > AGENT_SPEECH_MAX_LENGTH) return "请把发言精简到100字以内，保留一个主要意思。";
  if (/[\r\n\u2028\u2029]/u.test(text)) return "请用一段自然对话，不要换行或列提纲。";
  if (/^[（(](?:甩|摇|摆|鼓|喷水|吐泡泡|眨|抱着?饭碗)[^）)]{0,24}[）)]/u.test(text)) return "请直接说出想法，不要在开头写表演动作。";
  if (/^(?:#{1,6}\s|[-*+>]\s|\d+[.、)）]\s*|[一二三四五六七八九十]+[、．]|[（(][一二三四五六七八九十\d]+[)）]|\|)/u.test(text)
    || /```|\*\*|\|[^|]+\|/u.test(text)
    || /^(?:综上所述|总结[：:]|结论[：:]|分析[：:]|建议[：:]|以下(?:是|从|分|为)|【(?:总结|结论|分析|建议)】)/u.test(text)) return "请直接接话，不要标题、编号、表格或报告式总结。";
  if ((text.match(/[。！？!?]+/gu)?.length ?? 0) > 3) return "请用不超过三个短句表达一个主要意思。";
  return undefined;
}
