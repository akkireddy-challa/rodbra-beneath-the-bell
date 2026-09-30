import RAPIER3D from '@dimforge/rapier3d-compat';
import RAPIER2D from '@dimforge/rapier2d-compat';
import { QUERY_EXCLUDE_SENSORS } from 'engine/physics/QueryFilter.js';

describe('QUERY_EXCLUDE_SENSORS', () => {
    it('is the EXCLUDE_SENSORS flag of BOTH Rapier flavours', () => {
        // The enums are plain JS and need no wasm init.
        expect(RAPIER3D.QueryFilterFlags.EXCLUDE_SENSORS).toBe(QUERY_EXCLUDE_SENSORS);
        expect(RAPIER2D.QueryFilterFlags.EXCLUDE_SENSORS).toBe(QUERY_EXCLUDE_SENSORS);
    });
});
