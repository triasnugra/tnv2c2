# Backtester CryptoEliz

Menguji engine `core.mjs` (`feat()`) pada riwayat harian Binance dan memberi tahu apakah aturannya punya edge
yang bertahan secara statistik, bukan hanya terlihat bagus pada beberapa trade.

## Menjalankan
```
node scripts/backtest.mjs                 # top 40 koin volume terbesar, 1500 hari
node scripts/backtest.mjs --symbols BTC,ETH,SOL --days 1000
node scripts/backtest.mjs --precise       # resolusi 1 menit untuk candle ambigu (lebih lambat)
node scripts/backtest.mjs --help
node scripts/test-backtest.mjs            # uji otomatis (tanpa jaringan)
```
Perlu Node 18+ dan akses ke Binance (`data-api.binance.vision`). Unduhan pertama beberapa menit, berikutnya dari
`backtest/cache/`. Keluaran di `backtest/out/`: `report.md`, `trades.csv`, `equity.csv`, `summary.json`.

## Cara membaca report.md
1. **Lihat CI, bukan rata-rata.** Edge baru "terbukti" bila batas bawah CI 95% R/trade > 0.
2. **Bandingkan dengan baseline PER SINYAL.** MIRROR (arah dibalik) dan MARKET (arah sama, entry di open). Strategi
   hanya berarti bila mengalahkan keduanya. Selisih dihitung per sinyal karena order limit yang tidak terisi sering
   justru yang berlari menjauh (adverse selection).
3. **Ukuran sampel = jumlah minggu**, bukan jumlah trade. Sinyal di hari yang sama saling berkorelasi (satu rezim pasar).
4. **Tabel grup = hipotesis**, bukan bukti. Banyak grup diuji sekaligus, jadi sebagian akan tampak signifikan karena kebetulan.
5. **Tabel kuartal** menunjukkan stabilitas. Edge yang hanya hidup di satu kuartal patut dicurigai.

## Aturan simulasi (trade-sim.mjs, dipakai juga oleh jurnal live)
- Order limit berlaku `--hold` hari (default 7). Candle pengisi dicek SL. Bila SL dan TP kena dalam satu candle
  dan tidak ada data 1 menit, SL didahulukan.
- Scan disimulasikan 00:00 UTC hanya dengan harga open hari itu (tidak melihat masa depan; diuji otomatis).
- Biaya default 0,05% per sisi + 0,05% slippage. Funding futures belum dimodelkan.

## Batasan yang harus diingat
- Universe = koin teratas HARI INI (survivorship bias).
- Aturan dirancang setelah melihat chart terbaru, jadi periode terakhir bukan out-of-sample murni.
- Hasil backtest bukan jaminan hasil live.

## Riset varian dengan uji terkunci (scripts/research.mjs)
Menguji 16 varian (entry limit atau market, TP engine atau 1,5R/2R/3R, hold 3 atau 7 hari) dengan aturan yang
ditetapkan di awal: pilih varian HANYA dari data sebelum tanggal pemisah, lalu uji SEKALI pada data sesudahnya.
```
node scripts/research.mjs --split 2025-07-01
```
Atau lewat GitHub: Actions > "Riset varian CryptoEliz" > Run workflow. Baca `research.md`.
Aturan: jangan menambah varian atau mengganti tanggal pemisah setelah melihat hasil; itu membatalkan ujinya.
Lulus hanya berarti layak masuk forward test di jurnal live, bukan izin memakai uang besar.
