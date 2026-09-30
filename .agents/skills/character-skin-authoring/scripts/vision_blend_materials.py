"""Opt-in mask-blended skin revision. Native material response survives outside skin.

This changes no semantic labels and does not add anatomical coverage. Kept separate
from accepted material revisions while mixed surface rendering is evaluated.
"""
import argparse,copy,hashlib,json,shutil
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from glb_arrays import read,accessor
from glb_output import append_accessor,append_texture,image_array
from eye_assets import write_glb

from workspace_paths import workspace_root
ROOT=workspace_root(__file__)

def build(sid,all_surfaces=False):
    base=ROOT/'characters'/sid/'high/v1';source=base/'materials/v2/character.glb';out=base/'materials'/('v4' if all_surfaces else 'v3');out.mkdir(parents=True,exist_ok=True)
    doc,data=read(source);primitives=doc['meshes'][0]['primitives']
    skin=next(p for p in primitives if doc['materials'][p['material']].get('extras',{}).get('characterSurface')=='skin')
    native=[p for p in primitives if doc['materials'][p['material']].get('extras',{}).get('characterSurface') not in ['skin','hair','lips','eyes','nails']]
    if len(native)!=1:raise ValueError('Mixed adapter currently requires one native source material')
    combined=native+[skin]
    if all_surfaces:combined += [p for p in primitives if doc['materials'][p['material']].get('extras',{}).get('characterSurface') in ['hair','lips','nails']]
    ids=np.concatenate([accessor(doc,data,p['indices']) for p in combined])
    for p in combined:
        if any(p['attributes'][key]!=skin['attributes'][key] for key in ['POSITION','NORMAL','TEXCOORD_0']):raise ValueError('Mixed primitives must share source geometry and UVs')
    material=copy.deepcopy(doc['materials'][native[0]['material']]);skin_material=doc['materials'][skin['material']]
    material['name']='Vision_mask_blended_skin';material['extras']=copy.deepcopy(skin_material['extras']);material['extras']['skinSurfaceBlend']=True
    detail=image_array(doc,data,material['extras']['skinAtlasTexture'],mode='RGBA').copy()
    source_report=json.loads((base/'materials/v2/report.json').read_text())
    if source_report['output_sha256']!=hashlib.sha256(source.read_bytes()).hexdigest():raise ValueError('Skin source changed after its evidence report was written')
    masks=(ROOT/source_report['maskReport']).parent
    if json.loads((masks/'report.json').read_text())['sourceSha256']!=source_report['source_sha256']:raise ValueError('UV occupancy evidence belongs to another source')
    occupied=np.load(masks/'material-0-surface.npz')['occupied']
    if occupied.shape!=detail.shape[:2]:raise ValueError('UV occupancy does not match the atlas')
    # UV gutters are not surface area. Give filtering samples outside each island
    # its nearest occupied texel, without assigning any unknown surface texels.
    distance,nearest=distance_transform_edt(~occupied,return_indices=True)
    gutter=(~occupied)&(distance<=4)
    detail[gutter]=detail[tuple(nearest[:,gutter])]
    del distance,nearest
    # Antialias only inside reviewed coverage: never grow skin over an unknown region.
    inside=detail[:,:,3]>127
    ramp=np.clip((distance_transform_edt(inside)-.5)/3,0,1)
    detail[:,:,3]=np.round(255*ramp*ramp*(3-2*ramp)).astype(np.uint8)
    pbr_report=None
    if all_surfaces:
        from surface_pbr_maps import bake_surface_pbr,surface_weights
        labels=np.asarray(Image.open(base/'materials/v2/vision-labels.png'))
        weights=surface_weights(labels,occupied)
        detail[:,:,3]=np.round(weights['skin']*255).astype(np.uint8)
        pbr_report=bake_surface_pbr(doc,data,material,labels,occupied,out,weights)
    material['extras']['skinAtlasTexture']=append_texture(doc,data,detail,'skin-detail-blended',out)
    material['pbrMetallicRoughness']['baseColorTexture']=copy.deepcopy(skin_material['pbrMetallicRoughness']['baseColorTexture'])
    doc['materials'].append(material);primitive=copy.deepcopy(skin);primitive['material']=len(doc['materials'])-1
    primitive['indices']=append_accessor(doc,data,ids.astype('<u4'),'SCALAR',5125)
    doc['meshes'][0]['primitives']=[primitive]+[p for p in primitives if p not in combined]
    report={'id':sid,'status':'mixed_surface_review_required','inputSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'method':'authored UV skin coverage mixes native and skin response per fragment','limitations':['Hair, lip and ocular primitives remain separate','No new coverage inferred','WebGPU and WebGL visual acceptance required']}
    report['uvGutterTexels']=int(gutter.sum())
    report['triangle_counts']=source_report['triangle_counts']
    report['viewerReady']=False
    report['surfacePbr']=pbr_report
    if all_surfaces:report['limitations'][0]='Ocular primitives remain separate; fiber flow and source defects still require review'
    repair_profile=base/'materials/geometry-repair-profile.json'
    if all_surfaces and repair_profile.is_file():
        from geometry_repair import apply_geometry_repair
        report['geometryRepair']=apply_geometry_repair(doc,data,repair_profile,out,source_report['source_sha256'])
    report['outputSha256']=write_glb(doc,data,out/'character.glb');(out/'report.json').write_text(json.dumps(report,indent=2))
    shutil.copyfile(base/'materials/v2/ATTRIBUTION.txt',out/'ATTRIBUTION.txt');print(json.dumps(report))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--id',required=True);parser.add_argument('--all-surfaces',action='store_true');args=parser.parse_args();build(args.id,args.all_surfaces)
