#!/usr/bin/env node
// Riset terstruktur: apakah ada varian yang layak, diuji TANPA menipu diri sendiri.
//
// Aturan main (ditetapkan SEBELUM melihat hasil, dan sengaja ditulis di kode):
//  1. Kisi varian di bawah ini tetap. Menambah atau mengganti varian setelah melihat laporan
//     membatalkan uji terkunci (data sudah "terpakai").
//  2. Pemilihan varian HANYA memakai sinyal sebelum tanggal --split (data pengembangan):
//     varian dengan batas bawah CI 95% R/trade tertinggi, minimal MIN_TRAIN trade.
//  3. Varian terpilih dievaluasi SEKALI pada data terkunci (sejak --split).
//     LULUS bila: R/trade pengembangan > 0, batas bawah CI 95% data terkunci > 0,
//     dan minimal MIN_TEST trade terisi.
//  4. Varian lain di data terkunci hanya ditampilkan untuk transparansi, TIDAK boleh dipakai memilih.
//
// Pakai:  node scripts/research.mjs [--split 2025-07-01] [opsi backtest lain, mis. --top 40]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBacktest, DEFAULTS, parseArgs } from './backtest.mjs';
import { summarize, bootCI } from './backtest-lib.mjs';

export const SPLIT_DEFAULT = '2025-07-01';
export const MIN_TRAIN = 300, MIN_TEST = 200;
export const GRID = [];
for (const entry of ['limit', 'market']) for (const tpMult of [null, 1.5, 2, 3]) for (const hold of [3, 7]) GRID.push({ entry, tpMult, hold });
export const nameOf = v => `${v.entry}, TP ${v.tpMult ? v.tpMult + 'R' : 'engine'}, ${v.hold} hari`;

const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(0) + '%' : '-');
const rr = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-');
const ci = c => (c ? `[${rr(c.lo)}, ${rr(c.hi)}]` : 'n/a');

// Hanya membaca field `train`. Data terkunci tidak boleh memengaruhi pilihan.
export function chooseVariant(results, minN = MIN_TRAIN) {
  const ok = results.filter(r => r.train.s.filled >= minN && r.train.ci);
  ok.sort((a, b) => b.train.ci.lo - a.train.ci.lo);
  return ok[0] || null;
}
export function verdict(r, minTest = MIN_TEST) {
  if (!r) return { pass: false, why: 'tidak ada varian dengan sampel pengembangan cukup' };
  if (!(r.train.s.mean > 0)) return { pass: false, why: 'R/trade data pengembangan tidak positif' };
  if (r.test.s.filled < minTest) return { pass: false, why: `data terkunci hanya ${r.test.s.filled} trade terisi (minimal ${minTest})` };
  if (!r.test.ci || !(r.test.ci.lo > 0)) return { pass: false, why: 'batas bawah CI 95% data terkunci tidak di atas 0' };
  return { pass: true, why: 'lolos semua syarat' };
}

export async function runResearch(base, { grid = GRID, split = SPLIT_DEFAULT } = {}, log = () => {}) {
  const T0 = Date.parse(split), fetchHold = Math.max(...grid.map(v => v.hold));
  const results = [];
  for (const v of grid) {
    log(`varian: ${nameOf(v)}`);
    const o = { ...base, ...v, split: null, fetchHold };
    const { trades, meta } = await runBacktest(o, () => {});
    const part = rows => ({ s: summarize(rows), ci: bootCI(rows, { B: base.boot, seed: base.seed }) });
    results.push({ v, name: nameOf(v), meta, train: part(trades.filter(x => x.t < T0)), test: part(trades.filter(x => x.t >= T0)) });
  }
  const chosen = chooseVariant(results), vd = verdict(chosen);
  return { results, chosen, vd, split };
}

export function renderResearch({ results, chosen, vd, split }, base) {
  const row = r => `| ${r.name} | ${r.train.s.filled} | ${rr(r.train.s.mean)} | ${ci(r.train.ci)} | ${r.test.s.filled} | ${rr(r.test.s.mean)} | ${ci(r.test.ci)} |${chosen && r === chosen ? ' DIPILIH' : ''}`;
  let md = `# Riset varian (seleksi jujur)\n\n`;
  md += `- Pembagian: pengembangan = sinyal sebelum ${split}; UJI TERKUNCI = sejak ${split}\n- Jumlah varian diuji: ${results.length} (semua ditampilkan, tidak ada yang disembunyikan)\n- Biaya ${base.fee}%/sisi + slip ${base.slip}%, SL maks ${base.maxsl}%\n\n`;
  md += `## Keputusan\n\n`;
  if (!chosen) md += `Tidak ada varian dengan minimal ${MIN_TRAIN} trade pada data pengembangan.\n`;
  else {
    md += `Varian terpilih HANYA dari data pengembangan: **${chosen.name}**\n\n`;
    md += `- Pengembangan: ${chosen.train.s.filled} trade, R/trade ${rr(chosen.train.s.mean)}, CI 95% ${ci(chosen.train.ci)}\n`;
    md += `- Uji terkunci: ${chosen.test.s.filled} trade, R/trade ${rr(chosen.test.s.mean)}, CI 95% ${ci(chosen.test.ci)}\n\n`;
    md += `**Hasil: ${vd.pass ? 'LULUS' : 'TIDAK LULUS'}** (${vd.why}).\n\n`;
    md += vd.pass
      ? `Lulus berarti varian ini layak masuk tahap forward test di jurnal live. Ini BUKAN izin memakai uang besar: data terkunci hanya sebagian bersih karena hasil agregat periode ini pernah dilihat.\n`
      : `Tidak lulus berarti tidak ada bukti bahwa perubahan ini memperbaiki mesin. Itu hasil yang sah. Jangan menambah varian baru lalu menjalankan ulang sampai ada yang lulus; itu membuat uji terkunci tidak berlaku lagi.\n`;
  }
  md += `\n## Semua varian\n\n| Varian | Trade (pengembangan) | R/trade | CI 95% | Trade (terkunci) | R/trade | CI 95% | |\n|---|---|---|---|---|---|---|---|\n`;
  md += [...results].sort((a, b) => (b.train.ci?.lo ?? -9) - (a.train.ci?.lo ?? -9)).map(row).join('\n') + '\n';
  md += `\nKolom data terkunci untuk varian yang tidak dipilih hanya untuk transparansi. Memilih ulang berdasarkan kolom itu sama dengan melihat jawaban ujian.\n`;
  md += `\n## Batasan\n- ${results.length} varian diuji pada data pengembangan, jadi varian terbaik di sana cenderung kelihatan lebih bagus dari kenyataannya (winner's curse). Itulah gunanya uji terkunci.\n- Hasil agregat periode penuh pernah dilihat sebelum riset ini ditulis, jadi periode terkunci tidak sepenuhnya bersih. Satu-satunya uji yang benar-benar bersih adalah sinyal live dari sekarang.\n- Universe = koin teratas hari ini (survivorship bias). Funding, likuiditas, dan slippage saat volatil belum dimodelkan.\n`;
  return md;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2), si = args.indexOf('--split');
  const split = si >= 0 ? args[si + 1] : SPLIT_DEFAULT;
  if (si >= 0) args.splice(si, 2);
  const base = parseArgs(args);
  console.error(`Riset dimulai: ${GRID.length} varian, pembagian ${split}. Pertama kali bisa 10 sampai 30 menit.`);
  const res = await runResearch(base, { split }, m => console.error(' ', m));
  const md = renderResearch(res, base);
  fs.mkdirSync(base.out, { recursive: true });
  fs.writeFileSync(path.join(base.out, 'research.md'), md);
  fs.writeFileSync(path.join(base.out, 'research.json'), JSON.stringify({ split: res.split, chosen: res.chosen?.name ?? null, verdict: res.vd, results: res.results.map(r => ({ name: r.name, train: { ...r.train.s, ci: r.train.ci }, test: { ...r.test.s, ci: r.test.ci } })) }, null, 1));
  console.log(md);
}
