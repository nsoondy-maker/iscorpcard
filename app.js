'use strict';

/* ===== 공통 유틸 ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } }
};
const won = n => (Math.round(n) || 0).toLocaleString('ko-KR');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ===== 컬럼 정의 (회사 법인카드 필드) ===== */
const FIELDS = [
  ['seq', '순번'], ['card', '카드번호'], ['user', '이용자명'], ['date', '이용일'], ['merchant', '가맹점명'],
  ['amount', '이용금액'], ['addr', '가맹점주소'], ['bizno', '사업자등록번호'], ['appr', '승인번호'],
  ['tax', '과세유형'], ['slip', '전표구분'], ['usd', '미화금액'], ['fx', '미화환율'], ['time', '승인시간'],
  ['mcc', '가맹점업종코드'], ['mccName', '가맹점업종명'], ['fuel', '유종'], ['unit', '리터당단가']
];
const REQUIRED = ['user', 'date', 'merchant', 'amount', 'addr'];
const norm = s => String(s ?? '').replace(/[\s_\-()]/g, '');
const HEADER_MAP = Object.fromEntries(FIELDS.map(([k, label]) => [norm(label), k]));

/* ===== 상태 ===== */
const state = {
  rows: [],          // 정규화된 카드내역
  homes: LS.get('homes', []),   // [{name, addr}]
  geoCache: LS.get('geoCache', {}),
  results: [],       // 분석된 거래
  users: [],         // 이용자별 요약
  map: null, markers: [], circle: null, homeMarker: null, info: null,
  kakaoReady: null
};

/* ===== 탭 ===== */
function showTab(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'result' && state.map) setTimeout(() => state.map.relayout(), 50);
}
$('#tabs').addEventListener('click', e => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

/* ===== 설정 ===== */
const DEFAULT_CRITERIA = `[역할] 당신은 기업 감사팀의 분석가이며, 경영진(CEO·CFO)에게 법인카드 이상징후 탐지 결과를 보고한다.
[구성] 다음 순서의 마크다운으로 작성한다.
## 1. 핵심 결론 (3줄 이내, 결론 먼저)
## 2. 주요 지표 (전체 거래·금액, 집근처 사용, 휴일·심야·주의업종 사용 규모와 비율)
## 3. 이상징후 유형별 분석 (유형별 건수·금액·특징)
## 4. 확인이 필요한 이용자·거래 (상위 위험 건을 사유와 함께, 최대 5건)
## 5. 권고 조치 (즉시 조치 / 단기 개선 / 제도 개선으로 구분)
## 6. 분석의 한계 (좌표 미확인, 공휴일 반영 범위 등 데이터 한계)
[원칙]
- 제공된 데이터의 수치만 사용하고, 없는 수치·사실을 만들지 않는다.
- 이상징후는 부정사용의 증거가 아니다. "의심", "확인 필요" 등 중립적 표현을 쓰고 비위를 단정하지 않는다.
- 금액은 원 단위 천 단위 구분, 비율은 소수점 첫째 자리까지 표기한다.
- 전체 분량은 A4 1~1.5쪽, 경영진이 3분 안에 읽을 수 있게 간결하게 쓴다.
- 이용자는 입력된 표기(익명 포함)를 그대로 사용한다.`;
const settingIds = ['kakaoKey', 'radius', 'nightStart', 'nightEnd', 'keywords', 'geminiKey', 'geminiModel', 'reportCriteria'];
const settingChecks = ['holidayOn', 'maskNames'];
(function loadSettings() {
  const s = LS.get('settings', {});
  settingIds.forEach(id => { if (s[id]) $('#' + id).value = s[id]; });
  settingChecks.forEach(id => { if (s[id] != null) $('#' + id).checked = s[id]; });
  if (!$('#reportCriteria').value) $('#reportCriteria').value = DEFAULT_CRITERIA;
})();
$('#resetCriteria').onclick = () => { $('#reportCriteria').value = DEFAULT_CRITERIA; };
$('#saveSettings').onclick = () => {
  const s = Object.fromEntries(settingIds.map(id => [id, $('#' + id).value.trim()]));
  settingChecks.forEach(id => { s[id] = $('#' + id).checked; });
  LS.set('settings', s);
  $('#settingsMsg').textContent = '저장되었습니다.';
  setTimeout(() => $('#settingsMsg').textContent = '', 2000);
};
$('#clearAll').onclick = () => {
  if (!confirm('저장된 집주소, 지오코딩 캐시, 설정(키 포함)을 모두 삭제할까요?')) return;
  ['homes', 'geoCache', 'settings'].forEach(LS.del);
  state.homes = []; state.geoCache = {};
  renderHomes();
  alert('삭제되었습니다.');
};
const getSettings = () => ({
  key: $('#kakaoKey').value.trim(),
  radius: Math.max(50, Number($('#radius').value) || 1000),
  nightStart: Number($('#nightStart').value),
  nightEnd: Number($('#nightEnd').value),
  keywords: $('#keywords').value.split(',').map(s => s.trim()).filter(Boolean),
  holidayOn: $('#holidayOn').checked
});

/* ===== 파일 파싱 ===== */
async function readWorkbook(file) {
  const buf = await file.arrayBuffer();
  if (/\.csv$/i.test(file.name)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { text = new TextDecoder('euc-kr').decode(buf); }   // 카드사 CSV는 EUC-KR이 흔함
    return XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
  }
  return XLSX.read(buf, { type: 'array' });
}
async function readTable(file) {
  const wb = await readWorkbook(file);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: true, defval: '' });
}

function parseDate(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') {                         // 엑셀 시리얼
    const d = XLSX.SSF.parse_date_code(v);
    return d ? new Date(d.y, d.m - 1, d.d) : null;
  }
  const s = String(v).trim();
  let m = s.match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  return m ? new Date(2000 + +m[1], +m[2] - 1, +m[3]) : null;
}
const fmtDate = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';

function parseHour(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number' && v < 1) return Math.floor(v * 24);          // 엑셀 시간 소수
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return +m[1];
  m = s.replace(/\D/g, '');
  if (m.length >= 4) return +m.padStart(6, '0').slice(0, 2);
  return null;
}
const fmtTime = v => {
  if (v === '' || v == null) return '';
  const h = parseHour(v);
  if (h == null) return String(v);
  const s = typeof v === 'number' && v < 1 ? null : String(v).replace(/\D/g, '').padStart(6, '0');
  return s ? `${s.slice(0, 2)}:${s.slice(2, 4)}` : `${String(h).padStart(2, '0')}:00`;
};
const parseNum = v => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[,\s원]/g, ''));
  return isNaN(n) ? 0 : n;
};

function normalizeRows(table) {
  if (!table.length) throw new Error('데이터가 비어 있습니다.');
  const cols = Object.keys(table[0]);
  const colOf = {};
  cols.forEach(c => { const k = HEADER_MAP[norm(c)]; if (k && !colOf[k]) colOf[k] = c; });
  const missing = REQUIRED.filter(k => !colOf[k]);
  if (missing.length) throw new Error('필수 컬럼이 없습니다: ' + missing.map(k => FIELDS.find(f => f[0] === k)[1]).join(', '));
  return table.map((r, i) => {
    const o = {};
    for (const [k] of FIELDS) o[k] = colOf[k] ? r[colOf[k]] : '';
    o.seq = o.seq === '' ? i + 1 : o.seq;
    o.user = String(o.user).trim();
    o.merchant = String(o.merchant).trim();
    o.addr = String(o.addr).trim();
    o.dateObj = parseDate(o.date);
    o.amt = parseNum(o.amount);
    if (/취소/.test(o.slip) && o.amt > 0) o.amt = -o.amt;
    o.hour = parseHour(o.time);
    return o;
  }).filter(r => r.user || r.merchant);
}

async function loadCardFile(file) {
  try {
    state.rows = normalizeRows(await readTable(file));
    showDataInfo(file.name);
  } catch (e) {
    $('#dataInfo').innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p>`;
  }
}
function showDataInfo(name) {
  const rows = state.rows;
  const users = new Set(rows.map(r => r.user));
  const noAddr = rows.filter(r => !r.addr).length;
  const total = rows.reduce((s, r) => s + r.amt, 0);
  $('#dataInfo').innerHTML = `<p><b>${esc(name)}</b> — ${rows.length.toLocaleString()}건 · 이용자 ${users.size}명 · 합계 ${won(total)}원` +
    (noAddr ? ` · <span style="color:var(--amber)">주소 없음 ${noAddr}건 (가맹점명으로 검색 시도)</span>` : '') + '</p>';
  $('#previewCard').hidden = false;
  const head = FIELDS.filter(([k]) => rows.some(r => r[k] !== '' && r[k] != null));
  $('#previewTable').innerHTML = '<thead><tr>' + head.map(([, l]) => `<th>${l}</th>`).join('') + '</tr></thead><tbody>' +
    rows.slice(0, 50).map(r => '<tr>' + head.map(([k]) => {
      const v = k === 'date' ? fmtDate(r.dateObj) || r.date : k === 'time' ? fmtTime(r.time) : r[k];
      return `<td${k === 'amount' ? ' class="num"' : ''}>${esc(k === 'amount' ? won(r.amt) : v)}</td>`;
    }).join('') + '</tr>').join('') + '</tbody>';
}

const drop = $('#drop'), fileInput = $('#file');
drop.onclick = () => fileInput.click();
fileInput.onchange = () => fileInput.files[0] && loadCardFile(fileInput.files[0]);
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && loadCardFile(e.dataTransfer.files[0]); };

$('#sampleLink').onclick = async e => {
  e.preventDefault();
  try {
    const res = await fetch('sample/cards.csv');
    const f = new File([await res.blob()], 'cards.csv');
    await loadCardFile(f);
    const hres = await fetch('sample/homes.csv');
    const t = await readTable(new File([await hres.blob()], 'homes.csv'));
    state.homes = t.map(r => ({ name: String(r['이용자명'] ?? '').trim(), addr: String(r['집주소'] ?? '').trim() })).filter(h => h.name);
    LS.set('homes', state.homes);
    renderHomes();
  } catch {
    $('#dataInfo').innerHTML = '<p style="color:var(--red)">샘플을 불러오려면 start.bat으로 실행해야 합니다.</p>';
  }
};

/* ===== 집주소 ===== */
function renderHomes() {
  const tb = $('#homeTable tbody');
  tb.innerHTML = '';
  (state.homes.length ? state.homes : [{ name: '', addr: '' }]).forEach(h => tb.appendChild(homeRow(h)));
}
function homeRow(h) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input class="hn" value="${esc(h.name)}"></td><td><input class="ha" value="${esc(h.addr)}" placeholder="예: 서울 강남구 테헤란로 152"></td><td><button class="del">삭제</button></td>`;
  tr.querySelector('.del').onclick = () => tr.remove();
  return tr;
}
function collectHomes() {
  return $$('#homeTable tbody tr').map(tr => ({ name: $('.hn', tr).value.trim(), addr: $('.ha', tr).value.trim() })).filter(h => h.name);
}
$('#addHome').onclick = () => $('#homeTable tbody').appendChild(homeRow({ name: '', addr: '' }));
$('#saveHomes').onclick = () => {
  state.homes = collectHomes();
  LS.set('homes', state.homes);
  $('#homesMsg').textContent = `${state.homes.length}명 저장됨`;
  setTimeout(() => $('#homesMsg').textContent = '', 2500);
};
$('#loadUsers').onclick = () => {
  if (!state.rows.length) return alert('먼저 카드내역을 업로드하세요.');
  const cur = collectHomes();
  const have = new Set(cur.map(h => h.name));
  [...new Set(state.rows.map(r => r.user))].filter(u => u && !have.has(u)).forEach(u => cur.push({ name: u, addr: '' }));
  state.homes = cur;
  renderHomes();
};
$('#homeUpload').onclick = () => $('#homeFile').click();
$('#homeFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const t = await readTable(f);
  const merged = new Map(collectHomes().map(h => [h.name, h.addr]));
  t.forEach(r => {
    const n = String(r['이용자명'] ?? r['이름'] ?? '').trim();
    const a = String(r['집주소'] ?? r['주소'] ?? '').trim();
    if (n) merged.set(n, a);
  });
  state.homes = [...merged].map(([name, addr]) => ({ name, addr }));
  renderHomes();
  e.target.value = '';
};

/* ===== 카카오 SDK / 지오코딩 ===== */
function loadKakao(key) {
  if (state.kakaoReady) return state.kakaoReady;
  state.kakaoReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    s.onload = () => kakao.maps.load(resolve);
    s.onerror = () => { state.kakaoReady = null; reject(new Error('카카오 SDK 로드 실패: JavaScript 키와 등록된 사이트 도메인을 확인하세요.')); };
    document.head.appendChild(s);
  });
  return state.kakaoReady;
}

let geocoder, places;
const clean = a => a.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
const cacheKey = (a, n) => a ? 'a:' + clean(a) : 'n:' + n;

function addressSearch(q) {
  return new Promise(res => geocoder.addressSearch(q, (r, st) =>
    res(st === kakao.maps.services.Status.OK && r.length ? { lat: +r[0].y, lng: +r[0].x } : null)));
}
function keywordSearch(q) {
  return new Promise(res => places.keywordSearch(q, (r, st) =>
    res(st === kakao.maps.services.Status.OK && r.length ? { lat: +r[0].y, lng: +r[0].x } : null)));
}
/** 주소 → 좌표. 실패하면 뒤 토큰(층/호 등)을 줄여 재시도, 마지막엔 가맹점명 키워드 검색 */
async function geocode(addr, name) {
  const key = cacheKey(addr, name);
  if (key in state.geoCache) return state.geoCache[key];
  let pos = null;
  if (addr) {
    let q = clean(addr);
    for (let i = 0; i < 3 && q && !pos; i++) {
      pos = await addressSearch(q);
      const idx = q.lastIndexOf(' ');
      if (idx < 0) break;
      q = q.slice(0, idx);
    }
  }
  if (!pos && name) {
    const region = addr ? clean(addr).split(' ').slice(0, 2).join(' ') : '';
    pos = await keywordSearch((region + ' ' + name).trim());
  }
  state.geoCache[key] = pos;
  return pos;
}

async function runPool(items, worker, onTick, concurrency = 4) {
  let i = 0, done = 0;
  const run = async () => {
    while (i < items.length) {
      const it = items[i++];
      await worker(it);
      onTick(++done, items.length);
      await sleep(40);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, run));
}

/* ===== 분석 ===== */
function distM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const FIXED_HOLIDAYS = new Set(['01-01', '03-01', '05-05', '06-06', '08-15', '10-03', '10-09', '12-25']);
function isHoliday(d) {
  if (!d) return false;
  const day = d.getDay();
  return day === 0 || day === 6 || FIXED_HOLIDAYS.has(fmtDate(d).slice(5));
}
const isNight = (h, s, e) => h != null && (s > e ? (h >= s || h < e) : (h >= s && h < e));

function evaluate(r, home, merchantPos, cfg) {
  const flags = [];
  let score = 0, dist = null;
  if (home && merchantPos) {
    dist = distM(home, merchantPos);
    if (dist <= cfg.radius) { flags.push('집근처'); score += 40; }
  }
  if (cfg.holidayOn && isHoliday(r.dateObj)) { flags.push('휴일'); score += 20; }
  if (isNight(r.hour, cfg.nightStart, cfg.nightEnd)) { flags.push('심야'); score += 15; }
  const text = r.merchant + ' ' + r.mccName;
  if (cfg.keywords.some(k => text.includes(k))) { flags.push('주의업종'); score += 25; }
  const level = score >= 60 ? 'high' : score >= 40 ? 'mid' : 'low';
  return { dist, flags, score, level };
}

$('#run').onclick = async () => {
  const cfg = getSettings();
  const msg = $('#runMsg'), prog = $('#progress');
  if (!cfg.key) { showTab('settings'); return alert('카카오 JavaScript 키를 먼저 입력하세요.'); }
  if (!state.rows.length) { showTab('data'); return alert('카드내역을 먼저 업로드하세요.'); }
  state.homes = collectHomes().length ? collectHomes() : state.homes;
  if (!state.homes.some(h => h.addr)) { showTab('homes'); return alert('직원 집주소를 등록하세요.'); }

  $('#run').disabled = true;
  try {
    msg.textContent = '카카오 SDK 로딩 중...';
    await loadKakao(cfg.key);
    geocoder = new kakao.maps.services.Geocoder();
    places = new kakao.maps.services.Places();

    // 대상 수집 (중복 주소는 1회만 검색)
    const jobs = new Map();
    state.rows.forEach(r => jobs.set(cacheKey(r.addr, r.merchant), { addr: r.addr, name: r.merchant }));
    state.homes.filter(h => h.addr).forEach(h => jobs.set(cacheKey(h.addr, ''), { addr: h.addr, name: '' }));
    const todo = [...jobs.values()].filter(j => !(cacheKey(j.addr, j.name) in state.geoCache));

    prog.hidden = false; prog.max = Math.max(todo.length, 1); prog.value = 0;
    await runPool(todo, j => geocode(j.addr, j.name), (d, n) => {
      prog.value = d; msg.textContent = `주소 변환 ${d}/${n}`;
    });
    LS.set('geoCache', state.geoCache);

    const homeMap = new Map(state.homes.map(h => [h.name, h.addr ? { addr: h.addr, pos: state.geoCache[cacheKey(h.addr, '')] } : null]));
    state.results = state.rows.map(r => {
      const mp = state.geoCache[cacheKey(r.addr, r.merchant)] || null;
      const h = homeMap.get(r.user);
      return { ...r, pos: mp, home: h?.pos || null, homeAddr: h?.addr || '', ...evaluate(r, h?.pos, mp, cfg) };
    });
    summarize(cfg);
    renderResult(cfg);
    msg.textContent = `완료 — 좌표 미확인 ${state.results.filter(r => !r.pos).length}건`;
  } catch (e) {
    msg.textContent = '';
    alert(e.message || e);
  } finally {
    prog.hidden = true; $('#run').disabled = false;
  }
};

function summarize() {
  const by = new Map();
  state.results.forEach(r => {
    const u = by.get(r.user) || { user: r.user, count: 0, total: 0, near: 0, nearAmt: 0, high: 0, noHome: !r.home, unknown: 0, score: 0, hol: 0, holAmt: 0 };
    if (r.flags.includes('휴일')) { u.hol++; u.holAmt += r.amt; }
    u.count++; u.total += r.amt;
    if (r.flags.includes('집근처')) { u.near++; u.nearAmt += r.amt; }
    if (r.level === 'high') u.high++;
    if (!r.pos) u.unknown++;
    u.score += r.score;
    by.set(r.user, u);
  });
  state.users = [...by.values()].sort((a, b) => b.nearAmt - a.nearAmt || b.score - a.score);
}

/* ===== 결과 렌더링 ===== */
function levelBadge(l) {
  return `<span class="badge ${l}">${{ high: '높음', mid: '주의', low: '정상' }[l]}</span>`;
}

function renderResult(cfg) {
  $('#resultBody').hidden = false;
  $('#exportBtn').disabled = false;
  const R = state.results;
  const near = R.filter(r => r.flags.includes('집근처'));
  const total = R.reduce((s, r) => s + r.amt, 0);
  const nearAmt = near.reduce((s, r) => s + r.amt, 0);
  const high = R.filter(r => r.level === 'high').length;
  const hol = R.filter(r => r.flags.includes('휴일'));
  $('#kpis').innerHTML = [
    ['전체 거래', R.length.toLocaleString() + '건'],
    ['전체 금액', won(total) + '원'],
    [`집근처(${cfg.radius}m) 거래`, `${near.length.toLocaleString()}건 (${R.length ? (near.length / R.length * 100).toFixed(1) : 0}%)`],
    ['집근처 금액', won(nearAmt) + '원 (' + (total ? (nearAmt / total * 100).toFixed(1) : 0) + '%)'],
    ['휴일 사용', `${hol.length.toLocaleString()}건 · ${won(hol.reduce((s, r) => s + r.amt, 0))}원`],
    ['위험도 높음', high.toLocaleString() + '건'],
    ['집주소 미등록 이용자', state.users.filter(u => u.noHome).length + '명']
  ].map(([l, v]) => `<div class="kpi"><span>${l}</span><b>${v}</b></div>`).join('');

  $('#userTable').innerHTML = '<thead><tr><th>이용자</th><th class="num">건수</th><th class="num">금액</th><th class="num">집근처 건</th><th class="num">집근처 금액</th><th class="num">비율</th><th class="num">휴일 건</th><th class="num">휴일 금액</th><th>비고</th></tr></thead><tbody>' +
    state.users.map(u => `<tr class="click" data-user="${esc(u.user)}"><td>${esc(u.user)}</td><td class="num">${u.count}</td><td class="num">${won(u.total)}</td>
      <td class="num">${u.near}</td><td class="num">${won(u.nearAmt)}</td><td class="num">${u.count ? (u.near / u.count * 100).toFixed(0) : 0}%</td>
      <td class="num">${u.hol}</td><td class="num">${won(u.holAmt)}</td><td>${u.noHome ? '<span class="badge mid">집주소 없음</span>' : ''}${u.unknown ? `<span class="badge">좌표실패 ${u.unknown}</span>` : ''}</td></tr>`).join('') + '</tbody>';
  $$('#userTable tr.click').forEach(tr => tr.onclick = () => selectUser(tr.dataset.user, cfg));

  const fUser = $('#fUser');
  fUser.innerHTML = '<option value="">전체 이용자</option>' + state.users.map(u => `<option>${esc(u.user)}</option>`).join('');
  ['fUser', 'fLevel', 'fNear', 'fHoliday'].forEach(id => $('#' + id).onchange = renderTx);
  renderTx();
  initMap();
  drawMap(null, cfg);
}

function renderTx() {
  const u = $('#fUser').value, lv = $('#fLevel').value, nearOnly = $('#fNear').checked, holOnly = $('#fHoliday').checked;
  const list = state.results.filter(r =>
    (!u || r.user === u) && (!nearOnly || r.flags.includes('집근처')) && (!holOnly || r.flags.includes('휴일')) &&
    (!lv || (lv === 'high' ? r.level === 'high' : r.level !== 'low')))
    .sort((a, b) => b.score - a.score || (b.dateObj || 0) - (a.dateObj || 0));
  $('#fCount').textContent = `${list.length.toLocaleString()}건`;
  const shown = list.slice(0, 1500);
  $('#txTable').innerHTML = '<thead><tr><th>등급</th><th>이용자</th><th>이용일</th><th>시간</th><th>가맹점</th><th>업종</th><th class="num">금액</th><th class="num">집과 거리</th><th>사유</th></tr></thead><tbody>' +
    shown.map(r => `<tr class="click" data-i="${state.results.indexOf(r)}"><td>${levelBadge(r.level)}</td><td>${esc(r.user)}</td><td>${fmtDate(r.dateObj)}${r.dateObj ? ' (' + '일월화수목금토'[r.dateObj.getDay()] + ')' : ''}</td><td>${fmtTime(r.time)}</td>
      <td title="${esc(r.addr)}">${esc(r.merchant)}</td><td>${esc(r.mccName)}</td><td class="num">${won(r.amt)}</td>
      <td class="num">${r.dist == null ? (r.pos ? '집주소 없음' : '좌표실패') : r.dist < 1000 ? Math.round(r.dist) + 'm' : (r.dist / 1000).toFixed(1) + 'km'}</td>
      <td>${r.flags.map(f => `<span class="badge">${f}</span>`).join('')}</td></tr>`).join('') +
    '</tbody>' + (list.length > shown.length ? `<tfoot><tr><td colspan="9">상위 ${shown.length}건만 표시 (전체는 엑셀로 저장)</td></tr></tfoot>` : '');
  $$('#txTable tr.click').forEach(tr => tr.onclick = () => focusTx(state.results[+tr.dataset.i]));
}

/* ===== 지도 ===== */
function initMap() {
  if (state.map) { state.map.relayout(); return; }
  state.map = new kakao.maps.Map($('#map'), { center: new kakao.maps.LatLng(37.5665, 126.978), level: 8 });
  state.map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  state.info = new kakao.maps.InfoWindow({ removable: true });
}
const svgIcon = (color, shape) => {
  const body = shape === 'sq' ? `<rect x="3" y="3" width="18" height="18" fill="${color}" stroke="#fff" stroke-width="2"/>`
    : `<circle cx="12" cy="12" r="8" fill="${color}" stroke="#fff" stroke-width="2"/>`;
  return new kakao.maps.MarkerImage('data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">${body}</svg>`),
    new kakao.maps.Size(24, 24), { offset: new kakao.maps.Point(12, 12) });
};

function clearMap() {
  state.markers.forEach(m => m.setMap(null)); state.markers = [];
  state.circle?.setMap(null); state.circle = null;
  state.homeMarker?.setMap(null); state.homeMarker = null;
  state.info?.close();
}

function drawMap(user, cfg) {
  clearMap();
  const list = state.results.filter(r => r.pos && (!user || r.user === user));
  const bounds = new kakao.maps.LatLngBounds();
  const redIcon = svgIcon('#e5484d'), blueIcon = svgIcon('#3b82f6');
  const cap = user ? Infinity : 2000;
  list.slice(0, cap).forEach(r => {
    const p = new kakao.maps.LatLng(r.pos.lat, r.pos.lng);
    const m = new kakao.maps.Marker({ position: p, image: r.flags.includes('집근처') ? redIcon : blueIcon, map: state.map });
    kakao.maps.event.addListener(m, 'click', () => showInfo(r, m));
    r._marker = m;
    state.markers.push(m); bounds.extend(p);
  });
  const home = user && state.results.find(r => r.user === user && r.home)?.home;
  if (home) {
    const hp = new kakao.maps.LatLng(home.lat, home.lng);
    state.homeMarker = new kakao.maps.Marker({ position: hp, image: svgIcon('#111', 'sq'), map: state.map, zIndex: 10 });
    state.circle = new kakao.maps.Circle({ center: hp, radius: cfg.radius, strokeWeight: 2, strokeColor: '#e5484d', strokeOpacity: .8, fillColor: '#e5484d', fillOpacity: .08, map: state.map });
    bounds.extend(hp);
  }
  $('#mapMsg').textContent = user
    ? (home ? `${user}님 — 집 기준 반경 ${cfg.radius}m 원 표시` : `${user}님 — 집주소 좌표가 없어 반경을 표시할 수 없습니다.`)
    : `전체 거래 ${Math.min(list.length, cap).toLocaleString()}건 표시 · 이용자를 선택하면 집 기준 반경이 표시됩니다.`;
  if (!bounds.isEmpty()) state.map.setBounds(bounds, 40);
  setTimeout(() => state.map.relayout(), 0);
}

function showInfo(r, marker) {
  state.info.setContent(`<div class="info"><b>${esc(r.merchant)}</b><br>${esc(r.user)} · ${fmtDate(r.dateObj)} ${fmtTime(r.time)}<br>${won(r.amt)}원` +
    (r.dist != null ? `<br>집과 ${r.dist < 1000 ? Math.round(r.dist) + 'm' : (r.dist / 1000).toFixed(1) + 'km'}` : '') +
    (r.flags.length ? `<br>${r.flags.join(' · ')}` : '') + '</div>');
  state.info.open(state.map, marker);
}

function selectUser(user, cfg) {
  $$('#userTable tr.click').forEach(tr => tr.classList.toggle('sel', tr.dataset.user === user));
  $('#fUser').value = user;
  renderTx();
  drawMap(user, cfg || getSettings());
}

function focusTx(r) {
  if (!r.pos) return alert('이 거래는 좌표를 찾지 못했습니다.');
  if (!r._marker || !state.markers.includes(r._marker)) drawMap(r.user, getSettings());
  state.map.setLevel(3);
  state.map.panTo(new kakao.maps.LatLng(r.pos.lat, r.pos.lng));
  showInfo(r, r._marker);
}

/* ===== 엑셀 내보내기 ===== */
$('#exportBtn').onclick = () => {
  const tx = state.results.map(r => ({
    순번: r.seq, 이용자명: r.user, 카드번호: r.card, 이용일: fmtDate(r.dateObj), 승인시간: fmtTime(r.time),
    가맹점명: r.merchant, 가맹점주소: r.addr, 가맹점업종명: r.mccName, 이용금액: r.amt,
    '집과의거리(m)': r.dist == null ? '' : Math.round(r.dist), 위험점수: r.score,
    등급: { high: '높음', mid: '주의', low: '정상' }[r.level], 사유: r.flags.join(', '), 승인번호: r.appr
  }));
  const us = state.users.map(u => ({
    이용자명: u.user, 건수: u.count, 금액: u.total, 집근처건수: u.near, 집근처금액: u.nearAmt,
    집근처비율: u.count ? +(u.near / u.count).toFixed(3) : 0, 집주소: u.noHome ? '미등록' : '등록'
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(us), '이용자별');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tx), '거래상세');
  XLSX.writeFile(wb, `법인카드_집근처분석_${fmtDate(new Date())}.xlsx`);
};

renderHomes();

/* ===== 경영진 보고서 (Gemini) ===== */
let reportText = '';

/** 모델에 보낼 집계 데이터. 카드번호·집주소는 포함하지 않는다. */
function buildReportPayload(mask, cfg) {
  const R = state.results;
  const alias = new Map(state.users.map((u, i) => [u.user, mask ? '이용자' + String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '') : u.user]));
  const sum = a => a.reduce((s, r) => s + r.amt, 0);
  const by = f => { const a = R.filter(r => r.flags.includes(f)); return { 건수: a.length, 금액: sum(a) }; };
  const dates = R.map(r => r.dateObj).filter(Boolean).sort((a, b) => a - b);
  return {
    분석기간: dates.length ? `${fmtDate(dates[0])} ~ ${fmtDate(dates[dates.length - 1])}` : '미상',
    분석기준: { 집근처반경_m: cfg.radius, 심야시간: `${cfg.nightStart}시~${cfg.nightEnd}시`, 주의키워드: cfg.keywords, 휴일포함: cfg.holidayOn, 위험점수: '집근처40+휴일20+심야15+주의업종25, 60이상 높음, 40이상 주의' },
    전체: { 건수: R.length, 금액: sum(R), 이용자수: state.users.length, 좌표미확인건수: R.filter(r => !r.pos).length, 집주소미등록이용자수: state.users.filter(u => u.noHome).length },
    유형별: { 집근처: by('집근처'), 휴일: by('휴일'), 심야: by('심야'), 주의업종: by('주의업종') },
    위험등급건수: { 높음: R.filter(r => r.level === 'high').length, 주의: R.filter(r => r.level === 'mid').length },
    이용자별: state.users.slice(0, 15).map(u => ({
      이용자: alias.get(u.user), 건수: u.count, 금액: u.total, 집근처건수: u.near, 집근처금액: u.nearAmt, 휴일건수: u.hol, 휴일금액: u.holAmt, 위험도높음건수: u.high
    })),
    위험상위거래: [...R].filter(r => r.level !== 'low').sort((a, b) => b.score - a.score || b.amt - a.amt).slice(0, 20).map(r => ({
      이용자: alias.get(r.user), 이용일: fmtDate(r.dateObj), 시간: fmtTime(r.time), 가맹점: r.merchant, 업종: r.mccName,
      금액: r.amt, 집과거리_m: r.dist == null ? null : Math.round(r.dist), 사유: r.flags, 점수: r.score
    }))
  };
}

async function callGemini(key, model, criteria, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: criteria }] },
      contents: [{ role: 'user', parts: [{ text: '다음은 법인카드 이상징후 탐지 결과(JSON)다. 작성기준에 따라 경영진 보고서를 작성하라.\n\n' + JSON.stringify(payload) }] }],
      generationConfig: { temperature: 0.3 }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini 오류 (${res.status}): ${data.error?.message || res.statusText}`);
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error('응답이 비어 있습니다: ' + (data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || '원인 불명'));
  return text;
}

/** 필요한 만큼만 지원하는 마크다운 렌더러 (제목·굵게·목록·문단). 입력은 먼저 이스케이프한다. */
function renderMd(md) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '', inList = false;
  for (const line of md.split('\n')) {
    const li = line.match(/^\s*[-*]\s+(.*)/), h = line.match(/^(#{1,3})\s+(.*)/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}

$('#genReport').onclick = async () => {
  const key = $('#geminiKey').value.trim(), model = $('#geminiModel').value.trim() || 'gemini-2.5-flash';
  const criteria = $('#reportCriteria').value.trim() || DEFAULT_CRITERIA;
  if (!key) { showTab('settings'); return alert('① 설정에서 Gemini API Key를 입력하세요.'); }
  if (!state.results.length) return alert('먼저 분석을 실행하세요.');
  const btn = $('#genReport'), msg = $('#reportMsg');
  btn.disabled = true; msg.textContent = 'Gemini가 보고서를 작성 중...';
  try {
    reportText = await callGemini(key, model, criteria, buildReportPayload($('#maskNames').checked, getSettings()));
    $('#reportOut').innerHTML = renderMd(reportText);
    $('#reportOut').hidden = false;
    $('#copyReport').disabled = $('#dlReport').disabled = false;
    msg.textContent = '생성 완료 — AI 초안이므로 수치는 위 표와 대조 후 사용하세요.';
  } catch (e) {
    msg.textContent = '';
    alert(e.message || e);
  } finally { btn.disabled = false; }
};
$('#copyReport').onclick = async () => {
  try { await navigator.clipboard.writeText(reportText); $('#reportMsg').textContent = '복사되었습니다.'; }
  catch { $('#reportMsg').textContent = '복사 실패: 브라우저 권한을 확인하세요.'; }
};
$('#dlReport').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([reportText], { type: 'text/markdown;charset=utf-8' }));
  a.download = `경영진보고서_${fmtDate(new Date())}.md`;
  a.click(); URL.revokeObjectURL(a.href);
};
