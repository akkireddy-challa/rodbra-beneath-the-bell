"""Shared embedded-GLB output helpers; no semantic classification."""
import io
import numpy as np
from PIL import Image

def image_array(doc,data,texture,mode='RGB'):
 im=doc['images'][doc['textures'][texture]['source']];v=doc['bufferViews'][im['bufferView']];start=v.get('byteOffset',0)
 return np.array(Image.open(io.BytesIO(data[start:start+v['byteLength']])).convert(mode))

def append_view(doc,data,raw):
 data.extend(b'\0'*((-len(data))%4));offset=len(data);data.extend(raw)
 doc['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':len(raw)});return len(doc['bufferViews'])-1

def append_accessor(doc,data,values,kind,component):
 view=append_view(doc,data,values.tobytes());doc['accessors'].append({'bufferView':view,'componentType':component,'count':len(values),'type':kind});return len(doc['accessors'])-1

def append_texture(doc,data,pixels,name,folder):
 im=Image.fromarray(pixels.astype(np.uint8));raw=io.BytesIO();im.save(raw,format='PNG');(folder/(name+'.png')).write_bytes(raw.getvalue())
 if not doc.get('samplers'):doc['samplers']=[{}]
 view=append_view(doc,data,raw.getvalue());doc['images'].append({'bufferView':view,'mimeType':'image/png','name':name});doc['textures'].append({'source':len(doc['images'])-1,'sampler':0});return len(doc['textures'])-1

