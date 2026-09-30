/**
 * Rapier query-filter flags as plain numbers.
 *
 * `RAPIER.QueryFilterFlags.EXCLUDE_SENSORS` is a VALUE read of the rapier3d
 * module. Code that runs on both physics lanes (the shared character movers)
 * must not read it: a 2D-only bundle stubs the 3D package to `null` and the
 * read throws at call time. The two packages define identical flag values, so
 * a plain constant serves both — `__tests__/QueryFilter.test.ts` pins it
 * against BOTH enums.
 */
export const QUERY_EXCLUDE_SENSORS = 8;
