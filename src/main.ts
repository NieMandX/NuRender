import {assetUrl} from './asset-url';
import {parseMaterialPack,materialStorageKey,MAX_PACK_BYTES} from './material-pack';
import './style.css';
import { Renderer } from './renderer';
import {NavigationControls,type WheelMode} from './navigation-controls';
import { MODES, type Mode, type Detail } from './scene';
import { comparePixels } from './quality';
import { summarize, summarizePasses, type Sample } from './stats';
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
$('app').innerHTML=`
<header><h1>NuRender</h1><span>Structured renderer / 0.15</span><div id="backend">Проверка WebGPU…</div></header>
<main><aside>
<section><h2>Представление</h2><div class="segmented"><button id="modeA" aria-pressed="true">A · Детали</button><button id="modeB" aria-pressed="false">B · Структура</button><button id="modeC" aria-pressed="false">C · Меши</button></div></section>
<section><h2>Сцена</h2><label>Профиль<select id="deviceProfile"><option value="desktop">Полное качество</option><option value="mobile">Мобильный</option></select></label><p class="note" id="profileNote"></p><label id="geometryLabel">Геометрия<select id="geometryMode"><option value="legacy">Обычная</option><option value="paged">Два семейства · 0.13</option><option value="stream">Вся сцена · потоковая, опытная</option></select></label><label id="pageDetailLabel" hidden>Детализация<select id="pageDetail"><option value="auto">Автоматически</option><option value="coarse">Дальний уровень</option></select></label><p id="pageStatus" class="note" hidden></p><label id="cullingLabel">За кадром<select id="cullingMode"><option value="1">Пропускать</option><option value="0">Рисовать всё</option></select></label><label>Источник<select id="source"><option value="procedural">Процедурная</option><option value="blender">Blender · фрагмент M8</option><option value="full">Blender · полная M8</option></select></label><p class="note" id="sourceNote">Параметрические здания и уникальные детали.</p><label>Зданий<select id="count"><option>16</option><option selected>64</option><option>256</option><option>1024</option></select></label><label>Типов зданий<select id="types"><option>1</option><option selected>4</option><option>16</option></select></label><label>Детализация<select id="detail"><option value="full">Полная</option><option value="medium">Средняя</option><option value="mass">Объёмы</option></select></label><button id="reset" class="wide">Сбросить камеру</button></section>
<section id="navigationPanel"><h2>Управление</h2><label>Устройство<select id="wheelMode"><option value="mouse">Мышь</option><option value="trackpad">Трекпад</option></select></label><label>Скорость полёта<select id="flightSpeed"><option value="0.25">Медленно · ¼×</option><option value="1" selected>Обычно · 1×</option><option value="4">Быстро · 4×</option></select></label><p class="note">Левая кнопка — вращение. Зажатое колёсико или Shift + левая кнопка — сдвиг. Правая кнопка — осмотреться.</p><p class="note">Трекпад: два пальца — сдвиг, щипок — масштаб. Мышь: колесо — масштаб. На сенсорном экране: один палец — вращение, два — сдвиг и масштаб.</p><p class="note">Клик по сцене → <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> — полёт; <kbd>Q</kbd> вниз, <kbd>E</kbd> вверх. <kbd>Shift</kbd> — ускорение, <kbd>Esc</kbd> — остановка. Клавиши работают и в русской раскладке.</p></section>
<section id="texturePanel" hidden><h2>Текстуры из Blender</h2><label>Карты материала<select id="textureMode"><option value="0">Без текстур</option><option value="1">Только цвет</option><option value="2" selected>Цвет + PBR-карты</option></select></label><p id="textureStatus" class="note"></p><details id="textureWarnings" hidden><summary>Карты с ограничениями</summary><p class="note" id="textureWarningList"></p></details><label>Окружение<select id="environmentMode"><option value="1" selected>HDR · городской двор</option><option value="0">Процедурное</option></select></label><label>Отражения HDR<select id="iblMode"><option value="1" selected>Подготовленные</option><option value="0">Контрольные · 16 выборок</option></select></label><label>Поворот окружения<input id="environmentRotation" type="range" min="0" max="360" step="5" value="0"><output id="environmentRotationValue">0°</output></label><p class="note">UV и масштаб из Blender. Ручные назначения заменяют карты выбранных элементов. Стемолит сохраняет светлую глянцевую поверхность.</p></section>
<section id="analysisPanel" hidden><h2>Поиск повторений</h2><button id="analyse" class="wide">Показать повторения</button><div id="analysisControls" hidden><label>Окраска<select id="diagnostic"><option value="0">Исходная</option><option value="-1">Все группы</option><option value="1">Одна группа</option></select></label><label id="familyLabel" hidden>Группа<select id="family"></select></label><button id="focusFamily" class="wide" hidden>Приблизить группу</button><p id="analysisStats" class="note"></p><p id="familyStats" class="note"></p><a href="${assetUrl('scenes/m8-fragment/repetitions.json')}" download="nurender-repetitions.json">Скачать разбор JSON</a></div><p id="analysisStatus" class="note" role="status"></p></section>
<section id="classificationPanel" hidden><h2>Автоматические материалы</h2><p id="classificationStatus" class="note"></p><details><summary>Что распознано</summary><ul id="classificationList"></ul></details><p class="note">Стемолит — светлый, непрозрачный и глянцевый. Стекло — прозрачное. Металл — металлическое отражение. Неизвестные названия сохраняют исходный вид.</p><p class="note">Ручные назначения имеют приоритет. «Сбросить материалы» возвращает автоматические.</p></section><section id="materialPanel" hidden><h2>PBR-материал · B</h2><label>Отрисовка<select id="batchMode"><option value="batch">Пакетная</option><option value="legacy">По шаблону</option></select></label><label>Группа<select id="materialFamily"></select></label><label>Назначить<select id="materialScope"><option value="all">Всей группе</option><option value="one">Одной копии</option></select></label><label id="copyLabel" hidden>Копия<select id="materialCopy"></select></label><label>Цвет<input id="materialColor" type="color" value="#ffbb55"></label><label>Шероховатость<input id="materialRoughness" type="range" min="0.05" max="1" step="0.05" value="0.7"><output id="roughnessValue">0.70</output></label><label>Металличность<input id="materialMetallic" type="range" min="0" max="1" step="0.1" value="0"><output id="metallicValue">0.0</output></label><label>Свечение<input id="materialEmission" type="range" min="0" max="2" step="0.1" value="0"></label><button id="applyMaterial" class="wide">Применить в B</button><button id="resetMaterials" class="wide">Сбросить материалы</button><button id="saveMaterials" class="wide">Скачать материалы</button><button id="loadMaterials" class="wide">Загрузить материалы</button><input id="materialFile" type="file" accept=".json,.numat,application/json" hidden><a id="materialDownload" hidden>Скачать подготовленный файл</a><p id="storageStatus" class="note" role="status"></p><p class="note">Автосохранение в этом браузере. Файл заменяет все назначения; геометрия проверяется перед загрузкой.</p><p id="materialStatus" class="note" role="status">PBR: цвет, шероховатость, металл и свечение. HDR-окружение. Ручной материал заменяет исходные карты. Стекло прозрачно, пока не назначен ручной материал. Изменения действуют в пакетном B и автоматически сохраняются в этом браузере.</p></section>
<section><h2>Измерения</h2><p class="note" id="shadowStatus">Статичные тени: подготовка…</p><dl><div><dt>Кадр</dt><dd id="frame">—</dd></div><div><dt>CPU submit</dt><dd id="cpu">—</dd></div><div><dt>GPU</dt><dd id="gpu">—</dd></div><div><dt>Буферы сцены</dt><dd id="memory">—</dd></div></dl><p class="note" id="metricNote">Для замеров запустите сравнение. Размер буферов — не полная VRAM.</p></section>
<section class="actions"><button id="benchmark" class="wide primary">Сравнить A/B/C</button><button id="export" class="wide" disabled>Экспорт JSON</button><p id="progress" role="status" aria-live="polite"></p><div id="result" hidden></div></section>
<p class="help">Кликните по сцене для управления клавиатурой.<br>1 / 2 / 3 — сменить представление · Esc — выйти из управления.</p>
</aside><div id="viewport"><canvas id="canvas" aria-label="Интерактивный трёхмерный фасадный квартал" tabindex="0"></canvas><div class="caption"><h2>Фасадный квартал</h2><p>Одинаковая сцена. Три представления.</p></div><div id="error" role="alert" hidden></div></div></main>
<footer><span id="status">Инициализация…</span><span id="resolution"></span></footer>`;
const renderer=new Renderer($<HTMLCanvasElement>('canvas'));
$<HTMLSelectElement>('deviceProfile').value=renderer.profile;
$<HTMLSelectElement>('count').value=String(renderer.count);
$('deviceProfile').onchange=()=>{if(busy)return;const url=new URL(location.href);url.searchParams.set('profile',$<HTMLSelectElement>('deviceProfile').value);location.href=url.href;};
let firstFrameSubmittedMs:number|null=null;
let ready=false, busy=false, pending=0, abort=false, lastReport:Record<string,unknown>|null=null;
const formatBytes=(n:number|null)=>n===null?'н/д':n<1024*1024?`${(n/1024).toFixed(1)} КБ`:`${(n/1024/1024).toFixed(2)} МБ`;
const ms=(n:number|null)=>n===null?'н/д':`${n.toFixed(2)} мс`;
const controls=['wheelMode','flightSpeed','geometryMode','pageDetail','cullingMode','deviceProfile','modeA','modeB','modeC','textureMode','environmentMode','iblMode','environmentRotation','source','count','types','detail','reset','analyse','diagnostic','family','focusFamily','batchMode','materialFamily','materialScope','materialCopy','materialColor','materialEmission','materialRoughness','materialMetallic','applyMaterial','resetMaterials','saveMaterials','loadMaterials','materialFile'];
function fail(message:string){$('error').hidden=false;$('error').textContent=message;$('backend').textContent='WebGPU: ошибка';$('status').textContent='Рендер остановлен';abort=true;ready=false;for(const id of [...controls,'benchmark'])$<HTMLButtonElement>(id).disabled=true;busy=false;$<HTMLSelectElement>('deviceProfile').disabled=false;}
renderer.onError=fail;
renderer.onSceneChange=()=>{if(!busy){invalidate();draw();}};
$('geometryMode').onchange=()=>{if(busy)return;const url=new URL(location.href);url.searchParams.set('geometry',$<HTMLSelectElement>('geometryMode').value);location.href=url.href;};
$('pageDetail').onchange=()=>{renderer.detailEnabled=$<HTMLSelectElement>('pageDetail').value==='auto';invalidate();draw();};
function syncControls(){
  if(busy)navigation.stop();
  $('geometryLabel').hidden=!(renderer.mobile&&renderer.source==='full');
  $<HTMLSelectElement>('geometryMode').value=renderer.geometryMode;
  $<HTMLSelectElement>('pageDetail').value=renderer.detailEnabled?'auto':'coarse';
  $('pageDetailLabel').hidden=!renderer.pagingInfo;$('pageStatus').hidden=!renderer.pagingInfo;
  $('cullingLabel').hidden=renderer.source!=='full';
  $('materialPanel').hidden=renderer.source==='procedural';
  populateMaterials();populateClassification();
  $('texturePanel').hidden=renderer.source==='procedural';
  if(renderer.textureInfo){const t=renderer.textureInfo;$('textureStatus').textContent=`${t.images} изображений · ${t.resolution} px · ${t.mappedMaterials} материалов с картами. Текстуры с mip-уровнями: ${formatBytes(t.bytes)} отдельно от геометрии.`;$('textureWarnings').hidden=!t.warnings.length;$('textureWarningList').textContent=t.warnings.map(w=>`${w.material}: ${({'color':'цвет','roughness':'шероховатость','metallic':'металличность','normal':'нормали'} as Record<string,string>)[w.role]??w.role} — ${w.reason.startsWith('Missing requested UV')?'нужный UV-слой отсутствует, используются постоянные параметры материала':w.reason}.`).join(' ');}
  $('analysisPanel').hidden=renderer.source!=='blender';
  $<HTMLButtonElement>('benchmark').disabled=!ready||(!busy&&(renderer.diagnostic!==0||renderer.materialEdits>0));
  for(const id of controls)$<HTMLButtonElement>(id).disabled=!ready||busy;
  if(renderer.materialEdits||renderer.mobile)$<HTMLSelectElement>('batchMode').disabled=true;
  $('batchMode').closest('label')!.hidden=renderer.mobile;
  $<HTMLSelectElement>('deviceProfile').value=renderer.profile;
  $('profileNote').textContent=renderer.mobile?'Меньше памяти: упрощённая геометрия всей сцены, карты 256 px, ограниченное разрешение. Переключение профиля перезагрузит сцену.':'Исходная геометрия. Для телефона или планшета доступен мобильный профиль.';
  $<HTMLSelectElement>('batchMode').value=renderer.batching?'batch':'legacy';
  if(renderer.source!=='procedural')for(const id of ['count','types','detail'])$<HTMLButtonElement>(id).disabled=true;
  for(const id of ['count','types','detail'])$(id).closest('label')!.hidden=renderer.source!=='procedural';
  $('modeB').textContent=renderer.source==='full'?(renderer.mobile?'B · Материалы':'B · Пакеты'):renderer.source==='blender'?'B · Повторы':'B · Структура';
  $('modeA').textContent=renderer.source!=='procedural'?'A · Объекты':'A · Детали';
  $('modeC').textContent=renderer.source!=='procedural'?'C · Инстансы':'C · Меши';
  $('benchmark').textContent=busy?'Остановить':`Сравнить ${renderer.activeModes.join('/')}`;
  $('sourceNote').textContent=renderer.source==='full'&&renderer.mobile&&renderer.geometryMode==='stream'?'Сначала — облегчённый обзор всех объектов, затем — видимые подробности. Обзорная геометрия и статичные тени приближённые; тонкие детали и швы могут отличаться.':renderer.source==='full'&&renderer.mobile?'Все 265 объектов. Мобильное упрощение уменьшает мелкие детали; исходная полная сцена доступна в профиле полного качества.':renderer.source==='full'?'Полная сцена без обрезки и упрощения. B пакетирует части исходных мешей; поиск повторов внутри мешей доступен во фрагменте.':renderer.source==='blender'?'Реальный фрагмент с UV и PBR-картами из Blender. B: шаблоны найденных частей + уникальный остаток.':'Параметрические здания и уникальные детали.';
  document.querySelector('.caption h2')!.textContent=renderer.source==='full'?(renderer.mobile&&renderer.geometryMode==='stream'?'M8 · потоковая детализация':renderer.mobile?'M8 · мобильная детализация':'M8 · полная сцена'):renderer.source==='blender'?(renderer.diagnostic===0?'M8 · фрагмент из Blender':renderer.diagnostic===-1?'M8 · найденные повторения':`M8 · группа #${renderer.diagnostic}`):'Фасадный квартал';
  document.querySelector('.caption p')!.textContent=renderer.source==='full'&&renderer.mobile&&renderer.geometryMode==='stream'?'Быстрый обзор → подробности по мере приближения.':renderer.source!=='procedural'?(renderer.diagnostic===0?'Реальная геометрия. Текстуры и PBR-карты из Blender.':'Цвет — совпадающие формы. Серый — остальная геометрия.'):'Одинаковая сцена. Три представления.';
}
function update(){
  const m=renderer.metrics;
  if(renderer.pagingInfo){const p=renderer.pagingInfo;$('pageStatus').textContent=`Подробности: ${p.residentPages}/${p.totalPages} участков · ${formatBytes(p.residentBytes)} из ${formatBytes(p.budgetBytes)}. ${p.pendingPages?'Загрузка…':'Готово.'}${p.version===2?` Обзор: ${p.activeLevels[0]}, средний: ${p.activeLevels[1]}, подробный: ${p.activeLevels[2]}.`:''}${p.budgetLimitedPages?' Достигнут лимит памяти; часть участков остаётся на дальнем уровне.':''}${p.failedPages?' Часть подробностей недоступна; сохранён дальний уровень.':''}`;}
  $('shadowStatus').textContent=`Статичные тени · построений: ${m.shadowCache.builds} · повторных кадров: ${m.shadowCache.reuses}. Движение камеры сохраняет карту теней.`;
  for(const mode of MODES)$('mode'+mode).setAttribute('aria-pressed',String(renderer.mode===mode));
  $('memory').textContent=formatBytes(({A:m.bytesA,B:m.bytesB,C:m.bytesC})[renderer.mode]);
  $('memory').title=`A: ${m.bytesA} байт; B: ${m.bytesB===null?'не применим':m.bytesB+' байт'}; C: ${m.bytesC} байт. Три представления хранятся для переключения: ${m.residentSceneBuffers} байт. Общая геометрия включена; uniform и текстуры исключены.`;
  $('status').textContent=`${busy?'Замер':'Готово'}  |  ${renderer.source!=='procedural'?'Объектов: '+renderer.sourceInfo!.objects.length:'Зданий: '+renderer.count}  |  Инстансы: ${m.instances.toLocaleString('ru')}  |  Треугольники: ${m.triangles.toLocaleString('ru')}`;
  $('resolution').textContent=`WebGPU  |  ${m.width} × ${m.height}`;
  if(lastReport&&!busy){
    const summary=lastReport.summary as Record<Mode,ReturnType<typeof summarize>>;
    const s=summary[renderer.mode];
    $('frame').textContent=`${ms(s.frame.median)} · ${s.frame.median?(1000/s.frame.median).toFixed(0):'—'} FPS`;
    $('cpu').textContent=ms(s.cpu.median);$('gpu').textContent=ms(s.gpu.median);
  }
}
function draw(){if(!ready||busy||pending||document.hidden)return;pending=requestAnimationFrame(time=>{pending=0;try{navigation.tick(time);renderer.render();if(firstFrameSubmittedMs===null)firstFrameSubmittedMs=performance.now();update();if(navigation.moving)draw();}catch(e){fail(String(e));}});}
function invalidate(){lastReport=null;$<HTMLButtonElement>('export').disabled=true;$('result').hidden=true;for(const id of ['frame','cpu','gpu'])$(id).textContent='—';$('progress').textContent='';$('metricNote').textContent=renderer.materialEdits>0?'Сбросьте материалы перед сравнением: A/C показывают автоматические материалы.':renderer.diagnostic!==0?'Замеры отключены при диагностической окраске. Выберите «Исходная», чтобы сравнить режимы.':'Для замеров запустите сравнение. Размер буферов — не полная VRAM.';}
function setMode(mode:Mode){if(!ready||busy||!renderer.activeModes.includes(mode))return;renderer.mode=mode;update();draw();}
for(const mode of MODES)$('mode'+mode).onclick=()=>setMode(mode);
$('source').onchange=async()=>{
  if(!ready||busy)return;
  const target=$<HTMLSelectElement>('source').value as 'procedural'|'blender'|'full';
  // Mobile releases imported scenes. A recreated scene must restore its draft again.
  if(renderer.mobile&&target!==renderer.source&&renderer.materialIdentity)restoredScenes.delete(materialStorageKey(renderer.materialIdentity));
  busy=true;invalidate();syncControls();$<HTMLButtonElement>('benchmark').disabled=true;$('progress').textContent='Загрузка геометрии…';
  try{await renderer.setSource(target,text=>{$('sourceNote').textContent=text;$('progress').textContent=text;});$('materialFamily').replaceChildren();$('classificationList').replaceChildren();restoreSavedMaterials();invalidate();const url=new URL(location.href);url.searchParams.set('scene',renderer.source);history.replaceState(null,'',url);$('progress').textContent='';}
  catch(e){$('progress').textContent=String(e);$<HTMLSelectElement>('source').value=renderer.source;}
  finally{busy=false;syncControls();draw();}
};
function populateMaterials(){
  if(!renderer.materialFamilies||$<HTMLSelectElement>('materialFamily').options.length)return;
  for(const f of [...renderer.materialFamilies!].sort((a,b)=>a.id-b.id)){const o=document.createElement('option');o.value=String(f.id);o.textContent=`#${f.id} · ${f.copies} копий · ${f.object}`;$('materialFamily').append(o);}
  const first=[...renderer.materialFamilies!].filter(f=>f.object.includes('Glass')).sort((a,b)=>b.copies*b.trianglesPerCopy-a.copies*a.trianglesPerCopy)[0]??renderer.materialFamilies![0];
  $<HTMLSelectElement>('materialFamily').value=String(first.id);updateCopies();
}
function populateClassification(){
  $('classificationPanel').hidden=renderer.source==='procedural';
  if(!renderer.classification||$('classificationList').childElementCount)return;
  const counts={glass:new Set<number>(),stemolit:new Set<number>(),metal:new Set<number>()};
  for(const g of renderer.classification)for(const m of g.materials){
    const c=m.classification;if(c.kind==='default'||!m.triangles)continue;
    counts[c.kind].add(g.group);
    const item=document.createElement('li');
    item.textContent=`${g.name} · ${m.name||'без имени материала'} → ${c.label}`;
    item.title=`Распознано «${c.matched}» в «${c.source}»`;
    $('classificationList').append(item);
  }
  $('classificationStatus').textContent=`Группы: стекло — ${counts.glass.size}, стемолит — ${counts.stemolit.size}, металл — ${counts.metal.size}. Применено в A/B/C, включая уникальные части.`;
}
function updateCopies(){
  const f=renderer.materialFamilies?.find(f=>f.id===Number($<HTMLSelectElement>('materialFamily').value));
  $('materialCopy').replaceChildren();if(f)for(let i=0;i<f.copies;i++){const o=document.createElement('option');o.value=String(i);o.textContent=String(i+1);$('materialCopy').append(o);}
  $('copyLabel').hidden=$<HTMLSelectElement>('materialScope').value!=='one';
}
$('cullingMode').onchange=()=>{if(!ready||busy)return;renderer.culling=Number($<HTMLSelectElement>('cullingMode').value)===1;invalidate();draw();};
$('iblMode').onchange=()=>{if(!ready||busy)return;renderer.iblMode=Number($<HTMLSelectElement>('iblMode').value);invalidate();draw();};
$('environmentMode').onchange=()=>{if(!ready||busy)return;renderer.environmentMode=Number($<HTMLSelectElement>('environmentMode').value);invalidate();draw();};
$('environmentRotation').oninput=()=>{if(!ready||busy)return;renderer.environmentRotation=Number($<HTMLInputElement>('environmentRotation').value);$('environmentRotationValue').textContent=renderer.environmentRotation+'°';invalidate();draw();};
$('textureMode').onchange=()=>{if(!ready||busy)return;renderer.textureMode=Number($<HTMLSelectElement>('textureMode').value);invalidate();draw();};
$('batchMode').onchange=()=>{if(!ready||busy)return;renderer.batching=$<HTMLSelectElement>('batchMode').value==='batch';invalidate();draw();};
$('materialFamily').onchange=updateCopies;
$('materialRoughness').oninput=()=>{$('roughnessValue').textContent=Number($<HTMLInputElement>('materialRoughness').value).toFixed(2);};
$('materialMetallic').oninput=()=>{$('metallicValue').textContent=Number($<HTMLInputElement>('materialMetallic').value).toFixed(1);};
$('materialScope').onchange=()=>{$('copyLabel').hidden=$<HTMLSelectElement>('materialScope').value!=='one';};
$('applyMaterial').onclick=()=>{
  if(!ready||busy)return;
  const family=Number($<HTMLSelectElement>('materialFamily').value),copy=$<HTMLSelectElement>('materialScope').value==='one'?Number($<HTMLSelectElement>('materialCopy').value):null;
  const hex=$<HTMLInputElement>('materialColor').value;
  // HTML colors are sRGB; the lighting shader consumes linear RGB.
  const color=[1,3,5].map(i=>{const c=parseInt(hex.slice(i,i+2),16)/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});
  const n=renderer.editMaterial(family,copy,color,Number($<HTMLInputElement>('materialEmission').value),Number($<HTMLInputElement>('materialRoughness').value),Number($<HTMLInputElement>('materialMetallic').value));
  $<HTMLSelectElement>('diagnostic').value='0';$('familyLabel').hidden=true;$('focusFamily').hidden=true;
  renderer.focusFamily(family);
  $('materialStatus').textContent=`Обновлено элементов: ${n}, группа #${family}. Всего изменено: ${renderer.materialEdits}. Эффект только в пакетном B; A/C сохраняют автоматические материалы. `;
  saveMaterialDraft();invalidate();syncControls();draw();if(matchMedia('(max-width:760px)').matches)$('viewport').scrollIntoView({block:'start'});
};
$('resetMaterials').onclick=()=>{if(!ready||busy)return;renderer.resetMaterials();saveMaterialDraft();$('materialStatus').textContent='Ручные назначения сброшены. Восстановлены автоматические материалы; сравнение доступно.';invalidate();syncControls();draw();};
let materialUrl:string|null=null;
const restoredScenes=new Set<string>();
function revokeMaterialFile(){if(materialUrl)URL.revokeObjectURL(materialUrl);materialUrl=null;$('materialDownload').hidden=true;$('materialDownload').removeAttribute('href');}
function saveMaterialDraft(){
  revokeMaterialFile();
  try{localStorage.setItem(materialStorageKey(renderer.materialIdentity!),JSON.stringify(renderer.exportMaterials()));$('storageStatus').textContent='Автосохранено в этом браузере.';}
  catch{$('storageStatus').textContent='Автосохранение недоступно. Изменения применены; скачайте файл, чтобы сохранить их.';}
}
function restoreSavedMaterials(){
  if(renderer.source==='procedural'||!renderer.materialIdentity)return;
  const key=materialStorageKey(renderer.materialIdentity);if(restoredScenes.has(key))return;restoredScenes.add(key);
  try{const saved=localStorage.getItem(key);if(!saved){$('storageStatus').textContent='Для этой сцены пока нет сохранённого набора.';return;}
    const n=renderer.importMaterials(parseMaterialPack(saved));$('storageStatus').textContent=`Восстановлено из браузера: ${n} назначений.`;
  }catch(e){$('storageStatus').textContent=`Сохранённый набор не загружен: ${e instanceof Error?e.message:String(e)}`;}
}
$('saveMaterials').onclick=()=>{
  if(!ready||busy||renderer.source==='procedural')return;
  revokeMaterialFile();materialUrl=URL.createObjectURL(new Blob([JSON.stringify(renderer.exportMaterials(),null,2)],{type:'application/json'}));
  const link=$<HTMLAnchorElement>('materialDownload');link.href=materialUrl;link.download='nurender-materials.numat.json';link.hidden=false;link.click();
  $('storageStatus').textContent='Файл подготовлен. Если загрузка не началась, нажмите «Скачать подготовленный файл».';
};
$('loadMaterials').onclick=()=>{if(ready&&!busy)$<HTMLInputElement>('materialFile').click();};
$('materialFile').onchange=async()=>{
  const input=$<HTMLInputElement>('materialFile'),file=input.files?.[0];input.value='';if(!file||!ready||busy)return;
  busy=true;syncControls();$<HTMLButtonElement>('benchmark').disabled=true;
  try{if(file.size>MAX_PACK_BYTES)throw new Error('Файл материалов больше 2 МиБ');
    const n=renderer.importMaterials(parseMaterialPack(await file.text()));
    $<HTMLSelectElement>('diagnostic').value='0';$('familyLabel').hidden=true;$('focusFamily').hidden=true;
    $('materialStatus').textContent=`Загружено назначений: ${n}. Предыдущий набор заменён. Геометрия совпадает.`;
    saveMaterialDraft();invalidate();
  }catch(e){$('materialStatus').textContent=`Набор не загружен: ${e instanceof Error?e.message:String(e)}. Текущие материалы сохранены.`;}
  finally{busy=false;syncControls();draw();}
};
$('types').onchange=()=>{if(!ready||busy)return;renderer.types=Number($<HTMLSelectElement>('types').value);renderer.rebuild();invalidate();draw();};
$('count').onchange=()=>{if(!ready||busy)return;renderer.count=Number($<HTMLSelectElement>('count').value);renderer.rebuild();renderer.resetCamera();invalidate();draw();};
$('detail').onchange=()=>{if(!ready||busy)return;renderer.detail=$<HTMLSelectElement>('detail').value as Detail;renderer.rebuild();invalidate();draw();};
function applyDiagnostic(){
  const choice=Number($<HTMLSelectElement>('diagnostic').value);
  const id=choice===1?Number($<HTMLSelectElement>('family').value):choice;
  renderer.setDiagnostic(id);invalidate();
  $('familyLabel').hidden=choice!==1;$('focusFamily').hidden=choice!==1;
  const f=renderer.analysis?.families.find(f=>f.id===id);
  $('familyStats').textContent=f?`#${f.id} · ${f.object}. ${f.copies} копий × ${f.trianglesPerCopy} треуг. Максимальное отклонение: ${(f.maxErrorMetres*1000).toFixed(4)} мм.`:'Цвет объединяет совпадающие формы. Серый — остаток и исключённые из поиска деревья. Это геометрические кандидаты, не распознанные окна.';
  $('metricNote').textContent=renderer.materialEdits>0?'Сбросьте материалы перед сравнением: A/C показывают автоматические материалы.':id!==0?'Замеры отключены при диагностической окраске. Выберите «Исходная», чтобы сравнить режимы.':'Для замеров запустите сравнение. Размер буферов — не полная VRAM.';
  syncControls();draw();
}
$('analyse').onclick=async()=>{
  if(!ready||busy)return;busy=true;syncControls();$<HTMLButtonElement>('benchmark').disabled=true;$('analysisStatus').textContent='Загрузка результатов геометрического разбора…';
  try{
    const r=await renderer.loadAnalysis();const list=$<HTMLSelectElement>('family');list.replaceChildren();
    for(const f of [...r.families].sort((a,b)=>b.copies*b.trianglesPerCopy-a.copies*a.trianglesPerCopy)){const o=document.createElement('option');o.value=String(f.id);o.textContent=`#${f.id} · ${f.copies} × ${f.trianglesPerCopy} · ${f.object}`;list.append(o);}
    $('analysisStats').textContent=`${r.summary.families} групп · ${r.summary.repeatedComponents.toLocaleString('ru')} повторяющихся частей. ${(r.summary.coverage*100).toFixed(1)}% исследованных треугольников (${r.summary.repeatedTriangles.toLocaleString('ru')} / ${r.summary.analysedTriangles.toLocaleString('ru')}). Деревья исключены. Допуск ≤ 1 мм; от 3 копий. Разбор: ${r.analysisMs.toFixed(0)} мс на машине подготовки.`;
    $('analysisControls').hidden=false;$('analyse').hidden=true;$('analysisStatus').textContent='Исходная геометрия сохранена. Меняется только цвет.';$<HTMLSelectElement>('diagnostic').value='-1';
  }catch(e){$('analysisStatus').textContent=String(e);}
  finally{busy=false;if(renderer.analysis)applyDiagnostic();else syncControls();}
};
$('diagnostic').onchange=()=>{if(ready&&!busy)applyDiagnostic();};
$('family').onchange=()=>{if(ready&&!busy)applyDiagnostic();};
$('focusFamily').onclick=()=>{if(!ready||busy)return;renderer.focusFamily(Number($<HTMLSelectElement>('family').value));invalidate();draw();if(matchMedia('(max-width:760px)').matches)$('viewport').scrollIntoView({block:'start'});};
$('reset').onclick=()=>{if(!ready||busy)return;renderer.resetCamera();invalidate();draw();};
window.addEventListener('keydown',e=>{if((e.target as HTMLElement).matches('input,select,textarea')||e.ctrlKey||e.metaKey)return;if(e.key==='1')setMode('A');if(e.key==='2')setMode('B');if(e.key==='3')setMode('C');});
const navigation=new NavigationControls(renderer.canvas,renderer.camera,()=>renderer.cameraFraming,()=>ready&&!busy&&!document.hidden,()=>{invalidate();draw();});
try{const saved=localStorage.getItem('nurender-navigation-wheel');if(saved==='mouse'||saved==='trackpad')navigation.wheelMode=saved;}catch{}
$<HTMLSelectElement>('wheelMode').value=navigation.wheelMode;
$('wheelMode').onchange=()=>{navigation.wheelMode=$<HTMLSelectElement>('wheelMode').value as WheelMode;try{localStorage.setItem('nurender-navigation-wheel',navigation.wheelMode);}catch{}};
$('flightSpeed').onchange=()=>{navigation.speed=Number($<HTMLSelectElement>('flightSpeed').value);};
const resize=new ResizeObserver(()=>{if(busy)abort=true;else {if(ready)invalidate();draw();}});resize.observe($('viewport'));
document.addEventListener('visibilitychange',()=>{if(document.hidden&&busy)abort=true;else draw();});
const nextFrame=()=>new Promise<number>(resolve=>requestAnimationFrame(resolve));
async function compare(){
  if(!ready||busy||renderer.diagnostic!==0||renderer.materialEdits>0)return;
  busy=true;abort=false;navigation.stop();if(pending){cancelAnimationFrame(pending);pending=0;}
  const originalMode=renderer.mode;
  invalidate();for(const id of controls)$<HTMLButtonElement>(id).disabled=true;
  $('benchmark').textContent='Остановить';$('result').hidden=true;
  const samples:Record<Mode,Sample[]>={A:[],B:[],C:[]};
  const coldSamples:Record<Mode,Sample[]>={A:[],B:[],C:[]};
  const activeModes=renderer.activeModes;
  const order:Mode[]=[...activeModes,...[...activeModes].reverse()];
  try {
    renderer.streamingFrozen=true;
    const deadline=performance.now()+30000;
    while(renderer.pagingInfo?.pendingPages){
      if(abort||performance.now()>deadline)throw new Error('Дождитесь загрузки подробностей и повторите сравнение.');
      $('progress').textContent='Ожидание подробной геометрии…';await nextFrame();
    }
    const config={startup:{firstFrameSubmittedMs},paging:renderer.pagingInfo,culling:renderer.culling,profile:renderer.profile,source:renderer.source,sourceDescription:renderer.sourceInfo?{name:renderer.sourceInfo.name,source:renderer.sourceInfo.source,anchorObject:renderer.sourceInfo.anchorObject,cropRule:renderer.sourceInfo.cropRule,materials:renderer.sourceInfo.materials}:null,buildings:renderer.count,detail:renderer.detail,types:renderer.types,width:renderer.canvas.width,height:renderer.canvas.height,yaw:renderer.yaw,pitch:renderer.pitch,distance:renderer.distance,cameraOffset:[...renderer.camera.offset],cameraPose:renderer.cameraPose,framing:renderer.cameraFraming,shadowPolicy:'static; cold builds measured separately',batching:renderer.batching,materialEdits:renderer.materialEdits,environment:renderer.environmentInfo,textureMode:renderer.textureMode,textures:renderer.textureInfo,shading:"Imported UV and PBR maps; name-based surface classes; GGX; HDR or procedural environment; weighted blended glass transparency; filmic tone mapping"};
    for(let round=0;round<order.length;round++){
      renderer.mode=order[round];update();
      const cold=renderer.render(0,true,true);cold.sample.gpu=await cold.done;coldSamples[renderer.mode].push(cold.sample);
      let last=await nextFrame();
      for(let i=0;i<90;i++){
        if(abort||renderer.stopped||document.hidden)throw new Error('Сравнение отменено. Сохраните размер окна и оставьте вкладку активной.');
        const now=await nextFrame();
        const measured=i>=30;
        const {sample,done}=renderer.render(now-last,measured);last=now;
        sample.gpu=await done;
        if(measured)samples[renderer.mode].push(sample);
        if(i%15===0)$('progress').textContent=`${round+1}/${order.length} · ${renderer.mode} · ${i<30?'прогрев':`замер ${i-29}/60`}`;
      }
    }
    if(abort||document.hidden)throw new Error('Сравнение отменено.');
    // Read back both images with the exact same state. Not part of timed samples.
    $('progress').textContent='Проверка совпадения изображений…';
    renderer.mode='A';const pixelsA=await renderer.pixels();
    const quality:Partial<Record<Mode,ReturnType<typeof comparePixels>>>={};
    const cullingQuality:Partial<Record<Mode,ReturnType<typeof comparePixels>>>={};
    const checkCulling=async(mode:Mode,pixels:Uint8Array)=>{if(renderer.source!=='full'||!renderer.culling)return;renderer.culling=false;try{cullingQuality[mode]=comparePixels(pixels,await renderer.pixels());}finally{renderer.culling=true;}};
    await checkCulling('A',pixelsA);
    const shadowQuality:Partial<Record<Mode,ReturnType<typeof comparePixels>>>={A:comparePixels(await renderer.pixels(),await renderer.pixels(true))};
    for(const mode of activeModes.filter(m=>m!=='A')){renderer.mode=mode;const cached=await renderer.pixels();quality[mode]=comparePixels(pixelsA,cached);await checkCulling(mode,cached);shadowQuality[mode]=comparePixels(await renderer.pixels(),await renderer.pixels(true));}
    if(abort||document.hidden)throw new Error('Сравнение отменено.');
    const summary={A:summarize(samples.A),B:summarize(samples.B),C:summarize(samples.C)};
    lastReport={version:'0.15.0',createdAt:new Date().toISOString(),config,adapter:renderer.adapterInfo,userAgent:navigator.userAgent,timestamps:renderer.hasTimestamps,supportedModes:activeModes,order,warmupFrames:30,samplesPerRound:60,metrics:renderer.metrics,summary,quality,shadowQuality,cullingQuality,samples,coldSamples,passSummary:{A:summarizePasses(samples.A),B:summarizePasses(samples.B),C:summarizePasses(samples.C)},
      notes:['Frame intervals include browser scheduling, GPU readback and vsync. GPU reports sum of shadow, opaque, transparency and compositing passes.','CPU submit measures encoding, uniforms and submission, not GPU execution.','Buffers are explicit scene buffer sizes, not total VRAM. All active representations share geometry where implemented; residentSceneBuffers reports the total.','Static camera; frustum culling follows config.culling for full scene, runtime LOD residency is frozen during comparison when paging is enabled. Steady-state samples reuse the shadow map; coldSamples include forced shadow builds. Skipped passes contribute zero GPU time. Draw calls are warm counts; coldDrawCallsByMode includes shadow draws.',renderer.source==='full'&&renderer.mobile?'Mobile: all objects retained with offline lossy LOD, quantized positions/normals and float32 UV. A/B/C share one compact geometry allocation; B uses editable instances, no vertex-pulling address buffer. Material textures 256 px, DPR <= 1, pixel budget 1M, shadow 1024. No inactive imported scenes cached.':renderer.source==='full'?'Full scene retains every visible mesh triangle. A/C draw source mesh parts with shared geometry, B batches those parts with vertex pulling; full-scene submesh repetition discovery is not implemented. PBR textures use 512 px, HDR and material classification match the fragment.':renderer.source==='blender'?'Real scene A/C use identical shared geometry buffers: A draws each object separately; C instances shared meshes. B uses discovered submesh templates: packed vertex pulling or legacy instancing, according to config.batching, plus unchanged residuals; triangle order and float32 arithmetic can differ. This is not a novel GPU algorithm. All paths use GGX metallic-roughness and the same imported per-copy UVs, colour/roughness/metallic/normal maps with mipmaps; HDR specular: prefiltered split-sum or 16 GGX samples according to config.environment.specular; SH diffuse approximation. Legacy B draws textured copies separately to retain distinct UVs.':'C is ordinary indexed whole-building mesh instancing; B uses shared box templates. Unique details are included in every mode.']};
    const m=renderer.metrics;
    $('result').hidden=false;
    const row=(name:string,values:string[])=>`<tr><th>${name}</th>${values.map(v=>`<td>${v}</td>`).join('')}</tr>`;
    const sizes={A:m.bytesA,B:m.bytesB,C:m.bytesC};
    const qualityText=activeModes.filter(m=>m!=='A').map(mode=>`${mode}/A: ${quality[mode]!.exact?'пиксели совпадают':`отличаются ${(100*quality[mode]!.changedPixelFraction).toFixed(3)}% пикселей`}`).join('. ');
    $('result').innerHTML=`<table><thead><tr><th></th>${activeModes.map(m=>`<th>${m}</th>`).join('')}</tr></thead><tbody>${row('GPU median',activeModes.map(m=>ms(summary[m].gpu.median)))}${row('CPU median',activeModes.map(m=>ms(summary[m].cpu.median)))}${row('GPU p95',activeModes.map(m=>ms(summary[m].gpu.p95)))}${row('Буферы',activeModes.map(mode=>formatBytes(sizes[mode])))}${row('Draw calls · кэш',activeModes.map(mode=>String(m.drawCallsByMode[mode])))}</tbody></table><p class="note">${qualityText}. Отсечение: ${renderer.source==='full'&&renderer.culling?(activeModes.every(mode=>cullingQuality[mode]?.exact)?'совпадает с полным выводом':'обнаружены отличия'):'выключено / не применяется'}. Кэш теней: ${activeModes.every(mode=>shadowQuality[mode]!.exact)?'изображение совпадает с перестроением':'обнаружены отличия'}.<br>Качество и исходные замеры — в JSON. Размер буферов не означает ускорение.</p>`;
    const s=summary[originalMode];
    $('frame').textContent=`${ms(s.frame.median)} · ${s.frame.median?(1000/s.frame.median).toFixed(0):'—'} FPS`;
    $('cpu').textContent=ms(s.cpu.median);$('gpu').textContent=ms(s.gpu.median);
    $('metricNote').textContent=`Медианы с готовыми статичными тенями. ${activeModes.join('/')} и p95 — в JSON. Буферы — не полная VRAM.`;
    $('progress').textContent='Готово · 120 замеров на режим';$<HTMLButtonElement>('export').disabled=false;
  }catch(e){$('progress').textContent=e instanceof Error?e.message:String(e);}
  finally{renderer.streamingFrozen=false;busy=false;renderer.mode=originalMode;syncControls();if(ready){update();draw();}}
}
$('benchmark').onclick=()=>{if(busy){abort=true;$('progress').textContent='Останавливаем…';}else void compare();};
let exportUrl:string|null=null;
$('export').onclick=()=>{if(!lastReport)return;if(exportUrl)URL.revokeObjectURL(exportUrl);const url=URL.createObjectURL(new Blob([JSON.stringify(lastReport,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`nurender-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;exportUrl=url;document.body.append(link);link.click();link.remove();};
for(const id of [...controls,'benchmark'])$<HTMLButtonElement>(id).disabled=true;
renderer.init().then(async()=>{const source=new URL(location.href).searchParams.get('scene')??import.meta.env?.VITE_DEFAULT_SCENE;if(source==='blender'||source==='full'){await renderer.setSource(source,text=>{$('status').textContent=text;$('sourceNote').textContent=text;});$<HTMLSelectElement>('source').value=source;}restoreSavedMaterials();ready=true;renderer.resetCamera();$('backend').textContent=renderer.hasTimestamps?'WebGPU · GPU timing':'WebGPU';invalidate();syncControls();draw();}).catch(e=>fail(e instanceof Error?e.message:String(e)));
window.addEventListener('pagehide',()=>{abort=true;navigation.destroy();if(pending)cancelAnimationFrame(pending);resize.disconnect();revokeMaterialFile();if(exportUrl)URL.revokeObjectURL(exportUrl);renderer.destroy();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
// Read-only diagnostics for browser validation and reproducible experiments.
Object.defineProperty(window,'nurender',{value:{get startup(){return {firstFrameSubmittedMs};},get camera(){return {yaw:renderer.yaw,pitch:renderer.pitch,distance:renderer.distance,offset:[...renderer.camera.offset],...renderer.cameraPose,moving:navigation.moving,wheelMode:navigation.wheelMode};},get environmentInfo(){return renderer.environmentInfo;},get textureInfo(){return renderer.textureInfo;},get textureMode(){return renderer.textureMode;},get ready(){return ready;},get busy(){return busy;},get report(){return lastReport;},get materialEdits(){return renderer.materialEdits;},get batching(){return renderer.batching;},get analysis(){return renderer.analysis;},get classification(){return renderer.classification;},get diagnostic(){return renderer.diagnostic;},get metrics(){return ready?renderer.metrics:null;},get mode(){return renderer.mode;}}});
