"""Read material graph/image data without modifying Blender datablocks."""
import bpy, numpy as np, hashlib, pathlib
from mathutils import Euler

class TextureAssets:
    def __init__(self, out):
        self.out=out;self.images=[];self.materials=[];self.image_ids={};self.material_ids={};self.warnings=[]
        (out/'textures').mkdir(parents=True,exist_ok=True)

    def image(self, image):
        if image.name in self.image_ids:return self.image_ids[image.name]
        if list(image.size)!=[1024,1024]:raise ValueError('Expected 1024 image: '+image.name)
        data=bytes(image.packed_file.data) if image.packed_file else pathlib.Path(bpy.path.abspath(image.filepath)).read_bytes()
        ext='.png' if data[:8]==b'\x89PNG\r\n\x1a\n' else '.jpg' if data[:2]==b'\xff\xd8' else None
        if not ext:raise ValueError('Unsupported packed image: '+image.name)
        digest=hashlib.sha256(data).hexdigest();file='textures/'+digest[:20]+ext
        (self.out/file).write_bytes(data)
        # Dedupe by bytes, retaining colour-space semantics on the map descriptor.
        old=next((i for i,row in enumerate(self.images) if row['sha256']==digest),None)
        index=len(self.images) if old is None else old
        if old is None:self.images.append({'file':file,'sha256':digest,'width':1024,'height':1024})
        self.image_ids[image.name]=index;return index

    def mapping(self, image_node):
        inp=image_node.inputs['Vector'];matrix=np.eye(4);uv_name=''
        if inp.is_linked:
            link=inp.links[0];node=link.from_node
            if node.type=='MAPPING':
                if any(node.inputs[n].is_linked for n in ['Location','Rotation','Scale']):raise ValueError('Animated/linked Mapping is unsupported')
                r=np.array(Euler(tuple(node.inputs['Rotation'].default_value),'XYZ').to_matrix())
                matrix[:3,:3]=r@np.diag(node.inputs['Scale'].default_value);matrix[:3,3]=node.inputs['Location'].default_value
                if node.vector_type=='TEXTURE':matrix=np.linalg.inv(matrix)
                elif node.vector_type!='POINT':raise ValueError('Unsupported Mapping type: '+node.vector_type)
                if not node.inputs['Vector'].is_linked:raise ValueError('Mapping has no UV source')
                link=node.inputs['Vector'].links[0];node=link.from_node
            if node.type=='UVMAP':uv_name=node.uv_map
            elif node.type!='TEX_COORD' or link.from_socket.identifier!='UV':raise ValueError('Only UV coordinates are supported')
        # Retain Blender V-up coordinates; the GPU sampler flips V exactly once.
        return [float(matrix[0,0]),float(matrix[0,1]),float(matrix[0,3]),float(matrix[1,0]),float(matrix[1,1]),float(matrix[1,3])],uv_name

    def map(self, socket, normal=False):
        if not socket or not socket.is_linked:return None
        link=socket.links[0];node=link.from_node;channel=0;strength=1
        if normal:
            if node.type!='NORMAL_MAP' or node.space!='TANGENT':raise ValueError('Only tangent Normal Map is supported')
            strength=float(node.inputs['Strength'].default_value)
            if not node.inputs['Color'].is_linked:return None
            link=node.inputs['Color'].links[0];node=link.from_node
        elif node.type=='SEPARATE_COLOR':
            channel={'Red':0,'Green':1,'Blue':2}[link.from_socket.identifier]
            link=node.inputs['Color'].links[0];node=link.from_node
        if node.type!='TEX_IMAGE' or not node.image:raise ValueError('Unsupported material connection: '+node.type)
        if node.extension!='REPEAT' or node.projection!='FLAT':raise ValueError('Only flat repeating image maps are supported')
        matrix,uv=self.mapping(node)
        return {'image':self.image(node.image),'matrix':matrix,'uv':uv,'channel':channel,'srgb':node.image.colorspace_settings.name=='sRGB','strength':strength}

    def material(self, mat):
        name=mat.name if mat else ''
        if name in self.material_ids:return self.material_ids[name]
        row={'name':name,'roughness':.7,'metallic':0,'maps':{}}
        if mat and mat.use_nodes:
            p=next((n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
            if p:
                row.update(roughness=float(p.inputs['Roughness'].default_value),metallic=float(p.inputs['Metallic'].default_value))
                for role,identifier in [('color','Base Color'),('roughness','Roughness'),('metallic','Metallic'),('normal','Normal')]:
                    try:
                        value=self.map(next((s for s in p.inputs if s.identifier==identifier),None),role=='normal')
                        if value:row['maps'][role]=value
                    except ValueError as error:self.warnings.append({'material':name,'role':role,'reason':str(error)})
        index=len(self.materials)+1;self.materials.append(row);self.material_ids[name]=index;return index
