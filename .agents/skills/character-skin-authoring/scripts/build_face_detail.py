"""Register an attributed scan detail atlas to a generated face, preserving identity.

This transfers band-limited displacement, not the scan's face shape. Height scale
is an authoring calibration (not recovered physical capture metadata). No MERL or
MetaHuman textures are used. All derivatives carry source/license/hash provenance.
"""
from pathlib import Path
import hashlib,json
import numpy as np
from PIL import Image,ImageDraw
from scipy.ndimage import gaussian_filter, distance_transform_edt
from face_atlas import rasterize,sample,register
from glb_arrays import read,accessor
from workspace_paths import workspace_root
ROOT=workspace_root(__file__)
REFERENCE=ROOT/'highquality/references/lee-perry-smith'

def pixels_to_coords(points,bounds,n=900):
    p=np.asarray(points,dtype=float)/n;p[:,1]=1-p[:,1]
    return np.asarray(bounds[:2])+p*(np.asarray(bounds[2:])-bounds[:2])

def region_image(profile,size=2048):
    im=Image.new('L',(size,size),0);draw=ImageDraw.Draw(im)
    for value,kind in enumerate(['eyes','brows','lips'],1):
        for polygon in profile['regions'][kind]:
            draw.polygon([(x/profile['annotationImageSize']*(size-1),(1-y/profile['annotationImageSize'])*(size-1)) for x,y in polygon],fill=value)
    return np.array(im)

def verify_landmark_evidence(profile,root,source):
    if profile.get('version',1)<2:return 'legacy_unbound_landmarks'
    if hashlib.sha256(source.read_bytes()).hexdigest()!=profile['sourceSha256']:
        raise ValueError('Face landmarks belong to a different source mesh')
    image=root/profile['evidenceImage']
    if hashlib.sha256(image.read_bytes()).hexdigest()!=profile['evidenceImageSha256']:
        raise ValueError('Face landmark evidence image changed')
    with Image.open(image) as pixels:
        if pixels.size!=(profile['annotationImageSize'],profile['annotationImageSize']):
            raise ValueError('Face landmark evidence dimensions differ')
    return 'source_and_image_hash_verified'

def build(sid='b3662'):
    profile_path=ROOT/'highquality/materials/faces'/f'{sid}.json';profile=json.loads(profile_path.read_text())
    evidence_status=verify_landmark_evidence(profile,ROOT,ROOT/'characters'/sid/'high/v1/source/hy31pro.glb')
    folder=ROOT/'characters'/sid/'high/v1/materials/v2';folder.mkdir(parents=True,exist_ok=True)
    source=REFERENCE/'LeePerrySmith.glb';j,b=read(source);pr=j['meshes'][0]['primitives'][0]
    p=accessor(j,b,pr['attributes']['POSITION']);uv=accessor(j,b,pr['attributes']['TEXCOORD_0']);uv[:,1]=1-uv[:,1]
    ids=accessor(j,b,pr['indices']).reshape(-1,3)
    size=profile.get('atlasSize',2048)
    if size not in (2048,4096):raise ValueError('Facial atlasSize must be 2048 or 4096')
    pixel_scale=size/2048
    scan_uv,scan_valid=rasterize(p,ids,uv,profile['sourceBounds'],size)
    displacement=np.asarray(Image.open(REFERENCE/'Infinite-Level_02_Disp_NoSmoothUV-4096.jpg').convert('L'),dtype=float)/255
    scan_height=sample(displacement,scan_uv)
    # Inpaint uncovered pixels before filtering to avoid silhouette impulses.
    nearest=distance_transform_edt(~scan_valid,return_distances=False,return_indices=True)
    scan_height=scan_height[tuple(nearest)]
    # Remove identity-scale form; retain scan-correlated intermediate and fine detail.
    band=gaussian_filter(scan_height,.65*pixel_scale)-gaussian_filter(scan_height,24*pixel_scale)
    central=band[size//3:3*size//4,size//3:2*size//3]
    amplitude=np.percentile(np.abs(central),95)
    band*=profile['detailAmplitudeM']/max(amplitude,1.e-6)
    np.save(folder/'scan-band-height-m.npy',band.astype('float32'))
    yy,xx=np.mgrid[0:size,0:size];coords=np.stack([xx,yy],-1)/(size-1)
    bounds=np.array(profile['bounds']);target=coords*(bounds[2:]-bounds[:2])+bounds[:2]
    mapped,valid=register(target.reshape(-1,2),pixels_to_coords(profile['targetPixels'],profile['bounds'],profile['annotationImageSize']),pixels_to_coords(profile['sourcePixels'],profile['sourceBounds'],profile.get('sourceAnnotationImageSize',900)))
    sb=np.array(profile['sourceBounds']);lookup=((mapped-sb[:2])/(sb[2:]-sb[:2])).reshape(size,size,2)
    height=sample(band,lookup)
    regions=region_image(profile,size)
    coverage=valid.reshape(size,size)&(regions==0)
    if not coverage.any():raise ValueError('Registration has no uncovered skin; review landmark hull and exclusion polygons')
    feather=np.clip(distance_transform_edt(coverage)/(48*pixel_scale),0,1)
    # Roughness follows the transferred relief's local variation, with coarse oil regions.
    dy,dx=np.gradient(height);variance=gaussian_filter(dx*dx+dy*dy,3*pixel_scale)
    relief=np.clip(np.sqrt(variance)/max(np.percentile(np.sqrt(variance[coverage]),95),1e-9),0,1)
    # Transfer only gentle chromatic variation from clean upper-face skin;
    # reject beard/jaw pigment so the donor's stubble does not enter the queen.
    scan_color=sample(np.asarray(Image.open(REFERENCE/'Map-COL.jpg'),dtype=float)/255,scan_uv)
    chroma=np.log(np.maximum(scan_color[:,:,0],.02)/np.maximum(scan_color[:,:,1],.02))
    chroma=gaussian_filter(chroma,4*pixel_scale)-gaussian_filter(chroma,50*pixel_scale)
    pigment=sample(chroma,lookup)*np.clip((lookup[:,:,1]-.53)/.09,0,1)
    pigment=np.clip(pigment*4,-.3,.3)
    packed=np.stack([np.clip(.5+height/profile['detailHeightRangeM'],0,1),.45+.20*relief,.5+pigment,feather],axis=-1)
    Image.fromarray(np.round(packed*255).astype('uint8'),'RGBA').save(folder/'face-detail.png')
    # Authored appearance deltas, NOT captured expression scans. Modulate the
    # registered relief within facial regions; the source HY geometry stays intact.
    x=coords[:,:,0];z=coords[:,:,1]
    forehead=np.exp(-((x-.5)/.22)**2-((z-.69)/.11)**2)
    smile=np.exp(-((abs(x-.5)-.15)/.10)**2-((z-.23)/.13)**2)
    squint=np.exp(-((abs(x-.5)-.19)/.10)**2-((z-.46)/.09)**2)
    delta=np.stack([height*forehead*.8,height*smile*.6,height*squint*.7],-1)
    dynamic=np.concatenate([np.clip(.5+delta/profile['detailHeightRangeM'],0,1),np.clip((smile+forehead+squint)*feather,0,1)[...,None]],axis=-1)
    Image.fromarray(np.round(dynamic*255).astype('uint8'),'RGBA').save(folder/'face-expression.png')
    np.save(folder/'face-height-m.npy' ,height.astype('float32'))
    Image.fromarray(regions.astype('uint8')).save(folder/'face-regions.png')
    # Useful independent normal preview in the registered face plane.
    physical_height=json.loads((ROOT/'characters'/sid/'high/v1/output/viewer-profile.json').read_text())['height']
    spacing=(bounds[2:]-bounds[:2])*physical_height/(size-1)
    dy,dx=np.gradient(height,spacing[1],spacing[0]);n=np.stack([-dx,-dy,np.ones_like(height)],-1);n/=np.linalg.norm(n,axis=-1,keepdims=True)
    Image.fromarray(np.round((n*.5+.5)*255).astype('uint8')).save(folder/'face-normal-preview.png')
    report={'id':sid,'landmarkEvidence':evidence_status,'method':'landmark-registered, band-limited scan displacement','author':'Lee Perry-Smith / Infinite Realities','license':'CC BY 3.0','licenseUrl':'https://creativecommons.org/licenses/by/3.0/','sourceUrl':'https://github.com/mrdoob/three.js/tree/r186/examples/models/gltf/LeePerrySmith','changes':'Projected into a facial atlas, band-pass filtered, amplitude calibrated, landmark-warped and masked. Only upper-face chromatic residual is transferred; beard pigment and face shape are not copied.','expressionMaps':'Authored modulation of scan relief; not captured expressions or a biological color model','scale':'Authoring estimate, not measured displacement units','heightRangeM':profile['detailHeightRangeM'],'profile_sha256':hashlib.sha256(profile_path.read_bytes()).hexdigest(),'inputs':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in REFERENCE.iterdir() if f.is_file()},'source_sha256':hashlib.sha256((ROOT/'characters'/sid/'high/v1/source/hy31pro.glb').read_bytes()).hexdigest()}
    report['atlasSize']=size;report['texelSpacingM']=spacing.tolist();report['filterScaleRelativeTo2048']=pixel_scale
    (folder/'face-detail-provenance.json').write_text(json.dumps(report,indent=2)+'\n')
    (folder/'ATTRIBUTION.txt').write_text('Facial detail adapted from Infinite, 3D Head Scan by Lee Perry-Smith / Infinite Realities.\nCC BY 3.0: https://creativecommons.org/licenses/by/3.0/\nSource: three.js r186 examples/models/gltf/LeePerrySmith.\nModified by landmark registration, filtering, masking and amplitude calibration.\n')
    print(json.dumps({'id':sid,'atlasSize':size,'heightP95Mm':float(np.percentile(abs(height[coverage]),95)*1000)}))
if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--id',default='b3662');build(parser.parse_args().id)
