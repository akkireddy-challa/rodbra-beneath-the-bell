"""Evaluate relief from an explicitly selected, locally planar tangent-normal patch.

Frankot/Chellappa (1988), discrete integration (eq.22). This does not recover a
donor's missing surface metric or turn an authored normal texture into a scan.
"""
import numpy as np
from scipy.ndimage import gaussian_filter

def integrate_slopes(dx,dy,spacing):
    dx=np.asarray(dx,float);dy=np.asarray(dy,float)
    if dx.shape!=dy.shape or dx.ndim!=2 or not np.isfinite(dx).all() or not np.isfinite(dy).all() or not np.isfinite(spacing) or spacing<=0:
        raise ValueError('Finite slope fields and positive spacing required')
    wx=2*np.pi*np.fft.fftfreq(dx.shape[1]);wy=2*np.pi*np.fft.fftfreq(dx.shape[0])
    ax=1j*np.sin(wx)[None,:]/spacing;ay=1j*np.sin(wy)[:,None]/spacing
    denominator=abs(ax)**2+abs(ay)**2
    numerator=ax.conj()*np.fft.fft2(dx)+ay.conj()*np.fft.fft2(dy)
    spectrum=np.zeros_like(numerator);valid=denominator>1e-12/spacing**2
    spectrum[valid]=numerator[valid]/denominator[valid]
    return np.fft.ifft2(spectrum).real

def normal_patch_height(rgb,width_m,normal_y,low_sigma_m=.00012,high_sigma_m=.004):
    rgb=np.asarray(rgb,float)
    if rgb.ndim!=3 or rgb.shape[2]!=3 or rgb.shape[0]!=rgb.shape[1] or min(rgb.shape[:2])<16:
        raise ValueError('A square, explicitly selected normal patch is required')
    if not np.isfinite(rgb).all() or np.any(rgb<0) or np.any(rgb>1) or not np.isfinite(width_m) or width_m<=0:
        raise ValueError('Normal values must be linear [0,1]; patch scale must be positive')
    if normal_y not in ['up','down'] or not 0<low_sigma_m<high_sigma_m<width_m/2:
        raise ValueError('Declare normal Y convention and valid physical filter widths')
    n=rgb*2-1
    if np.any(n[:,:,2]<.1):raise ValueError('Selected patch contains unsupported grazing/back-facing normals')
    dx=-n[:,:,0]/n[:,:,2];dy=n[:,:,1]/n[:,:,2]*(1 if normal_y=='up' else -1)
    # Even-reflected height has odd derivative across the corresponding boundary.
    # Integrate the resulting periodic extension, then retain the original patch.
    dx=np.concatenate([dx,-dx[:,::-1]],axis=1);dx=np.concatenate([dx,dx[::-1]],axis=0)
    dy=np.concatenate([dy,dy[:,::-1]],axis=1);dy=np.concatenate([dy,-dy[::-1]],axis=0)
    spacing=width_m/(len(rgb)-1)
    height=integrate_slopes(dx,dy,spacing)[:len(rgb),:len(rgb)]
    return gaussian_filter(height,low_sigma_m/spacing)-gaussian_filter(height,high_sigma_m/spacing)
