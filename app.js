/* ============================================================
   SIMMONS 해외 매트리스 업계 동향 대시보드
   ============================================================ */

/* ── CSV 파일 경로 (섹션에서 재사용) ── */
const CSV = {
  market: 'market_trends.csv',
  competitor: 'competitor_analysis.csv',
  news: 'industry_news.csv',
  material: 'material_cost.csv',
};

/* ── 데이터셋 정의: 파일명 매핑 + 라벨 (전 섹션 공용) ──
   match: 업로드 파일명에 이 문자열(중 하나)이 포함되면 해당 데이터셋으로 자동 매핑. */
const DATASETS = [
  { key: 'market', file: CSV.market, match: 'market_trends', label: '해외 시장 동향' },
  { key: 'competitor', file: CSV.competitor, match: 'competitor_analysis', label: '경쟁사 분석' },
  { key: 'news', file: CSV.news, match: 'industry_news', label: '업계 주요 뉴스' },
  // 원자재: material_cost 외에도 원자재성 파일명(FRED 코드 포함)을 폭넓게 수용
  { key: 'material', file: CSV.material, label: '원자재 원가 동향',
    match: ['material_cost', 'material', 'wti', 'crude', 'oil', 'urethane', 'foam', 'steel', 'rubber', 'latex'] },
];

/* ── 공유 스토어: { rows, origin, file } (다른 섹션이 읽어감) ── */
const STORE = {};

/* ============================================================
   공통 유틸
   ============================================================ */

/**
 * parseCsvText(text, opts) — CSV 텍스트를 PapaParse로 파싱한다.
 * @returns {object[]} 객체 배열
 */
function parseCsvText(text, opts = {}) {
  let body = String(text).replace(/^﻿/, '');
  if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1); // 실제 BOM(U+FEFF) 제거
  body = body.replace(/^\\xEF\\xBB\\xBF/, ''); // 리터럴 "\xEF\xBB\xBF" 텍스트로 저장된 BOM 제거
  const parsed = Papa.parse(body, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    ...(opts.papa || {}),
  });
  if (parsed.errors && parsed.errors.length) {
    console.warn('[parseCsvText] 파싱 경고:', parsed.errors);
  }
  return parsed.data;
}

/**
 * renderBadge(source) — source 값에 따라 상태 배지 HTML 문자열을 반환한다.
 * 규칙: "실데이터"=초록, "샘플"=회색, "준비중"=주황. (전 섹션 공용)
 */
function renderBadge(source) {
  const key = String(source == null ? '' : source).trim();
  const MAP = {
    '실데이터': { cls: 'badge--real', label: '실데이터' },
    '샘플': { cls: 'badge--sample', label: '샘플' },
    '준비중': { cls: 'badge--pending', label: '준비중' },
  };
  const meta = MAP[key] || { cls: 'badge--sample', label: key || '미상' };
  return `<span class="badge ${meta.cls}">${meta.label}</span>`;
}

/** 공용 빈 데이터 플레이스홀더 (준비중 배지 + 안내) */
function emptyState(msg) {
  return `<div class="empty-state">${renderBadge('준비중')}<span>${escapeHtml(msg || '데이터 준비중')}</span></div>`;
}

/** HTML 이스케이프 (미리보기 테이블 셀 안전 출력용) */
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 행 배열에서 source 값 분포를 집계한다. → [{ source, count }] (없으면 []) */
function sourceDistribution(rows) {
  if (!rows.length || !('source' in rows[0])) return null;
  const counts = new Map();
  rows.forEach((r) => {
    const s = String(r.source == null ? '' : r.source).trim() || '미상';
    counts.set(s, (counts.get(s) || 0) + 1);
  });
  return [...counts.entries()].map(([source, count]) => ({ source, count }));
}

/* ============================================================
   섹션 탭 전환
   ============================================================ */
const VIEWS = ['dashboard', 'simmons_news', 'material', 'competitor', 'domestic', 'fx', 'worldclock'];

/** 화면 전환: 'dashboard'(그리드) ↔ 개별 섹션(포커스). 차트는 재렌더 없이 CSS로 리플로우 */
function setView(view) {
  if (!VIEWS.includes(view)) view = 'dashboard';
  const content = document.getElementById('content');
  if (!content) return;
  const isDash = view === 'dashboard';
  content.dataset.view = view;

  const header = document.getElementById('dashHeader');
  const back = document.getElementById('focusBack');
  if (header) header.style.display = isDash ? 'flex' : 'none';
  if (back) back.style.display = isDash ? 'none' : 'inline-flex';

  document.querySelectorAll('.dash-card').forEach((card) => {
    const sec = card.dataset.section;
    const show = isDash || sec === view;
    card.classList.toggle('is-hidden', !show);
    card.classList.toggle('is-focused', !isDash && sec === view);
  });

  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('is-active', n.dataset.view === view));
  history.replaceState(null, '', `#${view}`);
  window.scrollTo(0, 0);
}

/** 네비게이션(사이드바 항목 + 카드 "더보기" + 뒤로가기) 라우팅 */
function initNav() {
  document.querySelectorAll('.nav-item').forEach((n) =>
    n.addEventListener('click', () => setView(n.dataset.view)));
  document.querySelectorAll('.more-link').forEach((m) =>
    m.addEventListener('click', () => setView(m.dataset.view)));
  const back = document.getElementById('focusBack');
  if (back) back.addEventListener('click', () => setView('dashboard'));

  // 딥링크: #market 등
  const initial = location.hash.replace('#', '');
  setView(VIEWS.includes(initial) ? initial : 'dashboard');
}

/* ============================================================
   1) 데이터 업로드 섹션
   ============================================================ */

/** 업로드된 파일명을 데이터셋에 매핑 (파일명 부분일치, 대소문자 무시) */
function matchDataset(filename) {
  const name = filename.toLowerCase();
  return DATASETS.find((ds) => {
    const pats = Array.isArray(ds.match) ? ds.match : [ds.match];
    return pats.some((p) => name.includes(String(p).toLowerCase()));
  }) || null;
}

/** CSV 열 이름으로 섹션 자동 인식 (파일명으로 못 정했을 때). 못 정하면 null */
function detectDatasetByColumns(keys) {
  const lc = (keys || []).map((k) => String(k).trim().toLowerCase());
  const has = (n) => lc.includes(String(n).toLowerCase());
  // UN Comtrade 무역데이터 → 해외 시장 동향(2)
  if (has('reporterISO') || has('reporterDesc') || has('primaryValue') || has('flowDesc')) return 'market';
  // 원자재 원가 동향(5): material 또는 (종가/observation_date)
  if (has('material') || has('종가') || has('observation_date')) return 'material';
  // 경쟁사 분석(3): company/revenue 류
  if (has('company') || lc.some((k) => k.startsWith('revenue') || k.includes('revenue') || k === '매출')) return 'competitor';
  // 커스텀 시장 스키마(region+iso+metric+value) → 시장
  if (has('iso') && has('metric') && has('value')) return 'market';
  // 뉴스(4): 제목+요약/헤드라인
  if ((has('title') || has('headline')) && (has('summary') || has('url'))) return 'news';
  return null;
}

/** 데이터셋 카드 하나를 렌더 */
function renderDatasetCard(ds) {
  const entry = STORE[ds.key];
  const originMeta = {
    upload: { cls: 'ds-origin--upload', label: '업로드됨' },
    default: { cls: 'ds-origin--default', label: '기본값(폴더)' },
    error: { cls: 'ds-origin--error', label: '로드 실패' },
    none: { cls: 'ds-origin--none', label: '미로드' },
  };
  const origin = entry ? entry.origin : 'none';
  const om = originMeta[origin] || originMeta.none;

  let inner;
  if (!entry || origin === 'error') {
    inner = `<div class="ds-empty">${entry && entry.message ? escapeHtml(entry.message) : '데이터 없음'}</div>`;
  } else {
    const rows = entry.rows;
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const preview = rows.slice(0, 10);

    // source 분포
    const dist = sourceDistribution(rows);
    let distHtml;
    if (dist === null) {
      distHtml = `<span class="ds-nodist">source 열 없음</span>`;
    } else {
      distHtml = dist
        .map((d) => `${renderBadge(d.source)}<span class="dist-count">×${d.count}</span>`)
        .join('');
    }

    // 미리보기 테이블
    const thead = `<tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
    const tbody = preview
      .map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(r[c])}</td>`).join('')}</tr>`)
      .join('');

    inner = `
      <div class="ds-meta">
        <span class="ds-file">${escapeHtml(entry.file)}</span>
        <span class="ds-rows">${rows.length.toLocaleString()}행</span>
      </div>
      <div class="ds-dist">${distHtml}</div>
      <div class="ds-preview-wrap">
        <table class="ds-preview">
          <thead>${thead}</thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
      <div class="ds-note">앞 ${Math.min(10, rows.length)}행 미리보기 · 전체 ${cols.length}개 열</div>`;
  }

  return `
    <div class="ds-card">
      <div class="ds-card__head">
        <span class="ds-card__label">${ds.label}</span>
        <span class="ds-origin ${om.cls}">${om.label}</span>
      </div>
      ${inner}
    </div>`;
}

/** 전체 카드 그리드 렌더 (구 업로드 패널용 — 있으면 그림) + 사이드바 위젯 파일 목록 갱신 */
function renderUploadCards() {
  renderUploadedList();
  const grid = document.getElementById('dsGrid');
  if (!grid) return;
  grid.innerHTML = DATASETS.map(renderDatasetCard).join('');
}

/** 사이드바 업로드 위젯: 로드된 파일 목록(최근 5개) */
function renderUploadedList() {
  const el = document.getElementById('uploadList');
  if (!el) return;
  const items = DATASETS
    .filter((d) => STORE[d.key] && STORE[d.key].rows && STORE[d.key].rows.length)
    .map((d) => ({ label: d.label, file: STORE[d.key].file, rows: STORE[d.key].rows.length, origin: STORE[d.key].origin }));
  if (!items.length) { el.innerHTML = '<div class="uw-empty">아직 없음</div>'; return; }
  el.innerHTML = items.slice(0, 5).map((it) => `
    <div class="uw-file">
      <span class="uw-file__name" title="${escapeHtml(it.file)}">${escapeHtml(it.file)}</span>
      <span class="uw-file__meta">${it.rows.toLocaleString()}행 · ${escapeHtml(it.label)} · ${it.origin === 'upload' ? '업로드' : '기본'}</span>
    </div>`).join('');
}

/** 섹션 자동 배정 대기 목록 (파일명·내용으로 못 정한 파일) */
const _pendingUploads = [];

/** 파일 하나를 읽어 파싱 후 (파일명→열내용) 매핑. 못 정하면 unassigned 반환 */
function ingestFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      let rows;
      try { rows = parseCsvText(reader.result); }
      catch (err) { resolve({ ok: false, file: file.name, error: String(err.message || err) }); return; }

      // 1) 파일명 키워드 → 2) 열 이름 내용
      let ds = matchDataset(file.name);
      let how = 'filename';
      if (!ds) {
        const key = detectDatasetByColumns(rows.length ? Object.keys(rows[0]) : []);
        if (key) { ds = DATASETS.find((d) => d.key === key); how = 'columns'; }
      }
      if (ds) {
        STORE[ds.key] = { rows, origin: 'upload', file: file.name };
        resolve({ ok: true, file: file.name, key: ds.key, how });
      } else {
        // 3) 미결정 → 사용자가 드롭다운으로 직접 선택
        resolve({ ok: false, unassigned: true, file: file.name, rows });
      }
    };
    reader.onerror = () => resolve({ ok: false, file: file.name, error: '파일 읽기 실패' });
    reader.readAsText(file, 'utf-8');
  });
}

/** 업로드된 FileList 처리 */
async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => /\.csv$/i.test(f.name));
  const results = await Promise.all(files.map(ingestFile));

  results.forEach((r) => { if (r.unassigned) _pendingUploads.push({ file: r.file, rows: r.rows }); });

  renderUploadCards();
  refreshSections();
  renderPendingUploads();

  const banner = document.getElementById('uploadStatus');
  if (banner) {
    const okCount = results.filter((r) => r.ok).length;
    const unassigned = results.filter((r) => r.unassigned).map((r) => r.file);
    const errored = results.filter((r) => !r.ok && !r.unassigned).map((r) => r.file);
    let msg = `${okCount}개 파일 매핑 완료.`;
    if (unassigned.length) msg += ` 미인식 ${unassigned.length}개 — 아래에서 섹션을 선택하세요.`;
    if (errored.length) msg += ` 읽기 실패: ${errored.join(', ')}`;
    banner.textContent = msg;
    banner.classList.add('is-visible');
  }
  updateResetState();
}

/** 미결정 업로드에 대한 섹션 선택 드롭다운 렌더 */
function renderPendingUploads() {
  const el = document.getElementById('uploadPending');
  if (!el) return;
  if (!_pendingUploads.length) { el.innerHTML = ''; return; }
  const opts = DATASETS.map((d) => `<option value="${d.key}">${escapeHtml(d.label)}</option>`).join('');
  el.innerHTML = _pendingUploads
    .map((p, i) => `
      <div class="pending-row">
        <span class="pending-file">${escapeHtml(p.file)}</span>
        <span class="pending-msg">섹션 자동 인식 실패 — 직접 선택:</span>
        <select class="pending-select" data-i="${i}">${opts}</select>
        <button class="pending-apply" data-i="${i}" type="button">적용</button>
      </div>`)
    .join('');
}

/** 폴더의 CSV를 기본값으로 로드 (업로드 안 된 데이터셋만) */
/** 상시 업로드 위젯 초기화: 정적 DOM 요소를 배선 (드롭존/파일선택/초기화/드롭다운) */
function initUpload() {
  const dz = document.getElementById('dropzone');
  const input = document.getElementById('fileInput');
  const resetBtn = document.getElementById('resetBtn');
  const pendingEl = document.getElementById('uploadPending');
  const browse = document.getElementById('uwBrowse');
  if (!dz || !input) return;

  if (resetBtn) resetBtn.addEventListener('click', resetAllData);
  if (browse) browse.addEventListener('click', () => input.click());

  // 미결정 파일의 섹션 선택 "적용" (위임)
  if (pendingEl) {
    pendingEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.pending-apply');
      if (!btn) return;
      const i = +btn.dataset.i;
      const sel = pendingEl.querySelector(`.pending-select[data-i="${i}"]`);
      const p = _pendingUploads[i];
      if (!sel || !p) return;
      STORE[sel.value] = { rows: p.rows, origin: 'upload', file: p.file };
      _pendingUploads.splice(i, 1);
      renderUploadCards();
      refreshSections();
      renderPendingUploads();
      updateResetState();
    });
  }

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files.length) handleFiles(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-drag'); })
  );
  ['dragleave', 'dragend', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-drag'); })
  );
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  renderUploadCards(); // 초기: 미로드 카드 표시 (자동 적재 없음 — 업로드/[업데이트]로만 채움)
  updateResetState();
}

/** 초기화 버튼 활성/비활성: STORE에 데이터가 하나라도 있으면 활성 */
function updateResetState() {
  const btn = document.getElementById('resetBtn');
  if (!btn) return;
  const hasData = DATASETS.some((ds) => STORE[ds.key] && STORE[ds.key].rows && STORE[ds.key].rows.length);
  btn.disabled = !hasData;
}

/** 초기화: 브라우저 메모리(JS 상태)만 비운다. 서버/저장소·기본 CSV 재로딩 없음 */
function resetAllData() {
  if (!window.confirm('업로드한 데이터를 모두 삭제하고 초기 상태로 되돌립니다. 계속할까요?')) return;

  // 1) 메모리에 올려둔 모든 CSV 데이터(4개 슬롯) 제거
  Object.keys(STORE).forEach((k) => delete STORE[k]);

  // 2) 차트/hover 상태 캐시 비우기
  _compBars = null;
  _pieSlices = null;
  _material = null;

  // 3) 뉴스 필터 상태 초기화
  _newsState.category = '전체';
  _newsState.region = '전체';

  // 4) 파일 input 초기화 → 같은 파일 재업로드 가능
  const input = document.getElementById('fileInput');
  if (input) input.value = '';

  // 5) "N개 파일 매핑 완료" 메시지 + 미결정 대기 목록 제거
  const banner = document.getElementById('uploadStatus');
  if (banner) { banner.textContent = ''; banner.classList.remove('is-visible'); }
  _pendingUploads.length = 0;
  renderPendingUploads();

  // 6) 미리보기 카드 + 2~5번 섹션 차트/표 전부 비우기 (빈 STORE → emptyState/미로드)
  renderUploadCards();
  refreshSections();

  // 7) 버튼 비활성화 (더 이상 지울 데이터 없음). 기본 CSV는 다시 읽지 않음.
  updateResetState();
}

/* ============================================================
   2) 해외 시장 동향 섹션
   ============================================================ */

/** 숫자 파싱 (빈 문자열/미상 → null) */
function num(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 값을 "보기 좋은" 상한값으로 올림 (1/2/5 × 10^n) */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return f * mag;
}

/* iso3 → 대략적 [경도, 위도] 중심 좌표 (버블 위치용). 없는 코드는 지도에서 생략 */
const ISO_LONLAT = {
  USA: [-98, 39], CAN: [-106, 56], MEX: [-102, 23], BRA: [-52, -10], ARG: [-64, -34], CHL: [-71, -35], COL: [-74, 4], PER: [-76, -10],
  GBR: [-1.5, 52.5], DEU: [10, 51], FRA: [2.5, 46.5], ITA: [12.5, 42], ESP: [-3.7, 40], NLD: [5.5, 52], BEL: [4.5, 50.6],
  POL: [19, 52], SWE: [16, 62], NOR: [9, 61], DNK: [10, 56], CHE: [8, 47], AUT: [14, 47.5], PRT: [-8, 39.5], IRL: [-8, 53],
  FIN: [26, 64], CZE: [15.5, 49.8], ROU: [25, 46], GRC: [22, 39], HUN: [19.5, 47], TUR: [35, 39], UKR: [31, 49], RUS: [90, 62],
  CHN: [104, 35], JPN: [138, 37], KOR: [127.8, 36.5], IND: [79, 22], IDN: [113, -1], VNM: [106, 16], THA: [101, 15],
  MYS: [102, 4], PHL: [122, 12], SGP: [103.8, 1.35], TWN: [121, 23.7], HKG: [114.1, 22.3], PAK: [70, 30], BGD: [90, 24],
  AUS: [134, -25], NZL: [172, -41], SAU: [45, 24], ARE: [54, 24], ISR: [35, 31], EGY: [30, 27], ZAF: [24, -29], NGA: [8, 10],
};

/* metric/flow 코드 → 표시명 (없으면 원문) */
const METRIC_LABEL = {
  import_value: '수입액', export_value: '수출액', market_size: '시장 규모',
  production_value: '생산액', consumption: '소비액', trade_value: '교역액',
  Import: '수입액', Export: '수출액', 'Re-export': '재수출', 'Re-import': '재수입',
};
function metricLabel(m) {
  const k = String(m).trim();
  if (METRIC_LABEL[k]) return METRIC_LABEL[k];
  const low = { import: '수입액', export: '수출액', 're-export': '재수출', 're-import': '재수입' };
  if (low[k.toLowerCase()]) return low[k.toLowerCase()];
  return k.replace(/_/g, ' ');
}

/* 금액 포맷: unit에 billion/million/trillion 있으면 $NB 형태, 아니면 값+단위 */
function fmtMoney(v, unit) {
  if (v == null) return '—';
  const u = String(unit || '').toLowerCase();
  const r2 = (x) => Math.round(x * 100) / 100;
  const n = Number(v);
  if (u.includes('trillion')) return `$${r2(n).toLocaleString()}T`;
  if (u.includes('billion')) return `$${r2(n).toLocaleString()}B`;
  if (u.includes('million')) return `$${r2(n).toLocaleString()}M`;
  return `${r2(n).toLocaleString()} ${String(unit || '').replace(/_/g, ' ')}`.trim();
}

/**
 * getMarketData() — STORE.market을 자동 인식·정규화.
 * UN Comtrade 원본(reporterDesc/reporterISO/primaryValue/flowDesc)과
 * 커스텀 스키마(region/iso/metric/value/unit) 양쪽 지원.
 * 값 없거나 0인 행은 제외. 반환: { rows:[{region,iso,value,unit,metric,yoy,source,isWorld}], isComtrade }
 */
function getMarketData() {
  const entry = STORE.market;
  if (!entry || !entry.rows.length) return null;
  const rows = entry.rows;
  const keys = Object.keys(rows[0]);
  const findKey = (cands) => {
    for (const c of cands) { const hit = keys.find((k) => k.trim().toLowerCase() === c.toLowerCase()); if (hit) return hit; }
    return null;
  };
  const isComtrade = !!(findKey(['reporterISO']) || findKey(['primaryValue']) || findKey(['flowDesc']));

  let regionK, isoK, valueK, metricK, unitK, yoyK, sourceK;
  if (isComtrade) {
    regionK = findKey(['reporterDesc', 'reporter']);
    isoK = findKey(['reporterISO', 'reporter_iso']);
    valueK = findKey(['primaryValue', 'primary_value', 'TradeValue', 'tradeValue', 'value']);
    metricK = findKey(['flowDesc', 'flow']);
    unitK = null; // primaryValue(USD) → 10억 단위 환산
    yoyK = findKey(['yoy_growth_pct', 'yoy']);
    sourceK = findKey(['source']);
  } else {
    regionK = findKey(['region', 'country', 'reporterDesc']);
    isoK = findKey(['iso', 'reporterISO', 'country_iso']);
    valueK = findKey(['value', 'primaryValue']);
    metricK = findKey(['metric', 'flowDesc', 'flow']);
    unitK = findKey(['unit']);
    yoyK = findKey(['yoy_growth_pct', 'yoy']);
    sourceK = findKey(['source']);
  }
  if (!regionK || !valueK) return null;

  const norm = rows
    .map((r) => {
      let value = num(r[valueK]);
      let unit;
      if (isComtrade) {
        value = value == null ? null : value / 1e9; // USD → 10억 단위
        unit = 'USD_billion';
      } else {
        unit = unitK ? String(r[unitK]) : 'USD_billion';
      }
      const region = String(r[regionK] == null ? '' : r[regionK]).trim();
      return {
        region,
        iso: isoK ? String(r[isoK] || '').trim().toUpperCase() : '',
        value,
        unit,
        metric: metricK ? String(r[metricK]).trim() : '(전체)',
        yoy: yoyK ? num(r[yoyK]) : null,
        source: sourceK ? String(r[sourceK]).trim() : (isComtrade ? '실데이터' : null),
        isWorld: region.toLowerCase() === 'world',
      };
    })
    .filter((r) => r.region && r.value != null && r.value !== 0); // 값 없거나 0 제외

  return { rows: norm, isComtrade };
}

/* ── 시몬스 코리아 소식 (Google News RSS) ─────────────────────────────── */
let _simmonsNews = null; // { status, items:[{title,source,date,link,image}] }

/** 응답의 simmons_news 저장 후 섹션 갱신 */
function applySimmonsNewsUpdate(data) {
  const sn = data && data.sections && data.sections.simmons_news;
  if (!sn) return;
  _simmonsNews = sn;
  if (sn.status && sn.status !== 'ok') console.warn('[update] simmons_news:', sn.reason || sn.status);
  renderSimmonsNews();
}

/** 시몬스 코리아 소식 — 썸네일 카드 그리드 (제목 클릭 → 원문 새 탭) */
function renderSimmonsNews() {
  const el = document.getElementById('simmonsNewsGrid');
  if (!el) return;
  const items = (_simmonsNews && Array.isArray(_simmonsNews.items)) ? _simmonsNews.items : null;
  if (!items || !items.length) {
    const msg = (_simmonsNews && _simmonsNews.status && _simmonsNews.status !== 'ok')
      ? _simmonsNews.status : '데이터 없음';
    el.innerHTML = emptyState(msg);
    return;
  }
  el.innerHTML = items.map((it) => {
    const url = safeUrl(it.link);
    const img = safeUrl(it.image);
    // 썸네일: 이미지 있으면 표시(로드 실패 시 그라데이션+워드마크로 대체), 없으면 그라데이션
    const thumb = img
      ? `<div class="sk-card__thumb"><img src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('sk-card__thumb--ph');this.remove()"><span class="sk-card__wm">SIMMONS</span></div>`
      : `<div class="sk-card__thumb sk-card__thumb--ph"><span class="sk-card__wm">SIMMONS</span></div>`;
    const tag = url ? 'a' : 'div';
    const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="sk-card"${attrs}>
      ${thumb}
      <div class="sk-card__body">
        <h3 class="sk-card__title">${escapeHtml(it.title)}</h3>
        <div class="sk-card__meta">${escapeHtml(it.source || '')}${it.date ? '<span class="sk-dot"></span>' + escapeHtml(it.date) : ''}</div>
      </div>
    </${tag}>`;
  }).join('');
}



/* ============================================================
   3) 경쟁사 분석 섹션 — 국외(Global) / 국내(Korea) 두 그룹
   국외: SEC EDGAR 최근 분기(10-Q) 매출·순이익 + 전년 동기 대비(YoY).
   국내: 준비중(추후 DART).  ※ 경쟁사 섹션은 .viz-root 밖 → 전역(:root) 색 토큰 사용
   ============================================================ */
const COMP_COLORS = ['var(--blue)', 'var(--green)', 'var(--amber)', 'var(--violet)'];

// { global:[{name,ticker,quarter,revenue,revenue_yoy,net_income,net_income_yoy,logo_url}], korea:{status} }
let _competitors = null;

/** 큰 USD 금액 포맷: $X.XXB / $XXX.XM / $숫자 */
function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  const n = Number(v), a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

/** 원화 금액을 조/억/만 원 단위로 읽기 좋게(반올림). 음수는 '-' 유지. */
function fmtKrwShort(v) {
  if (v == null || !isFinite(v)) return null;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(1)}조 원`;
  if (a >= 1e8) return `${sign}${Math.round(a / 1e8).toLocaleString('ko-KR')}억 원`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString('ko-KR')}만 원`;
  return `${sign}${Math.round(a).toLocaleString('ko-KR')}원`;
}

/** 응답의 competitors 저장 후 섹션 갱신 */
function applyCompetitorsUpdate(data) {
  const cp = data && data.sections && data.sections.competitors;
  if (!cp) return;
  _competitorsAt = (data && data.updated_at) || null;  // 순수 추가: 수집 시각 표시용
  _competitors = cp.global ? cp : null;
  // 미국 매트리스 제조업 PPI — 별도 섹션(us_ppi)을 그대로 읽는다.
  _usPpi = (data && data.sections && data.sections.us_ppi) || null;
  if (cp.status === 'error') console.warn('[update] competitors error:', cp.reason);
  renderCompetitor();
}

/** YoY 배지: 오르면 빨강 ▲ / 내리면 초록 ▼ (stk-chg 색상 재사용) */
function compYoy(yoy) {
  const cls = yoy == null ? 'flat' : (yoy > 0 ? 'up' : yoy < 0 ? 'down' : 'flat');
  const txt = yoy == null ? '—' : `${yoy > 0 ? '▲' : yoy < 0 ? '▼' : ''} ${Math.abs(yoy).toFixed(1)}%`;
  return `<span class="stk-chg ${cls}">${txt} <span class="gco-yoy">YoY</span></span>`;
}

/** 로고 onerror 체인: data-srcs(|구분)의 다음 후보로 교체, 다 떨어지면 제거→텍스트 노출 */
function cLogoNext(img) {
  const rest = (img.getAttribute('data-srcs') || '').split('|').filter(Boolean);
  if (rest.length) {
    img.setAttribute('data-srcs', rest.slice(1).join('|'));
    img.src = rest[0];
  } else {
    img.remove();
  }
}

/** 매출/순이익 행: USD(주) + 원화 환산(보조, 회색) + YoY 배지 */
function compMetricRow(label, usd, yoy, rate) {
  const krw = (rate != null) ? fmtKrwShort(usd == null ? null : usd * rate) : null;
  return `<div class="gco-row">
    <span class="gco-row__lbl">${escapeHtml(label)}</span>
    <span class="gco-row__main">
      <span class="gco-row__val">${fmtUsd(usd)}</span>
      ${krw ? `<span class="gco-row__krw">≈ ${escapeHtml(krw)}</span>` : ''}
    </span>
    ${compYoy(yoy)}
  </div>`;
}

/** 국외 회사 카드 (로고 + 회사명/티커 + 분기 + 매출/순이익 USD·KRW + YoY) */
function compGlobalCard(c, i, rate) {
  const color = COMP_COLORS[i % COMP_COLORS.length];
  // 로고 소스 다중 시도: logo_urls[0]→[1]→[2] 순서로 onerror 체인, 다 깨지면 티커 텍스트.
  const srcs = (Array.isArray(c.logo_urls) ? c.logo_urls : (c.logo_url ? [c.logo_url] : []))
    .map(safeUrl).filter(Boolean);
  // 로고 위에 티커 텍스트를 깔아, 이미지가 모두 실패하면 텍스트가 드러남
  const logoImg = srcs.length
    ? `<img class="gco-logo__img" src="${escapeHtml(srcs[0])}" alt="${escapeHtml(c.name)}" loading="lazy" referrerpolicy="no-referrer" data-srcs="${escapeHtml(srcs.slice(1).join('|'))}" onerror="cLogoNext(this)">`
    : '';
  const hasData = c.revenue != null || c.net_income != null;
  // 순수 추가: 비상장 기업은 실적이 없다 — 추정치를 만들지 않고 그대로 알린다.
  const emptyTxt = (c.public === false) ? '비상장 · 실적 미공시' : '데이터 준비중';
  const body = hasData
    ? compMetricRow('매출', c.revenue, c.revenue_yoy, rate)
      + compMetricRow('순이익', c.net_income, c.net_income_yoy, rate)
    : '<div class="gco-empty' + (c.public === false ? ' gco-empty--priv' : '') + '">'
      + emptyTxt + '</div>';
  return `<div class="gco-card" style="--c:${color}">
    <div class="gco-head">
      <div class="gco-logo"><span class="gco-logo__txt">${escapeHtml(c.ticker || c.name)}</span>${logoImg}</div>
      <div class="gco-id">
        <div class="gco-name">${escapeHtml(c.name)} <span class="gco-tk">(${escapeHtml(c.ticker)})</span></div>
        <div class="gco-qtr">${escapeHtml(c.quarter || '—')}${compQtrLag(c, _compLatest)}</div>
      </div>
    </div>
    <div class="gco-body">${body}</div>
  </div>`;
}

let _competitorsAt = null;   // 순수 추가: 마지막 수집 시각(카드 표기용)
let _compLatest = null;      // 순수 추가: 현재 렌더 중인 그룹의 최신 분기(지연 표기 기준)

/* ── 분기 표기 헬퍼 (순수 추가 · 표시 전용) ──────────────────────────────
   기업마다 공시 시점이 달라 표시 분기가 섞인다. 어느 시점을 보고 있는지
   한눈에 드러나게 하는 표기만 담당하며, 수집·계산에는 관여하지 않는다. */

/** "2026 Q2" → 20262 (비교용 정수). 형식이 다르면 null. */
function compQtrOrd(q) {
  const m = /^(\d{4})\s*Q([1-4])$/.exec(String(q || '').trim());
  return m ? Number(m[1]) * 10 + Number(m[2]) : null;
}

/** 정수 → "2026 Q2" */
function compQtrLabel(o) {
  return `${Math.floor(o / 10)} Q${o % 10}`;
}

/** 그룹의 분기 요약 → {label, latest, mixed}. 값이 없으면 null. */
function compQtrSummary(list) {
  const ords = (list || []).map((c) => compQtrOrd(c.quarter)).filter((v) => v != null);
  if (!ords.length) return null;
  const mn = Math.min.apply(null, ords), mx = Math.max.apply(null, ords);
  if (mn === mx) return { label: `${compQtrLabel(mx)} 기준`, latest: mx, mixed: false };
  // 같은 해면 "2026 Q1~Q2", 해를 넘으면 "2025 Q4~2026 Q1"
  const label = (Math.floor(mn / 10) === Math.floor(mx / 10))
    ? `${compQtrLabel(mn)}~Q${mx % 10} 기준`
    : `${compQtrLabel(mn)}~${compQtrLabel(mx)} 기준`;
  return { label, latest: mx, mixed: true };
}

/** 최신 분기가 아닌 기업에 붙일 작은 안내(경고 아님). 최신이면 ''. */
function compQtrLag(c, latest) {
  const o = compQtrOrd(c.quarter);
  if (o == null || latest == null || o >= latest) return '';
  const gap = (Math.floor(latest / 10) - Math.floor(o / 10)) * 4 + (latest % 10 - o % 10);
  return `<span class="gco-lag">${gap <= 1 ? '직전 분기' : `${gap}분기 전`}</span>`;
}

/** 순수 추가: 출처 캡션 뒤에 붙일 " · YYYY-MM-DD HH:MM 수집". 시각 없으면 ''. */
function compFetchedAt() {
  return _competitorsAt ? ` · ${escapeHtml(String(_competitorsAt).slice(0, 16))} 수집` : '';
}

/** 분기 매출 막대 (회사별 색). key=값 필드, fmt=포맷터, tkKey=티커/코드 필드 */
function compRevBars(companies, key, fmt, tkKey) {
  key = key || 'revenue'; fmt = fmt || fmtUsd; tkKey = tkKey || 'ticker';
  const withRev = companies.filter((c) => c[key] != null && c[key] > 0);
  if (!withRev.length) return '';
  const maxV = Math.max(...withRev.map((c) => c[key]));
  // 순수 추가: 막대마다 어느 분기 값인지 병기한다(서로 다른 분기를 나란히 비교하게 되므로).
  const sum = compQtrSummary(companies);
  const bars = companies.map((c, i) => {
    const color = COMP_COLORS[i % COMP_COLORS.length];
    const v = c[key], tk = c[tkKey] || '';
    const qtr = c.quarter
      ? `<span class="gbar__qtr">· ${escapeHtml(c.quarter)}</span>${compQtrLag(c, sum && sum.latest)}` : '';
    if (v == null) {
      return `<div class="gbar"><div class="gbar__head"><span>${escapeHtml(c.name)} ${qtr}</span><span class="gbar__val">—</span></div></div>`;
    }
    const pct = Math.max(2, (v / maxV) * 100);
    return `<div class="gbar">
      <div class="gbar__head"><span>${escapeHtml(c.name)} ${tk ? `<span class="gco-tk">(${escapeHtml(tk)})</span>` : ''} ${qtr}</span><span class="gbar__val">${escapeHtml(fmt(v))}</span></div>
      <div class="gbar__track"><div class="gbar__fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
    </div>`;
  }).join('');
  // 분기가 섞였을 때만 안내 한 줄(오류가 아니라 정상적인 공시 시차임을 알린다).
  const note = (sum && sum.mixed)
    ? '<div class="gbars__note">일부 기업은 최신 분기가 아직 공시되지 않아 직전 분기 기준입니다.</div>' : '';
  return `<h3 class="subhead">분기 매출 비교</h3>${note}<div class="gbars">${bars}</div>`;
}

/** 국내 회사 카드 (네이버 금융): 로고 + 회사명/코드 + 분기 + 매출/순이익(원화) + YoY */
function compKoreaCard(c, i) {
  const color = COMP_COLORS[i % COMP_COLORS.length];
  const srcs = (Array.isArray(c.logo_urls) ? c.logo_urls : []).map(safeUrl).filter(Boolean);
  const logoImg = srcs.length
    ? `<img class="gco-logo__img" src="${escapeHtml(srcs[0])}" alt="${escapeHtml(c.name)}" loading="lazy" referrerpolicy="no-referrer" data-srcs="${escapeHtml(srcs.slice(1).join('|'))}" onerror="cLogoNext(this)">`
    : '';
  const krwRow = (label, v, yoy) => `<div class="gco-row">
    <span class="gco-row__lbl">${label}</span>
    <span class="gco-row__main"><span class="gco-row__val">${escapeHtml(fmtKrwShort(v) || '—')}</span></span>
    ${compYoy(yoy)}
  </div>`;
  const hasData = c.revenue_krw != null || c.net_income_krw != null;
  const body = hasData
    ? krwRow('매출', c.revenue_krw, c.revenue_yoy) + krwRow('순이익', c.net_income_krw, c.net_income_yoy)
    : '<div class="gco-empty">데이터 없음</div>';
  return `<div class="gco-card" style="--c:${color}">
    <div class="gco-head">
      <div class="gco-logo"><span class="gco-logo__txt">${escapeHtml((c.name || '').slice(0, 2))}</span>${logoImg}</div>
      <div class="gco-id">
        <div class="gco-name">${escapeHtml(c.name)} <span class="gco-tk">(${escapeHtml(c.code || '')})</span></div>
        <div class="gco-qtr">${escapeHtml(c.quarter || '—')}${compQtrLag(c, _compLatest)}</div>
      </div>
    </div>
    <div class="gco-body">${body}</div>
  </div>`;
}

/* ── 국외(Global) · 미국 매트리스 제조업 PPI ───────────────────────────────
   차트 하나, 선 하나. BLS PCU337910337910 의 월별 지수를 연평균으로 집계한다.

   ★ 단일 지표다. '하이엔드/프리미엄' 같은 가격대 구분을 만들지 않는다 —
     이 시리즈는 미국에서 만드는 전 매트리스를 하나로 평균한 값이고, BLS 는
     NAICS 337910 아래에 가격대별 하위 시리즈를 발표하지 않는다.
     (예전 화면의 티어 버튼은 HS 코드 = '소재' 구분이었고 가격대가 아니었다.
      근거 없는 구분이라 걷어냈다.)
   ★ 원지수를 그대로 그린다 — 기준월을 다시 잡지 않는다. 그래야 축 라벨과
     설명표의 '기준 시점(1983년 6월 = 100)'이 어긋나지 않는다.
   ★ 설명표의 숫자·추세 문구는 us_ppi.py 가 실데이터에서 계산해 payload.table
     로 보낸다. 프런트는 그 목록을 그대로 그린다 — 여기서 숫자를 만들지 않는다. */
let _usPpi = null;          // sections.us_ppi
let _gtCharts = {};         // 차트 툴팁 데이터·기하 (gtState/gtShowTip 공용)

const G_COL_PPI = 'var(--accent)';

/** Y축 단위 라벨 */
function gtYUnit(txt) {
  return '<div class="gt-yunit">' + escapeHtml(txt) + '</div>';
}

/** 연도별 원지수 선그래프(단일 계열).
    years: [{year, value, months, complete}] — us_ppi.py 의 연평균 그대로.
    마지막 해가 부분 연도면 그 구간만 점선으로 이어 '아직 안 끝난 해'임을 보인다. */
function gPpiChart(key, years, unitLabel) {
  const pts = (years || []).filter((y) => y && y.value != null);
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.value);
  let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;

  const padL = 42, padR = 10;
  const plotW = VIZ_W - padL - padR, plotH = VIZ_H - VIZ_PAD_T - VIZ_PAD_B;
  const X = (i) => padL + (i / (pts.length - 1)) * plotW;
  const Y = (v) => VIZ_PAD_T + plotH - ((v - lo) / (hi - lo)) * plotH;

  let grid = '';
  for (let k = 0; k <= VIZ_Y_TICKS; k += 1) {
    const v = lo + ((hi - lo) * k) / VIZ_Y_TICKS, y = Y(v);
    grid += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (VIZ_W - padR) + '" y2="'
      + y.toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>'
      + '<text x="' + (padL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="'
      + VIZ_FS_AXIS + '" fill="var(--muted)">' + Math.round(v) + '</text>';
  }
  let xlab = '';
  pts.forEach((p, i) => {
    xlab += '<text x="' + X(i).toFixed(1) + '" y="' + (VIZ_H - 8) + '" text-anchor="middle" font-size="'
      + VIZ_FS_AXIS + '" fill="var(--muted)">' + p.year + '</text>';
  });
  // 완전한 해까지는 실선, 부분 연도로 넘어가는 마지막 구간만 점선
  const solid = [], dash = [];
  pts.forEach((p, i) => {
    const xy = X(i).toFixed(1) + ' ' + Y(p.value).toFixed(1);
    if (p.complete === false && i > 0) {
      if (!dash.length) dash.push('M' + X(i - 1).toFixed(1) + ' ' + Y(pts[i - 1].value).toFixed(1));
      dash.push('L' + xy);
    } else {
      solid.push((solid.length ? 'L' : 'M') + xy);
    }
  });
  let lines = '';
  if (solid.length > 1) {
    lines += '<path d="' + solid.join(' ') + '" fill="none" stroke="' + G_COL_PPI
      + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  }
  if (dash.length > 1) {
    lines += '<path d="' + dash.join(' ') + '" fill="none" stroke="' + G_COL_PPI
      + '" stroke-width="2" stroke-linecap="round" stroke-dasharray="5 3"/>';
  }
  _gtCharts[key] = {
    tip: pts.map((p) => ({
      q: p.year + '년 ' + (p.complete === false ? p.months + '개월 평균' : '연평균'),
      rows: [{ name: 'PPI (원지수)', color: G_COL_PPI, seg: p.complete === false,
        y: Y(p.value), val: p.value.toFixed(1) }],
    })),
    geom: { padL: padL, plotW: plotW, n: pts.length },
  };
  const hov = '<g class="gt-hov" aria-hidden="true">'
    + '<line class="gt-hov__l" x1="0" y1="' + VIZ_PAD_T + '" x2="0" y2="' + (VIZ_PAD_T + plotH) + '"/>'
    + '<circle class="gt-adot" data-si="0" r="3.5" cx="-99" cy="-99" fill="var(--card)" stroke="'
    + G_COL_PPI + '" stroke-width="2"/></g>';
  const partial = pts.filter((p) => p.complete === false).length > 0;
  return '<div class="gt-chartwrap" data-gt-chart="' + escapeHtml(key) + '">'
    + gtYUnit(unitLabel || '지수')
    + '<svg class="gt-chart" viewBox="0 0 ' + VIZ_W + ' ' + VIZ_H
    + '" preserveAspectRatio="xMidYMid meet" role="img"'
    + ' aria-label="미국 매트리스 제조업 PPI 연평균 추이">'
    + grid + lines + xlab + hov + '</svg>'
    + '<div class="gt-tip" hidden></div></div>'
    + '<div class="gt-legend"><span class="gt-lg"><i style="background:' + G_COL_PPI
    + '"></i>매트리스 제조업 PPI (연평균)</span>'
    + (partial ? '<span class="gt-lg gt-lg--seg"><i></i>진행 중인 해(부분 연도)</span>' : '')
    + '</div>';
}

/** 요약 3칸 — 최신 월값 / 올해 평균 / 첫 해 대비 변화. 전부 payload 값에서 만든다. */
function gPpiSummary(u) {
  const ys = u.years || [], last = u.latest;
  if (!ys.length || !last) return '';
  // d = 큰 숫자 아래에 붙는 한 줄 설명(caption). 세 숫자가 각각 무엇인지 그 자리에서
  // 읽히게 한다 — 표로 빼지 않는다. 크기·색은 각주(.sm-foot)와 같다.
  const cell = (k, v, d) => '<div class="gs-cell"><span class="gs-k">' + escapeHtml(k)
    + '</span><span class="gs-v">' + v + '</span>'
    + (d ? '<span class="gs-d">' + escapeHtml(d) + '</span>' : '') + '</div>';
  const cur = ys[ys.length - 1], first = ys[0];
  let out = cell('최근 값 (' + last.month + ')', last.value.toFixed(1),
    '가장 최근 발표된 한 달 수치');
  // ★ 1~2월에는 BLS 가 새해 첫 달을 아직 공표하지 않아 마지막 해가 '올해'가 아니다.
  //   그때만 연도를 밝혀 '올해'라는 말이 틀리지 않게 한다(연도는 하드코딩하지 않는다).
  const isThisYear = cur.year === new Date().getFullYear();
  out += cell(cur.year + '년 평균' + (cur.complete ? '' : ' (' + cur.months + '개월)'),
    cur.value.toFixed(1),
    isThisYear ? '올해 발표된 달까지의 평균' : cur.year + '년에 발표된 달까지의 평균');
  if (first.value) {
    const chg = ((last.value - first.value) / first.value) * 100;
    out += cell(first.year + '년 대비',
      '<span class="gs-gap' + (chg < 0 ? ' gs-gap--neg' : '') + '">'
      + (chg > 0 ? '+' : '') + chg.toFixed(1) + '%</span>',
      '기준 연도 대비 변화율');
  }
  return '<div class="gs">' + out + '</div>';
}

/** 지표 설명표 — us_ppi.py 가 만든 payload.table({k,v}) 을 그대로 그린다.
    ★ 여기서 값을 계산하거나 문구를 덧붙이지 않는다. 표 내용을 고칠 일이 생기면
      us_ppi.py 한 곳만 고친다(새 데이터가 들어오면 자동으로 최신화된다). */
function gPpiTable(u) {
  const rows = (u && u.table) || [];
  if (!rows.length) return '';
  return '<div class="icis-terms"><h3 class="subhead">지표 설명</h3>'
    + '<div class="icis-term-wrap"><table class="icis-termtable">'
    + '<thead><tr><th>항목</th><th>설명</th></tr></thead><tbody>'
    + rows.map((r) => '<tr><td>' + escapeHtml(r.k) + '</td><td>'
      + escapeHtml(r.v) + '</td></tr>').join('')
    + '</tbody></table></div></div>';
}

/** 수집 시각 여러 개 중 가장 최근 날짜(YYYY-MM-DD). 하나도 없으면 null. */
function gSrcDate() {
  let best = null;
  for (let i = 0; i < arguments.length; i += 1) {
    const s = arguments[i];
    if (!s) continue;
    const d = String(s).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (best == null || d > best)) best = d;
  }
  return best;
}

/* 카드별 원본 페이지 — 각주의 기관·페이지 이름을 이 주소로 건다.
   ★ 미국 PPI 각주가 쓰는 gLinkify(text, links) 와 같은 형식이라 함수를 재사용한다.
     새 카드에 링크를 붙일 때도 여기 한 줄만 추가하면 된다. */
const SRC_LINKS = {
  sea: [{ text: 'Sea-Intelligence',
    url: 'https://www.sea-intelligence.com/press-room/400-global-schedule-reliability-drops-to-62-6-in-june-2026' }],
  oilCrude: [{ text: '일일국제원유가격', url: 'https://www.petronet.co.kr/v4/sub.jsp' }],
  oilProduct: [{ text: '일일국제제품가격', url: 'https://www.petronet.co.kr/v4/sub.jsp' }],
  koimaIndex: [{ text: '한국수입협회 국제원자재가격정보',
    url: 'https://www.koimaindex.com/koimaindex/koima/item/index/retrieveList.do' }],
  koimaPrice: [{ text: '한국수입협회 국제원자재가격정보',
    url: 'https://www.koimaindex.com/koimaindex/koima/price/detailView.do' }],
};

/** 카드 하단 출처 각주(.comp-caption) — 문구는 그대로 두고 이름만 링크로 만든다. */
function capSrc(text, links) {
  return '<div class="comp-caption">' + gLinkify(text, links) + '</div>';
}

/** 각주 문구 안의 특정 토막(시리즈 코드·품목 코드 등)만 원본 페이지 링크로 바꾼다.
    links: [{text, url}] — payload 가 준다. 어느 지표든 이 모양만 실어 보내면 된다.
    ★ 문자열을 순차 치환하지 않는다. 앞서 넣은 <a href="…PCU337910337910…"> 안의
      코드가 다음 치환에 다시 걸리는 사고를 구조적으로 막기 위해, 원문을 앞에서부터
      한 번만 훑으며 토막을 만나면 링크로, 아니면 한 글자씩 escape 해 쌓는다.
    ★ 정규식을 쓰지 않으므로 코드에 어떤 문자가 들어와도 이스케이프 사고가 없다. */
function gLinkify(text, links) {
  const src = String(text == null ? '' : text);
  const ls = (links || []).filter((l) => l && l.text && safeUrl(l.url))
    .slice().sort((a, b) => b.text.length - a.text.length);   // 긴 토막을 먼저 맞춘다
  if (!ls.length) return escapeHtml(src);
  let out = '', i = 0;
  while (i < src.length) {
    const hit = ls.filter((l) => src.startsWith(l.text, i))[0];
    if (hit) {
      out += '<a class="src-link" href="' + escapeHtml(safeUrl(hit.url))
        + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(hit.text) + '</a>';
      i += hit.text.length;
    } else {
      out += escapeHtml(src.charAt(i));
      i += 1;
    }
  }
  return out;
}

/** 차트 하단 출처 각주. 국내 카드 각주와 같은 클래스(.sm-foot)를 써서 스타일이 동일하다.
    links 를 주면 문구 중 그 토막만 원본 링크가 된다(문구 자체는 그대로). */
function gSrcFoot(text, date, links) {
  return '<div class="sm-foot">' + gLinkify(text, links)
    + (date ? ' · 최종 업데이트: ' + escapeHtml(date) : '') + '</div>';
}

/** 미국 매트리스 제조업 PPI 블록 — 차트 + 요약 + 설명표. */
function gUsPpiBlock() {
  const u = _usPpi;
  if (!u || u.status !== 'ok' || !(u.years || []).length) {
    return emptyState((u && u.reason) || '업데이트 버튼을 누르면 표시됩니다');
  }
  const chart = gPpiChart('gusppi', u.years, u.unit);
  if (!chart) return emptyState('연도가 2개 미만이라 추이를 그릴 수 없습니다');
  // 부분 연도·잠정치는 '숨기지 않고 밝힌다' — 나중에 값이 바뀔 수 있는 구간이다.
  let caveat = '';
  if (u.partial_year) {
    caveat += ' ' + u.partial_year.year + '년은 아직 '
      + u.partial_year.months + '개월치라 부분 연도 평균이며 점선으로 표시했습니다.';
  }
  if (u.prelim_months) {
    caveat += ' 최근 ' + u.prelim_months + '개월은 BLS 잠정치로, 공표 후 4개월까지 개정될 수 있습니다.';
  }
  return gPpiSummary(u) + chart
    + '<div class="g-note">' + escapeHtml(u.note || '') + escapeHtml(caveat) + '</div>'
    + gSrcFoot('출처: ' + (u.source || ''), gSrcDate(u.updatedAt), u.source_links)
    + gPpiTable(u);
}

/* ══ 국내 섹션 — 시몬스/경쟁사 실적·점유율 (public/data/simmons-market.json) ══
   ★ 값을 하드코딩하지 않는다. 이 파일 하나만 갱신되면 차트가 자동으로 따라간다.
   ★ 시몬스는 비상장사라 공시 API 자동 조회가 안 된다 — 수기 입력값임을 ⓘ 로 밝힌다. */
const SM_DATA_URL = 'public/data/simmons-market.json';
const SM_COL_REV = 'var(--accent)';                 // 매출 — 빨강(차트 A·B)
const SM_COL_OP = 'var(--blue)';                    // 영업이익 — 파랑
const SM_SHARE_COL = {                              // 점유율 — 브랜드 구분색, 기타는 회색
  '코웨이': '#3B82F6',
  '시몬스': 'var(--accent)',
  '에이스침대': '#F59E0B',
  '기타업체': '#9CA3AF',
};
const SM_TIP = '시몬스는 비상장사로 DART 등 공시 API 자동 조회가 불가능합니다. '
  + '표시된 수치는 각 연도 실적 발표 기사(헤럴드경제·아주경제·인더스트리뉴스 등)를 '
  + '기준으로 수기 입력한 값이며, 감사보고서 확정치와 다를 수 있습니다.';
let _smData = null;      // {status:'ok'|'error', ...} — 로드 결과
const SM_W = 720;        // 차트 A viewBox 가로(다른 차트와 같은 기준)

/** 데이터 로드. 실패해도 다른 카드에 영향을 주지 않는다. */
async function fetchSimmonsMarket() {
  try {
    const res = await fetch(SM_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 (' + SM_DATA_URL + ')');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || !Array.isArray(d.simmonsPerformance)) throw new Error('형식이 올바르지 않습니다');
    _smData = Object.assign({ status: 'ok' }, d);
  } catch (e) {
    _smData = { status: 'error', reason: (e && e.message) || String(e) };
    console.warn('[simmons-market] 로드 실패:', e);
  }
  renderCompetitor();
}

/** 억원 정수 — 3,239 */
function smNum(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('ko-KR');
}

/** 증감률 배지. 양수 초록 ▲ / 음수 빨강 ▼ */
function smDelta(pct) {
  if (pct == null) return '';
  const up = pct > 0, flat = pct === 0;
  const cls = flat ? 'flat' : (up ? 'up' : 'down');
  const ar = flat ? '–' : (up ? '▲' : '▼');
  return '<span class="sm-delta ' + cls + '">' + ar + ' '
    + Math.abs(pct).toFixed(1) + '%</span>';
}

/** 차트 A — 시몬스 최근 실적 추이. 매출 막대 + 영업이익 라인(같은 억원 축). */
function smPerfChart(d) {
  const rows = (d.simmonsPerformance || []).slice().sort((a, b) => a.year - b.year);
  if (!rows.length) return '';
  const H = 208, padL = 46, padR = 14, padT = 26, padB = 30;
  const plotW = SM_W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max.apply(null, rows.map((r) =>
    Math.max(r.revenue || 0, r.operatingProfit || 0)));
  const top = maxV * 1.14 || 1;
  const y = (v) => padT + plotH - (v / top) * plotH;
  const slot = plotW / rows.length;
  const bw = Math.min(52, slot * 0.42);
  const cx = (i) => padL + slot * (i + 0.5);

  let grid = '';
  for (let t = 0; t <= VIZ_Y_TICKS; t += 1) {
    const v = (top / VIZ_Y_TICKS) * t, yy = y(v);
    grid += '<line class="sm-grid" x1="' + padL + '" x2="' + (SM_W - padR)
      + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '"/>'
      + '<text class="sm-ax" x="' + (padL - 6) + '" y="' + (yy + 3).toFixed(1)
      + '" text-anchor="end">' + smNum(Math.round(v)) + '</text>';
  }
  const bars = rows.map((r, i) => {
    const yy = y(r.revenue), h = Math.max(0, padT + plotH - yy);
    return '<rect class="sm-bar" x="' + (cx(i) - bw / 2).toFixed(1) + '" y="' + yy.toFixed(1)
      + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1)
      + '" rx="2" fill="' + SM_COL_REV + '"/>'
      + '<text class="sm-lab" x="' + cx(i).toFixed(1) + '" y="' + (yy - 5).toFixed(1)
      + '" text-anchor="middle" fill="' + SM_COL_REV + '">' + smNum(r.revenue) + '</text>';
  }).join('');
  const pts = rows.map((r, i) => cx(i).toFixed(1) + ',' + y(r.operatingProfit).toFixed(1));
  const line = '<polyline class="sm-line" points="' + pts.join(' ')
    + '" fill="none" stroke="' + SM_COL_OP + '"/>';
  const dots = rows.map((r, i) => '<circle class="sm-dot" cx="' + cx(i).toFixed(1)
    + '" cy="' + y(r.operatingProfit).toFixed(1) + '" r="3" fill="' + SM_COL_OP + '"/>'
    + '<text class="sm-lab" x="' + cx(i).toFixed(1) + '" y="'
    + (y(r.operatingProfit) - 7).toFixed(1) + '" text-anchor="middle" fill="' + SM_COL_OP
    + '">' + smNum(r.operatingProfit) + '</text>').join('');
  const xs = rows.map((r, i) => '<text class="sm-ax" x="' + cx(i).toFixed(1)
    + '" y="' + (H - 9) + '" text-anchor="middle">' + r.year + '</text>').join('');

  return '<svg class="sm-svg" viewBox="0 0 ' + SM_W + ' ' + H
    + '" role="img" aria-label="시몬스 최근 실적 추이">'
    + grid + bars + line + dots + xs + '</svg>'
    + '<div class="sm-legend">'
    + '<span><i style="background:' + SM_COL_REV + '"></i>매출</span>'
    + '<span><i class="sm-legend__l" style="background:' + SM_COL_OP + '"></i>영업이익</span>'
    + '</div>';
}

/** 차트 B — 지난해 매출 비교(가로 막대) + 증감률 + note 각주 */
function smRevCompare(d) {
  const c = d.competitorRevenueLastYear;
  if (!c || !Array.isArray(c.companies) || !c.companies.length) return '';
  const rows = c.companies.slice().sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  const max = Math.max.apply(null, rows.map((r) => r.revenue || 0)) || 1;
  const bars = rows.map((r) => {
    const w = Math.max(2, ((r.revenue || 0) / max) * 100);
    const mine = String(r.name).indexOf('시몬스') === 0;
    // ★ 회사마다 기준 회계연도가 다르다(2023~2025). 막대마다 밝혀 오해를 막는다.
    const yr = r.year ? '<span class="sm-hyr">(' + escapeHtml(String(r.year)) + '년)</span>' : '';
    const memo = r.memo ? '<div class="sm-hmemo">' + escapeHtml(r.memo) + '</div>' : '';
    return '<div class="sm-hrow' + (mine ? ' is-mine' : '') + '">'
      + '<div class="sm-hname" title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + yr + '</div>'
      + '<div class="sm-htrack"><div class="sm-hbar" style="width:' + w.toFixed(1) + '%"></div></div>'
      + '<div class="sm-hval">' + smNum(r.revenue) + ' ' + smDelta(r.yoyChangePct) + '</div>'
      + memo
      + '</div>';
  }).join('');
  const notes = Array.isArray(c.notes) ? c.notes : (c.note ? [c.note] : []);
  return '<div class="sm-hbars">' + bars + '</div>'
    + notes.map((t) => '<div class="sm-foot">※ ' + escapeHtml(t) + '</div>').join('');
}

/** 차트 C — 점유율 도넛. 중앙에 제목 + 출처. */
function smShareDonut(d) {
  const m = d.marketShare2025;
  if (!m || !Array.isArray(m.data) || !m.data.length) return '';
  const rows = m.data.filter((r) => r && r.share > 0);
  const tot = rows.reduce((s, r) => s + r.share, 0) || 1;
  const S = 200, cc = S / 2, R = 78, TH = 26;
  const rr = R - TH / 2;
  const circ = 2 * Math.PI * rr;
  let acc = 0;
  const segs = rows.map((r) => {
    const frac = r.share / tot;
    const seg = '<circle class="sm-seg" cx="' + cc + '" cy="' + cc + '" r="' + rr
      + '" fill="none" stroke="' + (SM_SHARE_COL[r.name] || '#9CA3AF')
      + '" stroke-width="' + TH + '" stroke-dasharray="'
      + (circ * frac).toFixed(2) + ' ' + (circ * (1 - frac)).toFixed(2) + '"'
      + ' stroke-dashoffset="' + (-circ * acc).toFixed(2) + '">'
      + '<title>' + escapeHtml(r.name) + ' ' + r.share + '%</title></circle>';
    acc += frac;
    return seg;
  }).join('');
  const yr = String(m.year || 2025);
  const center = '<text class="sm-dc1" x="' + cc + '" y="' + (cc - 4)
    + '" text-anchor="middle">' + escapeHtml(yr) + '년 시장 점유율</text>'
    + '<text class="sm-dc2" x="' + cc + '" y="' + (cc + 12)
    + '" text-anchor="middle">' + escapeHtml(m.source || '') + '</text>';
  // '기타업체'는 어떤 회사인지 알 수 없어 hover 로 예시를 보여 준다(각주로도 밝힌다)
  const oNote = m.othersNote || '';
  const oLabel = m.othersLabel || '기타업체';
  const legend = rows.map((r) => {
    const isOther = (r.name === oLabel) && oNote;
    return '<span' + (isOther ? ' class="sm-oth" tabindex="0" role="note"' : '') + '>'
      + '<i style="background:' + (SM_SHARE_COL[r.name] || '#9CA3AF') + '"></i>'
      + escapeHtml(r.name) + ' <b>' + r.share + '%</b>'
      + (isOther ? '<span class="sm-oth__bub">' + escapeHtml(oNote) + '</span>' : '')
      + '</span>';
  }).join('');
  const foot = oNote ? '<div class="sm-othfoot">' + escapeHtml(oNote) + '</div>' : '';
  return '<div class="sm-donutwrap">'
    + '<svg class="sm-donut" viewBox="0 0 ' + S + ' ' + S + '" role="img" aria-label="'
    + escapeHtml(yr) + '년 시장 점유율">'
    + '<g transform="rotate(-90 ' + cc + ' ' + cc + ')">' + segs + '</g>'
    + center + '</svg>'
    + '<div class="sm-legend sm-legend--wrap">' + legend + '</div>' + foot + '</div>';
}


/** 기업 로고 — 각사 공식 사이트에서 받은 이미지를 그대로 쓴다.
    ★ 이미지를 왜곡하지 않는다: 높이만 고정하고 너비는 auto + object-fit:contain.
    ★ 로고를 찾지 못한 회사는 아무것도 그리지 않는다(임의 아이콘으로 때우지 않는다).
    ★ 파일이 없거나 깨지면 onerror 로 조용히 지운다 — 깨진 이미지 아이콘을 남기지 않게. */
function smStLogo(c, cls) {
  if (!c.logo) return '';
  return '<img class="sm-st__logo' + (cls ? ' ' + cls : '') + '" src="' + escapeHtml(c.logo)
    + '" alt="' + escapeHtml(c.name) + ' 로고" loading="lazy"'
    + ' onerror="this.remove()">';
}

/** 막대에 쓸 투자액. 국내는 억원(investEok), 국외는 백만 달러(investVal)로 들어온다.
    ★ 통화가 다른 값을 한 그래프에 섞지 않는다 — 섹션마다 st.investUnit 이 통화를 고정한다. */
function stInvestVal(c) {
  if (typeof c.investEok === 'number') return c.investEok;
  if (typeof c.investVal === 'number') return c.investVal;
  return null;
}

/** 백만 달러 → '약 1조 7,294억원' 문구. 환율이 없으면 null(= 달러만 남는다).
    ★ 계산: 백만 달러 × 1,000,000 × 환율 ÷ 100,000,000 = 억원
      = 백만 달러 × 환율 ÷ 100   (1,250 × 1,383.49 ÷ 100 = 17,293.6억원)
    ★ 환율은 국제유가·해외 시장 그래프가 쓰는 공용 헬퍼(krwRate)를 그대로 쓴다 —
      매일 자동 갱신되는 값이고, 이 카드가 따로 받아 오지 않는다. */
function stKrwEok(musd, rate) {
  if (rate == null || musd == null || !isFinite(musd)) return null;
  const eok = Math.round((Number(musd) * rate) / 100);   // 억원(정수)
  const n = (x) => x.toLocaleString('ko-KR');
  if (eok >= 10000) {
    const jo = Math.floor(eok / 10000), rest = eok % 10000;
    return '약 ' + n(jo) + '조' + (rest ? ' ' + n(rest) + '억원' : '원');
  }
  return '약 ' + n(eok) + '억원';
}

/** (3-b) 투자 유치액 막대그래프 — 매출이 아니라 '공개된 누적 투자액'으로 견준다.
    ★ 금액이 확인되지 않은 회사는 막대를 만들지 않고 왜 빠졌는지만 적는다.
    ★ 단위는 섹션이 정한다. st.investUnit 이 없으면 국내 기본값(억원)을 그대로 쓴다. */
function smStInvest(st) {
  const all = st.companies || [];
  const has = (c) => { const v = stInvestVal(c); return typeof v === 'number' && v > 0; };
  const bars = all.filter(has).slice().sort((a, b) => stInvestVal(b) - stInvestVal(a));
  if (!bars.length) return '';
  const max = Math.max.apply(null, bars.map(stInvestVal)) || 1;
  const out = all.filter((c) => !has(c));
  const unitLabel = st.investUnit || '억원';          // 제목 옆 (단위: …)
  const suffix = st.investUnit ? '' : '억';            // 값 뒤에 붙는 글자(국내: 180억)
  /* ★ 값이 달러일 때만 원화를 병기한다. 국내는 이미 억원이라 환산할 것이 없고,
     이 조건이 false 면 아래 출력이 예전과 한 글자도 다르지 않다. */
  const isUsd = /달러/.test(unitLabel);
  const rate = isUsd ? krwRate('USD') : null;
  const rows = bars.map((c) => {
    const v = stInvestVal(c);
    const krw = stKrwEok(v, rate);
    const w = Math.max(2, (v / max) * 100);
    return '<div class="sm-hrow">'
      + '<div class="sm-hname" title="' + escapeHtml(c.name) + '">' + smStLogo(c, 'sm-st__logo--bar')
      + escapeHtml(c.name) + '</div>'
      + '<div class="sm-htrack"><div class="sm-hbar" style="width:' + w.toFixed(1)
      + '%;background:' + escapeHtml(c.color || 'var(--slate)') + ';opacity:1"></div></div>'
      + '<div class="sm-hval">' + v.toLocaleString('ko-KR') + suffix
      + (krw ? '<span class="sm-hkrw">' + escapeHtml(krw) + '</span>' : '') + '</div>'
      + (c.investBasis ? '<div class="sm-hmemo">' + escapeHtml(c.investBasis) + '</div>' : '')
      + '</div>';
  }).join('');
  const excl = out.length
    ? '<div class="sm-foot">※ 그래프에서 제외: '
      + out.map((c) => escapeHtml(c.name) + '(' + escapeHtml(c.investExcluded || '금액 미확인') + ')').join(', ')
      + '</div>' : '';
  return '<h3 class="subhead sm-st__ih">' + escapeHtml(st.investHeading || '투자 유치액 비교')
    + ' <span class="sm-h__u">(단위: ' + escapeHtml(unitLabel) + ')</span></h3>'
    + (st.investNote ? '<div class="sm-othfoot">※ ' + escapeHtml(st.investNote) + '</div>' : '')
    + '<div class="sm-hbars sm-hbars--inv">' + rows + '</div>'
    + (rate != null ? krwNote('USD') : '') + excl;
}

/** 국내 수면·슬립테크 시장 규모 추이.
    ★★ 발표된 세 시점(2011·2021·2025)만 점으로 찍는다. 사이 연도(2012~2020,
      2022~2024)는 정기 통계가 없어 값을 만들지 않고, 구간을 점선으로만 잇는다.
      점선은 '그 사이를 이렇게 지나갔다'는 뜻이 아니라 '발표 시점끼리 이었다'는 뜻이다.
    ★ X축은 연도에 비례해 배치한다 — 2011→2021 은 10년, 2021→2025 는 4년이라
      균등 간격으로 놓으면 기울기가 실제와 달라진다. */
function smSleepMarket(d) {
  const m = d.sleepMarket;
  if (!m || !Array.isArray(m.points) || m.points.length < 2) return '';
  const pts = m.points.slice().sort((a, b) => a.year - b.year)
    .map((p) => ({ year: p.year, jo: p.eok / 10000, label: p.label }));
  const y0 = pts[0].year, y1 = pts[pts.length - 1].year;
  const vals = pts.map((p) => p.jo);
  let lo = 0, hi = Math.max.apply(null, vals) * 1.28;

  const W = VIZ_W, H = 190, padL = 46, padR = 22, padT = 26, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (yr) => padL + ((yr - y0) / ((y1 - y0) || 1)) * plotW;
  const Y = (v) => padT + (1 - (v - lo) / ((hi - lo) || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = lo + (hi - lo) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${val.toFixed(1)}</text>`;
  }).join('');

  // 구간 점선 + 구간별 성장 배수(실제 계산값)
  let segs = '', mult = '';
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1], b = pts[i];
    segs += `<line x1="${X(a.year).toFixed(1)}" y1="${Y(a.jo).toFixed(1)}" x2="${X(b.year).toFixed(1)}" y2="${Y(b.jo).toFixed(1)}"`
      + ` stroke="var(--accent)" stroke-width="2" stroke-dasharray="6 4" stroke-linecap="round" opacity=".75"/>`;
    const x = (X(a.year) + X(b.year)) / 2, y = (Y(a.jo) + Y(b.jo)) / 2 - 8;
    const times = Math.round((b.jo / a.jo) * 10) / 10;
    mult += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="700"`
      + ` paint-order="stroke" stroke="var(--card)" stroke-width="3" fill="var(--accent)">약 ${times.toFixed(1)}배</text>`;
  }
  // 발표 시점 — 실선 원 + 값 라벨
  const dots = pts.map((p, i) => {
    const x = X(p.year), y = Y(p.jo);
    const anchor = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>`
      + `<text x="${x.toFixed(1)}" y="${(y - 12).toFixed(1)}" text-anchor="${anchor}" font-size="11" font-weight="800"`
      + ` paint-order="stroke" stroke="var(--card)" stroke-width="3.5" fill="var(--ink)">${escapeHtml(p.label)}</text>`;
  }).join('');
  const xlab = pts.map((p, i) => {
    const anchor = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
    return `<text x="${X(p.year).toFixed(1)}" y="${(padT + plotH + 16).toFixed(1)}" text-anchor="${anchor}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${p.year}년</text>`;
  }).join('');

  const growth = [];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1], b = pts[i];
    growth.push(a.year + '→' + b.year + '년 약 '
      + (Math.round((b.jo / a.jo) * 10) / 10).toFixed(1) + '배 성장');
  }

  // 한줄 요약 — 처음과 끝 두 시점만으로 만든다(배수·기간 모두 계산값, 하드코딩 없음).
  const a0 = pts[0], aN = pts[pts.length - 1];
  const totX = Math.round((aN.jo / a0.jo) * 10) / 10;
  const span = aN.year - a0.year;
  // 제목에서 '규모 추이'를 떼어 문장 주어로 쓴다 — 제목이 바뀌면 문장도 따라간다.
  const subj = String(m.title || '').replace(/\s*규모\s*추이\s*$/, '') || '이 시장';
  const lead = '<div class="sm-mkthead">' + escapeHtml(subj) + '은 '
    + escapeHtml(a0.year + '년 ' + a0.label) + '에서 '
    + escapeHtml(aN.year + '년 ' + aN.label) + '으로 '
    + escapeHtml(span + '년간') + ' <b>약 ' + totX.toFixed(1) + '배</b> 성장했습니다.</div>';

  return '<div class="sm-card sm-card--full"><div class="sm-h">' + escapeHtml(m.title)
    + ' <span class="sm-h__u">(단위: ' + escapeHtml(m.unit || '조원') + ')</span></div>'
    + lead
    + '<div class="sm-growth">' + growth.map((t) => '<span>' + escapeHtml(t) + '</span>').join('') + '</div>'
    + `<svg class="sm-mktsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ' aria-label="' + escapeHtml(m.title) + '">'
    + grid + xlab + segs + mult + dots
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/></svg>`
    + '<div class="sm-mktlg"><span class="sm-mktlg__dot"></span>발표된 시점(실측)'
    + '<span class="sm-mktlg__dash"></span>' + escapeHtml(m.gapNote || '') + '</div>'
    + (m.source ? '<div class="sm-foot">' + escapeHtml(m.source) + '</div>' : '')
    + '</div>';
}

/** (3) 슬립테크 주요 기업 카드 — 확인된 값만 적고, 없는 것은 그대로 '비공개/미확인'.
    ★ 국내·국외가 같은 함수를 쓴다. 넘기는 데이터 파일만 다르고 화면 구성은 똑같다. */
function stCardsHtml(st) {
  if (!st || !Array.isArray(st.companies) || !st.companies.length) return '';
  const row = (k, v) => (v ? '<div class="sm-st__row"><span class="sm-st__k">'
    + escapeHtml(k) + '</span><span class="sm-st__v">' + escapeHtml(v) + '</span></div>' : '');
  const cards = st.companies.map((c) => {
    const src = (c.sources || []).map((x) => {
      const u = safeUrl(x.url);
      return '<li>' + (u
        ? '<a class="src-link" href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">'
          + escapeHtml(x.label) + '</a>'
        : escapeHtml(x.label)) + '</li>';
    }).join('');
    return '<div class="sm-st">'
      + '<div class="sm-st__hd">' + smStLogo(c)
      + '<span class="sm-st__h">' + escapeHtml(c.name) + '</span></div>'
      + (c.desc ? '<p class="sm-st__desc">' + escapeHtml(c.desc) + '</p>' : '')
      + row('설립', c.founded) + row('주요 제품·서비스', c.products)
      + row('투자 유치', c.funding) + row('매출·재무', c.revenue) + row('그 밖에', c.extra)
      + (src ? '<div class="sm-st__src">출처<ul>' + src + '</ul></div>' : '')
      + '</div>';
  }).join('');
  return '<div class="sm-card sm-card--full"><div class="sm-h">'
    + escapeHtml(st.title || '국내 슬립테크 시장 주요 기업') + '</div>'
    + '<div class="sm-st-grid">' + cards + '</div>'
    + smStInvest(st)
    + (st.note ? '<div class="sm-foot">' + escapeHtml(st.note) + '</div>' : '')
    + (st.logoNote ? '<div class="sm-foot">' + escapeHtml(st.logoNote) + '</div>' : '')
    + '</div>';
}

/** 국내 섹션에서 부르는 이름은 그대로 둔다(호출부 변경 없음). */
function smSleepTech(d) { return stCardsHtml(d.sleepTech); }

/** 국내 섹션 본문 — 차트 A 풀와이드 / 차트 B·C 2열 */
function smKoreaHtml() {
  if (!_smData) {
    return '<div class="comp-todo"><span class="comp-todo__badge">준비중</span>'
      + ' 업데이트 버튼을 누르면 표시됩니다</div>';
  }
  if (_smData.status !== 'ok') {
    return '<div class="comp-todo"><span class="comp-todo__badge">데이터 없음</span> '
      + escapeHtml(_smData.reason || '로드 실패') + '</div>';
  }
  const d = _smData;
  const perf = (d.simmonsPerformance || []).slice().sort((a, b) => a.year - b.year);
  const lastYear = perf.length ? perf[perf.length - 1].year : null;
  const prov = d.isProvisional === true
    || (perf.length > 0 && perf[perf.length - 1].provisional === true);
  const badge = '<div class="sm-badge">'
    + (prov ? '<span class="sm-badge__prov">잠정치</span>' : '')
    + (lastYear ? escapeHtml(lastYear + '년 12월 결산 기준') + ' · ' : '')
    + '최종 업데이트 ' + escapeHtml(d.lastUpdated || '—')
    + '<span class="sm-info" tabindex="0" role="note" aria-label="' + escapeHtml(SM_TIP)
    + '" title="' + escapeHtml(SM_TIP) + '">ⓘ<span class="sm-info__bub">'
    + escapeHtml(SM_TIP) + '</span></span></div>';
  const unit = escapeHtml(d.unit || '억원');
  const cy = d.competitorRevenueLastYear && d.competitorRevenueLastYear.year;
  const sy = (d.marketShare2025 && d.marketShare2025.year) || 2025;

  return '<div class="sm-wrap">'
    + '<div class="sm-card sm-card--full">'
    + '<div class="sm-h">시몬스 최근 실적 추이 <span class="sm-h__u">(단위: ' + unit + ')</span>'
    + badge + '</div>' + smPerfChart(d) + '</div>'
    + '<div class="sm-grid2">'
    + '<div class="sm-card"><div class="sm-h">국내 침대·매트리스 업계 매출 비교'
    + ' <span class="sm-h__u">(단위: ' + unit + ' · 기준 연도는 회사마다 표기)</span></div>'
    + smRevCompare(d) + '</div>'
    + '<div class="sm-card"><div class="sm-h">' + escapeHtml(String(sy))
    + '년 침대 매트리스 시장 점유율</div>'
    + smShareDonut(d) + '</div>'
    + '</div>'
    + smSleepMarket(d)
    + smSleepTech(d)
    + '</div>';
}

/** 제목 옆 약어 배지 + hover/포커스 툴팁.
    ★ 약어를 그 자리에서 풀어 준다 — 'PPI' 만 보고 뜻을 몰라 멈추는 일이 없게.
      배지 텍스트에 이미 우리말 뜻이 들어가고, 툴팁은 원어와 정의를 덧붙인다.
    ★ 툴팁 문구는 DOM 안에 그대로 있어 스크린리더도 읽는다(title 중복 방지). */
function gcAbbr(label, tip) {
  return '<span class="gc-abbr" tabindex="0" role="note">' + escapeHtml(label)
    + '<span class="gc-abbr__bub">' + escapeHtml(tip) + '</span></span>';
}

const PPI_ABBR = 'PPI(생산자물가지수)';
const PPI_ABBR_TIP = 'PPI = Producer Price Index, 생산자물가지수 — '
  + '공장이 도매로 파는 판매가격의 변화를 측정하는 지표';

/* ══ 국외 섹션 — 해외 수면·슬립테크 시장 + 주요 기업 ═══════════════════════
   (public/data/global-sleeptech.json · 국내 simmons-market.json 과 같은 방식)
   ★ 값을 코드에 적지 않는다. JSON 한 곳만 고치면 문장·배수·그래프가 모두 따라온다.
   ★★ 두 시장 시리즈를 한 선으로 잇지 않는다 — 조사기관도(GMI vs Graphical Research)
     지역 범위도(글로벌 vs 북미) 다르다. 축만 함께 쓰고 선·색·문장은 시리즈마다 따로
     만들며, 범례에 조사기관과 범위를 그대로 적는다.
   ★★ 실측과 전망을 눈으로 가른다 — 실측은 꽉 찬 점, 전망은 속 빈 점, 그 사이는 점선.
     점선은 '해마다 이렇게 지나간다'가 아니라 '조사기관이 낸 두 값을 이었다'는 뜻이다. */
const GS_DATA_URL = 'public/data/global-sleeptech.json';
let _gsData = null;      // {status:'ok'|'error', ...} — 로드 결과

/** 데이터 로드. 실패해도 다른 카드에 영향을 주지 않는다(국내 로더와 같은 모양). */
async function fetchGlobalSleepTech() {
  try {
    const res = await fetch(GS_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 (' + GS_DATA_URL + ')');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (!d || !d.sleepMarket || !d.sleepTech) throw new Error('형식이 올바르지 않습니다');
    _gsData = Object.assign({ status: 'ok' }, d);
  } catch (e) {
    _gsData = { status: 'error', reason: (e && e.message) || String(e) };
    console.warn('[global-sleeptech] 로드 실패:', e);
  }
  renderCompetitor();
}

/** 한글 음절의 받침 유무. 한글이 아니면 null(판단하지 않는다). */
function gsJong(ch) {
  const c = String(ch || '').charCodeAt(0);
  if (!(c >= 0xAC00 && c <= 0xD7A3)) return null;
  return ((c - 0xAC00) % 28) !== 0;
}

/** 받침에 맞는 조사를 고른다 — '시장은/952억 달러로'처럼 문장이 자연스럽게 붙도록.
    ★ 조사를 하드코딩하지 않는 이유: JSON 의 이름·단위가 바뀌어도 문장이 깨지지 않게. */
function gsJosa(word, withJong, without) {
  const s = String(word == null ? '' : word);
  return (s && gsJong(s.charAt(s.length - 1)) === true) ? withJong : without;
}

/** 억 달러 → 조원 문구('약 29.2조원'). 환율이 없으면 null 을 돌려 달러만 남긴다.
    ★ 계산: 억 달러 × 환율 ÷ 10,000 = 조원
      (211억 달러 × 1,384원 ÷ 10,000 = 29.2조원)
    ★ 환율은 국제유가 카드가 쓰는 공용 헬퍼(krwRate)에서 그대로 가져온다 —
      매일 자동 갱신되는 무료 환율이고, 이 카드가 따로 받아 오지 않는다. */
function gsKrwJo(usdEok, rate) {
  if (rate == null || usdEok == null || !isFinite(usdEok)) return null;
  const jo = (Number(usdEok) * rate) / 10000;
  return '약 ' + (Math.round(jo * 10) / 10).toLocaleString('ko-KR',
    { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '조원';
}

/** 해외 수면·슬립테크 시장 규모 추이 — 시리즈 여러 개를 한 축 위에 따로 그린다. */
function gsSleepMarket(m) {
  const series = (m.series || []).map((s) => Object.assign({}, s, {
    pts: (s.points || []).slice().sort((a, b) => a.year - b.year),
  })).filter((s) => s.pts.length >= 2);
  if (!series.length) return '';

  // 축 범위 — 두 시리즈를 함께 담기만 한다(값을 합치거나 섞어 계산하지 않는다).
  const years = [], vals = [];
  series.forEach((s) => s.pts.forEach((p) => { years.push(p.year); vals.push(p.usdEok); }));
  const y0 = Math.min.apply(null, years), y1 = Math.max.apply(null, years);
  const lo = 0, hi = Math.max.apply(null, vals) * 1.3;

  /* 여백·글자 크기는 이 차트에서만 쓴다(다른 차트의 VIZ_* 는 건드리지 않는다).
     ★ 아래 여백(padB)을 넉넉히 둬서 X축 연도 라벨이 축선 '아래 고정 자리'에
       놓이게 한다 — 값 라벨과 자리를 다투지 않는다.
     ★ 좌우 여백은 양 끝 라벨('65.79억 달러' / '952억 달러')이 카드 경계를
       넘지 않도록 잡은 값이다. */
  /* 원화 병기 — 국제유가·제품가 카드에서 쓰던 공용 헬퍼를 그대로 쓴다.
     ★ 저장값은 달러(억 달러)로 그대로 두고, 그릴 때만 환율을 곱한다.
       환율을 못 읽으면 rate 가 null 이라 달러만 나온다(카드가 깨지지 않는다). */
  const rate = krwRate('USD');
  const W = VIZ_W, H = 234, padL = 52, padR = 34, padT = 44, padB = 40;
  const FS_VAL = 11.5;          // 값 라벨(작게 줄면 못 읽으므로 축 눈금보다 크게)
  const FS_AX = 9.5;            // 축 눈금·연도 라벨
  const FS_KRW = 9.5;           // 값 라벨 아래 원화 둘째 줄
  // 원화 줄이 한 줄 더 들어가므로 달러 라벨을 그만큼 더 올린다(겹치지 않게).
  const LAB_UP = rate != null ? 27 : 13;
  const KRW_UP = 14;            // 점 위로 띄우는 거리(달러 라벨 바로 아래 자리)
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (yr) => padL + ((yr - y0) / ((y1 - y0) || 1)) * plotW;
  const Y = (v) => padT + (1 - (v - lo) / ((hi - lo) || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = lo + (hi - lo) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 7}" y="${(y + 3.4).toFixed(1)}" text-anchor="end" font-size="${FS_AX}" fill="var(--muted)">${Math.round(val).toLocaleString('ko-KR')}</text>`;
  }).join('');

  const body = series.map((s) => {
    const col = s.color || 'var(--accent)';
    let seg = '';
    for (let i = 1; i < s.pts.length; i += 1) {
      const a = s.pts[i - 1], b = s.pts[i];
      seg += `<line x1="${X(a.year).toFixed(1)}" y1="${Y(a.usdEok).toFixed(1)}"`
        + ` x2="${X(b.year).toFixed(1)}" y2="${Y(b.usdEok).toFixed(1)}"`
        + ` stroke="${escapeHtml(col)}" stroke-width="2" stroke-dasharray="6 4" stroke-linecap="round" opacity=".8"/>`;
    }
    const dots = s.pts.map((p, i) => {
      const x = X(p.year), y = Y(p.usdEok);
      // 실측 = 꽉 찬 점 / 전망 = 속 빈 점. 눈으로 바로 갈리게 한다.
      const dot = (p.kind === 'forecast')
        ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="var(--card)" stroke="${escapeHtml(col)}" stroke-width="2.5"/>`
        : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${escapeHtml(col)}" stroke="var(--card)" stroke-width="2"/>`;
      // ★ 값 라벨은 언제나 점 '위'에 둔다. 예전엔 값이 작은 시리즈만 점 아래로
      //   내렸는데, 그 자리가 X축 연도 라벨 자리와 겹쳐 '2021년'이 잘렸다.
      const anchor = i === 0 ? 'start' : (i === s.pts.length - 1 ? 'end' : 'middle');
      const krw = gsKrwJo(p.usdEok, rate);   // 달러 라벨 아래 원화 둘째 줄
      return dot + `<text x="${x.toFixed(1)}" y="${(y - LAB_UP).toFixed(1)}" text-anchor="${anchor}" font-size="${FS_VAL}" font-weight="800"`
        + ` paint-order="stroke" stroke="var(--card)" stroke-width="3.5" fill="var(--ink)">${escapeHtml(p.label)}</text>`
        + (krw
          ? `<text x="${x.toFixed(1)}" y="${(y - KRW_UP).toFixed(1)}" text-anchor="${anchor}" font-size="${FS_KRW}" font-weight="600"`
            + ` paint-order="stroke" stroke="var(--card)" stroke-width="3" fill="var(--muted)">${escapeHtml(krw)}</text>`
          : '');
    }).join('');
    return seg + dots;
  }).join('');

  // X축 — 발표된 연도만 찍는다(사이 연도는 값이 없으므로 눈금도 만들지 않는다).
  // ★ 축선 아래 고정된 자리에 놓는다. 값 라벨은 모두 점 위에 있으므로 부딪히지 않는다.
  const yrs = years.filter((v, i) => years.indexOf(v) === i).sort((a, b) => a - b);
  const xlab = yrs.map((yr, i) => {
    const anchor = i === 0 ? 'start' : (i === yrs.length - 1 ? 'end' : 'middle');
    return `<text x="${X(yr).toFixed(1)}" y="${(padT + plotH + 20).toFixed(1)}" text-anchor="${anchor}" font-size="${FS_AX}" fill="var(--muted)">${yr}년</text>`;
  }).join('');

  // 한줄 요약 — 시리즈마다 한 문장. 배수·기간 모두 계산값이고 하드코딩이 없다.
  const heads = series.map((s) => {
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    const times = Math.round((b.usdEok / a.usdEok) * 10) / 10;
    const span = b.year - a.year;
    // 문장 주어는 범례 문구와 따로 둔다 — 범례는 '글로벌 (Global Market Insights)',
    // 문장은 '글로벌 슬립테크 시장은…' 처럼 읽혀야 자연스럽다.
    const subj = s.headSubject || s.scope || s.label;
    // 끝점이 전망이면 '성장할 전망입니다', 실측이면 '성장했습니다'.
    const verb = (b.kind === 'forecast') ? '성장할 전망입니다' : '성장했습니다';
    // 금액 뒤에 원화를 괄호로 덧붙인다. 환율이 없으면 달러만 남는다.
    const amt = (p) => {
      const k = gsKrwJo(p.usdEok, rate);
      return p.year + '년 ' + p.label + (k ? '(' + k + ')' : '');
    };
    const endTxt = amt(b);
    return '<div class="sm-mkthead">'
      + '<i class="gs-hdot" style="background:' + escapeHtml(s.color || 'var(--accent)') + '"></i>'
      + escapeHtml(subj) + gsJosa(subj, '은', '는') + ' '
      + escapeHtml(amt(a)) + '에서 '
      // 조사는 마지막 글자로 판정한다 — 원화가 붙으면 '…조원)'으로 끝나므로
      // '달러로'가 아니라 '…)으로'가 맞다. 괄호를 뺀 실제 끝 글자로 본다.
      + escapeHtml(endTxt) + gsJosa(endTxt.replace(/[)\s]+$/, ''), '으로', '로') + ' '
      + escapeHtml(span + '년간') + ' <b>약 ' + times.toFixed(1) + '배</b> ' + verb + '.</div>';
  }).join('');

  const lg = series.map((s) => '<span class="gs-lg">'
    + '<i class="gs-lg__i" style="background:' + escapeHtml(s.color || 'var(--accent)') + '"></i>'
    + escapeHtml(s.label)
    + (s.scope ? '<span class="gs-lg__s">' + escapeHtml(s.scope) + '</span>' : '')
    + '</span>').join('');

  return '<div class="sm-card sm-card--full"><div class="sm-h">' + escapeHtml(m.title)
    + ' <span class="sm-h__u">(단위: ' + escapeHtml(m.unit || '억 달러') + ')</span></div>'
    + heads
    + (m.mixNote ? '<div class="gs-mixnote">※ ' + escapeHtml(m.mixNote) + '</div>' : '')
    // 좁은 화면에서 라벨이 못 읽을 만큼 작아지지 않게, 아래 폭부터는 줄이는 대신
    // 이 그래프 안에서만 좌우로 밀어 볼 수 있게 한다(.kp-t__wrap 과 같은 방식).
    + '<div class="gs-svgwrap">'
    + `<svg class="sm-mktsvg gs-mktsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ' aria-label="' + escapeHtml(m.title) + '">'
    + grid + xlab + body
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/></svg></div>`
    + '<div class="gs-mktlg">' + lg + '</div>'
    + '<div class="sm-mktlg"><span class="sm-mktlg__dot"></span>실측(조사기관이 발표한 값)'
    + '<span class="sm-mktlg__hollow"></span>전망(조사기관 예측)'
    + '<span class="sm-mktlg__dash"></span>' + escapeHtml(m.gapNote || '') + '</div>'
    // 적용 환율 — 국제유가·제품가 카드와 같은 공용 문구(.viz-fxnote)
    + krwNote('USD')
    + gSrcFoot(m.source, null, m.sourceLinks)
    + (m.revisionNote
      ? '<div class="sm-foot">※ ' + gLinkify(m.revisionNote, m.revisionLinks) + '</div>' : '')
    + '</div>';
}

/** 국외 섹션에 덧붙는 두 블록(시장 규모 추이 + 주요 기업 카드).
    ★ 로드 전이거나 실패했으면 빈 문자열을 돌려, 기존 PPI 카드만 그대로 나오게 한다. */
function gsBlocksHtml() {
  if (!_gsData || _gsData.status !== 'ok') return '';
  return '<div class="sm-wrap gs-wrap">'
    + gsSleepMarket(_gsData.sleepMarket || {})
    + stCardsHtml(_gsData.sleepTech)
    + '</div>';
}

/** 국외 섹션 — 미국 매트리스 제조업 PPI 블록 하나. 그 외에는 만들지 않는다.
    payload 에 us_ppi 섹션이 없으면(구버전 dashboard.json) null 을 돌려
    호출부가 기존 SEC 분기 실적 카드를 그대로 쓰게 한다. */
function gtGlobalHtml() {
  // PPI 가 없으면 예전처럼 null 을 돌려 SEC 분기 실적 카드로 되돌아간다(기존 동작 그대로).
  if (!_usPpi) return null;
  return '<div class="gc-block"><div class="gc-h">미국 매트리스 제조업'
    + gcAbbr(PPI_ABBR, PPI_ABBR_TIP) + '</div>'
    + gUsPpiBlock() + '</div>'
    + gsBlocksHtml();   // 순수 추가: 해외 슬립테크 시장 규모 + 주요 기업(없으면 빈 문자열)
}

/* 국외 섹션 소제목 — 블록이 늘어난 만큼만 문구를 늘린다.
   ★ 해외 슬립테크 데이터가 없으면(로드 실패·구버전) 예전 문구를 그대로 돌려준다. */
const GT_SUB_PPI = '미국 매트리스 가격 동향';
const GT_DESC_PPI = '미국 매트리스 공장 출고가격(생산자물가지수)의 연평균 추이 · '
  + 'BLS(Bureau of Labor Statistics, 미국 노동통계국) 월별 데이터 자동 수집';

function gtSubTitle() {
  return (_gsData && _gsData.status === 'ok')
    ? GT_SUB_PPI + ' · 해외 슬립테크 시장' : GT_SUB_PPI;
}

function gtSubDesc() {
  return (_gsData && _gsData.status === 'ok')
    ? GT_DESC_PPI + ' · 해외 슬립테크 시장 규모와 주요 기업은 수기 입력(출처는 각 카드에 표기)'
    : GT_DESC_PPI;
}

/* ── 원화 병기 공용 헬퍼 (순수 추가) ─────────────────────────────────────
   ★ 저장된 값은 원래 통화로 유지하고, 표시할 때만 환율을 곱한다.
   ★ 환율을 못 읽으면 null 을 돌려 호출부가 외화만 표시하게 한다. */

/** 축·툴팁용 원화 축약: 3.2조 / 7,974억 / 5,200만 / 1,200원 */
function fmtKrwAxis(v) {
  if (v == null || !isFinite(v)) return null;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  // 축약 규칙: 조는 소수 한 자리, 억·만은 정수(3.2조 / 7,974억 / 5,200만)
  const n1 = (x) => x.toLocaleString('ko-KR', { maximumFractionDigits: 1 });
  const n0 = (x) => Math.round(x).toLocaleString('ko-KR');
  if (a >= 1e12) return sign + n1(a / 1e12) + '조';
  if (a >= 1e8) return sign + n0(a / 1e8) + '억';
  if (a >= 1e4) return sign + n0(a / 1e4) + '만';
  return sign + n0(a) + '원';
}

/** 단위 문자열 → KRW 환산 배율. 원화·미지원 통화면 null.
    KOIMA 일일가격처럼 품목마다 단위가 다른 경우에 쓴다($/ton, ￠/lb, CNY/tonne …). */
function krwFactor(unit) {
  const u = String(unit || "").trim();
  const r = krwRate("USD");
  if (r == null) return null;
  if (u.charAt(0) === "$") return r;              // $/ton, $/tonne, $/mmbtu
  if (u.charAt(0) === "￠") return r / 100;      // ￠/lb — 미국 센트
  return null;                                    // CNY·원·천원 단위는 환산하지 않는다
}

/** 통화 → KRW 환율. 기존 환율 데이터만 참조하고 새로 수집하지 않는다. */
function krwRate(cur) {
  const c = String(cur || 'USD').toUpperCase();
  if (c === 'KRW') return 1;
  if (c === 'USD' && _matUsdKrw != null) return _matUsdKrw;
  try {
    const s = _fx && _fx.series;
    const arr = s && s[c];
    if (Array.isArray(arr)) {
      for (let i = arr.length - 1; i >= 0; i -= 1) if (arr[i] != null) return arr[i];
    }
  } catch (e) { /* 표기용이라 실패해도 무시 */ }
  return null;
}

/** 환율 기준일(해당 통화의 마지막 관측일). 없으면 null */
function krwAsOf(cur) {
  const c = String(cur || 'USD').toUpperCase();
  try {
    const s = _fx && _fx.series;
    if (!s || !Array.isArray(s.dates) || !Array.isArray(s[c])) return null;
    for (let i = s[c].length - 1; i >= 0; i -= 1) if (s[c][i] != null) return s.dates[i] || null;
  } catch (e) { /* 무시 */ }
  return null;
}

/** 차트 근처에 한 번만 붙이는 "적용 환율" 문구. 환율 없으면 '' */
function krwNote(cur) {
  const c = String(cur || 'USD').toUpperCase();
  const r = krwRate(c);
  if (r == null) return '';
  const d = krwAsOf(c);
  return '<div class="viz-fxnote">적용 환율 1 ' + escapeHtml(c) + ' = '
    + Math.round(r).toLocaleString('ko-KR') + '원'
    + (d ? ' <span class="viz-fxnote__d">(' + escapeHtml(d) + ' 기준)</span>' : '') + '</div>';
}

/** Y축 눈금 아래에 붙일 원화 둘째 줄. 환율 없으면 '' */
function vizKrwTick(x, y, val, rate) {
  if (rate == null || val == null || val === 0) return '';
  const t = fmtKrwAxis(val * rate);
  if (!t) return '';
  return '<text x="' + x + '" y="' + (y + 9.5).toFixed(1) + '" text-anchor="end" font-size="7"'
    + ' fill="var(--muted)" opacity=".78">' + escapeHtml(t) + '</text>';
}

/** wrap 의 차트 상태(툴팁 데이터·기하). 없으면 null */
function gtState(wrap) {
  const k = wrap && wrap.getAttribute('data-gt-chart');
  const st = k ? _gtCharts[k] : null;
  return (st && st.tip && st.tip.length && st.geom) ? st : null;
}

/** 포인터 x좌표 → 인덱스. 차트 밖이면 null */
function gtHitIndex(wrap, svg, clientX) {
  const st = gtState(wrap);
  if (!st) return null;
  const r = svg.getBoundingClientRect();
  if (!r.width) return null;
  const vb = ((clientX - r.left) / r.width) * VIZ_W;      // viewBox 좌표로 환산
  const g = st.geom;
  if (g.n < 2) return 0;
  const i = Math.round(((vb - g.padL) / g.plotW) * (g.n - 1));
  return Math.max(0, Math.min(g.n - 1, i));
}

/** 툴팁·activeDot 표시. i=null 이면 감춘다. 미국·이탈리아 차트가 같은 경로를 쓴다. */
function gtShowTip(wrap, i) {
  const tip = wrap.querySelector('.gt-tip');
  const hov = wrap.querySelector('.gt-hov');
  const st = gtState(wrap);
  if (!tip || !hov) return;
  if (!st || i == null || !st.tip[i]) {
    tip.hidden = true; hov.classList.remove('is-on');
    wrap.querySelectorAll('.gt-adot').forEach((c) => { c.setAttribute('cx', '-99'); });
    return;
  }
  const g = st.geom;
  const x = g.padL + (g.n === 1 ? g.plotW / 2 : (i / (g.n - 1)) * g.plotW);
  const line = hov.querySelector('.gt-hov__l');
  if (line) { line.setAttribute('x1', x.toFixed(1)); line.setAttribute('x2', x.toFixed(1)); }
  const rows = st.tip[i].rows;
  wrap.querySelectorAll('.gt-adot').forEach((c) => {
    const r = rows[Number(c.getAttribute('data-si'))];
    if (r) { c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', r.y.toFixed(1)); }
    else { c.setAttribute('cx', '-99'); }
  });
  hov.classList.add('is-on');
  const body = rows.filter(Boolean).map((r) => '<div class="gt-tip__r">'
    + '<i style="background:' + r.color + (r.seg ? ';border-radius:0' : '') + '"></i>'
    + '<span class="gt-tip__n">' + escapeHtml(r.name) + '</span>'
    + '<span class="gt-tip__v">' + r.val + '</span></div>').join('');
  tip.innerHTML = '<div class="gt-tip__q">' + escapeHtml(st.tip[i].q) + '</div>' + body;
  tip.hidden = false;
  const pct = Math.max(0, Math.min(100, (x / VIZ_W) * 100));
  tip.style.left = pct.toFixed(2) + '%';
  // 오른쪽 끝에서는 툴팁을 왼쪽으로 붙여 화면을 넘지 않게 한다
  tip.style.transform = (pct > 72) ? 'translateX(-100%)' : (pct < 28 ? 'none' : 'translateX(-50%)');
}

/** 차트 툴팁 배선(위임 1회 등록). 티어 필터가 없어져 클릭 핸들러는 두지 않는다. */
function wireGtControls() {
  const el = document.getElementById('compRoot');
  if (!el || el.dataset.gtWired === '1') return;
  el.dataset.gtWired = '1';

  // hover(데스크톱) + pointerdown(모바일 탭) 모두 같은 경로로 처리한다.
  const move = (ev) => {
    const svg = ev.target.closest && ev.target.closest('.gt-chart');
    if (!svg) return;
    const wrap = svg.closest('.gt-chartwrap');
    if (wrap) gtShowTip(wrap, gtHitIndex(wrap, svg, ev.clientX));
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerdown', move);
  el.addEventListener('pointerleave', () => {
    el.querySelectorAll('.gt-chartwrap').forEach((w) => gtShowTip(w, null));
  }, true);
  el.addEventListener('pointerout', (ev) => {
    const wrap = ev.target.closest && ev.target.closest('.gt-chartwrap');
    if (wrap && !wrap.contains(ev.relatedTarget)) gtShowTip(wrap, null);
  });
}

/** 경쟁사 분석 전체 렌더 (국내 + 국외) */
function renderCompetitor() {
  const el = document.getElementById('compRoot');
  if (!el) return;
  const g = _competitors && _competitors.global;
  const rate = _competitors && _competitors.usd_krw_rate;
  const rateNote = (rate != null)
    ? `<div class="comp-fxnote">적용 환율: 1 USD = ${Math.round(rate).toLocaleString('ko-KR')}원</div>`
    : '';
  const gSum = compQtrSummary(g || []);
  // 순수 추가: 티어 뷰(payload 에 tier_defs 가 오면). 구버전 payload 면 기존 화면 그대로.
  let globalHtml, gTier = false;
  if (g && g.length) {
    _compLatest = gSum && gSum.latest;
    const tierHtml = gtGlobalHtml();
    gTier = !!tierHtml;
    globalHtml = tierHtml
      || `<div class="gco-grid">${g.map((c, i) => compGlobalCard(c, i, rate)).join('')}</div>
       ${rateNote}
       ${compRevBars(g)}
       <div class="comp-caption">출처: SEC EDGAR${compFetchedAt()}</div>`;
  } else {
    globalHtml = emptyState('국외 경쟁사 데이터 준비중');
  }


  // 국내: 시몬스/경쟁사 실적·점유율 — public/data/simmons-market.json 단일 소스.
  // (네이버 금융 분기 수집기는 그대로 두되 이 자리에는 더 쓰지 않는다)
  const koreaHtml = smKoreaHtml();

  el.innerHTML = `
    <div class="comp-group">
      <div class="comp-group__head">국내 <span class="comp-group__tag">Korea</span></div>
      <div class="comp-group__sub">시몬스·경쟁사 실적과 시장 점유율
        <span class="comp-group__desc">단위 억원 · 비상장사 수기 입력 · 출처는 각 차트에 표기</span>
      </div>
      ${koreaHtml}
    </div>
    <div class="comp-group">
      <div class="comp-group__head">국외 <span class="comp-group__tag">Global</span></div>
      <div class="comp-group__sub">${gTier ? gtSubTitle() : '분기별 실적'}
        <span class="comp-group__desc${gTier ? ' comp-group__desc--own' : ''}">${gTier ? gtSubDesc() : '매출·순이익 · 전년 동기 대비(YoY) 기준 · SEC EDGAR'}</span>
      </div>
      ${globalHtml}
    </div>`;
  wireGtControls();
}

/* ============================================================
   4) 업계 주요 뉴스 섹션
   ============================================================ */

const _newsState = { category: '전체', region: '전체' };

/** 날짜 표시: 2025-06-15 → 2025.06.15 */
function fmtDate(d) {
  return String(d || '').replace(/-/g, '.');
}

/** url이 안전한 http(s) 링크인지 */
function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

/** 고유값 목록 (등장 순서 유지) */
function distinct(rows, key) {
  const seen = new Set();
  const out = [];
  rows.forEach((r) => {
    const v = String(r[key] || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  });
  return out;
}


/* ============================================================
   5) 원자재 원가 동향 섹션
   ============================================================ */

/* ── 차트 공통 치수 상수 ────────────────────────────────────────────────
   대시보드의 모든 선그래프(스폰지·정시성·국제유가·월간지수·일일가격·환율)가
   이 값을 공유한다. 차트 높이를 바꾸려면 VIZ_H 한 곳만 고치면 된다.
   ★ 값(데이터)·색상·시리즈 구성·툴팁에는 관여하지 않는 '치수 전용' 상수다. */
const VIZ_W = 720;            // viewBox 가로(고정) — 실제 크기는 CSS width:100% 로 결정
const VIZ_H = 158;            // viewBox 세로 ← 300 → 190 → 158 (직전의 83%). 여기만 고치면 전 차트 반영
const VIZ_PAD_T = 10;         // 위 여백(기존 16~18)
const VIZ_PAD_B = 24;         // 아래 여백(기존 30~34) — X축 라벨 자리
const VIZ_FS_AXIS = 8.5;      // 축 눈금 폰트(기존 9~10)
const VIZ_FS_LABEL = 8;       // 데이터 라벨 폰트(기존 10)
const VIZ_Y_TICKS = 4;        // Y 눈금 개수(기존 5)
const VIZ_TICK_GAP = 96;      // X 라벨 최소 간격(px) — 겹침 방지
const VIZ_LABEL_MAX_PTS = 12; // 점이 이 개수 이하일 때만 데이터 라벨 유지(그 외는 툴팁으로만)

/** Y 눈금 위치 비율 배열 (0~1). VIZ_Y_TICKS 개. */
function vizYFractions() {
  const n = Math.max(2, VIZ_Y_TICKS);
  return Array.from({ length: n }, (_, i) => i / (n - 1));
}

/** X 눈금 인덱스: 라벨 1개당 최소 gap(px) 을 확보해 겹치지 않는 개수만 고른다. */
function vizTickIdx(n, plotW, gap) {
  const g = gap || VIZ_TICK_GAP;
  // 눈금 수는 '라벨 최소 간격(g)'만으로 정한다. 예전엔 여기에 min(8, …) 상한이 있어
  // 자리가 남는데도 8개로 잘렸고, 12개월 고정 차트(정시성·스폰지 단일연도)에서
  // Feb/May/Aug/Nov 가 누락됐다. g 가 이미 겹침을 막으므로 별도 상한은 두지 않는다.
  // (recharts 의 interval={0} 에 해당 — 자리가 되면 전부, 모자라면 g 간격으로 생략)
  const maxTicks = Math.max(2, Math.floor(plotW / g));
  const t = Math.min(maxTicks, n);
  const out = [];
  for (let k = 0; k < t; k++) {
    const i = t <= 1 ? 0 : Math.round((k / (t - 1)) * (n - 1));
    if (!out.includes(i)) out.push(i);
  }
  return out;
}

/* ── 스폰지 주원료 시황 (ICIS Asia, 고정 데이터) ── */
const ICIS_DATA = {
  periods: ["2021-01","2021-02","2021-03","2021-04","2021-05","2021-06","2021-07","2021-08","2021-09","2021-10","2021-11","2021-12","2022-01","2022-02","2022-03","2022-04","2022-05","2022-06","2022-07","2022-08","2022-09","2022-10","2022-11","2022-12","2023-01","2023-02","2023-03","2023-04","2023-05","2023-06","2023-07","2023-08","2023-09","2023-10","2023-11","2023-12","2024-01","2024-02","2024-03","2024-04","2024-05","2024-06","2024-07","2024-08","2024-09","2024-10","2024-11","2024-12","2025-01","2025-02","2025-03","2025-04","2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03","2026-04","2026-05","2026-06"],
  PPG: [2600,2600,2650,2550,2800,2600,2300,2450,2450,2350,2550,2300,2300,1900,2000,2000,1850,1850,1825,1300,1350,1600,1750,1400,1180,1500,1600,1600,1550,1395,1450,1435,1435,1450,1350,1350,1400,1370,1350,1400,1400,1388,1350,1320,1296,1299,1295,1266,1261,1250,1250,1182,1150,1156,1160,1194,1188,1224,1186,1191,1221,1209,1776,2110,1666,1350],
  TDI: [1900,1950,2800,2700,2500,2080,1900,2050,2150,2300,2450,2450,2450,2600,2950,3000,2900,2550,2600,2500,2550,2750,3000,2500,2600,2800,2650,2400,2450,2200,2200,2200,2050,2100,2050,1950,1950,2100,2100,2025,1960,1900,1880,1872,1800,1800,1800,1800,1850,1938,1808,1682,1680,1650,1740,1975,1825,1800,1700,1810,1825,1888,2500,2890,2563,2238],
  MDI: [2300,2600,3300,2900,2450,2200,2400,2600,2600,3000,2700,2500,2500,2800,2800,2700,2650,2400,2200,2050,1950,1950,1850,1600,1750,1850,2000,1900,1800,1775,1850,1930,1950,1900,1750,1750,1800,2100,2100,2063,2100,2163,2200,2175,2113,2200,2200,2100,2175,2238,2150,2010,1988,1925,1832,1817,1763,1686,1650,1765,1765,1750,2300,2920,2688,2375],
  PO: [2100,2100,2400,2350,2275,1850,1790,2070,2070,2240,2250,2070,1700,1800,1500,1450,1375,1330,1220,1050,1120,1250,1050,1050,1050,1150,1380,1165,1200,1210,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,965,948,920,903,915,920,904,907,910,925,955,962,994,1000,1355,1710,1713,1398],
};
const ICIS_SERIES = [
  { key: 'PPG', color: '#3B82F6' },  // 파랑
  { key: 'TDI', color: '#12B981' },  // 초록
  { key: 'MDI', color: '#F59E0B' },  // 주황
  { key: 'PO',  color: '#8B5CF6' },  // 보라
];

// 원료 용어 설명 (그래프 색과 매칭)
const ICIS_TERMS = [
  { key: 'PPG', color: '#3B82F6', full: 'Polypropylene Glycol (폴리프로필렌글리콜, Polyether Polyol)',
    use: '폴리우레탄 폼의 주원료. 침대 매트리스·소파·자동차 시트 등에 사용' },
  { key: 'TDI', color: '#12B981', full: 'Toluene Diisocyanate (톨루엔 디이소시아네이트)',
    use: '연질(Soft) 폴리우레탄 폼 제조에 사용되는 핵심 원료' },
  { key: 'MDI', color: '#F59E0B', full: 'Methylene Diphenyl Diisocyanate (메틸렌 디페닐 디이소시아네이트)',
    use: '경질(Rigid) 폴리우레탄 폼 및 고기능 폼 제조에 사용되는 원료' },
  { key: 'PO', color: '#8B5CF6', full: 'Propylene Oxide (프로필렌 옥사이드)',
    use: 'PPG(폴리올)를 만드는 기초 원료(원료의 원료)' },
];

// 그래프 아래 "주요 시황 원자재 링크" (클릭 시 새 탭)
const MATERIAL_LINKS = [
  { name: '글로벌 컨테이너 운임지수', desc: 'Freightos Baltic Index (FBX)', icon: '🚢',
    url: 'https://app.terminal.freightos.com/fbx?ticker=FBX&frequency=%22weekly%22' },
  { name: '제재목 (Lumber)', desc: 'Trading Economics Lumber', icon: '🪵',
    url: 'https://tradingeconomics.com/commodity/lumber' },
];

let _icisChart = null;
let _matReady = false;      // [업데이트] 누르기 전엔 빈 초기 상태
let _matYear = null;        // 선택된 연도('2021'~'2026' | 'all')
let _matUsdKrw = null;      // USD/KRW 환율(업데이트 시 확보)

// 해상 정시성(Sea-Intelligence) — 연도별 선 색상 + 상태
const SR_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 연도별 선 색 — 순환 팔레트.
// ★ 앞 6색은 기존 SR_YEAR_COLORS(2021~2026)의 값을 순서 그대로 옮긴 것이라
//   현재 화면의 연도별 색은 변하지 않는다. 2027부터 뒤쪽 색을 이어 쓴다.
const SR_YEAR_BASE = 2021;          // 팔레트 0번이 대응하는 연도
const SR_PALETTE = [
  '#94A3B8', // 2021 (기존)
  '#3B82F6', // 2022 (기존)
  '#12B981', // 2023 (기존)
  '#F59E0B', // 2024 (기존)
  '#8B5CF6', // 2025 (기존)
  '#C8102E', // 2026 (기존)
  '#0EA5E9', // 2027 ↓ 신규
  '#DB2777', // 2028
  '#65A30D', // 2029
  '#F97316', // 2030
];

/** 연도 → 선 색. 팔레트 10색을 순환하므로 2031년에야 2021과 색이 겹친다. */
function srYearColor(year) {
  const n = Number(year);
  if (!isFinite(n)) return 'var(--slate)';
  const len = SR_PALETTE.length;
  return SR_PALETTE[(((n - SR_YEAR_BASE) % len) + len) % len];
}
let _srData = null;   // {months, years:{...}} | {error:'reason'} | null
let _srYear = null;   // '2021'~'2026' | 'all'
let _srChart = null;

let _icisForecast = null; // 순수 추가: 다음 달 주원료 예측(백엔드 계산). null이면 예측 섹션 숨김
let _srForecast = null;   // 순수 추가: 다음 달 해상 정시성 예측(백엔드 계산). null이면 섹션 숨김

/** 응답의 usd_krw + 해상 정시성 + 국제유가 저장 + 원자재 섹션을 "업데이트됨" 상태로 전환 */
function applyMaterialUpdate(data) {
  _matReady = true;
  const uk = data && data.sections && data.sections.usd_krw;
  _matUsdKrw = (uk && uk.status === 'ok') ? uk.rate : null;

  const sr = data && data.sections && data.sections.schedule_reliability;
  if (sr && sr.status === 'ok' && sr.years && Object.keys(sr.years).length) {
    _srData = { months: (sr.months && sr.months.length) ? sr.months : SR_MONTHS, years: sr.years };
    // ICIS와 동일: 업데이트 직후엔 그래프를 띄우지 않고 연도 선택을 기다린다(_srYear=null → "연도를 선택하세요")
  } else {
    _srData = { error: (sr && sr.reason) || '데이터 없음' };
  }

  // 국제유가(원유) — 기준 4개(년·월·주·일)를 한 번에 받아 두고 화면에서 자른다
  const oc = data && data.sections && data.sections.oil_crude;
  if (oc && oc.status === 'ok' && oc.terms && Object.keys(oc.terms).length) {
    _ocData = oc;
    if (!_ocForm) _ocForm = ocFormFor(ocTerm('m') ? 'm' : Object.keys(oc.terms)[0]);
  } else {
    _ocData = { error: (oc && oc.reason) || '데이터 없음' };
  }
  // 국제유가(석유제품) — 원유와 같은 구조의 별도 섹션
  const op = data && data.sections && data.sections.oil_product;
  if (op && op.status === 'ok' && op.terms && Object.keys(op.terms).length) {
    _opData = op;
    if (!_opForm) _opForm = opFormFor(opTerm('d') ? 'd' : Object.keys(op.terms)[0]);
  } else {
    _opData = { error: (op && op.reason) || '데이터 없음' };
  }
  // 순수 추가: 다음 달 예측 저장(있을 때만; 없으면 예측 섹션 숨김)
  const fc = data && data.sections && data.sections.icis_forecast;
  _icisForecast = (fc && fc.status === 'ok') ? fc : null;
  const srf = data && data.sections && data.sections.sr_forecast;
  _srForecast = (srf && srf.status === 'ok') ? srf : null;  // 순수 추가: 정시성 예측
  renderMaterial();
}

/** 선택 연도에 맞춰 periods/series 슬라이스 (데이터 있는 원료만) */
function icisViewData(year) {
  const P = ICIS_DATA.periods;
  const idx = year === 'all'
    ? P.map((_, i) => i)
    : P.map((p, i) => (p.slice(0, 4) === year ? i : -1)).filter((i) => i >= 0);
  const periods = idx.map((i) => P[i]);
  const series = ICIS_SERIES
    .map((s) => ({ key: s.key, color: s.color, values: idx.map((i) => ICIS_DATA[s.key][i]) }))
    .filter((s) => s.values.some((v) => v != null));  // 값 없는 원료(예: 2024 PO)는 생략
  return { periods, series };
}

/** 섹션 5 전체 렌더: 업데이트 전 안내 → 업데이트 후 연도 툴바 → 연도 선택 시 그래프 */
function renderMaterial() {
  const root = document.getElementById('materialRoot');
  if (!root) return;
  if (!_matReady) {
    root.innerHTML = emptyState('업데이트 버튼을 누르면 표시됩니다');
    return;
  }
  // 연도 칩은 데이터(ICIS_DATA.periods)에서 뽑는다 — 하드코딩 배열이 아니라서
  // 나중에 2027 데이터가 추가되면 2027 칩이 자동으로 생긴다.
  const icisYears = Array.from(new Set(ICIS_DATA.periods.map((p) => p.slice(0, 4)))).sort();
  const years = icisYears.concat(['all']);
  // 데이터가 비면 칩을 그리지 않는다(빈 툴바가 남아 레이아웃이 뜨는 것 방지).
  const toolbar = icisYears.length
    ? `<div class="icis-years">${years.map((y) =>
      `<button class="icis-year${y === _matYear ? ' is-active' : ''}" data-year="${y}">${y === 'all' ? '전체' : y}</button>`).join('')}</div>`
    : '';

  let body;
  if (!_matYear) {
    body = '<div class="icis-prompt">연도를 선택하세요</div>';
  } else {
    const { periods, series } = icisViewData(_matYear);
    body = buildIcisChart(periods, series) + icisLatest() + icisTermsTable()
      + renderIcisForecastHtml();  // 순수 추가: 용어표 아래 '다음 달 전망'
  }

  // 순수 추가: KOIMA 요약 한 줄을 맨 앞에 덧붙인다(데이터 없으면 '' → 기존 출력과 동일).
  root.innerHTML = renderKoimaSummaryHtml() + `<div class="viz-root viz-figure icis-figure">
    <div class="viz-head"><div>
      <div class="viz-title">스폰지 주원료 시황 (ICIS Asia)</div>
      <div class="viz-sub">PPG·TDI·MDI·PO 월별 (USD/톤) → 원료의 월별 시장가격 추이를 보여주는 자료</div>
    </div></div>
    ${toolbar}
    ${body}
    <div class="viz-tooltip" id="icisTooltip"></div>
    <div class="comp-caption">출처: ICIS Asia</div>
  </div>
  ${renderScheduleReliabilityHtml()}
  ${renderOilPricesHtml()}
  ${renderOilProductHtml()}
  ${renderKoimaHtml()}
  ${renderKoimaPriceHtml()}
  ${renderMaterialLinksHtml()}`;

  const yearsEl = root.querySelector('.icis-years');
  if (yearsEl) yearsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.icis-year');
    if (!b) return;
    _matYear = b.dataset.year;
    renderMaterial();
  });
  if (_matYear) wireIcisChart();

  const srYearsEl = root.querySelector('.sr-years');
  if (srYearsEl) srYearsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.sr-year');
    if (!b) return;
    _srYear = b.dataset.year;
    renderMaterial();
  });
  const srFig = root.querySelector('.sr-figure');
  if (srFig) srFig.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-sr-report]');
    if (!b) return;
    _srReport = !_srReport;      // 펼치기/접기
    renderMaterial();
  });
  if (_srData && !_srData.error) wireSrChart();

  wireCrudeControls(root);   // 국제유가(원유): 기준·기간·제품 + [조회]
  wireProductControls(root); // 국제유가(석유제품): 같은 조회 UI

  wireKoimaControls(root);  // 순수 추가: KOIMA 부문별 지수 카드
  wireKpControls(root);     // 순수 추가: KOIMA 일일 국제원자재가격 카드
}

/** 4개 원료 월별 선그래프 SVG (null 구간 선 끊김) */
function buildIcisChart(periods, series) {
  const n = periods.length;
  if (!n || !series.length) return '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
  const singleYear = periods.every((p) => p.slice(0, 4) === periods[0].slice(0, 4));

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.08 || 100; ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 46, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val).toLocaleString('en-US')}</text>${vizKrwTick(padL - 6, y, val, _matUsdKrw)}`;
  }).join('');

  // 단일 연도는 'MM월'(짧음)이라 간격을 좁게, 전체 보기는 'YYYY-MM'이라 넓게
  const xticks = vizTickIdx(n, plotW, singleYear ? 44 : VIZ_TICK_GAP).map((i) => {
    const p = periods[i];
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(singleYear ? p.slice(5) + '월' : p)}</text>`;
  }).join('');

  const lines = series.map((s) => {
    let path = '', pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  // 각 데이터 점 표시
  const dots = series.map((s) => s.values.map((v, i) => v == null ? '' :
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1"/>`).join('')).join('');
  // 값 라벨 방침: 차트가 낮아진 뒤 실측하니 4개 시리즈(PPG·TDI·MDI·PO)를 겹쳐 그리는
  // 이 차트는 12개월 보기에서도 라벨이 서로 겹쳤다(2022년 6쌍, 2023년 4쌍).
  // → 시리즈가 1개일 때만 라벨을 남기고, 그 외에는 툴팁으로만 값을 보여준다.
  const labels = (singleYear && n <= VIZ_LABEL_MAX_PTS && series.length === 1) ? series.map((s, si) => s.values.map((v, i) => {
    if (v == null) return '';
    const x = X(i), y = Y(v);
    let ly = (si % 2 === 0) ? y - 6 : y + 11;
    if (ly < padT + 7) ly = y + 11;
    if (ly > padT + plotH) ly = y - 6;
    return `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_LABEL}" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${s.color}">${Math.round(v).toLocaleString('en-US')}</text>`;
  }).join('')).join('') : '';

  const legend = `<div class="viz-legend">${series.map((s) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${s.color}"></span>${s.key}</span>`).join('')}</div>`;
  _icisChart = { periods, series, geom: { X, Y, n, W, padL } };

  return `${legend}
    <svg class="viz-svg icis-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="스폰지 주원료 시황">
      ${grid}${xticks}${lines}${dots}${labels}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="icis-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="icis-dots"></g>
      <rect class="icis-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 최신값 병기 (USD/톤 → ≈ 원/톤) + 적용 환율 */
/** 순수 추가: 적용 환율의 기준일(YYYY-MM-DD). _fx.series 의 마지막 유효 USD 값 날짜.
 *  usd_krw 섹션에는 날짜가 없어(rate 만 옴) 같은 값을 주는 _fx 에서 날짜만 빌려온다.
 *  ★ 환율 값·원화 환산 계산에는 관여하지 않는다(표기용). 없으면 null. */
function fxAsOfDate() {
  try {
    const s = _fx && _fx.series;
    if (!s || !Array.isArray(s.dates) || !Array.isArray(s.USD)) return null;
    for (let i = s.USD.length - 1; i >= 0; i--) {
      if (s.USD[i] != null) return s.dates[i] || null;
    }
  } catch (e) { /* 표기용이라 실패해도 무시 */ }
  return null;
}

function icisLatest() {
  const rate = _matUsdKrw;
  // ★ 선택된 연도 칩과 무관하게 '전체 데이터'의 최신값을 쓴다.
  //   예전에는 연도로 잘린 series 를 받아 2021 칩에서 2021-12 값이 나왔고,
  //   라벨('최신값')과 동작이 어긋났다. 아래 예측 섹션의 '최신 데이터' 표기와도
  //   이제 같은 기준(전체 마지막 월)을 가리킨다.
  const full = icisViewData('all');
  const periods = full.periods;
  // 값과 함께 '몇 번째 월의 값인지'(idx)도 잡아 둔다 — 기준 연월 표기용.
  const items = full.series.map((s) => {
    for (let i = s.values.length - 1; i >= 0; i--) {
      if (s.values[i] != null) return { key: s.key, color: s.color, v: s.values[i], idx: i };
    }
    return null;
  }).filter(Boolean);
  if (!items.length) return '';
  // 원료별로 마지막 값의 월이 다를 수 있어(PO 결측 구간) 가장 늦은 월을 기준으로 표기한다.
  const asOf = periods[Math.max.apply(null, items.map((it) => it.idx))] || null;
  const rows = items.map((it) => {
    const krw = (rate != null) ? ` <span class="icis-krw">≈ 약 ${escapeHtml(fmtKrwShort(it.v * rate))}/톤</span>` : '';
    return `<span class="icis-latest__item"><span class="icis-dot" style="background:${it.color}"></span><b>${it.key}</b> ${it.v.toLocaleString('en-US')} USD/톤${krw}</span>`;
  }).join('');
  // 두 기준을 한 줄에 나란히 두면 어느 게 무엇의 기준인지 안 드러난다.
  // → 헤드에는 '데이터 기준월'만, 환율 기준은 아랫줄에 작게 분리한다.
  const fxDate = fxAsOfDate();
  const fxNote = (rate != null)
    ? `<div class="icis-fxnote">원화 환산은 1 USD = ${Math.round(rate).toLocaleString('ko-KR')}원${fxDate ? ` (${escapeHtml(fxDate)})` : ''} 적용</div>` : '';
  const asOfNote = asOf ? `<span class="icis-asof">· ${escapeHtml(asOf)}</span>` : '';
  return `<div class="icis-latest">
    <div class="icis-latest__head">최신값 ${asOfNote}</div>
    <div class="icis-latest__row">${rows}</div>
    ${fxNote}
  </div>`;
}

/** 원료 용어 설명표 (색 점 매칭) */
function icisTermsTable() {
  const rows = ICIS_TERMS.map((t) =>
    `<tr><td class="icis-term__var"><span class="icis-dot" style="background:${t.color}"></span>${t.key}</td>
      <td>${escapeHtml(t.full)}</td><td>${escapeHtml(t.use)}</td></tr>`).join('');
  return `<div class="icis-terms">
    <h3 class="subhead">원료 용어 설명</h3>
    <div class="icis-term-wrap"><table class="icis-termtable">
      <thead><tr><th>변수</th><th>의미</th><th>용도</th></tr></thead><tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

/** 순수 추가: 용어표 아래 '다음 달 전망'. 예측 데이터 없으면 '' 반환(섹션 숨김).
 *  숫자는 백엔드가 계산(_icisForecast), 문장(comment/summary/caution)만 AI. 기존 환율값(_matUsdKrw) 참조. */
function renderIcisForecastHtml() {
  const fc = _icisForecast;
  if (!fc || !Array.isArray(fc.materials) || !fc.materials.some((m) => m && m.status === 'ok')) return '';
  const rate = _matUsdKrw;  // 기존 환율 값만 참조(기존 코드 미변경)
  const rcls = (r) => (r === '상방' ? 'up' : (r === '하방' ? 'down' : 'flat'));
  const num = (v) => Number(v).toLocaleString('en-US');
  const moLabel = (ym) => (ym ? `${parseInt(String(ym).slice(5, 7), 10)}월` : '');
  const cards = fc.materials.map((m) => {
    const color = m.color || 'var(--slate)';
    const head = `<div class="icis-fc__head"><span class="icis-dot" style="background:${color}"></span><b>${escapeHtml(m.code)}</b>`;
    if (m.status !== 'ok') {
      return `<div class="icis-fc__card">${head}</div>
        <div class="icis-fc__na">데이터 부족</div>
        <div class="icis-fc__reason">${escapeHtml(m.reason || '')}</div></div>`;
    }
    const krw = (rate != null) ? ` <span class="icis-krw">≈ ${escapeHtml(fmtKrwShort(m.predict * rate))}/톤</span>` : '';
    const d = m.delta, dp = m.delta_pct;
    const dcls = d > 0 ? 'up' : (d < 0 ? 'down' : 'flat');
    const arrow = d > 0 ? '▲' : (d < 0 ? '▼' : '–');
    const prevLbl = m.prev_month ? `${escapeHtml(m.prev_month)} 실측 ${num(m.prev)}` : `직전월 ${num(m.prev)}`;
    const path = (Array.isArray(m.path) && m.path.length > 1)
      ? `<div class="icis-fc__path">${m.path.map((p) => `${moLabel(p.ym)} ${num(p.value)}`).join(' → ')} (추정)</div>`
      : '';
    return `<div class="icis-fc__card">
      ${head}<span class="icis-fc__risk ${rcls(m.risk)}">${escapeHtml(m.risk)}</span></div>
      <div class="icis-fc__val">${num(m.predict)} <span class="icis-fc__unit">USD/톤</span>${krw}</div>
      <div class="icis-fc__delta ${dcls}">${arrow} ${num(Math.abs(d))} (${Math.abs(dp).toFixed(1)}%) <span class="icis-fc__prev">${prevLbl} 대비</span></div>
      ${path}
      <div class="icis-fc__ci">신뢰구간 ${num(m.ci_low)} ~ ${num(m.ci_high)}</div>
      ${m.comment ? `<div class="icis-fc__cmt">${escapeHtml(m.comment)}</div>` : ''}
    </div>`;
  }).join('');
  const gen = fc.generated_at ? `<span class="icis-fc__gen">예측 생성 ${escapeHtml(fc.generated_at)}</span>` : '';
  const sub = fc.last_data_month
    ? `<div class="icis-fc__sub">최신 데이터 ${escapeHtml(fc.last_data_month)} 기준 · ${Number(fc.months_ahead || 1)}개월 후 추정</div>`
    : '';
  const sum = fc.summary ? `<div class="icis-fc__summary">${escapeHtml(fc.summary)}</div>` : '';
  const cau = fc.caution ? `<div class="icis-fc__caution">⚠ ${escapeHtml(fc.caution)}</div>` : '';
  return `<div class="icis-fc">
    <h3 class="subhead icis-fc__title">다음 달 전망 <span class="icis-fc__month">(${escapeHtml(fc.target_month || '')} 예측)</span>${gen}</h3>
    ${sub}
    <div class="icis-fc__grid">${cards}</div>
    ${sum}${cau}
    <div class="icis-fc__disc">통계적 추세 기반 참고용 추정치이며 실제 시황과 다를 수 있습니다. 구매 의사결정의 유일한 근거로 사용하지 마세요.</div>
  </div>`;
}

/** 크로스헤어 + 툴팁 (월 · 원료별 USD/톤 및 원화 환산) */
function wireIcisChart() {
  const fig = document.querySelector('#materialRoot .icis-figure');
  const tip = document.getElementById('icisTooltip');
  if (!fig || !tip || !_icisChart) return;
  const svg = fig.querySelector('.icis-svg');
  const overlay = svg.querySelector('.icis-overlay');
  const cross = svg.querySelector('.icis-cross');
  const dots = svg.querySelector('.icis-dots');
  const c = _icisChart, g = c.geom, rate = _matUsdKrw;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      const krw = (rate != null) ? ` (≈ ${fmtKrwShort(v * rate)}/톤)` : '';
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${s.key}</span><span class="viz-tt-val">${v.toLocaleString('en-US')} USD/톤${krw}</span></div>`;
    });
    dots.innerHTML = dh;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.periods[i])}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 조회 조건 조작 + [조회] + 표/차트 전환 + 내보내기 배선.
    ★ 조건을 만져도 결과는 그대로다 — [조회]를 눌러야 _ocQuery 가 바뀐다(실제 사이트와 동일).
    ★ 기준(term)을 바꾸면 고를 수 있는 연도와 기본 기간이 달라지므로 '조건 영역만'
      다시 그린다. 결과 영역은 건드리지 않는다(아직 조회한 것이 아니므로). */
function wireCrudeControls(root) {
  const fig = root.querySelector('.oil-figure');
  if (!fig || !_ocData || _ocData.error) return;
  const form = fig.querySelector('.oc-formwrap');

  if (form) {
    form.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !_ocForm) return;
      // ★ 리포트가 열려 있는데 조건을 바꾸면, 화면의 폼과 리포트가 서로 다른 조건을
      //   가리켜 리포트가 '고정된' 것처럼 보인다. 그래서 조건이 바뀌면 리포트를 닫는다.
      //   ([조회]를 눌러야 새 조건이 확정된다는 이 카드의 규칙은 그대로다)
      const wasOpen = _ocReport;
      if (t.name === 'ocTerm') {
        _ocForm = ocFormFor(t.value, new Set(_ocForm.on));
        if (wasOpen) { _ocReport = false; renderMaterial(); return; }
        form.innerHTML = ocControlsHtml();
        return;
      }
      const k = t.getAttribute && t.getAttribute('data-oc');
      if (k) {
        _ocForm[k] = t.value;
      } else {
        const p = t.getAttribute && t.getAttribute('data-oc-prod');
        if (!p) return;
        if (t.checked) _ocForm.on.add(p); else _ocForm.on.delete(p);
      }
      if (wasOpen) { _ocReport = false; renderMaterial(); }
    });
    form.addEventListener('click', (e) => {
      const go = e.target.closest && e.target.closest('.oc-go');
      if (!go || !_ocForm) return;
      _ocQuery = { term: _ocForm.term, y0: _ocForm.y0, m0: _ocForm.m0,
        y1: _ocForm.y1, m1: _ocForm.m1, on: new Set(_ocForm.on) };
      renderMaterial();
    });
  }

  fig.addEventListener('click', (e) => {
    const rb = e.target.closest && e.target.closest('[data-oc-report]');
    if (rb) { _ocReport = !_ocReport; renderMaterial(); return; }
    const v = e.target.closest && e.target.closest('[data-oc-view]');
    if (v) { _ocView = v.getAttribute('data-oc-view'); renderMaterial(); return; }
    const x = e.target.closest && e.target.closest('[data-oc-exp]');
    if (!x || !_ocQuery) return;
    const win = ocWindow(_ocQuery);
    const kind = x.getAttribute('data-oc-exp');
    if (kind === 'csv') ocExportCsv(_ocQuery, win);
    else if (kind === 'xls') ocExportXls(_ocQuery, win);
    else ocPrint(_ocQuery, win);
  });

  if (_ocQuery && _ocView === 'chart') wireOilChart();
}

/* ── 국제유가 (PETRONET 일일국제제품가격) ─────────────────────────────────
   원유 카드(oc*)와 같은 UI 패턴이다: 기준선택 → 기간 → 제품 → [조회].

   ★ 원유 카드의 함수를 재사용하지 않고 op* 로 따로 뒀다. oc* 는 _ocData/_ocQuery
     전역을 직접 읽어서, 공통화하려면 원유 카드를 고쳐야 한다. 두 카드가 서로를
     깨뜨리지 않게 이 저장소의 관례대로 '중복을 허용'한다.
     화면 스타일(.oc-*)은 그대로 함께 쓴다 — 모양은 같아야 하므로.
   ★ 제품은 기간을 '일' 단위까지 고른다(기준이 일일 때 연-월-일 드롭다운 세 쌍).
   ★ 요약행 계산 규칙은 원유에서 PETRONET 값과 대조해 확정한 것과 같다. */
const OP_COLORS = {
  gasoline95: '#C8102E', gasoline92: '#F97316', kerosene: '#F59E0B',
  diesel05: '#84CC16', diesel005: '#12B981', diesel0001: '#06B6D4',
  hsfo180: '#3B82F6', hsfo380: '#8B5CF6', naphtha: '#64748B',
};
const OP_DEFAULT_SPAN = { y: null, m: 12, w: 3, d: 1 };   // 기본 조회 폭(개월)
// 체크박스 라벨 옆 짧은 설명 — 라벨의 숫자가 '무슨 뜻인지'를 적는다(숫자를 되풀이하지 않는다).
// ★ 뜻풀이 근거는 PETRONET 조회 페이지 각주다: RON=옥탄가 · cst=동점도(센티스톡) 단위 ·
//   경유 0.5% 는 2012년 12월 1일 게시 중단(그 자리를 경유 0.001%(10ppm)이 대신한다).
// ★ 원유 카드와 같이, 조회 조건의 체크박스에만 쓴다. 표 머리·범례·CSV 는
//   payload 의 series.label 을 그대로 써야 하므로 건드리지 않는다.
const OP_ORIGIN = {
  gasoline95: '옥탄가(RON) 95 · 고옥탄 등급',
  gasoline92: '옥탄가(RON) 92 · 표준 등급',
  kerosene: '난방유 · 항공유 계열',
  diesel05: '황 함량 5,000ppm · 2012년 게시 중단',
  diesel005: '황 함량 500ppm',
  diesel0001: '황 함량 10ppm · 초저황',
  hsfo180: '선박 연료유 · cst는 점도 단위',
  hsfo380: '선박 연료유 · 180cst보다 점도 높음',
  naphtha: '석유화학 기초원료',
};

let _opData = null;     // sections.oil_product
let _opForm = null;     // 사용자가 만지는 중인 조건
let _opQuery = null;    // [조회]로 확정된 조건
let _opView = 'table';  // 'table' | 'chart'
let _opChart = null;    // 차트 크로스헤어·툴팁 상태(원유와 분리)

function opTerm(t) {
  const d = _opData;
  return (d && !d.error && d.terms && d.terms[t]) || null;
}

/** 기간 비교 키 — 일 기준만 '일'까지 본다 */
function opKey(period, term) {
  const p = String(period);
  if (term === 'y') return p.slice(0, 4);
  if (term === 'd') return p.slice(0, 10);
  return p.slice(0, 7);
}

function opLabel(period, term) {
  const p = String(period);
  if (term === 'y') return p + '년';
  if (term === 'm') return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월';
  if (term === 'w') return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월 ' + p.split('W')[1] + '주';
  return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월 ' + p.slice(8, 10) + '일';
}

function opYears(term) {
  const t = opTerm(term);
  if (!t) return [];
  return Array.from(new Set(t.rows.map((r) => String(r.period).slice(0, 4)))).sort();
}

/** 기본 기간 — 마지막 데이터에서 OP_DEFAULT_SPAN 만큼 거슬러 연다 */
function opDefaultSpan(term) {
  const t = opTerm(term);
  if (!t || !t.rows.length) return null;
  const last = t.rows[t.rows.length - 1].period, first = t.rows[0].period;
  const p2 = (n) => String(n).padStart(2, '0');
  if (term === 'y') {
    return { y0: first.slice(0, 4), m0: '01', d0: '01', y1: last.slice(0, 4), m1: '12', d1: '31' };
  }
  const y1 = Number(last.slice(0, 4)), m1 = Number(last.slice(5, 7));
  const span = OP_DEFAULT_SPAN[term] || 12;
  let y0 = y1, m0 = m1 - span + 1;
  while (m0 <= 0) { y0 -= 1; m0 += 12; }
  const fy = Number(first.slice(0, 4)), fm = Number(first.slice(5, 7));
  if (y0 < fy || (y0 === fy && m0 < fm)) { y0 = fy; m0 = fm; }
  return { y0: String(y0), m0: p2(m0), d0: '01',
    y1: String(y1), m1: p2(m1), d1: (term === 'd' ? last.slice(8, 10) : '31') };
}

function opFormFor(term, keepOn) {
  const sp = opDefaultSpan(term) || { y0: '', m0: '01', d0: '01', y1: '', m1: '12', d1: '31' };
  return { term: term, y0: sp.y0, m0: sp.m0, d0: sp.d0, y1: sp.y1, m1: sp.m1, d1: sp.d1,
    on: keepOn || new Set((_opData && _opData.default_on) || []) };
}

function opWindow(q) {
  const t = opTerm(q.term);
  if (!t) return [];
  let a, b;
  if (q.term === 'y') { a = q.y0; b = q.y1; }
  else if (q.term === 'd') { a = q.y0 + '-' + q.m0 + '-' + q.d0; b = q.y1 + '-' + q.m1 + '-' + q.d1; }
  else { a = q.y0 + '-' + q.m0; b = q.y1 + '-' + q.m1; }
  const lo = a <= b ? a : b, hi = a <= b ? b : a;
  return t.rows.filter((r) => {
    const k = opKey(r.period, q.term);
    return k >= lo && k <= hi;
  });
}

function opOnSeries(q) {
  const d = _opData;
  if (!d || d.error) return [];
  return (d.series || []).filter((s) => q.on.has(s.key))
    .map((s) => ({ key: s.key, label: s.label, color: OP_COLORS[s.key] || 'var(--slate)' }));
}

/* 요약행 — 규칙은 원유 카드와 같다(PETRONET 값과 대조해 확정).
   비교 대상은 '받아둔 전 구간'에서 찾는다 — 조회 창 밖의 과거가 필요하다. */
function opShift(iso, dy, dm, dd) {
  const Y = Number(iso.slice(0, 4)), M = Number(iso.slice(5, 7)), D = Number(iso.slice(8, 10));
  let yy = Y + (dy || 0), mm = M + (dm || 0);
  yy += Math.floor((mm - 1) / 12);
  mm = ((mm - 1) % 12 + 12) % 12 + 1;
  const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const t = new Date(Date.UTC(yy, mm - 1, Math.min(D, dim)));
  t.setUTCDate(t.getUTCDate() + (dd || 0));
  return t.toISOString().slice(0, 10);
}

function opAtOrBefore(rows, target) {
  let hit = null;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].period <= target) hit = rows[i]; else break;
  }
  return hit;
}

function opSummaryRows(q, win) {
  const t = opTerm(q.term);
  if (!t || !win.length) return [];
  const all = t.rows, last = win[win.length - 1];
  const i = all.indexOf(last);
  const keys = opOnSeries(q).map((s) => s.key);
  const back = (n) => ((i - n >= 0) ? all[i - n] : null);
  const find = (p) => all.filter((r) => r.period === p)[0] || null;
  const out = [];
  const push = (label, prev) => {
    const vals = {};
    keys.forEach((k) => {
      vals[k] = (!prev || last[k] == null || prev[k] == null)
        ? null : Math.round((last[k] - prev[k]) * 100) / 100;
    });
    out.push({ label: label, vals: vals, kind: 'delta' });
  };
  const p = String(last.period);
  if (q.term === 'd') {
    push('전일비', back(1));
    push('전주비', opAtOrBefore(all, opShift(p, 0, 0, -7)));
    push('전월동일비', opAtOrBefore(all, opShift(p, 0, -1, 0)));
    push('전년동일비', opAtOrBefore(all, opShift(p, -1, 0, 0)));
  } else if (q.term === 'm') {
    push('전월비', back(1));
    push('전년동월비', find((Number(p.slice(0, 4)) - 1) + '-' + p.slice(5, 7)));
  } else if (q.term === 'w') {
    push('전주비', back(1));
    push('전월동주비', back(4));
    push('전년동주비', find((Number(p.slice(0, 4)) - 1) + '-' + p.slice(5, 7) + '-W' + p.split('W')[1]));
  } else {
    push('전년비', back(1));
  }
  const avg = {};
  keys.forEach((k) => {
    const v = win.map((r) => r[k]).filter((x) => x != null);
    avg[k] = v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
  });
  out.push({ label: '평균', vals: avg, kind: 'avg' });
  return out;
}

function opNum(v) { return (v == null) ? '-' : Number(v).toFixed(2); }

/** 배럴당 USD → 원화 보조 표기. 환율이 없으면 null(→ 달러만 보인다).
    ★ 톤당 원료가와 자릿수가 달라 fmtKrwShort 를 쓰지 않는다.
      1만 원 이상은 '14.7만'(만 단위 소수 1자리), 그 미만은 '9,853'(원 단위 전체).
    ★ 환율·기준일은 이미 있는 krwRate/krwAsOf 를 그대로 쓴다(usd_krw 섹션 = ECB 기반
      Frankfurter, 키 불필요·매일 자동 수집). 여기서 새로 수집하지 않는다. */
function opKrw(usd) {
  const rate = krwRate('USD');
  if (rate == null || usd == null || !isFinite(Number(usd))) return null;
  const w = Number(usd) * rate, sign = w < 0 ? '-' : '', a = Math.abs(w);
  return (a >= 1e4) ? (sign + (a / 1e4).toFixed(1) + '만 원')
    : (sign + Math.round(a).toLocaleString('ko-KR') + '원');
}

/** 표 셀 안쪽 — 달러 값 아래 작은 글씨로 원화. 환율이 없으면 달러만 남는다. */
function opCell(v) {
  const k = opKrw(v);
  return '<span class="op-usd">' + opNum(v) + '</span>'
    + (k ? '<span class="op-krw">≈ ' + escapeHtml(k) + '</span>' : '');
}

/** 기준선택 · 기간(연-월-일) · 제품 · [조회] */
function opControlsHtml() {
  const f = _opForm;
  if (!f) return '';
  const sel = (name, val, opts) => '<select class="oc-sel" data-op="' + name + '">'
    + opts.map((o) => '<option value="' + escapeHtml(o[0]) + '"'
      + (String(o[0]) === String(val) ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>').join('')
    + '</select>';
  const yOpts = opYears(f.term).map((y) => [y, y + '년']);
  const two = (n) => String(n).padStart(2, '0');
  const mOpts = Array.from({ length: 12 }, (_, i) => [two(i + 1), two(i + 1) + '월']);
  const dOpts = Array.from({ length: 31 }, (_, i) => [two(i + 1), two(i + 1) + '일']);
  const showM = f.term !== 'y', showD = f.term === 'd';

  const terms = OC_TERMS.map((t) => '<label class="oc-radio">'
    + '<input type="radio" name="opTerm" value="' + t[0] + '"'
    + (f.term === t[0] ? ' checked' : '') + '>' + escapeHtml(t[1]) + '</label>').join('');
  const prods = ((_opData && _opData.series) || []).map((s) => '<label class="oc-check oc-check--origin">'
    + '<input type="checkbox" data-op-prod="' + escapeHtml(s.key) + '"'
    + (f.on.has(s.key) ? ' checked' : '') + '>'
    + '<span class="oc-swatch" style="background:' + (OP_COLORS[s.key] || 'var(--slate)') + '"></span>'
    + '<span class="oc-name">' + escapeHtml(s.label) + '</span>'
    + (OP_ORIGIN[s.key] ? '<span class="oc-note">(' + escapeHtml(OP_ORIGIN[s.key]) + ')</span>' : '')
    + '</label>').join('');

  return '<div class="oc-form">'
    + '<div class="oc-row"><span class="oc-lab">기준선택</span><div class="oc-ctl">' + terms + '</div></div>'
    + '<div class="oc-row"><span class="oc-lab">기간</span><div class="oc-ctl">'
    + sel('y0', f.y0, yOpts) + (showM ? sel('m0', f.m0, mOpts) : '') + (showD ? sel('d0', f.d0, dOpts) : '')
    + '<span class="oc-tilde">~</span>'
    + sel('y1', f.y1, yOpts) + (showM ? sel('m1', f.m1, mOpts) : '') + (showD ? sel('d1', f.d1, dOpts) : '')
    + '</div></div>'
    + '<div class="oc-row"><span class="oc-lab">제품</span><div class="oc-ctl oc-ctl--wrap">' + prods + '</div></div>'
    + '<div class="oc-row oc-row--go"><span class="oc-lab"></span>'
    + '<div class="oc-ctl"><button type="button" class="oc-go op-go">조회</button></div></div>'
    + '</div>';
}

function opSpanText(q, win) {
  if (!win.length) return '';
  return opLabel(win[0].period, q.term) + ' ~ ' + opLabel(win[win.length - 1].period, q.term);
}

function opTableHtml(q, win) {
  const ser = opOnSeries(q);
  if (!ser.length) return '<div class="chart-empty">제품을 하나 이상 선택하고 [조회]를 누르세요.</div>';
  if (!win.length) return '<div class="chart-empty">선택한 기간에 데이터가 없습니다.</div>';
  const ext = {};
  ser.forEach((s) => {
    const v = win.map((r) => r[s.key]).filter((x) => x != null);
    ext[s.key] = v.length ? { lo: Math.min.apply(null, v), hi: Math.max.apply(null, v) } : null;
  });
  const head = '<tr><th class="oc-th-p">' + escapeHtml(opTerm(q.term).label) + '</th>'
    + ser.map((s) => '<th><span class="oc-swatch" style="background:' + s.color + '"></span>'
      + escapeHtml(s.label) + '</th>').join('') + '</tr>';
  const body = win.map((r) => '<tr><td class="oc-td-p">' + escapeHtml(opLabel(r.period, q.term)) + '</td>'
    + ser.map((s) => {
      const v = r[s.key], e = ext[s.key];
      let cls = '';
      if (v != null && e && e.lo !== e.hi) cls = (v === e.lo) ? ' oc-min' : (v === e.hi ? ' oc-max' : '');
      return '<td class="oc-num' + cls + '">' + opCell(v) + '</td>';
    }).join('') + '</tr>').join('');
  const sums = opSummaryRows(q, win).map((s) => '<tr class="oc-sum oc-sum--' + s.kind + '">'
    + '<td class="oc-td-p">' + escapeHtml(s.label) + '</td>'
    + ser.map((x) => {
      const v = s.vals[x.key];
      const sign = (s.kind === 'delta' && v != null && v > 0) ? '+' : '';
      const cls = (s.kind !== 'delta' || v == null) ? '' : (v > 0 ? ' oc-up' : (v < 0 ? ' oc-down' : ''));
      if (v == null) return '<td class="oc-num' + cls + '">-</td>';
      // ★ 원화도 달러와 같은 sign 을 쓴다 — 평균 행에 '+' 가 붙지 않게.
      const kw = opKrw(v);
      return '<td class="oc-num' + cls + '"><span class="op-usd">' + sign + opNum(v) + '</span>'
        + (kw ? '<span class="op-krw">≈ ' + sign + escapeHtml(kw) + '</span>' : '')
        + '</td>';
    }).join('') + '</tr>').join('');
  return '<div class="oc-tablewrap"><table class="oc-table">'
    + '<thead>' + head + '</thead><tbody>' + body + sums + '</tbody></table></div>';
}

function opMatrix(q, win) {
  const ser = opOnSeries(q);
  const rows = [[opTerm(q.term).label].concat(ser.map((s) => s.label))];
  win.forEach((r) => rows.push([opLabel(r.period, q.term)].concat(ser.map((s) => opNum(r[s.key])))));
  opSummaryRows(q, win).forEach((s) => rows.push([s.label].concat(ser.map((x) => {
    const v = s.vals[x.key];
    return v == null ? '-' : ((s.kind === 'delta' && v > 0 ? '+' : '') + opNum(v));
  }))));
  return rows;
}

function opFileName(q, ext) {
  const a = q.y0 + (q.term === 'y' ? '' : q.m0) + (q.term === 'd' ? q.d0 : '');
  const b = q.y1 + (q.term === 'y' ? '' : q.m1) + (q.term === 'd' ? q.d1 : '');
  return '국제제품가_' + opTerm(q.term).label + '_' + a + '-' + b + '.' + ext;
}

function opExportCsv(q, win) {
  const csv = opMatrix(q, win)
    .map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  ocSave(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), opFileName(q, 'csv'));
}

function opExportXls(q, win) {
  const rows = opMatrix(q, win);
  const tbl = '<table border="1">' + rows.map((r, i) => '<tr>'
    + r.map((c) => (i ? '<td>' : '<th>') + escapeHtml(c) + (i ? '</td>' : '</th>')).join('')
    + '</tr>').join('') + '</table>';
  const html = '<html><head><meta charset="utf-8"></head><body>'
    + '<h3>국제유가 (PETRONET 일일국제제품가격) · ' + escapeHtml(opSpanText(q, win))
    + ' · 단위 ' + escapeHtml((_opData && _opData.unit) || '$/배럴') + '</h3>'
    + tbl + '</body></html>';
  ocSave(new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' }),
    opFileName(q, 'xls'));
}

function opPrint(q, win) {
  const rows = opMatrix(q, win);
  const tbl = '<table>' + rows.map((r, i) => '<tr>'
    + r.map((c) => (i ? '<td>' : '<th>') + escapeHtml(c) + (i ? '</td>' : '</th>')).join('')
    + '</tr>').join('') + '</table>';
  const w = window.open('', '_blank');
  if (!w) { window.alert('팝업이 차단되어 인쇄 창을 열지 못했습니다.'); return; }
  w.document.write('<html><head><meta charset="utf-8"><title>국제제품가 (PETRONET)</title>'
    + '<style>body{font-family:sans-serif;padding:20px}h3{margin:0 0 4px}'
    + 'p{margin:0 0 12px;color:#555;font-size:12px}table{border-collapse:collapse;font-size:12px}'
    + 'th,td{border:1px solid #999;padding:4px 8px;text-align:right}'
    + 'th:first-child,td:first-child{text-align:left}</style></head><body>'
    + '<h3>국제유가 (PETRONET 일일국제제품가격)</h3><p>' + escapeHtml(opSpanText(q, win))
    + ' · 단위 ' + escapeHtml((_opData && _opData.unit) || '$/배럴')
    + ' · 출처 한국석유공사 PETRONET</p>' + tbl + '</body></html>');
  w.document.close(); w.focus(); w.print();
}

/** 제품 선그래프 — 원유 차트와 같은 모양이지만 상태(_opChart)를 따로 둔다 */
function buildProductChart(rows, onSeries, term) {
  const n = rows.length;
  if (!n) { _opChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const series = (onSeries || []).map((s) => ({
    key: s.key, label: s.label, color: s.color || 'var(--slate)',
    values: rows.map((r) => (r[s.key] == null ? null : r[s.key])),
  }));
  const periods = rows.map((r) => opLabel(r.period, term));
  if (!series.length) { _opChart = null; return '<div class="chart-empty">제품을 하나 이상 선택하세요.</div>'; }
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { _opChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
  const yp = (ymax - ymin) * 0.1 || 5; ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 42, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">$${Math.round(val)}</text>${vizKrwTick(padL - 6, y, val, krwRate('USD'))}`;
  }).join('');
  const xticks = vizTickIdx(n, plotW).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(periods[i])}</text>`;
  }).join('');
  const lines = series.map((s) => {
    let d = '', started = false;
    s.values.forEach((v, i) => {
      if (v == null) return;
      d += `${started ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; started = true;
    });
    return d ? `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  _opChart = { periods, series, geom: { X, Y, n, W, padL } };
  const legend = '<div class="viz-legend">' + series.map((s) =>
    '<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:'
    + s.color + '"></span>' + escapeHtml(s.label) + '</span>').join('') + '</div>';
  return legend + `<svg class="viz-svg oilp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="국제제품가 추이">
      ${grid}${xticks}${lines}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="oilp-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="oilp-dots"></g>
      <rect class="oilp-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 제품 차트 크로스헤어 + 툴팁(원유 차트와 분리된 DOM·상태) */
function wireProductChart() {
  const fig = document.querySelector('#materialRoot .oilp-figure');
  const tip = document.getElementById('oilpTooltip');
  if (!fig || !tip || !_opChart) return;
  const svg = fig.querySelector('.oilp-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.oilp-overlay');
  const cross = svg.querySelector('.oilp-cross');
  const dots = svg.querySelector('.oilp-dots');
  const c = _opChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      const kw = opKrw(v);
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${escapeHtml(s.label)}</span><span class="viz-tt-val">$${v.toFixed(2)}${kw ? ` <span class="op-krw op-krw--tt">≈ ${escapeHtml(kw)}</span>` : ''}</span></div>`;
    });
    if (!rows) { clear(); return; }
    dots.innerHTML = dh;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.periods[i])}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/* ── 국제유가 리포트 분석 (원유 · 석유제품 공용) ───────────────────────────
   ★ AI/LLM 을 쓰지 않는다. 문장은 템플릿, 숫자는 전부 '조회된 구간'에서 계산한다.
     외부 호출이 없어 비용도 없다.
   ★★ 원인(OPEC 감산·중동 정세 등)은 이 데이터에 없다 — 한 줄도 지어내지 않는다.
     서술하는 것은 가격 자체의 움직임뿐이다: 등락률·순위·스프레드·최고/최저·평균.
   ★ 두 카드는 구조가 같아 엔진을 하나만 둔다. 카드별로 다른 것(데이터·계열·기간
     라벨·지표 정의)은 orCtx() 가 묶어서 넘긴다. 기존 oc·op 함수는 읽기만 한다. */
let _ocReport = false;     // 원유 카드 리포트 펼침
let _opReport = false;     // 제품 카드 리포트 펼침

const OR_DEF = {
  crude: '원유란 정제하기 전 상태의 기름으로, 여기 수치는 지역별 대표 유종의 '
    + '배럴당 국제 거래 가격입니다. 각 유종은 그 지역 시장의 기준 가격 역할을 합니다.',
  product: '석유제품이란 원유를 정제해 만든 휘발유·등유·경유·중유·나프타 등을 말하며, '
    + '여기 수치는 싱가포르 현물 시장의 배럴당 거래 가격입니다.',
};
const OR_NOUN = { crude: '유종', product: '제품' };

/** 카드별 맥락을 한 덩이로 묶는다. 조회 전이면 null. */
function orCtx(kind) {
  if (kind === 'crude') {
    if (!_ocData || _ocData.error || !_ocQuery) return null;
    return { kind: kind, unit: _ocData.unit, q: _ocQuery,
      win: ocWindow(_ocQuery), ser: ocOnSeries(_ocQuery),
      termLabel: (ocTerm(_ocQuery.term) || {}).label || '',
      label: (p) => ocLabel(p, _ocQuery.term), span: ocSpanText(_ocQuery, ocWindow(_ocQuery)) };
  }
  if (!_opData || _opData.error || !_opQuery) return null;
  return { kind: kind, unit: _opData.unit, q: _opQuery,
    win: opWindow(_opQuery), ser: opOnSeries(_opQuery),
    termLabel: (opTerm(_opQuery.term) || {}).label || '',
    label: (p) => opLabel(p, _opQuery.term), span: opSpanText(_opQuery, opWindow(_opQuery)) };
}

function orNum(v) { return (v == null) ? '—' : '$' + Number(v).toFixed(2); }
function orPct(v) { return (v == null) ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }

/** 계열별 지표. 값이 하나도 없는 계열은 n=0 으로 남겨 '데이터 없음'을 알린다. */
function orStats(c) {
  return c.ser.map((s) => {
    const pts = c.win.filter((r) => r[s.key] != null).map((r) => ({ p: r.period, v: r[s.key] }));
    const base = { key: s.key, label: s.label, color: s.color,
      n: pts.length, missing: c.win.length - pts.length };
    if (!pts.length) return base;
    const first = pts[0], last = pts[pts.length - 1];
    const vals = pts.map((x) => x.v);
    const mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
    return Object.assign(base, {
      first: first, last: last,
      chg: Math.round((last.v - first.v) * 100) / 100,
      pct: first.v ? Math.round(((last.v - first.v) / first.v) * 1000) / 10 : null,
      hi: pts.filter((x) => x.v === mx)[0], lo: pts.filter((x) => x.v === mn)[0],
      avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
    });
  });
}

/** 헤드라인으로 쓸 계열 — 원유는 국제 기준인 Brent 를 우선, 없으면 첫 체크 항목. */
function orHeadStat(c, st) {
  const live = st.filter((x) => x.n);
  if (!live.length) return null;
  if (c.kind === 'crude') {
    const b = live.filter((x) => x.key === 'brent')[0];
    if (b) return b;
  }
  return live[0];
}

/** 보조 문장들. 근거가 없는 문장은 만들지 않는다. */
function orSubs(c, st, head) {
  const out = [];
  const live = st.filter((x) => x.n && x.pct != null);
  const noun = OR_NOUN[c.kind];
  if (live.length >= 2) {
    const sorted = live.slice().sort((a, b) => b.pct - a.pct);
    const top = sorted[0], bot = sorted[sorted.length - 1];
    out.push('이번 기간 ' + top.label + '가 ' + orPct(top.pct) + ' '
      + (top.pct > 0 ? '올라' : (top.pct < 0 ? '내려' : '움직여')) + ' '
      + live.length + '개 ' + noun + ' 중 가장 많이 '
      + (top.pct > 0 ? '상승했습니다.' : (top.pct < 0 ? '하락했습니다.' : '보합이었습니다.')));
    if (bot.key !== top.key) {
      out.push('가장 적게 움직인 것은 ' + bot.label + '로 ' + orPct(bot.pct) + '입니다.');
    }
  } else if (live.length === 1) {
    out.push('이번 기간 ' + live[0].label + '는 ' + orPct(live[0].pct) + ' 움직였습니다.');
  }
  // Brent-WTI 스프레드 — 둘 다 체크됐을 때만
  if (c.kind === 'crude') {
    const b = st.filter((x) => x.key === 'brent' && x.n)[0];
    const w = st.filter((x) => x.key === 'wti' && x.n)[0];
    if (b && w) {
      const now = Math.round((b.last.v - w.last.v) * 100) / 100;
      const was = Math.round((b.first.v - w.first.v) * 100) / 100;
      const wide = Math.abs(now) - Math.abs(was);
      out.push('Brent 가 WTI 보다 배럴당 ' + orNum(Math.abs(now)) + ' '
        + (now >= 0 ? '높은' : '낮은') + ' 상태이며, 이 격차는 조회 기간 시작('
        + orNum(Math.abs(was)) + ') 대비 '
        + (Math.abs(wide) < 0.005 ? '거의 같습니다.'
          : (wide > 0 ? '확대되었습니다.' : '축소되었습니다.')));
    }
  }
  // 결측 안내 — 지어내지 않고 '없다'고 밝힌다.
  // ★ 한 항목에 두 문장이 겹치지 않게, 값이 통째로 없는 것(dead)은 gaps 에서 뺀다.
  // ★ 조사(는/은)를 피해 쓴다 — 'Oman는' 처럼 어긋나지 않게 항목을 뒤로 뺀 형태로 적는다.
  const dead = st.filter((x) => !x.n);
  const gaps = st.filter((x) => x.n && x.missing > 0);
  if (gaps.length) {
    out.push('조회 기간 중 값이 비는 구간이 있습니다 — '
      + gaps.map((g) => g.label + ' ' + g.missing + '개').join(', ') + '.');
  }
  if (dead.length) {
    out.push('이 기간에 공표된 값이 없는 항목: ' + dead.map((d) => d.label).join(', ') + '.');
  }
  return out;
}

/** 총 내용 정리 — 이미 나온 값만 2~3문장으로 압축한다. */
function orSummary(c, st, head) {
  const out = [];
  const noun = OR_NOUN[c.kind];
  if (head) {
    out.push(c.span + ' 기준 ' + head.label + '는 ' + orNum(head.last.v)
      + '로 조회 기간 시작(' + orNum(head.first.v) + ') 대비 ' + orPct(head.pct)
      + ' ' + (head.pct > 0 ? '상승' : (head.pct < 0 ? '하락' : '보합'))
      + '했고, 기간 평균은 ' + orNum(head.avg) + '입니다.');
  }
  const live = st.filter((x) => x.n && x.pct != null);
  if (live.length >= 2) {
    const sorted = live.slice().sort((a, b) => b.pct - a.pct);
    out.push('체크한 ' + live.length + '개 ' + noun + ' 가운데 ' + sorted[0].label + '가 '
      + orPct(sorted[0].pct) + '로 가장 크게 올랐고, ' + sorted[sorted.length - 1].label
      + '가 ' + orPct(sorted[sorted.length - 1].pct) + '로 가장 낮았습니다.');
  }
  if (head) {
    out.push('기간 중 최고가는 ' + c.label(head.hi.p) + ' ' + orNum(head.hi.v)
      + ', 최저가는 ' + c.label(head.lo.p) + ' ' + orNum(head.lo.v) + '입니다 ('
      + head.label + ' 기준).');
  }
  return out;
}

/** 계열별 지표 표 — 카드 본문 표와 같은 클래스라 모양이 이어진다. */
function orTable(c, st) {
  const row = (x) => {
    if (!x.n) {
      return '<tr><td class="oc-td-p"><span class="oc-swatch" style="background:' + x.color
        + '"></span>' + escapeHtml(x.label) + '</td>'
        + '<td class="oc-num" colspan="5">이 기간 공표 값 없음</td></tr>';
    }
    const cls = x.pct == null ? '' : (x.pct > 0 ? ' oc-up' : (x.pct < 0 ? ' oc-down' : ''));
    return '<tr><td class="oc-td-p"><span class="oc-swatch" style="background:' + x.color
      + '"></span>' + escapeHtml(x.label) + '</td>'
      + '<td class="oc-num">' + orNum(x.last.v) + '</td>'
      + '<td class="oc-num' + cls + '">' + orPct(x.pct) + '</td>'
      + '<td class="oc-num"><span class="or-hi">' + orNum(x.hi.v) + '</span>'
      + '<span class="or-when">' + escapeHtml(c.label(x.hi.p)) + '</span></td>'
      + '<td class="oc-num"><span class="or-lo">' + orNum(x.lo.v) + '</span>'
      + '<span class="or-when">' + escapeHtml(c.label(x.lo.p)) + '</span></td>'
      + '<td class="oc-num">' + orNum(x.avg) + '</td></tr>';
  };
  return '<div class="oc-tablewrap"><table class="oc-table or-tbl"><thead><tr>'
    + '<th class="oc-th-p">' + escapeHtml(OR_NOUN[c.kind]) + '</th>'
    + '<th>최근값</th><th>기간 등락</th><th>최고</th><th>최저</th><th>평균</th>'
    + '</tr></thead><tbody>' + st.map(row).join('') + '</tbody></table></div>';
}

/* 리포트 강조 색 — 표와 그래프가 같은 규칙을 쓴다(정시성 리포트와 동일). */
const OR_HI = 'var(--blue)';
const OR_LO = 'var(--accent)';
const OR_NOW = 'var(--ink)';

/** X축용 짧은 라벨 — '2026년 08월 03일'(11자)을 그대로 쓰면 축에서 겹친다.
    ★ 표시 전용이다. 표·문장은 계속 긴 라벨(c.label)을 쓴다. */
function orShortLabel(period, term) {
  const p = String(period);
  if (term === 'y') return p.slice(0, 4);
  if (term === 'm') return p.slice(2, 4) + '.' + p.slice(5, 7);
  if (term === 'w') return p.slice(2, 4) + '.' + p.slice(5, 7) + ' ' + p.split('W')[1] + '주';
  return p.slice(2, 4) + '.' + p.slice(5, 7) + '.' + p.slice(8, 10);
}

/** 균등 간격으로 최대 max 개만 고른다(양 끝은 항상 포함). */
function orTickIdx(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (let k = 0; k < max; k += 1) out.push(Math.round((k * (n - 1)) / (max - 1)));
  return out.filter((v, i, a) => a.indexOf(v) === i);
}

/** 리포트 전용 그래프. 라벨은 대표 계열의 최고·최저·최근 3곳에만 단다.
    ★ 카드 본문의 buildOilChart / buildProductChart 는 건드리지 않는다. */
function orChart(c, st, head) {
  const n = c.win.length;
  const live = st.filter((x) => x.n);
  if (n < 2 || !live.length) return '<div class="chart-empty">추이를 그릴 값이 부족합니다.</div>';
  const all = [];
  live.forEach((x) => c.win.forEach((r) => { if (r[x.key] != null) all.push(r[x.key]); }));
  let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
  const yp = (ymax - ymin) * 0.18 || 5;
  ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = VIZ_W, H = 176, padL = 44, padR = 16, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => padL + (i / (n - 1)) * plotW;
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">$${Math.round(val)}</text>`
      + vizKrwTick(padL - 6, y, val, krwRate('USD'));   // 달러 아래 작은 원화(다른 카드와 같은 헬퍼)
  }).join('');
  // ★ 라벨은 짧은 형태로, 개수는 최대 6개만. 좁은 화면에서는 CSS 가 홀수 번째를 숨겨 3개로 준다.
  const ticks = orTickIdx(n, 6);
  const xlab = ticks.map((i, k) =>
    `<text class="or-xlab${k % 2 ? ' or-xlab--alt' : ''}" x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(orShortLabel(c.win[i].period, c.q.term))}</text>`).join('');

  // 대표 계열은 진하게, 나머지는 옅게 — 라벨이 붙는 선이 어느 것인지 드러난다
  const lines = live.map((x) => {
    let d = '', pen = false;
    c.win.forEach((r, i) => {
      const v = r[x.key];
      if (v == null) return;
      d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true;
    });
    const me = head && x.key === head.key;
    return d ? `<path d="${d.trim()}" fill="none" stroke="${x.color}" stroke-width="${me ? 2.4 : 1.4}"`
      + ` opacity="${me ? 1 : 0.42}" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  let marks = '';
  if (head) {
    const idxOf = (p) => c.win.map((r) => r.period).indexOf(p);
    const put = (i, v, color, tag) => {
      if (i < 0) return '';
      const kw = opKrw(v);   // 배럴당 원화 — 제품 카드가 쓰는 것과 같은 함수(환율은 usd_krw)
      const x = X(i), y = Y(v), up = y > padT + 26;
      const ly = up ? y - 13 : y + 20;
      return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${color}" stroke="var(--surface-1)" stroke-width="1.6"/>`
        + `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="800"`
        + ` paint-order="stroke" stroke="var(--surface-1)" stroke-width="3" fill="${color}">$${v.toFixed(2)}</text>`
        + `<text x="${x.toFixed(1)}" y="${(up ? ly - 9 : ly + 9).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700"`
        + ` paint-order="stroke" stroke="var(--surface-1)" stroke-width="3" fill="${color}" opacity=".85">`
        + `${tag}${kw ? ' · 약 ' + escapeHtml(kw) : ''}</text></g>`;
    };
    const hiI = idxOf(head.hi.p), loI = idxOf(head.lo.p), nowI = idxOf(head.last.p);
    marks += put(hiI, head.hi.v, OR_HI, '최고');
    marks += put(loI, head.lo.v, OR_LO, '최저');
    if (nowI !== hiI && nowI !== loI) marks += put(nowI, head.last.v, OR_NOW, '최근');
  }

  const legend = '<div class="srr-legend">'
    + live.map((x) => '<span class="srr-lg"><i style="background:' + x.color + '"></i>'
      + escapeHtml(x.label) + (head && x.key === head.key ? ' (라벨 기준)' : '') + '</span>').join('')
    + '</div>';

  return legend
    + `<svg class="srr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ` aria-label="가격 추이 · 최고 최저 최근 강조">`
    + grid + xlab + lines + marks
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>`
    + `</svg>`;
}

/** 리포트 본문(두 카드 공용). 버튼을 누르기 전에는 호출되지 않는다. */
function orReportHtml(kind) {
  const c = orCtx(kind);
  if (!c) return '';
  if (!c.ser.length || !c.win.length) {
    return '<div class="srr"><div class="chart-empty">리포트를 만들 조회 결과가 없습니다.</div></div>';
  }
  const st = orStats(c);
  const head = orHeadStat(c, st);
  if (!head) {
    return '<div class="srr"><div class="chart-empty">선택한 기간에 공표된 값이 없습니다.</div></div>';
  }
  const dir = head.pct == null ? 'flat' : (head.pct > 0 ? 'up' : (head.pct < 0 ? 'down' : 'flat'));
  const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '—');

  const hero = '<div class="srr-hero">'
    + '<div class="srr-hero__when">' + escapeHtml(c.label(head.last.p)) + ' · '
    + escapeHtml(head.label) + '</div>'
    + '<div class="srr-hero__row">'
    + '<span class="srr-hero__v">' + orNum(head.last.v) + '</span>'
    + '<span class="srr-hero__d srr-' + dir + '">' + arrow + ' '
    + escapeHtml(orPct(head.pct == null ? null : Math.abs(head.pct)).replace('+', ''))
    + '<span class="srr-hero__vs">조회 기간 시작 대비</span></span>'
    + '</div></div>';

  const subs = orSubs(c, st, head).map((t) =>
    '<p class="srr-p">' + escapeHtml(t) + '</p>').join('');

  return '<div class="srr">'
    + '<div class="srr-head">리포트 분석 <span class="srr-scope">' + escapeHtml(c.span)
    + ' · ' + escapeHtml(c.termLabel + ' 기준 ' + c.win.length + '개 구간')
    + ' · ' + escapeHtml(c.unit) + '</span></div>'
    + '<p class="srr-cond"><b>현재 조회 조건</b> · ' + escapeHtml(c.termLabel) + ' 기준 · '
    + escapeHtml(c.span) + ' · ' + escapeHtml(c.ser.map((x) => x.label).join(', ')) + '</p>'
    + '<p class="srr-def">' + escapeHtml(OR_DEF[kind]) + '</p>'
    + hero + subs
    + '<h4 class="srr-h">' + escapeHtml(OR_NOUN[kind]) + '별 지표</h4>'
    + orTable(c, st)
    + '<div class="srr-chart">' + orChart(c, st, head) + krwNote('USD') + '</div>'
    + '<div class="srr-sum"><div class="srr-sum__h">총 내용 정리</div>'
    + orSummary(c, st, head).map((t) => '<p class="srr-sum__p">' + escapeHtml(t) + '</p>').join('')
    + '</div></div>';
}

function renderOilProductHtml() {
  const unit = (_opData && !_opData.error && _opData.unit) || '$/배럴';
  const head = `<div class="viz-head"><div>
      <div class="viz-title">국제유가 · 석유제품 (PETRONET)</div>
      <div class="viz-sub">일일국제제품가격 · 휘발유·등유·경유·중유·나프타 (${escapeHtml(unit)})</div>
    </div></div>`;
  const cap = capSrc('출처: 한국석유공사 PETRONET · 일일국제제품가격', SRC_LINKS.oilProduct);
  if (!_opData) {
    return `<div class="viz-root viz-figure oilp-figure">${head}`
      + '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>' + `${cap}</div>`;
  }
  if (_opData.error) {
    return `<div class="viz-root viz-figure oilp-figure">${head}`
      + '<div class="chart-empty">데이터를 불러오지 못했습니다 (PETRONET 접근 차단 가능)</div>'
      + `${cap}</div>`;
  }
  const controls = '<div class="oc-formwrap op-formwrap">' + opControlsHtml() + '</div>';
  let body;
  if (!_opQuery) {
    body = '<div class="icis-prompt">기준·기간·제품을 고르고 [조회]를 누르세요</div>';
  } else {
    const q = _opQuery, win = opWindow(q);
    const tools = '<div class="oc-result__head">'
      + '<div class="oc-span">' + escapeHtml(opSpanText(q, win))
      + ' <span class="oc-unit">(단위: ' + escapeHtml(unit) + ')</span></div>'
      + '<div class="oc-tools">'
      + '<button type="button" class="oc-tool' + (_opView === 'table' ? ' is-on' : '') + '" data-op-view="table">표보기</button>'
      + '<button type="button" class="oc-tool' + (_opView === 'chart' ? ' is-on' : '') + '" data-op-view="chart">차트보기</button>'
      + '<button type="button" class="oc-tool" data-op-exp="csv">csv 저장</button>'
      + '<button type="button" class="oc-tool" data-op-exp="xls">엑셀저장</button>'
      + '<button type="button" class="oc-tool" data-op-exp="print">인쇄하기</button>'
      + '<button type="button" class="oc-tool or-btn' + (_opReport ? ' is-on' : '')
      + '" data-op-report="1" aria-expanded="' + (_opReport ? 'true' : 'false')
      + '">📊 리포트 분석</button>'
      + '</div></div>';
    const result = (_opView === 'chart')
      ? buildProductChart(win, opOnSeries(q), q.term) + '<div class="viz-tooltip" id="oilpTooltip"></div>'
      : opTableHtml(q, win);
    body = tools + result + (_opReport ? orReportHtml('product') : '');
  }
  const note = (_opData.note ? '<div class="g-note">' + escapeHtml(_opData.note) + '</div>' : '');
  // 적용 환율·기준일 — 이미 있는 krwNote()(usd_krw 섹션 기반)를 그대로 쓴다
  const fxnote = _opQuery ? krwNote('USD') : '';
  return `<div class="viz-root viz-figure oilp-figure">${head}${controls}${body}${fxnote}${note}${cap}</div>`;
}

/** 제품 카드 조회 조건 배선 — 원유 카드와 같은 동작, 선택자만 다르다 */
function wireProductControls(root) {
  const fig = root.querySelector('.oilp-figure');
  if (!fig || !_opData || _opData.error) return;
  const form = fig.querySelector('.op-formwrap');
  if (form) {
    form.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || !_opForm) return;
      // ★ 원유 카드와 같은 이유로, 조건이 바뀌면 열려 있던 리포트를 닫는다.
      const wasOpen = _opReport;
      if (t.name === 'opTerm') {
        _opForm = opFormFor(t.value, new Set(_opForm.on));
        if (wasOpen) { _opReport = false; renderMaterial(); return; }
        form.innerHTML = opControlsHtml();
        return;
      }
      const k = t.getAttribute && t.getAttribute('data-op');
      if (k) {
        _opForm[k] = t.value;
      } else {
        const p = t.getAttribute && t.getAttribute('data-op-prod');
        if (!p) return;
        if (t.checked) _opForm.on.add(p); else _opForm.on.delete(p);
      }
      if (wasOpen) { _opReport = false; renderMaterial(); }
    });
    form.addEventListener('click', (e) => {
      const go = e.target.closest && e.target.closest('.op-go');
      if (!go || !_opForm) return;
      _opQuery = { term: _opForm.term, y0: _opForm.y0, m0: _opForm.m0, d0: _opForm.d0,
        y1: _opForm.y1, m1: _opForm.m1, d1: _opForm.d1, on: new Set(_opForm.on) };
      renderMaterial();
    });
  }
  fig.addEventListener('click', (e) => {
    const rb = e.target.closest && e.target.closest('[data-op-report]');
    if (rb) { _opReport = !_opReport; renderMaterial(); return; }
    const v = e.target.closest && e.target.closest('[data-op-view]');
    if (v) { _opView = v.getAttribute('data-op-view'); renderMaterial(); return; }
    const x = e.target.closest && e.target.closest('[data-op-exp]');
    if (!x || !_opQuery) return;
    const win = opWindow(_opQuery);
    const kind = x.getAttribute('data-op-exp');
    if (kind === 'csv') opExportCsv(_opQuery, win);
    else if (kind === 'xls') opExportXls(_opQuery, win);
    else opPrint(_opQuery, win);
  });
  if (_opQuery && _opView === 'chart') wireProductChart();
}

/* ── 해상 정시성 (Sea-Intelligence Global Schedule Reliability) ── */

/** 선택 연도에 맞춰 표시할 연도(선) 목록 구성 */
/* ── 해상 정시성 · 리포트 분석 ─────────────────────────────────────────────
   ★ AI/LLM 을 쓰지 않는다. 문장은 템플릿이고 숫자는 전부 받아둔 관측치에서 계산한다.
     외부 호출이 없으므로 비용도 없다.
   ★★ 없는 것을 지어내지 않는다. Sea-Intelligence 가 주는 것은 '월별 전세계 정시성
     한 줄'뿐이다 — payload 실측 결과 years={연도: 월 12개 값} 이 전부이고
     지역·항로·선사 구분이 아예 없다. 그래서 '지역/항로별 동향' 절은 만들지 않고,
     왜 없는지만 밝힌다.
   ★★ 원인(춘절·홍해 등)은 이 데이터에 없다. 추정해서 채우지 않고 '준비 중'으로 둔다.
     서술하는 것은 오직 숫자 자체의 변화뿐이다 — 증감 · 최고/최저 · 평균 · 연속 추세. */
let _srReport = false;      // 리포트 펼침 상태

const SR_FLAT_BAND = 1.0;   // 6개월 변화가 이 %p 미만이면 '보합'으로 본다
const SR_STREAK_MIN = 2;    // 연속 개월이 이 수 이상일 때만 '연속' 문장을 낸다
// ★ 3 으로 뒀더니 실데이터(2021~2026)에서 한 번도 뜨지 않았다 — 이 지표는 등락이
//   잦아 최대 연속이 2개월이다. '연속이 아니면 생략'이 원칙이므로 2 로 둔다.

function srR1(v) { return Math.round(v * 10) / 10; }
function srPct(v) { return (v == null) ? '—' : srR1(v).toFixed(1) + '%'; }
function srPp(v) { return (v == null) ? '—' : (v > 0 ? '+' : '') + srR1(v).toFixed(1) + '%p'; }
function srYmLabel(ym) { return ym.slice(0, 4) + '년 ' + ym.slice(5, 7) + '월'; }

/** 연도 목록의 관측치를 시간순으로 편다. [{ym:'2026-06', v:62.6}] (결측은 뺀다) */
function srFlatten(years) {
  const out = [];
  (years || []).forEach((y) => {
    const arr = (_srData.years || {})[y] || [];
    arr.forEach((v, i) => {
      if (v != null) out.push({ ym: y + '-' + String(i + 1).padStart(2, '0'), v: Number(v) });
    });
  });
  return out.sort((a, b) => (a.ym < b.ym ? -1 : 1));
}

/** 마지막 지점에서 거슬러 올라간 '같은 방향 연속' 개월 수. 없으면 null */
function srStreak(pts) {
  const mv = [];
  for (let i = 1; i < pts.length; i += 1) mv.push(srR1(pts[i].v - pts[i - 1].v));
  if (!mv.length) return null;
  const last = mv[mv.length - 1];
  if (last === 0) return null;
  const up = last > 0;
  let n = 0;
  for (let i = mv.length - 1; i >= 0; i -= 1) {
    if (mv[i] === 0 || (mv[i] > 0) !== up) break;
    n += 1;
  }
  return { up: up, n: n };
}

/** 리포트에 쓸 수치 묶음. 관측치가 없으면 null */
function srReportData(year) {
  if (!_srData || _srData.error || !_srData.years) return null;
  const all = Object.keys(_srData.years).sort();
  const pick = (year === 'all') ? all : all.filter((y) => y === year);
  const pts = srFlatten(pick);
  if (!pts.length) return null;
  const whole = srFlatten(all);          // 전월·전년동월은 조회 창 밖도 봐야 한다
  const last = pts[pts.length - 1];
  const wi = whole.map((p) => p.ym).indexOf(last.ym);
  const prev = wi > 0 ? whole[wi - 1] : null;
  const yoyYm = (Number(last.ym.slice(0, 4)) - 1) + '-' + last.ym.slice(5, 7);
  const yoy = whole.filter((p) => p.ym === yoyYm)[0] || null;
  const vals = pts.map((p) => p.v);
  const hi = pts.filter((p) => p.v === Math.max.apply(null, vals))[0];
  const lo = pts.filter((p) => p.v === Math.min.apply(null, vals))[0];
  const win = pts.slice(-6);
  const wDiff = win.length >= 2 ? srR1(win[win.length - 1].v - win[0].v) : null;
  return {
    pts: pts, last: last, prev: prev, yoy: yoy,
    mom: prev ? srR1(last.v - prev.v) : null,
    yoyDiff: yoy ? srR1(last.v - yoy.v) : null,
    hi: hi, lo: lo,
    avg: srR1(vals.reduce((a, b) => a + b, 0) / vals.length),
    streak: srStreak(pts),
    win: win, wDiff: wDiff,
    wWord: (wDiff == null) ? null
      : (Math.abs(wDiff) < SR_FLAT_BAND ? '보합' : (wDiff > 0 ? '상승' : '하락')),
  };
}

/** 헤드라인용 — 최신값과 전월 대비. 숫자는 srReportData 가 계산한 것을 그대로 쓴다. */
function srHeadline(d) {
  const dir = (d.mom == null) ? 'flat' : (d.mom > 0 ? 'up' : (d.mom < 0 ? 'down' : 'flat'));
  const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '—');
  return {
    ym: d.last.ym, value: srPct(d.last.v), dir: dir, arrow: arrow,
    delta: (d.mom == null) ? null : srR1(Math.abs(d.mom)).toFixed(1) + '%p',
  };
}

/** 헤드라인 아래 보조 문장들. 근거가 없는 문장은 넣지 않는다(기존 규칙 그대로). */
function srReportSubs(d) {
  const out = [];
  if (d.yoyDiff != null) {
    const gap = srR1(Math.abs(d.yoyDiff)).toFixed(1);
    out.push('1년 전 같은 달(' + srYmLabel(d.yoy.ym) + ' ' + srPct(d.yoy.v) + ')보다 '
      + (d.yoyDiff === 0 ? '변화가 없습니다.' : gap + '%p ' + (d.yoyDiff > 0 ? '높습니다.' : '낮습니다.')));
  }
  if (d.streak && d.streak.n >= SR_STREAK_MIN) {
    out.push(d.streak.n + '개월 연속 ' + (d.streak.up ? '오름세' : '내림세') + '입니다.');
  }
  if (d.wWord) {
    const a = srPct(d.win[0].v), b = srPct(d.last.v), gap = srPp(d.wDiff);
    if (d.wWord === '보합') {
      out.push('최근 ' + d.win.length + '개월은 큰 변화 없이 ' + Math.floor(d.last.v)
        + '%대를 유지하고 있습니다 (' + a + ' → ' + b + ', ' + gap + ').');
    } else {
      out.push('최근 ' + d.win.length + '개월 동안 ' + a + '에서 ' + b + '로 '
        + gap + ' ' + (d.wWord === '상승' ? '올랐습니다' : '내렸습니다') + '.');
    }
  }
  return out;
}

/** 가장 낙폭이 큰 '연속 하락 구간'. [시작 index, 끝 index] · 없으면 null.
    ★ 표시 전용이다 — srReportData 의 수치 계산에는 관여하지 않는다. */
function srDropRun(pts) {
  let best = null, i = 0;
  while (i < pts.length - 1) {
    if (pts[i + 1].v >= pts[i].v) { i += 1; continue; }
    let j = i;
    while (j < pts.length - 1 && pts[j + 1].v < pts[j].v) j += 1;
    const drop = pts[i].v - pts[j].v;
    if (!best || drop > best.drop) best = { from: i, to: j, drop: drop };
    i = j;
  }
  return best;
}

/* 리포트 강조 색 — 참고 지표 카드와 그래프가 같은 규칙을 쓴다.
   ★ 최고=파랑 · 최저=빨강. 이 카드의 지표는 '높을수록 좋은' 정시성이라
     주가 카드(오르면 빨강)와 반대다 — 리포트 안에서만 이 규칙을 쓴다. */
const SRR_HI = 'var(--blue)';
const SRR_LO = 'var(--accent)';
const SRR_NOW = 'var(--ink)';

/** 리포트 전용 그래프 — 의미 있는 지점(최고·최저·최신·최대 낙폭)만 라벨을 단다.
    ★ 카드 본문의 buildSrChart 는 건드리지 않는다. 전역 _srChart 도 쓰지 않아
      본문 차트의 툴팁 동작에 영향이 없다. */
function srReportChart(pts, hiYm, loYm) {
  const n = pts.length;
  if (n < 2) return '<div class="chart-empty">추이를 그릴 관측치가 부족합니다.</div>';
  const vals = pts.map((p) => p.v);
  let ymin = Math.min.apply(null, vals), ymax = Math.max.apply(null, vals);
  const yp = (ymax - ymin) * 0.18 || 5;
  ymin = Math.max(0, ymin - yp); ymax = Math.min(100, ymax + yp);

  const W = VIZ_W, H = 176, padL = 40, padR = 16, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => padL + (i / (n - 1)) * plotW;
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val)}%</text>`;
  }).join('');

  const xlab = vizTickIdx(n, plotW, 46).map((i) =>
    `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(pts[i].ym.slice(2).replace('-', '.'))}</text>`).join('');

  // 최대 낙폭 구간 — 음영 + 그 구간만 색을 달리한 선
  const run = srDropRun(pts);
  let band = '', dropLine = '';
  if (run && run.to > run.from) {
    const x0 = X(run.from), x1 = X(run.to);
    band = `<rect x="${x0.toFixed(1)}" y="${padT}" width="${(x1 - x0).toFixed(1)}" height="${plotH}"`
      + ` fill="${SRR_LO}" opacity=".07"/>`;
    let dp = '';
    for (let i = run.from; i <= run.to; i += 1) {
      dp += `${i === run.from ? 'M' : 'L'}${X(i).toFixed(1)} ${Y(pts[i].v).toFixed(1)} `;
    }
    dropLine = `<path d="${dp.trim()}" fill="none" stroke="${SRR_LO}" stroke-width="3"`
      + ` stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`;
  }

  let path = '';
  pts.forEach((p, i) => { path += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)} `; });
  const line = `<path d="${path.trim()}" fill="none" stroke="var(--slate)" stroke-width="2"`
    + ` stroke-linejoin="round" stroke-linecap="round" opacity=".55"/>`;

  // 평범한 지점은 점만 남기고 숫자는 생략한다
  const plain = pts.map((p, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="2" fill="var(--slate)" opacity=".5"/>`).join('');

  // 강조 지점 — 최고 / 최저 / 최신. 겹치면 최고·최저를 우선한다.
  const marks = [];
  const add = (i, color, tag, cls) => {
    const x = X(i), y = Y(pts[i].v);
    const up = y > padT + 26;                       // 위쪽 공간이 없으면 라벨을 아래로
    const ly = up ? y - 13 : y + 20;
    marks.push(`<g class="srr-mark ${cls}">`
      + `<circle class="srr-ring" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="none" stroke="${color}" stroke-width="2" opacity="0"/>`
      + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${color}" stroke="var(--surface-1)" stroke-width="1.6"/>`
      + `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="800"`
      + ` paint-order="stroke" stroke="var(--surface-1)" stroke-width="3" fill="${color}">${pts[i].v.toFixed(1)}%</text>`
      + `<text x="${x.toFixed(1)}" y="${(up ? ly - 9 : ly + 9).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700"`
      + ` paint-order="stroke" stroke="var(--surface-1)" stroke-width="3" fill="${color}" opacity=".85">${escapeHtml(tag)}</text>`
      + `</g>`);
  };
  const hiI = pts.map((p) => p.ym).indexOf(hiYm);
  const loI = pts.map((p) => p.ym).indexOf(loYm);
  const nowI = n - 1;
  if (hiI >= 0) add(hiI, SRR_HI, '최고', 'srr-mark--hi');
  if (loI >= 0) add(loI, SRR_LO, '최저', 'srr-mark--lo');
  if (nowI !== hiI && nowI !== loI) add(nowI, SRR_NOW, '최근', 'srr-mark--now');

  const legend = '<div class="srr-legend">'
    + '<span class="srr-lg"><i style="background:' + SRR_HI + '"></i>최고</span>'
    + '<span class="srr-lg"><i style="background:' + SRR_LO + '"></i>최저</span>'
    + '<span class="srr-lg"><i style="background:' + SRR_NOW + '"></i>최근</span>'
    + (run && run.to > run.from
      ? '<span class="srr-lg srr-lg--band"><i></i>최대 낙폭 구간 (−'
        + srR1(run.drop).toFixed(1) + '%p)</span>' : '')
    + '</div>';

  return legend
    + `<svg class="srr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ` aria-label="정시성 추이 · 최고 최저 최근 지점 강조">`
    + band + grid + xlab + line + dropLine + plain + marks.join('')
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>`
    + `</svg>`;
}

/** '총 내용 정리' 문장 — 리포트에 이미 나온 값만 압축한다.
    ★ 새 숫자도, 원인 추정도 만들지 않는다. 근거가 없는 조각은 문장에서 빠진다
      (전월 비교가 없으면 그 절을, 전년 자료가 없으면 그 절을 통째로 뺀다). */
function srSummaryText(d) {
  const out = [];
  const head = srYmLabel(d.last.ym) + ' 해상 정시성은 ' + srPct(d.last.v);
  const mom = (d.mom == null) ? null
    : '전월 대비 ' + srR1(Math.abs(d.mom)).toFixed(1) + '%p '
      + (d.mom > 0 ? '상승' : (d.mom < 0 ? '하락' : '보합'));
  const yoy = (d.yoyDiff == null) ? null
    : (d.yoyDiff === 0 ? '1년 전과 같은'
      : '1년 전보다 ' + srR1(Math.abs(d.yoyDiff)).toFixed(1) + '%p '
        + (d.yoyDiff > 0 ? '높은' : '낮은'));
  if (mom && yoy) out.push(head + '로 ' + mom + '했고, ' + yoy + ' 수준입니다.');
  else if (mom) out.push(head + '로 ' + mom + '했습니다.');
  else if (yoy) out.push(head + '로, ' + yoy + ' 수준입니다.');
  else out.push(head + '입니다.');

  if (d.streak && d.streak.n >= SR_STREAK_MIN) {
    out.push(d.streak.n + '개월 연속 ' + (d.streak.up ? '오름세' : '내림세') + '입니다.');
  }
  if (d.wWord) {
    out.push('최근 ' + d.win.length + '개월간은 ' + d.wWord + '세를 보이고 있습니다.');
  }
  return out;
}

/** 리포트 본문. 버튼을 누르기 전에는 호출되지 않는다. */
function srReportHtml() {
  const d = srReportData(_srYear);
  if (!d) return '<div class="srr"><div class="chart-empty">리포트를 만들 관측치가 없습니다.</div></div>';
  const scope = (_srYear === 'all') ? '전체 기간' : (_srYear + '년');
  const h = srHeadline(d);

  const head = '<div class="srr-hero">'
    + '<div class="srr-hero__when">' + escapeHtml(srYmLabel(h.ym)) + ' 해상 정시성</div>'
    + '<div class="srr-hero__row">'
    + '<span class="srr-hero__v">' + escapeHtml(h.value) + '</span>'
    + (h.delta
      ? '<span class="srr-hero__d srr-' + h.dir + '">' + h.arrow + ' ' + escapeHtml(h.delta)
        + '<span class="srr-hero__vs">전월 대비</span></span>'
      : '<span class="srr-hero__d srr-flat">전월 비교 자료 없음</span>')
    + '</div></div>';

  const subs = srReportSubs(d).map((t) =>
    '<p class="srr-p">' + escapeHtml(t) + '</p>').join('');

  const cell = (k, v, sub, cls) => '<div class="gs-cell srr-stat ' + cls + '">'
    + '<span class="gs-k">' + escapeHtml(k) + '</span>'
    + '<span class="gs-v">' + escapeHtml(v) + '</span>'
    + '<span class="srr-sub">' + escapeHtml(sub) + '</span></div>';
  const stats = '<div class="gs srr-stats">'
    + cell('조회 기간 최고', srPct(d.hi.v), srYmLabel(d.hi.ym), 'srr-stat--hi')
    + cell('조회 기간 최저', srPct(d.lo.v), srYmLabel(d.lo.ym), 'srr-stat--lo')
    + cell('조회 기간 평균', srPct(d.avg), d.pts.length + '개월 기준', 'srr-stat--avg')
    + '</div>';

  return '<div class="srr">'
    + '<div class="srr-head">리포트 분석 <span class="srr-scope">' + escapeHtml(scope)
    + ' · ' + escapeHtml(d.pts.length + '개월 관측') + '</span></div>'
    + '<p class="srr-def">해상 정시성이란 선사가 사전에 공표한 도착 예정일에 '
    + '실제로 도착한 선박의 비율(%)을 뜻합니다.</p>'
    + head + subs
    + '<h4 class="srr-h">참고 지표 <span class="srr-hint">최고·최저에 마우스를 올리면 그래프에서 해당 지점이 표시됩니다</span></h4>'
    + stats
    + '<div class="srr-chart">' + srReportChart(d.pts, d.hi.ym, d.lo.ym) + '</div>'
    + '<div class="srr-sum"><div class="srr-sum__h">총 내용 정리</div>'
    + srSummaryText(d).map((t) => '<p class="srr-sum__p">' + escapeHtml(t) + '</p>').join('')
    + '</div>'
    + '</div>';
}

function srViewData(year) {
  const yrs = Object.keys(_srData.years).sort();
  const months = _srData.months;
  const pick = (year === 'all') ? yrs : yrs.filter((y) => y === year);
  const series = pick.map((y) => ({
    key: y,
    color: srYearColor(y),
    values: (_srData.years[y] || []).slice(0, months.length),
  })).filter((s) => s.values.some((v) => v != null));
  return { months, series };
}

/** 해상 정시성 블록 HTML (ICIS와 동일 스타일: 연도 버튼 → 선그래프) */
function renderScheduleReliabilityHtml() {
  if (!_srData) return '';
  // 연도를 고른 뒤에만 리포트를 낼 수 있다(관측 구간이 정해져야 계산이 된다)
  const canReport = !_srData.error && _srYear;
  const reportBtn = canReport
    ? `<button type="button" class="srr-btn${_srReport ? ' is-on' : ''}" data-sr-report="1"
        aria-expanded="${_srReport ? 'true' : 'false'}">📊 리포트 분석</button>`
    : '';
  const head = `<div class="viz-head"><div>
      <div class="viz-title">해상 정시성 (Global Schedule Reliability)</div>
      <div class="viz-sub">월별 정시 도착 비율(%) · 연도별</div>
    </div>${reportBtn}</div>`;
  if (_srData.error) {
    return `<div class="viz-root viz-figure sr-figure">${head}
      <div class="chart-empty">데이터를 불러오지 못했습니다(사이트 접근 차단 가능)</div>
      ${capSrc('출처: Sea-Intelligence', SRC_LINKS.sea)}
    </div>`;
  }
  const years = Object.keys(_srData.years).sort().concat(['all']);
  const toolbar = `<div class="icis-years sr-years">${years.map((y) =>
    `<button class="icis-year sr-year${y === _srYear ? ' is-active' : ''}" data-year="${y}">${y === 'all' ? '전체' : y}</button>`).join('')}</div>`;

  // 스폰지 카드(renderMaterial의 _matYear 분기)와 동일 조건: 연도를 고르기 전에는
  // 차트와 함께 지표 설명·예측도 내보내지 않는다.
  let body, extras = '';
  if (!_srYear) {
    body = '<div class="icis-prompt">연도를 선택하세요</div>';
  } else {
    const { months, series } = srViewData(_srYear);
    body = buildSrChart(months, series);
    extras = (_srReport ? srReportHtml() : '') + renderSrTermsHtml() + renderSrForecastHtml();
  }
  return `<div class="viz-root viz-figure sr-figure">${head}
    ${toolbar}
    ${body}
    <div class="viz-tooltip" id="srTooltip"></div>
    ${capSrc('출처: Sea-Intelligence', SRC_LINKS.sea)}
    ${extras}
  </div>`;
}

/* 순수 추가: 정시성 '지표 설명' 정적 텍스트 (데이터 수집·API 없음).
   ★ 스폰지 카드의 ICIS_TERMS/icisTermsTable과 표기 패턴만 맞추고 공통화하지 않음. */
const SR_TERMS = [
  { item: '정시성이란',
    desc: '선사가 사전에 공표한 도착 예정일에 실제로 도착한 선박의 비율. '
        + 'Sea-Intelligence가 전 세계 34개 주요 항로, 60여 개 선사를 대상으로 매월 집계해 발표한다.' },
  { item: '수치 읽는 법',
    desc: '60%는 열 척 중 여섯 척만 예정일에 도착했다는 뜻이다. '
        + '나머지 네 척은 지연되었으며, 통상 수일에서 2주 이상 늦어진다.' },
  { item: '왜 중요한가',
    desc: '정시성이 낮아지면 원자재 입고가 늦어져 생산 계획에 차질이 생기고, 안전재고를 늘려야 해 재고 비용이 증가한다. '
        + '또한 지연이 길어질수록 운임과 체선료 부담도 함께 커진다.' },
  { item: '주요 변동 요인',
    desc: '항만 혼잡, 기상 악화, 선사 파업, 지정학적 항로 차단(수에즈·파나마 등), 물동량 급증에 따른 병목.' },
];

// '수준별 해석' 행에만 색 점 사용 (원활=초록 / 보통=파랑 / 지연=주황 / 심각=빨강)
const SR_LEVELS = [
  { range: '70% 이상', name: '원활', note: '팬데믹 이전 평시 수준', color: '#12B981' },
  { range: '55~70%',   name: '보통', note: '최근 몇 년간의 일반적 범위', color: '#3B82F6' },
  { range: '40~55%',   name: '지연', note: '공급망 차질이 체감되는 구간', color: '#F59E0B' },
  { range: '40% 미만', name: '심각', note: '2021~2022년 물류 대란 수준', color: '#C8102E' },
];

/** 순수 추가: 출처 아래 '지표 설명' 표(2열: 항목/설명). 정적 텍스트라 항상 표시. */
function renderSrTermsHtml() {
  const levels = SR_LEVELS.map((l) =>
    `<div class="sr-lv"><span class="icis-dot" style="background:${l.color}"></span>
      <b class="sr-lv__range">${escapeHtml(l.range)}</b>
      <span class="sr-lv__name">${escapeHtml(l.name)}</span>
      <span class="sr-lv__note">— ${escapeHtml(l.note)}</span></div>`).join('');
  const rows = SR_TERMS.map((t) =>
    `<tr><td class="sr-term__item">${escapeHtml(t.item)}</td><td>${escapeHtml(t.desc)}</td></tr>`);
  // '수준별 해석'은 '수치 읽는 법' 바로 다음(2번째)에 배치
  rows.splice(2, 0, `<tr><td class="sr-term__item">수준별 해석</td><td><div class="sr-lvs">${levels}</div></td></tr>`);
  return `<div class="sr-terms">
    <h3 class="subhead">지표 설명</h3>
    <div class="sr-term-wrap"><table class="sr-termtable">
      <thead><tr><th>항목</th><th>설명</th></tr></thead><tbody>${rows.join('')}</tbody>
    </table></div>
    <div class="sr-terms__ref">함께 보면 좋은 지표: 글로벌 컨테이너 운임지수(FBX) — 운임이 급등하는 국면에서는 정시성도 함께 악화되는 경향이 있다.</div>
  </div>`;
}

/** 순수 추가: 출처 아래 '다음 달 전망'(정시성). 예측 없으면 '' 반환(섹션 숨김).
 *  숫자는 백엔드 계산(_srForecast), 문장(summary/seasonal/yoy/caution)만 AI. */
function renderSrForecastHtml() {
  const fc = _srForecast;
  if (!fc) return '';
  const gen = fc.generated_at ? `<span class="sr-fc__gen">예측 생성 ${escapeHtml(fc.generated_at)}</span>` : '';
  const title = `<h3 class="subhead sr-fc__title">다음 달 전망 <span class="sr-fc__month">(${escapeHtml(fc.target_month || '')} 예측)</span>${gen}</h3>`;
  const dist = (fc.last_data_month && fc.months_ahead != null)
    ? `<div class="sr-fc__dist">최신 데이터 ${escapeHtml(fc.last_data_month)} 기준 · ${fc.months_ahead}개월 후 추정</div>` : '';
  const monthsTxt = (fc.months_ahead != null) ? (fc.months_ahead + '개월') : '수개월';
  const disc = `<div class="sr-fc__disc">최신 데이터로부터 ${monthsTxt} 후를 추정한 값으로, 과거 계절 패턴에 주로 의존합니다. 예측 거리가 멀수록 오차가 커지며, 기상·파업·항만 혼잡·지정학적 요인 등 외부 변수는 반영되지 않았습니다.</div>`;
  if (fc.forecast_status === 'insufficient') {
    return `<div class="sr-fc">${title}${dist}
      <div class="sr-fc__na">데이터 부족 <span class="sr-fc__reason">(${escapeHtml(fc.reason || '')})</span></div>
      ${disc}</div>`;
  }
  const rcls = fc.risk === '상방' ? 'up' : (fc.risk === '하방' ? 'down' : 'flat');
  const dcls = (v) => (v == null ? 'flat' : (v > 0 ? 'up' : (v < 0 ? 'down' : 'flat')));
  const pp = (v) => (v == null ? '— ' : `${v > 0 ? '▲' : (v < 0 ? '▼' : '–')} ${Math.abs(v).toFixed(1)}%p`);
  const deltaLabel = escapeHtml(fc.delta_label || '직전 실측 대비');
  const path = (Array.isArray(fc.path) && fc.path.length)
    ? `<div class="sr-fc__path">${fc.path.map((p) => `${escapeHtml(p.label)} ${Number(p.v).toFixed(1)}`).join(' → ')} <span class="sr-fc__path-tag">(추정)</span></div>` : '';
  const ai = [
    fc.summary ? `<div class="sr-fc__ai">${escapeHtml(fc.summary)}</div>` : '',
    fc.seasonal_txt ? `<div class="sr-fc__ai"><b>계절 패턴</b> ${escapeHtml(fc.seasonal_txt)}</div>` : '',
    fc.yoy_txt ? `<div class="sr-fc__ai"><b>전년 대비</b> ${escapeHtml(fc.yoy_txt)}</div>` : '',
  ].join('');
  return `<div class="sr-fc">${title}${dist}
    <div class="sr-fc__row">
      <div class="sr-fc__big">${Number(fc.predict).toFixed(1)}<span class="sr-fc__pct">%</span>
        <span class="sr-fc__risk ${rcls}">${escapeHtml(fc.risk)}</span></div>
      <div class="sr-fc__cmps">
        <span class="sr-fc__cmp ${dcls(fc.delta_pp)}">${deltaLabel} ${pp(fc.delta_pp)}</span>
        <span class="sr-fc__cmp ${dcls(fc.yoy_pp)}">전년 동월 대비 ${pp(fc.yoy_pp)}</span>
        <span class="sr-fc__ci">신뢰구간 ${Number(fc.ci_low).toFixed(1)}% ~ ${Number(fc.ci_high).toFixed(1)}%</span>
      </div>
    </div>
    ${path}
    ${ai}
    ${fc.caution ? `<div class="sr-fc__caution">⚠ ${escapeHtml(fc.caution)}</div>` : ''}
    ${disc}
  </div>`;
}

/** 연도별 정시성(%) 선그래프 SVG (null 구간 선 끊김, 단일 연도 시 값 라벨) */
function buildSrChart(months, series) {
  const n = months.length;
  if (!n || !series.length) return '<div class="chart-empty">표시할 데이터가 없습니다.</div>';
  const single = series.length === 1;

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.12 || 5; ymin = Math.max(0, ymin - yp); ymax = Math.min(100, ymax + yp);

  const W = VIZ_W, H = VIZ_H, padL = 40, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val)}%</text>`;
  }).join('');

  // 월 이름(Jan…)은 짧아 12개를 모두 넣어도 겹치지 않는다(간격 40px 기준)
  const xticks = vizTickIdx(n, plotW, 40).map((i) =>
    `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(months[i])}</text>`).join('');

  const lines = series.map((s) => {
    let path = '', pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  const dots = series.map((s) => s.values.map((v, i) => v == null ? '' :
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1"/>`).join('')).join('');

  // 값 라벨: 점이 VIZ_LABEL_MAX_PTS 이하인 단일 연도 보기(12개월)에서만 표시.
  // 여러 연도를 겹쳐 보는 경우는 라벨 없이 툴팁으로만 값을 보여준다.
  const labels = (single && n <= VIZ_LABEL_MAX_PTS) ? series[0].values.map((v, i) => {
    if (v == null) return '';
    const x = X(i), y = Y(v) - 6;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_LABEL}" font-weight="700" paint-order="stroke" stroke="var(--surface-1)" stroke-width="2.5" fill="${series[0].color}">${v.toFixed(1)}%</text>`;
  }).join('') : '';

  const legend = `<div class="viz-legend">${series.map((s) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${s.color}"></span>${s.key}</span>`).join('')}</div>`;
  _srChart = { months, series, geom: { X, Y, n, W, padL } };

  return `${legend}
    <svg class="viz-svg sr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="해상 정시성">
      ${grid}${xticks}${lines}${dots}${labels}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="sr-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="sr-dots"></g>
      <rect class="sr-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 크로스헤어 + 툴팁 (월 · 연도별 정시성 %) */
function wireSrChart() {
  const fig = document.querySelector('#materialRoot .sr-figure');
  const tip = document.getElementById('srTooltip');
  if (!fig || !tip || !_srChart) return;
  const svg = fig.querySelector('.sr-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.sr-overlay');
  const cross = svg.querySelector('.sr-cross');
  const dots = svg.querySelector('.sr-dots');
  const c = _srChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${s.key}</span><span class="viz-tt-val">${v.toFixed(1)}%</span></div>`;
    });
    if (!rows) { clear(); return; }
    dots.innerHTML = dh;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.months[i])}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/* ── 국제유가 (PETRONET 일일국제원유가격) ─────────────────────────────────
   실제 조회 페이지와 같은 순서로 조작한다: 기준선택 → 기간 → 제품 → [조회].

   ★ [조회]를 누르기 전에는 결과가 바뀌지 않는다. 조건은 _ocForm 에 쌓이고,
     [조회]가 그것을 _ocQuery 로 확정할 때만 표·그래프를 다시 그린다(실제 사이트와 동일).
   ★ 서버를 다시 부르지 않는다. 기준별 전 구간을 미리 받아 두고(oil_crude.py)
     여기서 자른다 — PETRONET 은 브라우저에서 직접 부를 수 없다(CORS).
   ★ 요약행(전일비·전주비·전월동일비·전년동일비)은 '보이는 구간'이 아니라
     '받아둔 전 구간'에서 찾아 계산한다. 전년동일비는 1년 전 값을 봐야 해서다.
     계산 규칙은 PETRONET 이 스스로 계산해 준 값과 대조해 확정했다(oil_crude.py 주석). */
const OC_COLORS = { dubai: '#C8102E', brent: '#3B82F6', wti: '#F59E0B', oman: '#12B981' };
const OC_TERMS = [['y', '년'], ['m', '월'], ['w', '주'], ['d', '일']];
// 체크박스 라벨 옆에 붙일 짧은 설명 — 어느 지역 기준 유종인지 그 자리에서 읽히게.
// ★ 조회 조건의 체크박스에만 쓴다. 표 머리·범례·CSV 는 payload 의 series.label
//   (Dubai / Brent(ICE) …)을 그대로 써야 하므로 그쪽은 건드리지 않는다.
const OC_ORIGIN = {
  dubai: '두바이유 · 중동 기준',
  brent: '브렌트유 · 유럽/국제유가 기준',
  wti: '서부텍사스유 · 미국 기준',
  oman: '오만유 · 중동 기준',
};
// 기준별 기본 조회 폭(개월). 표가 한눈에 들어오는 크기로 연다.
const OC_DEFAULT_SPAN = { y: null, m: 12, w: 3, d: 1 };

let _ocData = null;     // sections.oil_crude — {series, terms:{y,m,w,d}, unit, ...}
let _ocForm = null;     // 사용자가 만지는 중인 조건 {term, y0,m0,y1,m1, on:Set}
let _ocQuery = null;    // [조회]로 확정된 조건 — 결과는 이것만 본다
let _ocView = 'table';  // 'table' | 'chart'
let _oilChart = null;   // 차트 크로스헤어·툴팁 상태

/** 기준(term) 블록. 없으면 null */
function ocTerm(t) {
  const d = _ocData;
  return (d && !d.error && d.terms && d.terms[t]) || null;
}

/** period → 'YYYY'(년) 또는 'YYYY-MM'(그 외). 기간 필터의 비교 키다. */
function ocYm(period, term) {
  return term === 'y' ? String(period).slice(0, 4) : String(period).slice(0, 7);
}

/** period → 표에 찍을 라벨 */
function ocLabel(period, term) {
  const p = String(period);
  if (term === 'y') return p + '년';
  if (term === 'm') return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월';
  if (term === 'w') return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월 ' + p.split('W')[1] + '주';
  return p.slice(0, 4) + '년 ' + p.slice(5, 7) + '월 ' + p.slice(8, 10) + '일';
}

/** 기준의 rows 에 등장하는 연도 목록(오름차순) */
function ocYears(term) {
  const t = ocTerm(term);
  if (!t) return [];
  const s = new Set(t.rows.map((r) => String(r.period).slice(0, 4)));
  return Array.from(s).sort();
}

/** 그 기준의 기본 기간 — 마지막 데이터에서 OC_DEFAULT_SPAN 만큼 거슬러 연다. */
function ocDefaultSpan(term) {
  const t = ocTerm(term);
  if (!t || !t.rows.length) return null;
  const last = t.rows[t.rows.length - 1].period, first = t.rows[0].period;
  if (term === 'y') return { y0: first.slice(0, 4), m0: '01', y1: last.slice(0, 4), m1: '12' };
  const y1 = Number(last.slice(0, 4)), m1 = Number(last.slice(5, 7));
  const span = OC_DEFAULT_SPAN[term] || 12;
  let y0 = y1, m0 = m1 - span + 1;
  while (m0 <= 0) { y0 -= 1; m0 += 12; }
  const fy = Number(first.slice(0, 4)), fm = Number(first.slice(5, 7));
  if (y0 < fy || (y0 === fy && m0 < fm)) { y0 = fy; m0 = fm; }
  const p2 = (n) => String(n).padStart(2, '0');
  return { y0: String(y0), m0: p2(m0), y1: String(y1), m1: p2(m1) };
}

/** 최초/기준변경 시의 조회 조건 */
function ocFormFor(term, keepOn) {
  const sp = ocDefaultSpan(term) || { y0: '', m0: '01', y1: '', m1: '12' };
  const on = keepOn || new Set((_ocData && _ocData.default_on) || []);
  return { term: term, y0: sp.y0, m0: sp.m0, y1: sp.y1, m1: sp.m1, on: on };
}

/** 조건에 맞는 행만 자른다(기간). 유종은 표·차트에서 고른다. */
function ocWindow(q) {
  const t = ocTerm(q.term);
  if (!t) return [];
  const a = q.term === 'y' ? q.y0 : q.y0 + '-' + q.m0;
  const b = q.term === 'y' ? q.y1 : q.y1 + '-' + q.m1;
  const lo = a <= b ? a : b, hi = a <= b ? b : a;   // 거꾸로 골라도 동작하게
  return t.rows.filter((r) => {
    const k = ocYm(r.period, q.term);
    return k >= lo && k <= hi;
  });
}

/** 켜진 유종 목록 [{key,label,color}] (payload 순서 유지) */
function ocOnSeries(q) {
  const d = _ocData;
  if (!d || d.error) return [];
  return (d.series || []).filter((s) => q.on.has(s.key))
    .map((s) => ({ key: s.key, label: s.label, color: OC_COLORS[s.key] || 'var(--slate)' }));
}

/* ── 요약행 계산 ───────────────────────────────────────────────────────────
   ★ 비교 대상은 '받아둔 전 구간(all)'에서 찾는다 — 조회 창 밖의 과거를 봐야 한다.
   ★ 규칙은 PETRONET 이 계산해 준 값과 대조해 확정했다(14개 중 13개 정확히 일치.
     남은 1개는 일별 초장기 구간의 '평균'인데, 월별 표로 교차검증한 결과
     PETRONET 쪽이 틀렸다 — oil_crude.py 주석 참고).
       일 : 전일비=직전 행 · 전주비=7일 전 · 전월동일비=1개월 전 · 전년동일비=1년 전
            (휴장일이면 그 이전 영업일로 내려 잡는다)
       월 : 전월비=직전 행 · 전년동월비=1년 전 같은 달
       주 : 전주비=직전 행 · 전월동주비=4주 전 · 전년동주비=1년 전 같은 월·같은 주차
       년 : 전년비=직전 행
       평균: 조회 구간 전체 평균 */

/** 'YYYY-MM-DD' 를 y년 m개월 d일 만큼 옮긴다(월말 보정 포함) */
function ocShift(iso, dy, dm, dd) {
  const Y = Number(iso.slice(0, 4)), M = Number(iso.slice(5, 7)), D = Number(iso.slice(8, 10));
  let yy = Y + (dy || 0), mm = M + (dm || 0);
  yy += Math.floor((mm - 1) / 12);
  mm = ((mm - 1) % 12 + 12) % 12 + 1;
  const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const t = new Date(Date.UTC(yy, mm - 1, Math.min(D, dim)));
  t.setUTCDate(t.getUTCDate() + (dd || 0));
  return t.toISOString().slice(0, 10);
}

/** period <= target 인 마지막 행(휴장일이면 그 이전 영업일). 없으면 null */
function ocAtOrBefore(rows, target) {
  let hit = null;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].period <= target) hit = rows[i]; else break;
  }
  return hit;
}

/** 표 아래에 붙일 요약행 [{label, vals:{key:값}, kind}] */
function ocSummaryRows(q, win) {
  const t = ocTerm(q.term);
  if (!t || !win.length) return [];
  const all = t.rows, last = win[win.length - 1];
  const i = all.indexOf(last);
  const keys = ocOnSeries(q).map((s) => s.key);
  const back = (n) => ((i - n >= 0) ? all[i - n] : null);
  const find = (p) => all.filter((r) => r.period === p)[0] || null;
  const out = [];
  const push = (label, prev) => {
    const vals = {};
    keys.forEach((k) => {
      vals[k] = (!prev || last[k] == null || prev[k] == null)
        ? null : Math.round((last[k] - prev[k]) * 100) / 100;
    });
    out.push({ label: label, vals: vals, kind: 'delta' });
  };
  const p = String(last.period);
  if (q.term === 'd') {
    push('전일비', back(1));
    push('전주비', ocAtOrBefore(all, ocShift(p, 0, 0, -7)));
    push('전월동일비', ocAtOrBefore(all, ocShift(p, 0, -1, 0)));
    push('전년동일비', ocAtOrBefore(all, ocShift(p, -1, 0, 0)));
  } else if (q.term === 'm') {
    push('전월비', back(1));
    push('전년동월비', find((Number(p.slice(0, 4)) - 1) + '-' + p.slice(5, 7)));
  } else if (q.term === 'w') {
    push('전주비', back(1));
    push('전월동주비', back(4));
    push('전년동주비', find((Number(p.slice(0, 4)) - 1) + '-' + p.slice(5, 7) + '-W' + p.split('W')[1]));
  } else {
    push('전년비', back(1));
  }
  const avg = {};
  keys.forEach((k) => {
    const v = win.map((r) => r[k]).filter((x) => x != null);
    avg[k] = v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
  });
  out.push({ label: '평균', vals: avg, kind: 'avg' });
  return out;
}

/* ── 조회 조건 UI ─────────────────────────────────────────────────────── */

function ocNum(v) {
  return (v == null) ? '-' : Number(v).toFixed(2);
}

/** 기준선택 · 기간 · 제품 · [조회] */
function ocControlsHtml() {
  const f = _ocForm;
  if (!f) return '';
  const years = ocYears(f.term);
  const sel = (name, val, opts) => '<select class="oc-sel" data-oc="' + name + '">'
    + opts.map((o) => '<option value="' + escapeHtml(o[0]) + '"'
      + (String(o[0]) === String(val) ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>').join('')
    + '</select>';
  const yOpts = years.map((y) => [y, y + '년']);
  const mOpts = Array.from({ length: 12 }, (_, i) => {
    const v = String(i + 1).padStart(2, '0');
    return [v, v + '월'];
  });
  const showM = f.term !== 'y';   // 년 기준은 월을 고르지 않는다

  const terms = OC_TERMS.map((t) => '<label class="oc-radio">'
    + '<input type="radio" name="ocTerm" value="' + t[0] + '"'
    + (f.term === t[0] ? ' checked' : '') + '>' + escapeHtml(t[1]) + '</label>').join('');

  const prods = ((_ocData && _ocData.series) || []).map((s) => '<label class="oc-check oc-check--origin">'
    + '<input type="checkbox" data-oc-prod="' + escapeHtml(s.key) + '"'
    + (f.on.has(s.key) ? ' checked' : '') + '>'
    + '<span class="oc-swatch" style="background:' + (OC_COLORS[s.key] || 'var(--slate)') + '"></span>'
    + '<span class="oc-name">' + escapeHtml(s.label) + '</span>'
    + (OC_ORIGIN[s.key] ? '<span class="oc-note">(' + escapeHtml(OC_ORIGIN[s.key]) + ')</span>' : '')
    + '</label>').join('');

  return '<div class="oc-form">'
    + '<div class="oc-row"><span class="oc-lab">기준선택</span>'
    + '<div class="oc-ctl">' + terms + '</div></div>'
    + '<div class="oc-row"><span class="oc-lab">기간</span><div class="oc-ctl">'
    + sel('y0', f.y0, yOpts) + (showM ? sel('m0', f.m0, mOpts) : '')
    + '<span class="oc-tilde">~</span>'
    + sel('y1', f.y1, yOpts) + (showM ? sel('m1', f.m1, mOpts) : '')
    + '</div></div>'
    + '<div class="oc-row"><span class="oc-lab">제품</span>'
    + '<div class="oc-ctl">' + prods + '</div></div>'
    + '<div class="oc-row oc-row--go"><span class="oc-lab"></span>'
    + '<div class="oc-ctl"><button type="button" class="oc-go">조회</button></div></div>'
    + '</div>';
}

/* ── 결과: 표 ─────────────────────────────────────────────────────────── */

/** 조회 구간 표시 — '2026년 08월 17일 ~ 2026년 08월 24일' */
function ocSpanText(q, win) {
  if (!win.length) return '';
  return ocLabel(win[0].period, q.term) + ' ~ ' + ocLabel(win[win.length - 1].period, q.term);
}

function ocTableHtml(q, win) {
  const ser = ocOnSeries(q);
  if (!ser.length) return '<div class="chart-empty">제품을 하나 이상 선택하고 [조회]를 누르세요.</div>';
  if (!win.length) return '<div class="chart-empty">선택한 기간에 데이터가 없습니다.</div>';
  // 열별 최소·최대(데이터 행만) — 요약행은 하이라이트 대상이 아니다
  const ext = {};
  ser.forEach((s) => {
    const v = win.map((r) => r[s.key]).filter((x) => x != null);
    ext[s.key] = v.length ? { lo: Math.min.apply(null, v), hi: Math.max.apply(null, v) } : null;
  });
  const head = '<tr><th class="oc-th-p">' + escapeHtml(ocTerm(q.term).label) + '</th>'
    + ser.map((s) => '<th><span class="oc-swatch" style="background:' + s.color + '"></span>'
      + escapeHtml(s.label) + '</th>').join('') + '</tr>';
  const body = win.map((r) => '<tr><td class="oc-td-p">' + escapeHtml(ocLabel(r.period, q.term)) + '</td>'
    + ser.map((s) => {
      const v = r[s.key], e = ext[s.key];
      let cls = '';
      if (v != null && e) {
        if (v === e.lo && e.lo !== e.hi) cls = ' oc-min';
        else if (v === e.hi && e.lo !== e.hi) cls = ' oc-max';
      }
      return '<td class="oc-num' + cls + '">' + ocNum(v) + '</td>';
    }).join('') + '</tr>').join('');
  const sums = ocSummaryRows(q, win).map((s) => '<tr class="oc-sum oc-sum--' + s.kind + '">'
    + '<td class="oc-td-p">' + escapeHtml(s.label) + '</td>'
    + ser.map((x) => {
      const v = s.vals[x.key];
      const sign = (s.kind === 'delta' && v != null && v > 0) ? '+' : '';
      const cls = (s.kind !== 'delta' || v == null) ? '' : (v > 0 ? ' oc-up' : (v < 0 ? ' oc-down' : ''));
      return '<td class="oc-num' + cls + '">' + (v == null ? '-' : sign + ocNum(v)) + '</td>';
    }).join('') + '</tr>').join('');
  return '<div class="oc-tablewrap"><table class="oc-table">'
    + '<thead>' + head + '</thead><tbody>' + body + sums + '</tbody></table></div>';
}

/* ── 결과: 내보내기 ───────────────────────────────────────────────────── */

/** 표를 [[셀,...],...] 로 — csv·엑셀·인쇄가 같은 원본을 쓴다 */
function ocMatrix(q, win) {
  const ser = ocOnSeries(q);
  const rows = [[ocTerm(q.term).label].concat(ser.map((s) => s.label))];
  win.forEach((r) => rows.push([ocLabel(r.period, q.term)].concat(ser.map((s) => ocNum(r[s.key])))));
  ocSummaryRows(q, win).forEach((s) => rows.push([s.label].concat(ser.map((x) => {
    const v = s.vals[x.key];
    return v == null ? '-' : ((s.kind === 'delta' && v > 0 ? '+' : '') + ocNum(v));
  }))));
  return rows;
}

/** Blob 을 파일로 내려받기 */
function ocSave(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ocFileName(q, ext) {
  return '국제유가_' + ocTerm(q.term).label + '_' + String(q.y0) + (q.term === 'y' ? '' : q.m0)
    + '-' + String(q.y1) + (q.term === 'y' ? '' : q.m1) + '.' + ext;
}

function ocExportCsv(q, win) {
  const csv = ocMatrix(q, win)
    .map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  // BOM 을 붙여야 엑셀에서 한글이 깨지지 않는다
  ocSave(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), ocFileName(q, 'csv'));
}

function ocExportXls(q, win) {
  const rows = ocMatrix(q, win);
  const tbl = '<table border="1">' + rows.map((r, i) => '<tr>'
    + r.map((c) => (i ? '<td>' : '<th>') + escapeHtml(c) + (i ? '</td>' : '</th>')).join('')
    + '</tr>').join('') + '</table>';
  const html = '<html><head><meta charset="utf-8"></head><body>'
    + '<h3>국제유가 (PETRONET 일일국제원유가격) · ' + escapeHtml(ocSpanText(q, win))
    + ' · 단위 ' + escapeHtml((_ocData && _ocData.unit) || '$/배럴') + '</h3>'
    + tbl + '</body></html>';
  ocSave(new Blob(['﻿' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' }),
    ocFileName(q, 'xls'));
}

function ocPrint(q, win) {
  const rows = ocMatrix(q, win);
  const tbl = '<table>' + rows.map((r, i) => '<tr>'
    + r.map((c) => (i ? '<td>' : '<th>') + escapeHtml(c) + (i ? '</td>' : '</th>')).join('')
    + '</tr>').join('') + '</table>';
  const w = window.open('', '_blank');
  if (!w) { window.alert('팝업이 차단되어 인쇄 창을 열지 못했습니다.'); return; }
  w.document.write('<html><head><meta charset="utf-8"><title>국제유가 (PETRONET)</title>'
    + '<style>body{font-family:sans-serif;padding:20px}h3{margin:0 0 4px}'
    + 'p{margin:0 0 12px;color:#555;font-size:12px}'
    + 'table{border-collapse:collapse;font-size:12px}'
    + 'th,td{border:1px solid #999;padding:4px 8px;text-align:right}'
    + 'th:first-child,td:first-child{text-align:left}</style></head><body>'
    + '<h3>국제유가 (PETRONET 일일국제원유가격)</h3>'
    + '<p>' + escapeHtml(ocSpanText(q, win)) + ' · 단위 '
    + escapeHtml((_ocData && _ocData.unit) || '$/배럴') + ' · 출처 한국석유공사 PETRONET</p>'
    + tbl + '</body></html>');
  w.document.close();
  w.focus();
  w.print();
}

/* ── 카드 전체 ───────────────────────────────────────────────────────── */

function renderOilPricesHtml() {
  const unit = (_ocData && !_ocData.error && _ocData.unit) || '$/배럴';
  const head = `<div class="viz-head"><div>
      <div class="viz-title">국제유가 (PETRONET)</div>
      <div class="viz-sub">일일국제원유가격 · Dubai/Brent(ICE)/WTI(NYMEX)/Oman (${escapeHtml(unit)})</div>
      <div class="viz-sub2">지역별 대표 원유(유종)의 가격을 비교하는 그래프</div>
    </div></div>`;
  const cap = capSrc('출처: 한국석유공사 PETRONET · 일일국제원유가격', SRC_LINKS.oilCrude);

  if (!_ocData) {
    return `<div class="viz-root viz-figure oil-figure">${head}`
      + '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>' + `${cap}</div>`;
  }
  if (_ocData.error) {
    return `<div class="viz-root viz-figure oil-figure">${head}`
      + '<div class="chart-empty">데이터를 불러오지 못했습니다 (PETRONET 접근 차단 가능)</div>'
      + `${cap}</div>`;
  }

  const controls = '<div class="oc-formwrap">' + ocControlsHtml() + '</div>';
  let body;
  if (!_ocQuery) {
    body = '<div class="icis-prompt">기준·기간·제품을 고르고 [조회]를 누르세요</div>';
  } else {
    const q = _ocQuery, win = ocWindow(q);
    const tools = '<div class="oc-result__head">'
      + '<div class="oc-span">' + escapeHtml(ocSpanText(q, win))
      + ' <span class="oc-unit">(단위: ' + escapeHtml(unit) + ')</span></div>'
      + '<div class="oc-tools">'
      + '<button type="button" class="oc-tool' + (_ocView === 'table' ? ' is-on' : '') + '" data-oc-view="table">표보기</button>'
      + '<button type="button" class="oc-tool' + (_ocView === 'chart' ? ' is-on' : '') + '" data-oc-view="chart">차트보기</button>'
      + '<button type="button" class="oc-tool" data-oc-exp="csv">csv 저장</button>'
      + '<button type="button" class="oc-tool" data-oc-exp="xls">엑셀저장</button>'
      + '<button type="button" class="oc-tool" data-oc-exp="print">인쇄하기</button>'
      + '<button type="button" class="oc-tool or-btn' + (_ocReport ? ' is-on' : '')
      + '" data-oc-report="1" aria-expanded="' + (_ocReport ? 'true' : 'false')
      + '">📊 리포트 분석</button>'
      + '</div></div>';
    const result = (_ocView === 'chart')
      ? buildOilChart(win, ocOnSeries(q), q.term) + '<div class="viz-tooltip" id="oilTooltip"></div>'
      : ocTableHtml(q, win);
    body = tools + result + (_ocReport ? orReportHtml('crude') : '');
  }
  const note = (_ocData.note ? '<div class="g-note">' + escapeHtml(_ocData.note) + '</div>' : '');
  return `<div class="viz-root viz-figure oil-figure">${head}${controls}${body}${note}${cap}</div>`;
}


/** 선택한 유종만 선그래프 (connectNulls: 결측은 건너뛰고 이어 그림, dot 없음).
    ★ 계열을 인자로 받는다 — 전역 상태를 읽지 않으므로 어느 기준(년·월·주·일)이든 그대로 쓴다. */
function buildOilChart(rows, onSeries, term) {
  const n = rows.length;
  if (!n) { _oilChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const series = (onSeries || []).map((s) => ({
    key: s.key, label: s.label, color: s.color || 'var(--slate)',
    values: rows.map((r) => (r[s.key] == null ? null : r[s.key])),
  }));
  const periods = rows.map((r) => ocLabel(r.period, term));
  if (!series.length) { _oilChart = null; return '<div class="chart-empty">제품을 하나 이상 선택하세요.</div>'; }

  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { _oilChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.1 || 5; ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 42, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">$${Math.round(val)}</text>${vizKrwTick(padL - 6, y, val, _matUsdKrw)}`;
  }).join('');

  const xticks = vizTickIdx(n, plotW).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(periods[i])}</text>`;
  }).join('');

  // connectNulls: 결측(null)은 건너뛰되 선은 끊지 않고 다음 값과 이어 그림
  const lines = series.map((s) => {
    let d = '', started = false;
    s.values.forEach((v, i) => {
      if (v == null) return;
      const x = X(i), y = Y(v);
      d += `${started ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; started = true;
    });
    return d ? `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  _oilChart = { periods, series, geom: { X, Y, n, W, padL } };

  return `<svg class="viz-svg oil-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="국제유가 월별">
      ${grid}${xticks}${lines}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="oil-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="oil-dots"></g>
      <rect class="oil-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 크로스헤어 + 툴팁 (연-월 · 유종 · $값) */
function wireOilChart() {
  const fig = document.querySelector('#materialRoot .oil-figure');
  const tip = document.getElementById('oilTooltip');
  if (!fig || !tip || !_oilChart) return;
  const svg = fig.querySelector('.oil-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.oil-overlay');
  const cross = svg.querySelector('.oil-cross');
  const dots = svg.querySelector('.oil-dots');
  const c = _oilChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${escapeHtml(s.label)}</span><span class="viz-tt-val">$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>`;
    });
    if (!rows) { clear(); return; }
    dots.innerHTML = dh;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.periods[i])}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 주요 시황 원자재 링크 HTML */
function renderMaterialLinksHtml() {
  const cards = MATERIAL_LINKS.map((l) => `<a class="matlink" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">
    <span class="matlink__icon" aria-hidden="true">${l.icon}</span>
    <span class="matlink__txt">
      <span class="matlink__name">${escapeHtml(l.name)}</span>
      <span class="matlink__desc">${escapeHtml(l.desc)}</span>
    </span>
    <span class="matlink__go" aria-hidden="true">↗</span>
  </a>`).join('');
  return `<h3 class="subhead matlink-head">주요 시황 원자재 링크</h3><div class="matlink-grid">${cards}</div>`;
}


/* ── 월간 부문별 지수 (KOIMA) — 순수 추가 카드 ─────────────────────────────
   백엔드 koima_index.py 가 8개 부문 전 구간(1995-12~)을 한 번에 실어 보내므로
   탭·연월·기간 조작은 전부 로컬 필터링이다(재요청 없음 → '검색' 버튼도 없음).
   ★ 스폰지/정시성/유가 카드와 공통화하지 않고 별도 작성(중복 허용). */

// 탭 순서: 매트리스 원가와 직결되는 유화원료(폼 원료)·철강재(스프링)를 앞에 두고,
// 나머지는 KOIMA 원본 탭 순서(농산품→광산품→유무기원료→섬유원료→비철금속→희소금속).
const KOIMA_TAB_ORDER = ['petchem', 'steel', 'agri', 'mining', 'inorg', 'textile', 'nonferrous', 'rare'];
// 1단계(데이터 없음)에서도 탭 이름은 보여주고 비활성만 시킨다. 데이터가 오면 응답의 label을 쓴다.
const KOIMA_TAB_LABELS = {
  petchem: '유화원료', steel: '철강재', agri: '농산품', mining: '광산품',
  inorg: '유무기원료', textile: '섬유원료', nonferrous: '비철금속', rare: '희소금속',
};
const KOIMA_COLORS = {
  petchem: '#C8102E', steel: '#3B82F6', agri: '#12B981', mining: '#F59E0B',
  inorg: '#8B5CF6', textile: '#0EA5E9', nonferrous: '#64748B', rare: '#DB2777',
};
const KOIMA_RANGES = [
  { key: '1y', label: '1년', months: 12 }, { key: '3y', label: '3년', months: 36 },
  { key: '5y', label: '5년', months: 60 }, { key: 'all', label: '전체', months: null },
];
const KOIMA_DEFAULT_CAT = 'petchem';   // 기본 선택 부문: 유화원료

let _koimaData = null;   // {source,baseline,latestPeriod,categories:[...]} | {error} | null
let _koimaCat = null;    // 선택 부문 key
let _koimaEnd = null;    // 구간 끝점 'YYYY-MM'
let _koimaRange = null;  // 선택 기간(null=미선택 → "기간을 선택하세요")
let _koimaChart = null;

/** 응답의 koima_index 저장. 다른 카드 상태는 건드리지 않는다.
 *  ★ renderMaterial()은 _matReady 게이트가 있으므로 applyMaterialUpdate 다음에 호출해야 한다. */
function applyKoimaUpdate(data) {
  const k = data && data.sections && data.sections.koima_index;
  if (k && k.status === 'ok' && Array.isArray(k.categories) && k.categories.length) {
    _koimaData = {
      source: k.source, baseline: k.baseline,
      latestPeriod: k.latestPeriod, categories: k.categories,
    };
    // 부문·끝점만 기본값을 잡고 기간은 미선택으로 둔다(유가 카드와 동일한 2단계 유지)
    if (!_koimaCat) _koimaCat = KOIMA_DEFAULT_CAT;
    if (!_koimaEnd) _koimaEnd = k.latestPeriod || null;
    const rc = (koimaCatOf(_koimaCat) || {}).rows || [];
    console.log('[koima] 부문 %d개 · 최신월 %s · 기본 탭 %s(%d행)',
      k.categories.length, k.latestPeriod, _koimaCat, rc.length);
  } else {
    _koimaData = { error: (k && k.reason) || '데이터 없음' };
  }
  renderMaterial();
}

/** key로 부문 찾기 */
function koimaCatOf(key) {
  if (!_koimaData || _koimaData.error) return null;
  return _koimaData.categories.find((c) => c.key === key) || null;
}

/** 탭 표시 순서대로 정렬된 부문 목록 (KOIMA_TAB_ORDER에 없는 부문은 뒤에 붙임) */
function koimaCatsOrdered() {
  if (!_koimaData || _koimaData.error) return [];
  const cats = _koimaData.categories;
  const known = KOIMA_TAB_ORDER.map((k) => cats.find((c) => c.key === k)).filter(Boolean);
  const rest = cats.filter((c) => !KOIMA_TAB_ORDER.includes(c.key));
  return known.concat(rest);
}

/** 'YYYY-MM' → 정수 월 인덱스(정렬·차이 계산용) */
function koimaMonthIdx(p) {
  const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7));
  return y * 12 + (m - 1);
}

/** 선택 부문의 연도 목록(오름차순) */
function koimaYears(cat) {
  const set = new Set((cat.rows || []).map((r) => r.period.slice(0, 4)));
  return Array.from(set).sort();
}

/** 선택 부문 + 연도의 월 목록(오름차순, 2자리) */
function koimaMonths(cat, year) {
  return (cat.rows || []).filter((r) => r.period.slice(0, 4) === year)
    .map((r) => r.period.slice(5, 7)).sort();
}

/** 끝점이 선택 부문에 없으면 가장 가까운(≤) 기간으로, 없으면 첫 기간으로 보정.
 *  희소금속(2010-01~)처럼 구간이 짧은 부문으로 탭을 옮길 때 필요하다. */
function koimaClampEnd(cat, end) {
  const rows = cat.rows || [];
  if (!rows.length) return null;
  if (!end) return rows[rows.length - 1].period;
  if (rows.some((r) => r.period === end)) return end;
  const le = rows.filter((r) => r.period <= end);
  return le.length ? le[le.length - 1].period : rows[0].period;
}

/** 끝점 + 기간칩 → 표시할 rows. 기간은 끝점에서 N개월 소급(끝점 포함). */
function koimaSliceRows() {
  const cat = koimaCatOf(_koimaCat);
  if (!cat || !_koimaRange) return [];
  const end = koimaClampEnd(cat, _koimaEnd);
  if (!end) return [];
  const rng = KOIMA_RANGES.find((r) => r.key === _koimaRange);
  const months = rng ? rng.months : null;
  const endIdx = koimaMonthIdx(end);
  return (cat.rows || []).filter((r) => {
    const i = koimaMonthIdx(r.period);
    if (i > endIdx) return false;                       // 끝점 이후는 제외
    return months == null ? true : i > endIdx - months; // N개월 소급(끝점 포함 = N개)
  });
}

/** 증감 표기: "0.04 (▲0.14%)" — ▲빨강 / ▼파랑 */
function koimaDelta(val, pct) {
  if (val == null && pct == null) return '<span class="koima-chg flat">–</span>';
  const v = val == null ? (pct || 0) : val;
  const cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
  const arrow = v > 0 ? '▲' : (v < 0 ? '▼' : '–');
  const av = val == null ? '-' : Math.abs(val).toFixed(2);
  const ap = pct == null ? '-' : Math.abs(pct).toFixed(2);
  return `<span class="koima-chg ${cls}">${av} (${arrow}${ap}%)</span>`;
}

/** KOIMA 카드 HTML — 유가 카드와 동일한 3단계 빈 상태 */
function renderKoimaHtml() {
  const cap = capSrc('출처: 한국수입협회 국제원자재가격정보', SRC_LINKS.koimaIndex);
  const ok = _koimaData && !_koimaData.error && _koimaData.categories.length;
  const cat = ok ? koimaCatOf(_koimaCat) : null;
  const dis = ok ? '' : ' disabled';

  /* 소제목 아래 한 줄 — '지수'가 무슨 뜻인지 지금 고른 부문 이름으로 풀어 준다.
     ★ 부문 이름을 코드에 적지 않는다. 탭에서 고른 부문(cat.label)을 그대로 쓰므로
       유화원료를 고르면 문구도 '유화원료 가격이…'로 따라간다.
     ★ 아직 못 고른 상태(로드 전)면 부문 이름 없이 일반 문장으로 둔다. */
  const catName = (cat && cat.label) || (KOIMA_TAB_LABELS[_koimaCat] || '');
  const exSubject = catName ? catName + ' 가격이' : '해당 부문 가격이';
  const head = `<div class="viz-head"><div>
      <div class="viz-title">원자재 월간 부문별 지수 (KOIMA)</div>
      <div class="viz-sub">8개 부문 월별 지수 · 2010.12 = 100 기준</div>
      <div class="viz-sub2">예) &ldquo;${escapeHtml(exSubject)} 기준 시점에 비해 얼마나 올랐거나 내렸는지&rdquo;를 보여주는 지수</div>
    </div></div>`;

  // 1) 부문 탭 8개 — 데이터 없으면 비활성
  const tabList = ok ? koimaCatsOrdered()
    : KOIMA_TAB_ORDER.map((k) => ({ key: k, label: KOIMA_TAB_LABELS[k] || k }));
  const tabs = `<div class="icis-years koima-tabs">${tabList.map((c) =>
    `<button class="icis-year koima-tab${c.key === _koimaCat ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-cat="${escapeHtml(c.key)}"${dis}>${escapeHtml(c.label || KOIMA_TAB_LABELS[c.key] || c.key)}</button>`).join('')}</div>`;

  // 2) 연도 + 월 드롭다운 — 로드된 데이터의 실제 범위로 동적 생성(하드코딩 없음)
  let selects;
  if (ok && cat) {
    const end = koimaClampEnd(cat, _koimaEnd) || '';
    const ey = end.slice(0, 4), em = end.slice(5, 7);
    const yOpts = koimaYears(cat).map((y) =>
      `<option value="${y}"${y === ey ? ' selected' : ''}>${y}년</option>`).join('');
    const mOpts = koimaMonths(cat, ey).map((m) =>
      `<option value="${m}"${m === em ? ' selected' : ''}>${Number(m)}월</option>`).join('');
    selects = `<label class="koima-sel"><span>기준</span>
        <select class="koima-year">${yOpts}</select>
        <select class="koima-month">${mOpts}</select></label>
      <span class="koima-avail">수집 범위 ${escapeHtml(cat.rows.length ? cat.rows[0].period : '-')} ~ ${escapeHtml(cat.rows.length ? cat.rows[cat.rows.length - 1].period : '-')}</span>`;
  } else {
    selects = `<label class="koima-sel"><span>기준</span>
      <select class="koima-year" disabled></select>
      <select class="koima-month" disabled></select></label>`;
  }
  const controls = `<div class="koima-controls">${selects}</div>`;

  // 3) 기간 칩
  const rptBtn = (ok && _koimaRange)
    ? `<button type="button" class="oc-tool or-btn koima-report${_koimaReport ? ' is-on' : ''}"
        data-koima-report="1" aria-expanded="${_koimaReport ? 'true' : 'false'}">📊 리포트 분석</button>`
    : '';
  const chips = `<div class="icis-years koima-ranges">${KOIMA_RANGES.map((r) =>
    `<button class="icis-year koima-range${r.key === _koimaRange ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-range="${r.key}"${dis}>${r.label}</button>`).join('')}${rptBtn}</div>`;

  let body;
  if (!_koimaData) {                                   // 1) 데이터 없음
    body = '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>';
  } else if (_koimaData.error) {
    body = `<div class="chart-empty">데이터를 불러오지 못했습니다 (${escapeHtml(_koimaData.error)})</div>`;
  } else if (!_koimaRange) {                            // 2) 데이터 있음 · 기간 미선택
    body = '<div class="icis-prompt">기간을 선택하세요</div>';
  } else {                                              // 3) 선택됨 → 차트 + 표
    const rows = koimaSliceRows();
    body = buildKoimaChart(rows, cat) + '<div class="viz-tooltip" id="koimaTooltip"></div>'
      + koimaRecentTable(rows, cat)
      + (_koimaReport ? krIndexHtml() : '');
  }
  return `<div class="viz-root viz-figure koima-figure">${head}${tabs}${controls}${chips}${body}${cap}</div>`;
}

/** 단일 시리즈 월별 선그래프 (dot 없음, Y축 auto — 0에서 시작하지 않음) */
function buildKoimaChart(rows, cat) {
  const n = rows.length;
  if (!n || !cat) { _koimaChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const color = KOIMA_COLORS[cat.key] || 'var(--accent)';
  const periods = rows.map((r) => r.period);
  const values = rows.map((r) => (r.index == null ? null : r.index));
  const all = values.filter((v) => v != null);
  if (!all.length) { _koimaChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }

  // domain ['auto','auto'] 대응: 0으로 내리지 않고 데이터 범위 ±8% 여백만 둔다
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.08 || Math.max(1, ymax * 0.05);
  ymin -= yp; ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 42, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${val.toFixed(val >= 100 ? 0 : 1)}</text>`;
  }).join('');

  const xticks = vizTickIdx(n, plotW).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(periods[i])}</text>`;
  }).join('');

  let d = '', started = false;
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${started ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; started = true;
  });
  const line = d ? `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/>` : '';

  _koimaChart = { periods, values, label: cat.label, color, geom: { X, Y, n, W, padL } };
  console.log('[koima] 차트 · %s · %s~%s · %d개 점', cat.label, periods[0], periods[n - 1], n);

  return `<div class="viz-legend koima-legend"><span class="viz-legend__item">
      <span class="viz-legend__swatch" style="background:${color}"></span>${escapeHtml(cat.label)} 지수</span></div>
    <svg class="viz-svg koima-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(cat.label)} 월간 지수">
      ${grid}${xticks}${line}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="koima-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="koima-dots"></g>
      <rect class="koima-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 차트 아래 최근 12개월 표 — 원본처럼 2열(6행씩) 배치, 최신월이 왼쪽 위 */
function koimaRecentTable(rows, cat) {
  if (!rows.length || !cat) return '';
  const recent = rows.slice(-12).reverse();        // 최신 → 과거
  const half = Math.ceil(recent.length / 2);
  const left = recent.slice(0, half), right = recent.slice(half);
  const cells = (r) => (r
    ? `<td class="koima-t__p">${escapeHtml(r.period)}</td>
       <td class="koima-t__v">${r.index == null ? '-' : r.index.toFixed(2)}</td>
       <td>${koimaDelta(r.momValue, r.momPct)}</td>
       <td>${koimaDelta(r.yoyValue, r.yoyPct)}</td>`
    : '<td colspan="4" class="koima-t__blank"></td>');
  const body = left.map((r, i) => `<tr>${cells(r)}${cells(right[i])}</tr>`).join('');
  const hg = '<th>기간</th><th>부문별 지수</th><th>전월비(%)</th><th>전년비(%)</th>';
  return `<h3 class="subhead koima-t__head">${escapeHtml(cat.label)} 최근 ${recent.length}개월</h3>
    <div class="koima-t__wrap"><table class="koima-t">
      <thead><tr>${hg}${hg}</tr></thead><tbody>${body}</tbody>
    </table></div>`;
}

/** 크로스헤어 + 툴팁 (연-월 · 부문 · 지수) */
function wireKoimaChart() {
  const fig = document.querySelector('#materialRoot .koima-figure');
  const tip = document.getElementById('koimaTooltip');
  if (!fig || !tip || !_koimaChart) return;
  const svg = fig.querySelector('.koima-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.koima-overlay');
  const cross = svg.querySelector('.koima-cross');
  const dots = svg.querySelector('.koima-dots');
  const c = _koimaChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const v = c.values[i];
    if (v == null) { clear(); return; }
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    dots.innerHTML = `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3" fill="${c.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.periods[i])}</div>
      <div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${c.color}"></span><span>${escapeHtml(c.label)}</span><span class="viz-tt-val">${v.toFixed(2)}</span></div>`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 탭·드롭다운·칩 이벤트 (검색 버튼 없음 — 바꾸면 즉시 다시 그린다) */
function wireKoimaControls(root) {
  const fig = root.querySelector('.koima-figure');
  if (!fig) return;
  const tabsEl = fig.querySelector('.koima-tabs');
  if (tabsEl) tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.koima-tab');
    if (!b || b.disabled) return;
    _koimaCat = b.dataset.cat;
    const cat = koimaCatOf(_koimaCat);
    if (cat) _koimaEnd = koimaClampEnd(cat, _koimaEnd);  // 짧은 구간 부문으로 옮길 때 보정
    renderMaterial();
  });
  const chipsEl = fig.querySelector('.koima-ranges');
  if (chipsEl) chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.koima-range');
    if (!b || b.disabled) return;
    _koimaRange = b.dataset.range;
    renderMaterial();
  });
  const yEl = fig.querySelector('.koima-year');
  const mEl = fig.querySelector('.koima-month');
  if (yEl) yEl.addEventListener('change', () => {
    const cat = koimaCatOf(_koimaCat);
    if (!cat) return;
    const ms = koimaMonths(cat, yEl.value);
    // 연도를 바꾸면 그 연도에 있는 월로 맞춘다(현재 월이 없으면 마지막 월)
    const want = mEl && ms.includes(mEl.value) ? mEl.value : ms[ms.length - 1];
    if (want) _koimaEnd = `${yEl.value}-${want}`;
    renderMaterial();
  });
  if (mEl) mEl.addEventListener('change', () => {
    if (yEl) _koimaEnd = `${yEl.value}-${mEl.value}`;
    renderMaterial();
  });
  const krBtn = fig.querySelector('.koima-report');
  if (krBtn) krBtn.addEventListener('click', () => { _koimaReport = !_koimaReport; renderMaterial(); });
  if (_koimaRange && _koimaData && !_koimaData.error) wireKoimaChart();
}

/** 대시보드 메인 요약용 한 줄: 유화원료 최신 지수 + 전월비.
 *  ★ 메인 그리드에서는 .panel-body가 150px로 잘리므로 materialRoot 맨 위에 둔다.
 *    포커스(원자재 섹션) 화면에서는 CSS로 숨겨 기존 카드 배치를 바꾸지 않는다. */
function renderKoimaSummaryHtml() {
  const cat = koimaCatOf(KOIMA_DEFAULT_CAT);
  if (!cat || !cat.rows || !cat.rows.length) return '';
  const r = cat.rows[cat.rows.length - 1];
  const color = KOIMA_COLORS[cat.key] || 'var(--accent)';
  return `<div class="koima-oneline">
    <span class="koima-oneline__dot" style="background:${color}"></span>
    <span class="koima-oneline__lbl">KOIMA ${escapeHtml(cat.label)}</span>
    <b class="koima-oneline__val">${r.index == null ? '-' : r.index.toFixed(2)}</b>
    <span class="koima-oneline__meta">${escapeHtml(r.period)} · 전월비 ${koimaDelta(r.momValue, r.momPct)}</span>
  </div>`;
}


/* ── 일일 국제원자재가격 (KOIMA) — 순수 추가 카드 ───────────────────────────
   ★ 월간 부문별 지수 카드와 데이터 모양이 다르다(일별 · 품목 2단 구조 ·
     전일/전주/전월 3종 증감 · 전주평균/전월평균). 코드를 복사하지 않고 새로 작성했다.
   ★ 데이터는 미리 수집해 둔 정적 JSON(public/data/koima-price.json)을 읽는다.
     60개 품목 수집에 약 167초가 걸려 요청 시점에 수집하면 업데이트 버튼이 그만큼 멈추고
     Vercel 함수 한도(최대 60초)도 넘긴다. 파일로 두면 어디서나 즉시 로드된다.
     데이터 갱신은 `python koima_price.py` 를 돌려 이 파일을 다시 만드는 방식.
   저장 구조: categories[{no,key,label,items:[{no,name,unit,market,spotFutures,
              weekAvg,monthAvg,rows:[{date,price,domValue,domPct,wowValue,wowPct,
              momValue,momPct}]}]}]  */

// 정적 데이터 파일(상대경로). Flask(static_folder='.')·정적 서버·Vercel 모두 동일 경로로 서빙된다.
const KP_DATA_URL = 'public/data/koima-price.json';
// 부문 색(품목 단일 시리즈에 부문 색을 쓴다)
const KP_COLORS = {
  petchem: '#C8102E', textile: '#0EA5E9', steel: '#3B82F6',
  nonferrous: '#64748B', rare: '#DB2777',
};
// 1단계(데이터 없음)에서도 탭 이름을 보여주기 위한 폴백 라벨 + 표시 순서
const KP_TABS = [
  { key: 'petchem', label: '유화원료' }, { key: 'textile', label: '섬유원료' },
  { key: 'steel', label: '철강재' }, { key: 'nonferrous', label: '비철금속' },
  { key: 'rare', label: '희소금속' },
];
const KP_RANGES = [
  { key: '1m', label: '1개월', days: 30 }, { key: '6m', label: '6개월', days: 182 },
  { key: '1y', label: '1년', days: 365 }, { key: 'all', label: '전체', days: null },
];
const KP_DEFAULT_CAT = 'petchem';

let _kpData = null;    // {baseDate,categories:[...]} | {error} | null
let _kpCat = null;     // 선택 부문 key
let _kpItem = null;    // 선택 품목 no (숫자)
let _kpRange = null;   // 선택 기간(null=미선택 → "품목과 기간을 선택하세요")
let _kpChart = null;
let _kpBusy = false;   // 수집 진행 중(업데이트 버튼이 켠다)

/** 부문 찾기 */
function kpCatOf(key) {
  if (!_kpData || _kpData.error) return null;
  return _kpData.categories.find((c) => c.key === key) || null;
}

/** 표시 순서대로 정렬된 부문 목록 */
function kpCatsOrdered() {
  if (!_kpData || _kpData.error) return [];
  const cs = _kpData.categories;
  const known = KP_TABS.map((t) => cs.find((c) => c.key === t.key)).filter(Boolean);
  return known.concat(cs.filter((c) => !KP_TABS.some((t) => t.key === c.key)));
}

/** 선택 부문의 품목 찾기 */
function kpItemOf(cat, no) {
  if (!cat || !cat.items.length) return null;
  return cat.items.find((i) => String(i.no) === String(no)) || null;
}

/** 부문의 첫 품목 no (부문 변경 시 리셋용) */
function kpFirstItemNo(cat) {
  return (cat && cat.items.length) ? cat.items[0].no : null;
}

/** 기간 칩 → 표시할 rows. 마지막 날짜에서 N일 소급. */
function kpSliceRows(item) {
  if (!item || !item.rows.length || !_kpRange) return [];
  const rng = KP_RANGES.find((r) => r.key === _kpRange);
  if (!rng || rng.days == null) return item.rows;
  const end = new Date(item.rows[item.rows.length - 1].date + 'T00:00:00');
  const from = new Date(end.getTime() - rng.days * 86400000);
  const fromStr = from.toISOString().slice(0, 10);
  return item.rows.filter((r) => r.date >= fromStr);
}

/** 증감 표기: "10.00 (▲1.01%)" — ▲빨강 ▼파랑 */
function kpDelta(val, pct) {
  if (val == null && pct == null) return '<span class="kp-chg flat">–</span>';
  const v = val == null ? (pct || 0) : val;
  const cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'flat');
  const arrow = v > 0 ? '▲' : (v < 0 ? '▼' : '–');
  const av = val == null ? '-' : Math.abs(val).toFixed(2);
  const ap = pct == null ? '-' : Math.abs(pct).toFixed(2);
  return `<span class="kp-chg ${cls}">${av} (${arrow}${ap}%)</span>`;
}

/** 숫자 표기(가격) — 소수 2자리 + 천단위 구분 */
function kpPrice(v) {
  return v == null ? '-' : Number(v).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 응답 저장. 다른 카드 상태는 건드리지 않는다. */
function applyKoimaPriceUpdate(data) {
  if (data && data.status === 'ok' && Array.isArray(data.categories) && data.categories.length) {
    _kpData = { baseDate: data.baseDate, days: data.days, categories: data.categories,
      failures: data.failures || [] };
    if (!_kpCat) _kpCat = KP_DEFAULT_CAT;
    let cat = kpCatOf(_kpCat) || kpCatsOrdered()[0] || null;
    if (cat) { _kpCat = cat.key; if (_kpItem == null) _kpItem = kpFirstItemNo(cat); }
    const counts = data.categories.map((c) => `${c.label} ${c.items.length}개`).join(' · ');
    console.log('[koima-price] 기준일 %s · 부문별 품목 수: %s', data.baseDate, counts);
    if (_kpData.failures.length) {
      console.warn('[koima-price] 실패 %d건:', _kpData.failures.length, _kpData.failures);
    }
  } else {
    _kpData = { error: (data && data.reason) || '데이터 없음' };
  }
  renderMaterial();
}

/** 업데이트 버튼이 호출: 미리 수집해 둔 정적 JSON을 읽는다(즉시 완료).
 *  파일이 없으면(404) 수집 스크립트를 돌리라는 안내를 카드에 표시한다. */
async function fetchKoimaPrice() {
  _kpBusy = true;
  renderMaterial();
  try {
    const res = await fetch(KP_DATA_URL, { cache: 'no-store' });
    if (res.status === 404) throw new Error('데이터 파일 없음 — python koima_price.py 를 실행해 생성하세요');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _kpBusy = false;
    applyKoimaPriceUpdate(data);
  } catch (e) {
    _kpBusy = false;
    _kpData = { error: (e && e.message) || String(e) };
    console.warn('[koima-price] 로드 실패:', e, '(경로:', KP_DATA_URL, ')');
    renderMaterial();
  }
}

/** 요약 바 — 원본처럼 한 줄: 가격 / 단위 / 거래시장 / 현물·선물 / 전주평균 / 전월평균 / 전일·전주·전월비 */
function kpSummaryBar(item, rows) {
  if (!item || !rows.length) return '';
  const r = rows[rows.length - 1];
  const cell = (label, val) => `<div class="kp-sum__cell"><span class="kp-sum__k">${label}</span><span class="kp-sum__v">${val}</span></div>`;
  return `<div class="kp-sum">
    <div class="kp-sum__main">
      <span class="kp-sum__price">${kpPrice(r.price)}</span>
      <span class="kp-sum__unit">${escapeHtml(item.unit || '')}</span>
      <span class="kp-sum__date">${escapeHtml(r.date)} 기준</span>
    </div>
    <div class="kp-sum__grid">
      ${cell('거래시장', escapeHtml(item.market || '-'))}
      ${cell('현물/선물', escapeHtml(item.spotFutures || '-'))}
      ${cell('전주평균', kpPrice(item.weekAvg))}
      ${cell('전월평균', kpPrice(item.monthAvg))}
      ${cell('전일비', kpDelta(r.domValue, r.domPct))}
      ${cell('전주비', kpDelta(r.wowValue, r.wowPct))}
      ${cell('전월비', kpDelta(r.momValue, r.momPct))}
    </div>
  </div>`;
}

/* ── KOIMA 리포트 분석 (월간 부문별 지수 · 일일 국제원자재가격) ─────────────
   ★ AI/LLM 을 쓰지 않는다. 문장은 템플릿, 숫자는 화면에 이미 있는 값과 받아둔
     관측치에서 계산한다. 외부 호출이 없어 비용도 없다.
   ★★ 원인(중국 수요·공급망 등)은 이 데이터에 없다 — 한 줄도 지어내지 않는다.
     서술하는 것은 값 자체의 움직임뿐: 등락률·최고/최저·평균·역대 대비 수준.
   ★ 이 두 카드는 부문·품목·기간을 바꿀 때마다 renderMaterial() 이 다시 도므로
     리포트가 늘 현재 선택을 따라간다(유가 카드처럼 [조회] 단계가 없다). */
let _koimaReport = false;   // 월간 부문별 지수 리포트 펼침
let _kpReport = false;      // 일일 국제원자재가격 리포트 펼침

const KR_HI = 'var(--blue)';
const KR_LO = 'var(--accent)';
const KR_NOW = 'var(--ink)';

function krN(v, d) { return (v == null) ? '—' : Number(v).toFixed(d == null ? 2 : d); }
function krPct(v) { return (v == null) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function krWord(v) { return v == null ? '보합' : (v > 0 ? '상승' : (v < 0 ? '하락' : '보합')); }

/** 'YYYY-MM' / 'YYYY-MM-DD' → 축에 쓸 짧은 라벨 */
function krShort(p) {
  const s = String(p);
  return (s.length > 7) ? s.slice(2).replace(/-/g, '.') : s.slice(2).replace('-', '.');
}

/** 단위에 맞춘 원화 병기. 환산할 수 없는 단위(CNY·원 등)면 null.
    ★ 단위 판정은 이미 있는 krwFactor() 를 그대로 쓴다. */
function krKrw(v, unit) {
  const f = krwFactor(unit);
  if (f == null || v == null) return null;
  // ★ 축약(fmtKrwAxis)은 10,317원을 '1만'으로 줄여 본문에서 너무 뭉개진다.
  //   본문에는 만 단위 소수 한 자리까지 쓴다(제품 카드 opKrw 와 같은 규칙).
  const w = Number(v) * f, sign = w < 0 ? '-' : '', a = Math.abs(w);
  return (a >= 1e4) ? (sign + (a / 1e4).toFixed(1) + '만 원')
    : (sign + Math.round(a).toLocaleString('ko-KR') + '원');
}

/** 단일 계열 리포트 그래프 — 최고·최저·최근 3곳만 라벨을 단다.
    pts=[{p,v}] · fmt=값 표기 · unit=원화 병기용(없으면 병기 생략) */
function krChart(pts, fmt, unit) {
  const n = pts.length;
  if (n < 2) return '<div class="chart-empty">추이를 그릴 값이 부족합니다.</div>';
  const vals = pts.map((x) => x.v);
  let ymin = Math.min.apply(null, vals), ymax = Math.max.apply(null, vals);
  const yp = (ymax - ymin) * 0.18 || 5;
  ymin = Math.max(0, ymin - yp); ymax += yp;

  const W = VIZ_W, H = 176, padL = 46, padR = 16, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => padL + (i / (n - 1)) * plotW;
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;
  const kf = unit ? krwFactor(unit) : null;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val).toLocaleString('en-US')}</text>`
      + (kf ? vizKrwTick(padL - 6, y, val, kf) : '');
  }).join('');

  const xlab = orTickIdx(n, 6).map((i, k) =>
    `<text class="or-xlab${k % 2 ? ' or-xlab--alt' : ''}" x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="middle" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(krShort(pts[i].p))}</text>`).join('');

  let d = '';
  pts.forEach((x, i) => { d += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(x.v).toFixed(1)} `; });
  const line = `<path d="${d.trim()}" fill="none" stroke="var(--slate)" stroke-width="2" opacity=".55" stroke-linejoin="round" stroke-linecap="round"/>`;
  const dots = pts.map((x, i) =>
    `<circle cx="${X(i).toFixed(1)}" cy="${Y(x.v).toFixed(1)}" r="2" fill="var(--slate)" opacity=".5"/>`).join('');

  const mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
  const hiI = vals.indexOf(mx), loI = vals.indexOf(mn), nowI = n - 1;
  const put = (i, color, tag) => {
    if (i < 0) return '';
    const v = pts[i].v, x = X(i), y = Y(v), up = y > padT + 26;
    const ly = up ? y - 13 : y + 20;
    const kw = unit ? krKrw(v, unit) : null;
    return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${color}" stroke="var(--surface-1)" stroke-width="1.6"/>`
      + `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="800"`
      + ` paint-order="stroke" stroke="var(--surface-1)" stroke-width="3" fill="${color}">${escapeHtml(fmt(v))}</text>`
      + `<text x="${x.toFixed(1)}" y="${(up ? ly - 9 : ly + 9).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700"`
      + ` paint-order="stroke" stroke="var(--surface-1)" stroke-width="3" fill="${color}" opacity=".85">`
      + `${tag}${kw ? ' · 약 ' + escapeHtml(kw) : ''}</text></g>`;
  };
  let marks = put(hiI, KR_HI, '최고') + put(loI, KR_LO, '최저');
  if (nowI !== hiI && nowI !== loI) marks += put(nowI, KR_NOW, '최근');

  const legend = '<div class="srr-legend">'
    + '<span class="srr-lg"><i style="background:' + KR_HI + '"></i>최고</span>'
    + '<span class="srr-lg"><i style="background:' + KR_LO + '"></i>최저</span>'
    + '<span class="srr-lg"><i style="background:' + KR_NOW + '"></i>최근</span></div>';

  return legend
    + `<svg class="srr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="추이 · 최고 최저 최근 강조">`
    + grid + xlab + line + dots + marks
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/></svg>`;
}

/* ── 1) 월간 부문별 지수 ─────────────────────────────────────────────── */

/** 리포트 수치. 화면의 momPct/yoyPct 를 그대로 쓰고, 나머지는 관측치에서 계산한다. */
function krIndexData() {
  const cat = koimaCatOf(_koimaCat);
  if (!_koimaData || _koimaData.error || !cat || !_koimaRange) return null;
  const win = (koimaSliceRows() || []).filter((r) => r.index != null);
  if (!win.length) return null;
  const all = (cat.rows || []).filter((r) => r.index != null);
  const last = win[win.length - 1];
  // 최근 12개월 — 조회 구간이 아니라 '최신 월 기준 12개월'을 본다
  const li = all.map((r) => r.period).indexOf(last.period);
  const w12 = all.slice(Math.max(0, li - 11), li + 1);
  const v12 = w12.map((r) => r.index);
  const allMax = all.reduce((a, b) => (b.index > a.index ? b : a), all[0]);
  const wv = win.map((r) => r.index);
  return {
    cat: cat, win: win, all: all, last: last,
    hi12: w12.filter((r) => r.index === Math.max.apply(null, v12))[0],
    lo12: w12.filter((r) => r.index === Math.min.apply(null, v12))[0],
    n12: w12.length,
    allMax: allMax,
    ratio: allMax.index ? Math.round((last.index / allMax.index) * 1000) / 10 : null,
    avg: Math.round((wv.reduce((a, b) => a + b, 0) / wv.length) * 100) / 100,
    firstPeriod: all[0].period,
  };
}

/** 다른 부문의 최신 전월비만 간단히 나열 */
function krOtherCats() {
  return koimaCatsOrdered().map((c) => {
    const rows = (c.rows || []).filter((r) => r.index != null);
    const r = rows[rows.length - 1];
    return { key: c.key, label: c.label || c.key, pct: r ? r.momPct : null, period: r ? r.period : null };
  });
}

function krIndexHtml() {
  const d = krIndexData();
  if (!d) return '<div class="srr"><div class="chart-empty">리포트를 만들 관측치가 없습니다.</div></div>';
  const rangeLbl = (KOIMA_RANGES.find((r) => r.key === _koimaRange) || {}).label || '';
  const dir = d.last.momPct == null ? 'flat' : (d.last.momPct > 0 ? 'up' : (d.last.momPct < 0 ? 'down' : 'flat'));
  const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '—');

  const subs = [];
  if (d.last.yoyPct != null) {
    subs.push('전년 같은 달 대비로는 ' + krPct(d.last.yoyPct) + ' '
      + (d.last.yoyPct > 0 ? '높습니다.' : (d.last.yoyPct < 0 ? '낮습니다.' : '같습니다.')));
  }
  subs.push('최근 ' + d.n12 + '개월 중 가장 높았던 달은 ' + d.hi12.period + '(' + krN(d.hi12.index)
    + '), 가장 낮았던 달은 ' + d.lo12.period + '(' + krN(d.lo12.index) + ')입니다.');
  if (d.ratio != null) {
    subs.push('현재 지수는 역대 최고치(' + d.allMax.period + ', ' + krN(d.allMax.index)
      + ') 대비 ' + d.ratio.toFixed(1) + '% 수준입니다 (' + d.firstPeriod + '부터 집계).');
  }
  subs.push('조회 구간(' + d.win[0].period + ' ~ ' + d.last.period + ' · ' + d.win.length
    + '개월) 평균은 ' + krN(d.avg) + '입니다.');

  const others = krOtherCats().map((c) => {
    const cls = c.pct == null ? '' : (c.pct > 0 ? ' oc-up' : (c.pct < 0 ? ' oc-down' : ''));
    return '<span class="kr-oth' + (c.key === _koimaCat ? ' is-me' : '') + '">'
      + escapeHtml(c.label) + '<b class="' + cls.trim() + '">' + krPct(c.pct) + '</b></span>';
  }).join('');

  const sum = [];
  sum.push(d.last.period + ' ' + d.cat.label + ' 지수는 ' + krN(d.last.index) + '로 전월 대비 '
    + krPct(d.last.momPct) + ' ' + krWord(d.last.momPct) + '했고'
    + (d.last.yoyPct != null ? ', 전년 같은 달보다는 ' + krPct(d.last.yoyPct) + ' '
      + (d.last.yoyPct > 0 ? '높습니다.' : '낮습니다.') : '입니다.'));
  if (d.ratio != null) {
    sum.push('역대 최고치(' + d.allMax.period + ' ' + krN(d.allMax.index) + ') 대비 '
      + d.ratio.toFixed(1) + '% 수준이며, 최근 ' + d.n12 + '개월 범위는 '
      + krN(d.lo12.index) + ' ~ ' + krN(d.hi12.index) + '입니다.');
  }

  return '<div class="srr">'
    + '<div class="srr-head">리포트 분석 <span class="srr-scope">'
    + escapeHtml(d.cat.label) + ' · ' + escapeHtml(_koimaData.baseline || '') + '</span></div>'
    + '<p class="srr-cond"><b>현재 조회 조건</b> · 부문 ' + escapeHtml(d.cat.label)
    + ' · 기간 ' + escapeHtml(rangeLbl) + ' (' + escapeHtml(d.win[0].period) + ' ~ '
    + escapeHtml(d.last.period) + ' · ' + d.win.length + '개월)</p>'
    + '<p class="srr-def">KOIMA 부문별 지수란 수입 원자재 가격을 부문별로 묶어 지수로 만든 값으로, '
    + escapeHtml(_koimaData.baseline || '') + '입니다.</p>'
    + '<div class="srr-hero"><div class="srr-hero__when">' + escapeHtml(d.last.period + ' · ' + d.cat.label) + '</div>'
    + '<div class="srr-hero__row"><span class="srr-hero__v">' + krN(d.last.index) + '</span>'
    + '<span class="srr-hero__d srr-' + dir + '">' + arrow + ' '
    + escapeHtml(krPct(d.last.momPct == null ? null : Math.abs(d.last.momPct)).replace('+', ''))
    + '<span class="srr-hero__vs">전월 대비</span></span></div></div>'
    + subs.map((t) => '<p class="srr-p">' + escapeHtml(t) + '</p>').join('')
    + '<div class="srr-chart">' + krChart(d.win.map((r) => ({ p: r.period, v: r.index })),
      (v) => krN(v), null) + '</div>'
    + '<h4 class="srr-h">다른 부문도 함께 보기 <span class="srr-hint">각 부문의 최신 전월비</span></h4>'
    + '<div class="kr-oths">' + others + '</div>'
    + '<div class="srr-sum"><div class="srr-sum__h">총 내용 정리</div>'
    + sum.map((t) => '<p class="srr-sum__p">' + escapeHtml(t) + '</p>').join('')
    + '</div></div>';
}

/* ── 2) 일일 국제원자재가격 ──────────────────────────────────────────── */

/** period <= target 인 마지막 행 */
function krAtOrBefore(rows, target) {
  let hit = null;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].date <= target) hit = rows[i]; else break;
  }
  return hit;
}

function krPriceData() {
  const cat = kpCatOf(_kpCat);
  const item = kpItemOf(cat, _kpItem);
  if (!_kpData || _kpData.error || !item || !_kpRange) return null;
  const win = (kpSliceRows(item) || []).filter((r) => r.price != null);
  if (!win.length) return null;
  const all = (item.rows || []).filter((r) => r.price != null);
  const last = win[win.length - 1];
  const vals = win.map((r) => r.price);
  const mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
  // ★ 전년동일비는 원본에 없다(전일·전주·전월비만 온다). 받아둔 3년치에서 직접 계산한다.
  const yoyBase = krAtOrBefore(all, opShift(last.date, -1, 0, 0));
  return {
    cat: cat, item: item, win: win, all: all, last: last,
    hi: win.filter((r) => r.price === mx)[0], lo: win.filter((r) => r.price === mn)[0],
    avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
    yoy: (yoyBase && yoyBase.date !== last.date && yoyBase.price)
      ? { base: yoyBase, value: Math.round((last.price - yoyBase.price) * 100) / 100,
        pct: Math.round(((last.price - yoyBase.price) / yoyBase.price) * 10000) / 100 }
      : null,
  };
}

function krPriceHtml() {
  const d = krPriceData();
  if (!d) return '<div class="srr"><div class="chart-empty">리포트를 만들 관측치가 없습니다.</div></div>';
  const u = d.item.unit || '';
  const rangeLbl = (KP_RANGES.find((r) => r.key === _kpRange) || {}).label || '';
  const dir = d.last.domPct == null ? 'flat' : (d.last.domPct > 0 ? 'up' : (d.last.domPct < 0 ? 'down' : 'flat'));
  const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '—');
  const withKrw = (v) => krN(v) + ' ' + u + (krKrw(v, u) ? ' (약 ' + krKrw(v, u) + '/' + u.split('/')[1] + ')' : '');

  const subs = [];
  subs.push(d.item.name + '는 ' + (d.item.market || '-') + ' 시장에서 '
    + (d.item.spotFutures || '현물') + '로 거래되며, 단위는 ' + u + '입니다.');
  const cmp = [];
  if (d.last.wowPct != null) cmp.push('전주 대비 ' + krPct(d.last.wowPct));
  if (d.last.momPct != null) cmp.push('전월 같은 날 대비 ' + krPct(d.last.momPct));
  if (d.yoy) cmp.push('전년 같은 날(' + d.yoy.base.date + ') 대비 ' + krPct(d.yoy.pct));
  if (cmp.length) subs.push(cmp.join(', ') + ' 수준입니다.');
  subs.push('조회 기간 최고가는 ' + d.hi.date + ' ' + withKrw(d.hi.price)
    + ', 최저가는 ' + d.lo.date + ' ' + withKrw(d.lo.price) + '입니다.');
  subs.push('조회 기간(' + d.win[0].date + ' ~ ' + d.last.date + ' · ' + d.win.length
    + '일) 평균은 ' + withKrw(d.avg) + '입니다.');

  const sum = [];
  sum.push(d.last.date + ' ' + d.item.name + ' 가격은 ' + withKrw(d.last.price)
    + '로 전일 대비 ' + krPct(d.last.domPct) + ' ' + krWord(d.last.domPct) + '했습니다.');
  const s2 = [];
  if (d.last.wowPct != null) s2.push('전주 ' + krPct(d.last.wowPct));
  if (d.last.momPct != null) s2.push('전월 ' + krPct(d.last.momPct));
  if (d.yoy) s2.push('전년 ' + krPct(d.yoy.pct));
  if (s2.length) sum.push('비교 기준별로는 ' + s2.join(' · ') + '이며, 거래시장은 '
    + (d.item.market || '-') + '입니다.');
  sum.push('조회 기간 범위는 ' + krN(d.lo.price) + ' ~ ' + krN(d.hi.price) + ' ' + u
    + ', 평균은 ' + krN(d.avg) + ' ' + u + '입니다.');

  return '<div class="srr">'
    + '<div class="srr-head">리포트 분석 <span class="srr-scope">'
    + escapeHtml(d.item.name + ' · ' + (d.item.market || '-') + ' · ' + u) + '</span></div>'
    + '<p class="srr-cond"><b>현재 조회 조건</b> · 부문 ' + escapeHtml(d.cat ? d.cat.label : '-')
    + ' · 품목 ' + escapeHtml(d.item.name) + ' · 기간 ' + escapeHtml(rangeLbl)
    + ' (' + escapeHtml(d.win[0].date) + ' ~ ' + escapeHtml(d.last.date) + ' · ' + d.win.length + '일)</p>'
    + '<p class="srr-def">KOIMA 일일 국제원자재가격이란 주요 원자재의 거래시장별 하루 시세로, '
    + '품목마다 거래되는 시장과 단위가 다릅니다.</p>'
    + '<div class="srr-hero"><div class="srr-hero__when">' + escapeHtml(d.last.date + ' · ' + d.item.name) + '</div>'
    + '<div class="srr-hero__row"><span class="srr-hero__v">' + krN(d.last.price) + '</span>'
    + '<span class="srr-hero__unit">' + escapeHtml(u) + '</span>'
    + '<span class="srr-hero__d srr-' + dir + '">' + arrow + ' '
    + escapeHtml(krPct(d.last.domPct == null ? null : Math.abs(d.last.domPct)).replace('+', ''))
    + '<span class="srr-hero__vs">전일 대비</span></span></div>'
    + (krKrw(d.last.price, u) ? '<div class="srr-hero__krw">≈ 약 ' + escapeHtml(krKrw(d.last.price, u))
      + '/' + escapeHtml(u.split('/')[1] || '') + '</div>' : '')
    + '</div>'
    + subs.map((t) => '<p class="srr-p">' + escapeHtml(t) + '</p>').join('')
    + '<div class="srr-chart">' + krChart(d.win.map((r) => ({ p: r.date, v: r.price })),
      (v) => krN(v), u) + (krwFactor(u) != null ? krwNote('USD') : '') + '</div>'
    + '<div class="srr-sum"><div class="srr-sum__h">총 내용 정리</div>'
    + sum.map((t) => '<p class="srr-sum__p">' + escapeHtml(t) + '</p>').join('')
    + '</div></div>';
}

/** 카드 HTML — 3단계 빈 상태 */
function renderKoimaPriceHtml() {
  const head = `<div class="viz-head"><div>
      <div class="viz-title">일일 국제원자재가격 (KOIMA)</div>
      <div class="viz-sub">부문별 주요 품목 일별 가격</div>
    </div></div>`;
  const cap = capSrc('출처: 한국수입협회 국제원자재가격정보', SRC_LINKS.koimaPrice);
  const ok = _kpData && !_kpData.error && _kpData.categories.length;
  const cat = ok ? kpCatOf(_kpCat) : null;
  const item = ok ? kpItemOf(cat, _kpItem) : null;
  const dis = ok ? '' : ' disabled';

  // 1) 부문 탭 5개
  const tabSrc = ok ? kpCatsOrdered() : KP_TABS;
  const tabs = `<div class="icis-years kp-tabs">${tabSrc.map((c) =>
    `<button class="icis-year kp-tab${c.key === _kpCat ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-cat="${escapeHtml(c.key)}"${dis}>${escapeHtml(c.label)}</button>`).join('')}</div>`;

  // 2) 품목 드롭다운 — 선택된 부문의 품목만
  const opts = (ok && cat) ? cat.items.map((i) =>
    `<option value="${escapeHtml(String(i.no))}"${String(i.no) === String(_kpItem) ? ' selected' : ''}>${escapeHtml(i.name)}</option>`).join('') : '';
  const controls = `<div class="kp-controls">
    <label class="kp-sel"><span>품목</span>
      <select class="kp-item"${dis}>${opts}</select></label>
    ${(ok && cat) ? `<span class="kp-meta">${escapeHtml(cat.label)} ${cat.items.length}개 품목${_kpData.baseDate ? ` · 기준일 ${escapeHtml(_kpData.baseDate)}` : ''}</span>` : ''}
  </div>`;

  // 3) 기간 칩
  const rptBtn = (ok && _kpRange && item)
    ? `<button type="button" class="oc-tool or-btn kp-report${_kpReport ? ' is-on' : ''}"
        data-kp-report="1" aria-expanded="${_kpReport ? 'true' : 'false'}">📊 리포트 분석</button>`
    : '';
  const chips = `<div class="icis-years kp-ranges">${KP_RANGES.map((r) =>
    `<button class="icis-year kp-range${r.key === _kpRange ? ' is-active' : ''}${ok ? '' : ' is-disabled'}" data-range="${r.key}"${dis}>${r.label}</button>`).join('')}${rptBtn}</div>`;

  let body;
  if (_kpBusy) {                                    // 로드 중
    body = '<div class="icis-prompt kp-busy">국제원자재가격을 불러오는 중입니다…</div>';
  } else if (!_kpData) {                            // 1) 데이터 없음
    body = '<div class="chart-empty">업데이트 버튼을 눌러 데이터를 불러오세요</div>';
  } else if (_kpData.error) {
    body = `<div class="chart-empty">데이터를 불러오지 못했습니다 (${escapeHtml(_kpData.error)})</div>`;
  } else if (!_kpRange || !item) {                  // 2) 데이터 있음 · 미선택
    body = '<div class="icis-prompt">품목과 기간을 선택하세요</div>';
  } else {                                          // 3) 선택됨
    const rows = kpSliceRows(item);
    body = kpSummaryBar(item, rows) + buildKpChart(rows, item, cat)
      + '<div class="viz-tooltip" id="kpTooltip"></div>' + kpRecentTable(rows, item)
      + (_kpReport ? krPriceHtml() : '');
  }
  const warn = (ok && _kpData.failures && _kpData.failures.length)
    ? `<div class="kp-warn">일부 품목 수집 실패 ${_kpData.failures.length}건 (해당 품목은 목록에서 제외)</div>` : '';
  return `<div class="viz-root viz-figure kp-figure">${head}${tabs}${controls}${chips}${body}${warn}${cap}</div>`;
}

/** 단일 품목 일별 선그래프 (dot 없음, Y축 auto) */
function buildKpChart(rows, item, cat) {
  const n = rows.length;
  if (!n || !item) { _kpChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }
  const color = KP_COLORS[cat && cat.key] || 'var(--accent)';
  const dates = rows.map((r) => r.date);
  const values = rows.map((r) => (r.price == null ? null : r.price));
  const all = values.filter((v) => v != null);
  if (!all.length) { _kpChart = null; return '<div class="chart-empty">표시할 데이터가 없습니다.</div>'; }

  // domain ['auto','auto'] — 0으로 내리지 않는다
  let ymin = Math.min(...all), ymax = Math.max(...all);
  const yp = (ymax - ymin) * 0.08 || Math.max(0.5, ymax * 0.05);
  ymin -= yp; ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 48, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const dec = (ymax - ymin) < 20 ? 2 : 0;   // 값 폭이 좁으면 소수 표시
  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${val.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}</text>${vizKrwTick(padL - 6, y, val, krwFactor(item.unit))}`;
  }).join('');

  // 날짜 라벨은 'YYYY-MM-DD'(10자)로 가장 길어 간격을 더 넓게 잡는다
  const xticks = vizTickIdx(n, plotW, 108).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(dates[i])}</text>`;
  }).join('');

  let d = '', started = false;
  values.forEach((v, i) => {
    if (v == null) return;
    d += `${started ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; started = true;
  });
  const line = d ? `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` : '';

  _kpChart = { dates, values, label: item.name, unit: item.unit, color, geom: { X, Y, n, W, padL } };
  console.log('[koima-price] 차트 · %s · %s~%s · %d개 점', item.name, dates[0], dates[n - 1], n);

  return `<div class="viz-legend kp-legend"><span class="viz-legend__item">
      <span class="viz-legend__swatch" style="background:${color}"></span>${escapeHtml(item.name)}${item.unit ? ` (${escapeHtml(item.unit)})` : ''}</span></div>
    <svg class="viz-svg kp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(item.name)} 일별 가격">
      ${grid}${xticks}${line}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="kp-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="kp-dots"></g>
      <rect class="kp-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 최근 12일 표 — 2열(6행씩), 최신일이 왼쪽 위 */
function kpRecentTable(rows, item) {
  if (!rows.length || !item) return '';
  const recent = rows.slice(-12).reverse();
  const half = Math.ceil(recent.length / 2);
  const left = recent.slice(0, half), right = recent.slice(half);
  const cells = (r) => (r
    ? `<td class="kp-t__d">${escapeHtml(r.date)}</td>
       <td class="kp-t__v">${kpPrice(r.price)}</td>
       <td>${kpDelta(r.domValue, r.domPct)}</td>
       <td>${kpDelta(r.wowValue, r.wowPct)}</td>
       <td>${kpDelta(r.momValue, r.momPct)}</td>`
    : '<td colspan="5" class="kp-t__blank"></td>');
  const body = left.map((r, i) => `<tr>${cells(r)}${cells(right[i])}</tr>`).join('');
  const hg = '<th>기간</th><th>품목별 가격</th><th>전일비(%)</th><th>전주비(%)</th><th>전월비(%)</th>';
  return `<h3 class="subhead kp-t__head">${escapeHtml(item.name)} 최근 ${recent.length}일</h3>
    <div class="kp-t__wrap"><table class="kp-t">
      <thead><tr>${hg}${hg}</tr></thead><tbody>${body}</tbody>
    </table></div>`;
}

/** 크로스헤어 + 툴팁 (날짜 · 품목 · 가격) */
function wireKpChart() {
  const fig = document.querySelector('#materialRoot .kp-figure');
  const tip = document.getElementById('kpTooltip');
  if (!fig || !tip || !_kpChart) return;
  const svg = fig.querySelector('.kp-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.kp-overlay');
  const cross = svg.querySelector('.kp-cross');
  const dots = svg.querySelector('.kp-dots');
  const c = _kpChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const v = c.values[i];
    if (v == null) { clear(); return; }
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    dots.innerHTML = `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3" fill="${c.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.dates[i])}</div>
      <div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${c.color}"></span><span>${escapeHtml(c.label)}</span><span class="viz-tt-val">${kpPrice(v)}${c.unit ? ' ' + escapeHtml(c.unit) : ''}</span></div>`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/** 탭·품목·기간 이벤트 (검색 버튼 없음 — 바꾸면 즉시 다시 그린다) */
function wireKpControls(root) {
  const fig = root.querySelector('.kp-figure');
  if (!fig) return;
  const tabsEl = fig.querySelector('.kp-tabs');
  if (tabsEl) tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.kp-tab');
    if (!b || b.disabled) return;
    _kpCat = b.dataset.cat;
    _kpItem = kpFirstItemNo(kpCatOf(_kpCat));   // 부문 변경 시 첫 품목으로 리셋
    renderMaterial();
  });
  const selEl = fig.querySelector('.kp-item');
  if (selEl) selEl.addEventListener('change', () => {
    _kpItem = selEl.value;
    renderMaterial();
  });
  const chipsEl = fig.querySelector('.kp-ranges');
  if (chipsEl) chipsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.kp-range');
    if (!b || b.disabled) return;
    _kpRange = b.dataset.range;
    renderMaterial();
  });
  const kprBtn = fig.querySelector('.kp-report');
  if (kprBtn) kprBtn.addEventListener('click', () => { _kpReport = !_kpReport; renderMaterial(); });
  if (_kpRange && _kpData && !_kpData.error && !_kpBusy) wireKpChart();
}


/* ── 국내외 브랜드 신제품 (Google News RSS) ── */
let _domestic = null;         // 국내 items
let _domesticFeatured = null; // 국내 대표 상품
let _globalBrands = null;     // 국외 items
let _globalFeatured = null;   // 국외 대표 상품

// 브랜드별 포인트 색 (배지 강조)
const DOM_BRAND_COLORS = {
  '에이스침대': 'var(--blue)', '씰리': 'var(--violet)', '한샘': 'var(--green)', '이케아': 'var(--amber)',
  'Sleep Number': 'var(--blue)', 'Tempur-Pedic': 'var(--green)', 'Purple': 'var(--violet)', 'Serta': 'var(--amber)',
};

/** 응답의 domestic 저장 */
function applyDomesticUpdate(data) {
  const dm = data && data.sections && data.sections.domestic;
  if (!dm) return;
  if (dm.status === 'error') { _domestic = null; _domesticFeatured = null; console.warn('[update] domestic error:', dm.reason); }
  else { _domestic = dm.items || []; _domesticFeatured = (dm.featured && dm.featured.length) ? dm.featured : _domestic.slice(0, 3); }
  renderBrands();
}

/** 응답의 global_brands 저장 */
function applyGlobalBrandsUpdate(data) {
  const gb = data && data.sections && data.sections.global_brands;
  if (!gb) return;
  if (gb.status === 'error') { _globalBrands = null; _globalFeatured = null; console.warn('[update] global_brands error:', gb.reason); }
  else { _globalBrands = gb.items || []; _globalFeatured = (gb.featured && gb.featured.length) ? gb.featured : _globalBrands.slice(0, 3); }
  renderBrands();
}

/** 대표 출시 상품 카드 3개 HTML (사진 > Clearbit 로고 > 파비콘 > 브랜드명) */
function brandFeatureCards(featList, colors) {
  return featList.map((it) => {
    const url = safeUrl(it.link);
    const img = safeUrl(it.image);
    const logo = safeUrl(it.logo_url);
    const logo2 = safeUrl(it.logo_fallback);
    const color = colors[it.brand] || 'var(--accent)';
    const brand = String(it.brand || '');
    const name = String(it.product_name || it.title || '').trim();
    const meta = [it.source, it.date].filter(Boolean).join(' · ');
    const mkLogo = (u) => u
      ? `<img class="prod-card__logo" src="${escapeHtml(u)}" alt="${escapeHtml(brand)} 로고" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const imgTag = img
      ? `<img class="prod-card__img" src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const tag = url ? 'a' : 'div';
    const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="prod-card"${attrs}>
      <div class="prod-card__photo" style="--dom-c:${color}">
        <span class="prod-card__ph">${escapeHtml(brand)}</span>
        ${mkLogo(logo2)}${mkLogo(logo)}${imgTag}
      </div>
      <div class="prod-card__body">
        <div class="prod-card__brand" style="color:${color}">${escapeHtml(brand)}</div>
        <div class="prod-card__name">${escapeHtml(name)}</div>
        ${meta ? `<div class="prod-card__meta">${escapeHtml(meta)}</div>` : ''}
      </div>
    </${tag}>`;
  }).join('');
}

/** 기사 목록 HTML ([브랜드] 제목 + 출처·날짜) */
function brandListItems(items, colors) {
  return items.map((it) => {
    const url = safeUrl(it.link);
    const img = safeUrl(it.image);
    const color = colors[it.brand] || 'var(--accent)';
    const brand = String(it.brand || '');
    const meta = [it.source, it.date].filter(Boolean).join(' · ');
    let title = String(it.title || '');
    if (it.source && title.endsWith(' - ' + it.source)) title = title.slice(0, -(it.source.length + 3));
    if (brand) {
      const bre = new RegExp('^\\s*' + brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[,·:\\-]?\\s*');
      const stripped = title.replace(bre, '').trim();
      if (stripped) title = stripped;
    }
    const logo = safeUrl(it.logo_url);
    const logo2 = safeUrl(it.logo_fallback);
    const initial = brand ? brand.charAt(0) : '·';
    if (brand && !logo && !logo2) console.warn('[brands] 로고 URL 없음(첫글자 폴백):', brand);
    // 썸네일 스택(뒤→앞): 첫글자 → 파비콘 → Clearbit 로고 → 기사 사진
    const mkLogo = (u) => u
      ? `<img class="dom-thumb__logo" src="${escapeHtml(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const imgTag = img
      ? `<img class="dom-thumb__img" src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    const tag = url ? 'a' : 'div';
    const attrs = url ? ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"` : '';
    return `<${tag} class="dom-item${url ? '' : ' dom-item--nolink'}"${attrs}>
      <div class="dom-thumb" style="--dom-c:${color}">
        <span class="dom-thumb__ini">${escapeHtml(initial)}</span>
        ${mkLogo(logo2)}${mkLogo(logo)}${imgTag}
      </div>
      <div class="dom-item__body">
        <h3 class="dom-item__title"><span class="dom-brand" style="color:${color}">[${escapeHtml(brand)}]</span> ${escapeHtml(title)}</h3>
        <div class="dom-item__meta">${escapeHtml(meta)}</div>
      </div>
    </${tag}>`;
  }).join('');
}

/* ── 국내 신제품 카테고리 분류 (규칙 기반 · AI 미사용 · 무료) ──────────────
   ★ 수집기(api/update.py)는 손대지 않는다. 이미 받아 둔 기사 제목·상품명에서
     키워드를 찾아 화면에서 분류만 한다. 외부 호출이 없으므로 비용도 없다.
   ★★ 억지로 끼워 맞추지 않는다. 어느 키워드에도 걸리지 않으면 '기타(미분류)'로
     남긴다 — 매트리스 본품 기사는 프레임도 베딩도 아니므로 여기로 간다.
     (하이엔드/프리미엄 때처럼 없는 분류를 지어내지 않는다) */

// 대분류 → 소분류. 화면 버튼도 이 표에서 만들어진다(문구를 코드 여기저기 적지 않는다).
const DOM_CATS = [
  { key: 'mattress', label: '매트리스', subs: [
    { key: 'frame', label: '프레임' },
    { key: 'bedding', label: '베딩' },
    { key: 'body', label: '매트리스 본체' },
  ] },
  { key: 'sleeptech', label: '슬립테크', subs: [
    { key: 'wearable', label: '웨어러블' },
    { key: 'stetc', label: '기타' },
  ] },
];
const DOM_OTHER = { key: 'other', label: '기타', note: '(미분류)' };

/* 슬립테크 기업. 이 브랜드 기사는 대분류를 '슬립테크'로 고정한다.
   ★★ 왜 필요한가: 이 회사들의 기사는 제품 이름이 아니라 '유통 계약·MOU·임상
     등록·플랫폼 공개'를 다룬다. 제품 종류 낱말이 없어 키워드로는 잡히지 않지만,
     슬립테크 기사인 것은 분명하다. 그래서 소분류가 애매하면 '슬립테크 > 기타'로
     받고, 대분류만은 놓치지 않는다.
   ★ 매트리스 브랜드는 넣지 않는다 — 코웨이 비렉스·Sleep Number 는 슬립테크
     카드에도 실려 있지만 본업이 매트리스라 기사도 매트리스 쪽이다. */
const DOM_SLEEPTECH_BRANDS = [
  '에이슬립', '허니냅스', '웰트', '텐마인즈', '삼분의일',            // 국내
  'Eight Sleep', 'Oura', 'ResMed', 'Whoop', 'Withings',            // 국외
];

/* 소분류별 키워드. 제목·상품명에서 찾는다. 국내(한국어)·국외(영어) 공용이다.
   ★ 붙여쓰기/띄어쓰기를 모두 적어 둔다 — 기사 제목의 표기가 제각각이라
     한쪽만 적으면 놓친다('베드프레임' vs '베드 프레임').
   ★★ 영문 키워드는 낱말 경계로 찾는다(domHasKw). 부분 일치로 두면
     'ring' 이 'spring'·'during' 에, 'band' 가 'brand' 에 걸린다.
   ★★ 정의 순서가 곧 동점일 때의 우선순위다. body(매트리스 본체)를
     맨 뒤에 둔 이유: '침대 프레임'·'mattress cover'처럼 body 키워드
     ('침대'·'mattress')를 품은 말이 많아서, 같은 수로 걸리면 더 좁은
     분류(프레임·베딩)가 이겨야 한다. */
const DOM_RULES = {
  frame: ['프레임', '베드프레임', '베드 프레임', '헤드보드', '헤드 보드',
    '침대틀', '침대 틀', '침대 프레임', '저상형', '평상형',
    '수납침대', '수납 침대', '벙커침대', '벙커 침대', '철제침대', '철제 침대',
    '붙박이', '원목침대', '원목 침대', '슬랫',
    '모션베드', '모션 베드', '전동베드', '전동 베드',
    '리클라이닝베드', '리클라이닝 베드', '리클라이너',
    // 영문
    'frame', 'frames', 'bed frame', 'bedframe', 'headboard', 'footboard',
    'slats', 'platform bed', 'bunk bed', 'adjustable base', 'adjustable bases',
    'adjustable bed', 'recliner', 'bed base'],
  bedding: ['이불', '차렵', '차렵이불', '누비이불', '패딩이불', '패딩 이불',
    '극세사이불', '극세사 이불', '구스이불', '구스 이불', '거위털', '구스다운',
    '침구', '침구류', '베개', '베갯잇', '필로우', '경추베개', '경추 베개',
    '라텍스베개', '라텍스 베개', '메모리폼베개', '메모리폼 베개',
    '토퍼', '패드', '매트리스커버', '매트리스 커버', '침대커버', '침대 커버',
    '침대시트', '침대 시트', '린넨', '리넨',
    // ★ '마이크'(웨어러블)와 겹치는 '마이크로파이버'를 여기에도 둔다 —
    //   극세사 침구 기사가 웨어러블로 새지 않게 베딩 쪽 점수를 올려 준다.
    '마이크로파이버', '마이크로화이버',
    // 영문
    'bedding', 'pillow', 'pillows', 'pillowcase', 'duvet', 'comforter',
    'sheet', 'sheets', 'blanket', 'quilt', 'linen', 'linens',
    'mattress cover', 'mattress protector', 'topper', 'mattress topper'],
  // 웨어러블 / 디지털 수면측정 — 착용형에 한정하지 않는다. 비접촉·앱·진단까지.
  wearable: ['스마트링', '스마트 링', '슬립링', '슬립 링',
    '스마트워치', '스마트 워치', '워치',
    '스마트밴드', '스마트 밴드', '밴드', '웨어러블',
    '수면추적', '수면 추적', '수면추적기', '수면 추적기',
    '수면모니터링', '수면 모니터링', '트래커', '반지형',
    '링 디바이스', '링디바이스',
    // 비접촉·소리 기반 측정(에이슬립 '숨소리만으로 수면 측정' 유형)
    '비접촉', '마이크', '호흡음', '호흡분석', '호흡 분석', '숨소리',
    '수면측정', '수면 측정', '수면분석', '수면 분석',
    // AI·데이터·진단
    'ai 수면', '수면 ai', '수면단계', '수면 단계', '코골이',
    '수면무호흡', '수면 무호흡', '무호흡',
    '수면데이터', '수면 데이터', '수면다원검사',
    '수면진단', '수면 진단', '원격진단', '원격 진단',
    // 앱·디지털 기기(처방 앱 유형)
    '앱기반', '앱 기반', '처방앱', '처방 앱',
    '디지털치료기기', '디지털 치료기기', '디지털의료기기', '디지털 의료기기',
    // 영문
    'wearable', 'wearables', 'smart ring', 'ring', 'rings',
    'smartwatch', 'smart watch', 'watch', 'band', 'strap',
    'tracker', 'trackers', 'tracking', 'sleep tracking', 'sleep score',
    'sensor', 'sensors', 'contactless', 'snoring', 'apnea', 'sleep apnea',
    'cpap', 'polysomnography', 'psg', 'sleep stage', 'sleep stages',
    'sleep data', 'monitoring', 'diagnosis', 'digital therapeutic',
    'digital therapeutics', 'dtx'],
  // ★ 맨 뒤 — 위 어느 분류에도 더 좁게 걸리지 않은 '매트리스 자체' 기사를 받는다.
  body: ['매트리스', '침대', '하이브리드', '스프링', '포켓스프링', '포켓 스프링',
    '본넬스프링', '본넬 스프링', '메모리폼', '라텍스', '폼매트리스', '폼 매트리스',
    '미디엄하드', '미디엄 하드', '미디엄펌', '경도', '양면매트리스', '양면 매트리스',
    // 영문
    'mattress', 'mattresses', 'bed', 'beds', 'hybrid', 'innerspring',
    'pocket spring', 'coil', 'coils', 'memory foam', 'foam', 'latex',
    'firmness', 'medium-firm', 'smart bed', 'smart mattress'],
};

/* 슬립테크 대분류 안에서 키워드로 고를 소분류.
   ★ 향수·약은 요청에 따라 없앴다(실데이터 0건이라 옮길 기사도 없었다).
     남은 것은 웨어러블 하나뿐이고, 여기 안 걸리면 '슬립테크 > 기타'가 받는다. */
const DOM_ST_SUBS = ['wearable'];

/* 제품이 아니라 행사·판촉을 다루는 기사인지 가늠하는 낱말(미분류 사유 설명용).
   ★ 이걸로 분류하지 않는다. 왜 안 걸렸는지 설명할 때만 쓴다. */
const DOM_EVENT_WORDS = ['캠페인', '기념', '주년', '행사', '프로모션', '이벤트',
  '특가', '할인', '세일', '팝업', '전시', '후원', '협약', '수상',
  'sale', 'campaign', 'anniversary', 'coupon', 'coupons', 'deal', 'deals',
  'discount', 'partner', 'partnership', 'award', 'awards'];

/** 소분류 key → {대분류, 소분류} 라벨 (breadcrumb·콘솔용) */
function domSubMeta(sub) {
  for (let i = 0; i < DOM_CATS.length; i += 1) {
    const hit = DOM_CATS[i].subs.filter((s) => s.key === sub)[0];
    if (hit) return { cat: DOM_CATS[i], sub: hit };
  }
  return null;
}

/** 키워드 한 개가 본문에 있는지.
    ★★ 영문·숫자가 든 키워드는 낱말 경계로 본다 — 부분 일치로 두면
      'ring' 이 'spring'·'during' 에, 'band' 가 'brand' 에, 'bed' 가
      'bedding' 에 걸려 분류가 무너진다.
    ★ 한글 키워드는 조사가 붙으므로 부분 일치로 둔다('침구를', '이불은'). */
function domHasKw(text, w) {
  const k = String(w).toLowerCase();
  if (!k) return false;
  if (/[a-z0-9]/.test(k)) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(text);
  }
  return text.indexOf(k) >= 0;
}

/** 키워드를 찾을 본문. 브랜드명과 끝의 '- 언론사'는 빼고 본다.
    ★★ 브랜드명을 빼는 게 핵심이다. 국내 브랜드에 '씰리침대·에이스침대'처럼
      '침대'가 박혀 있고, 국외에도 'Sleep Number'·'Eight Sleep' 처럼 'sleep',
      'Serta Simmons Bedding' 처럼 'bedding' 이 박혀 있다. 그대로 두면
      어떤 기사든 브랜드명 때문에 걸린다(브랜드는 제품 종류를 알려 주지 않는다). */
function domSearchText(it) {
  let t = String(it.title || '');
  const src = String(it.source || '');
  if (src && t.endsWith(' - ' + src)) t = t.slice(0, -(src.length + 3));
  t = [t, it.product_name].filter(Boolean).join(' ');
  const brand = String(it.brand || '').trim();
  if (brand) {
    // 대소문자를 가리지 않고 지운다('EIGHT SLEEP'·'eight sleep' 표기 차이)
    const esc = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(esc, 'gi'), ' ');
  }
  return t;
}

/** 이 기사가 슬립테크 기업 것인지. 브랜드 칸과 제목 어디에 있어도 잡는다.
    (제휴 기사는 브랜드가 상대 회사로 잡히기도 한다 —
     "에이슬립·텐마인즈 협력…"의 브랜드 칸은 텐마인즈였다) */
function domSleeptechBrand(it) {
  const hay = (String(it.brand || '') + ' ' + String(it.title || '')
    + ' ' + String(it.product_name || '')).toLowerCase();
  return DOM_SLEEPTECH_BRANDS.filter((b) => hay.indexOf(b.toLowerCase()) >= 0)[0] || null;
}

/** 주어진 소분류 후보들 중 걸린 키워드가 가장 많은 것. 없으면 null.
    같은 수면 DOM_RULES 에 먼저 정의된 소분류가 이긴다. */
function domPickSub(text, subs) {
  let best = null;
  subs.forEach((sub) => {
    const hits = (DOM_RULES[sub] || []).filter((w) => domHasKw(text, w));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { sub: sub, hits: hits };
  });
  return best;
}

/** 항목 하나를 분류한다.
    ★ 슬립테크 기업 기사면 대분류를 슬립테크로 고정하고, 소분류는
      웨어러블·향수·약 중에서 고른다. 애매하면 '슬립테크 > 기타'.
    ★ 그 밖의 기사는 6개 소분류 전체에서 키워드가 가장 많이 걸린 것으로. */
function domClassifyItem(it) {
  const raw = domSearchText(it);
  const text = raw.toLowerCase();
  const stBrand = domSleeptechBrand(it);
  if (!text.trim() && !stBrand) {
    return { sub: null, hits: [], text: raw, why: '제목이 비어 있습니다' };
  }

  if (stBrand) {
    const best = domPickSub(text, DOM_ST_SUBS);
    if (best) return { sub: best.sub, hits: best.hits, text: raw, why: null, stBrand: stBrand };
    // 슬립테크인 것은 분명하나 세부는 애매 → 기타로 받는다(미분류로 흘리지 않는다)
    return { sub: 'stetc', hits: [], text: raw, stBrand: stBrand,
      why: null, note: '슬립테크 기업(' + stBrand + ') 기사 — 세부 분류 낱말이 없어 기타' };
  }

  const best = domPickSub(text, Object.keys(DOM_RULES));
  if (best) return { sub: best.sub, hits: best.hits, text: raw, why: null };

  /* 못 걸렸을 때 — 지어내지 않는다. 본문에 실제로 있는 낱말만 근거로 적는다.
     ★ '행사 기사라서 못 걸렸다'고 단정하지 않는다. 확실한 것은 '제품 종류를
       가리키는 낱말이 없다'는 사실 하나뿐이고, 나머지는 참고로만 덧붙인다. */
  let why = '제품 종류를 가리키는 낱말이 없습니다(브랜드·언론사 이름 제외 후 검사)';
  const pn = String(it.product_name || '').trim();
  if (pn && raw.indexOf(pn) >= 0) why += ' — 제품 라인 이름(‘' + pn + '’)만 적혀 있습니다';
  const ev = DOM_EVENT_WORDS.filter((w) => domHasKw(text, w));
  if (ev.length) why += ' · 함께 쓰인 낱말: ' + ev.join('·');
  return { sub: null, hits: [], text: raw, why: why };
}

/* 선택 상태 — 국내·국외가 서로 독립이다(한쪽을 눌러도 다른 쪽은 그대로).
   rk('region key') 는 'kor' | 'glo'. 버튼마다 data-rk 로 실어 보낸다. */
const DOM_STATE = { kor: { cat: null, sub: null }, glo: { cat: null, sub: null } };
let _domClassSig = {};   // 같은 목록을 다시 분류했을 때 콘솔이 도배되지 않게(구역별)
let _domWired = false;

function domSt(rk) { return DOM_STATE[rk] || DOM_STATE.kor; }

/** 목록 전체를 소분류별로 나눈다. 결과는 콘솔에도 한 번 찍는다. */
function domClassify(items, rk, label) {
  const list = items || [];
  const bySub = { other: [] };
  // ★ DOM_RULES 가 아니라 DOM_CATS 기준으로 칸을 만든다 —
  //   '슬립테크 > 기타'처럼 키워드 규칙이 없는 소분류도 칸이 있어야 한다.
  DOM_CATS.forEach((c) => c.subs.forEach((sb) => { bySub[sb.key] = []; }));
  const detail = [];
  list.forEach((it) => {
    const r = domClassifyItem(it);
    bySub[r.sub || 'other'].push(it);
    detail.push({ sub: r.sub, hits: r.hits, title: String(it.title || ''),
      text: r.text, why: r.why, note: r.note });
  });

  // 콘솔 출력 — 카테고리별 항목 수 + 미분류 수 + 미분류로 남은 제목·사유
  const sig = list.map((x) => x.link || x.title).join('|');
  if (_domClassSig[rk] !== sig) {
    _domClassSig[rk] = sig;
    console.log('[' + (label || rk) + ' 신제품 분류] 총 ' + list.length
      + '건 (규칙 기반 · AI 미사용)');
    DOM_CATS.forEach((c) => {
      const n = c.subs.reduce((a, s) => a + bySub[s.key].length, 0);
      console.log('  ' + c.label + ' ' + n + '건 — '
        + c.subs.map((s) => s.label + ' ' + bySub[s.key].length).join(' · '));
    });
    console.log('  ' + DOM_OTHER.label + DOM_OTHER.note + ' ' + bySub.other.length + '건');
    if (bySub.other.length) {
      console.log('  ↳ 미분류로 남긴 항목 — 억지로 끼워 맞추지 않고 사유를 남긴다:');
      detail.filter((d) => !d.sub).forEach((d) => {
        console.log('     · ' + d.title);
        console.log('       검사한 문구(브랜드·언론사 제외): "' + String(d.text || '').trim() + '"');
        console.log('       사유: ' + d.why);
      });
    }
    detail.filter((d) => d.sub).forEach((d) => {
      const m = domSubMeta(d.sub);
      console.log('  ✔ [' + (m ? m.cat.label + ' > ' + m.sub.label : d.sub) + '] '
        + d.title + (d.hits && d.hits.length ? '  ← 키워드: ' + d.hits.join(', ')
          : '  ← ' + (d.note || '')));
    });
  }
  return bySub;
}

/** 대분류/소분류 버튼 한 줄. 건수를 함께 보여 주고, 0건이어도 눌러 볼 수 있다.
    ★ 0건도 누를 수 있게 둔 이유: '없다'는 것도 확인하고 싶은 정보라서.
      대신 숫자로 미리 알려 주고, 눌렀을 때 안내 문구를 보여 준다. */
function domBtns(opts, rk) {
  return '<div class="icis-years dom-cats">' + opts.map((o) => {
    return '<button type="button" class="icis-year dom-cat'
      + (o.count === 0 ? ' is-empty' : '') + '"'
      + ' data-rk="' + escapeHtml(rk) + '"'
      + ' data-' + escapeHtml(o.kind) + '="' + escapeHtml(o.key) + '">'
      + escapeHtml(o.label)
      + (o.note ? '<span class="dom-cat__note">' + escapeHtml(o.note) + '</span>' : '')
      + '<span class="dom-cat__n">' + o.count + '</span></button>';
  }).join('') + '</div>';
}

/** breadcrumb + 뒤로 가기.
    ★★ 구역 이름(국내/국외)은 넣지 않는다 — 바로 위 .comp-group__head 가
      이미 '국내'/'국외'를 보여 주고 있어, 여기에 또 넣으면 같은 글자가
      두 번 찍힌다(그 겹침이 이번에 고친 버그다).
    ★ 아직 아무것도 고르지 않았으면 이 줄 자체를 만들지 않는다. */
function domCrumb(rk) {
  const st = domSt(rk);
  if (!st.cat && !st.sub) return '';
  const path = [];
  const cat = DOM_CATS.filter((c) => c.key === st.cat)[0];
  if (cat) path.push(cat.label);
  else if (st.cat === DOM_OTHER.key) path.push(DOM_OTHER.label + DOM_OTHER.note);
  const m = st.sub ? domSubMeta(st.sub) : null;
  if (m) path.push(m.sub.label);
  const crumbs = path.map((t, i) => (i === path.length - 1
    ? '<b>' + escapeHtml(t) + '</b>' : escapeHtml(t))).join('<i class="dom-crumb__sep">›</i>');
  return '<div class="dom-nav"><div class="dom-crumb">' + crumbs + '</div>'
    + '<button type="button" class="dom-back" data-rk="' + escapeHtml(rk) + '">‹ 이전</button></div>';
}

/** 카테고리 선택 단계 HTML. 결과를 보여줄 차례면 null 을 돌려
    호출부가 '기존 렌더'로 넘어가게 한다(기존 이미지+기사 코드는 그대로 쓴다). */
function domCatStage(items, rk, label) {
  const st = domSt(rk);
  const bySub = domClassify(items, rk, label);
  const nOf = (c) => (c.key === DOM_OTHER.key
    ? bySub.other.length : c.subs.reduce((a, s) => a + bySub[s.key].length, 0));
  const tops = DOM_CATS.concat([Object.assign({ subs: [] }, DOM_OTHER)]);

  // 1단계 — 대분류
  if (!st.cat) {
    return domBtns(tops.map((c) => ({
      kind: 'cat', key: c.key, label: c.label, note: c.note, count: nOf(c),
    })), rk)
      + '<div class="dom-hint">분류를 골라 주세요. 숫자는 지금 받아 둔 기사 건수입니다.</div>';
  }

  // '기타'는 소분류가 없다 — 바로 결과로 간다.
  if (st.cat === DOM_OTHER.key) return null;

  const cat = DOM_CATS.filter((c) => c.key === st.cat)[0];
  if (!cat) { st.cat = null; return domCatStage(items, rk, label); }

  // 2단계 — 소분류
  if (!st.sub) {
    return domCrumb(rk)
      + domBtns(cat.subs.map((s) => ({
        kind: 'sub', key: s.key, label: s.label, count: bySub[s.key].length,
      })), rk)
      + '<div class="dom-hint">' + escapeHtml(cat.label) + ' 안에서 세부 분류를 골라 주세요.</div>';
  }
  return null;   // 3단계 — 결과는 기존 렌더가 그린다
}

/** 결과 단계에서 쓸 필터된 목록 */
function domFiltered(items, rk, label) {
  const st = domSt(rk);
  const bySub = domClassify(items, rk, label);
  if (st.cat === DOM_OTHER.key) return bySub.other;
  return bySub[st.sub] || [];
}

/** 버튼 클릭 — #domesticList 에 한 번만 붙인다(다시 그려도 중복되지 않게).
    국내·국외 버튼이 한 컨테이너에 함께 있으므로 data-rk 로 구역을 가른다. */
function wireBrandCats() {
  if (_domWired) return;
  const el = document.getElementById('domesticList');
  if (!el) return;
  _domWired = true;
  el.addEventListener('click', (e) => {
    const back = e.target.closest && e.target.closest('.dom-back');
    if (back) {
      const st = domSt(back.dataset.rk);
      if (st.sub) st.sub = null; else st.cat = null;   // 한 단계씩만 되돌린다
      renderBrands();
      return;
    }
    const b = e.target.closest && e.target.closest('.dom-cat');
    if (!b) return;
    const st = domSt(b.dataset.rk);
    if (b.dataset.cat) { st.cat = b.dataset.cat; st.sub = null; }
    else if (b.dataset.sub) { st.sub = b.dataset.sub; }
    renderBrands();
  });
}

/** 한 소그룹(국내/국외) 렌더: 소제목 + 대표 상품 3개 + 기사 목록
    ★ catUi=true 일 때만 앞에 카테고리 선택 단계가 붙는다(국내 전용).
      국외는 이 인자를 넘기지 않으므로 예전 동작 그대로다.
    ★ 이미지+기사를 그리는 부분(brandFeatureCards·brandListItems)은 손대지 않았다.
      목록만 걸러서 같은 함수에 그대로 넘긴다. */
function brandGroupHtml(title, tag, items, featured, colors, emptyMsg, catUi) {
  const head = `<div class="comp-group__head">${escapeHtml(title)}${tag ? ` <span class="comp-group__tag">${escapeHtml(tag)}</span>` : ''}</div>`;
  if (!items || !items.length) return `<div class="brand-group">${head}${emptyState(emptyMsg)}</div>`;

  let list = items, feat = featured, nav = '';
  if (catUi) {
    // catUi 는 구역 키('kor'|'glo'). 국내·국외가 서로 다른 선택 상태를 갖는다.
    const stage = domCatStage(items, catUi, title);
    // 아직 고르는 중이면 여기서 끝낸다(이미지·기사는 그리지 않는다).
    if (stage !== null) return `<div class="brand-group">${head}${stage}</div>`;
    nav = domCrumb(catUi);
    list = domFiltered(items, catUi, title);
    // 대표 상품도 같은 분류로 거른다 — 남는 게 없으면 아래에서 목록 앞 3건을 쓴다.
    const keys = list.map((x) => x.link || x.title);
    feat = (featured || []).filter((x) => keys.indexOf(x.link || x.title) >= 0);
    if (!list.length) {
      return `<div class="brand-group">${head}${nav}${emptyState('이 분류에 해당하는 기사가 아직 없습니다')}</div>`;
    }
  }

  const featList = (feat && feat.length) ? feat : list.slice(0, 3);
  // ★ ${nav} 를 head 에 바로 붙인다 — 국외는 nav 가 빈 문자열이라, 줄을 나누면
  //   빈 줄이 하나 끼어 예전 출력과 달라진다(내용은 같아도 그대로 두지 않는다).
  return `<div class="brand-group">
    ${head}${nav}
    <div class="dom-feature"><div class="dom-feature__head">대표 출시 상품</div>
      <div class="dom-feature__grid">${brandFeatureCards(featList, colors)}</div></div>
    <div class="dom-divider"></div>
    ${brandListItems(list, colors)}
  </div>`;
}

/** 국내외 브랜드 신제품 렌더: 국내 + 국외(Global) 두 소그룹 */
function renderBrands() {
  const el = document.getElementById('domesticList');
  if (!el) return;
  const hasKor = _domestic && _domestic.length;
  const hasGlo = _globalBrands && _globalBrands.length;
  if (!hasKor && !hasGlo) { el.innerHTML = emptyState('브랜드 신제품 데이터 준비중'); return; }
  // 국내·국외 모두 카테고리 선택 단계를 앞에 둔다. 마지막 인자가 구역 키다 —
  // 서로 다른 키를 쓰므로 한쪽에서 고른 분류가 다른 쪽에 영향을 주지 않는다.
  const kor = brandGroupHtml('국내', '', _domestic, _domesticFeatured, DOM_BRAND_COLORS, '국내 브랜드 신제품 준비중', 'kor');
  const glo = brandGroupHtml('국외', 'Global', _globalBrands, _globalFeatured, DOM_BRAND_COLORS, '국외 브랜드 신제품 준비중', 'glo');
  const foot = '<div class="dom-note">뉴스 기사 기반으로, 상품명·사진이 정확하지 않을 수 있습니다.</div>'
    + '<div class="comp-caption">출처: Google News</div>';
  el.innerHTML = kor + '<div class="brand-divider"></div>' + glo + foot;
  wireBrandCats();
}

/* ── 환율 (우리은행 스타일: USD·EUR·JPY 원화 시세표 + 기간별 추이) ── */
let _fx = null;        // { rows:[{cur,now,change,prev}], series:{dates,USD,EUR,JPY}, source }
let _fxCur = null;     // 선택 통화 배열(예 ['USD'] · ['USD','EUR']). null=미선택
let _fxMonths = null;  // 추이 기간(3/6/9/12개월). null=미선택
let _fxChart = null;   // 추이 차트 hover 캐시

const FX_META = {
  USD: { label: 'USD', name: '미국 달러', sub: '미국 달러', color: '#C8102E' }, // 빨강
  EUR: { label: 'EUR', name: '유로',      sub: '유로',      color: '#F59E0B' }, // 주황
  JPY: { label: 'JPY', name: '엔화',      sub: '100엔',     color: '#3B82F6' }, // 파랑
};
const FX_CURS = ['USD', 'EUR', 'JPY'];

/** 응답의 fx 저장 후 환율 섹션 갱신 */
function applyFxUpdate(data) {
  const fx = data && data.sections && data.sections.fx;
  if (!fx) return;
  _fx = (fx.status === 'error') ? null : fx;
  if (fx.status === 'error') console.warn('[update] fx error:', fx.reason);
  renderFx();
}

/** 지금 고른 통화 배열(항상 FX_CURS 순서). 아무것도 안 골랐으면 []. */
function fxSel() {
  if (!_fxCur) return [];
  const arr = Array.isArray(_fxCur) ? _fxCur : [_fxCur];   // 예전 문자열 값 방어
  return FX_CURS.filter((c) => arr.indexOf(c) >= 0);
}

/** 원화 시세 포맷: 천단위 콤마 + 소수 2자리 */
function fxNum(v) {
  return (v == null) ? '—' : Number(v).toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 환율 섹션 렌더: 상단 시세표 + 기간 버튼 + 추이 그래프 */
function renderFx() {
  const el = document.getElementById('body-fx');
  if (!el) return;
  const note = '<div class="fx-note">원/달러·원/유로·원/엔 시세. 수입 원자재·설비 결제 시 원가 부담을 가늠할 수 있습니다.</div>';
  if (!_fx || !Array.isArray(_fx.rows) || !_fx.rows.length) {
    el.innerHTML = emptyState('환율 데이터 준비중') + note;
    return;
  }

  // 1) 상단 시세표
  const rowByCur = {};
  _fx.rows.forEach((r) => { rowByCur[r.cur] = r; });
  const trs = FX_CURS.map((cur) => {
    const r = rowByCur[cur]; if (!r) return '';
    const m = FX_META[cur], c = r.change;
    const chg = (c == null)
      ? '<span class="fxr-flat">—</span>'
      : `<span class="fxr-chg ${c > 0 ? 'up' : c < 0 ? 'down' : 'fxr-flat'}">${c > 0 ? '▲' : c < 0 ? '▼' : ''} ${fxNum(Math.abs(c))}</span>`;
    return `<tr>
      <td class="fxr-cur"><span class="fxr-dot" style="background:${m.color}"></span><b>${m.label}</b> <span class="fxr-sub">${m.sub}</span></td>
      <td class="fxr-now">${fxNum(r.now)}</td>
      <td>${chg}</td>
      <td class="fxr-prev">${fxNum(r.prev)}</td>
    </tr>`;
  }).join('');
  const table = `<div class="fxr-wrap"><table class="fxr-table">
    <thead><tr><th>통화</th><th>현재기준율</th><th>전일대비</th><th>전일기준율</th></tr></thead>
    <tbody>${trs}</tbody>
  </table></div>`;

  // 2) 통화 칩(1줄) + 기간 칩(2줄) — 두 값을 조합해 단일 통화 추이를 그림
  // 통화 칩 — 여러 개를 함께 고를 수 있다(누를 때마다 켜짐/꺼짐).
  // '전체'는 셋을 한 번에 켜고, 이미 셋 다 켜져 있으면 모두 끈다.
  const sel = fxSel();
  const curChips = `<div class="icis-years fx-curs">${[...FX_CURS, 'all'].map((cur) => {
    const label = (cur === 'all') ? '전체' : `${FX_META[cur].name}(${FX_META[cur].label})`;
    const on = (cur === 'all') ? (sel.length === FX_CURS.length) : (sel.indexOf(cur) >= 0);
    return `<button class="icis-year fx-cur${on ? ' is-active' : ''}" data-cur="${cur}"
        aria-pressed="${on ? 'true' : 'false'}">${escapeHtml(label)}</button>`;
  }).join('')}<span class="fx-curhint">여러 개를 함께 고를 수 있습니다</span></div>`;
  const months = [3, 6, 9, 12];
  // 리포트 버튼 — 통화·기간이 모두 골라졌을 때만 낸다(원유·제품·KOIMA 카드와 같은 자리·클래스)
  const rptBtn = (sel.length && _fxMonths)
    ? `<button type="button" class="oc-tool or-btn fx-report${_fxReport ? ' is-on' : ''}"
        data-fx-report="1" aria-expanded="${_fxReport ? 'true' : 'false'}">📊 리포트 분석</button>`
    : '';
  const monChips = `<div class="icis-years fx-months">${months.map((mm) =>
    `<button class="icis-year fx-month${mm === _fxMonths ? ' is-active' : ''}" data-months="${mm}">${mm}개월</button>`).join('')}${rptBtn}</div>`;

  let chartBody, sub;
  if (!sel.length || !_fxMonths) {   // 통화·기간 중 하나라도 미선택 → 안내
    _fxChart = null;
    sub = '통화와 기간을 선택하세요';
    chartBody = '<div class="icis-prompt">통화와 기간을 선택하세요</div>';
  } else {
    // 고른 통화만 그린다. 하나면 범례 없이, 둘 이상이면 범례를 붙인다.
    sub = sel.map((c) => `${FX_META[c].name}(${FX_META[c].label})`).join(' · ')
      + (sel.indexOf('JPY') >= 0 ? ' · 100엔 기준' : '');
    chartBody = buildFxChart(fxSlice(_fxMonths), sel)
      + (sel.indexOf('JPY') >= 0 ? '<div class="fx-jpy-note">* JPY는 100엔 단위</div>' : '');
  }

  el.innerHTML = `
    ${table}
    ${note}
    <div class="viz-root viz-figure fx-figure">
      <div class="viz-head"><div>
        <div class="viz-title">원화 환율 추이</div>
        <div class="viz-sub">${escapeHtml(sub)}</div>
      </div></div>
      ${curChips}
      ${monChips}
      ${chartBody}${_fxReport ? fxrReportHtml() : ''}
      <div class="viz-tooltip" id="fxTooltip"></div>
      <div class="comp-caption">${fxAsOfDate() ? `기준일 ${escapeHtml(fxAsOfDate())} · ` : ''}출처: Frankfurter (ECB 기반)</div>
    </div>`;

  const curEl = el.querySelector('.fx-curs');
  if (curEl) curEl.addEventListener('click', (e) => {
    const b = e.target.closest('.fx-cur');
    if (!b) return;
    const cur = b.dataset.cur;   // 기간은 유지한 채 통화만 켜고 끈다
    const now = fxSel();
    if (cur === 'all') {
      _fxCur = (now.length === FX_CURS.length) ? null : FX_CURS.slice();
    } else {
      const next = (now.indexOf(cur) >= 0) ? now.filter((x) => x !== cur) : now.concat([cur]);
      // FX_CURS 순서를 유지한다(고른 차례와 무관하게 항상 USD·EUR·JPY 순)
      _fxCur = FX_CURS.filter((x) => next.indexOf(x) >= 0);
      if (!_fxCur.length) _fxCur = null;
    }
    _fxReport = _fxCur ? _fxReport : false;   // 통화를 다 끄면 리포트도 접는다
    renderFx();
  });
  const mEl = el.querySelector('.fx-months');
  if (mEl) mEl.addEventListener('click', (e) => {
    const b = e.target.closest('.fx-month');
    if (!b) return;
    _fxMonths = parseInt(b.dataset.months, 10);  // 통화는 유지
    renderFx();
  });
  const rEl = el.querySelector('.fx-report');
  if (rEl) rEl.addEventListener('click', () => { _fxReport = !_fxReport; renderFx(); });
  if (sel.length && _fxMonths) wireFxInteraction();
}

/* ── 환율 · 리포트 분석 ───────────────────────────────────────────────────
   ★ AI/LLM 을 쓰지 않는다. 문장은 템플릿이고 숫자는 전부 받아둔 시세에서 계산한다.
     외부 호출이 없으므로 비용도 없다.
   ★★ 원인은 지어내지 않는다. '연준 금리', '무역수지' 같은 해설은 이 데이터에
     없다. 서술하는 것은 오직 숫자 자체의 변화뿐이다 — 전일 대비 · 기간 등락 ·
     최고/최저 · 평균 · 통화 간 변동폭 비교.
   ★ 고정값이 없다. 지금 고른 통화(_fxCur)와 기간(_fxMonths)에서 매번 계산한다. */
let _fxReport = false;      // 리포트 펼침 상태

const FXR_DEF = '환율이란 자국 통화와 외국 통화 간의 교환 비율을 뜻하며, '
  + '원/달러 환율이 오르면 원화 가치가 하락(달러 대비 원화 약세)했다는 의미입니다.';

/* |변동률|을 말로 옮기는 유일한 근거표. 사람 감각으로 '소폭'을 쓰지 않는다.
   경계값을 코드에 적어 두어 나중에 왜 그렇게 썼는지 확인할 수 있게 한다. */
const FXR_BANDS = [
  { lim: 0.3, word: '소폭 ' },
  { lim: 1.0, word: '' },
  { lim: Infinity, word: '큰 폭으로 ' },
];
function fxrMag(pct) {
  const a = Math.abs(pct == null ? 0 : pct);
  return FXR_BANDS.filter((b) => a < b.lim)[0].word;
}

function fxrWon(v) { return (v == null) ? '—' : fxNum(v) + '원'; }
function fxrSigned(v) {
  if (v == null) return '—';
  return (v > 0 ? '+' : v < 0 ? '-' : '') + fxNum(Math.abs(v)) + '원';
}
function fxrPct(v) { return (v == null) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
function fxrDay(cur) {
  return ((_fx && _fx.rows) || []).filter((x) => x.cur === cur)[0] || null;
}
/** 전일 대비 변동률(%) — prev 가 없으면 null */
function fxrDayPct(r) {
  if (!r || r.change == null || !r.prev) return null;
  return Math.round((r.change / r.prev) * 10000) / 100;
}

/** 조회 창 안의 통화별 지표. 값이 하나도 없으면 n=0 으로 남긴다. */
function fxrStats(cur, sl) {
  const m = FX_META[cur];
  const pts = [];
  (sl.dates || []).forEach((d, i) => {
    const v = sl[cur] ? sl[cur][i] : null;
    if (v != null) pts.push({ d: d, v: v });
  });
  const base = { cur: cur, label: m.label, name: m.name, color: m.color, n: pts.length };
  if (!pts.length) return base;
  const vals = pts.map((x) => x.v);
  const mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
  const first = pts[0], last = pts[pts.length - 1];
  return Object.assign(base, {
    pts: pts, first: first, last: last,
    hi: pts.filter((x) => x.v === mx)[0],
    lo: pts.filter((x) => x.v === mn)[0],
    avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
    chg: Math.round((last.v - first.v) * 100) / 100,
    pct: first.v ? Math.round(((last.v - first.v) / first.v) * 10000) / 100 : null,
  });
}

/** 리포트가 쓸 값 묶음. 통화·기간이 안 골라졌거나 값이 없으면 null */
function fxrCtx() {
  if (!_fx || !fxSel().length || !_fxMonths) return null;
  const sl = fxSlice(_fxMonths);
  if (!sl.dates || !sl.dates.length) return null;
  /* ★★ 지금 화면에서 고른 통화만 다룬다.
     예전에는 FX_CURS(3통화)를 통째로 계산해, USD 하나만 골라도 리포트에
     EUR·JPY 비교가 섞여 나왔다. 고른 것과 읽는 것이 어긋나던 원인이다. */
  const drawCurs = fxSel();
  const st = drawCurs.map((c) => fxrStats(c, sl));
  const live = st.filter((x) => x.n);
  if (!live.length) return null;
  const headCur = drawCurs[0];          // 단일이면 그 통화, '전체'면 첫 번째(USD)
  return {
    sl: sl, st: st, live: live, headCur: headCur, drawCurs: drawCurs,
    months: _fxMonths, isAll: drawCurs.length === FX_CURS.length,
    multi: drawCurs.length > 1,         // 통화가 둘 이상일 때만 '비교'를 말한다
    span: sl.dates[0] + ' ~ ' + sl.dates[sl.dates.length - 1],
    days: sl.dates.length,
    head: st.filter((x) => x.cur === headCur)[0],
  };
}

/** 통화별 지표 표 — '고른 통화'만 담는다(고른 게 하나면 한 줄). */
function fxrTable(c) {
  const row = (x) => {
    // 표에 들어오는 것 자체가 고른 통화뿐이라 굵게/보통을 나눌 이유가 없다.
    const nameCell = '<td class="oc-td-p"><span class="oc-swatch" style="background:'
      + x.color + '"></span><b>' + escapeHtml(x.label) + ' '
      + escapeHtml(x.name) + '</b></td>';
    if (!x.n) return '<tr>' + nameCell + '<td class="oc-num" colspan="6">이 기간 값 없음</td></tr>';
    const d = fxrDay(x.cur), dp = fxrDayPct(d);
    const dCls = (d && d.change != null) ? (d.change > 0 ? ' oc-up' : (d.change < 0 ? ' oc-down' : '')) : '';
    const pCls = x.pct == null ? '' : (x.pct > 0 ? ' oc-up' : (x.pct < 0 ? ' oc-down' : ''));
    return '<tr>' + nameCell
      + '<td class="oc-num">' + fxrWon(x.last.v) + '</td>'
      + '<td class="oc-num' + pCls + '">' + fxrSigned(x.chg)
      + '<span class="or-when">' + escapeHtml(fxrPct(x.pct)) + '</span></td>'
      + '<td class="oc-num"><span class="or-hi">' + fxrWon(x.hi.v) + '</span>'
      + '<span class="or-when">' + escapeHtml(x.hi.d) + '</span></td>'
      + '<td class="oc-num"><span class="or-lo">' + fxrWon(x.lo.v) + '</span>'
      + '<span class="or-when">' + escapeHtml(x.lo.d) + '</span></td>'
      + '<td class="oc-num">' + fxrWon(x.avg) + '</td>'
      + '<td class="oc-num' + dCls + '">' + (d ? fxrSigned(d.change) : '—')
      + '<span class="or-when">' + escapeHtml(fxrPct(dp)) + '</span></td></tr>';
  };
  return '<div class="oc-tablewrap"><table class="oc-table or-tbl"><thead><tr>'
    + '<th class="oc-th-p">통화</th><th>최근값</th><th>기간 등락</th>'
    + '<th>최고</th><th>최저</th><th>평균</th><th>참고 · 전일 대비</th>'
    + '</tr></thead><tbody>' + c.st.map(row).join('') + '</tbody></table></div>';
}

/** 변동폭 순위 — 기간 등락률 절댓값 기준. 값 없는 통화는 순위에서 뺀다. */
function fxrRankHtml(c) {
  const rank = c.live.filter((x) => x.pct != null)
    .slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  if (!rank.length) return '';
  return '<div class="srr-stats">' + rank.map((x, i) => {
    const cls = x.pct > 0 ? ' srr-up' : (x.pct < 0 ? ' srr-down' : ' srr-flat');
    return '<div class="srr-stat"><span class="gs-k">' + (i + 1) + '위 '
      + escapeHtml(x.label) + '</span>'
      + '<span class="gs-v' + cls + '">' + escapeHtml(fxrPct(x.pct)) + '</span>'
      + '<span class="srr-sub">' + escapeHtml(fxrSigned(x.chg)) + '</span></div>';
  }).join('') + '</div>';
}

/** 보조 설명 문장. 근거 없는 문장은 아예 넣지 않는다. */
function fxrSubs(c) {
  const h = c.head, out = [];
  const unit = (h.cur === 'JPY') ? ' (100엔 기준)' : '';
  if (h.n) {
    out.push('조회 기간(' + c.months + '개월 · ' + c.span + ') 안에서 '
      + h.label + unit + '는 최고 ' + fxrWon(h.hi.v) + '(' + h.hi.d + '), '
      + '최저 ' + fxrWon(h.lo.v) + '(' + h.lo.d + ')입니다.');
    out.push('같은 기간 평균은 ' + fxrWon(h.avg) + '이고, 값이 있는 날은 '
      + h.n + '일입니다.');
    const diff = Math.round((h.last.v - h.avg) * 100) / 100;
    out.push('최근값은 기간 평균보다 ' + fxrSigned(diff) + ' '
      + (diff > 0 ? '높은' : (diff < 0 ? '낮은' : '같은')) + ' 수준입니다.');
  }
  /* ★ 통화 비교는 '둘 이상 골랐을 때'만 말한다.
     하나만 골랐는데 다른 통화를 끌어오면, 고른 조건과 읽는 내용이 어긋난다. */
  if (c.multi) {
    const rank = c.live.filter((x) => x.pct != null)
      .slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
    if (rank.length >= 2) {
      const top = rank[0], bot = rank[rank.length - 1];
      out.push('고른 ' + c.drawCurs.length + '개 통화 가운데 이번 기간 원화 대비 '
        + '변동폭이 가장 큰 통화는 ' + top.label + '(' + fxrPct(top.pct) + '), '
        + '가장 작은 통화는 ' + bot.label + '(' + fxrPct(bot.pct) + ')입니다.');
    }
  }
  /* ★ 전일 대비는 시간 기준이 달라 헷갈리기 쉽다. 문장 앞에 '참고'를 붙여
     기간 기준 문장들과 확실히 갈라 놓는다. */
  const d = fxrDay(h.cur), dp = fxrDayPct(d);
  if (d && d.change != null) {
    const w = d.change > 0 ? '상승' : (d.change < 0 ? '하락' : '보합');
    out.push('참고 · 전일 대비(하루 기준)로는 ' + h.label + '가 '
      + fxrSigned(d.change) + '(' + fxrPct(dp) + ') ' + w + '했습니다. '
      + '위 문장들은 모두 조회 기간(' + c.months + '개월) 기준입니다.');
  }
  return out;
}

/** 총 내용 정리 — 맨 앞이 한줄평이다. 모두 계산값으로만 만든다. */
function fxrSummary(c) {
  const out = [];
  /* ① 한줄평 — '조회 기간' 기준으로 말한다.
     ★★ 예전에는 전일 대비(하루)로 한줄평을 쓰고 바로 다음 문장은 3개월을 말해
       시간 기준이 섞였다. 헤드라인·한줄평·보조 문장을 모두 조회 기간으로 맞춘다.
     ★★ 그리고 고른 통화만 센다 — 예전에는 FX_CURS(3통화)를 통째로 셌다. */
  const per = c.live.filter((x) => x.pct != null);
  if (per.length) {
    const up = per.filter((x) => x.chg > 0).length;
    const dn = per.filter((x) => x.chg < 0).length;
    const fl = per.length - up - dn;
    const mv = per.slice().sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))[0];
    const mag = fxrMag(mv.pct);          // 가장 큰 변동폭의 등급
    /* ★ '소폭'을 어디에 붙이느냐가 뜻을 바꾼다.
       고른 통화가 모두 같은 방향이면 '가장 큰 변동폭이 소폭' = '모두 소폭'
       이므로 방향 동사에 붙여도 참이다. 방향이 섞였을 때는 그렇게 말할 수 없으니
       가장 많이 움직인 통화 쪽에만 붙인다. */
    const base = '조회 기간(' + c.months + '개월) 동안 ';
    let dir, magOnMover = true;
    if (!c.multi) {                       // 통화 하나 — 비교하지 않고 그 통화만 말한다
      const w = mv.chg > 0 ? '상승' : (mv.chg < 0 ? '하락' : '보합');
      out.push(mv.label + '는 ' + base + fxrSigned(mv.chg) + '('
        + fxrPct(mv.pct) + ') ' + mag + w + '했습니다.');
    } else {
      if (dn === per.length) { dir = '고른 ' + per.length + '개 통화 모두 ' + base + mag + '하락했으며'; magOnMover = false; }
      else if (up === per.length) { dir = '고른 ' + per.length + '개 통화 모두 ' + base + mag + '상승했으며'; magOnMover = false; }
      else if (fl === per.length) { dir = '고른 ' + per.length + '개 통화 모두 ' + base + '거의 움직이지 않았으며'; magOnMover = false; }
      else {
        const parts = [];
        if (up) parts.push(up + '개 통화가 상승');
        if (dn) parts.push(dn + '개가 하락');
        if (fl) parts.push(fl + '개가 보합');
        dir = base + parts.join('하고 ') + '했으며';
      }
      const tail = '변동폭이 가장 큰 통화는 ' + mv.label
        + '(' + fxrSigned(mv.chg) + ', ' + fxrPct(mv.pct) + ')';
      out.push('최근 환율은 ' + dir + ', ' + tail
        + (magOnMover ? '로 ' + mag + '움직였습니다.' : '입니다.'));
    }
  }
  // ② 기간 관점 — 헤드라인 통화의 경로
  const h = c.head;
  if (h.n && h.pct != null) {
    const w = h.chg > 0 ? '올랐고' : (h.chg < 0 ? '내렸고' : '보합이었고');
    const lastWon = fxrWon(h.last.v);   // '…원' 은 받침이 있어 '으로'가 맞다
    out.push(h.label + '는 조회한 ' + c.months + '개월 동안 '
      + fxrWon(h.first.v) + '에서 ' + lastWon + gsJosa(lastWon, '으로', '로') + ' '
      + fxrSigned(h.chg) + '(' + fxrPct(h.pct) + ') ' + w
      + ' 최고 ' + fxrWon(h.hi.v) + '과 최저 ' + fxrWon(h.lo.v) + ' 사이에서 움직였습니다.');
  }
  // ③ 원인은 쓰지 않는다 — 이 데이터로 알 수 없다는 사실만 남긴다.
  out.push('환율이 왜 그렇게 움직였는지는 이 시세 데이터만으로 알 수 없어 적지 않았습니다. '
    + '위 문장은 모두 조회 기간(' + c.months + '개월) 기준이며, 수치는 같은 원본 시세에서 '
    + '계산한 값입니다.');
  return out;
}

/** 추이 그래프 — 핵심 지점만 라벨. 단일 통화는 최고·최저·최근값,
    '전체'는 선이 셋이라 각 통화의 최근값만 찍는다(최고·최저는 위 표에 있다). */
function fxrChart(c) {
  const dates = c.sl.dates, n = dates.length;
  const draw = c.st.filter((x) => x.n && c.drawCurs.indexOf(x.cur) >= 0);
  if (n < 2 || !draw.length) return '<div class="chart-empty">추이를 그릴 값이 부족합니다.</div>';
  const all = [];
  draw.forEach((x) => x.pts.forEach((p) => all.push(p.v)));
  let ymin = Math.min.apply(null, all), ymax = Math.max.apply(null, all);
  const pad = (ymax - ymin) * 0.22 || 5;
  ymin -= pad; ymax += pad;

  const W = VIZ_W, H = 200, padL = 58, padR = 30, padT = 26, padB = 32;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / ((ymax - ymin) || 1)) * plotH;
  const idxOf = {};
  dates.forEach((d, i) => { idxOf[d] = i; });

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${fxNum(val)}</text>`;
  }).join('');

  const xlab = orTickIdx(n, 6).map((i) => {
    const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 18).toFixed(1)}" text-anchor="${anchor}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(dates[i].slice(2).replace(/-/g, '.'))}</text>`;
  }).join('');

  const lines = draw.map((x) => {
    const pts = x.pts.map((p) => X(idxOf[p.d]).toFixed(1) + ',' + Y(p.v).toFixed(1)).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${x.color}" stroke-width="1.8" stroke-linejoin="round"/>`;
  }).join('');

  // 라벨 — 값 위/아래로 나눠 겹침을 피한다(최고는 위, 최저는 아래).
  const mark = (p, color, txt, up) => {
    const x = X(idxOf[p.d]), y = Y(p.v);
    const anchor = x > padL + plotW - 60 ? 'end' : (x < padL + 60 ? 'start' : 'middle');
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${color}" stroke="var(--card)" stroke-width="1.6"/>`
      + `<text x="${x.toFixed(1)}" y="${(y + (up ? -9 : 15)).toFixed(1)}" text-anchor="${anchor}" font-size="10" font-weight="800"`
      + ` paint-order="stroke" stroke="var(--card)" stroke-width="3" fill="var(--ink)">${escapeHtml(txt)}</text>`;
  };
  let marks = '';
  if (c.drawCurs.length === 1) {
    const x = draw[0];
    marks += mark(x.hi, x.color, '최고 ' + fxNum(x.hi.v), true);
    marks += mark(x.lo, x.color, '최저 ' + fxNum(x.lo.v), false);
    marks += mark(x.last, x.color, '최근 ' + fxNum(x.last.v), true);
  } else {
    draw.forEach((x) => { marks += mark(x.last, x.color, x.label + ' ' + fxNum(x.last.v), true); });
  }

  const legend = (c.drawCurs.length > 1)
    ? '<div class="srr-legend">' + draw.map((x) => '<span class="srr-lg">'
      + '<i style="background:' + x.color + '"></i>' + escapeHtml(x.label) + '</span>').join('')
      + '</div>' : '';

  return `<svg class="srr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ' aria-label="환율 추이">' + grid + xlab + lines + marks
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/></svg>`
    + legend;
}

/** 리포트 본문. 버튼을 누르기 전에는 호출되지 않는다. */
function fxrReportHtml() {
  const c = fxrCtx();
  if (!c) return '<div class="srr"><div class="chart-empty">리포트를 만들 시세가 없습니다.</div></div>';
  const h = c.head;
  const d = fxrDay(h.cur), dp = fxrDayPct(d);
  /* ★★ 헤드라인은 '조회 기간' 변화다(전일 대비 아님).
     한 리포트 안에서 시간 기준이 섞이지 않도록, 전일 대비는 아래 줄에
     '참고'라고 못 박아 따로 뺀다. */
  const dir = (h.chg == null) ? 'flat' : (h.chg > 0 ? 'up' : (h.chg < 0 ? 'down' : 'flat'));
  const arrow = dir === 'up' ? '▲' : (dir === 'down' ? '▼' : '—');
  /* 조회 조건에 쓸 통화 이름 — 고른 것을 모두 적는다.
     셋 다면 '전체', 하나면 이름까지, 둘이면 코드로 나열한다. */
  const curLabel = c.isAll
    ? '전체(' + c.drawCurs.join('·') + ')'
    : (c.multi ? c.drawCurs.map((x) => FX_META[x].label).join(' · ')
      : h.name + '(' + h.label + ')');
  const dDir = (!d || d.change == null) ? 'flat' : (d.change > 0 ? 'up' : (d.change < 0 ? 'down' : 'flat'));
  const dArrow = dDir === 'up' ? '▲' : (dDir === 'down' ? '▼' : '—');

  const hero = '<div class="srr-hero">'
    + '<div class="srr-hero__when">' + escapeHtml(h.name + '(' + h.label + ')')
    + (h.cur === 'JPY' ? ' · 100엔 기준' : '')
    + (c.multi ? ' · 고른 ' + c.drawCurs.length + '개 통화 중 기준 통화' : '')
    + (fxAsOfDate() ? ' · 기준일 ' + escapeHtml(fxAsOfDate()) : '') + '</div>'
    + '<div class="srr-hero__row">'
    + '<span class="srr-hero__v">' + escapeHtml(fxNum(h.last.v)) + '</span>'
    + '<span class="srr-hero__unit">원</span>'
    + '<span class="srr-hero__d srr-' + dir + '">' + arrow + ' '
    + escapeHtml(h.chg == null ? '—' : fxNum(Math.abs(h.chg)) + '원')
    + (h.pct != null ? ' (' + escapeHtml(fxrPct(h.pct)) + ')' : '')
    + '<span class="srr-hero__vs">조회 기간(' + c.months + '개월) 대비</span></span>'
    + '</div>'
    + '<div class="fxr-daily">참고 · 전일 대비 <b class="srr-' + dDir + '">' + dArrow + ' '
    + escapeHtml(d && d.change != null ? fxNum(Math.abs(d.change)) + '원' : '—')
    + (dp != null ? ' (' + escapeHtml(fxrPct(dp)) + ')' : '') + '</b>'
    + ' <span class="fxr-daily__s">— 하루 기준이라 위 수치와 기간이 다릅니다</span></div>'
    + '</div>';

  const subs = fxrSubs(c).map((t) => '<p class="srr-p">' + escapeHtml(t) + '</p>').join('');

  return '<div class="srr">'
    + '<div class="srr-head">리포트 분석 <span class="srr-scope">'
    + escapeHtml(curLabel + ' · ' + c.months + '개월 · ' + c.days + '일 관측') + '</span></div>'
    + '<p class="srr-cond"><b>현재 조회 조건</b> · 통화 ' + escapeHtml(curLabel)
    + ' · 기간 최근 ' + c.months + '개월(' + escapeHtml(c.span) + ')'
    + ' · 서술 기준 조회 기간</p>'
    + '<p class="srr-def">' + escapeHtml(FXR_DEF) + '</p>'
    + hero + subs
    + '<h4 class="srr-h">' + (c.multi
      ? '통화별 지표 (' + escapeHtml(c.drawCurs.join(' · ')) + ' 비교)'
      : escapeHtml(h.label) + ' 지표') + '</h4>'
    + fxrTable(c)
    // 순위는 견줄 대상이 둘 이상일 때만 낸다
    + (c.multi ? '<h4 class="srr-h">기간 변동폭 순위 (원화 대비)</h4>' + fxrRankHtml(c) : '')
    + '<h4 class="srr-h">추이</h4><div class="srr-chart">' + fxrChart(c) + '</div>'
    + '<div class="srr-sum"><div class="srr-sum__h">총 내용 정리</div>'
    + fxrSummary(c).map((t) => '<p class="srr-sum__p">' + escapeHtml(t) + '</p>').join('')
    + '</div></div>';
}

/** series를 최근 N개월로 슬라이스 */
function fxSlice(months) {
  const empty = { dates: [], USD: [], EUR: [], JPY: [] };
  const s = _fx && _fx.series;
  if (!s || !Array.isArray(s.dates) || !s.dates.length) return empty;
  const dates = s.dates;
  const last = new Date(dates[dates.length - 1] + 'T00:00:00');
  const cutoff = new Date(last); cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const idx = dates.map((d, i) => (d >= cutoffStr ? i : -1)).filter((i) => i >= 0);
  const pick = (arr) => (Array.isArray(arr) ? idx.map((i) => arr[i]) : idx.map(() => null));
  return { dates: idx.map((i) => dates[i]), USD: pick(s.USD), EUR: pick(s.EUR), JPY: pick(s.JPY) };
}

/** 원화 추이 선그래프 — cur='all'이면 세 통화 동시(범례 O), 아니면 단일(라벨).
 *  Y축은 표시 통화들의 min/max에 여유를 준 auto 범위(0부터 시작 안 함). */
function buildFxChart(slice, cur) {
  const dates = slice.dates, n = dates.length;
  if (!n) { _fxChart = null; return '<div class="chart-empty">추이 데이터가 없습니다.</div>'; }
  // cur 은 통화 배열(예 ['USD','EUR']). 'all'/단일 문자열도 그대로 받는다.
  const curList = Array.isArray(cur) ? cur : (cur === 'all' ? FX_CURS : [cur]);
  const isAll = curList.length > 1;      // 둘 이상이면 범례를 붙인다
  const series = curList.map((c) => ({ key: c, color: FX_META[c].color, values: slice[c] || [] }))
    .filter((sr) => sr.values.some((v) => v != null));
  if (!series.length) { _fxChart = null; return '<div class="chart-empty">추이 데이터가 없습니다.</div>'; }

  // Y축: 통화별 자릿수가 달라 고정 금지 → 데이터 min/max 기준 + 여유(변동이 평평해지지 않게)
  const all = series.flatMap((sr) => sr.values).filter((v) => v != null);
  let ymin = Math.min(...all), ymax = Math.max(...all);
  if (ymin === ymax) { const d = Math.abs(ymin) * 0.05 || 1; ymin -= d; ymax += d; }
  const yp = (ymax - ymin) * 0.14 || 10; ymin -= yp; ymax += yp;

  const W = VIZ_W, H = VIZ_H, padL = 46, padR = 16, padT = VIZ_PAD_T, padB = VIZ_PAD_B;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin || 1)) * plotH;

  const grid = vizYFractions().map((t) => {
    const val = ymin + (ymax - ymin) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${Math.round(val).toLocaleString('ko-KR')}</text>`;
  }).join('');

  const xticks = vizTickIdx(n, plotW).map((i) => {
    const a = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 15).toFixed(1)}" text-anchor="${a}" font-size="${VIZ_FS_AXIS}" fill="var(--muted)">${escapeHtml(dates[i].slice(0, 7))}</text>`;
  }).join('');

  const lines = series.map((sr) => {
    let path = '', pen = false;
    sr.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      const x = X(i), y = Y(v);
      path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `; pen = true;
    });
    return path ? `<path d="${path.trim()}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  }).join('');

  // 헤더: 전체=범례(3개), 단일=통화 라벨
  let header, aria;
  if (isAll) {
    header = `<div class="viz-legend">${series.map((sr) => `<span class="viz-legend__item"><span class="viz-legend__swatch" style="background:${sr.color}"></span>${escapeHtml(FX_META[sr.key].name)}(${sr.key})</span>`).join('')}</div>`;
    aria = '원화 환율 추이 (USD·EUR·JPY)';
  } else {
    const m = FX_META[cur] || { color: 'var(--slate)', name: cur, label: cur };
    header = `<div class="fx-series-label"><span class="viz-legend__swatch" style="background:${m.color}"></span>${escapeHtml(m.name)}(${escapeHtml(m.label)})<span class="fx-series-unit"> · 원${cur === 'JPY' ? ' (100엔)' : ''}</span></div>`;
    aria = `${m.name} 원화 추이`;
  }
  _fxChart = { dates, series, geom: { X, Y, n, W, padL }, cur };

  return `${header}
    <svg class="viz-svg fx-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeHtml(aria)}">
      ${grid}${xticks}${lines}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>
      <line class="fx-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>
      <g class="fx-dots"></g>
      <rect class="fx-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
    </svg>`;
}

/** 추이 차트 크로스헤어 + 툴팁 (날짜 · 통화 · 값) */
function wireFxInteraction() {
  const fig = document.querySelector('#body-fx .fx-figure');
  const tip = document.getElementById('fxTooltip');
  if (!fig || !tip || !_fxChart) return;
  const svg = fig.querySelector('.fx-svg');
  if (!svg) return;
  const overlay = svg.querySelector('.fx-overlay');
  const cross = svg.querySelector('.fx-cross');
  const dots = svg.querySelector('.fx-dots');
  const c = _fxChart, g = c.geom;
  const clear = () => { tip.classList.remove('is-visible'); cross.style.opacity = '0'; dots.innerHTML = ''; };
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = (evt.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round(((sx - g.padL) / ((g.X(g.n - 1) - g.padL) || 1)) * (g.n - 1));
    i = Math.max(0, Math.min(g.n - 1, i));
    const cx = g.X(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.opacity = '1';
    let dh = '', rows = '';
    c.series.forEach((s) => {
      const v = s.values[i];
      if (v == null) return;
      dh += `<circle cx="${cx.toFixed(1)}" cy="${g.Y(v).toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
      const unit = s.key === 'JPY' ? ' 원 (100엔)' : ' 원';
      const nm = FX_META[s.key] ? `${FX_META[s.key].name}(${s.key})` : s.key;
      rows += `<div class="viz-tt-row"><span class="viz-tt-swatch" style="background:${s.color}"></span><span>${escapeHtml(nm)}</span><span class="viz-tt-val">${fxNum(v)}${unit}</span></div>`;
    });
    if (!rows) { clear(); return; }
    dots.innerHTML = dh;
    tip.innerHTML = `<div class="viz-tooltip__date">${escapeHtml(c.dates[i])}</div>${rows}`;
    const fr = fig.getBoundingClientRect();
    let left = evt.clientX - fr.left + 14;
    if (left + tip.offsetWidth > fr.width) left = evt.clientX - fr.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${evt.clientY - fr.top + 14}px`;
    tip.classList.add('is-visible');
  });
  overlay.addEventListener('mouseleave', clear);
}

/* ── 세계 시간 (World Clock) — 외부 API 없이 Intl.DateTimeFormat로 계산 ── */
// 등장방형도법: lat/lon → x=(lon+180)/360, y=(90-lat)/180 (남위도 그대로 정확: 예 -33.87→68.8%)
// dir=도시명 라벨 방향(근접 도시 겹침 분산). 상세(시각·날씨·시차)는 hover/탭 툴팁 + 하단 표.
const WORLD_CITIES = [
  { ko: '서울', tz: 'Asia/Seoul', lat: 37.57, lon: 126.98, dir: 'n' },
  { ko: '도쿄', tz: 'Asia/Tokyo', lat: 35.68, lon: 139.69, dir: 'ne' },
  { ko: '상하이', tz: 'Asia/Shanghai', lat: 31.23, lon: 121.47, dir: 'sw' },
  { ko: '싱가포르', tz: 'Asia/Singapore', lat: 1.35, lon: 103.82, dir: 's' },
  { ko: '두바이', tz: 'Asia/Dubai', lat: 25.20, lon: 55.27, dir: 's' },
  { ko: '런던', tz: 'Europe/London', lat: 51.51, lon: -0.13, dir: 'w' },
  { ko: '파리', tz: 'Europe/Paris', lat: 48.86, lon: 2.35, dir: 'sw' },
  { ko: '프랑크푸르트', tz: 'Europe/Berlin', lat: 50.11, lon: 8.68, dir: 'n' },
  { ko: '밀라노', tz: 'Europe/Rome', lat: 45.46, lon: 9.19, dir: 'se' },
  { ko: '모스크바', tz: 'Europe/Moscow', lat: 55.76, lon: 37.62, dir: 'n' },
  { ko: '카이로', tz: 'Africa/Cairo', lat: 30.04, lon: 31.24, dir: 'se' },
  { ko: '요하네스버그', tz: 'Africa/Johannesburg', lat: -26.20, lon: 28.05, dir: 's' },
  { ko: '뉴욕', tz: 'America/New_York', lat: 40.71, lon: -74.01, dir: 'e' },
  { ko: '시카고', tz: 'America/Chicago', lat: 41.88, lon: -87.63, dir: 'w' },
  { ko: '로스앤젤레스', tz: 'America/Los_Angeles', lat: 34.05, lon: -118.24, dir: 's' },
  // 브라질리아 타임존은 America/Sao_Paulo(=Brasilia 아님), 부에노스아이레스는 슬래시 2개
  { ko: '브라질리아', tz: 'America/Sao_Paulo', lat: -15.79, lon: -47.88, dir: 'ne' },
  { ko: '부에노스아이레스', tz: 'America/Argentina/Buenos_Aires', lat: -34.61, lon: -58.38, dir: 'sw' },
  { ko: '시드니', tz: 'Australia/Sydney', lat: -33.87, lon: 151.21, dir: 'se' },
];
let _wcTimer = null;
let _wcShown = false;    // 마커 표시 여부(업데이트 후 true, 초기화 시 false)
let _wcWeather = null;   // 도시별 {temp,code} 배열 | null(요청 실패 → 기온 —)
let _wcOpen = null;      // 툴팁 열린 도시 index(핀 고정) | null

/** tz 현재 시각 구성요소 {year,month,day,minute,h(0~23)} — 24시간제 */
function wcParts(tz, date) {
  const out = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).forEach((p) => { if (p.type !== 'literal') out[p.type] = p.value; });
  let hh = parseInt(out.hour, 10); if (hh === 24) hh = 0;  // 자정 '24' 방어
  out.h = hh;
  return out;
}

/** tz UTC 오프셋(분) — 서머타임 자동 반영(하드코딩 없음) */
function wcOffsetMin(parts, date) {
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, parts.h, +parts.minute, 0);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** 서울 기준 시차 배지(예 '+0h', '-1h', '-16h') */
function wcOffsetLabel(diffMin) {
  const h = diffMin / 60, a = Math.abs(h);
  return `${h < 0 ? '-' : '+'}${Number.isInteger(a) ? a : a.toFixed(1)}h`;
}

/** WMO weather_code → 아이콘 */
function wmoIcon(code) {
  if (code == null) return '·';
  if (code === 0) return '☀';
  if ([1, 2, 3].includes(code)) return '⛅';
  if ([45, 48].includes(code)) return '🌫';
  if ((code >= 51 && code <= 57) || (code >= 61 && code <= 67)) return '🌧';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '❄';
  if (code >= 80 && code <= 82) return '🌦';
  if ([95, 96, 99].includes(code)) return '⛈';
  return '🌡';
}

/** 도시 i의 현재 상태 {timeStr,dateStr,h,diffMin} 계산 */
function wcState(i, now, seoulOff) {
  const p = wcParts(WORLD_CITIES[i].tz, now);
  return {
    timeStr: `${String(p.h).padStart(2, '0')}:${p.minute}`,
    dateStr: `${p.month}/${p.day}`,
    h: p.h,
    diffMin: wcOffsetMin(p, now) - seoulOff,
  };
}

/** 지도 + 마커(점+도시명) + 하단 표 렌더. 초기(미표시)엔 회색 지도 + 안내 */
function renderWorldClock() {
  const root = document.getElementById('worldclockRoot');
  if (!root) return;
  _wcOpen = null;
  if (!_wcShown) {
    root.innerHTML = `<div class="wc-map">
        <img class="wc-map__img" src="world-map.svg" alt="" aria-hidden="true">
        <div class="wc-empty">업데이트 버튼을 눌러 불러오세요</div>
      </div>
      <div class="comp-caption">출처: Open-Meteo</div>`;
    return;
  }
  const dots = WORLD_CITIES.map((c, i) => {
    const x = (c.lon + 180) / 360 * 100;
    const y = (90 - c.lat) / 180 * 100;
    // 서울만 상세 화면이 있어 표시를 조금 더 준다.
    // ★ 두 값은 서울이 아니면 빈 문자열이라, 나머지 마커의 HTML 은 예전과 한 글자도 다르지 않다.
    const krCls = (c.ko === '서울') ? ' wc-mk--kr' : '';
    const krHint = (c.ko === '서울') ? ' title="눌러서 국내 주요 도시 날씨 보기"' : '';
    return `<button class="wc-mk wc-${c.dir}${krCls}" data-i="${i}" type="button"
        style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%" aria-label="${escapeHtml(c.ko)}"${krHint}>
        <span class="wc-dot"></span><span class="wc-name">${escapeHtml(c.ko)}</span>
      </button>`;
  }).join('');
  root.innerHTML = `<div class="wc-map">
      <img class="wc-map__img" src="world-map.svg" alt="" aria-hidden="true">
      <div class="wc-markers">${dots}</div>
      <div class="wc-tip" id="wcTip" hidden></div>
    </div>
    <div class="comp-caption">출처: Open-Meteo</div>`;
  wcWire();
  wcTick();
}

/** 매 틱(30초): 마커 주야 구분 + 열린 툴팁 갱신 */
function wcTick() {
  const root = document.getElementById('worldclockRoot');
  if (!root || !_wcShown || _krOn) return;   // 한국 상세 화면이 열려 있으면 건드리지 않는다
  const now = new Date();
  const seoulOff = wcOffsetMin(wcParts('Asia/Seoul', now), now);
  root.querySelectorAll('.wc-mk').forEach((mk) => {
    const st = wcState(+mk.dataset.i, now, seoulOff);
    const night = (st.h >= 19 || st.h < 6);
    mk.classList.toggle('is-night', night);
    mk.classList.toggle('is-day', !night);
  });
  if (_wcOpen != null) wcShowTip(_wcOpen, true);  // 열린 툴팁 내용 갱신
}

/** 툴팁 내용 + 지도 안쪽으로 위치 지정 */
function wcShowTip(i, keepOpen) {
  const root = document.getElementById('worldclockRoot');
  const tip = root && root.querySelector('#wcTip');
  const mk = root && root.querySelector(`.wc-mk[data-i="${i}"]`);
  if (!tip || !mk) return;
  const c = WORLD_CITIES[i];
  const now = new Date();
  const seoulOff = wcOffsetMin(wcParts('Asia/Seoul', now), now);
  const st = wcState(i, now, seoulOff);
  const w = _wcWeather && _wcWeather[i];
  const wx = w ? `${wmoIcon(w.code)} ${w.temp != null ? Math.round(w.temp) + '°' : '—'}` : '—';
  const x = (c.lon + 180) / 360 * 100, y = (90 - c.lat) / 180 * 100;
  tip.innerHTML = `<div class="wc-tip__city">${escapeHtml(c.ko)}</div>
    <div class="wc-tip__time">${st.timeStr}<span class="wc-tip__date"> · ${st.dateStr}</span></div>
    <div class="wc-tip__row"><span>서울 대비</span><b>${wcOffsetLabel(st.diffMin)}</b></div>
    <div class="wc-tip__row"><span>날씨</span><b>${wx}</b></div>`;
  // 지도 안쪽으로 열기: 오른쪽 도시는 왼쪽으로, 아래 도시는 위로
  tip.style.left = tip.style.right = tip.style.top = tip.style.bottom = 'auto';
  if (x <= 50) tip.style.left = `calc(${x}% + 12px)`; else tip.style.right = `calc(${(100 - x).toFixed(2)}% + 12px)`;
  if (y <= 55) tip.style.top = `calc(${y}% - 6px)`; else tip.style.bottom = `calc(${(100 - y).toFixed(2)}% - 6px)`;
  tip.hidden = false;
  if (!keepOpen) mk.classList.add('is-hi');
}

/** 툴팁 숨김 */
function wcHideTip() {
  const root = document.getElementById('worldclockRoot');
  const tip = root && root.querySelector('#wcTip');
  if (tip) tip.hidden = true;
  if (root) root.querySelectorAll('.wc-mk.is-hi').forEach((m) => m.classList.remove('is-hi'));
}

/** 마커 hover/탭 + 표 행 hover 연동 배선 */
function wcWire() {
  const root = document.getElementById('worldclockRoot');
  if (!root) return;
  const markers = root.querySelector('.wc-markers');
  markers.addEventListener('mouseover', (e) => {
    const mk = e.target.closest('.wc-mk'); if (!mk || _wcOpen != null) return;
    wcShowTip(+mk.dataset.i, false);
  });
  markers.addEventListener('mouseout', (e) => {
    const mk = e.target.closest('.wc-mk'); if (!mk || _wcOpen != null) return;
    wcHideTip();
  });
  // 탭/클릭: 핀 고정 토글(모바일 대응)
  // ★ 서울만 예외 — 한국 상세 화면으로 들어간다. 다른 도시는 예전 그대로 툴팁 토글.
  markers.addEventListener('click', (e) => {
    const mk = e.target.closest('.wc-mk'); if (!mk) return;
    const i = +mk.dataset.i;
    if (WORLD_CITIES[i] && WORLD_CITIES[i].ko === '서울') {
      e.stopPropagation();
      krOpen();
      return;
    }
    if (_wcOpen === i) { _wcOpen = null; wcHideTip(); }
    else { _wcOpen = i; wcShowTip(i, true); }
    e.stopPropagation();
  });
  // 바깥 탭/클릭 → 닫기
  document.addEventListener('click', wcOutside);
}

/** 지도 바깥 클릭 시 핀 툴팁 닫기 */
function wcOutside(e) {
  const root = document.getElementById('worldclockRoot');
  if (!root || _wcOpen == null) return;
  if (e.target.closest('.wc-mk') || e.target.closest('#wcTip')) return;
  _wcOpen = null; wcHideTip();
}

/* ── 한국 상세 화면 (세계 시간 카드 안) ─────────────────────────────────────
   ★ 기존 세계지도(WORLD_CITIES·renderWorldClock)는 건드리지 않는다.
     서울 마커를 눌렀을 때만 이 화면으로 바꿔 끼우고, [세계 시간으로 돌아가기]
     를 누르면 원래 렌더 함수를 그대로 다시 부른다.
   ★ 날씨: Open-Meteo (키 불필요·무료). 응답 값을 그대로 쓰고 임의 보정하지 않는다.
   ★ 뉴스: 서버의 /api/weather-news → 구글 뉴스 RSS. 제목·링크·언론사·날짜만.
     없으면 '없음'을 정직하게 띄운다(지어내지 않는다).
   ★ 지도: public/maps/korea.svg — 아래 KR_PROJ 와 '같은 식'으로 만들었다.
     그래서 lat/lon 을 그대로 넣으면 핀이 정확히 그 자리에 찍힌다. */

// korea.svg 를 만들 때 쓴 투영 상수(등장방형 · 표준위도 36°). 바꾸면 지도도 다시 만들어야 한다.
const KR_PROJ = { lon0: 124.50, lat1: 38.70, k: Math.cos(36 * Math.PI / 180), s: 120, w: 631.0, h: 684.0 };

/* 주요 도시 — 위도/경도는 각 시청 기준 공개 좌표.
   ★ 15개 전부 지도 폴리곤 안에 들어가는지 좌표로 검증했다(점-내부 판정). */
const KR_CITIES = [
  { ko: '서울', lat: 37.5665, lon: 126.9780 },
  { ko: '인천', lat: 37.4563, lon: 126.7052 },
  { ko: '수원', lat: 37.2636, lon: 127.0286 },
  { ko: '이천', lat: 37.2792, lon: 127.4425 },
  { ko: '강릉', lat: 37.7519, lon: 128.8761 },
  { ko: '세종', lat: 36.4800, lon: 127.2890 },
  { ko: '대전', lat: 36.3504, lon: 127.3845 },
  { ko: '포항', lat: 36.0190, lon: 129.3435 },
  { ko: '대구', lat: 35.8714, lon: 128.6014 },
  { ko: '울산', lat: 35.5384, lon: 129.3114 },
  { ko: '부산', lat: 35.1796, lon: 129.0756 },
  { ko: '광주', lat: 35.1595, lon: 126.8526 },
  { ko: '거제', lat: 34.8806, lon: 128.6211 },
  { ko: '통영', lat: 34.8544, lon: 128.4331 },
  { ko: '목포', lat: 34.8118, lon: 126.3922 },
  { ko: '제주', lat: 33.4996, lon: 126.5312 },
];

const KR_WX_TTL = 30 * 60 * 1000;   // 날씨 캐시 30분(요청 '1시간 이내' 요건보다 짧게)
const KR_FORECAST_NOTE = '예보는 기상 모델 예측값으로, 실제와 다를 수 있습니다. '
  + '먼 날짜일수록 정확도가 낮습니다.';
const KR_MAP_SRC = '지도: southkorea-maps (POPONG, CC BY 4.0) · 원자료 통계청 2013';

let _krOn = false;      // 한국 상세 화면이 열렸는지
let _krCity = 0;        // 고른 도시 index (기본 서울)
let _krWx = {};         // { 도시명: {ts, cur, days} }
let _krNews = {};       // { 도시명: {ts, status, items} }
let _krBusy = {};       // { 도시명: true } — 요청 중
let _krWired = false;   // root 는 재렌더에도 살아 있어 리스너가 쌓인다 → 한 번만 붙인다

/** lat/lon → korea.svg 안의 백분율 좌표(지도 생성식과 동일) */
function krXY(lat, lon) {
  const p = KR_PROJ;
  return {
    x: ((lon - p.lon0) * p.k * p.s) / p.w * 100,
    y: ((p.lat1 - lat) * p.s) / p.h * 100,
  };
}

/** WMO 코드 → 한국어 날씨 이름 (아이콘은 기존 wmoIcon 재사용) */
function krWmoText(code) {
  if (code == null) return '—';
  if (code === 0) return '맑음';
  if (code === 1) return '대체로 맑음';
  if (code === 2) return '구름 조금';
  if (code === 3) return '흐림';
  if (code === 45 || code === 48) return '안개';
  if (code >= 51 && code <= 57) return '이슬비';
  if (code >= 61 && code <= 67) return '비';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '눈';
  if (code >= 80 && code <= 82) return '소나기';
  if (code === 95) return '천둥번개';
  if (code === 96 || code === 99) return '천둥번개·우박';
  return '—';
}

function krNum(v, digits) {
  if (v == null || !isFinite(v)) return '—';
  const d = digits == null ? 0 : digits;
  return Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 시간 배열에서 특정 날짜의 오전(06~11시)·오후(12~17시) 평균을 낸다.
    ★ Open-Meteo 는 일별로 최고/최저만 주므로, 오전·오후를 나누려면 시간별을 모아야 한다.
      값을 만들어 내는 게 아니라 응답에 있는 시간값을 평균만 낸다. */
function krAmPm(hourly, day, key) {
  const t = hourly && hourly.time, arr = hourly && hourly[key];
  if (!Array.isArray(t) || !Array.isArray(arr)) return { am: null, pm: null };
  let as = 0, an = 0, ps = 0, pn = 0;
  for (let i = 0; i < t.length; i += 1) {
    const s = String(t[i]);
    if (s.slice(0, 10) !== day) continue;
    const h = parseInt(s.slice(11, 13), 10);
    const v = arr[i];
    if (v == null) continue;
    if (h >= 6 && h <= 11) { as += v; an += 1; }
    else if (h >= 12 && h <= 17) { ps += v; pn += 1; }
  }
  return { am: an ? as / an : null, pm: pn ? ps / pn : null };
}

/** Open-Meteo 로 현재 날씨 + 3일 예보. 실패하면 error 를 담아 돌려준다. */
async function krFetchWeather(city) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${city.lat}&longitude=${city.lon}`
    + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,precipitation'
    + '&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation_probability'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=Asia%2FSeoul&forecast_days=3';
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 9000) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const days = (d.daily && d.daily.time ? d.daily.time : []).map((day, i) => ({
      day: day,
      code: d.daily.weather_code ? d.daily.weather_code[i] : null,
      tmax: d.daily.temperature_2m_max ? d.daily.temperature_2m_max[i] : null,
      tmin: d.daily.temperature_2m_min ? d.daily.temperature_2m_min[i] : null,
      pop: d.daily.precipitation_probability_max ? d.daily.precipitation_probability_max[i] : null,
      t: krAmPm(d.hourly, day, 'temperature_2m'),
      rh: krAmPm(d.hourly, day, 'relative_humidity_2m'),
      ws: krAmPm(d.hourly, day, 'wind_speed_10m'),
      pp: krAmPm(d.hourly, day, 'precipitation_probability'),
    }));
    return { ts: Date.now(), cur: d.current || null, units: d.current_units || null, days: days };
  } catch (e) {
    console.warn('[korea] weather fail:', city.ko, e);
    return { ts: Date.now(), error: (e && e.message) || String(e), cur: null, days: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 서버 경유로 지역 날씨 이슈 뉴스. 실패해도 화면은 뜬다. */
async function krFetchNews(city) {
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
  try {
    const res = await fetch('/api/weather-news?region=' + encodeURIComponent(city.ko),
      { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return { ts: Date.now(), status: d.status || 'ok', items: d.items || [], reason: d.reason };
  } catch (e) {
    console.warn('[korea] news fail:', city.ko, e);
    return { ts: Date.now(), status: 'error', items: [], reason: (e && e.message) || String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 고른 도시의 날씨·뉴스를 필요할 때만 새로 받는다(캐시 TTL 지났을 때만). */
async function krLoad(i, force) {
  const city = KR_CITIES[i];
  if (!city || _krBusy[city.ko]) return;
  const stale = (c) => !c || (Date.now() - c.ts) > KR_WX_TTL;
  if (!force && !stale(_krWx[city.ko]) && !stale(_krNews[city.ko])) return;
  _krBusy[city.ko] = true;
  renderKorea();
  const [wx, news] = await Promise.all([
    (force || stale(_krWx[city.ko])) ? krFetchWeather(city) : Promise.resolve(_krWx[city.ko]),
    (force || stale(_krNews[city.ko])) ? krFetchNews(city) : Promise.resolve(_krNews[city.ko]),
  ]);
  _krWx[city.ko] = wx;
  _krNews[city.ko] = news;
  _krBusy[city.ko] = false;
  if (_krOn) renderKorea();
}

/** 오늘/내일/모레 라벨 */
function krDayLabel(day, i) {
  const names = ['오늘', '내일', '모레'];
  const md = day ? day.slice(5).replace('-', '/') : '';
  return (names[i] || md) + (md ? ' (' + md + ')' : '');
}

/** 현재 날씨 4칸 */
function krNowHtml(city, wx) {
  if (!wx || wx.error || !wx.cur) {
    return '<div class="kr-now kr-now--empty">' + escapeHtml(
      wx && wx.error ? '날씨를 불러오지 못했습니다 (' + wx.error + ')' : '날씨를 불러오는 중…') + '</div>';
  }
  const c = wx.cur;
  const cell = (k, v, u) => '<div class="kr-cell"><span class="kr-cell__k">' + escapeHtml(k)
    + '</span><span class="kr-cell__v">' + escapeHtml(v)
    + (u ? '<i>' + escapeHtml(u) + '</i>' : '') + '</span></div>';
  return '<div class="kr-nowwrap">'
    + '<div class="kr-nowhead"><span class="kr-nowicon">' + wmoIcon(c.weather_code) + '</span>'
    + '<span class="kr-nowtemp">' + krNum(c.temperature_2m, 1) + '<i>℃</i></span>'
    + '<span class="kr-nowtext">' + escapeHtml(krWmoText(c.weather_code)) + '</span></div>'
    + '<div class="kr-cells">'
    + cell('바람', krNum(c.wind_speed_10m, 1), 'km/h')
    + cell('습도', krNum(c.relative_humidity_2m), '%')
    + cell('1시간 강수량', krNum(c.precipitation, 1), 'mm')
    + cell('기온', krNum(c.temperature_2m, 1), '℃')
    + '</div></div>';
}

/** 3일 예보 표 — 오전/오후로 나눠 기온·습도·평균풍속·강수확률 */
function krForecastHtml(wx) {
  if (!wx || wx.error || !wx.days || !wx.days.length) {
    return '<div class="kr-fc__empty">예보를 불러오지 못했습니다.</div>';
  }
  const half = (d, k, key, digits, unit) => '<td class="kr-fc__v">'
    + escapeHtml(krNum(d[key][k], digits)) + (unit ? '<i>' + escapeHtml(unit) + '</i>' : '') + '</td>';
  const rows = wx.days.map((d, i) => ['am', 'pm'].map((k) =>
    '<tr>'
    + (k === 'am' ? '<td class="kr-fc__d" rowspan="2"><b>' + escapeHtml(krDayLabel(d.day, i))
      + '</b><span class="kr-fc__ic">' + wmoIcon(d.code) + ' '
      + escapeHtml(krWmoText(d.code)) + '</span>'
      + '<span class="kr-fc__mm">' + escapeHtml(krNum(d.tmin, 0)) + '° / '
      + escapeHtml(krNum(d.tmax, 0)) + '°</span></td>' : '')
    + '<td class="kr-fc__h">' + (k === 'am' ? '오전' : '오후') + '</td>'
    + half(d, k, 't', 1, '℃') + half(d, k, 'rh', 0, '%')
    + half(d, k, 'ws', 1, 'km/h') + half(d, k, 'pp', 0, '%')
    + '</tr>').join('')).join('');
  return '<div class="kr-fc__wrap"><table class="kr-fc">'
    + '<thead><tr><th>날짜</th><th></th><th>기온</th><th>습도</th><th>평균풍속</th><th>강수확률</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>'
    + '<div class="kr-note">※ ' + escapeHtml(KR_FORECAST_NOTE) + '</div>';
}

/** 지역 날씨 이슈 뉴스 — 제목·링크·언론사·날짜만 */
function krNewsHtml(city, nw) {
  if (!nw) return '<div class="kr-nw__empty">뉴스를 불러오는 중…</div>';
  if (nw.status !== 'ok') {
    return '<div class="kr-nw__empty">뉴스를 불러오지 못했습니다'
      + (nw.reason ? ' (' + escapeHtml(nw.reason) + ')' : '') + '</div>';
  }
  if (!nw.items.length) {
    return '<div class="kr-nw__empty">최근 관련 뉴스가 없습니다.</div>';
  }
  return '<ul class="kr-nw">' + nw.items.map((it) => {
    const u = safeUrl(it.link);
    const meta = [it.source, it.date].filter(Boolean).join(' · ');
    return '<li class="kr-nw__i">'
      + (u ? '<a class="kr-nw__t" href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer">'
        + escapeHtml(it.title) + '</a>' : '<span class="kr-nw__t">' + escapeHtml(it.title) + '</span>')
      + (meta ? '<span class="kr-nw__m">' + escapeHtml(meta) + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
}

/* ── 한국 도시 상세 · 과거 추이 그래프 4종 ────────────────────────────────
   ★ 값은 Open-Meteo Historical Weather API(archive) 응답을 그대로 쓴다.
     임의 보정하지 않는다. 단위 변환만 한다(일조시간 초 → 시간).
   ★★ 특보는 기상청 기상특보 조회서비스(공공데이터포털)에서 받는다. 인증키가
     없으면 서버가 status='no_key' 를 주고, 그래프에는 특보 관련 표시를 아무것도
     하지 않는다(안내 배지·각주 없음). 4개 그래프는 그대로 다 그려진다.
     ★ 받아 오는 구조는 그대로 살려 뒀다 — 키가 생기면 bands 가 채워지고
       음영·특보 보조축·종류 안내가 자동으로 나타난다(kwCard 의 아래 분기들). */

const KW_RANGES = [{ key: 30, label: '1개월' }, { key: 60, label: '2개월' }];
const KW_TTL = 60 * 60 * 1000;      // 과거값은 자주 바뀌지 않는다 — 1시간 캐시

let _kwRange = 30;
let _kwHist = {};      // { '도시|일수': {ts, days:[…]} }
let _kwAlert = {};     // { '도시|일수': {ts, status, bands:[…]} }
let _kwBusy = {};
let _kwGeom = {};       // 그래프별 좌표·값 (툴팁이 쓴다)
let _kwTipSeq = 0;      // 그래프마다 붙이는 일련번호

/* 특보 종류별 음영 색. 어느 그래프가 어떤 특보를 받는지는 서버의 KIND_GROUP 과 같다. */
const KW_ALERT_COLORS = {
  폭염: '#EF4444', 한파: '#3B82F6', 태풍: '#7C3AED', 강풍: '#8B5CF6',
  풍랑: '#6366F1', 건조: '#F59E0B', 호우: '#0EA5E9', 대설: '#64748B',
};

/** 캐시 키 */
function kwKey(city) { return city.ko + '|' + _kwRange; }

/** Open-Meteo archive → 일별 배열. 실패하면 error 를 담아 돌려준다. */
async function kwFetchHist(city, days) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const daily = ['temperature_2m_max', 'temperature_2m_mean', 'temperature_2m_min',
    'wind_speed_10m_mean', 'wind_speed_10m_max',
    'relative_humidity_2m_mean', 'relative_humidity_2m_min',
    'precipitation_sum', 'sunshine_duration'].join(',');
  const url = 'https://archive-api.open-meteo.com/v1/archive'
    + `?latitude=${city.lat}&longitude=${city.lon}`
    + `&start_date=${iso(start)}&end_date=${iso(end)}`
    + `&daily=${daily}&timezone=Asia%2FSeoul`;
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    const t = (d.daily && d.daily.time) || [];
    const g = (k, i) => (d.daily && d.daily[k] ? d.daily[k][i] : null);
    const rows = t.map((day, i) => ({
      day: day,
      tmax: g('temperature_2m_max', i), tmean: g('temperature_2m_mean', i),
      tmin: g('temperature_2m_min', i),
      wmean: g('wind_speed_10m_mean', i), wmax: g('wind_speed_10m_max', i),
      hmean: g('relative_humidity_2m_mean', i), hmin: g('relative_humidity_2m_min', i),
      rain: g('precipitation_sum', i),
      // 응답은 초 단위다. 보기 위해 시간으로만 바꾼다(값을 손대는 게 아니다).
      sun: g('sunshine_duration', i) == null ? null
        : Math.round((g('sunshine_duration', i) / 3600) * 100) / 100,
    }));
    return { ts: Date.now(), days: rows, units: d.daily_units || null };
  } catch (e) {
    console.warn('[korea] history fail:', city.ko, e);
    return { ts: Date.now(), error: (e && e.message) || String(e), days: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 서버 경유 기상특보. 키가 없으면 status='no_key' 가 온다(정상 흐름). */
async function kwFetchAlert(city, days) {
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
  try {
    const res = await fetch('/api/kma-alert?region=' + encodeURIComponent(city.ko)
      + '&days=' + days, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return { ts: Date.now(), status: d.status || 'error', bands: d.bands || [],
      reason: d.reason, stnExact: d.stn_exact, stnId: d.stnId };
  } catch (e) {
    console.warn('[korea] alert fail:', city.ko, e);
    return { ts: Date.now(), status: 'error', bands: [], reason: (e && e.message) || String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 그래프용 데이터 확보 (TTL 지났을 때만 새로 받는다) */
async function kwLoad(city, force) {
  const k = kwKey(city);
  if (!city || _kwBusy[k]) return;
  const stale = (c) => !c || (Date.now() - c.ts) > KW_TTL;
  if (!force && !stale(_kwHist[k]) && !stale(_kwAlert[k])) return;
  _kwBusy[k] = true;
  if (_krOn) renderKorea();
  const [h, a] = await Promise.all([
    (force || stale(_kwHist[k])) ? kwFetchHist(city, _kwRange) : Promise.resolve(_kwHist[k]),
    (force || stale(_kwAlert[k])) ? kwFetchAlert(city, _kwRange) : Promise.resolve(_kwAlert[k]),
  ]);
  _kwHist[k] = h;
  _kwAlert[k] = a;
  _kwBusy[k] = false;
  if (_krOn) renderKorea();
}

/** 이 그래프가 받을 특보만 골라 낸다(group 이 같은 것) */
function kwBandsFor(alert, group) {
  if (!alert || alert.status !== 'ok') return [];
  return (alert.bands || []).filter((b) => b.group === group);
}

/** 그래프 하나. cfg = {days, series, unit, group, alert, right, bars} */
function kwChart(cfg) {
  const rows = cfg.days || [];
  const n = rows.length;
  if (n < 2) return '<div class="kw-empty">추이를 그릴 값이 부족합니다.</div>';

  const vals = [];
  cfg.series.forEach((s) => rows.forEach((r) => { if (r[s.key] != null) vals.push(r[s.key]); }));
  if (!vals.length) return '<div class="kw-empty">값이 없습니다.</div>';
  let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (cfg.zeroBase) lo = Math.min(0, lo);
  const pad = (hi - lo) * 0.18 || 1;
  lo -= pad; hi += pad;

  const hasRight = !!cfg.right;
  const W = 360, H = 178, padL = 34, padR = hasRight ? 30 : 10, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - lo) / ((hi - lo) || 1)) * plotH;

  // 오른쪽 축 스케일 (일조시간 또는 특보 0/1)
  let RY = null, rLo = 0, rHi = 1;
  if (hasRight) {
    if (cfg.right.key) {
      const rv = rows.map((r) => r[cfg.right.key]).filter((v) => v != null);
      rLo = 0; rHi = rv.length ? Math.max.apply(null, rv) * 1.15 || 1 : 1;
    }
    RY = (v) => padT + (1 - (v - rLo) / ((rHi - rLo) || 1)) * plotH;
  }

  const grid = vizYFractions().map((t) => {
    const val = lo + (hi - lo) * t, y = Y(val);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="var(--grid)" stroke-width="1"/>`
      + `<text x="${padL - 4}" y="${(y + 2.6).toFixed(1)}" text-anchor="end" font-size="7.5" fill="var(--muted)">${krNum(val, (hi - lo) < 6 ? 1 : 0)}</text>`;
  }).join('');

  const rAxis = hasRight ? vizYFractions().map((t) => {
    const val = rLo + (rHi - rLo) * t;
    const y = RY(val);
    const txt = cfg.right.key ? krNum(val, rHi < 6 ? 1 : 0) : (val >= 0.5 ? '있음' : '없음');
    return `<text x="${padL + plotW + 4}" y="${(y + 2.6).toFixed(1)}" text-anchor="start" font-size="7.5" fill="${escapeHtml(cfg.right.color || 'var(--muted)')}">${escapeHtml(txt)}</text>`;
  }).join('') : '';

  // 특보 음영 — 날짜가 이 창 안에 있을 때만
  const idxOf = {};
  rows.forEach((r, i) => { idxOf[r.day] = i; });
  const bw = plotW / Math.max(1, n - 1);
  const bands = (cfg.bands || []).map((b) => {
    const i = idxOf[b.from];
    if (i == null) return '';
    const c = KW_ALERT_COLORS[b.kind] || 'var(--slate)';
    const x = X(i) - bw / 2;
    return `<rect x="${Math.max(padL, x).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}"`
      + ` fill="${c}" opacity="${b.level === '경보' ? '.22' : '.12'}"/>`;
  }).join('');

  // 막대(강수) → 선보다 먼저 그린다
  const barsHtml = (cfg.bars || []).map((s) => rows.map((r, i) => {
    const v = r[s.key];
    if (v == null || v <= 0) return '';
    const y = Y(v), y0 = Y(Math.max(lo, 0));
    const w = Math.max(1.2, bw * 0.62);
    return `<rect x="${(X(i) - w / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}"`
      + ` height="${Math.max(0.6, y0 - y).toFixed(1)}" fill="${s.color}" opacity=".85"/>`;
  }).join('')).join('');

  const lines = cfg.series.filter((s) => !s.bar).map((s) => {
    const pts = rows.map((r, i) => (r[s.key] == null ? null : X(i).toFixed(1) + ',' + Y(r[s.key]).toFixed(1)))
      .filter(Boolean).join(' ');
    if (!pts) return '';
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.4}"`
      + (s.dash ? ` stroke-dasharray="${s.dash}"` : '') + ' stroke-linejoin="round"/>';
  }).join('');

  // 오른쪽 축 계열(일조시간)
  const rLine = (hasRight && cfg.right.key) ? (() => {
    const pts = rows.map((r, i) => (r[cfg.right.key] == null ? null
      : X(i).toFixed(1) + ',' + RY(r[cfg.right.key]).toFixed(1))).filter(Boolean).join(' ');
    return pts ? `<polyline points="${pts}" fill="none" stroke="${cfg.right.color}" stroke-width="1.2" stroke-dasharray="3 2"/>` : '';
  })() : '';

  // 특보 유무 계단선(오른쪽 축이 특보일 때)
  const aStep = (hasRight && !cfg.right.key) ? (() => {
    const on = {};
    (cfg.bands || []).forEach((b) => { on[b.from] = true; });
    const pts = rows.map((r, i) => X(i).toFixed(1) + ',' + RY(on[r.day] ? 1 : 0).toFixed(1)).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${cfg.right.color}" stroke-width="1.1" opacity=".8"/>`;
  })() : '';

  const xlab = orTickIdx(n, 4).map((i) => {
    const anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
    return `<text x="${X(i).toFixed(1)}" y="${(padT + plotH + 14).toFixed(1)}" text-anchor="${anchor}" font-size="7.5" fill="var(--muted)">${escapeHtml(rows[i].day.slice(5).replace('-', '/'))}</text>`;
  }).join('');

  /* ── 툴팁 재료 ────────────────────────────────────────────────────────
     날짜별로 '무엇을 몇으로 보여줄지'를 지금 미리 만들어 둔다. 마우스가 움직일
     때마다 다시 계산하지 않게 하고, 값의 출처를 이 자리 하나로 모으기 위해서다.
     ★ 겹쳐 그린 선은 같은 날짜의 값을 한 번에 모아 보여 준다(기온 최고·평균·최저).
     ★ 오른쪽 축 계열(일조시간)도 같은 줄에 함께 넣는다. */
  const tipSeries = cfg.series.concat(
    (hasRight && cfg.right.key) ? [Object.assign({}, cfg.right, { isRight: true })] : []);
  const tipRows = rows.map((r, i) => ({
    day: r.day,
    x: X(i),
    vals: tipSeries.map((s) => ({
      label: s.label, color: s.color,
      txt: (r[s.key] == null) ? '—'
        : krNum(r[s.key], s.digits == null ? 1 : s.digits) + (s.unit ? ' ' + s.unit : ''),
      y: (r[s.key] == null) ? null : (s.isRight ? RY(r[s.key]) : Y(r[s.key])),
    })),
  }));
  const id = 'kw' + (_kwTipSeq += 1);
  _kwGeom[id] = { W: W, padL: padL, plotW: plotW, padT: padT, plotH: plotH,
    n: n, rows: tipRows };

  return `<svg class="kw-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"`
    + ' data-kw-id="' + id + '"'
    + ' aria-label="' + escapeHtml(cfg.title || '추이') + '">'
    + bands + grid + rAxis + xlab + barsHtml + rLine + aStep + lines
    + `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>`
    // 아래 셋은 덧그리기 전용 — 위 그림에는 손대지 않는다
    + `<line class="kw-cross" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1" stroke-dasharray="3 3" style="opacity:0"/>`
    + '<g class="kw-hi"></g>'
    + `<rect class="kw-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>`
    + '</svg>';
}

/** 그래프 한 칸(제목 + 범례 + 그래프 + 특보 안내) */
function kwCard(cfg, alert) {
  const bands = kwBandsFor(alert, cfg.group);
  /* ★ 특보 보조축(오른쪽 '있음/없음')은 특보 데이터가 실제로 있을 때만 그린다.
     키가 없어 데이터가 없는데 축과 계단선을 그리면, 바닥에 붙은 평평한 선이
     마치 관측값인 것처럼 보인다 — 없는 걸 있는 것처럼 보이게 하지 않는다.
     (일조시간처럼 key 가 있는 보조축은 실제 값이므로 그대로 둔다) */
  if (cfg.right && !cfg.right.key && (!alert || alert.status !== 'ok')) {
    cfg = Object.assign({}, cfg);
    delete cfg.right;
  }
  const lg = cfg.series.concat(cfg.right && cfg.right.key
    ? [{ label: cfg.right.label + ' (우축)', color: cfg.right.color, dash: '3 2' }] : [])
    .map((s) => '<span class="kw-lg"><i style="background:' + escapeHtml(s.color) + '"></i>'
      + escapeHtml(s.label) + '</span>').join('');
  // 특보 안내 — 키가 없으면 그 사실을, 있으면 이 기간에 몇 건인지
  /* ★ 인증키가 없거나(no_key) 아직 받아 오는 중이면 아무 표시도 하지 않는다.
     (특보를 받아 오는 구조 자체는 그대로다 — 키가 생기면 아래 분기들이 살아난다) */
  let aNote = '';
  if (!alert || alert.status === 'no_key') {
    aNote = '';
  } else if (alert.status !== 'ok') {
    aNote = '<span class="kw-alertnote">특보 정보를 불러오지 못했습니다</span>';
  } else if (!bands.length) {
    aNote = '<span class="kw-alertnote">이 기간 해당 특보 없음</span>';
  } else {
    const kinds = bands.filter((b, i, a) => a.findIndex((x) => x.kind === b.kind) === i);
    aNote = '<span class="kw-alertnote">' + kinds.map((b) =>
      '<i class="kw-abox" style="background:' + (KW_ALERT_COLORS[b.kind] || 'var(--slate)') + '"></i>'
      + escapeHtml(b.kind)).join(' ') + ' ' + bands.length + '건' + '</span>';
  }
  return '<div class="kw-card"><div class="kw-h">' + escapeHtml(cfg.title)
    + ' <span class="kw-h__u">(' + escapeHtml(cfg.unit) + ')</span></div>'
    + '<div class="kw-lgs">' + lg + aNote + '</div>'
    // .kw-figure 는 툴팁을 이 그래프 안쪽에 띄우기 위한 기준 상자다
    + '<div class="kw-figure">' + kwChart(Object.assign({}, cfg, { bands: bands }))
    + '<div class="viz-tooltip kw-tip"></div></div>'
    + '</div>';
}

/** 과거 추이 4종 전체 */
function kwSectionHtml(city) {
  const k = kwKey(city);
  const h = _kwHist[k], a = _kwAlert[k];
  const chips = '<div class="icis-years kw-ranges">' + KW_RANGES.map((r) =>
    '<button type="button" class="icis-year kw-range' + (r.key === _kwRange ? ' is-active' : '')
    + '" data-kw-range="' + r.key + '">' + escapeHtml(r.label) + '</button>').join('') + '</div>';

  let body;
  if (_kwBusy[k] && !h) body = '<div class="kw-empty">추이를 불러오는 중…</div>';
  else if (!h) body = '<div class="kw-empty">추이를 불러오는 중…</div>';
  else if (h.error) body = '<div class="kw-empty">추이를 불러오지 못했습니다 (' + escapeHtml(h.error) + ')</div>';
  else {
    const D = h.days;
    body = '<div class="kw-grid">'
      + kwCard({
        title: '기온', unit: '℃', group: 'temp', days: D,
        series: [
          { key: 'tmax', label: '최고', color: '#EF4444', unit: '℃', digits: 1 },
          { key: 'tmean', label: '평균', color: '#111827', w: 1.7, unit: '℃', digits: 1 },
          { key: 'tmin', label: '최저', color: '#3B82F6', unit: '℃', digits: 1 },
        ],
        right: { label: '특보', color: '#9CA3AF' },   // key 없음 → 특보 0/1 보조축
      }, a)
      + kwCard({
        title: '풍속', unit: 'km/h', group: 'wind', days: D, zeroBase: true,
        series: [{ key: 'wmean', label: '평균풍속', color: '#7C3AED', w: 1.7, unit: 'km/h', digits: 1 }],
        right: { label: '특보', color: '#9CA3AF' },
      }, a)
      + kwCard({
        title: '습도', unit: '%', group: 'humid', days: D,
        series: [
          { key: 'hmean', label: '평균습도', color: '#0EA5E9', w: 1.7, unit: '%', digits: 0 },
          { key: 'hmin', label: '최저습도', color: '#F59E0B', unit: '%', digits: 0 },
        ],
        right: { label: '특보', color: '#9CA3AF' },
      }, a)
      + kwCard({
        title: '강수 · 일조', unit: 'mm · 시간', group: 'rain', days: D, zeroBase: true,
        series: [{ key: 'rain', label: '강수량', color: '#0284C7', bar: true, unit: 'mm', digits: 1 }],
        bars: [{ key: 'rain', color: '#0284C7' }],
        right: { key: 'sun', label: '일조시간', color: '#F59E0B', unit: '시간', digits: 1 },
      }, a)
      + '</div>';
  }

  const span = (h && h.days && h.days.length)
    ? h.days[0].day + ' ~ ' + h.days[h.days.length - 1].day : '';
  // 키가 없을 때(no_key)는 각주도 남기지 않는다. 그 밖의 상태 안내는 그대로 둔다.
  let aFoot = '';
  if (a && a.status === 'ok' && a.stnExact === false) {
    aFoot = '※ 이 도시의 특보구역 코드가 아직 등록되지 않아 전국(지점 '
      + (a.stnId || '108') + ') 기준으로 조회했습니다.';
  } else if (a && a.status === 'error') {
    aFoot = '※ 특보 조회 실패' + (a.reason ? ' (' + a.reason + ')' : '') + '.';
  }

  return '<div class="kw-wrap"><h4 class="kr-h">과거 추이 '
    + '<span class="kr-h__s">' + escapeHtml(span ? '최근 ' + _kwRange + '일 · ' + span : '') + '</span>'
    + '</h4>' + chips + body
    + '<div class="kr-note">과거값 출처: Open-Meteo Historical Weather API (응답 값 그대로 · '
    + '일조시간만 초→시간 변환) · 특보: 기상청 기상특보 조회서비스(공공데이터포털)</div>'
    + (aFoot ? '<div class="kr-note">' + escapeHtml(aFoot) + '</div>' : '')
    + '</div>';
}

/* ── 그래프 툴팁 ──────────────────────────────────────────────────────────
   ★ 차트 라이브러리가 없다(SVG 를 직접 그린다). 그래서 KOIMA 일일가격·환율
     카드가 쓰는 방식을 그대로 가져왔다 — 투명 overlay 위에서 x 좌표를 날짜
     번호로 바꾸고, 그 날짜의 값을 한 상자에 모아 보여 준다.
   ★ 마우스(hover)와 손가락(탭) 모두 같은 함수를 탄다. */
function kwTipAt(fig, clientX) {
  const svg = fig.querySelector('.kw-svg');
  const tip = fig.querySelector('.kw-tip');
  const g = svg && _kwGeom[svg.dataset.kwId];
  if (!svg || !tip || !g) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return;
  // 화면 픽셀 → viewBox 좌표 → 가장 가까운 날짜 번호
  const sx = (clientX - rect.left) * (g.W / rect.width);
  let i = (g.n === 1) ? 0
    : Math.round(((sx - g.padL) / (g.plotW || 1)) * (g.n - 1));
  i = Math.max(0, Math.min(g.n - 1, i));
  const row = g.rows[i];
  if (!row) return;

  const cross = svg.querySelector('.kw-cross');
  const hi = svg.querySelector('.kw-hi');
  if (cross) {
    cross.setAttribute('x1', row.x.toFixed(1));
    cross.setAttribute('x2', row.x.toFixed(1));
    cross.style.opacity = '1';
  }
  if (hi) {
    hi.innerHTML = row.vals.filter((v) => v.y != null).map((v) =>
      '<circle cx="' + row.x.toFixed(1) + '" cy="' + v.y.toFixed(1)
      + '" r="3" fill="' + v.color + '" stroke="var(--card)" stroke-width="1.5"/>').join('');
  }
  tip.innerHTML = '<div class="viz-tooltip__date">' + escapeHtml(row.day) + '</div>'
    + row.vals.map((v) => '<div class="viz-tt-row">'
      + '<span class="viz-tt-swatch" style="background:' + v.color + '"></span>'
      + '<span>' + escapeHtml(v.label) + '</span>'
      + '<span class="viz-tt-val">' + escapeHtml(v.txt) + '</span></div>').join('');

  // 그래프 안쪽에 띄운다 — 오른쪽 끝에서는 왼쪽으로 붙인다
  const fr = fig.getBoundingClientRect();
  let left = (row.x / g.W) * rect.width + (rect.left - fr.left) + 12;
  if (left + tip.offsetWidth > fr.width) left = left - tip.offsetWidth - 24;
  tip.style.left = Math.max(2, left).toFixed(0) + 'px';
  tip.style.top = '6px';
  tip.classList.add('is-visible');
}

/** 툴팁 감추기 */
function kwTipHide(fig) {
  const tip = fig.querySelector('.kw-tip');
  const svg = fig.querySelector('.kw-svg');
  if (tip) tip.classList.remove('is-visible');
  if (svg) {
    const cross = svg.querySelector('.kw-cross');
    const hi = svg.querySelector('.kw-hi');
    if (cross) cross.style.opacity = '0';
    if (hi) hi.innerHTML = '';
  }
}

/** 한국 상세 화면 전체 */
function renderKorea() {
  const root = document.getElementById('worldclockRoot');
  if (!root) return;
  const city = KR_CITIES[_krCity] || KR_CITIES[0];
  const wx = _krWx[city.ko], nw = _krNews[city.ko];
  const busy = !!_krBusy[city.ko];
  const now = new Date();
  const p = wcParts('Asia/Seoul', now);
  const stamp = `${p.year}-${p.month}-${p.day} ${String(p.h).padStart(2, '0')}:${p.minute}`;

  const pins = KR_CITIES.map((c, i) => {
    const q = krXY(c.lat, c.lon);
    return `<button type="button" class="kr-pin${i === _krCity ? ' is-on' : ''}" data-kr-city="${i}"
        style="left:${q.x.toFixed(2)}%;top:${q.y.toFixed(2)}%" aria-label="${escapeHtml(c.ko)}"
        aria-pressed="${i === _krCity ? 'true' : 'false'}">
        <span class="kr-pin__d"></span><span class="kr-pin__n">${escapeHtml(c.ko)}</span></button>`;
  }).join('');

  // 상세 패널 왼쪽의 '작은 지도' — 같은 지도를 쓰고 고른 도시에만 핀을 찍는다
  const mini = krXY(city.lat, city.lon);
  const miniMap = `<div class="kr-mini">
      <img class="kr-mini__img" src="public/maps/korea.svg" alt="" aria-hidden="true">
      <span class="kr-mini__pin" style="left:${mini.x.toFixed(2)}%;top:${mini.y.toFixed(2)}%"></span>
    </div>`;

  root.innerHTML = `
    <div class="kr-bar">
      <button type="button" class="kr-back" data-kr-back="1">‹ 세계 시간으로 돌아가기</button>
      <span class="kr-bar__t">대한민국 주요 도시 날씨</span>
      <button type="button" class="oc-tool kr-refresh" data-kr-refresh="1"${busy ? ' disabled' : ''}>${busy ? '불러오는 중…' : '↻ 새로 고침'}</button>
    </div>
    <div class="kr-wrap">
      <div class="kr-mapbox">
        <img class="kr-map__img" src="public/maps/korea.svg" alt="대한민국 지도" >
        <div class="kr-pins">${pins}</div>
      </div>
      <div class="kr-panel">
        <div class="kr-phead">
          <span class="kr-phead__c">${escapeHtml(city.ko)}</span>
          <span class="kr-phead__t">${escapeHtml(stamp)} 발표 기준</span>
        </div>
        <div class="kr-pbody">
          ${miniMap}
          <div class="kr-pinfo">${krNowHtml(city, wx)}</div>
        </div>
        <h4 class="kr-h">오늘 · 내일 · 모레 예보</h4>
        ${krForecastHtml(wx)}
        ${kwSectionHtml(city)}
        <h4 class="kr-h">주요 날씨 이슈 <span class="kr-h__s">(${escapeHtml(city.ko)} 관련 최근 기사)</span></h4>
        ${krNewsHtml(city, nw)}
      </div>
    </div>
    <div class="comp-caption">날씨: Open-Meteo · 뉴스: Google 뉴스 검색 · ${escapeHtml(KR_MAP_SRC)}</div>`;
  krWire();
}

/** 한국 화면 배선 — 도시 핀 / 돌아가기 / 새로 고침 */
function krWire() {
  if (_krWired) return;
  const root = document.getElementById('worldclockRoot');
  if (!root) return;
  _krWired = true;
  /* 그래프 툴팁 — root 에 한 번만 건다(다시 그려도 overlay 가 새로 생기므로
     각 그래프에 직접 걸면 리스너가 쌓인다).
     ★ 손가락도 같은 함수를 탄다. touchmove 에서 preventDefault 를 하지 않아
       페이지 스크롤은 그대로 된다. */
  const figOf = (e) => e.target.closest && e.target.closest('.kw-figure');
  root.addEventListener('mousemove', (e) => {
    const fig = figOf(e); if (fig) kwTipAt(fig, e.clientX);
  });
  root.addEventListener('mouseleave', (e) => {
    const fig = figOf(e); if (fig) kwTipHide(fig);
  }, true);
  root.addEventListener('mouseout', (e) => {
    const fig = figOf(e);
    if (fig && !fig.contains(e.relatedTarget)) kwTipHide(fig);
  });
  root.addEventListener('touchstart', (e) => {
    const fig = figOf(e);
    if (fig && e.touches && e.touches[0]) kwTipAt(fig, e.touches[0].clientX);
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    const fig = figOf(e);
    if (fig && e.touches && e.touches[0]) kwTipAt(fig, e.touches[0].clientX);
  }, { passive: true });
  root.addEventListener('click', (e) => {
    const fig = figOf(e); if (fig) kwTipAt(fig, e.clientX);   // 클릭으로도 뜬다
    const back = e.target.closest && e.target.closest('[data-kr-back]');
    if (back) { krClose(); return; }
    const rf = e.target.closest && e.target.closest('[data-kr-refresh]');
    if (rf) { krLoad(_krCity, true); kwLoad(KR_CITIES[_krCity], true); return; }
    const rg = e.target.closest && e.target.closest('[data-kw-range]');
    if (rg) {                                  // 기간 버튼 — 추이만 다시 받는다
      _kwRange = +rg.dataset.kwRange;
      renderKorea();
      kwLoad(KR_CITIES[_krCity], false);
      return;
    }
    const pin = e.target.closest && e.target.closest('[data-kr-city]');
    if (!pin) return;
    _krCity = +pin.dataset.krCity;
    renderKorea();
    krLoad(_krCity, false);   // 도시를 고를 때마다 최신인지 확인하고 필요하면 새로 받는다
    kwLoad(KR_CITIES[_krCity], false);
  });
}

/** 서울 마커에서 진입 */
function krOpen() {
  _krOn = true;
  _krCity = 0;
  wcHideTip();
  _wcOpen = null;
  renderKorea();
  krLoad(_krCity, false);
  kwLoad(KR_CITIES[_krCity], false);
}

/** 세계 시간으로 복귀 — 기존 렌더 함수를 그대로 부른다(세계지도 로직 미변경) */
function krClose() {
  _krOn = false;
  renderWorldClock();
}

/** [업데이트]에 연결: Open-Meteo로 18개 도시 날씨 1회 요청 → 마커 표시.
 *  실패해도 마커·시계는 뜨고 기온만 '—'. */
async function updateWorldWeather() {
  // 먼저 마커부터 표시(시계 동작 보장). 날씨는 도착하면 채우고, 실패/지연이면 '—' 유지
  _wcShown = true;
  _wcWeather = null;
  if (!_krOn) renderWorldClock();   // 한국 상세 화면을 보고 있으면 그대로 둔다
  const ctrl = ('AbortController' in window) ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;  // 지연 방어(무한 대기 방지)
  try {
    const lat = WORLD_CITIES.map((c) => c.lat).join(',');
    const lon = WORLD_CITIES.map((c) => c.lon).join(',');
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`;  // 15개 1회 요청
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : [data];  // 다중 좌표 → 배열(도시 순서와 매칭)
    _wcWeather = WORLD_CITIES.map((c, i) => {
      const cur = arr[i] && arr[i].current;
      return cur ? { temp: cur.temperature_2m, code: cur.weather_code } : null;
    });
  } catch (e) {  // 날씨 실패해도 시계는 동작(기온 '—')
    console.warn('[worldclock] weather fail:', e);
    _wcWeather = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!_krOn) renderWorldClock();  // 날씨 반영해 재렌더(실패 시 '—'). 한국 화면 중이면 유지
}

/** [초기화]: 마커 제거하고 회색 지도 + 안내 상태로 */
function resetWorldClock() {
  _krOn = false;        // 한국 상세 화면도 닫는다
  _wcShown = false;
  _wcWeather = null;
  _wcOpen = null;
  document.removeEventListener('click', wcOutside);
  renderWorldClock();
}

/** 세계 시간 초기화: 지도 렌더 + 30초 인터벌(중복 방지 위해 기존 타이머 정리 후 재설정) */
function initWorldClock() {
  renderWorldClock();
  if (_wcTimer) clearInterval(_wcTimer);  // useEffect 정리(cleanup) 대응 — 중복 인터벌 방지
  _wcTimer = setInterval(wcTick, 30000);  // 30초마다 시각 갱신(분 단위만 표시)
}

/** 데이터 변경 시 데이터 의존 섹션 재렌더 */
function refreshSections() {
  renderSimmonsNews();
  renderCompetitor();
  renderBrands();
  renderMaterial();
  renderFx();
  updateDashHeader();
}

/** 대시보드 헤더의 "마지막 업데이트" 표시.
 *  자동 날짜를 넣지 않는다 — [업데이트] 전에는 항상 미갱신("—") 상태로 둔다. */
function updateDashHeader() {
  /* no-op: 업데이트 시각은 [업데이트] 버튼 핸들러에서만 설정한다 */
}

/* ============================================================
   초기화
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  initUpload();
  initReport();
  initUpdate();
  // 로드 시 항상 "초기 상태(데이터 없음)"로 시작한다.
  // 저장된 값/기본 CSV를 자동으로 불러오지 않는다 — 데이터는 오직 [업데이트]로만 채운다.
  refreshSections(); // 빈 STORE → 모든 섹션 "준비중" 빈 상태
  initWorldClock();  // 세계 시간: 업데이트와 무관하게 로드 즉시 실시간 표시
});

/** 보고서 다운로드: 브라우저 인쇄(→ PDF로 저장) */
function initReport() {
  const btn = document.getElementById('reportBtn');
  if (btn) btn.addEventListener('click', () => window.print());
}

/* ============================================================
   실시간 업데이트 — 백엔드 /api/update
   서버(python dashboard_server.py) 실행 중일 때만 동작.
   ============================================================ */



/** API 기본 경로 — 상대경로('/api/update')로 호출한다.
 *  같은 출처에서 서빙되므로(로컬: dashboard_server.py, 배포: Vercel) 절대주소가 필요 없다. */
const API_BASE = '';

/** [초기화] 버튼: 서버 호출 없이 화면 상태만 처음(준비중)으로 되돌린다 */
function resetDashboard() {
  if (!window.confirm('초기화할까요?')) return;
  // 업데이트/기본값으로 채워졌던 모든 섹션 데이터 제거 → 각 섹션 "준비중" 빈 상태
  Object.keys(STORE).forEach((k) => delete STORE[k]);
  _simmonsNews = null;  // 시몬스 코리아 소식 비우기
  _matReady = false; _matYear = null; _matUsdKrw = null; // 원자재: 업데이트 전 초기 상태
  _icisForecast = null; // 순수 추가: 예측 초기화(섹션 숨김)
  _srData = null; _srYear = null; _srChart = null; _srReport = false; // 해상 정시성 비우기
  _srForecast = null; // 순수 추가: 정시성 예측 초기화(섹션 숨김)
  _ocData = null; _ocForm = null; _ocQuery = null; _ocView = 'table'; _ocReport = false; _oilChart = null; // 국제유가(원유) 비우기
  _opData = null; _opForm = null; _opQuery = null; _opView = 'table'; _opReport = false; _opChart = null; // 국제유가(제품) 비우기
  // 순수 추가: KOIMA 부문별 지수 → 1단계(데이터 없음)로 복귀
  _koimaData = null; _koimaCat = null; _koimaEnd = null; _koimaRange = null; _koimaChart = null; _koimaReport = false;
  // 순수 추가: KOIMA 일일 국제원자재가격 → 1단계로 복귀
  _kpData = null; _kpCat = null; _kpItem = null; _kpRange = null; _kpChart = null; _kpBusy = false; _kpReport = false;
  _domestic = null; _domesticFeatured = null;       // 국내 브랜드 비우기
  _globalBrands = null; _globalFeatured = null;     // 국외 브랜드 비우기
  _competitors = null;      // 경쟁사(국외 SEC) 데이터 비우기
  _fx = null;           // 환율 비우기
  _fxChart = null;      // 환율 추이 차트 캐시 비우기
  _fxCur = null;        // 선택 통화(배열) 미선택으로 리셋
  _fxMonths = null;     // 환율 추이 기간 미선택 상태로 리셋
  _fxReport = false;    // 환율 리포트 접기
  // "마지막 업데이트" 텍스트 되돌리기
  const lbl = document.getElementById('lastUpdated');
  if (lbl) lbl.textContent = '아직 업데이트하지 않았습니다';
  const dashUpd = document.getElementById('dashUpdated');
  if (dashUpd) dashUpd.textContent = '—';
  resetWorldClock();  // 세계 시간: 마커 제거 → 회색 지도 + 안내
  // 원자재·시장·경쟁사·뉴스 재렌더(빈 STORE → emptyState/데이터 부족)
  refreshSections();
}

/* ── 데이터 로드: 사전 수집 JSON 우선, 실패 시 실시간 수집으로 폴백 ──────────
   GitHub Actions 가 매일 새벽 public/data/dashboard.json 을 만들어 커밋한다.
   그 파일을 읽으면 즉시 완료된다(콜드 수집은 약 30초).
   파일이 없거나 못 읽으면 종전처럼 /api/update 가 직접 수집한다(로컬 개발 등). */
const DASH_DATA_URL = 'public/data/dashboard.json';

/** {data, source:'static'|'live'} 반환. 둘 다 실패하면 throw. */
async function fetchDashboardData() {
  try {
    const r = await fetch(DASH_DATA_URL, { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      if (d && d.sections && Object.keys(d.sections).length) {
        console.log('[update] 사전 수집 데이터 사용:', d.updated_at);
        return { data: d, source: 'static' };
      }
      console.warn('[update] 사전 수집 파일이 비어 있음 → 실시간 수집으로 폴백');
    } else if (r.status !== 404) {
      console.warn('[update] 사전 수집 파일 HTTP', r.status, '→ 실시간 수집으로 폴백');
    }
  } catch (e) {
    console.warn('[update] 사전 수집 파일 읽기 실패 → 실시간 수집으로 폴백:', e);
  }
  const res = await fetch(API_BASE + '/api/update', { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { data: await res.json(), source: 'live' };
}

/** 순수 추가: /api/update 응답에서 '건너뜀(캐시)'·'실패' 섹션을 요약한 문구.
 *  사용자가 "안 돈 것"과 "이미 최신이라 건너뛴 것"을 구분할 수 있게 한다. */
function updateStatusNote(data) {
  const secs = (data && data.sections) || {};
  const skipped = [], failed = [];
  Object.keys(secs).forEach((k) => {
    const v = secs[k];
    if (!v || typeof v !== 'object') return;
    if (v.cached) skipped.push(SECTION_LABELS[k] || k);
    else if (v.status && v.status !== 'ok') failed.push(SECTION_LABELS[k] || k);
  });
  if (skipped.length) console.log('[update] 건너뜀(캐시 재사용):', skipped.join(', '));
  if (failed.length) console.warn('[update] 수집 실패:', failed.join(', '));
  let s = '';
  if (skipped.length) s += ` · 건너뜀 ${skipped.length}건(${skipped.join(', ')})`;
  if (failed.length) s += ` · 실패 ${failed.length}건(${failed.join(', ')})`;
  return s;
}

/** 섹션 키 → 사람이 읽는 이름(위 문구 전용) */
const SECTION_LABELS = {
  simmons_news: '시몬스 소식', usd_krw: '환율(USD)', schedule_reliability: '해상 정시성',
  oil_crude: '국제유가(원유)', oil_product: '국제유가(제품)', domestic: '국내 브랜드', global_brands: '국외 브랜드',
  competitors: '경쟁사 실적', fx: '환율', icis_forecast: '주원료 예측',
  sr_forecast: '정시성 예측', koima_index: 'KOIMA 월간지수',
  us_ppi: '미국 매트리스 PPI',
};

/** [업데이트] 버튼: /api/update 호출 → 마지막 업데이트 시각 + 원자재 섹션 갱신 */
function initUpdate() {
  const btn = document.getElementById('updateBtn');
  const lbl = document.getElementById('lastUpdated');
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) clearBtn.addEventListener('click', resetDashboard);
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '불러오는 중…';
    updateWorldWeather();  // 세계 시간: Open-Meteo 날씨(서버 /api/update와 독립) → 마커 표시
    // 순수 추가: KOIMA 일일가격 — 미리 수집해 둔 정적 JSON 로드(즉시 완료).
    // await 하지 않는다 — 다른 카드가 이 로드를 기다리지 않게 한다.
    fetchKoimaPrice();
    // 순수 추가: 국내 실적·점유율 정적 JSON. await 하지 않는다 —
    // 다른 카드가 이 로드를 기다리지 않게 하고, 끝나면 스스로 다시 그린다.
    fetchSimmonsMarket();
    // 순수 추가: 국외 해외 슬립테크 시장·기업 정적 JSON (위와 같은 이유로 await 안 한다)
    fetchGlobalSleepTech();
    try {
      const { data, source } = await fetchDashboardData();
      // 순수 추가: 데이터 출처(사전 수집/실시간) + 캐시로 '건너뛴'·'실패한' 수집기를
      // 기존 라벨 뒤에 덧붙인다. (레이아웃은 그대로 — 문구만 늘린다)
      if (lbl && data.updated_at) lbl.textContent = '마지막 업데이트: ' + data.updated_at
        + (source === 'static' ? ' (사전 수집)' : '') + updateStatusNote(data);
      const dashUpd = document.getElementById('dashUpdated');
      if (dashUpd && data.updated_at) dashUpd.textContent = data.updated_at;
      applyFxUpdate(data);
      applyMaterialUpdate(data);
      applyKoimaUpdate(data);  // 순수 추가: KOIMA 부문별 지수(반드시 applyMaterialUpdate 뒤)
      applySimmonsNewsUpdate(data);
      applyDomesticUpdate(data);
      applyGlobalBrandsUpdate(data);
      applyCompetitorsUpdate(data);
    } catch (e) {
      if (lbl) lbl.textContent = '업데이트 실패 — 서버 실행을 확인하세요 (' + (e.message || e) + ')';
      console.warn('[update] 실패:', e);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
}
