const fs = require("fs");
const path = require("path");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const config = require("../config");

if (!config.BOT_TOKEN || config.BOT_TOKEN.includes("PASTE_YOUR_NEW")) {
  console.error("BOT_TOKEN is not configured. Put your NEW BotFather token in config.js.");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

const app = express();
app.get("/", (_req,res)=>res.json({
  ok:true, service:"advanced-prediction-bot-v4",
  mode:state.mode, running:state.running,
  lastPeriod:state.lastPeriod||null,
  holdRemaining:state.holdRemaining||0
}));
app.get("/health", (_req,res)=>res.json({ok:true, uptime:process.uptime(), running:state.running}));
app.listen(process.env.PORT || 10000, "0.0.0.0", ()=>console.log("Health server ready."));

function defaultState() {
  return {
    running:true,
    mode:config.MODE || "1m",
    lastPeriod:"",
    lastApi:"",
    predictions:[],
    wins:0,
    losses:0,
    jackpots:0,
    winStreak:0,
    bestStreak:0,
    lossStreak:0,
    bestLossStreak:0,
    holdRemaining:0,
    holdTriggerCount:0,
    totalHeldPeriods:0,
    premium:Array.isArray(config.PREMIUM?.userIds) ? config.PREMIUM.userIds.map(String) : [],
    subscriptions:{},
    customTemplates:{
      prediction:config.MESSAGE_TEMPLATE,
      win:config.WIN_MESSAGE,
      jackpot:config.JACKPOT_MESSAGE,
      superWin:config.SUPER_WIN_MESSAGE,
      loss:config.LOSS_MESSAGE,
      hold:config.HOLD_MESSAGE,
      warning:config.SESSION_WARNING_MESSAGE
    },
    schedule:{
      enabled:!!config.SCHEDULE?.enabled,
      warningMinutes:Number(config.SCHEDULE?.warningMinutes ?? 30),
      sessions:Array.isArray(config.SCHEDULE?.sessions) ? config.SCHEDULE.sessions : []
    },
    hold:{
      enabled:!!config.LOSS_HOLD?.enabled,
      threshold:Math.max(1,Number(config.LOSS_HOLD?.lossThreshold ?? 3)),
      periods:Math.max(1,Number(config.LOSS_HOLD?.holdPeriods ?? 2))
    },
    lastWarningKey:"",
    lastResultPeriod:"",
    holdHistory:[],
    resultHistory:[],
    sessionStats:{}
  };
}

function loadState(){
  const base=defaultState();
  try{
    if(!fs.existsSync(STATE_FILE)) return base;
    const old=JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));
    const s=Object.assign(base,old);
    s.customTemplates=Object.assign(base.customTemplates,old.customTemplates||{});
    s.schedule=Object.assign(base.schedule,old.schedule||{});
    s.hold=Object.assign(base.hold,old.hold||{});
    s.subscriptions=old.subscriptions||{};
    s.predictions=Array.isArray(old.predictions)?old.predictions:[];
    s.premium=Array.isArray(old.premium)?old.premium.map(String):base.premium;
    return s;
  }catch(e){
    console.error("state load:",e.message);
    return base;
  }
}
const state=loadState();

let saveTimer=null;
function saveState(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{
    try{fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2));}
    catch(e){console.error("state save:",e.message);}
  },200);
}

const API_ENDPOINTS={
  "1m":[
    ["AR-LOTTERY","https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?pageNo=1&pageSize=100"],
    ["BDG88","https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList?pageSize=100&pageNo=1&typeId=2&language=0"],
    ["BDG88-W","https://www.bdg88zf.com/api/webapi/GetNoaverageEmerdList?pageSize=100&pageNo=1&typeId=2&language=0"]
  ],
  "30s":[
    ["AR-LOTTERY","https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=100"],
    ["BDG88","https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList?pageSize=100&pageNo=1&typeId=1&language=0"],
    ["BDG88-W","https://www.bdg88zf.com/api/webapi/GetNoaverageEmerdList?pageSize=100&pageNo=1&typeId=1&language=0"]
  ]
};

async function fetchJson(url){
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),Number(config.REQUEST_TIMEOUT_MS||8000));
  try{
    const r=await fetch(url+"&ts="+Date.now(),{signal:ctl.signal,headers:{"user-agent":"Mozilla/5.0"}});
    if(!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  }finally{clearTimeout(timer);}
}
function normalize(raw){
  const candidates=[
    raw?.data?.list,raw?.data?.records,raw?.list,raw?.records,
    Array.isArray(raw)?raw:null,Array.isArray(raw?.data)?raw.data:null,
    raw?.result?.list
  ].filter(Array.isArray);
  const arr=candidates[0]||[];
  return arr.map(x=>{
    const p=x?.issueNumber??x?.issue_number??x?.period??x?.periodId;
    const n=x?.number??x?.num??x?.result??x?.winNumber;
    const num=Number(n);
    return {period:String(p??""),num:Number.isFinite(num)?num:null};
  }).filter(x=>x.period && Number.isFinite(x.num));
}
async function fetchHistory(){
  const list=API_ENDPOINTS[state.mode]||API_ENDPOINTS["1m"];
  let lastErr=null;
  for(const [label,url] of list){
    try{
      const rows=normalize(await fetchJson(url));
      if(rows.length){
        state.lastApi=label;
        return rows.sort((a,b)=>Number(b.period)-Number(a.period));
      }
    }catch(e){lastErr=e;}
  }
  throw lastErr||new Error("All APIs failed");
}

function nums(history){return history.slice(0,30).map(x=>x.num).filter(Number.isFinite);}
function side(n){return n>=5?"B":"S";}
function clamp(n,a,b){return Math.max(a,Math.min(b,n));}

/*
  Multi-signal analysis inspired by the supplied HTML's structure:
  recent majority, alternation, streak-break, mean reversion,
  frequency/cold-number selection, and transition tendencies.
*/
function analyze(history){
  const ns=nums(history);
  if(ns.length<8) return null;
  const bs=ns.map(side);
  let b=0,s=0,rules=[];
  const l3=bs.slice(0,3);
  if(l3.filter(x=>x==="B").length>=2){b+=3;rules.push("L3-BIG");}
  else{s+=3;rules.push("L3-SMALL");}
  if(bs[0]!==bs[1] && bs[1]!==bs[2]){
    if(bs[0]==="B"){b+=4;rules.push("ALT-BIG");}
    else{s+=4;rules.push("ALT-SMALL");}
  }
  if(bs[0]===bs[1] && bs[1]===bs[2]){
    if(bs[0]==="B"){s+=5;rules.push("STREAK-BREAK");}
    else{b+=5;rules.push("STREAK-BREAK");}
  }
  const avg5=ns.slice(0,5).reduce((a,x)=>a+x,0)/5;
  if(avg5>5.5){s+=3;rules.push("MEAN-REV");}
  else if(avg5<4.5){b+=3;rules.push("MEAN-REV");}

  const freq=Array.from({length:10},()=>0);
  ns.forEach(n=>freq[n]++);
  const pred=b>=s?"B":"S";
  const zone=pred==="B"?[5,6,7,8,9]:[0,1,2,3,4];
  const picked=zone.slice().sort((x,y)=>freq[x]-freq[y]).slice(0,2);

  const transition={B:0,S:0};
  for(let i=0;i<Math.min(ns.length-1,20);i++){
    const cur=side(ns[i]), nxt=side(ns[i+1]);
    if(cur===bs[0]) transition[nxt]++;
  }
  if(transition.B!==transition.S){
    if(transition.B>transition.S){b+=2;rules.push("TRANS-BIG");}
    else{s+=2;rules.push("TRANS-SMALL");}
  }
  const confidence=clamp(55+Math.round(Math.abs(b-s)/(b+s+0.01)*35),55,92);
  return {
    predSide:pred,n1:picked[0],n2:picked[1],
    confidence,rule:rules.slice(0,4).join(" + ")||"BALANCE"
  };
}

function fill(tpl,vals){
  return String(tpl||"").replace(/\{(\w+)\}/g,(_,k)=>vals[k]??"");
}
function isAdmin(msg){return String(msg.from?.id||"")===String(config.ADMIN_UID);}
function getSub(id){
  const s=state.subscriptions[String(id)];
  if(!s)return null;
  if(s.expiresAt && s.expiresAt<=Date.now()){
    delete state.subscriptions[String(id)]; saveState(); return null;
  }
  return s;
}
function isPremium(msg){
  if(!config.PREMIUM?.enabled)return true;
  const id=String(msg.from?.id||"");
  return isAdmin(msg)||state.premium.includes(id)||!!getSub(id);
}
function addSub(id,days){
  const key=String(id), old=getSub(key);
  const base=old?.expiresAt>Date.now()?old.expiresAt:Date.now();
  const expiresAt=base+Math.max(1,Number(days))*86400000;
  state.subscriptions[key]={expiresAt,createdAt:Date.now(),label:"Premium"};
  saveState(); return expiresAt;
}
function removeSub(id){
  delete state.subscriptions[String(id)];
  state.premium=state.premium.filter(x=>x!==String(id));
  saveState();
}
function esc(x){return String(x).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function sendChannel(text,opts={}){
  try{return await bot.sendMessage(config.CHANNEL_ID,text,{parse_mode:"HTML",disable_web_page_preview:true,...opts});}
  catch(e){console.error("Telegram send:",e.message);return null;}
}
async function deleteChannelMessage(id){
  if(!id || !config.DELETE_ON_LOSS)return;
  try{await bot.deleteMessage(config.CHANNEL_ID,id);}
  catch(e){console.error("Telegram delete:",e.message);}
}


function chartSvgData(results, title='Prediction Result Chart'){
  const W=900,H=500,pl=70,pr=30,pt=70,pb=90,iw=W-pl-pr,ih=H-pt-pb;
  const rows=(results||[]).slice(-20);
  const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const x=i=>pl+(rows.length<=1?iw/2:i*iw/(rows.length-1));
  const y=v=>pt+ih-(v/100)*ih;
  const good=r=>r.status==='WIN'||r.status==='JACKPOT';
  const grid=[0,25,50,75,100].map(v=>`<line x1="${pl}" y1="${y(v)}" x2="${W-pr}" y2="${y(v)}" stroke="#d9dee7"/><text x="${pl-12}" y="${y(v)+5}" text-anchor="end" font-size="14" fill="#667085">${v}</text>`).join('');
  const poly=rows.map((r,i)=>`${x(i)},${y(good(r)?100:0)}`).join(' ');
  const dots=rows.map((r,i)=>`<circle cx="${x(i)}" cy="${y(good(r)?100:0)}" r="7" fill="${good(r)?'#16a34a':'#dc2626'}"><title>${esc(r.status)} — ${esc(r.period)}</title></circle>`).join('');
  const labels=rows.map((r,i)=>`<text x="${x(i)}" y="${H-pb+28}" text-anchor="middle" font-size="11" fill="#667085">${esc(String(r.period).slice(-6))}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" rx="24" fill="#fff"/><text x="${W/2}" y="38" text-anchor="middle" font-family="Arial" font-size="24" font-weight="700" fill="#111827">${esc(title)}</text>${grid}<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${H-pb}" stroke="#98a2b3"/><line x1="${pl}" y1="${H-pb}" x2="${W-pr}" y2="${H-pb}" stroke="#98a2b3"/>${rows.length?`<polyline points="${poly}" fill="none" stroke="#344054" stroke-width="4"/>`:''}${dots}${labels}<text x="${pl}" y="${H-20}" font-family="Arial" font-size="13" fill="#667085">Last ${rows.length} settled predictions • green = win/jackpot • red = loss</text></svg>`;
}
function heatmapSvg(resultHistory){
  const W=900,H=430,cw=66,ch=90,ox=55,oy=95,counts=Array(24).fill(0);
  for(const r of (resultHistory||[])) if(r.status==='LOSS'){
    const d=new Date(r.at||Date.now()), dh=new Date(d.getTime()+6*60*60*1000); counts[dh.getUTCHours()]++;
  }
  const max=Math.max(1,...counts);
  let cells='';
  for(let h=0;h<24;h++){const c=counts[h],x=ox+(h%12)*cw,y=oy+Math.floor(h/12)*ch,op=.12+.78*(c/max);cells+=`<rect x="${x}" y="${y}" width="${cw-7}" height="${ch-7}" rx="12" fill="#dc2626" fill-opacity="${op.toFixed(2)}"/><text x="${x+(cw-7)/2}" y="${y+34}" text-anchor="middle" font-size="18" font-weight="700" fill="#111827">${String(h).padStart(2,'0')}:00</text><text x="${x+(cw-7)/2}" y="${y+59}" text-anchor="middle" font-size="14" fill="#344054">${c} loss${c===1?'':'es'}</text>`}
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" rx="24" fill="#fff"/><text x="${W/2}" y="42" text-anchor="middle" font-family="Arial" font-size="24" font-weight="700" fill="#111827">LOSS HEATMAP — DHAKA TIME</text><text x="${W/2}" y="68" text-anchor="middle" font-family="Arial" font-size="13" fill="#667085">Loss events grouped by local hour</text>${cells}</svg>`;
}
function svgTempFile(svg,prefix){
  const f=path.join(DATA_DIR,`${prefix}_${Date.now()}.svg`);
  fs.writeFileSync(f,svg,'utf8'); return f;
}
async function sendChart(chatId, svg, caption){
  const f=svgTempFile(svg,'analytics');
  try{
    await bot.sendDocument(chatId,f,{caption});
  } finally { try{fs.unlinkSync(f)}catch{} }
}

function localParts(date=new Date()){
  const f=new Intl.DateTimeFormat("en-GB",{timeZone:config.TIMEZONE,hour:"2-digit",minute:"2-digit",hour12:false,year:"numeric",month:"2-digit",day:"2-digit"});
  const p=Object.fromEntries(f.formatToParts(date).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour),minute:Number(p.minute)};
}
function modMin(t){const [h,m]=String(t).split(":").map(Number);return h*60+m;}
function sessionNow(){
  if(!state.schedule.enabled)return {active:true};
  const p=localParts(), now=p.hour*60+p.minute;
  for(const s of state.schedule.sessions||[]){
    const a=modMin(s.start),b=modMin(s.end);
    if(now>=a&&now<b)return {active:true,...s};
  }
  return {active:false};
}
async function warningCheck(){
  if(!state.schedule.enabled)return;
  const p=localParts(),now=p.hour*60+p.minute,w=Number(state.schedule.warningMinutes||30);
  for(const s of state.schedule.sessions||[]){
    const d=modMin(s.start)-now;
    if(d===w){
      const key=`${p.date}|${s.start}`;
      if(state.lastWarningKey!==key){
        state.lastWarningKey=key; saveState();
        await sendChannel(fill(state.customTemplates.warning,{minutes:d,start:s.start,end:s.end}));
      }
    }
  }
}
setInterval(warningCheck,30000);

async function resolvePending(latest){
  const pending=state.predictions.find(x=>x.status==="pending");
  if(!pending || pending.period===latest.period)return;
  const result=latest.num;
  const resultSide=side(result);
  const jackpot=result===pending.n1||result===pending.n2;
  const win=!jackpot && resultSide===pending.predSide;
  pending.result=result; pending.resultSide=resultSide;
  if(jackpot){
    pending.status="jackpot"; state.jackpots++; state.wins++; state.winStreak++;
    state.lossStreak=0; state.bestStreak=Math.max(state.bestStreak,state.winStreak);
    await sendChannel(fill(state.customTemplates.jackpot,{period:pending.period,result, predSide:pending.predSide,streak:state.winStreak}));
    if(state.winStreak>=Number(config.SUPER_WIN_STREAK||2)){
      await sendChannel(fill(state.customTemplates.superWin,{period:pending.period,result,streak:state.winStreak}));
    }
  }else if(win){
    pending.status="win"; state.wins++; state.winStreak++;
    state.lossStreak=0; state.bestStreak=Math.max(state.bestStreak,state.winStreak);
    await sendChannel(fill(state.customTemplates.win,{period:pending.period,result,predSide:pending.predSide,streak:state.winStreak}));
    if(state.winStreak>=Number(config.SUPER_WIN_STREAK||2)){
      await sendChannel(fill(state.customTemplates.superWin,{period:pending.period,result,streak:state.winStreak}));
    }
  }else{
    pending.status="loss"; state.losses++; state.lossStreak++; state.winStreak=0;
    state.bestLossStreak=Math.max(state.bestLossStreak,state.lossStreak);
    await deleteChannelMessage(pending.messageId);
    await sendChannel(fill(state.customTemplates.loss,{period:pending.period,result,lossStreak:state.lossStreak}));
    if(state.hold.enabled && state.lossStreak>=state.hold.threshold){
      state.holdRemaining=state.hold.periods;
      state.holdTriggerCount++;
      state.totalHeldPeriods+=state.hold.periods;
      state.holdHistory.unshift({
        at:Date.now(), triggerLosses:state.lossStreak,
        periods:state.hold.periods, completed:false
      });
      state.holdHistory=state.holdHistory.slice(0,100);
      await sendChannel(fill(state.customTemplates.hold,{lossStreak:state.lossStreak,holdPeriods:state.hold.periods}));
    }
  }
  state.lastResultPeriod=latest.period;
  state.resultHistory.unshift({
    period:pending.period,status:pending.status,result,
    predSide:pending.predSide,confidence:pending.confidence,
    at:Date.now(),session:sessionLabel()
  });
  state.resultHistory=state.resultHistory.slice(0,500);
  state.predictions=state.predictions.slice(0,100);
  saveState();
}

async function tick(){
  if(!state.running)return;
  try{
    const history=await fetchHistory();
    const latest=history[0];
    if(!latest || !latest.period)return;
    if(state.lastPeriod===latest.period)return;

    // A new period has arrived. Resolve the prediction from the prior period first.
    if(state.lastPeriod) await resolvePending(latest);
    state.lastPeriod=latest.period;

    // If safety hold is active, consume exactly one new period and do not publish.
    if(state.holdRemaining>0){
      state.holdRemaining=Math.max(0,state.holdRemaining-1);
      if(state.holdRemaining===0 && state.holdHistory.length){
        const h=state.holdHistory.find(x=>!x.completed);
        if(h)h.completed=true;
        await sendChannel("🟢 <b>HOLD COMPLETE</b> — prediction engine is active again.");
      }
      saveState();
      return;
    }

    if(!sessionNow().active)return;
    const a=analyze(history);
    if(!a)return;

    const predictedPeriod=String(Number(latest.period)+1);
    // Prevent duplicates even if the API returns the same period ordering oddly.
    if(state.predictions.some(x=>x.period===predictedPeriod && x.status==="pending"))return;

    const text=fill(state.customTemplates.prediction,{
      period:predictedPeriod,side:a.predSide==="B"?"BIG":"SMALL",
      n1:a.n1,n2:a.n2,confidence:a.confidence,rule:a.rule,
      risk:a.confidence>=80?"LOW":a.confidence>=68?"MEDIUM":"HIGH",
      streak:state.winStreak
    });
    const sent=await sendChannel(text);
    state.predictions.unshift({
      period:predictedPeriod,predSide:a.predSide,n1:a.n1,n2:a.n2,
      confidence:a.confidence,rule:a.rule,status:"pending",
      messageId:sent?.message_id||null,createdAt:Date.now()
    });
    saveState();
  }catch(e){console.error("tick:",e.message);}
}
setInterval(tick,Number(config.POLL_MS||2500));
tick();

function fmtDate(ms){
  if(!ms)return "—";
  return new Intl.DateTimeFormat("en-GB",{timeZone:config.TIMEZONE,dateStyle:"medium",timeStyle:"short"}).format(new Date(ms));
}
function activeSubs(){
  for(const id of Object.keys(state.subscriptions))getSub(id);
  return Object.entries(state.subscriptions).filter(([id])=>!!getSub(id));
}

function sessionLabel(){
  const x=sessionNow();
  if(x && x.start && x.end)return `${x.start}-${x.end}`;
  return state.schedule.enabled ? "OUTSIDE" : "UNSCHEDULED";
}
function analyticsSummary(){
  const total=state.wins+state.losses;
  const accuracy=total?Math.round(state.wins/total*100):0;
  const sessions={};
  for(const r of state.resultHistory||[]){
    const k=r.session||"UNKNOWN";
    if(!sessions[k])sessions[k]={total:0,wins:0,losses:0,jackpots:0};
    sessions[k].total++;
    if(r.status==="win"){sessions[k].wins++;}
    else if(r.status==="jackpot"){sessions[k].wins++;sessions[k].jackpots++;}
    else if(r.status==="loss"){sessions[k].losses++;}
  }
  return {total,accuracy,sessions};
}
function heatmapText(){
  const buckets=Array(10).fill(0);
  for(const r of state.resultHistory||[]){
    if(r.status==="loss"){
      const h=new Date(r.at).toLocaleString("en-GB",{timeZone:config.TIMEZONE,hour:"2-digit",hour12:false});
      const n=Number(h);
      if(Number.isFinite(n))buckets[n]++;
    }
  }
  const max=Math.max(1,...buckets);
  return buckets.map((v,h)=>`${String(h).padStart(2,"0")}  ${"█".repeat(Math.min(12,Math.ceil(v/max*12)))} ${v}`).join("\\n");
}
function usersText(){
  const rows=activeSubs().map(([id,s])=>`• ${id} — ${fmtDate(s.expiresAt)}`);
  return rows.length?rows.join("\\n"):"No active subscriptions.";
}

function dashboard(){
  const a=analyticsSummary();
  const active=state.running;
  const hold=state.holdRemaining>0;
  const api=(state.lastApi||"—").replace(/^https?:\/\//,"").slice(0,34);
  return [
    "╭━━━━━━━━━━━━━━━━━━━━━━━━━━╮",
    "┃  ⚡ <b>IX • COMMAND DECK</b>  ┃",
    "┃      <i>Premium Admin Panel</i>     ┃",
    "╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯",
    "",
    `${active?"🟢":"🔴"} <b>BOT</b>  ${active?"ONLINE":"STOPPED"}     🧠 <b>MODE</b> ${state.mode}`,
    `📡 <b>API</b>  <code>${esc(api)}</code>`,
    `🎯 <b>PERIOD</b>  <code>${esc(state.lastPeriod||"—")}</code>`,
    "",
    "┌─ <b>PERFORMANCE</b> ───────────",
    `│ ✅ Wins <b>${state.wins}</b>   ❌ Loss <b>${state.losses}</b>`,
    `│ 💎 Jackpot <b>${state.jackpots}</b>   🎯 Rate <b>${a.accuracy}%</b>`,
    `│ 🔥 Win Streak <b>${state.winStreak}</b>   🧨 Loss Streak <b>${state.lossStreak}</b>`,
    `│ 🏆 Best Win <b>${state.bestStreak}</b>   📉 Best Loss <b>${state.bestLossStreak}</b>`,
    "└──────────────────────────",
    "",
    `🛡 <b>HOLD</b>  ${hold?"⏸ "+state.holdRemaining+" PERIOD(S)":"✓ READY"}   • Rule: ${state.hold.enabled?state.hold.threshold+"L → "+state.hold.periods+"H":"OFF"}`,
    `💎 <b>PREMIUM</b>  ${activeSubs().length} active users`,
    `🗓 <b>SCHEDULE</b>  ${state.schedule.enabled?"ON":"OFF"} • ${(state.schedule.sessions||[]).length} session(s)`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "Use the controls below to manage everything."
  ].join("\n");
}

function kb(){
  return {inline_keyboard:[
    [{text:state.running?"⏸ STOP BOT":"▶️ START BOT",callback_data:"p:toggle"},{text:"🔄 REFRESH",callback_data:"p:refresh"}],
    [{text:"📊 LIVE STATS",callback_data:"p:stats"},{text:"📈 CHART",callback_data:"p:chart"},{text:"🔥 WIN-RATE",callback_data:"p:winrate"}],
    [{text:"🌡 HEATMAP",callback_data:"p:heat"},{text:"📊 SESSIONS",callback_data:"p:sessions"}],
    [{text:"🧠 ENGINE",callback_data:"p:engine"},{text:"🛡 LOSS→HOLD",callback_data:"p:hold"}],
    [{text:"💎 USER MANAGER",callback_data:"p:users"},{text:"🗓 SCHEDULE",callback_data:"p:schedule"}],
    [{text:"📋 HOLD HISTORY",callback_data:"p:holds"},{text:"✏️ MESSAGE STUDIO",callback_data:"p:messages"}],
    [{text:"♻ RESET STATS",callback_data:"p:reset"}]
  ]};
}
function engineKb(){
  return {inline_keyboard:[
    [{text:`1 MIN ${state.mode==="1m"?"●":"○"}`,callback_data:"e:1m"},{text:`30 SEC ${state.mode==="30s"?"●":"○"}`,callback_data:"e:30s"}],
    [{text:`DELETE LOSS ${config.DELETE_ON_LOSS?"ON":"OFF"}`,callback_data:"e:del"}],
    [{text:"⬅ BACK",callback_data:"p:back"}]
  ]};
}
function holdKb(){
  return {inline_keyboard:[
    [{text:`SYSTEM ${state.hold.enabled?"ON":"OFF"}`,callback_data:"h:toggle"}],
    [{text:`THRESHOLD: ${state.hold.threshold}`,callback_data:"h:threshold"},{text:`HOLD: ${state.hold.periods}`,callback_data:"h:periods"}],
    [{text:"🛡 HOLD NOW",callback_data:"h:now"},{text:"♻ CLEAR HOLD",callback_data:"h:clear"}],
    [{text:"⬅ BACK",callback_data:"p:back"}]
  ]};
}
function scheduleKb(){
  return {inline_keyboard:[
    [{text:`SCHEDULE ${state.schedule.enabled?"ON":"OFF"}`,callback_data:"s:toggle"}],
    [{text:"➕ ADD SESSION",callback_data:"s:add"},{text:"🗑 CLEAR",callback_data:"s:clear"}],
    [{text:`⚠ WARNING ${state.schedule.warningMinutes}M`,callback_data:"s:warning"}],
    [{text:"⬅ BACK",callback_data:"p:back"}]
  ]};
}
function premiumKb(){
  return {inline_keyboard:[
    [{text:"➕ ADD PREMIUM",callback_data:"u:add"},{text:"➖ REMOVE",callback_data:"u:remove"}],
    [{text:"📋 LIST USERS",callback_data:"u:list"},{text:"🔄 REFRESH",callback_data:"p:users"}],
    [{text:"⬅ BACK TO COMMAND DECK",callback_data:"p:back"}]
  ]};
}
function messagesKb(){
  return {inline_keyboard:[
    [{text:"🎯 PREDICTION",callback_data:"m:prediction"},{text:"✅ WIN",callback_data:"m:win"}],
    [{text:"💎 JACKPOT",callback_data:"m:jackpot"},{text:"🚀 SUPER WIN",callback_data:"m:superWin"}],
    [{text:"❌ LOSS",callback_data:"m:loss"},{text:"🛡 HOLD",callback_data:"m:hold"}],
    [{text:"⏰ WARNING",callback_data:"m:warning"}],
    [{text:"⬅ BACK",callback_data:"p:back"}]
  ]};
}

async function editPanel(chatId,messageId,text,replyMarkup){
  try{await bot.editMessageText(text,{chat_id:chatId,message_id:messageId,parse_mode:"HTML",reply_markup:replyMarkup});}
  catch(e){console.error("panel edit:",e.message);}
}
const inputMode=new Map();

bot.onText(/^\/panel$/,(msg)=>{
  if(!isAdmin(msg))return bot.sendMessage(msg.chat.id,"⛔ Admin only.");
  bot.sendMessage(msg.chat.id,"<b>⚡ IX COMMAND DECK</b>\n\n"+dashboard(),{parse_mode:"HTML",reply_markup:kb()});
});
bot.onText(/^\/health$/,(msg)=>{if(isAdmin(msg))bot.sendMessage(msg.chat.id,dashboard());});
bot.onText(/^\/sub\s+(\d+)\s+(\d+)$/,(msg,m)=>{
  if(!isAdmin(msg))return;
  const exp=addSub(m[1],Number(m[2]));
  bot.sendMessage(msg.chat.id,`💎 Premium added\nUser: ${m[1]}\nExpires: ${fmtDate(exp)}`);
});
bot.onText(/^\/unsub\s+(\d+)$/,(msg,m)=>{if(isAdmin(msg)){removeSub(m[1]);bot.sendMessage(msg.chat.id,"✅ Subscription removed.");}});
bot.onText(/^\/premium$/,(msg)=>{
  if(!isAdmin(msg))return;
  const rows=activeSubs().map(([id,s])=>`• ${id} — ${fmtDate(s.expiresAt)}`);
  bot.sendMessage(msg.chat.id,"💎 <b>ACTIVE PREMIUM</b>\n"+(rows.join("\n")||"No active subscriptions."),{parse_mode:"HTML"});
});
bot.onText(/^\/sessions$/,(msg)=>{
  if(!isAdmin(msg))return;
  const rows=(state.schedule.sessions||[]).map((s,i)=>`${i+1}. ${s.start} → ${s.end}`);
  bot.sendMessage(msg.chat.id,`🗓 ${state.schedule.enabled?"ON":"OFF"}\n${rows.join("\n")||"No sessions."}`);
});

bot.on("callback_query",async q=>{
  const msg=q.message;
  if(!msg || !isAdmin(q))return;
  const d=q.data||"";
  try{await bot.answerCallbackQuery(q.id);}catch{}
  if(d==="p:toggle"){state.running=!state.running;saveState();return editPanel(msg.chat.id,msg.message_id,"<b>⚡ CONTROL CENTER</b>\n\n"+dashboard(),kb());}
  if(d==="p:chart"){
    await sendChart(msg.chat.id,chartSvgData(state.resultHistory||[]),'📈 Prediction Result Chart');
    return;
  }
  if(d==="p:winrate"){
    const a=analyticsSummary();
    return editPanel(msg.chat.id,msg.message_id,`<b>🔥 WIN-RATE ANALYTICS</b>\n\nTotal settled: <b>${a.total}</b>\nWins + Jackpots: <b>${state.wins}</b>\nLosses: <b>${state.losses}</b>\nWin-rate: <b>${a.accuracy}%</b>\n\nCurrent streak: <b>${state.winStreak}</b>\nBest streak: <b>${state.bestStreak}</b>`,kb());
  }
  if(d==="p:heat"){
    await sendChart(msg.chat.id,heatmapSvg(state.resultHistory||[]),'🌡 Loss Heatmap — Dhaka Time');
    return;
  }
  if(d==="p:holds"){
    const rows=(state.holdHistory||[]).slice(0,12).map((h,i)=>`${i+1}. ${fmtDate(h.at)} | ${h.triggerLosses} LOSS → ${h.periods} HOLD | ${h.completed?"DONE":"ACTIVE"}`);
    return editPanel(msg.chat.id,msg.message_id,"<b>📋 HOLD HISTORY</b>\n\n"+(rows.join("\n")||"No hold events yet."),kb());
  }
  if(d==="p:users"){
    const users=activeSubs();
    const body=users.length?users.map(([id,s],i)=>`${i+1}. 👤 <code>${esc(id)}</code>\n   💎 Expires: <b>${fmtDate(s.expiresAt)}</b>`).join("\n"):"No active premium subscriptions.";
    return editPanel(msg.chat.id,msg.message_id,`<b>💎 USER COMMAND DECK</b>\n\nActive premium: <b>${users.length}</b>\n\n${body}\n\n<i>Use Add/Remove to manage access.</i>`,premiumKb());
  }
  if(d==="p:sessions"){
    const a=analyticsSummary();
    const rows=Object.entries(a.sessions).map(([k,v])=>`${k} | ${v.total} total | ${v.wins} win | ${v.losses} loss | ${v.total?Math.round(v.wins/v.total*100):0}%`);
    return editPanel(msg.chat.id,msg.message_id,"<b>📊 SESSION ANALYTICS</b>\n\n"+(rows.join("\n")||"No settled results yet."),kb());
  }
  if(d==="p:stats"||d==="p:refresh"||d==="p:back")return editPanel(msg.chat.id,msg.message_id,"<b>⚡ CONTROL CENTER</b>\n\n"+dashboard(),kb());
  if(d==="p:engine")return editPanel(msg.chat.id,msg.message_id,"<b>🧠 ENGINE SETTINGS</b>\n\nSelect mode and channel message behavior.",engineKb());
  if(d==="p:hold")return editPanel(msg.chat.id,msg.message_id,`<b>🛡 LOSS → HOLD SYSTEM</b>\n\nAfter <b>${state.hold.threshold}</b> consecutive losses, the bot pauses predictions for <b>${state.hold.periods}</b> new periods.\n\nCurrent remaining: <b>${state.holdRemaining}</b>\nTrigger count: <b>${state.holdTriggerCount}</b>`,holdKb());
  if(d==="p:schedule")return editPanel(msg.chat.id,msg.message_id,"<b>🗓 SCHEDULE EDITOR</b>\n\n"+(state.schedule.sessions||[]).map((s,i)=>`${i+1}. <code>${s.start}-${s.end}</code>`).join("\n")+"\n\nWarning: "+state.schedule.warningMinutes+" minutes",scheduleKb());
  if(d==="p:premium")return editPanel(msg.chat.id,msg.message_id,"<b>💎 PREMIUM MANAGER</b>\n\nActive subscriptions: "+activeSubs().length,premiumKb());
  if(d==="p:messages")return editPanel(msg.chat.id,msg.message_id,"<b>✏️ MESSAGE STUDIO</b>\n\nTap a template, then send the new text in this private chat.",messagesKb());
  if(d==="p:reset"){
    state.wins=state.losses=state.jackpots=state.winStreak=state.bestStreak=state.lossStreak=state.bestLossStreak=0;
    state.predictions=[]; state.resultHistory=[]; state.holdHistory=[]; state.sessionStats={}; saveState();
    return editPanel(msg.chat.id,msg.message_id,"<b>♻ STATS RESET</b>\n\nAll bot statistics and prediction history were reset.",kb());
  }

  if(d==="e:1m"||d==="e:30s"){state.mode=d.slice(2);saveState();return editPanel(msg.chat.id,msg.message_id,"<b>🧠 ENGINE SETTINGS</b>\n\nMode changed to <b>"+state.mode+"</b>.",engineKb());}
  if(d==="e:del"){
    config.DELETE_ON_LOSS=!config.DELETE_ON_LOSS;
    return editPanel(msg.chat.id,msg.message_id,"<b>🧠 ENGINE SETTINGS</b>\n\nDelete-on-loss is now <b>"+(config.DELETE_ON_LOSS?"ON":"OFF")+"</b>.",engineKb());
  }

  if(d==="h:toggle"){state.hold.enabled=!state.hold.enabled;saveState();return editPanel(msg.chat.id,msg.message_id,"<b>🛡 LOSS → HOLD</b>\n\nSystem: <b>"+(state.hold.enabled?"ON":"OFF")+"</b>",holdKb());}
  if(d==="h:threshold"||d==="h:periods"){
    inputMode.set(msg.chat.id,d==="h:threshold"?"hold_threshold":"hold_periods");
    return bot.sendMessage(msg.chat.id,d==="h:threshold"?"Send new LOSS threshold (1-20):":"Send number of HOLD periods (1-50):");
  }
  if(d==="h:now"){state.holdRemaining=state.hold.periods;saveState();return editPanel(msg.chat.id,msg.message_id,"<b>🛡 MANUAL HOLD ENABLED</b>\n\nRemaining: "+state.holdRemaining+" periods.",holdKb());}
  if(d==="h:clear"){state.holdRemaining=0;saveState();return editPanel(msg.chat.id,msg.message_id,"<b>🟢 HOLD CLEARED</b>",holdKb());}

  if(d==="s:toggle"){state.schedule.enabled=!state.schedule.enabled;saveState();return editPanel(msg.chat.id,msg.message_id,"<b>🗓 SCHEDULE</b>\n\nStatus: <b>"+(state.schedule.enabled?"ON":"OFF")+"</b>",scheduleKb());}
  if(d==="s:clear"){state.schedule.sessions=[];saveState();return editPanel(msg.chat.id,msg.message_id,"<b>🗑 SESSIONS CLEARED</b>",scheduleKb());}
  if(d==="s:add"){inputMode.set(msg.chat.id,"session");return bot.sendMessage(msg.chat.id,"Send session as <code>20:00-23:00</code>",{parse_mode:"HTML"});}
  if(d==="s:warning"){inputMode.set(msg.chat.id,"warning");return bot.sendMessage(msg.chat.id,"Send warning minutes, e.g. <code>30</code>",{parse_mode:"HTML"});}

  if(d==="u:add"){inputMode.set(msg.chat.id,"sub_add");return bot.sendMessage(msg.chat.id,"Send <code>USER_ID DAYS</code>\nExample: <code>123456789 30</code>",{parse_mode:"HTML"});}
  if(d==="u:remove"){inputMode.set(msg.chat.id,"sub_remove");return bot.sendMessage(msg.chat.id,"Send the USER_ID to remove.",{parse_mode:"HTML"});}
  if(d==="u:list"){
    const rows=activeSubs().map(([id,s])=>`• <code>${id}</code> — ${fmtDate(s.expiresAt)}`);
    return bot.sendMessage(msg.chat.id,"💎 <b>ACTIVE SUBSCRIPTIONS</b>\n"+(rows.join("\n")||"None"),{parse_mode:"HTML"});
  }

  if(d.startsWith("m:")){
    const key=d.slice(2);
    inputMode.set(msg.chat.id,"msg:"+key);
    return bot.sendMessage(msg.chat.id,
      `✏️ Send new <b>${key}</b> template.\n\nPlaceholders: {period} {side} {n1} {n2} {confidence} {rule} {result} {predSide} {streak} {lossStreak} {holdPeriods} {minutes} {start} {end}`,
      {parse_mode:"HTML"});
  }
});

bot.on("message",msg=>{
  if(!isAdmin(msg) || !msg.text || msg.text.startsWith("/"))return;
  const mode=inputMode.get(msg.chat.id);
  if(!mode)return;
  inputMode.delete(msg.chat.id);

  if(mode==="hold_threshold"){
    const n=clamp(parseInt(msg.text,10)||state.hold.threshold,1,20);
    state.hold.threshold=n;saveState();return bot.sendMessage(msg.chat.id,`✅ LOSS threshold set to ${n}. Use /panel to continue.`);
  }
  if(mode==="hold_periods"){
    const n=clamp(parseInt(msg.text,10)||state.hold.periods,1,50);
    state.hold.periods=n;saveState();return bot.sendMessage(msg.chat.id,`✅ HOLD periods set to ${n}.`);
  }
  if(mode==="session"){
    const m=msg.text.trim().match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
    if(!m)return bot.sendMessage(msg.chat.id,"❌ Invalid. Use HH:MM-HH:MM");
    state.schedule.sessions.push({start:`${m[1]}:${m[2]}`,end:`${m[3]}:${m[4]}`});
    state.schedule.sessions.sort((a,b)=>modMin(a.start)-modMin(b.start));saveState();
    return bot.sendMessage(msg.chat.id,"✅ Session added.");
  }
  if(mode==="warning"){
    const n=clamp(parseInt(msg.text,10)||state.schedule.warningMinutes,0,180);
    state.schedule.warningMinutes=n;saveState();return bot.sendMessage(msg.chat.id,`✅ Warning set to ${n} minutes.`);
  }
  if(mode==="sub_add"){
    const m=msg.text.trim().match(/^(\d+)\s+(\d+)$/);
    if(!m)return bot.sendMessage(msg.chat.id,"❌ Use USER_ID DAYS");
    const exp=addSub(m[1],Number(m[2]));
    return bot.sendMessage(msg.chat.id,`💎 Added ${m[1]}\nExpires: ${fmtDate(exp)}`);
  }
  if(mode==="sub_remove"){
    removeSub(msg.text.trim());
    return bot.sendMessage(msg.chat.id,"✅ Subscription removed.");
  }
  if(mode.startsWith("msg:")){
    const key=mode.slice(4);
    if(!Object.prototype.hasOwnProperty.call(state.customTemplates,key))return;
    state.customTemplates[key]=msg.text;saveState();
    return bot.sendMessage(msg.chat.id,`✅ ${key} template updated.`);
  }
});
