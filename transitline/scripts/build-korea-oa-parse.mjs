import fs from "fs";

// build_oa.mjs 의 전국판. 차이는 두 가지뿐:
//  1) VIEW bbox 필터 제거 — 108,510개 전부 담는다.
//  2) 결과가 ~190MB 라 JSON.stringify 한 방에 만들지 않고 스트림으로 흘린다.

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

const DIR="sgis/";
const dbf=fs.readFileSync(DIR+"bnd_oa_00_2025_2Q.dbf");
const nrec=dbf.readInt32LE(4), hlen=dbf.readInt16LE(8), rlen=dbf.readInt16LE(10);
const codes=new Array(nrec), admCds=new Array(nrec);
for(let i=0;i<nrec;i++){
  const o=hlen+i*rlen+1;
  admCds[i]=dbf.toString("latin1",o+8,o+16).trim();
  codes[i]=dbf.toString("latin1",o+16,o+36).trim();
}
console.error("집계구 총",nrec,"개 | 예:",admCds[0],codes[0]);

const shp=fs.readFileSync(DIR+"bnd_oa_00_2025_2Q.shp");
console.error("shp",(shp.length/1e6).toFixed(0),"MB 읽음");

const out=fs.createWriteStream("oa_geom_kr.json");
out.write("[");
let off=100, idx=0, kept=0, skippedType=0;
while(off < shp.length){
  const rl = shp.readInt32BE(off+4)*2;
  const body = off+8;
  const type = shp.readInt32LE(body);
  if(type!==5){ skippedType++; off = body+rl; idx++; continue; }

  const nParts=shp.readInt32LE(body+36), nPts=shp.readInt32LE(body+40);
  const partsOff=body+44, ptsOff=partsOff+nParts*4;
  const parts=[]; for(let p=0;p<nParts;p++) parts.push(shp.readInt32LE(partsOff+p*4));
  parts.push(nPts);
  const rings=[]; let areaM2=0, sx=0, sy=0, sn=0;
  for(let p=0;p<nParts;p++){
    const a=parts[p], b=parts[p+1];
    const ringM=[], ringLL=[];
    for(let k=a;k<b;k++){
      const x=shp.readDoubleLE(ptsOff+k*16), y=shp.readDoubleLE(ptsOff+k*16+8);
      ringM.push([x,y]); sx+=x; sy+=y; sn++;
    }
    let s2=0;
    for(let k=0;k<ringM.length-1;k++) s2 += ringM[k][0]*ringM[k+1][1] - ringM[k+1][0]*ringM[k][1];
    areaM2 += s2/2;
    for(const [x,y] of ringM) ringLL.push(invTM(x,y));
    rings.push(ringLL);
  }
  const [cx,cy]=invTM(sx/sn, sy/sn);
  out.write((kept?",":"")+JSON.stringify({
    c:codes[idx], a:admCds[idx], x:+cx.toFixed(6), y:+cy.toFixed(6),
    km2:+(Math.abs(areaM2)/1e6).toFixed(6),
    r:rings.map(r=>r.map(p=>[+p[0].toFixed(5),+p[1].toFixed(5)]))
  }));
  kept++;
  off=body+rl; idx++;
  if(kept%20000===0) console.error("  …담은",kept);
}
out.write("]");
out.end();
out.on("close",()=>{
  console.error("레코드",idx,"| 폴리곤 아닌 것",skippedType,"| 담은 집계구",kept);
  console.error("oa_geom_kr.json",(fs.statSync("oa_geom_kr.json").size/1e6).toFixed(1),"MB");
});
