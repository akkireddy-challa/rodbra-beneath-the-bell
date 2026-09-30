import { HibernationComponent } from 'engine/character/HibernationComponent.js';
import { SimClass } from 'engine/character/CharacterLodScheduler.js';

describe('HibernationComponent sim class', () => {
    function make() {
        const calls: string[] = [];
        const comp = new HibernationComponent({
            onHibernate: () => calls.push('hib'),
            onWake: () => calls.push('wake'),
        });
        return { comp, calls };
    }

    test('defaults to FULL', () => {
        const { comp } = make();
        expect(comp.getSimClass()).toBe(SimClass.FULL);
    });

    test('setSimClass stores and reports', () => {
        const { comp } = make();
        comp.setSimClass(SimClass.VIRTUAL);
        expect(comp.getSimClass()).toBe(SimClass.VIRTUAL);
    });

    test('existing hibernate/wake behavior unchanged', () => {
        const { comp, calls } = make();
        comp.hibernate();
        comp.hibernate();
        comp.wake();
        expect(calls).toEqual(['hib', 'wake']);
    });
});
