// Ambil data saham & forex dari Yahoo Finance saat GitHub Actions berjalan,
// simpan sebagai JSON statis di data/ (dibaca browser dari domain yang sama).
// Daftar simbol = CONFIG.stocks + CONFIG.forex (+ CONFIG.extraWatch) di config.js.
import fs from "node:fs";

const SLEEP = +(process.env.SLEEP_MS ?? 400);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cfg = new Function(fs.readFileSync("config.js", "utf8") + "; return CONFIG;")();
const list = [...(cfg.stocks || []), ...(cfg.forex || []), ...(cfg.extraWatch || [])];
const OVERRIDE = { "OANDA:XAUUSD": "GC=F", "OANDA:XAGUSD": "SI=F", "TVC:DXY": "DX-Y.NYB", "TVC:USOIL": "CL=F", ...(cfg.yahooMap || {}) };

const yahooSym = tv => {
  if (OVERRIDE[tv]) return OVERRIDE[tv];
  const [ex, t] = tv.split(":");
  if (ex === "IDX") return t + ".JK";
  if (/^(FX|OANDA|FOREXCOM|FX_IDC)$/.test(ex) && /^[A-Z]{6}$/.test(t)) return t + "=X";
  return t;
};
const rows = res => {
  const q = res.indicators.quote[0], out = [];
  res.timestamp.forEach((_, i) => {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    out.push([q.high[i], q.low[i], q.close[i], q.volume?.[i] || 0]);
  });
  return out;
};
const to4h = r => {
  const o = [];
  for (let i = 0; i < r.length; i += 4) {
    const g = r.slice(i, i + 4);
    o.push([Math.max(...g.map(x => x[0])), Math.min(...g.map(x => x[1])), g.at(-1)[2], g.reduce((a, x) => a + x[3], 0)]);
  }
  return o;
};
async function chart(sym, interval, range) {
  let last = "";
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=false`,
        { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "application/json" } });
      if (r.ok) { const res = (await r.json()).chart?.result?.[0]; if (res?.timestamp?.length) return rows(res); last = "data kosong"; }
      else last = "HTTP " + r.status;
    } catch (e) { last = e.message }
    await sleep(SLEEP * 4);
  }
  throw new Error(last);
}

fs.mkdirSync("data", { recursive: true });
const index = { updated: new Date().toISOString(), ok: [], failed: [] };
for (const tv of list) {
  const ys = yahooSym(tv), data = { symbol: tv, yahoo: ys, updated: index.updated, tf: {} };
  const jobs = [["15m", "15m", "30d"], ["1h", "60m", "730d"], ["1d", "1d", "2y"]];
  const got = {};
  for (const [name, iv, range] of jobs) {
    try { got[name] = await chart(ys, iv, range) } catch (e) { console.warn(`${tv} ${name}: ${e.message}`) }
    await sleep(SLEEP);
  }
  if (got["15m"]) data.tf["15m"] = got["15m"].slice(-250);
  if (got["1h"]) { data.tf["1h"] = got["1h"].slice(-250); data.tf["4h"] = to4h(got["1h"].slice(-1000)).slice(-250); }
  if (got["1d"]) data.tf["1d"] = got["1d"].slice(-250);
  if (Object.keys(data.tf).length) {
    fs.writeFileSync(`data/${tv.replace(/[^A-Z0-9]/gi, "_")}.json`, JSON.stringify(data));
    index.ok.push(tv);
  } else index.failed.push(tv);
}
fs.writeFileSync("data/index.json", JSON.stringify(index));
console.log(`Selesai: ${index.ok.length} berhasil, ${index.failed.length} gagal`, index.failed);
process.exit(0); // jangan gagalkan deploy walau Yahoo menolak
