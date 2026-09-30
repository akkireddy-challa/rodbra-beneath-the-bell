"""Independent optical eye geometry fitted from agent-authored source-view landmarks.

The adapter preserves the skin revision and writes a separate eye revision. Geometry,
UV conventions and optical surfaces are a single contract; no anatomy classifier runs.
"""
import argparse,copy,hashlib,json,struct,shutil
from pathlib import Path
import numpy as np
from scipy.spatial.transform import Rotation
from glb_arrays import read,accessor
from glb_output import append_accessor
from vision_materials import source_world_points
from eye_opening import cut_openings,refine_authored_contours
from eyelid_morph import add_blinks,conform_open_lid,surface_normal_groups,surface_normals,transport_normals
from eye_texture import build_texture,optical_uv
from workspace_paths import workspace_root
ROOT=workspace_root(__file__)

def ray_hit(origin,direction,points,triangles):
    a=points[triangles[:,0]];e1=points[triangles[:,1]]-a;e2=points[triangles[:,2]]-a
    h=np.cross(direction,e2);det=(e1*h).sum(1);safe=np.where(abs(det)>1e-12,det,1);s=origin-a;u=(s*h).sum(1)/safe;q=np.cross(s,e1);v=(q*direction).sum(1)/safe;t=(e2*q).sum(1)/safe
    valid=(abs(det)>1e-12)&(u>=0)&(v>=0)&(u+v<=1)&(t>0)
    if not valid.any():raise ValueError('An eye landmark ray misses the source; review the exact evidence')
    return origin+direction*t[valid].min()

def projected_ray_candidates(projected,triangles,contour):
    """Conservative screen-space broad phase; retain all depths/occluders."""
    contour=np.asarray(contour,float);lo=contour.min(0)-1;hi=contour.max(0)+1
    bounds=projected[triangles]
    return triangles[((bounds.min(1)<=hi)&(bounds.max(1)>=lo)).all(1)]

def constrain_orbital_backing(depth,radial_distance,limbus,unit):
    # Continue the interior cap outside the globe too. Keeping source-surface
    # depth at those canthi leaves backing ahead of the closing lid.
    inner_radius=limbus-.0013*unit
    envelope=np.sqrt(np.maximum(0,inner_radius*inner_radius-radial_distance*radial_distance))-.0001*unit
    return np.minimum(depth,envelope)

def radial_mesh(radii,depths,colors,segments=192):
    theta=np.arange(segments)*2*np.pi/segments;c=np.cos(theta);s=np.sin(theta)
    radius=np.broadcast_to(np.asarray(radii)[:,None],(len(radii),segments));depth=np.broadcast_to(np.asarray(depths)[:,None],radius.shape).copy()
    if callable(colors):color,relief=colors(radius,theta[None,:]);depth+=relief
    else:color=np.broadcast_to(colors,(*radius.shape,3)).copy()
    p=np.stack([radius*c,radius*s,depth],-1).reshape(-1,3);indices=[]
    for row in range(len(radii)-1):
        for k in range(segments):
            a=row*segments+k;b=row*segments+(k+1)%segments;c1=b+segments;d=a+segments;indices.extend([[a,b,d],[b,c1,d]])
    ids=np.asarray(indices)[:,::-1];n=np.zeros_like(p);face=np.cross(p[ids[:,1]]-p[ids[:,0]],p[ids[:,2]]-p[ids[:,0]])
    for k in range(3):np.add.at(n,ids[:,k],face)
    n/=np.maximum(np.linalg.norm(n,axis=1,keepdims=True),1e-12)
    return p,n,color.reshape(-1,3),ids

def write_glb(doc,data,path):
    doc['buffers'][0]['byteLength']=len(data);payload=json.dumps(doc,separators=(',',':')).encode();payload+=b' '*((-len(payload))%4);data.extend(b'\0'*((-len(data))%4))
    raw=struct.pack('<III',0x46546c67,2,28+len(payload)+len(data))+struct.pack('<II',len(payload),0x4e4f534a)+payload+struct.pack('<II',len(data),0x004e4942)+data
    temporary=path.with_suffix('.part.glb');temporary.write_bytes(raw);temporary.replace(path);return hashlib.sha256(raw).hexdigest()

def build(profile_path):
    fit=json.loads(profile_path.read_text());sid=fit['id'];base=ROOT/'characters'/sid/'high/v1';out=base/'eyes/v1';out.mkdir(parents=True,exist_ok=True)
    fit['eyes']=[refine_authored_contours(eye) for eye in fit['eyes']]
    if sorted(e['anatomicalSide'] for e in fit['eyes'])!=['left','right']:raise ValueError('This adapter requires one explicitly authored left and right eye')
    evidence=Path(fit['evidence']);manifest=json.loads((evidence/'manifest.json').read_text());raw_source=Path(manifest['source'])
    if manifest.get('sourceSha256')!=fit['sourceSha256']:raise ValueError('Eye evidence belongs to another source')
    if hashlib.sha256(raw_source.read_bytes()).hexdigest()!=fit['sourceSha256']:raise ValueError('Eye fit source hash mismatch')
    source,source_data=read(raw_source);prim=source['meshes'][0]['primitives'][0];local=accessor(source,source_data,prim['attributes']['POSITION']);tri=accessor(source,source_data,prim['indices']).reshape(-1,3);points=source_world_points(source,local)
    revision=fit.get('skinRevision','v2')
    if revision not in ['v2','v3','v4']:raise ValueError('Unsupported skin revision')
    skin_path=base/'materials'/revision/'character.glb'
    doc,data=read(skin_path);skin_hash=hashlib.sha256(skin_path.read_bytes()).hexdigest()
    repair_report=None
    if fit.get('sourceAlbedoRepairMask'):
        from texture_repair import apply_reviewed_repair
        repair_report=apply_reviewed_repair(doc,data,ROOT/fit['sourceAlbedoRepairMask'],out,fit['sourceSha256'])
    old=doc['meshes'][0]['primitives'];removed=sum(accessor(doc,data,p['indices']).size//3 for p in old if doc['materials'][p['material']].get('extras',{}).get('characterSurface')=='eyes')
    if not removed and fit.get('openingAuthority')!='reviewed-contours':
        raise ValueError('No reviewed ocular primitives; explicitly authorize reviewed-contours after inspecting the source eye evidence')
    openings=[];lid_detail_bindings=[]
    height=np.ptp(points[:,2]);center=(points.max(0)+points.min(0))/2;physical_height=json.loads((base/'output/viewer-profile.json').read_text())['height']
    if not np.isfinite(physical_height) or physical_height<=0:raise ValueError('Character physical height must be positive finite metres')
    unit=height/physical_height
    origin_basis=source_world_points(source,np.zeros((1,3)))[0];basis=(source_world_points(source,np.eye(3))-origin_basis).T;inverse=np.linalg.inv(basis)
    parent=next(i for i,node in enumerate(doc['nodes']) if node.get('mesh')==0);eye_reports=[];texture_provenance=[]
    for eye in fit['eyes']:
        view=next(v for v in manifest['views'] if v['name']==eye['view']);image_path=evidence/(eye['view']+'.png')
        if hashlib.sha256(image_path.read_bytes()).hexdigest()!=manifest['evidenceHashes'][image_path.name]:raise ValueError('Eye evidence image changed')
        direction=np.array(view['direction'],float);direction/=np.linalg.norm(direction);up=np.array(view.get('up',[0,0,1]),float);right=np.cross(direction,up);right/=np.linalg.norm(right);up=np.cross(right,direction)
        target=center+height*np.array(view.get('targetOffset',[0,0,0]));span=height*view['span'];x,y=eye['irisCenterPx'];point=target+right*((x+.5)/manifest['size']-.5)*span+up*(.5-(y+.5)/manifest['size'])*span
        front=ray_hit(point-direction*height*2,direction,points,tri)
        projected=np.stack([((points-target)@right/span+.5)*manifest['size'],(.5-(points-target)@up/span)*manifest['size']],1)
        openings.append({'pixels':projected,'contour':eye['openingPx'],'surfaceHit':front,'radius':eye['globeRadiusM']*unit,'side':eye['anatomicalSide']})
        radius=eye['globeRadiusM']*unit;iris=eye['irisRadiusPx']/manifest['size']*span;pupil=iris*eye['pupilRatio'];bulge=eye['corneaBulgeM']*unit
        if not 0<pupil<iris<radius or not 0<bulge<radius*.3:raise ValueError('Eye dimensions must satisfy pupil < iris < globe and a positive, shallow cornea')
        limbus=np.sqrt(radius*radius-iris*iris)
        eye_center=front+direction*(limbus+bulge-eye['frontOffsetM']*unit);axes=inverse@np.stack([right,up,-direction],1);rotation=Rotation.from_matrix(axes).as_quat();translation=inverse@(eye_center-origin_basis)
        group=len(doc['nodes']);doc['nodes'].append({'name':'OpticalEye_'+eye['name'],'translation':translation.tolist(),'rotation':rotation.tolist(),'children':[],'extras':{'characterEye':True,'forwardAxis':'+Z','fitSource':fit['sourceSha256']}});doc['nodes'][parent].setdefault('children',[]).append(group)
        def add(name,geometry,material,parent_node=group,uv=None):
            p,n,c,ids=geometry;mi=len(doc['materials']);doc['materials'].append({'name':eye['name']+'_'+name,'extras':{'characterSurface':'eyes','eyeLayer':name,'eyeSide':eye['anatomicalSide']},**material})
            attributes={key:append_accessor(doc,data,arr.astype('<f4'),'VEC3',5126) for key,arr in [('POSITION',p),('NORMAL',n)]}
            attributes['COLOR_0']=append_accessor(doc,data,c.astype('<f4'),'VEC4' if c.shape[1]==4 else 'VEC3',5126)
            if uv is not None:attributes['TEXCOORD_0']=append_accessor(doc,data,uv.astype('<f4'),'VEC2',5126)
            mesh=len(doc['meshes']);doc['meshes'].append({'name':eye['name']+'_'+name,'primitives':[{'attributes':attributes,'indices':append_accessor(doc,data,ids.astype('<u4').reshape(-1),'SCALAR',5125),'material':mi}]})
            node=len(doc['nodes']);doc['nodes'].append({'name':eye['name']+'_'+name,'mesh':mesh});doc['nodes'][parent_node]['children'].append(node)
        def material(rough,extensions=None):return {'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':0,'roughnessFactor':rough},'extensions':extensions or {}}
        theta=np.linspace(np.arcsin(iris/radius),np.pi-.001,64)
        eye_texture,provenance=build_texture(doc,data,out,eye['irisColorLinear']);texture_provenance.append(provenance)
        sclera=radial_mesh(radius*np.sin(theta),radius*np.cos(theta),[.70,.67,.65])
        sclera_material=material(.28,{'KHR_materials_clearcoat':{'clearcoatFactor':1,'clearcoatRoughnessFactor':.08},'KHR_materials_ior':{'ior':1.376}})
        sclera_material['pbrMetallicRoughness']['baseColorTexture']={'index':eye_texture}
        add('sclera',sclera,sclera_material,uv=optical_uv(sclera[0],iris))
        # The transparent cornea supplies the air-interface reflection. Do not
        # add another broad wet-surface reflection on the recessed iris or pupil.
        rr=np.linspace(pupil,iris,64);depth=limbus-.0008*unit*(1-(rr-pupil)/(iris-pupil))
        iris_geometry=radial_mesh(rr,depth,[1,1,1]);iris_material=material(.5,{'KHR_materials_specular':{'specularFactor':0}})
        iris_material['pbrMetallicRoughness']['baseColorTexture']={'index':eye_texture}
        add('iris',iris_geometry,iris_material,uv=optical_uv(iris_geometry[0],iris))
        add('pupil',radial_mesh(np.linspace(0,pupil*1.02,8),np.full(8,limbus-.00095*unit),[.001,.001,.001]),material(.7,{'KHR_materials_specular':{'specularFactor':0}}))
        rr=np.linspace(0,iris*1.002,64);zz=limbus+bulge*np.maximum(0,1-(rr/iris)**2)
        add('cornea',radial_mesh(rr,zz,[1,1,1]),material(.025,{'KHR_materials_transmission':{'transmissionFactor':1},'KHR_materials_volume':{'thicknessFactor':.0005*unit,'attenuationDistance':10,'attenuationColor':[1,1,1]},'KHR_materials_ior':{'ior':1.376}}))
        # A head-fixed contact strip follows the authored lid contour, never the gaze node.
        contour=np.asarray(eye['openingPx'],float);middle=contour.mean(0);rings=[];alpha=[]
        aperture_triangles=projected_ray_candidates(projected,tri,contour)
        openings[-1].update(center=eye_center,right=right,up=up,direction=direction,target=target,span=span,size=manifest['size'],iris=iris,bulge=bulge,unit=unit,cornerDepths=eye.get('cornerDepths',[]))
        from eyelid_patch import authored_corner_support
        def corner_surface(plane):
            return authored_corner_support(ray_hit(plane-direction*height*2,direction,points,aperture_triangles),plane,openings[-1])
        # Mucosal backing closes the orbital opening outside the spherical globe.
        # It is behind the cornea/iris and attached to the head, not the gaze node.
        boundary_depth=[]
        for pixel in contour:
            on_plane=target+right*(pixel[0]/manifest['size']-.5)*span+up*(.5-pixel[1]/manifest['size'])*span
            boundary_depth.append((corner_surface(on_plane)-eye_center)@(-direction)-.0001*unit)
        edge_steps=np.linspace(0,1,8,endpoint=False)
        boundary=np.concatenate([a[None,:]*(1-edge_steps[:,None])+b[None,:]*edge_steps[:,None] for a,b in zip(contour,np.roll(contour,-1,axis=0))])
        boundary_depth=np.concatenate([a*(1-edge_steps)+b*edge_steps for a,b in zip(boundary_depth,np.roll(boundary_depth,-1))])
        backing=[];radial_steps=20
        for fraction in np.linspace(0,1,radial_steps):
            pixels=middle[None,:]*(1-fraction)+boundary*fraction
            plane=target[None,:]+right[None,:]*((pixels[:,0]/manifest['size']-.5)*span)[:,None]+up[None,:]*((.5-pixels[:,1]/manifest['size'])*span)[:,None]
            xy=np.stack([(plane-eye_center)@right,(plane-eye_center)@up],1);r=np.linalg.norm(xy,axis=1)
            depth=(limbus-.004*unit)*(1-fraction)+boundary_depth*fraction
            # A coarse fan can cut across the globe. Sample the backing finely and
            # constrain it behind every optical layer wherever their domains overlap.
            # A spherical inset is gaze-invariant: a neutral-view iris-depth cap
            # can cross the recessed iris when the globe rotates.
            depth=constrain_orbital_backing(depth,r,limbus,unit)
            world=eye_center+xy[:,0,None]*right+xy[:,1,None]*up-depth[:,None]*direction
            backing.extend((world-origin_basis)@inverse.T)
        backing=np.asarray(backing);backing_ids=[];count=len(boundary)
        for row in range(radial_steps-1):
            for k in range(count):
                a=row*count+k;b=row*count+(k+1)%count;backing_ids.extend([[a,b,a+count],[b,b+count,a+count]])
        backing_material=material(.55,{'KHR_materials_specular':{'specularFactor':.2}});backing_material['doubleSided']=True
        add('orbital-mucosa',(backing,np.broadcast_to(inverse@(-direction),backing.shape),np.broadcast_to([.11,.035,.03],backing.shape),np.asarray(backing_ids)),backing_material,parent)
        if eye.get('caruncle'):
            authored=eye['caruncle'];corner=np.asarray(eye['openingPx'][authored['innerContourIndex']],float)
            toward=np.asarray(eye['irisCenterPx'],float)-corner;toward/=np.linalg.norm(toward)
            pixel=corner+toward*(authored['insetM']*unit/span*manifest['size'])
            plane=target+right*(pixel[0]/manifest['size']-.5)*span+up*(.5-pixel[1]/manifest['size'])*span
            xy=np.array([(plane-eye_center)@right,(plane-eye_center)@up])
            dimensions=np.asarray(authored['radiiM'],float)*unit
            if dimensions.shape!=(3,) or not np.isfinite(dimensions).all() or np.any(dimensions<=0) or np.any(dimensions>radius*.2):raise ValueError('Invalid authored caruncle dimensions')
            theta=np.linspace(.001,np.pi-.001,20)
            tissue,_,colors,faces=radial_mesh(dimensions[0]*np.sin(theta),dimensions[2]*np.cos(theta),authored['colorLinear'],48)
            tissue[:,1]*=dimensions[1]/dimensions[0]
            lateral=tissue[:,:2]+xy
            cap=np.sqrt(np.maximum(0,radius*radius-np.sum(lateral*lateral,axis=1)))
            center_depth=np.sqrt(max(0,radius*radius-np.dot(xy,xy)))-dimensions[2]-.00045*unit
            depths=np.minimum(tissue[:,2]+center_depth,cap-.0004*unit)
            if authored.get('support') == 'corner-lining-v1':
                from canthus_wall import lining_depth_at_radius
                walls=[wall for wall in eye.get('canthusWalls',[]) if authored['innerContourIndex'] in wall['contourIndices']]
                if len(walls)!=1:raise ValueError('Corner tissue requires one explicitly authored supporting lining')
                corner_plane=target+right*(corner[0]/manifest['size']-.5)*span+up*(.5-corner[1]/manifest['size'])*span
                corner_xy=np.array([(corner_plane-eye_center)@right,(corner_plane-eye_center)@up])
                corner_hit=corner_surface(corner_plane)
                support_depth=lining_depth_at_radius(np.linalg.norm(xy),np.linalg.norm(corner_xy),(corner_hit-eye_center)@(-direction),radius,iris,unit,walls[0].get('contactMethod')=='reconstructed-lid-v1')
                depths=tissue[:,2]+support_depth+.00005*unit
                # Medial tissue may cover the peripheral sclera. Clamping it
                # behind the whole globe creates a deep discontinuity and hides
                # it behind the lining. Protect the swept iris instead.
                swept=iris*np.cos(.35)+np.sqrt(radius*radius-iris*iris)*np.sin(.35)
                if np.linalg.norm(lateral,axis=1).min()<swept+.00035*unit:
                    raise ValueError('Authored corner tissue encroaches on the reviewed iris gaze envelope')
            elif authored.get('support') is not None:raise ValueError('Unsupported corner tissue support')
            world=eye_center+lateral[:,0,None]*right+lateral[:,1,None]*up-depths[:,None]*direction
            local_tissue=(world-origin_basis)@inverse.T
            normals=surface_normals(local_tissue,faces,surface_normal_groups(local_tissue))
            wet=material(.4,{'KHR_materials_clearcoat':{'clearcoatFactor':.3,'clearcoatRoughnessFactor':.12},'KHR_materials_ior':{'ior':1.376}})
            add('caruncle',(local_tissue,normals,colors,faces),wet,parent)
        # Resolve the curved lid/globe contact between authored landmarks too.
        # The sparse authoring contour is not a sufficient render tessellation.
        contact_contour=boundary[::2]
        for inset in [0,.07,.19]:
            for pixel in contact_contour:
                xy=pixel*(1-inset)+middle*inset
                on_plane=target+right*(xy[0]/manifest['size']-.5)*span+up*(.5-xy[1]/manifest['size'])*span
                surface_hit=ray_hit(on_plane-direction*height*2,direction,points,aperture_triangles)
                local_xy=np.array([(on_plane-eye_center)@right,(on_plane-eye_center)@up]);rad=np.linalg.norm(local_xy)
                optical=limbus+bulge*max(0,1-(rad/iris)**2) if rad<iris else np.sqrt(max(0,radius*radius-rad*rad))
                forward_depth=optical+.00033*unit if eye.get('outerLidPx') else max((surface_hit-eye_center)@(-direction),optical)+.00008*unit
                point=eye_center+right*local_xy[0]+up*local_xy[1]-direction*forward_depth
                rings.append(inverse@(point-origin_basis));top=1 if pixel[1]<middle[1] else .55
                alpha.append(top*{0:.60,.07:.18,.19:0}[inset])
        contact_ids=[];count=len(contact_contour)
        for row in range(2):
            for k in range(count):
                a=row*count+k;b=row*count+(k+1)%count;contact_ids.extend([[a,b,a+count],[b,b+count,a+count]])
        contact_p=np.asarray(rings);contact_n=np.broadcast_to(inverse@(-direction),contact_p.shape);contact_c=np.zeros((len(rings),4));contact_c[:,3]=alpha
        contact_mat=material(1,{'KHR_materials_specular':{'specularFactor':0}});contact_mat.update(alphaMode='BLEND',doubleSided=True)
        add('lid-contact',(contact_p,contact_n,contact_c,np.asarray(contact_ids)),contact_mat,parent)
        # A small fluid meniscus follows the reviewed lower lid, attached to the head.
        lower=contact_p[np.asarray(eye['lowerContourIndices'])*4];path=np.concatenate([a[None,:]+np.linspace(0,1,8,endpoint=False)[:,None]*(b-a)[None,:] for a,b in zip(lower,lower[1:])]+[lower[-1:]])
        tangent=np.gradient(path,axis=0);tangent/=np.maximum(np.linalg.norm(tangent,axis=1,keepdims=True),1e-12);fwd=inverse@(-direction);binormal=np.cross(tangent,fwd);binormal/=np.maximum(np.linalg.norm(binormal,axis=1,keepdims=True),1e-12)
        theta=np.arange(8)*2*np.pi/8;meniscus_n=binormal[:,None,:]*np.cos(theta)[None,:,None]+fwd[None,None,:]*np.sin(theta)[None,:,None]
        meniscus_p=path[:,None,:]+meniscus_n*(.00012*unit);meniscus_ids=[]
        for j in range(len(path)-1):
            for k in range(8):
                a=j*8+k;b=j*8+(k+1)%8;meniscus_ids.extend([[a,b,a+8],[b,b+8,a+8]])
        tear=material(.035,{'KHR_materials_transmission':{'transmissionFactor':.9},'KHR_materials_ior':{'ior':1.336}});tear['doubleSided']=True
        add('tear-meniscus',(meniscus_p.reshape(-1,3),meniscus_n.reshape(-1,3),np.ones((len(path)*8,3)),np.asarray(meniscus_ids)),tear,parent)
        if fit.get('lashes'):
            lash_profile=fit['lashes'];lash_points=[];lash_normals=[];lash_roots=[];lash_ids=[]
            for contour_indices,amount,length in [(eye['upperContourIndices'],lash_profile['upperCount'],lash_profile['upperLengthM']),(eye['lowerContourIndices'],lash_profile['lowerCount'],lash_profile['lowerLengthM'])]:
                root_path=contact_p[np.asarray(contour_indices)*4];segments=np.linalg.norm(np.diff(root_path,axis=0),axis=1);arc=np.r_[0,np.cumsum(segments)]
                upper=contour_indices==eye['upperContourIndices'];sign=1 if upper else -1
                for strand,fraction in enumerate(np.linspace(.035,.965,amount)):
                    distance=fraction*arc[-1];edge=min(len(segments)-1,np.searchsorted(arc,distance,side='right')-1);t=(distance-arc[edge])/segments[edge]
                    root=root_path[edge]*(1-t)+root_path[edge+1]*t
                    variation=.82+.18*np.sin(strand*2.399963+len(lash_points))
                    size=length*unit*variation*(.55+.45*np.sin(np.pi*fraction))
                    outward=inverse@(-direction);vertical=inverse@up*sign;lateral=inverse@right
                    curve=[]
                    for q in np.linspace(0,1,8):
                        curve.append(root+size*(outward*(.8*q-.18*q*q)+vertical*(.15*q+.65*q*q)+lateral*((fraction-.5)*.32*q)))
                    curve=np.asarray(curve);tangent=np.gradient(curve,axis=0);tangent/=np.maximum(np.linalg.norm(tangent,axis=1,keepdims=True),1e-12)
                    side=np.cross(tangent,vertical);side/=np.maximum(np.linalg.norm(side,axis=1,keepdims=True),1e-12);other=np.cross(tangent,side)
                    angle=np.arange(5)*2*np.pi/5;normals=side[:,None,:]*np.cos(angle)[None,:,None]+other[:,None,:]*np.sin(angle)[None,:,None]
                    strand_radius=lash_profile['radiusM']*unit*np.linspace(1,.06,8)
                    vertices=curve[:,None,:]+normals*strand_radius[:,None,None];start=len(lash_points)
                    lash_points.extend(vertices.reshape(-1,3));lash_normals.extend(normals.reshape(-1,3));lash_roots.extend(np.repeat(root[None,:],40,axis=0))
                    for row in range(7):
                        for k in range(5):
                            a=start+row*5+k;b=start+row*5+(k+1)%5;lash_ids.extend([[a,b,a+5],[b,b+5,a+5]])
            lash_points=np.asarray(lash_points);lash_material=material(.65,{'KHR_materials_specular':{'specularFactor':.35}})
            add('eyelashes',(lash_points,np.asarray(lash_normals),np.broadcast_to([.012,.007,.004],lash_points.shape),np.asarray(lash_ids)),lash_material,parent)
            lash_primitive=doc['meshes'][-1]['primitives'][0]
            lash_primitive['attributes']['_LASH_ROOT']=append_accessor(doc,data,np.asarray(lash_roots,dtype='<f4'),'VEC3',5126)
            doc['materials'][lash_primitive['material']]['extras']['characterSurface']='hair'
        if eye.get('browGroom'):
            from brow_groom import build_brow
            source_normals=accessor(source,source_data,prim['attributes']['NORMAL'])@inverse
            source_normals/=np.maximum(np.linalg.norm(source_normals,axis=1,keepdims=True),1e-12)
            brow=build_brow(eye['browGroom'],points,tri,source_normals,target,right,up,direction,span,manifest['size'],unit,inverse,origin_basis)
            add('eyebrows',brow,material(.72,{'KHR_materials_specular':{'specularFactor':.22}}),parent)
            doc['materials'][-1]['extras']['characterSurface']='hair'
        openings[-1].update(center=eye_center,right=right,up=up,direction=direction,target=target,span=span,size=manifest['size'],iris=iris,bulge=bulge,unit=unit)
        for wall in eye.get('canthusWalls',[]):
            from canthus_wall import build_canthus_wall
            geometry,wall_roots,wall_weights=build_canthus_wall(wall,openings[-1],corner_surface,inverse,origin_basis)
            wall_material=material(.55,{'KHR_materials_specular':{'specularFactor':.35}});wall_material['doubleSided']=True
            add('canthus-wall',geometry,wall_material,parent)
            wall_primitive=doc['meshes'][-1]['primitives'][0]
            wall_primitive['attributes']['_LID_WALL_ROOT']=append_accessor(doc,data,wall_roots.astype('<f4'),'VEC3',5126)
            wall_primitive['attributes']['_LID_WALL_WEIGHT']=append_accessor(doc,data,wall_weights.astype('<f4'),'SCALAR',5126)
        if eye.get('outerLidPx'):
            from eyelid_patch import build_lid_band
            from glb_output import image_array
            # The boundary joins the current material revision, including reviewed
            # source-color repairs, rather than its unrepaired raw texture.
            source_material=doc['materials'][doc['meshes'][0]['primitives'][0]['material']]
            color_image=image_array(doc,data,source_material['pbrMetallicRoughness']['baseColorTexture']['index']).astype(float)
            source_normals=accessor(source,source_data,prim['attributes']['NORMAL'])@inverse
            source_normals/=np.maximum(np.linalg.norm(source_normals,axis=1,keepdims=True),1e-12)
            geometry=build_lid_band(openings[-1],eye['outerLidPx'],points,tri,accessor(source,source_data,prim['attributes']['TEXCOORD_0']),color_image,inverse,origin_basis,source_normals,eye.get('lidSkinSamplesPx'),eye.get('outerEdgeSampling'),eye.get('fairLidDepth',False))
            geometry=(geometry[0],geometry[1],geometry[2]*np.asarray(source_material['pbrMetallicRoughness'].get('baseColorFactor',[1,1,1,1])[:3]),geometry[3])
            lid_material=material(.59,{'KHR_materials_specular':{'specularFactor':.65}})
            add('eyelid-skin',geometry,lid_material,parent)
            doc['materials'][-1]['extras'].update(characterSurface='skin',skinMicroDetail=False,skinDiffusionProfile=source_material.get('extras',{}).get('skinDiffusionProfile',[1,.55,.3]))
            lid_primitive=doc['meshes'][-1]['primitives'][0]
            lid_primitive['attributes']['_SCATTER']=append_accessor(doc,data,np.full(len(geometry[0]),.2,dtype='<f4'),'SCALAR',5126)
            if 'skinFacialAtlasTexture' in source_material.get('extras',{}):
                from eyelid_detail import bind_lid_detail
                face_path=ROOT/'highquality/materials/faces'/f'{sid}.json'
                face_profile=json.loads(face_path.read_text())
                face_receipt=json.loads((base/'materials/v2/face-detail-provenance.json').read_text())
                if hashlib.sha256(face_path.read_bytes()).hexdigest()!=face_receipt['profile_sha256']:
                    raise ValueError('Eyelid facial coordinates differ from the baked atlas')
                bind_lid_detail(doc,data,lid_primitive,doc['materials'][-1],source_world_points(source,geometry[0]),center,height,face_profile,source_material['extras'],out)
                lid_detail_bindings.append(eye['anatomicalSide'])
            openings[-1]['cutContour']=eye['outerLidPx']
            openings[-1]['cutRadius']=openings[-1]['radius']*3
        eye_reports.append({'name':eye['name'],'centerSource':translation.tolist(),'globeRadiusM':eye['globeRadiusM'],'irisRadiusM':iris/unit,'sourceSurfaceHit':front.tolist(),'node':group})
    cut_report=cut_openings(doc,data,points,openings)
    if not cut_report['removedInteriorTriangles']:
        raise ValueError('Authored eye contours removed no interior surface; review the source fit')
    cut_report['authority']=fit.get('openingAuthority','reviewed-ocular-material-and-contours')
    rest_fit=[]
    if fit.get('conformOpenLids',False):
        body=doc['meshes'][0];p=body['primitives'][0];local0=accessor(doc,data,p['attributes']['POSITION']);world0=source_world_points(source,local0);world1=world0.copy()
        for opening in openings:
            world1,moved=conform_open_lid(world1,opening)
            rest_fit.append({'side':opening['side'],'movedVertices':int(moved.sum())})
        local1=local0+(world1-world0)@inverse.T
        faces=np.concatenate([accessor(doc,data,p['indices']).reshape(-1,3) for p in body['primitives']])
        groups=surface_normal_groups(local0)
        def normals(vertices):return surface_normals(vertices,faces,groups)
        n0=accessor(doc,data,p['attributes']['NORMAL']);n1=transport_normals(n0,normals(local0),normals(local1))
        position_index=append_accessor(doc,data,local1.astype('<f4'),'VEC3',5126);normal_index=append_accessor(doc,data,n1.astype('<f4'),'VEC3',5126)
        for p in body['primitives']:
            # Preserve the interpolated source surface for later body-weight
            # transfer. Optical fitting must not change correspondence.
            p['attributes'].setdefault('_BIND_SOURCE_POSITION',p['attributes']['POSITION'])
            p['attributes']['POSITION']=position_index;p['attributes']['NORMAL']=normal_index
    blink_report=add_blinks(doc,data,source,openings,[e['node'] for e in eye_reports])
    extensions={e for m in doc['materials'] for e in m.get('extensions',{})};doc['extensionsUsed']=sorted(set(doc.get('extensionsUsed',[]))|extensions)
    report={'id':sid,'status':'optical_fit_review_required','skinRevisionSha256':skin_hash,'sourceSha256':fit['sourceSha256'],'openingCut':cut_report,'eyelids':blink_report,'eyes':eye_reports,'implementation':'independent sclera, recessed fibrous iris, pupil cavity and refractive corneal dome; authored optical dimensions','limitations':['Eyelid deformation and tear meniscus under visual review','Procedural iris detail, not a captured iris','Fit must be inspected from multiple angles before promotion']}
    report['eyelashes']=fit.get('lashes')
    report['canthusWalls']=[eye.get('canthusWalls',[]) for eye in fit['eyes']]
    report['browGrooms']=[eye.get('browGroom') for eye in fit['eyes']]
    report['lidBandAuthoring']=fit.get('lidBandAuthoring')
    report['lidDetailBindings']=lid_detail_bindings
    if any(eye.get('outerLidPx') for eye in fit['eyes']):report['limitations'].extend(['Reconstructed lid bands have authored color and smooth geometry, not captured lid detail','Outer transition and corner fit require per-character visual acceptance'])
    report['fitProfileSha256']=hashlib.sha256(profile_path.read_bytes()).hexdigest()
    report['openLidFit']=rest_fit
    report['textureProvenance']=texture_provenance
    report['sourceAlbedoRepair']=repair_report
    report['limitations'][1]='CC0 MakeHuman iris/sclera detail with authored pigment, not captured character eyes'
    shutil.copyfile(ROOT/'highquality/references/makehuman-eyes/LICENSE.md',out/'MakeHuman-LICENSE.md')
    skin_attribution=base/'materials/v2/ATTRIBUTION.txt'
    if skin_attribution.exists():shutil.copyfile(skin_attribution,out/'Skin-ATTRIBUTION.txt')
    report['outputSha256']=write_glb(doc,data,out/'character.glb');(out/'report.json').write_text(json.dumps(report,indent=2));(out/'fit.json').write_text(json.dumps(fit,indent=2));print(json.dumps(report))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--profile',required=True,type=Path);build(p.parse_args().profile)
