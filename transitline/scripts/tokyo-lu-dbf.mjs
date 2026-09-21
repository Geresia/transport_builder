import fs from "fs";
export function* readDbf(path){
  const fd=fs.openSync(path,"r");const h=Buffer.alloc(32);fs.readSync(fd,h,0,32,0);
  const n=h.readUInt32LE(4),hl=h.readUInt16LE(8),rl=h.readUInt16LE(10);
  const f=Buffer.alloc(hl-32);fs.readSync(fd,f,0,hl-32,32);
  const fl=[];let off=1;for(let o=0;f[o]!==0x0d;o+=32){const len=f[o+16];fl.push({name:f.slice(o,o+11).toString("latin1").replace(/\0+$/,""),type:String.fromCharCode(f[o+11]),off,len});off+=len}
  const dec=new TextDecoder("shift_jis");const CH=20000;const buf=Buffer.alloc(rl*CH);
  for(let i=0;i<n;i+=CH){const c=Math.min(CH,n-i);fs.readSync(fd,buf,0,rl*c,hl+i*rl);
    for(let k=0;k<c;k++){const b=k*rl;const r={};for(const x of fl){const s=buf.slice(b+x.off,b+x.off+x.len);r[x.name]=x.type==="N"?parseFloat(s.toString("latin1")):dec.decode(s).trim()}yield r}}
  fs.closeSync(fd);
}
