"""Offline front-face atlas rasterization and landmark correspondence.

Coordinates are authoring space, not guesses made by the renderer. Rasterization
keeps the closest triangle and its interpolated attributes, including UV seams.
"""
import numpy as np
from scipy.ndimage import map_coordinates
from scipy.spatial import Delaunay
from scipy.interpolate import RBFInterpolator


def rasterize(points, triangles, values, bounds, size=1024):
    lo=np.asarray(bounds[:2]);hi=np.asarray(bounds[2:])
    xy=(points[:,:2]-lo)/(hi-lo)*(size-1)
    image=np.zeros((size,size,values.shape[1]),np.float32)
    depth=np.full((size,size),-np.inf,np.float32)
    for ids in triangles:
        t=xy[ids];d=points[ids,2]
        if not np.isfinite(t).all():continue
        xmin,ymin=np.maximum(np.floor(t.min(0)).astype(int),0)
        xmax,ymax=np.minimum(np.ceil(t.max(0)).astype(int),size-1)
        if xmax<xmin or ymax<ymin:continue
        den=(t[1,1]-t[2,1])*(t[0,0]-t[2,0])+(t[2,0]-t[1,0])*(t[0,1]-t[2,1])
        if abs(den)<1.e-8:continue
        yy,xx=np.mgrid[ymin:ymax+1,xmin:xmax+1]
        a=((t[1,1]-t[2,1])*(xx-t[2,0])+(t[2,0]-t[1,0])*(yy-t[2,1]))/den
        b=((t[2,1]-t[0,1])*(xx-t[2,0])+(t[0,0]-t[2,0])*(yy-t[2,1]))/den
        c=1-a-b;z=a*d[0]+b*d[1]+c*d[2]
        dst=depth[ymin:ymax+1,xmin:xmax+1]
        mask=(a>=-1.e-5)&(b>=-1.e-5)&(c>=-1.e-5)&(z>dst)
        dst[mask]=z[mask]
        field=image[ymin:ymax+1,xmin:xmax+1]
        field[mask]=(a[...,None]*values[ids[0]]+b[...,None]*values[ids[1]]+c[...,None]*values[ids[2]])[mask]
    return image,np.isfinite(depth)


def sample(image,uv):
    coords=np.array([uv[...,1]*(image.shape[0]-1),uv[...,0]*(image.shape[1]-1)])
    if image.ndim==2:return map_coordinates(image,coords,order=1,mode='nearest')
    return np.stack([map_coordinates(image[:,:,i],coords,order=1,mode='nearest') for i in range(image.shape[2])],axis=-1)


def register(points,target_landmarks,source_landmarks):
    """Smooth thin-plate anatomical correspondence; rejects points outside the hull."""
    tri=Delaunay(target_landmarks);ids=tri.find_simplex(points)
    landmarks=np.asarray(target_landmarks)
    center=landmarks.mean(0);scale=np.ptp(landmarks,axis=0)
    # Smooth first derivatives avoid shading seams at affine triangle boundaries.
    warp=RBFInterpolator((landmarks-center)/scale,np.asarray(source_landmarks),kernel='thin_plate_spline',smoothing=0.0001)
    mapped=np.concatenate([warp((chunk-center)/scale) for chunk in np.array_split(points,64)])
    return mapped,ids>=0
