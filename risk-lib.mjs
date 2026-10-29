// Lapisan manajemen risiko di sisi pengguna. Fungsi murni (tanpa jaringan, tanpa DOM) supaya bisa diuji dan dipakai
// bersama oleh halaman jurnal dan script. TIDAK mengubah sinyal mesin, hanya memberi tahu kapan sebaiknya berhenti
// dan kapan hasil belum boleh dipercaya untuk uang nyata.
import { FILLED } from './scripts/backtest-lib.mjs';

export const RISK = {
  maxRiskPct: 2,        // risiko per trade di atas ini hampir pasti terlalu besar untuk mesin yang belum terbukti
  maxHeatPct: 3,        // total risiko semua sinyal aktif bersamaan (bila semuanya kena SL sekaligus)
  maxLeverage: 3,
  streakWarn: 3, streakStop: 5,   // SL berturut-turut
  last10Warn: -3, last10Stop: -6, // jumlah R dari 10 trade terisi terakhir
  dayStop: -3,                    // rugi harian (R) yang sudah terealisasi
};

// rows: baris jurnal (hasil, R, tx/due, arah). Hanya trade TERISI yang dihitung (TP/SL/kedaluwarsa).
export function riskState(rows, now = Date.now()) {
  const f = rows.filter(r => FILLED(r.hasil) && Number.isFinite(+r.R)).map(r => ({ h: r.hasil, R: +r.R, x: r.tx ?? r.due ?? r.t })).sort((a, b) => a.x - b.x);
  let streak = 0;
  for (let i = f.length - 1; i >= 0 && f[i].h === 'SL'; i--) streak++;
  const l10 = f.slice(-10), last10R = l10.reduce((a, b) => a + b.R, 0);
  const d0 = Math.floor(now / 864e5) * 864e5, dayR = f.filter(x => x.x >= d0).reduce((a, b) => a + b.R, 0);
  const why = [];
  let level = 'ok';
  const up = l => { if (l === 'berhenti' || (l === 'waspada' && level === 'ok')) level = l; };
  if (streak >= RISK.streakStop) { up('berhenti'); why.push(`${streak} SL berturut-turut`); } else if (streak >= RISK.streakWarn) { up('waspada'); why.push(`${streak} SL berturut-turut`); }
  if (l10.length >= 5 && last10R <= RISK.last10Stop) { up('berhenti'); why.push(`10 trade terakhir ${last10R.toFixed(1)}R`); } else if (l10.length >= 5 && last10R <= RISK.last10Warn) { up('waspada'); why.push(`10 trade terakhir ${last10R.toFixed(1)}R`); }
  if (dayR <= RISK.dayStop) { up('berhenti'); why.push(`rugi hari ini ${dayR.toFixed(1)}R`); }
  return { level, streak, last10R, dayR, n: f.length, why, riskMult: level === 'berhenti' ? 0 : level === 'waspada' ? 0.5 : 1 };
}

// Ukuran posisi dengan pagar: risiko per trade dibatasi, leverage dihitung dan diberi peringatan.
export function sizePosition({ cap, riskPct, entry, sl }) {
  const warn = [], rp = Math.min(Math.max(+riskPct || 0, 0), 100);
  if (rp > RISK.maxRiskPct) warn.push(`risiko ${rp}% per trade terlalu besar (batas wajar ${RISK.maxRiskPct}%)`);
  const risk = Math.abs(entry - sl), usd = (cap || 0) * rp / 100, qty = risk > 0 ? usd / risk : 0, notional = qty * entry, lev = cap ? notional / cap : 0;
  if (lev > RISK.maxLeverage) warn.push(`leverage efektif ${lev.toFixed(1)}x melebihi ${RISK.maxLeverage}x`);
  return { usd, qty, notional, lev, warn };
}

// Total risiko bila SEMUA sinyal aktif kena SL bersamaan. Altcoin bergerak serempak, jadi ini skenario nyata (14 dan 22 Okt: puluhan SL dalam sehari).
export function portfolioHeat(n, riskPct, mult = 1) {
  const pct = n * (+riskPct || 0) * mult, warn = pct > RISK.maxHeatPct ? `total risiko ${pct.toFixed(1)}% bila semua kena SL (batas ${RISK.maxHeatPct}%)` : '';
  return { pct, warn };
}

// Gerbang uang nyata. Memakai keluaran analyze() dari forward-lib. Jawaban default adalah TIDAK sampai semua syarat terbukti.
export function readiness(a) {
  if (!a) return { layak: false, items: [], headline: 'BELUM LAYAK UANG NYATA: hasil forward test belum tersedia.' };
  const items = [], add = (nama, ok, ket) => items.push({ nama, ok, ket });
  add('Integritas jurnal (rantai hash)', !!a.chain?.ok, a.chain?.ok ? `${a.chain.n} baris tersegel utuh` : 'ada baris yang diedit atau dihapus');
  const p = a.progress || { trade_terisi: [0, 150], minggu: [0, 20] };
  add(`Trade terisi >= ${p.trade_terisi[1]}`, p.trade_terisi[0] >= p.trade_terisi[1], `${p.trade_terisi[0]} dari ${p.trade_terisi[1]}`);
  add(`Minggu berbeda >= ${p.minggu[1]}`, p.minggu[0] >= p.minggu[1], `${p.minggu[0]} dari ${p.minggu[1]}`);
  const s = a.hasil?.strategi;
  if (a.ready && s) {
    add('Batas bawah CI 95% R/trade > 0 (setelah biaya)', !!(s.ci && s.ci.lo > 0), s.ci ? `[${s.ci.lo.toFixed(2)}, ${s.ci.hi.toFixed(2)}]` : 'n/a');
    add('Profit factor >= 1.2', Number.isFinite(s.pf) && s.pf >= 1.2, Number.isFinite(s.pf) ? s.pf.toFixed(2) : 'n/a');
    add('Max drawdown <= 15R', s.maxDD <= 15, `${s.maxDD.toFixed(1)}R`);
    const d = a.hasil.selisihVsMirror?.ci;
    add('Mengalahkan baseline MIRROR (arah dibalik)', !!(d && d.lo > 0), d ? `[${d.lo.toFixed(2)}, ${d.hi.toFixed(2)}]` : 'n/a');
  } else add('Kinerja setelah biaya', false, 'belum dinilai: syarat sampel belum terpenuhi (angka sengaja disembunyikan)');
  const layak = items.every(i => i.ok);
  const gagal = items.filter(i => !i.ok).map(i => i.nama);
  return { layak, items, headline: layak ? 'LULUS gerbang uang nyata. Tetap mulai dari ukuran kecil dan naikkan bertahap.' : `BELUM LAYAK UANG NYATA: ${gagal.length} syarat belum terpenuhi (${gagal.slice(0, 3).join('; ')}${gagal.length > 3 ? '; ...' : ''}).` };
}
