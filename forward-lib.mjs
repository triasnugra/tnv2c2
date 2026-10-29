// Forward test: bukti bahwa sinyal dicatat SEBELUM hasilnya diketahui, dengan aturan evaluasi
// yang ditetapkan di muka. Dipakai oleh scripts/jurnal.mjs (mencatat) dan scripts/forward.mjs (menilai).
//
// Yang dijamin, dan batasnya (dinyatakan jujur):
//  - Setiap baris baru disegel dengan rantai hash. Mengedit isi sinyal (entry/sl/tp/alasan/waktu/mesin)
//    atau menghapus baris di tengah akan terdeteksi. Menghapus baris TERAKHIR tidak terdeteksi oleh rantai
//    saja; karena itu hash ujung rantai dicetak ke ringkasan GitHub Actions (stempel waktu di luar repo).
//  - Hasil (hasil/R/tx) tidak disegel karena memang diisi belakangan. Kebenarannya dicek dengan
//    `node scripts/forward.mjs verify --regrade` (menilai ulang dari data Binance memakai trade-sim.mjs).
//  - Pemilik repo secara teknis bisa menghitung ulang seluruh rantai. Bukti waktu yang kuat adalah riwayat
//    commit GitHub dan hash ujung rantai di ringkasan Actions, bukan hash itu sendiri.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { summarize, bootCI, FILLED } from './scripts/backtest-lib.mjs';
import { CFG, ENGINE_VERSION } from './core.mjs';

export const PROTOCOL_FILE = 'data/forward-protocol.json';
export const MIN_SIGNALS = 150; // trade terisi (setelah deduplikasi) sebelum boleh dievaluasi
export const MIN_WEEKS = 20; // minggu berbeda yang berisi trade; ukuran sampel independen yang sebenarnya
export const RES = h => h === 'TP' || h === 'SL' || h === 'kedaluwarsa' || h === 'tidak terisi';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
export const engineHash = (...texts) => sha(texts.map(t => String(t).replace(/\r\n/g, '\n')).join('\u0000')).slice(0, 16);

// ---------- rantai hash ----------
const SEAL = ['id', 't', 'due', 'agen', 'aset', 'arah', 'entry', 'sl', 'tp', 'harga_awal', 'alasan', 'alert', 'engine'];
// v2: baris baru (sv=2) ikut menyegel pemicu, skor, grade, umur setup. Baris lama (tanpa sv) tetap diverifikasi dengan daftar lama,
// jadi rantai yang sudah ada tidak putus.
const SEAL2 = [...SEAL, 'trig', 'score', 'grade', 'age'];
const canon = r => JSON.stringify((r.sv === 2 ? SEAL2 : SEAL).map(k => (r[k] === undefined ? null : r[k])));
const link = (prev, seq, r) => sha(`${prev}|${seq}|${canon(r)}`).slice(0, 20);
export const lastSealed = rows => { let m = null; for (const r of rows) if (r.fwd && (!m || r.seq > m.seq)) m = r; return m; };
export function sealRow(row, prev) {
  row.fwd = 1; row.sv = 2; row.seq = (prev ? prev.seq : 0) + 1; row.prev = prev ? prev.h : 'GENESIS'; row.h = link(row.prev, row.seq, row);
  return row;
}
export function verifyChain(rows) {
  const f = rows.filter(r => r.fwd).sort((a, b) => a.seq - b.seq), errors = []; let prev = 'GENESIS';
  f.forEach((r, i) => {
    if (r.seq !== i + 1) errors.push(`seq ${r.seq} tidak berurutan (harapan ${i + 1}); ada baris yang dihapus atau disisipkan`);
    if (r.prev !== prev) errors.push(`baris ${r.id}: tautan ke baris sebelumnya putus`);
    if (r.h !== link(r.prev, r.seq, r)) errors.push(`baris ${r.id}: isi sinyal diubah setelah dicatat`);
    if (i && r.t < f[i - 1].t) errors.push(`baris ${r.id}: waktu lebih awal dari baris sebelumnya`);
    prev = r.h;
  });
  return { ok: !errors.length, n: f.length, head: f.length ? f.at(-1).h : null, errors };
}

// ---------- protokol ----------
export function makeProtocol(engine, now = Date.now()) {
  return {
    versi: 2, versi_mesin: ENGINE_VERSION, gerbang: { ...CFG }, mulai: new Date(now).toISOString(), mulai_ms: now, engine, agen: 'Aturan Eliz',
    aturan: { hold_hari: 7, maks_sl_persen: 15, satu_order_aktif_per_koin: true, batal_bila_tp_tanpa_isi: true, biaya: { fee_persen_per_sisi: 0.05, slip_persen: 0.05 }, baseline_tp_kelipatan_risiko: 2 },
    syarat_evaluasi: { min_trade_terisi: MIN_SIGNALS, min_minggu_berbeda: MIN_WEEKS },
    kriteria_lulus: 'Setelah KEDUA syarat evaluasi terpenuhi: batas bawah CI 95% (bootstrap per minggu) dari rata-rata R per trade terisi, setelah biaya, harus lebih dari 0. Selisih terhadap baseline MARKET per sinyal dilaporkan sebagai informasi nilai tambah logika, bukan syarat lulus.',
    larangan: [
      'Mengubah core.mjs atau trade-sim.mjs. Hash mesin berubah dan baris baru tidak dihitung; mulai protokol baru bila perlu (hapus file ini).',
      'Mengubah syarat evaluasi atau kriteria setelah protokol dimulai.',
      'Mengedit atau menghapus baris jurnal. Rantai hash akan menandainya.',
      'Menilai hasil sebelum syarat evaluasi terpenuhi. Angka sebelum itu hanya boleh dibaca sebagai kemajuan, bukan bukti.',
    ],
  };
}
export function ensureProtocol(engine, file = PROTOCOL_FILE, now = Date.now()) {
  if (fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, 'utf8')), created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const p = makeProtocol(engine, now);
  fs.writeFileSync(file, JSON.stringify(p, null, 1));
  return { ...p, created: true };
}

// ---------- analisis ----------
const costPct = P => 2 * P.aturan.biaya.fee_persen_per_sisi + P.aturan.biaya.slip_persen;
const netRow = (r, P) => ({ hasil: r.hasil, R: FILLED(r.hasil) ? r.R - costPct(P) / ((Math.abs(r.entry - r.sl) / r.entry) * 100) : 0, exitT: r.tx ?? r.due, t: r.t });
const baseRow = (r, b, P) => ({ hasil: b.h, R: FILLED(b.h) ? b.R - costPct(P) / ((Math.abs(r.entry - r.sl) / b.e) * 100) : 0, exitT: b.tx, t: r.t });

// Sinyal yang dihitung: baris tersegel, agen dan mesin sesuai protokol, sesudah tanggal mulai, lalu
// deduplikasi satu order aktif per koin (aturan yang sama dengan backtester). Order yang belum selesai
// memblokir sinyal berikutnya pada koin itu.
export function pickSignals(rows, P) {
  const base = rows.filter(r => r.fwd && r.agen === P.agen && r.t >= P.mulai_ms && (r.arah === 'LONG' || r.arah === 'SHORT') && r.hasil !== 'tidak valid' && r.hasil !== 'NO_TRADE');
  const same = base.filter(r => r.engine === P.engine).sort((a, b) => a.t - b.t);
  const other = base.length - same.length;
  if (!P.aturan.satu_order_aktif_per_koin) return { kept: same, other, skipped: 0 };
  const busy = new Map(), kept = []; let skipped = 0;
  for (const r of same) {
    if (r.t < (busy.get(r.aset) ?? 0)) { skipped++; continue; }
    kept.push(r); busy.set(r.aset, RES(r.hasil) ? (r.tx ?? r.due) : Infinity);
  }
  return { kept, other, skipped };
}

export function analyze(rows, P, { peek = false, B = 5000, seed = 1 } = {}) {
  const chain = verifyChain(rows), { kept, other, skipped } = pickSignals(rows, P);
  const done = kept.filter(r => RES(r.hasil)), pending = kept.length - done.length;
  const net = done.map(r => netRow(r, P)), S = summarize(net), C = bootCI(net, { B, seed });
  const need = P.syarat_evaluasi, weeks = C ? C.clusters : 0;
  const ready = S.filled >= need.min_trade_terisi && weeks >= need.min_minggu_berbeda;
  const out = {
    chain, protocol: { mulai: P.mulai, engine: P.engine, agen: P.agen }, ready, locked: !ready && !peek, peek: !ready && peek,
    counts: { tercatat_sesuai_protokol: kept.length, selesai: done.length, menunggu: pending, terisi: S.filled, minggu_berbeda: weeks, diabaikan_mesin_lain: other, dilewati_dedupe: skipped },
    progress: { trade_terisi: [S.filled, need.min_trade_terisi], minggu: [weeks, need.min_minggu_berbeda] },
  };
  if (!ready && !peek) return out; // gerbang evaluasi: angka kinerja disembunyikan
  const Cs = bootCI(net, { B, seed, all: true });
  const paired = f => {
    const rr = done.filter(r => r.bm && r.bi).map(r => ({ hasil: 'TP', R: netRow(r, P).R - f(r), t: r.t }));
    return { n: rr.length, ci: bootCI(rr, { B, seed }) };
  };
  const mkt = done.filter(r => r.bm).map(r => baseRow(r, r.bm, P)), mir = done.filter(r => r.bi).map(r => baseRow(r, r.bi, P));
  out.hasil = {
    strategi: { ...S, ci: C, ciPerSinyal: Cs },
    market: summarize(mkt), mirror: summarize(mir),
    selisihVsMarket: paired(r => baseRow(r, r.bm, P).R), selisihVsMirror: paired(r => baseRow(r, r.bi, P).R),
    perGrade: Object.fromEntries(['A', 'B'].map(g => [g, summarize(done.filter(r => r.grade === g).map(r => netRow(r, P)))])),
  };
  out.verdict = ready ? { pass: !!(C && C.lo > 0), why: C && C.lo > 0 ? 'batas bawah CI 95% R/trade di atas 0' : 'batas bawah CI 95% R/trade tidak di atas 0' } : { pass: null, why: 'INTIP: syarat evaluasi belum terpenuhi, hasil ini tidak sah sebagai uji' };
  return out;
}

const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(0) + '%' : '-');
const rr = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-');
const ci = c => (c ? `[${rr(c.lo)}, ${rr(c.hi)}]` : 'n/a');
export function renderForward(a) {
  const c = a.counts, p = a.progress;
  let md = `# Forward test CryptoEliz\n\n- Mulai: ${a.protocol.mulai} | agen: ${a.protocol.agen} | mesin terkunci: ${a.protocol.engine}\n`;
  md += `- Integritas jurnal: ${a.chain.ok ? `OK (${a.chain.n} baris tersegel, ujung rantai ${a.chain.head ?? '-'})` : 'BERMASALAH: ' + a.chain.errors.slice(0, 5).join('; ')}\n`;
  md += `- Tercatat sesuai protokol: ${c.tercatat_sesuai_protokol} (selesai ${c.selesai}, menunggu ${c.menunggu}, dilewati dedupe ${c.dilewati_dedupe}${c.diabaikan_mesin_lain ? `, DIABAIKAN karena mesin berubah: ${c.diabaikan_mesin_lain}` : ''})\n\n`;
  md += `## Kemajuan menuju evaluasi\n\n- Trade terisi: ${p.trade_terisi[0]} dari ${p.trade_terisi[1]}\n- Minggu berbeda: ${p.minggu[0]} dari ${p.minggu[1]}\n\n`;
  if (a.locked) {
    md += `**BELUM BOLEH DIEVALUASI.** Angka kinerja sengaja disembunyikan sampai kedua syarat terpenuhi. Melihat hasil di tengah jalan lalu mengubah aturan adalah cara paling umum untuk merusak uji ini.\n`;
    return md;
  }
  const h = a.hasil, s = h.strategi;
  if (a.peek) md += `> INTIP: syarat evaluasi belum terpenuhi. Angka di bawah TIDAK sah sebagai hasil uji.\n\n`;
  md += `## Hasil (R sudah dikurangi biaya)\n\n| Skenario | Sinyal | Terisi | Win% | R/trade | CI 95% R/trade | R/sinyal | Total R | MaxDD (R) |\n|---|---|---|---|---|---|---|---|---|\n`;
  const row = (n, x, k) => `| ${n} | ${x.signals} | ${x.filled} | ${pct(x.win)} | ${rr(x.mean)} | ${ci(k)} | ${rr(x.perSignal)} | ${rr(x.total)} | ${x.maxDD.toFixed(1)} |`;
  md += row('**Strategi (jurnal live)**', s, s.ci) + '\n' + row('Baseline MARKET (entry saat sinyal)', h.market, null) + '\n' + row('Baseline MIRROR (arah dibalik)', h.mirror, null) + '\n';
  const pg = Object.entries(h.perGrade || {}).filter(([, v]) => v.filled);
  if (pg.length) md += `\n| Grade kualitas | Terisi | Win% | R/trade | Total R |\n|---|---|---|---|---|\n` + pg.map(([g, v]) => `| ${g} | ${v.filled} | ${pct(v.win)} | ${rr(v.mean)} | ${rr(v.total)} |`).join('\n') + '\n';
  md += `\nCI 95% strategi per sinyal (tidak terisi = 0R): ${ci(s.ciPerSinyal)}\nSelisih per sinyal vs MARKET: ${ci(h.selisihVsMarket.ci)} (n=${h.selisihVsMarket.n}); vs MIRROR: ${ci(h.selisihVsMirror.ci)} (n=${h.selisihVsMirror.n})\n`;
  md += `\n**Keputusan: ${a.verdict.pass === null ? 'TIDAK SAH (intip)' : a.verdict.pass ? 'LULUS' : 'TIDAK LULUS'}** (${a.verdict.why}).\n`;
  if (a.verdict.pass) md += `\nLulus berarti ada bukti awal bahwa mesin menguntungkan setelah biaya pada data yang tidak bisa dicemari. Ini belum jaminan: pasar bisa berubah, dan sampelnya masih terbatas. Naikkan ukuran posisi bertahap, bukan sekaligus.\n`;
  else if (a.verdict.pass === false) md += `\nTidak lulus berarti tidak ada bukti edge pada uji yang bersih. Itu hasil yang sah. Jangan mengubah mesin lalu menghitung ulang di data yang sama; mulai protokol baru dengan hipotesis baru.\n`;
  return md;
}
