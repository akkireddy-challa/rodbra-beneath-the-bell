import type { GameConstants } from 'engine/Constants.js';
import { DEFAULT_CONSTANTS } from 'engine/Constants.js';

export const VOXEL_CONSTANTS: Partial<GameConstants> = {
    interactionRange: 4.5,
};

export const CONSTANTS: GameConstants = {
    ...DEFAULT_CONSTANTS,
    ...VOXEL_CONSTANTS,
};

export interface UpgradeState {
    temperedEdge: boolean;   // +15% sword damage (cost: 4 nails)
    wovenCharm: boolean;     // +20% max health (cost: 4 nails)
    quickenedWard: boolean;  // -20% ward recharge time (cost: 4 nails)
}

export interface PlayerStats {
    baseMaxHealth: number;
    currentHealth: number;
    rendMeter: number;        // 0 to 100
    wardCharges: number;      // 0 to 3
    wardRechargeTimer: number;// seconds
    wardMaxCharges: number;
    healCharges: number;      // 0 to 1
    healMaxCharges: number;
    ironNails: number;
    upgrades: UpgradeState;
    swordAcquired: boolean;
    activeCheckpointId: string;
    completedBosses: {
        hollowThrallTutorial: boolean;
        antlerMiniboss: boolean;
        millButcherBoss: boolean;
        bellMotherBoss: boolean;
    };
    unlockedShortcuts: {
        hushwoodGate: boolean;
        millGate: boolean;
    };
    currentZoneIndex: number;
}

export const INITIAL_PLAYER_STATS: PlayerStats = {
    baseMaxHealth: 100,
    currentHealth: 100,
    rendMeter: 0,
    wardCharges: 3,
    wardRechargeTimer: 0,
    wardMaxCharges: 3,
    healCharges: 1,
    healMaxCharges: 1,
    ironNails: 0,
    upgrades: {
        temperedEdge: false,
        wovenCharm: false,
        quickenedWard: false,
    },
    swordAcquired: false,
    activeCheckpointId: 'checkpoint_prologue',
    completedBosses: {
        hollowThrallTutorial: false,
        antlerMiniboss: false,
        millButcherBoss: false,
        bellMotherBoss: false,
    },
    unlockedShortcuts: {
        hushwoodGate: false,
        millGate: false,
    },
    currentZoneIndex: 0,
};

export const COMBAT_CONFIG = {
    lightAttack1: { damage: 22, duration: 0.45, hitWindow: [0.15, 0.3], range: 2.5, rendGain: 15 },
    lightAttack2: { damage: 26, duration: 0.48, hitWindow: [0.16, 0.32], range: 2.6, rendGain: 18 },
    lightAttack3: { damage: 38, duration: 0.65, hitWindow: [0.22, 0.42], range: 2.8, rendGain: 25 },
    heavyAttack: { minDamage: 45, maxDamage: 85, maxChargeTime: 1.2, duration: 0.75, hitWindow: [0.2, 0.45], range: 3.2, rendGain: 35 },
    sprintAttack: { damage: 32, duration: 0.5, hitWindow: [0.15, 0.32], range: 2.8, rendGain: 20 },
    dodgeAttack: { damage: 28, duration: 0.45, hitWindow: [0.12, 0.28], range: 2.5, rendGain: 20 },
    dodge: { duration: 0.55, iframes: [0.05, 0.35], speed: 9.0, cancelWindow: 0.35 },
    parry: { duration: 0.45, activeWindow: [0.05, 0.28], riposteWindow: 1.2 },
    riposte: { damage: 75, duration: 0.6, range: 2.8 },
    execution: { damage: 300, duration: 1.4, range: 2.0 },
    ward: { damage: 35, baseCooldown: 7.0, speed: 22.0, maxLifetime: 2.5, radius: 0.8 },
    healAmountPercent: 0.65,
};

export const NARRATION_LINES = [
    { text: "Winter, 1893. The mountain pass of Vargdal.", duration: 4.0 },
    { text: "Every church bell in the valley rang at once...", duration: 4.5 },
    { text: "...though their iron clappers were stripped years ago.", duration: 4.5 },
    { text: "The frost yields what was buried. Nameless dead rise.", duration: 4.5 },
    { text: "Liv Ravn returns for her sister Elin.", duration: 4.0 },
    { text: "Beneath the frozen church, an ancient voice screams.", duration: 4.5 },
];

export const SUBTITLES_ELIN = [
    "Liv... don't listen to the bronze...",
    "It needs a voice to keep the roots sleeping...",
    "If I stop singing, Vargdal drowns in ash...",
    "Sister... free me, or take my place...",
];

export const CREDITS_DATA = [
    { title: "RÖDBRÅ: Beneath the Bell", role: "A Nordic Folk-Horror Action Slasher" },
    { title: "Directed & Developed By", role: "Liv Ravn Pair-Programming Unit" },
    { title: "Engine & Platform", role: "Bitmagic GDK & WebGPU Engine" },
    { title: "Original Concept & Lore", role: "Winter 1893 Vargdal Chronicles" },
    { title: "Original Character Design", role: "Liv Ravn, Hardened Monster Hunter" },
    { title: "Atmosphere & World Design", role: "Hushwood, Red Mill, Bell Sanctuary" },
    { title: "Procedural Audio & Synthesis", role: "Scandinavian Nyckelharpa & Bronze Bell System" },
    { title: "Special Thanks", role: "All Souls Resonating Beneath the Bell" },
];
