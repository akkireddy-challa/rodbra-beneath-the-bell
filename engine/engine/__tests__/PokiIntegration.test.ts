/** @jest-environment jsdom */
import * as THREE from 'three';
import { GameState, GameStateManager } from 'engine/GameStateManager.js';
import { PokiIntegration } from 'engine/PokiIntegration.js';

jest.mock('engine/recording/GameEventLog.js', () => ({ getGameEventLog: () => ({ logEvent: () => {} }) }));

async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture() {
  const events: string[] = [];
  let finish = (): void => {};
  window.PokiSDK = {
    init: jest.fn(async () => { events.push('init'); }),
    gameLoadingFinished: () => { events.push('loaded'); },
    gameplayStart: () => { events.push('start'); },
    gameplayStop: () => { events.push('stop'); },
    commercialBreak: jest.fn(() => { events.push('ad'); return new Promise<void>((resolve) => { finish = resolve; }); }),
    setDebug: () => {},
  };
  const integration = new PokiIntegration();
  const manager = new GameStateManager(GameState.MENU, (resume) => integration.beforePlaying(resume));
  manager.addListener(integration.createStateListener());
  return { integration, manager, events, finish: () => finish() };
}
afterEach(() => { delete window.PokiSDK; });

it('keeps SDK-absent starts synchronous and deduplicates ordinary state changes', () => {
  const integration = new PokiIntegration();
  const manager = new GameStateManager(GameState.MENU, (resume) => integration.beforePlaying(resume));
  const changed = jest.fn(); manager.addListener(changed);
  manager.markPlaying(); manager.markPlaying();
  expect(manager.getCurrentState()).toBe(GameState.PLAYING);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('loads without an ad, then holds pause/input and restores volume while a resume ad runs', async () => {
  const f = fixture();
  const camera = new THREE.Camera();
  // Avoid Web Audio in jsdom while preserving the runtime instanceof check.
  const listener = Object.create(THREE.AudioListener.prototype) as THREE.AudioListener;
  let volume = 0.37;
  listener.getMasterVolume = () => volume;
  listener.setMasterVolume = (value) => { volume = value; return listener; };
  camera.children.push(listener);
  f.integration.setCameraGetter(() => camera);
  f.manager.transitionToLoading(); f.manager.transitionToMenu(); await flush();
  expect(f.events).toEqual(['init', 'loaded']);
  f.manager.markPlaying(); await flush();
  expect(f.events).toEqual(['init', 'loaded', 'start']);
  f.manager.setPaused(true); await flush();
  f.manager.setPaused(false); f.manager.setPaused(false); await flush();
  expect(f.manager.getCurrentState()).toBe(GameState.PAUSED);
  expect(volume).toBe(0);
  expect(window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true }))).toBe(false);
  expect(f.events).toEqual(['init', 'loaded', 'start', 'stop', 'ad']);
  f.finish(); await flush();
  expect(f.manager.getCurrentState()).toBe(GameState.PLAYING);
  expect(volume).toBe(0.37);
  expect(window.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true }))).toBe(true);
  expect(f.events.at(-1)).toBe('start');
});

it('does not resume a game that ended or reloaded during an advertisement', async () => {
  const f = fixture(); f.manager.markPlaying(); await flush();
  f.manager.setPaused(true); await flush(); f.manager.setPaused(false); await flush();
  f.manager.transitionToEnd(); f.finish(); await flush();
  expect(f.manager.getCurrentState()).toBe(GameState.END);
  expect(f.events.filter((e) => e === 'start')).toHaveLength(1);
});

it('does not emit loading events when a reset overlaps an advertisement', async () => {
  const f = fixture();
  const loading = jest.fn(); window.PokiSDK!.gameLoadingStart = loading;
  f.manager.markPlaying(); await flush();
  f.manager.setPaused(true); await flush(); f.manager.setPaused(false); await flush();
  f.manager.transitionToLoading(); await flush();
  expect(loading).not.toHaveBeenCalled();
  f.finish(); await flush();
  expect(f.manager.getCurrentState()).toBe(GameState.LOADING);
  expect(f.events.filter((event) => event === 'start')).toHaveLength(1);
});

it('continues playing when SDK initialization or an ad rejects', async () => {
  const f = fixture();
  window.PokiSDK!.init = jest.fn(async () => { throw new Error('ad blocked'); });
  await f.integration.init(); f.manager.markPlaying(); await flush();
  expect(f.manager.getCurrentState()).toBe(GameState.PLAYING);
  expect(f.events).toEqual([]);
  const second = fixture(); second.manager.markPlaying(); await flush();
  window.PokiSDK!.commercialBreak = async () => { throw new Error('no fill'); };
  second.manager.setPaused(true); await flush(); second.manager.setPaused(false); await flush();
  expect(second.manager.getCurrentState()).toBe(GameState.PLAYING);
});
