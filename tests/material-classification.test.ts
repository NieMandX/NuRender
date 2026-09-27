import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {classifyMaterialName as classify,classifyVertices} from '../src/material-classification.ts';
test('stemolit spelling variants take precedence over glass across material and group names',()=>{
  for(const n of ['Стекло - Стемалит Светлый','Стемолит','Стимолит','СТЕМАЛИТ.001','StEmOlIt_Light','Glass Stemalite White']){
    assert.equal(classify('M8_Glass_Clear_PBR',[n]).kind,'stemolit',n);
  }
  assert.equal(classify('M8_Glass_Clear_PBR',['Стекло - Стемалит Светлый']).code,4);
  assert.equal(classify('Стемолит темный').code,2);
  for(const n of ['M8_Glass_Clear_PBR','Стекло-Прозрачное.003','Остекление','Стеклянная панель','Витраж','FacadeGlassClear'])assert.equal(classify(n).kind,'glass',n);
});
test('Russian and English metals, alloys and inflections are classified without substring collisions',()=>{
  for(const n of ['Металл - Белый','! Металл темный','Metal - Stainless Steel','Алюминий','Алюминиевая панель','ALUMINUM_6061','Aluminium.004','Бронза','бронзовый','bronze','Латунь','brass','Медь','медный','copper','Сталь','нержавеющая','Чугун','iron','Титан','titanium','Цинк','оцинкованный','zinc','Хром','chrome','Никель','nickel','Серебро','silver','Золото','gold','Олово','tin','Свинец','lead','Магний','magnesium','Платина','platinum','Дюраль','Вольфрам','Кобальт'])assert.equal(classify(n).kind,'metal',n);
  for(const n of ['Grass - Green','Stone - Granite','Paint - Golden Beige','Glasshouseplant','MetallicaTree','nothing','Медовый цвет'])assert.equal(classify(n).kind,'default',n);
  assert.equal(classify('Aluminium',['Glass facade']).kind,'metal');
});
test('mixed meshes classify individual slots and malformed maps cannot partly mutate geometry',()=>{
  const v=new Float32Array(90),idx=Uint32Array.from({length:9},(_,i)=>i),slots=new Uint32Array([0,0,0,1,1,1,2,2,2]);
  const r=classifyVertices(v,idx,slots,['Grass','Metal steel','Стекло Стемалит светлый'],['Court']);
  assert.deepEqual(r.map(m=>m.classification.kind),['default','metal','stemolit']);
  assert.deepEqual(Array.from({length:9},(_,i)=>v[i*10+9]),[0,0,0,3,3,3,4,4,4]);
  const before=v.slice();slots[8]=99;assert.throws(()=>classifyVertices(v,idx,slots,['Grass','Metal steel','Glass'],['Court']));assert.deepEqual(v,before);
});
test('exported scene includes exact material slot maps and recognizes stemolit despite assigned Glass material', {skip:process.env.NUR_ASSET_TESTS==='0'}, async()=>{
  const root=new URL('../public/scenes/m8-fragment/',import.meta.url),manifest=JSON.parse(await readFile(new URL('scene.json',root),'utf8')),provenance=JSON.parse(await readFile(new URL('materials.json',root),'utf8'));
  const reports=[];
  for(const [i,g] of manifest.groups.entries()){
    const m=provenance.groups[i],vb=await readFile(new URL(g.vertices,root)),ib=await readFile(new URL(g.indices,root)),sb=await readFile(new URL(m.vertexSlots,root));
    const v=new Float32Array(vb.buffer.slice(vb.byteOffset,vb.byteOffset+vb.byteLength)),idx=new Uint32Array(ib.buffer.slice(ib.byteOffset,ib.byteOffset+ib.byteLength)),s=new Uint32Array(sb.buffer.slice(sb.byteOffset,sb.byteOffset+sb.byteLength));
    assert.equal(m.name,g.name);assert.equal(m.vertexCount,g.vertexCount);
    reports.push(classifyVertices(v,idx,s,m.materialNames,g.objects));
  }
  assert.equal(reports[0][0].classification.kind,'glass');
  assert.equal(reports[23][0].name,'M8_Glass_Clear_PBR');assert.equal(reports[23][0].classification.code,4);
  for(const i of [10,25,28,29,32])assert.equal(reports[i][0].classification.kind,'metal');
  assert.deepEqual(reports[15].map((r:any)=>r.classification.kind),['default','metal','default','default']);
});
