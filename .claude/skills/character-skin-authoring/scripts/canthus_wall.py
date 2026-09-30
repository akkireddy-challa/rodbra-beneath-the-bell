"""Designed lining between an explicitly authored canthus and the globe."""
import numpy as np
from eyelid_morph import conform_open_lid,surface_normals,surface_normal_groups
from eyelid_patch import lid_contact_depth,corner_contact_depth

def lining_depth_at_radius(radial,corner_radial,source_depth,radius,iris,unit,reconstructed=True):
    """Depth on the authored corner lining, for tissue supported by that lining."""
    swept=iris*np.cos(.35)+np.sqrt(radius*radius-iris*iris)*np.sin(.35)
    inner=max(radius*.88,swept+.00035*unit)
    if inner>=radius or not inner<=radial<=corner_radial or corner_radial<=inner:
        raise ValueError('Authored corner tissue lies outside its lining support')
    globe=np.sqrt(max(0,radius*radius-corner_radial*corner_radial))
    if reconstructed:boundary=float(lid_contact_depth(corner_radial,radius,globe,source_depth))+.00025*unit
    else:boundary=max(source_depth,globe+.00025*unit) if corner_radial<radius and source_depth>0 else source_depth
    inner_depth=np.sqrt(radius*radius-inner*inner)-.00035*unit
    t=(radial-inner)/(corner_radial-inner)
    return inner_depth*(1-t)+(boundary-.0003*unit)*t


def build_canthus_wall(profile,opening,sample_surface,inverse,origin):
    contour=np.asarray(opening['contour']);indices=profile['contourIndices']
    if len(indices)<3:raise ValueError('A corner wall needs upper, corner and lower landmarks')
    path=contour[indices];pixels=np.concatenate([a[None,:]*(1-np.arange(12)[:,None]/12)+b[None,:]*(np.arange(12)[:,None]/12) for a,b in zip(path[:-1],path[1:])]+[path[-1:]])
    right=opening['right'];up=opening['up'];forward=-opening['direction'];center=opening['center'];radius=opening['radius'];unit=opening['unit']
    plane=opening['target']+right[None,:]*((pixels[:,0]/opening['size']-.5)*opening['span'])[:,None]+up[None,:]*((.5-pixels[:,1]/opening['size'])*opening['span'])[:,None]
    xy=np.stack([(plane-center)@right,(plane-center)@up],1);rad=np.linalg.norm(xy,axis=1)
    swept_iris=opening['iris']*np.cos(.35)+np.sqrt(radius*radius-opening['iris']**2)*np.sin(.35)
    inner_radius=max(radius*.88,swept_iris+.00035*unit)
    if inner_radius>=radius:raise ValueError('Authored optical dimensions leave no lining clearance for the reviewed gaze range')
    active=np.flatnonzero(rad>inner_radius)
    if len(active)<3 or np.any(np.diff(active)!=1):raise ValueError('Reviewed corner must form one contiguous lining outside the globe center')
    plane=plane[active];xy=xy[active];rad=rad[active]
    boundary=np.asarray([sample_surface(p) for p in plane])
    if profile.get('contactMethod') == 'reconstructed-lid-v1':
        # Use precisely the reconstructed aperture's depth, rather than the
        # old source eye surface, which is removed by the lid-band exporter.
        source_depth=(boundary-center)@forward
        globe_depth=np.sqrt(np.maximum(0,radius*radius-rad*rad))
        depth=np.array([corner_contact_depth(r,g,s,p,opening) for r,g,s,p in zip(rad,globe_depth,source_depth,plane)])+.00025*unit
        boundary=center+xy[:,0,None]*right+xy[:,1,None]*up+depth[:,None]*forward
    elif profile.get('contactMethod') is not None:
        raise ValueError('Unsupported canthus contact method')
    boundary,_=conform_open_lid(boundary,opening)
    inner_xy=xy*(inner_radius/rad)[:,None];inner=center+inner_xy[:,0,None]*right+inner_xy[:,1,None]*up+forward*(np.sqrt(radius*radius-inner_radius*inner_radius)-.00035*unit)
    rows=7;vertices=[];roots=[];weights=[];faces=[];count=len(boundary)
    for row,t in enumerate(np.linspace(0,1,rows)):
        # The near-lid edge shares its support point with the source lid, but is
        # slightly recessed. The far edge remains behind the globe during blink.
        vertices.extend(inner*(1-t)+(boundary-forward*.0003*unit)*t)
        roots.extend(boundary);weights.extend(np.full(count,t))
        if row:
            for j in range(count-1):
                a=(row-1)*count+j;b=a+1;faces.extend([[a,b,a+count],[b,b+count,a+count]])
    vertices=(np.asarray(vertices)-origin)@inverse.T;faces=np.asarray(faces)
    normals=surface_normals(vertices,faces,surface_normal_groups(vertices))
    colors=np.broadcast_to(profile['colorLinear'],vertices.shape).copy()
    return (vertices,normals,colors,faces),(np.asarray(roots)-origin)@inverse.T,np.asarray(weights)
