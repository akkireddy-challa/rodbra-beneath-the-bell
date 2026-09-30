import { resolve as pathResolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const projectRoot = pathResolve('.');

export function resolve(specifier, context, nextResolve) {
    let target = specifier;

    if (target.startsWith('engine/')) {
        const sub = target.slice('engine/'.length);
        target = pathResolve(projectRoot, 'engine/engine', sub);
    } else if (target.startsWith('types/')) {
        const sub = target.slice('types/'.length);
        target = pathResolve(projectRoot, 'engine/types', sub);
    } else if (target.startsWith('work/')) {
        const sub = target.slice('work/'.length);
        target = pathResolve(projectRoot, 'src/work', sub);
    } else if (target.startsWith('.') && context.parentURL) {
        const parentPath = fileURLToPath(context.parentURL);
        const parentDir = pathResolve(parentPath, '..');
        target = pathResolve(parentDir, target);
    }

    if (typeof target === 'string' && target.startsWith('/')) {
        if (!existsSync(target) && target.endsWith('.js')) {
            const tsPath = target.slice(0, -3) + '.ts';
            if (existsSync(tsPath)) {
                return nextResolve(pathToFileURL(tsPath).href, context);
            }
        }
        if (existsSync(target)) {
            return nextResolve(pathToFileURL(target).href, context);
        }
    }

    return nextResolve(specifier, context);
}
