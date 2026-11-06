// 셀러마진 UI 컨트롤러. 계산은 logic.js 에 있고 여기서는 DOM 연결만 한다.
// 사용자 입력과 저장 데이터는 모두 textContent 로만 표시한다 (innerHTML 사용 안 함).
import {
  CONSTANTS, HEALTH, HEALTH_LABEL, rnd, validateProduct, validateChannel, computeProduct,
  solvePriceForMargin, compareChannels, summarize, sortRows, mapCsvProducts, toCsv,
  defaultState, importStateJson, exportStateJson, newId, validateTargetMargin,
  checkKeyFormat, buildAdvicePrompt, parseAdviceReply, ruleBasedAdvice,
} from './logic.js';

const STORAGE_KEY = 'sellermargin-state';
const KEY_STORAGE = 'sellermargin-ai-key';
const AI_MODEL = 'claude-haiku-5-5';
const AI_TIMEOUT_MS = 30000;
const SAMPLE_PRODUCTS = [
  { name: '무선 충전 케이블 1m', sku: 'CBL-1M', channelId: 'smartstore', price: '9900', cogs: '2800', packaging: '300', shipping: '2500', returnRate: '4', returnLoss: '2000', adMode: 'perOrder', adPerOrder: '1500', volume: '300' },
  { name: '요가 매트 6mm', sku: 'YM-6', channelId: 'coupang', price: '29000', cogs: '14000', packaging: '1200', shipping: '3000', returnRate: '6', returnLoss: '3500', adMode: 'roas', roasTarget: '3.5', volume: '80' },
  { name: '스테인리스 텀블러 500ml', sku: 'TB-500', channelId: 'elevenst', price: '15900', cogs: '6500', packaging: '600', shipping: '2500', returnRate: '2', returnLoss: '1500', adMode: 'perOrder', adPerOrder: '4000', volume: '150' },
  { name: '자사몰 패키지 세트', sku: 'SET-01', channelId: 'own', price: '38000', cogs: '17000', packaging: '1500', shipping: '0', returnRate: '1', returnLoss: '0', adMode: 'roas', roasTarget: '5', volume: '40' },
];
const PRODUCT_FIELDS = ['name', 'sku', 'channelId', 'price', 'cogs', 'packaging', 'shipping', 'returnRate', 'returnLoss', 'adPerOrder', 'roasTarget', 'volume'];
const CSV_HEADERS = ['상품명', 'SKU', '채널', '판매가', '원가', '포장비', '배송비부담액', '반품률', '반품손실', '광고비', '목표ROAS', '월판매량'];

const $ = (id) => document.getElementById(id);
const won = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : `${n.toLocaleString('ko-KR')}원`);
const signedWon = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('ko-KR')}원`;
const pct = (v) => (v === null || v === undefined ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)}%`);
const roasTxt = (v) => (v === null ? '없음' : `${(Math.round(v * 100) / 100).toFixed(2)}배`);

/** 안전한 요소 생성: 문자열은 항상 textContent 로 들어간다. */
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
const chip = (health) => el('span', { class: `chip ${health}`, text: HEALTH_LABEL[health] });
const cls = (...xs) => xs.filter(Boolean).join(' ');

function setMsg(node, text, tone = '') {
  node.className = cls('form-msg', tone);
  node.textContent = text;
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ *
 * 상태
 * ------------------------------------------------------------------ */
let state = loadState();
let loadNotice = '';
const ui = {
  sort: { key: 'net', dir: 'asc' },
  selectedId: null,
  editingId: null,
  csv: { text: '', parsed: null, source: '' },
  whatif: null,
  aiBusy: false,
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const res = importStateJson(raw);
    if (res.ok) {
      if (res.dropped && (res.dropped.products || res.dropped.channels)) {
        loadNotice = `저장된 데이터 중 일부(상품 ${res.dropped.products}개, 채널 ${res.dropped.channels}개)를 형식 오류로 건너뛰었습니다.`;
      }
      return res.state;
    }
    loadNotice = `저장된 데이터를 읽지 못해 예시 설정으로 시작합니다 (${res.error}).`;
  } catch {
    loadNotice = '브라우저 저장소에 접근할 수 없어 이번 방문에는 저장되지 않습니다.';
  }
  return defaultState();
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function persist(msgNode, okText) {
  const ok = save();
  if (msgNode) setMsg(msgNode, ok ? okText : '저장 공간에 쓸 수 없어 이 변경은 새로고침 후 사라집니다.', ok ? 'ok' : 'bad');
  renderAll();
  return ok;
}

const channelById = (id) => state.channels.find((c) => c.id === id) || state.channels[0];
const productById = (id) => state.products.find((p) => p.id === id) || null;

function computeRows() {
  const tm = state.settings.targetMargin;
  return state.products.map((product) => {
    const channel = channelById(product.channelId);
    return { product, channel, result: computeProduct(product, channel, { targetMargin: tm }) };
  });
}

/* ------------------------------------------------------------------ *
 * 렌더링
 * ------------------------------------------------------------------ */
function renderAll() {
  renderSummary();
  renderProducts();
  renderDetail();
  renderChannels();
  renderChannelSelect();
  renderAiPayload();
}

function renderBasis() {
  $('basis-line').textContent = `기준: 예시 수수료 기준일 ${CONSTANTS.AS_OF_DATE} (직접 확인 필요) · ${CONSTANTS.VAT_SOURCE} · 금액은 원 단위 정수로 반올림합니다.`;
}

function renderSummary() {
  const rows = computeRows();
  const tm = state.settings.targetMargin;
  const s = summarize(rows, tm);
  const kpis = $('kpis');
  kpis.replaceChildren(
    el('div', {}, el('dt', { text: '등록 상품' }), el('dd', { text: `${s.count}개` })),
    el('div', {}, el('dt', { text: '적자 판매 중' }), el('dd', { class: s.lossSelling ? 'bad' : '', text: `${s.lossSelling}개` })),
    el('div', {}, el('dt', { text: `목표(${tm}%) 미달` }), el('dd', { text: `${s.belowTarget}개` })),
    el('div', {}, el('dt', { text: '월 예상 순이익' }), el('dd', { class: s.monthlyNet < 0 ? 'bad' : '', text: won(s.monthlyNet) })),
    el('div', {}, el('dt', { text: '월 광고비 총액' }), el('dd', { text: won(s.monthlyAd) })),
    el('div', {}, el('dt', { text: '월 예상 마진율' }), el('dd', { text: pct(s.monthlyMarginRate) })),
  );
  const w = $('warnings');
  w.replaceChildren();
  if (s.count === 0) {
    w.append(el('p', { class: 'warn ok', text: '상품을 추가하면 적자와 목표 미달을 여기서 알려 줍니다.' }));
  } else {
    if (s.lossSelling > 0) w.append(el('p', { class: 'warn loss', text: `적자 판매 중인 상품이 ${s.lossSelling}개 있습니다 (월 판매량 1개 이상 기준).` }));
    if (s.belowTarget > 0) w.append(el('p', { class: 'warn risk', text: `마진율이 목표 ${tm}% 미만인 상품이 ${s.belowTarget}개 있습니다.` }));
    if (s.lossSelling === 0 && s.belowTarget === 0) w.append(el('p', { class: 'warn ok', text: '모든 상품이 목표 마진율 이상입니다.' }));
  }
  const wrap = $('worst-wrap');
  wrap.hidden = s.count === 0;
  const list = $('worst-list');
  list.replaceChildren(...s.worst.map((r) => el('li', {},
    el('button', { type: 'button', onclick: () => selectProduct(r.product.id) },
      `${r.product.name} · 순마진 ${won(r.result.net)} · 마진율 ${pct(r.result.marginRate)}`),
  )));
}

function renderProducts() {
  const rows = computeRows();
  const text = $('filter-text').value.trim().toLowerCase();
  const lossOnly = $('filter-loss').checked;
  let view = rows.filter((r) => {
    if (lossOnly && !(r.result.net < 0)) return false;
    if (text && !(`${r.product.name} ${r.product.sku}`.toLowerCase().includes(text))) return false;
    return true;
  });
  view = sortRows(view, ui.sort.key, ui.sort.dir);

  document.querySelectorAll('button.sort').forEach((btn) => {
    const active = btn.dataset.sort === ui.sort.key;
    btn.closest('th').setAttribute('aria-sort', active ? (ui.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  const body = $('product-body');
  body.replaceChildren(...view.map(({ product: p, channel, result: r }) => el('tr', { class: p.id === ui.selectedId ? 'selected' : '' },
    el('td', {},
      el('strong', { text: p.name }),
      el('span', { class: 'sub', text: p.sku ? `SKU ${p.sku}` : ' ' }),
    ),
    el('td', { class: 'hide-sm', text: channel.name }),
    el('td', { class: 'num', text: won(p.price) }),
    el('td', { class: cls('num', r.net < 0 && 'neg'), text: won(r.net) }),
    el('td', { class: 'num', text: pct(r.marginRate) }),
    el('td', { class: 'num', text: roasTxt(r.bepRoas) }),
    el('td', {}, chip(r.health)),
    el('td', {},
      el('div', { class: 'row-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': `${p.name} 상세 보기`, onclick: () => selectProduct(p.id), text: '보기' }),
        el('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': `${p.name} 수정`, onclick: () => editProduct(p.id), text: '수정' }),
        el('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': `${p.name} 삭제`, onclick: () => deleteProduct(p.id), text: '삭제' }),
      ),
    ),
  )));
  const empty = $('product-empty');
  empty.hidden = view.length > 0;
  empty.textContent = state.products.length === 0
    ? '아직 상품이 없습니다. 위 양식으로 추가하거나 예시 상품을 불러오세요.'
    : '조건에 맞는 상품이 없습니다. 검색어나 필터를 바꿔 보세요.';
}

function renderChannelSelect() {
  const sel = $('pf-channel');
  const current = sel.value;
  sel.replaceChildren(...state.channels.map((c) => el('option', { value: c.id, text: c.name })));
  if (state.channels.some((c) => c.id === current)) sel.value = current;
}

function renderDetail() {
  const panel = $('panel-detail');
  const p = productById(ui.selectedId);
  panel.hidden = !p;
  if (!p) { ui.whatif = null; return; }
  const ch = channelById(p.channelId);
  const tm = state.settings.targetMargin;
  const r = computeProduct(p, ch, { targetMargin: tm });
  const solved = solvePriceForMargin(p, ch, tm, { targetMargin: tm });
  $('detail-title').textContent = `상품 상세 · ${p.name}`;

  const metrics = el('div', { class: 'metrics' },
    el('div', { class: 'metric hero-metric' }, el('div', { class: 'label', text: '순마진 (주문 1건)' }), el('div', { class: cls('value', r.net < 0 && 'neg'), text: won(r.net) }), el('div', { class: 'hint', text: '광고비·반품 기대값 반영 후' })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: '마진율' }), el('div', { class: 'value', text: pct(r.marginRate) }), el('div', { class: 'hint', text: `목표 ${tm}% · 상태 ${HEALTH_LABEL[r.health]}` })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: '손익분기 ROAS' }), el('div', { class: 'value', text: roasTxt(r.bepRoas) }), el('div', { class: 'hint', text: r.bepRoas === null ? '광고 전 이익이 0 이하라 광고로 맞출 수 없습니다' : '실제 ROAS가 이 값 이상이어야 광고 후 이익이 남습니다' })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: '손익분기 광고비 (주문당)' }), el('div', { class: cls('value', r.bepAd < 0 && 'neg'), text: won(r.bepAd) }), el('div', { class: 'hint', text: r.bepAd < 0 ? '광고 전 적자입니다' : '이 금액 이하로 쓰면 이익 0 이상' })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: `목표 마진율 ${tm}%를 위한 판매가` }), el('div', { class: 'value', text: solved === null ? '도달 불가' : won(solved) }), el('div', { class: 'hint', text: solved === null ? '현재 원가·수수료·광고비로는 목표에 닿지 않습니다' : `현재 판매가 ${won(p.price)}` })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: '반품 반영 기대 마진율' }), el('div', { class: 'value', text: pct(r.marginRate) }), el('div', { class: 'hint', text: `반품 전 ${pct(r.marginNoReturn)} · 기대 반품 손실 ${won(r.returnDrag)}` })),
  );

  const line = (label, value, cls2 = '') => el('tr', { class: cls2 }, el('td', { text: label }), el('td', { text: value }));
  const breakdown = el('table', { class: 'breakdown', 'aria-label': '정산 내역' },
    el('tbody', {},
      line('판매가 (정가)', won(p.price)),
      line('할인·쿠폰 적용 판매가', won(r.effectivePrice)),
      line('− 부가세', signedWon(-r.vat)),
      line('= 매출 (부가세 제외)', won(r.netRevenue)),
      line('− 판매 수수료', signedWon(-r.saleFee)),
      line('− 결제/PG 수수료', signedWon(-r.pgFee)),
      line('− 주문당 고정 수수료', signedWon(-r.fixedFee)),
      line('− 원가', signedWon(-r.cogs)),
      line('− 포장비', signedWon(-p.packaging)),
      line('− 배송비 부담액', signedWon(-p.shipping)),
      line('− 반품 기대 손실', signedWon(-r.returnDrag)),
      line('− 광고비 (주문당)', signedWon(-r.adPerOrder)),
      line('= 순마진', won(r.net), 'total'),
    ),
  );

  const compare = compareChannels(p, state.channels, { targetMargin: tm });
  const compareTable = el('div', { class: 'table-wrap', tabindex: '0' },
    el('table', { class: 'data' },
      el('caption', { class: 'sr-only', text: '채널별 비교' }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: '채널' }),
        el('th', { scope: 'col', class: 'num', text: '순마진' }),
        el('th', { scope: 'col', class: 'num', text: '마진율' }),
        el('th', { scope: 'col', class: 'num', text: '손익분기 ROAS' }),
        el('th', { scope: 'col', text: '상태' }),
      )),
      el('tbody', {}, compare.map(({ channel, result }) => el('tr', { class: channel.id === p.channelId ? 'selected' : '' },
        el('td', {}, channel.name, channel.id === p.channelId ? el('span', { class: 'sub', text: '현재 상품의 채널' }) : null),
        el('td', { class: cls('num', result.net < 0 && 'neg'), text: won(result.net) }),
        el('td', { class: 'num', text: pct(result.marginRate) }),
        el('td', { class: 'num', text: roasTxt(result.bepRoas) }),
        el('td', {}, chip(result.health)),
      ))),
    ),
  );

  if (!ui.whatif || ui.whatif.productId !== p.id) {
    ui.whatif = { productId: p.id, price: p.price, discountRate: 0, coupon: 0, cogs: p.cogs, adPerOrder: r.adPerOrder, returnRate: p.returnRate };
  }
  const w = ui.whatif;
  const sliderDefs = [
    { key: 'price', label: '판매가', min: Math.max(1, Math.round(p.price * 0.5)), max: Math.min(CONSTANTS.MAX_PRICE, Math.round(p.price * 1.5) + 1), step: 10, unit: '원' },
    { key: 'discountRate', label: '할인율', min: 0, max: 50, step: 1, unit: '%' },
    { key: 'cogs', label: '원가', min: 0, max: Math.max(1000, p.cogs * 2), step: 10, unit: '원' },
    { key: 'adPerOrder', label: '주문당 광고비', min: 0, max: Math.max(1000, Math.round(r.adPerOrder * 2)), step: 10, unit: '원' },
    { key: 'returnRate', label: '반품률', min: 0, max: 100, step: 0.5, unit: '%' },
  ];
  const resultBox = el('div', { id: 'whatif-result', 'aria-live': 'polite' });
  const sliders = sliderDefs.map((d) => {
    const out = el('output', { for: `wi-${d.key}`, text: `${w[d.key]}${d.unit}` });
    const input = el('input', { type: 'range', id: `wi-${d.key}`, min: d.min, max: d.max, step: d.step, value: Math.min(d.max, Math.max(d.min, w[d.key])) });
    input.addEventListener('input', () => {
      w[d.key] = Number(input.value);
      out.textContent = `${w[d.key]}${d.unit}`;
      updateWhatIf(p, ch);
    });
    return el('div', { class: 'slider' }, el('div', { class: 'top' }, el('label', { for: `wi-${d.key}`, text: d.label }), out), input);
  });
  const couponInput = el('input', { id: 'wi-coupon', type: 'text', inputmode: 'numeric', value: String(w.coupon), autocomplete: 'off' });
  couponInput.addEventListener('input', () => {
    const v = Number(String(couponInput.value).replace(/[,\s원]/g, ''));
    w.coupon = Number.isSafeInteger(v) && v >= 0 && v <= CONSTANTS.MAX_MONEY ? v : 0;
    updateWhatIf(p, ch);
  });
  const reset = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '기준값으로 되돌리기', onclick: () => { ui.whatif = null; renderDetail(); } });

  const whatif = el('div', { class: 'whatif' },
    el('h4', { text: '시뮬레이션 (저장되지 않음)' }),
    el('p', { class: 'basis', text: '슬라이더를 움직이면 아래 표가 바로 바뀝니다. 쿠폰은 할인 후 판매가에서 원 단위로 뺍니다.' }),
    el('div', { class: 'slider-grid' }, sliders, el('div', { class: 'slider' }, el('div', { class: 'top' }, el('label', { for: 'wi-coupon', text: '쿠폰 (원)' })), couponInput)),
    el('div', { class: 'inline-actions' }, reset),
    resultBox,
  );

  const body = $('detail-body');
  body.replaceChildren(
    el('p', {}, el('span', { class: 'ai-tag', text: `SKU ${p.sku || '없음'}` }), el('span', { class: 'ai-tag', text: ch.name }), el('span', { class: 'ai-tag', text: `월 판매량 ${p.volume.toLocaleString('ko-KR')}개` }), chip(r.health)),
    metrics,
    el('div', { class: 'card-grid-2' }, breakdown, el('div', {}, el('h4', { text: '채널별 비교 (같은 상품, 같은 가격)' }), compareTable)),
    whatif,
  );
  updateWhatIf(p, ch);
}

function updateWhatIf(p, ch) {
  const w = ui.whatif;
  const tm = state.settings.targetMargin;
  const base = computeProduct(p, ch, { targetMargin: tm });
  const sim = computeProduct(p, ch, {
    targetMargin: tm, price: w.price, cogs: w.cogs, adPerOrder: w.adPerOrder,
    returnRate: w.returnRate, discountRate: w.discountRate, coupon: w.coupon,
  });
  const delta = (a, b, fmt, unit = '') => {
    if (a === null || b === null) return '—';
    const d = b - a;
    const s = `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmt(Math.abs(d))}${unit}`;
    return s;
  };
  const rows = [
    ['순마진', won(base.net), won(sim.net), delta(base.net, sim.net, (x) => x.toLocaleString('ko-KR'), '원'), sim.net - base.net],
    ['마진율', pct(base.marginRate), pct(sim.marginRate), delta(base.marginRate, sim.marginRate, (x) => (Math.round(x * 100) / 100).toFixed(2), '%p'), (sim.marginRate ?? 0) - (base.marginRate ?? 0)],
    ['손익분기 ROAS', roasTxt(base.bepRoas), roasTxt(sim.bepRoas), delta(base.bepRoas, sim.bepRoas, (x) => (Math.round(x * 100) / 100).toFixed(2), '배'), (sim.bepRoas ?? 0) - (base.bepRoas ?? 0)],
    ['상태', HEALTH_LABEL[base.health], HEALTH_LABEL[sim.health], base.health === sim.health ? '변화 없음' : `${HEALTH_LABEL[base.health]} → ${HEALTH_LABEL[sim.health]}`, 0],
  ];
  $('whatif-result').replaceChildren(el('div', { class: 'table-wrap', tabindex: '0' },
    el('table', { class: 'data' },
      el('caption', { class: 'sr-only', text: '시뮬레이션 결과와 기준값 비교' }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: '지표' }), el('th', { scope: 'col', class: 'num', text: '기준' }),
        el('th', { scope: 'col', class: 'num', text: '시뮬레이션' }), el('th', { scope: 'col', class: 'num', text: '변화' }),
      )),
      el('tbody', {}, rows.map(([label, a, b, d, sign]) => el('tr', {},
        el('td', { text: label }), el('td', { class: 'num', text: a }), el('td', { class: 'num', text: b }),
        el('td', { class: cls('num delta', sign > 0 && 'up', sign < 0 && 'down'), text: d }),
      ))),
    ),
  ));
}

function renderChannels() {
  const body = $('channel-body');
  const presets = new Map(CONSTANTS.CHANNEL_PRESETS.map((c) => [c.id, c]));
  body.replaceChildren(...state.channels.map((c) => {
    const preset = presets.get(c.id);
    const edited = preset && (preset.saleFeeRate !== c.saleFeeRate || preset.pgFeeRate !== c.pgFeeRate || preset.fixedFee !== c.fixedFee || preset.vatSeparate !== c.vatSeparate || preset.name !== c.name);
    const label = preset ? (edited ? '예시 · 수정됨' : '예시') : '직접 추가';
    const err = el('p', { class: 'field-error', role: 'alert' });
    const inputs = {
      name: el('input', { type: 'text', value: c.name, maxlength: '40', 'aria-label': `${c.name} 채널 이름` }),
      saleFeeRate: el('input', { type: 'text', inputmode: 'decimal', value: String(c.saleFeeRate), 'aria-label': `${c.name} 판매 수수료` }),
      pgFeeRate: el('input', { type: 'text', inputmode: 'decimal', value: String(c.pgFeeRate), 'aria-label': `${c.name} 결제 수수료` }),
      fixedFee: el('input', { type: 'text', inputmode: 'numeric', value: String(c.fixedFee), 'aria-label': `${c.name} 고정 수수료` }),
    };
    const vat = el('input', { type: 'checkbox', checked: c.vatSeparate, 'aria-label': `${c.name} 부가세 분리` });
    const save = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '저장', onclick: () => {
      const res = validateChannel({ id: c.id, name: inputs.name.value, saleFeeRate: inputs.saleFeeRate.value, pgFeeRate: inputs.pgFeeRate.value, fixedFee: inputs.fixedFee.value, vatSeparate: vat.checked });
      if (!res.ok) {
        err.textContent = Object.values(res.errors).join(' / ');
        return;
      }
      const idx = state.channels.findIndex((x) => x.id === c.id);
      state.channels[idx] = { ...res.channel, source: c.source };
      persist(null, '');
      setMsg($('cf-msg'), `${res.channel.name} 채널을 저장했습니다.`, 'ok');
    } });
    const remove = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '삭제', onclick: () => {
      const used = state.products.filter((p) => p.channelId === c.id).length;
      if (state.channels.length <= 1) { err.textContent = '채널은 최소 1개 남아 있어야 합니다.'; return; }
      if (used > 0) { err.textContent = `이 채널을 쓰는 상품이 ${used}개 있습니다. 상품의 채널을 먼저 바꾸세요.`; return; }
      if (!window.confirm(`${c.name} 채널을 삭제할까요?`)) return;
      state.channels = state.channels.filter((x) => x.id !== c.id);
      persist(null, '');
    } });
    return el('tr', {},
      el('td', {}, inputs.name, el('span', { class: 'sub', text: label })),
      el('td', { class: 'num' }, inputs.saleFeeRate),
      el('td', { class: 'num' }, inputs.pgFeeRate),
      el('td', { class: 'num' }, inputs.fixedFee),
      el('td', {}, el('label', { class: 'check' }, vat, '분리')),
      el('td', {}, el('div', { class: 'row-actions' }, save, remove), err),
    );
  }));
}

function renderAiPayload() {
  const rows = computeRows();
  const s = summarize(rows, state.settings.targetMargin);
  const items = s.worst.map((r) => toAiItem(r));
  const includeNames = $('ai-names').checked;
  const names = s.worst.map((r) => r.product.name);
  $('ai-payload').textContent = items.length
    ? buildAdvicePrompt(items, { targetMargin: state.settings.targetMargin, includeNames, names })
    : '상품을 추가하면 전송될 요약이 여기에 표시됩니다.';
}

function toAiItem(r) {
  return {
    price: r.product.price,
    net: r.result.net,
    marginRate: r.result.marginRate,
    bepRoas: r.result.bepRoas,
    adPerOrder: r.result.adPerOrder,
    returnRate: r.product.returnRate,
    volume: r.product.volume,
  };
}

/* ------------------------------------------------------------------ *
 * 상품 입력
 * ------------------------------------------------------------------ */
function readProductForm() {
  return {
    id: $('pf-id').value || '',
    name: $('pf-name').value,
    sku: $('pf-sku').value,
    channelId: $('pf-channel').value,
    price: $('pf-price').value,
    cogs: $('pf-cogs').value,
    packaging: $('pf-packaging').value,
    shipping: $('pf-shipping').value,
    returnRate: $('pf-returnRate').value,
    returnLoss: $('pf-returnLoss').value,
    adMode: document.querySelector('input[name="adMode"]:checked')?.value || 'perOrder',
    adPerOrder: $('pf-adPerOrder').value,
    roasTarget: $('pf-roasTarget').value,
    volume: $('pf-volume').value,
  };
}

function setAdMode(mode) {
  document.querySelector(`input[name="adMode"][value="${mode}"]`).checked = true;
  $('wrap-adPerOrder').hidden = mode === 'roas';
  $('wrap-roasTarget').hidden = mode !== 'roas';
}

function resetProductForm() {
  ui.editingId = null;
  $('product-form').reset();
  $('pf-id').value = '';
  setAdMode('perOrder');
  $('pf-submit').textContent = '상품 저장';
  $('pf-cancel').hidden = true;
  $('form-title').textContent = '상품 추가';
  $('pf-errors').replaceChildren();
  document.querySelectorAll('#product-form [aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
}

function showFormErrors(errors) {
  const box = $('pf-errors');
  box.replaceChildren(...Object.values(errors).map((m) => el('p', { text: m })));
  const ids = { name: 'pf-name', sku: 'pf-sku', channelId: 'pf-channel', price: 'pf-price', cogs: 'pf-cogs', packaging: 'pf-packaging', shipping: 'pf-shipping', returnRate: 'pf-returnRate', returnLoss: 'pf-returnLoss', adPerOrder: 'pf-adPerOrder', roasTarget: 'pf-roasTarget', volume: 'pf-volume' };
  for (const key of Object.keys(errors)) {
    const node = $(ids[key]);
    if (node) node.setAttribute('aria-invalid', 'true');
  }
  const first = Object.keys(errors)[0];
  if (first && $(ids[first])) $(ids[first]).focus();
}

function onProductSubmit(e) {
  e.preventDefault();
  const raw = readProductForm();
  const res = validateProduct(raw, state.channels.map((c) => c.id));
  document.querySelectorAll('#product-form [aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
  if (!res.ok) {
    showFormErrors(res.errors);
    setMsg($('pf-msg'), '입력을 확인해 주세요.', 'bad');
    return;
  }
  $('pf-errors').replaceChildren();
  let savedId;
  if (ui.editingId) {
    const idx = state.products.findIndex((p) => p.id === ui.editingId);
    if (idx < 0) { setMsg($('pf-msg'), '수정할 상품을 찾지 못했습니다.', 'bad'); return; }
    state.products[idx] = { ...res.product, id: ui.editingId };
    savedId = ui.editingId;
  } else {
    if (state.products.length >= CONSTANTS.MAX_PRODUCTS) {
      setMsg($('pf-msg'), `상품은 최대 ${CONSTANTS.MAX_PRODUCTS}개까지 저장할 수 있습니다.`, 'bad');
      return;
    }
    res.product.id = newId('p');
    state.products.push(res.product);
    savedId = res.product.id;
  }
  const wasEditing = !!ui.editingId;
  resetProductForm();
  ui.selectedId = savedId;
  persist($('pf-msg'), wasEditing ? '상품을 수정했습니다.' : '상품을 추가했습니다.');
  scrollToNode($('panel-detail'));
}

function editProduct(id) {
  const p = productById(id);
  if (!p) return;
  ui.editingId = id;
  $('pf-id').value = id;
  $('pf-name').value = p.name;
  $('pf-sku').value = p.sku;
  $('pf-channel').value = p.channelId;
  $('pf-price').value = String(p.price);
  $('pf-cogs').value = String(p.cogs);
  $('pf-packaging').value = String(p.packaging);
  $('pf-shipping').value = String(p.shipping);
  $('pf-returnRate').value = String(p.returnRate);
  $('pf-returnLoss').value = String(p.returnLoss);
  $('pf-adPerOrder').value = p.adMode === 'perOrder' ? String(p.adPerOrder) : '';
  $('pf-roasTarget').value = p.adMode === 'roas' ? String(p.roasTarget) : '';
  $('pf-volume').value = p.volume ? String(p.volume) : '';
  setAdMode(p.adMode);
  $('pf-submit').textContent = '수정 저장';
  $('pf-cancel').hidden = false;
  $('form-title').textContent = `상품 수정 · ${p.name}`;
  setMsg($('pf-msg'), '값을 고친 뒤 수정 저장을 누르세요.');
  $('pf-name').focus();
  scrollToNode($('product-form'));
}

function deleteProduct(id) {
  const p = productById(id);
  if (!p) return;
  if (!window.confirm(`"${p.name}" 상품을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  state.products = state.products.filter((x) => x.id !== id);
  if (ui.selectedId === id) ui.selectedId = null;
  if (ui.editingId === id) resetProductForm();
  persist(null, '');
}

function selectProduct(id) {
  ui.selectedId = id;
  ui.whatif = null;
  renderAll();
  scrollToNode($('panel-detail'));
}

function scrollToNode(node) {
  if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' });
}

function loadSamples() {
  const ids = state.channels.map((c) => c.id);
  const added = [];
  for (const raw of SAMPLE_PRODUCTS) {
    const res = validateProduct({ ...raw, channelId: ids.includes(raw.channelId) ? raw.channelId : ids[0] }, ids);
    if (res.ok) { res.product.id = newId('p'); added.push(res.product); }
  }
  if (state.products.length + added.length > CONSTANTS.MAX_PRODUCTS) return 0;
  state.products.push(...added);
  return added.length;
}

/* ------------------------------------------------------------------ *
 * 채널 추가 / 목표 마진율
 * ------------------------------------------------------------------ */
function onChannelSubmit(e) {
  e.preventDefault();
  const res = validateChannel({
    name: $('cf-name').value,
    saleFeeRate: $('cf-sale').value,
    pgFeeRate: $('cf-pg').value,
    fixedFee: $('cf-fixed').value,
    vatSeparate: $('cf-vat').checked,
  });
  if (!res.ok) {
    $('cf-errors').replaceChildren(...Object.values(res.errors).map((m) => el('p', { text: m })));
    setMsg($('cf-msg'), '입력을 확인해 주세요.', 'bad');
    return;
  }
  $('cf-errors').replaceChildren();
  state.channels.push({ ...res.channel, source: 'custom' });
  ['cf-name', 'cf-sale', 'cf-pg', 'cf-fixed'].forEach((id) => { $(id).value = ''; });
  persist($('cf-msg'), `${res.channel.name} 채널을 추가했습니다.`);
}

function onTargetSave() {
  const res = validateTargetMargin($('target-margin').value);
  if (!res.ok) {
    $('target-err').textContent = res.error;
    return;
  }
  $('target-err').textContent = '';
  state.settings.targetMargin = res.value;
  $('target-margin').value = String(res.value);
  persist(null, '');
}

/* ------------------------------------------------------------------ *
 * CSV / JSON
 * ------------------------------------------------------------------ */
function previewCsv() {
  const text = $('csv-text').value;
  const msg = $('csv-msg');
  if (!text.trim()) {
    ui.csv.parsed = null;
    $('btn-csv-import').disabled = true;
    setMsg(msg, 'CSV 내용을 붙여넣거나 파일을 선택하세요.', 'bad');
    $('csv-errors').replaceChildren();
    return;
  }
  const parsed = mapCsvProducts(text, state.channels);
  ui.csv.parsed = parsed;
  const room = CONSTANTS.MAX_PRODUCTS - state.products.length;
  const overflow = parsed.products.length > room;
  $('btn-csv-import').disabled = parsed.products.length === 0 || overflow;
  const summary = `전체 ${parsed.total}행 중 ${parsed.products.length}행 가져오기 가능, ${parsed.errors.length}개 오류`;
  setMsg(msg, overflow ? `상품 한도(${CONSTANTS.MAX_PRODUCTS}개)를 넘습니다. 행을 줄이세요.` : summary, parsed.errors.length ? '' : 'ok');
  const list = el('ul', { class: 'error-list', 'aria-label': 'CSV 오류 목록' },
    parsed.errors.slice(0, 50).map((er) => el('li', { text: er.line ? `${er.line}행: ${er.message}` : er.message })),
  );
  $('csv-errors').replaceChildren(...(parsed.errors.length ? [list] : []));
}

function importCsv() {
  const parsed = ui.csv.parsed;
  if (!parsed || parsed.products.length === 0) return;
  const products = parsed.products.map((p) => ({ ...p, id: newId('p') }));
  state.products.push(...products);
  ui.csv = { text: '', parsed: null, source: '' };
  $('csv-text').value = '';
  $('csv-file').value = '';
  $('csv-errors').replaceChildren();
  $('btn-csv-import').disabled = true;
  persist($('csv-msg'), `${products.length}개 상품을 추가했습니다.`);
}

function exportProductsCsv() {
  const rows = state.products.map((p) => [
    p.name, p.sku, channelById(p.channelId).name, p.price, p.cogs, p.packaging, p.shipping, p.returnRate, p.returnLoss,
    p.adMode === 'perOrder' ? p.adPerOrder : '', p.adMode === 'roas' ? p.roasTarget : '', p.volume,
  ]);
  download(`sellermargin-products-${stamp()}.csv`, toCsv(CSV_HEADERS, rows), 'text/csv;charset=utf-8');
}

function exportResultsCsv() {
  const rows = computeRows().map(({ product: p, channel, result: r }) => [
    p.name, p.sku, channel.name, r.effectivePrice, r.netRevenue, r.vat, r.net,
    r.marginRate === null ? '' : Math.round(r.marginRate * 100) / 100,
    r.bepRoas === null ? '' : Math.round(r.bepRoas * 100) / 100,
    r.bepAd, HEALTH_LABEL[r.health], p.volume, r.net * p.volume,
  ]);
  download(`sellermargin-results-${stamp()}.csv`, toCsv(['상품명', 'SKU', '채널', '할인후판매가', '매출(부가세제외)', '부가세', '순마진', '마진율(%)', '손익분기ROAS', '손익분기광고비', '상태', '월판매량', '월예상순이익'], rows), 'text/csv;charset=utf-8');
}

function stamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function onJsonFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    setMsg($('backup-msg'), '파일이 5MB보다 큽니다. 백업 파일이 맞는지 확인하세요.', 'bad');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const res = importStateJson(String(reader.result));
    if (!res.ok) {
      setMsg($('backup-msg'), `가져오지 못했습니다: ${res.error}`, 'bad');
      e.target.value = '';
      return;
    }
    if (!window.confirm(`현재 데이터를 백업 파일(상품 ${res.state.products.length}개)로 덮어쓸까요?`)) {
      e.target.value = '';
      return;
    }
    state = res.state;
    ui.selectedId = null;
    resetProductForm();
    const dropped = res.dropped.products ? ` (형식 오류 ${res.dropped.products}개 건너뜀)` : '';
    persist($('backup-msg'), `백업을 가져왔습니다${dropped}.`);
    e.target.value = '';
  };
  reader.onerror = () => setMsg($('backup-msg'), '파일을 읽지 못했습니다.', 'bad');
  reader.readAsText(file);
}

/* ------------------------------------------------------------------ *
 * AI 패널
 * ------------------------------------------------------------------ */
function readKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}

function onKeySave(e) {
  e.preventDefault();
  const res = checkKeyFormat($('ai-key').value);
  if (!res.ok) { setMsg($('ai-key-msg'), res.error, 'bad'); return; }
  try {
    localStorage.setItem(KEY_STORAGE, res.key);
    $('ai-key').value = '';
    setMsg($('ai-key-msg'), '키를 이 브라우저에 저장했습니다 (형식만 확인, 실제 유효성은 분석 시 확인됩니다).', 'ok');
  } catch {
    setMsg($('ai-key-msg'), '브라우저 저장소에 쓸 수 없어 키를 저장하지 못했습니다.', 'bad');
  }
}

function onKeyRemove() {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* 무시 */ }
  $('ai-key').value = '';
  setMsg($('ai-key-msg'), '저장된 키를 삭제했습니다.', 'ok');
}

function worstEntries() {
  const rows = computeRows();
  const s = summarize(rows, state.settings.targetMargin);
  const includeNames = $('ai-names').checked;
  return s.worst.map((r, idx) => ({
    label: includeNames ? r.product.name : `상품 ${String.fromCharCode(65 + idx)}`,
    product: r.product,
    channel: r.channel,
    result: r.result,
  }));
}

function renderAdvice(advice, sourceText) {
  const out = $('ai-output');
  const typeLabel = { price: '가격', ad: '광고', return: '반품', cost: '원가', other: '기타' };
  out.replaceChildren(
    el('p', { class: 'summary', text: advice.summary }),
    el('p', { class: 'small', text: sourceText }),
    advice.actions.length
      ? el('ul', {}, advice.actions.map((a) => el('li', {}, el('span', { class: 'ai-tag', text: typeLabel[a.type] || '기타' }), el('strong', { text: `${a.product}: ` }), a.suggestion)))
      : el('p', { text: '표시할 조치가 없습니다.' }),
  );
}

function onLocalAdvice() {
  const entries = worstEntries();
  if (entries.length === 0) { setMsg($('ai-msg'), '상품을 먼저 추가하세요.', 'bad'); return; }
  const advice = ruleBasedAdvice(entries, state.settings.targetMargin);
  renderAdvice(advice, '규칙 기반 분석 · API를 호출하지 않았습니다.');
  setMsg($('ai-msg'), '규칙 기반 분석을 표시했습니다.', 'ok');
}

async function onAiRun() {
  if (ui.aiBusy) return;
  const key = readKey();
  const entries = worstEntries();
  if (entries.length === 0) { setMsg($('ai-msg'), '상품을 먼저 추가하세요.', 'bad'); return; }
  if (!key) { setMsg($('ai-msg'), '키가 없습니다. 위에 키를 저장하거나 "키 없이 규칙 기반 분석"을 사용하세요.', 'bad'); return; }
  const includeNames = $('ai-names').checked;
  const prompt = buildAdvicePrompt(entries.map((e) => toAiItem({ product: e.product, result: e.result })), {
    targetMargin: state.settings.targetMargin, includeNames, names: entries.map((e) => e.product.name),
  });
  ui.aiBusy = true;
  const btn = $('ai-run');
  btn.disabled = true;
  setMsg($('ai-msg'), 'AI에 요청 중입니다…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const hint = res.status === 401 ? '키가 올바르지 않습니다.' : res.status === 429 ? '요청 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.' : '';
      setMsg($('ai-msg'), `AI 요청이 실패했습니다 (HTTP ${res.status}). ${hint}`, 'bad');
      return;
    }
    const data = await res.json();
    const text = Array.isArray(data?.content) ? data.content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('') : '';
    const parsed = parseAdviceReply(text);
    if (!parsed.ok) {
      setMsg($('ai-msg'), `응답을 해석하지 못했습니다: ${parsed.error}. 규칙 기반 분석을 사용해 보세요.`, 'bad');
      return;
    }
    renderAdvice(parsed, `AI 분석 (${AI_MODEL}) · 전송한 내용: 최하위 ${entries.length}개의 숫자 요약${includeNames ? ' + 상품명' : ' (상품명 제외)'}`);
    setMsg($('ai-msg'), 'AI 분석을 표시했습니다. 참고용으로만 사용하세요.', 'ok');
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    setMsg($('ai-msg'), aborted ? '응답 시간이 초과되었습니다.' : '네트워크 또는 브라우저 제한으로 요청하지 못했습니다.', 'bad');
  } finally {
    clearTimeout(timer);
    ui.aiBusy = false;
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * 초기화
 * ------------------------------------------------------------------ */
function bind() {
  $('btn-target-save').addEventListener('click', onTargetSave);
  $('target-margin').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onTargetSave(); } });
  $('product-form').addEventListener('submit', onProductSubmit);
  $('pf-cancel').addEventListener('click', () => { resetProductForm(); setMsg($('pf-msg'), '수정을 취소했습니다.'); });
  document.querySelectorAll('input[name="adMode"]').forEach((r) => r.addEventListener('change', () => setAdMode(r.value)));
  document.querySelectorAll('button.sort').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    if (ui.sort.key === key) ui.sort.dir = ui.sort.dir === 'asc' ? 'desc' : 'asc';
    else { ui.sort.key = key; ui.sort.dir = key === 'name' ? 'asc' : 'desc'; }
    renderProducts();
  }));
  $('filter-text').addEventListener('input', renderProducts);
  $('filter-loss').addEventListener('change', renderProducts);
  $('btn-detail-close').addEventListener('click', () => { ui.selectedId = null; renderAll(); });
  $('btn-sample').addEventListener('click', () => {
    if (state.products.length && !window.confirm('기존 상품 목록 뒤에 예시 상품 4개를 추가할까요?')) return;
    const n = loadSamples();
    if (!n) { setMsg($('pf-msg'), '예시를 추가하면 상품 한도를 넘습니다.', 'bad'); return; }
    persist($('pf-msg'), `예시 상품 ${n}개를 추가했습니다. 값은 참고용입니다.`);
  });
  $('btn-sample-hero').addEventListener('click', () => {
    if (state.products.length === 0) { loadSamples(); save(); }
    ui.selectedId = state.products[0]?.id ?? null;
    renderAll();
    scrollToNode($('calc'));
  });
  $('channel-form').addEventListener('submit', onChannelSubmit);
  $('btn-channel-reset').addEventListener('click', () => {
    if (!window.confirm('예시 채널 값을 기본 예시로 되돌릴까요? 직접 추가한 채널은 유지됩니다.')) return;
    const custom = state.channels.filter((c) => c.source !== 'preset' && !CONSTANTS.CHANNEL_PRESETS.some((p) => p.id === c.id));
    state.channels = [...CONSTANTS.CHANNEL_PRESETS.map((c) => ({ ...c, source: 'preset' })), ...custom];
    persist($('cf-msg'), '예시 채널을 기본값으로 되돌렸습니다.');
  });
  $('csv-text').addEventListener('input', () => { ui.csv.parsed = null; $('btn-csv-import').disabled = true; });
  $('btn-csv-preview').addEventListener('click', previewCsv);
  $('btn-csv-import').addEventListener('click', importCsv);
  $('csv-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { setMsg($('csv-msg'), 'CSV 파일이 1MB보다 큽니다.', 'bad'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { $('csv-text').value = String(reader.result); previewCsv(); setMsg($('csv-msg'), `${file.name} 을(를) 읽었습니다. 아래 검사 결과를 확인하세요.`); };
    reader.onerror = () => setMsg($('csv-msg'), '파일을 읽지 못했습니다.', 'bad');
    reader.readAsText(file);
  });
  $('btn-csv-template').addEventListener('click', () => {
    const sample = [['무선 충전 케이블 1m', 'CBL-1M', '스마트스토어', 9900, 2800, 300, 2500, 4, 2000, 1500, '', 300]];
    download('sellermargin-template.csv', toCsv(CSV_HEADERS, sample), 'text/csv;charset=utf-8');
  });
  $('btn-export-products').addEventListener('click', exportProductsCsv);
  $('btn-export-results').addEventListener('click', exportResultsCsv);
  $('ai-names').addEventListener('change', () => { renderAiPayload(); });
  $('ai-key-form').addEventListener('submit', onKeySave);
  $('ai-key-remove').addEventListener('click', onKeyRemove);
  $('ai-run').addEventListener('click', onAiRun);
  $('ai-local').addEventListener('click', onLocalAdvice);
  $('btn-json-export').addEventListener('click', () => {
    download(`sellermargin-backup-${stamp()}.json`, exportStateJson(state), 'application/json;charset=utf-8');
    setMsg($('backup-msg'), '백업 파일을 내려받았습니다.', 'ok');
  });
  $('json-file').addEventListener('change', onJsonFile);
  $('btn-clear').addEventListener('click', () => {
    if (!window.confirm('모든 상품과 채널 설정을 지울까요? 먼저 백업을 내려받는 것을 권장합니다. (AI 키는 유지됩니다)')) return;
    state = defaultState();
    ui.selectedId = null;
    resetProductForm();
    persist($('backup-msg'), '전체 데이터를 지웠습니다.');
  });
}

function init() {
  renderBasis();
  $('target-margin').value = String(state.settings.targetMargin);
  bind();
  renderAll();
  if (loadNotice) setMsg($('backup-msg'), loadNotice, 'bad');
  if (readKey()) setMsg($('ai-key-msg'), '이 브라우저에 저장된 키가 있습니다.', 'ok');
  if (!save()) setMsg($('backup-msg'), '저장 공간에 쓸 수 없어 변경 사항이 유지되지 않을 수 있습니다.', 'bad');
}

init();
