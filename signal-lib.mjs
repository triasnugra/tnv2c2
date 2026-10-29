// Validasi dan penyaringan sinyal SEBELUM dicatat ke jurnal. Fungsi murni, diuji di scripts/test-engine.mjs.
// Tujuan: sinyal cacat (simbol kosong, urutan entry/SL/TP salah, waktu tidak masuk akal, data kedaluwarsa)
// tertangkap di pintu masuk dan dihitung di corong penolakan, bukan masuk jurnal lalu muncul sebagai "INVALID".
import { CFG } from './core.mjs';

export const SYM_RE = /^[A-Z0-9]{2,15}$/;
const DAY = 864e5;

export function validateSignal(s, { now = Date.now(), maxSlPct = 15, minRR = 1.5 } = {}) {
  const e = [];
  const fin = (...v) => v.every(x => typeof x === 'number' && Number.isFinite(x) && x > 0);
  if (typeof s.aset !== 'string' || !SYM_RE.test(s.aset)) e.push('simbol kosong atau format tidak sah');
  if (s.arah !== 'LONG' && s.arah !== 'SHORT') e.push('arah bukan LONG/SHORT');
  if (!fin(s.entry, s.sl, s.tp)) e.push('entry/SL/TP bukan angka positif');
  if (!fin(s.harga_awal)) e.push('harga acuan tidak valid');
  if (!Number.isFinite(s.t) || s.t > now + 5 * 6e4) e.push('waktu analisis tidak diketahui atau di masa depan');
  else if (Number.isFinite(s.due) && s.due <= s.t) e.push('batas waktu sebelum waktu sinyal');
  if (fin(s.entry, s.sl, s.tp) && (s.arah === 'LONG' || s.arah === 'SHORT')) {
    const d = s.arah === 'LONG' ? 1 : -1, risk = d * (s.entry - s.sl), reward = d * (s.tp - s.entry);
    if (!(risk > 0 && reward > 0)) e.push('urutan entry/SL/TP tidak sesuai arah');
    else {
      if (risk / s.entry * 100 > maxSlPct) e.push(`SL ${(risk / s.entry * 100).toFixed(1)}% melebihi batas ${maxSlPct}%`);
      if (reward / risk < minRR) e.push(`RR ${(reward / risk).toFixed(2)} di bawah ${minRR}`);
    }
    if (fin(s.harga_awal) && Math.abs(s.entry - s.harga_awal) / s.harga_awal > 0.25) e.push('entry terlalu jauh dari harga acuan (>25%)');
  }
  return { ok: !e.length, errors: e };
}

// Satu order aktif per koin, dan jeda setelah SL. Sebelumnya jurnal mencatat setup yang sama setiap hari (TRX 7x, UNI 6x)
// sehingga "Setup terbit" membengkak dan satu peristiwa pasar dihitung berkali-kali.
export function activeBlock(rows, aset, now = Date.now(), cooldownDays = CFG.cooldownDays, agen = 'Aturan Eliz') {
  for (const r of rows) {
    if (r.agen !== agen || r.aset !== aset) continue;
    if (r.hasil === 'menunggu') return 'duplikat-aktif';
    if (r.hasil === 'SL' && now - (r.tx ?? r.due ?? r.t) < cooldownDays * DAY) return 'cooldown-sl';
  }
  return null;
}

// Rekap corong harian yang ditulis ke data/funnel.json (tidak disegel; hanya transparansi).
export const bumpCount = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; };
