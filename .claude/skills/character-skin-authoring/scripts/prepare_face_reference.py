"""Render the licensed Lee Perry-Smith donor in the exact registration coordinates.

This supplies an inspectable image for source landmarks, not target anatomy.
"""
import argparse,hashlib,json
from pathlib import Path
import numpy as np
from PIL import Image
from face_atlas import rasterize,sample
from glb_arrays import read,accessor

def prepare(workspace,out,size=900):
    if not 128<=size<=2048:raise ValueError('Reference view size must be 128..2048')
    reference=workspace/'highquality/references/lee-perry-smith';source=reference/'LeePerrySmith.glb';color=reference/'Map-COL.jpg';bounds=[-3,-3,3,4]
    doc,data=read(source);prim=doc['meshes'][0]['primitives'][0]
    points=accessor(doc,data,prim['attributes']['POSITION']);uv=accessor(doc,data,prim['attributes']['TEXCOORD_0']).copy();uv[:,1]=1-uv[:,1]
    lookup,valid=rasterize(points,accessor(doc,data,prim['indices']).reshape(-1,3),uv,bounds,size)
    rgb=sample(np.asarray(Image.open(color).convert('RGB'),float)/255,lookup);rgb[~valid]=.18
    out.mkdir(parents=True,exist_ok=True);image=out/'donor-front.png';Image.fromarray(np.round(np.flipud(rgb)*255).astype(np.uint8)).save(image)
    receipt={'sourceBounds':bounds,'sourceAnnotationImageSize':size,'imageSha256':hashlib.sha256(image.read_bytes()).hexdigest(),'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'colorSha256':hashlib.sha256(color.read_bytes()).hexdigest(),'coordinateConvention':'Donor X/Y plane, nearest positive Z; top-left image pixels; matches build_face_detail sourcePixels','license':'CC BY 3.0','attribution':'Lee Perry-Smith / Infinite Realities; projection derivative'}
    (out/'registration-view.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--workspace',required=True,type=Path);p.add_argument('--out',required=True,type=Path);p.add_argument('--size',type=int,default=900);a=p.parse_args();prepare(a.workspace.resolve(),a.out.resolve(),a.size)
