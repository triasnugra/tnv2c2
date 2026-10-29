// Server Binance/CoinGecko palsu untuk uji offline (random walk deterministik). Hanya untuk pengujian.
const H1 = 36e5;
function mul(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const SYMS = ['BTC', 'ETH', 'SOL', 'ADA', 'XRP', 'DOGE', 'LINK', 'AVAX', 'LTC', 'BNB'];
export function install({ days = 1200, seed = 500 } = {}) {
  const NOW = Date.now(), hourly = {}, daily = {}, start = Math.floor(NOW / 864e5) * 864e5 - days * 864e5, endH = Math.floor(NOW / H1) * H1;
  SYMS.forEach((s, si) => {
    const r = mul(seed + si); let p = 100 + si * 10; const hs = [];
    for (let t = start; t <= endH; t += H1) { const o = p, c = p * (1 + (r() - 0.5) * 0.012); p = c; hs.push([t, o, Math.max(o, c) * (1 + r() * 0.004), Math.min(o, c) * (1 - r() * 0.004), c, (50 + r() * 50) * 500, t + H1 - 1]); }
    hourly[s] = hs; const d = new Map();
    for (const h of hs) { const k = Math.floor(h[0] / 864e5) * 864e5, x = d.get(k); if (!x) d.set(k, [k, h[1], h[2], h[3], h[4], h[5], k + 864e5 - 1]); else { x[2] = Math.max(x[2], h[2]); x[3] = Math.min(x[3], h[3]); x[4] = h[4]; x[5] += h[5]; } }
    daily[s] = [...d.values()];
  });
  const real = globalThis.fetch, calls = { n: 0 };
  globalThis.fetch = async url => {
    calls.n++; const u = new URL(url), j = v => ({ ok: true, status: 200, json: async () => v, text: async () => '' });
    if (u.hostname.includes('coingecko')) return j({ data: { market_cap_percentage: { btc: 59.3, eth: 10.9 } } });
    if (u.pathname.endsWith('/ticker/24hr')) return j(SYMS.map((s, i) => ({ symbol: s + 'USDT', quoteVolume: String(1e9 - i * 1e7) })));
    if (u.pathname.endsWith('/klines')) {
      const sym = u.searchParams.get('symbol').replace('USDT', ''), iv = u.searchParams.get('interval');
      const st = +(u.searchParams.get('startTime') || 0), en = +(u.searchParams.get('endTime') || 9e15), lim = +(u.searchParams.get('limit') || 500);
      if (!hourly[sym]) return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad symbol' };
      if (iv === '1m') {
        const out = [];
        for (const h of hourly[sym]) { if (h[6] < st || h[0] > en) continue; for (let m = 0; m < 60; m++) { const ot = h[0] + m * 6e4; if (ot < st || ot > en) continue; const px = h[1] + (h[4] - h[1]) * (m / 60); out.push([ot, px, m == 10 ? h[2] : px * 1.0002, m == 40 ? h[3] : px * 0.9998, px, 1, ot + 59999]); } if (out.length >= lim) break; }
        return j(out.slice(0, lim).map(r => [...r, 0, 0, 0, 0, 0]));
      }
      const src = iv === '1d' ? daily[sym] : iv === '1h' ? hourly[sym] : null;
      if (!src) return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad interval' };
      // Seperti Binance sungguhan: tanpa startTime, kembalikan candle TERAKHIR (paling baru), bukan yang paling lama.
      const rows = src.filter(r => r[0] >= st && r[0] <= en);
      const pick = u.searchParams.get('startTime') ? rows.slice(0, lim) : rows.slice(-lim);
      return j(pick.map(r => [...r, 0, 0, 0, 0, 0]));
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'nf' };
  };
  return { restore: () => { globalThis.fetch = real; }, calls, hourly, daily };
}
