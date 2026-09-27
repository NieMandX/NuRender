/** Name-based defaults; explicit per-element edits remain a separate layer. */
export type MaterialKind='default'|'glass'|'stemolit'|'metal';
export type MaterialClass={kind:MaterialKind;code:number;label:string;matched:string;source:string};
export type MaterialProvenance={version:number;sourceDigest:string;groups:{name:string;materialNames:string[];vertexSlots:string;vertexCount:number}[]};
export type ClassifiedGroup={group:number;name:string;materials:{name:string;classification:MaterialClass;triangles:number}[]};
export function normalizeMaterialName(name:string){return name.normalize('NFKC').replace(/([a-zа-я])([A-ZА-Я])/gu,'$1 $2').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}]+/gu,' ').trim();}
const stems=[/^ст[еиэ]м[ао]лит[а-я]*$/u,/^st[ei]m[ao]lit[e]?[a-z]*$/u];
const glass=[/^стекл(?:о|а|ян)[а-я]*$/u,/^остеклен[а-я]*$/u,/^витраж[а-я]*$/u,/^(?:glass|glasses|glazing|glazedglass|vitrage|steklo)$/u];
const metals=[
  /^металл[а-я]*$/u,/^метал[а-я]*$/u,/^(?:metal|metals|metallic|metall|metallized)$/u,
  /^алюмин[а-я]*$/u,/^(?:aluminium|aluminum|aluminiy|aluminij|aluminii|alumini)[a-z]*$/u,
  /^бронз[а-я]*$/u,/^(?:bronze|bronzed|bronza)$/u,
  /^латун[а-я]*$/u,/^(?:brass|latun)$/u,
  /^мед(?:ь|и|ью|н[а-я]*)$/u,/^(?:copper|cuprum|med)$/u,
  /^стал(?:ь|и|ью|ьн[а-я]*)$/u,/^нержав[а-я]*$/u,/^(?:steel|stainless|inox|stainlesssteel)$/u,
  /^желез[а-я]*$/u,/^чугун[а-я]*$/u,/^(?:iron|ferrous|castiron)$/u,
  /^титан(?:а|ом|овый|овая|овое|овые|овых)?$/u,/^titanium$/u,
  /^цинк[а-я]*$/u,/^оцинк[а-я]*$/u,/^(?:zinc|galvanized|galvanised)$/u,
  /^никел[а-я]*$/u,/^(?:nickel|nickeled|nickelplated)$/u,
  /^хром(?:а|ом|овый|овая|овое|овые|ированный|ированная|ированное)?$/u,/^(?:chrome|chromium|chromed)$/u,
  /^серебр[а-я]*$/u,/^(?:silver|silvered)$/u,
  /^золот[а-я]*$/u,/^(?:gold|gilded)$/u,
  /^олов[а-я]*$/u,/^tin$/u,/^свин[еца-я]*$/u,/^lead$/u,
  /^магни[а-я]*$/u,/^magnesium$/u,/^платин[а-я]*$/u,/^platinum$/u,
  /^дюрал[а-я]*$/u,/^(?:duralumin|duraluminium|duraluminum)$/u,
  /^вольфрам[а-я]*$/u,/^tungsten$/u,/^кобальт[а-я]*$/u,/^cobalt$/u,
];
function find(names:string[],rules:RegExp[]){for(const source of names)for(const token of [...normalizeMaterialName(source).split(' '),...source.normalize('NFKC').toLowerCase().replace(/ё/g,'е').split(/[^\p{L}]+/u)])if(rules.some(r=>r.test(token)))return {source,matched:token};return null;}
export function classifyMaterialName(materialName:string,groupNames:string[]=[]):MaterialClass{
  const names=[materialName,...groupNames].filter(Boolean);
  // A precise opaque-glass name must win even if its assigned material says Glass.
  const stem=find(names,stems);
  if(stem){const light=names.some(n=>/(?:^| )(?:светл[а-я]*|бел[а-я]*|light|white)(?: |$)/u.test(normalizeMaterialName(n)));return {kind:'stemolit',code:light?4:2,label:'Стемолит',...stem};}
  // A classified material slot is more specific than a generic object/group name.
  for(const source of names){
    const g=find([source],glass);if(g)return {kind:'glass',code:1,label:'Стекло',...g};
    const m=find([source],metals);if(m)return {kind:'metal',code:3,label:'Металл',...m};
  }
  return {kind:'default',code:0,label:'Исходный',source:'',matched:''};
}
/** The unused tenth vertex float carries the automatic surface code in GPU copies. */
export function classifyVertices(vertices:Float32Array,indices:Uint32Array,slots:Uint32Array,names:string[],groupNames:string[]){
  if(slots.length!==vertices.length/10||!names.length)throw new Error('Карта материалов не соответствует геометрии');
  const classes=names.map(name=>classifyMaterialName(name,groupNames)),counts=names.map(()=>0);
  // Validate all addresses before changing any buffer.
  for(const slot of slots)if(slot>=names.length)throw new Error('Неизвестный слот исходного материала');
  for(let i=0;i<indices.length;i+=3){const slot=slots[indices[i]];if(slot===undefined||slots[indices[i+1]]!==slot||slots[indices[i+2]]!==slot)throw new Error('Треугольник пересекает границу материалов');counts[slot]++;}
  for(let i=0;i<slots.length;i++)vertices[i*10+9]=classes[slots[i]].code;
  return names.map((name,i)=>({name,classification:classes[i],triangles:counts[i]}));
}
