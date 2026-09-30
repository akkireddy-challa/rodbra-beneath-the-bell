"""Attach the shared body rig without re-exporting authored materials or eye layers.

Original surface vertices match the dense bound mesh. Newly clipped eye vertices
use a unanimous rigid-head field or exact bound-triangle interpolation. Optical
rest fitting retains its pre-fit correspondence; off-surface evidence is rejected.
"""
import argparse,copy,hashlib,json,shutil
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation
from glb_arrays import read,accessor
from glb_output import append_accessor
from vision_materials import source_world_points
from eye_assets import write_glb

from workspace_paths import workspace_root
ROOT=workspace_root(__file__)

def node_matrix(node):
    if 'matrix' in node:return np.asarray(node['matrix']).reshape(4,4).T
    matrix=np.eye(4);matrix[:3,:3]=Rotation.from_quat(node.get('rotation',[0,0,0,1])).as_matrix()@np.diag(node.get('scale',[1,1,1]));matrix[:3,3]=node.get('translation',[0,0,0]);return matrix

def world_matrices(doc):
    parents={child:i for i,n in enumerate(doc['nodes']) for child in n.get('children',[])};cache={}
    def world(i):
        if i not in cache:cache[i]=(world(parents[i]) if i in parents else np.eye(4))@node_matrix(doc['nodes'][i])
        return cache[i]
    return [world(i) for i in range(len(doc['nodes']))]

def set_transform(node,matrix):
    scale=np.linalg.norm(matrix[:3,:3],axis=0);rotation=matrix[:3,:3]/scale
    if not np.allclose(rotation.T@rotation,np.eye(3),atol=1e-5) or np.linalg.det(rotation)<0:raise ValueError('Eye attachment requires a non-sheared positive transform')
    node.pop('matrix',None);node.update(translation=matrix[:3,3].tolist(),rotation=Rotation.from_matrix(rotation).as_quat().tolist(),scale=scale.tolist())

def skin_points(points,joints,weights,matrices):
    result=np.zeros_like(points,dtype=float);p=np.c_[points,np.ones(len(points))]
    for slot in range(4):result+=np.einsum('nij,nj->ni',matrices[joints[:,slot]],p)[:,:3]*weights[:,slot,None]
    return result

def surface_weight_transfer(query,points,faces,joints,weights,tolerance):
    """Exact closest-triangle interpolation; reject points off the bound surface."""
    triangles=points[faces];centers=triangles.mean(1)
    radius=np.linalg.norm(triangles-centers[:,None,:],axis=2).max()
    tree=cKDTree(centers);vertices=cKDTree(points[np.unique(faces)])
    result_j=[];result_w=[]
    for point in query:
        upper=vertices.query(point)[0]
        ids=tree.query_ball_point(point,float(upper+radius+tolerance))
        tri=triangles[ids];a=tri[:,0];u=tri[:,1]-a;v=tri[:,2]-a;p=point-a
        uu=(u*u).sum(1);uv=(u*v).sum(1);vv=(v*v).sum(1);pu=(p*u).sum(1);pv=(p*v).sum(1)
        determinant=uu*vv-uv*uv;safe=np.where(determinant>1e-24,determinant,1)
        b=(vv*pu-uv*pv)/safe;c=(uu*pv-uv*pu)/safe
        bary=np.stack([1-b-c,b,c],1);inside=(bary>=0).all(1)&(determinant>1e-24)
        distance=np.linalg.norm(np.einsum('ni,nij->nj',bary,tri)-point,axis=1)
        distance[~inside]=np.inf
        for first,last in [(0,1),(1,2),(2,0)]:
            edge=tri[:,last]-tri[:,first];length=(edge*edge).sum(1)
            t=np.clip(((point-tri[:,first])*edge).sum(1)/np.maximum(length,1e-24),0,1)
            candidate=np.linalg.norm(tri[:,first]+edge*t[:,None]-point,axis=1);better=candidate<distance
            distance[better]=candidate[better];bary[better]=0;bary[better,first]=1-t[better];bary[better,last]=t[better]
        closest=int(np.argmin(distance))
        if distance[closest]>tolerance:raise ValueError('Binding provenance is not on the validated source surface')
        corners=faces[ids[closest]];combined={}
        for vertex,factor in zip(corners,bary[closest]):
            for joint,weight in zip(joints[vertex],weights[vertex]):combined[int(joint)]=combined.get(int(joint),0)+float(factor*weight)
        strongest=sorted(combined.items(),key=lambda item:item[1],reverse=True)[:4]
        strongest += [(0,0)]*(4-len(strongest));total=sum(w for _,w in strongest)
        if total<=0:raise ValueError('Bound triangle has no skin weights')
        result_j.append([j for j,_ in strongest]);result_w.append([w/total for _,w in strongest])
    return np.asarray(result_j),np.asarray(result_w)

def assemble(sid,relative_input,variant='eyes'):
    base=ROOT/'characters'/sid/'high/v1';input_path=(base/relative_input).resolve()
    if base.resolve() not in input_path.parents:raise ValueError('Input must be a revision inside this character')
    doc,data=read(input_path);rig_path=base/'output/character.glb';rig,rig_data=read(rig_path);rig_report=json.loads((base/'rig-report.json').read_text())
    if hashlib.sha256(rig_path.read_bytes()).hexdigest()!=rig_report['output_sha256']:raise ValueError('Body rig changed after validation')
    if rig_report['geometry_displacement_max_m']>1e-6:raise ValueError('Reshaped sources require an explicit surface deformation transfer')
    if len(rig.get('skins',[]))!=1 or doc.get('skins'):raise ValueError('This assembly adapter adds exactly one new body skin')
    body_node=next(i for i,n in enumerate(doc['nodes']) if n.get('mesh')==0)
    rig_body=next(i for i,n in enumerate(rig['nodes']) if n.get('skin')==0)
    if any('mesh' in n for i,n in enumerate(rig['nodes']) if i!=rig_body):raise ValueError('Unexpected extra body geometry')
    worlds=world_matrices(doc);rig_world=world_matrices(rig)
    if not np.allclose(rig_world[rig_body],np.eye(4),atol=1e-6):raise ValueError('Bound mesh needs an explicit nonidentity bind-space adapter')
    primitives=doc['meshes'][0]['primitives'];positions=accessor(doc,data,primitives[0]['attributes']['POSITION'])
    if any(p['attributes']['POSITION']!=primitives[0]['attributes']['POSITION'] for p in primitives):raise ValueError('Expected a shared surface vertex pool')
    rp=rig['meshes'][rig['nodes'][rig_body]['mesh']]['primitives'][0]
    bound_positions=accessor(rig,rig_data,rp['attributes']['POSITION']);bound_joints=accessor(rig,rig_data,rp['attributes']['JOINTS_0']).astype(np.int32);bound_weights=accessor(rig,rig_data,rp['attributes']['WEIGHTS_0'])
    if not np.issubdtype(bound_weights.dtype,np.floating):raise ValueError('Decode normalized integer weight attributes explicitly')
    scale=rig_report['normalization']['scale'];center=np.asarray(rig_report['normalization']['center']);normalization=np.eye(4);normalization[:3,:3]*=scale;normalization[:3,3]=-center[[0,2,1]]*np.array([1,1,-1])*scale
    transform=normalization@worlds[body_node];expected=positions@transform[:3,:3].T+transform[:3,3]
    binding_index=primitives[0]['attributes'].get('_BIND_SOURCE_POSITION')
    if any(p['attributes'].get('_BIND_SOURCE_POSITION')!=binding_index for p in primitives):raise ValueError('Expected shared source binding positions across material partitions')
    binding_positions=positions if binding_index is None else accessor(doc,data,binding_index)
    if binding_positions.shape!=positions.shape or not np.isfinite(binding_positions).all():raise ValueError('Invalid source binding positions')
    binding_expected=binding_positions@transform[:3,:3].T+transform[:3,3]
    distance,index=cKDTree(bound_positions).query(binding_expected);tolerance=max(np.ptp(bound_positions,axis=0))*2e-6
    joints=bound_joints[index].copy();weights=bound_weights[index].copy();unmatched=distance>tolerance
    source_skin=rig['skins'][0];head_indices=[k for k,i in enumerate(source_skin['joints']) if rig['nodes'][i].get('name') in ['Head','mixamorigHead','mixamorig:Head']]
    if len(head_indices)!=1:raise ValueError('The shared rig must identify one Head joint')
    head=head_indices[0]
    barycentric_count=0
    if unmatched.any():
        # A clipped ocular vertex is safe only within the explicit rigid-head field.
        d,near=cKDTree(bound_positions).query(binding_expected[unmatched],k=4)
        head_weight=np.sum(bound_weights[near]*(bound_joints[near]==head),axis=2)
        rigid=(d<=.003).all(1)&(head_weight>=.9999).all(1)
        missing_ids=np.flatnonzero(unmatched);joints[missing_ids[rigid]]=head;weights[missing_ids[rigid]]=[1,0,0,0]
        if not rigid.all():
            selected=missing_ids[~rigid]
            faces=np.concatenate([accessor(rig,rig_data,p['indices']).reshape(-1,3) for p in rig['meshes'][rig['nodes'][rig_body]['mesh']]['primitives']])
            joints[selected],weights[selected]=surface_weight_transfer(binding_expected[selected],bound_positions,faces,bound_joints,bound_weights,tolerance)
            barycentric_count=len(selected)
    if not np.isfinite(weights).all() or np.max(abs(weights.sum(1)-1))>1e-5:raise ValueError('Invalid transferred weights')
    original_length=len(data);mapping={}
    for i,n in enumerate(rig['nodes']):
        if i!=rig_body:mapping[i]=len(doc['nodes']);doc['nodes'].append(copy.deepcopy(n))
    for old,new in mapping.items():
        if 'children' in doc['nodes'][new]:doc['nodes'][new]['children']=[mapping[c] for c in rig['nodes'][old]['children'] if c!=rig_body]
    roots=rig['scenes'][rig.get('scene',0)]['nodes'];doc['scenes'][doc.get('scene',0)]['nodes'] += [mapping[i] for i in roots if i!=rig_body]
    inverse_bind=accessor(rig,rig_data,source_skin['inverseBindMatrices']).reshape(-1,4,4).transpose(0,2,1)
    # Keep the rig's canonical inverse binds: Skeleton.pose() reconstructs its
    # rest world matrices from them. Convert mesh coordinates instead of hiding
    # a mesh-space transform inside the inverse binds.
    coordinate_scale=np.linalg.norm(transform[:3,:3],axis=0)
    if not np.allclose(coordinate_scale,coordinate_scale[0],rtol=1e-5):raise ValueError('Nonuniform bind-space conversion needs explicit normal handling')
    rotation=transform[:3,:3]/coordinate_scale[0]
    if not np.allclose(rotation.T@rotation,np.eye(3),atol=1e-5):raise ValueError('Sheared bind-space conversion is unsupported')
    converted={}
    def convert_attribute(index,kind,delta=False):
        key=(index,kind,delta)
        if key not in converted:
            values=accessor(doc,data,index)
            if kind=='POSITION':values=values@transform[:3,:3].T+(0 if delta else transform[:3,3])
            elif kind=='TANGENT':values[:,:3]=values[:,:3]@rotation.T
            else:values=values@rotation.T
            converted[key]=append_accessor(doc,data,values.astype('<f4'),'VEC4' if kind=='TANGENT' else 'VEC3',5126)
            if kind=='POSITION':doc['accessors'][converted[key]].update(min=values.min(0).tolist(),max=values.max(0).tolist())
        return converted[key]
    for p in primitives:
        # Authoring correspondence is consumed here; it is not a renderer input.
        p['attributes'].pop('_BIND_SOURCE_POSITION',None)
        for kind in ['POSITION','NORMAL','TANGENT']:
            if kind in p['attributes']:p['attributes'][kind]=convert_attribute(p['attributes'][kind],kind)
        for target in p.get('targets',[]):
            for kind in ['POSITION','NORMAL']:
                if kind in target:target[kind]=convert_attribute(target[kind],kind,True)
    adjusted=inverse_bind
    pose_error=float(np.max(abs(np.linalg.inv(adjusted)-np.asarray([rig_world[i] for i in source_skin['joints']]))))
    if pose_error>2e-5:raise ValueError('Inverse binds are incompatible with the engine skeleton pose reset')
    ibm_index=append_accessor(doc,data,adjusted.transpose(0,2,1).reshape(-1,16).astype('<f4'),'MAT4',5126)
    doc['skins']=[{'name':source_skin.get('name','SharedBodyRig'),'joints':[mapping[i] for i in source_skin['joints']],'inverseBindMatrices':ibm_index}];doc['nodes'][body_node]['skin']=0
    ji=append_accessor(doc,data,joints.astype('<u2'),'VEC4',5123);wi=append_accessor(doc,data,weights.astype('<f4'),'VEC4',5126)
    for p in primitives:p['attributes'].update(JOINTS_0=ji,WEIGHTS_0=wi)
    # Optical roots and head-fixed tissue now follow the animated Head joint.
    head_node=mapping[source_skin['joints'][head]];head_world=rig_world[source_skin['joints'][head]];rotation_changes={};attachments=list(doc['nodes'][body_node].get('children',[]))
    for child in attachments:
        node=doc['nodes'][child]
        optical=node.get('extras',{}).get('characterEye') or ('mesh' in node and all(doc['materials'][p['material']].get('extras',{}).get('eyeLayer') for p in doc['meshes'][node['mesh']]['primitives']))
        if not optical:raise ValueError('Nonocular body attachments require explicit parenting')
        old_rotation=Rotation.from_quat(node.get('rotation',[0,0,0,1]));set_transform(node,np.linalg.inv(head_world)@normalization@worlds[child]);rotation_changes[child]=Rotation.from_quat(node['rotation'])*old_rotation.inv()
        doc['nodes'][head_node].setdefault('children',[]).append(child)
    doc['nodes'][body_node]['children']=[]
    for i,node in enumerate(doc['nodes']):
        if i!=body_node and body_node in node.get('children',[]):node['children'].remove(body_node)
    set_transform(doc['nodes'][body_node],np.eye(4))
    scene_nodes=doc['scenes'][doc.get('scene',0)]['nodes']
    if body_node not in scene_nodes:scene_nodes.append(body_node)
    for animation in doc.get('animations',[]):
        for channel in animation['channels']:
            target=channel['target']
            if target.get('path')=='rotation' and target['node'] in rotation_changes:
                sampler=animation['samplers'][channel['sampler']]
                if sampler.get('interpolation','LINEAR')!='LINEAR':raise ValueError('Eye rotation retarget requires linear quaternion tracks')
                q=accessor(doc,data,sampler['output']);q=(rotation_changes[target['node']]*Rotation.from_quat(q)).as_quat();sampler['output']=append_accessor(doc,data,q.astype('<f4'),'VEC4',5126)
    copied={}
    def copy_accessor(index):
        if index not in copied:
            original=rig['accessors'][index];copied[index]=append_accessor(doc,data,accessor(rig,rig_data,index),original['type'],original['componentType'])
            for key in ['min','max','normalized']:
                if key in original:doc['accessors'][copied[index]][key]=original[key]
        return copied[index]
    for animation in rig.get('animations',[]):
        a=copy.deepcopy(animation)
        for sampler in a['samplers']:sampler['input']=copy_accessor(sampler['input']);sampler['output']=copy_accessor(sampler['output'])
        for channel in a['channels']:channel['target']['node']=mapping[channel['target']['node']]
        doc.setdefault('animations',[]).append(a)
    matrices=np.asarray([rig_world[i] for i in source_skin['joints']])@adjusted
    maximum=0.
    for batch in np.array_split(np.arange(len(positions)),max(1,len(positions)//100000)):
        error=np.linalg.norm(skin_points(expected[batch],joints[batch],weights[batch],matrices)-expected[batch],axis=1);maximum=max(maximum,float(error.max()))
    if maximum>2e-5:raise ValueError(f'Assembled bind pose does not preserve the source: {maximum}m')
    out=base/'runtime/v1';out.mkdir(parents=True,exist_ok=True)
    report={'id':sid,'status':'motion_review_required','viewerReady':False,'surfaceInput':relative_input,'surfaceSha256':hashlib.sha256(input_path.read_bytes()).hexdigest(),'rigSha256':rig_report['output_sha256'],'restPositionErrorM':maximum,'rigidHeadInsertedVertices':int(unmatched.sum()),'bodyBones':len(source_skin['joints']),'headAttachments':len(attachments),'clips':[a['name'] for a in doc.get('animations',[])],'sourceBufferBytesPreserved':bytes(data[:original_length])==bytes(read(input_path)[1]),'geometryChange':'Rigid uniform bind-space coordinate conversion of positions, normals and morph deltas; no surface reshaping','limitations':['Shared body rig currently has no independent finger bones','Motion and eye contact require visual acceptance']}
    report['variant']=variant
    report['barycentricWeightVertices']=barycentric_count
    report['rigidHeadInsertedVertices']=int(unmatched.sum())-barycentric_count
    report['poseResetMatrixError']=pose_error
    report['outputSha256']=write_glb(doc,data,out/f'{variant}.glb');(out/f'{variant}-report.json').write_text(json.dumps(report,indent=2))
    for name in ['ATTRIBUTION.txt','MakeHuman-LICENSE.md']:
        if (input_path.parent/name).exists():shutil.copyfile(input_path.parent/name,out/name)
    print(json.dumps(report))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--id',required=True);p.add_argument('--input',required=True);p.add_argument('--variant',choices=['eyes','surfaces'],default='eyes');a=p.parse_args();assemble(a.id,a.input,a.variant)
