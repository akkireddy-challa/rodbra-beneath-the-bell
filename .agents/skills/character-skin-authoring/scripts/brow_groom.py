"""Short strand groom from explicit image-space brow polygons and comb guides.

Sampling places designed fibers inside authored regions; it does not recognize hair.
"""
import numpy as np


def inside_polygon(points, polygon):
    polygon=np.asarray(polygon,float);inside=np.zeros(len(points),bool)
    for a,b in zip(polygon,np.roll(polygon,-1,axis=0)):
        if abs(b[1]-a[1])<1e-12:continue
        inside^=((a[1]>points[:,1])!=(b[1]>points[:,1]))&(points[:,0]<(b[0]-a[0])*(points[:,1]-a[1])/(b[1]-a[1])+a[0])
    return inside


def build_brow(profile,points,triangles,normals,target,right,up,direction,span,size,unit,inverse,origin):
    polygon=np.asarray(profile['polygonPx'],float);guides=np.asarray(profile['combGuidesPx'],float)
    if polygon.ndim!=2 or polygon.shape[1]!=2 or len(polygon)<3 or not np.isfinite(polygon).all():raise ValueError('Brow needs an explicit finite polygon')
    if guides.ndim!=3 or guides.shape[1:]!=(2,2) or len(guides)<2 or not np.isfinite(guides).all():raise ValueError('Brow needs at least two explicit comb guides')
    vectors=guides[:,1]-guides[:,0];lengths=np.linalg.norm(vectors,axis=1)
    if np.any(lengths<1e-6):raise ValueError('Brow comb guides must have a direction')
    vectors/=lengths[:,None]
    pigment=np.asarray(profile['colorLinear'],float)
    if pigment.shape!=(3,) or not np.isfinite(pigment).all() or np.any(pigment<0) or np.any(pigment>1):raise ValueError('Brow pigment must be finite linear RGB')
    count=int(profile['strandCount']);radii=float(profile['radiusM'])*unit
    low,high=np.asarray(profile['lengthRangeM'],float)*unit
    if not 1<=count<=1000 or not 0<radii<.0001*unit or not 0<low<=high<.015*unit:raise ValueError('Invalid authored brow fiber dimensions')
    rng=np.random.default_rng(profile['seed']);roots=[]
    for batch in range(100):
        candidates=rng.uniform(polygon.min(0),polygon.max(0),size=(count*4,2))
        roots.extend(candidates[inside_polygon(candidates,polygon)])
        if len(roots)>=count:break
    if len(roots)<count:raise ValueError('Brow polygon has insufficient area')
    roots=np.asarray(roots[:count])
    projected=np.stack([((points-target)@right/span+.5)*size,(.5-(points-target)@up/span)*size],1)
    bounds=projected[triangles];selected=np.all(bounds.max(1)>=polygon.min(0)-1,axis=1)&np.all(bounds.min(1)<=polygon.max(0)+1,axis=1)
    triangles=triangles[selected];a=points[triangles[:,0]];e1=points[triangles[:,1]]-a;e2=points[triangles[:,2]]-a
    h=np.cross(direction,e2);det=(e1*h).sum(1);safe=np.where(abs(det)>1e-12,det,1)
    vertices=[];vertex_normals=[];faces=[];color=[]
    for pixel in roots:
        ray=target+right*((pixel[0]+.5)/size-.5)*span+up*(.5-(pixel[1]+.5)/size)*span-direction*span*4
        s=ray-a;u=(s*h).sum(1)/safe;q=np.cross(s,e1);v=(q*direction).sum(1)/safe;t=(e2*q).sum(1)/safe
        valid=(abs(det)>1e-12)&(u>=0)&(v>=0)&(u+v<=1)&(t>0)
        if not valid.any():raise ValueError('Authored brow root misses visible source geometry')
        face=int(np.argmin(np.where(valid,t,np.inf)));root=ray+direction*t[face]
        normal=normals[triangles[face]].T@np.array([1-u[face]-v[face],u[face],v[face]]);normal/=np.linalg.norm(normal)
        weights=1/np.maximum(np.sum((guides[:,0]-pixel)**2,axis=1),9);comb=weights@vectors/weights.sum()
        tangent=right*comb[0]-up*comb[1];tangent-=normal*np.dot(normal,tangent);tangent/=np.linalg.norm(tangent)
        length=rng.uniform(low,high);curve=[]
        for fraction in np.linspace(0,1,8):
            curve.append(root+tangent*length*fraction+normal*unit*(.00004+.00018*np.sin(np.pi*fraction)+.00008*fraction))
        curve=np.asarray(curve);along=np.gradient(curve,axis=0);along/=np.linalg.norm(along,axis=1,keepdims=True)
        side=np.cross(along,normal);side/=np.linalg.norm(side,axis=1,keepdims=True);other=np.cross(along,side)
        angle=np.arange(5)*2*np.pi/5;tube_normals=side[:,None,:]*np.cos(angle)[None,:,None]+other[:,None,:]*np.sin(angle)[None,:,None]
        tube=curve[:,None,:]+tube_normals*radii*np.linspace(1,.05,8)[:,None,None];start=len(vertices)
        vertices.extend((tube.reshape(-1,3)-origin)@inverse.T)
        transformed=tube_normals.reshape(-1,3)@np.linalg.inv(inverse);transformed/=np.linalg.norm(transformed,axis=1,keepdims=True);vertex_normals.extend(transformed)
        shade=np.clip(pigment*rng.uniform(.8,1.2),0,1);color.extend(np.broadcast_to(shade,(40,3)))
        for row in range(7):
            for k in range(5):
                i=start+row*5+k;j=start+row*5+(k+1)%5;faces.extend([[i,j,i+5],[j,j+5,i+5]])
    return np.asarray(vertices),np.asarray(vertex_normals),np.asarray(color),np.asarray(faces)
