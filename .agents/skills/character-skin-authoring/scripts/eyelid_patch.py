"""Reconstruct a lid band between two explicitly authored ocular contours."""
import numpy as np
from eyelid_morph import conform_open_lid,surface_normals,surface_normal_groups

def authored_corner_support(hit,plane,opening):
    """Apply an explicitly reviewed corner depth, fading to source support."""
    result=np.asarray(hit,float).copy();forward=-opening['direction']
    pixel=np.array([((plane-opening['target'])@opening['right']/opening['span']+.5)*opening['size'],(.5-(plane-opening['target'])@opening['up']/opening['span'])*opening['size']])
    for patch in opening.get('cornerDepths',[]):
        radius=patch['radiusM']*opening['unit']/opening['span']*opening['size']
        if radius<=0 or not np.isfinite([radius,patch['depthM']]).all():raise ValueError('Invalid authored corner depth')
        t=np.clip(1-np.linalg.norm(pixel-np.asarray(patch['pixel']))/radius,0,1);weight=t*t*(3-2*t)
        result+=forward*((patch['depthM']*opening['unit']-(result-opening['center'])@forward)*weight)
    return result

def lid_contact_depth(radial_distance,radius,globe_depth,source_depth):
    """Beyond the sphere, retain authored face support instead of collapsing to zero."""
    t=np.clip((radial_distance/radius-.85)/.15,0,1)
    t=t*t*(3-2*t)
    return globe_depth+t*np.maximum(0,source_depth-globe_depth)

def corner_contact_depth(radial,globe,source,plane,o):
    depth=lid_contact_depth(radial,o['radius'],globe,source)
    for patch in o.get('cornerDepths',[]):
        pixel=np.asarray(patch['pixel']);corner=o['target']+o['right']*(pixel[0]/o['size']-.5)*o['span']+o['up']*(.5-pixel[1]/o['size'])*o['span']
        rel=corner-o['center'];end=np.linalg.norm(rel-(rel@o['direction'])*o['direction']);start=.85*o['radius']
        if end<=start:raise ValueError('Authored corner must lie outside the inner globe support')
        axis=rel-(rel@o['direction'])*o['direction'];axis/=end
        lateral=plane-o['center'];lateral-=((lateral@o['direction'])*o['direction'])
        distance=np.linalg.norm(lateral-(lateral@axis)*axis)
        width=patch['radiusM']*o['unit']
        w=np.clip((width-distance)/(width*.5),0,1);w=w*w*(3-2*w)
        if lateral@axis<=0:w=0
        if radial>start and w>0:
            t=np.clip((radial-start)/(end-start),0,1);z=np.sqrt(o['radius']**2-start**2);slope=-start/z
            curve=(2*t**3-3*t*t+1)*z+(t**3-2*t*t+t)*slope*(end-start)+(-2*t**3+3*t*t)*patch['depthM']*o['unit']
            # Preserve the globe clearance and blend away from the authored corner.
            depth=max(globe,depth*(1-w)+curve*w)
    return depth

def sample_paired_contours(inner,outer,projected_triangles=None):
    """Preserve source-edge breakpoints on the reconstructed band's outer rim."""
    inner=np.asarray(inner,float);outer=np.asarray(outer,float);inside=[];outside=[]
    if projected_triangles is not None:
        a=projected_triangles.reshape(-1,2)
        b=np.roll(projected_triangles,-1,axis=1).reshape(-1,2);edge=b-a
    for i,p in enumerate(outer):
        q=outer[(i+1)%len(outer)];d=q-p;ts=list(np.arange(8)/8)
        if projected_triangles is not None:
            offset=a-p;den=d[0]*edge[:,1]-d[1]*edge[:,0];valid=abs(den)>1e-12
            safe=np.where(valid,den,1)
            t=(offset[:,0]*edge[:,1]-offset[:,1]*edge[:,0])/safe
            u=(offset[:,0]*d[1]-offset[:,1]*d[0])/safe
            valid&=(t>0)&(t<1)&(u>=-1e-10)&(u<=1+1e-10)
            ts.extend(t[valid])
            collinear=(~(abs(den)>1e-12))&(abs(offset[:,0]*d[1]-offset[:,1]*d[0])<1e-10)
            for endpoints in [a[collinear],b[collinear]]:
                along=(endpoints-p)@d/np.dot(d,d);ts.extend(along[(along>0)&(along<1)])
        t=np.unique(np.round(ts,12));t=t[t<1]
        outside.extend(p[None,:]*(1-t[:,None])+q[None,:]*t[:,None])
        inside.extend(inner[i][None,:]*(1-t[:,None])+inner[(i+1)%len(inner)][None,:]*t[:,None])
    return np.asarray(inside),np.asarray(outside)

def sample_hit(origin,direction,points,triangles,uv,rgb,normals):
    a=points[triangles[:,0]];e1=points[triangles[:,1]]-a;e2=points[triangles[:,2]]-a
    h=np.cross(direction,e2);det=(e1*h).sum(1);safe=np.where(abs(det)>1e-12,det,1)
    s=origin-a;u=(s*h).sum(1)/safe;q=np.cross(s,e1);v=(q*direction).sum(1)/safe;t=(e2*q).sum(1)/safe
    valid=(abs(det)>1e-12)&(u>=0)&(v>=0)&(u+v<=1)&(t>0)
    if not valid.any():raise ValueError('Authored outer lid contour misses the source surface')
    index=np.argmin(np.where(valid,t,np.inf));tex=np.array([1-u[index]-v[index],u[index],v[index]])@uv[triangles[index]]
    x=np.clip(tex[0]*rgb.shape[1]-.5,0,rgb.shape[1]-1);y=np.clip(tex[1]*rgb.shape[0]-.5,0,rgb.shape[0]-1)
    ix,iy=int(x),int(y);jx,jy=min(ix+1,rgb.shape[1]-1),min(iy+1,rgb.shape[0]-1)
    c=(rgb[iy,ix]*(1-(x-ix))+rgb[iy,jx]*(x-ix))*(1-(y-iy))+(rgb[jy,ix]*(1-(x-ix))+rgb[jy,jx]*(x-ix))*(y-iy)
    c=c/255;c=np.where(c<=.04045,c/12.92,((c+.055)/1.055)**2.4)
    normal=np.array([1-u[index]-v[index],u[index],v[index]])@normals[triangles[index]]
    normal/=max(np.linalg.norm(normal),1e-12)
    return origin+direction*t[index],c,normal

def fair_lid_depth(vertices,faces,forward,boundary):
    """Harmonic depth fairing on the projected mesh, with both rims fixed."""
    from scipy.sparse import coo_matrix,diags
    from scipy.sparse.linalg import spsolve
    vertices=np.asarray(vertices);depth=vertices@forward
    xy=vertices-depth[:,None]*forward
    edges=np.unique(np.sort(np.concatenate([faces[:,[0,1]],faces[:,[1,2]],faces[:,[2,0]]]),axis=1),axis=0)
    length=np.linalg.norm(xy[edges[:,0]]-xy[edges[:,1]],axis=1)
    weight=1/np.maximum(length,1e-10)
    row=np.r_[edges[:,0],edges[:,1]];col=np.r_[edges[:,1],edges[:,0]]
    adjacency=coo_matrix((np.r_[weight,weight],(row,col)),shape=(len(vertices),len(vertices))).tocsr()
    lap=diags(np.asarray(adjacency.sum(1)).ravel())-adjacency
    free=np.flatnonzero(~boundary);fixed=np.flatnonzero(boundary)
    fitted=depth.copy();fitted[free]=spsolve(lap[free][:,free],-lap[free][:,fixed]@depth[fixed])
    result=vertices+(fitted-depth)[:,None]*forward;result[boundary]=vertices[boundary]
    return result

def build_lid_band(o,outer,points,triangles,uv,rgb,inverse,origin_basis,source_normals=None,skin_samples=None,outer_edge_sampling=None,depth_fairing=False):
    inner=np.asarray(o['contour'],float);outer=np.asarray(outer,float)
    if outer.shape!=inner.shape:raise ValueError('Lid contours need paired authored vertices')
    area=np.sum(outer[:,0]*np.roll(outer[:,1],-1)-outer[:,1]*np.roll(outer[:,0],-1))
    sign=1 if area>0 else -1
    for a,b in zip(outer,np.roll(outer,-1,axis=0)):
        edge=b-a
        if np.any(sign*(edge[0]*(inner[:,1]-a[1])-edge[1]*(inner[:,0]-a[0]))<0):raise ValueError('Outer lid contour must contain the optical aperture')
    direction=o['direction'];forward=-direction;right=o['right'];up=o['up'];target=o['target'];span=o['span'];size=o['size']
    projection=np.stack([((points-target)@right/span+.5)*size,(.5-(points-target)@up/span)*size],1)
    lo=outer.min(0)-1;hi=outer.max(0)+1;projected=projection[triangles]
    candidates=(projected.min(1)<=hi).all(1)&(projected.max(1)>=lo).all(1)
    candidates&=np.linalg.norm(points[triangles].mean(1)-o['center'],axis=1)<o['radius']*3
    local_triangles=triangles[candidates]
    if not len(local_triangles):raise ValueError('No source triangles behind authored lid band')
    if outer_edge_sampling not in [None,'source-intersections-v1']:raise ValueError('Unsupported lid boundary sampling')
    if source_normals is None:source_normals=surface_normals(points,triangles,surface_normal_groups(points))
    inner,outer=sample_paired_contours(inner,outer,projection[local_triangles] if outer_edge_sampling else None)
    edge_points=[];edge_colors=[];edge_normals=[];inside=[]
    ray_offset=np.ptp(points,axis=0).max()*2
    for p,q in zip(inner,outer):
        plane=target+right*((q[0]/size)-.5)*span+up*(.5-q[1]/size)*span
        hit,color,normal=sample_hit(plane-direction*ray_offset,direction,points,local_triangles,uv,rgb,source_normals)
        edge_points.append(hit);edge_colors.append(color);edge_normals.append(normal)
        plane=target+right*(p[0]/size-.5)*span+up*(.5-p[1]/size)*span
        xy=np.array([(plane-o['center'])@right,(plane-o['center'])@up]);r=np.linalg.norm(xy)
        depth=np.sqrt(max(0,o['radius']**2-r*r))
        if r<o['iris']:depth=np.sqrt(o['radius']**2-o['iris']**2)+o['bulge']*max(0,1-(r/o['iris'])**2)
        # Canthus support belongs to the aperture point, not the outer band's
        # cheek/upper-fold sample. Reusing the latter pulls the inner corner
        # toward a different facial depth and creates a visible ramp.
        support_hit=hit
        if r>o['radius']*.85:
            support_hit,_,_=sample_hit(plane-direction*ray_offset,direction,points,local_triangles,uv,rgb,source_normals)
            support_hit=authored_corner_support(support_hit,plane,o)
        depth=corner_contact_depth(r,depth,(support_hit-o['center'])@forward,plane,o)
        inside.append(o['center']+right*xy[0]+up*xy[1]+forward*(depth+.00025*o['unit']))
    edge_points=np.asarray(edge_points);inside=np.asarray(inside);edge_colors=np.asarray(edge_colors);edge_normals=np.asarray(edge_normals)
    inner_colors=edge_colors.copy()
    if skin_samples is not None:
        samples=np.asarray(skin_samples,float)
        if samples.ndim!=2 or samples.shape[1]!=2 or len(samples)<3 or not np.isfinite(samples).all():
            raise ValueError('Reconstructed lid skin requires at least three explicit valid donor pixels')
        donors=[];donor_colors=[]
        for q in samples:
            plane=target+right*((q[0]+.5)/size-.5)*span+up*(.5-(q[1]+.5)/size)*span
            hit,color,_=sample_hit(plane-direction*ray_offset,direction,points,triangles,uv,rgb,source_normals)
            donors.append(hit);donor_colors.append(color)
        distances=np.linalg.norm(inside[:,None,:]-np.asarray(donors)[None,:,:],axis=2)
        weights=1/np.maximum(distances,1e-8)**2;weights/=weights.sum(1,keepdims=True)
        inner_colors=weights@np.asarray(donor_colors)
    chord=inside-edge_points
    inner_normals=inside-o['center'];inner_normals/=np.maximum(np.linalg.norm(inner_normals,axis=1,keepdims=True),1e-12)
    outer_tangent=chord-edge_normals*(chord*edge_normals).sum(1)[:,None]
    inner_tangent=chord-inner_normals*(chord*inner_normals).sum(1)[:,None]
    vertices=[];colors=[];faces=[];count=len(inner);rings=9
    for row,t in enumerate(np.linspace(0,1,rings)):
        # Outer boundary stays on the sampled source. The inner boundary follows
        # the optical envelope. Existing source eye paint is not resampled inside.
        vertices.extend((2*t**3-3*t*t+1)*edge_points+(t**3-2*t*t+t)*outer_tangent+(-2*t**3+3*t*t)*inside+(t**3-t*t)*inner_tangent);blend=t*t*(3-2*t);colors.extend(edge_colors*(1-blend)+inner_colors*blend)
        if row:
            for j in range(count):
                a=(row-1)*count+j;b=(row-1)*count+(j+1)%count;faces.extend([[a,b,a+count],[b,b+count,a+count]])
    world=np.asarray(vertices);faces=np.asarray(faces)
    if depth_fairing:
        # Hermite tangents can also bunch the projected columns at the canthi.
        # Use the paired contours' straight projected strips for the solve.
        linear=np.concatenate([edge_points*(1-t)+inside*t for t in np.linspace(0,1,rings)])
        world=linear+((world-linear)@forward)[:,None]*forward
        boundary=np.zeros(len(world),bool);boundary[:count]=True;boundary[-count:]=True
        world=fair_lid_depth(world,faces,forward,boundary)
    world,_=conform_open_lid(world,o);local=(world-origin_basis)@inverse.T
    cross=np.cross(local[faces[:,1]]-local[faces[:,0]],local[faces[:,2]]-local[faces[:,0]])
    if np.mean(cross@(inverse@forward))<0:faces=faces[:,::-1]
    normals=surface_normals(local,faces,surface_normal_groups(local))
    outer_local_normals=edge_normals@np.linalg.inv(inverse);outer_local_normals/=np.maximum(np.linalg.norm(outer_local_normals,axis=1,keepdims=True),1e-12)
    normals[:count]=outer_local_normals
    return local,normals,np.asarray(colors),faces
