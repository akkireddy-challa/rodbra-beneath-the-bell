"""Rest-space eyelid closure from authored ocular contours; eyeballs never scale."""
import numpy as np
from scipy.spatial.transform import Rotation
from glb_arrays import accessor
from glb_output import append_accessor
from vision_materials import source_world_points

def surface_normal_groups(rest):
    """Weld geometric duplicates for deformation normals, retaining every UV vertex."""
    tolerance=max(float(np.ptp(rest,axis=0).max())*1e-8,1e-12)
    return np.unique(np.round(rest/tolerance).astype(np.int64),axis=0,return_inverse=True)[1]

def surface_normals(vertices,faces,groups):
    face=np.cross(vertices[faces[:,1]]-vertices[faces[:,0]],vertices[faces[:,2]]-vertices[faces[:,0]])
    summed=np.zeros((int(groups.max())+1,3),dtype=np.float64)
    for k in range(3):np.add.at(summed,groups[faces[:,k]],face)
    summed/=np.maximum(np.linalg.norm(summed,axis=1,keepdims=True),1e-12)
    return summed[groups]

def transport_normals(original,rest,deformed):
    """Rotate authored normals with the geometric frame instead of adding vectors."""
    result=np.asarray(original,dtype=float).copy()
    valid=(np.linalg.norm(rest,axis=1)>1e-8)&(np.linalg.norm(deformed,axis=1)>1e-8)
    a=rest[valid]/np.linalg.norm(rest[valid],axis=1,keepdims=True)
    b=deformed[valid]/np.linalg.norm(deformed[valid],axis=1,keepdims=True)
    n=result[valid];cosine=np.clip((a*b).sum(1),-1,1);axis=np.cross(a,b)
    regular=cosine>-1+1e-8
    v=axis[regular];x=n[regular]
    n[regular]=x+np.cross(v,x)+np.cross(v,np.cross(v,x))/(1+cosine[regular,None])
    if (~regular).any():
        # The shortest rotation is ambiguous at 180 degrees; select a stable
        # perpendicular axis, retaining unit length and the geometric endpoint.
        old=a[~regular];basis=np.eye(3)[np.argmin(abs(old),axis=1)]
        v=np.cross(old,basis);v/=np.linalg.norm(v,axis=1,keepdims=True)
        x=n[~regular];n[~regular]=2*v*(v*x).sum(1)[:,None]-x
    n/=np.maximum(np.linalg.norm(n,axis=1,keepdims=True),1e-12)
    result[valid]=n
    return result

def closed_lid(points,o,band_pixels=36):
    target=o['target'];right=o['right'];up=o['up'];forward=-o['direction'];span=o['span'];size=o['size'];contour=np.asarray(o['contour'])
    xy=np.stack([((points-target)@right/span+.5)*size,(.5-(points-target)@up/span)*size],1);x=xy[:,0];y=xy[:,1]
    upper=np.full(len(points),np.inf);lower=np.full(len(points),-np.inf)
    for a,b in zip(contour,np.roll(contour,-1,axis=0)):
        if abs(b[0]-a[0])<1e-9:continue
        valid=(x>=min(a[0],b[0]))&(x<=max(a[0],b[0]));yy=a[1]+(x-a[0])/(b[0]-a[0])*(b[1]-a[1]);upper[valid]=np.minimum(upper[valid],yy[valid]);lower[valid]=np.maximum(lower[valid],yy[valid])
    valid=np.isfinite(upper)&np.isfinite(lower)&(np.linalg.norm(points-o['center'],axis=1)<o['radius']*2)&((points-o['center'])@forward>0)
    # Invalid columns are neutral; avoid infinities entering the deformation arithmetic.
    upper[~valid]=y[~valid];lower[~valid]=y[~valid]
    middle=upper*.3+lower*.7;top=y<=middle;edge=np.where(top,upper,lower);distance=abs(y-edge)
    weight=np.clip(1-distance/band_pixels,0,1);weight=weight*weight*(3-2*weight);weight*=valid
    movement=(middle-edge)*weight;out=points-up[None,:]*(movement*span/size)[:,None]
    lateral=np.stack([(out-o['center'])@right,(out-o['center'])@up],1);rad=np.linalg.norm(lateral,axis=1)
    depth=np.sqrt(np.maximum(0,o['radius']**2-rad**2));limbus=np.sqrt(o['radius']**2-o['iris']**2)
    depth=np.where(rad<o['iris'],limbus+o['bulge']*np.maximum(0,1-(rad/o['iris'])**2),depth)+o['unit']*.00025
    current=(out-o['center'])@forward
    correction=depth-current
    # Follow the globe where closure requires it, without dragging the whole
    # orbital support band inward. Fade inward fitting at the canthi, where
    # the authored upper and lower contours already meet and do not travel.
    canthus=np.clip((lower-upper)/8,0,1)
    inward=weight**8*canthus
    correction=np.where(correction>0,correction*weight,correction*inward)
    out+=forward[None,:]*correction[:,None]
    return out,weight

def conform_open_lid(points,o,band_pixels=36):
    """Push intersecting lid tissue outside the authored globe, never pull skin in.

    Selection is the explicitly fitted opening and its local support band. This
    is a geometric fit operation, not an anatomical segmentation algorithm.
    """
    forward=-o['direction'];rel=points-o['center']
    xy=np.stack([((points-o['target'])@o['right']/o['span']+.5)*o['size'],(.5-(points-o['target'])@o['up']/o['span'])*o['size']],1)
    distance=np.full(len(points),np.inf)
    contour=np.asarray(o['contour'],float)
    for a,b in zip(contour,np.roll(contour,-1,axis=0)):
        edge=b-a;t=np.clip(((xy-a)*edge).sum(1)/np.dot(edge,edge),0,1)
        distance=np.minimum(distance,np.linalg.norm(xy-a-t[:,None]*edge,axis=1))
    lateral=np.stack([rel@o['right'],rel@o['up']],1);rad=np.linalg.norm(lateral,axis=1);current=rel@forward
    support=(distance<band_pixels)&(current>0)&(rad<o['radius'])
    depth=np.sqrt(np.maximum(0,o['radius']**2-rad**2))+o['unit']*.00025
    limbus=np.sqrt(o['radius']**2-o['iris']**2)
    depth=np.where(rad<o['iris'],limbus+o['bulge']*np.maximum(0,1-(rad/o['iris'])**2)+o['unit']*.00025,depth)
    delta=np.where(support,np.maximum(0,depth-current),0)
    return points+delta[:,None]*forward,delta>0

def follow_lid(points,o,direction):
    _,weight=closed_lid(points,o)
    xy=np.stack([((points-o['target'])@o['right']/o['span']+.5)*o['size'],(.5-(points-o['target'])@o['up']/o['span'])*o['size']],1)
    contour=np.asarray(o['contour']);lo,hi=contour[:,0].min(),contour[:,0].max()
    across=np.clip((xy[:,0]-lo)/(hi-lo),0,1)
    canthus=np.sin(np.pi*across)**2
    gains=o.get('lidFollowGains',[.55,.2])
    gain=np.where(xy[:,1]<contour[:,1].mean(),gains[0],gains[1])
    offset=direction*.35*o['radius']*gain*weight*canthus
    moved=points+offset[:,None]*o['up']
    # Refit only vertices affected by this target; a neutral eye's unrelated
    # support vertices must not move when the gaze controller changes.
    fitted,_=conform_open_lid(moved,o);active=abs(offset)>1e-12
    moved[active]=fitted[active]
    return moved,active

def add_blinks(doc,data,source,openings,eye_nodes):
    mesh=doc['meshes'][0]
    if any(p.get('targets') for p in mesh['primitives']):raise ValueError('Compose existing facial morphs explicitly before adding eyelid targets')
    prim=mesh['primitives'][0];local=accessor(doc,data,prim['attributes']['POSITION']);world=source_world_points(source,local)
    origin=source_world_points(source,np.zeros((1,3)))[0];basis=(source_world_points(source,np.eye(3))-origin).T;inverse=np.linalg.inv(basis)
    names=['eyeBlink'+o['side'].title() for o in openings];targets=[];counts=[]
    faces=np.concatenate([accessor(doc,data,p['indices']).reshape(-1,3) for p in mesh['primitives']]);original_normals=accessor(doc,data,prim['attributes']['NORMAL'])
    groups=surface_normal_groups(local)
    def geometric_normals(vertices):return surface_normals(vertices,faces,groups)
    base_normals=geometric_normals(local)
    for o in openings:
        closed,weight=closed_lid(world,o);delta=(closed-world)@inverse.T
        adjusted=transport_normals(original_normals,base_normals,geometric_normals(local+delta));normal_delta=adjusted-original_normals;normal_delta[weight==0]=0
        targets.append({'POSITION':append_accessor(doc,data,delta.astype('<f4'),'VEC3',5126),'NORMAL':append_accessor(doc,data,normal_delta.astype('<f4'),'VEC3',5126)});counts.append(int((weight>0).sum()))
    for o in openings:
        for direction,title in [(1,'Up'),(-1,'Down')]:
            followed,active=follow_lid(world,o,direction);delta=(followed-world)@inverse.T
            adjusted=transport_normals(original_normals,base_normals,geometric_normals(local+delta))
            normal_delta=adjusted-original_normals;normal_delta[~active]=0
            targets.append({'POSITION':append_accessor(doc,data,delta.astype('<f4'),'VEC3',5126),'NORMAL':append_accessor(doc,data,normal_delta.astype('<f4'),'VEC3',5126)})
            names.append('eyeLidLook'+title+o['side'].title())
    for p in mesh['primitives']:p['targets']=targets.copy()
    mesh['weights']=[0]*len(names);mesh.setdefault('extras',{})['targetNames']=names
    times=np.array([0,.8,.9,.98,1.12,2],dtype='<f4');values=np.array([0,0,1,1,0,0],dtype='<f4');time_index=append_accessor(doc,data,times,'SCALAR',5126)
    animation={'name':'Eyes Blink','samplers':[],'channels':[]}
    def channel(node,weights):
        i=len(animation['samplers']);animation['samplers'].append({'input':time_index,'output':append_accessor(doc,data,weights.astype('<f4').reshape(-1),'SCALAR',5126),'interpolation':'LINEAR'});animation['channels'].append({'sampler':i,'target':{'node':node,'path':'weights'}})
    parent=next(i for i,n in enumerate(doc['nodes']) if n.get('mesh')==0);channel(parent,np.column_stack([values,values,np.zeros((len(values),len(names)-2))]))
    gaze_bindings=[(parent,names)]
    # Orbital backing stays head-fixed behind the optical envelope. Moving it
    # toward the cornea during closure crosses the recessed iris at partial blinks.
    for node_index,node in enumerate(doc['nodes']):
        if 'mesh' not in node or node['mesh']==0:continue
        m=doc['meshes'][node['mesh']];p=m['primitives'][0];material=doc['materials'][p['material']]
        if material.get('extras',{}).get('eyeLayer') not in ['lid-contact','tear-meniscus','eyelashes','eyelid-skin','canthus-wall']:continue
        side=next(i for i,o in enumerate(openings) if o['side']==material['extras']['eyeSide'])
        p0=accessor(doc,data,p['attributes']['POSITION']);motion_points=accessor(doc,data,p['attributes']['_LID_WALL_ROOT']) if '_LID_WALL_ROOT' in p['attributes'] else accessor(doc,data,p['attributes']['_LASH_ROOT']) if '_LASH_ROOT' in p['attributes'] else p0;world0=source_world_points(source,motion_points);closed,weight=closed_lid(world0,openings[side])
        transport=accessor(doc,data,p['attributes']['_LID_WALL_WEIGHT']).reshape(-1,1) if '_LID_WALL_WEIGHT' in p['attributes'] else 1
        delta=((closed-world0)@inverse.T)*transport
        p['targets']=[{'POSITION':append_accessor(doc,data,delta.astype('<f4'),'VEC3',5126)}]
        def add_patch_normals(target,offset):
            if material['extras']['eyeLayer'] not in ['eyelid-skin','canthus-wall']:return
            faces=accessor(doc,data,p['indices']).reshape(-1,3);groups=surface_normal_groups(p0)
            original=accessor(doc,data,p['attributes']['NORMAL'])
            adjusted=transport_normals(original,surface_normals(p0,faces,groups),surface_normals(p0+offset,faces,groups))
            target['NORMAL']=append_accessor(doc,data,(adjusted-original).astype('<f4'),'VEC3',5126)
        add_patch_normals(p['targets'][-1],delta)
        local_names=[names[side]]
        for direction,title in [(1,'Up'),(-1,'Down')]:
            followed,_=follow_lid(world0,openings[side],direction);delta=((followed-world0)@inverse.T)*transport
            p['targets'].append({'POSITION':append_accessor(doc,data,delta.astype('<f4'),'VEC3',5126)})
            add_patch_normals(p['targets'][-1],delta)
            local_names.append('eyeLidLook'+title+openings[side]['side'].title())
        m['weights']=[0]*len(local_names);m['extras']={'targetNames':local_names}
        channel(node_index,np.column_stack([values,np.zeros((len(values),2))]));gaze_bindings.append((node_index,local_names))
    doc.setdefault('animations',[]).append(animation)
    gaze={'name':'Eyes Gaze','samplers':[],'channels':[]};gaze_times=append_accessor(doc,data,np.array([0,1,2,3,4],dtype='<f4'),'SCALAR',5126)
    for i,node in enumerate(eye_nodes):
        rest=Rotation.from_quat(doc['nodes'][node]['rotation']);rotations=np.array([(rest*Rotation.from_euler('yx',[yaw,pitch])).as_quat() for yaw,pitch in [(0,0),(.2,0),(0,.1),(-.2,0),(0,0)]],dtype='<f4')
        gaze['samplers'].append({'input':gaze_times,'output':append_accessor(doc,data,rotations,'VEC4',5126),'interpolation':'LINEAR'});gaze['channels'].append({'sampler':i,'target':{'node':node,'path':'rotation'}})
    for node,target_names in gaze_bindings:
        weights=np.zeros((5,len(target_names)),dtype='<f4')
        for j,name in enumerate(target_names):
            if name.startswith('eyeLidLookDown'):weights[2,j]=.1/.35
        sampler=len(gaze['samplers']);gaze['samplers'].append({'input':gaze_times,'output':append_accessor(doc,data,weights.reshape(-1),'SCALAR',5126),'interpolation':'LINEAR'})
        gaze['channels'].append({'sampler':sampler,'target':{'node':node,'path':'weights'}})
    doc['animations'].append(gaze)
    return {'controls':names,'affectedVertices':counts,'method':'contour-defined eyelid closure with surface-following depth and smooth outer falloff','normals':'shortest-frame rotation transports authored normals with area-weighted deformed surface normals'}
