/**
 * Keyring is a pure, engine-free data structure — grant/has/keys/onChanged.
 * See engine/doors/Keyring.ts for the contract.
 */
import { Keyring } from 'engine/doors/Keyring.js';

describe('Keyring', () => {
    it('starts with no keys', () => {
        const keyring = new Keyring();
        expect(keyring.keys()).toEqual([]);
        expect(keyring.has('golden_key')).toBe(false);
    });

    it('grant() adds a key that has() then reports', () => {
        const keyring = new Keyring();
        keyring.grant('golden_key');
        expect(keyring.has('golden_key')).toBe(true);
        expect(keyring.keys()).toEqual(['golden_key']);
    });

    it('duplicate grant() is idempotent — no duplicate entry, no extra event', () => {
        const keyring = new Keyring();
        const cb = jest.fn();
        keyring.onChanged(cb);

        keyring.grant('golden_key');
        keyring.grant('golden_key');
        keyring.grant('golden_key');

        expect(keyring.keys()).toEqual(['golden_key']);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('keys() preserves deterministic insertion order', () => {
        const keyring = new Keyring();
        keyring.grant('bronze_key');
        keyring.grant('golden_key');
        keyring.grant('silver_key');
        expect(keyring.keys()).toEqual(['bronze_key', 'golden_key', 'silver_key']);
    });

    it('onChanged fires exactly once per newly granted key, with the key id', () => {
        const keyring = new Keyring();
        const cb = jest.fn();
        keyring.onChanged(cb);

        keyring.grant('golden_key');
        keyring.grant('silver_key');

        expect(cb).toHaveBeenCalledTimes(2);
        expect(cb).toHaveBeenNthCalledWith(1, 'golden_key');
        expect(cb).toHaveBeenNthCalledWith(2, 'silver_key');
    });

    it('unsubscribe stops further notifications to that listener only', () => {
        const keyring = new Keyring();
        const cb1 = jest.fn();
        const cb2 = jest.fn();
        keyring.onChanged(cb1);
        const unsubscribe2 = keyring.onChanged(cb2);

        keyring.grant('golden_key');
        unsubscribe2();
        keyring.grant('silver_key');

        expect(cb1).toHaveBeenCalledTimes(2);
        expect(cb2).toHaveBeenCalledTimes(1);
        expect(cb2).toHaveBeenCalledWith('golden_key');
    });
});
