"""Adapt the CC0 MakeHuman eye atlas to the optical eye's planar UV contract.

The source remains immutable. Iris pigment is an authored character parameter;
the asset supplies spatial detail. This is not a captured iris or recovered identity.
"""
import hashlib
from pathlib import Path
import numpy as np
from PIL import Image
from glb_output import append_texture

from workspace_paths import workspace_root
ROOT=workspace_root(__file__)
ASSET=ROOT/'highquality/references/makehuman-eyes/blue_eye.png'
# Reviewed upper-right eye in MakeHuman's two-eye atlas, in source pixels.
CENTER=np.array([723.,304.])
IRIS_RADIUS=120.

def optical_uv(points,iris_radius):
    return (CENTER+points[:,:2]*np.array([1,-1])*IRIS_RADIUS/iris_radius)/1024.

def build_texture(doc,data,out,pigment):
    original=np.asarray(Image.open(ASSET).convert('RGB'),dtype=np.float32)/255
    linear=np.where(original<=.04045,original/12.92,((original+.055)/1.055)**2.4)
    yy,xx=np.indices(original.shape[:2]);radius=np.hypot(xx-CENTER[0],yy-CENTER[1])/IRIS_RADIUS
    # Preserve the source fiber contrast while changing the artist-selected pigment.
    luminance=linear@np.array([.2126,.7152,.0722])
    band=(radius>.35)&(radius<.88)
    detail=np.clip(luminance/max(float(np.mean(luminance[band])),1e-5),.025,3)
    iris=np.asarray(pigment)[None,None,:]*detail[:,:,None]
    coverage=np.clip((1.025-radius)/.055,0,1)
    linear=linear*(1-coverage[:,:,None])+iris*coverage[:,:,None]
    encoded=np.where(linear<=.0031308,linear*12.92,1.055*np.maximum(linear,0)**(1/2.4)-.055)
    texture=append_texture(doc,data,np.clip(encoded*255,0,255),'makehuman-eye-pigment',out)
    return texture,{'source':str(ASSET.relative_to(ROOT)),'sha256':hashlib.sha256(ASSET.read_bytes()).hexdigest(),'license':'CC0-1.0','upstream':'https://github.com/makehumancommunity/mpfb-eye-model-v2','adaptation':'Reviewed planar UV registration; authored iris pigment with source fiber contrast; source sclera retained'}
