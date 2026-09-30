import * as THREE from 'three';

/**
 * Deduplicates Three.js geometries by dimensions.
 *
 * Instead of creating `new THREE.BoxGeometry(2,2,2)` for every snowball,
 * request one from the cache. Identical dimensions return the same instance.
 *
 * **Important:** Cached geometries are shared. Do NOT call `.dispose()` on
 * individual geometries — use `geoCache.dispose()` to clean up everything.
 */
export class GeometryCache {
    private boxes = new Map<string, THREE.BoxGeometry>();
    private spheres = new Map<string, THREE.SphereGeometry>();
    private cylinders = new Map<string, THREE.CylinderGeometry>();

    /** Get or create a BoxGeometry. Dimensions rounded to 2 decimals. */
    box(width: number, height: number, depth: number): THREE.BoxGeometry {
        return cached(
            this.boxes,
            `${r(width)},${r(height)},${r(depth)}`,
            () => new THREE.BoxGeometry(width, height, depth)
        );
    }

    /** Get or create a SphereGeometry. Default segments: 8w × 6h. */
    sphere(radius: number, widthSegments = 8, heightSegments = 6): THREE.SphereGeometry {
        return cached(
            this.spheres,
            `${r(radius)},${widthSegments},${heightSegments}`,
            () => new THREE.SphereGeometry(radius, widthSegments, heightSegments)
        );
    }

    /** Get or create a CylinderGeometry. Default segments: 8. */
    cylinder(
        radiusTop: number,
        radiusBottom: number,
        height: number,
        radialSegments = 8
    ): THREE.CylinderGeometry {
        return cached(
            this.cylinders,
            `${r(radiusTop)},${r(radiusBottom)},${r(height)},${radialSegments}`,
            () => new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)
        );
    }

    /** Total number of cached geometries. */
    get size(): number {
        return this.boxes.size + this.spheres.size + this.cylinders.size;
    }

    /** Dispose all cached geometries and clear the cache. */
    dispose(): void {
        for (const geo of this.boxes.values()) geo.dispose();
        for (const geo of this.spheres.values()) geo.dispose();
        for (const geo of this.cylinders.values()) geo.dispose();
        this.boxes.clear();
        this.spheres.clear();
        this.cylinders.clear();
    }
}

/** Return the geometry cached under `key`, creating and storing it on first use. */
function cached<T extends THREE.BufferGeometry>(map: Map<string, T>, key: string, create: () => T): T {
    let geo = map.get(key);
    if (!geo) {
        geo = create();
        map.set(key, geo);
    }
    return geo;
}

/** Round to 2 decimal places for key stability. */
function r(v: number): number {
    return Math.round(v * 100) / 100;
}
