// Aturan penilaian trade yang SAMA dipakai jurnal live (scripts/jurnal.mjs)
// dan backtester (scripts/backtest.mjs). Satu sumber kebenaran, supaya angka
// backtest dan angka jurnal bisa dibandingkan apa adanya.
//
// Aturan (semuanya konservatif bila urutan kejadian tidak bisa dipastikan):
//  1. Order limit terisi bila harga menyentuh entry. Bila candle dibuka sudah di sisi
//     entry yang menguntungkan, order terisi di open.
//  2. Candle yang mengisi entry BOLEH menyentuh SL. Bila ya, dihitung SL.
//     TP di candle pengisi hanya dihitung bila order terisi tepat di open.
//  3. Candle yang menyentuh SL dan TP sekaligus: bila ada data 1 menit (m1), urutan
//     ditentukan dari data itu; bila tidak ada, dihitung SL lebih dulu.
//  4. Candle yang sedang berjalan saat sinyal dibuat TIDAK dipakai utuh (isinya memuat
//     harga sebelum sinyal). Dipakai hanya lewat data 1 menit setelah waktu sinyal.
//  5. Habis waktu (due): tidak terisi -> 0R; terisi -> dinilai di close candle terakhir.
//  6. (v2) Order yang BELUM terisi dibatalkan begitu harga menyentuh TP tanpa pernah menyentuh entry: setup
//     sudah berjalan tanpa kita. Hasil tetap 'tidak terisi' (0R) dengan batal:true, dan koin langsung bebas
//     untuk sinyal berikutnya alih-alih tertahan sampai jatuh tempo.
export const H1 = 36e5;
export const mapK = a => ({ ot: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], ct: a[6] });

const rules = r => {
  const s = r.arah === 'LONG' ? 1 : -1;
  return {
    s,
    touch: k => (s == 1 ? k.l <= r.entry : k.h >= r.entry),
    open: k => (s == 1 ? k.o <= r.entry : k.o >= r.entry),
    sl: k => (s == 1 ? k.l <= r.sl : k.h >= r.sl),
    tp: k => (s == 1 ? k.h >= r.tp : k.l <= r.tp),
  };
};

// Jalankan daftar candle berurutan; ubah st.fill; kembalikan {res,t} saat SL/TP kena.
function walk(cs, P, st) {
  for (const k of cs) {
    if (!st.fill) {
      const ao = P.open(k);
      if (!ao && !P.touch(k)) { if (P.tp(k)) return { res: 'BATAL', t: k.ot }; continue; }
      st.fill = true;
      if (P.sl(k)) return { res: 'SL', t: k.ot };
      if (ao && P.tp(k)) return { res: 'TP', t: k.ot };
      continue;
    }
    if (P.sl(k)) return { res: 'SL', t: k.ot };
    if (P.tp(k)) return { res: 'TP', t: k.ot };
  }
  return null;
}

/**
 * r   : { arah:'LONG'|'SHORT', entry, sl, tp, t (ms sinyal), due (ms batas waktu) }
 * src : { h1: () => Promise<[{ot,o,h,l,c,ct}]>  candle 1H mulai jam yang memuat r.t,
 *         m1?: (fromMs, toMs) => Promise<[{ot,o,h,l,c}]>  candle 1 menit (opsional),
 *         now?: ms }
 * Hasil: { hasil:'TP'|'SL'|'kedaluwarsa'|'tidak terisi', R (kotor, tanpa biaya), t (waktu keluar), batal?:true }
 *        atau null bila trade belum selesai (masih menunggu).
 */
export async function gradeTrade(r, { h1, m1, now = Date.now() }) {
  const P = rules(r), risk = Math.abs(r.entry - r.sl), st = { fill: false };
  if (!(risk > 0)) return { hasil: 'tidak valid', R: 0, t: r.t };
  const done = w => w.res === 'BATAL' ? { hasil: 'tidak terisi', R: 0, t: w.t, batal: true } : ({
    hasil: w.res,
    R: w.res === 'SL' ? -1 : (P.s * (r.tp - r.entry)) / risk,
    t: w.t,
  });
  const cs = (await h1()).filter(k => k.ct < now);

  // aturan 4: candle yang memuat waktu sinyal
  if (cs.length && cs[0].ot < r.t) {
    const k0 = cs.shift();
    if (m1) {
      const ms = (await m1(Math.max(k0.ot, r.t), k0.ct)).filter(m => m.ot >= r.t);
      const w = walk(ms, P, st);
      if (w) return done(w);
    }
  }

  let last = null;
  for (const k of cs) {
    if (k.ct > r.due) break;
    last = k;
    const amb = st.fill ? P.sl(k) && P.tp(k) : (P.touch(k) || P.open(k)) && (P.sl(k) || P.tp(k));
    const w = amb && m1 ? walk(await m1(k.ot, k.ct), P, st) : walk([k], P, st);
    if (w) return done(w);
  }

  if (now < r.due) return null;
  if (!st.fill) return { hasil: 'tidak terisi', R: 0, t: r.due };
  return { hasil: 'kedaluwarsa', R: (P.s * ((last ? last.c : r.entry) - r.entry)) / risk, t: r.due };
}
