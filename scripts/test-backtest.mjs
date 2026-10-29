// Uji otomatis:  node scripts/test-backtest.mjs
// 1) aturan penilaian trade (kasus dihitung manual), 2) statistik, 3) anti look-ahead,
// 4) pipeline end-to-end memakai server Binance palsu (random walk), tanpa jaringan.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { feat, scanInput } from '../core.mjs';
import { gradeTrade, H1 } from '../trade-sim.mjs';
import { summarize, bootCI, mulberry32 } from './backtest-lib.mjs';
import { runBacktest, buildReport, writeOutputs, DEFAULTS, win } from './backtest.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  GAGAL', name, extra); } };
const eq = (a, b, name) => ok(Math.abs(a - b) < 1e-9, name, `(dapat ${a}, harapan ${b})`);
const K = (i, o, h, l, c) => ({ ot: i * H1, o, h, l, c, ct: i * H1 + H1 - 1 });
const L = { arah: 'LONG', entry: 100, sl: 95, tp: 110, t: 0, due: 6 * H1 };
const run = (r, ks, m1, now = 1e15) => gradeTrade({ ...L, ...r }, { h1: async () => ks, m1, now });
const flat = i => K(i, 102, 103, 101, 102); // candle netral di atas entry

console.log('\n[1] Aturan penilaian trade');
{
  let g = await run({}, [K(0, 100, 102, 99.5, 101), K(1, 101, 111, 100.5, 110), flat(2), flat(3), flat(4), flat(5)]);
  ok(g.hasil === 'TP', 'fill di open lalu TP'); eq(g.R, 2, 'R TP = +2');

  g = await run({}, [K(0, 101, 102, 94, 96), flat(1), flat(2), flat(3), flat(4), flat(5)]);
  ok(g.hasil === 'SL', 'candle pengisi yang menyentuh SL dihitung SL (bug lama melewatkannya)'); eq(g.R, -1, 'R SL = -1');

  g = await run({}, [K(0, 101, 111, 99.5, 108), K(1, 108, 112, 106, 111), flat(2), flat(3), flat(4), flat(5)]);
  ok(g.hasil === 'TP' && g.t === 1 * H1, 'TP di candle pengisi (bukan di open) tidak dihitung, TP baru di candle berikutnya');

  const amb = [K(0, 100, 101, 99.5, 100), K(1, 100, 111, 94, 100), flat(2), flat(3), flat(4), flat(5)];
  g = await run({}, amb);
  ok(g.hasil === 'SL', 'SL dan TP sama-sama kena dalam 1H tanpa data 1 menit: SL didahulukan');
  const mk = (a, b) => ({ ot: 1 * H1, o: 100, h: a, l: b, c: 100, ct: 1 * H1 + 59999 });
  g = await run({}, amb, async () => [mk(111, 100), { ...mk(100, 94), ot: H1 + 6e4 }]);
  ok(g.hasil === 'TP', 'data 1 menit menunjukkan TP lebih dulu: dihitung TP');
  g = await run({}, amb, async () => [mk(101, 94), { ...mk(111, 100), ot: H1 + 6e4 }]);
  ok(g.hasil === 'SL', 'data 1 menit menunjukkan SL lebih dulu: dihitung SL');

  g = await run({ entry: 100 }, [K(0, 105, 106, 103, 104), K(1, 105, 106, 103, 104), K(2, 105, 106, 103, 104), K(3, 105, 106, 103, 104), K(4, 105, 106, 103, 104), K(5, 105, 106, 103, 104)]);
  ok(g.hasil === 'tidak terisi' && g.R === 0, 'tidak pernah menyentuh entry: tidak terisi, 0R');

  g = await run({}, [K(0, 100, 102, 99.5, 101), flat(1), flat(2), flat(3), flat(4), K(5, 102, 103, 101, 102)]);
  ok(g.hasil === 'kedaluwarsa', 'habis waktu setelah terisi: kedaluwarsa'); eq(g.R, (102 - 100) / 5, 'R kedaluwarsa = (close - entry)/risiko');

  g = await run({ t: 30 * 6e4 }, [K(0, 100, 101, 94, 99), flat(1), flat(2), flat(3), flat(4), flat(5)]);
  ok(g.hasil !== 'SL', 'candle yang memuat waktu sinyal (low 94 terjadi SEBELUM sinyal) tidak dipakai tanpa data 1 menit');
  const early = [{ ot: 10 * 6e4, o: 100, h: 101, l: 94, c: 99, ct: 10 * 6e4 + 59999 }, { ot: 40 * 6e4, o: 100, h: 101, l: 99.5, c: 100, ct: 40 * 6e4 + 59999 }];
  g = await run({ t: 30 * 6e4 }, [K(0, 100, 101, 94, 99), flat(1), flat(2), flat(3), flat(4), flat(5)], async () => early);
  ok(g.hasil !== 'SL', 'dengan data 1 menit: hanya menit setelah sinyal yang dipakai');

  g = await run({ arah: 'SHORT', entry: 100, sl: 105, tp: 90 }, [K(0, 100, 100.5, 99, 99.5), K(1, 99, 99.5, 89, 90), flat(2), flat(3), flat(4), flat(5)]);
  ok(g.hasil === 'TP', 'SHORT: fill di open lalu TP'); eq(g.R, 2, 'R SHORT TP = +2');

  g = await run({}, [K(0, 100, 102, 99.5, 101), flat(1)], undefined, 2 * H1);
  ok(g === null, 'belum jatuh tempo dan belum kena: masih menunggu (null)');
}

console.log('\n[2] Statistik');
{
  const rows = [{ hasil: 'TP', R: 2, exitT: 1, t: 0 }, { hasil: 'SL', R: -1, exitT: 2, t: 0 }, { hasil: 'SL', R: -1, exitT: 3, t: 0 }, { hasil: 'tidak terisi', R: 0, exitT: 4, t: 0 }];
  const s = summarize(rows);
  ok(s.signals === 4 && s.filled === 3, 'ringkasan: jumlah sinyal dan terisi'); eq(s.mean, 0, 'rata-rata R'); eq(s.win, 1 / 3, 'win rate = TP/(TP+SL)'); eq(s.maxDD, 2, 'max drawdown (R)'); eq(s.pf, 1, 'profit factor');
  const W = 7 * 864e5, mkRows = f => Array.from({ length: 300 }, (_, i) => ({ hasil: 'TP', R: f(i), t: 4 * 864e5 + Math.floor(i / 3) * W })); // 100 minggu
  const c1 = bootCI(mkRows(() => 1), { B: 500 });
  ok(c1.lo === 1 && c1.hi === 1, 'bootstrap: data konstan menghasilkan CI sempit');
  const r = mulberry32(7), noise = Array.from({ length: 300 }, () => (r() < 0.5 ? -1 : 1));
  const c2 = bootCI(mkRows(i => noise[i]), { B: 2000 });
  ok(c2.lo < 0 && c2.hi > 0, 'bootstrap: data tanpa edge menghasilkan CI yang mencakup 0', JSON.stringify(c2));
  const a = bootCI(mkRows(i => noise[i]), { B: 500, seed: 3 }), b = bootCI(mkRows(i => noise[i]), { B: 500, seed: 3 });
  ok(a.lo === b.lo && a.hi === b.hi, 'bootstrap deterministik untuk seed yang sama');
  ok(bootCI([{ hasil: 'TP', R: 1, t: 0 }]) === null, 'bootstrap menolak data satu blok');
  const sg = summarize([{ hasil: 'TP', R: 2, exitT: 1, t: 0 }, { hasil: 'tidak terisi', R: 0, exitT: 2, t: 0 }, { hasil: 'tidak terisi', R: 0, exitT: 3, t: 0 }, { hasil: 'SL', R: -1, exitT: 4, t: 0 }]);
  eq(sg.mean, 0.5, 'R/trade dihitung hanya dari trade terisi'); eq(sg.perSignal, 0.25, 'R/sinyal dibagi SEMUA sinyal (tidak terisi = 0R)');
  const mixed = Array.from({ length: 200 }, (_, i) => ({ hasil: i % 2 ? 'TP' : 'tidak terisi', R: i % 2 ? 1 : 0, t: 4 * 864e5 + Math.floor(i / 2) * 7 * 864e5 }));
  const cf = bootCI(mixed, { B: 300 }), ca = bootCI(mixed, { B: 300, all: true });
  ok(cf.lo === 1 && ca.hi < 0.6 && ca.lo > 0.4, 'bootCI all:true memasukkan trade tidak terisi (rata-rata 0.5), default tidak (rata-rata 1)', JSON.stringify([cf, ca]));
  // sinyal sehari penuh berkorelasi: 50 trade di 1 minggu tidak boleh memberi CI sempit palsu
  const oneWeek = Array.from({ length: 50 }, (_, i) => ({ hasil: i % 2 ? 'TP' : 'SL', R: i % 2 ? 1 : -1, t: 4 * 864e5 }));
  ok(bootCI(oneWeek.concat(mkRows(() => 0).slice(0, 3))) !== undefined, 'bootstrap tetap berjalan pada data sangat terkelompok');
}

console.log('\n[2b] Laporan: adverse selection');
{
  // 100 sinyal di 100 minggu berbeda. 50 limit terisi dan kalah (-0.5R); 50 tidak terisi karena harga lari menjauh
  // (nilainya 0R), padahal entry market di sinyal yang sama akan untung +1.5R. Strategi TIDAK boleh dinyatakan lebih baik.
  const T = Array.from({ length: 100 }, (_, i) => {
    const t = Date.UTC(2024, 0, 1) + i * 7 * 864e5, filled = i % 2 === 0;
    return { sym: 'ETH', date: new Date(t).toISOString().slice(0, 10), t, s: 1, side: 'LONG', trig: 'dev', tr: 1, btcTr: 1, type: 'swing',
      hasil: filled ? 'SL' : 'tidak terisi', R: filled ? -0.5 : 0, exitT: t + 864e5,
      mirHasil: 'SL', mirR: -0.3, mirExit: t + 864e5, mktHasil: filled ? 'SL' : 'TP', mktR: filled ? -0.5 : 1.5, mktExit: t + 864e5 };
  });
  const rep = buildReport(T, { ...DEFAULTS, boot: 500 }, { used: 1, universe: 1, skipped: [], immature: 0 });
  ok(rep.summary.diffVsMarket.hi < 0, 'selisih per sinyal vs MARKET negatif (strategi kalah)', JSON.stringify(rep.summary.diffVsMarket));
  ok(!/lebih baik dari MARKET per sinyal/.test(rep.md) && /LEBIH BURUK dari MARKET/.test(rep.md), 'kesimpulan otomatis tidak menyatakan strategi lebih baik dari MARKET');
  ok(/adverse selection/i.test(rep.md), 'laporan memuat peringatan adverse selection');
}

console.log('\n[3] Anti look-ahead');
{
  const rnd = mulberry32(11), mk = n => { let p = 100; const t0 = Date.UTC(2023, 0, 2); return Array.from({ length: n }, (_, i) => { const o = p, c = p * (1 + (rnd() - 0.5) * 0.06); p = c; return { t: t0 + i * 864e5, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1e6 }; }); };
  const A = mk(700);
  const sig = f => JSON.stringify([f.side, f.entry, f.sl, f.tp, f.trig, f.tr, f.pos]);
  let same = 0, tot = 0, sigs = 0;
  for (let i = 450; i < 600; i += 2) {
    // B identik dengan A sampai open hari i; high/low/close hari i dan SEMUA hari sesudahnya diubah drastis
    const B = A.map((x, j) => (j < i ? x : j === i ? { ...x, h: x.h * 3, l: x.l * 0.3, c: x.c * 2 } : { ...x, o: x.o * 2, h: x.h * 3, l: x.l * 0.3, c: x.c * 2 }));
    const fa = feat(win(A, i), 1), fb = feat(win(B, i), 1);
    tot++; if (sig(fa) === sig(fb)) same++; if (fa.side) sigs++;
  }
  ok(same === tot, `sinyal hari i tidak berubah walau high/low/close hari i dan masa depan diubah drastis (${same}/${tot} hari, ${sigs} di antaranya bersinyal)`);
  const fh = feat(win(A, 500), 1);
  ok(win(A, 500).at(-1).h === A[500].o && win(A, 500).at(-1).c === A[500].o, 'candle berjalan sintetis hanya berisi harga open');
  ok(fh.px === A[500].o, 'harga acuan feat = open hari i');
}

console.log('\n[4] Pipeline end-to-end (server Binance palsu)');
{
  const NOW = Date.now(), SY = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'LINK', 'AVAX'];
  const hourly = {}, daily = {};
  const startDay = Math.floor(NOW / 864e5) * 864e5 - 1700 * 864e5, endH = Math.floor(NOW / H1) * H1;
  SY.forEach((s, si) => {
    const rnd = mulberry32(100 + si); let p = 100 + si * 10; const hs = [];
    for (let t = startDay; t <= endH; t += H1) {
      const ph = (t - startDay) / H1, trend = 0, o = p, c = p * (1 + trend + (rnd() - 0.5) * 0.012);
      p = c; hs.push([t, o, Math.max(o, c) * (1 + rnd() * 0.004), Math.min(o, c) * (1 - rnd() * 0.004), c, (50 + rnd() * 50) * 500, t + H1 - 1]);
    }
    hourly[s] = hs;
    const d = new Map();
    for (const h of hs) { const k = Math.floor(h[0] / 864e5) * 864e5, x = d.get(k); if (!x) d.set(k, [k, h[1], h[2], h[3], h[4], h[5], k + 864e5 - 1]); else { x[2] = Math.max(x[2], h[2]); x[3] = Math.min(x[3], h[3]); x[4] = h[4]; x[5] += h[5]; } }
    daily[s] = [...d.values()];
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const u = new URL(url), j = v => ({ ok: true, json: async () => v });
    if (u.pathname.endsWith('/ticker/24hr')) return j(SY.map((s, i) => ({ symbol: s + 'USDT', quoteVolume: String(1e9 - i * 1e7) })).concat([{ symbol: 'USDCUSDT', quoteVolume: '9e12' }]));
    if (u.pathname.endsWith('/klines')) {
      const sym = u.searchParams.get('symbol').replace('USDT', ''), iv = u.searchParams.get('interval');
      const src = iv === '1d' ? daily[sym] : iv === '1h' ? hourly[sym] : null;
      if (!src) return { ok: false, status: 400, json: async () => ({}) };
      const st = +(u.searchParams.get('startTime') || 0), en = +(u.searchParams.get('endTime') || 9e15), lim = +(u.searchParams.get('limit') || 500);
      return j(src.filter(r => r[0] >= st && r[0] <= en).slice(0, lim).map(r => [...r, 0, 0, 0, 0, 0]));
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
  const o = { ...DEFAULTS, top: 8, days: 1500, warmup: 400, boot: 500, out: path.join(tmp, 'out'), cache: path.join(tmp, 'cache') };
  const t0 = Date.now();
  const { trades, meta } = await runBacktest(o);
  console.log(`      (${trades.length} sinyal, ${meta.used} koin, ${((Date.now() - t0) / 1000).toFixed(1)} dtk)`);
  ok(meta.used >= 6, 'koin stablecoin tersaring dan koin lain terpakai', JSON.stringify(meta));
  ok(trades.length > 20, 'menghasilkan sinyal yang cukup untuk diuji', String(trades.length));
  ok(trades.every(x => Number.isFinite(x.R) && Number.isFinite(x.mirR) && Number.isFinite(x.mktR)), 'semua R bernilai angka');
  ok(trades.every(x => x.t + o.hold * 864e5 <= NOW), 'tidak ada trade yang belum jatuh tempo');
  ok(trades.every(x => x.t === Math.floor(x.t / 864e5) * 864e5), 'sinyal berlabel tepat 00:00 UTC');
  ok(trades.every(x => x.hasil !== 'tidak terisi' || x.R === 0), 'trade tidak terisi bernilai 0R tanpa biaya');
  const gotSides = new Set(trades.map(x => x.side));
  ok(gotSides.size === 2, 'ada sinyal LONG dan SHORT');
  // dedupe: tidak ada dua order aktif tumpang tindih pada koin yang sama
  let overlap = 0; const by = new Map(); trades.forEach(x => { if (!by.has(x.sym)) by.set(x.sym, []); by.get(x.sym).push(x); });
  for (const v of by.values()) for (let i = 1; i < v.length; i++) if (v[i].t < v[i - 1].exitT) overlap++;
  ok(overlap === 0, 'dedupe: satu order aktif per koin');
  const S = summarize(trades);
  ok(Number.isFinite(S.mean) && S.mean < 0.35 && S.mean > -0.6, `random walk TANPA tren tidak menghasilkan rata-rata R fantastis (${S.mean.toFixed(3)}R)`);
  const rep = buildReport(trades, o, meta); writeOutputs(trades, rep, o);
  ok(['report.md', 'trades.csv', 'equity.csv', 'summary.json'].every(f => fs.existsSync(path.join(o.out, f))), 'keempat file keluaran tertulis');
  ok(/Per pemicu/.test(rep.md) && /Baseline MIRROR/.test(rep.md) && /Bonferroni/.test(rep.md), 'laporan memuat baseline dan tabel grup berkoreksi Bonferroni');
  const csv = fs.readFileSync(path.join(o.out, 'trades.csv'), 'utf8').split('\n');
  ok(csv.length === trades.length + 1 && csv.every(l => l.split(',').length === csv[0].split(',').length), 'CSV rapi (jumlah kolom konsisten)');
  const again = await runBacktest(o); // jalan kedua memakai cache
  ok(JSON.stringify(buildReport(again.trades, o, again.meta).summary.overall) === JSON.stringify(rep.summary.overall), 'hasil identik pada jalan kedua (cache + deterministik)');
  // varian entry / TP
  const rm = await runBacktest({ ...o, entry: 'market', tpMult: 2, fetchHold: 7, out: path.join(tmp, 'o2') });
  ok(rm.trades.length > 20, 'varian market + TP 2R menghasilkan sinyal');
  ok(rm.trades.every(x => x.hasil !== 'tidak terisi'), 'entry market selalu terisi');
  ok(rm.trades.some(x => x.hasil === 'TP') && rm.trades.filter(x => x.hasil === 'TP').every(x => Math.abs(x.Rg - 2) < 1e-6), 'TP tetap 2R: R kotor trade TP = 2');
  const r3 = await runBacktest({ ...o, tpMult: 3 });
  ok(r3.trades.some(x => x.hasil === 'TP') && r3.trades.filter(x => x.hasil === 'TP').every(x => Math.abs(x.Rg - 3) < 1e-6), 'TP 3R pada order limit: R kotor trade TP = 3');
  const splitD = new Date(NOW - 500 * 864e5).toISOString().slice(0, 10);
  const rep2 = buildReport(trades, { ...o, split: splitD }, meta);
  ok(/UJI TERKUNCI/.test(rep2.md), 'laporan memuat bagian uji terkunci');
  // riset
  const { runResearch, renderResearch } = await import('./research.mjs');
  const rs = await runResearch({ ...o, boot: 300 }, { grid: [{ entry: 'limit', tpMult: 2, hold: 7 }, { entry: 'market', tpMult: 2, hold: 3 }], split: splitD });
  ok(rs.results.length === 2, 'riset menjalankan semua varian di kisi');
  ok(rs.results.every(r => r.train.s.filled > 0 && r.test.s.filled > 0), 'kedua periode (pengembangan dan terkunci) berisi trade');
  ok(/Hasil: (LULUS|TIDAK LULUS)/.test(renderResearch(rs, o)) || /Tidak ada varian/.test(renderResearch(rs, o)), 'laporan riset memuat keputusan');
  globalThis.fetch = realFetch;
  fs.writeFileSync('/tmp/sample-report.md', rep.md);
}

console.log('\n[5b] Jalur live = jalur backtest');
{
  const rnd = mulberry32(21), t0 = Date.UTC(2023, 0, 2), N = 800;
  let p = 100; const A = Array.from({ length: N }, (_, i) => { const o = p, c = p * (1 + (rnd() - 0.5) * 0.05); p = c; return { t: t0 + i * 864e5, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c, v: 1e5 + rnd() * 1e5 }; });
  const iF = N - 1, now = A[iF].t + 3 * 36e5; // live: scan jam 03 UTC, candle terakhir sedang berjalan
  const sc = scanInput(A, now), bt = win(A, iF), qvBT = A[iF - 1].v * A[iF - 1].c;
  ok(sc.qv === qvBT, 'volume dolar: live = volume x close kemarin (bukan volume 24 jam bergulir)');
  ok(JSON.stringify(sc.bars) === JSON.stringify(bt), 'input feat identik dengan backtest (999 candle tutup + open hari ini)');
  const fl = feat(sc.bars, sc.qv), fb = feat(bt, qvBT);
  const keys = ['side', 'entry', 'sl', 'tp', 'px', 'trig', 'tr', 'pos', 'type', 'slp', 'qv'];
  ok(keys.every(k => JSON.stringify(fl[k]) === JSON.stringify(fb[k])), 'hasil feat live dan backtest identik pada semua field', JSON.stringify(keys.map(k => [k, fl[k], fb[k]])));
  ok(fl.px === A[iF].o, 'harga acuan = open hari ini, tidak bergantung pada jam scan');
  const sc2 = scanInput(A, A[iF].t + 23 * 36e5);
  ok(JSON.stringify(sc2.bars) === JSON.stringify(sc.bars), 'jam scan 03 dan 23 UTC menghasilkan input yang sama');
  let thrown = false; try { scanInput(A.slice(0, -1), now); } catch { thrown = true; }
  ok(thrown, 'tanpa candle hari ini (tidak ada open untuk diacu): koin DILEWATI, tidak ditebak');
  thrown = false; try { scanInput([], now); } catch { thrown = true; }
  ok(thrown, 'kline kosong ditolak');
}

console.log('\n[5] Seleksi varian (anti data snooping)');
{
  const { chooseVariant, verdict } = await import('./research.mjs');
  const mk = (name, trLo, trMean, trN, teLo, teMean, teN) => ({ name, train: { s: { filled: trN, mean: trMean }, ci: { lo: trLo, hi: trLo + 0.2 } }, test: { s: { filled: teN, mean: teMean }, ci: { lo: teLo, hi: teLo + 0.2 } } });
  const R = [mk('A', -0.05, 0.02, 500, 0.4, 0.5, 300), mk('B', 0.01, 0.1, 500, -0.3, -0.2, 300), mk('C', 0.2, 0.3, 100, 0.5, 0.6, 300)];
  const ch = chooseVariant(R);
  ok(ch.name === 'B', 'seleksi hanya memakai data pengembangan: A (terbaik di data terkunci) tidak dipilih, C ditolak karena sampel kecil', ch && ch.name);
  ok(!verdict(ch).pass, 'varian terpilih yang gagal di data terkunci dinyatakan TIDAK LULUS');
  ok(verdict(mk('D', 0.05, 0.1, 500, 0.02, 0.1, 300)).pass, 'lulus bila semua syarat terpenuhi');
  ok(!verdict(mk('E', 0.05, 0.1, 500, 0.02, 0.1, 50)).pass, 'tidak lulus bila sampel terkunci terlalu kecil');
  ok(!verdict(mk('F', 0.05, -0.01, 500, 0.5, 0.5, 300)).pass, 'tidak lulus bila R/trade pengembangan tidak positif');
  ok(!verdict(null).pass && chooseVariant([mk('G', 0.1, 0.2, 10, 0.1, 0.2, 300)]) === null, 'tanpa sampel pengembangan cukup: tidak ada pilihan');
}

console.log(`\n${fail ? 'GAGAL' : 'SEMUA LULUS'}: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
