// Uji otomatis mesin v2 (offline):  node scripts/test-engine.mjs
// Memeriksa gerbang kualitas, anti-setup-usang, rezim BTC, portofolio, validator sinyal, jeda koin, proteksi risiko,
// gerbang uang nyata, pembatalan order di simulator, dan kompatibilitas rantai hash lama. Skenario candle dibuat
// tangan agar hasilnya dapat diperiksa manual, ditambah uji properti pada ribuan hari data acak.
import { feat, checkBars, selectPortfolio, btcCtx, scanInput, CFG } from '../core.mjs';
import { gradeTrade, H1 } from '../trade-sim.mjs';
import { validateSignal, activeBlock } from '../signal-lib.mjs';
import { riskState, sizePosition, portfolioHeat, readiness, RISK } from '../risk-lib.mjs';
import { sealRow, lastSealed, verifyChain } from '../forward-lib.mjs';
import { mulberry32 } from './backtest-lib.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  GAGAL', name, extra); } };
const T0 = Date.UTC(2025, 0, 6), DAY = 864e5;
const mkBar = (i, o, c, wick = 0.004) => ({ t: T0 + i * DAY, o, c, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), v: 1e6 });
const win = k => [...k, { t: k.at(-1).t + DAY, o: k.at(-1).c, h: k.at(-1).c, l: k.at(-1).c, c: k.at(-1).c, v: 0 }];
// Range naik bergelombang (drift > 0 = tren naik, < 0 = tren turun) selama 420 hari
function base(drift = 0.15, amp = 0.08, N = 420) {
  const b = []; let p = 100;
  for (let i = 0; i < N; i++) { const ctr = 100 + drift * i, c = ctr * (1 + amp * Math.sin(i / 7)); b.push(mkBar(i, p, c)); p = c; }
  return b;
}
const lowOf = b => Math.min(...b.slice(-65, -5).map(q => q.l));
// Ekor: turun ke dekat L, sweep di bawah L lalu reclaim, lalu `after` (daftar close berikutnya)
function sweep(drift, after = [], { reclaim = 1.012, noSweepClose = null } = {}) {
  const b = base(drift), L = lowOf(b), last = b.at(-1).c; let i = b.length;
  const out = b.slice(), push = (o, c, l, h) => { const q = mkBar(i++, o, c); if (l != null) q.l = Math.min(q.l, l); if (h != null) q.h = Math.max(q.h, h); out.push(q); return q; };
  push(last, L * 1.04); push(L * 1.04, L * 1.015); push(L * 1.015, L * 1.01, L * 0.985);
  push(L * 1.01, L * reclaim, L * 0.97);
  let prev = L * reclaim;
  for (const c of after) { const [o, cl] = Array.isArray(c) ? c : [prev, c]; push(o, cl, null, Math.max(o, cl) * 1.002); prev = cl; }
  return { bars: out, L };
}

console.log('\n[1] Validasi data masuk');
{
  const b = base(); const good = win(b);
  ok(checkBars(good) === true, 'data sehat diterima');
  const nan = good.map((q, i) => (i === good.length - 5 ? { ...q, c: NaN } : q));
  let t = false; try { feat(nan, 1e9); } catch (e) { t = /data-tidak-valid/.test(e.message); }
  ok(t, 'nilai NaN ditolak dengan alasan data-tidak-valid');
  const gap = good.filter((_, i) => i !== good.length - 10);
  t = false; try { feat(gap, 1e9); } catch (e) { t = /bolong/.test(e.message); }
  ok(t, 'candle harian bolong ditolak (bukan dipakai diam-diam)');
  const bad = good.map((q, i) => (i === good.length - 7 ? { ...q, h: q.l * 0.9 } : q));
  t = false; try { feat(bad, 1e9); } catch (e) { t = /tidak konsisten/.test(e.message); }
  ok(t, 'high < low ditolak');
  const zero = good.map((q, i) => (i === good.length - 3 ? { ...q, o: 0 } : q));
  t = false; try { feat(zero, 1e9); } catch (e) { t = /nol/.test(e.message); }
  ok(t, 'harga nol ditolak');
  t = false; try { feat([], 1e9); } catch { t = true; }
  ok(t, 'data kosong ditolak');
  // scanInput: candle hari ini harus menyambung dengan kemarin
  const now = b.at(-1).t + DAY + 3 * 36e5, k = [...b, { t: b.at(-1).t + 2 * DAY, o: 1, h: 1, l: 1, c: 1, v: 1 }];
  t = false; try { scanInput(k, b.at(-1).t + 2 * DAY + 3e6); } catch (e) { t = /menyambung/.test(e.message); }
  ok(t, 'scanInput menolak candle hari ini yang tidak menyambung');
}

console.log('\n[2] Setup segar lolos, setup usang ditolak');
{
  const fresh = feat(win(sweep(0.15).bars), 1e9);
  ok(fresh.side === 1 && fresh.trig === 'dev' && fresh.ok, 'skenario deviasi bawah di tren naik menghasilkan LONG yang lolos', JSON.stringify([fresh.side, fresh.trig, fresh.rej]));
  ok(fresh.age === 1 && fresh.score >= CFG.minScore && fresh.grade !== 'C', `umur 1 hari, skor ${fresh.score}, grade ${fresh.grade}`);
  ok(fresh.type === 'scalping' || fresh.type === 'swing', 'tipe setup tetap terisi untuk setup yang lolos');

  // Harga lari ke TP lalu kembali ke entry: persis kasus "EXPIRED = harga sudah di TP 2-3 hari sebelumnya"
  const tp = fresh.tp, L = fresh.entry;
  const stale = feat(win(sweep(0.15, [tp * 1.03, L * 1.012]).bars), 1e9);
  ok(stale.side === 1 && !stale.ok && stale.rej.includes('usang-tp-tercapai'), 'harga sudah menyentuh TP setelah pemicu: DITOLAK usang-tp-tercapai', JSON.stringify([stale.side, stale.rej]));
  ok(stale.type === 'ditolak', 'konsumen lama (type=ditolak) otomatis melewati setup usang');

  // Pemicu terlalu lama
  const old = feat(win(sweep(0.15, [L * 1.02, L * 1.015, L * 1.012, L * 1.012]).bars), 1e9);
  ok(old.side !== 1 || !old.ok, 'pemicu 5 hari lalu tidak dipublikasikan', JSON.stringify([old.side, old.age, old.rej]));

  // SL tertembus sejak pemicu: setup gugur
  const brk = feat(win(sweep(0.15, [fresh.sl * 0.97, [L * 1.012, L * 1.012]]).bars), 1e9); // turun menembus wick lalu gap naik tanpa reclaim baru
  ok(!(brk.side === 1 && brk.ok) && (brk.side !== 1 || brk.rej.includes('usang-sl-tertembus')), 'harga menembus wick pemicu: tesis gugur, tidak dipublikasikan', JSON.stringify([brk.side, brk.rej]));

  // Harga masih jauh dari entry: bukan sinyal, hanya pantauan
  const far = feat(win(sweep(0.15, [], { reclaim: 1.06 }).bars), 1e9);
  ok(far.side === 1 && !far.ok && far.rej.includes('jauh-dari-entry'), 'harga terlalu jauh dari entry limit: ditolak jauh-dari-entry', JSON.stringify([far.side, far.rej, far.dist]));
  ok(far.watch === true || far.rej.length > 1, 'bila hanya itu kekurangannya, ditandai watch (pantauan)');

  // Likuiditas
  const thin = feat(win(sweep(0.15).bars), 1e6);
  ok(!thin.ok && thin.rej.includes('likuiditas-rendah'), 'volume dolar di bawah batas: ditolak likuiditas-rendah');
}

console.log('\n[3] Rezim BTC');
{
  const S = win(sweep(0.15).bars);
  const up = { tr: 1, td: 1, ret1d: 0, ret3d: 0.01, ret7d: 0.02 }, dn = { tr: -1, td: -1, ret1d: -0.01, ret3d: -0.02, ret7d: -0.03 };
  const a = feat(S, 1e9, up), b = feat(S, 1e9, dn);
  ok(a.ok, 'LONG altcoin lolos saat BTC searah');
  ok(!b.ok && b.rej.includes('melawan-btc'), 'LONG altcoin ditolak saat BTC turun di weekly dan daily (gerbang BTC kini keras)');
  const c = feat(S, 1e9, { tr: 1, td: 1, ret1d: -0.04, ret3d: -0.08, ret7d: -0.1 });
  ok(!c.ok && c.rej.includes('btc-momentum-lawan'), 'LONG ditolak saat BTC jatuh >5% dalam 3 hari (pisau jatuh)');
  const d = feat(S, 1e9, { tr: -1, td: 0, ret1d: 0, ret3d: 0, ret7d: 0 });
  ok(!d.rej.includes('melawan-btc'), 'BTC hanya melawan di satu timeframe: tidak diblokir keras (hanya mengurangi skor)');
  ok(d.score < a.score, `skor lebih rendah bila BTC tidak searah (${d.score} < ${a.score})`);
  ok(feat(S, 1e9).ok, 'tanpa ctx (BTC sendiri) gerbang rezim tidak dipakai');
  const ctx = btcCtx(feat(win(base(0.15)), 0));
  ok(ctx && ctx.tr === 1 && Number.isFinite(ctx.ret3d), 'btcCtx diambil dari feat(BTC)');
  ok(btcCtx(null) === undefined, 'btcCtx tanpa data BTC = undefined');
}

console.log('\n[4] Melawan tren butuh konfirmasi');
{
  // Tren turun + sweep ke bawah lalu reclaim = LONG melawan tren. v1 meloloskannya lewat sweep saja.
  const f = feat(win(sweep(-0.1).bars), 1e9);
  ok(!(f.side === 1 && f.tr === -1 && f.obvDiv !== 1 && f.rsiDiv !== 1), 'LONG melawan tren makro tanpa divergensi OBV/RSI tidak menghasilkan sinyal', JSON.stringify([f.side, f.tr, f.obvDiv, f.rsiDiv]));
}

console.log('\n[5] Properti pada data acak (oracle independen)');
{
  const r = mulberry32(99), mk = (seed, n) => { const rr = mulberry32(seed); let p = 100; return Array.from({ length: n }, (_, i) => { const o = p, c = p * (1 + (rr() - 0.5) * 0.07); p = c; return { t: T0 + i * DAY, o, h: Math.max(o, c) * (1 + rr() * 0.01), l: Math.min(o, c) * (1 - rr() * 0.01), c, v: 1e6 + rr() * 1e6 }; }); };
  const B = mk(1, 1000), syms = [2, 3, 4, 5].map(s => mk(s, 1000));
  let raw = 0, oks = 0, viol = [], rejTp = 0, rejTpWrong = 0, rejAge = 0, rejAgeWrong = 0;
  const w = (k, i) => [...k.slice(Math.max(0, i - 999), i), { t: k[i].t, o: k[i].o, h: k[i].o, l: k[i].o, c: k[i].o, v: 0 }];
  for (let i = 450; i < 990; i++) {
    const bc = btcCtx(feat(w(B, i), 1e9));
    for (const k of syms) {
      const f = feat(w(k, i), k[i - 1].v * k[i - 1].c * 100, bc);
      if (!f.side) continue; raw++;
      const x = k.slice(0, i), seg = f.ev == null ? [] : x.slice(f.ev + 1), hi = Math.max(f.px, ...seg.map(q => q.h)), lo = Math.min(f.px, ...seg.map(q => q.l));
      const reached = f.ev != null && (f.side == 1 ? hi >= f.tp : lo <= f.tp);
      if (f.rej.includes('usang-tp-tercapai')) { rejTp++; if (!reached) rejTpWrong++; }
      if (f.rej.includes('usang-umur')) { rejAge++; if (!(f.age > CFG.maxAgeBreakout - 2)) rejAgeWrong++; }
      if (f.ok) {
        oks++;
        const e = [];
        if (reached) e.push('TP sudah tercapai');
        if (f.ev != null && f.age > (f.trig == 'bo' ? CFG.maxAgeBreakout : CFG.maxAge)) e.push('terlalu tua');
        if (f.dist > CFG.maxDistPct + 1e-9 || f.dist > CFG.maxDistR * f.slp + 1e-9) e.push('terlalu jauh');
        if (f.score < CFG.minScore) e.push('skor rendah');
        if (f.slAtr < CFG.slAtrMin - 1e-9) e.push('SL lebih ketat dari ATR');
        if (!(f.qv >= CFG.minQv)) e.push('likuiditas');
        if (bc && bc.tr == -f.side && bc.td == -f.side) e.push('melawan BTC');
        if (f.side * (f.tp - f.entry) <= 0 || f.side * (f.entry - f.sl) <= 0) e.push('urutan harga salah');
        if (Math.abs(f.tp - f.entry) / Math.abs(f.entry - f.sl) < 1.99) e.push('RR < 2');
        if (e.length) viol.push(`${i}: ${e.join(', ')}`);
      }
    }
  }
  console.log(`      (${raw} kandidat, ${oks} lolos, ${raw - oks} ditolak)`);
  ok(raw > 200 && oks > 30, 'cukup banyak kandidat dan setup lolos untuk diuji', `${raw}/${oks}`);
  ok(viol.length === 0, 'tidak ada setup lolos yang melanggar satu pun gerbang (oracle independen)', viol.slice(0, 3).join(' | '));
  ok(rejTp > 0 && rejTpWrong === 0, `semua penolakan usang-tp-tercapai benar menurut oracle (${rejTp} kasus)`);
  ok(oks < raw * 0.6, `gerbang menyaring cukup banyak kandidat (lolos ${(oks / raw * 100).toFixed(0)}%)`);
}

console.log('\n[6] Portofolio harian');
{
  const mkc = (s, side, score, dist = 1) => ({ s, side, score, dist, ok: true });
  const few = [mkc('A', 1, 90), mkc('B', 1, 80), mkc('C', 1, 70), mkc('D', 1, 65), mkc('E', -1, 61)];
  let p = selectPortfolio(few);
  ok(p.picked.map(x => x.s).join('') === 'ABCE' && p.dropped[0].r.s === 'D' && p.dropped[0].why === 'batas-portofolio', 'batas 3 per arah: skor tertinggi dipertahankan');
  const many = Array.from({ length: 12 }, (_, i) => mkc('L' + i, 1, 95 - i));
  p = selectPortfolio(many);
  ok(p.picked.length === CFG.clusterKeep && p.dropped.every(d => d.why === 'klaster-pasar'), '12 sinyal LONG serempak = satu taruhan pasar: hanya 2 teratas diambil');
  p = selectPortfolio([...Array.from({ length: 3 }, (_, i) => mkc('L' + i, 1, 90 - i)), ...Array.from({ length: 3 }, (_, i) => mkc('S' + i, -1, 90 - i)), mkc('X', 1, 61)]);
  ok(p.picked.length <= CFG.maxTotal, 'total sinyal per hari tidak melebihi batas');
  ok(selectPortfolio([{ s: 'Z', side: 1, score: 99, dist: 1, ok: false }]).picked.length === 0, 'setup yang tidak lolos gerbang tidak pernah dipilih');
  const tie = selectPortfolio([mkc('F', 1, 80, 3), mkc('G', 1, 80, 1)]);
  ok(tie.picked[0].s === 'G', 'skor sama: yang lebih dekat ke entry didahulukan');
}

console.log('\n[7] Validator sinyal dan jeda koin');
{
  const now = Date.now(), good = { aset: 'SOL', arah: 'LONG', entry: 100, sl: 95, tp: 110, harga_awal: 101, t: now, due: now + 7 * DAY };
  ok(validateSignal(good, { now }).ok, 'sinyal sehat lolos');
  ok(!validateSignal({ ...good, aset: '' }, { now }).ok, 'simbol kosong ditolak di pintu masuk');
  ok(!validateSignal({ ...good, aset: undefined }, { now }).ok, 'simbol tidak ada ditolak');
  ok(!validateSignal({ ...good, aset: 'so l' }, { now }).ok, 'simbol berformat salah ditolak');
  ok(!validateSignal({ ...good, t: undefined }, { now }).ok, 'waktu analisis tidak diketahui ditolak');
  ok(!validateSignal({ ...good, t: now + 3600e3 }, { now }).ok, 'waktu di masa depan ditolak');
  ok(!validateSignal({ ...good, sl: 105 }, { now }).ok, 'SL di sisi yang salah ditolak');
  ok(!validateSignal({ ...good, tp: 99 }, { now }).ok, 'TP di sisi yang salah ditolak');
  ok(!validateSignal({ ...good, entry: NaN }, { now }).ok, 'entry NaN ditolak');
  ok(!validateSignal({ ...good, sl: 80 }, { now }).ok, 'SL 20% ditolak (batas 15%)');
  ok(!validateSignal({ ...good, tp: 103 }, { now }).ok, 'RR di bawah 1.5 ditolak');
  ok(validateSignal({ aset: 'ETH', arah: 'SHORT', entry: 100, sl: 105, tp: 90, harga_awal: 99, t: now, due: now + DAY }, { now }).ok, 'SHORT sehat lolos');
  ok(!validateSignal({ ...good, entry: 140 }, { now }).ok, 'entry >25% dari harga acuan ditolak');
  const rows = [
    { agen: 'Aturan Eliz', aset: 'TRX', hasil: 'menunggu', t: now - DAY },
    { agen: 'Aturan Eliz', aset: 'UNI', hasil: 'SL', tx: now - DAY, t: now - 3 * DAY, due: now + DAY },
    { agen: 'Aturan Eliz', aset: 'NEAR', hasil: 'SL', tx: now - 5 * DAY, t: now - 9 * DAY, due: now - 2 * DAY },
    { agen: 'Gemini (eliz)', aset: 'ADA', hasil: 'menunggu', t: now },
  ];
  ok(activeBlock(rows, 'TRX', now) === 'duplikat-aktif', 'koin yang masih punya order aktif tidak dicatat lagi (tidak ada pengulangan harian)');
  ok(activeBlock(rows, 'UNI', now) === 'cooldown-sl', 'koin yang baru kena SL diberi jeda');
  ok(activeBlock(rows, 'NEAR', now) === null, 'jeda berakhir setelah beberapa hari');
  ok(activeBlock(rows, 'ADA', now) === null, 'baris agen AI tidak memblokir mesin');
  ok(activeBlock(rows, 'SOL', now) === null, 'koin tanpa riwayat tidak diblokir');
}

console.log('\n[8] Simulator: order yang tidak terisi dibatalkan saat harga lari ke TP');
{
  const K = (i, o, h, l, c) => ({ ot: i * H1, o, h, l, c, ct: i * H1 + H1 - 1 });
  const L = { arah: 'LONG', entry: 100, sl: 95, tp: 110, t: 0, due: 6 * H1 };
  const run = (r, ks) => gradeTrade({ ...L, ...r }, { h1: async () => ks, now: 1e15 });
  let g = await run({}, [K(0, 104, 105, 103, 104), K(1, 106, 112, 105, 111), K(2, 111, 112, 99, 100), K(3, 100, 101, 99, 100), K(4, 100, 101, 99, 100), K(5, 100, 101, 99, 100)]);
  ok(g.hasil === 'tidak terisi' && g.batal === true && g.R === 0 && g.t === 1 * H1, 'harga mencapai TP tanpa menyentuh entry: dibatalkan di candle itu (0R), bukan menunggu 7 hari dan terisi belakangan');
  g = await run({}, [K(0, 101, 111, 99.5, 108), K(1, 108, 112, 106, 111), K(2, 108, 109, 107, 108), K(3, 108, 109, 107, 108), K(4, 108, 109, 107, 108), K(5, 108, 109, 107, 108)]);
  ok(g.hasil === 'TP' || g.hasil === 'SL', 'candle yang menyentuh entry dan TP bersamaan tidak dianggap pembatalan');
  g = await run({ arah: 'SHORT', entry: 100, sl: 105, tp: 90 }, [K(0, 96, 97, 95, 96), K(1, 95, 96, 89, 90), K(2, 90, 101, 89, 100), K(3, 100, 101, 99, 100), K(4, 100, 101, 99, 100), K(5, 100, 101, 99, 100)]);
  ok(g.hasil === 'tidak terisi' && g.batal === true, 'SHORT: harga mencapai TP tanpa menyentuh entry: dibatalkan');
  g = await run({}, [K(0, 104, 105, 103, 104), K(1, 104, 105, 103, 104), K(2, 104, 105, 103, 104), K(3, 104, 105, 103, 104), K(4, 104, 105, 103, 104), K(5, 104, 105, 103, 104)]);
  ok(g.hasil === 'tidak terisi' && !g.batal && g.t === 6 * H1, 'tidak terisi biasa tetap berlaku sampai jatuh tempo (bukan pembatalan)');
}

console.log('\n[9] Proteksi risiko');
{
  const now = Date.UTC(2026, 9, 29, 12), mk = (h, R, dx) => ({ hasil: h, R, tx: now - dx * 3600e3 });
  ok(riskState([]).level === 'ok', 'tanpa riwayat: ok');
  let s = riskState([mk('SL', -1, 50), mk('SL', -1, 40), mk('SL', -1, 30)], now);
  ok(s.level === 'waspada' && s.riskMult === 0.5 && s.streak === 3, '3 SL berturut-turut: waspada, risiko dipotong setengah');
  s = riskState(Array.from({ length: 5 }, (_, i) => mk('SL', -1, 100 - i * 10)), now);
  ok(s.level === 'berhenti' && s.riskMult === 0, '5 SL berturut-turut: berhenti');
  s = riskState([mk('SL', -1, 50), mk('SL', -1, 40), mk('TP', 2, 30), mk('SL', -1, 20)], now);
  ok(s.streak === 1 && s.level === 'ok', 'TP memutus rentetan SL');
  s = riskState([...Array.from({ length: 4 }, (_, i) => mk('TP', 0.2, 200 - i)), ...Array.from({ length: 6 }, (_, i) => mk(i % 2 ? 'SL' : 'TP', i % 2 ? -1 : 0.2, 60 - i * 5))], now);
  ok(s.n === 10, 'hanya trade terisi dihitung');
  s = riskState([{ hasil: 'tidak terisi', R: 0, tx: now }, { hasil: 'menunggu', R: '', tx: now }], now);
  ok(s.n === 0 && s.level === 'ok', 'tidak terisi dan menunggu tidak dihitung');
  s = riskState([mk('SL', -1, 2), mk('SL', -1, 1), mk('TP', -0, 0.5), { hasil: 'SL', R: -1.2, tx: now - 0.2 * 3600e3 }], now);
  ok(s.dayR <= -3 + 1e-9 && s.level === 'berhenti', `rugi harian ${s.dayR.toFixed(1)}R: berhenti`);
  const z = sizePosition({ cap: 1000, riskPct: 1, entry: 100, sl: 95 });
  ok(Math.abs(z.usd - 10) < 1e-9 && Math.abs(z.qty - 2) < 1e-9 && Math.abs(z.lev - 0.2) < 1e-9 && !z.warn.length, 'ukuran posisi: risiko $10, qty 2, leverage 0.2x');
  ok(sizePosition({ cap: 1000, riskPct: 5, entry: 100, sl: 99 }).warn.length === 2, 'risiko 5% dan leverage tinggi sama-sama diberi peringatan');
  ok(portfolioHeat(10, 1).warn !== '' && portfolioHeat(2, 1).warn === '', 'panas portofolio: 10 sinyal x 1% = 10% diperingatkan');
}

console.log('\n[10] Gerbang uang nyata');
{
  ok(!readiness(null).layak, 'tanpa laporan: tidak layak');
  const base0 = { chain: { ok: true, n: 100 }, progress: { trade_terisi: [74, 150], minggu: [3, 20] }, ready: false };
  const r0 = readiness(base0);
  ok(!r0.layak && /BELUM LAYAK/.test(r0.headline), 'sampel belum cukup: BELUM LAYAK UANG NYATA');
  const good = { chain: { ok: true, n: 400 }, progress: { trade_terisi: [160, 150], minggu: [22, 20] }, ready: true, hasil: { strategi: { ci: { lo: 0.05, hi: 0.4 }, pf: 1.5, maxDD: 9 }, selisihVsMirror: { ci: { lo: 0.1, hi: 0.5 } } } };
  ok(readiness(good).layak, 'semua syarat terpenuhi: layak');
  ok(!readiness({ ...good, hasil: { ...good.hasil, strategi: { ...good.hasil.strategi, ci: { lo: -0.02, hi: 0.3 } } } }).layak, 'CI mencakup 0: tidak layak walau rata-rata positif');
  ok(!readiness({ ...good, hasil: { ...good.hasil, strategi: { ...good.hasil.strategi, maxDD: 22 } } }).layak, 'drawdown 22R: tidak layak');
  ok(!readiness({ ...good, chain: { ok: false, n: 3, errors: ['x'] } }).layak, 'jurnal diedit: tidak layak');
}

console.log('\n[11] Rantai hash lama tetap valid, baris baru menyegel skor');
{
  const rows = []; const old = { id: 'a', t: 1, due: 2, agen: 'Aturan Eliz', aset: 'BTC', arah: 'LONG', entry: 1, sl: 0.9, tp: 1.2, harga_awal: 1, alasan: 'x', alert: '', engine: 'E' };
  // baris gaya lama: disegel dengan daftar field lama (tanpa sv)
  const crypto = await import('node:crypto'); const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const SEAL = ['id', 't', 'due', 'agen', 'aset', 'arah', 'entry', 'sl', 'tp', 'harga_awal', 'alasan', 'alert', 'engine'];
  old.fwd = 1; old.seq = 1; old.prev = 'GENESIS'; old.h = sha(`GENESIS|1|${JSON.stringify(SEAL.map(k => old[k] ?? null))}`).slice(0, 20); rows.push(old);
  ok(verifyChain(rows).ok, 'baris gaya lama (tanpa sv) tetap lolos verifikasi');
  const nw = { ...old, id: 'b', t: 3, due: 4, trig: 'dev', score: 80, grade: 'A', age: 1 }; delete nw.h; delete nw.seq; delete nw.prev; delete nw.fwd;
  sealRow(nw, lastSealed(rows)); rows.push(nw);
  ok(verifyChain(rows).ok && nw.sv === 2, 'baris baru (sv=2) tersegel dan rantai campuran valid');
  const edit = fn => { const c = JSON.parse(JSON.stringify(rows)); fn(c); return verifyChain(c); };
  ok(!edit(c => (c[1].score = 99)).ok && !edit(c => (c[1].grade = 'B')).ok && !edit(c => (c[1].age = 0)).ok && !edit(c => (c[1].trig = 'mon')).ok, 'mengubah skor, grade, umur, atau pemicu terdeteksi');
  ok(!edit(c => (c[1].entry = 2)).ok, 'mengubah entry tetap terdeteksi');
  ok(!edit(c => { c[1].sv = 1; }).ok, 'menurunkan sv ke 1 untuk menghindari segel skor terdeteksi');
}

console.log(`\n${fail ? 'GAGAL' : 'SEMUA LULUS'}: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
