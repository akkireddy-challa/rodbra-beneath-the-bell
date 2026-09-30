"""Vision-registered roughness/height exemplars, limited by labels and visibility.

No inferred anatomy and no conversion of normal RGB into displacement.
"""
import hashlib,json
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw
from scipy.interpolate import RBFInterpolator
from scipy.ndimage import distance_transform_edt,map_coordinates,gaussian_filter
from authored_detail import LABELS

class AuthoredSurfacePatch:
 def __init__(self,path,manifest,physical_height,root):
  self.patches=[];self.independent=[];self.report=None;self.attributions={}
  if not path.exists():return
  raw=path.read_bytes();profile=json.loads(raw)
  if profile['sourceSha256']!=manifest['sourceSha256']:raise ValueError('Surface patch belongs to another source')
  receipts=[]
  for record in profile['patches']:
   index=next(i for i,v in enumerate(manifest['views'])if v['name']==record['view']);view=manifest['views'][index];image=record['view']+'.png'
   image_path=Path(manifest['output'])/image
   if profile['evidenceHashes'].get(image)!=manifest['evidenceHashes'].get(image) or hashlib.sha256(image_path.read_bytes()).hexdigest()!=profile['evidenceHashes'][image]:raise ValueError('Surface patch evidence changed')
   texture_path=root/record['roughnessTexture'];data=texture_path.read_bytes()
   if hashlib.sha256(data).hexdigest()!=record['textureSha256']:raise ValueError('Surface patch exemplar changed')
   provenance=record['provenance'];license_bytes=(root/provenance['licenseFile']).read_bytes()
   if hashlib.sha256(license_bytes).hexdigest()!=provenance['licenseSha256']:raise ValueError('Surface patch license receipt changed')
   self.attributions[provenance['licenseSha256']]=provenance['title']+'\n'+provenance['url']+'\nAdapted by vision registration and roughness remapping.\n'+license_bytes.decode()
   donor=np.asarray(Image.open(texture_path).convert('L'),float)/255
   source=np.asarray(record['sourcePixels'],float);target=np.asarray(record['targetPixels'],float)
   if source.shape!=target.shape or source.ndim!=2 or source.shape[1]!=2 or len(source)<3 or not np.isfinite(source).all() or not np.isfinite(target).all():raise ValueError('Invalid surface patch correspondences')
   size=manifest['size'];donor_size=record['sourceAnnotationImageSize'];resolution=record.get('sampleResolution',size)
   if not isinstance(resolution,int) or not 16<=resolution<=4096:raise ValueError('Invalid patch sampling resolution')
   if (target<0).any() or (target>=size).any() or (source<0).any() or (source>=donor_size).any():raise ValueError('Surface patch pixel outside evidence')
   if not 0<record['featherM']<=.02:raise ValueError('Invalid surface patch feather')
   low,high=record['roughnessRange']
   if not 0<=low<high<=1:raise ValueError('Invalid surface patch roughness range')
   target_mask=Image.new('L',(resolution,resolution));ImageDraw.Draw(target_mask).polygon([tuple(p*resolution/size)for p in target],fill=255);inside=np.asarray(target_mask)>0
   yy,xx=np.nonzero(inside);mapped=RBFInterpolator(target/size,source/donor_size,kernel='thin_plate_spline',smoothing=0)(np.column_stack([xx,yy])/resolution)
   sampled=map_coordinates(gaussian_filter(donor,1),[mapped[:,1]*(donor.shape[0]-1),mapped[:,0]*(donor.shape[1]-1)],order=1,mode='nearest')
   # Preserve exemplar variation inside a declared art-directed physical response range.
   rough=np.full((resolution,resolution),.5*(low+high));rough[yy,xx]=low+(high-low)*sampled
   height=None
   if record.get('height'):
    h=record['height'];height_path=root/h['path']
    if hashlib.sha256(height_path.read_bytes()).hexdigest()!=h['sha256']:raise ValueError('Surface height exemplar changed')
    field=np.load(height_path,allow_pickle=False);bounds=np.asarray(h['boundsPx'],float)
    if field.ndim!=2 or not np.isfinite(field).all() or np.max(abs(field))>.001 or bounds.shape!=(4,) or not np.isfinite(bounds).all() or np.any(bounds[2:]<=bounds[:2]) or not 0<h['scale']<=4 or not h.get('provenance'):
     raise ValueError('Invalid physical surface height field or provenance')
    coordinates=(mapped*donor_size-bounds[:2])/(bounds[2:]-bounds[:2])
    height=np.zeros((resolution,resolution));height[yy,xx]=map_coordinates(field,[coordinates[:,1]*(field.shape[0]-1),coordinates[:,0]*(field.shape[1]-1)],order=1,mode='nearest')*h['scale']
    self.attributions[provenance['licenseSha256']]+='\nHeight adaptation: '+json.dumps(h['provenance'])+'\n'
   feather=np.clip(distance_transform_edt(inside)*view['span']*physical_height/resolution/record['featherM'],0,1);feather=feather*feather*(3-2*feather)
   direction=np.asarray(view['direction'],float);direction/=np.linalg.norm(direction);right=np.cross(direction,view.get('up',[0,0,1]));right/=np.linalg.norm(right);up=np.cross(right,direction)
   self.patches.append((index,np.asarray(view.get('targetOffset',[0,0,0]))*physical_height,right,up,direction,view['span']*physical_height,resolution,LABELS[record['region']],rough,feather,height))
   self.independent.append(record.get('independentDetail',False))
   receipts.append({'view':record['view'],'region':record['region'],'roughnessTexture':record['roughnessTexture'],'textureSha256':record['textureSha256'],'roughnessRange':record['roughnessRange'],'height':record.get('height'),'provenance':record['provenance'],'independentDetail':self.independent[-1],'sampleResolution':resolution})
  self.report={'profileSha256':hashlib.sha256(raw).hexdigest(),'patches':receipts,'method':'independent vision correspondences; optional physical height; semantic labels and geometric visibility constrain application'}

 def evaluate(self,points,normals,labels,visibility,base,include_independent=True):
  return self._evaluate(points,normals,labels,visibility,base,False,include_independent)

 def relief(self,points,normals,labels,visibility,include_independent=True):
  return self._evaluate(points,normals,labels,visibility,np.zeros(len(points)),True,include_independent)

 def _evaluate(self,points,normals,labels,visibility,base,use_height,include_independent):
  total=np.zeros(len(points));value=np.zeros(len(points))
  for independent,patch in zip(self.independent,self.patches):
   if independent and not include_independent:continue
   index,target,right,up,direction,span,size,region,rough,feather,height=patch
   field=height if use_height else rough
   if field is None:continue
   selected=(labels==region)&((visibility&(1<<index))!=0)
   if not selected.any():continue
   local=points[selected]-target;xy=np.stack([(local@right/span+.5)*size,(.5-local@up/span)*size],1)
   weight=map_coordinates(feather,[xy[:,1],xy[:,0]],order=1,mode='constant',cval=0)
   facing=np.clip((abs(normals[selected]@direction)-.2)/.3,0,1);weight*=facing*facing*(3-2*facing)
   value[selected]+=map_coordinates(field,[xy[:,1],xy[:,0]],order=1,mode='nearest')*weight;total[selected]+=weight
  return base*(1-np.minimum(total,1))+value/np.maximum(total,1e-12)*np.minimum(total,1)

 def independent_planes(self):
  names=['index','target','right','up','direction','span','size','region','roughness','feather','height']
  return [dict(zip(names,patch)) for independent,patch in zip(self.independent,self.patches) if independent]
