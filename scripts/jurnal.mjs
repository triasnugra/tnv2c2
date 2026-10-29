import fs from 'node:fs';
import {bj,kl,NOT,feat,alertList,scanInput,btcCtx,selectPortfolio,CFG,ENGINE_VERSION} from '../core.mjs';
import {gradeTrade,mapK} from '../trade-sim.mjs';
import {engineHash,sealRow,lastSealed,ensureProtocol,RES} from '../forward-lib.mjs';
import {validateSignal,activeBlock,bumpCount} from '../signal-lib.mjs';
import {riskState} from '../risk-lib.mjs';
const DAY=864e5,H1=36e5,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const F='data/journal.json'
// Forward test: versi mesin dikunci lewat hash core.mjs + trade-sim.mjs. Mengubah salah satunya = mesin baru.
const ENGINE=engineHash(fs.readFileSync(new URL('../core.mjs',import.meta.url),'utf8'),fs.readFileSync(new URL('../trade-sim.mjs',import.meta.url),'utf8'));
const alerts=()=>alertList().map(a=>a[1]).join('; ');

const ELIZ=`Terapkan metode CryptoEliz:
- Ikuti tren; tren naik cari long, jangan short tanpa deviasi. BTC adalah gerbang: long altcoin saat BTC turun dihindari.
- Hanya trading di range high/low, hindari mid-range.
- Entry limit di retest setelah breakout ber-close, atau setelah deviasi (harga tembus level lalu kembali).
- Fib 0.75 zona koreksi; OBV dan RSI divergence sebagai konfirmasi.
- SL ketat (scalping 3-5%, swing 10-15%); tolak setup yang butuh SL lebih lebar.
- Saat ragu atau ada alert, NO_TRADE.`;
const prompt=(b,al,mode)=>`Kamu analis crypto. Hari ini ${new Date().toISOString().slice(0,10)} UTC. Alert aktif: ${al||'tidak ada'}.
Data harian (sudah dihitung; jangan mengarang angka lain):
${JSON.stringify(b)}
Beri rencana trading horizon 7 hari per aset. entry = harga limit. Jika tidak ada setup jelas, ada alert aktif, atau data kurang, jawab NO_TRADE. Jarak SL maks 15% dari entry.
Jawab HANYA JSON: {"hasil":[{"aset":"BTC","arah":"LONG|SHORT|NO_TRADE","entry":0,"sl":0,"tp":0,"keyakinan":0,"alasan":"maks 20 kata"}]}`+(mode=='eliz'?'\n\n'+ELIZ:'');

async function post(url,body,headers){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
 if(!r.ok)throw new Error('HTTP '+r.status+' '+(await r.text()).slice(0,150));return r.json()}
const oai=(url,def,env,json)=>async(k,p)=>(await post(url,{model:process.env[env]||def,temperature:0,messages:[{role:'user',content:p}],...(json?{response_format:{type:'json_object'}}:{})},{Authorization:'Bearer '+k})).choices[0].message.content;
const AI={
 Gemini:{key:'GEMINI_API_KEY',run:async(k,p)=>(await post(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL||'gemini-2.5-flash'}:generateContent`,{contents:[{parts:[{text:p}]}],generationConfig:{temperature:0,responseMimeType:'application/json'}},{'x-goog-api-key':k})).candidates[0].content.parts[0].text},
 Groq:{key:'GROQ_API_KEY',run:oai('https://api.groq.com/openai/v1/chat/completions','llama-3.3-70b-versatile','GROQ_MODEL',true)},
 OpenRouter:{key:'OPENROUTER_API_KEY',run:oai('https://openrouter.ai/api/v1/chat/completions','meta-llama/llama-3.3-70b-instruct:free','OPENROUTER_MODEL',false)},
 Perplexity:{key:'PERPLEXITY_API_KEY',run:oai('https://api.perplexity.ai/chat/completions','sonar','PERPLEXITY_MODEL',false)}};

const rows=fs.existsSync(F)?JSON.parse(fs.readFileSync(F,'utf8')):[];
const ids=new Set(rows.map(r=>r.id)),today=new Date().toISOString().slice(0,10);
const PROTO=ensureProtocol(ENGINE);
if(PROTO.created)console.log('Protokol forward test DIMULAI',PROTO.mulai,'mesin',ENGINE);
else if(PROTO.engine!==ENGINE)console.log('PERINGATAN: mesin berubah (hash '+ENGINE+', protokol '+PROTO.engine+'). Baris baru TIDAK dihitung di forward test sampai protokol baru dimulai (hapus data/forward-protocol.json).');
const q=v=>+Number(v).toPrecision(5);
function addRow(agen,aset,o,px,al){
 const id=`${today}|${agen}|${aset}`;if(ids.has(id))return;ids.add(id);
 const arah=String(o.arah||'').toUpperCase(),t=Date.now(),entry=+o.entry,sl=+o.sl,tp=+o.tp;
 const row={id,waktu:new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC',t,due:t+7*DAY,agen,aset,arah,entry:'',sl:'',tp:'',harga_awal:px,keyakinan:o.keyakinan??'',alasan:String(o.alasan||'').slice(0,160),alert:al,hasil:'menunggu',R:'',...(o.trig?{trig:o.trig,score:o.score,grade:o.grade,age:o.age}:{})};
 if(arah==='NO_TRADE'){row.hasil='NO_TRADE'}
 else if(arah!=='LONG'&&arah!=='SHORT'||![entry,sl,tp].every(Number.isFinite)){row.arah=arah||'?';row.hasil='tidak valid'}
 else{Object.assign(row,{entry:q(entry),sl:q(sl),tp:q(tp)});const s=arah==='LONG'?1:-1;
  if(!(s*(entry-sl)>0&&s*(tp-entry)>0)||Math.abs(entry-sl)/entry>.15)row.hasil='tidak valid'}
 row.engine=ENGINE;sealRow(row,lastSealed(rows));
 rows.push(row)}
// Penilaian memakai aturan bersama di trade-sim.mjs (sama persis dengan backtester):
// candle pengisi dicek SL, urutan SL/TP dalam candle 1H yang ambigu diputuskan lewat data 1 menit.
async function grade(r){
 const sym=r.aset+'USDT',t0=Math.floor(r.t/H1)*H1,now=Date.now();
 const g=await gradeTrade(r,{now,
  h1:async()=>(await bj(`klines?symbol=${sym}&interval=1h&startTime=${t0}&limit=1000`)).map(mapK),
  m1:async(a,b)=>(await bj(`klines?symbol=${sym}&interval=1m&startTime=${a}&endTime=${b}&limit=1000`)).map(mapK)});
 if(g){r.hasil=g.hasil;r.R=+g.R.toFixed(2);r.tx=g.t}}

// Baseline forward: entry MARKET di menit pertama setelah sinyal (arah sama) dan MIRROR (arah dibalik), jarak risiko
// sama dan TP 2R. Dinilai dengan aturan yang sama. Pembanding wajib: tanpa ini tidak bisa dibedakan edge dari kebetulan.
async function gradeBase(r){
 const sym=r.aset+'USDT',s=r.arah==='LONG'?1:-1,risk=Math.abs(r.entry-r.sl),now=Date.now(),t0=Math.floor(r.t/H1)*H1;
 const m0=(await bj(`klines?symbol=${sym}&interval=1m&startTime=${r.t}&limit=1`)).map(mapK)[0];if(!m0)return;
 const e=m0.o,src={now,
  h1:async()=>(await bj(`klines?symbol=${sym}&interval=1h&startTime=${t0}&limit=1000`)).map(mapK),
  m1:async(a,b)=>(await bj(`klines?symbol=${sym}&interval=1m&startTime=${a}&endTime=${b}&limit=1000`)).map(mapK)};
 const one=async d=>{const sd=d*s;return gradeTrade({arah:sd==1?'LONG':'SHORT',entry:e,sl:e-sd*risk,tp:e+sd*2*risk,t:r.t,due:r.due},src)};
 const a=await one(1),b=await one(-1);
 if(a&&b){r.bm={e,h:a.hasil,R:+a.R.toFixed(3),tx:a.t};r.bi={e,h:b.hasil,R:+b.R.toFixed(3),tx:b.t}}}

// 1) nilai prediksi lama
for(const r of rows.filter(r=>r.hasil==='menunggu')){try{await grade(r)}catch(e){console.log('nilai gagal',r.id,e.message)}}
for(const r of rows.filter(r=>r.fwd&&r.agen===PROTO.agen&&RES(r.hasil)&&!r.bm&&(r.arah==='LONG'||r.arah==='SHORT')&&Number.isFinite(+r.entry))){try{await gradeBase(r)}catch(e){console.log('baseline gagal',r.id,e.message)}}

// 2) prediksi baru (sekali sehari, setelah candle harian tutup)
const FUN='data/funnel.json';
const hr=new Date().getUTCHours();
if(process.env.FORCE||(hr>=1&&hr<=5)){
 const t=await bj('ticker/24hr');
 const top=t.filter(x=>x.symbol.endsWith('USDT')&&!NOT.test(x.symbol.slice(0,-4))).sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,40);
 const rej={},scan=async(sym,ctx)=>{try{const sc=scanInput(await kl(sym+'USDT'));return {s:sym,...feat(sc.bars,sc.qv,ctx)}}catch(e){bumpCount(rej,'data-tidak-valid');if(!/data-tidak-valid|kurang|lengkap/.test(e.message))console.log('scan gagal',sym,e.message);return null}};
 // BTC dulu: rezim BTC adalah gerbang untuk semua altcoin
 const btc=await scan('BTC'),ctx=btcCtx(btc),F40=btc?[btc]:[];
 if(!btc)console.log('PERINGATAN: data BTC tidak valid. Gerbang rezim tidak bisa dihitung, semua altcoin DITOLAK (gagal aman).');
 const alts=top.map(x=>x.symbol.slice(0,-4)).filter(s=>s!=='BTC');
 if(btc)for(let i=0;i<alts.length;i+=8)for(const f of await Promise.all(alts.slice(i,i+8).map(s=>scan(s,ctx))))if(f)F40.push(f);
 const cand=[];
 for(const f of F40){
  if(!f.side){bumpCount(rej,'tanpa-pemicu');continue}
  if(f.ok)cand.push(f);else for(const c of f.rej)bumpCount(rej,c)}
 const sel=selectPortfolio(cand);
 for(const d of sel.dropped)bumpCount(rej,d.why);
 const rs=riskState(rows),sig=[];
 for(const f of sel.picked){
  const blk=activeBlock(rows,f.s,Date.now());if(blk){bumpCount(rej,blk);continue}
  const o={arah:f.side==1?'LONG':'SHORT',entry:f.entry,sl:f.sl,tp:f.tp,alasan:f.why.join(', '),aset:f.s,harga_awal:f.px,t:Date.now(),due:Date.now()+7*DAY},v=validateSignal(o);
  if(!v.ok){bumpCount(rej,'data-tidak-valid');console.log('sinyal ditolak validator',f.s,v.errors.join('; '));continue}
  sig.push(f)}
 const al=alerts(),btcF=F40.find(f=>f.s==='BTC'),cand2=[...(btcF?[btcF]:[]),...sig.filter(f=>f.s!=='BTC').slice(0,5)];
 for(const f of sig)addRow('Aturan Eliz',f.s,{arah:f.side==1?'LONG':'SHORT',entry:f.entry,sl:f.sl,tp:f.tp,alasan:f.why.join(', '),trig:f.trig,score:f.score,grade:f.grade,age:f.age},f.px,al);
 const fu=fs.existsSync(FUN)?JSON.parse(fs.readFileSync(FUN,'utf8')):[];
 if(!fu.some(x=>x.d===today))fu.push({d:today,mesin:ENGINE_VERSION,dipindai:F40.length,kandidat:cand.length,dicatat:sig.length,ditolak:rej,
  btc:btc?{tr:btc.tr,td:btc.td,ret3d:+(btc.ret3d*100).toFixed(2)}:null,proteksi:{level:rs.level,alasan:rs.why},
  dicatat_detail:sig.map(f=>({s:f.s,arah:f.side==1?'LONG':'SHORT',skor:f.score,grade:f.grade,umur:f.age,pemicu:f.trig}))});
 console.log('corong:',JSON.stringify({dipindai:F40.length,kandidat:cand.length,dicatat:sig.length,ditolak:rej}));
 if(rs.level!=='ok')console.log('PROTEKSI RISIKO',rs.level.toUpperCase(),rs.why.join('; '),'(sinyal tetap dicatat untuk forward test; jangan dieksekusi dengan uang nyata)');
 fs.mkdirSync('data',{recursive:true});fs.writeFileSync(FUN,JSON.stringify(fu.slice(-90),null,1));
 const bundle=cand2.map(f=>({aset:f.s,harga:q(f.px),tren_harian:['turun','netral','naik'][f.tr+1],btc_tren:['turun','netral','naik'][(btcF?.tr??0)+1],ema20:q(f.e20),ema50:q(f.e50),rsi14:Math.round(f.rsi),obv_divergence:f.obvDiv,rsi_divergence:f.rsiDiv,range60d_high:q(f.H),range60d_low:q(f.L),posisi_range_pct:Math.round(f.pos*100),fib075:q(f.f75),deviasi_bawah_5h:f.devUp,deviasi_atas_5h:f.devDn,volume24h_usd:Math.round(f.qv)}));
 const px=Object.fromEntries(cand2.map(f=>[f.s,f.px]));
 if(process.env.USE_AI&&bundle.length)for(const[n,a]of Object.entries(AI)){const key=process.env[a.key];if(!key)continue;
  for(const mode of['polos','eliz']){
   try{const txt=await a.run(key,prompt(bundle,al,mode));const j=JSON.parse(txt.slice(txt.indexOf('{'),txt.lastIndexOf('}')+1));
    for(const o of j.hasil||[]){const as=String(o.aset||'').toUpperCase();if(px[as])addRow(`${n} (${mode})`,as,o,px[as],al)}
    console.log(n,mode,'ok')}catch(e){console.log(n,mode,'gagal:',e.message)}
   await sleep(2500)}}
}
fs.mkdirSync('data',{recursive:true});
fs.writeFileSync(F,JSON.stringify(rows,null,1));
try{const g=(await (await fetch('https://api.coingecko.com/api/v3/global',{signal:AbortSignal.timeout(15000)})).json()).data.market_cap_percentage;
 const DF='data/dominance.json',D=fs.existsSync(DF)?JSON.parse(fs.readFileSync(DF,'utf8')):[];
 if(!D.some(x=>x.d===today)){D.push({d:today,btc:+g.btc.toFixed(2),eth:+g.eth.toFixed(2)});fs.writeFileSync(DF,JSON.stringify(D.slice(-400)))}}
catch(e){console.log('dominasi gagal:',e.message)}
console.log('baris:',rows.length);
