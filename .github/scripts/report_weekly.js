#!/usr/bin/env node
const { callLLM, smartSample, deepAnalyze } = require("./utils/llm_analyzer");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const BASE = "https://discord.com/api/v10";
const H = { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" };

const GUILDS = {
  small: { id: "1458340952358785193", name: "Yoyo Creative Studio" },
  large: { id: "1427259763334451220", name: "My Leisure Time" },
};

const FEISHU_WEBHOOKS = {
 "small-weekly": "https://open.feishu.cn/open-apis/bot/v2/hook/a770eb64-5613-4078-904d-ac649b47b145",
 "large-weekly": "https://open.feishu.cn/open-apis/bot/v2/hook/cb6d6d02-3168-4db5-8c84-0fe9ec3e4283",
};

const $ = async (u) => {
    let retries = 0;
    while (retries < 5) {
      try {
        const r = await fetch(u, { headers: H });
        if (r.status === 429) {
          const after = parseInt(r.headers.get("Retry-After") || "5") * 1000;
          const wait = Math.max(after, (retries + 1) * 2000);
          console.error(`Discord 429, retry ${retries+1}/5 in ${wait/1000}s`);
          await new Promise(r2 => setTimeout(r2, wait));
          retries++;
          continue;
        }
        if (!r.ok) { console.error(`Discord ${r.status}: ${u.slice(0,80)}`); return null; }
        return r.json();
      } catch(e) { console.error(`Fetch threw: ${e.message}`); await new Promise(r2 => setTimeout(r2, 2000)); retries++; }
    }
    return null;
  };

async function scanMessages(guildId, startTime, endTime) {
  const channels = await $(`${BASE}/guilds/${guildId}/channels`);
  if (!channels) throw new Error("Cannot fetch channels");
  const textChannels = channels.filter(c => c.type === 0);

  let allMessages = [], totalCount = 0;
  const activeUsers = new Set();
  const channelStats = {}, userStats = {};
  const dailyCounts = Array(7).fill(0);

  const SKIP_CHANNELS = new Set(["1427268474996265045"]); // moderator-only (private admin chat)

  for (const ch of textChannels) {
    if (SKIP_CHANNELS.has(ch.id)) { console.error(`⏭️ 跳过: #${ch.name}`); continue; }
    let before = null, done = false, chCount = 0;
    while (!done) {
      try {
        let url = `${BASE}/channels/${ch.id}/messages?limit=100`;
        if (before) url += `&before=${before}`;
        const msgs = await $(url);
        if (!Array.isArray(msgs) || !msgs.length) break;
        for (const m of msgs) {
          const t = new Date(m.timestamp).getTime();
          if (t < startTime) { done = true; break; }
          if (t > endTime) continue;
          if (m.author && m.author.bot) continue;
          chCount++; totalCount++;
          const uid = m.author.id;
          const uname = m.author.global_name || m.author.username || "?";
          activeUsers.add(uid);
          userStats[uid] = { name: uname, count: (userStats[uid]?.count || 0) + 1 };
          const dayIdx = Math.floor((t - startTime) / 86400000);
          if (dayIdx >= 0 && dayIdx < 7) dailyCounts[dayIdx]++;
          allMessages.push({
            author_name: uname, author_id: uid,
            content: m.content || "", timestamp: m.timestamp,
            channel: ch.name,
            reply_count: m.referenced_message ? 1 : 0,
            attachments: m.attachments || [],
            has_link: /https?:\/\//.test(m.content || ""),
          });
        }
        if (done || msgs.length < 100) break;
        before = msgs[msgs.length - 1].id;
      } catch (e) { break; }
    }
    if (chCount > 0) channelStats[ch.name] = chCount;
  }
  const topUsers = Object.entries(userStats).sort((a, b) => b[1].count - a[1].count).slice(0, 10).map(([id, { name, count }]) => ({ name, count }));
  return { totalCount, activeUsers: activeUsers.size, channelStats, userStats, dailyCounts, topUsers, allMessages };
}

function getWeekRange(offset = 0) {
  const now = new Date();
  const dow = now.getDay();
  const base = new Date(now); base.setDate(base.getDate() - 7 * offset);
  const diff = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(base); mon.setDate(base.getDate() + diff); mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23, 59, 59, 999);
  return { start: mon.getTime(), end: sun.getTime(), label: `${mon.toLocaleDateString("zh-CN")} ~ ${sun.toLocaleDateString("zh-CN")}` };
}

function generateHTML(guildName, curData, prevData, llmAnalysis) {
  const cur = curData, prev = prevData;
  const msgGrowth = prev.totalCount > 0 ? ((cur.totalCount - prev.totalCount) / prev.totalCount * 100).toFixed(1) : "N/A";
  const userGrowth = prev.activeUsers > 0 ? ((cur.activeUsers - prev.activeUsers) / prev.activeUsers * 100).toFixed(1) : "N/A";
  const an = llmAnalysis?.llm_analysis || {};
  const diag = llmAnalysis?.problem_diagnosis || {};
  const plan = llmAnalysis?.action_plan || {};
  const genDate = new Date().toLocaleDateString("zh-CN");
  const fmt = n => (n || 0).toLocaleString("zh-CN");

  const topicsHTML = an.hot_topics?.map(t => `
    <div class="topic-card">
      <div class="top"><span class="name">${t.level==="high"?"🔥":t.level==="medium"?"📊":"💬"} ${t.topic}</span><span class="level ${t.level}">${t.level==="high"?"高讨论度":t.level==="medium"?"中讨论度":"一般"}</span></div>
      <div class="detail">${t.detail||""}</div>
      ${t.participants?`<div class="parts">👥 ${t.participants.join("、")}</div>`:""}
    </div>`).join("") || "";

  const painsHTML = an.pain_points?.map(p => `
    <div class="pain-card ${p.severity||"watch"}">
      <div class="pain-title">⚠️ ${p.issue}</div>
      <div class="pain-detail">${p.detail||""}</div>
      ${p.solution?`<div class="pain-fix">💡 ${p.solution}</div>`:""}
    </div>`).join("") || "";

  const highlightsHTML = an.highlights?.map(h => `<div class="highlight-card"><div class="hl-title">✨ ${h.event}</div><div class="hl-detail">${h.detail||""}</div></div>`).join("") || "";
  const quotesHTML = an.representative_quotes?.map(q => `<div class="quote-block">${q}</div>`).join("") || "";
  const scoreColor = (diag.health_score||70) > 70 ? "linear-gradient(90deg,#00e676,#00d4ff)" : (diag.health_score||70) > 40 ? "linear-gradient(90deg,#ffab00,#ff6b6b)" : "linear-gradient(90deg,#ff6b6b,#ff1744)";

  const problemsHTML = diag.problems?.map(p => `
    <div class="pain-card ${p.status==="new"?"critical":"watch"}">
      <div class="pain-title">${p.status==="new"?"🆕":"🔄"} ${p.title}</div>
      <div class="pain-detail">${p.detail||""}</div>
      <div class="pain-impact">📊 ${p.impact||""}</div>
      <div class="pain-fix">💡 ${p.solution||""}</div>
    </div>`).join("") || "";

  const risksHTML = diag.risks?.map(r => `<div style="font-size:12px;padding:6px 0;color:#b0b8d0">• ${r.probability==="high"?"🔴":"🟡"} ${r.risk} — ${r.mitigation||""}</div>`).join("") || "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${guildName} · 社群周报 · ${genDate}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0e17;color:#e0e6f0;font-family:-apple-system,'Inter',sans-serif;min-height:100vh}
.container{max-width:1200px;margin:0 auto;padding:20px}
.header{text-align:center;padding:40px 0 30px;border-bottom:1px solid rgba(0,212,255,.1);margin-bottom:30px}
.header .logo{font-size:14px;color:#00d4ff;letter-spacing:3px;text-transform:uppercase}
.header h1{font-size:32px;font-weight:700;background:linear-gradient(135deg,#00d4ff,#7b2ff7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.header .subtitle{color:#8892b0;font-size:14px;margin-top:6px}
.header .badge{display:inline-block;background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.3);color:#00d4ff;padding:4px 14px;border-radius:12px;font-size:12px;margin-top:8px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px}
.kpi-card{background:linear-gradient(135deg,rgba(20,30,60,.8),rgba(15,20,40,.8));border:1px solid rgba(0,212,255,.12);border-radius:14px;padding:18px 20px;position:relative;overflow:hidden}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#00d4ff,#7b2ff7);opacity:.5}
.kpi-card .label{color:#8892b0;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:1px}
.kpi-card .value{font-size:30px;font-weight:700;margin:6px 0 3px;letter-spacing:-1px;line-height:1.1}
.kpi-card .change{font-size:12px;font-weight:500;color:#00d4ff}.kpi-card .change.down{color:#ff6b6b}
.section{background:linear-gradient(135deg,rgba(20,30,60,.6),rgba(15,20,40,.6));border:1px solid rgba(0,212,255,.1);border-radius:14px;padding:28px;margin-bottom:24px}
.section-title{font-size:18px;font-weight:600;color:#00d4ff;margin-bottom:20px;display:flex;align-items:center;gap:10px}
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th{color:#8892b0;font-weight:500;text-transform:uppercase;padding:10px 8px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06)}
.data-table td{padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.04)}.data-table .num{text-align:right;font-weight:500}
.up{color:#00d4ff}.down{color:#ff6b6b}
.topic-card{background:rgba(0,0,0,.15);border-radius:12px;padding:18px;margin-bottom:14px}
.topic-card .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.topic-card .name{font-size:15px;font-weight:600}.topic-card .level{font-size:11px;padding:2px 8px;border-radius:8px;font-weight:600}
.topic-card .level.high{background:rgba(255,107,107,.2);color:#ff6b6b}.topic-card .level.medium{background:rgba(255,171,0,.2);color:#ffab00}.topic-card .level.low{background:rgba(0,212,255,.15);color:#00d4ff}
.topic-card .detail{font-size:13px;color:#b0b8d0;line-height:1.7;margin-top:6px}
.topic-card .parts{font-size:11px;color:#8892b0;margin-top:6px}
.pain-card{background:rgba(255,107,107,.05);border:1px solid rgba(255,107,107,.15);border-radius:12px;padding:16px;margin-bottom:12px}
.pain-card.critical{border-color:rgba(255,107,107,.4);background:rgba(255,107,107,.1)}
.pain-card.watch{border-color:rgba(255,171,0,.2);background:rgba(255,171,0,.05)}
.pain-card .pain-title{font-size:14px;font-weight:600;margin-bottom:6px}
.pain-card .pain-detail{font-size:12px;color:#b0b8d0;line-height:1.6}
.pain-card .pain-impact{font-size:11px;color:#ffab00;margin-top:6px}
.pain-card .pain-fix{font-size:11px;color:#00d4ff;margin-top:4px}
.action-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.action-col{background:rgba(0,0,0,.15);border-radius:12px;padding:18px}
.action-col h4{font-size:14px;color:#00d4ff;margin-bottom:12px}
.action-item{display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;font-size:13px}
.action-prio{font-size:10px;padding:1px 6px;border-radius:6px;font-weight:700;flex-shrink:0;margin-top:2px}
.action-prio.P0{background:rgba(255,107,107,.2);color:#ff6b6b}.action-prio.P1{background:rgba(255,171,0,.2);color:#ffab00}.action-prio.P2{background:rgba(0,212,255,.15);color:#00d4ff}
.quote-block{background:rgba(0,212,255,.04);border-left:3px solid #00d4ff;padding:12px 16px;margin:10px 0;border-radius:0 8px 8px 0;font-size:12px;color:#b0b8d0;line-height:1.6;font-style:italic}
.highlight-card{background:rgba(0,230,118,.05);border:1px solid rgba(0,230,118,.15);border-radius:12px;padding:14px;margin-bottom:10px}
.highlight-card .hl-title{font-size:13px;font-weight:600;color:#00e676}
.highlight-card .hl-detail{font-size:12px;color:#b0b8d0;margin-top:4px;line-height:1.5}
.trend-box{background:rgba(0,0,0,.2);border-radius:10px;padding:16px;font-size:13px;color:#b0b8d0;line-height:1.7}
.health-bar{height:8px;background:rgba(255,255,255,.05);border-radius:4px;margin:8px 0;overflow:hidden}
.health-bar .fill{height:100%;border-radius:4px}
.health-label{font-size:14px;font-weight:600}
.footer{text-align:center;padding:40px 20px;color:#8892b0;font-size:11px;border-top:1px solid rgba(255,255,255,.04);margin-top:30px}
.footer a{color:#00d4ff;text-decoration:none}
.daily-chart{display:flex;align-items:flex-end;gap:4px;height:120px;margin:16px 0}
.daily-bar{flex:1;border-radius:4px 4px 0 0;background:linear-gradient(180deg,#00d4ff,rgba(0,212,255,.3));min-height:2px;position:relative}
.daily-bar .day-label{position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:9px;color:#8892b0}
.daily-bar .day-value{position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:9px;color:#00d4ff}
.user-row{display:flex;align-items:center;gap:10px;padding:8px 12px;margin:4px 0;background:rgba(0,0,0,.1);border-radius:8px;font-size:13px}
.user-row .rank{font-size:18px;width:30px;text-align:center;font-weight:700}.user-row .uname{flex:1}.user-row .ucount{color:#00d4ff;font-weight:600}
@media(max-width:768px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.action-grid{grid-template-columns:1fr}}
</style>
</head>
<body><div class="container">
<div class="header">
  <div class="logo">📊 Weekly Report</div>
  <h1>${guildName}</h1>
  <div class="subtitle">${cur.weekLabel} · 社群周报 · ${genDate} 生成</div>
  <div class="badge">🤖 Mochi Bot · 深度分析 by DeepSeek</div>
</div>
<div class="kpi-grid">
  <div class="kpi-card"><div class="label">🗣️ 全频道消息</div><div class="value">${fmt(cur.totalCount)}</div><div class="change ${msgGrowth.startsWith("-")?"down":""}">环比 ${msgGrowth}%</div></div>
  <div class="kpi-card"><div class="label">👥 发言人数</div><div class="value">${fmt(cur.activeUsers)}</div><div class="change ${userGrowth.startsWith("-")?"down":""}">环比 ${userGrowth}%</div></div>
  <div class="kpi-card"><div class="label">📡 活跃频道</div><div class="value">${Object.values(cur.channelStats).filter(v=>v>0).length}/${Object.keys(cur.channelStats).length}</div><div class="change">🏥 健康分 ${diag.health_score||"—"}/100</div></div>
  <div class="kpi-card"><div class="label">😊 社群氛围</div><div class="value" style="font-size:16px">${an.sentiment_map?`😊${an.sentiment_map.positive}% 😡${an.sentiment_map.negative}%`:"见分析"}</div><div class="change">LLM 情绪分析</div></div>
</div>
<div class="section">
  <div class="section-title">🤖 LLM 深度分析 · 本周</div>
  ${an.summary?`<div class="trend-box">📝 ${an.summary}</div>`:""}
  ${topicsHTML?`<h4 style="margin:20px 0 12px;color:#ff6b9d">🔥 热议话题</h4>${topicsHTML}`:""}
  ${painsHTML?`<h4 style="margin:20px 0 12px;color:#ff6b6b">⚠️ 关注痛点</h4>${painsHTML}`:""}
  ${highlightsHTML?`<h4 style="margin:20px 0 12px;color:#00e676">✨ 本周亮点</h4>${highlightsHTML}`:""}
  ${quotesHTML?`<h4 style="margin:20px 0 12px;color:#b388ff">💬 代表发言</h4>${quotesHTML}`:""}
  ${an.emerging_trends?`<div class="trend-box" style="margin-top:16px">🔮 新趋势：${an.emerging_trends}</div>`:""}
</div>
<div class="section">
  <div class="section-title">📈 日活跃趋势</div>
  <div class="daily-chart">${cur.dailyCounts.map((v,i)=>{const max=Math.max(...cur.dailyCounts,1);const h=Math.max((v/max)*100,2);const d=new Date(cur.weekStart+i*86400000);return`<div class="daily-bar" style="height:${h}%"><div class="day-value">${v}</div><div class="day-label">${d.getDate()}日</div></div>`}).join("")}</div>
</div>
<div class="section">
  <div class="section-title">📡 各频道消息分布</div>
  <table class="data-table"><thead><tr><th>频道</th><th>消息量</th><th>状态</th></tr></thead><tbody>${Object.entries(cur.channelStats).sort((a,b)=>b[1]-a[1]).map(([n,c])=>{const s=c>100?"🔥":c>20?"📊":c>0?"💤":"⛔";return`<tr><td>${s} #${n}</td><td class="num">${fmt(c)}</td><td>${c>100?"活跃":c>0?"低活":"无消息"}</td></tr>`}).join("")}</tbody></table>
</div>
<div class="section">
  <div class="section-title">🏆 TOP 10 活跃用户</div>
  ${cur.topUsers.map((u,i)=>`<div class="user-row"><span class="rank">${i===0?"🥇":i===1?"🥈":i===2?"🥉":i+1}</span><span class="uname">${u.name}</span><span class="ucount">~${u.count}条</span></div>`).join("")}
</div>
<div class="section">
  <div class="section-title">📊 环比对比</div>
  <table class="data-table"><thead><tr><th>指标</th><th>上周</th><th>本周</th><th>环比</th></tr></thead><tbody>
    <tr><td>全频道消息</td><td class="num">${fmt(prev.totalCount)}</td><td class="num">${fmt(cur.totalCount)}</td><td class="num ${msgGrowth.startsWith("-")?"down":"up"}">${msgGrowth}%</td></tr>
    <tr><td>发言人数</td><td class="num">${fmt(prev.activeUsers)}</td><td class="num">${fmt(cur.activeUsers)}</td><td class="num ${userGrowth.startsWith("-")?"down":"up"}">${userGrowth}%</td></tr>
    <tr><td>日均消息</td><td class="num">${Math.round(prev.totalCount/7)}</td><td class="num">${Math.round(cur.totalCount/7)}</td><td class="num">—</td></tr>
  </tbody></table>
</div>
${problemsHTML?`<div class="section"><div class="section-title">🔍 问题诊断</div>${problemsHTML}${risksHTML?`<h4 style="margin:16px 0 8px;color:#ffab00">⚠️ 风险预警</h4>${risksHTML}`:""}<div style="margin-top:16px"><div class="health-label">社群健康分 ${diag.health_score||70}/100</div><div class="health-bar"><div class="fill" style="width:${diag.health_score||70}%;background:${scoreColor}"></div></div></div></div>`:""}
${plan.this_week?.length?`<div class="section"><div class="section-title">🎯 行动计划</div><div class="action-grid"><div class="action-col"><h4>📅 本周</h4>${plan.this_week.map(a=>`<div class="action-item"><span class="action-prio ${a.priority}">${a.priority}</span><span>${a.action} ${a.goal?"— "+a.goal:""}</span></div>`).join("")}</div>${plan.next_week?.length?`<div class="action-col"><h4>📅 下周</h4>${plan.next_week.map(a=>`<div class="action-item"><span class="action-prio ${a.priority}">${a.priority}</span><span>${a.action}</span></div>`).join("")}</div>`:""}${plan.this_month?.length?`<div class="action-col"><h4>📅 本月</h4>${plan.this_month.map(a=>`<div class="action-item"><span class="action-prio ${a.priority}">${a.priority}</span><span>${a.action}</span></div>`).join("")}</div>`:""}</div></div>`:""}
${an.weekly_verdict?`<div class="section"><div class="section-title">📝 本周运营总结</div><div class="trend-box">${an.weekly_verdict}</div></div>`:""}
<div class="footer">🤖 由 GitHub Actions 自动生成 · ${genDate}<br>数据来源: Discord · ${guildName} · 话题分析: DeepSeek V4 Flash · 通过 ARK API<br><a href="https://jiashi65.github.io/yoyo-community-report/">https://jiashi65.github.io/yoyo-community-report/</a></div>
</div></body></html>`;
}

async function pushFeishu(webhookKey, guildName, htmlUrl, summary, curData, llmAnalysis) {
  const cur = curData || {};
  const an = llmAnalysis?.llm_analysis || {};
  const diag = llmAnalysis?.problem_diagnosis || {};
  const fmt = n => (n || 0).toLocaleString("zh-CN");
  const topTopics = (an.hot_topics || []).slice(0, 3).map(t => `• ${t.topic}`).join("\n");
  const topPains = (an.pain_points || []).slice(0, 2).map(p => `⚠️ ${p.issue}`).join("\n");

  const card = {
    msg_type: "interactive",
    card: {
      header: { title: { tag: "plain_text", content: `📊 ${guildName} 周报` }, template: "blue" },
      elements: [
       { tag: "div", text: { tag: "lark_md", content: `🗣️ 消息 **${fmt(cur.totalCount)}** 条 · 👥 **${fmt(cur.activeUsers)}** 人\n🏥 健康分 **${diag.health_score||"—"}**/100` } },
       { tag: "div", text: { tag: "lark_md", content: `🏆 **TOP 3 活跃**\n${(cur.topUsers||[]).slice(0,3).map((u,i)=>['🥇','🥈','🥉'][i]+' '+u.name+' ~'+u.count+'条').join('  ')}` } },
       { tag: "hr" },
        { tag: "div", text: { tag: "lark_md", content: `**📝 AI 总结**\n${summary||"详见 HTML 报告"}` } },
        { tag: "hr" },
        { tag: "div", text: { tag: "lark_md", content: `**🔥 热议话题**\n${topTopics||"暂无"}\n\n${topPains||""}` } },
        { tag: "hr" },
        { tag: "action", actions: [{ tag: "button", text: { tag: "lark_md", content: "📊 查看完整 BI 看板 →" }, url: htmlUrl, type: "primary" }] },
      ],
    },
  };
  const resp = await fetch(FEISHU_WEBHOOKS[webhookKey], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(card) });
  const result = await resp.text();
  console.log(`飞书 [${webhookKey}]: ${resp.status} ${result}`);
  return resp.ok;
}

async function main() {
  const args = process.argv.slice(2);
  const guildType = args.includes("large") ? "large" : "small";
  const isDry = args.includes("--dry");
  const guild = GUILDS[guildType];
  const genDate = new Date().toISOString().slice(0,10).replace(/-/g,"");
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  📊 ${guild.name} 周报生成器`);
  console.log(`║  🤖 LLM: DeepSeek V4 Flash`);
  console.log(`╚══════════════════════════════════╝\n`);
  const curWeek = getWeekRange(0), prevWeek = getWeekRange(1);
  console.log(`📅 本周: ${curWeek.label}`);
  console.log(`📅 上周: ${prevWeek.label}\n`);
  console.log("📥 拉取本周消息...");
  const curData = await scanMessages(guild.id, curWeek.start, curWeek.end);
  curData.weekStart = curWeek.start; curData.weekLabel = curWeek.label;
  console.log(`   ✅ ${curData.totalCount} 条, ${curData.activeUsers} 人\n`);
  console.log("📥 拉取上周消息...");
  const prevData = await scanMessages(guild.id, prevWeek.start, prevWeek.end);
  console.log(`   ✅ ${prevData.totalCount} 条, ${prevData.activeUsers} 人\n`);
  console.log("🎯 智能抽样 60 条...");
  const sampled = await smartSample(curData.allMessages, 60);
  console.log(`   ✅ ${curData.allMessages.length} → ${sampled.length} 条\n`);
  console.log("🧠 LLM 深度分析中...");
  const llmAnalysis = await deepAnalyze(sampled, curWeek.label, `上周: ${prevData.totalCount}条, ${prevData.activeUsers}人`);
  if (llmAnalysis) {
    console.log(`   ✅ ${llmAnalysis.llm_analysis?.hot_topics?.length||0} 个话题, 健康分 ${llmAnalysis.problem_diagnosis?.health_score||"—"}/100`);
  } else { console.log("   ⚠️ LLM 返回为空，使用降级报告"); }
  console.log("\n📄 生成 HTML...");
  const html = generateHTML(guild.name, curData, prevData, llmAnalysis||{});
  const htmlFilename = `${guildType}-weekly-${genDate}.html`;
  const htmlPath = path.join(__dirname, htmlFilename);
  fs.writeFileSync(htmlPath, html, "utf-8");
  console.log(`   ✅ ${htmlPath} (${(html.length/1024).toFixed(0)}KB)\n`);
  if (!isDry && process.env.CI) {
   const webhookKey = guildType === "small" ? "small-weekly" : "large-weekly";
    const fixedName = guildType === "small" ? "weekly.html" : "large-weekly.html";
    const htmlUrl = `https://jiashi65.github.io/yoyo-community-report/${fixedName}?ts=${Date.now()}`;
    const summary = llmAnalysis?.llm_analysis?.summary || `本周 ${curData.totalCount} 条, ${curData.activeUsers} 人`;
    console.log(`📤 推送飞书 [${webhookKey}]...`);
    await pushFeishu(webhookKey, guild.name, htmlUrl, summary, curData, llmAnalysis);
    console.log("   ✅ 完成\n");
  }
  console.log("✅ 周报生成完毕！");
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
