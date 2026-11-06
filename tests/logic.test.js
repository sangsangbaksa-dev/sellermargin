import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSTANTS, rnd, parseMoney, parseRate, parseRoas, parseVolume,
  validateProduct, validateChannel, computeProduct, solvePriceForMargin,
  compareChannels, summarize, sortRows, parseCsv, mapCsvProducts, toCsv,
  validateState, importStateJson, exportStateJson, defaultState,
  checkKeyFormat, buildAdvicePrompt, parseAdviceReply, ruleBasedAdvice,
  HEALTH,
} from '../logic.js';

// 재현 가능한 난수 (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SMART = { id: 'smartstore', name: '스마트스토어', saleFeeRate: 5.5, pgFeeRate: 3.5, fixedFee: 0, vatSeparate: true };
const NO_VAT = { id: 'etsy', name: 'Etsy', saleFeeRate: 6.5, pgFeeRate: 3, fixedFee: 600, vatSeparate: false };

const base = {
  id: 'p1', name: '테스트', sku: 'SKU-1', channelId: 'smartstore', price: 10000,
  cogs: 3000, packaging: 500, shipping: 2500, returnRate: 0, returnLoss: 0,
  adMode: 'perOrder', adPerOrder: 1000, roasTarget: 0, volume: 0,
};

describe('원 단위 반올림', () => {
  test('0.5 는 절대값 기준 올림, -0 은 나오지 않는다', () => {
    assert.equal(rnd(2.5), 3);
    assert.equal(rnd(-2.5), -3);
    assert.equal(rnd(0.49), 0);
    assert.ok(Object.is(rnd(-0.4), 0), 'expected +0');
    assert.equal(rnd(1.4999), 1);
  });
});

describe('입력 파싱', () => {
  test('정수 원 금액: 콤마/원 표기 허용, 소수·문자·범위 초과 거부', () => {
    assert.deepEqual(parseMoney('1,000'), { ok: true, value: 1000 });
    assert.deepEqual(parseMoney('12,000원'), { ok: true, value: 12000 });
    assert.equal(parseMoney('1000.5').ok, false);
    assert.equal(parseMoney('abc').ok, false);
    assert.equal(parseMoney('1e3').ok, false);
    assert.equal(parseMoney('-1').ok, false);
    assert.equal(parseMoney('99999999999999999999').ok, false);
    assert.equal(parseMoney('100000001').ok, false);
    assert.equal(parseMoney(' ').ok, false);
    assert.deepEqual(parseMoney('', { optional: true }), { ok: true, value: 0 });
  });

  test('퍼센트: 0~100, 소수 둘째 자리까지', () => {
    assert.deepEqual(parseRate('5.5'), { ok: true, value: 5.5 });
    assert.deepEqual(parseRate('12%'), { ok: true, value: 12 });
    assert.equal(parseRate('5.555').ok, false);
    assert.equal(parseRate('100.01').ok, false);
    assert.equal(parseRate('-0.1').ok, false);
    assert.equal(parseRate('100').ok, true);
    assert.equal(parseRate('0').ok, true);
  });

  test('ROAS 0 은 나눗셈 불가이므로 거부', () => {
    assert.equal(parseRoas('0').ok, false);
    assert.equal(parseRoas('-2').ok, false);
    assert.deepEqual(parseRoas('3.5x'), { ok: true, value: 3.5 });
  });

  test('월 판매량은 정수', () => {
    assert.equal(parseVolume('1.5').ok, false);
    assert.equal(parseVolume('').value, 0);
  });

  test('상품 검증: 판매가 0 거부, 광고 방식별 필수값', () => {
    const r1 = validateProduct({ ...base, price: '0' }, ['smartstore']);
    assert.equal(r1.ok, false);
    assert.ok(r1.errors.price);
    const r2 = validateProduct({ ...base, adMode: 'roas', roasTarget: '0' }, ['smartstore']);
    assert.ok(r2.errors.roasTarget);
    const r3 = validateProduct({ ...base, channelId: 'nope' }, ['smartstore']);
    assert.ok(r3.errors.channelId);
    const ok = validateProduct({ ...base, adMode: 'roas', roasTarget: '4' }, ['smartstore']);
    assert.equal(ok.ok, true);
    assert.equal(ok.product.roasTarget, 4);
  });

  test('채널 검증: 판매 수수료 필수, 부가세 옵션 boolean 변환', () => {
    assert.equal(validateChannel({ name: '', saleFeeRate: '5' }).ok, false);
    const r = validateChannel({ name: '테스트', saleFeeRate: '5', vatSeparate: 'on' });
    assert.equal(r.ok, true);
    assert.equal(r.channel.vatSeparate, true);
  });
});

describe('수수료 스택 계산', () => {
  test('부가세 분리 ON: 매출·수수료·광고 전 이익·순마진 값 확인', () => {
    const r = computeProduct(base, SMART);
    assert.equal(r.vat, 909); // 10000 - 10000/1.1
    assert.equal(r.netRevenue, 9091);
    assert.equal(r.saleFee, 550);
    assert.equal(r.pgFee, 350);
    assert.equal(r.fees, 900);
    assert.equal(r.keepPreAd, 9091 - 3000 - 3000 - 900);
    assert.equal(r.net, 2191 - 1000);
    assert.ok(Math.abs(r.marginRate - (1191 / 9091) * 100) < 1e-9);
    assert.equal(r.health, HEALTH.RISK); // 13.1% < 기본 목표 15%
  });

  test('부가세 분리 OFF: 판매가 전액이 매출, 고정 수수료 반영', () => {
    const r = computeProduct({ ...base, cogs: 3000, packaging: 0, shipping: 0 }, NO_VAT);
    assert.equal(r.vat, 0);
    assert.equal(r.netRevenue, 10000);
    assert.equal(r.saleFee, 650);
    assert.equal(r.pgFee, 300);
    assert.equal(r.fixedFee, 600);
    assert.equal(r.keepPreAd, 10000 - 3000 - 650 - 300 - 600);
  });

  test('반품률 반영: 기대 광고 전 이익 = (1-r)·유지 + r·반품', () => {
    const p = { ...base, returnRate: 10, returnLoss: 1000 };
    const r = computeProduct(p, SMART);
    // 유지 2191, 반품 -(3000 + 900 + 1000) = -4900 → 0.9·2191 + 0.1·(-4900) = 1481.9 → 1482
    assert.equal(r.expectedPreAd, 1482);
    assert.equal(r.net, 482);
    assert.equal(r.returnDrag, 2191 - 1482);
    assert.equal(r.netNoReturn, 1191);
  });

  test('반품률 0 과 100 경계', () => {
    const zero = computeProduct({ ...base, returnRate: 0, returnLoss: 500 }, SMART);
    assert.equal(zero.expectedPreAd, zero.keepPreAd);
    const full = computeProduct({ ...base, returnRate: 100, returnLoss: 500 }, SMART);
    assert.equal(full.expectedPreAd, -(3000 + 900 + 500));
    assert.equal(full.bepRoas, null);
  });

  test('ROAS 목표 모드: 광고비 = 판매가 / ROAS', () => {
    const r = computeProduct({ ...base, adMode: 'roas', roasTarget: 4 }, SMART);
    assert.equal(r.adPerOrder, 2500);
    assert.equal(r.roasMissing, false);
  });

  test('ROAS 목표가 0 이면 광고비 0 으로 두고 플래그', () => {
    const r = computeProduct({ ...base, adMode: 'roas', roasTarget: 0 }, SMART);
    assert.equal(r.adPerOrder, 0);
    assert.equal(r.roasMissing, true);
  });

  test('광고비 0 이어도 ROAS 계산이 깨지지 않는다 (광고 비용 0 은 나눗셈 대상 아님)', () => {
    const r = computeProduct({ ...base, adPerOrder: 0 }, SMART);
    assert.equal(r.adPerOrder, 0);
    assert.equal(r.bepRoas, 10000 / 2191);
  });

  test('손익분기 ROAS: 광고 전 이익이 0 이하이면 null', () => {
    const r = computeProduct({ ...base, cogs: 9000 }, SMART);
    assert.ok(r.expectedPreAd <= 0);
    assert.equal(r.bepRoas, null);
    assert.equal(r.health, HEALTH.LOSS);
  });

  test('할인과 쿠폰: 할인율 적용 후 쿠폰 차감, 음수 방지', () => {
    const r = computeProduct(base, SMART, { discountRate: 10, coupon: 500 });
    assert.equal(r.effectivePrice, 8500);
    const floor = computeProduct(base, SMART, { discountRate: 100, coupon: 500 });
    assert.equal(floor.effectivePrice, 0);
    assert.equal(floor.health, HEALTH.INVALID);
    assert.equal(floor.marginRate, null);
  });

  test('목표 마진율 미달이면 위험, 순마진 음수면 적자', () => {
    const risk = computeProduct(base, SMART, { targetMargin: 30 });
    assert.equal(risk.health, HEALTH.RISK);
    const loss = computeProduct({ ...base, adPerOrder: 5000 }, SMART);
    assert.equal(loss.health, HEALTH.LOSS);
  });

  test('채널 비교: 같은 상품을 채널별로 계산', () => {
    const rows = compareChannels(base, [SMART, NO_VAT]);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].result.net, rows[1].result.net);
  });
});

describe('역산: 목표 마진율을 만족하는 판매가', () => {
  test('고정 예시: 역산 결과가 정방향 계산과 일치', () => {
    const P = solvePriceForMargin(base, SMART, 20);
    assert.ok(P !== null);
    assert.ok(computeProduct({ ...base, price: P }, SMART).marginRate >= 20);
    assert.ok(computeProduct({ ...base, price: P - 1 }, SMART).marginRate < 20);
  });

  test('속성 테스트: 무작위 입력 300건에서 역산 판매가는 최소 달성 가격이다', () => {
    const rand = rng(20261106);
    const pick = (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1));
    let solved = 0;
    let unreachable = 0;
    for (let i = 0; i < 300; i += 1) {
      const channel = rand() < 0.5 ? SMART : NO_VAT;
      const p = {
        ...base,
        cogs: pick(0, 30000),
        packaging: pick(0, 3000),
        shipping: pick(0, 5000),
        returnRate: Math.round(rand() * 10000) / 100,
        returnLoss: pick(0, 3000),
        adPerOrder: pick(0, 5000),
      };
      const target = Math.round(rand() * 4000) / 100; // 0 ~ 40 %
      const opts = { targetMargin: target, discountRate: rand() < 0.3 ? pick(0, 50) : 0 };
      const P = solvePriceForMargin(p, channel, target, opts);
      if (P === null) {
        unreachable += 1;
        const max = computeProduct({ ...p, price: CONSTANTS.MAX_PRICE }, channel, opts).marginRate;
        assert.ok(max === null || max < target, `unreachable but max margin ${max} >= ${target}`);
        continue;
      }
      solved += 1;
      const at = computeProduct({ ...p, price: P }, channel, opts).marginRate;
      assert.ok(at !== null && at >= target, `P=${P} margin ${at} < target ${target}`);
      if (P > 1) {
        const below = computeProduct({ ...p, price: P - 1 }, channel, opts).marginRate;
        assert.ok(below === null || below < target, `P-1 also reaches target (P=${P})`);
      }
    }
    assert.ok(solved > 100, `too few solvable cases: ${solved}`);
    assert.ok(unreachable + solved === 300);
  });
});

describe('집계와 정렬', () => {
  test('summarize: 판매 중 적자, 목표 미달, 월 합계', () => {
    const lossP = { ...base, id: 'a', name: '적자', adPerOrder: 6000, volume: 10 };
    const okP = { ...base, id: 'b', name: '양호', volume: 100 };
    const idleLoss = { ...base, id: 'c', name: '판매없음', adPerOrder: 6000, volume: 0 };
    const rows = [lossP, okP, idleLoss].map((p) => ({ product: p, result: computeProduct(p, SMART, { targetMargin: 15 }) }));
    const s = summarize(rows, 15);
    assert.equal(s.count, 3);
    assert.equal(s.lossSelling, 1);
    assert.equal(s.lossCount, 2);
    assert.equal(s.monthlyNet, rows[0].result.net * 10 + rows[1].result.net * 100 + rows[2].result.net * 0);
    assert.equal(s.worst[0].product.id, 'a');
    assert.equal(s.worst.length, 3);
  });

  test('summarize: 빈 목록과 판매량 0', () => {
    const s = summarize([], 15);
    assert.equal(s.count, 0);
    assert.equal(s.monthlyMarginRate, null);
  });

  test('sortRows: null(BEP ROAS 없음)은 항상 뒤, 이름은 한국어 정렬', () => {
    const rows = [
      { product: { name: '나' }, result: { net: 5, marginRate: 10, bepRoas: 3, effectivePrice: 100 } },
      { product: { name: '가' }, result: { net: -5, marginRate: null, bepRoas: null, effectivePrice: 50 } },
      { product: { name: '다' }, result: { net: 9, marginRate: 2, bepRoas: 1, effectivePrice: 200 } },
    ];
    assert.deepEqual(sortRows(rows, 'bepRoas', 'asc').map((r) => r.product.name), ['다', '나', '가']);
    assert.deepEqual(sortRows(rows, 'net', 'desc').map((r) => r.product.name), ['다', '나', '가']);
    assert.deepEqual(sortRows(rows, 'name', 'asc').map((r) => r.product.name), ['가', '나', '다']);
  });
});

describe('CSV 파싱', () => {
  test('따옴표 안 콤마, 이스케이프 따옴표, CRLF, BOM, 줄바꿈 포함 필드', () => {
    const text = '﻿상품명,판매가,메모\r\n"티셔츠, 흰색",10000,"say ""hi""\n둘째 줄"\r\n\r\n';
    const { rows, error } = parseCsv(text);
    assert.equal(error, null);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1].cells, ['티셔츠, 흰색', '10000', 'say "hi"\n둘째 줄']);
    assert.equal(rows[1].line, 2);
  });

  test('닫히지 않은 따옴표는 오류로 보고', () => {
    const { error } = parseCsv('a,"b\nc,d');
    assert.ok(error);
  });

  test('매핑: 헤더 별칭, 채널 이름 매칭, 행별 오류와 줄 번호', () => {
    const csv = [
      '상품명,SKU,채널,판매가,원가,포장비,배송비 부담액,반품률(%),광고비,목표ROAS',
      '"고무 슬리퍼, 2종",A-1,스마트스토어,12000,4000,500,2500,3,1000,',
      '불량행,B-1,스마트스토어,abc,0,0,0,0,0,',
      '광고둘다,C-1,쿠팡 마켓플레이스,9000,1000,0,0,0,500,4',
      ',D-1,11번가,9000,0,0,0,0,0,',
      'E,E-1,없는채널,9000,0,0,0,0,0,',
    ].join('\n');
    const res = mapCsvProducts(csv, CONSTANTS.CHANNEL_PRESETS);
    assert.equal(res.products.length, 1);
    assert.equal(res.products[0].name, '고무 슬리퍼, 2종');
    assert.equal(res.products[0].channelId, 'smartstore');
    assert.equal(res.products[0].returnRate, 3);
    assert.equal(res.errors.length, 4);
    assert.deepEqual(res.errors.map((e) => e.line), [3, 4, 5, 6]);
    assert.match(res.errors[0].message, /판매가/);
  });

  test('헤더에 필수 열이 없으면 전체 오류', () => {
    const res = mapCsvProducts('sku,price\nA,1000', CONSTANTS.CHANNEL_PRESETS);
    assert.equal(res.products.length, 0);
    assert.match(res.errors[0].message, /상품명/);
  });

  test('목표 ROAS 열만 있으면 ROAS 모드로 읽는다', () => {
    const res = mapCsvProducts('상품명,판매가,목표ROAS\nX,10000,4', CONSTANTS.CHANNEL_PRESETS);
    assert.equal(res.products[0].adMode, 'roas');
    assert.equal(res.products[0].roasTarget, 4);
  });

  test('CSV 내보내기: 따옴표/콤마 이스케이프, 수식 주입 방지', () => {
    const out = toCsv(['이름', '값'], [['a,b', 1], ['"q"', 2], ['=HYPERLINK("x")', 3]]);
    assert.ok(out.startsWith('﻿'));
    assert.match(out, /"a,b",1/);
    assert.match(out, /"""q""",2/);
    assert.match(out, /'=HYPERLINK/);
  });
});

describe('상태 백업 검증', () => {
  test('내보내기 → 가져오기 왕복', () => {
    const st = defaultState();
    st.products.push({ ...base, channelId: 'smartstore' });
    const text = exportStateJson(st, new Date('2026-11-06T00:00:00Z'));
    const res = importStateJson(text);
    assert.equal(res.ok, true);
    assert.equal(res.state.products.length, 1);
    assert.equal(res.state.products[0].price, 10000);
    assert.equal(res.state.channels.length, CONSTANTS.CHANNEL_PRESETS.length);
  });

  test('잘못된 JSON, 버전 불일치, 잘못된 행 제외', () => {
    assert.equal(importStateJson('{not json').ok, false);
    assert.equal(validateState({ version: 2 }).ok, false);
    const st = defaultState();
    const obj = { ...st, products: [{ ...base, price: -5 }, { ...base, channelId: 'missing' }, { ...base }] };
    const res = validateState(obj);
    assert.equal(res.ok, true);
    assert.equal(res.state.products.length, 1);
    assert.equal(res.dropped.products, 2);
  });

  test('목표 마진율 범위 밖이면 기본값으로 복원', () => {
    const res = validateState({ ...defaultState(), settings: { targetMargin: 500 } });
    assert.equal(res.state.settings.targetMargin, CONSTANTS.DEFAULT_TARGET_MARGIN);
  });
});

describe('AI 패널 순수 로직', () => {
  test('키 형식 검사', () => {
    assert.equal(checkKeyFormat('').ok, false);
    assert.equal(checkKeyFormat('abc').ok, false);
    assert.equal(checkKeyFormat('sk-ant-short').ok, false);
    assert.equal(checkKeyFormat('sk-ant-' + 'a'.repeat(30) + ' ').ok, true);
    assert.equal(checkKeyFormat('sk-ant-' + 'a'.repeat(30) + ' x').ok, false);
    assert.equal(checkKeyFormat('sk-ant-' + 'a'.repeat(30)).ok, true);
  });

  test('프롬프트: 기본은 상품명 제외, 옵션으로만 포함', () => {
    const items = [{ price: 10000, net: -500, marginRate: -5, bepRoas: null, adPerOrder: 1000, returnRate: 3, volume: 10 }];
    const anon = buildAdvicePrompt(items, { targetMargin: 15, names: ['비밀상품명'] });
    assert.ok(!anon.includes('비밀상품명'));
    assert.match(anon, /상품 A/);
    assert.match(anon, /손익분기 ROAS 없음/);
    const named = buildAdvicePrompt(items, { targetMargin: 15, includeNames: true, names: ['비밀상품명'] });
    assert.match(named, /비밀상품명/);
  });

  test('응답 파싱: 설명 텍스트와 코드펜스 속 JSON 추출, 타입 보정, 제어문자 제거', () => {
    const text = '여기 결과입니다:\n```json\n{"summary":"요약\\u0007","actions":[{"product":"상품 A","type":"hack","suggestion":"가격을 올리세요"},{"product":"B","type":"ad","suggestion":""}]}\n```';
    const res = parseAdviceReply(text);
    assert.equal(res.ok, true);
    assert.equal(res.summary, '요약');
    assert.equal(res.actions.length, 1);
    assert.equal(res.actions[0].type, 'other');
  });

  test('응답 파싱 실패 케이스', () => {
    assert.equal(parseAdviceReply('아무 말').ok, false);
    assert.equal(parseAdviceReply('{broken}').ok, false);
    assert.equal(parseAdviceReply('{"summary":"","actions":[]}').ok, false);
    assert.equal(parseAdviceReply(null).ok, false);
    const long = parseAdviceReply(JSON.stringify({ summary: 'x'.repeat(1000), actions: [] }));
    assert.equal(long.summary.length, 300);
  });

  test('규칙 기반 조언: 적자 상품은 가격 인상 또는 광고 상한을 제시', () => {
    const p = { ...base, adPerOrder: 2000 };
    const result = computeProduct(p, SMART, { targetMargin: 15 });
    const advice = ruleBasedAdvice([{ label: '상품 A', product: p, channel: SMART, result }], 15);
    assert.equal(advice.ok, true);
    assert.ok(advice.actions.length >= 1);
    assert.ok(advice.actions.every((a) => typeof a.suggestion === 'string' && a.suggestion.length > 0));
    assert.ok(advice.actions.some((a) => a.type === 'price' || a.type === 'ad' || a.type === 'cost'));
  });

  test('규칙 기반 조언: 양호 상품은 조치 없음', () => {
    const result = computeProduct({ ...base, adPerOrder: 0 }, SMART, { targetMargin: 5 });
    const advice = ruleBasedAdvice([{ label: '상품 A', product: { ...base, adPerOrder: 0 }, channel: SMART, result }], 5);
    assert.equal(advice.actions.length, 0);
  });
});
