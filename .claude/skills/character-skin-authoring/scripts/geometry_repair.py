"""Repair an explicitly reviewed surface patch, retaining source rig correspondence.

The agent selects the patch and a clean surrounding annulus. No defect detection runs.
"""
import hashlib,json
from pathlib import Path
import numpy as np
from scipy.ndimage import distance_transform_edt
from glb_arrays import accessor
from glb_output import append_accessor,append_texture,image_array
from vision_materials import source_world_points
from eyelid_morph import surface_normals,surface_normal_groups,transport_normals
from texture_repair import harmonic_fill,surface_swatch_fill

def evidence_texel(uv,shape):
    """Evidence uses Blender UVs; decoded image arrays have a top-left origin."""
    return np.clip((np.array([1-uv[1],uv[0]])*np.array(shape)).astype(int),0,np.array(shape)-1)

def quadratic_patch(points,pixels,direction,center,full_radius,outer_radius,fit_ring,depth_center,depth_tolerance):
    points=np.asarray(points,float);pixels=np.asarray(pixels,float);direction=np.asarray(direction,float)
    if not 0<full_radius<outer_radius<fit_ring[0]<fit_ring[1]:raise ValueError('Repair and clean support annulus must be separate')
    q=(pixels-center)/fit_ring[1];r=np.linalg.norm(pixels-center,axis=1);depth=points@direction
    visible=abs(depth-depth_center)<depth_tolerance
    fit=visible&(r>=fit_ring[0])&(r<=fit_ring[1])
    if fit.sum()<30:raise ValueError('Insufficient clean surface support for authored geometry repair')
    def basis(v):return np.stack([np.ones(len(v)),v[:,0],v[:,1],v[:,0]**2,v[:,0]*v[:,1],v[:,1]**2],1)
    coefficients,_,rank,_=np.linalg.lstsq(basis(q[fit]),depth[fit],rcond=None)
    if rank!=6:raise ValueError('Degenerate support annulus')
    weight=np.clip((outer_radius-r)/(outer_radius-full_radius),0,1);weight=weight*weight*(3-2*weight);weight*=visible
    delta=(basis(q)@coefficients-depth)*weight
    result=points+delta[:,None]*direction
    result[weight==0]=points[weight==0]
    residual=basis(q[fit])@coefficients-depth[fit]
    return result,weight,{'supportVertices':int(fit.sum()),'movedVertices':int((weight>0).sum()),'maximumDisplacement':float(abs(delta).max()),'supportResidualP95':float(np.percentile(abs(residual),95))}

def apply_geometry_repair(doc,data,profile_path,out,source_sha):
    profile_path=Path(profile_path);profile=json.loads(profile_path.read_text())
    if profile['sourceSha256']!=source_sha:raise ValueError('Geometry repair belongs to a different source')
    evidence=Path(profile['evidence']);manifest=json.loads((evidence/'manifest.json').read_text())
    if manifest['sourceSha256']!=source_sha:raise ValueError('Geometry repair evidence source mismatch')
    view=next(v for v in manifest['views'] if v['name']==profile['view'])
    image=evidence/(profile['view']+'.png')
    if hashlib.sha256(image.read_bytes()).hexdigest()!=manifest['evidenceHashes'][image.name]:raise ValueError('Geometry repair evidence image changed')
    primitives=doc['meshes'][0]['primitives'];attributes=primitives[0]['attributes']
    if any(p['attributes']['POSITION']!=attributes['POSITION'] for p in primitives):raise ValueError('Repair requires shared source positions')
    local=accessor(doc,data,attributes['POSITION']);world=source_world_points(doc,local)
    source_height=float(np.ptp(world[:,2]));unit=source_height/profile['heightM'];center=(world.min(0)+world.max(0))*.5
    direction=np.asarray(view['direction'],float);direction/=np.linalg.norm(direction)
    up=np.asarray(view.get('up',[0,0,1]),float);right=np.cross(direction,up);right/=np.linalg.norm(right);up=np.cross(right,direction)
    target=center+source_height*np.asarray(view.get('targetOffset',[0,0,0]));span=source_height*view['span'];size=manifest['size']
    def project(p):return np.stack([((p-target)@right/span+.5)*size,(.5-(p-target)@up/span)*size],-1)
    pixel_center=np.asarray(profile['centerPx'],float)
    on_plane=target+right*(pixel_center[0]/size-.5)*span+up*(.5-pixel_center[1]/size)*span
    faces=np.concatenate([accessor(doc,data,p['indices']).reshape(-1,3) for p in primitives])
    from eye_assets import ray_hit
    hit=ray_hit(on_plane-direction*source_height*2,direction,world,faces);depth_center=hit@direction
    changed,weight,receipt=quadratic_patch(world,project(world),direction,pixel_center,profile['fullRadiusPx'],profile['outerRadiusPx'],profile['supportRingPx'],depth_center,profile['depthToleranceM']*unit)
    if receipt['maximumDisplacement']/unit>profile['maximumDisplacementM']:raise ValueError('Geometry correction exceeds the authored displacement bound')
    origin=source_world_points(doc,np.zeros((1,3)))[0];basis=(source_world_points(doc,np.eye(3))-origin).T
    corrected=local+(changed-world)@np.linalg.inv(basis).T
    groups=surface_normal_groups(local);old_normals=accessor(doc,data,attributes['NORMAL'])
    new_geometric=surface_normals(corrected,faces,groups)
    normals=transport_normals(old_normals,surface_normals(local,faces,groups),new_geometric)
    normals=normals*(1-weight[:,None])+new_geometric*weight[:,None]
    normals/=np.maximum(np.linalg.norm(normals,axis=1,keepdims=True),1e-12)
    touched=np.zeros(len(local),bool);touched[np.unique(faces[np.any(weight[faces]>0,axis=1)])]=True;normals[~touched]=old_normals[~touched]
    position_index=append_accessor(doc,data,corrected.astype('<f4'),'VEC3',5126);normal_index=append_accessor(doc,data,normals.astype('<f4'),'VEC3',5126)
    for p in primitives:
        p['attributes'].setdefault('_BIND_SOURCE_POSITION',p['attributes']['POSITION'])
        p['attributes']['POSITION']=position_index;p['attributes']['NORMAL']=normal_index
    # Exact UV-surface positions come from the reviewed dense evidence bake.
    surfaces=Path(profile['surfaceEvidence']);mask_report=json.loads((surfaces.parent/'report.json').read_text())
    if mask_report['sourceSha256']!=source_sha:raise ValueError('Repair UV evidence belongs to a different source')
    atlas=np.load(surfaces);positions=atlas['position'];occupied=atlas['occupied'];pixels=project(positions)
    r=np.linalg.norm(pixels-pixel_center,axis=-1);near=occupied&(abs(positions@direction-depth_center)<profile['depthToleranceM']*unit)
    distance,nearest=distance_transform_edt(~occupied,return_indices=True)
    gutter=(~occupied)&(distance<=4)
    r[gutter]=r[tuple(nearest[:,gutter])];near[gutter]=near[tuple(nearest[:,gutter])]
    positions=positions.copy();positions[gutter]=positions[tuple(nearest[:,gutter])]
    del distance,nearest,pixels
    material=doc['materials'][primitives[0]['material']];texture=material['pbrMetallicRoughness']['baseColorTexture']['index'];color=image_array(doc,data,texture).copy()
    if color.shape[:2]!=occupied.shape:raise ValueError('Repair atlas and base color resolution differ')
    paint=profile['paint'];cleanup=near&(r<paint['cleanupRadiusPx'])
    if paint.get('skinSamplesPx'):
        uv_path=evidence/(profile['view']+'.npz')
        if hashlib.sha256(uv_path.read_bytes()).hexdigest()!=manifest['evidenceHashes'][uv_path.name]:raise ValueError('Paint donor correspondence changed')
        correspondence=np.load(uv_path);donors=[]
        for x,y in paint['skinSamplesPx']:
            if correspondence['material'][y,x]!=0:raise ValueError('Paint donor is outside the reviewed source material')
            uv=correspondence['uv'][y,x];yx=evidence_texel(uv,occupied.shape)
            if not occupied[tuple(yx)]:
                region=occupied[max(0,yx[0]-2):yx[0]+3,max(0,yx[1]-2):yx[1]+3];candidates=np.argwhere(region)+np.maximum(0,yx-2)
                if not len(candidates):raise ValueError('Paint donor misses occupied UV surface')
                yx=candidates[np.argmin(((candidates-yx)**2).sum(1))]
            donors.append(yx)
        color=surface_swatch_fill(color[:,:,:3],cleanup,positions,donors,allowed_mask=near,blend_width=paint.get('blendWidthM',.001)*unit)
    else:color=harmonic_fill(color[:,:,:3],cleanup)
    alpha=np.clip((paint['radiusPx']+.5-r),0,1)*near
    original=color.astype(float)/255;original=np.where(original<=.04045,original/12.92,((original+.055)/1.055)**2.4)
    pigment=np.asarray(paint['colorSRGB'],float)/255;pigment=np.where(pigment<=.04045,pigment/12.92,((pigment+.055)/1.055)**2.4)
    mixed=original*(1-alpha[:,:,None])+pigment*alpha[:,:,None];encoded=np.where(mixed<=.0031308,mixed*12.92,1.055*mixed**(1/2.4)-.055)
    painted=color.copy();active=alpha>0;painted_count=int(active.sum());painted[active]=np.round(np.clip(encoded[active],0,1)*255).astype(np.uint8)
    material['pbrMetallicRoughness']['baseColorTexture']={'index':append_texture(doc,data,painted,'geometry-repair-base-color',out)}
    if material.get('normalTexture'):
        normal=image_array(doc,data,material['normalTexture']['index']).copy()
        if normal.shape[:2]!=occupied.shape:raise ValueError('Repair normal atlas resolution differs')
        w=np.clip((profile['outerRadiusPx']-r)/(profile['outerRadiusPx']-profile['fullRadiusPx']),0,1);w=w*w*(3-2*w)*near
        active=w>0;normal[active,:3]=np.round(normal[active,:3]*(1-w[active,None])+np.array([128,128,255])*w[active,None]).astype(np.uint8)
        material['normalTexture']={**material['normalTexture'],'index':append_texture(doc,data,normal,'geometry-repair-normal',out)}
    receipt.update(method='agent-authored quadratic patch from clean surrounding surface; feathered boundary',sourceSha256=source_sha,profileSha256=hashlib.sha256(profile_path.read_bytes()).hexdigest(),maximumDisplacementM=receipt.pop('maximumDisplacement')/unit,supportResidualP95M=receipt.pop('supportResidualP95')/unit,paintedTexels=painted_count,topologyAndUVsPreserved=True,sourceBindingPreserved=True)
    (Path(out)/'geometry-repair.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt
