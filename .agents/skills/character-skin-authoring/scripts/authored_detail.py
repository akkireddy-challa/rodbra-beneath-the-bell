"""Bake agent-authored regional crease curves; never infer anatomy or landmarks."""
import hashlib,json
import numpy as np

LABELS={'skin':1,'palm':2,'sole':3,'dorsal_hand':9}

def curve_distance(points,curve):
    distance=np.full(len(points),np.inf)
    for a,b in zip(curve[:-1],curve[1:]):
        edge=b-a;length=np.dot(edge,edge)
        if length<=0:raise ValueError('Crease curve has a repeated point')
        t=np.clip((points-a)@edge/length,0,1)
        distance=np.minimum(distance,np.linalg.norm(points-a-t[:,None]*edge,axis=1))
    return distance

class AuthoredDetail:
    def __init__(self,path,manifest,physical_height):
        self.curves=[];self.report=None
        if not path.exists():return
        raw=path.read_bytes();profile=json.loads(raw)
        if profile['sourceSha256']!=manifest['sourceSha256']:raise ValueError('Body detail profile belongs to another source')
        for record in profile['curves']:
            index=next(i for i,v in enumerate(manifest['views']) if v['name']==record['view'])
            image=record['view']+'.png'
            if profile['evidenceHashes'].get(image)!=manifest['evidenceHashes'].get(image):raise ValueError('Body detail coordinates belong to different view evidence')
            view=manifest['views'][index];direction=np.asarray(view['direction'],float);direction/=np.linalg.norm(direction)
            right=np.cross(direction,view.get('up',[0,0,1]));right/=np.linalg.norm(right);up=np.cross(right,direction)
            curve=np.asarray(record['pointsPx'],float)
            if curve.ndim!=2 or curve.shape[1]!=2 or len(curve)<2 or not np.isfinite(curve).all():raise ValueError('Invalid authored crease polyline')
            width=record['widthM'];depth=record['depthM']
            if not 0<width<=.003 or not 0<depth<=.00025:raise ValueError('Crease dimensions exceed the supported skin-detail range')
            self.curves.append((index,np.asarray(view.get('targetOffset',[0,0,0]))*physical_height,right,up,direction,view['span']*physical_height,manifest['size'],curve,width,depth,LABELS[record['region']]))
        self.report={'profileSha256':hashlib.sha256(raw).hexdigest(),'curves':len(self.curves),'provenance':profile['provenance'],'method':'agent-authored regional curves projected only onto visible independently labelled skin; physical width/depth'}

    def evaluate(self,points,normals,labels,visibility):
        result=np.zeros(len(points),np.float32)
        for index,target,right,up,direction,span,size,curve,width,depth,region in self.curves:
            selected=(labels==region)&((visibility&(1<<index))!=0)
            if not selected.any():continue
            local=points[selected]-target
            xy=np.stack([(local@right/span+.5)*size,(.5-local@up/span)*size],1)
            distance=curve_distance(xy,curve)*span/size
            facing=np.clip((abs(normals[selected]@direction)-.2)/.3,0,1)
            # A compact smooth groove avoids hard tube ends and adds no pigment.
            relief=-depth*np.exp(-.5*(distance/width)**2)*facing*facing*(3-2*facing)
            result[selected]=np.minimum(result[selected],relief)
        return result
