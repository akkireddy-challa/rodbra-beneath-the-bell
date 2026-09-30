"""Clip a source surface against a vision-authored convex ocular contour.

Interpolates original attributes at intersections. It never infers an eye boundary.
"""
import numpy as np
from glb_arrays import accessor
from glb_output import append_accessor

def half_polygon(weights,distances,inside):
    output=[]
    for i,a in enumerate(weights):
        b=weights[(i+1)%len(weights)];da=distances[i];db=distances[(i+1)%len(weights)];ia=da>=0 if inside else da<0;ib=db>=0 if inside else db<0
        if ia:output.append(a)
        if ia!=ib:output.append(a+(b-a)*(da/(da-db)))
    return np.asarray(output)

def subtract_convex(triangle,contour):
    remaining=np.eye(3);outside=[]
    for a,b in zip(contour,np.roll(contour,-1,axis=0)):
        if len(remaining)<3:break
        points=remaining@triangle;edge=b-a;distances=edge[0]*(points[:,1]-a[1])-edge[1]*(points[:,0]-a[0])
        piece=half_polygon(remaining,distances,False)
        if len(piece)>=3:outside.append(piece)
        remaining=half_polygon(remaining,distances,True)
    return outside

def cut_openings(doc,data,world,openings):
    primitives=doc['meshes'][0]['primitives'];pool={}
    for prim in primitives:
        for name,index in prim['attributes'].items():
            arr=accessor(doc,data,index)
            if name in pool and not np.array_equal(pool[name],arr):raise ValueError('Shared opening adapter requires matching attribute arrays across material partitions')
            pool[name]=arr
    additions={name:[] for name in pool};next_index=len(world);changed=0;removed=0
    for prim in primitives:
        indices=accessor(doc,data,prim['indices']).reshape(-1,3);keep=np.ones(len(indices),bool);fresh=[]
        for opening in openings:
            xy=opening['pixels'];contour=np.asarray(opening.get('cutContour',opening['contour']),float)
            if np.sum(contour[:,0]*np.roll(contour[:,1],-1)-contour[:,1]*np.roll(contour[:,0],-1))<0:contour=contour[::-1]
            edges=np.roll(contour,-1,axis=0)-contour
            if np.any(edges[:,0]*np.roll(edges[:,1],-1)-edges[:,1]*np.roll(edges[:,0],-1)<-1e-6):raise ValueError('Ocular contour must be convex; split nonconvex contours explicitly')
            lo=contour.min(0);hi=contour.max(0);tri_xy=xy[indices]
            candidate=keep&(tri_xy.min(1)<=hi).all(1)&(tri_xy.max(1)>=lo).all(1)&(np.linalg.norm(world[indices].mean(1)-opening['surfaceHit'],axis=1)<opening.get('cutRadius',opening['radius']*1.8))
            for ti in np.flatnonzero(candidate):
                ids=indices[ti];pieces=subtract_convex(tri_xy[ti],contour);keep[ti]=False;changed+=1
                if not pieces:removed+=1
                for weights in pieces:
                    for k in range(1,len(weights)-1):
                        w=weights[[0,k,k+1]]
                        for name,arr in pool.items():
                            value=w@arr[ids]
                            if name=='NORMAL':value/=np.maximum(np.linalg.norm(value,axis=1,keepdims=True),1e-12)
                            additions[name].extend(value)
                        fresh.append([next_index,next_index+1,next_index+2]);next_index+=3
        combined=np.concatenate([indices[keep],np.asarray(fresh,dtype=np.uint32).reshape(-1,3)])
        prim['indices']=append_accessor(doc,data,combined.astype('<u4').reshape(-1),'SCALAR',5125)
    attributes={}
    for name,arr in pool.items():
        combined=np.concatenate([arr,np.asarray(additions[name]).reshape(-1,arr.shape[1])]);kind={1:'SCALAR',2:'VEC2',3:'VEC3',4:'VEC4'}[arr.shape[1]]
        if np.issubdtype(arr.dtype,np.integer):raise ValueError('Rigged eye clipping needs discrete joint-index interpolation; source adapter is unskinned only')
        attributes[name]=append_accessor(doc,data,combined.astype('<f4'),kind,5126)
    for prim in primitives:
        prim['attributes']={name:attributes[name] for name in prim['attributes']}
    return {'intersectedTriangles':changed,'removedInteriorTriangles':removed,'newIntersectionVertices':next_index-len(world),'method':'exact convex-contour clipping with barycentric attribute interpolation'}


def refine_authored_contours(eye):
    """Round convex landmark chains while retaining the two authored canthi.

    Quadratic corner arcs stay inside the original convex selection. This is
    geometric interpolation of reviewed anatomy, never a new eye detector.
    """
    import copy
    if not eye.get('contourRefinement'):return eye
    result=copy.deepcopy(eye);options=result.pop('contourRefinement')
    samples=options.get('samplesPerLandmark',8)
    if options.get('method')!='convex-quadratic-v1' or not isinstance(samples,int) or samples<4 or samples>16 or samples%2:
        raise ValueError('Invalid authored contour refinement')
    original=np.asarray(eye['openingPx'],float);count=len(original)
    upper=eye['upperContourIndices'];lower=eye['lowerContourIndices']
    corners=set([upper[0],upper[-1]])
    if len(corners)!=2 or corners!=set([lower[0],lower[-1]]):raise ValueError('Upper and lower chains must share two authored eye corners')
    outer_method=options.get('outerBoundary','rounded')
    if outer_method not in ['rounded','preserve-authored']:raise ValueError('Unsupported outer contour refinement')
    def rounded(points,preserve_all=False):
        points=np.asarray(points,float)
        if points.shape!=(count,2) or not np.isfinite(points).all():raise ValueError('Paired valid contour landmarks required')
        output=[]
        for i,p in enumerate(points):
            entry=(points[(i-1)%count]+p)*.5;exit=(p+points[(i+1)%count])*.5
            for t in np.arange(samples)/samples:
                if preserve_all or i in corners:value=entry+(p-entry)*t*2 if t<=.5 else p+(exit-p)*(2*t-1)
                else:value=(1-t)**2*entry+2*t*(1-t)*p+t*t*exit
                output.append(value)
        output=np.asarray(output);edge=np.roll(output,-1,axis=0)-output
        turn=edge[:,0]*np.roll(edge[:,1],-1)-edge[:,1]*np.roll(edge[:,0],-1)
        if np.any(turn>1e-6) and np.any(turn<-1e-6):raise ValueError('Refined eye contour is nonconvex; review authored landmarks')
        return output.tolist()
    midpoint=lambda i:int(i*samples+samples//2)
    def chain(indices):
        differences=np.diff(indices)%count
        if np.all(differences==1):step=1
        elif np.all(differences==count-1):step=-1
        else:raise ValueError('Contour chains must follow consecutive authored landmarks')
        start=midpoint(indices[0]);length=len(indices)-1
        return [(start+step*i)%(count*samples) for i in range(length*samples+1)]
    result['openingPx']=rounded(original)
    if 'outerLidPx' in result:result['outerLidPx']=rounded(eye['outerLidPx'],outer_method=='preserve-authored')
    for name in ['upperContourIndices','lowerContourIndices']:result[name]=chain(eye[name])
    for wall in result.get('canthusWalls',[]):wall['contourIndices']=chain(wall['contourIndices'])
    if result.get('caruncle'):result['caruncle']['innerContourIndex']=midpoint(result['caruncle']['innerContourIndex'])
    result['contourRefinementApplied']={'method':'convex-quadratic-v1','samplesPerLandmark':samples,'authoredOpeningPx':eye['openingPx'],'authoredOuterLidPx':eye.get('outerLidPx'),'authoredCanthusIndices':sorted(corners),'maximumInsetPx':float(np.max(np.linalg.norm(np.asarray(result['openingPx'])[np.arange(count)*samples+samples//2]-original,axis=1)))}
    result['contourRefinementApplied']['outerBoundary']=outer_method
    return result
