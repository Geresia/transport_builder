import fs from "fs";
import pc from "polygon-clipping";
const m=JSON.parse(fs.readFileSync("korea/metro.json","utf8"));
const bySido=new Map();
for(const f of m.features){ if(!bySido.has(f.sd)) bySido.set(f.sd,[]); bySido.get(f.sd).push(f); }

// 시도 경계를 하나로 녹인다. 전국 뷰에서 3,558개 동 실선이 보이면 시도가 안 읽힌다.
// 녹인 뒤 표시용으로 한 번 더 성기게(약 0.002° ≈ 200 m) — 전국 축척에선 안 보인다.
const EPS=0.0018;
function thin(r){
  if(r.length<=8) return r;
  const o=[r[0]];
  for(let i=1;i<r.length-1;i++){ const a=o[o.length-1],b=r[i];
    if(Math.abs(a[0]-b[0])>=EPS||Math.abs(a[1]-b[1])>=EPS) o.push(b); }
  o.push(r[r.length-1]);
  return o.length>=4?o:r;
}
const out=[];
for(const [sd,list] of bySido){
  const t=Date.now();
  // martinez 는 한 번에 수백 개를 합칠 때 링을 못 닫고 죽는 일이 있다(서울 강서구
  // 부근에 자기교차 링이 있는 듯). 좌표 반올림으로는 안 고쳐져서, 실패하면 하나씩
  // 누적 병합하며 문제 폴리곤만 따로 빼둔다 — 결과가 27조각에서 몇 조각으로 준다.
  let u;
  const tryUnion=(polys)=>{ try{ return pc.union(...polys); }catch(e){ return null; } };
  u = tryUnion(list.map(f=>f.g));
  if(!u){
    let acc=null; const stray=[];
    for(const f of list){
      if(!acc){ acc=f.g; continue; }
      const r=tryUnion([acc,f.g]);
      if(r) acc=r; else stray.push(f.g);
    }
    u=[...(acc||[]), ...stray.flat()];
    console.error("  ↳",sd,"누적 병합으로 우회 (분리",stray.length,"개)");
  }
  const withD=list.filter(f=>f.d!==null);
  const ds=withD.map(f=>f.d).sort((a,b)=>a-b);
  // 작은 섬 링은 전국 축척에서 점 하나도 안 되므로 버린다 (인구는 그대로 집계).
  // 동 경계를 각자 단순화한 탓에 이웃끼리 정확히 안 맞아, 합치면 실 같은 구멍이
  // 수천 개 생긴다(경기 1,399개). 전국 축척에선 흰 점 노이즈로만 보이므로 작은
  // 구멍은 버리고, 진짜 enclave 급(0.02° ≈ 2km)만 남긴다.
  const bboxOf=(r)=>{let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
    for(const q of r){ if(q[0]<x0)x0=q[0]; if(q[0]>x1)x1=q[0]; if(q[1]<y0)y0=q[1]; if(q[1]>y1)y1=q[1]; }
    return [x1-x0, y1-y0];};
  let dropped=0;
  const rings=u.map(poly=>{
      const keep=[poly[0]];
      for(let i=1;i<poly.length;i++){
        const [dx,dy]=bboxOf(poly[i]);
        if(dx>=0.02||dy>=0.02) keep.push(poly[i]); else dropped++;
      }
      return keep.map(r=>thin(r.map(p=>[+p[0].toFixed(4),+p[1].toFixed(4)])));
    })
               .filter(poly=>{
                 if(poly[0].length<4) return false;
                 const [dx,dy]=bboxOf(poly[0]);
                 return dx>=0.012 || dy>=0.012;
               });
  if(dropped) console.error("  ↳",sd,"실구멍",dropped,"개 제거");
  out.push({ sd, n:list.length, p:list.reduce((a,f)=>a+f.p,0),
             med: ds[ds.length>>1] ?? null, g: rings });
  console.error(sd, list.length+"동", (Date.now()-t)+"ms", rings.length+"폴리곤", rings.flat(2).length+"점");
}
fs.writeFileSync("korea_sido.json", JSON.stringify(out));
console.error("korea_sido.json",(fs.statSync("korea_sido.json").size/1e6).toFixed(2),"MB");
