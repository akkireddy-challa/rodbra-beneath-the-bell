"""Exact geometric support for detail vertices whose UV sample is unoccupied.

No anatomical inference: labels come from the same reviewed image annotations.
This changes vertex detail bindings only; the per-fragment skin atlas is untouched.
"""
import hashlib,json,subprocess,sys
from pathlib import Path
import numpy as np

ALGORITHM_VERSION=2

def resolve_labels(bits):
    bits=bits.copy();subtypes=(bits&((1<<2)|(1<<3)|(1<<9)))!=0
    bits[subtypes]&=np.uint16(65535^(1<<1))
    labels=np.zeros(len(bits),np.uint8)
    for kind in range(1,10):labels[bits==(1<<kind)]=kind
    return labels

def worker(request):
    import bpy
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    c=json.loads(Path(request).read_text());m=c['manifest'];bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.gltf(filepath=m['source'])
    vertices=[];triangles=[]
    for obj in bpy.context.scene.objects:
        if obj.type!='MESH':continue
        mesh=obj.data;mesh.calc_loop_triangles();offset=len(vertices)
        vertices.extend(tuple(obj.matrix_world@v.co) for v in mesh.vertices)
        triangles.extend(tuple(offset+i for i in t.vertices) for t in mesh.loop_triangles)
    bvh=BVHTree.FromPolygons(vertices,triangles,all_triangles=True)
    with np.load(c['queries'],allow_pickle=False) as q:points=q['points'];normals=q['normals']
    bounds=np.asarray(m['worldBounds']);height=np.ptp(bounds[:,2]);center=bounds.mean(0);distance=np.linalg.norm(bounds[1]-bounds[0])*2
    visible=np.zeros(len(points),np.uint32)
    for index in c['viewIndices']:
        v=m['views'][index];direction=np.asarray(v['direction'],float);direction/=np.linalg.norm(direction)
        right=np.cross(direction,v.get('up',[0,0,1]));right/=np.linalg.norm(right);up=np.cross(right,direction)
        local=points-(center+height*np.asarray(v.get('targetOffset',[0,0,0])));span=height*v.get('span',1.1)
        x=np.floor((local@right/span+.5)*m['size']).astype(int);y=np.floor((.5-local@up/span)*m['size']).astype(int)
        valid=(x>=0)&(x<m['size'])&(y>=0)&(y<m['size'])&(abs(normals@direction)>.2)
        for i in np.flatnonzero(valid):
            hit,_,_,_=bvh.ray_cast(Vector((points[i]-direction*distance).tolist()),Vector(direction.tolist()),distance*2)
            if hit is not None and np.linalg.norm(np.asarray(hit)-points[i])<height*1e-5:visible[i]|=np.uint32(1<<index)
    np.save(c['result'],visible,allow_pickle=False)

def recover(source,manifest,masks,points,normals,labels,visibility,missing,view_indices,out):
    from workspace_paths import blender_executable
    view_indices=sorted(set(view_indices))
    if any(not isinstance(i,int) or i<0 or i>=min(32,len(manifest['views'])) for i in view_indices):raise ValueError('Invalid visibility view indices')
    if points.shape!=normals.shape or points.ndim!=2 or points.shape[1]!=3 or any(np.asarray(a).shape!=(len(points),) for a in [labels,visibility,missing]):raise ValueError('Invalid vertex support arrays')
    if not np.isfinite(points).all() or not np.isfinite(normals).all():raise ValueError('Non-finite vertex geometry')
    if hashlib.sha256(Path(source).read_bytes()).hexdigest()!=manifest['sourceSha256']:raise ValueError('Vertex evidence source mismatch')
    indices=np.flatnonzero(missing);out=Path(out);out.mkdir(parents=True,exist_ok=True)
    if not len(indices):return labels,visibility,{'queriedVertices':0}
    query=out/'detail-vertex-queries.npz';result=out/'detail-vertex-visibility.npy';receipt=out/'detail-vertex-visibility.json'
    selected_points=np.asarray(points[indices],np.float64);selected_normals=np.asarray(normals[indices],np.float64)
    key=hashlib.sha256(selected_points.tobytes()+selected_normals.tobytes()+json.dumps({'algorithm':ALGORITHM_VERSION,'source':manifest['sourceSha256'],'views':manifest['views'],'bounds':manifest['worldBounds'],'size':manifest['size'],'indices':view_indices},sort_keys=True).encode()).hexdigest()
    cached=json.loads(receipt.read_text()) if receipt.exists() else {}
    if cached.get('key')!=key or not result.exists() or hashlib.sha256(result.read_bytes()).hexdigest()!=cached.get('resultSha256'):
        np.savez_compressed(query,points=selected_points,normals=selected_normals)
        config=out/'detail-vertex-request.json';config.write_text(json.dumps({'manifest':manifest,'queries':str(query.resolve()),'result':str(result.resolve()),'viewIndices':view_indices}))
        result.unlink(missing_ok=True)
        subprocess.run([blender_executable(),'--background','--python-exit-code','1','--python',str(Path(__file__).resolve()),'--',str(config.resolve())],check=True)
        receipt.write_text(json.dumps({'key':key,'resultSha256':hashlib.sha256(result.read_bytes()).hexdigest()}))
    exact=np.load(result,allow_pickle=False)
    if exact.shape!=(len(indices),) or exact.dtype!=np.uint32:raise ValueError('Invalid exact vertex visibility cache')
    votes=np.zeros(len(indices),np.uint16);bounds=np.asarray(manifest['worldBounds']);height=np.ptp(bounds[:,2]);center=bounds.mean(0)
    for index in view_indices:
        view=manifest['views'][index];file=Path(masks)/(view['name']+'-annotation.npy')
        if not file.exists():continue
        annotation=np.load(file,allow_pickle=False)
        if annotation.shape!=(manifest['size'],manifest['size']) or np.any(annotation>9):raise ValueError('Invalid reviewed annotation')
        d=np.asarray(view['direction'],float);d/=np.linalg.norm(d);right=np.cross(d,view.get('up',[0,0,1]));right/=np.linalg.norm(right);up=np.cross(right,d)
        p=selected_points-(center+height*np.asarray(view.get('targetOffset',[0,0,0])));span=height*view.get('span',1.1)
        x=np.floor((p@right/span+.5)*manifest['size']).astype(int);y=np.floor((.5-p@up/span)*manifest['size']).astype(int);valid=(exact&(1<<index))!=0
        if np.any(valid&((x<0)|(x>=manifest['size'])|(y<0)|(y>=manifest['size']))):raise ValueError('Visibility cache projects outside image')
        kinds=annotation[y[valid],x[valid]].astype(np.uint16);votes[valid]|=np.where(kinds>0,np.uint16(1)<<kinds,0).astype(np.uint16)
    recovered=resolve_labels(votes);new_labels=labels.copy();new_visibility=visibility.copy();new_labels[indices]=recovered;new_visibility[indices]=exact
    return new_labels,new_visibility,{'queriedVertices':len(indices),'visibleVertices':int((exact!=0).sum()),'labelledVertices':int((recovered!=0).sum()),'geometryKey':key,'method':'exact source-geometry rays only for unoccupied UV vertex samples; original reviewed image labels; fragment coverage unchanged'}

if __name__=='__main__':worker(sys.argv[sys.argv.index('--')+1])
