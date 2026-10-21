// 私信监听（只回主人）—— 2026-10-19 主人提议：私信比评论区更安静、风险更小
//   只在【主人那个会话】有新消息时命中；其他会话（系统通知 / 陌生人）一律忽略 ✗
//
//   ⚠️ 2026-10-21：**命中不再自动推进 lastSeen** ✗→✓
//     旧行为：命中那一刻就写 lastSeen → 早于"唤醒她"是否成功
//       → 唤醒一失败（ctx 失效 / 会话 inactive），这条消息就**永久沉到已读线下面** ✗
//       用户实测：19:19、19:27 两条私信唤醒失败，之后再也没叫醒过她 ✗
//     新行为：命中只打印、不动状态 ✓；调用方**唤醒成功后才跑 `--mark <ts>`** 推进 ✓
//       → 唤醒失败就不推进 → 下一轮继续命中 → 自动重试 ✓ 消息不会丢 ✓
//
//   用法:
//     node dm-await.mjs --baseline       把当前状态记为"已读"（含未读基数），从现在起只认新消息
//     node dm-await.mjs --once [--json]  轮询一次（命中打印 DM_HIT，**不推进 lastSeen**）
//     node dm-await.mjs --mark <ts>      唤醒成功后才调：把已读线推进到 ts（只前进不后退 ✓）
//
//   ⚠️ 2026-10-21：删掉从未实现的 `--interval` / `--minutes`。
//     它们只被参数解析器收下、背后没有任何循环代码，却一直写在 usage 里 ——
//     用户实测被骗到（`dm-await --minutes 1` 以为在监听一分钟，其实只扫了一眼 ✗）。
//     要持续监听：插件里 dmTick 每 20 秒自己循环 ✓，或自己写 while + sleep。
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[argv[i].slice(2)] = true
    else { opt[argv[i].slice(2)] = v; i += 1 }
  }
}
const BASE = !!opt.baseline
const ONCE = !!opt.once || BASE
const JSONOUT = !!opt.json

const U = process.env.USERPROFILE || process.env.HOME || '/'
const STATE = path.join(U, '.bili-ai', 'dm-await-state.json')
const c = JSON.parse(fs.readFileSync(path.join(U, '.bili-ai', 'credentials.json'), 'utf8'))
const cfg = config()
const OWNER = String(cfg.owner?.mid ?? '').trim()
const OWNER_NAME = String(cfg.owner?.name ?? '主人')
if (!OWNER) { console.error('✗ 配置里 owner.mid 为空'); process.exit(2) }

const H = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}`,
}
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
const saveState = (o) => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2) + '\n') }
const parsed = (content) => {
  // 私信内容可能是 {"content":"…"} 或纯文本
  try { const j = JSON.parse(String(content)); return String(j.content ?? j.text ?? content) } catch { return String(content ?? '') }
}

async function poll() {
  const u = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_id=0&count=20&mobi_app=web'
  const r = await fetch(u, { headers: H })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) return { ok: false, why: `get_sessions code=${j.code} ${j.message ?? ''}` }
  const list = j.data?.session_list ?? []
  const mine = list.find((s) => String(s.talker_id) === OWNER)
  if (!mine) return { ok: true, hit: false, why: '没找到主人的会话' }
  const last = mine.last_msg ?? {}
  const ts = Number(last.timestamp ?? 0)
  const text = parsed(last.content)
  const sender = Number(last.sender_uid ?? 0)
  const fromOwner = String(sender) === OWNER      // 只有主人发的才算
  return { ok: true, ts, text, fromOwner, unread: Number(mine.unread_count ?? 0) }
}

if (BASE) {
  const r = await poll()
  if (!r.ok) { console.error(`✗ ${r.why}`); process.exit(3) }
  saveState({ lastSeen: r.ts || 0, unread: r.unread ?? 0, at: new Date().toISOString() })
  console.log(`已把当前私信状态标记为已读（lastSeen=${r.ts} · 未读基数=${r.unread ?? 0}）✓ 从现在起只认新消息`)
  process.exit(0)
}

// ── 2026-10-21：`--mark <ts>` —— 唤醒成功后才推进已读线 ──────────────────────
//   由插件在 sc.prompt() 成功返回后调用 ✓；失败时不调用 → 下一轮继续命中 → 重试 ✓
//   只前进不后退：避免把已经更靠后的已读线拉回去，导致旧消息反复触发 ✗
if (opt.mark !== undefined) {
  const ts = Number(opt.mark)
  if (!Number.isFinite(ts)) { console.error('✗ --mark 要跟一个时间戳，例如 --mark 1761048000'); process.exit(2) }
  const cur = loadState()
  // 网络炸了也要能标记 ✓ —— 否则"唤醒成功但标记失败"会导致同一条消息被反复唤醒 ✗
  let p = { ok: false }
  try { p = await poll() } catch { /* 走下面的兜底：沿用已存的未读基数 ✓ */ }
  const next = Math.max(Number(cur.lastSeen ?? 0), ts)
  saveState({
    lastSeen: next,
    unread: p.ok ? (p.unread ?? 0) : Number(cur.unread ?? 0),   // 连未读基线一起记 → 上升沿判据从这里来 ✓
    at: new Date().toISOString(),
  })
  console.log(`已标记读到 ts=${ts}（lastSeen=${next} · 未读基数=${p.ok ? p.unread ?? 0 : Number(cur.unread ?? 0)}）✓`)
  process.exit(0)
}

// ── 2026-10-21 重写判据 ────────────────────────────────────────────────
//   主判据：主人发了比 lastSeen 更新的消息（和以前一样 ✓）
//   兜底判据：**未读数上升沿** —— last_msg 时间判据万一漏了（比如已读线被错误推进过），
//     未读从 N 涨到 N+1 也能把消息捞回来 ✓
//     不会死循环：推进已读线时会把当时的未读数一起存成基线，下次同一未读数不再算"上升" ✓
//   ⚠️ 命中后**不写任何状态** —— 交给调用方唤醒成功后才 --mark ✓
const st = loadState()
const r = await poll()
if (!r.ok) { console.error(`✗ ${r.why}`); process.exit(3) }
const lastSeen = Number(st.lastSeen ?? 0)
const lastUnread = Number(st.unread ?? 0)
const hit = r.fromOwner && (r.ts > lastSeen || r.unread > lastUnread)
if (hit) {
  if (JSONOUT) console.log(JSON.stringify({ hit: true, mid: OWNER, name: OWNER_NAME, text: r.text, ts: r.ts, unread: r.unread }))
  else console.log(`DM_HIT mid=${OWNER} name=${OWNER_NAME} ts=${r.ts} unread=${r.unread} text=${r.text.replace(/\n/g, ' ').slice(0, 200)}`)
  process.exit(0)
}
if (JSONOUT) console.log(JSON.stringify({ hit: false, unread: r.unread }))
else if (!ONCE) console.log('无新私信')
process.exit(1)
