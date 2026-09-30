import * as THREE from 'three';
import { projectEvents, projectEntities, DEFAULT_ENTITY_LIMIT } from 'engine/BmDebug.js';
import type { TimelineSession } from 'engine/recording/GameEventLog.js';
import type { RegisteredObject } from 'engine/ObjectIdService.js';

/**
 * Only the pure projections are tested — they define what crosses the
 * page.evaluate boundary out of the page, so what they drop matters as much
 * as what they keep. The window install itself is covered by verify's E2E.
 */

function session(events: TimelineSession['events']): TimelineSession {
    return { events, sounds: [], music: [], hud: [] };
}

describe('projectEvents', () => {
    it('keeps frame/type/intensity/position/actor and DROPS the open-ended data payload', () => {
        const projected = projectEvents(session([
            {
                frame: 120, type: 'player-death', intensity: 0.9,
                position: [1, 2, 3], actor: 'player',
                data: { html: '<script>anything</script>' },
            },
        ]));
        expect(projected).toEqual([
            { frame: 120, type: 'player-death', intensity: 0.9, position: [1, 2, 3], actor: 'player' },
        ]);
        expect(projected[0]).not.toHaveProperty('data');
    });

    it('leaves optional fields absent rather than undefined-valued', () => {
        const [projected] = projectEvents(session([{ frame: 0, type: 'state', intensity: 0 }]));
        expect('position' in projected).toBe(false);
        expect('actor' in projected).toBe(false);
    });
});

function entity(id: string, type: RegisteredObject['type'], position: [number, number, number], name = ''): RegisteredObject {
    const object = new THREE.Object3D();
    object.name = name;
    object.position.set(...position);
    return { id, type, object };
}

describe('projectEntities', () => {
    it('projects id/type/name and the WORLD position under parenting', () => {
        const parent = new THREE.Object3D();
        parent.position.set(10, 0, 0);
        const child = entity('obj_1', 'object', [1.234, 0, -2.567], 'crate');
        parent.add(child.object);
        parent.updateMatrixWorld(true);
        expect(projectEntities([child])).toEqual([
            { id: 'obj_1', type: 'object', name: 'crate', position: [11.23, 0, -2.57] },
        ]);
    });

    it('filters by type when asked', () => {
        const objects = [entity('a', 'asset', [0, 0, 0]), entity('m', 'marker', [1, 1, 1])];
        const markers = projectEntities(objects, 'marker');
        expect(markers.map((e) => e.id)).toEqual(['m']);
    });

    it('caps at the default limit — a huge world must not make the probe expensive', () => {
        const objects = Array.from({ length: DEFAULT_ENTITY_LIMIT + 50 }, (_, i) =>
            entity(`obj_${i}`, 'object', [i, 0, 0]));
        expect(projectEntities(objects)).toHaveLength(DEFAULT_ENTITY_LIMIT);
        expect(projectEntities(objects, undefined, 5)).toHaveLength(5);
    });

    it('reports null for a non-finite world position instead of leaking NaN', () => {
        const broken = entity('b', 'object', [Number.NaN, 0, 0]);
        expect(projectEntities([broken])[0].position).toBeNull();
    });
});
