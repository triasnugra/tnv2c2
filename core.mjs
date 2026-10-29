// Inti aturan CryptoEliz. Dipakai bersama oleh halaman jurnal dan script GitHub Actions.
// v2: setiap setup harus lolos gerbang kualitas SEBELUM dipublikasikan (data valid, tidak usang, masih terjangkau,
// searah rezim BTC, ruang target cukup, skor kualitas). Gerbang ada di feat() supaya live, jurnal, dan backtest
// memakai aturan yang sama persis. Semua ambang ada di CFG agar bisa diaudit dan diuji, bukan tersebar di kode.
export const ENGINE_VERSION='2.0';
export const CFG={
 minQv:1e7,          // volume dolar harian kemarin minimum; di bawah ini slippage dan OBV tidak bisa dipercaya
 slAtrMin:1,         // SL minimal 1x ATR(14) harian; SL lebih ketat dari noise harian dihantam acak
 maxAge:3,           // umur maksimum (hari) sejak candle pemicu untuk deviasi/Monday/DD/Wolf
 maxAgeBreakout:5,   // umur maksimum untuk breakout-retest
 maxDistR:.75,       // harga harus dalam 0.75R dari entry limit, kalau tidak order nyaris tak terisi
 maxDistPct:5,       // dan tidak lebih jauh dari 5% harga
 minTargetR:1,       // target range (sisi seberang) minimal 1R dari entry
 btcKnife:.05,       // BTC bergerak >5% dalam 3 hari melawan arah setup: jangan menangkap pisau jatuh
 minScore:60,        // skor kualitas minimum (0-100) untuk dipublikasikan
 gradeA:75,          // skor >= ini = grade A
 perSide:3,          // maks sinyal baru per arah per hari
 maxTotal:5,         // maks sinyal baru per hari
 clusterN:6,         // >= N kandidat searah di hari yang sama = peristiwa pasar tunggal, bukan N peluang
 clusterKeep:2,      // pada klaster seperti itu hanya N teratas yang diambil
 cooldownDays:3,     // jeda untuk koin yang sama setelah SL
};
export const REJ_TEXT={
 'tanpa-pemicu':'tidak ada pemicu','sl-lebar':'SL melebihi batas','usang-umur':'pemicu sudah terlalu lama','usang-tp-tercapai':'harga sudah mencapai TP sejak pemicu',
 'usang-sl-tertembus':'SL sudah tertembus sejak pemicu','usang-sudah-berjalan':'entry sudah tersentuh dan harga sudah berjalan 1R','jauh-dari-entry':'harga terlalu jauh dari entry',
 'melawan-btc':'melawan tren BTC (weekly dan daily)','btc-momentum-lawan':'BTC bergerak tajam melawan arah setup','likuiditas-rendah':'likuiditas terlalu rendah',
 'ruang-target-sempit':'ruang menuju target range sempit','skor-rendah':'skor kualitas di bawah minimum','data-tidak-valid':'data kline tidak valid',
 'duplikat-aktif':'setup yang sama masih aktif','cooldown-sl':'koin baru kena SL (jeda)','klaster-pasar':'klaster searah, hanya terbaik yang diambil','batas-portofolio':'melewati batas sinyal per hari'};
// Validasi kline harian SEBELUM dihitung. Data cacat harus ditolak di pintu masuk, bukan menghasilkan setup palsu.
export function checkBars(k,span=130){
 if(!Array.isArray(k)||!k.length)throw new Error('data-tidak-valid: kline kosong');
 const s=k.slice(-span);
 for(let i=0;i<s.length;i++){const q=s[i];
  if(!q||![q.t,q.o,q.h,q.l,q.c,q.v].every(Number.isFinite))throw new Error('data-tidak-valid: nilai bukan angka');
  if(!(q.o>0&&q.h>0&&q.l>0&&q.c>0))throw new Error('data-tidak-valid: harga nol atau negatif');
  if(q.h<Math.max(q.o,q.c,q.l)-1e-12||q.l>Math.min(q.o,q.c,q.h)+1e-12)throw new Error('data-tidak-valid: high/low tidak konsisten');
  if(i&&q.t-s[i-1].t!==864e5)throw new Error('data-tidak-valid: candle harian bolong atau tidak berurutan');}
 return true}
// Konteks rezim BTC untuk menyaring altcoin. Dihitung dari hasil feat(BTC) yang sama persis di live dan backtest.
export const btcCtx=b=>b&&Number.isFinite(b.tr)?{tr:b.tr,td:b.td,ret1d:b.ret1d,ret3d:b.ret3d,ret7d:b.ret7d}:undefined;
// Pemilihan portofolio harian: 18 sinyal LONG di hari yang sama bukan 18 peluang, melainkan SATU taruhan pada arah pasar.
export function selectPortfolio(c,cfg=CFG){
 const ok=c.filter(r=>r.ok).sort((a,b)=>b.score-a.score||a.dist-b.dist),picked=[],dropped=[],n={1:0,'-1':0},tot={1:ok.filter(r=>r.side==1).length,'-1':ok.filter(r=>r.side==-1).length};
 for(const r of ok){const cl=tot[r.side]>=cfg.clusterN,cap=cl?cfg.clusterKeep:cfg.perSide;
  if(n[r.side]>=cap||picked.length>=cfg.maxTotal){dropped.push({r,why:cl&&n[r.side]>=cap?'klaster-pasar':'batas-portofolio'});continue}
  picked.push(r);n[r.side]++}
 return{picked,dropped}}
const HOSTS=['https://data-api.binance.vision','https://api.binance.com','https://api1.binance.com','https://api2.binance.com'];
let hi=0;
export async function bj(p){let e;for(let t=0;t<HOSTS.length;t++){const h=HOSTS[(hi+t)%HOSTS.length];
 try{const r=await fetch(h+'/api/v3/'+p,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(h+' HTTP '+r.status);hi=(hi+t)%HOSTS.length;return await r.json()}catch(x){e=x}}throw e}
export const kl=async s=>(await bj(`klines?symbol=${s}&interval=1d&limit=1000`)).map(a=>({t:a[0],o:+a[1],h:+a[2],l:+a[3],c:+a[4],v:+a[5]}));
export const NOT=/^(USDC|FDUSD|TUSD|USDP|DAI|BUSD|EUR|AEUR|USD1|XUSD|PAXG|USDE|PYUSD|U|USDS|USDD|RLUSD|BFUSD|USDG)$/;
// Tanggal keputusan FOMC 2026 (hari ke-2). WAJIB diverifikasi di federalreserve.gov
const FOMC=['2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09'];
const HOL=['12-24','12-25','12-26','12-31','01-01'];
const ema=(a,n)=>{const k=2/(n+1);let e=a[0];return a.map(v=>e=v*k+e*(1-k))};
const rsi=(c,n=14)=>{let g=0,l=0;return c.map((v,i)=>{if(!i)return null;const d=v-c[i-1],u=Math.max(d,0),w=Math.max(-d,0);if(i<=n){g+=u/n;l+=w/n}else{g=(g*(n-1)+u)/n;l=(l*(n-1)+w)/n}return i<n?null:100-100/(1+g/(l||1e-9))})};
const obv=k=>{let o=0;return k.map((x,i)=>{if(i)o+=x.c>k[i-1].c?x.v:x.c<k[i-1].c?-x.v:0;return o})};
function div(p,d){const n=p.length,ix=(a,b,f)=>{let j=a;for(let i=a;i<b;i++)if(f(p[i],p[j]))j=i;return j};
 const l1=ix(n-15,n,(v,m)=>v<m),l0=ix(n-30,n-15,(v,m)=>v<m),h1=ix(n-15,n,(v,m)=>v>m),h0=ix(n-30,n-15,(v,m)=>v>m);
 if(p[l1]<p[l0]&&d[l1]>d[l0])return 1;if(p[h1]>p[h0]&&d[h1]<d[h0])return -1;return 0}
const sgn=(p,a,b)=>p>b&&a>b?1:p<b&&a<b?-1:0;

// ctx (opsional) = btcCtx(feat(BTC)). Tanpa ctx (BTC sendiri, uji unit) gerbang rezim BTC tidak dipakai.
export function feat(k,qv,ctx){
 const x=k.slice(0,-1),c=x.map(q=>q.c),n=x.length,px=k.at(-1).c;
 if(n<120)throw new Error('data kurang dari 120 hari');
 checkBars(k);
 const last=(a,b,f)=>{for(let i=b-1;i>=a;i--)if(f(x[i]))return i;return -1},first=(a,b,f)=>{for(let i=a;i<b;i++)if(f(x[i]))return i;return -1};
 const E20=ema(c,20)[n-1],E50=ema(c,50)[n-1],td=sgn(px,E20,E50);
 // tren weekly: agregasi dari candle harian (minggu mulai Senin UTC), EMA20/50
 const wm=new Map();for(const q of x){const i=Math.floor((q.t-4*864e5)/(7*864e5)),o=wm.get(i)||{l:1e18,h:0};wm.set(i,{c:q.c,l:Math.min(o.l,q.l),h:Math.max(o.h,q.h)})}
 const wv=[...wm.values()].slice(0,-1),wc=wv.map(w=>w.c),m=wc.length,wlow=Math.min(...wv.slice(-26).map(w=>w.l)),whigh=Math.max(...wv.slice(-26).map(w=>w.h));let tw=0,flip=false;
 if(m>=55){const a=ema(wc,20),b=ema(wc,50);tw=sgn(px,a[m-1],b[m-1]);flip=sgn(wc[m-4],a[m-4],b[m-4])!==sgn(wc[m-1],a[m-1],b[m-1])}
 const tr=m>=55?tw:td; // tren makro: weekly bila data cukup
 const R=rsi(c),dO=div(c,obv(x)),dR=div(c,R);
 const pr=x.slice(n-65,n-5),H=Math.max(...pr.map(q=>q.h)),L=Math.min(...pr.map(q=>q.l)),rec=x.slice(n-5);
 const pos=(px-L)/(H-L),mid=pos>.3&&pos<.7,flat=(H-L)/L<.06;
 // zona demand/supply = kotak setebal 0.6 ATR dari tepi range (maks 1/4 range)
 const atr=x.slice(n-14).reduce((s,q,i,a)=>s+Math.max(q.h-q.l,i?Math.abs(q.h-a[i-1].c):0,i?Math.abs(q.l-a[i-1].c):0),0)/14,bd=Math.min(.6*atr,(H-L)/4),zs={a:L,b:L+bd},zr={a:H-bd,b:H};
 const devUp=px>L&&rec.some(q=>q.l<L&&q.c>L),devDn=px<H&&rec.some(q=>q.h>H&&q.c<H);
 const boUp=x.slice(n-10).some(q=>q.c>H)&&px>H&&px<H*1.03,boDn=x.slice(n-10).some(q=>q.c<L)&&px<L&&px>L*.97;
 const w=x.slice(n-60),hh=Math.max(...w.map(q=>q.h)),lo=Math.min(...w.map(q=>q.l));
 const f75=tr>=0?hh-.75*(hh-lo):lo+.75*(hh-lo),nf=Math.abs(px-f75)/px<.03;
 // Monday High/Low: candle harian Senin UTC terakhir (<=7 hari), jadi level kunci sepanjang minggu
 let mI=-1;for(let i=n-1;i>=n-7;i--)if(new Date(x[i].t).getUTCDay()===1){mI=i;break}
 const cur=k.at(-1),monL=mI>=0?x[mI].l:null,monH=mI>=0?x[mI].h:null;
 const mDevUp=mI>=0&&px>monL&&(x.slice(mI+1).some(q=>q.l<monL&&q.c>monL)||cur.l<monL),mDevDn=mI>=0&&px<monH&&(x.slice(mI+1).some(q=>q.h>monH&&q.c<monH)||cur.h>monH);
 // pivot +-3 hari (90 hari terakhir) untuk Three Tap dan Wolf
 const hs=x.map(q=>q.h),ls=x.map(q=>q.l);
 const pv=(a,i,hi)=>{for(let j=i-3;j<=i+3;j++)if(j!==i&&(hi?a[j]>a[i]:a[j]<a[i]))return false;return true};
 const PH=[],PL=[];for(let i=n-90;i<n-3;i++){if(pv(hs,i,1))PH.push(i);if(pv(ls,i,0))PL.push(i)}
 const tl=(P,a_,desc)=>{if(P.length<2)return null;const a=P.at(-2),b=P.at(-1);if(b-a<5||(desc?a_[b]>=a_[a]:a_[b]<=a_[a]))return null;return{a,av:a_[a],sl:(a_[b]-a_[a])/(b-a)}};
 const TH=tl(PH,hs,1),TL=tl(PL,ls,0),ln=(T,i)=>T.av+T.sl*(i-T.a);
 const brk=(T,a_,up)=>!!T&&[0,1,2,3,4].some(j=>up?a_[n-1-j]>ln(T,n-1-j):a_[n-1-j]<ln(T,n-1-j));
 const wDn=brk(TH,hs,1)&&px<ln(TH,n)&&c[n-1]<ln(TH,n-1),wUp=brk(TL,ls,0)&&px>ln(TL,n)&&c[n-1]>ln(TL,n-1);
 const tL=PL.filter(i=>i>=n-65&&i<n-5&&ls[i]<=L*1.02).length,tH=PH.filter(i=>i>=n-65&&i<n-5&&hs[i]>=H*.98).length;
 // Double Deviation (diagram Eliz): 2 sweep di luar level, sweep ke-2 lebih dangkal, keduanya reclaim, sweep ke-2 dalam 10 hari
 const Zs=Math.min(...c.slice(n-90)),Zh=Math.max(...c.slice(n-90));
 const swp=(a_,z,up)=>{const S=[];for(let i=n-60;i<n;i++)if(up?a_[i]<z*.998&&c[i]>z:a_[i]>z*1.002&&c[i]<z)if(!S.length||i-S.at(-1)>=3)S.push(i);return S};
 const sU=swp(ls,Zs,1),sD=swp(hs,Zh,0);
 const ddUp=sU.length>=2&&sU.at(-1)>=n-10&&ls[sU.at(-1)]>ls[sU.at(-2)]&&px>Zs,ddDn=sD.length>=2&&sD.at(-1)>=n-10&&hs[sD.at(-1)]<hs[sD.at(-2)]&&px<Zh;
 // retest langsung di zona kuat (2+ sentuhan, searah tren) tanpa menunggu deviasi
 const zUp=tr==1&&tL>=2&&px>=L&&px<=L+bd*1.5&&!devUp,zDn=tr==-1&&tH>=2&&px<=H&&px>=H-bd*1.5&&!devDn;
 const tags=[];
 if(devUp)tags.push(tL>=2?'Three Tap':'Deviasi bawah');if(devDn)tags.push(tH>=2?'Three Top':'Deviasi atas');
 if(boUp||boDn)tags.push('Breakout-retest');if(ddUp||ddDn)tags.push('Double Deviation');if(zUp||zDn)tags.push('Retest zona kuat');if(mDevUp)tags.push('Sweep Monday Low');if(mDevDn)tags.push('Sweep Monday High');if(wDn)tags.push('Wolf bearish');if(wUp)tags.push('Wolf bullish');
 const lw=[],sw=[];
 if(ddUp)lw.push('Double Deviation: sweep ke-2 lebih dangkal, tekanan jual melemah');if(zUp)lw.push('retest zona demand kuat (2+ sentuhan, searah tren)');if(devUp)lw.push(tL>=2?'Three Tap: 2 sentuhan lalu manipulasi di bawah':'deviasi bawah lalu recovery');if(mDevUp)lw.push('sweep Monday Low lalu reclaim');if(boUp)lw.push('breakout ber-close, retest');if(wUp)lw.push('Wolf bullish: breakdown trendline gagal');if(tr==1&&nf)lw.push('Fib 0.75 tren naik');
 if(ddDn)sw.push('Double Deviation: sweep ke-2 lebih dangkal, tekanan beli melemah');if(zDn)sw.push('retest zona supply kuat (2+ sentuhan, searah tren)');if(devDn)sw.push(tH>=2?'Three Top: 2 sentuhan lalu manipulasi di atas':'deviasi atas gagal bertahan');if(mDevDn)sw.push('sweep Monday High lalu reclaim');if(boDn)sw.push('breakdown ber-close, retest');if(wDn)sw.push('Wolf: breakout trendline gagal');if(tr==-1&&nf)sw.push('Fib 0.75 tren turun');
 let side=0,why=[];
 if(lw.length&&(!sw.length||lw.length>sw.length)){side=1;why=lw}else if(sw.length){side=-1;why=sw}
 // Melawan tren makro hanya boleh lewat pemicu pembalikan DAN dikonfirmasi divergensi OBV/RSI (Eliz: divergensi = konfirmasi).
 // v1 membolehkan sweep Monday saja; di jurnal 14-28 Okt itu menyumbang 59 dari 81 SL (LONG saat tren turun).
 const rev=side==1?devUp||boUp||wUp||mDevUp||ddUp:devDn||wDn||mDevDn||ddDn,ct=side&&side==-tr;
 if(ct&&!(rev&&(dO==side||dR==side)))side=0;
 if(side&&mid&&!(side==1?devUp||mDevUp||ddUp:devDn||mDevDn||ddDn))side=0;if(flat)side=0;
 const r={px,tr,td,tw,m,flip,e20:E20,e50:E50,atr,rsi:R[n-1],obvDiv:dO,rsiDiv:dR,ret1d:c[n-1]/c[n-2]-1,ret3d:c[n-1]/c[n-4]-1,ret7d:c[n-1]/c[n-8]-1,ret30:px/c[n-30]-1,tags,k:k.slice(-90),off:k.length-90,H,L,zs,zr,wlow,whigh,monL,monH,pos,mid,flat,devUp,devDn,boUp,boDn,f75,qv,side,ok:false,rej:[],score:0,grade:'-',watch:false};
 if(!side)r.rej=['tanpa-pemicu'];
 if(side){
  const nConf=why.length;
  if(dO==side)why.push('OBV divergence');if(dR==side)why.push('RSI divergence');if(tr==side)why.push('searah tren');
  const trig=side==1?(ddUp?'dd':devUp?'dev':mDevUp?'mon':zUp?'zone':boUp?'bo':wUp?'wolf':'fib'):(ddDn?'dd':devDn?'dev':mDevDn?'mon':zDn?'zone':boDn?'bo':wDn?'wolf':'fib');
  const lvl=side==1?(ddUp?Zs:devUp?L:mDevUp?monL:zUp?L+bd:boUp?H:wUp?ln(TL,n):f75):(ddDn?Zh:devDn?H:mDevDn?monH:zDn?H-bd:boDn?L:wDn?ln(TH,n):f75);
  const entry=side==1?Math.min(lvl,px):Math.max(lvl,px); // limit di level retest, bukan kejar harga
  let sl=trig=='fib'?entry*(1-side*.05):trig=='dd'?(side==1?ls[sU.at(-1)]*.995:hs[sD.at(-1)]*1.005):trig=='zone'?(side==1?L*.99:H*1.01):side==1?Math.min(...rec.map(q=>q.l),cur.l)*.995:Math.max(...rec.map(q=>q.h),cur.h)*1.005;
  sl=side==1?Math.min(sl,entry*.97):Math.max(sl,entry*1.03);
  sl=side==1?Math.min(sl,entry-CFG.slAtrMin*atr):Math.max(sl,entry+CFG.slAtrMin*atr); // lantai noise: SL tidak boleh lebih ketat dari 1 ATR harian
  const risk=Math.abs(entry-sl),slp=risk/entry*100,tp=entry+side*2*risk,t2=side==1?H:L,dist=Math.abs(px-entry)/px*100,tgtR=Math.abs(t2-entry)/risk;
  const type=slp<=5?'scalping':slp<=15?'swing':slp<=30&&tgtR>=3?'spot (SL lebar)':'ditolak';
  if(trig=='wolf'){const T=side==1?TL:TH;r.tl={a:T.a,av:T.av,sl:T.sl,e:n}}
  // ---- umur setup: candle pemicu (indeks di x). null = tanpa peristiwa (zona kuat, Fib), selalu "segar" ----
  const wev=(T,a_,up)=>{let m=-1;for(let j=0;j<5;j++)if(up?a_[n-1-j]>ln(T,n-1-j):a_[n-1-j]<ln(T,n-1-j))m=j;return m<0?null:n-1-m};
  let ev=null;
  if(trig=='dd')ev=side==1?sU.at(-1):sD.at(-1);
  else if(trig=='dev')ev=side==1?last(n-5,n,q=>q.l<L&&q.c>L):last(n-5,n,q=>q.h>H&&q.c<H);
  else if(trig=='mon'){const i=side==1?last(mI+1,n,q=>q.l<monL&&q.c>monL):last(mI+1,n,q=>q.h>monH&&q.c<monH);ev=i<0?null:i}
  else if(trig=='bo'){const i=side==1?first(n-10,n,q=>q.c>H):first(n-10,n,q=>q.c<L);ev=i<0?null:i}
  else if(trig=='wolf')ev=side==1?wev(TL,ls,0):wev(TH,hs,1);
  const age=ev==null?0:n-ev,rej=[];
  // ---- gerbang v2. Urutan = urutan alasan penolakan yang dilaporkan ----
  if(type=='ditolak')rej.push('sl-lebar');
  if(ev!=null){
   const seg=x.slice(ev+1),hi=Math.max(px,...seg.map(q=>q.h)),lo=Math.min(px,...seg.map(q=>q.l));
   if(age>(trig=='bo'?CFG.maxAgeBreakout:CFG.maxAge))rej.push('usang-umur');
   // Penyebab utama setup "EXPIRED": harga sudah menyentuh TP 2-3 hari SEBELUM setup dipublikasikan.
   if(side==1?hi>=tp:lo<=tp)rej.push('usang-tp-tercapai');
   // Tesis manipulasi gugur bila harga menembus ujung wick pemicu (bukan sekadar SL yang ikut bergeser ke low terbaru).
   const inv=trig=='dev'||trig=='mon'||trig=='dd'?(side==1?x[ev].l:x[ev].h):sl;
   if(side==1?lo<inv:hi>inv)rej.push('usang-sl-tertembus');
   const jt=seg.findIndex(q=>side==1?q.l<=entry:q.h>=entry);
   if(jt>=0){const af=seg.slice(jt),run=side==1?Math.max(...af.map(q=>q.h)):Math.min(...af.map(q=>q.l));if(side==1?run>=entry+risk:run<=entry-risk)rej.push('usang-sudah-berjalan')}}
  if(dist>Math.min(CFG.maxDistR*slp,CFG.maxDistPct))rej.push('jauh-dari-entry');
  if(ctx&&Number.isFinite(ctx.tr)){
   if(ctx.tr==-side&&ctx.td==-side)rej.push('melawan-btc');
   if(side*ctx.ret3d<=-CFG.btcKnife)rej.push('btc-momentum-lawan')}
  if(!(qv>=CFG.minQv))rej.push('likuiditas-rendah');
  if(tgtR<CFG.minTargetR)rej.push('ruang-target-sempit');
  // ---- skor kualitas 0-100 (heuristik; belum dikalibrasi, kalibrasinya ada di tabel per grade di report backtest) ----
  let sc=30;
  sc+=ct?-10:tr==side?15:0;
  if(ctx&&Number.isFinite(ctx.tr))sc+=ctx.tr==side?10:ctx.tr==-side||ctx.td==-side?-10:0;
  sc+=(dO==side?8:0)+(dR==side?8:0)+Math.min(12,Math.max(0,nConf-1)*4);
  sc+=ev==null?5:age<=1?10:age==2?5:0;
  sc+=tgtR>=3?10:tgtR>=2?5:0;
  sc+=(side==1?pos<.25:pos>.75)?8:0;
  sc+=qv>=1e8?6:qv>=3e7?3:qv<2e7?-5:0;
  sc+=risk/atr<=2.5?5:0;
  sc=Math.max(0,Math.min(100,Math.round(sc)));
  if(sc<CFG.minScore)rej.push('skor-rendah');
  // "hampir setup": satu-satunya kekurangannya harga belum dekat entry. Boleh dipantau, tidak boleh dicatat sebagai sinyal.
  const watch=rej.length==1&&rej[0]=='jauh-dari-entry';
  Object.assign(r,{why,trig,entry,sl,slp,tp,t2,dist,tgtR,slAtr:risk/atr,ev,age,ct:!!ct,score:sc,grade:sc>=CFG.gradeA?'A':sc>=CFG.minScore?'B':'C',rej,ok:!rej.length,watch,type:rej.length?'ditolak':type,type0:type})}
 return r}

export function alertList(){const d=new Date(),iso=d.toISOString().slice(0,10),md=iso.slice(5),dw=d.getUTCDay(),tm=new Date(+d+864e5),A=[];
 if(FOMC.includes(iso)||FOMC.includes(tm.toISOString().slice(0,10)))A.push(['y','FOMC hari ini atau besok: berita memicu noise. Eliz tetap hanya trading bila ada trigger jelas.','Verifikasi tanggal di federalreserve.gov']);
 if(tm.getUTCMonth()!=d.getUTCMonth())A.push(['r','Hari terakhir bulan. Penutupan bulanan 00:00 UTC.','']);
 if(dw==0)A.push(['y','Menjelang penutupan weekly (Senin 00:00 UTC).','']);
 if(HOL.includes(md))A.push(['r','Libur panjang, volume tipis. Banyak bot dan flash dump.','']);
 if(dw==1)A.push(['y','Senin: Monday range sedang terbentuk, harga cenderung kotor. Tunggu. Monday Low/High jadi level kunci minggu ini.','Dari video dan tweet']);
 return A}

// Konfirmasi timeframe rendah: retest tertahan di 4H, dan batal bila close 12H melewati SL
export async function conf(r){
 const raw=async iv=>await bj(`klines?symbol=${r.s}USDT&interval=${iv}&limit=30`),g=async iv=>(await raw(iv)).slice(0,-1).map(a=>({h:+a[2],l:+a[3],c:+a[4]}));
 const [a,b,fr]=await Promise.all([g('4h'),g('12h'),raw('1h')]),s=r.side,c4=a.at(-1).c,c12=b.at(-1).c;
 // pengecekan live sejak 00:00 UTC: setup yang sudah usang atau gugur setelah scan harian tidak boleh tetap tampil "aktif"
 const t0=Math.floor(Date.now()/864e5)*864e5,td=fr.filter(q=>+q[0]>=t0),hiN=Math.max(...td.map(q=>+q[2]),-Infinity),loN=Math.min(...td.map(q=>+q[3]),Infinity);
 if(s==1?hiN>=r.tp:loN<=r.tp)return['bad','BATAL: harga sudah menyentuh TP hari ini (setup usang)'];
 if(s==1?loN<=r.sl:hiN>=r.sl)return['bad','BATAL: harga sudah menembus SL hari ini'];
 if(s==1?c12<r.sl:c12>r.sl)return['bad','BATAL: close 12H melewati SL'];
 const held=a.slice(-8).some(q=>s==1?q.l<=r.entry*1.003&&q.c>r.entry:q.h>=r.entry*.997&&q.c<r.entry);
 if(s==1?c4>r.entry:c4<r.entry)return held?['ok','Retest tertahan di 4H']:['wait','Di sisi benar level, belum retest'];
 return['wait','Tunggu close 4H '+(s==1?'di atas':'di bawah')+' level']}

// Satu-satunya jalur masukan untuk feat(), dipakai live (jurnal & halaman) dan sama persis dengan backtest.
// k = kline harian Binance, candle terakhir boleh masih berjalan. Hasilnya:
//  - bars: 999 candle harian yang sudah TUTUP + satu candle sintetis hari ini berisi HARGA OPEN saja.
//    Keputusan dibuat dari open hari itu, sehingga tidak bergantung pada jam scan (01-05 UTC) atau pada
//    high/low hari ini yang belum selesai.
//  - qv: volume dolar harian kemarin (volume x close), bukan volume 24 jam bergulir.
export function scanInput(k,now=Date.now()){
 const closed=k.filter(q=>q.t+864e5<=now),forming=k.find(q=>q.t+864e5>now),last=closed.at(-1);
 if(!last||!forming)throw new Error('kline tidak lengkap untuk scan');
 if(forming.t-last.t!==864e5)throw new Error('data-tidak-valid: candle hari ini tidak menyambung dengan candle kemarin');
 const o=forming.o;
 return {bars:[...closed.slice(-999),{t:forming.t,o,h:o,l:o,c:o,v:0}],qv:last.v*last.c};
}
