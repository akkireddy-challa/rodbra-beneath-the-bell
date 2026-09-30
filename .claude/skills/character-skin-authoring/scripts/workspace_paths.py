"""Explicit installed-workspace paths, with the existing playground layout retained."""
import os,shutil
from pathlib import Path

def workspace_root(module_file):
    configured=os.environ.get('BITMAGIC_CHARACTER_WORKSPACE')
    if configured:return Path(configured).expanduser().resolve()
    # Retain direct invocation in the source playground; installed callers use the runner.
    file=Path(module_file).absolute()
    if file.parent.name=='src' and file.parent.parent.name=='highquality':return file.parents[2]
    return Path.cwd().resolve()

def blender_executable():
    configured=os.environ.get('BITMAGIC_BLENDER')
    found=configured or shutil.which('blender')
    if not found and Path('/Applications/Blender.app/Contents/MacOS/Blender').is_file():found='/Applications/Blender.app/Contents/MacOS/Blender'
    if not found:raise FileNotFoundError('Set BITMAGIC_BLENDER to the local Blender executable')
    return found
