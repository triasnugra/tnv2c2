// Uji otomatis forward test (offline):  node scripts/test-forward.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kl, feat, bj, scanInput, btcCtx } from '../core.mjs';
import { mulberry32 } from './backtest-lib.mjs';
import { install, SYMS } from './fake-binance.mjs';
import { regrade } from './forward.mjs';
import { engineHash, sealRow, lastSealed, verifyChain, makeProtocol, ensureProtocol, pickSignals, analyze, renderForward } from '../forward-lib.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  GAGAL', name, extra); } };
const near = (a, b, name, tol = 1e-6) => ok(Math.abs(a - b) < tol, name, `(dapat ${a}, harapan ${b})`);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 864e5, T0 = Date.UTC(2026, 9, 14);

// ---- pembuat baris tersegel ----
let rows;
const mk = (i, o = {}) => {
  const t = T0 + (o.dt ?? i * 3600e3);
  const r = { id: `u|${i}`, waktu: 'x', t, due: t + 7 * DAY, agen: 'Aturan Eliz', aset: o.aset ?? `S${i}`, arah: o.arah ?? 'LONG', entry: 100, sl: 95, tp: 110, harga_awal: 101, keyakinan: '', alasan: 'uji', alert: '', hasil: o.hasil ?? 'TP', R: o.R ?? 2, tx: o.tx ?? t + 2 * DAY, engine: o.engine ?? 'ENG', ...(o.extra || {}) };
  sealRow(r, lastSealed(rows)); rows.push(r); return r;
};
const P0 = () => ({ ...makeProtocol('ENG', T0 - DAY), syarat_evaluasi: { min_trade_terisi: 4, min_minggu_berbeda: 2 } });

console.log('\n[1] Hash mesin');
{
  const h = engineHash('a', 'b');
  ok(h === engineHash('a', 'b') && h.length === 16, 'hash stabil untuk isi yang sama');
  ok(h !== engineHash('a', 'bb') && h !== engineHash('aa', 'b'), 'hash berubah bila salah satu file berubah');
  ok(engineHash('x\r\ny', 'z') === engineHash('x\ny', 'z'), 'perbedaan akhir baris (CRLF/LF) tidak mengubah hash');
}

console.log('\n[2] Rantai hash (deteksi pengeditan)');
{
  rows = []; for (let i = 0; i < 6; i++) mk(i);
  let v = verifyChain(rows);
  ok(v.ok && v.n === 6 && rows[0].prev === 'GENESIS' && rows[3].prev === rows[2].h, 'rantai valid dan tertaut');
  const edit = fn => { const c = JSON.parse(JSON.stringify(rows)); fn(c); return verifyChain(c); };
  ok(!edit(c => (c[2].entry = 99)).ok, 'mengubah entry terdeteksi');
  ok(!edit(c => (c[2].sl = 90)).ok && !edit(c => (c[2].tp = 120)).ok, 'mengubah sl atau tp terdeteksi');
  ok(!edit(c => (c[2].alasan = 'diubah')).ok, 'mengubah alasan terdeteksi');
  ok(!edit(c => (c[2].t += 1)).ok, 'mengubah waktu sinyal terdeteksi');
  ok(!edit(c => (c[2].engine = 'LAIN')).ok, 'mengubah versi mesin terdeteksi');
  ok(!edit(c => (c[2].arah = 'SHORT')).ok, 'membalik arah terdeteksi');
  ok(!edit(c => c.splice(3, 1)).ok, 'menghapus baris di tengah terdeteksi');
  ok(!edit(c => { const x = c[1].seq; c[1].seq = c[2].seq; c[2].seq = x; }).ok, 'menukar urutan (nomor seq) terdeteksi');
  ok(edit(c => c.reverse()).ok, 'urutan elemen array di file tidak berpengaruh (rantai diurutkan menurut seq)');
  ok(!edit(c => { c[4].prev = c[1].h; }).ok, 'memutus tautan terdeteksi');
  // batas yang dinyatakan jujur
  ok(edit(c => (c[2].hasil = 'SL')).ok, 'BATAS: hasil tidak disegel (dicek lewat verify --regrade)');
  ok(edit(c => c.pop()).ok, 'BATAS: menghapus baris TERAKHIR tidak terdeteksi rantai (ditutup oleh hash ujung di ringkasan Actions)');
  ok(verifyChain([]).ok && verifyChain([]).head === null, 'jurnal kosong valid');
}

console.log('\n[3] Protokol terkunci');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-')), f = path.join(tmp, 'data', 'p.json');
  const a = ensureProtocol('E1', f, 1000), b = ensureProtocol('E2', f, 2000);
  ok(a.created && !b.created, 'protokol dibuat sekali');
  ok(b.engine === 'E1' && b.mulai_ms === 1000, 'protokol tidak ditimpa: mesin dan tanggal mulai tetap');
  ok(b.syarat_evaluasi.min_trade_terisi >= 100 && b.syarat_evaluasi.min_minggu_berbeda >= 12 && /CI 95%/.test(b.kriteria_lulus) && b.larangan.length >= 4, 'protokol memuat syarat evaluasi, kriteria lulus, dan larangan');
}

console.log('\n[4] Pemilihan sinyal dan deduplikasi');
{
  const P = P0();
  rows = [];
  mk(0, { aset: 'BTC', dt: 0, tx: T0 + 3 * DAY });
  mk(1, { aset: 'BTC', dt: 1 * DAY });           // sebelum BTC#0 selesai: dilewati
  mk(2, { aset: 'BTC', dt: 4 * DAY });           // sesudah selesai: dihitung
  mk(3, { aset: 'ETH', dt: 1 * DAY, hasil: 'menunggu', R: '', tx: undefined });
  mk(4, { aset: 'ETH', dt: 2 * DAY });           // ETH#3 belum selesai: memblokir
  mk(5, { aset: 'SOL', dt: 1 * DAY, engine: 'LAIN' }); // mesin berubah: diabaikan
  mk(6, { aset: 'ADA', dt: -2 * DAY });          // sebelum protokol mulai
  mk(7, { aset: 'XRP', dt: 1 * DAY, hasil: 'NO_TRADE', arah: 'NO_TRADE' });
  mk(8, { aset: 'LTC', dt: 1 * DAY, hasil: 'tidak valid' });
  const legacy = { id: 'lama', t: T0 + DAY, due: T0 + 8 * DAY, agen: 'Aturan Eliz', aset: 'DOT', arah: 'LONG', entry: 100, sl: 95, tp: 110, hasil: 'TP', R: 2 }; rows.push(legacy);
  const { kept, other, skipped } = pickSignals(rows, P);
  const ids = kept.map(r => r.id);
  ok(ids.includes('u|0') && !ids.includes('u|1') && ids.includes('u|2'), 'deduplikasi: sinyal saat order aktif dilewati, sesudah selesai dihitung');
  ok(ids.includes('u|3') && !ids.includes('u|4'), 'order yang masih menunggu memblokir sinyal berikutnya pada koin itu');
  ok(!ids.includes('u|5') && other === 1, 'baris dari mesin lain diabaikan dan dihitung terpisah');
  ok(!ids.includes('u|6'), 'baris sebelum tanggal mulai protokol tidak dihitung');
  ok(!ids.includes('u|7') && !ids.includes('u|8'), 'NO_TRADE dan tidak valid bukan sinyal');
  ok(!kept.includes(legacy), 'baris lama tanpa segel tidak dihitung');
  ok(skipped === 2, 'jumlah yang dilewati dedupe dilaporkan', String(skipped));
}

console.log('\n[5] Gerbang evaluasi dan perhitungan');
{
  const P = P0();
  // angka diketahui: TP, SL di minggu A; TP, SL di minggu B. slp 5%, biaya 0.15% -> TP +1.97, SL -1.03
  rows = [];
  mk(0, { dt: 0 }); mk(1, { dt: 100, hasil: 'SL', R: -1 }); mk(2, { dt: 8 * DAY }); mk(3, { dt: 8 * DAY + 100, hasil: 'SL', R: -1 });
  let a = analyze(rows, P);
  ok(a.ready && !a.locked && a.hasil, 'syarat terpenuhi: hasil ditampilkan');
  near(a.hasil.strategi.mean, (1.97 - 1.03) / 2, 'R/trade bersih biaya dihitung benar (TP +1.97, SL -1.03)', 1e-9);
  const thin = { ...P, syarat_evaluasi: { min_trade_terisi: 10, min_minggu_berbeda: 2 } };
  a = analyze(rows, thin);
  ok(a.locked && !a.hasil && !a.verdict, 'syarat belum terpenuhi: kinerja disembunyikan dan tanpa keputusan');
  ok(!JSON.stringify(a).includes('"mean"') && !JSON.stringify(a).includes('"win"'), 'JSON tidak membocorkan angka kinerja saat terkunci');
  const md = renderForward(a);
  ok(/BELUM BOLEH DIEVALUASI/.test(md) && !/R\/trade/.test(md), 'laporan terkunci menampilkan kemajuan, bukan angka');
  const pk = analyze(rows, thin, { peek: true });
  ok(pk.peek && pk.hasil && pk.verdict.pass === null && /INTIP/.test(renderForward(pk)), 'mode intip diberi label tidak sah dan tanpa keputusan lulus');
  const wk = { ...P, syarat_evaluasi: { min_trade_terisi: 3, min_minggu_berbeda: 5 } };
  ok(analyze(rows, wk).locked, 'syarat minggu berbeda juga menahan evaluasi walau jumlah trade cukup');
  // keputusan lulus / tidak lulus pada edge besar
  const build = pTP => { rows = []; const r = mulberry32(5); for (let i = 0; i < 90; i++) { const win = r() < pTP; mk(i, { dt: Math.floor(i / 3) * 7 * DAY + (i % 3) * 3600e3, hasil: win ? 'TP' : 'SL', R: win ? 2 : -1 }); } return analyze(rows, { ...P, syarat_evaluasi: { min_trade_terisi: 60, min_minggu_berbeda: 20 } }); };
  const good = build(0.6), bad = build(0.25);
  ok(good.ready && good.verdict.pass === true, 'edge besar nyata: LULUS', JSON.stringify(good.verdict));
  ok(bad.ready && bad.verdict.pass === false, 'edge negatif: TIDAK LULUS', JSON.stringify(bad.verdict));
  // baseline dan selisih
  rows = [];
  for (let i = 0; i < 8; i++) mk(i, { dt: i * 4 * DAY, hasil: i % 2 ? 'SL' : 'TP', R: i % 2 ? -1 : 2, extra: { bm: { e: 101, h: 'TP', R: 2, tx: T0 + (i * 4 + 1) * DAY }, bi: { e: 101, h: 'SL', R: -1, tx: T0 + (i * 4 + 1) * DAY } } });
  const bb = analyze(rows, { ...P, syarat_evaluasi: { min_trade_terisi: 8, min_minggu_berbeda: 2 } });
  ok(bb.hasil.market.filled === 8 && bb.hasil.mirror.filled === 8 && bb.hasil.selisihVsMarket.n === 8, 'baseline MARKET dan MIRROR ikut dihitung per sinyal');
  ok(bb.hasil.market.mean > bb.hasil.strategi.mean, 'baseline yang selalu TP tercermin lebih tinggi dari strategi campuran');
  ok(!bb.chain.ok === false && /Integritas jurnal: OK/.test(renderForward(bb)), 'laporan memuat status integritas jurnal');
  const tampered = JSON.parse(JSON.stringify(rows)); tampered[3].entry = 90;
  ok(/BERMASALAH/.test(renderForward(analyze(tampered, P))), 'laporan menandai jurnal yang diedit');
}

console.log('\n[6] Integrasi: jurnal.mjs sungguhan (server Binance palsu)');
{
  // cari seed yang menghasilkan sinyal agar uji tidak bergantung pada kebetulan
  let seed = null;
  for (let s = 500; s < 700 && seed == null; s++) {
    const fk = install({ seed: s }); let n = 0;
    let cx; try { const sb = scanInput(await kl('BTCUSDT')); cx = btcCtx(feat(sb.bars, sb.qv)); } catch { /* abaikan */ }
    for (const sy of SYMS) { try { const sc = scanInput(await kl(sy + 'USDT')); const f = feat(sc.bars, sc.qv, sy === 'BTC' ? undefined : cx); if (f.ok) n++; } catch { /* abaikan */ } }
    fk.restore(); if (n >= 2) seed = s;
  }
  ok(seed != null, 'ditemukan data palsu yang menghasilkan sinyal', String(seed));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fwj-'));
  for (const f of ['core.mjs', 'trade-sim.mjs', 'forward-lib.mjs', 'signal-lib.mjs', 'risk-lib.mjs']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(tmp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'));
  const ENG = engineHash(fs.readFileSync(path.join(tmp, 'core.mjs'), 'utf8'), fs.readFileSync(path.join(tmp, 'trade-sim.mjs'), 'utf8'));
  const run = () => spawnSync(process.execPath, ['--import', pathToFileURL(path.join(tmp, 'scripts/fake-binance-preload.mjs')).href, 'scripts/jurnal.mjs'], { cwd: tmp, env: { ...process.env, FORCE: '1', USE_AI: '', FAKE_SEED: String(seed) }, encoding: 'utf8', timeout: 120000 });
  // baris matang yang disegel di masa lalu: harus dinilai otomatis dan diberi baseline
  const fk = install({ seed }), tPast = Math.floor((Date.now() - 9 * DAY) / 36e5) * 36e5 + 30 * 6e4;
  const [k0] = await bj(`klines?symbol=LINKUSDT&interval=1m&startTime=${tPast}&limit=1`), px = +k0[1];
  rows = [];
  const old = { id: 'lama|Aturan Eliz|LINK', waktu: 'x', t: tPast, due: tPast + 7 * DAY, agen: 'Aturan Eliz', aset: 'LINK', arah: 'LONG', entry: +px.toPrecision(6), sl: +(px * 0.98).toPrecision(6), tp: +(px * 1.04).toPrecision(6), harga_awal: px, keyakinan: '', alasan: 'uji', alert: '', hasil: 'menunggu', R: '', engine: ENG };
  sealRow(old, null); fs.writeFileSync(path.join(tmp, 'data/journal.json'), JSON.stringify([old]));

  const r1 = run();
  ok(r1.status === 0 && !/ReferenceError|Error:/.test(r1.stderr), 'jurnal.mjs berjalan tanpa error', r1.stderr.slice(0, 300));
  const proto = JSON.parse(fs.readFileSync(path.join(tmp, 'data/forward-protocol.json'), 'utf8'));
  ok(proto.engine === ENG && /DIMULAI/.test(r1.stdout), 'protokol dibuat otomatis pada run pertama dan mengunci hash mesin');
  const j1 = JSON.parse(fs.readFileSync(path.join(tmp, 'data/journal.json'), 'utf8'));
  const fresh = j1.filter(r => r.id !== old.id);
  ok(fresh.length >= 1 && fresh.every(r => r.fwd === 1 && r.engine === ENG && typeof r.h === 'string'), `sinyal baru tersegel dengan hash mesin (${fresh.length} baris)`);
  ok(verifyChain(j1).ok, 'rantai hash valid setelah run pertama', JSON.stringify(verifyChain(j1).errors));
  const m = j1.find(r => r.id === old.id);
  ok(['TP', 'SL', 'kedaluwarsa', 'tidak terisi'].includes(m.hasil) && Number.isFinite(+m.R) && m.tx > m.t, `baris matang dinilai otomatis (${m.hasil}, R ${m.R}) dengan waktu keluar`);
  ok(m.bm && m.bi && Number.isFinite(m.bm.R) && Number.isFinite(m.bi.R), 'baris matang mendapat baseline MARKET dan MIRROR');
  ok(JSON.stringify(SEALED(m)) === JSON.stringify(SEALED(old)), 'penilaian tidak mengubah isi sinyal yang tersegel');

  const snap = JSON.stringify(j1.map(SEALED));
  const r2 = run();
  const j2 = JSON.parse(fs.readFileSync(path.join(tmp, 'data/journal.json'), 'utf8'));
  ok(r2.status === 0 && !/DIMULAI/.test(r2.stdout), 'run kedua tidak membuat protokol baru');
  ok(JSON.stringify(j2.slice(0, j1.length).map(SEALED)) === snap && verifyChain(j2).ok, 'run kedua: baris lama tidak berubah dan rantai tetap valid');
  ok(new Set(j2.map(r => r.id)).size === j2.length, 'tidak ada baris ganda');

  // regrade: hasil yang diedit manual harus ketahuan
  const P = JSON.parse(fs.readFileSync(path.join(tmp, 'data/forward-protocol.json'), 'utf8'));
  const g = await regrade(j2, P);
  ok(g.checked >= 1 && g.mismatches.length === 0, `penilaian ulang cocok dengan hasil tersimpan (${g.checked} baris)`, JSON.stringify(g.mismatches));
  const forged = JSON.parse(JSON.stringify(j2)), fm = forged.find(r => r.id === old.id);
  fm.hasil = fm.hasil === 'TP' ? 'SL' : 'TP'; fm.R = fm.hasil === 'TP' ? 2 : -1;
  ok(verifyChain(forged).ok, 'hasil yang dipalsukan lolos rantai (sesuai batas yang dinyatakan)');
  const g2 = await regrade(forged, P);
  ok(g2.mismatches.length >= 1 && g2.mismatches[0].id === old.id, 'tetapi penilaian ulang menangkap hasil yang dipalsukan');
  fk.restore();

  // mesin diubah -> baris baru tidak dihitung
  fs.appendFileSync(path.join(tmp, 'core.mjs'), '\n// perubahan\n');
  const r3 = run();
  ok(/PERINGATAN: mesin berubah/.test(r3.stdout), 'mengubah core.mjs memicu peringatan mesin berubah');
  const j3 = JSON.parse(fs.readFileSync(path.join(tmp, 'data/journal.json'), 'utf8'));
  const P3 = JSON.parse(fs.readFileSync(path.join(tmp, 'data/forward-protocol.json'), 'utf8'));
  ok(P3.engine === ENG && verifyChain(j3).ok, 'protokol tetap terkunci pada mesin awal; rantai tetap valid');
  fs.rmSync(tmp, { recursive: true, force: true });
}
function SEALED(r) { return ['id', 't', 'due', 'agen', 'aset', 'arah', 'entry', 'sl', 'tp', 'harga_awal', 'alasan', 'alert', 'engine', 'seq', 'prev', 'h'].map(k => r[k]); }

console.log(`\n${fail ? 'GAGAL' : 'SEMUA LULUS'}: ${pass} lulus, ${fail} gagal`);
process.exit(fail ? 1 : 0);
