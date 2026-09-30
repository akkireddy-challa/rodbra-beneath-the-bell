"""Trace a reviewed image pixel to its UV texel and contributing authoring views.

Read-only geometry/provenance diagnostic. Never chooses or changes an anatomical label.
Requires a dense bake made with --surface-data.
"""
import argparse,hashlib,json
from pathlib import Path
import numpy as np
from PIL import Image
from skin_views import LABELS

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def texel_footprint(positions,occupied,row,col,source_height,physical_height):
    if not np.isfinite(physical_height) or physical_height<=0:raise ValueError('Physical height must be positive and finite')
    if not np.isfinite(source_height) or source_height<=0:raise ValueError('Source height must be positive and finite')
    result=[];h,w=occupied.shape
    for dx,dy in [(-1,0),(1,0),(0,-1),(0,1)]:
        x=col+dx;y=row+dy
        if 0<=x<w and 0<=y<h and occupied[y,x]:
            result.append({'atlasOffset':[dx,dy],'distanceM':float(np.linalg.norm(positions[y,x]-positions[row,col])*physical_height/source_height)})
    return {'physicalHeightM':physical_height,'neighbours':result,'interpretation':'Local occupied-texel spacing, not guaranteed detail resolution. UV discontinuities can make a neighbour distant; inspect individual values.'}

def inspect(evidence,masks,view_name,x,y,physical_height=None):
    evidence=Path(evidence);masks=Path(masks)
    manifest=json.loads((evidence/'manifest.json').read_text())
    report=json.loads((masks/'report.json').read_text())
    archived=json.loads((masks/'dense-request.json').read_text())
    for key in ['sourceSha256','size','views','materials','worldBounds']:
        if archived.get(key)!=manifest.get(key):raise ValueError('Bake/evidence mismatch: '+key)
    if report['sourceSha256']!=manifest['sourceSha256'] or digest(Path(manifest['source']))!=manifest['sourceSha256']:
        raise ValueError('Source identity changed')
    if digest(masks/'annotations.json')!=report['annotationSha256']:raise ValueError('Baked annotations changed')
    if view_name not in [v['name'] for v in manifest['views']]:raise ValueError('Unknown evidence view')
    if not 0<=x<manifest['size'] or not 0<=y<manifest['size']:raise ValueError('Pixel outside evidence image')
    for ext in ['.png','.npz']:
        name=view_name+ext
        if digest(evidence/name)!=manifest['evidenceHashes'][name]:raise ValueError('Evidence changed: '+name)
    with np.load(evidence/(view_name+'.npz')) as data:
        material=int(data['material'][y,x]);uv=data['uv'][y,x]
    if material<0 or not np.isfinite(uv).all() or (uv<0).any() or (uv>1).any():raise ValueError('Pixel has no supported source UV surface')
    labels=np.asarray(Image.open(masks/f'material-{material}-labels.png'));h,w=labels.shape
    col=min(int(uv[0]*w),w-1);row=min(int((1-uv[1])*h),h-1)
    footprint=None
    with np.load(masks/f'material-{material}-surface.npz') as surface:
        occupied=surface['occupied'];positions=surface['position']
        if not occupied[row,col]:raise ValueError('Selected UV texel is unoccupied')
        point=positions[row,col];normal=surface['normal'][row,col]
        visible=int(surface['visibilityBits'][row,col]);voted=int(surface['viewBits'][row,col])
        if physical_height is not None:footprint=texel_footprint(positions,occupied,row,col,np.ptp(np.asarray(manifest['worldBounds'])[:,2]),physical_height)
    conflicts=np.asarray(Image.open(masks/f'material-{material}-conflicts.png'))
    bounds=np.asarray(manifest['worldBounds']);height=bounds[1,2]-bounds[0,2];center=bounds.mean(0);names={v:k for k,v in LABELS.items()};contributors=[]
    for index,view in enumerate(manifest['views']):
        if not visible&(1<<index):continue
        direction=np.asarray(view['direction'],float);direction/=np.linalg.norm(direction)
        up=np.asarray(view.get('up',[0,0,1]),float);right=np.cross(direction,up);right/=np.linalg.norm(right);up=np.cross(right,direction)
        target=center+height*np.asarray(view.get('targetOffset',[0,0,0]));span=height*view.get('span',1.1)
        px=int(np.floor(((point-target)@right/span+.5)*manifest['size']));py=int(np.floor((.5-(point-target)@up/span)*manifest['size']))
        if not 0<=px<manifest['size'] or not 0<=py<manifest['size']:raise ValueError('Visibility bit projects outside its archived camera')
        label_file=masks/(view['name']+'-annotation.npy');kind=int(np.load(label_file)[py,px]) if label_file.exists() else 0
        contributors.append({'view':view['name'],'pixel':[px,py],'label':names[kind],'facing':float(abs(normal@direction)),'contributed':bool(voted&(1<<index))})
    return {'sourceSha256':manifest['sourceSha256'],'annotationSha256':report['annotationSha256'],'view':view_name,'pixel':[x,y],'material':material,'atlasPixel':[col,row],'label':names[int(labels[row,col])],'conflict':bool(conflicts[row,col]),'contributors':contributors,'texelFootprint':footprint,'decision':'No semantic decision made; inspect the listed source pixels before editing annotations.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--evidence',required=True,type=Path);parser.add_argument('--masks',required=True,type=Path);parser.add_argument('--view',required=True);parser.add_argument('--x',required=True,type=int);parser.add_argument('--y',required=True,type=int);parser.add_argument('--height-m',type=float,help='Known authored physical height, for local texel-spacing diagnostics');a=parser.parse_args()
    print(json.dumps(inspect(a.evidence,a.masks,a.view,a.x,a.y,a.height_m),indent=2))
