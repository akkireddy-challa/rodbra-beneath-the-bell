"""Conservative albedo repair of explicitly vision-selected source defects.

The mask is evidence, not a detector. Solve a harmonic fill in linear light;
pixels outside the mask remain byte-identical. Never repair semantics this way.
"""
import hashlib,json
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import binary_fill_holes,label,distance_transform_edt
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import spsolve
from glb_output import image_array,append_texture

def harmonic_fill(rgb,mask):
    if rgb.shape[:2]!=mask.shape:raise ValueError('Repair mask must match source texture resolution')
    yy,xx=np.nonzero(mask)
    if not len(yy):raise ValueError('Empty repair selection')
    if len(yy)>50000:raise ValueError('Large texture reconstruction needs a separately reviewed workflow')
    if (yy==0).any() or (xx==0).any() or (yy==mask.shape[0]-1).any() or (xx==mask.shape[1]-1).any():raise ValueError('Repair touching atlas edge needs an explicit UV seam adapter')
    values=rgb.astype(float)/255;linear=np.where(values<=.04045,values/12.92,((values+.055)/1.055)**2.4)
    lookup=np.full(mask.shape,-1,np.int32);lookup[yy,xx]=np.arange(len(yy));matrix=lil_matrix((len(yy),len(yy)));rhs=np.zeros((len(yy),3))
    for row,(y,x) in enumerate(zip(yy,xx)):
        matrix[row,row]=4
        for ny,nx in [(y-1,x),(y+1,x),(y,x-1),(y,x+1)]:
            if mask[ny,nx]:matrix[row,lookup[ny,nx]]=-1
            else:rhs[row]+=linear[ny,nx]
    filled=np.clip(spsolve(matrix.tocsr(),rhs),0,1)
    srgb=np.where(filled<=.0031308,filled*12.92,1.055*filled**(1/2.4)-.055)
    result=rgb.copy();result[yy,xx]=np.round(srgb*255).astype(np.uint8)
    assert np.array_equal(result[~mask],rgb[~mask])
    return result

def surface_swatch_fill(rgb,mask,positions,donor_yx,allowed_mask=None,blend_width=0):
    """Interpolate agent-selected clean colors across UV islands in surface space."""
    if positions.shape!=(*mask.shape,3):raise ValueError('Surface positions do not match repair selection')
    donor_yx=np.asarray(donor_yx,dtype=int)
    if len(donor_yx)<3:raise ValueError('Surface repair needs at least three reviewed clean swatches')
    yy,xx=np.nonzero(mask);donors=positions[donor_yx[:,0],donor_yx[:,1]]
    if not np.isfinite(donors).all():raise ValueError('Invalid donor surface position')
    samples=rgb[donor_yx[:,0],donor_yx[:,1]].astype(float)/255
    samples=np.where(samples<=.04045,samples/12.92,((samples+.055)/1.055)**2.4)
    # The nearest clean swatches determine color, never the anatomical label.
    # Limit to three donors so the opposite hand cannot flatten local variation.
    distance=((positions[yy,xx,None,:]-donors[None,:,:])**2).sum(2)
    nearest=np.argsort(distance,axis=1)[:,:3];d=np.take_along_axis(distance,nearest,axis=1)
    weights=1/np.maximum(d,1e-16);weights/=weights.sum(1,keepdims=True)
    linear=(samples[nearest]*weights[:,:,None]).sum(1)
    if blend_width:
        from scipy.spatial import cKDTree
        if allowed_mask is None:raise ValueError('Surface feathering needs independent skin coverage')
        boundary=allowed_mask&~mask
        if not boundary.any():raise ValueError('Surface feathering needs an unchanged skin boundary')
        distance=cKDTree(positions[boundary]).query(positions[yy,xx])[0]
        blend=np.clip(distance/blend_width,0,1);blend=blend*blend*(3-2*blend)
        original=rgb[yy,xx].astype(float)/255
        original=np.where(original<=.04045,original/12.92,((original+.055)/1.055)**2.4)
        linear=original*(1-blend[:,None])+linear*blend[:,None]
    srgb=np.where(linear<=.0031308,linear*12.92,1.055*linear**(1/2.4)-.055)
    result=rgb.copy();result[yy,xx]=np.round(np.clip(srgb,0,1)*255).astype(np.uint8)
    assert np.array_equal(result[~mask],rgb[~mask])
    return result

def apply_reviewed_repair(doc,data,folder,out,source_hash,allowed_mask=None,fill_enclosed_holes_up_to=0,surface_swatches=None):
    folder=Path(folder);report=json.loads((folder/'report.json').read_text())
    if report['sourceSha256']!=source_hash:raise ValueError('Texture repair evidence belongs to another source')
    label_file=folder/'material-0-labels.png';mask=np.asarray(Image.open(label_file))==8
    filled_holes=0
    if fill_enclosed_holes_up_to:
        if allowed_mask is None:raise ValueError('Repair hole closure requires independent anatomical evidence')
        if not 0 < fill_enclosed_holes_up_to <= 64:raise ValueError('Repair hole closure is limited to 64 texels per enclosed hole')
        holes=binary_fill_holes(mask)&~mask
        components,count=label(holes)
        sizes=np.bincount(components.ravel());sizes[0]=fill_enclosed_holes_up_to+1
        additions=holes&(sizes[components]<=fill_enclosed_holes_up_to)&allowed_mask
        # An enclosed repair-selection hole is not an anatomical classification.
        # Only independently reviewed skin may receive the authored color repair.
        filled_holes=int(additions.sum());mask|=additions
    excluded=0
    if allowed_mask is not None:
        if allowed_mask.shape!=mask.shape:raise ValueError('Repair and anatomical mask resolution mismatch')
        excluded=int((mask&~allowed_mask).sum());mask&=allowed_mask
    # Conflicted/unobserved texels are deliberately excluded by the projection helper.
    references={}
    for primitive in doc['meshes'][0]['primitives']:
        material=doc['materials'][primitive['material']];slot=material.get('pbrMetallicRoughness',{}).get('baseColorTexture')
        if slot is not None:references.setdefault(slot['index'],[]).append(slot)
    for index,slots in references.items():
        pixels=image_array(doc,data,index)
        repaired=harmonic_fill(pixels,mask) if surface_swatches is None else surface_swatch_fill(pixels,mask,surface_swatches['positions'],surface_swatches['donorYX'],allowed_mask=allowed_mask,blend_width=surface_swatches.get('blendWidth',0))
        if surface_swatches is not None and 'occupied' in surface_swatches:
            occupied=surface_swatches['occupied']
            distance,nearest=distance_transform_edt(~occupied,return_indices=True)
            gutters=(~occupied)&(distance<=4)&mask[tuple(nearest)]
            repaired[gutters]=repaired[tuple(nearest[:,gutters])]
        replacement=append_texture(doc,data,repaired,f'vision-repaired-albedo-{index}',out)
        for slot in slots:slot['index']=replacement
    return {'selectionSha256':hashlib.sha256(label_file.read_bytes()).hexdigest(),'annotationSha256':report['annotationSha256'],'selectedTexels':int(mask.sum()),'enclosedSelectionHoleTexels':filled_holes,'excludedOutsideAllowedRegion':excluded,'textures':len(references),'method':('linear-light harmonic fill' if surface_swatches is None else 'linear-light interpolation from reviewed clean swatches in surface space')+' strictly inside vision-selected defect mask','status':'shaded_review_required'}
