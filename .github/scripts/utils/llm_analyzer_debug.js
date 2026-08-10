const ARK_API = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const ARK_KEY = process.env.ARK_API_KEY || "";
const MODEL = "deepseek-v4-flash-260425";

async function callLLM(systemPrompt, userPrompt, maxTokens = 8000) {
  const resp = await fetch(ARK_API, {
    method: "POST",
    headers: { "Authorization": `Bearer ${ARK_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });
  if (!resp.ok) throw new Error(`LLM error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json(); console.error("DEBUG data.choices:", JSON.stringify(data.choices?.[0]?.message).substring(0,200));
  return data.choices?.[0]?.message?.content || "";
}

async function smartSample(messages, maxSample = 60) {
  const msgList = messages.map((m, i) => ({
    id: i, author: m.author_name || "?", timestamp: m.timestamp || "",
    text: (m.content || "").substring(0, 500).replace(/\n/g, " "),
    reply_count: m.reply_count || 0,
    has_attachments: !!(m.attachments && m.attachments.length)
  }));

  if (msgList.length <= maxSample) return msgList;

  const sys = `你是社群运营分析专家。从消息列表中挑选最值得深度分析的 ${maxSample} 条。
评分：重要性(运营/产品相关、投诉、建议) > 讨论度(回复量) > 情感强度 > 信息密度 > 代表性。
返回 JSON: {"ids": [挑选的消息id]}，只返回 JSON。`;

  if (msgList.length <= 300) {
    const usr = msgList.map(m => `[${m.id}] ${m.author} [${m.reply_count}回复]: ${m.text}`).join("\n");
    const result = await callLLM(sys, usr, 2000);
    try {
      const ids = new Set(JSON.parse(result.trim().replace(/```json|```/g, "")).ids);
      return msgList.filter(m => ids.has(m.id)).slice(0, maxSample);
    } catch {
      return msgList.sort((a, b) => b.reply_count - a.reply_count).slice(0, maxSample);
    }
  }

  const candidates = [];
  for (let b = 0; b < Math.ceil(msgList.length / 300); b++) {
    const batch = msgList.slice(b * 300, (b + 1) * 300);
    const usr = batch.map(m => `[${m.id}] ${m.author} [${m.reply_count}回复]: ${m.text}`).join("\n");
    try {
      const result = await callLLM(sys, usr, 2000);
      const ids = new Set(JSON.parse(result.trim().replace(/```json|```/g, "")).ids);
      candidates.push(...batch.filter(m => ids.has(m.id)));
    } catch { candidates.push(...batch.sort((a, b) => b.reply_count - a.reply_count).slice(0, 60)); }
  }
  return candidates.sort((a, b) => b.reply_count - a.reply_count).slice(0, maxSample);
}

async function deepAnalyze(sampledMessages, periodLabel, prevSummary = "") {
  const msgTexts = sampledMessages.map(m =>
    `[${m.author}] ${m.reply_count ? `[${m.reply_count}回复]` : ""}: ${m.text || ""}`
  ).join("\n\n");

  const sys = `你是 Mochi Bot，Yoyo Creative Studio 的社群运营分析专家。
根据精选消息，输出 JSON（不要 markdown）：
{
  "llm_analysis": {
    "summary": "一句话总结本周期社群状态",
    "hot_topics": [{"topic":"具体话题名","level":"high|medium|low","detail":"详细描述：谁主导、核心讨论点、达成共识、潜在影响","participants":["用户"]}],
    "pain_points": [{"issue":"痛点描述","severity":"critical|watch|low","detail":"受影响人群、为何是问题、是否有解决方案"}],
    "highlights": [{"event":"亮点描述","detail":"产生的积极影响"}],
    "representative_quotes": ["最有代表性的发言原文，保持原语言"],
    "emerging_trends": "新出现的话题/行为趋势",
    "weekly_verdict": "核心问题总结 + 下周运营重点建议",
    "sentiment_map": {"positive": 数字,"neutral": 数字,"negative": 数字}
  },
  "problem_diagnosis": {
    "problems": [{"title":"问题","status":"ongoing|new|resolved","detail":"现状","impact":"量化影响","solution":"建议方案"}],
    "risks": [{"risk":"潜在风险","probability":"high|medium|low","mitigation":"应对方案"}],
    "health_score": 0-100
  },
  "action_plan": {
    "this_week": [{"action":"行动","priority":"P0|P1|P2","goal":"量化目标"}],
    "next_week": [{"action":"行动","priority":"P0|P1|P2"}],
    "this_month": [{"action":"行动","priority":"P0|P1|P2"}]
  },
  "auto_tags": {"消息id":{"topic":"细粒度话题","sentiment":"positive|neutral|negative","type":"question|share|feedback|discussion|complaint|announcement|greeting|other"}}
}
要求：话题描述具体（如"VIP礼物延迟"而非"用户提问"）；痛点有具体影响；行动计划可量化；英文原文不翻译。`;

  const usr = `分析周期：${periodLabel}\n${prevSummary ? `前周期摘要（供对比）：${prevSummary}\n` : ""}\n精选消息：\n\n${msgTexts}`;
  const result = await callLLM(sys, usr, 8000);
  try { return JSON.parse(result.trim().replace(/```json|```/g, "").trim()); }
  catch (e) { console.error("Parse error:", e.message); return null; }
}

module.exports = { callLLM, smartSample, deepAnalyze };
