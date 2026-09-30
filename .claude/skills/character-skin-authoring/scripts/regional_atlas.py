"""Pack explicitly registered regional detail alongside the facial atlas.

One shader sampler and one existing VEC3 binding; body coverage remains authoritative.
Overlapping vertex bindings require an authored combined patch, not an automatic winner.
"""
import numpy as np

def pack_regions(face,expression,binding,points,normals,labels,visibility,planes,height_range,triangles=None):
    if not planes:return face,expression,binding,{}
    if face.shape!=expression.shape or face.ndim!=3 or face.shape[2]!=4 or height_range<=0:
        raise ValueError('Regional atlas requires matching RGBA facial maps and physical height range')
    width=face.shape[1];cursor=face.shape[0]+2;slots=[]
    for plane in planes:
        yy,xx=np.nonzero(plane['feather']>0)
        if not len(xx):raise ValueError('Independent detail patch has no authored support')
        if xx.min()<2 or yy.min()<2 or xx.max()>=plane['size']-2 or yy.max()>=plane['size']-2:
            raise ValueError('Independent detail requires a transparent margin inside its evidence view')
        x0=max(0,int(xx.min())-2);x1=min(plane['size'],int(xx.max())+3)
        y0=max(0,int(yy.min())-2);y1=min(plane['size'],int(yy.max())+3)
        if x1-x0+4>width:raise ValueError('Registered patch exceeds atlas width')
        slots.append((plane,(x0,y0,x1,y1),2,cursor));cursor+=y1-y0+4
    if cursor>8192 or width*2>8192:raise ValueError('Regional atlas exceeds the supported 8192 texture extent')
    detail=np.full((cursor,width,4),.5,np.float32);detail[:,:,3]=0
    dynamic=detail.copy();detail[:len(face)]=face;dynamic[:len(face)]=expression
    result=binding.copy();result[:,1]*=len(face)/cursor
    assigned=np.zeros(len(points),bool);records=[]
    for plane,(x0,y0,x1,y1),dest_x,dest_y in slots:
        h=plane['height'];crop_height=np.zeros((y1-y0,x1-x0)) if h is None else h[y0:y1,x0:x1]
        tile=np.stack([np.clip(.5+crop_height/height_range,0,1),plane['roughness'][y0:y1,x0:x1],np.full(crop_height.shape,.5),plane['feather'][y0:y1,x0:x1]],axis=-1)
        detail[dest_y:dest_y+len(tile),dest_x:dest_x+tile.shape[1]]=tile
        local=points-plane['target'];pixels=np.stack([(local@plane['right']/plane['span']+.5)*plane['size'],(.5-local@plane['up']/plane['span'])*plane['size']],axis=1)
        seen=((visibility&(1<<plane['index']))!=0)&np.all((pixels>=0)&(pixels<plane['size']),axis=1)
        region=seen&(labels==plane['region'])
        support=region.copy()
        if triangles is not None:
            # An inactive vertex still interpolates UVs. Give adjacent triangle
            # corners coherent patch coordinates, but keep their detail weight zero.
            touching=triangles[np.any(region[triangles],axis=1)]
            support[np.unique(touching)]=True
        if np.any(support&assigned) or np.any(support&(binding[:,2]>0)):
            raise ValueError('Independent detail regions overlap; author a combined binding explicitly')
        # Clamp to this tile's transparent boundary, not another atlas region.
        q=np.clip(pixels-np.array([x0,y0]),[.5,.5],[x1-x0-1.5,y1-y0-1.5])
        result[support,0]=(q[support,0]+dest_x)/width
        result[support,1]=(q[support,1]+dest_y)/cursor
        result[support,2]=0
        facing=np.clip((abs(normals@plane['direction'])-.2)/.3,0,1)
        result[region,2]=(facing*facing*(3-2*facing))[region]
        assigned|=support
        records.append({'viewIndex':plane['index'],'region':plane['region'],'sourceViewResolution':plane['size'],'cropPixels':[x0,y0,x1,y1],'atlasPixels':[dest_x,dest_y,x1-x0,y1-y0],'boundVertices':int(region.sum()),'zeroWeightSupportVertices':int((support&~region).sum())})
    return detail,dynamic,result,{'skinFacialAtlasRegion':[0,0,1,len(face)/cursor],'skinRegionalAtlasPatches':records,'skinRegionalAtlasHeightMode':'additive-v1'}
