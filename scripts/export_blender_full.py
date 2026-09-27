"""Stream a read-only export of every visible mesh. Run start() via Blender MCP.
No clipping, decimation, operators, selection changes or saves. One timer step
handles at most 20,000 triangles; linked mesh/material combinations stay shared.
"""
import bpy, numpy as np, json, pathlib, hashlib, time, traceback, sys, copy, importlib
from mathutils import Vector
ROOT=pathlib.Path('/Users/mac/Documents/ChatGPT/NuRender')
sys.path.insert(0,str(ROOT/'scripts'))
import blender_texture_assets
importlib.reload(blender_texture_assets)
TextureAssets=blender_texture_assets.TextureAssets
OUT=ROOT/'public/scenes/m8-full'
PROGRESS=pathlib.Path('/private/tmp/nurender-full-export-progress.json')

def export_steps():
    started=time.time();OUT.mkdir(parents=True,exist_ok=True);assets=TextureAssets(OUT)
    objects=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.visible_get()]
    if any(any(m.show_viewport for m in o.modifiers) for o in objects):raise ValueError('Evaluated modifiers need explicit export support')
    bounds_world=np.array([list(o.matrix_world@Vector(c)) for o in objects for c in o.bound_box]);anchor=(bounds_world.min(axis=0)+bounds_world.max(axis=0))*.5
    conversion=np.array([[1,0,0,0],[0,0,1,0],[0,-1,0,0],[0,0,0,1]],dtype=np.float64);origin=conversion[:3,:3]@anchor
    groups=[];cache={};families=[];rows=[];bounds=[np.full(3,np.inf),np.full(3,-np.inf)]
    for oi,obj in enumerate(objects):
        mesh=obj.data;key=(mesh.as_pointer(),tuple(slot.material.name if slot.material else '' for slot in obj.material_slots))
        transform=conversion@np.array(obj.matrix_world,dtype=np.float64);transform[:3,3]-=origin
        normal=np.linalg.inv(transform[:3,:3]).T
        packed=np.concatenate([transform.T.reshape(-1),np.column_stack([normal.T,np.zeros(3)]).reshape(-1)]).astype('<f4').tolist()
        box=np.array([list(obj.matrix_world@Vector(c)) for c in obj.bound_box])@conversion[:3,:3].T-origin
        lo=box.min(axis=0);hi=box.max(axis=0);bounds[0]=np.minimum(bounds[0],lo);bounds[1]=np.maximum(bounds[1],hi)
        if key not in cache:
            cache[key]=[];mesh.calc_loop_triangles();count=len(mesh.loop_triangles)
            coords=np.empty((len(mesh.vertices),3),dtype='<f4');mesh.vertices.foreach_get('co',coords.ravel())
            triangles=np.empty((count,3),dtype=np.int32);mesh.loop_triangles.foreach_get('vertices',triangles.ravel())
            loops=np.empty((count,3),dtype=np.int32);mesh.loop_triangles.foreach_get('loops',loops.ravel())
            slots=np.empty(count,dtype=np.int32);mesh.loop_triangles.foreach_get('material_index',slots)
            layer=next((u for u in mesh.uv_layers if u.active_render),mesh.uv_layers.active)
            uv=np.zeros((len(mesh.loops),2),dtype='<f4')
            if layer:layer.data.foreach_get('uv',uv.ravel())
            for slot_id in np.unique(slots):
                material=obj.material_slots[int(slot_id)].material if int(slot_id)<len(obj.material_slots) else None
                material_id=assets.material(material);meta=assets.materials[material_id-1]
                invalid=[role for role,mapping in meta['maps'].items() if mapping['uv'] and (not layer or mapping['uv']!=layer.name)]
                if invalid:
                    meta=copy.deepcopy(meta)
                    for role in invalid:
                        assets.warnings.append({'material':meta['name'],'object':obj.name,'role':role,'reason':'Missing requested UV layer '+meta['maps'][role]['uv']+'; original material constant used'})
                        del meta['maps'][role]
                    assets.materials.append(meta);material_id=len(assets.materials)
                color=list(material.diffuse_color[:3]) if material else [.6,.6,.6]
                if material and material.use_nodes:
                    node=next((n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
                    if node:color=list(node.inputs['Base Color'].default_value[:3])
                family=len(families)+1;families.append({'id':family,'object':obj.name+' / '+meta['name'],'materialName':meta['name'],'copies':0,'trianglesPerCopy':int(np.count_nonzero(slots==slot_id)),'bounds':[lo.tolist(),hi.tolist()]})
                selected=np.flatnonzero(slots==slot_id)
                for start in range(0,len(selected),20000):
                    ids=selected[start:start+20000];pos=coords[triangles[ids]];tex=uv[loops[ids]]
                    normals=np.cross(pos[:,1]-pos[:,0],pos[:,2]-pos[:,0]);normals/=np.maximum(np.linalg.norm(normals,axis=1)[:,None],1e-20)
                    vertices=np.empty((len(ids)*3,8),dtype='<f4');vertices[:,:3]=pos.reshape(-1,3);vertices[:,3:6]=np.repeat(normals,3,axis=0);vertices[:,6:8]=tex.reshape(-1,2)
                    records=np.ascontiguousarray(vertices).view(np.dtype((np.void,32))).ravel();_,unique,inverse=np.unique(records,return_index=True,return_inverse=True)
                    vertices=vertices[unique];indices=inverse.astype('<u4');idx=len(groups)
                    vfile=f'part-{idx}.vertices.bin';ifile=f'part-{idx}.indices.bin';vertices.tofile(OUT/vfile);indices.tofile(OUT/ifile)
                    groups.append({'name':mesh.name,'family':family,'material':material_id,'color':color,'vertices':vfile,'indices':ifile,'vertexCount':len(vertices),'indexCount':len(indices),'vertexDigest':hashlib.sha256(vertices.tobytes()).hexdigest(),'indexDigest':hashlib.sha256(indices.tobytes()).hexdigest(),'instances':[],'objects':[]})
                    cache[key].append(idx)
                    PROGRESS.write_text(json.dumps({'status':'exporting','object':oi+1,'totalObjects':len(objects),'name':obj.name,'parts':len(groups),'seconds':time.time()-started},ensure_ascii=False));yield
            del coords,triangles,loops,slots,uv
        used_families=set()
        for idx in cache[key]:
            g=groups[idx];g['instances'].append(packed);g['objects'].append(obj.name);used_families.add(g['family'])
        for fid in used_families:
            f=families[fid-1];f['copies']+=1;f['bounds']=[np.minimum(f['bounds'][0],lo).tolist(),np.maximum(f['bounds'][1],hi).tolist()]
        rows.append({'name':obj.name,'triangles':sum(groups[i]['indexCount']//3 for i in cache[key])})
    manifest={'version':2,'name':'M8 — полная сцена','source':bpy.data.filepath,'anchorObject':'scene bounds centre','anchorBlender':anchor.tolist(),'cropRule':'all visible meshes; no clipping or decimation; original linked geometry shared; flat normals','materials':'UV, base colour and source PBR maps; name-based surface defaults','bounds':[x.tolist() for x in bounds],'groups':groups,'objects':rows,'families':families,'triangles':sum(o['triangles'] for o in rows),'exportSeconds':time.time()-started}
    raw=json.dumps(manifest,ensure_ascii=False).encode();(OUT/'scene.json').write_bytes(raw);digest=hashlib.sha256(raw).hexdigest()
    (OUT/'textures.json').write_text(json.dumps({'version':1,'sourceDigest':digest,'groups':[],'images':assets.images,'materials':assets.materials,'warnings':assets.warnings},ensure_ascii=False))
    PROGRESS.write_text(json.dumps({'status':'complete','objects':len(rows),'parts':len(groups),'families':len(families),'triangles':manifest['triangles'],'materials':len(assets.materials),'images':len(assets.images),'warnings':assets.warnings,'geometryBytes':sum(p.stat().st_size for p in OUT.glob('*.bin')),'seconds':time.time()-started},ensure_ascii=False))

def start():
    steps=export_steps()
    def tick():
        try:next(steps);return .001
        except StopIteration:return None
        except Exception:PROGRESS.write_text(json.dumps({'status':'error','error':traceback.format_exc()}));return None
    PROGRESS.write_text(json.dumps({'status':'starting'}));bpy.app.timers.register(tick,first_interval=.01)
