# Mesin 2 v2.0: upgrade kualitas

## Diagnosis (dari statistik monitor 28 Okt + jurnal 305 baris)
- LONG: win 7,0% (n=43, -34R). SHORT: win 63,6% (n=22, +20R). Win rate gabungan 26,2% hanya rata-rata dari dua kondisi yang sangat berbeda.
- Pemicu "Sweep Monday Low" (LONG) = 59 dari 81 SL. SL menumpuk pada hari yang sama (14 Okt: 18 SL; 21-22 Okt: 22 SL): itu 2-3 peristiwa pasar, bukan 80 sampel independen.
- Penyebab: filter lawan-tren v1 meloloskan sweep Monday tanpa konfirmasi; gerbang BTC hanya peringatan; SL minimum 3% lebih ketat dari ATR harian koin (noise).
- EXPIRED/"tidak terisi": mesin menerbitkan setup yang pemicunya 3-5 hari lalu, sehingga harga sudah menyentuh TP atau jauh dari entry (median jarak entry setup tak terisi 13%).
- Jurnal mencatat setup yang sama tiap hari (TRX 7x, UNI 6x) sehingga "Setup terbit" membengkak.

## Perubahan fitur
| Area | Perubahan |
|---|---|
| Validasi data | `checkBars`: NaN, harga <=0, high<low, candle bolong ditolak di pintu masuk (`data-tidak-valid`). `validateSignal`: simbol kosong, urutan entry/SL/TP, waktu, RR, SL maks dicek SEBELUM masuk jurnal, jadi tidak ada lagi baris INVALID. |
| Anti usang | Tiap setup melacak candle pemicu. Ditolak bila: umur > 3 hari (breakout 5), harga sudah menyentuh TP sejak pemicu, wick pemicu tertembus, entry sudah tersentuh dan harga sudah 1R menjauh. |
| Keterjangkauan | Harga harus dalam 0,75R (maks 5%) dari entry. Yang hanya kurang ini = "hampir setup" (pantauan, tidak dicatat). |
| Rezim BTC | Gerbang keras bila BTC melawan di weekly DAN daily; juga bila BTC bergerak >5% dalam 3 hari melawan arah. Simetris untuk LONG/SHORT. |
| Lawan tren | Boleh hanya dengan pemicu pembalikan + divergensi OBV/RSI. |
| SL | Lantai 1x ATR(14) harian. |
| Skor | 0-100 (heuristik), grade A/B/C, minimum 60. Tercatat dan disegel di jurnal. |
| Portofolio | Maks 3 sinyal/arah, 5/hari; bila >=6 kandidat searah (klaster pasar) hanya 2 teratas. |
| Jurnal | Satu order aktif per koin, jeda 3 hari setelah SL, corong penolakan harian di `data/funnel.json`. |
| Simulator | Order belum terisi dibatalkan bila harga mencapai TP tanpa menyentuh entry (0R, koin langsung bebas). |
| Risiko | `risk-lib.mjs`: proteksi (3 SL berturut = risiko -50%, 5 = berhenti; 10 trade terakhir <= -6R; rugi harian -3R), panas portofolio, ukuran posisi dengan peringatan. |
| Gerbang uang nyata | Panel yang tetap merah sampai: rantai utuh, >=150 trade & 20 minggu, CI95 R/trade > 0, PF >= 1,2, DD <= 15R, mengalahkan MIRROR. |
| Backtest | Diproses per hari (konteks BTC + portofolio), tabel per grade/skor/umur, corong, dan `--shadow` = efektivitas tiap gerbang (setup ditolak tetap dinilai). Opsi `--no-gates`, `--no-portfolio`, `--min-score`. |
| UI | Skor/grade/umur, corong penolakan, hampir-setup, proteksi risiko, panel uang nyata. |

## BATASAN JUJUR
- Sandbox tidak bisa menjangkau Binance, jadi efek gerbang pada data harga nyata BELUM diukur. Yang terbukti: 203 uji otomatis (skenario candle buatan tangan, uji properti pada ribuan hari acak, simulator, rantai hash). Skor dan ambang di `CFG` adalah heuristik berbasis temuan jurnal, bukan hasil optimasi.
- Jalankan di komputer/GitHub Actions: `node scripts/backtest.mjs --shadow --split 2026-01-01`. Baca "Efektivitas gerbang": gerbang yang menolak setup untung ("PERHATIAN") perlu dilonggarkan.
- Win rate tinggi bukan tujuan; yang dinilai R/trade setelah biaya dengan CI.

## Memulai forward test baru
core.mjs berubah, jadi hash mesin baru. Protokol v1 diarsipkan di `data/archive-v1/`. Jurnal lama tetap (rantai hash tetap valid). Run jurnal berikutnya otomatis membuat protokol v2; hanya baris v2 yang dihitung. Jangan ubah `core.mjs`/`trade-sim.mjs` lagi selama uji berjalan.
Monitor: skema `journal.json` hanya ditambah field (trig, score, grade, age, sv); nilai `hasil` tidak berubah.
