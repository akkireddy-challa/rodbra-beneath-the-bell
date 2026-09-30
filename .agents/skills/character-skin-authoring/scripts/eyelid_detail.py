"""Continue an independently authored facial atlas onto a reconstructed skin band."""
import numpy as np
from glb_output import append_accessor,append_texture

def bind_lid_detail(doc,data,primitive,material,world_positions,center,source_height,profile,source_extras,folder):
    if 'skinFacialAtlasTexture' not in source_extras:return False
    if source_extras.get('skinFacialAtlasLayout')!='detail-expression-halves-v1':
        raise ValueError('Unsupported eyelid facial atlas layout')
    if source_extras['skinAtlasHeightRangeM']!=profile['detailHeightRangeM']:
        raise ValueError('Eyelid detail physical range differs from facial atlas')
    bounds=np.asarray(profile['bounds'],float)
    if bounds.shape!=(4,) or not np.isfinite(bounds).all() or np.any(bounds[2:]<=bounds[:2]) or not np.isfinite(source_height) or source_height<=0:
        raise ValueError('Invalid eyelid detail projection')
    normalized=(world_positions-center)/source_height
    normalized[:,2]+=.5
    uv=(normalized[:,[0,2]]-bounds[:2])/(bounds[2:]-bounds[:2])
    region=np.asarray(source_extras.get('skinFacialAtlasRegion',[0,0,1,1]),float)
    if region.shape!=(4,) or not np.isfinite(region).all() or np.any(region[:2]<0) or np.any(region[2:]>1) or np.any(region[2:]<=region[:2]):
        raise ValueError('Invalid facial subregion inside the packed detail atlas')
    uv=uv*(region[2:]-region[:2])+region[:2]
    # Visibility is explicit: this geometry is the independently authored lid band,
    # not an automatically inferred extension of the source skin mask.
    count=len(uv);attributes=primitive['attributes']
    attributes['_FACIAL_DETAIL']=append_accessor(doc,data,np.c_[uv,np.ones(count)].astype('<f4'),'VEC3',5126)
    attributes['_FACE_UV']=append_accessor(doc,data,np.full((count,2),.5,dtype='<f4'),'VEC2',5126)
    attributes['_FACE_WEIGHT']=append_accessor(doc,data,np.ones(count,dtype='<f4'),'SCALAR',5126)
    neutral=append_texture(doc,data,np.array([[[128,150,128,255]]],np.uint8),'lid-neutral-detail',folder)
    expression=append_texture(doc,data,np.array([[[128,128,128,0]]],np.uint8),'lid-neutral-expression',folder)
    material['extras'].update(skinMicroDetail=True,skinAtlasTexture=neutral,
        skinExpressionTexture=expression,skinAtlasHeightRangeM=profile['detailHeightRangeM'],
        skinFacialAtlasTexture=source_extras['skinFacialAtlasTexture'],
        skinFacialAtlasLayout='detail-expression-halves-v1',
        skinAtlasAttribution=source_extras.get('skinAtlasAttribution','See ATTRIBUTION.txt'))
    return True
