window.__ModuleLoader__.load({
  id: 'dsh-daily-push',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /* ───────────────────────── 数据常量 ───────────────────────── */

    const REGISTRY_URL = '/dsh-recommend/registry.json';
    /** 咨询功能（宿主半 index.js 提供的同源端点）——探针阶段先只做自检。*/
    const CONSULT_HEALTH_URL = '/api/daily-consult.health';
    const CONSULT_ASK_URL = '/api/daily-consult';
    const GITHUB_SEARCH_URL =
      'https://api.github.com/search/repositories?q=' +
      encodeURIComponent('topic:dsh-plugin') +
      '&sort=stars&order=desc&per_page=30';

    /** 榜单停更后，「今日精选」靠这个实时搜：近 7 天有 push 的 dsh 插件，按最近更新排序。*/
    function githubRecentUrl() {
      const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      return (
        'https://api.github.com/search/repositories?q=' +
        encodeURIComponent('topic:dsh-plugin pushed:>=' + since) +
        '&sort=updated&order=desc&per_page=30'
      );
    }
    /** 实时结果在内存里放 10 分钟，避免每次切标签都打 GitHub。*/
    const GH_RECENT_TTL = 10 * 60 * 1000;
    let ghRecentCache = { at: 0, items: null };

    /** 本地快照：上一次打开时每颗仓库的 star 数，用来算「涨得最快」。*/
    const SNAPSHOT_KEY = 'dsh-daily-push:stars:v1';
    /** 「新出现」的判定窗口（天）。上游数据可能停更，窗口给宽一点。*/
    const NEW_WINDOW_DAYS = 60;
    /** 「今日精选」只挑最近还有动静的仓库。*/
    const FRESH_WINDOW_DAYS = 30;

    /* ── 「今日精选」权重：星 45 / 活跃 30 / 新 25 ──
       三项各自归一到 0..1 再加权 ×100；改这三个数就能调偏好。*/
    const W_STAR = 0.45;
    const W_ACT = 0.3;
    const W_NEW = 0.25;

    function scoreRepo(p) {
      const stars = Number(p.stars) || 0;
      const starS = Math.min(1, Math.log10(stars + 1) / 3); // 1000★ = 满分
      const dPush = daysBetween(p.pushedAt);
      const actS =
        dPush <= 1 ? 1 : dPush <= 3 ? 0.85 : dPush <= 7 ? 0.7 :
        dPush <= 14 ? 0.5 : dPush <= 30 ? 0.3 : dPush <= 90 ? 0.15 : 0.05;
      const dNew = daysBetween(p.createdAt);
      const newS =
        dNew <= 7 ? 1 : dNew <= 14 ? 0.85 : dNew <= 30 ? 0.7 :
        dNew <= 60 ? 0.45 : dNew <= 180 ? 0.2 : 0.05;
      const score = Math.round(100 * (W_STAR * starS + W_ACT * actS + W_NEW * newS));
      const badges = [];
      if (dNew <= 30) badges.push('新');
      if (actS >= 0.85) badges.push('活跃');
      if (stars >= 300) badges.push('热门');
      return { score, badges };
    }

    const BADGE_CSS = [
      '.fr-tag-hl{background:rgba(120,180,255,.16);border-color:rgba(120,180,255,.42);color:#a9cdff;font-weight:600}',
    ].join('\n');

    const TAB_ID = 'dsh-daily-push';
    /** 左侧导航条目与主区域面板共用同一个 id。*/
    const PANEL_ID = 'daily-push';

    /* ───────────────────────── 小工具 ───────────────────────── */

    const DAY = 86400000;

    function daysBetween(iso, from) {
      if (!iso) return Infinity;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return Infinity;
      const base = typeof from === 'number' && from > 0 ? from : Date.now();
      return (base - t) / DAY;
    }

    /** 榜单里最新的一次 push 时间（毫秒）；用来判断数据是不是停更了。*/
    function dataNewest(plugins) {
      let mx = 0;
      for (const p of plugins) {
        const t = Date.parse(p.pushedAt || '');
        if (t > mx) mx = t;
      }
      return mx;
    }

    /** 数据停更超过 2 天时，“今日”改成“数据里最新那一批”，否则空窗会一直空。*/
    function todayRef(plugins) {
      const newest = dataNewest(plugins);
      if (!newest) return { newest: 0, ref: Date.now(), stale: Infinity };
      const stale = (Date.now() - newest) / DAY;
      return { newest: newest, ref: stale > 2 ? newest : Date.now(), stale: stale };
    }

    function mdText(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      return d.getMonth() + 1 + '/' + d.getDate();
    }

    function pubTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    /** 「N 天前 / 昨天 / 今天」这种口语化的新鲜度。*/
    function agoText(iso) {
      const d = daysBetween(iso);
      if (!Number.isFinite(d)) return '';
      if (d < 1) return '今天有更新';
      if (d < 2) return '昨天有更新';
      if (d < 30) return Math.floor(d) + ' 天前有更新';
      if (d < 365) return Math.floor(d / 30) + ' 个月前有更新';
      return Math.floor(d / 365) + ' 年前有更新';
    }

    /** 把 GitHub 上常见的英文 markdown 描述收拾成能看的纯文本。*/
    function cleanText(raw) {
      if (!raw) return '';
      return String(raw)
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // 链接只留文字
        .replace(/https?:\/\/\S+/g, ' ')                // 裸链接
        .replace(/<[^>]+>/g, ' ')                       // html 标签
        .replace(/[`*_>#]/g, '')                        // markdown 记号
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ') // emoji
        .replace(/\s+/g, ' ')
        .trim();
    }

    function readSnapshot() {
      try {
        const raw = window.localStorage.getItem(SNAPSHOT_KEY);
        if (!raw) return null;
        const doc = JSON.parse(raw);
        if (!doc || typeof doc.stars !== 'object' || !doc.stars) return null;
        return doc;
      } catch {
        return null;
      }
    }

    /** 快照只留星数最高的 2500 个仓库：生态有 1.6 万个仓库，全存会撑到 0.6 MB 且天天变大。*/
    function writeSnapshot(stars) {
      try {
        const rows = Object.entries(stars || {})
          .sort((a, b) => (b[1] || 0) - (a[1] || 0))
          .slice(0, 2500);
        const trimmed = {};
        for (const [k, v] of rows) trimmed[k] = v;
        window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ at: new Date().toISOString(), stars: trimmed }));
      } catch {
        /* 站点数据被禁是正常情形，快照只是锦上添花 */
      }
    }

    async function fetchJson(url, init) {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(String(url) + ' · HTTP ' + res.status);
      return res.json();
    }

    /* ───────────────────────── 中文介绍生成 ─────────────────────────
       没有接模型，所以介绍是从仓库自带的英文描述 + 名字里读出来的：
       先按关键词判定它属于哪一类、能干什么，再用中文模板组装成一句话。
       判定不出来就老实写"用途待确认"，不编造。
                      */

    /** 领域规则：先匹配到的算主领域，后面的算辅助标签。*/
    const DOMAINS = [
      {
        key: 'vision',
        re: /(vision|视觉|识图|看图|eyes|ocr|多模态|multimodal|grounding|image understanding)/,
        label: '视觉识图',
        what: '让模型能看图：识图、读图、图片问答这一类',
      },
      {
        key: 'market',
        re: /(market|市场|商店|marketplace|store|榜单|推荐|discover)/,
        label: '插件市场',
        what: '找插件的地方：浏览、搜索、推荐、一键装',
      },
      {
        key: 'launcher',
        re: /(launcher|启动器|installer|安装器|updater|更新器|版本管理)/,
        label: '启动安装',
        what: '管安装、启动、升级这类装机和维护的活',
      },
      {
        key: 'image',
        re: /(image|img|文生图|绘图|draw|diffusion|comfy|seedream|midjourney|gpt-image|seededit|photo|海报|插画)/,
        label: '图像生成',
        what: '把文生图、图生图这类出图能力接进对话',
      },
      {
        key: 'video',
        re: /(video|t2v|i2v|视频|movie|clip|animate)/,
        label: '视频生成',
        what: '做文生视频、图生视频，或视频剪辑与增强',
      },
      {
        key: 'audio',
        re: /(speech|tts|voice|语音|audio|sound|music|音频|asr|whisper|朗读)/,
        label: '语音音频',
        what: '语音合成、语音识别或者音乐、音效相关',
      },
      {
        key: 'memory',
        re: /(memory|remember|记忆|recall|长期记忆)/,
        label: '记忆管理',
        what: '给会话做长期记忆，让模型记住以前聊过的事',
      },
      {
        key: 'agent',
        re: /(agent|智能体|subagent|自动|autonomous|loop|orchestrat)/,
        label: '智能体',
        what: '多智能体编排、自动化任务链一类的能力',
      },
      {
        key: 'mcp',
        re: /(mcp|gateway|网关|proxy|protocol|tool server)/,
        label: 'MCP 生态',
        what: '把外部工具、MCP 服务接到 DSH 里',
      },
      {
        key: 'ui',
        re: /(sidebar|侧边栏|ui|界面|layout|布局|theme|主题|皮肤|skin|wallpaper|壁纸|desktop|icon|图标)/,
        label: '界面美化',
        what: '改界面长相：侧边栏、主题、壁纸、图标这类',
      },
      {
        key: 'translate',
        re: /(translate|翻译|i18n|locali[sz]ation|语言)/,
        label: '翻译语言',
        what: '翻译、多语言界面或者文案本地化',
      },
      {
        key: 'note',
        re: /(note|笔记|notion|obsidian|markdown|文档|doc|wiki|知识)/,
        label: '笔记文档',
        what: '记笔记、管文档、整理知识库',
      },
      {
        key: 'task',
        re: /(todo|task|任务|kanban|看板|calendar|日历|日程|reminder|提醒)/,
        label: '任务日程',
        what: '待办、看板、日程提醒这类效率工具',
      },
      {
        key: 'search',
        re: /(search|检索|rag|embedding|向量|知识库|index)/,
        label: '检索问答',
        what: '搜索、检索增强，或者把资料喂给模型问答',
      },
      {
        key: 'web',
        re: /(browser|浏览器|scrape|爬虫|爬取|crawl|rss|news|资讯|webfetch|网页抓取|http)/,
        label: '网页抓取',
        what: '抓网页、读资讯、取网络上的内容',
      },
      {
        key: 'data',
        re: /(sqlite|postgres|mysql|database|数据库|storage|存储|redis|excel|csv)/,
        label: '数据存储',
        what: '存取数据：数据库、表格、文件型存储',
      },
      {
        key: 'dev',
        re: /(git|commit|代码|code|dev|调试|debug|test|构建|build|lint|插件开发|plugin dev)/,
        label: '开发工具',
        what: '写代码、查问题、构建发布这类开发向的能力',
      },
      {
        key: 'model',
        re: /(llm|model|模型|deepseek|openai|claude|gemini|qwen|provider|router|路由|api key|接入)/,
        label: '模型接入',
        what: '接不同厂商的模型、换端点或者做模型路由',
      },
      {
        key: 'monitor',
        re: /(monitor|监控|metric|指标|log|日志|telemetry|status|诊断|token|用量)/,
        label: '监控用量',
        what: '看运行状态、日志、token 用量与成本',
      },
      {
        key: 'file',
        re: /(file|文件|pdf|word|excel|ppt|office|图片整理|压缩|解压|batch rename)/,
        label: '文件处理',
        what: '读写、转换、批量整理本地文件',
      },
      {
        key: 'push',
        re: /(notify|通知|推送|wechat|微信|qq|telegram|slack|discord|bot|邮件|email|sms)/,
        label: '消息推送',
        what: '把消息推到微信、Telegram、邮件这类渠道',
      },
      {
        key: 'game',
        re: /(game|游戏|godot|unity|像素|pixel art)/,
        label: '游戏开发',
        what: '做游戏、素材或者游戏内工具',
      },
      {
        key: 'security',
        re: /(security|安全|sandbox|沙箱|权限|permission|加密|密码|vault)/,
        label: '安全权限',
        what: '管权限、沙箱、密钥与安全策略',
      },
      {
        key: 'mobile',
        re: /(android|安卓|ios|手机|mobile|微信小程序)/,
        label: '移动端',
        what: '手机端、小程序相关的适配',
      },
      {
        key: 'schedule',
        re: /(cron|定时|schedul|定时任务|队列|queue)/,
        label: '定时任务',
        what: '定时跑任务、排队执行',
      },
      {
        key: 'prompt',
        re: /(prompt|提示词|指令|system prompt)/,
        label: '提示词',
        what: '管理提示词模板、系统指令',
      },
      {
        key: 'learn',
        re: /(tutorial|教程|课程|learn|入门|指南|guide|handbook|例子|example)/,
        label: '教程资料',
        what: '教你怎么用 DSH 的资料、教程或示例集合',
      },
      {
        key: 'office',
        re: /(meeting|会议|腾讯会议|飞书|lark|钉钉|zoom|office|邮件|mail|日程同步)/,
        label: '办公协作',
        what: '会议、日历、办公套件这类协作场景',
      },
      {
        key: 'config',
        re: /(skill|技能|preset|预设|setting|设置|配置|config|profile|参数)/,
        label: '配置管理',
        what: '管技能、预设、配置这类"改行为"的设置',
      },
      {
        key: 'platform',
        re: /(platform|平台|genai|modality|saas|商业化|billing|计费|支付)/,
        label: '平台服务',
        what: '一整套平台化的服务（账号、计费、分发这类）',
      },
      {
        key: 'clone',
        re: /(clone|克隆|复刻|仿站|replica|port of)/,
        label: '克隆复刻',
        what: '照某个现成网站/产品复刻一份出来',
      },
      {
        key: 'workflow',
        re: /(workflow|工作流|自动化|pipeline|编排)/,
        label: '工作台',
        what: '把多个步骤串成可复用的工作流',
      },
    ];

    /** 从英文描述里读出"能干什么"的关键细节，拼成中文短语。*/
    const FEATURES = [
      { re: /(comfyui|comfy)/, text: '跑 ComfyUI 工作流' },
      { re: /(one[- ]click|一键)/, text: '一键就能用' },
      { re: /(self[- ]host|自部署|docker|私有化)/, text: '可以自己部署' },
      { re: /(no[- ]code|零代码|无代码)/, text: '不用写代码' },
      { re: /(sidebar|侧边栏)/, text: '挂在侧边栏里' },
      { re: /(slash|command|\/命令)/, text: '用斜杠命令触发' },
      { re: /(tool|工具调用)/, text: '给模型当工具调用' },
      { re: /(batch|批量)/, text: '支持批量处理' },
      { re: /(realtime|实时|stream)/, text: '实时出结果' },
      { re: /(local|本地|offline|离线)/, text: '本地离线跑' },
      { re: /(export|导出|import|导入)/, text: '能导入导出' },
      { re: /(schedule|cron|定时)/, text: '支持定时执行' },
      { re: /(theme|主题|dark mode|深色)/, text: '可切主题配色' },
    ];

    /** 给一个仓库算中文介绍，返回 { label, extraLabels, intro }。*/
    /** 描述本身是不是以中文为主（不少仓库自带中文简介，那就不用再翻译）。*/
    function isMostlyChinese(text) {
      if (!text) return false;
      const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const latin = (text.match(/[A-Za-z]/g) || []).length;
      return cjk >= 8 && cjk * 2 >= latin;
    }

    /** 取中文描述里最能当"介绍"的一段：第一句，太长就截断。*/
    function firstChineseSentence(text) {
      const parts = String(text).split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean);
      let out = '';
      for (const s of parts) {
        if (out && (out + s).length > 90) break;
        out += s;
        if (out.length >= 40) break;
      }
      out = out || String(text);
      if (out.length > 96) out = out.slice(0, 94).replace(/[，。、\s]+$/, '') + '…';
      if (!/[。！？…]$/.test(out)) out += '。';
      return out;
    }

    /** 描述开头如果是像样的中文句子，直接拿它当介绍；否则返回 null。*/
    function chineseLead(text) {
      if (!text) return null;
      const lead = firstChineseSentence(text);
      const cjk = (lead.match(/[\u4e00-\u9fff]/g) || []).length;
      return cjk >= 10 ? lead : null;
    }

    /** 给一个仓库算中文介绍，返回 { label, extraLabels, intro }。*/
    function zhIntro(p) {
      const name = String(p.fullName || '');
      const desc = cleanText(p.description);
      const hay = (name + ' ' + desc).toLowerCase();
      const matched = DOMAINS.filter((d) => d.re.test(hay));
      const main = matched[0];
      const extras = matched.slice(1, 3).map((d) => d.label);

      const lead = chineseLead(desc);
      let intro;
      if (lead && (isMostlyChinese(desc) || lead.length >= 14)) {
        // 自带中文简介：直接用仓库自己的说法，最准确。
        intro = lead;
      } else {
        const feats = [];
        for (const f of FEATURES) {
          if (f.re.test(hay) && feats.length < 3 && !feats.includes(f.text)) feats.push(f.text);
        }
        const parts = [main ? main.what : '用途还不明确，看名字和仓库再判断'];
        if (feats.length) parts.push(feats.join('、'));
        intro = parts.join('，') + '。';
      }

      // 尾巴只放事实：知名度档位 + 最近动静。
      const tail = [];
      const starN = p.stars || 0;
      if (starN >= 1000) tail.push('上千星');
      else if (starN >= 100) tail.push('百星级');
      else if (starN > 0) tail.push('刚起步');
      const ago = agoText(p.pushedAt);
      if (ago) tail.push(ago);
      if (tail.length) intro += '（' + tail.join(' · ') + '）';

      const label = main ? main.label : extras[0] || '工具';
      return { label, extraLabels: extras, intro };
    }

        /* ───────────────────────── 样式 ───────────────────────── */

    const CSS = `
.ddp-main {
  --ddp-line: var(--dsw-alias-border-l2, rgba(233,230,221,.16));
  --ddp-line-soft: var(--dsw-alias-border-l3, rgba(233,230,221,.08));
  --ddp-ink: var(--dsw-alias-label-primary, #e9e6dd);
  --ddp-dim: var(--dsw-alias-label-secondary, #b9b5ab);
  --ddp-faint: var(--dsw-alias-label-tertiary, #8a867d);
  --ddp-accent: var(--dsw-alias-brand-primary-new-color, #d3a85b);
  --ddp-serif: "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  --ddp-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
  height:100%; box-sizing:border-box; overflow:auto;
  background:var(--dsw-alias-bg-base,#101116);
  color:var(--ddp-ink);
  font-size:13px; line-height:1.6;
}
.ddp-sheet { max-width:1060px; margin:0 auto; padding:24px 30px 56px; }
.ddp-sheet a { color:inherit; text-decoration:none; }
.ddp-sheet a:hover { text-decoration:underline; text-underline-offset:2px; }

/* ── 报头 ── */
.ddp-mast {
  display:flex; justify-content:space-between; align-items:flex-end; gap:20px;
  border-bottom:3px double var(--ddp-line); padding-bottom:10px;
}
.ddp-mast h1 {
  margin:0; font-family:var(--ddp-serif); font-size:30px; letter-spacing:.06em; font-weight:600;
}
.ddp-mast-sub { color:var(--ddp-dim); font-size:11.5px; margin-top:3px; }
.ddp-mast-tools { display:flex; gap:8px; align-items:center; padding-bottom:3px; }
.ddp-tool {
  border:1px solid var(--ddp-line); background:transparent; color:var(--ddp-dim);
  font-family:var(--ddp-mono); font-size:11px; letter-spacing:.08em; padding:6px 10px; cursor:pointer;
  text-transform:uppercase;
}
.ddp-tool:hover { color:var(--ddp-accent); border-color:var(--ddp-accent); }
.ddp-tool[disabled] { opacity:.45; cursor:default; }

/* ── 统计条 ── */
.ddp-stats {
  display:flex; gap:22px; flex-wrap:wrap; border-bottom:1px solid var(--ddp-line); padding:8px 0;
  font-size:11.5px; color:var(--ddp-dim); letter-spacing:.04em;
}
.ddp-stat b { color:var(--ddp-ink); font-family:var(--ddp-mono); font-weight:400; font-size:12px; }
.ddp-warn { color:var(--ddp-accent); }

/* ── 咨询条 ── */
.ddp-ask { display:flex; gap:8px; align-items:center; padding:10px 0; border-bottom:1px solid var(--ddp-line); }
.ddp-ask-k { font-family:var(--ddp-mono); font-size:10px; letter-spacing:.16em; color:var(--ddp-faint); text-transform:uppercase; }
.ddp-ask-in {
  flex:1; background:transparent; border:1px solid var(--ddp-line); color:var(--ddp-ink);
  font-size:12.5px; padding:7px 10px; outline:none; min-width:120px;
}
.ddp-ask-in:focus { border-color:var(--ddp-accent); }
.ddp-ask-in::placeholder { color:var(--ddp-faint); }
.ddp-ask-model { font-family:var(--ddp-mono); font-size:10.5px; color:var(--ddp-faint); }
.ddp-answer { border:1px solid var(--ddp-line); border-top:none; padding:12px 14px; margin:0 0 4px; background:rgba(255,255,255,.02); }
.ddp-answer-q { font-size:11.5px; color:var(--ddp-faint); margin-bottom:8px; }
.ddp-answer-a { font-size:13px; line-height:1.75; color:var(--ddp-ink); white-space:pre-wrap; }
.ddp-answer-err { color:#e07a5f; font-size:12px; }
.ddp-answer-f { display:flex; justify-content:space-between; margin-top:8px; font-family:var(--ddp-mono); font-size:10px; color:var(--ddp-faint); }
.ddp-delta { display:inline-block; width:6px; height:11px; background:var(--ddp-accent); margin-left:2px; vertical-align:-1px; animation:ddp-blink 1s step-end infinite; }
@keyframes ddp-blink { 50% { opacity:0 } }

/* ── 头条 ── */
.ddp-lead {
  display:grid; grid-template-columns:1fr 220px; gap:30px;
  padding:22px 0 20px; border-bottom:1px solid var(--ddp-line);
}
.ddp-kicker {
  font-family:var(--ddp-mono); font-size:10px; letter-spacing:.22em; color:var(--ddp-accent);
  text-transform:uppercase; margin-bottom:8px;
}
.ddp-lead-title { font-family:var(--ddp-serif); font-size:31px; line-height:1.15; margin:0 0 10px; font-weight:600; }
.ddp-lede { font-family:var(--ddp-serif); font-size:17px; line-height:1.7; color:var(--ddp-ink); margin:0 0 12px; }
.ddp-polish { font-family:var(--ddp-mono); font-size:10px; letter-spacing:.08em; color:var(--ddp-faint); border:1px solid var(--ddp-line); border-radius:2px; padding:1px 5px; margin-left:8px; vertical-align:middle; }
.ddp-points { list-style:none; margin:0 0 14px; padding:0; display:grid; gap:5px; }
.ddp-points li { position:relative; padding-left:15px; font-size:13px; color:var(--ddp-dim); line-height:1.65; }
.ddp-points li:before { content:""; position:absolute; left:2px; top:9px; width:6px; height:1px; background:var(--ddp-accent); }
.ddp-points b { color:var(--ddp-ink); font-weight:600; margin-right:6px; }
.ddp-cmd {
  display:flex; align-items:center; gap:10px; border:1px solid var(--ddp-line);
  padding:7px 10px; margin:0 0 14px; background:rgba(255,255,255,.02); flex-wrap:wrap;
}
.ddp-cmd-k { font-family:var(--ddp-mono); font-size:9.5px; letter-spacing:.16em; color:var(--ddp-faint); text-transform:uppercase; }
.ddp-cmd code { font-family:var(--ddp-mono); font-size:11.5px; color:#cfe3c8; word-break:break-all; flex:1; }
.ddp-acts { display:flex; gap:9px; flex-wrap:wrap; margin-bottom:12px; }
.ddp-btn {
  border:1px solid var(--ddp-line); background:transparent; color:var(--ddp-ink);
  font-size:12.5px; padding:7px 13px; cursor:pointer; letter-spacing:.02em;
}
.ddp-btn:hover { border-color:var(--ddp-accent); color:var(--ddp-accent); }
.ddp-btn-solid { background:var(--ddp-accent); border-color:var(--ddp-accent); color:#12141a; font-weight:600; }
.ddp-btn-solid:hover { color:#000; }
.ddp-same { font-size:11.5px; color:var(--ddp-faint); border-top:1px solid var(--ddp-line-soft); padding-top:9px; }
.ddp-same-k { font-family:var(--ddp-mono); font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; margin-right:9px; }
.ddp-same a { color:var(--ddp-dim); }
.ddp-same a:hover { color:var(--ddp-accent); }
.ddp-same i { font-style:normal; margin:0 7px; color:var(--ddp-faint); opacity:.5; }

.ddp-facts { border-left:1px solid var(--ddp-line); padding-left:18px; }
.ddp-facts dl { margin:0; display:grid; grid-template-columns:auto 1fr; gap:8px 12px; align-items:baseline; }
.ddp-facts dt {
  font-family:var(--ddp-mono); font-size:10px; letter-spacing:.14em; color:var(--ddp-faint); text-transform:uppercase;
}
.ddp-facts dd { margin:0; font-size:13px; color:var(--ddp-ink); }
.ddp-facts .ddp-num { font-family:var(--ddp-mono); font-size:15px; }
.ddp-off { color:var(--ddp-faint); font-size:12px; }
.ddp-on { color:var(--ddp-accent); font-size:12px; }
.ddp-why { font-size:11.5px; color:var(--ddp-accent); line-height:1.5; }

/* ── 表格区块 ── */
.ddp-sect { padding-top:20px; }
.ddp-sect-head { display:flex; align-items:baseline; gap:12px; border-bottom:1px solid var(--ddp-line); padding-bottom:6px; }
.ddp-sect-head h3 { margin:0; font-family:var(--ddp-serif); font-size:16px; letter-spacing:.05em; font-weight:600; }
.ddp-hint { font-size:11px; color:var(--ddp-faint); margin-left:auto; }
.ddp-table { width:100%; border-collapse:collapse; font-size:13px; }
.ddp-table th {
  text-align:left; font-family:var(--ddp-mono); font-size:10px; letter-spacing:.14em; text-transform:uppercase;
  color:var(--ddp-faint); font-weight:400; padding:8px 10px 6px 0; border-bottom:1px solid var(--ddp-line);
}
.ddp-table td { padding:10px 10px 10px 0; border-bottom:1px solid var(--ddp-line-soft); vertical-align:baseline; }
.ddp-table tbody tr:hover { background:rgba(255,255,255,.025); }
.ddp-idx { color:var(--ddp-faint); font-family:var(--ddp-mono); width:28px; font-size:11px; }
.ddp-repo { width:25%; min-width:165px; }
.ddp-repo a { font-family:var(--ddp-serif); font-size:14.5px; color:var(--ddp-ink); }
.ddp-repo a:hover { color:var(--ddp-accent); }
.ddp-tags { margin-left:8px; display:inline-flex; gap:4px; flex-wrap:wrap; vertical-align:baseline; }
.ddp-tags i {
  font-style:normal; font-size:9.5px; letter-spacing:.06em; color:var(--ddp-faint);
  border:1px solid var(--ddp-line); padding:1px 5px; border-radius:2px;
}
.ddp-tags i.ddp-installed { color:var(--ddp-accent); border-color:var(--ddp-accent); }
.ddp-oneliner { color:var(--ddp-dim); font-size:12.5px; line-height:1.55; }
.ddp-lang, .ddp-upd { font-size:11px; color:var(--ddp-faint); white-space:nowrap; }
.ddp-upd { text-align:right; width:76px; }
.ddp-ops { text-align:right; white-space:nowrap; width:92px; }
.ddp-mini {
  border:1px solid var(--ddp-line); background:transparent; color:var(--ddp-dim);
  font-size:11px; padding:3px 7px; cursor:pointer; margin-left:4px;
}
.ddp-mini:hover { color:var(--ddp-accent); border-color:var(--ddp-accent); }

.ddp-empty { padding:14px 0 4px; color:var(--ddp-faint); font-size:12.5px; font-style:italic; }
.ddp-foot {
  margin-top:26px; border-top:3px double var(--ddp-line); padding-top:9px;
  display:flex; justify-content:space-between; font-family:var(--ddp-mono);
  font-size:10.5px; color:var(--ddp-faint);
}
.ddp-skel { display:grid; gap:8px; padding:20px 0; }
.ddp-skel i { display:block; height:12px; background:var(--ddp-line-soft); }
.ddp-fail { border:1px solid var(--ddp-line); border-left:3px solid #e07a5f; padding:10px 12px; margin:14px 0; font-size:12.5px; color:var(--ddp-dim); }

/* ── 版式 A：三栏看板的骨架（整页不滚，块内各管各的） ── */
.ddp-frame {
  --ddp-line: var(--dsw-alias-border-l2, rgba(233,230,221,.16));
  --ddp-line-soft: var(--dsw-alias-border-l3, rgba(233,230,221,.08));
  --ddp-ink: var(--dsw-alias-label-primary, #e9e6dd);
  --ddp-dim: var(--dsw-alias-label-secondary, #b9b5ab);
  --ddp-faint: var(--dsw-alias-label-tertiary, #8a867d);
  --ddp-accent: var(--dsw-alias-brand-primary-new-color, #d3a85b);
  --ddp-serif: "Songti SC", "STSong", "SimSun", "Noto Serif SC", serif;
  --ddp-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
  height:100%; box-sizing:border-box; overflow:hidden;
  display:flex; flex-direction:column;
  background:rgba(9,10,14,.62); color:var(--ddp-ink);
  -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px);
  font-size:13px; line-height:1.6;
}
.ddp-frame .ddp-mast { padding:16px 24px 8px; }
.ddp-frame .ddp-mast h1 { font-size:26px; }
.ddp-frame .ddp-stats { padding:6px 24px; }
.ddp-frame .ddp-ask { padding:8px 24px; }
.ddp-frame .ddp-mast,
.ddp-frame .ddp-stats,
.ddp-frame .ddp-ask { flex:0 0 auto; }
.ddp-frame-note {
  font-family:var(--ddp-mono); font-size:10px; letter-spacing:.08em; color:var(--ddp-faint);
  border:1px dashed var(--ddp-line); padding:3px 8px; margin-right:8px;
}
.ddp-grid {
  flex:1 1 auto; min-height:0; display:grid;
  grid-template-columns:1.05fr 1fr 1fr; gap:14px; padding:12px 24px 0;
}
.ddp-col {
  display:flex; flex-direction:column; min-height:0; overflow:hidden;
  border:1px solid var(--ddp-line-soft); background:rgba(12,13,18,.55); border-radius:3px;
}
.ddp-col-h {
  flex:0 0 auto; display:flex; align-items:baseline; gap:10px;
  padding:8px 12px 6px; border-bottom:1px solid var(--ddp-line);
}
.ddp-col-h h3 { margin:0; font-family:var(--ddp-serif); font-size:14.5px; letter-spacing:.05em; font-weight:600; }
.ddp-col-h span { margin-left:auto; font-size:10.5px; color:var(--ddp-faint); }
.ddp-col-b { flex:1 1 auto; min-height:0; overflow:auto; padding:6px 12px 8px; display:flex; flex-direction:column; }
.ddp-col-b::-webkit-scrollbar { width:6px; }
.ddp-col-b::-webkit-scrollbar-thumb { background:rgba(233,230,221,.14); border-radius:3px; }

/* 清单里的一行：序号 / 名字 + 一句话 + 标签 / 右侧星数与更新时间 */
.fr-row {
  flex:0 0 auto; display:grid; grid-template-columns:16px 1fr auto; gap:9px; align-items:start;
  padding:8px 0; border-bottom:1px solid var(--ddp-line-soft);
}
.fr-row:last-of-type { border-bottom:none; }
.fr-idx { font-family:var(--ddp-mono); font-size:10.5px; color:var(--ddp-accent); padding-top:1px; }
.fr-name { font-size:12.5px; font-weight:600; color:var(--ddp-ink); }
.fr-one {
  margin:2px 0 0; font-size:11.5px; line-height:1.55; color:var(--ddp-dim);
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
}
.fr-tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
.fr-tag {
  font-family:var(--ddp-mono); font-size:9px; letter-spacing:.06em; color:var(--ddp-faint);
  border:1px solid var(--ddp-line-soft); padding:1px 5px; border-radius:2px;
}
.fr-side { text-align:right; white-space:nowrap; }
.fr-stars { font-family:var(--ddp-mono); font-size:11px; color:var(--ddp-accent); }
.fr-upd { font-family:var(--ddp-mono); font-size:9.5px; color:var(--ddp-faint); margin-top:3px; }
.fr-more {
  flex:0 0 auto; margin-top:auto; padding-top:8px; display:flex; justify-content:space-between;
  font-size:10.5px; color:var(--ddp-faint); border-top:1px solid var(--ddp-line-soft);
}

/* 头条块 */
.fr-kicker { font-family:var(--ddp-mono); font-size:9.5px; letter-spacing:.16em; color:var(--ddp-accent); text-transform:uppercase; }
.fr-title { margin:6px 0 0; font-family:var(--ddp-serif); font-size:19px; line-height:1.35; font-weight:600; }
.fr-lede { margin:7px 0 0; font-size:11.5px; line-height:1.6; color:var(--ddp-dim); }
.fr-points { margin:9px 0 0; padding:0; list-style:none; }
.fr-points li { position:relative; padding-left:12px; margin-top:3px; font-size:11.5px; line-height:1.5; color:var(--ddp-dim); }
.fr-points li::before { content:'·'; position:absolute; left:2px; color:var(--ddp-accent); }
.fr-facts {
  display:grid; grid-template-columns:1fr 1fr; gap:3px 10px; margin-top:9px;
  font-family:var(--ddp-mono); font-size:10.5px; color:var(--ddp-faint);
}
.fr-facts b { color:var(--ddp-dim); font-weight:400; }
.fr-cmd {
  margin-top:9px; padding:7px 9px; border:1px solid var(--ddp-line); background:rgba(0,0,0,.3);
  font-family:var(--ddp-mono); font-size:10.5px; color:#cfe3c8; word-break:break-all;
}
.fr-acts { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.fr-btn { border:1px solid var(--ddp-line); background:transparent; color:var(--ddp-dim); font-size:11px; padding:3px 9px; }
.fr-btn.on { border-color:var(--ddp-accent); color:var(--ddp-accent); }
.fr-sub {
  flex:0 0 auto; margin-top:12px; padding-top:8px; border-top:1px solid var(--ddp-line);
  font-family:var(--ddp-mono); font-size:9.5px; letter-spacing:.14em; color:var(--ddp-faint); text-transform:uppercase;
}
.fr-list { display:flex; flex-direction:column; flex:1 1 auto; min-height:0; }

/* ── 底座：空槽位（只有框，不放内容） ── */
.fr-slot {
  flex:0 0 auto; border:1px dashed var(--ddp-line); border-radius:2px;
  padding:6px 8px; background:rgba(255,255,255,.018);
}
.fr-slot.grow { flex:1 1 auto; min-height:0; }
.fr-slot-k {
  font-family:var(--ddp-mono); font-size:9px; letter-spacing:.14em; color:var(--ddp-faint);
  text-transform:uppercase; margin-bottom:4px;
}
.fr-slot-b { display:flex; flex-direction:column; gap:5px; }
.fr-slot-acts { display:flex; gap:6px; }
.fr-slot-tags { display:flex; gap:5px; }
.fr-factgrid { display:grid; grid-template-columns:1fr 1fr; gap:5px 10px; }

/* 占位线：只表示“这里有一行字” */
.fr-blank { display:block; width:100%; height:9px; background:rgba(233,230,221,.10); border-radius:1px; }
.fr-blank.dim { background:rgba(233,230,221,.055); }
.fr-blank.tall { height:15px; }

/* 清单行的空位 */
.fr-rowslot {
  flex:0 0 auto; display:grid; grid-template-columns:16px 1fr 52px; gap:9px; align-items:start;
  padding:6px 0; border-bottom:1px solid var(--ddp-line-soft);
}
.fr-rowslot:last-of-type { border-bottom:none; }
.fr-slot-main { display:flex; flex-direction:column; gap:4px; min-width:0; }
.fr-slot-side { display:flex; flex-direction:column; gap:5px; align-items:flex-end; }

/* 快讯空位（中间横条，9 位 = 3 × 3，每格两行） */
.fr-chipslot {
  display:flex; flex-direction:column; gap:3px; min-width:0;
  padding:4px 0; border-bottom:1px solid var(--ddp-line-soft);
}
.fr-chipslot:nth-last-child(-n+3) { border-bottom:none; }

/* ── 咨询：单独一块（输入 + 快捷问题 + 回答区，块内闭合） ── */
.fr-ask-b { gap:8px; }
.fr-ask-row { display:flex; gap:6px; align-items:center; flex:0 0 auto; }
.fr-ask-in { flex:1 1 auto; min-width:0; }
.fr-ask-ta { resize:vertical; min-height:46px; max-height:140px; line-height:1.55; font-family:inherit; }
.fr-ask-row { align-items:flex-end; }
.fr-ask-go { flex:0 0 auto; }
.fr-ask-qs { display:flex; flex-wrap:wrap; gap:5px; flex:0 0 auto; }
.fr-ask-q {
  font-size:10.5px; color:var(--ddp-faint); border:1px solid var(--ddp-line-soft);
  border-radius:2px; padding:2px 7px; letter-spacing:.02em;
}
.fr-ask-gap { height:2px; }
.fr-ask-b > .fr-slot.grow { flex:1 1 auto; min-height:0; overflow:hidden; }

/* 版式 B：顶部快讯横带 → 上排（头条 | 咨询）→ 下排（精选 | 新出现） */
.ddp-row { flex:1 1 0; min-height:0; display:grid; gap:12px; padding:12px 24px 0; }
.ddp-row-top { grid-template-columns:1.15fr 1fr; flex:1.12 1 0; }
.ddp-row-bot { grid-template-columns:1fr 1fr; }
.ddp-frame .ddp-wire { flex:0 0 112px; margin:12px 24px 0; }



/* A/B/C 切换 */
.fr-tabs { display:flex; gap:4px; margin-right:10px; }
.fr-tab {
  font-family:var(--ddp-mono); font-size:10px; letter-spacing:.1em; padding:2px 8px;
  border:1px solid var(--ddp-line); background:transparent; color:var(--ddp-faint); cursor:pointer; border-radius:2px;
}
.fr-tab.on { border-color:var(--ddp-accent); color:var(--ddp-accent); }

/* 版式主体容器 */
.ddp-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }

/* B：两行两列 */
.ddp-grid-b {
  flex:1 1 auto; min-height:0; display:grid; gap:12px; padding:10px 20px 0;
  grid-template-columns:1.45fr 1fr; grid-template-rows:1.02fr 1fr;
}
.ddp-wire.inline { flex:1 1 auto; margin:0; min-height:0; }

/* C：分页卡 */
.ddp-c { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; padding:10px 20px 0; }
.fr-lead-strip {
  flex:0 0 auto; display:flex; align-items:baseline; gap:14px;
  padding:0 0 8px; border-bottom:1px solid var(--ddp-line-soft);
}
.fr-lead-strip b { font-family:var(--ddp-serif); font-size:15px; font-weight:600; }
.fr-lead-strip span { font-size:11.5px; color:var(--ddp-dim); }
.fr-lead-strip .fr-strip-meta { margin-left:auto; font-family:var(--ddp-mono); font-size:10.5px; color:var(--ddp-faint); }
.fr-tabs2 { flex:0 0 auto; display:flex; gap:2px; margin-top:8px; border-bottom:1px solid var(--ddp-line); }
.fr-tab2 {
  font-size:11.5px; padding:5px 13px; border:1px solid transparent; border-bottom:none;
  background:transparent; color:var(--ddp-faint); cursor:pointer; border-radius:2px 2px 0 0;
}
.fr-tab2.on { color:var(--ddp-ink); border-color:var(--ddp-line); background:rgba(12,13,18,.6); }
.ddp-c .ddp-col { flex:1 1 auto; min-height:0; margin-top:8px; }
.ddp-wire {
  flex:0 0 126px; margin:12px 20px 0; display:flex; flex-direction:column; min-height:0;
  border:1px solid var(--ddp-line-soft); background:rgba(12,13,18,.55); border-radius:3px;
}
.ddp-wire-b { flex:1 1 auto; min-height:0; overflow:hidden; padding:4px 12px 6px; display:grid; grid-template-columns:repeat(3,1fr); gap:0 18px; }
.fr-chip {
  display:grid; grid-template-columns:12px 1fr auto; gap:7px; align-items:baseline;
  padding:4px 0; border-bottom:1px solid var(--ddp-line-soft); font-size:10.5px; min-width:0;
}
.fr-chip b { font-family:var(--ddp-mono); font-weight:400; color:var(--ddp-accent); }
.fr-chip span { color:var(--ddp-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fr-chip em { font-style:normal; font-family:var(--ddp-mono); color:var(--ddp-faint); }
.ddp-frame .ddp-foot { flex:0 0 auto; margin:10px 24px 0; }

/* ── 骨架转真内容后补的零件 ── */
.fr-list { display:flex; flex-direction:column; min-height:0; }
.fr-row {
  flex:0 0 auto; display:grid; grid-template-columns:16px 1fr 58px; gap:9px; align-items:start;
  padding:6px 0; border-bottom:1px solid var(--ddp-line-soft);
}
.fr-row:last-of-type { border-bottom:none; }
.fr-chipslot { padding:0; border-bottom:none; }
.fr-chip { border-bottom:none; padding:2px 0; cursor:pointer; }
.fr-chip:hover span { color:var(--ddp-ink); }
.fr-name { cursor:pointer; }
.fr-name:hover { color:var(--ddp-accent); }
.fr-mini {
  margin-top:4px; border:1px solid var(--ddp-line-soft); background:transparent;
  color:var(--ddp-faint); font-size:9.5px; padding:1px 6px; border-radius:2px; cursor:pointer;
}
.fr-mini:hover { border-color:var(--ddp-accent); color:var(--ddp-accent); }
.fr-emptynote { font-size:11px; color:var(--ddp-faint); padding:6px 0; }
.fr-lead { display:flex; flex-direction:column; min-height:0; }
.fr-ans {
  font-size:11.5px; line-height:1.7; color:var(--ddp-ink);
  white-space:pre-wrap; word-break:break-word;
}
.fr-ans.err { color:#e2a08a; }
.fr-ans-meta { margin-top:6px; font-family:var(--ddp-mono); font-size:9.5px; color:var(--ddp-faint); }
.fr-ask-q { background:transparent; cursor:pointer; font-family:inherit; }
.fr-ask-q:hover { border-color:var(--ddp-accent); color:var(--ddp-accent); }
.fr-ask-q:disabled { opacity:.5; cursor:default; }
.fr-ask-b > .fr-slot.grow { overflow:auto; }
`;

    /* ───────────────────────── 中文摘要：缓存与裁剪 ─────────────────────────
       为什么要有缓存：每开一次面板都让模型润色十几条英文描述，既慢又费钱，还容易被限流。
       所以只缓存"面板上真正展示过"的条目，并且有明确上限：
         · 条数上限 INTRO_KEEP（按"最久没被用过"淘汰）→ 缓存不会随天数无限堆；
         · 键里带 pushedAt 校验 → 仓库更新了会重算，不会拿旧介绍糊弄；
         · 版本号进键名（:v1）→ 以后改 prompt 只抬版本号，老缓存整块作废；
         · localStorage 写满/被禁 → 清掉重来，退化成"每次都现算"，绝不报错。
       体量估算：面板每天最多十几条 × 每条约 0.4 KB → 上限 200 条时也就 ~80 KB。  */

    const INTRO_URL = '/api/daily-consult.intros';
    const INSTALLED_URL = '/api/daily-consult.installed';
    const ZH_URL = '/api/daily-consult.zh';
    const INTRO_KEY = 'dsh-daily-push:intro:v1';
    const INTRO_KEEP = 200;
    const INTRO_BATCH = 12;

    function readIntroCache() {
      try {
        const raw = window.localStorage.getItem(INTRO_KEY);
        if (!raw) return {};
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : {};
      } catch {
        return {};
      }
    }

    function writeIntroCache(cache) {
      try {
        const keys = Object.keys(cache);
        if (keys.length > INTRO_KEEP) {
          keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0));
          for (const k of keys.slice(0, keys.length - INTRO_KEEP)) delete cache[k];
        }
        window.localStorage.setItem(INTRO_KEY, JSON.stringify(cache));
      } catch {
        try {
          window.localStorage.removeItem(INTRO_KEY);
        } catch {
          /* 禁用站点数据：只是没缓存，不影响展示 */
        }
      }
    }

    /** 缓存命中条件：条目本身没变（pushedAt 相同）。*/
    function cachedIntro(cache, p) {
      if (!p || !p.fullName) return null;
      const rec = cache[p.fullName];
      if (!rec || !rec.one) return null;
      if (p.pushedAt && rec.up && rec.up !== p.pushedAt) return null;
      return rec;
    }

    /**
     * 读润色流（NDJSON：一行一条 {"t":"item","name":…,"one":…}）。
     * 每收到一条就回调一次，所以表格是一行一行亮起来的，不是等全部算完才出现。
     * 老格式（一次返回 JSON 数组）也兼容：拿不到 body 流就整体解析。
     */
    async function readIntroStream(res, onItem) {
      const type = res.headers && res.headers.get ? String(res.headers.get('content-type') || '') : '';
      if (type.indexOf('json') >= 0 && type.indexOf('ndjson') < 0) {
        const doc = await res.json();
        const rows = doc && Array.isArray(doc.data) ? doc.data : [];
        for (const row of rows) if (row && row.name && row.one) onItem(row);
        return;
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        const doc = await res.json();
        for (const row of (doc && doc.data) || []) if (row && row.name && row.one) onItem(row);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const eat = (line) => {
        const s = line.trim();
        if (!s) return;
        let msg;
        try {
          msg = JSON.parse(s);
        } catch {
          return;
        }
        if (msg && msg.t === 'item' && msg.name && msg.one) onItem(msg);
      };
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buf += decoder.decode(step.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          eat(line);
        }
      }
      eat(buf);
    }

    /* ───────────────────────── 计算 ───────────────────────── */

    function pickNew(plugins) {
      return plugins
        .filter((p) => !p.excluded && daysBetween(p.createdAt) <= NEW_WINDOW_DAYS)
        .sort((a, b) => (b.stars || 0) - (a.stars || 0))
        .slice(0, 6);
    }

    function pickToday(plugins, refMs) {
      const base = typeof refMs === 'number' && refMs > 0 ? refMs : Date.now();
      const fresh = plugins.filter((p) => !p.excluded && daysBetween(p.pushedAt, base) <= 2);
      const pool = fresh.length ? fresh : plugins.filter((p) => !p.excluded && daysBetween(p.pushedAt, base) <= FRESH_WINDOW_DAYS);
      return pool.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 6);
    }

    function pickRising(plugins, prevStars) {
      if (!prevStars) return [];
      const rows = [];
      for (const p of plugins) {
        if (p.excluded) continue;
        const before = prevStars[p.fullName];
        if (typeof before !== 'number') continue;
        const delta = (p.stars || 0) - before;
        if (delta > 0) rows.push({ plugin: p, delta });
      }
      rows.sort((a, b) => b.delta - a.delta);
      return rows.slice(0, 6);
    }

    function starsMap(plugins) {
      const out = {};
      for (const p of plugins) if (p.fullName) out[p.fullName] = p.stars || 0;
      return out;
    }

    /** 3700 → 3.7k，报纸上数字要短。*/
    function fmtStars(n) {
      const v = n || 0;
      if (v >= 10000) return Math.round(v / 1000) + 'k';
      if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
      return String(v);
    }

    /* ───────────────────────── 小组件 ───────────────────────── */

    /** 安装命令：和 DSH 文档里的一致，profile 固定 web。*/
    function installCmd(p) {
      return 'dsh plugin --profile web add github:' + String((p && p.fullName) || '');
    }

    function repoUrl(p) {
      const url = p && p.url ? String(p.url) : '';
      if (/^https?:\/\//i.test(url)) return url;
      return 'https://github.com/' + String((p && p.fullName) || '');
    }

    /** 明显不是仓库名/用户的词，避免把 https://github.com/... 里的片段当成 owner/repo。*/
    const SLUG_STOP = { http: 1, https: 1, www: 1, github: 1, com: 1, io: 1, org: 1, net: 1, dev: 1, zip: 1, api: 1, raw: 1, git: 1 };

    /** 从一段文字里扫出 owner/repo（URL 内部不算，避免误伤）。 */
    function scanSlugs(text) {
      const str = String(text || '');
      const out = [];
      const re = /(^|[^\w./@-])([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)/g;
      let m;
      while ((m = re.exec(str))) {
        const pre = m[1] || '';
        const a = m[2];
        const b = m[3];
        if (SLUG_STOP[a.toLowerCase()] || SLUG_STOP[b.toLowerCase()]) continue;
        if (!/[A-Za-z]/.test(a) || !/[A-Za-z]/.test(b)) continue;
        if (a.length < 2 || b.length < 2) continue;
        const start = m.index + pre.length;
        out.push({ slug: a + '/' + b, start: start, end: start + a.length + 1 + b.length });
      }
      return out;
    }

    /** 答完后列出参考仓库：先放锁定的那个，再按正文里出现顺序去重。*/
    function collectRefs(text, resolved) {
      const out = [];
      const seen = {};
      const push = (slug) => {
        const k = String(slug || '').toLowerCase();
        if (!k || seen[k]) return;
        seen[k] = 1;
        out.push(slug);
      };
      if (resolved) push(resolved);
      String(text || '').split(/(https?:\/\/[^\s)）】,，;；]+)/g).forEach((seg) => {
        if (/^https?:\/\//i.test(seg)) {
          const m = seg.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)/i);
          if (m) push(m[1].replace(/\.git$/i, ''));
          return;
        }
        scanSlugs(seg).forEach((x) => push(x.slug));
      });
      return out.slice(0, 6);
    }

    /** 正文里把 owner/repo 变成 GitHub 链接，其余原样保留。*/
    function linkifyText(text) {
      const str = String(text || '');
      const nodes = [];
      let key = 0;
      str.split(/(https?:\/\/[^\s)）】,，;；]+)/g).forEach((seg) => {
        if (!seg) return;
        if (/^https?:\/\//i.test(seg)) {
          const m = seg.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)/i);
          nodes.push(
            h(
              'a',
              { key: key++, className: 'fr-a', href: seg, target: '_blank', rel: 'noreferrer' },
              m ? m[1].replace(/\.git$/i, '') : seg,
            ),
          );
          return;
        }
        let last = 0;
        scanSlugs(seg).forEach((x) => {
          if (x.start > last) nodes.push(seg.slice(last, x.start));
          nodes.push(
            h(
              'a',
              {
                key: key++,
                className: 'fr-a',
                href: 'https://github.com/' + x.slug,
                target: '_blank',
                rel: 'noreferrer',
              },
              x.slug,
            ),
          );
          last = x.end;
        });
        if (last < seg.length) nodes.push(seg.slice(last));
      });
      return nodes.length ? nodes : str;
    }

    /** 参考条里的一枚仓库：名字可点、能复制 clone、能下 ZIP。*/
    function RefChip(props) {
      const name = String(props.name || '');
      const url = 'https://github.com/' + name;
      const clone = 'git clone ' + url + '.git';
      const [done, setDone] = useState('');
      const onCopy = () => {
        copyText(clone);
        setDone('1');
        setTimeout(() => setDone(''), 1200);
      };
      const [watching, setWatching] = useState(props.watched ? 'on' : '');
      const onWatch = () => {
        if (watching === 'on' || watching === 'busy') return;
        setWatching('busy');
        fetch('/api/daily-consult.watch.edit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'add', repo: name }),
        })
          .then((r) => r.json())
          .then((j) => setWatching(j && j.ok ? 'on' : 'err'))
          .catch(() => setWatching('err'));
      };
      return h(
        'span',
        { className: 'fr-ref' },
        h('a', { className: 'fr-ref-n', href: url, target: '_blank', rel: 'noreferrer', title: url }, name),
        h('button', { className: 'fr-ref-b', onClick: onCopy, title: clone }, done ? '已复制' : 'clone'),
        h(
          'button',
          {
            className: 'fr-ref-b' + (watching === 'on' ? ' fr-ref-on' : ''),
            onClick: onWatch,
            title: watching === 'on' ? '已在「我关注的」里' : '加入「我关注的」，之后有更新会提醒',
            disabled: watching === 'on' || watching === 'busy',
          },
          watching === 'on' ? '已关注' : watching === 'busy' ? '…' : watching === 'err' ? '重试' : '☆关注',
        ),
        h(
          'a',
          {
            className: 'fr-ref-b',
            href: url + '/archive/HEAD.zip',
            target: '_blank',
            rel: 'noreferrer',
            title: '下载源码 ZIP',
          },
          'ZIP',
        ),
      );
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* 落到下面的兜底 */
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }

    /** 仓库名旁边的分类标签 + 已装标记。*/
    function Tags(props) {
      const p = props.plugin;
      const zh = zhIntro(p);
      const labels = [zh.label].concat(zh.extraLabels || []).filter(Boolean).slice(0, 2);
      return h(
        'span',
        { className: 'ddp-tags' },
        props.installed === true ? h('i', { className: 'ddp-installed' }, '已装') : null,
        labels.map((t) => h('i', { key: t }, t)),
      );
    }

    /** 「6 天前」这种短的更新时间，表格里不占地方。*/
    function agoShort(iso) {
      if (!iso) return '—';
      const d = daysBetween(iso);
      if (!Number.isFinite(d)) return '—';
      if (d < 1) return '今天';
      if (d < 30) return Math.round(d) + ' 天前';
      if (d < 365) return Math.round(d / 30) + ' 个月前';
      return Math.round(d / 365) + ' 年前';
    }

    function Masthead(props) {
      return h(
        'header',
        { className: 'ddp-mast' },
        h(
          'div',
          null,
          h('h1', null, '每日推送'),
          h(
            'div',
            { className: 'ddp-mast-sub' },
            props.registry ? '收录 ' + props.registry.total + ' 个仓库 · 榜单 ' + pubTime(props.registry.meta.generatedAt) : '正在取榜单…',
            ' · ',
            props.dateText,
          ),
        ),
        h(
          'div',
          { className: 'ddp-mast-tools' },
          h('button', { className: 'ddp-tool', onClick: props.onRefresh, disabled: props.loading }, props.loading ? '刷新中' : '刷新'),
        ),
      );
    }

    function StatBar(props) {
      return h(
        'div',
        { className: 'ddp-stats' },
        h('span', { className: 'ddp-stat' }, '今日精选', h('b', null, String(props.today))),
        h('span', { className: 'ddp-stat' }, '新出现', h('b', null, String(props.fresh))),
        h('span', { className: 'ddp-stat' }, '涨得最快', h('b', null, String(props.rising))),
        props.stale > 3 ? h('span', { className: 'ddp-stat ddp-warn' }, '榜单已', h('b', null, String(Math.round(props.stale))), ' 天未更新') : null,
      );
    }

    /** 咨询条：问一句，答在条下面，收起来就干净了。*/
    function AskStrip(props) {
      const a = props.answer;
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'ddp-ask' },
          h('span', { className: 'ddp-ask-k' }, '咨询'),
          h('input', {
            className: 'ddp-ask-in',
            value: props.value,
            placeholder: '贴个插件名 / 仓库链接，问它值不值得装…',
            onChange: (e) => props.onChange(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') props.onSend();
            },
          }),
          h('button', { className: 'ddp-btn ddp-btn-solid', onClick: props.onSend, disabled: props.running }, props.running ? '回答中' : '问'),
          props.model ? h('span', { className: 'ddp-ask-model' }, props.model.replace(/^.*\//, '')) : null,
        ),
        a
          ? h(
              'div',
              { className: 'ddp-answer' },
              h('div', { className: 'ddp-answer-q' }, '问：' + a.q),
              a.error
                ? h('div', { className: 'ddp-answer-err' }, '没问成：' + a.error)
                : h(
                    'div',
                    { className: 'ddp-answer-a' },
                    a.text,
                    a.running ? h('span', { className: 'ddp-delta' }) : null,
                  ),
              h(
                'div',
                { className: 'ddp-answer-f' },
                h('span', null, (a.meta || '') + (a.totalMs ? ' · ' + a.totalMs + 'ms' : '')),
                h('button', { className: 'ddp-mini', onClick: props.onClear }, '收起'),
              ),
            )
          : null,
      );
    }

    function LeadBox(props) {
      const p = props.plugin;
      const zh = props.zh;
      const cmd = installCmd(p);
      return h(
        'section',
        { className: 'ddp-lead' },
        h(
          'div',
          null,
          h('div', { className: 'ddp-kicker' }, '今日精选 · 头条'),
          h('h2', { className: 'ddp-lead-title' }, p.fullName),
          h(
            'p',
            { className: 'ddp-lede' },
            zh && zh.one ? zh.one : '正在生成介绍…',
            zh && zh.rule ? h('span', { className: 'ddp-polish' }, '润色中…') : null,
          ),
          h(
            'ul',
            { className: 'ddp-points' },
            zh && zh.a ? h('li', { key: 'a' }, h('b', null, '能做什么'), zh.a) : null,
            zh && zh.b ? h('li', { key: 'b' }, h('b', null, '注意什么'), zh.b) : null,
            props.why ? h('li', { key: 'why' }, h('b', null, '为什么是它'), props.why) : null,
          ),
          h(
            'div',
            { className: 'ddp-cmd' },
            h('span', { className: 'ddp-cmd-k' }, '安装'),
            h('code', null, cmd),
          ),
          h(
            'div',
            { className: 'ddp-acts' },
            h('button', { className: 'ddp-btn ddp-btn-solid', onClick: () => window.open(repoUrl(p), '_blank', 'noopener') }, '打开仓库'),
            h('button', { className: 'ddp-btn', onClick: () => copyText(cmd) }, '复制安装命令'),
            h('button', { className: 'ddp-btn', onClick: () => props.onAsk('「' + p.fullName + '」这个插件值不值得装？能干什么、有什么坑？') }, '问一下'),
          ),
        ),
        h(
          'aside',
          { className: 'ddp-facts' },
          h(
            'dl',
            null,
            h('dt', null, '排名'),
            h('dd', { className: 'ddp-num' }, props.rank ? '★ ' + props.rank + ' 位' : '—'),
            h('dt', null, '星标'),
            h('dd', { className: 'ddp-num' }, fmtStars(p.stars)),
            h('dt', null, '语言'),
            h('dd', null, p.language || '—'),
            h('dt', null, '许可'),
            h('dd', null, p.license || '—'),
            h('dt', null, '装了吗'),
            h(
              'dd',
              { className: props.installed === true ? 'ddp-on' : props.installed === false ? 'ddp-off' : 'ddp-off' },
              props.installed === true ? '本机已装' : props.installed === false ? '未装' : '—',
            ),
            h('dt', null, '更新'),
            h('dd', null, agoShort(p.pushedAt)),
          ),
        ),
      );
    }

    function Row(props) {
      const p = props.plugin;
      return h(
        'tr',
        null,
        h('td', { className: 'ddp-idx' }, String(props.index + 1)),
        h(
          'td',
          { className: 'ddp-repo' },
          h('a', { href: repoUrl(p), target: '_blank', rel: 'noopener noreferrer' }, p.fullName),
          h(Tags, { plugin: p, installed: props.installed }),
        ),
        h('td', { className: 'ddp-oneliner' }, props.one ? props.one : '—'),
        h('td', { className: 'ddp-lang' }, p.language || '—'),
        h('td', { className: 'ddp-upd' }, props.delta ? '+' + props.delta : agoShort(p.pushedAt)),
        h(
          'td',
          { className: 'ddp-ops' },
          h('button', { className: 'ddp-mini', onClick: () => copyText(installCmd(p)) }, '复制'),
          h('button', { className: 'ddp-mini', onClick: () => props.onAsk('「' + p.fullName + '」这个插件值不值得装？') }, '问一下'),
        ),
      );
    }

    function TableSect(props) {
      return h(
        'section',
        { className: 'ddp-sect' },
        h(
          'div',
          { className: 'ddp-sect-head' },
          h('h3', null, props.title),
          h('span', { className: 'ddp-hint' }, props.hint),
        ),
        props.rows && props.rows.length
          ? h(
              'table',
              { className: 'ddp-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '#'),
                  h('th', null, '仓库'),
                  h('th', null, '一句话'),
                  h('th', null, '语言'),
                  h('th', { className: 'ddp-upd' }, props.deltaHead || '更新'),
                  h('th', { className: 'ddp-ops' }, '操作'),
                ),
              ),
              h('tbody', null, props.rows),
            )
          : h('div', { className: 'ddp-empty' }, props.empty),
      );
    }

    function DailyPushTab() {
      const [registry, setRegistry] = useState(null);
      const [github, setGithub] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [prevStars, setPrevStars] = useState(() => (readSnapshot() || {}).stars || null);

      // 咨询条
      const [q, setQ] = useState('');
      const [answer, setAnswer] = useState(null);
      const [askModel, setAskModel] = useState('');

      // 中文摘要与"已装"标记
      const [introCache, setIntroCache] = useState(() => readIntroCache());
      const introRef = useRef(null);
      if (introRef.current === null) introRef.current = introCache;
      const [tried, setTried] = useState({});
      const [installed, setInstalled] = useState(null);
      const inflightSet = useRef({});

      const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        let doc = null;
        try {
          doc = await fetchJson(REGISTRY_URL, { cache: 'no-store' });
          if (!doc || !Array.isArray(doc.plugins)) throw new Error('榜单数据结构异常');
          setRegistry(doc);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
        let items = null;
        try {
          const gh = await fetchJson(GITHUB_SEARCH_URL, { headers: { accept: 'application/vnd.github+json' } });
          items = Array.isArray(gh.items) ? gh.items : [];
        } catch {
          items = null; // 没网 / 限流：这一栏直接不显示
        }
        setGithub(items);
        if (doc || items) {
          const current = doc ? starsMap(doc.plugins) : {};
          if (items) for (const r of items) current[r.full_name] = r.stargazers_count;
          setPrevStars((readSnapshot() || {}).stars || null);
          writeSnapshot(current);
        }
        setLoading(false);
      }, []);

      /** 问一句：走宿主同源端点，流式收；不建会话、不进侧边栏。*/
      const send = useCallback(async () => {
        const question = q.trim();
        if (!question) return;
        if (answer && answer.running) return;
        setAnswer({ q: question, text: '', meta: '', error: null, running: true, totalMs: 0 });
        const t0 = Date.now();
        let acc = '';
        try {
          const res = await fetch(CONSULT_ASK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
            body: JSON.stringify({ question }),
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          if (!res.body) throw new Error('浏览器没有 response.body，无法流式读取');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const step = await reader.read();
            if (step.done) break;
            buf += decoder.decode(step.value, { stream: true });
            let nl = buf.indexOf('\n');
            while (nl >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              nl = buf.indexOf('\n');
              if (!line.trim()) continue;
              let msg = null;
              try {
                msg = JSON.parse(line);
              } catch {
                continue;
              }
              if (msg.t === 'delta') {
                acc += msg.text;
                setAnswer((s) => (s ? Object.assign({}, s, { text: acc }) : s));
              } else if (msg.t === 'meta') {
                setAnswer((s) => (s ? Object.assign({}, s, { meta: msg.provider + ' / ' + msg.model }) : s));
              } else if (msg.t === 'error') {
                setAnswer((s) => (s ? Object.assign({}, s, { error: msg.message }) : s));
              }
            }
          }
          if (!acc) {
            setAnswer((s) => (s ? Object.assign({}, s, { error: s.error || '模型没有返回任何文字（宿主日志里有原因）' }) : s));
          }
          setAnswer((s) => (s ? Object.assign({}, s, { running: false, totalMs: Date.now() - t0 }) : s));
        } catch (err) {
          setAnswer((s) =>
            s ? Object.assign({}, s, { running: false, error: (err && err.message) || String(err) }) : s,
          );
        }
      }, [q, answer]);

      useEffect(() => {
        load();
      }, [load]);

      // 默认模型（显示用，拿不到就空着）
      useEffect(() => {
        let alive = true;
        fetch(CONSULT_HEALTH_URL, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (!alive || !j || !j.defaultSelection) return;
            const d = j.defaultSelection;
            setAskModel(d.provider + ' / ' + d.model);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      // 本机已装清单（一次就够；拿不到就全部显示「—」）
      useEffect(() => {
        let alive = true;
        fetch(INSTALLED_URL, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (!alive || !j || !j.ok || !Array.isArray(j.names)) return;
            setInstalled(j.names);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      useEffect(() => {
        ensureDdpCss();
      }, []);

      // GitHub 搜索结果转成和榜单同形的对象。
      const ghFresh = useMemo(
        () =>
          (github || [])
            .filter((r) => daysBetween(r.created_at) <= NEW_WINDOW_DAYS)
            .slice(0, 5)
            .map((r) => ({
              fullName: r.full_name,
              url: r.html_url,
              description: r.description || '',
              stars: r.stargazers_count,
              pushedAt: r.pushed_at,
              createdAt: r.created_at,
            })),
        [github],
      );

      const view = useMemo(() => {
        const plugins = registry ? registry.plugins : [];
        const tr = todayRef(plugins);
        const today = pickToday(plugins, tr.ref);
        const fresh = pickNew(plugins);
        const rising = pickRising([...plugins, ...ghFresh], prevStars);
        const lead = today.length ? today[0] : fresh.length ? fresh[0] : null;
        return { today, fresh, rising, lead, newest: tr.newest, staleDays: tr.stale };
      }, [registry, prevStars, ghFresh]);

      const isInstalled = (p) => {
        if (!installed) return null;
        const name = String(p.fullName || '');
        const short = name.split('/')[1] || name;
        for (const n of installed) {
          if (!n) continue;
          if (n === name || n === short || n.endsWith('/' + short)) return true;
        }
        return false;
      };

      // 规则生成的介绍第一帧就能显示（rule:true 表示还没被模型润色）。
      // 模型润色版回来后就地替换，页面永远不会有"介绍生成中"的空窗期。
      const introOf = (p) => {
        const hit = cachedIntro(introCache, p);
        if (hit) return hit;
        const zh = zhIntro(p);
        return { one: zh.intro, a: '', b: '', rule: true };
      };

      // 批量润色：一次 12 条，多批并发；服务端边生成边回，回一条就刷新一行。
      useEffect(() => {
        if (!view.lead) return;
        const wanted = [];
        const push = (p) => {
          if (p && p.fullName && !wanted.some((w) => w.fullName === p.fullName)) wanted.push(p);
        };
        push(view.lead);
        view.today.forEach(push);
        view.fresh.forEach(push);
        view.rising.forEach((r) => push(r.plugin));
        const missing = wanted.filter(
          (p) => !cachedIntro(introCache, p) && !tried[p.fullName] && !inflightSet.current[p.fullName],
        );
        if (!missing.length) return;

        const batches = [];
        for (let i = 0; i < missing.length; i += INTRO_BATCH) batches.push(missing.slice(i, i + INTRO_BATCH));

        batches.forEach((batch) => {
          for (const p of batch) inflightSet.current[p.fullName] = true;
          fetch(INTRO_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              items: batch.map((p) => ({
                name: p.fullName,
                desc: cleanText(p.description || '').slice(0, 420),
                topics: (p.topics || []).slice(0, 6),
                stars: p.stars || 0,
                lang: p.language || '',
              })),
            }),
          })
            .then((res) => {
              if (!res.ok) throw new Error('intros ' + res.status);
              return readIntroStream(res, (item) => {
                const src = batch.find((p) => p.fullName === item.name);
                const next = Object.assign({}, introRef.current);
                next[item.name] = {
                  one: item.one,
                  a: item.a || '',
                  b: item.b || '',
                  up: src ? src.pushedAt : '',
                  at: Date.now(),
                };
                introRef.current = next;
                writeIntroCache(next);
                setIntroCache(next);
              });
            })
            .catch(() => {
              /* 失败就保持规则版介绍，不再反复重试 */
            })
            .finally(() => {
              const marks = {};
              for (const p of batch) {
                delete inflightSet.current[p.fullName];
                marks[p.fullName] = true;
              }
              setTried((prev) => Object.assign({}, prev, marks));
            });
        });
      }, [view, introCache, tried]);

      const stale = registry ? daysBetween(registry.meta && registry.meta.generatedAt) : 0;
      const now = new Date();
      const dateText =
        now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日 · 星期' + '日一二三四五六'[now.getDay()];
      const lead = view.lead;
      const leadIntro = lead ? introOf(lead) : null;

      const askAbout = (text) => {
        setQ(text);
        setAnswer(null);
      };

      return h(
        'div',
        { className: 'ddp-sheet' },
        h(Masthead, { registry, loading, onRefresh: load, dateText }),

        h(StatBar, { today: view.today.length, fresh: view.fresh.length, rising: view.rising.length, stale }),

        h(AskStrip, {
          value: q,
          onChange: setQ,
          onSend: send,
          running: !!(answer && answer.running),
          model: askModel,
          answer,
          onClear: () => setAnswer(null),
        }),

        error
          ? h('div', { className: 'ddp-fail' }, '榜单数据加载失败：' + error + '（dsh-recommend/registry.json 由 dsh-recommend 的 web 半供给）')
          : null,

        loading && !registry
          ? h('div', { className: 'ddp-skel' }, [0, 1, 2, 3, 4].map((i) => h('i', { key: i })))
          : lead
            ? h(LeadBox, {
                plugin: lead,
                zh: leadIntro,
                rank: view.today.indexOf(lead) + 1,
                installed: isInstalled(lead),
                why: (function () {
                  const days = Math.round(daysBetween(lead.pushedAt) || 0);
                  const bits = [];
                  if (Number.isFinite(days) && days <= 30) bits.push('近 30 天有提交');
                  const rank = view.today.indexOf(lead) + 1;
                  if (rank > 0) bits.push('今日综合分第 ' + rank);
                  if (lead.stars) bits.push('星标 ' + fmtStars(lead.stars));
                  return bits.join(' · ');
                })(),
                onAsk: askAbout,
              })
            : h('div', { className: 'ddp-empty' }, loading ? '正在取榜单…' : '这一窗里没有仓库有动静。'),

        h(TableSect, {
          title: '今日精选',
          hint: '近 ' + FRESH_WINDOW_DAYS + ' 天有提交 · 综合分排序 · ' + view.today.length + ' 条',
          empty: '这一窗里没有刚提交过的仓库。',
          rows: view.today.map((p, i) =>
            h(Row, {
              key: p.fullName,
              plugin: p,
              index: i,
              one: (introOf(p) || {}).one,
              installed: isInstalled(p),
              onAsk: askAbout,
            }),
          ),
        }),

        h(TableSect, {
          title: '新出现',
          hint: '近 ' + NEW_WINDOW_DAYS + ' 天收录 · 按星数 · ' + view.fresh.length + ' 条',
          empty: '这一窗里没有新仓库记录（上游停更时会是空）。',
          rows: view.fresh.map((p, i) =>
            h(Row, {
              key: p.fullName,
              plugin: p,
              index: i,
              one: (introOf(p) || {}).one,
              installed: isInstalled(p),
              onAsk: askAbout,
            }),
          ),
        }),

        prevStars
          ? h(TableSect, {
              title: '涨得最快',
              hint: '和上次打开时比 · star 增量',
              deltaHead: '增量',
              empty: '还没有涨幅为正的仓库。',
              rows: view.rising.map((r, i) =>
                h(Row, {
                  key: r.plugin.fullName,
                  plugin: r.plugin,
                  index: i,
                  delta: r.delta,
                  one: (introOf(r.plugin) || {}).one,
                  installed: isInstalled(r.plugin),
                  onAsk: askAbout,
                }),
              ),
            })
          : null,

        ghFresh.length
          ? h(TableSect, {
              title: 'GitHub 实时',
              hint: 'topic:dsh-plugin · 按星排序',
              empty: '',
              rows: ghFresh.map((p, i) =>
                h(Row, { key: p.fullName, plugin: p, index: i, one: (introOf(p) || {}).one, installed: isInstalled(p), onAsk: askAbout }),
              ),
            })
          : null,

        h(
          'footer',
          { className: 'ddp-foot' },
          h('span', null, '数据 dsh-recommend + GitHub · 中文介绍由本地模型生成并缓存（最多 200 条，按最久未用淘汰）'),
          h('span', null, '收录不等于安全背书，装之前先看一眼源码'),
        ),
      );
    }

    /* ───────────────────────── 版式 A：三栏看板骨架 ─────────────────────────
       这一版先只把「块」搭出来：报头 / 统计 / 咨询 / 头条 + 两张清单 / 快讯 / 页脚。
       全部固定在一屏里，谁超出谁在自己块里滚。数据接线留到下一步。
       想切回完整内容版：控制台执行 window.__DDP_FRAME = false 再刷新。  */

    /* 样式只注入一次；骨架版和内容版共用（以前只在内容版里注入，切成骨架就没样式了）。*/
    /** 参考条与正文链接的样式，单独一段，避免动到主样式表。*/
    const REF_CSS = [
      '.fr-a{color:#79b8ff;text-decoration:none;border-bottom:1px solid rgba(121,184,255,.35);}',
      '.fr-a:hover{border-bottom-color:#79b8ff;}',
      '.fr-refs{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--ddp-line);}',
      '.fr-refs-k{font-size:10px;letter-spacing:.12em;color:var(--ddp-faint);}',
      '.fr-ref{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border:1px solid var(--ddp-line);border-radius:999px;background:rgba(255,255,255,.03);}',
      '.fr-ref-n{font-family:var(--ddp-mono);font-size:11px;color:var(--ddp-ink);text-decoration:none;}',
      '.fr-ref-n:hover{color:#79b8ff;}',
      '.fr-ref-b{border:none;background:transparent;color:var(--ddp-faint);font-size:10.5px;cursor:pointer;padding:0 2px;text-decoration:none;font-family:var(--ddp-mono);}',
      '.fr-ref-b:hover{color:var(--ddp-ink);}',
      '.fr-ref-on{color:#79b8ff !important;cursor:default;}',
      '.fr-ref-b:disabled{cursor:default;}',
    ].join('');
    /* 包名 → 中文功能名。认不出来的包直接显示包名，不编造。 */
    const PLUGIN_ZH = {
      "dsh-better-sidebar": "侧边栏增强",
      "dsh-session-manager": "会话管理",
      "dsh-synapse": "非线性会话画布",
      "dsh-whale-widget": "余额小鲸鱼挂件",
      "dsh-daily-push": "每日推送",
      "dsh-plugin-wallpaper-engine": "动态壁纸",
      "dsh-worktable": "工作台",
      "dsh-codex": "Codex / ChatGPT 接入",
      "dsh-multiagent-console": "多代理控制台",
      "dsh-office-tools": "Office 文档工具",
      "canvas-workbench": "画布工作台",
      "billion-context": "上下文压缩",
      "dsh-token-ledger-pro": "Token 计费账本",
      "dsh-godot-skill": "Godot 游戏开发技能",
      "dsh-recommend": "插件排行",
      "what-sub-agents-doing-now": "子代理进度观测",
      "dsh-market": "插件市场（壳）",
      "safer-dsh-market": "安全市场",
      "@firetruck666/dsh-task-board": "任务看板",
      "dsh-acl-sandbox-patch": "沙箱权限补丁",
      "godot-tools-dsh-plugin": "Godot 工具"
    };
    function zhLabel(name) {
      return PLUGIN_ZH[name] || '';
    }
    /* 去掉 dsh- 前缀和作用域，留个短名字给变化条目用。 */
    function shortPkg(name) {
      const s0 = String(name || '');
      const bare = s0.indexOf('/') >= 0 ? s0.slice(s0.lastIndexOf('/') + 1) : s0;
      return bare.replace(/^dsh-/, '');
    }
    const WATCH_CSS = [
      '.ddp-wc-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.ddp-wc-zh{color:var(--ddp-accent);font-weight:600;font-size:13px;}',
      '.ddp-wc-pkg{font-family:var(--ddp-mono);font-size:11px;color:var(--ddp-faint);}',
      '.ddp-wc-txt{font-size:12px;color:var(--ddp-dim);margin-top:2px;}',
      '.ddp-wc-sub{font-size:11.5px;color:var(--ddp-faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ddp-watch-zh{color:var(--ddp-ink);font-weight:600;font-size:13.5px;}',
      '.ddp-watch-pkg{font-family:var(--ddp-mono);font-size:11px;color:var(--ddp-faint);}',
      '.ddp-watch-pkg:hover{color:var(--ddp-accent);}',
    ].join('');
    function ensureDdpCss() {
      if (typeof document === 'undefined' || !document.head) return;
      let style = document.getElementById('ddp-css');
      if (!style) {
        style = document.createElement('style');
        style.id = 'ddp-css';
        document.head.appendChild(style);
      }
      style.textContent = CSS + REF_CSS + WATCH_CSS + BADGE_CSS + DENSE_CSS + ZH_CSS;
    }

    const FRAME_MODE = (function () {
      try {
        if (typeof window !== 'undefined' && window.__DDP_FRAME === false) return false;
      } catch (err) {
        /* 拿不到 window 就当骨架 */
      }
      return true;
    })();

    const SK_PER_COL = 5;

    /* 问题里出现的"像仓库名"的片段：owner/repo 或裸的 repo 名。 */
    /* 用户输入里常见的噪声词：以前把它们当仓库名去匹配，会匹配到 CSA/https 这种离谱结果 */
    const REPO_STOP = {
      https: 1, http: 1, github: 1, 'github.com': 1, com: 1, www: 1, git: 1, io: 1, html: 1,
      index: 1, blob: 1, tree: 1, main: 1, master: 1, raw: 1, readme: 1, issue: 1, issues: 1, releases: 1,
    };

    /** 从输入里认出 owner/repo：完整 GitHub 链接、owner/repo、带 .git / 带后续路径都认。
        旧写法用裸正则会从 https://github.com/a/b 里抠出 "github.com/a"，导致后面全对不上。 */
    function parseRepoRef(text) {
      const s0 = String(text == null ? '' : text);
      /* 1) 明确指向 GitHub 的链接（含 .git、后续路径、查询串） */
      const gh = s0.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[\s\/#?]|$)/i);
      if (gh) return { owner: gh[1], repo: gh[2].replace(/\.git$/i, '') };
      /* 2) 其他站点的链接：跳过域名，取第一段路径 owner/repo */
      const web = s0.match(/[a-z][a-z0-9+.-]*:\/\/[^\s\/]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?![A-Za-z0-9_.\/-])/i);
      if (web && !REPO_STOP[web[1].toLowerCase()]) return { owner: web[1], repo: web[2].replace(/\.git$/i, '') };
      /* 3) 手写的 owner/repo：owner 不能是 https / github 这类噪声词（repo 允许任何名字，比如 CSA/https） */
      const bare = s0.match(/(?:^|[^A-Za-z0-9_.\/-])([A-Za-z0-9_.-]{2,})\/([A-Za-z0-9_.-]{2,})(?![A-Za-z0-9_.\/-])/);
      if (bare && !REPO_STOP[bare[1].toLowerCase()] && bare[1].indexOf('.') < 0) {
        return { owner: bare[1], repo: bare[2].replace(/\.git$/i, '') };
      }
      return null;
    }

    function repoWords(q) {
      const text = String(q || '');
      const words = text.match(/[A-Za-z0-9_.-]{3,}/g) || [];
      const seen = {};
      const out = [];
      for (const w of words) {
        const k = w.toLowerCase();
        if (seen[k]) continue;
        seen[k] = 1;
        out.push(w);
      }
      return out;
    }

    /* 把一句话拆成能用来找仓库的片段：英文名（≥2 字符，够短的片段也能命中）和中文词（≥2 字）。
       用户经常只记得半截名字（"rea"、"rever"）或者干脆只说用途（"逆向"），不能要求他写全 owner/repo。 */
    function queryTokens(q) {
      const text = String(q || '');
      const out = [];
      const seen = {};
      const push = (w) => {
        const v = String(w == null ? '' : w).replace(/^[-._]+|[-._]+$/g, '');
        const k = v.toLowerCase();
        if (!k || k.length < 2 || seen[k] || REPO_STOP[k]) return;
        seen[k] = 1;
        out.push(v);
      };
      for (const w of text.match(/[A-Za-z0-9_.-]{2,}/g) || []) push(w);
      for (const w of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) push(w);
      return out;
    }

    /* 打分：名字全等最高，其次前缀、包含、owner/全名包含，再退到描述与标签。
       "rea" 会先给 morluto/rea（全等 1000），而不是被某个描述里恰好含 rea 的大仓库顶掉。 */
    /* 中文意图 → 英文关键词。榜单里的 description/topics 绝大多数是英文，
       只拿"逆向"两个字去比英文描述是比不上的，得先翻成 reverse 这一组。 */
    const ZH_CONCEPTS = [
      [/逆向|反编译|脱壳|破解|反汇编/, ['reverse', 'reverse-engineer', 'disassembl', 'decompil', 'ghidra', 'ida', 'binary']],
      [/壁纸|桌面美化|动态壁纸|桌面背景/, ['wallpaper', 'live-wallpaper', 'scene', 'desktop-bg']],
      [/爬虫|抓取|采集|蜘蛛/, ['crawl', 'spider', 'scrap', 'crawler']],
      [/语音|朗读|配音|念稿|播报/, ['tts', 'voice', 'speech', 'narrat']],
      [/音乐|音频|歌曲|作曲/, ['music', 'audio', 'song', 'melody']],
      [/视频|剪辑|动画/, ['video', 'clip', 'edit', 'animation']],
      [/图片|图像|生图|绘图|画图|截图/, ['image', 'picture', 'photo', 'paint', 'screenshot', 'vision']],
      [/记忆|长期记忆|回忆/, ['memory', 'recall', 'remember']],
      [/压缩|上下文|摘要/, ['compact', 'context', 'compress', 'summar']],
      [/搜索|检索|查找/, ['search', 'find', 'query', 'retriev']],
      [/翻译|多语言/, ['translat', 'i18n', 'locale']],
      [/文档|表格|幻灯片|演示/, ['docx', 'xlsx', 'pptx', 'document', 'office', 'presentation']],
      [/任务|看板|待办|清单/, ['task', 'todo', 'kanban', 'board', 'project']],
      [/画布|设计|排版|海报/, ['canvas', 'design', 'draw', 'layout', 'poster']],
      [/游戏|引擎/, ['game', 'godot', 'unity', 'engine']],
      [/安全|审计|权限|沙箱/, ['security', 'audit', 'acl', 'sandbox', 'permission']],
      [/用量|花费|计费|成本|余额/, ['usage', 'token', 'ledger', 'cost', 'billing', 'quota']],
      [/会话|历史|聊天记录/, ['session', 'history', 'conversation', 'chat']],
      [/侧边栏|界面|主题|美化/, ['sidebar', 'theme', 'ui', 'skin', 'beautif']],
      [/市场|插件商店/, ['market', 'registry', 'store']],
    ];

    /* 把一个词扩成一组：原词 + 同义英文词（中文才扩）。 */
    function expandToken(token) {
      const t = String(token || '').toLowerCase();
      const out = [t];
      if (!/[\u4e00-\u9fa5]/.test(t)) return out;
      for (const row of ZH_CONCEPTS) {
        if (row[0].test(t)) {
          for (const w of row[1]) if (out.indexOf(w) < 0) out.push(w);
          break;
        }
      }
      return out;
    }

    /* dsh- / dsh-plugin- / plugin- 这些前缀是壳的固定词，比前缀时先剥掉 */
    function repoCore(repo) {
      return String(repo || '').replace(/^(dsh|plugin|dsh-plugin)[-_]/i, '');
    }

    function scoreOne(p, t, weight) {
      const full = String(p.fullName || '').toLowerCase();
      const repo = full.split('/')[1] || '';
      const core = repoCore(repo);
      const desc = String(p.description || '').toLowerCase();
      const topics = Array.isArray(p.topics) ? p.topics.join(' ').toLowerCase() : '';
      let s = 0;
      if (repo === t) s = 1000;
      else if (t.length < 3 && !/[\u4e00-\u9fa5]/.test(t)) return 0; /* 一两个英文字符只认全等，否则全是噪声 */
      else if (core.indexOf(t) === 0) s = 620;
      else if (repo.indexOf(t) === 0) s = 600;
      else if (repo.indexOf(t) > 0) s = 460;
      else if (full.indexOf(t) >= 0) s = 380;
      else if (desc.indexOf(t) >= 0) s = 220;
      else if (topics.indexOf(t) >= 0) s = 150;
      if (!s) return 0;
      return Math.round(s * weight);
    }

    function scoreMatch(p, token) {
      const list = expandToken(token);
      let best = 0;
      for (let i = 0; i < list.length; i++) {
        const s = scoreOne(p, list[i], i === 0 ? 1 : 0.9);
        if (s > best) best = s;
      }
      if (!best) return 0;
      return best + Math.min(80, Math.log(Math.max(1, p.stars || 0)) * 6);
    }

    /* 在榜单里找候选：先按片段逐个试，名字全等的算"锁定"，其余按相关度排成"相近"。 */
    function findCandidates(q, registry, limit) {
      const max = limit || 5;
      const plugins = registry && Array.isArray(registry.plugins) ? registry.plugins : [];
      if (!plugins.length) return { exact: [], near: [], tokens: [] };
      const ref = parseRepoRef(q);
      const tokens = ref ? [ref.owner + '/' + ref.repo] : queryTokens(q);
      for (const w of tokens) {
        if (w.indexOf('/') >= 0) {
          const want = String(w).toLowerCase();
          const same = plugins.filter((p) => String(p.fullName || '').toLowerCase() === want);
          if (same.length) return { exact: same, near: [], tokens };
          continue;
        }
        const scored = [];
        for (const p of plugins) {
          const sc = scoreMatch(p, w);
          if (sc > 0) scored.push({ p: p, s: sc });
        }
        if (!scored.length) continue;
        scored.sort((a, b) => b.s - a.s || (b.p.stars || 0) - (a.p.stars || 0));
        const exact = scored.filter((x) => x.s >= 1000).map((x) => x.p).slice(0, max);
        const near = scored.filter((x) => x.s < 1000).map((x) => x.p).slice(0, max);
        return { exact: exact, near: near, tokens: tokens };
      }
      return { exact: [], near: [], tokens: tokens };
    }

    /* 一行候选：owner/repo · ★ · 几天前更新 */
    function candidateLine(p) {
      const bits = [String(p.fullName || '')];
      if (p.stars) bits.push('★' + fmtStars(p.stars));
      const d = Math.round(daysBetween(p.pushedAt) || 0);
      if (p.pushedAt) bits.push(d <= 0 ? '今天更新' : d + ' 天前更新');
      return bits.join(' · ');
    }

    /**
     * 把"本机已装了什么"和"榜单里这个仓库的元数据"拼到问题前面。
     * 为什么是客户端拼：宿主半只收一个 question 字符串，拼在这里不用多开端点，
     * 而且用户能一眼看到自己问的到底是哪句话（前后用【问题】分开）。
     * 用户手动贴 README 时，这段前置信息也不影响模型读原文。
     * 第四参数 hits：外面已经解析好的候选（榜单 + GitHub 搜索），优先用它，免得重复查。
     */
    function buildConsultQuestion(question, ctx, hits) {
      const q = String(question == null ? '' : question).trim();
      if (!q) return q;
      const lines = [];
      const resolved = [];

      const inst = (ctx && ctx.installed) || [];
      if (inst.length) {
        const names = inst.slice(0, 200).map((n) => String(n)).filter(Boolean);
        if (names.length) {
          lines.push(
            '【本机已装】' + names.join(', ') + (inst.length > names.length ? ' …（共 ' + inst.length + ' 个）' : ''),
          );
        }
      }

      /* 只有带 - . _ 的 ASCII 片段才当成仓库名，中文句子和普通英文词不硬套 */
      const repoish = repoWords(q).some((w) => /[-._]/.test(w));

      /* 1) 已经在问题里写了 owner/repo 的，按它查榜单 */
      const ref = parseRepoRef(q);
      let found = null;
      if (ref && ctx && ctx.registry && Array.isArray(ctx.registry.plugins)) {
        const want = (ref.owner + '/' + ref.repo).toLowerCase();
        found = ctx.registry.plugins.find((p) => String(p.fullName || '').toLowerCase() === want) || null;
      }
      if (found) {
        const bits = [];
        if (found.stars) bits.push('★' + fmtStars(found.stars));
        if (found.language) bits.push(String(found.language));
        if (found.license) bits.push(String(found.license));
        const d = Math.round(daysBetween(found.pushedAt) || 0);
        bits.push(d <= 0 ? '今天更新' : d + ' 天前更新');
        lines.push('【榜单信息】' + found.fullName + ' · ' + bits.join(' · '));
        const zh = ctx.introOf ? ctx.introOf(found) : null;
        if (zh && zh.one) lines.push('【中文简介】' + zh.one);
        resolved.push(found);
      }

      /* 1.5) 榜单里没有，但用户给了明确的 owner/repo：直接用 GitHub 接口要这一条的真实数据 */
      if (!found && ref) {
        const remote = hits && hits.remote;
        if (remote) {
          const bits = [];
          if (remote.stars) bits.push('★' + fmtStars(remote.stars));
          if (remote.language) bits.push(String(remote.language));
          if (remote.license) bits.push(String(remote.license));
          if (remote.pushedAt) {
            const dd = Math.round(daysBetween(remote.pushedAt) || 0);
            bits.push(dd <= 0 ? '今天更新' : dd + ' 天前更新');
          }
          lines.push('【GitHub 仓库信息】' + remote.fullName + ' · ' + bits.join(' · '));
          if (remote.desc) lines.push('【仓库描述】' + String(remote.desc).slice(0, 300));
          if (remote.topics && remote.topics.length) lines.push('【仓库标签】' + remote.topics.slice(0, 8).join(', '));
          lines.push(
            '【匹配结论】用户给的 ' +
              ref.owner +
              '/' +
              ref.repo +
              ' 就是上面这个仓库（不在 DSH 插件榜单里）。请按它自己的真实用途回答：是什么、能拿来干什么、对用户有没有用；如果它和 DSH 插件没关系，不要硬套插件框架，也不要因为它"不在榜单里"就说不知道。',
          );
          resolved.push(remote);
        } else if (hits && hits.missing) {
          lines.push(
            '【匹配结论】GitHub 上查不到 ' + hits.missing + '（接口返回 404）。请照实说这个链接可能写错了、仓库不存在或已转为私有，不要猜内容。',
          );
        }
      }

      /* 2) 没写成 owner/repo（或者榜单里没有）时，用候选把名字钉住 */
      let exact = [];
      let near = [];
      let mine = { exact: [], near: [], tokens: [] };
      if (!found && !(hits && hits.remote)) {
        mine = findCandidates(q, ctx && ctx.registry);
        const given = hits && Array.isArray(hits.exact) ? hits.exact : [];
        exact = (mine.exact.length ? mine.exact : given).slice(0, 5);
        near = (mine.near.length ? mine.near : hits && Array.isArray(hits.near) ? hits.near : []).slice(0, 5);
        const pool = exact.length ? exact : near;
        if (pool.length) {
          if (exact.length) {
            lines.push(
              '【候选仓库】用户只给了名字，下面是按名字匹配到的仓库（GitHub 仓库名的 owner 部分不能省，名字本身不区分大小写）：',
            );
          } else {
            lines.push(
              '【候选仓库】用户给的是片段或关键词，不是完整仓库名。下面是榜单里名字/描述/标签能对上的仓库，已按相关度排序（不一定准确，也可能一个都不对）：',
            );
          }
          for (const p of pool) {
            const d = String(p.description || '').replace(/\s+/g, ' ').trim();
            lines.push('- ' + candidateLine(p) + (d ? ' — ' + d.slice(0, 90) : ''));
          }
          const first = pool[0];
          const zh = ctx && ctx.introOf ? ctx.introOf(first) : null;
          if (zh && zh.one) lines.push('【中文简介】' + zh.one);
          if (exact.length === 1) {
            lines.push(
              '【匹配结论】按名字只匹配到 ' +
                exact[0].fullName +
                ' 这一个仓库，如果用户问的就是它，直接按它回答，开头用一句话说明"你说的 ' +
                (repoWords(q)[0] || '') +
                ' 应该是 ' +
                exact[0].fullName +
                '"；如果明显不是，就说没匹配上。',
            );
            resolved.push(exact[0]);
          } else {
            if (exact.length) {
              lines.push(
                '【匹配结论】匹配到多个同名或相近的仓库，先让用户确认是哪一个，不要随便挑一个当答案；可以顺带说各自是干什么的。',
              );
            } else {
              lines.push(
                '【匹配结论】没有任何仓库名和"' +
                  (mine.tokens[0] || q) +
                  '"完全相同，上面的候选只是相关。请这样处理：如果第一个明显就是他要找的（例如他说的用途正好对上，像"逆向"对上 reverse），就直接按它回答，开头一句说明"你说的 ' +
                  (mine.tokens[0] || q) +
                  ' 我判断是 ' +
                  pool[0].fullName +
                  '"；如果前两个都像，就把它们各自的用途摆出来让他选；如果一个都不像，就说没找到，让他补英文全名或 owner/repo。不要编内容。',
              );
            }
          }
        } else if ((repoish || (mine.tokens && mine.tokens.length)) && !(hits && (hits.remote || hits.missing))) {
          const longest = (mine.tokens || []).reduce((n, w) => Math.max(n, String(w).length), 0);
          if (longest > 0 && longest <= 2) {
            lines.push(
              '【匹配结论】用户给的关键词只有 ' +
                longest +
                ' 个字符，太短了，榜单里没法可靠地定位。请直接说"这个词太短，搜不出来"，并请他把看到的名字多给几个字母（或者把网页上的链接/完整仓库名发过来）。不要猜。',
            );
          } else {
            lines.push(
              '【匹配结论】榜单和 GitHub 搜索都没匹配到这个关键词。请直接说"没找到"，并请用户补一点信息：多给几个字母的片段、英文全名，或者 GitHub 上的 owner/repo；如果他只记得中文用途，可以按用途再帮他找。不要猜内容。',
            );
          }
        }
      }

      if (!lines.length) return q;
      const head = lines.join('\n');
      const tail = '\n\n【问题】\n' + q;
      return head + tail;
    }

    /* ─────────────────── 插件动态：跟踪已装插件的变化 ─────────────────── */

    const WATCH_URL = '/api/daily-consult.watch';
    const WATCH_EDIT_URL = '/api/daily-consult.watch.edit';

    /** 窗口标题上的未读角标：有变化就写 (3) xxx，切到动态页就清掉。*/
    const titleBadge = {
      n: 0,
      obs: null,
      apply() {
        const base = String(document.title || '').replace(/^\(\d+\+?\)\s*/, '');
        const next = this.n > 0 ? '(' + (this.n > 99 ? '99+' : this.n) + ') ' + base : base;
        if (document.title !== next) document.title = next;
      },
      set(n) { this.n = n || 0; this.apply(); },
      watch() {
        if (this.obs || typeof MutationObserver === 'undefined') return;
        const t = document.querySelector('title');
        if (!t) return;
        this.obs = new MutationObserver(() => this.apply());
        this.obs.observe(t, { childList: true, characterData: true, subtree: true });
      },
    };

    function versionCmpLocal(a, b) {
      const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
      const pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
      }
      return 0;
    }

    function ensureWatchCss() {
      if (typeof document === 'undefined' || document.getElementById('ddp-css-watch')) return;
      const css = [
        '.ddp-tabs { flex:0 0 auto; display:flex; gap:6px; padding:0 24px 6px; border-bottom:1px solid var(--ddp-line, rgba(255,255,255,.09)); }',
        '.ddp-tab { appearance:none; border:0; background:transparent; color:var(--ddp-dim, #9aa0a8); font:inherit; font-size:13px; padding:6px 10px; border-radius:6px 6px 0 0; cursor:pointer; position:relative; }',
        '.ddp-tab:hover { color:var(--ddp-ink, #e9eaec); background:rgba(255,255,255,.04); }',
        '.ddp-tab.is-on { color:var(--ddp-ink, #e9eaec); background:rgba(255,255,255,.07); box-shadow:inset 0 -2px 0 var(--ddp-accent, #e8b23a); }',
        '.ddp-tab-n { display:inline-block; min-width:16px; margin-left:6px; padding:0 4px; border-radius:8px; background:var(--ddp-accent, #e8b23a); color:#1a1a1a; font-size:11px; line-height:16px; text-align:center; font-style:normal; }',
        '.ddp-watch { flex:1 1 0; min-height:0; overflow:auto; padding:10px 24px 0; }',
        '.ddp-watch-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:2px 0 8px; color:var(--ddp-dim, #9aa0a8); font-size:12px; }',
        '.ddp-watch-changes { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; padding:8px 10px; border:1px solid rgba(232,178,58,.35); border-radius:8px; background:rgba(232,178,58,.07); }',
        '.ddp-watch-change { font-size:12.5px; color:var(--ddp-ink, #e9eaec); }',
        '.ddp-watch-change b { color:var(--ddp-accent, #e8b23a); font-weight:600; margin-right:8px; }',
        '.ddp-watch-list { display:flex; flex-direction:column; gap:2px; padding-bottom:12px; }',
        '.ddp-watch-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 2px; border-bottom:1px solid rgba(255,255,255,.055); }',
        '.ddp-watch-row:last-child { border-bottom:0; }',
        '.ddp-watch-main { min-width:0; }',
        '.ddp-watch-name { font-size:13.5px; color:var(--ddp-ink, #e9eaec); display:flex; align-items:baseline; gap:8px; }',
        '.ddp-watch-name a { color:inherit; text-decoration:none; border-bottom:1px dotted rgba(255,255,255,.25); }',
        '.ddp-watch-name a:hover { color:var(--ddp-accent, #e8b23a); }',
        '.ddp-watch-repo { font-style:normal; font-size:11.5px; color:var(--ddp-dim, #9aa0a8); }',
        '.ddp-watch-desc { font-size:12px; color:var(--ddp-dim, #9aa0a8); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:64ch; }',
        '.ddp-watch-side { flex:0 0 auto; display:flex; align-items:center; gap:10px; font-size:12px; color:var(--ddp-dim, #9aa0a8); }',
        '.ddp-watch-ver i { font-style:normal; color:var(--ddp-accent, #e8b23a); }',
        '.ddp-watch-star { color:var(--ddp-accent, #e8b23a); }',
        '.ddp-tag-warn { color:#ffb4a2; border-color:rgba(255,120,90,.45); }',
        '.ddp-watch-warn { font-style:normal; color:#ffb4a2; }',
        '.ddp-watched { flex:0 0 auto; margin:2px 0 10px; padding:10px 12px; border:1px solid rgba(255,255,255,.09); border-radius:10px; background:rgba(255,255,255,.025); }',
        '.ddp-watched-head { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }',
        '.ddp-watched-head b { font-size:13.5px; color:var(--ddp-ink, #e9eaec); }',
        '.ddp-watched-sub { font-size:11.5px; color:var(--ddp-dim, #9aa0a8); }',
        '.ddp-watched-add { display:flex; gap:8px; margin-bottom:8px; }',
        '.ddp-watched-input { flex:1 1 auto; min-width:0; padding:6px 9px; font:inherit; font-size:12.5px; color:var(--ddp-ink, #e9eaec); background:rgba(0,0,0,.28); border:1px solid rgba(255,255,255,.12); border-radius:7px; outline:none; }',
        '.ddp-watched-input:focus { border-color:rgba(232,178,58,.55); }',
        '.ddp-watched-list { display:flex; flex-direction:column; gap:2px; }',
        '.ddp-watched-row { display:flex; align-items:center; gap:10px; padding:6px 0; border-top:1px solid rgba(255,255,255,.055); }',
        '.ddp-watched-main { min-width:0; flex:1 1 auto; }',
        '.ddp-kind { flex:0 0 auto; min-width:34px; text-align:center; font-size:11px; padding:1px 6px; border-radius:999px; border:1px solid rgba(232,178,58,.45); color:var(--ddp-accent, #e8b23a); }',
        '.ddp-watched-del { appearance:none; border:0; background:transparent; color:var(--ddp-dim, #9aa0a8); font-size:15px; line-height:1; cursor:pointer; padding:2px 4px; border-radius:4px; }',
        '.ddp-watched-del:hover { color:#ff8a70; background:rgba(255,120,90,.12); }',
        '.ddp-watched-empty { font-size:12px; color:var(--ddp-dim, #9aa0a8); }',
      ].join('\n');
      const el = document.createElement('style');
      el.id = 'ddp-css-watch';
      el.textContent = css;
      document.head.appendChild(el);
    }

    function useWatch() {
      const [state, setState] = useState({ loading: false, items: [], watched: [], changes: [], checkedAt: 0, error: null, loaded: false, rateLimited: false });
      const load = useCallback(async (ack) => {
        setState((s0) => Object.assign({}, s0, { loading: true }));
        try {
          const res = await fetch(WATCH_URL + (ack ? '?ack=1' : ''), { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          if (!data || data.ok === false) throw new Error((data && data.error) || '返回异常');
          const changes = data.changes || [];
          setState({ loading: false, items: data.items || [], watched: data.watched || [], changes, checkedAt: data.checkedAt || 0, error: null, loaded: true, rateLimited: !!data.rateLimited });
          titleBadge.watch();
          titleBadge.set(ack ? 0 : changes.length);
        } catch (err) {
          setState((s0) => Object.assign({}, s0, { loading: false, error: String((err && err.message) || err), loaded: true }));
        }
      }, []);
      useEffect(() => {
        load(false);
      }, [load]);
      const edit = useCallback(async (action, repo) => {
        try {
          const res = await fetch(WATCH_EDIT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, repo }),
          });
          const data = await res.json();
          if (!data || !data.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
          await load(false);
        } catch (err) {
          setState((s0) => Object.assign({}, s0, { error: '关注操作失败：' + String((err && err.message) || err) }));
        }
      }, [load]);
      return {
        loading: state.loading,
        items: state.items,
        watched: state.watched,
        edit,
        changes: state.changes,
        checkedAt: state.checkedAt,
        error: state.error,
        rateLimited: state.rateLimited,
        reload: () => load(false),
        ack: () => load(true),
      };
    }


    /** 我关注的仓库（插件 / skill / 软件 / 普通项目都能盯）。*/
    function WatchList(props) {
      const w = props.w;
      const [text, setText] = useState('');
      const add = () => {
        const v = String(text || '').trim();
        if (!v) return;
        setText('');
        w.edit('add', v);
      };
      const ago = (iso) => {
        const dd = daysBetween(iso);
        return Number.isFinite(dd) ? (dd < 1 ? '今天' : Math.round(dd) + ' 天前') : '';
      };
      return h(
        'div',
        { className: 'ddp-watched' },
        h(
          'div',
          { className: 'ddp-watched-head' },
          h('b', null, '我关注的'),
          h('span', { className: 'ddp-watched-sub' }, '贴 owner/repo 或 GitHub 链接，插件、skill、软件都能跟'),
        ),
        h(
          'div',
          { className: 'ddp-watched-add' },
          h('input', {
            className: 'ddp-watched-input',
            value: text,
            placeholder: '例如 Ryder191/haloflux 或 https://github.com/Ryder191/haloflux',
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') add(); },
          }),
          h('button', { className: 'ddp-tool', onClick: add, disabled: !String(text).trim() }, '关注'),
        ),
        w.watched.length
          ? h(
              'div',
              { className: 'ddp-watched-list' },
              w.watched.map((it) =>
                h(
                  'div',
                  { className: 'ddp-watched-row', key: it.repo },
                  h('span', { className: 'ddp-kind' }, it.kind),
                  h(
                    'div',
                    { className: 'ddp-watched-main' },
                    h(
                      'div',
                      { className: 'ddp-watch-name' },
                      it.htmlUrl ? h('a', { href: it.htmlUrl, target: '_blank', rel: 'noreferrer' }, it.repo) : h('span', null, it.repo),
                      it.tag ? h('em', { className: 'ddp-watch-repo' }, it.tag) : null,
                    ),
                    it.desc ? h('div', { className: 'ddp-watch-desc' }, it.desc) : null,
                  ),
                  h(
                    'div',
                    { className: 'ddp-watch-side' },
                    it.stars != null ? h('span', { className: 'ddp-watch-star' }, '★' + fmtStars(it.stars)) : null,
                    it.pushedAt ? h('span', null, ago(it.pushedAt)) : null,
                    it.missing ? h('span', { className: 'ddp-tag ddp-tag-warn' }, '查不到') : null,
                    it.archived ? h('span', { className: 'ddp-tag ddp-tag-warn' }, '已归档') : null,
                    h('button', { className: 'ddp-watched-del', title: '不关注了', onClick: () => w.edit('remove', it.repo) }, '×'),
                  ),
                ),
              ),
            )
          : h('div', { className: 'ddp-watched-empty' }, '还没有关注任何仓库。'),
      );
    }
    function WatchPanel(props) {
      const w = props.w;
      const ago = (iso) => {
        const dd = daysBetween(iso);
        if (!Number.isFinite(dd)) return '';
        return dd < 1 ? '今天' : Math.round(dd) + ' 天前';
      };
      const stamp = w.checkedAt ? new Date(w.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
      return h(
        'div',
        { className: 'ddp-watch' },
        h(
          'div',
          { className: 'ddp-watch-head' },
          h(
            'span',
            null,
            w.loading ? '正在检查已装插件…' : '跟踪 ' + w.items.length + ' 个插件 · 检查于 ' + stamp + ' · 有变化才提醒',
            w.rateLimited ? h('i', { className: 'ddp-watch-warn' }, ' · GitHub 限流，仓库活动稍后再查') : null,
          ),
          h('button', { className: 'ddp-tool', onClick: w.reload, disabled: w.loading }, w.loading ? '检查中' : '重新检查'),
        ),
        w.error ? h('div', { className: 'ddp-fail' }, '检查失败：' + w.error) : null,
        h(WatchList, { w: w }),
        w.changes.length
          ? h(
              'div',
              { className: 'ddp-watch-changes' },
              w.changes.slice(0, 8).map(function (c, i) {
                const zh = zhLabel(c.name);
                return h(
                  'div',
                  { className: 'ddp-watch-change', key: i },
                  h(
                    'div',
                    { className: 'ddp-wc-head' },
                    zh ? h('span', { className: 'ddp-wc-zh' }, zh) : null,
                    h('b', null, zh ? shortPkg(c.name) : c.name),
                    c.watched ? h('span', { className: 'ddp-tag' }, c.kindLabel || '关注') : null,
                  ),
                  h('div', { className: 'ddp-wc-txt' }, c.text),
                  c.desc ? h('div', { className: 'ddp-wc-sub' }, String(c.desc).slice(0, 90)) : null,
                );
              }),
            )
          : null,
        h(
          'div',
          { className: 'ddp-watch-list' },
          w.items.map((it) =>
            h(
              'div',
              { className: 'ddp-watch-row', key: it.name },
              h(
                'div',
                { className: 'ddp-watch-main' },
                h(
                  'div',
                  { className: 'ddp-watch-name' },
                  zhLabel(it.name) ? h('span', { className: 'ddp-watch-zh' }, zhLabel(it.name)) : null,
                  it.htmlUrl
                    ? h('a', { href: it.htmlUrl, target: '_blank', rel: 'noreferrer', className: 'ddp-watch-pkg' }, zhLabel(it.name) ? shortPkg(it.name) : it.name)
                    : h('span', { className: 'ddp-watch-pkg' }, zhLabel(it.name) ? shortPkg(it.name) : it.name),
                ),
                h('div', { className: 'ddp-watch-desc' }, it.desc || '—'),
              ),
              h(
                'div',
                { className: 'ddp-watch-side' },
                h('span', { className: 'ddp-watch-ver' }, it.version, it.latest && versionCmpLocal(it.latest, it.version) > 0 ? h('i', null, ' → ' + it.latest) : null),
                it.stars != null ? h('span', { className: 'ddp-watch-star' }, '★' + fmtStars(it.stars)) : null,
                it.pushedAt ? h('span', { className: 'ddp-watch-ago' }, ago(it.pushedAt)) : null,
                it.archived ? h('span', { className: 'ddp-tag ddp-tag-warn' }, '已归档') : null,
              ),
            ),
          ),
        ),
      );
    }

    /* ─────────────────── 数据层：内容版同一套取数 / 润色 / 咨询 ───────────────────
       抽成一个 hook，骨架版直接从它取数据；内容版（DailyPushTab）保持原样不动。 */

    function useDailyData() {
      const [registry, setRegistry] = useState(null);
      const [github, setGithub] = useState(null);
      const [githubRecent, setGithubRecent] = useState(() =>
        ghRecentCache.items && Date.now() - ghRecentCache.at < GH_RECENT_TTL ? ghRecentCache.items : null,
      );
      const [error, setError] = useState(null);
      const [ghExtra, setGhExtra] = useState({ leaders: [], official: [] });
      const [loading, setLoading] = useState(true);
      const [prevStars, setPrevStars] = useState(() => (readSnapshot() || {}).stars || null);

      const [q, setQ] = useState('');
      const [answer, setAnswer] = useState(null);
      const [askModel, setAskModel] = useState('');

      const [introCache, setIntroCache] = useState(() => readIntroCache());
      const introRef = useRef(null);
      if (introRef.current === null) introRef.current = introCache;
      const [tried, setTried] = useState({});
      const [installed, setInstalled] = useState(null);
      const inflight = useRef({});

      const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        let doc = null;
        try {
          doc = await fetchJson(REGISTRY_URL, { cache: 'no-store' });
          if (!doc || !Array.isArray(doc.plugins)) throw new Error('榜单数据结构异常');
          setRegistry(doc);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
        let items = null;
        try {
          const gh = await fetchJson(GITHUB_SEARCH_URL, { headers: { accept: 'application/vnd.github+json' } });
          items = Array.isArray(gh.items) ? gh.items : [];
        } catch (err) {
          items = null;
        }
        setGithub(items);
        let recent = ghRecentCache.items && Date.now() - ghRecentCache.at < GH_RECENT_TTL ? ghRecentCache.items : null;
        if (!recent) {
          /* 先让宿主代取（浏览器直连 GitHub 会被页面策略拦掉）；宿主也被拦时再试直连。*/
          try {
            const viaHost = await fetchJson('/api/daily-consult.recent');
            if (viaHost && Array.isArray(viaHost.items)) recent = viaHost.items;
            if (viaHost && (Array.isArray(viaHost.leaders) || Array.isArray(viaHost.official))) {
              setGhExtra({
                leaders: Array.isArray(viaHost.leaders) ? viaHost.leaders : [],
                official: Array.isArray(viaHost.official) ? viaHost.official : [],
              });
            }
          } catch (err) {
            recent = null;
          }
          if (!recent) {
            try {
              const gh2 = await fetchJson(githubRecentUrl(), {
                headers: { accept: 'application/vnd.github+json' },
              });
              recent = Array.isArray(gh2.items) ? gh2.items : [];
            } catch (err) {
              recent = null;
            }
          }
          if (recent) ghRecentCache = { at: Date.now(), items: recent };
        }
        setGithubRecent(recent);
        if (doc || items) {
          const current = doc ? starsMap(doc.plugins) : {};
          if (items) for (const r of items) current[r.full_name] = r.stargazers_count;
          setPrevStars((readSnapshot() || {}).stars || null);
          writeSnapshot(current);
        }
        setLoading(false);
      }, []);

      const send = useCallback(
        async (textArg) => {
          const question = String(textArg == null ? q : textArg).trim();
          if (!question) return;
          setQ(question);
          setAnswer({ q: question, text: '', meta: '', error: null, running: true, totalMs: 0 });
          const t0 = Date.now();
          let acc = '';

          /* 名字可能没写 owner，也可能压根不在榜单里：先查榜单，再拿 GitHub 搜索兜一次底。
             这样"deepseek-reasonix"这种只写了仓库名的输入也能被钉到具体的 owner/repo 上。 */
          let hits = null;
          const ref = parseRepoRef(question);
          try {
            const local = findCandidates(question, registry);
            const pool = local.exact.length ? local.exact : local.near;
            const word = repoWords(question).filter((w) => !REPO_STOP[w.toLowerCase()])[0];
            if (ref) {
              /* 用户给的是明确仓库：直接查这一条，最准（不在榜单里也能拿到真实数据） */
              try {
                const one = await fetchJson('https://api.github.com/repos/' + ref.owner + '/' + ref.repo, {
                  headers: { accept: 'application/vnd.github+json' },
                });
                if (one && one.full_name) {
                  hits = {
                    remote: {
                      fullName: one.full_name,
                      stars: one.stargazers_count,
                      pushedAt: one.pushed_at,
                      desc: one.description,
                      language: one.language,
                      license:
                        one.license && one.license.spdx_id && one.license.spdx_id !== 'NOASSERTION'
                          ? one.license.spdx_id
                          : '',
                      topics: Array.isArray(one.topics) ? one.topics : [],
                      htmlUrl: one.html_url,
                    },
                    exact: [
                      {
                        fullName: one.full_name,
                        stars: one.stargazers_count,
                        pushedAt: one.pushed_at,
                        desc: one.description,
                      },
                    ],
                    near: [],
                  };
                }
              } catch (err2) {
                hits = { exact: [], near: [], missing: ref.owner + '/' + ref.repo };
              }
            }
            if (!hits && !pool.length && word && word.length >= 3 && /^[a-z0-9_.-]+$/i.test(word)) {
              const gh = await fetchJson(
                'https://api.github.com/search/repositories?q=' + encodeURIComponent(word) + '&per_page=5',
                { headers: { accept: 'application/vnd.github+json' } },
              );
              const items = gh && Array.isArray(gh.items) ? gh.items : [];
              if (items.length) {
                const mapped = items.map((it) => ({
                  fullName: it.full_name,
                  stars: it.stargazers_count,
                  pushedAt: it.pushed_at,
                  desc: it.description,
                }));
                const same = mapped.filter(
                  (p) => String(p.fullName || '').toLowerCase().split('/')[1] === String(word).toLowerCase(),
                );
                hits = { exact: same.length ? same : mapped.slice(0, 3), near: [] };
              }
            }
          } catch (err) {
            /* 搜索失败就当没有候选，让模型照实说没查到 */
          }

          const payload = buildConsultQuestion(question, { installed, registry, introOf }, hits);
          {
            const fromHits = hits && hits.exact && hits.exact.length === 1 ? hits.exact[0].fullName : '';
            const fromReg = ref
              ? (registry && registry.plugins || []).find(
                  (p) => String(p.fullName || '').toLowerCase() === (ref.owner + '/' + ref.repo).toLowerCase(),
                )
              : null;
            const locked = fromReg
              ? fromReg.fullName
              : hits && hits.remote
                ? hits.remote.fullName
                : fromHits;
            if (locked) setAnswer((s2) => (s2 ? Object.assign({}, s2, { resolved: locked }) : s2));
          }
          try {
            const res = await fetch(CONSULT_ASK_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
              body: JSON.stringify({ question: payload }),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            if (!res.body) throw new Error('浏览器没有 response.body，无法流式读取');
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
              const step = await reader.read();
              if (step.done) break;
              buf += decoder.decode(step.value, { stream: true });
              let nl = buf.indexOf('\n');
              while (nl >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                nl = buf.indexOf('\n');
                if (!line.trim()) continue;
                let msg = null;
                try {
                  msg = JSON.parse(line);
                } catch (err) {
                  continue;
                }
                if (msg.t === 'delta') {
                  acc += msg.text;
                  setAnswer((s) => (s ? Object.assign({}, s, { text: acc }) : s));
                } else if (msg.t === 'meta') {
                  setAnswer((s) => (s ? Object.assign({}, s, { meta: msg.provider + ' / ' + msg.model }) : s));
                } else if (msg.t === 'error') {
                  setAnswer((s) => (s ? Object.assign({}, s, { error: msg.message }) : s));
                }
              }
            }
            setAnswer((s) => (s ? Object.assign({}, s, { running: false, totalMs: Date.now() - t0 }) : s));
          } catch (err) {
            setAnswer((s) =>
              s ? Object.assign({}, s, { running: false, error: (err && err.message) || String(err) }) : s,
            );
          }
        },
        [q, installed, registry, introCache],
      );

      useEffect(() => {
        load();
      }, [load]);

      useEffect(() => {
        let alive = true;
        fetch(CONSULT_HEALTH_URL, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (!alive || !j || !j.defaultSelection) return;
            const d = j.defaultSelection;
            setAskModel(d.provider + ' / ' + d.model);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      useEffect(() => {
        let alive = true;
        fetch(INSTALLED_URL, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            if (!alive || !j || !j.ok || !Array.isArray(j.names)) return;
            setInstalled(j.names);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      const ghFresh = useMemo(
        () =>
          (github || [])
            .filter((r) => daysBetween(r.created_at) <= NEW_WINDOW_DAYS)
            .slice(0, 5)
            .map((r) => ({
              fullName: r.full_name,
              url: r.html_url,
              description: r.description || '',
              stars: r.stargazers_count,
              pushedAt: r.pushed_at,
              createdAt: r.created_at,
            })),
        [github],
      );

      const ghToday = useMemo(
        () =>
          (githubRecent || [])
            .filter((r) => !r.archived && !r.fork)
            .map((r) => {
              const row = {
                fullName: r.full_name,
                url: r.html_url,
                description: r.description || '',
                stars: r.stargazers_count,
                pushedAt: r.pushed_at,
                createdAt: r.created_at,
                topics: (r.topics || []).filter((t) => !/^(dsh-plugin|dsh|plugin|plugins|deepseek|deepseek-harness|harness|ai|agent|llm)$/i.test(String(t))),
                language: r.language || '',
                live: true,
              };
              const sc = scoreRepo(row);
              row.score = sc.score;
              row.badges = sc.badges;
              return row;
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 8),
        [githubRecent],
      );

      const view = useMemo(() => {

        const plugins = registry ? registry.plugins : [];
        const tr = todayRef(plugins);
        const live = ghToday.slice(0, SK_PER_COL);
        const today = live.length ? live : pickToday(plugins, tr.ref).slice(0, SK_PER_COL);
        const fresh = pickNew(plugins).slice(0, SK_PER_COL);
        const rising = pickRising([...plugins, ...ghFresh], prevStars);
        const lead = today[0] || pickNew(plugins)[0] || null;
        /* ── 三榜并列用的数据（版式 C）── */
        const pack = (r) => denseRow(r);
        const regRows = plugins.map(pack).filter(Boolean);
        const liveRows = (githubRecent || []).map(pack).filter(Boolean).filter((r) => !isOfficialRepo(r.fullName));
        const leadersAll = (ghExtra.leaders || [])
          .map(pack)
          .filter(Boolean)
          .filter((r) => !isOfficialRepo(r.fullName));
        /* 官方：优先用宿主给的；宿主没给（限流/旧进程）就从三处数据里按组织名捞回来 */
        const officialRows = (ghExtra.official || [])
          .map(pack)
          .filter(Boolean)
          .concat((ghExtra.leaders || []).map(pack).filter(Boolean).filter((r) => isOfficialRepo(r.fullName)))
          .concat(regRows.filter((r) => isOfficialRepo(r.fullName)))
          .filter((r, i, arr) => arr.findIndex((x) => x.fullName === r.fullName) === i)
          .sort((a, b) => (b.stars || 0) - (a.stars || 0))
          .slice(0, 4);
        const byTime = (key) =>
          liveRows
            .slice()
            .sort((a, b) => (new Date(b[key] || 0).getTime() || 0) - (new Date(a[key] || 0).getTime() || 0))
            .slice(0, 15);
        const starLeaders = leadersAll
          .filter(looksLikeDshPlugin)
          .sort((a, b) => (b.stars || 0) - (a.stars || 0))
          .slice(0, 15);
        const regPlugins = regRows.filter((r) => !isOfficialRepo(r.fullName) && looksLikeDshPlugin(r));
        const starsTop = starLeaders.length
          ? starLeaders
          : regPlugins.slice().sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 15);
        const newTop = liveRows.length
          ? byTime('createdAt')
          : pickNew(plugins).map(pack).filter(Boolean).filter((r) => !isOfficialRepo(r.fullName)).slice(0, 15);
        const actTop = liveRows.length
          ? byTime('pushedAt')
          : pickToday(plugins, tr.ref).map(pack).filter(Boolean).filter((r) => !isOfficialRepo(r.fullName)).slice(0, 15);
        const others = leadersAll
          .concat(regRows.filter((r) => !isOfficialRepo(r.fullName) && !looksLikeDshPlugin(r)))
          .filter((r) => !looksLikeDshPlugin(r))
          .filter((r, i, arr) => arr.findIndex((x) => x.fullName === r.fullName) === i)
          .sort((a, b) => (b.stars || 0) - (a.stars || 0))
          .slice(0, 9);
        return {
          today,
          fresh,
          rising,
          lead,
          all: plugins,
          total: plugins.length,
          newest: tr.newest,
          staleDays: tr.stale,
          liveCount: live.length,
          liveReady: githubRecent !== null,
        starsTop,
        newTop,
        actTop,
        others,
        official: officialRows,
        };
      }, [registry, prevStars, ghFresh, ghToday, ghExtra]);

      const isInstalled = (p) => {
        if (!installed) return null;
        const name = String(p.fullName || '');
        const short = name.split('/')[1] || name;
        for (const n of installed) {
          if (!n) continue;
          if (n === name || n === short || n.endsWith('/' + short)) return true;
        }
        return false;
      };

      const introOf = (p) => {
        const hit = cachedIntro(introCache, p);
        if (hit) return hit;
        const zh = zhIntro(p);
        return { one: zh.intro, a: '', b: '', rule: true };
      };

      useEffect(() => {
        if (!view.lead) return;
        const wanted = [];
        const push = (p) => {
          if (p && p.fullName && !wanted.some((w) => w.fullName === p.fullName)) wanted.push(p);
        };
        push(view.lead);
        view.today.forEach(push);
        view.fresh.forEach(push);
        view.rising.forEach((r) => push(r.plugin));
        const missing = wanted.filter(
          (p) => !cachedIntro(introCache, p) && !tried[p.fullName] && !inflight.current[p.fullName],
        );
        if (!missing.length) return;

        const batches = [];
        for (let i = 0; i < missing.length; i += INTRO_BATCH) batches.push(missing.slice(i, i + INTRO_BATCH));

        batches.forEach((batch) => {
          for (const p of batch) inflight.current[p.fullName] = true;
          fetch(INTRO_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              items: batch.map((p) => ({
                name: p.fullName,
                desc: cleanText(p.description || '').slice(0, 420),
                topics: (p.topics || []).slice(0, 6),
                stars: p.stars || 0,
                lang: p.language || '',
              })),
            }),
          })
            .then((res) => {
              if (!res.ok) throw new Error('intros ' + res.status);
              return readIntroStream(res, (item) => {
                const src = batch.find((p) => p.fullName === item.name);
                const next = Object.assign({}, introRef.current);
                next[item.name] = {
                  one: item.one,
                  a: item.a || '',
                  b: item.b || '',
                  up: src ? src.pushedAt : '',
                  at: Date.now(),
                };
                introRef.current = next;
                writeIntroCache(next);
                setIntroCache(next);
              });
            })
            .catch(() => {})
            .finally(() => {
              const marks = {};
              for (const p of batch) {
                delete inflight.current[p.fullName];
                marks[p.fullName] = true;
              }
              setTried((prev) => Object.assign({}, prev, marks));
            });
        });
      }, [view, introCache, tried]);

      return {
        registry,
        loading,
        error,
        view,
        ghFresh,
        prevStars,
        installed,
        isInstalled,
        introOf,
        reload: load,
        askModel,
        consult: {
          q,
          setQ,
          answer,
          send,
          clear: () => setAnswer(null),
        },
      };
    }

    /* ───────────────────────────── 界面零件（真内容） ───────────────────────────── */

    function frameOpen(p) {
      try {
        const url = repoUrl(p);
        if (url) window.open(url, '_blank', 'noreferrer');
      } catch (err) {
        /* 打不开就算了 */
      }
    }

    /** 从「owner/repo」里取 repo 部分，太长就中间省略。 */
    function shortName(name) {
      const s = String(name || '');
      const cut = s.split('/')[1] || s;
      return cut.length > 22 ? cut.slice(0, 21) + '…' : cut;
    }

    /** 标签：沿用中文介绍生成器里识别出的能力标签。 */
    function frameTags(p) {
      try {
        const zh = zhIntro(p);
        return [zh.label].concat(zh.extraLabels || []).filter(Boolean).slice(0, 3);
      } catch (err) {
        return [];
      }
    }

    /** 顶部快讯横带：涨得最快 + GitHub 实时，一共 9 位。 */
    function WireBand(props) {
      const d = props.d;
      const cells = [];
      d.view.rising.slice(0, 5).forEach((r) => {
        cells.push({ key: 'up-' + r.plugin.fullName, delta: '+' + r.delta, p: r.plugin });
      });
      d.ghFresh.slice(0, 4).forEach((p) => {
        cells.push({ key: 'gh-' + p.fullName, delta: '新', p: p });
      });
      const used = {};
      cells.forEach((c) => {
        used[c.p.fullName] = true;
      });
      for (const p of d.view.today.concat(d.view.fresh)) {
        if (cells.length >= 9) break;
        if (used[p.fullName]) continue;
        used[p.fullName] = true;
        cells.push({ key: 'sel-' + p.fullName, delta: '·', p: p });
      }

      const hint =
        '涨得最快 ' + d.view.rising.length + ' · GitHub 实时 ' + (d.ghFresh ? d.ghFresh.length : 0);

      return h(
        'div',
        { className: 'ddp-wire' },
        h('div', { className: 'ddp-col-h' }, h('h3', null, '快讯'), h('span', null, hint)),
        h(
          'div',
          { className: 'ddp-wire-b' },
          cells.map((c, i) =>
            h(
              'div',
              { key: c.key, className: 'fr-chipslot' },
              h(
                'div',
                {
                  className: 'fr-chip',
                  title: c.p.fullName + ' · ' + cleanText(c.p.description || '').slice(0, 120),
                  onClick: () => props.onAsk(c.p),
                },
                h('em', null, String(i + 1).padStart(2, '0')),
                h('b', null, c.delta),
                h('span', null, shortName(c.p.fullName)),
              ),
            ),
          ),
          cells.length ? null : h('div', { className: 'fr-emptynote' }, '还没有涨幅数据：明天再打开就有了。'),
        ),
      );
    }

    /** 头条：名字 / 一句话 / 两条要点 / 事实 / 安装命令 / 操作。 */
    function LeadBlock(props) {
      const p = props.p;
      if (!p) return h('div', { className: 'fr-emptynote' }, props.empty || '这一窗里没有仓库有动静。');
      const zh = props.zh || { one: '', a: '', b: '', rule: true };
      const facts = [];
      if (p.stars) facts.push(['星标', fmtStars(p.stars)]);
      if (p.language) facts.push(['语言', p.language]);
      if (p.license) facts.push(['许可', p.license]);
      const days = Math.round(daysBetween(p.pushedAt) || 0);
      facts.push(['更新', days <= 0 ? '今天' : days + ' 天前']);
      const points = [zh.a, zh.b].filter(Boolean);
      const tags = frameTags(p);
      const inst = props.installed;

      return h(
        'div',
        { className: 'fr-lead' },
        h(
          'div',
          { className: 'fr-kicker' },
          '今日精选 · 头条' + (zh.rule ? '' : ' · AI 摘要') + (tags.length ? ' · ' + tags.join(' / ') : ''),
        ),
        h('h2', { className: 'fr-title', title: p.fullName }, p.fullName),
        h('p', { className: 'fr-lede' }, zh.one || cleanText(p.description || '') || '（暂无描述）'),
        points.length
          ? h(
              'ul',
              { className: 'fr-points' },
              points.map((t, i) => h('li', { key: i }, t)),
            )
          : null,
        h(
          'div',
          { className: 'fr-facts' },
          facts.map((f, i) => h('span', { key: i }, h('b', null, f[0] + ' '), f[1])),
        ),
        h('div', { className: 'fr-cmd' }, installCmd(p)),
        h(
          'div',
          { className: 'fr-acts' },
          h(
            'button',
            {
              className: 'fr-btn on',
              onClick: () => {
                copyText(installCmd(p));
              },
            },
            '复制安装命令',
          ),
          h('button', { className: 'fr-btn', onClick: () => frameOpen(p) }, '打开仓库'),
          h('button', { className: 'fr-btn', onClick: () => props.onAsk(p) }, '问一下'),
          inst === true ? h('span', { className: 'fr-btn on' }, '已装') : null,
        ),
      );
    }

    /** 清单一块：5 行，点名字开仓库、点「问」带到咨询区。 */
    function ListBlock(props) {
      const rows = props.rows || [];
      return h(
        'div',
        { className: 'fr-list' },
        rows.length
          ? rows.map((p, i) =>
              h(
                'div',
                { key: p.fullName, className: 'fr-row' },
                h('span', { className: 'fr-idx' }, i + 1),
                h(
                  'div',
                  { className: 'fr-slot-main' },
                  h(
                    'div',
                    { className: 'fr-name', title: p.fullName, onClick: () => frameOpen(p) },
                    p.fullName,
                  ),
                  h('div', { className: 'fr-one' }, (props.introOf(p) || {}).one || ''),
                  h(
                    'div',
                    { className: 'fr-tags' },
                    (p.badges || []).map((t, k) => h('span', { key: 'b' + k, className: 'fr-tag fr-tag-hl' }, t)),
                    frameTags(p).map((t, k) => h('span', { key: k, className: 'fr-tag' }, t)),
                    props.installedOf(p) === true ? h('span', { className: 'fr-tag' }, '已装') : null,
                  ),
                ),
                h(
                  'div',
                  { className: 'fr-side' },
                  h(
                    'div',
                    { className: 'fr-stars' },
                    props.deltaOf ? '+' + props.deltaOf(p) : '★ ' + fmtStars(p.stars),
                  ),
                  h('div', { className: 'fr-upd' }, agoShort(p.pushedAt)),
                  h('button', { className: 'fr-mini', onClick: () => props.onAsk(p) }, '问'),
                ),
              ),
            )
          : h('div', { className: 'fr-emptynote' }, props.empty || '暂无'),
        h(
          'div',
          { className: 'fr-more' },
          rows.length
            ? '共 ' + rows.length + ' 条 · 点名字开仓库 · 点「问」带到右边咨询'
            : '',
        ),
      );
    }

    /** 咨询：单独一块，输入 + 快捷问题 + 流式回答全在这一块里闭合。 */
    function AskPanel(props) {
      const c = props.d.consult;
      const quick = ['值得装吗', '能干什么', '有什么坑', '和我装的重复吗'];
      const ans = c.answer;
      const canSend = !!(c.q || '').trim() && !(ans && ans.running);

      return h(
        'section',
        { className: 'ddp-col fr-askcol' },
        h(
          'div',
          { className: 'ddp-col-h' },
          h('h3', null, '咨询'),
          h('span', null, props.d.askModel ? props.d.askModel : '看到疑似有用的，就在这里问'),
        ),
        h(
          'div',
          { className: 'ddp-col-b fr-ask-b' },
          h(
            'div',
            { className: 'fr-ask-row' },
            h('textarea', {
              className: 'ddp-ask-in fr-ask-in fr-ask-ta',
              placeholder:
                '贴插件名 / 仓库链接 / 一句话描述，也可以直接贴整段 README 或 package.json（Cmd/Ctrl+Enter 发送）',
              rows: 3,
              value: c.q,
              onChange: (e) => c.setQ(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  c.send();
                }
              },
              disabled: !!(ans && ans.running),
            }),
            h(
              'button',
              {
                className: 'ddp-btn ddp-btn-solid fr-ask-go',
                onClick: () => c.send(),
                disabled: !canSend,
              },
              ans && ans.running ? '…' : '问',
            ),
          ),
          h(
            'div',
            { className: 'fr-ask-qs' },
            quick.map((t, i) =>
              h(
                'button',
                {
                  key: i,
                  className: 'fr-ask-q',
                  disabled: !!(ans && ans.running),
                  onClick: () => c.send((c.q ? c.q + '｜' : '') + t),
                },
                t,
              ),
            ),
          ),
          h(
            'div',
            { className: 'fr-slot grow' },
            h(
              'div',
              { className: 'fr-slot-k' },
              ans ? (ans.running ? '回答中…' : '回答') : '回答区 · 流式显示在这里（块内闭合）',
            ),
            h(
              'div',
              { className: 'fr-ans' + (ans && ans.error ? ' err' : '') },
              ans
                ? ans.error
                  ? '出错：' + ans.error
                  : ans.text
                    ? linkifyText(ans.text)
                    : ans.running
                      ? '…'
                      : '（空）'
                : '在上面的框里贴一个插件名、仓库链接或一句话描述，回车或点「问」。',
            ),
            ans && !ans.error && !ans.running
              ? (function () {
                  const list = collectRefs(ans.text, ans.resolved);
                  if (!list.length) return null;
                  return h(
                    'div',
                    { className: 'fr-refs' },
                    h('span', { className: 'fr-refs-k' }, '参考'),
                    list.map((name) => h(RefChip, { key: name, name: name })),
                  );
                })()
              : null,
            ans && (ans.meta || ans.resolved)
              ? h(
                  'div',
                  { className: 'fr-ans-meta' },
                  (ans.resolved ? '已锁定 ' + ans.resolved + ' · ' : '') +
                    (ans.meta || '') +
                    (ans.totalMs ? ' · ' + (ans.totalMs / 1000).toFixed(1) + 's' : ''),
                )
              : null,
          ),
        ),
      );
    }

    function FrameCol(props) {
      return h(
        'section',
        { className: 'ddp-col' },
        h('div', { className: 'ddp-col-h' }, h('h3', null, props.title), h('span', null, props.hint)),
        h('div', { className: 'ddp-col-b' }, props.children),
      );
    }

    /* ── 版式 B：顶部快讯横带 → 上排 头条 | 咨询 → 下排 今日精选 | 新出现 ── */
    function FrameB(props) {
      const d = props.d;
      const askAbout = (p) => {
        const desc = cleanText(p.description || '').slice(0, 200);
        d.consult.setQ('这个插件值不值得装：' + p.fullName + (desc ? '\n' + desc : ''));
      };

      return h(
        'div',
        { className: 'ddp-body' },
        h(WireBand, { d: d, onAsk: askAbout }),
        h(
          'div',
          { className: 'ddp-row ddp-row-top' },
          h(
            FrameCol,
            { title: '头条', hint: d.view.lead ? '今日精选 · 1' : '空' },
            h(LeadBlock, {
              p: d.view.lead,
              zh: d.view.lead ? d.introOf(d.view.lead) : null,
              installed: d.view.lead ? d.isInstalled(d.view.lead) : null,
              onAsk: askAbout,
              empty: d.loading ? '正在取榜单…' : '这一窗里没有仓库有动静。',
            }),
          ),
          h(AskPanel, { d: d }),
        ),
        h(
          'div',
          { className: 'ddp-row ddp-row-bot' },
          h(
            FrameCol,
            {
              title: d.view.liveCount
                ? '综合榜'
                : d.view.liveReady && d.view.staleDays > 2
                  ? '最新一批'
                  : '今日精选',
              hint:
                d.view.today.length +
                ' 条 · ' +
                (d.view.liveCount
                  ? '实时 · 新建/活跃/热度加权（45/30/25）'
                  : d.view.liveReady && d.view.staleDays > 2
                    ? '数据停在 ' + mdText(d.view.newest)
                    : '近 24 小时有提交'),
            },
            h(ListBlock, {
              rows: d.view.today,
              introOf: d.introOf,
              installedOf: d.isInstalled,
              onAsk: askAbout,
              empty: d.loading
                ? '正在取榜单…'
                : d.view.staleDays > 2
                  ? '近 7 天没有插件更新，榜单数据也停在 ' + mdText(d.view.newest) + '。'
                  : '这一窗里没有刚提交过的仓库。',
            }),
          ),
          h(
            FrameCol,
            { title: '新出现', hint: d.view.fresh.length + ' 条 · 近 ' + NEW_WINDOW_DAYS + ' 天收录' },
            h(ListBlock, {
              rows: d.view.fresh,
              introOf: d.introOf,
              installedOf: d.isInstalled,
              onAsk: askAbout,
              empty: d.loading ? '正在取榜单…' : '这一窗里没有新仓库记录。',
            }),
          ),
        ),
      );
    }

    function FramePanel() {
      const d = useDailyData();
      const w = useWatch();
      const [tab, setTab] = useState('today');
      useEffect(() => {
        ensureDdpCss();
        ensureWatchCss();
      }, []);

      const stale = d.registry ? Math.round(daysBetween(d.registry.meta && d.registry.meta.generatedAt) || 0) : null;
      const now = new Date();
      const dateText =
        now.getFullYear() +
        ' 年 ' +
        (now.getMonth() + 1) +
        ' 月 ' +
        now.getDate() +
        ' 日 · 星期' +
        '日一二三四五六'[now.getDay()];

      const stats = [
        '今日精选 ' + d.view.today.length,
        '新出现 ' + d.view.fresh.length,
        '涨得最快 ' + d.view.rising.length,
        'GitHub 实时 ' + (d.ghFresh ? d.ghFresh.length : '—'),
        stale != null && stale > 2
          ? '⚠ 榜单已停更 ' + stale + ' 天'
          : '更新 ' + (stale == null ? '—' : stale <= 0 ? '今天' : stale + ' 天前'),
      ];

      return h(
        'div',
        { className: 'ddp-frame' },

        h(
          'div',
          { className: 'ddp-mast' },
          h(
            'div',
            null,
            h('h1', null, '每日推送'),
            h(
              'div',
              { className: 'ddp-mast-sub' },
              '收录 ' + (d.view.total || '—') + ' 个仓库 · 榜单 ' +
                ((d.registry && d.registry.meta && d.registry.meta.generatedAt) || '—').slice(0, 10),
            ),
          ),
          h(
            'div',
            { className: 'ddp-mast-tools' },
            h('span', { className: 'ddp-frame-note' }, dateText),
            h(
              'button',
              { className: 'ddp-tool', onClick: d.reload, disabled: d.loading },
              d.loading ? '刷新中' : '刷新',
            ),
          ),
        ),

        h(
          'div',
          { className: 'ddp-stats' },
          stats.map((t, i) => h('span', { key: i, className: 'ddp-stat' }, t)),
        ),

        d.error
          ? h('div', { className: 'ddp-fail' }, '榜单数据加载失败：' + d.error)
          : null,

        h(
          'div',
          { className: 'ddp-tabs' },
          h(
            'button',
            { className: 'ddp-tab' + (tab === 'today' ? ' is-on' : ''), onClick: () => setTab('today') },
            '今日精选',
          ),
          h(
            'button',
            {
              className: 'ddp-tab' + (tab === 'watch' ? ' is-on' : ''),
              onClick: () => {
                setTab('watch');
                w.ack();
              },
            },
            '插件动态',
            w.changes.length ? h('b', { className: 'ddp-tab-n' }, String(w.changes.length)) : null,
          ),
        ),

        tab === 'watch' ? h(WatchPanel, { w: w }) : h(FrameB, { d: d }),

        h(
          'footer',
          { className: 'ddp-foot' },
          h('span', null, '数据 dsh-recommend + GitHub · 中文介绍由本地模型生成并缓存（最多 200 条）'),
          h('span', null, '收录不等于安全背书，装之前先看一眼源码'),
        ),
      );
    }

    /* ─────────── 版式 C（密度优先）：官方置顶条 / 三榜并列 / 其他项目 / 咨询 ─────────── */

    /* 出问题时的回退开关：控制台执行 window.__DDP_DENSE = false 再刷新，就回到旧版式 */
    const DENSE_MODE = (function () {
      try {
        if (typeof window !== 'undefined' && window.__DDP_DENSE === false) return false;
      } catch (err) {
        /* 忽略 */
      }
      return true;
    })();

    const DENSE_KEY = 'dsh-daily-push:dense:v1';
    const DENSE_DEFAULT = {
      blur: true, scale: 1, alpha: 0.55, theme: 'auto' };
    const DENSE_SCALES = [0.94, 1, 1.1];
    const DENSE_ALPHAS = [0.42, 0.55, 0.78];
    const DENSE_BLUR = [true, false];

    function readDensePrefs() {
      try {
        const raw = window.localStorage.getItem(DENSE_KEY);
        if (!raw) return Object.assign({}, DENSE_DEFAULT);
        const j = JSON.parse(raw) || {};
        return {
          scale: DENSE_SCALES.indexOf(j.scale) >= 0 ? j.scale : DENSE_DEFAULT.scale,
          alpha: DENSE_ALPHAS.indexOf(j.alpha) >= 0 ? j.alpha : DENSE_DEFAULT.alpha,
          theme: j.theme === 'dark' || j.theme === 'light' ? j.theme : 'auto',
          blur: j.blur === false ? false : true,
        };
      } catch (err) {
        return Object.assign({}, DENSE_DEFAULT);
      }
    }

    function writeDensePrefs(prefs) {
      try {
        window.localStorage.setItem(DENSE_KEY, JSON.stringify(prefs));
      } catch (err) {
        /* 忽略 */
      }
    }

    function isOfficialRepo(name) {
      return /^deepseek-ai\//i.test(String(name || ''));
    }

    function looksLikeDshPlugin(row) {
      const name = String((row && row.fullName) || '');
      const desc = String((row && row.description) || '');
      /* 只看名字和描述：这些仓库几乎都挂着 dsh-plugin 标签，用标签判断等于全算插件 */
      return /(^|[/-])dsh/i.test(name) || /deepseek[\s-]?harness/i.test(desc);
    }

    /** 有中文就用中文；英文的交给宿主批量翻译（一次请求，宿主带磁盘缓存）。 */
    const HAS_CJK = /[\u4e00-\u9fa5]/;

    /** 一条一块地问宿主，返回 {name: zh}；失败/漏翻不抛错，交给下一轮补。 */
    function zhAsk(items) {
      return fetch(ZH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      })
        .then((res) => res.json())
        .then((j) => (j && j.map) || {})
        .catch(() => ({}));
    }

    const ZH_MEM = { at: 0, map: {} };
    function useZh(list) {
      const [map, setMap] = useState(() => (Date.now() - ZH_MEM.at < 300000 ? ZH_MEM.map : {}));
      const key = useMemo(() => (list || []).map((x) => x.name).join('|'), [list]);
      useEffect(() => {
        const todo = (list || []).filter((x) => x && x.name && x.desc && !HAS_CJK.test(x.desc));
        if (!todo.length) return undefined;
        let alive = true;
        const absorb = (got) => {
          if (!alive || !got) return;
          const keys = Object.keys(got);
          if (!keys.length) return;
          setMap((prev) => {
            const next = Object.assign({}, prev);
            let changed = false;
            for (const k of keys) {
              if (got[k] && next[k] !== got[k]) {
                next[k] = got[k];
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        };
        const run = async () => {
          if (Date.now() - ZH_MEM.at > 300000) {
            ZH_MEM.at = Date.now();
            ZH_MEM.map = {};
          }
          /* 一次问 15 条：太多会被截断，这正是上一版漏翻的原因 */
          const CHUNK = 15;
          const got = {};
          const chunks = [];
          for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
          for (const part of chunks) {
            if (!alive) return;
            const r = await zhAsk(part);
            Object.assign(got, r)
            Object.assign(ZH_MEM.map, r || {});
            absorb(r);
          }
          /* 还是漏的（模型少写、被限流）再补一轮，只补漏的部分 */
          const missing = todo.filter((x) => !got[x.name]);
          if (missing.length && alive) {
            await new Promise((r) => setTimeout(r, 1200));
            if (!alive) return;
            for (let i = 0; i < missing.length; i += CHUNK) {
              const r = await zhAsk(missing.slice(i, i + CHUNK));
              Object.assign(got, r);
              absorb(r);
            }
          }
        };
        run();
        return () => {
          alive = false;
        };
      }, [key]);
      return map;
    }

    const ZH_CSS = '.dsk-row .d.zh{color:rgba(214,224,236,.86)}';

    function denseRow(r) {
      if (!r) return null;
      const fullName = r.fullName || r.full_name || '';
      if (!fullName) return null;
      return {
        fullName,
        url: r.url || r.html_url || 'https://github.com/' + fullName,
        description: r.description || '',
        stars: r.stars != null ? r.stars : r.stargazers_count || 0,
        pushedAt: r.pushedAt || r.pushed_at || '',
        createdAt: r.createdAt || r.created_at || '',
        topics: r.topics || [],
        language: r.language || '',
        live: true,
      };
    }

    /** 「新」只看建库 30 天内；「热门」看星。两者可以同时为真，显示时以星数为先。 */
    const DENSE_NEW_DAYS = 30;
    function denseBadge(row) {
      if (row.stars >= 20000) return 'hot';
      const dd = daysBetween(row.createdAt);
      if (Number.isFinite(dd) && dd <= DENSE_NEW_DAYS) return 'new';
      return null;
    }
    function denseBadgeTitle(row) {
      const dd = daysBetween(row.createdAt);
      const created = Number.isFinite(dd) ? '建库 ' + dd + ' 天前' : '建库时间未知';
      return created + ' · ' + (row.stars || 0) + ' 星 · 最后提交 ' + agoShort(row.pushedAt);
    }

    const DENSE_CSS = `
.dsk{position:relative;--dsk-fs:1.08;--dsk-a:.55;--dsk-fg:#e9eff6;--dsk-mut:#98a6b8;--dsk-dim:#6f7b89;
  --dsk-line:rgba(255,255,255,.075);--dsk-card:rgba(255,255,255,.035);--dsk-acc:#7aa2f7;
  height:100%;min-height:0;display:flex;flex-direction:column;gap:6px;padding:8px 10px 6px;
  color:var(--dsk-fg);background:rgba(9,13,20,var(--dsk-a));
  -webkit-backdrop-filter:blur(26px) saturate(1.2);backdrop-filter:blur(26px) saturate(1.2);}
.dsk[data-theme="light"]{--dsk-fg:#1b2430;--dsk-mut:#5a6675;--dsk-dim:#7c8797;
  --dsk-line:rgba(16,24,40,.10);--dsk-card:rgba(255,255,255,.72);--dsk-acc:#2f6fd0;
  background:rgba(250,251,253,calc(.55 + var(--dsk-a)*.42));}
.dsk-head{display:flex;align-items:baseline;gap:10px;padding:0 2px;flex:0 0 auto}
.dsk-head h1{font-size:calc(15px*var(--dsk-fs));font-weight:700;letter-spacing:.02em;margin:0}
.dsk-head .sub{font-size:calc(10.4px*var(--dsk-fs));color:var(--dsk-dim)}
.dsk-head .sub b{color:#f2b263;font-weight:600}
.dsk-head .tools{margin-left:auto;display:flex;gap:6px;align-items:center}
.dsk-btn{border:1px solid var(--dsk-line);background:var(--dsk-card);color:var(--dsk-fg);
  border-radius:5px;padding:2px 8px;font-size:calc(10.8px*var(--dsk-fs));cursor:pointer}
.dsk-btn:hover{border-color:var(--dsk-acc)}
.dsk-btn[disabled]{opacity:.5;cursor:default}
.dsk-gear{padding:2px 7px}
.dsk-prefs{position:absolute;right:12px;top:40px;z-index:60;width:228px;border-radius:9px;
  box-shadow:0 10px 28px rgba(0,0,0,.45);background:rgba(18,23,32,.97);
  border:1px solid var(--dsk-line);background:rgba(12,17,24,.97);box-shadow:0 10px 30px rgba(0,0,0,.5);
  padding:8px;display:flex;flex-direction:column;gap:7px;font-size:11px;color:#e9eff6}
.dsk-prefs .pf{display:flex;align-items:center;gap:6px}
.dsk-prefs .pf>span{width:44px;color:#94a2b3;font-size:10.5px}
.dsk-prefs .seg{margin-left:auto;display:flex;border:1px solid rgba(255,255,255,.12);border-radius:5px;overflow:hidden}
.dsk-prefs .seg button{border:0;background:transparent;color:#c3ccd8;font-size:10.5px;padding:2px 7px;cursor:pointer}
.dsk-prefs .seg button.on{background:rgba(122,162,247,.28);color:#fff}
.dsk-off{display:flex;align-items:center;gap:9px;padding:4px 9px;border-radius:7px;flex:0 0 auto;
  border:1px solid rgba(227,192,123,.24);background:linear-gradient(90deg,rgba(227,192,123,.10),rgba(227,192,123,.02))}
.dsk-off .lb{font-size:calc(9.4px*var(--dsk-fs));letter-spacing:.12em;color:#e3c07b;
  border:1px solid rgba(227,192,123,.42);border-radius:3px;padding:0 5px;white-space:nowrap}
.dsk-off a{display:flex;align-items:baseline;gap:5px;text-decoration:none;color:inherit;white-space:nowrap}
.dsk-off a b{font-size:calc(11.2px*var(--dsk-fs));font-weight:600}
.dsk-off a i{font-style:normal;font-size:calc(9.8px*var(--dsk-fs));color:var(--dsk-dim)}
.dsk-main{flex:1;min-height:0;display:grid;grid-template-columns:1fr 1fr 1fr 1.02fr;gap:6px}
.dsk-col{display:flex;flex-direction:column;min-height:0;background:var(--dsk-card);
  border:1px solid var(--dsk-line);border-radius:8px;overflow:hidden}
.dsk-ch{display:flex;align-items:baseline;gap:6px;padding:4px 9px 3px;flex:0 0 auto;
  border-bottom:1px solid var(--dsk-line);background:linear-gradient(180deg,rgba(255,255,255,.05),transparent)}
.dsk-ch h2{font-size:calc(12px*var(--dsk-fs));font-weight:700;margin:0;letter-spacing:.03em}
.dsk-ch .k{font-size:calc(8.8px*var(--dsk-fs));letter-spacing:.08em;text-transform:uppercase;color:var(--dsk-dim)}
.dsk-ch .c{margin-left:auto;font-size:calc(9.6px*var(--dsk-fs));color:var(--dsk-dim);font-variant-numeric:tabular-nums}
.dsk-body{flex:1;min-height:0;overflow:auto}
.dsk-body::-webkit-scrollbar{width:5px}
.dsk-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}
.dsk-row{display:grid;grid-template-columns:15px 1fr auto;gap:7px;padding:6px 9px 7px;text-decoration:none;color:inherit;content-visibility:auto;contain-intrinsic-size:auto 80px;
  border-bottom:1px solid rgba(255,255,255,.055)}
.dsk-row:hover{background:rgba(122,162,247,.10)}
.dsk-row .n{font-size:calc(9.2px*var(--dsk-fs));color:var(--dsk-dim);text-align:right;padding-top:1px;font-variant-numeric:tabular-nums}
.dsk-row .m{min-width:0;display:flex;flex-direction:column}
.dsk-row .t{display:flex;align-items:center;gap:4px;min-width:0}
.dsk-row .t b{font-size:calc(11.2px*var(--dsk-fs));font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsk-row .d{font-size:calc(10.4px*var(--dsk-fs));color:var(--dsk-mut);line-height:1.38;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsk-row .x{display:flex;flex-wrap:wrap;gap:6px;margin-top:3px;font-size:calc(9px*var(--dsk-fs));color:var(--dsk-dim)}
.dsk-row .x u{text-decoration:none;opacity:.85}
.dsk-row .x .tag{background:rgba(255,255,255,.055);border-radius:3px;padding:0 4px}
.dsk-row .x .warn{color:#e0a35c}
.dsk-row .v{font-size:calc(9.5px*var(--dsk-fs));color:var(--dsk-dim);white-space:nowrap;padding-top:1px;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:5px}
.dsk-star{border:0;background:transparent;color:var(--dsk-dim);cursor:pointer;font-size:calc(11px*var(--dsk-fs));line-height:1;padding:0 1px;opacity:.45;transition:opacity .12s,color .12s}
.dsk-row:hover .dsk-star{opacity:.9}
.dsk-star:hover{color:#ffc861;opacity:1}
.dsk-star.on{color:#ffc861;opacity:1}
    .dsk.solid{-webkit-backdrop-filter:none;backdrop-filter:none}
.dsk-b{font-style:normal;font-size:calc(8.2px*var(--dsk-fs));padding:1px 3px;border-radius:3px;border:1px solid;line-height:1.15}
.dsk-b-hot{color:#f2b263;border-color:rgba(242,178,99,.42);background:rgba(242,178,99,.12)}
.dsk-b-new{color:#7ee2a8;border-color:rgba(126,226,168,.42);background:rgba(126,226,168,.12)}
.dsk-side{display:flex;flex-direction:column;gap:6px;min-height:0;overflow:hidden}
.dsk-side>.ddp-col{flex:1 1 auto;min-height:0;overflow:auto;background:var(--dsk-card);border:1px solid var(--dsk-line);border-radius:8px;display:flex;flex-direction:column}
.dsk-watch{border:1px solid var(--dsk-line);border-radius:8px;background:var(--dsk-card);overflow:hidden;display:flex;flex:0 0 auto;max-height:42%;min-height:96px;flex-direction:column;min-height:0;flex:.62}
.dsk-watch .ddp-watched{padding:0;display:flex;flex-direction:column;min-height:0;flex:1}
.dsk-watch .ddp-watched-head{padding:4px 9px 2px;border-bottom:1px solid var(--dsk-line)}
.dsk-watch .ddp-watched-head span{display:none}
.dsk-watch .ddp-watched-add{padding:4px 8px;gap:5px;display:flex}
.dsk-watch .ddp-watched-input{font-size:calc(10.2px*var(--dsk-fs));padding:2px 6px}
.dsk-watch .ddp-watched-list{overflow:auto;flex:1}
.dsk-watch .ddp-watched-row{padding:3px 9px}
.dsk-watch .ddp-watch-desc{display:none}
.dsk-bottom{flex:0 0 auto;display:flex;gap:8px;min-height:0}
.dsk-oth{flex:1 1 auto;min-width:0;height:246px;display:flex;flex-direction:column;background:var(--dsk-card);
  border:1px solid rgba(181,140,240,.24);border-radius:8px;overflow:hidden}
.dsk-oth .dsk-ch{background:linear-gradient(180deg,rgba(181,140,240,.13),transparent);border-bottom-color:rgba(181,140,240,.2)}
.dsk-oth .dsk-ch h2{color:#cbb3f2}
.dsk-ogrid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(3,1fr);gap:2px 10px;align-content:start;overflow:hidden}
.dsk-ogrid-2{grid-template-columns:repeat(2,1fr)}
.dsk-offcard{flex:0 0 34%;display:flex;flex-direction:column;height:246px;background:var(--dsk-card);
  border:1px solid rgba(214,178,94,.30);border-radius:8px;overflow:hidden}
.dsk-offcard .dsk-ch{background:linear-gradient(180deg,rgba(214,178,94,.13),transparent);border-bottom-color:rgba(214,178,94,.24)}
.dsk-offcard .dsk-ch h2{color:#e8cd8f}
.dsk-oc{display:grid;grid-template-columns:13px 1fr;gap:5px;padding:2px 9px;text-decoration:none;color:inherit}
.dsk-oc:hover{background:rgba(181,140,240,.10)}
.dsk-oc .n{font-size:calc(9px*var(--dsk-fs));color:var(--dsk-dim);text-align:right;padding-top:1px}
.dsk-oc .m{min-width:0;display:flex;flex-direction:column}
.dsk-oc b{font-size:calc(11px*var(--dsk-fs));font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsk-oc i{font-style:normal;font-size:calc(9.2px*var(--dsk-fs));color:var(--dsk-dim);font-variant-numeric:tabular-nums}
.dsk-oc s{text-decoration:none;font-size:calc(10px*var(--dsk-fs));color:var(--dsk-mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsk-foot{flex:0 0 auto;display:flex;gap:10px;font-size:calc(9.2px*var(--dsk-fs));color:var(--dsk-dim);padding:0 2px}
.dsk-empty{padding:10px 9px;font-size:calc(10.4px*var(--dsk-fs));color:var(--dsk-dim)}
`;

    function DenseRowView(props) {
      const p = props.p;
      const badge = denseBadge(p);
      const zhText = (props.zh && props.zh[p.fullName]) || '';
      const desc = zhText || p.description || '';
      const isWatch = !!(props.watched && props.watched[String(p.fullName).toLowerCase()]);
      return h(
        'a',
        { className: 'dsk-row', href: p.url, target: '_blank', rel: 'noreferrer', title: desc || p.fullName },
        h('span', { className: 'n' }, String(props.idx + 1)),
        h(
          'span',
          { className: 'm' },
          h(
            'span',
            { className: 't' },
            h('b', null, p.fullName),
            badge === 'hot' ? h('i', { className: 'dsk-b dsk-b-hot', title: denseBadgeTitle(p) }, '热门') : null,
            badge === 'new' ? h('i', { className: 'dsk-b dsk-b-new', title: denseBadgeTitle(p) }, '新') : null,
          ),
          h('span', zhText ? { className: 'd zh' } : { className: 'd' }, cleanText(desc).slice(0, 150) || '这个作者还没有写简介呢'),
          h(
            'span',
            { className: 'x' },
            p.language ? h('u', null, p.language) : null,
            p.pushedAt ? h('u', null, '更新 ' + agoShort(p.pushedAt)) : null,
            (p.topics || [])
              .filter((t) => !/^(dsh-plugin|dsh|plugin|plugins|harness)$/i.test(String(t).trim()))
              .slice(0, 2)
              .map((t) => h('u', { key: t, className: 'tag' }, String(t).trim())),
            p.archived ? h('u', { className: 'warn' }, '已归档') : null,
          ),
        ),
        h(
          'span',
          { className: 'v' },
          props.metric,
          h(
            'button',
            {
              className: 'dsk-star' + (isWatch ? ' on' : ''),
              title: isWatch ? '取消关注' : '加入「我关注的」，之后有更新会提醒',
              onClick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (props.onWatch) props.onWatch(p.fullName, isWatch);
              },
            },
            isWatch ? '★' : '☆',
          ),
        ),
      );
    }

    function DenseCol(props) {
      return h(
        'section',
        { className: 'dsk-col' },
        h(
          'div',
          { className: 'dsk-ch' },
          h('h2', null, props.title),
          props.kicker ? h('span', { className: 'k' }, props.kicker) : null,
          h('span', { className: 'c' }, props.hint || String((props.rows || []).length)),
        ),
        h(
          'div',
          { className: 'dsk-body' },
          (props.rows || []).length
            ? props.rows.map((p, i) => h(DenseRowView, { key: p.fullName, p, idx: i, metric: props.metric(p), zh: props.zh, watched: props.watched, onWatch: props.onWatch }))
            : h('div', { className: 'dsk-empty' }, props.empty || '这一栏暂时没有内容。'),
        ),
      );
    }

    function DensePrefs(props) {
      const prefs = props.prefs;
      const seg = (key, options) =>
        h(
          'div',
          { className: 'seg' },
          options.map((o) =>
            h(
              'button',
              {
                key: String(o.v),
                className: (prefs[key] === o.v ? 'on ' : '') + '',
                onClick: () => props.onChange(Object.assign({}, prefs, { [key]: o.v })),
              },
              o.t,
            ),
          ),
        );
      return h(
        'div',
        { className: 'dsk-prefs' },
        h('div', { className: 'pf' }, h('span', null, '字号'), seg('scale', [
          { v: DENSE_SCALES[0], t: '紧凑' },
          { v: DENSE_SCALES[1], t: '标准' },
          { v: DENSE_SCALES[2], t: '宽松' },
        ])),
        h('div', { className: 'pf' }, h('span', null, '浓度'), seg('alpha', [
          { v: DENSE_ALPHAS[0], t: '透' },
          { v: DENSE_ALPHAS[1], t: '中' },
          { v: DENSE_ALPHAS[2], t: '实' },
        ])),
        h('div', { className: 'pf' }, h('span', null, '磨砂'), seg('blur', [
          { v: true, t: '开' },
          { v: false, t: '关（省内存）' },
        ])),
        h('div', { className: 'pf' }, h('span', null, '主题'), seg('theme', [
          { v: 'auto', t: '跟随' },
          { v: 'dark', t: '深' },
          { v: 'light', t: '浅' },
        ])),
      );
    }

    function DensePanel() {
      const d = useDailyData();
      const w = useWatch();
      const [tab, setTab] = useState('today');
      const [prefs, setPrefs] = useState(() => readDensePrefs());
      const [showPrefs, setShowPrefs] = useState(false);

      useEffect(() => {
        ensureDdpCss();
        ensureWatchCss();
      }, []);

      const change = (next) => {
        setPrefs(next);
        writeDensePrefs(next);
      };

      const stale = d.registry ? Math.round(daysBetween(d.registry.meta && d.registry.meta.generatedAt) || 0) : null;
      const v = d.view;
      const official = v.official || [];
      const others = v.others || [];
      const zhItems = useMemo(() => {
        const all = [];
        for (const group of [v.starsTop, v.newTop, v.actTop, v.others, v.official]) {
          for (const r of group || []) {
            if (r && r.fullName) all.push({ name: r.fullName, desc: r.description || '' });
          }
        }
        const seen = {};
        return all.filter((x) => {
          if (seen[x.name]) return false;
          seen[x.name] = true;
          return true;
        });
      }, [v]);
      const zh = useZh(zhItems);
      const watchedMap = useMemo(() => {
        const m = {};
        for (const it of w.watched || []) {
          if (it && it.repo) m[String(it.repo).toLowerCase()] = true;
        }
        return m;
      }, [w.watched]);
      const toggleWatch = (name, on) => {
        w.edit(on ? 'remove' : 'add', name);
      };

      let theme = prefs.theme;
      if (theme === 'auto') {
        let light = false;
        try {
          const root = document.documentElement;
          const attr = (root.getAttribute('data-theme') || root.getAttribute('data-color-scheme') || '').toLowerCase();
          if (attr.indexOf('light') >= 0) light = true;
          else if (attr.indexOf('dark') >= 0) light = false;
          else light = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
        } catch (err) {
          light = false;
        }
        theme = light ? 'light' : 'dark';
      }

      const style = {
        ['--dsk-fs']: String(prefs.scale),
        ['--dsk-a']: String(prefs.alpha),
      };

      const now = new Date();
      const stamp =
        now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') +
        ' ' + '日一二三四五六'[now.getDay()];

      return h(
        'div',
        { className: 'dsk' + (prefs.blur === false ? ' solid' : ''), 'data-theme': theme, style },
        h(
          'div',
          { className: 'dsk-head' },
          h('h1', null, '每日推送'),
          h(
            'span',
            { className: 'sub' },
            '收录 ' + (v.total || '—') + ' 个旧榜单仓库 · 三榜各 15 · 官方已剔除 · ',
            stale != null && stale > 2
              ? h(
                  'b',
                  { title: '旧榜单文件（dsh-recommend）最后一次生成是 ' + stale + ' 天前，三榜数据取自 GitHub 实时搜索，不受影响' },
                  '旧榜单快照 ' + stale + ' 天未更新（三榜为实时）',
                )
              : h('b', null, '榜单更新 ' + (stale == null ? '—' : stale + ' 天前')),
          ),
          h(
            'div',
            { className: 'tools' },
            h('span', { className: 'sub' }, stamp),
            h('button', { className: 'dsk-btn', onClick: d.reload, disabled: d.loading }, d.loading ? '刷新中' : '刷新'),
            h('button', { className: 'dsk-btn dsk-gear', title: '显示设置', onClick: () => setShowPrefs(!showPrefs) }, '⚙'),
          ),
        ),
        showPrefs ? h(DensePrefs, { prefs, onChange: change }) : null,

        d.error ? h('div', { className: 'ddp-fail' }, '榜单数据加载失败：' + d.error) : null,

        tab === 'watch'
          ? h(WatchPanel, { w })
          : h(
              'div',
              { className: 'dsk-main' },
              h(DenseCol, {
                title: '星数榜',
                kicker: 'by stars',
                rows: v.starsTop || [],
                hint: '15',
                metric: (p) => '★' + fmtStars(p.stars),
                zh,
                watched: watchedMap,
                onWatch: toggleWatch,
                empty: d.loading ? '正在取数据…' : '还没有数据。',
              }),
              h(DenseCol, {
                title: '新建榜',
                kicker: 'newest',
                rows: v.newTop || [],
                hint: '15',
                metric: (p) => agoShort(p.createdAt),
                zh,
                watched: watchedMap,
                onWatch: toggleWatch,
                empty: d.loading ? '正在取数据…' : '这一窗里没有新仓库。',
              }),
              h(DenseCol, {
                title: '活跃榜',
                kicker: 'recently pushed',
                rows: v.actTop || [],
                hint: '15',
                metric: (p) => agoShort(p.pushedAt),
                zh,
                watched: watchedMap,
                onWatch: toggleWatch,
                empty: d.loading ? '正在取数据…' : '这一窗里没有刚提交的仓库。',
              }),
              h(
                'div',
                { className: 'dsk-side' },
                h(AskPanel, { d }),
                h('div', { className: 'dsk-watch' }, h(WatchList, { w })),
              ),
            ),

        h(
          'div',
          { className: 'dsk-bottom' },
          h(
          'div',
          { className: 'dsk-offcard' },
          h(
            'div',
            { className: 'dsk-ch' },
            h('h2', null, '官方仓库'),
            h('span', { className: 'k' }, 'deepseek-ai · 单独追踪'),
            h('span', { className: 'c' }, official.length + ' 个'),
          ),
          h(
            'div',
            { className: 'dsk-ogrid dsk-ogrid-2' },
            official.length
              ? official.map((o, i) =>
                  h(
                    'a',
                    { className: 'dsk-oc', key: o.fullName, href: o.url, target: '_blank', rel: 'noreferrer', title: (zh && zh[o.fullName]) || o.description || o.fullName },
                    h('span', { className: 'n' }, String(i + 1)),
                    h(
                      'span',
                      { className: 'm' },
                      h('b', null, o.fullName),
                      h('i', null, '★' + fmtStars(o.stars) + ' · ' + agoShort(o.pushedAt)),
                      h('s', null, cleanText((zh && zh[o.fullName]) || o.description || '').slice(0, 88) || '作者还没写简介'),
                    ),
                  ),
                )
              : h('div', { className: 'dsk-empty' }, '没取到官方仓库。'),
          ),
        ),
          h(
          'div',
          { className: 'dsk-oth' },
          h(
            'div',
            { className: 'dsk-ch' },
            h('h2', null, '其他项目（非插件）'),
            h('span', { className: 'k' }, 'software · tools · lists'),
            h('span', { className: 'c' }, others.length + ' 个'),
          ),
          h(
            'div',
            { className: 'dsk-ogrid' },
            others.length
              ? others.map((p, i) =>
                  h(
                    'a',
                    { className: 'dsk-oc', key: p.fullName, href: p.url, target: '_blank', rel: 'noreferrer', title: (zh && zh[p.fullName]) || p.description || p.fullName },
                    h('span', { className: 'n' }, String(i + 1)),
                    h(
                      'span',
                      { className: 'm' },
                      h('b', null, p.fullName),
                      h('i', null, '★' + fmtStars(p.stars) + ' · ' + agoShort(p.pushedAt)),
                      h('s', null, cleanText((zh && zh[p.fullName]) || p.description || '').slice(0, 56) || '作者还没写简介'),
                    ),
                  ),
                )
              : h('div', { className: 'dsk-empty' }, '这一窗没有非插件项目。'),
          ),
        ),
        ),

        h(
          'div',
          { className: 'dsk-foot' },
          h('span', null, '数据 dsh-recommend + GitHub 实时'),
          h('span', null, '星数榜已滤掉非插件'),
          h('span', null, '官方只在顶部条，不进任何榜'),
          h('span', null, '点任意一行打开仓库'),
        ),
      );
    }
    const NAV_ICON = (props) => {
      const size = (props && props.size) || 16;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 5, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M8 3v4M16 3v4M3 10h18' }),
        h('path', { d: 'M12 13v4M10 15h4' }),
      );
    };

    /** 主区域面板：骨架阶段渲染三栏看板，否则渲染完整内容版。*/
    const DailyPushPanel = () =>
      DENSE_MODE
        ? h(DensePanel)
        : FRAME_MODE
          ? h(FramePanel)
          : h('div', { className: 'ddp-main' }, h(DailyPushTab));

    return {
      __test: { zhIntro, cleanText, FramePanel, FrameB, WireBand, LeadBlock, ListBlock, AskPanel, WatchPanel, WatchList, useDailyData, buildConsultQuestion, scoreRepo, W_STAR, W_ACT, W_NEW, DensePanel, DenseCol, DenseRowView, denseRow, looksLikeDshPlugin },
      inject: ['slots'],
      apply(ctx) {
        // 1) 左侧导航栏（和「任务看板」/「任务清单」同一排）：点它切到下面的主区域面板。
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 200, label: () => '每日推送' },
                NAV_ICON,
              ),
            ),
          'dsh-daily-push: sidebar nav',
        );

        // 2) 主区域面板，key 与导航 id 一致。
        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register({ name: 'main', key: PANEL_ID }, DailyPushPanel),
            ),
          'dsh-daily-push: main panel',
        );

        // 3) 顺带仍挂一个更好侧边栏的 tab（装了 better-sidebar 时才有）。
        if (ctx.get('betterSidebar')) {
          ctx.effect(
            () =>
              ctx.get('betterSidebar').registerTab({
                id: TAB_ID,
                title: '每日推送',
                description: '每天一份插件简报：新出现的、涨得最快的、今日精选',
                icon: h(NAV_ICON, { size: 16 }),
                order: 40,
                single: true,
                component: () => h(DailyPushTab),
              }),
            'dsh-daily-push: sidebar tab',
          );
        }
      },
    };
  },
});
