"""Run the reviewed character exporters from an installed skill and explicit workspace.

This assembles authored inputs. It performs no anatomical recognition, asset download,
paid generation, rig fitting or automatic visual acceptance.
"""
import argparse,json,os,re,subprocess,sys
from pathlib import Path

def command(args):
    root=args.workspace.expanduser().resolve()
    if not root.is_dir():raise ValueError('Workspace must be an existing directory')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*',args.id):raise ValueError('Character ID must be one path component')
    base=root/'characters'/args.id/'high/v1'
    if root not in base.resolve().parents:raise ValueError('Character output escapes workspace')
    def path(value):return (root/value).resolve() if value else None
    evidence,masks,eyes=map(path,[args.evidence,args.masks,args.eyes_profile])
    script=Path(__file__).resolve().parent;required=[]
    if args.stage=='face':
        required=[root/'highquality/materials/faces'/f'{args.id}.json',base/'source/hy31pro.glb',base/'output/viewer-profile.json']
        required += [root/'highquality/references/lee-perry-smith'/name for name in ['LeePerrySmith.glb','Infinite-Level_02_Disp_NoSmoothUV-4096.jpg','Map-COL.jpg']]
        argv=[sys.executable,str(script/'build_face_detail.py'),'--id',args.id]
    elif args.stage=='surfaces':
        if not evidence or not masks:raise ValueError('Surfaces require --evidence and --masks')
        required=[evidence/'manifest.json',masks/'report.json',masks/'material-0-surface.npz',base/'output/viewer-profile.json',root/'highquality/materials/faces'/f'{args.id}.json']
        required += [base/'materials/v2'/name for name in ['face-detail.png','face-expression.png','scan-band-height-m.npy','ATTRIBUTION.txt']]
        argv=[sys.executable,str(script/'build_surface_candidate.py'),'--id',args.id,'--evidence',str(evidence),'--masks',str(masks)]
        if eyes:argv+=['--eyes-profile',str(eyes)]
        if args.assemble:argv+=['--assemble']
    elif args.stage=='eyes':
        if not eyes:raise ValueError('Eyes require --eyes-profile')
        argv=[sys.executable,str(script/'eye_assets.py'),'--profile',str(eyes)]
    else:
        required=[base/args.input]
        argv=[sys.executable,str(script/'assemble_character.py'),'--id',args.id,'--input',args.input,'--variant',args.variant]
    if eyes:
        required += [eyes,root/'highquality/references/makehuman-eyes/blue_eye.png',root/'highquality/references/makehuman-eyes/LICENSE.md']
        if eyes.is_file() and json.loads(eyes.read_text()).get('id')!=args.id:raise ValueError('Eye profile character mismatch')
    if args.assemble or args.stage=='assemble':required += [base/'output/character.glb',base/'rig-report.json']
    missing=[str(p) for p in required if not p.is_file()]
    if missing:raise ValueError('Missing authored inputs:\n'+'\n'.join(missing))
    return root,argv,required

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--workspace',required=True,type=Path);p.add_argument('--id',required=True)
    p.add_argument('--stage',choices=['face','surfaces','eyes','assemble'],default='surfaces')
    p.add_argument('--evidence',type=Path);p.add_argument('--masks',type=Path);p.add_argument('--eyes-profile',type=Path)
    p.add_argument('--assemble',action='store_true');p.add_argument('--input',default='eyes/v1/character.glb');p.add_argument('--variant',choices=['eyes','surfaces'],default='eyes')
    p.add_argument('--check',action='store_true',help='Check required inputs without modifying assets; exporters validate their full contracts when run')
    args=p.parse_args();root,argv,required=command(args)
    if args.check:print(json.dumps({'status':'inputs_present_not_visual_acceptance','workspace':str(root),'stage':args.stage,'requiredFiles':len(required)}));return
    subprocess.run(argv,cwd=root,env={**os.environ,'BITMAGIC_CHARACTER_WORKSPACE':str(root)},check=True)

if __name__=='__main__':main()
