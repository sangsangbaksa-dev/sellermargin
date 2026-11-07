// 셀러마진 UI 컨트롤러. 계산은 logic.js 에 있고 여기서는 DOM 연결만 한다.
// 사용자 입력과 저장 데이터는 모두 textContent 로만 표시한다 (innerHTML 사용 안 함).
import {
  CONSTANTS, HEALTH, healthLabel, krw, rnd, validateProduct, validateChannel, computeProduct,
  solvePriceForMargin, compareChannels, summarize, sortRows, mapCsvProducts, toCsv,
  defaultState, importStateJson, exportStateJson, newId, validateTargetMargin, presetName,
  checkKeyFormat, buildAdvicePrompt, parseAdviceReply, ruleBasedAdvice,
  computeScenarios, validateScenarioSettings, sensitivityGrid, SENS_ROAS_LEVELS, monthlyPnlByChannel,
  breakEvenChartModel, errorReportCsv, parseMoney, targetProfitRows,
} from './logic.js';
import { t, setLang, detectLang, applyI18n, langSelect, readSavedLang, writeSavedLang, localeTag } from './i18n.js';

setLang(detectLang(readSavedLang()));

const STORAGE_KEY = 'sellermargin-state';
const KEY_STORAGE = 'sellermargin-ai-key';
const AI_MODEL = 'claude-haiku-5-5';
const AI_TIMEOUT_MS = 30000;
const SAMPLE_PRODUCTS = [
  { name: 'sample1', sku: 'CBL-1M', channelId: 'smartstore', price: '9900', cogs: '2800', packaging: '300', shipping: '2500', returnRate: '4', returnLoss: '2000', adMode: 'perOrder', adPerOrder: '1500', volume: '300' },
  { name: 'sample2', sku: 'YM-6', channelId: 'coupang', price: '29000', cogs: '14000', packaging: '1200', shipping: '3000', returnRate: '6', returnLoss: '3500', adMode: 'roas', roasTarget: '3.5', volume: '80' },
  { name: 'sample3', sku: 'TB-500', channelId: 'elevenst', price: '15900', cogs: '6500', packaging: '600', shipping: '2500', returnRate: '2', returnLoss: '1500', adMode: 'perOrder', adPerOrder: '4000', volume: '150' },
  { name: 'sample4', sku: 'SET-01', channelId: 'own', price: '38000', cogs: '17000', packaging: '1500', shipping: '0', returnRate: '1', returnLoss: '0', adMode: 'roas', roasTarget: '5', volume: '40' },
];
// 예시 상품 이름은 언어별로 번역된 값을 쓴다.
const SAMPLE_NAMES = { sample1: 'ui.sample.name1', sample2: 'ui.sample.name2', sample3: 'ui.sample.name3', sample4: 'ui.sample.name4' };
// CSV 열 이름은 파일 형식이므로 한국어로 고정한다 (가져오기 호환).
const CSV_HEADERS = ['상품명', 'SKU', '채널', '판매가', '원가', '포장비', '배송비부담액', '반품률', '반품손실', '광고비', '목표ROAS', '월판매량'];

const $ = (id) => document.getElementById(id);
const fmtNum = (n) => new Intl.NumberFormat(localeTag()).format(n);
const won = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : krw(n));
const signedWon = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${krw(Math.abs(n))}`;
const pct = (v) => (v === null || v === undefined ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)}%`);
const roasTxt = (v) => (v === null ? t('common.none') : `${(Math.round(v * 100) / 100).toFixed(2)}${t('unit.times')}`);

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
const chip = (health) => el('span', { class: `chip ${health}`, text: healthLabel(health) });
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
        loadNotice = t('ui.loadDropped', { p: res.dropped.products, c: res.dropped.channels });
      }
      return res.state;
    }
    loadNotice = t('ui.loadFail', { e: res.error });
  } catch {
    loadNotice = t('ui.storageNoAccess');
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
  if (msgNode) setMsg(msgNode, ok ? okText : t('ui.saveFail'), ok ? 'ok' : 'bad');
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
  renderBasis();
  renderSummary();
  renderProducts();
  renderDetail();
  renderChannels();
  renderChannelSelect();
  renderPnl();
  renderAiPayload();
}

function renderBasis() {
  $('basis-line').textContent = t('ui.basisLine', { preset: CONSTANTS.PRESET_LABEL, vat: CONSTANTS.VAT_LABEL });
  $('channel-basis').textContent = t('ui.channelBasis', { preset: CONSTANTS.PRESET_LABEL });
}

function renderSummary() {
  const rows = computeRows();
  const tm = state.settings.targetMargin;
  const s = summarize(rows, tm);
  const kpis = $('kpis');
  kpis.replaceChildren(
    el('div', {}, el('dt', { text: t('ui.kpiCount') }), el('dd', { text: t('ui.countUnit', { n: s.count }) })),
    el('div', {}, el('dt', { text: t('ui.kpiLossSelling') }), el('dd', { class: s.lossSelling ? 'bad' : '', text: t('ui.countUnit', { n: s.lossSelling }) })),
    el('div', {}, el('dt', { text: t('ui.kpiBelow', { m: tm }) }), el('dd', { text: t('ui.countUnit', { n: s.belowTarget }) })),
    el('div', {}, el('dt', { text: t('ui.kpiMonthlyNet') }), el('dd', { class: s.monthlyNet < 0 ? 'bad' : '', text: won(s.monthlyNet) })),
    el('div', {}, el('dt', { text: t('ui.kpiMonthlyAd') }), el('dd', { text: won(s.monthlyAd) })),
    el('div', {}, el('dt', { text: t('ui.kpiMonthlyMargin') }), el('dd', { text: pct(s.monthlyMarginRate) })),
  );
  const w = $('warnings');
  w.replaceChildren();
  if (s.count === 0) {
    w.append(el('p', { class: 'warn ok', text: t('ui.warnEmpty') }));
  } else {
    if (s.lossSelling > 0) w.append(el('p', { class: 'warn loss', text: t('ui.warnLoss', { n: s.lossSelling }) }));
    if (s.belowTarget > 0) w.append(el('p', { class: 'warn risk', text: t('ui.warnBelow', { m: tm, n: s.belowTarget }) }));
    if (s.lossSelling === 0 && s.belowTarget === 0) w.append(el('p', { class: 'warn ok', text: t('ui.warnAllGood', { m: tm }) }));
  }
  const wrap = $('worst-wrap');
  wrap.hidden = s.count === 0;
  const list = $('worst-list');
  list.replaceChildren(...s.worst.map((r) => el('li', {},
    el('button', { type: 'button', onclick: () => selectProduct(r.product.id) },
      t('ui.worstLine', { name: r.product.name, net: won(r.result.net), m: pct(r.result.marginRate) })),
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
      el('span', { class: 'sub', text: p.sku ? t('ui.skuLabel', { sku: p.sku }) : ' ' }),
    ),
    el('td', { class: 'hide-sm', text: channel.name }),
    el('td', { class: 'num', text: won(p.price) }),
    el('td', { class: cls('num', r.net < 0 && 'neg'), text: won(r.net) }),
    el('td', { class: 'num', text: pct(r.marginRate) }),
    el('td', { class: 'num', text: roasTxt(r.bepRoas) }),
    el('td', {}, chip(r.health)),
    el('td', {},
      el('div', { class: 'row-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': t('ui.aria.detail', { name: p.name }), onclick: () => selectProduct(p.id), text: t('common.view') }),
        el('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': t('ui.aria.edit', { name: p.name }), onclick: () => editProduct(p.id), text: t('common.edit') }),
        el('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': t('ui.aria.delete', { name: p.name }), onclick: () => deleteProduct(p.id), text: t('common.delete') }),
      ),
    ),
  )));
  const empty = $('product-empty');
  empty.hidden = view.length > 0;
  empty.textContent = state.products.length === 0
    ? t('ui.productEmpty')
    : t('ui.productNoMatch');
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
  $('detail-title').textContent = t('ui.detailTitle', { name: p.name });

  const metrics = el('div', { class: 'metrics' },
    el('div', { class: 'metric hero-metric' }, el('div', { class: 'label', text: t('ui.m.net') }), el('div', { class: cls('value', r.net < 0 && 'neg'), text: won(r.net) }), el('div', { class: 'hint', text: t('ui.m.netHint') })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: t('ui.m.margin') }), el('div', { class: 'value', text: pct(r.marginRate) }), el('div', { class: 'hint', text: t('ui.m.marginHint', { m: tm, s: healthLabel(r.health) }) })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: t('ui.m.bep') }), el('div', { class: 'value', text: roasTxt(r.bepRoas) }), el('div', { class: 'hint', text: r.bepRoas === null ? t('ui.m.bepNone') : t('ui.m.bepHint') })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: t('ui.m.bepAd') }), el('div', { class: cls('value', r.bepAd < 0 && 'neg'), text: won(r.bepAd) }), el('div', { class: 'hint', text: r.bepAd < 0 ? t('ui.m.bepAdLoss') : t('ui.m.bepAdHint') })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: t('ui.m.targetPrice', { m: tm }) }), el('div', { class: 'value', text: solved === null ? t('ui.m.unreachable') : won(solved) }), el('div', { class: 'hint', text: solved === null ? t('ui.m.unreachableHint') : t('ui.m.currentPrice', { p: won(p.price) }) })),
    el('div', { class: 'metric' }, el('div', { class: 'label', text: t('ui.m.returnMargin') }), el('div', { class: 'value', text: pct(r.marginRate) }), el('div', { class: 'hint', text: t('ui.m.returnHint', { a: pct(r.marginNoReturn), b: won(r.returnDrag) }) })),
  );

  const line = (label, value, cls2 = '') => el('tr', { class: cls2 }, el('td', { text: label }), el('td', { text: value }));
  const breakdown = el('table', { class: 'breakdown', 'aria-label': t('ui.breakdownAria') },
    el('tbody', {},
      line(t('ui.b.price'), won(p.price)),
      line(t('ui.b.effective'), won(r.effectivePrice)),
      line(t('ui.b.vat'), signedWon(-r.vat)),
      line(t('ui.b.netRevenue'), won(r.netRevenue)),
      line(t('ui.b.saleFee'), signedWon(-r.saleFee)),
      line(t('ui.b.pgFee'), signedWon(-r.pgFee)),
      line(t('ui.b.fixedFee'), signedWon(-r.fixedFee)),
      line(t('ui.b.cogs'), signedWon(-r.cogs)),
      line(t('ui.b.packaging'), signedWon(-p.packaging)),
      line(t('ui.b.shipping'), signedWon(-p.shipping)),
      line(t('ui.b.returnDrag'), signedWon(-r.returnDrag)),
      line(t('ui.b.ad'), signedWon(-r.adPerOrder)),
      line(t('ui.b.net'), won(r.net), 'total'),
    ),
  );

  const compare = compareChannels(p, state.channels, { targetMargin: tm });
  const compareTable = el('div', { class: 'table-wrap', tabindex: '0' },
    el('table', { class: 'data' },
      el('caption', { class: 'sr-only', text: t('ui.cmpChannelAria') }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: t('ui.th.channel') }),
        el('th', { scope: 'col', class: 'num', text: t('ui.th.net') }),
        el('th', { scope: 'col', class: 'num', text: t('ui.th.margin') }),
        el('th', { scope: 'col', class: 'num', text: t('ui.th.bep') }),
        el('th', { scope: 'col', text: t('ui.th.status') }),
      )),
      el('tbody', {}, compare.map(({ channel, result }) => el('tr', { class: channel.id === p.channelId ? 'selected' : '' },
        el('td', {}, channel.name, channel.id === p.channelId ? el('span', { class: 'sub', text: t('ui.currentChannel') }) : null),
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
    { key: 'price', label: t('ui.s.price'), min: Math.max(1, Math.round(p.price * 0.5)), max: Math.min(CONSTANTS.MAX_PRICE, Math.round(p.price * 1.5) + 1), step: 10, unit: t('unit.won') },
    { key: 'discountRate', label: t('ui.s.discount'), min: 0, max: 50, step: 1, unit: '%' },
    { key: 'cogs', label: t('ui.s.cogs'), min: 0, max: Math.max(1000, p.cogs * 2), step: 10, unit: t('unit.won') },
    { key: 'adPerOrder', label: t('ui.s.ad'), min: 0, max: Math.max(1000, Math.round(r.adPerOrder * 2)), step: 10, unit: t('unit.won') },
    { key: 'returnRate', label: t('ui.s.returnRate'), min: 0, max: 100, step: 0.5, unit: '%' },
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
  const reset = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: t('ui.whatifReset'), onclick: () => { ui.whatif = null; renderDetail(); } });

  const whatif = el('div', { class: 'whatif' },
    el('h4', { text: t('ui.whatifTitle') }),
    el('p', { class: 'basis', text: t('ui.whatifHint') }),
    el('div', { class: 'slider-grid' }, sliders, el('div', { class: 'slider' }, el('div', { class: 'top' }, el('label', { for: 'wi-coupon', text: t('ui.s.coupon') })), couponInput)),
    el('div', { class: 'inline-actions' }, reset),
    resultBox,
  );

  const body = $('detail-body');
  const chart = el('figure', { class: 'chart-fig' },
    breakEvenSvg(r, r.adPerOrder),
    el('figcaption', { class: 'small', text: t('ui.chartCaption') }),
  );
  body.replaceChildren(
    el('p', {}, el('span', { class: 'ai-tag', text: t('ui.skuTag', { sku: p.sku || t('common.none') }) }), el('span', { class: 'ai-tag', text: ch.name }), el('span', { class: 'ai-tag', text: t('ui.volumeTag', { n: fmtNum(p.volume) }) }), chip(r.health)),
    metrics,
    el('div', { class: 'card-grid-2' }, breakdown, el('div', {}, el('h4', { text: t('ui.chartTitle') }), chart, el('h4', { text: t('ui.cmpTitle') }), compareTable)),
    scenarioBlock(p, ch, tm),
    sensitivityBlock(p, ch, tm),
    whatif,
  );
  updateWhatIf(p, ch);
}

/* 시나리오: 기준 · 프로모 · 광고 강화를 나란히 보여 주고, 프로모·광고 배율 설정을 저장한다. */
function scenarioBlock(p, ch, tm) {
  const sc = state.settings.scenarios;
  const results = computeScenarios(p, ch, { targetMargin: tm, promoDiscount: sc.promoDiscount, adMultiplier: sc.adMultiplier });
  const promoIn = el('input', { id: 'scn-promo', type: 'text', inputmode: 'decimal', value: String(sc.promoDiscount), autocomplete: 'off' });
  const multIn = el('input', { id: 'scn-mult', type: 'text', inputmode: 'decimal', value: String(sc.adMultiplier), autocomplete: 'off' });
  const form = el('form', { id: 'scn-form', class: 'scn-form', novalidate: true, onsubmit: (e) => {
    e.preventDefault();
    const res = validateScenarioSettings({ promoDiscount: promoIn.value, adMultiplier: multIn.value });
    if (!res.ok) {
      const first = Object.values(res.errors)[0];
      setMsg($('scn-msg'), t('ui.scnBlocked', { e: first }), 'bad');
      return;
    }
    state.settings.scenarios = res.value;
    persist(null, '');
    setMsg($('scn-msg'), t('ui.scnSaved'), 'ok');
  } },
    el('label', { class: 'field', for: 'scn-promo' }, t('ui.scnPromoLabel'), promoIn),
    el('label', { class: 'field', for: 'scn-mult' }, t('ui.scnMultLabel'), multIn),
    el('div', { class: 'form-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'submit', text: t('ui.scnSave') }),
      el('p', { class: 'form-msg', id: 'scn-msg', role: 'status', 'aria-live': 'polite' }),
    ),
  );
  const line = (label, fn, cls2 = '') => el('tr', { class: cls2 }, el('th', { scope: 'row', text: label }),
    results.map((x) => el('td', { class: cls('num', fn(x).cls), text: fn(x).text })));
  const table = el('div', { class: 'table-wrap', tabindex: '0' },
    el('table', { class: 'data scenario-table' },
      el('caption', { class: 'sr-only', text: t('ui.scnAria') }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: t('ui.th.metric') }),
        results.map((x) => el('th', { scope: 'col', class: 'num' }, x.label, el('span', { class: 'sub', text: x.detail }))),
      )),
      el('tbody', {},
        line(t('ui.sc.effective'), (x) => ({ text: won(x.result.effectivePrice) })),
        line(t('ui.sc.ad'), (x) => ({ text: won(x.result.adPerOrder) })),
        line(t('ui.sc.net'), (x) => ({ text: won(x.result.net), cls: x.result.net < 0 ? 'neg' : '' })),
        line(t('ui.sc.margin'), (x) => ({ text: pct(x.result.marginRate) })),
        line(t('ui.sc.bep'), (x) => ({ text: roasTxt(x.result.bepRoas) })),
        line(t('ui.sc.status'), (x) => ({ text: healthLabel(x.result.health) })),
      ),
    ),
  );
  return el('div', { class: 'sub-block', 'aria-labelledby': 'scn-title' },
    el('h4', { id: 'scn-title', text: t('ui.scnTitle') }),
    el('p', { class: 'basis', text: t('ui.scnHint') }),
    table,
    form,
  );
}

/* 민감도 표: 판매가(기준의 0.8~1.2배) × 목표 ROAS. 셀에는 마진율과 순마진을 함께 적는다. */
function sensitivityBlock(p, ch, tm) {
  const grid = sensitivityGrid(p, ch, { targetMargin: tm, basePrice: p.price, roasLevels: SENS_ROAS_LEVELS });
  const head = el('tr', {}, el('th', { scope: 'col', text: t('ui.sens.corner') }),
    grid.roasLevels.map((roas) => el('th', { scope: 'col', class: 'num', text: `${roas}${t('unit.times')}` })));
  const rows = grid.prices.map((price, i) => el('tr', { class: price === p.price ? 'selected' : '' },
    el('th', { scope: 'row', class: 'num', text: won(price) + (price === p.price ? t('ui.sens.current') : '') }),
    grid.cells[i].map((c) => el('td', { class: cls('num sens-cell', c.health) },
      el('span', { class: 'sens-margin', text: pct(c.marginRate) }),
      el('span', { class: 'sens-net', text: t('ui.sens.netLine', { v: signedWon(c.net) }) }),
    )),
  ));
  return el('div', { class: 'sub-block' },
    el('h4', { text: t('ui.sensTitle') }),
    el('p', { class: 'basis', text: t('ui.sensHint', { p: won(p.price) }) }),
    el('div', { class: 'table-wrap', tabindex: '0' },
      el('table', { class: 'data sens-table' },
        el('caption', { class: 'sr-only', text: t('ui.sensAria') }),
        el('thead', {}, head),
        el('tbody', {}, rows),
      ),
    ),
  );
}

/* 손익분기 차트 (인라인 SVG). 색과 글자를 함께 쓰고, 값은 텍스트로도 적는다. */
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid) node.append(kid);
  return node;
}
function svgText(x, y, text, attrs = {}) {
  const tx = svgEl('text', { x, y, ...attrs });
  tx.textContent = text;
  return tx;
}
function breakEvenSvg(r, currentAd) {
  const m = breakEvenChartModel(r, currentAd);
  const W = 640, H = 300, L = 84, R = 28, T = 24, B = 52;
  const iw = W - L - R, ih = H - T - B;
  const span = m.yMax - m.yMin || 1;
  const sx = (x) => L + (x / m.xMax) * iw;
  const sy = (y) => T + ((m.yMax - y) / span) * ih;
  const kids = [];
  for (const tk of m.yTicks) {
    kids.push(svgEl('line', { x1: L, x2: W - R, y1: sy(tk), y2: sy(tk), class: tk === 0 ? 'be-zero' : 'be-grid' }));
    kids.push(svgText(L - 8, sy(tk) + 4, fmtNum(tk), { 'text-anchor': 'end', class: 'be-tick' }));
  }
  for (const tk of m.xTicks) {
    kids.push(svgText(sx(tk), H - B + 20, fmtNum(tk), { 'text-anchor': 'middle', class: 'be-tick' }));
  }
  kids.push(svgText(L + iw / 2, H - 8, t('ui.chart.xAxis'), { 'text-anchor': 'middle', class: 'be-axis' }));
  kids.push(svgText(16, T + ih / 2, t('ui.chart.yAxis'), { 'text-anchor': 'middle', transform: `rotate(-90 16 ${T + ih / 2})`, class: 'be-axis' }));
  kids.push(svgEl('line', { x1: sx(m.line.x1), y1: sy(m.line.y1), x2: sx(m.line.x2), y2: sy(m.line.y2), class: 'be-line' }));
  if (m.bep) {
    kids.push(svgEl('circle', { cx: sx(m.bep.x), cy: sy(m.bep.y), r: 6, class: 'be-bep' }));
    const bx = sx(m.bep.x);
    const anchor = bx > W - 200 ? 'end' : bx < 200 ? 'start' : 'middle';
    kids.push(svgText(bx + (anchor === 'start' ? -2 : anchor === 'end' ? 2 : 0), sy(0) + 20, t('ui.chart.bepLabel', { v: won(Math.round(m.bep.x)) }), { 'text-anchor': anchor, class: 'be-label' }));
  }
  const cx = sx(m.current.x), cy = sy(m.current.y);
  kids.push(svgEl('circle', { cx, cy, r: 6, class: 'be-now' }));
  const nowAnchor = cx > W - 220 ? 'end' : 'start';
  kids.push(svgText(cx + (nowAnchor === 'start' ? 10 : -10), cy - 10, t('ui.chart.nowLabel', { a: won(Math.round(m.current.x)), n: signedWon(Math.round(m.current.y)) }), { 'text-anchor': nowAnchor, class: 'be-label' }));
  const titleText = t('ui.chart.svgTitle', { bep: m.bep ? won(Math.round(m.bep.x)) : t('ui.chart.noBep'), now: won(Math.round(m.current.x)) });
  return svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', class: 'be-chart', 'aria-labelledby': 'be-title' }, svgEl('title', { id: 'be-title' }, titleText), kids);
}

/* 채널별 월 손익 */
function renderPnl() {
  const rows = computeRows();
  const pnl = monthlyPnlByChannel(rows, state.channels);
  renderTargetProfit(rows);
  const has = pnl.channels.length > 0;
  $('pnl-empty').hidden = has;
  $('pnl-wrap').hidden = !has;
  if (!has) { $('pnl-body').replaceChildren(); return; }
  const line = (r, isTotal) => el('tr', { class: isTotal ? 'total' : '' },
    el('th', { scope: 'row', text: r.name }),
    el('td', { class: 'num', text: t('ui.countUnit', { n: r.count }) }),
    el('td', { class: 'num', text: fmtNum(r.volume) }),
    el('td', { class: 'num', text: won(r.revenue) }),
    el('td', { class: 'num', text: won(r.cogs) }),
    el('td', { class: 'num', text: won(r.handling) }),
    el('td', { class: 'num', text: won(r.fees) }),
    el('td', { class: 'num', text: won(r.returnDrag) }),
    el('td', { class: 'num', text: won(r.ad) }),
    el('td', { class: cls('num', r.net < 0 && 'neg'), text: won(r.net) }),
    el('td', { class: 'num', text: pct(r.marginRate) }),
  );
  $('pnl-body').replaceChildren(...pnl.channels.map((r) => line(r, false)), line(pnl.total, true));
}

// 목표 순이익 입력을 검사하고 상품×채널별 필요 판매량을 표로 보여줍니다.
function renderTargetProfit(rows) {
  const parsed = parseMoney($('tp-target').value, { min: 0, field: t('f.monthlyTarget') });
  $('tp-err').textContent = parsed.ok ? '' : parsed.error;
  const body = $('tp-body');
  body.replaceChildren();
  $('tp-wrap').hidden = !parsed.ok || rows.length === 0;
  $('tp-empty').hidden = rows.length > 0;
  if (!parsed.ok || rows.length === 0) return;
  for (const r of targetProfitRows(rows, parsed.value)) {
    const need = r.ok ? t('ui.tp.volume', { n: fmtNum(r.volume) }) : (r.reason === 'NO_PROFIT' ? t('ui.tp.impossible') : t('common.dash'));
    body.append(el('tr', {},
      el('th', { scope: 'row', text: r.productName }),
      el('td', { text: r.channelName }),
      el('td', { class: cls('num', r.perOrder !== null && r.perOrder < 0 && 'neg'), text: r.perOrder === null ? t('common.dash') : won(r.perOrder) }),
      el('td', { class: 'num', text: need }),
      el('td', { class: 'num', text: t('ui.tp.volume', { n: fmtNum(r.currentVolume) }) }),
    ));
  }
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
    if (a === null || b === null) return t('common.dash');
    const d = b - a;
    return `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmt(Math.abs(d))}${unit}`;
  };
  const rows = [
    [t('ui.wi.net'), won(base.net), won(sim.net), delta(base.net, sim.net, (x) => fmtNum(x), t('unit.won')), sim.net - base.net],
    [t('ui.wi.margin'), pct(base.marginRate), pct(sim.marginRate), delta(base.marginRate, sim.marginRate, (x) => (Math.round(x * 100) / 100).toFixed(2), t('unit.pp')), (sim.marginRate ?? 0) - (base.marginRate ?? 0)],
    [t('ui.wi.bep'), roasTxt(base.bepRoas), roasTxt(sim.bepRoas), delta(base.bepRoas, sim.bepRoas, (x) => (Math.round(x * 100) / 100).toFixed(2), t('unit.times')), (sim.bepRoas ?? 0) - (base.bepRoas ?? 0)],
    [t('ui.wi.status'), healthLabel(base.health), healthLabel(sim.health), base.health === sim.health ? t('ui.wi.noChange') : `${healthLabel(base.health)} → ${healthLabel(sim.health)}`, 0],
  ];
  $('whatif-result').replaceChildren(el('div', { class: 'table-wrap', tabindex: '0' },
    el('table', { class: 'data' },
      el('caption', { class: 'sr-only', text: t('ui.wiAria') }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: t('ui.th.metric') }), el('th', { scope: 'col', class: 'num', text: t('ui.wi.base') }),
        el('th', { scope: 'col', class: 'num', text: t('ui.wi.sim') }), el('th', { scope: 'col', class: 'num', text: t('ui.wi.change') }),
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
    const label = preset ? (edited ? t('ui.ch.editedPreset') : t('ui.ch.preset')) : t('ui.ch.custom');
    const err = el('p', { class: 'field-error', role: 'alert' });
    const inputs = {
      name: el('input', { type: 'text', value: c.name, maxlength: '40', 'aria-label': t('ui.ch.nameAria', { name: c.name }) }),
      saleFeeRate: el('input', { type: 'text', inputmode: 'decimal', value: String(c.saleFeeRate), 'aria-label': t('ui.ch.saleAria', { name: c.name }) }),
      pgFeeRate: el('input', { type: 'text', inputmode: 'decimal', value: String(c.pgFeeRate), 'aria-label': t('ui.ch.pgAria', { name: c.name }) }),
      fixedFee: el('input', { type: 'text', inputmode: 'numeric', value: String(c.fixedFee), 'aria-label': t('ui.ch.fixedAria', { name: c.name }) }),
    };
    const vat = el('input', { type: 'checkbox', checked: c.vatSeparate, 'aria-label': t('ui.ch.vatAria', { name: c.name }) });
    const save = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: t('common.save'), onclick: () => {
      const res = validateChannel({ id: c.id, name: inputs.name.value, saleFeeRate: inputs.saleFeeRate.value, pgFeeRate: inputs.pgFeeRate.value, fixedFee: inputs.fixedFee.value, vatSeparate: vat.checked });
      if (!res.ok) {
        err.textContent = Object.values(res.errors).join(' / ');
        return;
      }
      const idx = state.channels.findIndex((x) => x.id === c.id);
      state.channels[idx] = { ...res.channel, source: c.source };
      persist(null, '');
      setMsg($('cf-msg'), t('ui.ch.saved', { name: res.channel.name }), 'ok');
    } });
    const remove = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: t('common.delete'), onclick: () => {
      const used = state.products.filter((p) => p.channelId === c.id).length;
      if (state.channels.length <= 1) { err.textContent = t('ui.ch.keepOne'); return; }
      if (used > 0) { err.textContent = t('ui.ch.inUse', { n: used }); return; }
      if (!window.confirm(t('ui.ch.deleteConfirm', { name: c.name }))) return;
      state.channels = state.channels.filter((x) => x.id !== c.id);
      persist(null, '');
    } });
    return el('tr', {},
      el('td', {}, inputs.name, el('span', { class: 'sub', text: label })),
      el('td', { class: 'num' }, inputs.saleFeeRate),
      el('td', { class: 'num' }, inputs.pgFeeRate),
      el('td', { class: 'num' }, inputs.fixedFee),
      el('td', {}, el('label', { class: 'check' }, vat, t('ui.ch.vatSep'))),
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
    : t('ui.aiPayloadEmpty');
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
  $('pf-submit').textContent = t('ui.pf.save');
  $('pf-cancel').hidden = true;
  $('form-title').textContent = t('ui.pf.addTitle');
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
    setMsg($('pf-msg'), t('ui.pf.checkInput'), 'bad');
    return;
  }
  $('pf-errors').replaceChildren();
  let savedId;
  if (ui.editingId) {
    const idx = state.products.findIndex((p) => p.id === ui.editingId);
    if (idx < 0) { setMsg($('pf-msg'), t('ui.pf.notFound'), 'bad'); return; }
    state.products[idx] = { ...res.product, id: ui.editingId };
    savedId = ui.editingId;
  } else {
    if (state.products.length >= CONSTANTS.MAX_PRODUCTS) {
      setMsg($('pf-msg'), t('ui.pf.maxProducts', { n: CONSTANTS.MAX_PRODUCTS }), 'bad');
      return;
    }
    res.product.id = newId('p');
    state.products.push(res.product);
    savedId = res.product.id;
  }
  const wasEditing = !!ui.editingId;
  resetProductForm();
  ui.selectedId = savedId;
  persist($('pf-msg'), wasEditing ? t('ui.pf.updated') : t('ui.pf.added'));
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
  $('pf-submit').textContent = t('ui.pf.updateSave');
  $('pf-cancel').hidden = false;
  $('form-title').textContent = t('ui.pf.editTitle', { name: p.name });
  setMsg($('pf-msg'), t('ui.pf.editHint'));
  $('pf-name').focus();
  scrollToNode($('product-form'));
}

function deleteProduct(id) {
  const p = productById(id);
  if (!p) return;
  if (!window.confirm(t('ui.pf.deleteConfirm', { name: p.name }))) return;
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
    const res = validateProduct({ ...raw, name: t(SAMPLE_NAMES[raw.name]), channelId: ids.includes(raw.channelId) ? raw.channelId : ids[0] }, ids);
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
    setMsg($('cf-msg'), t('ui.pf.checkInput'), 'bad');
    return;
  }
  $('cf-errors').replaceChildren();
  state.channels.push({ ...res.channel, source: 'custom' });
  ['cf-name', 'cf-sale', 'cf-pg', 'cf-fixed'].forEach((id) => { $(id).value = ''; });
  persist($('cf-msg'), t('ui.ch.added', { name: res.channel.name }));
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
    $('btn-csv-errors').disabled = true;
    setMsg(msg, t('ui.csv.empty'), 'bad');
    $('csv-errors').replaceChildren();
    return;
  }
  const parsed = mapCsvProducts(text, state.channels);
  ui.csv.parsed = parsed;
  $('btn-csv-errors').disabled = parsed.errors.length === 0;
  const room = CONSTANTS.MAX_PRODUCTS - state.products.length;
  const overflow = parsed.products.length > room;
  $('btn-csv-import').disabled = parsed.products.length === 0 || overflow;
  const summary = t('ui.csv.summary', { total: parsed.total, ok: parsed.products.length, err: parsed.errors.length });
  setMsg(msg, overflow ? t('ui.csv.overflow', { n: CONSTANTS.MAX_PRODUCTS }) : summary, parsed.errors.length ? '' : 'ok');
  const list = el('ul', { class: 'error-list', 'aria-label': t('ui.csv.errAria') },
    parsed.errors.slice(0, 50).map((er) => el('li', { text: er.line ? t('ui.csv.lineErr', { line: er.line, m: er.message }) : er.message })),
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
  persist($('csv-msg'), t('ui.csv.imported', { n: products.length }));
}

function exportProductsCsv() {
  const rows = state.products.map((p) => [
    p.name, p.sku, channelById(p.channelId).name, p.price, p.cogs, p.packaging, p.shipping, p.returnRate, p.returnLoss,
    p.adMode === 'perOrder' ? p.adPerOrder : '', p.adMode === 'roas' ? p.roasTarget : '', p.volume,
  ]);
  download(`sellermargin-products-${stamp()}.csv`, toCsv(CSV_HEADERS, rows), 'text/csv;charset=utf-8');
}

// 결과 CSV 열 이름도 파일 형식이므로 한국어로 고정한다.
const RESULT_HEADERS = ['상품명', 'SKU', '채널', '할인후판매가', '매출(부가세제외)', '부가세', '순마진', '마진율(%)', '손익분기ROAS', '손익분기광고비', '상태', '월판매량', '월예상순이익'];

function exportResultsCsv() {
  const rows = computeRows().map(({ product: p, channel, result: r }) => [
    p.name, p.sku, channel.name, r.effectivePrice, r.netRevenue, r.vat, r.net,
    r.marginRate === null ? '' : Math.round(r.marginRate * 100) / 100,
    r.bepRoas === null ? '' : Math.round(r.bepRoas * 100) / 100,
    r.bepAd, healthLabel(r.health), p.volume, r.net * p.volume,
  ]);
  download(`sellermargin-results-${stamp()}.csv`, toCsv(RESULT_HEADERS, rows), 'text/csv;charset=utf-8');
}

function stamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function onJsonFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    setMsg($('backup-msg'), t('ui.backup.tooBig'), 'bad');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const res = importStateJson(String(reader.result));
    if (!res.ok) {
      setMsg($('backup-msg'), t('ui.backup.fail', { e: res.error }), 'bad');
      e.target.value = '';
      return;
    }
    if (!window.confirm(t('ui.backup.confirm', { n: res.state.products.length }))) {
      e.target.value = '';
      return;
    }
    state = res.state;
    ui.selectedId = null;
    resetProductForm();
    const dropped = res.dropped.products ? t('ui.backup.dropped', { n: res.dropped.products }) : '';
    persist($('backup-msg'), t('ui.backup.done', { d: dropped }));
    e.target.value = '';
  };
  reader.onerror = () => setMsg($('backup-msg'), t('ui.backup.readFail'), 'bad');
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
    setMsg($('ai-key-msg'), t('ui.ai.keySaved'), 'ok');
  } catch {
    setMsg($('ai-key-msg'), t('ui.ai.keyFail'), 'bad');
  }
}

function onKeyRemove() {
  try { localStorage.removeItem(KEY_STORAGE); } catch { /* 무시 */ }
  $('ai-key').value = '';
  setMsg($('ai-key-msg'), t('ui.ai.keyRemoved'), 'ok');
}

function worstEntries() {
  const rows = computeRows();
  const s = summarize(rows, state.settings.targetMargin);
  const includeNames = $('ai-names').checked;
  return s.worst.map((r, idx) => ({
    label: includeNames ? r.product.name : t('ai.anonLabel', { x: String.fromCharCode(65 + idx) }),
    product: r.product,
    channel: r.channel,
    result: r.result,
  }));
}

function renderAdvice(advice, sourceText) {
  const out = $('ai-output');
  const typeLabel = { price: t('ui.type.price'), ad: t('ui.type.ad'), return: t('ui.type.return'), cost: t('ui.type.cost'), other: t('ui.type.other') };
  out.replaceChildren(
    el('p', { class: 'summary', text: advice.summary }),
    el('p', { class: 'small', text: sourceText }),
    advice.actions.length
      ? el('ul', {}, advice.actions.map((a) => el('li', {}, el('span', { class: 'ai-tag', text: typeLabel[a.type] || typeLabel.other }), el('strong', { text: `${a.product}: ` }), a.suggestion)))
      : el('p', { text: t('ui.ai.noActions') }),
  );
}

function onLocalAdvice() {
  const entries = worstEntries();
  if (entries.length === 0) { setMsg($('ai-msg'), t('ui.ai.addFirst'), 'bad'); return; }
  const advice = ruleBasedAdvice(entries, state.settings.targetMargin);
  renderAdvice(advice, t('ui.ai.ruleSource'));
  setMsg($('ai-msg'), t('ui.ai.ruleShown'), 'ok');
}

async function onAiRun() {
  if (ui.aiBusy) return;
  const key = readKey();
  const entries = worstEntries();
  if (entries.length === 0) { setMsg($('ai-msg'), t('ui.ai.addFirst'), 'bad'); return; }
  if (!key) { setMsg($('ai-msg'), t('ui.ai.noKey'), 'bad'); return; }
  const includeNames = $('ai-names').checked;
  const prompt = buildAdvicePrompt(entries.map((e) => toAiItem({ product: e.product, result: e.result })), {
    targetMargin: state.settings.targetMargin, includeNames, names: entries.map((e) => e.product.name),
  });
  ui.aiBusy = true;
  const btn = $('ai-run');
  btn.disabled = true;
  setMsg($('ai-msg'), t('ui.ai.requesting'));
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
      const hint = res.status === 401 ? t('ui.ai.hint401') : res.status === 429 ? t('ui.ai.hint429') : '';
      setMsg($('ai-msg'), t('ui.ai.httpFail', { s: res.status, h: hint }), 'bad');
      return;
    }
    const data = await res.json();
    const text = Array.isArray(data?.content) ? data.content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('') : '';
    const parsed = parseAdviceReply(text);
    if (!parsed.ok) {
      setMsg($('ai-msg'), t('ui.ai.parseFail', { e: parsed.error }), 'bad');
      return;
    }
    renderAdvice(parsed, t('ui.ai.aiSource', { model: AI_MODEL, n: entries.length, names: includeNames ? t('ui.ai.withNames') : t('ui.ai.noNames') }));
    setMsg($('ai-msg'), t('ui.ai.aiShown'), 'ok');
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    setMsg($('ai-msg'), aborted ? t('ui.ai.timeout') : t('ui.ai.netFail'), 'bad');
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
  $('pf-cancel').addEventListener('click', () => { resetProductForm(); setMsg($('pf-msg'), t('ui.pf.cancelled')); });
  document.querySelectorAll('input[name="adMode"]').forEach((r) => r.addEventListener('change', () => setAdMode(r.value)));
  document.querySelectorAll('button.sort').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    if (ui.sort.key === key) ui.sort.dir = ui.sort.dir === 'asc' ? 'desc' : 'asc';
    else { ui.sort.key = key; ui.sort.dir = key === 'name' ? 'asc' : 'desc'; }
    renderProducts();
  }));
  $('tp-target').addEventListener('input', () => renderPnl());
  $('filter-text').addEventListener('input', renderProducts);
  $('filter-loss').addEventListener('change', renderProducts);
  $('btn-detail-close').addEventListener('click', () => { ui.selectedId = null; renderAll(); });
  $('btn-sample').addEventListener('click', () => {
    if (state.products.length && !window.confirm(t('ui.sample.confirm'))) return;
    const n = loadSamples();
    if (!n) { setMsg($('pf-msg'), t('ui.sample.overflow'), 'bad'); return; }
    persist($('pf-msg'), t('ui.sample.added', { n }));
  });
  $('btn-sample-hero').addEventListener('click', () => {
    if (state.products.length === 0) { loadSamples(); save(); }
    ui.selectedId = state.products[0]?.id ?? null;
    renderAll();
    scrollToNode($('calc'));
  });
  $('channel-form').addEventListener('submit', onChannelSubmit);
  $('btn-channel-reset').addEventListener('click', () => {
    if (!window.confirm(t('ui.ch.resetConfirm'))) return;
    const custom = state.channels.filter((c) => c.source !== 'preset' && !CONSTANTS.CHANNEL_PRESETS.some((p) => p.id === c.id));
    state.channels = [...CONSTANTS.CHANNEL_PRESETS.map((c) => ({ ...c, name: presetName(c.id), source: 'preset' })), ...custom];
    persist($('cf-msg'), t('ui.ch.resetDone'));
  });
  $('csv-text').addEventListener('input', () => { ui.csv.parsed = null; $('btn-csv-import').disabled = true; $('btn-csv-errors').disabled = true; });
  $('btn-csv-errors').addEventListener('click', () => {
    const errors = ui.csv.parsed?.errors ?? [];
    if (!errors.length) return;
    download(`sellermargin-csv-errors-${stamp()}.csv`, errorReportCsv(errors), 'text/csv;charset=utf-8');
    setMsg($('csv-msg'), t('ui.csv.errExported', { n: errors.length }), 'ok');
  });
  $('btn-csv-preview').addEventListener('click', previewCsv);
  $('btn-csv-import').addEventListener('click', importCsv);
  $('csv-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) { setMsg($('csv-msg'), t('ui.csv.tooBig'), 'bad'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { $('csv-text').value = String(reader.result); previewCsv(); setMsg($('csv-msg'), t('ui.csv.read', { f: file.name })); };
    reader.onerror = () => setMsg($('csv-msg'), t('ui.backup.readFail'), 'bad');
    reader.readAsText(file);
  });
  $('btn-csv-template').addEventListener('click', () => {
    const sample = [[t('ui.sample.name1'), 'CBL-1M', presetName('smartstore'), 9900, 2800, 300, 2500, 4, 2000, 1500, '', 300]];
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
    setMsg($('backup-msg'), t('ui.backup.exported'), 'ok');
  });
  $('json-file').addEventListener('change', onJsonFile);
  $('btn-clear').addEventListener('click', () => {
    if (!window.confirm(t('ui.clearConfirm'))) return;
    state = defaultState();
    ui.selectedId = null;
    resetProductForm();
    persist($('backup-msg'), t('ui.clearDone'));
  });
}

const THEME_KEY = 'sellermargin-theme';
const THEME_NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
function readTheme() {
  try { const th = localStorage.getItem(THEME_KEY); return th === 'light' || th === 'dark' ? th : 'auto'; } catch { return 'auto'; }
}
function themeLabel(mode) {
  return t(`ui.theme.${mode}`);
}
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode; else delete root.dataset.theme;
  $('btn-theme').textContent = themeLabel(mode);
  $('btn-theme').setAttribute('aria-label', t('ui.theme.aria', { mode: themeLabel(mode) }));
}

// 언어를 바꾸면 정적 문구와 열린 화면을 함께 다시 그린다.
function refreshLanguage() {
  applyI18n(document);
  applyTheme(readTheme());
  renderChannelSelect();
  renderAll();
  if (loadNotice) setMsg($('backup-msg'), loadNotice, 'bad');
}

function init() {
  applyI18n(document);
  langSelect($('lang-select'), (l) => {
    setLang(l);
    writeSavedLang(l);
    refreshLanguage();
  });
  applyTheme(readTheme());
  $('btn-theme').addEventListener('click', () => {
    const next = THEME_NEXT[readTheme()];
    try { if (next === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* 저장 불가 시 이번 화면에서만 적용 */ }
    applyTheme(next);
  });
  $('target-margin').value = String(state.settings.targetMargin);
  bind();
  renderAll();
  if (loadNotice) setMsg($('backup-msg'), loadNotice, 'bad');
  if (readKey()) setMsg($('ai-key-msg'), t('ui.ai.keyPresent'), 'ok');
  if (!save()) setMsg($('backup-msg'), t('ui.storageWarn'), 'bad');
}

init();
