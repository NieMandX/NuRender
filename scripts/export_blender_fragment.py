"""Read-only mesh extraction from the live Blender scene. No operators or saves.
Run through Blender MCP; output is confined to the NuRender project.
Triangles are clipped to a 100 x 100 m world XY box; no interior decimation.
Geometry retains base colour; a sidecar preserves names and per-vertex material slots.
"""
import bpy, numpy as np, json, pathlib, hashlib, time, sys
from mathutils import Vector
sys.path.insert(0,'/Users/mac/Documents/ChatGPT/NuRender/scripts')
from blender_texture_assets import TextureAssets
started=time.time()
out=pathlib.Path(globals().get('NUR_OUT','/Users/mac/Documents/ChatGPT/NuRender/public/scenes/m8-fragment'))
out.mkdir(parents=True,exist_ok=True)
active=bpy.data.objects[globals()['NUR_ANCHOR']] if globals().get('NUR_ANCHOR') else bpy.context.view_layer.objects.active
assets=TextureAssets(out);texture_groups=[]
anchor=np.array(active.matrix_world @ (sum((Vector(c) for c in active.bound_box),Vector())/8),dtype=np.float64)
half=50.0
conversion=np.array([[1,0,0,0],[0,0,1,0],[0,-1,0,0],[0,0,0,1]],dtype=np.float64)
converted_anchor=conversion[:3,:3]@anchor
cache={};groups=[];objects=[];material_groups=[];bounds=[np.full(3,np.inf),np.full(3,-np.inf)]
for obj in bpy.context.scene.objects:
    if obj.type!='MESH' or not obj.visible_get(): continue
    mw=np.array(obj.matrix_world,dtype=np.float64)
    bbox=np.array([list(obj.matrix_world @ Vector(c)) for c in obj.bound_box])
    if any(bbox[:,a].max()<anchor[a]-half or bbox[:,a].min()>anchor[a]+half for a in (0,1)): continue
    mesh=obj.data
    mesh.calc_loop_triangles()
    coords=np.empty(len(mesh.vertices)*3,dtype=np.float32);mesh.vertices.foreach_get('co',coords);coords=coords.reshape(-1,3)
    triangles=np.empty(len(mesh.loop_triangles)*3,dtype=np.int32);mesh.loop_triangles.foreach_get('vertices',triangles);triangles=triangles.reshape(-1,3)
    loops=np.empty(len(mesh.loop_triangles)*3,dtype=np.int32);mesh.loop_triangles.foreach_get('loops',loops);loops=loops.reshape(-1,3)
    uv_layer=next((u for u in mesh.uv_layers if u.active_render),mesh.uv_layers.active)
    uv=np.zeros((len(mesh.loops),2),dtype=np.float32)
    if uv_layer:uv_layer.data.foreach_get('uv',uv.ravel())
    # Broad-phase AABB filtering in chunks, then exact clipping of boundary triangles.
    kept=[]
    for start in range(0,len(triangles),200000):
        tri=triangles[start:start+200000]
        world=coords[tri].astype(np.float64)@mw[:3,:3].T+mw[:3,3]
        mask=np.all((world[:,:,:2].max(axis=1)>=anchor[:2]-half)&(world[:,:,:2].min(axis=1)<=anchor[:2]+half),axis=1)
        kept.append(np.flatnonzero(mask)+start)
    selected=np.concatenate(kept) if kept else np.empty(0,dtype=np.int64)
    if not len(selected): continue
    materials=[];material_names=[];texture_ids=[]
    for slot in obj.material_slots:
        mat=slot.material
        color=list(mat.diffuse_color[:3]) if mat else [.6,.6,.6]
        if mat and mat.use_nodes:
            node=next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
            if node:
                socket=next((s for s in node.inputs if s.identifier=='Base Color'),None)
                if socket: color=list(socket.default_value[:3])
        materials.append(color);material_names.append(mat.name if mat else '');texture_ids.append(assets.material(mat))
    if not materials: materials=[[.6,.6,.6]];material_names=[''];texture_ids=[assets.material(None)]
    for mid in texture_ids:
        for mapping in assets.materials[mid-1]['maps'].values():
            if mapping['uv'] and (not uv_layer or mapping['uv']!=uv_layer.name):raise ValueError('Multiple UV layers need explicit export support')
    local=coords[triangles[selected]].astype(np.float64)
    world=local@mw[:3,:3].T+mw[:3,3]
    inside=np.all(np.abs(world[:,:,:2]-anchor[:2])<=half,axis=(1,2))
    local_uv=uv[loops[selected]]
    clipped=[];sources=[];clipped_uv=[]
    for k in np.flatnonzero(~inside):
        poly=[(local[k,j],world[k,j],local_uv[k,j].astype(np.float64)) for j in range(3)]
        for axis,limit,sign in [(0,anchor[0]-half,1),(0,anchor[0]+half,-1),(1,anchor[1]-half,1),(1,anchor[1]+half,-1)]:
            result=[]
            for j in range(len(poly)):
                previous=poly[j-1];current=poly[j]
                dp=(previous[1][axis]-limit)*sign;dc=(current[1][axis]-limit)*sign
                if (dp>=0)!=(dc>=0):
                    t=dp/(dp-dc);result.append((previous[0]+t*(current[0]-previous[0]),previous[1]+t*(current[1]-previous[1]),previous[2]+t*(current[2]-previous[2])))
                if dc>=0: result.append(current)
            poly=result
            if not poly: break
        for j in range(1,len(poly)-1):
            clipped.append([poly[0][0],poly[j][0],poly[j+1][0]]);sources.append(selected[k]);clipped_uv.append([poly[0][2],poly[j][2],poly[j+1][2]])
    pos=np.concatenate([local[inside],np.asarray(clipped).reshape(-1,3,3)]).astype(np.float32)
    triangle_sources=np.concatenate([selected[inside],np.asarray(sources,dtype=np.int64)])
    triangle_uv=np.concatenate([local_uv[inside],np.asarray(clipped_uv).reshape(-1,3,2)]).astype('<f4')
    if not len(pos): continue
    signature=(mesh.name,hashlib.sha256(pos.tobytes()).hexdigest(),str(materials),str(material_names))
    transform=conversion@mw;transform[:3,3]-=converted_anchor
    normal=np.linalg.inv(transform[:3,:3]).T
    packed=np.concatenate([transform.T.reshape(-1),np.column_stack([normal.T,np.zeros(3)]).reshape(-1)]).astype('<f4')
    if signature not in cache:
        idx=len(groups);cache[signature]=idx
        # Flat normals deliberately match triangle geometry, including split faces.
        normals=np.cross(pos[:,1]-pos[:,0],pos[:,2]-pos[:,0]);length=np.linalg.norm(normals,axis=1)
        normals/=np.maximum(length[:,None],1e-20)
        mi=np.empty(len(mesh.loop_triangles),dtype=np.int32);mesh.loop_triangles.foreach_get('material_index',mi)
        slots=np.clip(mi[triangle_sources],0,len(materials)-1)
        palette=np.asarray(materials,dtype=np.float32);color=palette[slots]
        vertices=np.zeros((len(pos)*3,10),dtype='<f4');vertices[:,:3]=pos.reshape(-1,3);vertices[:,3:6]=np.repeat(normals,3,axis=0);vertices[:,6:9]=np.repeat(color,3,axis=0)
        # Index exact vertex records to retain hard edges/material boundaries.
        records=np.ascontiguousarray(vertices).view(np.dtype((np.void,40))).ravel()
        _,unique,inverse=np.unique(records,return_index=True,return_inverse=True)
        vertex_slots=np.repeat(slots,3)[unique].astype('<u4')
        # Equal-colour materials can share geometry but must retain distinct IDs.
        if not np.array_equal(vertex_slots[inverse],np.repeat(slots,3)):
            keyed=np.column_stack([vertices,np.repeat(slots,3)]).astype('<f4')
            _,unique,inverse=np.unique(keyed.view(np.dtype((np.void,44))).ravel(),return_index=True,return_inverse=True)
            vertex_slots=np.repeat(slots,3)[unique].astype('<u4')
        vertices=vertices[unique];indices=inverse.astype('<u4')
        vfile=f'group-{idx}.vertices.bin';ifile=f'group-{idx}.indices.bin'
        vertices.tofile(out/vfile);indices.tofile(out/ifile)
        sfile=f'group-{idx}.material-slots.bin';vertex_slots.tofile(out/sfile)
        texcoords=np.zeros((len(pos)*3,4),dtype='<f4');texcoords[:,:2]=triangle_uv.reshape(-1,2);texcoords[:,2]=np.repeat(np.asarray(texture_ids)[slots],3)
        tfile=f'group-{idx}.texcoords.bin';texcoords.tofile(out/tfile)
        texture_groups.append({'name':mesh.name,'file':tfile,'corners':len(indices),'uvLayer':uv_layer.name if uv_layer else None,'sha256':hashlib.sha256(texcoords.tobytes()).hexdigest()})
        material_groups.append({'name':mesh.name,'materialNames':material_names,'vertexSlots':sfile,'vertexCount':len(vertices)})
        groups.append({'name':mesh.name,'vertices':vfile,'indices':ifile,'vertexCount':len(vertices),'indexCount':len(indices),'instances':[],'objects':[]})
    group=groups[cache[signature]];group['instances'].append(packed.tolist());group['objects'].append(obj.name)
    used=pos.reshape(-1,3).astype(np.float64)
    world=used@transform[:3,:3].T+transform[:3,3]
    bounds[0]=np.minimum(bounds[0],world.min(axis=0));bounds[1]=np.maximum(bounds[1],world.max(axis=0))
    objects.append({'name':obj.name,'triangles':int(len(pos)),'sourceTriangles':len(triangles)})
manifest={'version':1,'name':'M8 — фрагмент из Blender','source':bpy.data.filepath,'anchorObject':active.name,'anchorBlender':anchor.tolist(),'cropHalfExtent':half,'cropRule':'exact clipping against world XY box; boundary triangles retriangulated; no interior decimation','materials':'base colour only; opaque; flat normals; no textures','bounds':[x.tolist() for x in bounds],'groups':groups,'objects':objects,'triangles':sum(o['triangles'] for o in objects),'exportSeconds':time.time()-started}
(out/'scene.json').write_text(json.dumps(manifest,ensure_ascii=False),encoding='utf8')
digest=hashlib.sha256((out/'scene.json').read_bytes())
for g in groups: digest.update((out/g['vertices']).read_bytes());digest.update((out/g['indices']).read_bytes())
(out/'materials.json').write_text(json.dumps({'version':1,'sourceDigest':digest.hexdigest(),'groups':material_groups},ensure_ascii=False),encoding='utf8')
(out/'textures.json').write_text(json.dumps({'version':1,'sourceDigest':digest.hexdigest(),'groups':texture_groups,'images':assets.images,'materials':assets.materials,'warnings':assets.warnings},ensure_ascii=False),encoding='utf8')
print(json.dumps({'objects':len(objects),'groups':len(groups),'triangles':manifest['triangles'],'bounds':manifest['bounds'],'bytes':sum(p.stat().st_size for p in out.iterdir()),'seconds':manifest['exportSeconds']},ensure_ascii=False))
