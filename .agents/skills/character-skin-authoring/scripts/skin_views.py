"""Deterministic visible-surface projection. The agent supplies all semantic labels.

prepare uses Blender BVH rays (no lighting, AI, color classification or pose guesses).
bake projects reviewed polygons into UV space, retaining unknown/conflict coverage.
"""
import argparse,hashlib,json,subprocess,sys,shutil
from pathlib import Path
import numpy as np

LABELS={'unknown':0,'skin':1,'palm':2,'sole':3,'lips':4,'eyes':5,'hair':6,'nails':7,'non_skin':8,'dorsal_hand':9}

def dense_worker(c,bvh,p,tri,uv,mi):
    """Inverse UV bake: texel -> surface -> annotated view, with exact visibility."""
    from mathutils import Vector
    n=c['resolution'];out=Path(c['output']);height=np.ptp(p[:,2]);distance=np.linalg.norm(np.ptp(p,axis=0))*2
    center=(p.min(0)+p.max(0))/2;all_votes=[];overlaps=[]
    for material in range(len(c['materials'])):
        position=np.zeros((n*n,3),np.float32);face_ids=np.full(n*n,-1,np.int32);overlap=np.zeros(n*n,bool)
        selected=np.flatnonzero(mi==material)
        for batch in np.array_split(selected,max(1,int(np.ceil(len(selected)/2048)))):
            q=uv[batch].copy();q[:,:,1]=1-q[:,:,1];q=q*n-.5
            lo=np.maximum(np.ceil(q.min(1)).astype(int),0);hi=np.minimum(np.floor(q.max(1)).astype(int),n-1)
            width=np.maximum(hi[:,0]-lo[:,0]+1,0);height_px=np.maximum(hi[:,1]-lo[:,1]+1,0);count=width*height_px
            if count.sum()==0:continue
            local=np.repeat(np.arange(len(batch)),count);starts=np.repeat(np.cumsum(count)-count,count);offset=np.arange(count.sum())-starts
            x=lo[local,0]+offset%width[local];y=lo[local,1]+offset//width[local];t=q[local]
            den=(t[:,1,1]-t[:,2,1])*(t[:,0,0]-t[:,2,0])+(t[:,2,0]-t[:,1,0])*(t[:,0,1]-t[:,2,1]);safe=np.where(abs(den)>1e-12,den,1)
            a=((t[:,1,1]-t[:,2,1])*(x-t[:,2,0])+(t[:,2,0]-t[:,1,0])*(y-t[:,2,1]))/safe
            b=((t[:,2,1]-t[:,0,1])*(x-t[:,2,0])+(t[:,0,0]-t[:,2,0])*(y-t[:,2,1]))/safe;d=1-a-b
            valid=(abs(den)>1e-12)&(a>=0)&(b>=0)&(d>=0);idx=(y*n+x)[valid];f=batch[local[valid]]
            xyz=(p[tri[f,0]]*a[valid,None]+p[tri[f,1]]*b[valid,None]+p[tri[f,2]]*d[valid,None])
            # Record distinct surfaces sharing a texel, including collisions within a batch.
            order=np.argsort(idx,kind='stable');ii=idx[order];xx=xyz[order];dup=ii[1:]==ii[:-1]
            overlap[ii[1:][dup&(np.linalg.norm(xx[1:]-xx[:-1],axis=1)>height*1e-5)]]=True
            exists=face_ids[idx]>=0;overlap[idx[exists&(np.linalg.norm(position[idx]-xyz,axis=1)>height*1e-5)]]=True
            position[idx]=xyz;face_ids[idx]=f
        occupied=face_ids>=0
        view_bits=np.zeros(n*n,np.uint32);visibility_bits=np.zeros(n*n,np.uint32)
        v=np.zeros((len(LABELS),n*n),np.uint32)
        normals=np.cross(p[tri[:,1]]-p[tri[:,0]],p[tri[:,2]]-p[tri[:,0]]);normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-15)
        for view_index,view in enumerate(c['views']):
            if view_index>=32:raise ValueError('Surface evidence supports at most 32 views per revision')
            label_path=out/(view['name']+'-annotation.npy')
            if not label_path.exists() and not c.get('surfaceData'):continue
            labels=np.load(label_path) if label_path.exists() else np.zeros((c['size'],c['size']),np.uint8);direction=np.array(view['direction'],float);direction/=np.linalg.norm(direction)
            up=np.array(view.get('up',[0,0,1]),float);right=np.cross(direction,up);right/=np.linalg.norm(right);up=np.cross(right,direction)
            target=center+height*np.array(view.get('targetOffset',[0,0,0]));span=height*view.get('span',1.1)
            ids=np.flatnonzero(occupied&~overlap);points=position[ids];delta=points-target
            x=np.floor((delta@right/span+.5)*c['size']).astype(int);y=np.floor((.5-delta@up/span)*c['size']).astype(int)
            keep=(x>=0)&(x<c['size'])&(y>=0)&(y<c['size'])&(abs(normals[face_ids[ids]]@direction)>.2)
            ids=ids[keep];x=x[keep];y=y[keep];label=labels[y,x];keep=np.ones(len(label),bool) if c.get('surfaceData') else label>0;ids=ids[keep];label=label[keep];ray=Vector(direction.tolist())
            for index,kind in zip(ids,label):
                point=position[index];hit,_,_,_=bvh.ray_cast(Vector((point-direction*distance).tolist()),ray,distance*2)
                if hit is not None and np.linalg.norm(np.asarray(hit)-point)<height*1e-5:
                    visibility_bits[index]|=np.uint32(1<<view_index)
                    if kind>0:v[kind,index]+=1;view_bits[index]|=np.uint32(1<<view_index)
            print('UV visibility',material,view['name'],len(ids),flush=True)
        if c.get('surfaceData'):np.savez_compressed(out/f'material-{material}-surface.npz',position=position.reshape(n,n,3),normal=normals[np.maximum(face_ids,0)].astype(np.float32).reshape(n,n,3),occupied=occupied.reshape(n,n),viewBits=view_bits.reshape(n,n),visibilityBits=visibility_bits.reshape(n,n))
        all_votes.append(v.reshape(len(LABELS),n,n));overlaps.append(overlap.reshape(n,n))
    np.savez_compressed(out/'dense-votes.npz',**{f'm{i}':v for i,v in enumerate(all_votes)},**{f'overlap{i}':a for i,a in enumerate(overlaps)})

def triangle_worker(c,bvh,p,tri):
    """Classify actual triangle centers against the same reviewed camera evidence.

    This avoids raster-resolution-dependent primitive boundaries. Visibility is exact;
    no UV hole filling or spatial anatomy rules are involved.
    """
    from mathutils import Vector
    out=Path(c['output']);points=p[tri].mean(1);height=np.ptp(p[:,2]);center=(p.min(0)+p.max(0))/2;distance=np.linalg.norm(np.ptp(p,axis=0))*2
    normals=np.cross(p[tri[:,1]]-p[tri[:,0]],p[tri[:,2]]-p[tri[:,0]]);normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-15)
    bits=np.zeros(len(tri),np.uint16)
    for view in c['views']:
        label_path=out/(view['name']+'-annotation.npy')
        if not label_path.exists():continue
        labels=np.load(label_path);direction=np.asarray(view['direction'],float);direction/=np.linalg.norm(direction)
        up=np.asarray(view.get('up',[0,0,1]),float);right=np.cross(direction,up);right/=np.linalg.norm(right);up=np.cross(right,direction)
        target=center+height*np.asarray(view.get('targetOffset',[0,0,0]));span=height*view.get('span',1.1);delta=points-target
        x=np.floor((delta@right/span+.5)*c['size']).astype(int);y=np.floor((.5-delta@up/span)*c['size']).astype(int)
        valid=(x>=0)&(x<c['size'])&(y>=0)&(y<c['size'])&(abs(normals@direction)>.2);ids=np.flatnonzero(valid);kinds=labels[y[ids],x[ids]];valid=kinds>0;ids=ids[valid];kinds=kinds[valid];ray=Vector(direction.tolist())
        for index,kind in zip(ids,kinds):
            point=points[index];hit,_,_,_=bvh.ray_cast(Vector((point-direction*distance).tolist()),ray,distance*2)
            if hit is not None and np.linalg.norm(np.asarray(hit)-point)<height*1e-5:bits[index]|=np.uint16(1<<int(kind))
        print('Triangle visibility',view['name'],len(ids),flush=True)
    subtype=(bits&((1<<2)|(1<<3)|(1<<9)))!=0;bits[subtype]&=np.uint16(65535^(1<<1));conflict=(bits&(bits-1))!=0
    labels=np.zeros(len(tri),np.uint8)
    for kind in LABELS.values():
        if kind:labels[bits==(1<<kind)]=kind
    np.savez_compressed(out/'triangles.npz',centers=points.astype(np.float32),labels=labels,conflict=conflict)

def worker(config):
    import bpy
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    c=json.loads(Path(config).read_text());out=Path(c['output'])
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=c['source'])
    depsgraph=bpy.context.evaluated_depsgraph_get()
    vertices=[];triangles=[];uvs=[];mats=[];materials=[];offset=0
    for obj in bpy.context.scene.objects:
        if obj.type!='MESH':continue
        evaluated=obj.evaluated_get(depsgraph);mesh=evaluated.to_mesh();mesh.calc_loop_triangles()
        if mesh.uv_layers.active is None:raise ValueError(f'Missing UVs: {obj.name}')
        vertices.extend([tuple(evaluated.matrix_world@v.co) for v in mesh.vertices])
        slots=[]
        for slot in obj.material_slots:
            material=slot.material
            if material not in materials:materials.append(material)
            slots.append(materials.index(material))
        for t in mesh.loop_triangles:
            triangles.append([offset+i for i in t.vertices]);uvs.append([tuple(mesh.uv_layers.active.data[i].uv) for i in t.loops]);mats.append(slots[t.material_index])
        offset+=len(mesh.vertices);evaluated.to_mesh_clear()
    p=np.array(vertices);tri=np.array(triangles);uv=np.array(uvs);mi=np.array(mats)
    bvh=BVHTree.FromPolygons(vertices,triangles,all_triangles=True)
    textures=[];info=[]
    for m in materials:
        bsdf=next((n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'),None)
        if bsdf is None:raise ValueError('Expected Principled base-color material')
        socket=bsdf.inputs['Base Color'];color=np.array(socket.default_value[:3]);im=None
        if socket.is_linked:
            node=socket.links[0].from_node
            if node.type!='TEX_IMAGE':raise ValueError('Base color must link directly to its image; prepare a faithful albedo bake first')
            im=node.image
        if im:
            if im.is_float:raise ValueError('Floating-point base-color images need an explicit sRGB albedo bake for evidence')
            # Blender byte-image buffers expose encoded channel values. Encoding
            # these again washes out the evidence (128 becomes about 188).
            pixels=np.array(im.pixels[:],dtype=np.float32).reshape(im.size[1],im.size[0],4)[:,:,:3]
        else:
            pixels=np.where(color<=.0031308,color*12.92,1.055*np.maximum(color,0)**(1/2.4)-.055).reshape(1,1,3)
        textures.append(pixels);info.append({'name':m.name,'width':pixels.shape[1],'height':pixels.shape[0]})
    if c.get('mode')=='dense':
        if [x['name'] for x in info]!=[x['name'] for x in c['materials']]:raise ValueError('Material order changed')
        dense_worker(c,bvh,p,tri,uv,mi)
        if c.get('triangleLabels'):triangle_worker(c,bvh,p,tri)
        return
    lo=p.min(0);hi=p.max(0);center=(lo+hi)/2;height=hi[2]-lo[2]
    # Blender world axes are recorded, not assumed to mean anatomical front.
    for view in c['views']:
        direction=np.array(view['direction'],dtype=float)
        if direction.shape!=(3,) or not np.isfinite(direction).all() or np.linalg.norm(direction)==0:raise ValueError('Invalid view direction')
        direction/=np.linalg.norm(direction)
        up=np.array(view.get('up',[0,0,1]),dtype=float);right=np.cross(direction,up)
        if np.linalg.norm(right)<1e-8:raise ValueError('View up is parallel to direction')
        right/=np.linalg.norm(right);up=np.cross(right,direction)
        target=center+height*np.array(view.get('targetOffset',[0,0,0]));span=height*view.get('span',1.1)
        n=c['size'];rgb=np.full((n,n,3),.2,np.float32);coord=np.zeros((n,n,2),np.float32);material_ids=np.full((n,n),-1,np.int16);facing=np.zeros((n,n),np.float32)
        distance=float(np.linalg.norm(hi-lo)*2);ray=Vector(direction.tolist())
        for y in range(n):
            for x in range(n):
                origin=target-direction*distance+right*((x+.5)/n-.5)*span+up*(.5-(y+.5)/n)*span
                hit,normal,face,_=bvh.ray_cast(Vector(origin.tolist()),ray,distance*2)
                if face is None:continue
                a,b,d=p[tri[face]];v0=b-a;v1=d-a;v2=np.array(hit)-a
                aa=v0@v0;ab=v0@v1;bb=v1@v1;ac=v0@v2;bc=v1@v2;den=aa*bb-ab*ab
                if abs(den)<1e-20:continue
                wb=(bb*ac-ab*bc)/den;wc=(aa*bc-ab*ac)/den
                texuv=(1-wb-wc)*uv[face,0]+wb*uv[face,1]+wc*uv[face,2]
                mat=int(mi[face]);pixels=textures[mat];h,w=pixels.shape[:2]
                xx=int(np.clip(texuv[0]*w,0,w-1));yy=int(np.clip(texuv[1]*h,0,h-1))
                rgb[y,x]=pixels[yy,xx];coord[y,x]=texuv;material_ids[y,x]=mat;facing[y,x]=abs(np.dot(normal,direction))
        np.savez_compressed(out/(view['name']+'.npz'),uv=coord,material=material_ids,facing=facing)
        np.save(out/(view['name']+'.rgb.npy'),np.uint8(np.clip(rgb,0,1)*255))
        print('Rendered',view['name'],flush=True)
    c['materials']=info;c['worldBounds']=[lo.tolist(),hi.tolist()];c['labels']=LABELS;c['evidenceColorSpace']='sRGB';c['byteImageTransfer']='encoded values preserved; no additional sRGB encoding'
    (out/'manifest.json').write_text(json.dumps(c,indent=2)+'\n')

def prepare(args):
    from PIL import Image
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    if (out/'manifest.json').exists():raise ValueError('Use a new output revision; existing evidence is immutable')
    source=Path(args.source).resolve();views=json.loads(Path(args.views).read_text())
    c={'source':str(source),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'output':str(out),'size':args.size,'views':views}
    config=out/'request.json';config.write_text(json.dumps(c,indent=2))
    blender=args.blender or shutil.which('blender')
    if not blender and Path('/Applications/Blender.app/Contents/MacOS/Blender').exists():blender='/Applications/Blender.app/Contents/MacOS/Blender'
    if not blender:raise ValueError('Pass --blender with the local Blender executable')
    subprocess.run([blender,'--background','--python-exit-code','1','--python',str(Path(__file__).resolve()),'--','worker',str(config)],check=True)
    for view in views:
        path=out/(view['name']+'.rgb.npy');Image.fromarray(np.load(path)).save(out/(view['name']+'.png'));path.unlink()
    manifest=json.loads((out/'manifest.json').read_text())
    manifest['evidenceHashes']={view['name']+ext:hashlib.sha256((out/(view['name']+ext)).read_bytes()).hexdigest() for view in views for ext in ['.png','.npz']}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')

def bake(args):
    from PIL import Image,ImageDraw
    folder=Path(args.evidence);m=json.loads((folder/'manifest.json').read_text());annotation=json.loads(Path(args.annotations).read_text());out=Path(args.output)
    if out.exists():raise ValueError('Use a fresh bake output directory')
    if annotation['sourceSha256']!=m['sourceSha256']:raise ValueError('Annotations belong to a different mesh')
    if hashlib.sha256(Path(m['source']).read_bytes()).hexdigest()!=m['sourceSha256']:raise ValueError('Source changed after rendering')
    for name in [v['name'] for v in m.get('views', [])] or annotation['views']:
        for ext in ['.png','.npz']:
            expected=m.get('evidenceHashes',{}).get(name+ext)
            if expected is not None and hashlib.sha256((folder/(name+ext)).read_bytes()).hexdigest()!=expected:raise ValueError('Evidence changed after rendering: '+name+ext)
    # Reject authoring errors before reserving the immutable output revision.
    # A corrected annotation can then retry the same destination safely.
    for name,regions in annotation['views'].items():
        if not (folder/(name+'.npz')).is_file():raise ValueError('Unknown annotation view: '+name)
        with Image.open(folder/(name+'.png')) as view:
            if list(view.size)!=[m['size'],m['size']]:raise ValueError('Evidence dimensions changed')
        for region in regions:
            if region['label'] not in LABELS:raise ValueError('Unknown annotation label: '+region['label'])
            points=region['polygon']
            if len(points)<3 or not all(0<=x<m['size'] and 0<=y<m['size'] for x,y in points):raise ValueError('Invalid annotation polygon in '+name)
    out.mkdir(parents=True);shutil.copyfile(args.annotations,out/'annotations.json');n=args.resolution;votes=[np.zeros((len(LABELS),n,n),np.uint32) for _ in m['materials']]
    for name,regions in annotation['views'].items():
        data=np.load(folder/(name+'.npz'));uv=data['uv'];ids=data['material'];view=Image.open(folder/(name+'.png'))
        if list(view.size)!=[m['size'],m['size']]:raise ValueError('Evidence dimensions changed')
        labels=Image.new('L',view.size,0);draw=ImageDraw.Draw(labels)
        for region in regions:
            label=LABELS[region['label']];points=region['polygon']
            if len(points)<3 or not all(0<=x<m['size'] and 0<=y<m['size'] for x,y in points):raise ValueError('Invalid annotation polygon')
            draw.polygon([tuple(p) for p in points],fill=label)
        a=np.array(labels);a[ids<0]=0;palette=np.array([[0,0,0],[50,210,100],[60,170,210],[80,130,200],[240,90,140],[70,140,255],[180,60,200],[240,230,150],[140,140,140],[90,210,140]],dtype=np.uint8)
        rgb=np.array(view.convert('RGB'));overlay=np.where((a>0)[...,None],(.45*rgb+.55*palette[a]).astype('uint8'),rgb)
        Image.fromarray(overlay).save(out/(name+'-overlay.png'))
        np.save(out/(name+'-annotation.npy'),a)
        for mat in range(len(votes)):
            ok=(ids==mat)&(a>0)&(data['facing']>.2)&(uv[:,:,0]>=0)&(uv[:,:,0]<=1)&(uv[:,:,1]>=0)&(uv[:,:,1]<=1)
            x=np.clip((uv[:,:,0][ok]*n).astype(int),0,n-1);y=np.clip(((1-uv[:,:,1][ok])*n).astype(int),0,n-1)
            np.add.at(votes[mat],(a[ok],y,x),1)
    uv_overlaps=[np.zeros((n,n),bool) for _ in votes]
    if getattr(args,'dense',False):
        c=dict(m,mode='dense',output=str(out.resolve()),resolution=n,surfaceData=getattr(args,'surface_data',False),triangleLabels=getattr(args,'triangle_labels',False));config=out/'dense-request.json';config.write_text(json.dumps(c))
        blender=getattr(args,'blender',None) or shutil.which('blender')
        if not blender and Path('/Applications/Blender.app/Contents/MacOS/Blender').exists():blender='/Applications/Blender.app/Contents/MacOS/Blender'
        if not blender:raise ValueError('Pass --blender for dense baking')
        subprocess.run([blender,'--background','--python-exit-code','1','--python',str(Path(__file__).resolve()),'--','worker',str(config.resolve())],check=True)
        d=np.load(out/'dense-votes.npz');votes=[d[f'm{i}'] for i in range(len(votes))];uv_overlaps=[d[f'overlap{i}'] for i in range(len(votes))]
    report={'sourceSha256':m['sourceSha256'],'annotationSha256':hashlib.sha256(Path(args.annotations).read_bytes()).hexdigest(),'status':'review_required','method':'inverse_uv_visibility' if getattr(args,'dense',False) else 'sparse_projection','resolution':n,'labels':LABELS,'materials':[],'views':[]}
    results=[];conflicts=[]
    for i,v in enumerate(votes):
        present=v>0
        # A generic skin observation agrees with a more specific skin subtype.
        # Palm versus dorsal hand (or skin versus hair) remains a real conflict.
        subtype=present[[LABELS['palm'],LABELS['sole'],LABELS['dorsal_hand']]].any(0)
        v[LABELS['skin'],subtype]=0;present=v>0
        conflict=(present.sum(0)>1)|uv_overlaps[i];known=present.any(0);labels=v.argmax(0).astype('uint8');labels[conflict]=0
        results.append(labels);conflicts.append(conflict)
        # Sparse evidence stays sparse. Never silently fill an unseen palm/back.
        Image.fromarray(labels).save(out/f'material-{i}-labels.png');Image.fromarray(np.uint8(known&~conflict)*255).save(out/f'material-{i}-observed.png');Image.fromarray(np.uint8(conflict)*255).save(out/f'material-{i}-conflicts.png')
        report['materials'].append({'material':m['materials'][i]['name'],'observedTexels':int(known.sum()),'conflictTexels':int(conflict.sum()),'overlappingUvTexels':int(uv_overlaps[i].sum()),'labelCounts':{k:int((labels==v).sum()) for k,v in LABELS.items()}})
    # Review the BAKED atlas through the original visibility buffer, not just polygons.
    for name in [v['name'] for v in m.get('views', [])] or annotation['views']:
        d=np.load(folder/(name+'.npz'));uv=d['uv'];ids=d['material'];visible=ids>=0
        x=np.clip((uv[:,:,0]*n).astype(int),0,n-1);y=np.clip(((1-uv[:,:,1])*n).astype(int),0,n-1)
        a=np.zeros(ids.shape,np.uint8);conflict=np.zeros(ids.shape,bool)
        for mat in range(len(results)):
            valid=(ids==mat)&(uv[:,:,0]>=0)&(uv[:,:,0]<=1)&(uv[:,:,1]>=0)&(uv[:,:,1]<=1)
            a[valid]=results[mat][y[valid],x[valid]];conflict[valid]=conflicts[mat][y[valid],x[valid]]
        rgb=np.array(Image.open(folder/(name+'.png')).convert('RGB'))
        color=palette[a];color[conflict]=[255,80,20];unknown=visible&(a==0)&~conflict
        color[unknown]=[160,45,45]
        overlay=np.where(visible[...,None],(.5*rgb+.5*color).astype('uint8'),rgb)
        Image.fromarray(overlay).save(out/(name+'-reprojected.png'))
        Image.fromarray(a).save(out/(name+'-reprojected-labels.png'))
        annotation_path=out/(name+'-annotation.npy');expected=np.load(annotation_path) if annotation_path.exists() else np.zeros_like(a)
        annotated=visible&(expected>0)&(d['facing']>.2)
        report['views'].append({'name':name,'visiblePixels':int(visible.sum()),'unknownPixels':int(unknown.sum()),'conflictPixels':int(conflict.sum()),'classifiedPixels':int((a>0).sum()),'annotatedVisiblePixels':int(annotated.sum()),'unresolvedAnnotatedPixels':int((annotated&(a==0)).sum()),'disagreeingAnnotatedPixels':int((annotated&(a>0)&(a!=expected)&~((expected==LABELS['skin'])&np.isin(a,[LABELS['palm'],LABELS['sole'],LABELS['dorsal_hand']]))).sum())})
    (out/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

if __name__=='__main__':
    if '--' in sys.argv:
        worker(sys.argv[sys.argv.index('--')+2]);sys.exit()
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='command',required=True)
    a=sub.add_parser('prepare');a.add_argument('--source',required=True);a.add_argument('--views',required=True);a.add_argument('--output',required=True);a.add_argument('--size',type=int,default=512);a.add_argument('--blender')
    a=sub.add_parser('bake');a.add_argument('--evidence',required=True);a.add_argument('--annotations',required=True);a.add_argument('--output',required=True);a.add_argument('--resolution',type=int,default=1024);a.add_argument('--dense',action='store_true');a.add_argument('--surface-data',action='store_true');a.add_argument('--triangle-labels',action='store_true');a.add_argument('--blender')
    args=p.parse_args();prepare(args) if args.command=='prepare' else bake(args)
