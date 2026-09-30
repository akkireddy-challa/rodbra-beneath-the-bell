import { envObjectCollides } from 'engine/template/EnvObjectCollision.js';

describe('envObjectCollides', () => {
    it('defaults to collidable when neither instance nor asset specifies a flag', () => {
        expect(envObjectCollides({}, {})).toBe(true);
        expect(envObjectCollides(undefined, undefined)).toBe(true);
        expect(envObjectCollides(null, null)).toBe(true);
    });

    it('opts out when the instance sets collision: false', () => {
        expect(envObjectCollides({ collision: false }, {})).toBe(false);
        expect(envObjectCollides({ collision: false }, { collision: true })).toBe(false);
    });

    it('opts out when only the asset sets collision: false', () => {
        expect(envObjectCollides({}, { collision: false })).toBe(false);
        expect(envObjectCollides(undefined, { collision: false })).toBe(false);
    });

    it('lets the per-instance flag override the asset-level default', () => {
        expect(envObjectCollides({ collision: true }, { collision: false })).toBe(true);
    });
});
