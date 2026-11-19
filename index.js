import { appendFileSync as __appendLog, mkdirSync as __mkdirLog } from 'node:fs';
import { join as __joinLog } from 'node:path';
/**
 * dsh-daily-push 的 Host 半。
 *
 * 四个同源端点：
 *   GET  /api/daily-consult.health      宿主侧能不能拿到 connection / llm / agentDefaultModel，默认模型是什么
 *   POST /api/daily-consult             单次调模型，NDJSON 流式回吐（不建会话、不挂工具、不碰工作区）
 *   POST /api/daily-consult.intros      批量把几条英文仓库描述润色成中文摘要（NDJSON 流，一行一条即时下发）
 *   GET  /api/daily-consult.installed   本机 profile 里已经装了哪些包（给"已装"标记用）
 *
 * 设计要点：咨询不创建 Session，所以不会在左侧会话列表里多出东西，也不会污染外面那段对话；
 * 一次问答就是一次纯模型调用，system 里限定成"插件顾问"。
 */

import fs from 'node:fs';
import path from 'node:path';

const HEALTH_PATH = '/api/daily-consult.health';
const ASK_PATH = '/api/daily-consult';
const INTROS_PATH = '/api/daily-consult.intros';
const INSTALLED_PATH = '/api/daily-consult.installed';
const ZH_PATH = '/api/daily-consult.zh';
const MAX_ZH_ITEMS = 60;
const ZH_KEEP = 3000;

/** 翻译用的 system：一行一个 JSON，不许加解释。 */
const ZH_SYSTEM = [
  '你是中文技术编辑，把 GitHub 仓库的英文一句话描述译成通顺的中文。',
  '输出格式：每行一个 JSON 对象，形如 {"name":"owner/repo","zh":"中文描述"}，不要数组、不要代码围栏、不要序号。',
  'name 必须原样照抄输入的 name；zh 要像人话，60 字以内，保留专有名词（DSH、MCP、CLI、TUI、API 等）不译。',
  '把营销语气去掉（强大、革命性、赋能之类），只讲它实际做什么；看不出来就照原文直译，不要编造功能。',
].join('\n');
const RECENT_PATH = '/api/daily-consult.recent';
const SEARCH_PATH = '/api/daily-consult.search';
const NPM_PATH = '/api/daily-consult.npm';
const GH_TOP_PATH = '/api/daily-consult.ghtop';

const SYSTEM_PROMPT = [
  '你是 DeepSeek Harness（DSH）的插件顾问，回答要短、具体、能落地。',
  '用户会给你一个插件、skill 或仓库的名字/链接/一句话简介，问它值不值得装、能干什么、有没有坑。',
  '你了解 DSH 的插件体系：一个插件通常有两半——宿主半（Host，注册服务、HTTP 端点、工具）和浏览器半（Client，往侧栏 sidebar.panellist、主区域 main、设置页等 slot 注册界面），',
  '通过 cordis.patch.yml 挂进 profile；插件来源可以是 npm 包，也可以是本地目录（junction 进 profile 的 node_modules）。',
  '判断价值时优先看：解决什么真实需求、跟已有插件是否重复、维护是否活跃、有没有明显风险（原生依赖、过宽权限、锁死版本）。',
  '只给判断和建议，不要输出 markdown 标题、不要长篇罗列；不确定就直说不确定，不要编造仓库内容。',
  '如果用户问的仓库根本不是 DSH 插件（壁纸、游戏、工具、普通网页项目都算），就按它本来的用途讲清楚：是什么、能拿来干什么、要不要用得上，不要硬套插件框架；只有确实和 DSH 有关时才谈插件。',
  '问题前面可能有三段真实数据：【本机已装】是本机 node_modules 里已有的包名，【榜单信息】是该仓库在插件榜单里的星标/语言/许可/更新时间，【中文简介】是它的中文一句话。',
  '这些数据可以直接用来判断"是否重复、是否活跃"，不要复述它们，也不要假装看到过仓库源码。',
  '如果用户直接贴了 README、package.json 或源码片段，以贴进来的原文为准；原文里没写能不能在 DSH 里用，就明确说"从这段内容看不出来"，不要替它保证。',
].join('\n');

const MAX_QUESTION_CHARS = 12000;
const MAX_TOKENS = 900;

/** 批量润色用的 system：一行一个 JSON 对象，方便边生成边抠出来（不许编造功能）。 */
const INTRO_SYSTEM = [
  '你是中文科技编辑，把 GitHub 仓库的英文描述改写成人话中文简介。',
  '输出格式：每行一个 JSON 对象，不要数组、不要代码围栏、不要序号、不要任何多余文字。',
  '每个对象形如 {"name":"owner/repo","one":"…","a":"…","b":"…"}，name 必须原样照抄输入的 name。',
  'one：一句话说清它到底能干什么，不超过 45 字，不要营销词（强大 / 赋能 / 一键 / 革命性）；',
  'a：它具体能帮你做什么，不超过 35 字；',
  'b：装之前要知道的一句话（限制、前置条件、可能的坑），不超过 35 字；看不出来就写"用途不明，建议先看 README"。',
  '唯一依据是输入里的 name / desc / topics；看不出来就直说，绝对不要编造功能。',
].join('\n');

const MAX_INTRO_ITEMS = 12;
const MAX_INTRO_TOKENS = 900;

/** 把每次咨询的结果记一行，出问题好查（失败也不影响回答）。*/
async function logConsult(info) {
  try {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = process.env.DSH_HOME || os.homedir();
    const dir = path.join(home, 'logs');
    await fs.mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      model: info.provider + '/' + info.model,
      effort: info.reasoningEffort == null ? null : info.reasoningEffort,
      chars: info.chars,
      firstDeltaMs: info.firstDeltaMs,
      totalMs: info.totalMs,
      error: info.lastError || null,
      q: String(info.question || '').slice(0, 80),
    });
    await fs.appendFile(path.join(dir, 'daily-push-consult.log'), line + '\n');
  } catch {
    /* 记日志失败就算了 */
  }
}

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function attempt(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

async function handleHealth(host) {
  const defaultModel = attempt(() => host.get('agentDefaultModel'));
  const selection = defaultModel ? attempt(() => defaultModel.currentSelection()) : undefined;
  let providers;
  try {
    providers = host.llm.listProviders ? await host.llm.listProviders() : undefined;
  } catch {
    providers = undefined;
  }
  return jsonResponse({
    ok: true,
    node: process.version,
    hasConnection: !!host.connection,
    hasLlm: !!host.llm,
    hasStream: typeof (host.llm && host.llm.stream) === 'function',
    hasAgentDefaultModel: !!defaultModel,
    defaultSelection: selection || null,
    providers: providers || null,
    hasSessionController: !!attempt(() => host.get('sessionController')),
  });
}

async function handleAsk(host, request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const question = String((body && body.question) || '').slice(0, MAX_QUESTION_CHARS).trim();
  if (!question) return jsonResponse({ ok: false, error: '缺少 question' }, 400);

  let provider = body && body.provider;
  let model = body && body.model;
  let reasoningEffort = body && body.reasoningEffort;
  if (!provider || !model) {
    const defaultModel = attempt(() => host.get('agentDefaultModel'));
    const selection = defaultModel ? attempt(() => defaultModel.currentSelection()) : undefined;
    if (selection) {
      provider = provider || selection.provider;
      model = model || selection.model;
      if (reasoningEffort === undefined) reasoningEffort = selection.reasoningEffort;
    }
  }
  if (!provider || !model) {
    return jsonResponse({ ok: false, error: '拿不到默认模型，也没有显式指定 provider/model' }, 400);
  }
  if (typeof (host.llm && host.llm.stream) !== 'function') {
    return jsonResponse({ ok: false, error: 'host.llm.stream 不可用' }, 500);
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n'));
        } catch {
          closed = true;
        }
      };

      send({
        t: 'meta',
        provider,
        model,
        reasoningEffort: reasoningEffort === undefined ? null : reasoningEffort,
        startedAt,
      });

      let chars = 0;
      let firstDeltaMs = null;
      let lastError = null;
      try {
        const chunks = host.llm.stream({
          provider,
          model,
          reasoningEffort,
          system: SYSTEM_PROMPT,
          temperature: 0.3,
          maxTokens: MAX_TOKENS,
          messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
        });
        for await (const chunk of chunks) {
          if (!chunk || typeof chunk !== 'object') continue;
          if (chunk.type === 'text-delta') {
            if (!chunk.text) continue;
            chars += chunk.text.length;
            const ms = Date.now() - startedAt;
            if (firstDeltaMs === null) firstDeltaMs = ms;
            send({ t: 'delta', text: chunk.text, ms });
          } else if (chunk.type === 'reasoning-delta') {
            send({ t: 'reasoning', ms: Date.now() - startedAt });
          } else if (chunk.type === 'usage') {
            send({ t: 'usage', usage: chunk.usage });
          } else if (chunk.type === 'finish') {
            const kind = chunk.reason ? chunk.reason.kind : null;
            const failure = chunk.reason ? chunk.reason.failure : null;
            const detail = failure ? failure.message || failure.code || '' : '';
            if (kind === 'error') {
              lastError = detail || '未知原因';
              send({ t: 'error', message: '模型调用失败：' + lastError, ms: Date.now() - startedAt });
            }
            send({ t: 'finish', reason: kind, ms: Date.now() - startedAt });
          }
        }
        if (chars === 0 && !lastError) {
          lastError = '模型没有返回任何文字';
          send({ t: 'error', message: '模型没有返回任何文字（可能被判为空响应，或额度/模型配置有问题）', ms: Date.now() - startedAt });
        }
        logConsult({ provider, model, reasoningEffort, chars, firstDeltaMs, lastError, totalMs: Date.now() - startedAt, question });
        send({ t: 'done', chars, firstDeltaMs, totalMs: Date.now() - startedAt });
      } catch (err) {
        send({ t: 'error', message: String((err && err.message) || err), ms: Date.now() - startedAt });
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* 已经关了 */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

function clipText(value, max) {
  const s = String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 从模型输出里抠出 JSON 数组；抠不出来就返回空（面板会退回规则生成的介绍）。 */
function parseIntros(text, items) {
  const allowed = new Set(items.map((it) => it.name));
  let src = String(text || '').trim();
  const fenced = src.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) src = fenced[1];
  const start = src.indexOf('[');
  const end = src.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(src.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const name = String(row.name || '').trim();
    if (!allowed.has(name)) continue;
    const one = clipText(row.one, 90);
    if (!one) continue;
    out.push({ name, one, a: clipText(row.a, 60), b: clipText(row.b, 60) });
  }
  return out;
}

async function zhLog(line) {
  try {
    const fsx = await import('node:fs/promises');
    const osx = await import('node:os');
    const pathx = await import('node:path');
    const home = process.env.DSH_HOME || osx.homedir();
    const dir = pathx.join(home, 'logs');
    await fsx.mkdir(dir, { recursive: true });
    await fsx.appendFile(pathx.join(dir, 'daily-push-zh.log'), new Date().toISOString() + ' ' + line + '\n');
  } catch {
    /* 日志失败无所谓 */
  }
}

function zhHash(text) {
  let h = 5381;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

async function zhCacheFile() {
  const os = await import('node:os');
  const path = await import('node:path');
  const home = process.env.DSH_HOME || os.homedir();
  return path.join(home, 'cache', 'daily-push-zh.json');
}

async function readZhCache() {
  try {
    const fs = await import('node:fs/promises');
    const file = await zhCacheFile();
    const raw = await fs.readFile(file, 'utf8');
    const j = JSON.parse(raw);
    return j && j.map && typeof j.map === 'object' ? j.map : {};
  } catch {
    return {};
  }
}

async function writeZhCache(map) {
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const file = await zhCacheFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const keys = Object.keys(map);
    if (keys.length > ZH_KEEP) {
      keys
        .map((k) => [k, (map[k] && map[k].at) || 0])
        .sort((a, b) => b[1] - a[1])
        .slice(ZH_KEEP)
        .forEach(([k]) => delete map[k]);
    }
    await fs.writeFile(file, JSON.stringify({ v: 1, map }), 'utf8');
  } catch {
    /* 写缓存失败不影响返回 */
  }
}

/** POST /api/daily-consult.zh  {items:[{name, desc}]} → {ok, map:{name:zh}} */
async function handleZh(host, request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const raw = Array.isArray(body && body.items) ? body.items : [];
  const items = raw
    .slice(0, MAX_ZH_ITEMS)
    .map((it) => ({ name: String((it && it.name) || '').trim(), desc: clipText(it && it.desc, 300) }))
    .filter((it) => it.name && it.desc);
  await zhLog('ask items=' + items.length + ' first=' + (items[0] ? items[0].name : '-'));
  const cache = await readZhCache();
  const out = {};
  const todo = [];
  for (const it of items) {
    const hit = cache[it.name];
    const h = zhHash(it.desc);
    if (hit && hit.h === h && hit.zh) out[it.name] = hit.zh;
    else todo.push({ name: it.name, desc: it.desc, h });
  }
  if (!todo.length) return jsonResponse({ ok: true, map: out, cached: true });
  if (typeof (host.llm && host.llm.stream) !== 'function') {
    return jsonResponse({ ok: true, map: out, error: 'llm 不可用' });
  }

  let provider = body && body.provider;
  let model = body && body.model;
  if (!provider || !model) {
    const dm = attempt(() => host.get('agentDefaultModel'));
    const sel = dm ? attempt(() => dm.currentSelection()) : undefined;
    if (sel) {
      provider = provider || sel.provider;
      model = model || sel.model;
    }
  }
  if (!provider || !model) return jsonResponse({ ok: true, map: out, error: '拿不到默认模型' });

  const prompt = '把下面这些仓库描述译成中文，按输入顺序一行一个 JSON：\n' + JSON.stringify(todo.map((t) => ({ name: t.name, desc: t.desc })));
  let text = '';
  /* 同一件事按不同参数试三次：有的 provider 不认 'off'，有的不认 undefined */
  const tries = [];
  if (body && body.reasoningEffort) tries.push(body.reasoningEffort);
  const selEff = attempt(() => {
    const dm = host.get('agentDefaultModel');
    return dm ? dm.currentSelection().reasoningEffort : undefined;
  });
  if (selEff) tries.push(selEff);
  tries.push('off');
  tries.push(undefined);
  const uniq = [];
  for (const t of tries) {
    const k = t === undefined ? '__none__' : String(t);
    if (uniq.every((u) => (u === undefined ? '__none__' : String(u)) !== k)) uniq.push(t);
  }
  for (const eff of uniq) {
    let got = '';
    let seenTypes = [];
    let finishInfo = '';
    try {
      const stream = host.llm.stream({
        provider,
        model,
        reasoningEffort: eff,
        system: ZH_SYSTEM,
        temperature: 0.3,
        maxTokens: 1200,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      });
      for await (const chunk of stream) {
        if (!chunk) continue;
        if (seenTypes.indexOf(chunk.type) < 0) seenTypes.push(chunk.type);
        if (chunk.type === 'text-delta' && chunk.text) got += chunk.text;
        if (chunk.type === 'finish') {
          try {
            finishInfo = JSON.stringify(chunk.reason || chunk.finishReason || chunk).slice(0, 200);
          } catch {
            finishInfo = 'unserializable';
          }
          break;
        }
      }
    } catch (err) {
      finishInfo = 'threw ' + String((err && err.message) || err);
    }
    await zhLog(
      'try eff=' + String(eff) + ' model=' + provider + '/' + model + ' chars=' + got.length + ' chunks=' + seenTypes.join(',') + ' finish=' + finishInfo,
    );
    if (got) {
      text = got;
      break;
    }
  }
  if (!text) {
    return jsonResponse({ ok: true, map: out, error: '模型没有返回文本（见 logs\daily-push-zh.log）' });
  }

  const byName = new Map(todo.map((t) => [t.name, t]));
  const text2 = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const objs = [];
  const pushObj = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach(pushObj);
      return;
    }
    if (Array.isArray(o.items)) {
      o.items.forEach(pushObj);
      return;
    }
    objs.push(o);
  };
  /* ① 整体就是一个 JSON（数组或 {items:[…]}） */
  try {
    pushObj(JSON.parse(text2));
  } catch {
    /* 不是整体 JSON，走下一步 */
  }
  /* ② 一行一个对象 */
  if (!objs.length) {
    for (const line of text2.split(/\r?\n/)) {
      const ln = line.trim().replace(/,\s*$/, '');
      if (!ln.startsWith('{')) continue;
      try {
        pushObj(JSON.parse(ln));
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  /* ③ 混杂输出：把所有 {...} 抠出来 */
  if (!objs.length) {
    const m = text2.match(/\{[^{}]*\}/g) || [];
    for (const seg of m) {
      try {
        pushObj(JSON.parse(seg));
      } catch {
        /* 跳过 */
      }
    }
  }
  for (const obj of objs) {
    const name = String((obj && (obj.name || obj.repo || obj.id)) || '').trim();
    const zh = clipText(obj && (obj.zh || obj.cn || obj.translation || obj.one || obj.desc), 120);
    const src = byName.get(name);
    if (!src || !zh) continue;
    out[name] = zh;
    cache[name] = { h: src.h, zh, at: Date.now() };
  }
  /* 模型可能不按 JSON 走：退化成按行顺序对齐（跳过看起来像 JSON 的行） */
  if (Object.keys(out).length === items.length - todo.length) {
    const lines = String(text)
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim())
      .filter((l) => l && !l.startsWith('{') && !l.startsWith('['));
    if (lines.length >= todo.length) {
      todo.forEach((t, i) => {
        const zh = clipText(lines[i], 120);
        if (!zh) return;
        out[t.name] = zh;
        cache[t.name] = { h: t.h, zh, at: Date.now() };
      });
    }
  }

  await writeZhCache(cache);
  await zhLog('done out=' + Object.keys(out).length + ' todo=' + todo.length + ' cachedHit=' + (items.length - todo.length));
  return jsonResponse({ ok: true, map: out, translated: Object.keys(out).length - (items.length - todo.length) });
}

async function handleIntros(host, request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const raw = Array.isArray(body && body.items) ? body.items : [];
  const items = raw
    .slice(0, MAX_INTRO_ITEMS)
    .map((it) => ({
      name: String((it && it.name) || '').trim(),
      desc: clipText(it && it.desc, 420),
      topics: Array.isArray(it && it.topics) ? it.topics.slice(0, 6).map((t) => String(t)) : [],
      stars: Number((it && it.stars) || 0),
      lang: String((it && it.lang) || ''),
    }))
    .filter((it) => it.name);
  if (!items.length) return jsonResponse({ ok: false, error: '缺少 items' }, 400);
  if (typeof (host.llm && host.llm.stream) !== 'function') {
    return jsonResponse({ ok: false, error: 'host.llm.stream 不可用' }, 500);
  }

  let provider = body && body.provider;
  let model = body && body.model;
  if (!provider || !model) {
    const defaultModel = attempt(() => host.get('agentDefaultModel'));
    const selection = defaultModel ? attempt(() => defaultModel.currentSelection()) : undefined;
    if (selection) {
      provider = provider || selection.provider;
      model = model || selection.model;
    }
  }
  if (!provider || !model) {
    return jsonResponse({ ok: false, error: '拿不到默认模型' }, 400);
  }
  // 写简介不需要推理：默认 off（之前继承默认的 high，模型先"想"一遍才开始写，是慢的主因）。
  const reasoningEffort = (body && body.reasoningEffort) || 'off';

  const allowed = new Set(items.map((it) => it.name));
  const prompt = '请为下面这些仓库各写一行中文简介（一行一个 JSON 对象，按输入顺序）：\n' + JSON.stringify(items);
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n'));
        } catch {
          closed = true;
        }
      };

      const seen = new Set();
      let count = 0;
      let text = '';

      const emit = (row) => {
        if (!row || !row.name || !row.one) return;
        if (seen.has(row.name) || !allowed.has(row.name)) return;
        seen.add(row.name);
        count += 1;
        send({
          t: 'item',
          name: row.name,
          one: row.one,
          a: row.a || '',
          b: row.b || '',
          ms: Date.now() - startedAt,
        });
      };

      // 模型按"一行一个对象"输出，凑满一行就当场解析下发，不等整段写完。
      const emitLine = (line) => {
        let s = String(line || '').trim();
        if (!s) return;
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').replace(/,\s*$/, '').trim();
        if (!s || s === '[' || s === ']' || s === ',') return;
        if (!s.startsWith('{')) return;
        let obj;
        try {
          obj = JSON.parse(s);
        } catch {
          return;
        }
        emit({
          name: String((obj && obj.name) || '').trim(),
          one: clipText(obj.one, 90),
          a: clipText(obj.a, 60),
          b: clipText(obj.b, 60),
        });
      };

      send({ t: 'meta', provider, model, reasoningEffort, startedAt, total: items.length });

      let buffer = '';
      try {
        const chunks = host.llm.stream({
          provider,
          model,
          reasoningEffort,
          system: INTRO_SYSTEM,
          temperature: 0.3,
          maxTokens: MAX_INTRO_TOKENS,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        });
        for await (const chunk of chunks) {
          if (!chunk || chunk.type !== 'text-delta' || !chunk.text) continue;
          text += chunk.text;
          buffer += chunk.text;
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            emitLine(line);
          }
        }
        emitLine(buffer);
      } catch (err) {
        send({ t: 'error', message: String((err && err.message) || err), ms: Date.now() - startedAt });
      }

      // 兜底：模型没照"一行一个"来（吐了数组 / 围栏），流结束后整体再解析一次，补发漏掉的。
      for (const row of parseIntros(text, items)) emit(row);

      send({ t: 'done', count, total: items.length, ms: Date.now() - startedAt });

      if (!closed) {
        closed = true;
        try {
          controller.close();
        } catch {
          /* 已经关了 */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

/** 本机 profile 里装了哪些包：node_modules 下的目录名（含 @scope/name）。 */
async function handleInstalled() {
  const dir = resolveProfileDir() || process.env.DSH_HOME || '';
  if (!dir) return jsonResponse({ ok: false, error: '拿不到 profile 目录' }, 500);
  const nm = path.join(dir, 'node_modules');
  const names = [];
  try {
    for (const ent of fs.readdirSync(nm, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      if (ent.name.startsWith('@')) {
        try {
          for (const sub of fs.readdirSync(path.join(nm, ent.name))) names.push(ent.name + '/' + sub);
        } catch {
          /* 权限之类：跳过这个 scope */
        }
      } else if (ent.isDirectory() || ent.isSymbolicLink()) {
        names.push(ent.name);
      }
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: String((err && err.message) || err) }, 500);
  }
  return jsonResponse({ ok: true, dir, names });
}


/* ─────────────────── 插件动态：跟踪已装插件的变化 ─────────────────── */

const WATCH_PATH = '/api/daily-consult.watch';
const WATCH_TTL_MS = 30 * 60 * 1000;
/** GitHub 仓库状态缓存更久（未登录只有 60 次/小时，省着用）。*/
const GH_TTL_MS = 6 * 60 * 60 * 1000;
/* 令牌：优先读用户在 ⚙ 里填的那份（宿主磁盘，前端永远拿不到原文），
   其次才是进程环境变量。模块级 const 会在进程启动时定死，所以这里必须是函数。 */
function dataHome() {
  return process.env.DSH_HOME || process.env.DSH_PROFILE_DIR || '.';
}

function tokenFilePath() {
  return path.join(dataHome(), 'daily-push-token.json');
}

function envToken() {
  return String(process.env.GITHUB_TOKEN || process.env.DSH_GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
}

/** 5 秒内存缓存：一次 .all 抓取里要建几十个请求头，不必每次都读盘。 */
let tokenMemo = { at: 0, value: null };
const TOKEN_MEMO_MS = 5000;

function readTokenFile() {
  try {
    const j = JSON.parse(fs.readFileSync(tokenFilePath(), 'utf8'));
    const token = String((j && j.token) || '').trim();
    if (!token) return null;
    return { token, login: String(j.login || ''), savedAt: Number(j.savedAt) || 0 };
  } catch (err) {
    return null;
  }
}

function currentToken() {
  const now = Date.now();
  if (now - tokenMemo.at < TOKEN_MEMO_MS) return tokenMemo.value;
  const file = readTokenFile();
  let value = null;
  if (file) value = { token: file.token, source: 'file', login: file.login, savedAt: file.savedAt };
  else if (envToken()) value = { token: envToken(), source: 'env', login: '', savedAt: 0 };
  tokenMemo = { at: now, value };
  return value;
}

function ghHeaders(token) {
  const h = { 'user-agent': 'dsh-daily-push', accept: 'application/vnd.github+json' };
  const t = token === undefined ? currentToken() : token ? { token } : null;
  if (t) h.authorization = 'Bearer ' + t.token;
  return h;
}

/** 有没有配令牌直接决定搜索限流是 10 次/分（未登录）还是 30 次/分，前端要如实告诉用户。*/
function ghHasToken() {
  return !!currentToken();
}

function watchFilePath() {
  const home = process.env.DSH_HOME || process.env.DSH_PROFILE_DIR || '.';
  return path.join(home, 'cache', 'daily-push-watch.json');
}

function readWatchStore() {
  try {
    const j = JSON.parse(fs.readFileSync(watchFilePath(), 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch {
    /* 没有就算了 */
  }
  return {};
}

function writeWatchStore(v) {
  try {
    fs.mkdirSync(path.dirname(watchFilePath()), { recursive: true });
    fs.writeFileSync(watchFilePath(), JSON.stringify(v), 'utf8');
  } catch {
    /* 写不进去不影响本次返回 */
  }
}

/** 从 package.json 的 repository / homepage 里抠 owner/repo。*/
function repoOfMeta(meta) {
  const repo = meta && meta.repository;
  const raw = (repo && (repo.url || repo)) || meta.homepage || '';
  const m = String(raw).match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i);
  return m ? m[1] + '/' + m[2] : null;
}

/** 装了哪些第三方插件：只认 profile 直接声明依赖的那些（node_modules 里还有两百个库）。*/
/** 链畾 profile 鐩綍锛氬厛鐪嬬幆澧冨彉閲忥紝鍐嶄粠 DSH_HOME/profiles 鎺㈡祴锛堟崲瀹夎浣嶇疆鍚?DSH_PROFILE_DIR 鍙兘涓嶅啀娉ㄥ叆锛夈€?*/
function resolveProfileDir() {
  const env = process.env.DSH_PROFILE_DIR || '';
  if (env && fs.existsSync(path.join(env, 'node_modules'))) return env;
  const home = process.env.DSH_HOME || '';
  if (home) {
    const base = path.join(home, 'profiles');
    for (const name of ['desktop', 'web']) {
      const d = path.join(base, name);
      if (fs.existsSync(path.join(d, 'node_modules'))) return d;
    }
    try {
      for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const d = path.join(base, ent.name);
        if (fs.existsSync(path.join(d, 'node_modules'))) return d;
      }
    } catch {
      /* 娌℃湁 profiles 鐩綍 */
    }
  }
  return env;
}

function profilePluginNames() {
  const dir = resolveProfileDir() || '';
  if (!dir) return null;
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const deps = Object.keys((pj && pj.dependencies) || {});
    if (deps.length) return deps.filter((n) => !n.startsWith('@deepseek-ai/'));
  } catch {
    /* 没有 package.json 就退回扫目录 */
  }
  return null;
}

function listInstalledPlugins() {
  const dir = resolveProfileDir() || '';
  if (!dir) return [];
  const nm = path.join(dir, 'node_modules');
  const out = [];
  const push = (pkgDir) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      if (!j || !j.name || !j.version) return;
      out.push({
        name: j.name,
        version: String(j.version),
        repo: repoOfMeta(j),
        desc: String(j.description || '').replace(/\s+/g, ' ').slice(0, 90),
      });
    } catch {
      /* 不是包 */
    }
  };
  try {
    for (const ent of fs.readdirSync(nm, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      if (ent.name.startsWith('@')) {
        try {
          for (const sub of fs.readdirSync(path.join(nm, ent.name))) push(path.join(nm, ent.name, sub));
        } catch {
          /* 跳过 */
        }
      } else {
        push(path.join(nm, ent.name));
      }
    }
  } catch {
    /* 读不到 node_modules */
  }
  const wanted = profilePluginNames();
  const keep = wanted ? out.filter((p) => wanted.indexOf(p.name) >= 0) : out.filter((p) => /^dsh-|^@[^/]+\/dsh-|-dsh-plugin$/i.test(p.name));
  return keep.filter((p) => !p.name.startsWith('@deepseek-ai/'));
}

async function getJsonQuiet(url) {
  try {
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) return { ok: false, status: res.status, headers: res.headers };
    return { ok: true, data: await res.json(), headers: res.headers };
  } catch (err) {
    return { ok: false, status: 0, error: String((err && err.message) || err) };
  }
}

/** 只比较点分数字，够用。*/
function versionCmp(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 拉一次现状：npm 最新版 + GitHub 仓库状态。*/
async function probeOne(p, ghCache, note) {
  const row = {
    name: p.name,
    version: p.version,
    repo: p.repo,
    desc: p.desc,
    latest: null,
    pushedAt: null,
    stars: null,
    archived: false,
    missing: false,
    htmlUrl: p.repo ? 'https://github.com/' + p.repo : null,
  };
  const npm = await getJsonQuiet('https://registry.npmjs.org/' + encodeURIComponent(p.name).replace('%2F', '/') + '/latest');
  if (npm.ok && npm.data && npm.data.version) row.latest = String(npm.data.version);
  if (p.repo) {
    const cached = ghCache[p.repo];
    if (cached && Date.now() - (cached.at || 0) < GH_TTL_MS) {
      row.pushedAt = cached.pushedAt || null;
      row.stars = cached.stars == null ? null : cached.stars;
      row.archived = !!cached.archived;
      row.missing = !!cached.missing;
      row.htmlUrl = cached.htmlUrl || row.htmlUrl;
    } else {
      const gh = await getJsonQuiet('https://api.github.com/repos/' + p.repo);
      if (gh.ok && gh.data) {
        row.pushedAt = gh.data.pushed_at || null;
        row.stars = typeof gh.data.stargazers_count === 'number' ? gh.data.stargazers_count : null;
        row.archived = !!gh.data.archived;
        row.htmlUrl = gh.data.html_url || row.htmlUrl;
        ghCache[p.repo] = { at: Date.now(), pushedAt: row.pushedAt, stars: row.stars, archived: row.archived, missing: false, htmlUrl: row.htmlUrl };
      } else if (gh.status === 404) {
        row.missing = true;
        ghCache[p.repo] = { at: Date.now(), pushedAt: null, stars: null, archived: false, missing: true, htmlUrl: row.htmlUrl };
      } else if (gh.status === 403 || gh.status === 429) {
        if (note) note.rateLimited = true;
      }
    }
  }
  return row;
}

function changesFor(cur, seen) {
  const out = [];
  if (!seen) return out;
  if (cur.latest && cur.latest !== cur.version && versionCmp(cur.latest, cur.version) > 0) {
    out.push({ kind: 'version', text: '有新版本 ' + cur.latest + '（当前 ' + cur.version + '）', at: null });
  }
  if (cur.pushedAt && seen.pushedAt && Date.parse(cur.pushedAt) > Date.parse(seen.pushedAt)) {
    out.push({ kind: 'commit', text: '仓库有新提交', at: cur.pushedAt });
  }
  if (!cur.archived && seen.archived) out.push({ kind: 'unarchived', text: '仓库恢复更新', at: null });
  if (cur.archived && !seen.archived) out.push({ kind: 'archived', text: '仓库已归档（作者停止维护）', at: null });
  if (cur.missing && !seen.missing) out.push({ kind: 'gone', text: '仓库查不到（可能删库或转私有）', at: null });
  if (cur.stars != null && seen.stars != null) {
    const d = cur.stars - seen.stars;
    if (d >= 50 || (d >= 10 && d >= seen.stars * 0.1)) out.push({ kind: 'stars', text: '星标 +' + d + '（' + seen.stars + ' → ' + cur.stars + '）', at: null });
  }
  return out;
}

/* ── 关注的仓库：可能是插件、skill，也可能是软件 / 普通项目 ── */

const KIND_PLUGIN = /dsh-plugin|dsh-skill|deepseek-harness/i;

/** 判断一个仓库属于哪一类：插件 / Skill / 软件 / 库 / 其他。*/
function classifyRepo(r) {
  const topics = (r.topics || []).join(' ').toLowerCase();
  const desc = String(r.desc || '').toLowerCase();
  const name = String(r.name || '').toLowerCase();
  const all = topics + ' ' + desc + ' ' + name;
  if (/dsh-plugin|dsh_plugin/.test(all) || /^dsh-/.test(name) || /(^|\/)dsh-/.test(name)) return '插件';
  if (/agent-skill|claude-skill|claude-code-skill|cursor-rules|\bskill\b/.test(all) || /-skill$/.test(name)) return 'Skill';
  if (/wallpaper-engine|live-wallpaper/.test(all)) return '壁纸';
  if (/desktop app|electron app|installer|\.exe|gui application|tray app/.test(desc)) return '软件';
  if (r.tag && /(^|\s)(app|desktop|gui|software|tool)(\s|$)/.test(topics)) return '软件';
  if (/library|framework|sdk|\bapi\b/.test(topics) || /library|framework|sdk/.test(desc)) return '库';
  if (r.tag) return '软件';
  return '其他';
}

/** 拉一个关注仓库的现状（仓库信息 + 最新 release）。*/
async function probeWatched(fullName, ghCache, note) {
  const row = {
    repo: fullName,
    name: fullName,
    title: fullName,
    desc: '',
    topics: [],
    laguage: null,
    language: null,
    pushedAt: null,
    stars: null,
    archived: false,
    missing: false,
    tag: null,
    tagsAt: null,
    htmlUrl: 'https://github.com/' + fullName,
    kind: '其他',
  };
  const cached = ghCache[fullName];
  let repoOk = false;
  if (cached && Date.now() - (cached.at || 0) < GH_TTL_MS) {
    row.title = cached.title || row.title;
    row.desc = cached.desc || '';
    row.topics = cached.topics || [];
    row.language = cached.language || null;
    row.pushedAt = cached.pushedAt || null;
    row.stars = cached.stars == null ? null : cached.stars;
    row.archived = !!cached.archived;
    row.missing = !!cached.missing;
    row.htmlUrl = cached.htmlUrl || row.htmlUrl;
    row.tag = cached.tag || null;
    repoOk = !cached.missing;
  } else {
    const gh = await getJsonQuiet('https://api.github.com/repos/' + fullName);
    if (gh.ok && gh.data) {
      const d = gh.data;
      row.title = d.full_name || row.title;
      row.desc = String(d.description || '').slice(0, 200);
      row.topics = Array.isArray(d.topics) ? d.topics : [];
      row.language = d.language || null;
      row.pushedAt = d.pushed_at || null;
      row.stars = typeof d.stargazers_count === 'number' ? d.stargazers_count : null;
      row.archived = !!d.archived;
      row.htmlUrl = d.html_url || row.htmlUrl;
      repoOk = true;
    } else if (gh.status === 404) {
      row.missing = true;
    } else if (gh.status === 403 || gh.status === 429) {
      if (note) note.rateLimited = true;
    }
  }
  if (repoOk) {
    const rel = ghCache['rel:' + fullName];
    if (rel && Date.now() - (rel.at || 0) < GH_TTL_MS) {
      row.tag = rel.tag;
      row.tagsAt = rel.tagsAt;
    } else {
      const r1 = await getJsonQuiet('https://api.github.com/repos/' + fullName + '/releases/latest');
      if (r1.ok && r1.data) {
        row.tag = r1.data.tag_name || null;
        row.tagsAt = r1.data.published_at || null;
      }
      ghCache['rel:' + fullName] = { at: Date.now(), tag: row.tag, tagsAt: row.tagsAt };
    }
  }
  row.kind = row.missing ? '查不到' : classifyRepo(row);
  if (row.missing) return row;
  if (!cached || (cached.at || 0) < Date.now() - 0) {
    ghCache[fullName] = ghCache[fullName] || {};
    Object.assign(ghCache[fullName], {
      title: row.title, desc: row.desc, topics: row.topics, language: row.language,
      pushedAt: row.pushedAt, stars: row.stars, archived: row.archived,
      missing: false, htmlUrl: row.htmlUrl, tag: row.tag, at: Date.now(),
    });
  }
  return row;
}

/** 关注列表里每条的增量变化。*/
function watchedChanges(cur, old) {
  const out = [];
  if (!old) return out;
  if (cur.tag && cur.tag !== old.tag) out.push({ kind: 'release', text: '新 release ' + cur.tag + (old.tag ? '（上一个是 ' + old.tag + '）' : ''), at: cur.tagsAt });
  if (cur.pushedAt && old.pushedAt && Date.parse(cur.pushedAt) > Date.parse(old.pushedAt)) out.push({ kind: 'commit', text: '仓库有新提交', at: cur.pushedAt });
  if (cur.archived && !old.archived) out.push({ kind: 'archived', text: '仓库已归档（作者停止维护）', at: null });
  if (cur.missing && !old.missing) out.push({ kind: 'gone', text: '仓库查不到（可能删库或转私有）', at: null });
  if (cur.stars != null && old.stars != null) {
    const d = cur.stars - old.stars;
    if (d >= 50 || (d >= 10 && d >= old.stars * 0.1)) out.push({ kind: 'stars', text: '星标 +' + d + '（' + old.stars + ' → ' + cur.stars + '）', at: null });
  }
  return out;
}

/** POST /api/daily-consult.watch.edit  {action:'add'|'remove', repo:'owner/repo'} */
async function handleWatchEdit(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: '请求体不是 JSON' }, 400);
  }
  const action = body && body.action;
  const m = String((body && body.repo) || '').trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (!m) return jsonResponse({ ok: false, error: '请填 owner/repo 或 GitHub 链接' }, 400);
  const fullName = m[1] + '/' + m[2];
  const store = readWatchStore();
  const list = Array.isArray(store.watched) ? store.watched : [];
  if (action === 'add') {
    if (list.some((w) => String(w.repo).toLowerCase() === fullName.toLowerCase())) {
      return jsonResponse({ ok: true, already: true, watched: list });
    }
    if (list.length >= 30) return jsonResponse({ ok: false, error: '最多关注 30 个仓库' }, 400);
    list.push({ repo: fullName, addedAt: Date.now() });
    if (store.gh) delete store.gh[fullName];
    if (store.gh) delete store.gh['rel:' + fullName];
    store.watchedAt = 0;
  } else if (action === 'remove') {
    const next = list.filter((w) => String(w.repo).toLowerCase() !== fullName.toLowerCase());
    if (next.length === list.length) return jsonResponse({ ok: false, error: '不在关注列表里' }, 404);
    store.watched = next;
    if (store.watchedSeen) delete store.watchedSeen[fullName];
    store.watchedAt = 0;
    writeWatchStore(store);
    return jsonResponse({ ok: true, watched: next });
  } else {
    return jsonResponse({ ok: false, error: 'action 只能是 add 或 remove' }, 400);
  }
  store.watched = list;
  writeWatchStore(store);
  return jsonResponse({ ok: true, watched: list });
}
/** GET /api/daily-consult.watch[?ack=1&force=1] */
async function handleWatch(request) {
  let q = {};
  try {
    const u = new URL(request && request.url ? request.url : WATCH_PATH, 'http://127.0.0.1');
    q = { ack: u.searchParams.get('ack') === '1', force: u.searchParams.get('force') === '1' };
  } catch {
    /* 解析不了就按默认 */
  }

  const store = readWatchStore();
  const ghCache = store.gh && typeof store.gh === 'object' ? store.gh : {};
  const note = {};
  const fresh = store.current && Date.now() - (store.checkedAt || 0) < WATCH_TTL_MS;
  let current = fresh && !q.force ? store.current : null;
  let checkedAt = store.checkedAt || 0;

  if (!current) {
    const list = listInstalledPlugins();
    const rows = [];
    for (let i = 0; i < list.length; i += 6) {
      const batch = list.slice(i, i + 6);
      rows.push(...(await Promise.all(batch.map((p) => probeOne(p, ghCache, note)))));
    }
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const k of Object.keys(ghCache)) if ((ghCache[k].at || 0) < cutoff) delete ghCache[k];
    store.gh = ghCache;
    if (note.rateLimited) {
      store.rateLimitedAt = Date.now();
      store.rateLimited = true;
    } else {
      store.rateLimited = false;
    }
    current = {};
    for (const r of rows) current[r.name] = r;
    checkedAt = Date.now();
    store.current = current;
    store.checkedAt = checkedAt;
  }

  /* 关注的仓库（软件 / skill / 插件都行）*/
  const watchedList = Array.isArray(store.watched) ? store.watched : [];
  const freshW = store.watchedAt && Date.now() - store.watchedAt < WATCH_TTL_MS;
  let watched = freshW && !q.force && Array.isArray(store.watchedItems) ? store.watchedItems : null;
  if (!watched) {
    const rows = [];
    for (let i = 0; i < watchedList.length; i += 4) {
      const batch = watchedList.slice(i, i + 4);
      rows.push(...(await Promise.all(batch.map((w) => probeWatched(w.repo, ghCache, note)))));
    }
    watched = rows.filter((r) => r && r.repo);
    store.watchedItems = watched;
    store.watchedAt = Date.now();
  }
  const cutoffW = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const k of Object.keys(ghCache)) if ((ghCache[k].at || 0) < cutoffW) delete ghCache[k];
  store.gh = ghCache;
  if (note.rateLimited) {
    store.rateLimitedAt = Date.now();
    store.rateLimited = true;
  } else if (note.rateLimited === undefined && !store.rateLimitedAt) {
    store.rateLimited = false;
  }

  const seen = store.seen || null;
  const baseline = !seen;
  let changes = [];
  if (baseline) {
    store.seen = current;
  } else {
    for (const name of Object.keys(current)) {
      const cur = current[name];
      const old = seen[name];
      const list = changesFor(cur, old);
      if (!old && cur.version) list.push({ kind: 'new', text: '新装（基线之后才有）', at: null });
      for (const c of list) changes.push(Object.assign({ name, repo: cur.repo, version: cur.version, latest: cur.latest, desc: cur.desc || null }, c));
    }
    if (q.ack) store.seen = current;
  }

  /* 关注项的变化 */
  const wseen = store.watchedSeen || null;
  if (!wseen) {
    store.watchedSeen = {};
    for (const r of watched) store.watchedSeen[r.repo] = r;
  } else {
    for (const r of watched) {
      const old = wseen[r.repo];
      const list2 = watchedChanges(r, old);
      if (!old) list2.push({ kind: 'new', text: '新加入关注', at: null });
      for (const c of list2) changes.push(Object.assign({ name: r.repo, watched: true, repo: r.repo, kindLabel: r.kind, desc: r.desc || null }, c));
    }
    if (q.ack) {
      for (const r of watched) store.watchedSeen[r.repo] = r;
    }
  }
  writeWatchStore(store);

  const items = Object.keys(current)
    .map((k) => current[k])
    .sort((a, b) => {
      const ca = changes.some((c) => c.name === a.name) ? 1 : 0;
      const cb = changes.some((c) => c.name === b.name) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return String(a.name).localeCompare(String(b.name));
    });

  return jsonResponse({
    ok: true,
    rateLimited: !!store.rateLimited,
    hasToken: !!(process.env.GITHUB_TOKEN || process.env.DSH_GITHUB_TOKEN || process.env.GH_TOKEN),
    profileDir: resolveProfileDir() || '',
    checkedAt,
    ttlMs: WATCH_TTL_MS,
    baseline,
    changes,
    items,
    watched,
  });
}

/**
 * 注册咨询端点。宿主侧只依赖 connection（HTTP 路由）与 llm（模型流式调用）。
 * @param ctx 插件上下文
 */
/** 实时从 GitHub 搜「近 N 天有 push 的 dsh 插件」。浏览器直接打 api.github.com 会被页面策略拦，
 * 所以由宿主代取，顺便做 10 分钟缓存，失败时把上一次成功的结果原样还回去。*/
const RECENT_DAYS = 7;
const NEW_DAYS = 30;
const RECENT_TTL_MS = 10 * 60 * 1000;
let recentCache = { at: 0, payload: null };

function memLog(tag, extra) {
  try {
    const dir = __joinLog(process.env.DSH_HOME || __joinLog(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'logs');
    __mkdirLog(dir, { recursive: true });
    const m = process.memoryUsage();
    const line = new Date().toISOString() + ' ' + tag +
      ' rss=' + Math.round(m.rss / 1048576) + 'MB' +
      ' heap=' + Math.round(m.heapUsed / 1048576) + 'MB' +
      ' ext=' + Math.round(m.external / 1048576) + 'MB' +
      (extra ? ' ' + extra : '') + '\n';
    __appendLog(__joinLog(dir, 'daily-push-mem.log'), line);
  } catch (err) {
    /* 记日志失败不影响功能 */
  }
}

/* ─────────────────── 全站搜索：把中文关键词翻成 GitHub 查询 ─────────────────── */

/* 关键词由前端按词表扩展好再传过来（terms），宿主只负责拼查询和缓存。
   为什么不在这里扩词：词表在 client.js 里，宿主不重复维护一份。*/
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 60;
const searchCache = new Map();

/** 只留能进 GitHub 查询的英文词，最多 3 个。
 *  两个实测结论：① GitHub 不认括号分组，`(a OR b) topic:x` 会被拆开，所以不加括号；
 *  ② OR 的词越多越不准——6 个词时"书"的搜索结果会被 mobile 插件占满，3 个词时全是书。*/
function buildSearchQuery(terms) {
  const picked = [];
  for (const t of terms || []) {
    const w = String(t || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9+.#-]{1,24}$/.test(w)) continue;
    if (picked.indexOf(w) >= 0) continue;
    picked.push(w);
    if (picked.length >= 3) break;
  }
  if (!picked.length) return '';
  return picked.join(' OR ') + ' topic:dsh-plugin fork:false';
}

function searchCacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  /* 命中就挪到队尾，天然按最近使用淘汰 */
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit;
}

function searchCachePut(key, payload) {
  searchCache.set(key, { at: Date.now(), payload });
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
}

async function handleSearch(request) {
  let u;
  try {
    u = new URL(request.url, 'http://local');
  } catch (err) {
    return jsonResponse({ ok: false, error: 'bad_url' }, 400);
  }
  const rawQ = String(u.searchParams.get('q') || '').trim().slice(0, 80);
  const terms = String(u.searchParams.get('terms') || '')
    .slice(0, 400)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const q = buildSearchQuery(terms);
  if (!q) return jsonResponse({ ok: false, error: 'no_terms', q: '' });

  const key = rawQ.toLowerCase() + '|' + q;
  const cached = searchCacheGet(key);
  if (cached) return jsonResponse(Object.assign({}, cached.payload, { cached: true, ok: true }));

  memLog('search ' + q);
  const url =
    'https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&per_page=30';
  let res;
  try {
    res = await fetch(url, { headers: ghHeaders() });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'network', detail: String((err && err.message) || err) });
  }
  const remain = parseInt(res.headers.get('x-ratelimit-remaining') || '', 10);
  const reset = parseInt(res.headers.get('x-ratelimit-reset') || '', 10);
  const rate = {
    remaining: Number.isFinite(remain) ? remain : null,
    resetAt: Number.isFinite(reset) ? reset * 1000 : null,
    hasToken: ghHasToken(),
  };
  if (!res.ok) {
    const why = res.status === 403 || res.status === 429 ? 'rate_limited' : 'http_' + res.status;
    return jsonResponse({ ok: false, error: why, rate, q });
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: 'bad_json', rate, q });
  }
  const items = (data.items || []).map((it) => ({
    fullName: it.full_name,
    url: it.html_url,
    description: it.description || '',
    stars: it.stargazers_count || 0,
    pushedAt: it.pushed_at || null,
    createdAt: it.created_at || null,
    topics: it.topics || [],
    language: it.language || '',
    archived: !!it.archived,
    fork: !!it.fork,
  }));
  const payload = {
    ok: true,
    q,
    total: data.total_count || items.length,
    items,
    rate,
    fetchedAt: Date.now(),
  };
  searchCachePut(key, payload);
  return jsonResponse(payload);
}

/* ─────────────────── npm 侧：只发了 npm 包的插件 ─────────────────── */

/* npm 的搜索是模糊的：text=keywords:dsh-plugin 会把描述里出现 dsh 的包也塞进来，
   所以拿回来之后还要按 keywords 再筛一遍，只留真打了标签的包。 */
const NPM_TTL_MS = 10 * 60 * 1000;
const NPM_CACHE_MAX = 12;
const npmCache = new Map();

/** 一个包算不算 DSH 插件：打了 dsh-plugin 标签，或者名字就是 dsh-xxx / @scope/dsh-xxx。 */
function isNpmPlugin(p) {
  const tags = (p && p.keywords ? p.keywords : []).map((k) => String(k).toLowerCase());
  if (tags.indexOf('dsh-plugin') >= 0) return true;
  if (tags.indexOf('deepseek-harness') >= 0) return true;
  const name = String((p && p.name) || '');
  return /^(?:@[^/]+\/)?dsh(?:[-.]|$)/i.test(name);
}

/** npm 的字段名跟 GitHub 不一样，这里统一成前端列表认的那一套；
 *  stars 留 null，因为 npm 没有星数——前端看到 null 就不显示星。 */
function npmRow(o) {
  const p = (o && o.package) || {};
  const links = p.links || {};
  const detail = (o && o.score && o.score.detail) || {};
  const name = String(p.name || '');
  if (!name) return null;
  const npmUrl = links.npm || 'https://www.npmjs.com/package/' + name;
  /* 列表行用 owner/repo 当主键（「我关注的」也按这个存），没有仓库链接的才退回包名。
     npm 的 repo 地址常带 git+ 前缀和 .git 尾巴，这里先洗干净再取 owner/repo。 */
  const repoRaw = String(links.repository || '').replace(/^git\+/i, '').replace(/\.git$/i, '');
  const repoMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i.exec(repoRaw);
  const repoPath = repoMatch ? repoMatch[1] + '/' + repoMatch[2] : '';
  return {
    fullName: repoPath || name,
    displayName: name,
    name,
    url: links.repository || npmUrl,
    repoUrl: links.repository || '',
    npmUrl,
    description: p.description || '',
    version: p.version || '',
    date: p.date || '',
    createdAt: p.date || '',
    pushedAt: p.date || '',
    stars: null,
    source: 'npm',
    relevance: Number((o && o.score && o.score.final) || 0),
    downloads: 0,
    score: {
      popularity: Number(detail.popularity) || 0,
      quality: Number(detail.quality) || 0,
      maintenance: Number(detail.maintenance) || 0,
    },
  };
}

/* 下载量变化很慢，但接口会 429（Cloudflare 1015 限流）。
   所以：内存缓存 10 分钟 → 磁盘缓存 6 小时 → 真去请求；请求失败就用旧的，绝不因为下载量把页面搞挂。 */
const DL_TTL_MS = 6 * 60 * 60 * 1000;
const dlCachePath = path.join(
  process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'),
  'cache',
  'daily-push-npm-downloads.json',
);
let dlDisk = null;

function readDlDisk() {
  if (dlDisk) return dlDisk;
  try {
    const raw = JSON.parse(fs.readFileSync(dlCachePath, 'utf8'));
    dlDisk = raw && raw.map && typeof raw.map === 'object' ? raw : { at: 0, map: {} };
  } catch (err) {
    dlDisk = { at: 0, map: {} };
  }
  return dlDisk;
}

function writeDlDisk(data) {
  try {
    fs.mkdirSync(path.dirname(dlCachePath), { recursive: true });
    fs.writeFileSync(dlCachePath, JSON.stringify(data));
  } catch (err) {
    /* 写不进去就算了，下次重新取 */
  }
}

async function fetchDownloads(names) {
  const out = Object.create(null);
  const disk = readDlDisk();
  const fresh = Date.now() - disk.at < DL_TTL_MS;
  const want = [];
  for (const n of names) {
    if (fresh && typeof disk.map[n] === 'number') out[n] = disk.map[n];
    else want.push(n);
  }
  if (!want.length) return out;

  const plain = want.filter((n) => String(n).charAt(0) !== '@');
  const scoped = want.filter((n) => String(n).charAt(0) === '@').slice(0, 40);
  let got = 0;

  const one = async (url) => {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  };

  for (let i = 0; i < plain.length; i += 128) {
    const chunk = plain.slice(i, i + 128);
    const data = await one('https://api.npmjs.org/downloads/point/last-week/' + chunk.map((n) => encodeURIComponent(n)).join(','));
    for (const k of Object.keys(data || {})) {
      out[k] = Number((data[k] && data[k].downloads) || 0) || 0;
      got++;
    }
  }

  /* 带 scope 的包只能一个个问，串行 40 个要十几秒，所以开 4 路并发（8 路更容易被限流）。 */
  let cursor = 0;
  const take = async () => {
    while (cursor < scoped.length) {
      const name = scoped[cursor++];
      const data = await one('https://api.npmjs.org/downloads/point/last-week/' + encodeURIComponent(name));
      if (data) {
        out[name] = Number((data && data.downloads) || 0) || 0;
        got++;
      }
    }
  };
  await Promise.all(new Array(Math.min(4, scoped.length)).fill(0).map(take));

  if (got) {
    const merged = Object.assign({}, readDlDisk().map, out);
    dlDisk = { at: Date.now(), map: merged };
    writeDlDisk(dlDisk);
  }

  /* 这次没取到的，用磁盘里的旧值兜底（可能过期，但比显示 0 好） */
  for (const n of names) if (typeof out[n] !== 'number' && typeof disk.map[n] === 'number') out[n] = disk.map[n];
  return out;
}

/* 先画后补：搜索一回来就把 243 条交给前端（约 2 秒），下载量随后再补。
   一次给 243 个包取下载量要 6~7 秒（带 scope 的包只能一个个问），所以分两步：
   - 不带 dl：只套用磁盘缓存里已存的值，绝不发请求 → 秒回
   - 带 dl=1：只给"三列可能用到"的那批取（按日期、相关度各取前 60，去重后上限 120）
   代价是第一次打开时「最常被用」那一列会先按相关度排，一两秒后跳到按下载量排。 */
function dlTargets(items, cap) {
  const byDate = items.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const byRel = items.slice().sort((a, b) => Number(b.relevance || 0) - Number(a.relevance || 0));
  const out = [];
  const seen = Object.create(null);
  const half = Math.ceil(cap / 2);
  const push = (r) => {
    if (!r || out.length >= cap || seen[r.name]) return;
    seen[r.name] = 1;
    out.push(r.name);
  };
  for (const r of byDate.slice(0, half)) push(r);
  for (const r of byRel) push(r);
  return out;
}

function applyDiskDownloads(items) {
  const disk = readDlDisk();
  let missing = 0;
  for (const r of items) {
    const v = disk.map[r.name];
    if (typeof v === 'number') r.downloads = v;
    else if (!r.downloads) missing++;
  }
  return missing;
}

async function handleNpm(request) {
  let u;
  try {
    u = new URL(request.url, 'http://local');
  } catch (err) {
    return jsonResponse({ ok: false, error: 'bad_url' }, 400);
  }
  const q = String(u.searchParams.get('q') || '').trim().slice(0, 60).toLowerCase();
  const wantDl = u.searchParams.get('dl') === '1';
  const key = q || '*';
  const hit = npmCache.get(key);
  const fresh = hit && Date.now() - hit.at < NPM_TTL_MS;
  if (fresh) {
    npmCache.delete(key);
    npmCache.set(key, hit);
    if (!wantDl || hit.payload.dlDone) {
      return jsonResponse(Object.assign({}, hit.payload, { cached: true, ok: true }));
    }
    return finishNpm(hit.payload, true);
  }

  const text = q ? q + ' keywords:dsh-plugin' : 'keywords:dsh-plugin';
  const url = 'https://registry.npmjs.org/-/v1/search?text=' + encodeURIComponent(text) + '&size=250';
  memLog('npm ' + text);
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'network', detail: String((err && err.message) || err) });
  }
  if (!res.ok) return jsonResponse({ ok: false, error: 'http_' + res.status });
  let data;
  try {
    data = await res.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: 'bad_json' });
  }

  const seen = Object.create(null);
  const items = [];
  for (const o of data.objects || []) {
    const p = (o && o.package) || {};
    if (!isNpmPlugin(p)) continue;
    const row = npmRow(o);
    if (!row || seen[row.fullName]) continue;
    seen[row.fullName] = 1;
    items.push(row);
  }
  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const payload = {
    ok: true,
    source: 'npm',
    q,
    items,
    total: items.length,
    fetchedAt: Date.now(),
    enriched: applyDiskDownloads(items) === 0,
    dlDone: false,
  };
  npmCache.set(key, { at: Date.now(), payload });
  while (npmCache.size > NPM_CACHE_MAX) npmCache.delete(npmCache.keys().next().value);
  return wantDl ? finishNpm(payload) : jsonResponse(payload);
}

/* 第二步：真去取下载量（只取 dlTargets 挑出来的那批），取完把结果写回同一份 payload。
   dlDone 表示"这一轮补全做过了"，避免前端每次挂载都再触发一次 5 秒的请求。 */
async function finishNpm(payload) {
  if (payload.dlDone) return jsonResponse(payload);
  const map = await fetchDownloads(dlTargets(payload.items, 80));
  for (const r of payload.items) {
    if (typeof map[r.name] === 'number') r.downloads = map[r.name];
  }
  payload.enriched = applyDiskDownloads(payload.items) === 0;
  payload.dlDone = true;
  payload.dlCount = payload.items.filter((r) => Number(r.downloads) > 0).length;
  payload.downloadsAt = Date.now();
  return jsonResponse(payload);
}

/* ── GitHub 星数采样 ──
   ∩ 屏要拿"GitHub 上有、npm 上也有"对照，得先有一份按星排的 GitHub 名单。
   搜索接口单查询最多给 1000 条（10 页），这里默认取 3 页 = 300 条，6 小时缓存。 */
const GH_TOP_TTL_MS = 6 * 60 * 60 * 1000;
let ghTopCache = { at: 0, pages: 0, items: [] };

async function handleGhTop(request) {
  let u;
  try {
    u = new URL(request.url, 'http://local');
  } catch (err) {
    return jsonResponse({ ok: false, error: 'bad_request' });
  }
  const want = Math.max(1, Math.min(5, Number(u.searchParams.get('pages')) || 3));
  const now = Date.now();
  if (ghTopCache.items.length && ghTopCache.pages >= want && now - ghTopCache.at < GH_TOP_TTL_MS) {
    return jsonResponse({
      ok: true,
      items: ghTopCache.items,
      total: ghTopCache.items.length,
      pages: ghTopCache.pages,
      cached: true,
    });
  }

  const seen = Object.create(null);
  const items = [];
  let err = null;
  for (let p = 1; p <= want; p += 1) {
    const url =
      'https://api.github.com/search/repositories?q=' +
      encodeURIComponent('topic:dsh-plugin fork:false') +
      '&sort=stars&order=desc&per_page=100&page=' + p;
    const rr = await getJsonQuiet(url);
    if (!rr.ok) {
      err = rr.status || rr.error || 'fail';
      break;
    }
    const batch = (rr.data && rr.data.items) || [];
    for (const it of batch) {
      if (!it || !it.full_name || seen[it.full_name]) continue;
      seen[it.full_name] = 1;
      items.push({
        fullName: it.full_name,
        url: it.html_url,
        description: it.description || '',
        stars: it.stargazers_count || 0,
        pushedAt: it.pushed_at,
        createdAt: it.created_at,
        topics: it.topics || [],
        language: it.language || '',
      });
    }
    if (batch.length < 100) break;
  }

  if (!items.length) return jsonResponse({ ok: false, items: [], error: err || 'fail', hasToken: ghHasToken() });
  if (!err) ghTopCache = { at: now, pages: want, items };
  return jsonResponse({
    ok: true,
    items,
    total: items.length,
    pages: want,
    degraded: !!err,
    error: err,
    hasToken: ghHasToken(),
    fetchedAt: now,
  });
}

async function handleRecent() {
  const now = Date.now();
  if (recentCache.payload && now - recentCache.at < RECENT_TTL_MS) {
    return jsonResponse(Object.assign({}, recentCache.payload, { cached: true }));
  }
  memLog('recent');
  const since = new Date(now - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const sinceNew = new Date(now - NEW_DAYS * 86400000).toISOString().slice(0, 10);
  const search = async (q, sort, per) => {
    const u =
      'https://api.github.com/search/repositories?q=' +
      encodeURIComponent(q) + '&sort=' + sort + '&order=desc&per_page=' + per;
    const rr = await getJsonQuiet(u);
    return rr.ok ? { items: rr.data.items || [] } : { items: [], error: rr.status || rr.error || 'fail' };
  };
  /* 两个来源：还在更新的 + 最近新建的。合并去重后交给前端按权重排序。*/
  /* 三个来源：还在更新的 / 最近新建的 / 按星数排的（星数榜与其他项目都取自第三个）。
     另外单拉一次官方 org，官方仓库只出现在顶部条，不进任何榜。*/
  const [resA, resB, resC, orgRes] = await Promise.all([
    search('topic:dsh-plugin pushed:>=' + since, 'updated', 40),
    search('topic:dsh-plugin created:>=' + sinceNew, 'stars', 40),
    search('topic:dsh-plugin', 'stars', 40),
    getJsonQuiet('https://api.github.com/orgs/deepseek-ai/repos?per_page=100&sort=updated'),
  ]);
  if (!resA.items.length && !resB.items.length) {
    const why = resA.error || resB.error || 'fail';
    if (recentCache.payload) {
      return jsonResponse(Object.assign({}, recentCache.payload, { cached: true, stale: true, error: why }));
    }
    return jsonResponse({ ok: false, items: [], error: why, since, sinceNew, fetchedAt: now });
  }
  const pick = (it) => ({
    full_name: it.full_name,
    html_url: it.html_url,
    description: it.description || "",
    stargazers_count: it.stargazers_count || 0,
    pushed_at: it.pushed_at,
    created_at: it.created_at,
    topics: it.topics || [],
    language: it.language || "",
    archived: !!it.archived,
    fork: !!it.fork,
  });
  const merged = new Map();
  const add = (it, src) => {
    const prev = merged.get(it.full_name);
    const row = pick(it);
    row.sources = prev ? Array.from(new Set(prev.sources.concat(src))) : [src];
    merged.set(it.full_name, row);
  };
  for (const it of resA.items) add(it, 'active');
  for (const it of resB.items) add(it, 'new');
  const items = Array.from(merged.values());
  const leaders = (resC.items || []).map(pick);
  const orgList = orgRes && orgRes.ok && Array.isArray(orgRes.data) ? orgRes.data : [];
  const official = orgList
    .filter((it) => /dsh|harness/i.test(String(it.name || '') + ' ' + String(it.description || '')))
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
    .slice(0, 8)
    .map(pick);
  const payload = { ok: true, items, leaders, official, total: items.length, since, sinceNew, fetchedAt: now };
  recentCache = { at: now, payload };
  return jsonResponse(payload);
}

/* ─────────────────── 令牌：存在宿主，前端只看得到「配没配」 ───────────────────
   0.1.x 把令牌放在进程环境变量里，用户得改启动脚本才能配；0.2.0 改成在面板 ⚙ 里填，
   宿主写进 DSH_HOME/daily-push-token.json（600 权限）。前端拿到的只有：
   configured / 来源 / 登录名 / 尾号 4 位 / 剩余额度——原文永不出宿主。 */

const TOKEN_PATH = '/api/daily-consult.token';

/** 探一次额度：/rate_limit 对任何令牌都免费，不计入额度，正好拿来当校验。
 *  带令牌时顺便问一次 /user 拿登录名（失败不影响校验结果）。 */
async function probeToken(token) {
  const headers = ghHeaders(token || '');
  const out = { ok: false, login: '', search: null, core: null, error: null, detail: null };
  try {
    const res = await fetch('https://api.github.com/rate_limit', { headers });
    if (res.status === 401) {
      out.error = 'bad_token';
      return out;
    }
    if (!res.ok) {
      out.error = 'http_' + res.status;
      return out;
    }
    const j = await res.json();
    const r = (j && j.resources) || {};
    const pick = (x) => ({
      limit: Number((x && x.limit) || 0) || 0,
      remaining: Number((x && x.remaining) || 0) || 0,
      resetAt: Number((x && x.reset) || 0) * 1000,
    });
    out.search = pick(r.search);
    out.core = pick(r.core);
    out.ok = true;
    if (token) {
      try {
        const who = await fetch('https://api.github.com/user', { headers });
        if (who.ok) {
          const uj = await who.json();
          out.login = String((uj && uj.login) || '');
        }
      } catch (err) {
        /* 拿不到登录名不影响令牌可用 */
      }
    }
  } catch (err) {
    out.error = 'network';
    out.detail = String((err && err.message) || err);
  }
  return out;
}

function writeTokenFile(token, login) {
  const file = tokenFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ token, login: login || '', savedAt: Date.now() });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    /* Windows 上 chmod 基本是空操作，写失败也不影响功能 */
  }
  tokenMemo = { at: 0, value: null };
}

function clearTokenFile() {
  try {
    fs.rmSync(tokenFilePath(), { force: true });
  } catch (err) {
    /* 本来就没有 */
  }
  tokenMemo = { at: 0, value: null };
}

function tokenState(extra) {
  const t = currentToken();
  return Object.assign(
    {
      ok: true,
      configured: !!t,
      source: t ? t.source : null,
      login: t ? t.login : '',
      /* 尾号 4 位足够让用户确认「填的是哪一个」，又不至于泄露 */
      hint: t ? '…' + t.token.slice(-4) : '',
      savedAt: t ? t.savedAt : 0,
      env: !!envToken(),
    },
    extra || {},
  );
}

async function handleToken(request) {
  const method = String((request && request.method) || 'GET').toUpperCase();
  if (method === 'GET') {
    let u;
    try {
      u = new URL(request.url, 'http://local');
    } catch (err) {
      u = null;
    }
    const wantRate = !!(u && u.searchParams.get('rate') === '1');
    const extra = {};
    if (wantRate) {
      const t = currentToken();
      extra.rate = await probeToken(t ? t.token : '');
      extra.hasToken = !!t;
    }
    return jsonResponse(tokenState(extra));
  }

  if (method === 'DELETE') {
    clearTokenFile();
    return jsonResponse(tokenState({ cleared: true }));
  }

  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    body = {};
  }
  const action = String((body && body.action) || 'save');
  const raw = String((body && body.token) || '').trim();
  const t = currentToken();

  if (action === 'clear') {
    clearTokenFile();
    return jsonResponse(tokenState({ cleared: true }));
  }

  if (action === 'test') {
    const use = raw || (t ? t.token : '');
    if (!use) return jsonResponse(tokenState({ ok: false, error: 'no_token' }), 400);
    const probe = await probeToken(use);
    return jsonResponse(tokenState({ test: probe, error: probe.error }));
  }

  /* save */
  if (!raw) return jsonResponse({ ok: false, error: 'no_token' }, 400);
  /* classic PAT 是 ghp_xxx（40 位），fine-grained 是 github_pat_xxx（含下划线），都命中这个形状；
     明显不是令牌的输入在这里就挡掉，省一次网络往返。 */
  if (!/^[A-Za-z0-9_]{20,}$/.test(raw)) {
    return jsonResponse({ ok: false, error: 'bad_format' }, 400);
  }
  const probe = await probeToken(raw);
  if (!probe.ok) {
    return jsonResponse(
      Object.assign({ ok: false, saved: false, error: probe.error || 'invalid' }, { detail: probe.detail }),
      400,
    );
  }
  writeTokenFile(raw, probe.login);
  return jsonResponse(tokenState({ saved: true, probe }));
}

/* ─────────────────── 全量数据：GitHub 1000 + npm 2499，一屏对照 ───────────────────
   0.1.x 只有 GitHub 300 条 + npm 250 条的抽样；0.2.0 要「按 owner/repo 归一、一屏并列两源」，
   就得先把两边都翻到底：GitHub 搜索单查询上限 1000 条（10 页 ×100），
   npm 搜索上限 2500 条（第 11 页就空了）。
   数据变化很慢，缓存 6 小时落在磁盘上，重启不白抓；失败/不完整时 10 分钟后再试。 */

const ALL_PATH = '/api/daily-consult.all';
const ALL_DL_PATH = '/api/daily-consult.all.dl';
const ALL_TTL_MS = 6 * 60 * 60 * 1000;
const ALL_RETRY_MS = 10 * 60 * 1000;
/** 未登录时 GitHub 搜索只有 10 次/分、60 次/时，抓满 20 页会直接把自己锁死，
 *  所以没有令牌就只翻 4 页（400 条）+ 3 页（300 条），有令牌才翻到底。 */
const ALL_GH_PAGES_TOKEN = 10;
const ALL_GH_PAGES_ANON = 4;
const ALL_GH_UPD_PAGES_TOKEN = 10;
const ALL_GH_UPD_PAGES_ANON = 3;
const ALL_NPM_PAGES = 10;
const ALL_NPM_SIZE = 250;
const ALL_DL_CAP = 700;
const ALL_QUERY = 'topic:dsh-plugin fork:false';

let allBody = { at: 0, body: '' };

function allCachePath() {
  return path.join(dataHome(), 'cache', 'daily-push-all.json');
}

let allDisk = null;

function readAllDisk() {
  if (allDisk) return allDisk;
  try {
    const j = JSON.parse(fs.readFileSync(allCachePath(), 'utf8'));
    allDisk = j && typeof j === 'object' ? j : { v: 2, github: null, npm: null };
  } catch (err) {
    allDisk = { v: 2, github: null, npm: null };
  }
  return allDisk;
}

function writeAllDisk() {
  try {
    const file = allCachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(allDisk));
    fs.renameSync(tmp, file);
    allBody = { at: 0, body: '' };
  } catch (err) {
    /* 写不进去不影响这次返回 */
  }
}

function needRefresh(entry, now, force) {
  if (force) return true;
  if (!entry || !Array.isArray(entry.items) || !entry.items.length) return true;
  const ttl = entry.ok === false ? ALL_RETRY_MS : ALL_TTL_MS;
  const seen = Number(entry.checkedAt || entry.at) || 0;
  return now - seen > ttl;
}

function ghItem(it) {
  const full = String((it && it.full_name) || '');
  if (!full) return null;
  return {
    fullName: full,
    url: it.html_url || 'https://github.com/' + full,
    /* 描述只留前 180 字：1000 条 × 长描述会把这份 JSON 撑到几 MB */
    description: String(it.description || '').slice(0, 180),
    stars: Number(it.stargazers_count) || 0,
    pushedAt: it.pushed_at || '',
    createdAt: it.created_at || '',
    topics: Array.isArray(it.topics) ? it.topics.slice(0, 5) : [],
    language: it.language || '',
    source: 'gh',
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 翻一列搜索结果，边翻边往共享的 items/seen 里塞（两条查询好互相去重）。
 *  GitHub 未登录时搜索只有 10 次/分，而且对并发非常敏感——两个搜索请求同时发出去会直接吃
 *  二级限流（403，但 x-ratelimit-remaining 还大于 0），所以这里串行 + 留间隔。
 *  真被限流就带着已经拿到的条目回去（partial），列不清空，10 分钟后自动再试。 */
async function searchPages(query, sort, pages, seen, items, hasToken) {
  let error = null;
  let remoteTotal = 0;
  let resetAt = 0;
  let remaining = null;
  let page = 0;
  const gap = hasToken ? 350 : 1200;
  for (let i = 1; i <= pages; i++) {
    if (i > 1) await sleep(gap);
    page = i;
    const url =
      'https://api.github.com/search/repositories?q=' +
      encodeURIComponent(query) +
      '&sort=' + sort + '&order=desc&per_page=100&page=' + i;
    let res = await getJsonQuiet(url);
    /* 二级限流是一次性的，等一下再来通常就通了；额度真的用光（remaining=0）就别白撞。 */
    if (!res.ok && (res.status === 403 || res.status === 429) && remaining !== 0) {
      await sleep(2500);
      res = await getJsonQuiet(url);
    }
    if (!res.ok) {
      const h = res.headers;
      if (h && typeof h.get === 'function') {
        const rem = Number(h.get('x-ratelimit-remaining'));
        if (Number.isFinite(rem)) remaining = rem;
        const rst = Number(h.get('x-ratelimit-reset'));
        if (rst) resetAt = rst * 1000;
      }
      error = res.status === 403 || res.status === 429 ? 'rate_limited' : res.status ? 'http_' + res.status : res.error || 'network';
      break;
    }
    const rh = res.headers;
    if (rh && typeof rh.get === 'function') {
      const rem = Number(rh.get('x-ratelimit-remaining'));
      if (Number.isFinite(rem)) remaining = rem;
      const rst = Number(rh.get('x-ratelimit-reset'));
      if (rst) resetAt = rst * 1000;
    }
    const data = res.data || {};
    if (i === 1) remoteTotal = Number(data.total_count) || 0;
    const list = data.items || [];
    for (const it of list) {
      const row = ghItem(it);
      if (!row || seen[row.fullName]) continue;
      seen[row.fullName] = 1;
      items.push(row);
    }
    if (list.length < 100) break;
  }
  return { error, remoteTotal, resetAt, remaining, page };
}

async function refreshGithub() {
  const hasToken = ghHasToken();
  const seen = Object.create(null);
  const items = [];
  let error = null;
  let remoteTotal = 0;
  let resetAt = 0;
  let remaining = null;
  let pages = 0;
  /* 两条查询串行：星数榜回答「谁最热」，最近更新榜回答「谁还在动」。
     第一条被限流的话第二条也没有额度，直接停，别把 10 次/分耗在注定 403 的请求上。 */
  const runs = [
    { sort: 'stars', pages: hasToken ? ALL_GH_PAGES_TOKEN : ALL_GH_PAGES_ANON },
    { sort: 'updated', pages: hasToken ? ALL_GH_UPD_PAGES_TOKEN : ALL_GH_UPD_PAGES_ANON },
  ];
  for (const run of runs) {
    const r = await searchPages(ALL_QUERY, run.sort, run.pages, seen, items, hasToken);
    pages += r.page;
    if (r.remoteTotal) remoteTotal = Math.max(remoteTotal, r.remoteTotal);
    if (r.resetAt) resetAt = r.resetAt;
    if (r.remaining !== null) remaining = r.remaining;
    if (r.error) {
      error = r.error;
      if (r.error === 'rate_limited') break;
    }
  }
  return {
    items,
    error,
    partial: !!(error && items.length),
    remoteTotal,
    pages,
    resetAt,
    remaining,
    hasToken,
  };
}

/** 进度条用的全量 npm 行：去掉恒等于 1 的 score.detail，只留前端要显示的字段。 */
function compactNpmRow(o) {
  const p = (o && o.package) || {};
  const links = p.links || {};
  const name = String(p.name || '');
  if (!name) return null;
  const repoRaw = String(links.repository || '').replace(/^git\+/i, '').replace(/\.git$/i, '');
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i.exec(repoRaw);
  return {
    fullName: m ? m[1] + '/' + m[2] : name,
    name,
    displayName: name,
    description: String(p.description || '').slice(0, 180),
    version: String(p.version || ''),
    date: String(p.date || ''),
    npmUrl: links.npm || 'https://www.npmjs.com/package/' + name,
    repoUrl: links.repository || '',
    relevance: Number((o && o.score && o.score.final) || 0) || 0,
    source: 'npm',
  };
}

async function refreshNpm() {
  const items = [];
  const seen = Object.create(null);
  let pages = 0;
  let error = null;
  let total = 0;
  for (let i = 0; i < ALL_NPM_PAGES; i++) {
    const url =
      'https://registry.npmjs.org/-/v1/search?text=' +
      encodeURIComponent('keywords:dsh-plugin') +
      '&size=' + ALL_NPM_SIZE + '&from=' + i * ALL_NPM_SIZE;
    let data = null;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) error = 'http_' + res.status;
      else data = await res.json();
    } catch (err) {
      error = 'network';
    }
    if (!data) break;
    total = Number(data.total) || total;
    const objs = data.objects || [];
    for (const o of objs) {
      const p = (o && o.package) || {};
      if (!isNpmPlugin(p)) continue;
      const row = compactNpmRow(o);
      if (!row || seen[row.name]) continue;
      seen[row.name] = 1;
      items.push(row);
    }
    pages++;
    /* npm 的 from+size 最多到 2500，第 11 页直接空；先判空再判 short page 再判总数，三重收尾 */
    if (!objs.length || objs.length < ALL_NPM_SIZE) break;
    if (total && i * ALL_NPM_SIZE + objs.length >= total) break;
  }
  return { items, pages, total, error };
}

function mergeEntry(prev, fresh, now, kind) {
  const old = prev && Array.isArray(prev.items) && prev.items.length ? prev : null;
  const items = fresh.items || [];
  if (!items.length) {
    if (old) {
      /* 这次没抓到，但磁盘上有旧的：继续用旧的，只把「过期」和错误原因告诉前端。 */
      return Object.assign({}, old, { checkedAt: now, error: fresh.error || 'fail', stale: true, ok: false });
    }
    return { at: 0, checkedAt: now, items: [], total: 0, pages: 0, error: fresh.error || 'fail', ok: false, stale: false };
  }
  return {
    at: now,
    checkedAt: now,
    items,
    total: items.length,
    pages: fresh.pages || 0,
    remoteTotal: fresh.remoteTotal || 0,
    error: fresh.error || null,
    partial: !!fresh.partial,
    stale: false,
    ok: !fresh.error,
    resetAt: fresh.resetAt || 0,
    remaining: fresh.remaining === undefined ? null : fresh.remaining,
    kind,
  };
}

async function handleAll(request) {
  let u;
  try {
    u = new URL(request.url, 'http://local');
  } catch (err) {
    return jsonResponse({ ok: false, error: 'bad_url' }, 400);
  }
  const force = u.searchParams.get('force') === '1';
  const now = Date.now();
  const disk = readAllDisk();
  const wantGh = needRefresh(disk.github, now, force);
  const wantNpm = needRefresh(disk.npm, now, force);
  let changed = false;

  const jobs = [];
  if (wantGh) {
    jobs.push(
      refreshGithub().then((g) => {
        disk.github = mergeEntry(disk.github, g, Date.now(), 'github');
        changed = true;
      }),
    );
  }
  if (wantNpm) {
    jobs.push(
      refreshNpm().then((n) => {
        disk.npm = mergeEntry(disk.npm, n, Date.now(), 'npm');
        changed = true;
      }),
    );
  }
  if (jobs.length) await Promise.all(jobs);
  if (changed) writeAllDisk();

  const github = disk.github || { at: 0, items: [], total: 0 };
  const npm = disk.npm || { at: 0, items: [], total: 0 };
  const ghItems = Array.isArray(github.items) ? github.items : [];
  const npmItems = Array.isArray(npm.items) ? npm.items : [];
  const payload = {
    ok: ghItems.length + npmItems.length > 0,
    fetchedAt: Math.max(Number(github.at) || 0, Number(npm.at) || 0),
    checkedAt: now,
    hasToken: ghHasToken(),
    github: {
      at: Number(github.at) || 0,
      total: ghItems.length,
      pages: github.pages || 0,
      remoteTotal: github.remoteTotal || 0,
      partial: !!github.partial,
      stale: !!github.stale,
      error: github.error || null,
      items: ghItems,
    },
    npm: {
      at: Number(npm.at) || 0,
      total: npmItems.length,
      pages: npm.pages || 0,
      remoteTotal: npm.remoteTotal || 0,
      error: npm.error || null,
      stale: !!npm.stale,
      items: npmItems,
    },
  };

  /* 1MB 的 payload 每次重新序列化要几十毫秒；同一个缓存版本只编一次。 */
  if (!force && allBody.body && now - allBody.at < 60000) {
    return new Response(allBody.body, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const body = JSON.stringify(payload);
  allBody = { at: now, body };
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 下载量单独走一路：全量名单有两千多条，不能为了补下载量把整份列表再传一遍。 */
async function handleAllDl(request) {
  let cap = ALL_DL_CAP;
  try {
    const u = new URL(request.url, 'http://local');
    const want = Number(u.searchParams.get('cap'));
    if (Number.isFinite(want) && want > 0) cap = Math.min(ALL_DL_CAP, want);
  } catch (err) {
    /* 用默认值 */
  }
  const disk = readAllDisk();
  const npm = disk.npm;
  if (!npm || !Array.isArray(npm.items) || !npm.items.length) {
    return jsonResponse({ ok: false, error: 'no_data', map: {}, at: 0 }, 404);
  }
  const names = npm.items
    .slice()
    .sort((a, b) => Number(b.relevance || 0) - Number(a.relevance || 0))
    .slice(0, cap)
    .map((r) => r.name);
  const map = await fetchDownloads(names);
  const dlDisk = readDlDisk();
  let covered = 0;
  for (const r of npm.items) if (typeof dlDisk.map[r.name] === 'number') covered++;
  return jsonResponse({
    ok: true,
    at: Number(dlDisk.at) || 0,
    map,
    requested: names.length,
    total: npm.items.length,
    covered,
  });
}

export function apply(ctx) {
  ctx.inject(['connection', 'llm'], (host) => {
    host.effect(
      () =>
        host.connection.fetch.register({
          path: HEALTH_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => handleHealth(host),
        }),
      'dsh-daily-push: consult health',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: ASK_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleAsk(host, request),
        }),
      'dsh-daily-push: consult ask',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: INTROS_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleIntros(host, request),
        }),
      'dsh-daily-push: consult intros',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: INSTALLED_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => handleInstalled(),
        }),
      'dsh-daily-push: installed packages',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: WATCH_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleWatch(request),
        }),
      'dsh-daily-push: plugin watch',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: '/api/daily-consult.watch.edit',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleWatchEdit(request),
        }),
      'dsh-daily-push: watch edit',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: RECENT_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => handleRecent(),
        }),
      'dsh-daily-push: recent search',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: SEARCH_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleSearch(request),
        }),
      'dsh-daily-push: keyword search',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: NPM_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleNpm(request),
        }),
      'dsh-daily-push: npm search',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: GH_TOP_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleGhTop(request),
        }),
      'dsh-daily-push: github top sample',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: ALL_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleAll(request),
        }),
      'dsh-daily-push: all sources',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: ALL_DL_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: (request) => handleAllDl(request),
        }),
      'dsh-daily-push: all downloads',
    );

    host.effect(
      () =>
        host.connection.fetch.register({
          path: TOKEN_PATH,
          methods: ['GET', 'POST', 'DELETE'],
          requestBody: 'buffered',
          fetch: (request) => handleToken(request),
        }),
      'dsh-daily-push: github token',
    );
    ctx.effect(
      () =>
        host.connection.fetch.register({
          path: ZH_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request) => handleZh(host, request),
        }),
      'dsh-daily-push: zh translate',
    );
  });
}
