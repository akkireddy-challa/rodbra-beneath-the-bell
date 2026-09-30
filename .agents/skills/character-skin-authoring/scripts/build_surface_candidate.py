"""Build reviewed evidence into a separate surface/eye/runtime candidate, fail-fast.

Authoring and visual acceptance remain agent tasks. This command never selects anatomy,
promotes viewer readiness, modifies the original model, or runs paid generation.
"""
import argparse,json,subprocess,sys
from pathlib import Path

from workspace_paths import workspace_root
ROOT=workspace_root(__file__)

def build(character,evidence,masks,eyes=None,assemble=False):
    base=ROOT/'characters'/character/'high/v1'
    for file in [evidence/'manifest.json',masks/'report.json',masks/'material-0-surface.npz',base/'materials/v2/face-detail.png',base/'materials/v2/face-expression.png',base/'materials/v2/scan-band-height-m.npy']:
        if not file.is_file():raise ValueError(f'Missing authored input: {file}')
    if eyes and json.loads(eyes.read_text())['id']!=character:raise ValueError('Eye profile character mismatch')
    def run(script,*args):
        subprocess.run([sys.executable,str(Path(__file__).resolve().parent/script),*map(str,args)],cwd=ROOT,check=True)
    run('vision_materials.py','--id',character,'--evidence',evidence,'--masks',masks)
    run('vision_blend_materials.py','--id',character,'--all-surfaces')
    if eyes:run('eye_assets.py','--profile',eyes)
    if assemble:
        run('assemble_character.py','--id',character,'--input','materials/v4/character.glb','--variant','surfaces')
        if eyes:run('assemble_character.py','--id',character,'--input','eyes/v1/character.glb','--variant','eyes')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--id',required=True);p.add_argument('--evidence',required=True,type=Path);p.add_argument('--masks',required=True,type=Path);p.add_argument('--eyes-profile',type=Path);p.add_argument('--assemble',action='store_true');a=p.parse_args()
    build(a.id,a.evidence.resolve(),a.masks.resolve(),a.eyes_profile.resolve() if a.eyes_profile else None,a.assemble)
