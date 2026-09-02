import fs from "fs";
import readline from "readline";
import pc from "polygon-clipping";

// build_oa_final.mjs 의 전국판.
//  - 대상 동: dens_data2.json(수도권 1,295) → korea/metro.json(전국 3,558)
//  - 입력 집계구가 342MB 라 통째로 JSON.parse 하지 않고 스트리밍으로 흘려 읽는다.
//    (각 원소에 중첩 객체가 없어서 "},{" 경계로 자르는 게 안전하다)

const F = JSON.parse(fs.readFileSync("korea/metro.json","utf8")).features;
console.error("전국 행정동", F.length);

// ---------- 집계구 총인구 ----------
const pop=new Map();
{
  const rl=readline.createInterface({input:fs.createReadStream("sgis/stat_tot.csv")});
  for await(const l of rl){ const p=l.split(","); if(p[2]==="to_in_001") pop.set(p[1],+p[3]||0); }
}
console.error("집계구 인구 레코드",pop.size);

// ---------- 행정동 공간 인덱스 ----------
const CB=0.05, buckets=new Map(), bbox=[];
F.forEach((f,i)=>{
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const p of f.g.flat(2)){ if(p[0]<x0)x0=p[0]; if(p[0]>x1)x1=p[0]; if(p[1]<y0)y0=p[1]; if(p[1]>y1)y1=p[1]; }
  bbox[i]=[x0,y0,x1,y1];
  for(let bx=Math.floor(x0/CB);bx<=Math.floor(x1/CB);bx++)
    for(let by=Math.floor(y0/CB);by<=Math.floor(y1/CB);by++){
      const k=bx+","+by; if(!buckets.has(k)) buckets.set(k,[]); buckets.get(k).push(i);
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
function thin(r, km2){
  if(r.length<=6) return r;
  const EPS=Math.min(0.0008, Math.max(0.00005, Math.sqrt(Math.max(km2,1e-4))*0.00028));
  const o=[r[0]];
  for(let i=1;i<r.length-1;i++){ const a=o[o.length-1],b=r[i];
    if(Math.abs(a[0]-b[0])>=EPS||Math.abs(a[1]-b[1])>=EPS) o.push(b); }
  o.push(r[r.length-1]);
  return o.length>=4?o:r;
}

// ---------- 집계구 스트리밍 ----------
async function* streamOA(path){
  const st=fs.createReadStream(path,{encoding:"utf8",highWaterMark:1<<22});
  let buf="", started=false;
  for await(const chunk of st){
    buf+=chunk;
    if(!started){ const i=buf.indexOf("{"); if(i<0){ buf=""; continue; } buf=buf.slice(i); started=true; }
    let cut;
    while((cut=buf.indexOf("},{"))>=0){
      yield JSON.parse(buf.slice(0,cut+1));
      buf=buf.slice(cut+2);
    }
  }
  const end=buf.lastIndexOf("}");
  if(end>0) yield JSON.parse(buf.slice(0,end+1));
}

// ---------- 클리핑 ----------
const perDong=new Map();
let clipped=0, orphan=0, seen=0, noPop=0;
for await(const oa of streamOA("oa_geom_kr.json")){
  seen++;
  const p=pop.get(oa.c);
  if(p===undefined){ noPop++; continue; }
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const r of oa.r) for(const q of r){ if(q[0]<x0)x0=q[0]; if(q[0]>x1)x1=q[0]; if(q[1]<y0)y0=q[1]; if(q[1]>y1)y1=q[1]; }
  const cand=new Set();
  for(let bx=Math.floor(x0/CB);bx<=Math.floor(x1/CB);bx++)
    for(let by=Math.floor(y0/CB);by<=Math.floor(y1/CB);by++)
      for(const i of (buckets.get(bx+","+by)||[])) cand.add(i);
  const whole=[oa.r];
  const full=areaKm2(oa.r) || oa.km2;
  let placed=false;
  for(const i of cand){
    const b=bbox[i]; if(x1<b[0]||x0>b[2]||y1<b[1]||y0>b[3]) continue;
    let inter; try{ inter=pc.intersection(whole, F[i].g); }catch(e){ continue; }
    if(!inter||!inter.length) continue;
    const aIn=areaKm2(inter.flatMap(z=>z));
    if(aIn < full*0.05) continue;
    const frac=Math.min(1,aIn/full);
    if(!perDong.has(i)) perDong.set(i,[]);
    perDong.get(i).push({ code:oa.c, pop:p*frac, km2:aIn, den:full>0?p/full:0,
      rings: inter.map(z=>z.map(r=>thin(r.map(q=>[rnd(q[0]),rnd(q[1])]), full))) });
    placed=true; clipped++;
  }
  if(!placed) orphan++;
  if(seen%10000===0) console.error("  …",seen,"| 조각",clipped,"| 동",perDong.size);
}
console.error(`스캔 ${seen} | 인구없음 ${noPop} | 조각 ${clipped} | 미배치 ${orphan} | 동 ${perDong.size}`);

// ---------- raking + 지표 ----------
const out={}, conc={};
let emitted=0, skipped=0;
for(const [di,list] of perDong){
  const f=F[di];
  if(list.length<2){ skipped++; continue; }       // 집계구 1개면 보여줄 내부 분포가 없다
  const raw=list.reduce((a,c)=>a+c.pop,0);
  if(raw<=0){ skipped++; continue; }
  const k=f.p/raw;
  const cells=list.map(c=>({p:c.pop*k, d:c.den*k, km2:c.km2}));
  const tot=cells.reduce((a,c)=>a+c.p,0);
  if(tot<=0){ skipped++; continue; }
  const ed=Math.round(cells.reduce((a,c)=>a+c.p*c.d,0)/tot);
  const byD=[...cells].sort((a,b)=>b.d-a.d);
  const totA=cells.reduce((a,c)=>a+c.km2,0);
  let acc=0,accA=0;
  for(const c of byD){ acc+=c.p; accA+=c.km2; if(acc>=tot/2) break; }
  conc[f.c]={ ed, h:+(100*accA/totA).toFixed(1), n:cells.length };
  out[f.c]={ di, cells, rings:list.map(c=>c.rings), codes:list.map(c=>c.code),
             o:[Math.floor(bbox[di][0]*1e4), Math.floor(bbox[di][1]*1e4)] };
  emitted++;
}
console.error(`동 상세 ${emitted}/${F.length} (${(100*emitted/F.length).toFixed(0)}%) | 제외 ${skipped}`);

// ---------- varint pack ----------
const NAMES = fs.existsSync("oa_names.json") ? JSON.parse(fs.readFileSync("oa_names.json","utf8")) : {};
const nameList=[], nameId=new Map();
const idOf = code => {
  const rec=NAMES[code]; if(!rec) return 0;
  let id=nameId.get(rec.n);
  if(!id){ nameList.push(rec.n); id=nameList.length; nameId.set(rec.n,id); }
  return id;
};
const bytes=[];
const wV=n=>{ n=n>>>0; while(n>=128){ bytes.push((n&127)|128); n>>>=7; } bytes.push(n); };
const wZ=n=>wV((n<<1)^(n>>31));
const index={};
for(const [code,rec] of Object.entries(out)){
  index[code]={ o:rec.o, n:rec.cells.length, gp:Math.round(rec.cells.reduce((a,c)=>a+c.p,0)), at:bytes.length };
  wV(rec.cells.length);
  rec.cells.forEach((c,ci)=>{
    wV(Math.round(c.p)); wV(Math.round(c.d));
    wV(idOf(rec.codes[ci]));
    const polys=rec.rings[ci];
    wV(polys.length);
    for(const poly of polys){
      wV(poly.length);
      for(const ring of poly){
        wV(ring.length);
        let px=0, py=0;
        for(const q of ring){
          const X=Math.round(q[0]*1e4)-rec.o[0], Y=Math.round(q[1]*1e4)-rec.o[1];
          wZ(X-px); wZ(Y-py); px=X; py=Y;
        }
      }
    }
  });
}
fs.writeFileSync("oa_kr_clip.json", JSON.stringify({
  index, names:nameList, blob: Buffer.from(Uint8Array.from(bytes)).toString("base64")
}));
fs.writeFileSync("oa_kr_conc.json", JSON.stringify(conc));
console.error("고유 지명", nameList.length, "| 이름 붙은 동은 수도권뿐(OSM 수집 범위)");
console.error("oa_kr_clip.json",(fs.statSync("oa_kr_clip.json").size/1e6).toFixed(2),"MB",
              "| oa_kr_conc.json",(fs.statSync("oa_kr_conc.json").size/1e3).toFixed(0),"KB");

for(const nm of ["남사읍","천호3동","울릉읍","해운대구 우1동","경주시 황성동","제주시 노형동"]){
  const key=nm.split(" ").pop();
  const f=F.find(x=>x.n.endsWith(key)); const c=f&&conc[f.c];
  console.error(c ? `${key}: 집계구 ${c.n}개 | 단순 ${f.d.toLocaleString()} → 유효 ${c.ed.toLocaleString()}/㎢ | 절반이 ${c.h}%`
                  : `${key}: 상세 없음`);
}
