import fs from "fs";
import pc from "polygon-clipping";

// 전국 1km 격자 → 행정동 클리핑. 출력은 **집계구판(oa_kr_clip.json)과 같은 포맷**이라
// 페이지의 상세 패널을 그대로 재사용한다. 격자는 공공데이터포털 15141768,
// 이용허락범위 제한 없음 → 상업 배포 가능. (집계구는 비영리 연구 한정이라 배포판에 못 씀)

const A=6378137,F_=1/298.257222101,E2=F_*(2-F_);
const LAT0=38*Math.PI/180,LON0=127.5*Math.PI/180,K0=0.9996,X0=1e6,Y0=2e6,e1sq=E2/(1-E2);
const Mf=p=>A*((1-E2/4-3*E2*E2/64-5*E2**3/256)*p-(3*E2/8+3*E2*E2/32+45*E2**3/1024)*Math.sin(2*p)
  +(15*E2*E2/256+45*E2**3/1024)*Math.sin(4*p)-(35*E2**3/3072)*Math.sin(6*p));
const M0=Mf(LAT0),e1=(1-Math.sqrt(1-E2))/(1+Math.sqrt(1-E2));
function invTM(x,y){
  const mu=(M0+(y-Y0)/K0)/(A*(1-E2/4-3*E2*E2/64-5*E2**3/256));
  const p1=mu+(3*e1/2-27*e1**3/32)*Math.sin(2*mu)+(21*e1*e1/16-55*e1**4/32)*Math.sin(4*mu)
        +(151*e1**3/96)*Math.sin(6*mu)+(1097*e1**4/512)*Math.sin(8*mu);
  const s=Math.sin(p1),c=Math.cos(p1),t=Math.tan(p1),C1=e1sq*c*c,T1=t*t;
  const N1=A/Math.sqrt(1-E2*s*s),R1=A*(1-E2)/Math.pow(1-E2*s*s,1.5),D=(x-X0)/(N1*K0);
  const lat=p1-(N1*t/R1)*(D*D/2-(5+3*T1+10*C1-4*C1*C1-9*e1sq)*D**4/24
        +(61+90*T1+298*C1+45*T1*T1-252*e1sq-3*C1*C1)*D**6/720);
  const lon=LON0+(D-(1+2*T1+C1)*D**3/6+(5-2*C1+28*T1-3*C1*C1+8*e1sq+24*T1*T1)*D**5/120)/c;
  return [lon*180/Math.PI,lat*180/Math.PI];
}
{ const [lo,la]=invTM(X0,Y0);
  if(Math.abs(lo-127.5)>1e-9||Math.abs(la-38)>1e-9) throw new Error("역TM 검산 실패"); }

// ---------- 타일 원점 (SHP 헤더 bytes 36/44) ----------
const TMP="gridtmp";
const tileXY={};
for(const f of fs.readdirSync(TMP).filter(x=>x.endsWith(".shp"))){
  const b=fs.readFileSync(`${TMP}/${f}`);
  tileXY[f.replace(/^grid_|\.shp$/g,"")]=[b.readDoubleLE(36), b.readDoubleLE(44)];
}
console.error("타일",Object.keys(tileXY).length,"개");

// ---------- 인구 CSV (EUC-KR, long format) ----------
const pop=new Map();
for(const f of fs.readdirSync(TMP).filter(x=>x.startsWith("pop_"))){
  const lines=new TextDecoder("euc-kr").decode(fs.readFileSync(`${TMP}/${f}`)).split("\n");
  for(let i=1;i<lines.length;i++){
    const p=lines[i].split(","); if(p.length<4) continue;
    const item=p[2].replace(/"/g,"").trim();
    if(!item.startsWith("in_age_")) continue;
    if(+item.slice(7)>22) continue;                 // 031~052 = 여자(중복)
    const code=p[1].replace(/"/g,"").trim();
    pop.set(code,(pop.get(code)||0)+(parseFloat(p[3])||0));
  }
}
console.error("격자 칸(원본)",pop.size);

// ---------- 칸 지오메트리 ----------
const cells=[];
let noTile=0;
for(const [code,p] of pop){
  if(p<=0) continue;
  const t=code.slice(0,2), cc=+code.slice(2,4), rr=+code.slice(4,6);
  const o=tileXY[t]; if(!o){ noTile++; continue; }
  const gx=(o[0]/1000)+cc, gy=(o[1]/1000)+rr;
  const ring=[invTM(gx*1000,gy*1000),invTM(gx*1000+1000,gy*1000),
              invTM(gx*1000+1000,gy*1000+1000),invTM(gx*1000,gy*1000+1000)];
  ring.push(ring[0]);
  cells.push({ pop:p, ring });
}
console.error("인구 있는 칸",cells.length,"| 타일 미매칭",noTile,
  "| 인구합",Math.round(cells.reduce((a,c)=>a+c.pop,0)).toLocaleString());

// ---------- 공간 인덱스 ----------
const CB=0.05, hash=new Map();
cells.forEach((c,i)=>{
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const p of c.ring){ if(p[0]<x0)x0=p[0]; if(p[0]>x1)x1=p[0]; if(p[1]<y0)y0=p[1]; if(p[1]>y1)y1=p[1]; }
  c.bb=[x0,y0,x1,y1];
  for(let bx=Math.floor(x0/CB);bx<=Math.floor(x1/CB);bx++)
    for(let by=Math.floor(y0/CB);by<=Math.floor(y1/CB);by++){
      const k=bx+","+by; if(!hash.has(k)) hash.set(k,[]); hash.get(k).push(i);
    }
});

function areaKm2(rings){
  let tot=0;
  rings.forEach((ring,ri)=>{
    const lat0=ring.reduce((s,p)=>s+p[1],0)/ring.length;
    const kx=111.320*Math.cos(lat0*Math.PI/180), ky=110.574;
    let s=0;
    for(let i=0;i<ring.length-1;i++) s+=ring[i][0]*kx*ring[i+1][1]*ky-ring[i+1][0]*kx*ring[i][1]*ky;
    tot+=Math.abs(s/2)*(ri===0?1:-1);
  });
  return Math.abs(tot);
}
const rnd=n=>Math.round(n*1e4)/1e4;
const EPS=0.0004;                                    // 칸 경계는 동 윤곽선이 따로 그려지므로 세게 솎는다
function thin(r){
  if(r.length<=5) return r;
  const o=[r[0]];
  for(let i=1;i<r.length-1;i++){ const a=o[o.length-1],b=r[i];
    if(Math.abs(a[0]-b[0])>=EPS||Math.abs(a[1]-b[1])>=EPS) o.push(b); }
  o.push(r[r.length-1]);
  return o.length>=4?o:r;
}

// ---------- 동별 클리핑 ----------
const F=JSON.parse(fs.readFileSync("korea/metro.json","utf8")).features;
console.error("행정동",F.length);
const MIN_AREA=3;                                    // 3㎢ 미만이면 동이 칸보다 작아 배울 게 없다
const out={}, conc={};
let done=0, small=0, few=0;
F.forEach((f,fi)=>{
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const p of f.g.flat(2)){ if(p[0]<x0)x0=p[0]; if(p[0]>x1)x1=p[0]; if(p[1]<y0)y0=p[1]; if(p[1]>y1)y1=p[1]; }
  const cand=new Set();
  for(let bx=Math.floor(x0/CB);bx<=Math.floor(x1/CB);bx++)
    for(let by=Math.floor(y0/CB);by<=Math.floor(y1/CB);by++)
      for(const i of (hash.get(bx+","+by)||[])) cand.add(i);
  const kept=[];
  for(const i of cand){
    const c=cells[i];
    if(c.bb[2]<x0||c.bb[0]>x1||c.bb[3]<y0||c.bb[1]>y1) continue;
    let inter; try{ inter=pc.intersection([c.ring], f.g); }catch(e){ continue; }
    if(!inter||!inter.length) continue;
    const aIn=areaKm2(inter.flatMap(z=>z));
    if(aIn<0.004) continue;                          // 칸의 0.4% 미만 = 잡티
    const full=areaKm2([c.ring]);
    kept.push({ p:c.pop*Math.min(1,aIn/full), den:c.pop/full, km2:aIn,
                rings: inter.map(z=>z.map(r=>thin(r.map(q=>[rnd(q[0]),rnd(q[1])])))) });
  }
  if(kept.length<3){ few++; return; }
  const raw=kept.reduce((a,c)=>a+c.p,0);
  if(raw<=0){ few++; return; }
  // 격자는 2024, 행정동 인구는 2026-07 → 분포는 격자, 총량은 주민등록에 맞춘다(raking).
  const k=f.p/raw;
  const cs=kept.map(c=>({p:c.p*k, d:c.den*k, km2:c.km2, rings:c.rings}));
  const tot=cs.reduce((a,c)=>a+c.p,0);
  const ed=Math.round(cs.reduce((a,c)=>a+c.p*c.d,0)/tot);
  const byD=[...cs].sort((a,b)=>b.d-a.d);
  const totA=cs.reduce((a,c)=>a+c.km2,0);
  let acc=0,accA=0;
  for(const c of byD){ acc+=c.p; accA+=c.km2; if(acc>=tot/2) break; }
  conc[f.c]={ ed, h:+(100*accA/totA).toFixed(1), n:cs.length };
  if(f.a != null && f.a < MIN_AREA){ small++; return; }   // 지표는 남기고 그림만 생략
  out[f.c]={ cells:cs, o:[Math.floor(x0*1e4), Math.floor(y0*1e4)] };
  if(++done%400===0) console.error("  …",done);
});
console.error(`동 상세 ${Object.keys(out).length} | 지표 ${Object.keys(conc).length} | 3㎢미만 제외 ${small} | 칸부족 ${few}`);

// ---------- varint pack (집계구판과 동일 포맷) ----------
const bytes=[];
const wV=n=>{ n=Math.round(n)>>>0; while(n>=128){ bytes.push((n&127)|128); n>>>=7; } bytes.push(n); };
const wZ=n=>wV((n<<1)^(n>>31));
const index={};
for(const [code,rec] of Object.entries(out)){
  index[code]={ o:rec.o, n:rec.cells.length, gp:Math.round(rec.cells.reduce((a,c)=>a+c.p,0)), at:bytes.length };
  wV(rec.cells.length);
  for(const c of rec.cells){
    wV(c.p); wV(c.d); wV(0);                        // 0 = 지명 없음
    wV(c.rings.length);
    for(const poly of c.rings){
      wV(poly.length);
      for(const ring of poly){
        wV(ring.length);
        let px=0,py=0;
        for(const q of ring){
          const X=Math.round(q[0]*1e4)-rec.o[0], Y=Math.round(q[1]*1e4)-rec.o[1];
          wZ(X-px); wZ(Y-py); px=X; py=Y;
        }
      }
    }
  }
}
fs.writeFileSync("grid_kr_clip.json", JSON.stringify({
  kind:"1km 격자", unit:"인구 격자 1km",
  index, names:[], blob: Buffer.from(Uint8Array.from(bytes)).toString("base64")
}));
fs.writeFileSync("grid_kr_conc.json", JSON.stringify(conc));
console.error("grid_kr_clip.json",(fs.statSync("grid_kr_clip.json").size/1e6).toFixed(2),"MB",
              "| grid_kr_conc.json",(fs.statSync("grid_kr_conc.json").size/1e3).toFixed(0),"KB");

for(const nm of ["남사읍","가평읍","고삼면","울릉읍","목천읍"]){
  const f=F.find(x=>x.n.endsWith(nm)); const c=f&&conc[f.c];
  console.error(c ? `${nm}: ${c.n}칸 | 단순 ${f.d.toLocaleString()} → 유효 ${c.ed.toLocaleString()}/㎢ | 절반이 ${c.h}%`
                  : `${nm}: 없음`);
}
