// 순수 계산 로직 (DOM 없음). 모든 금액은 원(KRW) 정수로 다룬다.
// 반올림 규칙: 0.5 는 절대값 기준으로 올림 (rnd 참고). 중간값은 실수로 두고 금액 항목마다 한 번만 반올림한다.
// 사용자에게 보이는 문구는 i18n.js 의 t() 로 가져온다. 기본 언어는 ko 이다.

import { t, localeTag } from './i18n.js';

const fmtNum = (n) => new Intl.NumberFormat(localeTag()).format(n);
/** 원 금액 표기. 한국어는 '1,000원', 그 밖의 언어는 'KRW 1,000' 형식. */
export function krw(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (localeTag() === 'ko-KR') return `${fmtNum(n)}원`;
  return new Intl.NumberFormat(localeTag(), { style: 'currency', currency: 'KRW', currencyDisplay: 'code' }).format(n);
}

/**
 * 모든 숫자 기준값은 여기 한 곳에서 관리한다. 수수료·세율은 바뀔 수 있으므로 직접 확인 후 수정할 것.
 */
function preset(id, saleFeeRate, pgFeeRate, fixedFee, vatSeparate) {
  return Object.freeze({ id, saleFeeRate, pgFeeRate, fixedFee, vatSeparate, get name() { return t(`preset.${id}`); } });
}

export const CONSTANTS = Object.freeze({
  AS_OF_DATE: '2026-11',
  APPLY_YEAR: 2026,
  VAT_RATE: 0.1,
  DEFAULT_TARGET_MARGIN: 15,
  MAX_MONEY: 100000000,
  MAX_PRICE: 100000000,
  MAX_RATE: 100,
  MAX_ROAS: 1000,
  MAX_VOLUME: 1000000,
  MAX_TEXT: 80,
  MAX_PRODUCTS: 2000,
  get VAT_SOURCE() { return t('basis.vatSource'); },
  get PRESET_LABEL() { return t('basis.presetLabel'); },
  get VAT_LABEL() { return t('basis.vatLabel'); },
  // 예시 채널 이름은 데이터이므로 id 로 사전에서 찾는다.
  CHANNEL_PRESETS: Object.freeze([
    preset('smartstore', 5.5, 3.5, 0, true),
    preset('coupang', 10.8, 0, 0, true),
    preset('elevenst', 12, 3, 0, true),
    preset('own', 0, 3.3, 200, true),
    preset('etsy', 6.5, 3, 600, false),
    preset('fba', 15, 0, 3000, false),
  ]),
});

/** 예시 채널 이름. 사용자가 이름을 바꾸면 그 값을 쓴다. */
export function presetName(id) {
  return t(`preset.${id}`);
}

export const HEALTH = Object.freeze({ LOSS: 'loss', RISK: 'risk', GOOD: 'good', INVALID: 'invalid' });
export function healthLabel(h) { return t(`health.${h}`); }

/** 원 단위 반올림: 0.5 는 절대값 기준 올림 (2.5 -> 3, -2.5 -> -3). */
export function rnd(x) {
  return (Math.sign(x) * Math.round(Math.abs(x))) || 0; // || 0 으로 -0 을 없앤다
}

const RATE_RE = /^-?\d+(\.\d{1,2})?$/;
const INT_RE = /^-?\d+$/;

function stripNumeric(raw) {
  return String(raw).replace(/[,\s원%]/g, '');
}

function isBlank(raw) {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
}

/** 정수 원 금액 파싱. 소수점·문자·범위 초과는 오류. */
export function parseMoney(raw, { min = 0, max = CONSTANTS.MAX_MONEY, optional = false, field = t('f.money') } = {}) {
  if (isBlank(raw)) {
    return optional ? { ok: true, value: 0 } : { ok: false, error: t('err.required', { field }) };
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return { ok: false, error: t('err.notInt', { field }) };
    return checkRange(raw, min, max, field);
  }
  const s = stripNumeric(raw);
  if (!INT_RE.test(s)) return { ok: false, error: t('err.notIntNum', { field }) };
  return checkRange(Number(s), min, max, field);
}

function checkRange(v, min, max, field) {
  if (!Number.isSafeInteger(v)) return { ok: false, error: t('err.tooLarge', { field }) };
  if (v < min) return { ok: false, error: t('err.minVal', { field, min: fmtNum(min) }) };
  if (v > max) return { ok: false, error: t('err.maxVal', { field, max: fmtNum(max) }) };
  return { ok: true, value: v };
}

/** 퍼센트 파싱 (소수 둘째 자리까지). 0~100. */
export function parseRate(raw, { optional = false, field = t('f.rate') } = {}) {
  if (isBlank(raw)) {
    return optional ? { ok: true, value: 0 } : { ok: false, error: t('err.required', { field }) };
  }
  const s = stripNumeric(typeof raw === 'number' ? String(raw) : raw);
  if (!RATE_RE.test(s)) return { ok: false, error: t('err.rateNumber', { field }) };
  const v = Number(s);
  if (v < 0) return { ok: false, error: t('err.rateMin', { field }) };
  if (v > CONSTANTS.MAX_RATE) return { ok: false, error: t('err.rateMax', { field }) };
  return { ok: true, value: v };
}

/** 목표 ROAS 파싱 (0.01 ~ 1000, 0은 나눗셈 불가이므로 거부). */
export function parseRoas(raw, { field = t('f.roas') } = {}) {
  if (isBlank(raw)) return { ok: false, error: t('err.required', { field }) };
  const s = stripNumeric(typeof raw === 'number' ? String(raw) : raw).replace(/x$/i, '');
  if (!RATE_RE.test(s)) return { ok: false, error: t('err.roasNumber', { field }) };
  const v = Number(s);
  if (v <= 0) return { ok: false, error: t('err.roasPositive', { field }) };
  if (v > CONSTANTS.MAX_ROAS) return { ok: false, error: t('err.tooLarge', { field }) };
  return { ok: true, value: v };
}

/** 월 판매량 파싱 (정수 0 ~ MAX_VOLUME). */
export function parseVolume(raw, { field = t('f.volume') } = {}) {
  return parseMoney(raw, { min: 0, max: CONSTANTS.MAX_VOLUME, optional: true, field });
}

function parseText(raw, { max = CONSTANTS.MAX_TEXT, required = false, field = t('f.text') } = {}) {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (required && s === '') return { ok: false, error: t('err.required', { field }) };
  if (s.length > max) return { ok: false, error: t('err.textMax', { field, max }) };
  return { ok: true, value: s };
}

/* ------------------------------------------------------------------ *
 * 채널 / 상품 검증
 * ------------------------------------------------------------------ */

export function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function validateChannel(input) {
  const errors = {};
  const out = { id: '', name: '', saleFeeRate: 0, pgFeeRate: 0, fixedFee: 0, vatSeparate: false };
  const name = parseText(input.name, { required: true, max: 40, field: t('f.channelName') });
  if (!name.ok) errors.name = name.error; else out.name = name.value;
  const sale = parseRate(input.saleFeeRate, { field: t('f.saleFee') });
  if (!sale.ok) errors.saleFeeRate = sale.error; else out.saleFeeRate = sale.value;
  const pg = parseRate(input.pgFeeRate, { optional: true, field: t('f.pgFee') });
  if (!pg.ok) errors.pgFeeRate = pg.error; else out.pgFeeRate = pg.value;
  const fixed = parseMoney(input.fixedFee, { optional: true, field: t('f.fixedFee') });
  if (!fixed.ok) errors.fixedFee = fixed.error; else out.fixedFee = fixed.value;
  out.vatSeparate = input.vatSeparate === true || input.vatSeparate === 'true' || input.vatSeparate === 'on';
  out.id = typeof input.id === 'string' && /^[\w-]{1,60}$/.test(input.id) ? input.id : newId('ch');
  return { ok: Object.keys(errors).length === 0, channel: out, errors };
}

/**
 * 상품 입력 검증. 광고 방식은 'perOrder'(주문당 광고비) 또는 'roas'(목표 ROAS → 광고비 = 판매가 / ROAS).
 */
export function validateProduct(input, channelIds = []) {
  const errors = {};
  const out = {
    id: '', name: '', sku: '', channelId: '', price: 0, cogs: 0, packaging: 0, shipping: 0,
    returnRate: 0, returnLoss: 0, adMode: 'perOrder', adPerOrder: 0, roasTarget: 0, volume: 0,
  };
  const set = (key, res) => { if (res.ok) out[key] = res.value; else errors[key] = res.error; };

  const id = typeof input.id === 'string' && /^[\w-]{1,60}$/.test(input.id) ? input.id : newId('p');
  out.id = id;
  set('name', parseText(input.name, { required: true, field: t('f.productName') }));
  set('sku', parseText(input.sku, { max: 40, field: t('f.sku') }));

  const ch = typeof input.channelId === 'string' ? input.channelId : '';
  if (channelIds.length && !channelIds.includes(ch)) errors.channelId = t('err.channelPick');
  else out.channelId = ch;

  set('price', parseMoney(input.price, { min: 1, max: CONSTANTS.MAX_PRICE, field: t('f.price') }));
  set('cogs', parseMoney(input.cogs, { optional: true, field: t('f.cogs') }));
  set('packaging', parseMoney(input.packaging, { optional: true, field: t('f.packaging') }));
  set('shipping', parseMoney(input.shipping, { optional: true, field: t('f.shipping') }));
  set('returnRate', parseRate(input.returnRate, { optional: true, field: t('f.returnRate') }));
  set('returnLoss', parseMoney(input.returnLoss, { optional: true, field: t('f.returnLoss') }));
  set('volume', parseVolume(input.volume));

  out.adMode = input.adMode === 'roas' ? 'roas' : 'perOrder';
  if (out.adMode === 'roas') {
    const roas = parseRoas(input.roasTarget);
    if (roas.ok) out.roasTarget = roas.value; else errors.roasTarget = roas.error;
  } else {
    set('adPerOrder', parseMoney(input.adPerOrder, { optional: true, field: t('f.adPerOrder') }));
  }
  return { ok: Object.keys(errors).length === 0, product: out, errors };
}

/* ------------------------------------------------------------------ *
 * 계산
 * ------------------------------------------------------------------ *
 * 가정 (README 와 동일):
 *  - 수수료 %는 할인 적용 후 판매가(결제금액, 부가세 포함) 기준.
 *  - 부가세 분리 ON: 부가세 = 판매가 - 판매가/(1+10%) 를 반올림한 값, 매출 = 판매가 - 부가세.
 *    부가세 분리 OFF: 판매가 전액을 매출로 본다.
 *  - 원가·포장비·배송비는 부가세 제외 금액으로 입력한다고 가정 (매입세액 공제 반영).
 *  - 반품: 원가는 재입고, 매출은 환불, 수수료·포장비·배송비는 환불되지 않는다고 가정(보수적).
 *    반품 1건당 추가 손실(회수·재포장·폐기 등)을 별도 입력한다.
 *  - 기대 광고 전 순이익 = (1-반품률) × 반품 없을 때 이익 + 반품률 × 반품 시 이익.
 *  - 광고비는 모든 주문(반품 포함)에 대해 주문당 발생한다고 본다.
 *  - 마진율 = 순마진 / 매출(부가세 제외, 반품 전 기준) × 100.
 *  - 손익분기 ROAS = 판매가(할인 후) / 광고 전 순이익. 손익분기 광고비 = 광고 전 순이익.
 */
export function computeProduct(p, channel, opts = {}) {
  const C = CONSTANTS;
  const price = opts.price ?? p.price;
  const cogs = opts.cogs ?? p.cogs;
  const packaging = opts.packaging ?? p.packaging;
  const shipping = opts.shipping ?? p.shipping;
  const returnRate = opts.returnRate ?? p.returnRate;
  const returnLoss = opts.returnLoss ?? p.returnLoss;
  const discountRate = opts.discountRate ?? 0;
  const coupon = opts.coupon ?? 0;
  const targetMargin = opts.targetMargin ?? C.DEFAULT_TARGET_MARGIN;

  const effective = Math.max(0, rnd(price * (100 - discountRate) / 100) - coupon);
  const vat = channel.vatSeparate ? rnd(effective * C.VAT_RATE / (1 + C.VAT_RATE)) : 0;
  const netRevenue = effective - vat;
  const saleFee = rnd(effective * channel.saleFeeRate / 100);
  const pgFee = rnd(effective * channel.pgFeeRate / 100);
  const fixedFee = channel.fixedFee;
  const fees = saleFee + pgFee + fixedFee;
  const handling = packaging + shipping;

  // 반품 없을 때 광고 전 이익, 반품 1건일 때 광고 전 이익
  const keepPreAd = netRevenue - cogs - handling - fees;
  const returnPreAd = -(handling + fees + returnLoss);
  const r = returnRate / 100;
  const expectedPreAd = rnd((1 - r) * keepPreAd + r * returnPreAd);
  const returnDrag = keepPreAd - expectedPreAd; // 반품으로 인한 기대 손실 (양수 = 손실)

  let adPerOrder;
  let roasMissing = false;
  if (opts.adPerOrder !== undefined) {
    adPerOrder = opts.adPerOrder;
  } else if (p.adMode === 'roas') {
    if (p.roasTarget > 0) adPerOrder = rnd(effective / p.roasTarget);
    else { adPerOrder = 0; roasMissing = true; }
  } else {
    adPerOrder = p.adPerOrder;
  }

  const net = expectedPreAd - adPerOrder;
  const netNoReturn = keepPreAd - adPerOrder;
  const marginRate = netRevenue > 0 ? (net / netRevenue) * 100 : null;
  const marginNoReturn = netRevenue > 0 ? (netNoReturn / netRevenue) * 100 : null;
  const bepRoas = effective > 0 && expectedPreAd > 0 ? effective / expectedPreAd : null;

  let health;
  if (effective <= 0 || netRevenue <= 0) health = HEALTH.INVALID;
  else if (net < 0) health = HEALTH.LOSS;
  else if (marginRate < targetMargin) health = HEALTH.RISK;
  else health = HEALTH.GOOD;

  return {
    effectivePrice: effective,
    vat,
    netRevenue,
    saleFee,
    pgFee,
    fixedFee,
    fees,
    cogs,
    handling,
    keepPreAd,
    expectedPreAd,
    returnDrag,
    adPerOrder,
    roasMissing,
    net,
    netNoReturn,
    marginRate,
    marginNoReturn,
    bepRoas,
    bepAd: expectedPreAd,
    health,
  };
}

/**
 * 목표 마진율을 만족하는 최소 판매가(정수 원)를 이분 탐색으로 구한다.
 * 불변식: pred(lo) = false, pred(hi) = true 를 유지하므로 결과 hi 에 대해 pred(hi-1) = false 가 항상 성립한다.
 * 도달 불가능하면 null.
 */
export function solvePriceForMargin(p, channel, targetPct, opts = {}) {
  const pred = (price) => {
    if (price <= 0) return false;
    const m = computeProduct(p, channel, { ...opts, price }).marginRate;
    return m !== null && m >= targetPct;
  };
  let lo = 0;
  let hi = CONSTANTS.MAX_PRICE;
  if (!pred(hi)) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (pred(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

/** 같은 상품을 여러 채널에서 비교한다. channels: 배열. */
export function compareChannels(p, channels, opts = {}) {
  return channels.map((ch) => ({ channel: ch, result: computeProduct(p, ch, opts) }));
}

/** 상품 목록 집계. rows: [{ product, channel, result }] */
export function summarize(rows, targetMargin) {
  let monthlyNet = 0;
  let monthlyAd = 0;
  let monthlyRevenue = 0;
  let lossSelling = 0;
  let belowTarget = 0;
  let lossCount = 0;
  let riskCount = 0;
  for (const { product, result } of rows) {
    const vol = product.volume || 0;
    monthlyNet += result.net * vol;
    monthlyAd += result.adPerOrder * vol;
    monthlyRevenue += result.netRevenue * vol;
    if (result.net < 0 && vol > 0) lossSelling += 1;
    if (result.health === HEALTH.LOSS) lossCount += 1;
    if (result.health === HEALTH.RISK) riskCount += 1;
    if (result.marginRate !== null && result.marginRate < targetMargin) belowTarget += 1;
  }
  const worst = [...rows]
    .sort((a, b) => a.result.net - b.result.net || (a.result.marginRate ?? -Infinity) - (b.result.marginRate ?? -Infinity))
    .slice(0, 5);
  return {
    count: rows.length,
    lossSelling,
    belowTarget,
    lossCount,
    riskCount,
    monthlyNet,
    monthlyAd,
    monthlyRevenue,
    monthlyMarginRate: monthlyRevenue > 0 ? (monthlyNet / monthlyRevenue) * 100 : null,
    worst,
  };
}

/** 정렬. key: 'name' | 'net' | 'margin' | 'bepRoas' | 'price'. dir: 'asc' | 'desc'. null 값은 항상 뒤로. */
export function sortRows(rows, key, dir = 'desc') {
  const val = (row) => {
    switch (key) {
      case 'name': return row.product.name;
      case 'net': return row.result.net;
      case 'margin': return row.result.marginRate;
      case 'bepRoas': return row.result.bepRoas;
      case 'price': return row.result.effectivePrice;
      default: return 0;
    }
  };
  const mul = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'string') return mul * va.localeCompare(vb, localeTag());
    return mul * (va - vb);
  });
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/** RFC 4180 스타일 파서. BOM, CRLF, 큰따옴표 이스케이프, 줄바꿈 포함 필드 지원. 각 행에 시작 줄 번호를 붙인다. */
export function parseCsv(input) {
  let text = input === null || input === undefined ? '' : String(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let cells = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const pushRow = () => {
    cells.push(field);
    if (!(cells.length === 1 && cells[0].trim() === '')) rows.push({ line: rowLine, cells: cells.map((c) => c.trim()) });
    cells = [];
    field = '';
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      if (c === '\n') line += 1;
      field += c; i += 1; continue;
    }
    if (c === '"' && field.trim() === '') { inQuotes = true; field = ''; i += 1; continue; }
    if (c === ',') { cells.push(field); field = ''; i += 1; continue; }
    if (c === '\r' || c === '\n') {
      pushRow();
      if (c === '\r' && text[i + 1] === '\n') i += 2; else i += 1;
      line += 1;
      rowLine = line;
      continue;
    }
    field += c; i += 1;
  }
  const error = inQuotes ? t('csv.unclosedQuote') : null;
  if (field !== '' || cells.length) pushRow();
  return { rows, error };
}

// 열 이름 별칭. 한국어 헤더(내보내기 형식)와 영문 헤더를 모두 받는다. 파일 형식이므로 번역하지 않는다.
const HEADER_ALIASES = {
  name: ['상품명', 'name', 'product', 'title'],
  sku: ['sku', '품번', '상품코드'],
  channel: ['채널', 'channel'],
  price: ['판매가', 'price'],
  cogs: ['원가', 'cogs', 'cost'],
  packaging: ['포장비', 'packaging'],
  shipping: ['배송비부담액', '배송비', 'shipping'],
  returnRate: ['반품률', 'returnrate'],
  returnLoss: ['반품손실', '반품1건당추가손실', 'returnloss'],
  adPerOrder: ['광고비', '광고비주문', 'adperorder', 'ad'],
  roasTarget: ['목표roas', 'roas', 'roastarget'],
  volume: ['월판매량', 'volume'],
};

const normHeader = (s) => String(s).toLowerCase().replace(/[\s()%/_-]/g, '');

/**
 * CSV 텍스트 → 상품 배열 + 행별 오류.
 * 필수 헤더: 상품명, 판매가. 채널은 이름 또는 id, 비우면 첫 번째 채널.
 * 광고비와 목표 ROAS 는 하나만 입력해야 한다.
 */
export function mapCsvProducts(text, channels) {
  const { rows, error: parseError } = parseCsv(text);
  const errors = [];
  if (parseError) errors.push({ line: 0, message: parseError });
  if (rows.length === 0) return { products: [], errors: [...errors, { line: 0, message: t('csv.noData') }], total: 0 };

  const header = rows[0];
  const colOf = {};
  header.cells.forEach((h, idx) => {
    const n = normHeader(h);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (colOf[key] === undefined && aliases.map(normHeader).includes(n)) colOf[key] = idx;
    }
  });
  const missing = ['name', 'price'].filter((k) => colOf[k] === undefined);
  if (missing.length) {
    const names = { name: t('f.productName'), price: t('f.price') };
    return {
      products: [],
      errors: [...errors, { line: header.line, message: t('csv.missingCols', { cols: missing.map((k) => names[k]).join(', ') }) }],
      total: 0,
    };
  }

  const dataRows = rows.slice(1).slice(0, CONSTANTS.MAX_PRODUCTS);
  const channelIds = channels.map((c) => c.id);
  const products = [];
  const get = (cells, key) => (colOf[key] === undefined ? '' : cells[colOf[key]] ?? '');

  for (const row of dataRows) {
    const { line, cells } = row;
    const rowErrors = [];
    let channelId = channels[0]?.id ?? '';
    const chRaw = get(cells, 'channel');
    if (chRaw) {
      const found = channels.find((c) => c.id === chRaw || normHeader(c.name) === normHeader(chRaw));
      if (found) channelId = found.id; else rowErrors.push(t('csv.unknownChannel', { name: chRaw }));
    }
    const adRaw = get(cells, 'adPerOrder');
    const roasRaw = get(cells, 'roasTarget');
    if (adRaw !== '' && roasRaw !== '') rowErrors.push(t('csv.adAndRoas'));
    const input = {
      name: get(cells, 'name'),
      sku: get(cells, 'sku'),
      channelId,
      price: get(cells, 'price'),
      cogs: get(cells, 'cogs'),
      packaging: get(cells, 'packaging'),
      shipping: get(cells, 'shipping'),
      returnRate: get(cells, 'returnRate'),
      returnLoss: get(cells, 'returnLoss'),
      adMode: roasRaw !== '' && adRaw === '' ? 'roas' : 'perOrder',
      adPerOrder: adRaw,
      roasTarget: roasRaw,
      volume: get(cells, 'volume'),
    };
    const res = validateProduct(input, channelIds);
    if (!res.ok) rowErrors.push(...Object.values(res.errors));
    if (rowErrors.length) {
      errors.push({ line, message: rowErrors.join(' / ') });
    } else {
      products.push(res.product);
    }
  }
  return { products, errors, total: dataRows.length };
}

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 수식 주입 방지
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ *
 * 상태 저장 / 백업 (JSON)
 * ------------------------------------------------------------------ */

export const STATE_VERSION = 1;

export function defaultState() {
  return {
    version: STATE_VERSION,
    settings: { targetMargin: CONSTANTS.DEFAULT_TARGET_MARGIN, scenarios: { ...SCENARIO_DEFAULTS } },
    channels: CONSTANTS.CHANNEL_PRESETS.map((c) => ({ ...c, name: presetName(c.id), source: 'preset' })),
    products: [],
  };
}

export function validateTargetMargin(raw) {
  return parseRate(raw, { field: t('f.targetMargin') });
}

/** 저장/복원용 상태 검증. 잘못된 행은 버리고 개수를 알려준다. */
export function validateState(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: t('err.notObject') };
  if (obj.version !== STATE_VERSION) return { ok: false, error: t('err.badVersion', { v: obj.version }) };
  const channels = [];
  const channelErrors = [];
  for (const raw of Array.isArray(obj.channels) ? obj.channels : []) {
    const res = validateChannel(raw || {});
    if (res.ok) channels.push({ ...res.channel, source: raw.source === 'preset' ? 'preset' : 'custom' });
    else channelErrors.push(Object.values(res.errors).join(' / '));
  }
  if (channels.length === 0) return { ok: false, error: t('err.noChannel') };
  const ids = channels.map((c) => c.id);
  const products = [];
  let droppedProducts = 0;
  for (const raw of Array.isArray(obj.products) ? obj.products : []) {
    const res = validateProduct(raw || {}, ids);
    if (res.ok) products.push(res.product); else droppedProducts += 1;
  }
  const tm = validateTargetMargin(obj.settings?.targetMargin ?? CONSTANTS.DEFAULT_TARGET_MARGIN);
  const sc = validateScenarioSettings(obj.settings?.scenarios ?? {});
  return {
    ok: true,
    state: {
      version: STATE_VERSION,
      settings: { targetMargin: tm.ok ? tm.value : CONSTANTS.DEFAULT_TARGET_MARGIN, scenarios: sc.value },
      channels,
      products: products.slice(0, CONSTANTS.MAX_PRODUCTS),
    },
    dropped: { products: droppedProducts, channels: channelErrors.length },
  };
}

export function exportStateJson(state, now = new Date()) {
  return JSON.stringify({ ...state, exportedAt: now.toISOString(), app: 'sellermargin' }, null, 2);
}

export function importStateJson(text) {
  let obj;
  try {
    obj = JSON.parse(String(text));
  } catch {
    return { ok: false, error: t('err.badJson') };
  }
  return validateState(obj);
}

/* ------------------------------------------------------------------ *
 * 시나리오 비교 (기준 · 프로모 · 광고 강화)
 * ------------------------------------------------------------------ */

export const SCENARIO_DEFAULTS = Object.freeze({ promoDiscount: 10, adMultiplier: 2 });
const MULT_RE = /^\d+(\.\d{1,2})?$/;

/** 시나리오 설정 검증. 프로모 할인율 0~50, 광고 배율 1~10. 잘못된 값은 기본값으로 되돌리고 오류를 알려 준다. */
export function validateScenarioSettings(input = {}) {
  const errors = {};
  const out = { ...SCENARIO_DEFAULTS };
  const promo = input.promoDiscount === undefined || input.promoDiscount === '' ? { ok: true, value: SCENARIO_DEFAULTS.promoDiscount } : parseRate(input.promoDiscount, { field: t('f.promo') });
  if (!promo.ok) errors.promoDiscount = promo.error;
  else if (promo.value > 50) errors.promoDiscount = t('err.promoRange');
  else out.promoDiscount = promo.value;

  const rawMult = input.adMultiplier === undefined || input.adMultiplier === '' ? SCENARIO_DEFAULTS.adMultiplier : input.adMultiplier;
  const s = String(rawMult).trim().replace(/x$/i, '');
  if (!MULT_RE.test(s)) errors.adMultiplier = t('err.multNumber');
  else if (Number(s) < 1 || Number(s) > 10) errors.adMultiplier = t('err.multRange');
  else out.adMultiplier = Number(s);
  return { ok: Object.keys(errors).length === 0, value: out, errors };
}

/**
 * 같은 상품을 세 가지 시나리오로 계산한다.
 *  - 기준: 입력값 그대로
 *  - 프로모: 할인율만 적용 (쿠폰 없음)
 *  - 광고 강화: 주문당 광고비에 배율 적용 (광고 전 이익은 그대로)
 */
export function computeScenarios(p, channel, { targetMargin = CONSTANTS.DEFAULT_TARGET_MARGIN, promoDiscount = SCENARIO_DEFAULTS.promoDiscount, adMultiplier = SCENARIO_DEFAULTS.adMultiplier } = {}) {
  const base = computeProduct(p, channel, { targetMargin });
  const promo = computeProduct(p, channel, { targetMargin, discountRate: promoDiscount });
  const adHeavy = computeProduct(p, channel, { targetMargin, adPerOrder: rnd(base.adPerOrder * adMultiplier) });
  return [
    { key: 'base', label: t('scn.base'), detail: t('scn.baseDetail'), result: base },
    { key: 'promo', label: t('scn.promo'), detail: t('scn.promoDetail', { d: promoDiscount }), result: promo },
    { key: 'adHeavy', label: t('scn.adHeavy'), detail: t('scn.adHeavyDetail', { m: adMultiplier }), result: adHeavy },
  ];
}

/* ------------------------------------------------------------------ *
 * 민감도 표 (판매가 × 목표 ROAS)
 * ------------------------------------------------------------------ *
 * 셀 = 해당 판매가에서 광고비를 판매가 / ROAS 로 두었을 때의 순마진과 마진율.
 * 할인·쿠폰은 적용하지 않는다 (판매가 자체의 영향만 보기 위해).
 */
export const SENS_PRICE_FACTORS = Object.freeze([0.8, 0.9, 1, 1.1, 1.2]);
export const SENS_ROAS_LEVELS = Object.freeze([2, 3, 4, 5, 6]);

export function sensitivityGrid(p, channel, { targetMargin = CONSTANTS.DEFAULT_TARGET_MARGIN, basePrice = p.price, roasLevels = SENS_ROAS_LEVELS, prices } = {}) {
  const priceList = prices ?? [...new Set(SENS_PRICE_FACTORS.map((f) => Math.max(10, Math.round((basePrice * f) / 10) * 10)))].sort((a, b) => a - b);
  const cells = priceList.map((price) => roasLevels.map((roas) => {
    const adPerOrder = rnd(price / roas);
    const r = computeProduct(p, channel, { targetMargin, price, discountRate: 0, coupon: 0, adPerOrder });
    return { price, roas, adPerOrder, net: r.net, marginRate: r.marginRate, health: r.health };
  }));
  return { prices: priceList, roasLevels: [...roasLevels], cells };
}

/* ------------------------------------------------------------------ *
 * 채널별 월 손익 요약
 * ------------------------------------------------------------------ *
 * 상품 1개당 금액 × 월 판매량을 채널별로 합산한다.
 * 항등식: 매출 − 원가 − 포장·배송 − 수수료 − 반품 기대 손실 − 광고비 = 순이익 (정수 원, 오차 없음).
 */
export function monthlyPnlByChannel(rows, channels = []) {
  const map = new Map();
  const blank = (id, name) => ({ channelId: id, name, count: 0, volume: 0, revenue: 0, cogs: 0, handling: 0, fees: 0, returnDrag: 0, ad: 0, net: 0, marginRate: null });
  for (const c of channels) map.set(c.id, blank(c.id, c.name));
  for (const { product, channel, result } of rows) {
    if (!map.has(channel.id)) map.set(channel.id, blank(channel.id, channel.name));
    const row = map.get(channel.id);
    const v = product.volume || 0;
    row.count += 1;
    row.volume += v;
    row.revenue += result.netRevenue * v;
    row.cogs += result.cogs * v;
    row.handling += result.handling * v;
    row.fees += result.fees * v;
    row.returnDrag += result.returnDrag * v;
    row.ad += result.adPerOrder * v;
    row.net += result.net * v;
  }
  const finish = (r) => ({ ...r, marginRate: r.revenue > 0 ? (r.net / r.revenue) * 100 : null });
  const list = [...map.values()].filter((r) => r.count > 0).map(finish);
  const sum = (k) => list.reduce((acc, r) => acc + r[k], 0);
  const total = finish({
    channelId: '__total', name: t('pnl.total'), count: sum('count'), volume: sum('volume'), revenue: sum('revenue'), cogs: sum('cogs'),
    handling: sum('handling'), fees: sum('fees'), returnDrag: sum('returnDrag'), ad: sum('ad'), net: sum('net'),
  });
  return { channels: list, total };
}

/* ------------------------------------------------------------------ *
 * 목표 이익 달성 판매량
 * ------------------------------------------------------------------ *
 * result.net 은 현재 가정(할인, 광고비, 반품 등)에서 주문 1건당 순이익이다.
 * 월 목표 순이익을 주문당 순이익으로 나눠 필요한 판매 건수를 올림으로 구한다.
 * 주문당 순이익이 0 이하이면 판매량을 늘려도 목표에 닿지 않으므로 불가능으로 표시한다.
 */
export function volumeForTargetProfit(result, monthlyTarget) {
  if (!Number.isSafeInteger(monthlyTarget) || monthlyTarget < 0) return { ok: false, reason: 'INVALID', perOrder: null, volume: null };
  if (!result || !Number.isFinite(result.net)) return { ok: false, reason: 'INVALID', perOrder: null, volume: null };
  const perOrder = rnd(result.net);
  if (monthlyTarget === 0) return { ok: true, reason: null, perOrder, volume: 0 };
  if (perOrder <= 0) return { ok: false, reason: 'NO_PROFIT', perOrder, volume: null };
  return { ok: true, reason: null, perOrder, volume: Math.ceil(monthlyTarget / perOrder) };
}

/**
 * 상품×채널 행 목록에 필요 판매량을 붙인다. 달성 가능한 행을 필요 판매량 적은 순으로 먼저,
 * 불가능한 행은 뒤에 둔다. 입력 rows는 { product, channel, result } 형태다.
 */
export function targetProfitRows(rows, monthlyTarget) {
  const out = rows.map(({ product, channel, result }) => ({
    productName: product.name,
    channelName: channel.name,
    currentVolume: product.volume || 0,
    ...volumeForTargetProfit(result, monthlyTarget),
  }));
  return out.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.ok) return a.volume - b.volume || a.productName.localeCompare(b.productName, localeTag());
    return a.productName.localeCompare(b.productName, localeTag());
  });
}

/* ------------------------------------------------------------------ *
 * 손익분기 차트 모델 (SVG 그리기는 app.js 에서)
 * ------------------------------------------------------------------ *
 * 주문당 광고비 x 에 대한 순마진 = 광고 전 이익 − x (직선).
 * 반환값은 데이터 좌표이며 화면 좌표 변환은 호출하는 쪽이 한다.
 */
function niceCeil(v) {
  if (!(v > 0)) return 1000;
  const m = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / m) * m;
}

/** 범위를 대략 4칸으로 나누는 보기 좋은 간격 (1, 2, 5 × 10^k). */
function niceStep(range) {
  if (!(range > 0)) return 1000;
  const raw = range / 4;
  const m = 10 ** Math.floor(Math.log10(raw));
  const n = raw / m;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * m;
}

/** lo 이상 hi 이하의 간격 배수 눈금 (0 이 범위 안에 있으면 항상 포함). */
function gridTicks(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v) || 0); // || 0 으로 -0 제거
  return out;
}

export function breakEvenChartModel(result, currentAd = 0) {
  const E = result.expectedPreAd;
  const xMax = niceCeil(Math.max(Math.abs(E), currentAd, 1000) * 1.2);
  const yMax = Math.max(E, 0);
  const yMin = Math.min(0, E - xMax);
  return {
    xMax,
    yMin,
    yMax,
    line: { x1: 0, y1: E, x2: xMax, y2: E - xMax },
    bep: E > 0 ? { x: E, y: 0 } : null,
    current: { x: currentAd, y: E - currentAd },
    xTicks: gridTicks(0, xMax, niceStep(xMax)),
    yTicks: gridTicks(yMin, yMax, niceStep(yMax - yMin)),
  };
}

/* ------------------------------------------------------------------ *
 * 오류 보고서 CSV (CSV 가져오기 행별 오류를 내려받을 때)
 * ------------------------------------------------------------------ */
export function errorReportCsv(errors) {
  // 열 이름은 파일 형식이므로 한국어로 고정한다 (가져오기와 호환).
  return toCsv(['줄', '오류 내용'], (errors || []).map((e) => [e.line || '', e.message]));
}

/* ------------------------------------------------------------------ *
 * AI 패널 (순수 함수: 프롬프트 생성 / 응답 파싱 / 키 형식 검사 / 규칙 기반 조언)
 * ------------------------------------------------------------------ */

const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

/** 키 형식만 검사한다 (실제 유효성은 API 호출로만 확인 가능). */
export function checkKeyFormat(raw) {
  const key = String(raw ?? '').trim();
  if (key === '') return { ok: false, error: t('err.keyEmpty') };
  if (/\s/.test(key)) return { ok: false, error: t('err.keySpace') };
  if (!key.startsWith('sk-ant-')) return { ok: false, error: t('err.keyPrefix') };
  if (!KEY_RE.test(key)) return { ok: false, error: t('err.keyLength') };
  return { ok: true, key };
}

/**
 * 최하위 상품 요약만 프롬프트에 넣는다. 상품명·SKU 는 기본적으로 제외 ("상품 A" 등으로 치환).
 * items: [{ label, price, net, marginRate, bepRoas, adPerOrder, returnRate, volume }]
 */
export function buildAdvicePrompt(items, { targetMargin, includeNames = false, names = [] } = {}) {
  const lines = items.map((it, idx) => {
    const label = includeNames && names[idx] ? names[idx] : t('ai.anonLabel', { x: String.fromCharCode(65 + idx) });
    const none = t('common.none');
    const f = (v, unit = '') => (v === null || v === undefined || Number.isNaN(v) ? none : `${Math.round(v * 100) / 100}${unit}`);
    const money = (v) => (v === null || v === undefined || Number.isNaN(v) ? none : krw(Math.round(v)));
    return `- ${label}: ${t('ai.line.price')} ${money(it.price)}, ${t('ai.line.net')} ${money(it.net)}, ${t('ai.line.margin')} ${f(it.marginRate, '%')}, ${t('ai.line.bep')} ${f(it.bepRoas)}, ${t('ai.line.ad')} ${money(it.adPerOrder)}, ${t('ai.line.returnRate')} ${f(it.returnRate, '%')}, ${t('ai.line.volume')} ${f(it.volume, ' ' + t('unit.pcs'))}`;
  });
  return [
    t('ai.prompt.intro'),
    t('ai.prompt.target', { m: targetMargin }),
    '',
    ...lines,
    '',
    t('ai.prompt.rule'),
    '{"summary":"..." ,"actions":[{"product":"...","type":"price|ad|return|cost|other","suggestion":"..."}]}',
  ].join('\n');
}

const ACTION_TYPES = ['price', 'ad', 'return', 'cost', 'other'];

/** 모델 응답을 안전하게 파싱한다. 기대 형식이 아니면 ok:false. */
export function parseAdviceReply(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: t('err.aiNoJson') };
  let obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch {
    return { ok: false, error: t('err.aiParse') };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: t('err.aiShape') };
  const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
  const summary = clip(obj.summary, 300);
  const actions = (Array.isArray(obj.actions) ? obj.actions : [])
    .slice(0, 10)
    .map((a) => ({
      product: clip(a?.product, 40) || t('ai.defaultProduct'),
      type: ACTION_TYPES.includes(a?.type) ? a.type : 'other',
      suggestion: clip(a?.suggestion, 300),
    }))
    .filter((a) => a.suggestion !== '');
  if (!summary && actions.length === 0) return { ok: false, error: t('err.aiEmpty') };
  return { ok: true, summary, actions };
}

/**
 * 규칙 기반 조언 (API 키가 없을 때). rows: [{ label, product, channel, result }] (최하위 상품)
 * 가격 역산 결과로 "얼마 올리면 목표 마진" 과 "광고비 상한" 을 계산한다.
 */
export function ruleBasedAdvice(rows, targetMargin) {
  const actions = [];
  for (const { label, product, channel, result } of rows) {
    if (result.health === HEALTH.INVALID) {
      actions.push({ product: label, type: 'other', suggestion: t('rule.noRevenue') });
      continue;
    }
    if (result.health === HEALTH.GOOD) continue;
    if (result.expectedPreAd <= 0) {
      actions.push({ product: label, type: 'cost', suggestion: t('rule.lossBeforeAd', { v: krw(result.expectedPreAd) }) });
      continue;
    }
    const targetPrice = solvePriceForMargin(product, channel, targetMargin, { targetMargin, discountRate: 0, coupon: 0 });
    if (targetPrice !== null && targetPrice > product.price) {
      const up = targetPrice - product.price;
      actions.push({ product: label, type: 'price', suggestion: t('rule.raisePrice', { up: krw(up), target: krw(targetPrice), m: targetMargin }) });
    } else if (targetPrice === null) {
      actions.push({ product: label, type: 'cost', suggestion: t('rule.cannotReach', { m: targetMargin }) });
    }
    if (result.adPerOrder > 0) {
      const maxAd = result.expectedPreAd - rnd((targetMargin / 100) * result.netRevenue);
      if (maxAd >= 0 && maxAd < result.adPerOrder) {
        actions.push({ product: label, type: 'ad', suggestion: t('rule.maxAd', { max: krw(maxAd), cur: krw(result.adPerOrder) }) });
      } else if (maxAd < 0) {
        actions.push({ product: label, type: 'ad', suggestion: t('rule.zeroAdFail') });
      }
    }
    if (product.returnRate >= 5 && product.returnLoss > 0) {
      actions.push({ product: label, type: 'return', suggestion: t('rule.returnHigh', { rate: product.returnRate, loss: krw(result.returnDrag) }) });
    }
  }
  const summary = actions.length
    ? t('rule.summaryN', { n: rows.length, a: actions.length })
    : t('rule.summaryNone');
  return { ok: true, summary, actions: actions.slice(0, 10) };
}
