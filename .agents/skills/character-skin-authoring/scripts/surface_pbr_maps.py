"""Bake vision-authored hair/lip/nail response into standard glTF PBR maps."""
import numpy as np
from scipy.ndimage import distance_transform_edt,gaussian_filter
from glb_output import image_array,append_texture

def surface_weights(labels,occupied):
    labels=labels.copy()
    distance,nearest=distance_transform_edt(~occupied,return_indices=True)
    gutter=(~occupied)&(distance<=4);labels[gutter]=labels[tuple(nearest[:,gutter])]
    categories={'skin':[1,2,3,9],'hair':[6],'lips':[4],'nails':[7]}
    known=np.isin(labels,[1,2,3,9,6,4,7])
    weights={key:gaussian_filter(np.isin(labels,ids).astype(np.float32),1.2) for key,ids in categories.items()}
    total=sum(weights.values())
    for value in weights.values():value/=np.maximum(total,1e-12);value[~known]=0
    return weights

def bake_surface_pbr(doc,data,material,labels,occupied,out,weights=None):
    pbr=material['pbrMetallicRoughness'];ext=material.setdefault('extensions',{})
    spec=ext.get('KHR_materials_specular',{})
    if spec.get('specularTexture') or spec.get('specularColorTexture'):raise ValueError('Compose existing specular textures explicitly before region baking')
    if ext.get('KHR_materials_anisotropy',{}).get('anisotropyStrength',0) or ext.get('KHR_materials_sheen',{}).get('sheenColorFactor',[0,0,0])!=[0,0,0]:raise ValueError('Preserve existing native fiber maps with a dedicated adapter')
    weights=surface_weights(labels,occupied) if weights is None else weights
    hair=weights['hair'];lips=weights['lips'];nails=weights['nails'];non_skin=hair+lips+nails
    # The skin shader performs the final skin/non-skin mix. These base PBR maps
    # describe the conditional non-skin response, avoiding a second native mix.
    denominator=np.maximum(non_skin,1e-12);h=hair/denominator;l=lips/denominator;n=nails/denominator;assigned=np.clip(h+l+n,0,1)
    orm=image_array(doc,data,pbr['metallicRoughnessTexture']['index']).astype(np.float32)/255
    orm[:,:,1]=orm[:,:,1]*pbr.get('roughnessFactor',1)*(1-assigned)+h*.76+l*.38+n*.32
    orm[:,:,2]*=pbr.get('metallicFactor',1)*(1-assigned)
    pbr['roughnessFactor']=1;pbr['metallicFactor']=1
    pbr['metallicRoughnessTexture']={'index':append_texture(doc,data,np.round(orm*255),'vision-surface-orm',out)}
    factor=float(spec.get('specularFactor',1));color=np.asarray(spec.get('specularColorFactor',[1,1,1]),float)
    intensity=np.maximum(factor,.5);color_factor=np.maximum(color,1.)
    rgba=np.full((*labels.shape,4),255,np.uint8);rgba[:,:,3]=np.round(((1-assigned)*factor+assigned*.5)/intensity*255)
    intensity_index=append_texture(doc,data,rgba,'vision-surface-specular',out)
    linear=((1-assigned[:,:,None])*color+assigned[:,:,None])/color_factor
    encoded=np.where(linear<=.0031308,linear*12.92,1.055*np.maximum(linear,0)**(1/2.4)-.055)
    color_index=append_texture(doc,data,np.round(encoded*255),'vision-surface-specular-color',out)
    ext['KHR_materials_specular']={'specularFactor':intensity,'specularColorFactor':color_factor.tolist(),'specularTexture':{'index':intensity_index},'specularColorTexture':{'index':color_index}}
    flow=np.zeros((*labels.shape,3),np.uint8);flow[:,:,0]=255;flow[:,:,1]=128;flow[:,:,2]=np.round(hair*255)
    ext['KHR_materials_anisotropy']={'anisotropyStrength':.25,'anisotropyTexture':{'index':append_texture(doc,data,flow,'vision-surface-fiber-flow',out)}}
    sheen=np.repeat(np.round(hair*255).astype(np.uint8)[:,:,None],3,axis=2)
    ext['KHR_materials_sheen']={'sheenColorFactor':[.025,.025,.025],'sheenRoughnessFactor':.8,'sheenColorTexture':{'index':append_texture(doc,data,sheen,'vision-surface-sheen',out)}}
    for key in ext:
        if key not in doc.setdefault('extensionsUsed',[]):doc['extensionsUsed'].append(key)
    return {'hairTexels':int((hair>0).sum()),'lipTexels':int((lips>0).sum()),'nailTexels':int((nails>0).sum()),'method':'explicit vision labels baked into ORM, specular, anisotropy and sheen; native response outside selected regions','limitations':['Fiber direction is a uniform provisional tangent direction; author comb-flow before final hair acceptance','8-bit PBR maps quantize material factors']}
