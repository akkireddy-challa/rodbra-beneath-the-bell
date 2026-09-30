"""Build a character material revision from reviewed vision labels and exact UV surfaces.

No anatomical classification by colour, height or character ID. Semantic masks are inputs.
Scan detail is attributed; glabrous ridges are explicitly authored, not captured data.
"""
import argparse,copy,hashlib,json,struct
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt,gaussian_filter,map_coordinates
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation
from glb_arrays import read,accessor
from glb_output import append_accessor,append_texture,image_array
from face_atlas import sample

from workspace_paths import workspace_root
ROOT=workspace_root(__file__)
SKIN_IDS=(1,2,3,9)

def pad_unused_labels(labels,occupied,conflict):
    """Filtering gutters may fill unused UV space, never unknown occupied surface."""
    result=labels.copy()
    if not np.any(labels):return result
    distance,nearest=distance_transform_edt(labels==0,return_indices=True)
    padding=(labels==0)&~occupied&(distance<=2)&~conflict
    result[padding]=labels[tuple(nearest[:,padding])]
    return result

def sample_labels(labels,uv):
    h,w=labels.shape;x=np.clip((uv[...,0]*w).astype(int),0,w-1);y=np.clip((uv[...,1]*h).astype(int),0,h-1)
    return labels[y,x]

def source_world_points(doc,points,mesh_index=0):
    """glTF scene transforms, followed by the documented Y-up to Blender Z-up basis."""
    parents={child:i for i,node in enumerate(doc['nodes']) for child in node.get('children',[])}
    instances=[i for i,node in enumerate(doc['nodes']) if node.get('mesh')==mesh_index]
    if len(instances)!=1:raise ValueError('Mesh instances require a per-instance packaging adapter')
    index=instances[0];matrix=np.eye(4)
    while True:
        node=doc['nodes'][index]
        if 'matrix' in node:local=np.array(node['matrix']).reshape(4,4).T
        else:
            local=np.eye(4);local[:3,:3]=Rotation.from_quat(node.get('rotation',[0,0,0,1])).as_matrix()@np.diag(node.get('scale',[1,1,1]));local[:3,3]=node.get('translation',[0,0,0])
        matrix=local@matrix
        if index not in parents:break
        index=parents[index]
    world=points@matrix[:3,:3].T+matrix[:3,3]
    return world[:,[0,2,1]]*np.array([1,-1,1])

def triangle_categories(doc,data,prim,masks):
    evidence=np.load(masks/'triangles.npz');ids=accessor(doc,data,prim['indices']).reshape(-1,3)
    points=source_world_points(doc,accessor(doc,data,prim['attributes']['POSITION']))
    centers=points[ids].mean(1);distance,index=cKDTree(evidence['centers']).query(centers)
    tolerance=np.ptp(points,axis=0).max()*1e-6
    if len(centers)!=len(evidence['centers']) or distance.max()>tolerance or len(np.unique(index))!=len(index):
        raise ValueError('Triangle evidence does not bijectively match the source scene geometry')
    return evidence['labels'][index],{'matchingTolerance':tolerance,'maxCenterError':float(distance.max()),'conflictingTriangles':int(evidence['conflict'].sum())}

def tile_sample(tile,u,v):
    return map_coordinates(tile,[np.remainder(v,1)*(tile.shape[0]-1),np.remainder(u,1)*(tile.shape[1]-1)],order=1,mode='wrap')

def equalize_skin_seams(doc,data,prim,labels,out):
    """Match colour at coincident surface vertices across split UV islands.

    Geometry supplies correspondence. The vision mask limits edits to skin; no colour
    threshold identifies anatomy. Corrections taper inside a 24-texel neighbourhood.
    """
    uv=accessor(doc,data,prim['attributes']['TEXCOORD_0']);p=accessor(doc,data,prim['attributes']['POSITION'])
    mat=doc['materials'][prim['material']];source=image_array(doc,data,mat['pbrMetallicRoughness']['baseColorTexture']['index'])
    srgb=source.astype(np.float32)/255;linear=np.where(srgb<=.04045,srgb/12.92,((srgb+.055)/1.055)**2.4)
    extent=np.ptp(p,axis=0).max();_,group,counts=np.unique(np.round(p/(extent*1e-7)).astype(np.int64),axis=0,return_inverse=True,return_counts=True)
    selected=np.isin(sample_labels(labels,uv),SKIN_IDS)&(counts[group]>1)
    h,w=source.shape[:2];x=np.clip((uv[:,0]*w).astype(int),0,w-1);y=np.clip((uv[:,1]*h).astype(int),0,h-1)
    values=linear[y,x];sums=np.zeros((len(counts),3),np.float64);number=np.zeros(len(counts),np.int32)
    np.add.at(sums,group[selected],values[selected]);np.add.at(number,group[selected],1)
    valid=selected&(number[group]>1);residual=sums[group[valid]]/number[group[valid],None]-values[valid]
    correction=np.zeros((h,w,3),np.float32);hits=np.zeros((h,w),np.float32)
    np.add.at(correction,(y[valid],x[valid]),residual);np.add.at(hits,(y[valid],x[valid]),1)
    correction/=np.maximum(hits[:,:,None],1)
    distance,nearest=distance_transform_edt(hits==0,return_indices=True)
    field=correction[tuple(nearest)];field=gaussian_filter(field,(2,2,0));field*=np.clip(1-distance/24,0,1)[:,:,None]
    skin=np.isin(labels,SKIN_IDS)
    if skin.shape!=(h,w):skin=np.asarray(Image.fromarray(skin).resize((w,h),Image.Resampling.NEAREST))
    corrected=np.clip(linear+field*skin[:,:,None],0,1)
    encoded=np.where(corrected<=.0031308,12.92*corrected,1.055*corrected**(1/2.4)-.055)
    encoded=np.round(encoded*255).astype(np.uint8);encoded[~skin]=source[~skin]
    Image.fromarray(encoded).save(out/'skin-albedo-seams.png')
    return encoded,{'coincidentSkinSamples':int(valid.sum()),'correctionP95Linear':float(np.percentile(abs(residual),95)) if len(residual) else 0,'method':'geometry-corresponding UV seam colour equalization; 24px taper, skin only'}

def verify_projection_contract(manifest,masks):
    # Visibility bit i belongs to camera i, not merely to a source mesh hash.
    # Dense requests archive the exact camera/material contract used by the bake.
    request=masks/'dense-request.json'
    if not request.is_file():
        raise ValueError('Missing dense projection receipt; rebake the evidence')
    archived=json.loads(request.read_text())
    for key in ['sourceSha256','size','views','materials','worldBounds']:
        if key not in archived or archived[key]!=manifest.get(key):
            raise ValueError('Baked projection contract differs from evidence: '+key)

def build(sid,masks,evidence):
    base=ROOT/'characters'/sid/'high/v1';out=base/'materials/v2';out.mkdir(exist_ok=True,parents=True)
    manifest=json.loads((evidence/'manifest.json').read_text());report=json.loads((masks/'report.json').read_text());source=Path(manifest['source'])
    verify_projection_contract(manifest,masks)
    source_hash=hashlib.sha256(source.read_bytes()).hexdigest()
    if source_hash!=manifest['sourceSha256'] or source_hash!=report['sourceSha256']:raise ValueError('Evidence/bake source mismatch')
    doc,data=read(source);original=copy.deepcopy(doc);original_bytes=bytes(data)
    if len(doc['meshes'])!=1 or len(doc['meshes'][0]['primitives'])!=1:raise ValueError('This packaging adapter currently requires a single source mesh primitive')
    prim=doc['meshes'][0]['primitives'][0];uv=accessor(doc,data,prim['attributes']['TEXCOORD_0']);ids=accessor(doc,data,prim['indices']).reshape(-1,3)
    labels=np.asarray(Image.open(masks/'material-0-labels.png')).copy();conflict=np.asarray(Image.open(masks/'material-0-conflicts.png'))>0
    surface=np.load(masks/'material-0-surface.npz')
    if 'visibilityBits' not in surface:
        raise ValueError('Surface evidence predates geometric visibility: rebake with the current skin_views.py --surface-data. Annotation viewBits cannot substitute for visibilityBits.')
    position=surface['position'];normal=surface['normal'];occupied=surface['occupied'];view_bits=surface['visibilityBits'];n=labels.shape[0]
    # Texel-footprint padding only: never grow an unseen body part or resolve a conflict.
    labels=pad_unused_labels(labels,occupied,conflict)
    Image.fromarray(labels).save(out/'vision-labels.png')
    bound=np.asarray(manifest['worldBounds']);unit_height=bound[1,2]-bound[0,2];center=(bound[0]+bound[1])/2
    physical_height=json.loads((base/'output/viewer-profile.json').read_text())['height']
    if not np.isfinite(physical_height) or physical_height<=0:raise ValueError('Character physical height must be positive finite metres')
    physical=(position-center).astype(np.float32)*(physical_height/unit_height)
    p=(position-center)/unit_height;p[:,:,2]+=.5
    fp=json.loads((ROOT/'highquality/materials/faces'/f'{sid}.json').read_text());bounds=np.asarray(fp['bounds'])
    independent_face=fp.get('independentFacialDetail',False)
    registered=np.asarray(Image.open(out/'face-detail.png'),dtype=np.float32)/255
    dynamic=np.asarray(Image.open(out/'face-expression.png'),dtype=np.float32)/255
    band=np.load(out/'scan-band-height-m.npy')
    # A clean forehead crop is mirrored and smoothed into a seamless repeat.
    crop=band[round(.72*len(band)):round(.84*len(band)),round(.37*len(band)):round(.62*len(band))]
    tile=np.concatenate([crop,crop[:,::-1]],axis=1);tile=np.concatenate([tile,tile[::-1]],axis=0);tile=gaussian_filter(tile,.7,mode='wrap')
    skin=np.isin(labels,SKIN_IDS);glabrous=np.isin(labels,[2,3]);detail=np.zeros((n,n,4),np.uint8);expression=np.full((n,n,4),128,np.uint8);expression[:,:,3]=0
    from authored_detail import AuthoredDetail
    body_detail=AuthoredDetail(base/'materials/body-detail-profile.json',manifest,physical_height)
    from authored_surface_patch import AuthoredSurfacePatch
    surface_patch=AuthoredSurfacePatch(base/'materials/surface-patch-profile.json',manifest,physical_height,ROOT)
    if surface_patch.independent_planes() and not independent_face:raise ValueError('Independent body detail requires the packed independent facial atlas path')
    # Evaluate only occupied skin in chunks to keep peak memory bounded.
    rows,cols=np.nonzero(skin&occupied);front_index=[v['name'] for v in manifest['views']].index('face')
    for batch in np.array_split(np.arange(len(rows)),max(1,int(np.ceil(len(rows)/100000)))):
        yy=rows[batch];xx=cols[batch];point=physical[yy,xx];norm=abs(normal[yy,xx]);weights=norm**4;weights/=np.maximum(weights.sum(1,keepdims=True),1e-8)
        relief=(tile_sample(tile,point[:,1]/.06,point[:,2]/.06)*weights[:,0]+tile_sample(tile,point[:,0]/.06,point[:,2]/.06)*weights[:,1]+tile_sample(tile,point[:,0]/.06,point[:,1]/.06)*weights[:,2])*.40
        palm=glabrous[yy,xx]
        # No follicles on palms/soles. Fine low-amplitude ridges follow rest-space coordinates.
        ridge=np.sin(point[:,0]*2*np.pi/.00045+np.sin(point[:,1]*85))*0.000003
        relief=np.where(palm,ridge,relief)
        coords=(p[yy,xx][:,[0,2]]-bounds[:2])/(bounds[2:]-bounds[:2]);face=sample(registered,coords);expr=sample(dynamic,coords)
        visible=((view_bits[yy,xx]&(1<<front_index))!=0)&~palm
        face_direction=np.asarray(manifest['views'][front_index]['direction'],float);face_direction/=np.linalg.norm(face_direction)
        facing=np.abs(normal[yy,xx]@face_direction)
        grazing=np.clip((facing-.2)/.25,0,1);grazing=grazing*grazing*(3-2*grazing)
        face_weight=face[:,3]*visible*grazing;face_height=(face[:,0]-.5)*fp['detailHeightRangeM']
        if independent_face:face_weight=np.zeros_like(face_weight)
        height=relief*(1-face_weight)+face_height*face_weight
        height+=body_detail.evaluate(point,normal[yy,xx],labels[yy,xx],view_bits[yy,xx])
        height+=surface_patch.relief(point,normal[yy,xx],labels[yy,xx],view_bits[yy,xx],include_independent=False)
        rough=np.where(palm,.66,.59)*(1-face_weight)+face[:,1]*face_weight
        rough=surface_patch.evaluate(point,normal[yy,xx],labels[yy,xx],view_bits[yy,xx],rough,include_independent=False)
        packed=np.stack([np.clip(.5+height/fp['detailHeightRangeM'],0,1),rough,.5+(face[:,2]-.5)*face_weight,np.ones(len(batch))],1)
        detail[yy,xx]=np.round(packed*255).astype(np.uint8)
        expr[:,:3]=.5+(expr[:,:3]-.5)*face_weight[:,None];expr[:,3]*=face_weight
        expression[yy,xx]=np.round(expr*255).astype(np.uint8)
    # Fill atlas gutter samples from the nearest real skin sample, but keep coverage zero outside the label.
    valid=skin&occupied;dist,nearest=distance_transform_edt(~valid,return_indices=True);gutter=(~valid)&(dist<=3)
    detail[gutter]=detail[tuple(nearest[:,gutter])];detail[:,:,3]=np.uint8(skin)*255
    facial_attributes={};facial_metadata={};vertex_support_report=None
    if independent_face:
        # Retain the registered face map at its own resolution. Geometry-linked
        # visibility is only a projection gate; body coverage still owns anatomy.
        vertex_points=source_world_points(original,accessor(original,original_bytes,prim['attributes']['POSITION']))
        vertex_world=vertex_points.copy()
        basis=source_world_points(original,np.vstack([np.zeros(3),np.eye(3)]))
        linear=(basis[1:]-basis[0]).T
        vertex_normals=accessor(original,original_bytes,prim['attributes']['NORMAL'])@np.linalg.inv(linear)
        vertex_normals/=np.maximum(np.linalg.norm(vertex_normals,axis=1,keepdims=True),1e-12)
        vertex_physical=(vertex_points-center)*(physical_height/unit_height)
        vertex_points=(vertex_points-center)/unit_height;vertex_points[:,2]+=.5
        facial_uv=(vertex_points[:,[0,2]]-bounds[:2])/(bounds[2:]-bounds[:2])
        vx=np.clip((uv[:,0]*n).astype(int),0,n-1);vy=np.clip((uv[:,1]*n).astype(int),0,n-1)
        from vertex_detail_support import recover
        vertex_labels,vertex_visibility,vertex_support_report=recover(source,manifest,masks,vertex_world,vertex_normals,labels[vy,vx],view_bits[vy,vx],~occupied[vy,vx],[front_index]+[p['index'] for p in surface_patch.independent_planes()],out)
        facing=np.abs(vertex_normals@face_direction)
        grazing=np.clip((facing-.2)/.25,0,1);grazing=grazing*grazing*(3-2*grazing)
        gate=((vertex_visibility&(1<<front_index))!=0)&np.isin(vertex_labels,[1,9])
        gate &= np.all((facial_uv>=0)&(facial_uv<=1),axis=1)
        from regional_atlas import pack_regions
        packed_detail,packed_expression,packed_binding,regional_metadata=pack_regions(registered,dynamic,np.column_stack([facial_uv,gate*grazing]),vertex_physical,vertex_normals,vertex_labels,vertex_visibility,surface_patch.independent_planes(),fp['detailHeightRangeM'],triangles=ids)
        facial_attributes={'_FACIAL_DETAIL':append_accessor(doc,data,packed_binding.astype('<f4'),'VEC3',5126)}
        facial_metadata={'skinFacialAtlasTexture':append_texture(doc,data,np.round(np.concatenate([packed_detail,packed_expression],axis=1)*255),'skin-facial-independent',out),
                         'skinFacialAtlasLayout':'detail-expression-halves-v1',**regional_metadata}
    del physical,p,position,normal,nearest,dist
    albedo,albedo_report=equalize_skin_seams(original,original_bytes,prim,labels,out)
    albedo_index=append_texture(doc,data,albedo,'skin-albedo-seams',out)
    atlas_index=append_texture(doc,data,detail,'skin-detail-uv',out);expression_index=append_texture(doc,data,expression,'skin-expression-uv',out)
    face_uv=append_accessor(doc,data,uv.astype('<f4'),'VEC2',5126);weight_index=append_accessor(doc,data,np.ones(len(uv),dtype='<f4'),'SCALAR',5126);scatter_index=append_accessor(doc,data,np.full(len(uv),.12,dtype='<f4'),'SCALAR',5126)
    categories,triangle_report=triangle_categories(original,original_bytes,prim,masks);kind=np.full(len(ids),'native',dtype='U8')
    kind[np.isin(categories,SKIN_IDS)]='skin';kind[categories==6]='hair';kind[categories==4]='lips';kind[categories==5]='eyes';kind[categories==7]='nails'
    mat=original['materials'][prim['material']];orm=image_array(original,original_bytes,mat['pbrMetallicRoughness']['metallicRoughnessTexture']['index'])
    new_prims=[];counts={}
    for name in ['native','skin','hair','lips','eyes','nails']:
        selected=kind==name
        if not selected.any():continue
        q=copy.deepcopy(prim);q['indices']=append_accessor(doc,data,ids[selected].astype('<u4').reshape(-1),'SCALAR',5125);counts[name]=int(selected.sum())
        if name!='native':
            material=copy.deepcopy(mat);material['name']='Vision_'+name;material['extras']={'characterSurface':name,'surfaceVersion':2,'semanticSource':'local vision annotations'}
            maps=orm.copy();maps[:,:,2]=0;rough={'skin':.59,'hair':.76,'lips':.38,'eyes':.14,'nails':.32}[name];maps[:,:,1]=round(rough*255)
            material['pbrMetallicRoughness']['metallicFactor']=0;material['pbrMetallicRoughness']['roughnessFactor']=1
            material['pbrMetallicRoughness']['metallicRoughnessTexture']={'index':append_texture(doc,data,maps,name+'-vision-orm',out)}
            material['extensions']={'KHR_materials_specular':{'specularFactor':.65 if name=='skin' else .5,'specularColorFactor':[1,1,1]}}
            if name=='skin':
                material.pop('normalTexture',None)
                material['pbrMetallicRoughness']['baseColorTexture']={'index':albedo_index}
                material['extras'].update(skinDiffusionProfile=fp.get('diffusionProfile',[1,.55,.3]),skinMicroDetail=True,skinAtlasTexture=atlas_index,skinExpressionTexture=expression_index,skinAtlasHeightRangeM=fp['detailHeightRangeM'],skinBaseNormalMode='geometry plus authored UV detail; defective HY skin normal excluded',skinAtlasAttribution='Lee Perry-Smith / Infinite Realities; CC BY 3.0; see ATTRIBUTION.txt')
                q['attributes'].update(_FACE_UV=face_uv,_FACE_WEIGHT=weight_index,_SCATTER=scatter_index)
                q['attributes'].update(facial_attributes);material['extras'].update(facial_metadata)
            if name=='hair':
                material['extensions'].update(KHR_materials_anisotropy={'anisotropyStrength':.25,'anisotropyRotation':0},KHR_materials_sheen={'sheenColorFactor':[.025,.025,.025],'sheenRoughnessFactor':.8})
            doc['materials'].append(material);q['material']=len(doc['materials'])-1
            for extension in material['extensions']:
                if extension not in doc.setdefault('extensionsUsed',[]):doc['extensionsUsed'].append(extension)
        new_prims.append(q)
    doc['meshes'][0]['primitives']=new_prims
    assert sum(counts.values())==len(ids) and bytes(data[:len(original_bytes)])==original_bytes
    assert doc['nodes']==original['nodes'] and doc.get('skins')==original.get('skins') and doc.get('animations')==original.get('animations')
    repair_report=None
    repair_profile=base/'materials/repair-profile.json'
    if repair_profile.is_file():
        from texture_repair import apply_reviewed_repair
        repair_document=json.loads(repair_profile.read_text())
        operations=repair_document.get('repairs',[repair_document])
        if not isinstance(operations,list) or not operations or any(not isinstance(item,dict) or 'mask' not in item for item in operations):
            raise ValueError('Repair profile requires a nonempty list of explicit repair selections')
        repair_reports=[]
        for authored in operations:
            swatches=None
            if authored.get('cleanSwatches'):
                swatch_evidence=ROOT/authored['evidence'] if authored.get('evidence') else evidence
                swatch_manifest=json.loads((swatch_evidence/'manifest.json').read_text())
                if swatch_manifest['sourceSha256']!=source_hash:raise ValueError('Swatch evidence source mismatch')
                donor_yx=[]
                for swatch in authored['cleanSwatches']:
                    image_file=swatch_evidence/(swatch['view']+'.png')
                    if hashlib.sha256(image_file.read_bytes()).hexdigest()!=swatch_manifest['evidenceHashes'][image_file.name]:raise ValueError('Swatch image changed')
                    view_file=swatch_evidence/(swatch['view']+'.npz')
                    if hashlib.sha256(view_file.read_bytes()).hexdigest()!=swatch_manifest['evidenceHashes'][view_file.name]:raise ValueError('Swatch correspondence changed')
                    view=np.load(view_file)
                    for x,y in swatch['pixels']:
                        if view['material'][y,x]!=0:raise ValueError('Clean swatch is not on source material zero')
                        u,v=view['uv'][y,x];tx=min(labels.shape[1]-1,int(u*labels.shape[1]));ty=min(labels.shape[0]-1,int((1-v)*labels.shape[0]))
                        if labels[ty,tx] not in SKIN_IDS:raise ValueError('Clean swatch is outside independently reviewed skin')
                        donor_yx.append([ty,tx])
                swatch_surface=np.load(masks/'material-0-surface.npz')
                swatches={'positions':swatch_surface['position'],'occupied':swatch_surface['occupied'],'donorYX':donor_yx,'blendWidth':authored.get('blendWidthM',0)*np.ptp(np.asarray(swatch_manifest['worldBounds'])[:,2])/json.loads((base/'output/viewer-profile.json').read_text())['height']}
            item_report=apply_reviewed_repair(doc,data,ROOT/authored['mask'],out,source_hash,allowed_mask=np.isin(labels,SKIN_IDS),fill_enclosed_holes_up_to=authored.get('fillEnclosedSelectionHolesUpToTexels',0),surface_swatches=swatches)
            item_report['purpose']=authored.get('purpose','')
            repair_reports.append(item_report)
        repair_report=repair_reports[0] if 'repairs' not in repair_document else {'repairs':repair_reports,'status':'shaded_review_required'}
        repair_report['profileSha256']=hashlib.sha256(repair_profile.read_bytes()).hexdigest()
    doc['buffers'][0]['byteLength']=len(data);payload=json.dumps(doc,separators=(',',':')).encode();payload+=b' '*((-len(payload))%4);data.extend(b'\0'*((-len(data))%4))
    raw=struct.pack('<III',0x46546c67,2,28+len(payload)+len(data))+struct.pack('<II',len(payload),0x4e4f534a)+payload+struct.pack('<II',len(data),0x004e4942)+data
    (out/'character.part.glb').write_bytes(raw);(out/'character.part.glb').replace(out/'character.glb')
    result={'id':sid,'status':'shaded_review_required','method':'vision labels and geometry-linked full UV detail','source_sha256':source_hash,'output_sha256':hashlib.sha256(raw).hexdigest(),'triangle_counts':counts,'geometry_skin_animation_bytes_unchanged':True,'evidence':str(evidence),'maskReport':str(masks/'report.json'),'annotationSha256':report['annotationSha256'],'detail':'landmark registered scan face; seamless reduced scan microrelief elsewhere; authored nonfollicular palm/sole ridges','sourceNormal':'excluded only on explicitly labelled skin','remainingConflictTexels':report['materials'][0]['conflictTexels'],'vertexDetailSupport':vertex_support_report,'albedoSeams':albedo_report,'sourceAlbedoRepair':repair_report,'triangleEvidence':triangle_report}
    result['authoredBodyDetail']=body_detail.report
    result['authoredSurfacePatches']=surface_patch.report
    attribution=out/'ATTRIBUTION.txt';text=attribution.read_text()
    for sha,notice in surface_patch.attributions.items():
        marker='Surface patch adaptation SHA256 '+hashlib.sha256(notice.encode()).hexdigest()
        if marker not in text:text+='\n'+marker+'\nSource license SHA256 '+sha+'\n'+notice+'\n'
    attribution.write_text(text)
    result['independentFacialDetail']={'enabled':independent_face,'atlasSize':list(registered.shape[:2]),'layout':facial_metadata.get('skinFacialAtlasLayout'),'coverageAuthority':'unchanged body atlas; facial projection never adds skin'}
    if independent_face:
        result['independentFacialDetail'].update({'packedTextureSize':[packed_detail.shape[1]*2,packed_detail.shape[0]],'faceRegion':facial_metadata.get('skinFacialAtlasRegion',[0,0,1,1]),'regionalPatches':facial_metadata.get('skinRegionalAtlasPatches',[])})
    (out/'report.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--id',required=True);p.add_argument('--masks',required=True,type=Path);p.add_argument('--evidence',required=True,type=Path);a=p.parse_args();build(a.id,a.masks,a.evidence)
