"""Select a local preview only after exact-asset rendering and recorded visual review.

This validates receipts. The agent supplies the visual verdict; no image classification
or whole-character acceptance is performed here.
"""
import argparse,hashlib,json,shutil,tempfile
from pathlib import Path

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def select(asset,render_report,visual_verdict,metadata,variant=None):
    asset,render_report,visual_verdict,metadata=map(Path,(asset,render_report,visual_verdict,metadata))
    sha=digest(asset);reports=json.loads(render_report.read_text());verdict=json.loads(visual_verdict.read_text());record=json.loads(metadata.read_text())
    if not isinstance(reports,list) or {row.get('backend') for row in reports}!={'webgl','webgpu'}:
        raise ValueError('Both rendering backends require current receipts')
    for row in reports:
        rendered=row.get('assetHashes',{}).get(variant) if variant else row.get('outputSha256')
        if rendered!=sha or row.get('actual')!=row['backend'] or row.get('errors')!=[]:
            raise ValueError('Rendering receipt is stale, failed, or used a fallback')
    if verdict.get('outputSha256')!=sha or verdict.get('status')!='local_preview_with_known_issues' or verdict.get('wholeCharacterAccepted') is not False:
        raise ValueError('Explicit current local-preview verdict required')
    images=verdict.get('visuallyInspected',[])
    if not images:raise ValueError('No inspected images recorded')
    for image in images:
        if digest(visual_verdict.parent/image['file'])!=image['sha256']:
            raise ValueError('Inspected image changed after visual review')
    if record.get('outputSha256',record.get('output_sha256'))!=sha:
        raise ValueError('Candidate metadata belongs to another asset')
    # Keep the last reviewed bytes independent of the next candidate build.
    # Publish the pointer only after the complete snapshot is safely in place.
    snapshots=asset.parent/'.previews';snapshots.mkdir(exist_ok=True)
    review_sha=hashlib.sha256(render_report.read_bytes()+visual_verdict.read_bytes()).hexdigest()
    (snapshots/sha).mkdir(exist_ok=True)
    destination=snapshots/sha/review_sha
    if not destination.exists():
        staging=Path(tempfile.mkdtemp(prefix='pending-',dir=snapshots))
        try:
            shutil.copyfile(asset,staging/asset.name)
            if digest(staging/asset.name)!=sha:raise ValueError('Candidate changed while snapshotting')
            saved_verdict=dict(verdict);saved_verdict['visuallyInspected']=[]
            for index,image in enumerate(images):
                source_image=visual_verdict.parent/image['file'];name=f"view-{index}{source_image.suffix}"
                shutil.copyfile(source_image,staging/name)
                if digest(staging/name)!=image['sha256']:raise ValueError('Inspected image changed while snapshotting')
                saved_verdict['visuallyInspected'].append(dict(image,file=name))
            (staging/'visual-verdict.json').write_text(json.dumps(saved_verdict,indent=2)+'\n')
            (staging/'render-report.json').write_text(json.dumps(reports,indent=2)+'\n')
            saved_record=dict(record,viewerReady=True,visualReview='visual-verdict.json')
            (staging/'metadata.json').write_text(json.dumps(saved_record,indent=2)+'\n')
            staging.replace(destination)
        finally:
            if staging.exists():shutil.rmtree(staging)
    elif digest(destination/asset.name)!=sha:
        raise ValueError('Previously selected snapshot is corrupted')
    pointer=asset.with_suffix('.selected.json');temporary_pointer=pointer.with_suffix('.tmp')
    temporary_pointer.write_text(json.dumps({'asset':str((destination/asset.name).relative_to(asset.parent)),
        'outputSha256':sha,'reviewSha256':review_sha,'status':'local_preview_with_known_issues','wholeCharacterAccepted':False},indent=2)+'\n')
    temporary_pointer.replace(pointer)
    record.update(viewerReady=True,visualReview=str(visual_verdict.resolve()))
    temporary=metadata.with_suffix('.preview.tmp')
    temporary.write_text(json.dumps(record,indent=2)+'\n');temporary.replace(metadata)
    return {'asset':str(asset),'outputSha256':sha,'status':'local_preview_with_known_issues'}



def selected_preview(asset):
    """Resolve a reviewed immutable snapshot without following arbitrary paths."""
    asset=Path(asset);pointer=asset.with_suffix('.selected.json')
    if not pointer.is_file():return None
    record=json.loads(pointer.read_text());sha=record.get('outputSha256','')
    if len(sha)!=64 or any(c not in '0123456789abcdef' for c in sha):raise ValueError('Invalid selected snapshot identity')
    review_sha=record.get('reviewSha256')
    if review_sha is not None and (len(review_sha)!=64 or any(c not in '0123456789abcdef' for c in review_sha)):raise ValueError('Invalid selected review identity')
    expected=Path('.previews')/sha
    if review_sha:expected/=review_sha
    expected/=asset.name
    if record.get('asset')!=str(expected) or record.get('wholeCharacterAccepted') is not False:raise ValueError('Invalid selected snapshot path or verdict')
    path=asset.parent/expected
    metadata=json.loads((path.parent/'metadata.json').read_text())
    if not path.is_file() or metadata.get('outputSha256',metadata.get('output_sha256'))!=sha or not metadata.get('viewerReady'):
        raise ValueError('Selected snapshot is incomplete')
    return path


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['asset','render-report','visual-verdict','metadata']:parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--variant',choices=['eyes','surfaces']);args=parser.parse_args()
    print(json.dumps(select(args.asset,args.render_report,args.visual_verdict,args.metadata,args.variant)))

