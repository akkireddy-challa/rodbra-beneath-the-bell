"""GLB binary array readers usable from Python and Blender without Pillow."""
import json,struct
import numpy as np

def read(path):
 raw=path.read_bytes();n=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+n]);off=20+n;size=struct.unpack_from('<I',raw,off)[0]
 return doc,bytearray(raw[off+8:off+8+size])

def accessor(doc,data,index):
 a=doc['accessors'][index];v=doc['bufferViews'][a['bufferView']]
 dt=np.dtype({5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[a['componentType']]);w={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
 return np.ndarray((a['count'],w),dtype=dt,buffer=data,offset=v.get('byteOffset',0)+a.get('byteOffset',0),strides=(v.get('byteStride',dt.itemsize*w),dt.itemsize)).copy()

