export type PackedRange={offset:number;vertexBytes:number;indexBytes:number};
export type GeometryPacket={file:string;bytes:number;vertexBytes:number;sha256:string};
export type Bootstrap={file:string;bytes:number;sha256:string};
export function validatePackRanges(parts:{packed?:PackedRange}[],bytes:number){
 if(!Number.isSafeInteger(bytes)||bytes<1||bytes>128*1024*1024)throw Error('Invalid bootstrap size');
 let end=0;
 for(const p of parts){const r=p.packed;
  if(!r||r.offset!==end||![r.offset,r.vertexBytes,r.indexBytes].every(Number.isSafeInteger)||r.vertexBytes<1||r.indexBytes<1)throw Error('Invalid bootstrap range');
  end+=r.vertexBytes+r.indexBytes;if(end>bytes)throw Error('Bootstrap range exceeds file');
 }
 if(end!==bytes)throw Error('Incomplete bootstrap coverage');
}
export function slicePack(bytes:ArrayBuffer,r:PackedRange){
 if(![r.offset,r.vertexBytes,r.indexBytes].every(Number.isSafeInteger)||r.offset<0||r.vertexBytes<1||r.indexBytes<1||r.offset+r.vertexBytes+r.indexBytes>bytes.byteLength)throw Error('Invalid geometry packet range');
 return {vb:bytes.slice(r.offset,r.offset+r.vertexBytes),ib:bytes.slice(r.offset+r.vertexBytes,r.offset+r.vertexBytes+r.indexBytes)};
}
/** Select a refinement using the error of the preceding level, with hysteresis. */
export function selectDetailLevel(errors:number[],retained:(level:number)=>boolean){
 let level=-1;
 for(let i=0;i<errors.length;i++)if(errors[i]>(retained(i)?.7:1))level=i;else break;
 return level;
}
