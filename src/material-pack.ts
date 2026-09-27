import {clearMaterials,type BatchData} from './batch';
export const MAX_PACK_BYTES=2*1024*1024;
export type PackIdentity={sourceDigest:string;layoutDigest:string};
export type MaterialAssignment={elementId:number;family:number;copy:number;baseColor:number[];emission:number;roughness:number;metallic:number};
export type MaterialPack=PackIdentity&{format:'nurender-materials';version:1;colorSpace:'linear-srgb';assignments:MaterialAssignment[]};
export function exportMaterialPack(batch:BatchData,identity:PackIdentity):MaterialPack{
  return {...identity,format:'nurender-materials',version:1,colorSpace:'linear-srgb',assignments:batch.elements.filter(e=>e.material!==0).map(e=>{
    const p=batch.materials.subarray(e.material*8,e.material*8+8);
    return {elementId:e.id,family:e.family,copy:e.copy,baseColor:Array.from(p.subarray(0,3)),emission:p[4],roughness:p[5],metallic:p[6]};
  })};
}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Неверная структура файла материалов');return value as Record<string,unknown>;}
function number(value:unknown,min:number,max:number){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error('Параметр материала вне допустимого диапазона');return value;}
export function validateMaterialPack(value:unknown,batch:BatchData,identity:PackIdentity):MaterialPack{
  const p=object(value);
  if(p.format!=='nurender-materials'||p.version!==1||p.colorSpace!=='linear-srgb')throw new Error('Формат или версия набора материалов не поддерживается');
  if(p.sourceDigest!==identity.sourceDigest)throw new Error('Набор предназначен для другой геометрии сцены');
  if(p.layoutDigest!==identity.layoutDigest)throw new Error('Разбор элементов изменился: набор нельзя назначить безопасно');
  if(!Array.isArray(p.assignments)||p.assignments.length>batch.elements.length)throw new Error('Неверный список назначений');
  const catalog=new Map(batch.elements.map(e=>[e.id,e])),seen=new Set<number>();
  const assignments=p.assignments.map(value=>{
    const a=object(value),id=number(a.elementId,1,65536),e=catalog.get(id);
    if(!e||seen.has(id)||a.family!==e.family||a.copy!==e.copy)throw new Error('Неизвестный, повторный или несовпадающий ID элемента');seen.add(id);
    if(!Array.isArray(a.baseColor)||a.baseColor.length!==3)throw new Error('Неверный базовый цвет');
    return {elementId:id,family:e.family,copy:e.copy,baseColor:a.baseColor.map(x=>number(x,0,1)),emission:number(a.emission,0,2),roughness:number(a.roughness,.05,1),metallic:number(a.metallic,0,1)};
  });
  return {...identity,format:'nurender-materials',version:1,colorSpace:'linear-srgb',assignments};
}
/** Validate the entire document before any mutation. Import replaces all overrides. */
export function importMaterialPack(value:unknown,batch:BatchData,identity:PackIdentity){
  const pack=validateMaterialPack(value,batch,identity);
  clearMaterials(batch);const ids=new Uint32Array(batch.instances.buffer),catalog=new Map(batch.elements.map(e=>[e.id,e]));
  for(const a of pack.assignments){const e=catalog.get(a.elementId)!;e.material=e.id;ids[(e.id-1)*32+29]=e.id;batch.materials.set([...a.baseColor,1,a.emission,a.roughness,a.metallic,0],e.id*8);}
  return pack.assignments.length;
}
export function parseMaterialPack(text:string):unknown{
  if(new TextEncoder().encode(text).byteLength>MAX_PACK_BYTES)throw new Error('Файл материалов больше 2 МиБ');
  try{return JSON.parse(text);}catch{throw new Error('Не удалось прочитать JSON набора материалов');}
}
export function materialStorageKey(identity:PackIdentity){return `nurender:materials:v1:${identity.sourceDigest}:${identity.layoutDigest}`;}
