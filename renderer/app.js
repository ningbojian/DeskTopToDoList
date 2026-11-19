const $ = (s) => document.querySelector(s);
const content = $('#content');
const countEl = $('#count');
const hintEl = $('#hint');
const btnMode = $('#btn-mode');
const dropMask = $('#drop-mask');
const reviewMask = $('#review-mask');

let cards = [];
let saveTimer = null;
let reviewCandidates = [];

const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
function saveNow() { clearTimeout(saveTimer); saveTimer = setTimeout(() => window.api.saveBoard(cards), 250); }

// ================= DDL parsing (based on system time) =================
function pad(n) { return String(n).padStart(2, '0'); }
function toLocalInput(y, mo, d, h, mi) { return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`; }
function extractDue(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ');
  const now = new Date();
  let year = null, month = null, day = null, hour = null, minute = 0, m;

  if ((m = t.match(/(20\d{2})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})\s*日?/))) {
    year = +m[1]; month = +m[2]; day = +m[3];
  } else if ((m = t.match(/(?:^|\D)(\d{1,2})\s*[月/.\-]\s*(\d{1,2})\s*[日号]?(?=\D|$)/))) {
    month = +m[1]; day = +m[2]; year = now.getFullYear();
  } else {
    let base = null;
    if (/今天|今日/.test(t)) base = 0;
    else if (/明天|明日/.test(t)) base = 1;
    else if (/后天/.test(t)) base = 2;
    else if (/大后天/.test(t)) base = 3;
    else if ((m = t.match(/下?\s*(?:周|星期)\s*([一二三四五六日天1-7])/))) {
      const map = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':0,'天':0,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':0 };
      const target = map[m[1]];
      const nextWeek = /下/.test(m[0]);
      if (target !== undefined) {
        let delta = (target - now.getDay() + 7) % 7;
        if (delta === 0) delta = 7;
        if (nextWeek) delta += 7;
        base = delta;
      }
    } else if ((m = t.match(/(\d+)\s*天[后内]/))) {
      base = parseInt(m[1], 10);
    }
    if (base !== null) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + base);
      year = d.getFullYear(); month = d.getMonth() + 1; day = d.getDate();
    }
  }
  if (month == null || day == null) return null;

  if ((m = t.match(/(\d{1,2})\s*[:：]\s*(\d{2})/))) { hour = +m[1]; minute = +m[2]; }
  else if ((m = t.match(/(\d{1,2})\s*点\s*(\d{1,2})?\s*分?/))) { hour = +m[1]; minute = m[2] ? +m[2] : 0; }
  if (hour !== null) {
    if (/下午|晚上|傍晚|夜里|pm/i.test(t) && hour < 12) hour += 12;
    if (/上午|早上|凌晨|am/i.test(t)) hour = hour === 12 ? 0 : hour;
    if (/晚上|夜里/.test(t) && hour < 12) hour += 12;
  } else { hour = 23; minute = 59; }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  if (year !== null) {
    const dt = new Date(year, month - 1, day, hour, minute);
    if (dt.getTime() < now.getTime() - 60 * 1000 && !/(20\d{2})/.test(t)) dt.setFullYear(dt.getFullYear() + 1);
    return toLocalInput(dt.getFullYear(), dt.getMonth() + 1, dt.getDate(), dt.getHours(), dt.getMinutes());
  }
  return null;
}

// ================= OCR sifting: DATE-CENTRIC =================
// Principle: a line only becomes a todo if we can attach a real date/time to it.
// Lines without any time anchor are noise (DEC, KB/S, building names, footers…)
// and are dropped. This keeps the signal clean and puts DDL first.
const NOISE_PATTERNS = [
  /^\s*\d{4}[-/.年]\s*\d{1,2}[-/.月]\s*\d{1,2}\s*日?\s*$/,
  /^\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]\s*$/,
  /^\s*第?\s*\d+\s*[页张]\s*$/,
  /^\s*[—\-=_*·•|]{2,}\s*$/,
];
// English task words (screenshots are often English) + Chinese
const TASK_SIGNALS = /提交|上交|完成|交付|复习|预习|考试|测验|开会|会议|汇报|报告|截止|ddl|deadline|due|交作业|交材料|记得|提醒|准备|发送|发布|上线|报名|缴费|支付|续费|预约|面试|回复|联系|整理|检查|修改|填写|签|领|取|买|订|exam|examination|test|quiz|meeting|report|assignment|homework|project|task|review|presentation|interview|payment|renew|register|apply|submit|finish|complete/i;
const DDL_SIGNALS = /截止|ddl|deadline|due|之前|前交|按时|务必|最迟|到期|时限|交期|before|no later|close/i;
// event title: course code like "CS5187 Vision and Image", or a named event
const EVENT_TITLE = /^([A-Z]{1,6}\s?\d{3,4}[A-Z]?)\b|^(?:exam|test|meeting|assignment|report|考试|会议|面试|报告)/i;
// venue / building / room lines — NEVER the todo itself, but may follow an event
const VENUE = /lecture\s?theatre|theatre|bldg|building|room|campus|acad|hall|教学楼|教室|室|楼|昌|finished|upcoming|completed|^[A-Z]?\s*\d{3,5}\s*$/i;
// a time range like "18:30 - 20:30" / "18 ： 30 - 20 ： 30"
const TIME_ONLY = /^\s*0?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[-~—至to]+\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*$|^(\d{1,2})\s*[-~—至]\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*$/i;
// lines that are UI/status-bar noise, never content
const UI_NOISE = /^\s*(kb\/s|k\s*b\s*\/\s*s|wifi|dec|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|\d{1,2}\s*[:：]\s*\d{2}\s*$|6\s*[．.]\s*\d{2})/i;
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };

function looksLikeNoise(line) {
  const s = line.trim();
  if (!s || s.length < 3) return true;
  if (TIME_ONLY.test(s)) return false;
  if (/^[\d\s\-—_./:：()（）]+$/.test(s)) return true;
  return NOISE_PATTERNS.some(p => p.test(s));
}

// pull a start clock (hour, minute) out of any text
function pickTime(text) {
  let m;
  if ((m = text.match(/\b(\d{1,2})\s*[:：]\s*(\d{2})\s*[-~—至to]+\s*\d{1,2}\s*[:：]\s*\d{2}/i)) ||
      (m = text.match(/\b(\d{1,2})\s*[:：]\s*(\d{2})\b/))) {
    return { h: +m[1], m: +m[2] };
  }
  if ((m = text.match(/(\d{1,2})\s*点\s*(\d{1,2})?\s*分?/))) {
    let h = +m[1], mi = m[2] ? +m[2] : 0;
    if (/下午|晚上|傍晚|pm/i.test(text) && h < 12) h += 12;
    if (/上午|早上|凌晨/.test(text) && h === 12) h = 0;
    return { h, m: mi };
  }
  return null;
}

// pull a month/day out of a line (Chinese, ISO, English "DEC 19" / "19 Dec")
function pickDate(text) {
  const now = new Date();
  let m, year = null, month = null, day = null;
  if ((m = text.match(/(20\d{2})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})\s*日?/))) {
    year = +m[1]; month = +m[2]; day = +m[3];
  } else if ((m = text.match(/(?:^|[\s(（])(\d{1,2})\s*[月/.\-]\s*(\d{1,2})\s*[日号]?(?=\s|[)）]|$)/)) && !/[a-zA-Z]\s*\d*[/.]\s*\d/.test(text)) {
    month = +m[1]; day = +m[2]; year = now.getFullYear();
  } else if ((m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i))) {
    month = MONTHS[m[1].toLowerCase()]; day = +m[2]; year = now.getFullYear();
  } else if ((m = text.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i))) {
    day = +m[1]; month = MONTHS[m[2].toLowerCase()]; year = now.getFullYear();
  }
  if (month == null || day == null || month > 12 || day > 31) return null;
  return { year, month, day, hasYear: year !== null };
}
function buildDue(date, time) {
  if (!date) return '';
  const now = new Date();
  const h = time ? time.h : 23, mi = time ? time.m : 59;
  if (h > 23 || mi > 59) return '';
  const dt = new Date(date.year || now.getFullYear(), date.month - 1, date.day, h, mi);
  if (!date.year || date.year === now.getFullYear()) {
    if (dt.getTime() < now.getTime() - 60 * 1000) dt.setFullYear(dt.getFullYear() + 1);
  }
  return toLocalInput(dt.getFullYear(), dt.getMonth() + 1, dt.getDate(), dt.getHours(), dt.getMinutes());
}

// One date that applies to the whole image (e.g. timetable header "DEC 19").
function findGlobalDate(fullText) {
  const t = String(fullText || '').replace(/\s+/g, ' ');
  let m;
  // ISO / Chinese full date
  if ((m = t.match(/(20\d{2})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})\s*日?/))) {
    return { year: +m[1], month: +m[2], day: +m[3], hasYear: true };
  }
  // English month name + day, e.g. "DEC 19" / "19 December"
  if ((m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/i))) {
    const mo = MONTHS[m[1].toLowerCase()], d = +m[2];
    if (mo && d >= 1 && d <= 31) return { year: new Date().getFullYear(), month: mo, day: d, hasYear: true };
  }
  if ((m = t.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i))) {
    const d = +m[1], mo = MONTHS[m[2].toLowerCase()];
    if (mo && d >= 1 && d <= 31) return { year: new Date().getFullYear(), month: mo, day: d, hasYear: true };
  }
  return null;
}

// Clean an OCR'd event title: strip leading bullets/numbers and fix the most
// common OCR letter confusions (I↔l, O↔0 in words) without touching real dates.
function cleanEventName(s) {
  let t = String(s || '')
    .replace(/^[\s\d•·\-—*>|]+/, '')      // leading bullets / list numbers
    .replace(/\s+/g, ' ')
    .trim();
  // word-boundary fixes only, so numbers like 12:30 or v1.2 are untouched
  t = t.replace(/\bl(?=[a-z])/g, 'I')      // lmage→Image, lntroduction→Introduction
       .replace(/\btO\b/g, 'to')           // tO→to
       .replace(/\blnternet/g, 'Internet')
       .replace(/\bO(?=[a-z]{2,})/g, 'O'); // no-op placeholder, keep O
  return t;
}

// DATE-CENTRIC analyzer: only emit items that have a usable DDL.
function analyzeLines(lines, fullText, dates) {
  // lines may be objects {text,x,y,w,h} (coordinate-aware) or plain strings.
  const hasCoords = lines && lines.length && typeof lines[0] === 'object' && lines[0].text !== undefined;
  const items = (lines || []).map(l => {
    if (hasCoords) return { text: String(l.text).trim(), y: Number(l.y) || 0, x: Number(l.x) || 0 };
    return { text: String(l).trim(), y: -1, x: -1 };
  });
  const global = findGlobalDate(fullText || items.map(i => i.text).join(' '));
  const dateList = Array.isArray(dates) ? dates : [];

  // For a head at y=Y, pick the date label whose y is closest but above it.
  function dateForY(headY) {
    if (headY < 0 || !dateList.length) return null;
    let best = null, bestDy = Infinity;
    for (const d of dateList) {
      const dy = headY - d.y;
      if (dy >= -10 && dy < bestDy && dy < 400) { bestDy = dy; best = d; }
    }
    if (!best) return null;
    const mo = typeof best.month === 'number' ? best.month : MONTHS[String(best.month).toLowerCase()];
    if (!mo) return null;
    return { year: new Date().getFullYear(), month: mo, day: best.day, hasYear: true };
  }

  // Group: an "event head" line collects following time / venue lines.
  const groups = [];
  for (const item of items) {
    const raw = item.text;
    const probe = raw.replace(/^[\s|•·\-—*>0-9]+/, '').trim(); // leading bullets/| before matching
    if (looksLikeNoise(raw)) continue;
    if (UI_NOISE.test(raw)) continue;              // status bar / repeated month labels
    // Pure UI/section headers are not todos (timetable title, Upcoming, etc.)
    if (/^(examination\s+timetable|timetable|upcoming|finished|schedule|课程表|时间表)$/i.test(probe)) continue;
    const isTime = TIME_ONLY.test(raw);
    const isVenue = VENUE.test(raw);
    const ownDate = pickDate(raw);
    const isHead = EVENT_TITLE.test(probe) || TASK_SIGNALS.test(probe) || ownDate;

    if (isTime || isVenue) {
      if (groups.length) {
        const g = groups[groups.length - 1];
        if (isTime && !g.time) g.time = pickTime(raw);
        g.tail.push(raw);
      }
      continue;
    }
    if (isHead) {
      groups.push({ head: raw, y: item.y, time: pickTime(raw), date: ownDate, tail: [] });
    } else if (groups.length) {
      groups[groups.length - 1].tail.push(raw);
    }
  }

  const seen = new Set();
  const out = [];
  for (const g of groups) {
    const allText = [g.head, ...g.tail].join(' ').replace(/\s+/g, ' ').trim();
    // coordinate-paired date > date in text > image-wide date
    const coordDate = dateForY(g.y);
    const date = coordDate || g.date || pickDate(g.head) || (g.tail.map(pickDate).find(Boolean)) || null;
    const effectiveDate = date || global;
    const time = g.time || pickTime(allText);
    const due = buildDue(effectiveDate, time);

    // THE key filter: without a DDL it isn't worth reminding → drop it.
    if (!due) continue;

    const codeMatch = g.head.match(EVENT_TITLE);
    const hasTask = TASK_SIGNALS.test(allText);
    const hasDdl = DDL_SIGNALS.test(allText);
    let confidence = 'mid', reason = '识别到时间';
    if (hasDdl && date) { confidence = 'high'; reason = '含明确截止日期'; }
    else if (codeMatch && time) { confidence = 'high'; reason = '事件 + 时间'; }
    else if (hasTask && time) { confidence = 'high'; reason = '任务 + 时间'; }
    else if (date) { confidence = 'high'; reason = '含日期'; }

    let text = cleanEventName(g.head);
    if (!text) text = cleanEventName(allText);
    const key = text.replace(/\s/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, due, confidence, reason, source: allText, id: uid() });
  }

  const rank = { high: 0, mid: 1, low: 2 };
  out.sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.due.localeCompare(b.due));
  return out.slice(0, 30);
}

// ================= time formatting =================
function fmtDiff(ms) {
  const s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), mi = Math.floor(s % 3600 / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${mi}分`;
  if (mi > 0) return `${mi}分`;
  return `${s}秒`;
}
function fmtDueCanvas(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return `${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ================= render list =================
function render() {
  if (!cards.length) {
    content.innerHTML = `<div class="empty"><span class="big">📝</span>还没有内容<br>点 ＋ 添加文字，🖼 添加图片，或把图片直接拖进来<br>图片里的待办会自动识别并让你勾选导入</div>`;
  } else {
    content.innerHTML = cards.map(rowHtml).join('');
  }
  const open = cards.filter(c => !c.done).length;
  countEl.textContent = open ? `${open} 项待办` : (cards.length ? '全部完成' : '');
  tick();
}

function rowHtml(c) {
  if (c.type === 'image') {
    const hidden = !!c.imgHidden;
    return `<div class="row ${c.done ? 'done' : ''}" data-id="${c.id}">
      <img class="img-thumb ${hidden ? 'collapsed' : ''}" src="${esc(c.src)}" data-act="zoom" title="${hidden ? '点击显示图片' : '点击隐藏图片'}">
      <div class="row-main">
        <div class="text">图片待办</div>
        <div class="row-meta">
          ${c.candCount ? `<span class="tag">⏰ ${c.candCount} 项带时间</span>` : ''}
          ${c.ocrStatus === 'empty' ? `<span class="img-note">图中未识别到日期</span>` : ''}
          ${c.ocrStatus === 'loading' ? `<span class="img-note">识别中…</span>` : ''}
          ${c.ocrStatus === 'error' ? `<span class="tag error">识别失败</span>` : ''}
          <input class="due" type="datetime-local" value="${esc(c.due || '')}">
          <span class="countdown"></span>
        </div>
      </div>
      <div class="row-tools">
        ${c.candCount ? `<button class="icon-btn eye" data-act="review" title="查看识别结果">✓</button>` : ''}
        <button class="icon-btn eye" data-act="retry" title="重新识别">⟳</button>
        <button class="icon-btn eye" data-act="toggle" title="显示/隐藏图片">👁</button>
        <button class="icon-btn" data-act="del" title="删除">✕</button>
      </div>
    </div>`;
  }
  return `<div class="row ${c.done ? 'done' : ''} ${c.fromOcr ? 'ocr-row' : ''}" data-id="${c.id}">
    <input class="chk" type="checkbox" ${c.done ? 'checked' : ''}>
    <div class="row-main">
      <div class="text" contenteditable="true" spellcheck="false">${esc(c.text)}</div>
      <div class="row-meta">
        <input class="due" type="datetime-local" value="${esc(c.due || '')}">
        <span class="countdown"></span>
      </div>
    </div>
    <div class="row-tools"><button class="icon-btn" data-act="del" title="删除">✕</button></div>
  </div>`;
}

function tick() {
  const now = Date.now();
  content.querySelectorAll('.row').forEach(el => {
    const c = cards.find(x => x.id === el.dataset.id);
    if (!c) return;
    const cd = el.querySelector('.countdown');
    if (!cd) return;
    el.classList.remove('urgent');
    if (c.done) { cd.className = 'countdown ok'; cd.textContent = '完成'; return; }
    if (!c.due) {
      cd.className = 'countdown normal';
      cd.textContent = c.type === 'image' ? '' : '';
      return;
    }
    const diff = new Date(c.due).getTime() - now;
    if (diff <= 0) { cd.className = 'countdown overdue'; cd.textContent = '逾期 ' + fmtDiff(diff); el.classList.add('urgent'); }
    else if (diff <= 60 * 60 * 1000) { cd.className = 'countdown soon'; cd.textContent = fmtDiff(diff); el.classList.add('urgent'); }
    else if (diff <= 24 * 60 * 60 * 1000) { cd.className = 'countdown soon'; cd.textContent = fmtDiff(diff); }
    else { cd.className = 'countdown normal'; cd.textContent = fmtDueCanvas(c.due); }
  });
}

// ================= actions =================
function addText() {
  cards.push({ id: uid(), type: 'text', text: '', due: '', done: false, createdAt: Date.now() });
  render(); saveNow();
  scrollToBottom();
  setTimeout(() => content.querySelector('.row:last-child .text')?.focus(), 50);
}
function scrollToBottom() { content.scrollTop = content.scrollHeight; }

async function recognizeCard(c) {
  c.ocrStatus = 'loading'; c.candCount = 0; c.candidates = [];
  render(); saveNow();
  const res = await window.api.ocrImage(c.src);
  if (!res.ok) { c.ocrStatus = 'error'; render(); saveNow(); return; }

  const candidates = analyzeLines(res.lines, res.text, res.dates || []);
  c.candidates = candidates;
  c.candCount = candidates.length;
  c.ocrStatus = candidates.length ? 'done' : 'empty';
  // Date is the whole point: auto-stamp the earliest detected DDL onto the
  // image card so its countdown/reminder works even before importing items.
  if (candidates.length) {
    const dues = candidates.map(x => x.due).filter(Boolean).sort();
    if (dues.length) c.due = dues[0];
  }
  render(); saveNow();
  if (candidates.length) openReview(c);
}

async function processImageUrl(url) {
  const c = { id: uid(), type: 'image', src: url, text: '', due: '', done: false, imgHidden: false, candCount: 0, candidates: [], ocrStatus: 'loading', createdAt: Date.now() };
  cards.push(c);
  render(); saveNow(); scrollToBottom();
  await recognizeCard(c);
}

async function addImage() {
  const urls = await window.api.selectImage();
  if (!urls || !urls.length) return;
  for (const url of urls) await processImageUrl(url);
}

// ================= review panel (proactive ask) =================
function openReview(card) {
  reviewCandidates = card.candidates.map(c => ({ ...c, checked: true }));
  const listHtml = reviewCandidates.map((c, i) => `
    <div class="cand" data-i="${i}">
      <input type="checkbox" ${c.checked ? 'checked' : ''}>
      <div class="cand-body">
        <div class="cand-text" contenteditable="true" spellcheck="false">${esc(c.text)}</div>
        <div class="cand-meta">
          <span class="conf ${c.confidence}">${c.confidence === 'high' ? '高' : c.confidence === 'mid' ? '中' : '低'}·${esc(c.reason)}</span>
          <input class="cand-due" type="datetime-local" value="${esc(c.due || '')}" title="可修改截止时间">
        </div>
      </div>
    </div>`).join('');
  reviewMask.innerHTML = `<div class="review">
    <div class="review-head">
      <h3>⏰ 识别到 ${reviewCandidates.length} 项带日期的待办</h3>
      <p>已按日期自动标注时间并默认全选。确认后点“导入”，就会变成带提醒的文字待办。</p>
    </div>
    <div class="review-list">${listHtml}</div>
    <div class="review-foot">
      <button class="btn ghost" data-act="cancel">取消</button>
      <button class="btn ghost" data-act="none">全不选</button>
      <button class="btn primary" data-act="import">导入选中</button>
    </div>
  </div>`;
  reviewMask.classList.add('show');
  reviewMask.dataset.cardId = card.id;
}
function closeReview() { reviewMask.classList.remove('show'); reviewMask.innerHTML = ''; reviewCandidates = []; }

function collectReview() {
  reviewMask.querySelectorAll('.cand').forEach(el => {
    const i = +el.dataset.i;
    if (!reviewCandidates[i]) return;
    reviewCandidates[i].checked = el.querySelector('input[type=checkbox]').checked;
    reviewCandidates[i].text = el.querySelector('.cand-text').innerText.trim();
    reviewCandidates[i].due = el.querySelector('.cand-due').value;
  });
}
function importCandidates() {
  collectReview();
  const picked = reviewCandidates.filter(c => c.checked && c.text);
  for (const c of picked) {
    cards.push({ id: uid(), type: 'text', text: c.text, due: c.due || '', done: false, fromOcr: true, createdAt: Date.now() });
  }
  closeReview(); render(); saveNow(); scrollToBottom();
}

// ================= events =================
$('#btn-add-text').addEventListener('click', addText);
$('#btn-add-image').addEventListener('click', addImage);
$('#btn-hide').addEventListener('click', () => window.api.hideWindow());
btnMode.addEventListener('click', async () => {
  const cur = await window.api.getMode();
  await window.api.setMode(cur === 'top' ? 'desktop' : 'top');
  syncModeButton();
});
function syncModeButton() {
  window.api.getMode().then(m => {
    btnMode.textContent = m === 'top' ? '📌' : '🖥';
    btnMode.classList.toggle('active', m === 'top');
    btnMode.title = m === 'top' ? '当前：置顶（点击切换为贴桌面）' : '当前：贴桌面（点击切换为置顶）';
    hintEl.textContent = m === 'top' ? '拖图片到窗口添加 · 拖标题栏移动' : '贴桌面模式 · 不遮挡其他窗口';
  });
}
window.api.onModeChanged && window.api.onModeChanged(() => syncModeButton());

// list row interactions (event delegation)
content.addEventListener('click', (e) => {
  const el = e.target.closest('.row');
  if (!el) return;
  const c = cards.find(x => x.id === el.dataset.id);
  if (!c) return;
  const act = e.target.dataset.act;
  if (act === 'del') { cards = cards.filter(x => x.id !== c.id); render(); saveNow(); }
  else if (act === 'toggle') { c.imgHidden = !c.imgHidden; render(); saveNow(); }
  else if (act === 'zoom') {
    if (c.imgHidden) { c.imgHidden = false; render(); saveNow(); }
    else window.open(c.src);
  }
  else if (act === 'review' && c.candidates && c.candidates.length) openReview(c);
  else if (act === 'retry') recognizeCard(c);
});
content.addEventListener('change', (e) => {
  const el = e.target.closest('.row');
  if (!el) return;
  const c = cards.find(x => x.id === el.dataset.id);
  if (!c) return;
  if (e.target.classList.contains('chk')) { c.done = e.target.checked; render(); saveNow(); }
  if (e.target.classList.contains('due')) { c.due = e.target.value; saveNow(); tick(); }
});
content.addEventListener('input', (e) => {
  if (!e.target.classList.contains('text')) return;
  const el = e.target.closest('.row');
  const c = cards.find(x => x.id === el?.dataset.id);
  if (c) { c.text = e.target.innerText; saveNow(); }
});

// review panel buttons
reviewMask.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (act === 'cancel') closeReview();
  else if (act === 'none') reviewMask.querySelectorAll('.cand input[type=checkbox]').forEach(cb => cb.checked = false);
  else if (act === 'import') importCandidates();
});

// ================= drag & drop images =================
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropMask.classList.add('show'); });
document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dropMask.classList.remove('show'); } });
document.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; dropMask.classList.remove('show');
  const files = [...(e.dataTransfer.files || [])].filter(f => /^image\//.test(f.type));
  for (const f of files) {
    const p = window.api.getFilePath(f);
    if (!p) continue;
    const r = await window.api.importImagePath(p);
    if (r.ok) await processImageUrl(r.url);
  }
});

// ================= window dragging & resize =================
let dragging = false, lastX = 0, lastY = 0;
$('#titlebar').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  dragging = true; lastX = e.screenX; lastY = e.screenY;
});
document.addEventListener('mousemove', (e) => {
  if (dragging) { window.api.moveBy(e.screenX - lastX, e.screenY - lastY); lastX = e.screenX; lastY = e.screenY; }
});
document.addEventListener('mouseup', () => { dragging = false; });
let resizing = false;
$('#resizer').addEventListener('mousedown', (e) => { e.stopPropagation(); resizing = true; });
document.addEventListener('mousemove', (e) => {
  if (resizing) window.api.resizeTo(window.outerWidth + e.movementX, window.outerHeight + e.movementY);
});
document.addEventListener('mouseup', () => { resizing = false; });

// ================= init =================
(async function init() {
  cards = await window.api.getBoard();
  syncModeButton();
  render();
  setInterval(tick, 1000);
})();
