/**
 * RÖDBRÅ: Beneath the Bell — Complete UI & HUD System
 * Follows the UI Reference sheet:
 * - Charcoal wood and oxidized-iron borders
 * - Ivory / antique-white typography (Cinzel / serif)
 * - Deep crimson highlights (#9C1C1C)
 * - Upper-left Health & Rend meters, Ward and Flask counters
 * - Top-center fading objective banner
 * - Bottom-center segmented boss health bar
 * - Interactive prompts with keyboard and gamepad glyphs
 * - Start Menu, Cutscene, Checkpoint Upgrades, Pause, Settings, Accessibility, Death, Ending Choice & Credits
 */

import { audio } from './AudioSystem.js';
import { type PlayerStats, NARRATION_LINES, CREDITS_DATA } from './Constants.js';
import type { GoreLevel } from './CombatSystem.js';
import { SaveGameService } from './SaveGameService.js';

export interface UIStateCallbacks {
    onStartGame: () => void;
    onNewGame?: () => void;
    onResumeGame: () => void;
    onRestartCheckpoint: () => void;
    onQuitToTitle: () => void;
    onApplySettings: (settings: UISettings) => void;
    onFinalChoice: (choice: 'break_seal' | 'offer_blood') => void;
    onUpgradePurchased?: () => void;
}

export interface UISettings {
    masterVolume: number;
    musicVolume: number;
    sfxVolume: number;
    voiceVolume: number;
    sensitivity: number;
    invertY: boolean;
    cameraShake: number;
    quality: 'low' | 'medium' | 'high';
    gore: GoreLevel;
    subtitles: boolean;
    subtitleSize: 'small' | 'medium' | 'large';
    subtitlesOpacity: number;
    uiScale: number;
    highContrast: boolean;
    sprintToggle: boolean;
    lockToggle: boolean;
    aimAssist: 'off' | 'normal' | 'strong';
    colorSafe: boolean;
    reduceFlashes: boolean;
    difficulty: 'story' | 'standard' | 'hard';
}

export class UIManager {
    private container: HTMLElement;
    private stats: PlayerStats;
    private callbacks: UIStateCallbacks;

    // View states
    public currentScreen: 'title' | 'intro' | 'gameplay' | 'pause' | 'settings' | 'accessibility' | 'checkpoint' | 'death' | 'choice' | 'credits' = 'title';
    public activeModal: 'none' | 'settings' | 'accessibility' | 'checkpoint' = 'none';
    private continueBtn: HTMLButtonElement | null = null;

    // HUD Elements
    private hudRoot!: HTMLElement;
    private healthFill!: HTMLElement;
    private healthText!: HTMLElement;
    private rendFill!: HTMLElement;
    private rendGlow!: HTMLElement;
    private wardContainer!: HTMLElement;
    private flaskContainer!: HTMLElement;
    private nailCountText!: HTMLElement;
    private objectiveTitle!: HTMLElement;
    private objectiveSub!: HTMLElement;
    private objectiveRoot!: HTMLElement;
    private promptRoot!: HTMLElement;
    private promptKey!: HTMLElement;
    private promptText!: HTMLElement;
    private bossRoot!: HTMLElement;
    private bossNameText!: HTMLElement;
    private bossFill!: HTMLElement;

    // Fullscreen Overlay Containers
    private titleScreenRoot!: HTMLElement;
    private introRoot!: HTMLElement;
    private pauseRoot!: HTMLElement;
    private modalRoot!: HTMLElement;
    private deathRoot!: HTMLElement;
    private choiceRoot!: HTMLElement;
    private creditsRoot!: HTMLElement;

    // Subtitle element
    private subtitleText!: HTMLElement;

    // State settings
    public settings: UISettings = {
        masterVolume: 0.8,
        musicVolume: 0.65,
        sfxVolume: 0.85,
        voiceVolume: 0.9,
        sensitivity: 5,
        invertY: false,
        cameraShake: 1.0,
        quality: 'high',
        gore: 'full',
        subtitles: true,
        subtitleSize: 'medium',
        subtitlesOpacity: 0.8,
        uiScale: 1.0,
        highContrast: false,
        sprintToggle: false,
        lockToggle: true,
        aimAssist: 'normal',
        colorSafe: false,
        reduceFlashes: false,
        difficulty: 'standard',
    };

    private isGamepadConnected: boolean = false;
    private introTimer: number = 0;
    private introIndex: number = 0;
    private isIntroPlaying: boolean = false;

    constructor(stats: PlayerStats, callbacks: UIStateCallbacks) {
        this.stats = stats;
        this.callbacks = callbacks;

        // Create main container stacking inside engine UI layer
        this.container = document.createElement('div');
        this.container.id = 'rodbra-ui-container';
        this.applyGlobalStyles();
        document.body.appendChild(this.container);

        this.buildHUD();
        this.buildTitleScreen();
        this.buildIntroOverlay();
        this.buildPauseMenu();
        this.buildModals();
        this.buildDeathOverlay();
        this.buildChoiceModal();
        this.buildCreditsScreen();

        this.setupInputDetection();
        this.loadSettingsFromStorage();
    }

    private applyGlobalStyles(): void {
        const style = document.createElement('style');
        style.textContent = `
            #rodbra-ui-container {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                pointer-events: none;
                z-index: 9999;
                font-family: 'Cinzel', serif, -apple-system, BlinkMacSystemFont;
                user-select: none;
                color: #E8E2D8;
                overflow: hidden;
            }
            .interactive-panel {
                pointer-events: auto;
                background: #0E0C0B;
                border: 2px solid #2A2220;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.85);
            }
            .rodbra-btn {
                background: #1C1816;
                color: #E8E2D8;
                border: 1px solid #3A2F2B;
                padding: 10px 24px;
                font-size: 16px;
                font-family: inherit;
                letter-spacing: 1.5px;
                text-transform: uppercase;
                cursor: pointer;
                transition: all 0.15s ease;
                display: block;
                width: 100%;
                text-align: center;
                margin-bottom: 12px;
            }
            .rodbra-btn:hover {
                background: #9C1C1C;
                color: #FFFFFF;
                border-color: #E62424;
                box-shadow: 0 0 12px rgba(156, 28, 28, 0.6);
            }
            .rodbra-btn:disabled {
                opacity: 0.35;
                cursor: not-allowed;
                border-color: #222;
                background: #111;
            }
            .rodbra-bar-bg {
                background: #141210;
                border: 1px solid #2C2422;
                box-shadow: inset 0 2px 4px rgba(0,0,0,0.8);
            }
            .rodbra-key-hint {
                background: #242220;
                border: 1px solid #4D443E;
                color: #FFFFFF;
                padding: 3px 8px;
                font-size: 13px;
                border-radius: 3px;
                margin-right: 8px;
                font-weight: bold;
            }
        `;
        document.head.appendChild(style);
    }

    // =========================================================================
    // GAMEPLAY HUD
    // =========================================================================

    private buildHUD(): void {
        this.hudRoot = document.createElement('div');
        this.hudRoot.style.cssText = 'position: absolute; width: 100%; height: 100%; display: none;';

        // 1. Upper Left Status Bars & Counters
        const statusBox = document.createElement('div');
        statusBox.style.cssText = 'position: absolute; top: 24px; left: 32px; width: 340px;';

        // Health bar
        const hpLabel = document.createElement('div');
        hpLabel.style.cssText = 'font-size: 13px; letter-spacing: 2px; color: #8A8278; margin-bottom: 4px; display: flex; justify-content: space-between;';
        hpLabel.innerHTML = '<span>LIV RAVN</span><span id="rodbra-hp-text">100 / 100</span>';
        statusBox.appendChild(hpLabel);
        this.healthText = hpLabel.querySelector('#rodbra-hp-text') as HTMLElement;

        const hpBarBg = document.createElement('div');
        hpBarBg.className = 'rodbra-bar-bg';
        hpBarBg.style.cssText = 'width: 100%; height: 16px; position: relative; margin-bottom: 6px;';
        this.healthFill = document.createElement('div');
        this.healthFill.style.cssText = 'width: 100%; height: 100%; background: linear-gradient(90deg, #6B1010, #C71A1A); transition: width 0.15s ease;';
        hpBarBg.appendChild(this.healthFill);
        statusBox.appendChild(hpBarBg);

        // Rend meter
        const rendBarBg = document.createElement('div');
        rendBarBg.className = 'rodbra-bar-bg';
        rendBarBg.style.cssText = 'width: 100%; height: 8px; position: relative; margin-bottom: 12px;';
        this.rendFill = document.createElement('div');
        this.rendFill.style.cssText = 'width: 0%; height: 100%; background: linear-gradient(90deg, #A86518, #E59828); transition: width 0.1s ease;';
        rendBarBg.appendChild(this.rendFill);
        this.rendGlow = document.createElement('div');
        this.rendGlow.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; box-shadow: 0 0 10px #FF9F1C; opacity: 0; transition: opacity 0.2s ease;';
        rendBarBg.appendChild(this.rendGlow);
        statusBox.appendChild(rendBarBg);

        // Sub-bar charges (Wards & Flask)
        const chargesRow = document.createElement('div');
        chargesRow.style.cssText = 'display: flex; align-items: center; gap: 16px; font-size: 14px;';

        // Ward charges (3 diamond icons)
        this.wardContainer = document.createElement('div');
        this.wardContainer.style.cssText = 'display: flex; gap: 6px; align-items: center;';
        this.updateWardIcons(3);
        chargesRow.appendChild(this.wardContainer);

        // Health flask
        this.flaskContainer = document.createElement('div');
        this.flaskContainer.style.cssText = 'display: flex; align-items: center; gap: 6px;';
        this.flaskContainer.innerHTML = '<span style="color:#C71A1A; font-size:18px;">⚱</span> <span id="rodbra-flask-count">1</span>';
        chargesRow.appendChild(this.flaskContainer);

        // Iron nails currency
        const nailRow = document.createElement('div');
        nailRow.style.cssText = 'display: flex; align-items: center; gap: 6px; color: #B0A89C; margin-left: auto;';
        nailRow.innerHTML = '<span style="font-size:16px;">🔩</span> <span id="rodbra-nail-count">0</span>';
        this.nailCountText = nailRow.querySelector('#rodbra-nail-count') as HTMLElement;
        chargesRow.appendChild(nailRow);

        statusBox.appendChild(chargesRow);
        this.hudRoot.appendChild(statusBox);

        // 2. Top-Center Objective Banner
        this.objectiveRoot = document.createElement('div');
        this.objectiveRoot.style.cssText = 'position: absolute; top: 24px; left: 50%; transform: translateX(-50%); text-align: center; pointer-events: none; opacity: 1; transition: opacity 0.8s ease;';
        this.objectiveTitle = document.createElement('div');
        this.objectiveTitle.style.cssText = 'font-size: 20px; letter-spacing: 3px; font-weight: bold; color: #FFFFFF; text-shadow: 0 2px 8px #000;';
        this.objectiveTitle.textContent = 'THE LAST RING';
        this.objectiveSub = document.createElement('div');
        this.objectiveSub.style.cssText = 'font-size: 14px; font-style: italic; color: #8A8278; margin-top: 4px;';
        this.objectiveSub.textContent = 'Draw the seax blade from the stone altar.';
        this.objectiveRoot.appendChild(this.objectiveTitle);
        this.objectiveRoot.appendChild(this.objectiveSub);
        this.hudRoot.appendChild(this.objectiveRoot);

        // 3. Interaction Prompt (Bottom Left / Contextual)
        this.promptRoot = document.createElement('div');
        this.promptRoot.style.cssText = 'position: absolute; bottom: 36px; left: 40px; display: none; align-items: center; background: rgba(14,12,11,0.85); padding: 8px 16px; border: 1px solid #3A2F2B; border-radius: 4px;';
        this.promptKey = document.createElement('span');
        this.promptKey.className = 'rodbra-key-hint';
        this.promptKey.textContent = 'E';
        this.promptText = document.createElement('span');
        this.promptText.style.cssText = 'font-size: 15px; color: #E8E2D8;';
        this.promptRoot.appendChild(this.promptKey);
        this.promptRoot.appendChild(this.promptText);
        this.hudRoot.appendChild(this.promptRoot);

        // 4. Boss Health Bar (Bottom Center)
        this.bossRoot = document.createElement('div');
        this.bossRoot.style.cssText = 'position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%); width: 540px; text-align: center; display: none;';
        this.bossNameText = document.createElement('div');
        this.bossNameText.style.cssText = 'font-size: 16px; letter-spacing: 3px; font-weight: bold; color: #E8E2D8; margin-bottom: 6px; text-shadow: 0 2px 4px #000;';
        this.bossNameText.textContent = 'THE BELL MOTHER';
        this.bossRoot.appendChild(this.bossNameText);

        const bossBarBg = document.createElement('div');
        bossBarBg.className = 'rodbra-bar-bg';
        bossBarBg.style.cssText = 'width: 100%; height: 18px; border: 2px solid #3A2F2B;';
        this.bossFill = document.createElement('div');
        this.bossFill.style.cssText = 'width: 100%; height: 100%; background: linear-gradient(90deg, #7A1212, #D42424); transition: width 0.15s ease;';
        bossBarBg.appendChild(this.bossFill);
        this.bossRoot.appendChild(bossBarBg);
        this.hudRoot.appendChild(this.bossRoot);

        // 5. Subtitles Bar (Bottom Center above boss / prompts)
        this.subtitleText = document.createElement('div');
        this.subtitleText.style.cssText = 'position: absolute; bottom: 90px; left: 50%; transform: translateX(-50%); font-size: 18px; color: #F0EDE6; text-shadow: 0 2px 6px #000; background: rgba(0,0,0,0.7); padding: 6px 20px; border-radius: 4px; display: none; max-width: 700px; text-align: center;';
        this.hudRoot.appendChild(this.subtitleText);

        this.container.appendChild(this.hudRoot);
    }

    public updateHUD(stats: PlayerStats, activeBoss: any | null, currentObjective?: { title: string; sub: string }): void {
        this.stats = stats;
        const maxHp = stats.upgrades.wovenCharm ? stats.baseMaxHealth * 1.2 : stats.baseMaxHealth;
        const hpPercent = Math.max(0, Math.min(100, (stats.currentHealth / maxHp) * 100));
        this.healthFill.style.width = `${hpPercent}%`;
        this.healthText.textContent = `${Math.ceil(stats.currentHealth)} / ${Math.ceil(maxHp)}`;

        this.rendFill.style.width = `${stats.rendMeter}%`;
        this.rendGlow.style.opacity = stats.rendMeter >= 100 ? '1' : '0';

        this.updateWardIcons(stats.wardCharges);

        const flaskElem = this.flaskContainer.querySelector('#rodbra-flask-count');
        if (flaskElem) flaskElem.textContent = `${stats.healCharges}`;

        this.nailCountText.textContent = `${stats.ironNails}`;

        if (activeBoss && activeBoss.state !== 'dead') {
            this.bossRoot.style.display = 'block';
            this.bossNameText.textContent = activeBoss.name.toUpperCase();
            const bossHpPercent = Math.max(0, Math.min(100, (activeBoss.stats.currentHealth / activeBoss.stats.maxHealth) * 100));
            this.bossFill.style.width = `${bossHpPercent}%`;
        } else {
            this.bossRoot.style.display = 'none';
        }

        if (currentObjective) {
            this.objectiveTitle.textContent = currentObjective.title;
            this.objectiveSub.textContent = currentObjective.sub;
            this.objectiveRoot.style.opacity = '1';
        }
    }

    private updateWardIcons(charges: number): void {
        this.wardContainer.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            const diamond = document.createElement('span');
            diamond.style.cssText = `font-size: 16px; color: ${i < charges ? '#5B90A8' : '#333A40'}; text-shadow: ${i < charges ? '0 0 6px #5B90A8' : 'none'};`;
            diamond.textContent = '◆';
            this.wardContainer.appendChild(diamond);
        }
    }

    public showInteractionPrompt(text: string, customKey?: string): void {
        this.promptRoot.style.display = 'flex';
        this.promptKey.textContent = customKey || (this.isGamepadConnected ? 'X' : 'E');
        this.promptText.textContent = text;
    }

    public hideInteractionPrompt(): void {
        this.promptRoot.style.display = 'none';
    }

    public showSubtitle(speaker: string, text: string, durationMs: number = 4000): void {
        if (!this.settings.subtitles) return;
        this.subtitleText.innerHTML = `<span style="color:#C71A1A; font-weight:bold;">${speaker}:</span> ${text}`;
        this.subtitleText.style.display = 'block';
        setTimeout(() => {
            if (this.subtitleText.innerHTML.includes(text)) {
                this.subtitleText.style.display = 'none';
            }
        }, durationMs);
    }

    // =========================================================================
    // START / TITLE SCREEN
    // =========================================================================

    private buildTitleScreen(): void {
        this.titleScreenRoot = document.createElement('div');
        this.titleScreenRoot.className = 'interactive-panel';
        this.titleScreenRoot.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: none; flex-direction: column; justify-content: center; align-items: flex-start; padding-left: 8vw; background: radial-gradient(circle at 70% 50%, rgba(10,12,14,0.4), rgba(4,4,5,0.95)), #080808;';

        const logoGroup = document.createElement('div');
        logoGroup.style.cssText = 'margin-bottom: 40px;';
        const title = document.createElement('h1');
        title.style.cssText = 'font-size: 56px; letter-spacing: 8px; margin: 0; color: #FFFFFF; text-shadow: 0 4px 16px rgba(0,0,0,0.9); font-weight: 700;';
        title.innerHTML = 'RÖDBRÅ';
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size: 18px; letter-spacing: 4px; color: #8A8278; margin-top: 6px; font-weight: 400;';
        sub.textContent = 'BENEATH THE BELL';
        logoGroup.appendChild(title);
        logoGroup.appendChild(sub);
        this.titleScreenRoot.appendChild(logoGroup);

        const menuBtns = document.createElement('div');
        menuBtns.style.cssText = 'width: 260px;';

        const continueBtn = document.createElement('button');
        continueBtn.className = 'rodbra-btn';
        continueBtn.textContent = 'CONTINUE';
        this.continueBtn = continueBtn;
        const hasSave = SaveGameService.hasSave();
        continueBtn.disabled = !hasSave;
        continueBtn.onclick = () => {
            audio.playUIConfirm();
            this.callbacks.onResumeGame();
        };
        menuBtns.appendChild(continueBtn);

        const newGameBtn = document.createElement('button');
        newGameBtn.className = 'rodbra-btn';
        newGameBtn.textContent = 'NEW GAME';
        newGameBtn.onclick = () => {
            audio.playUIConfirm();
            const currentHasSave = SaveGameService.hasSave();
            if (currentHasSave) {
                if (confirm('Start a new game and overwrite existing progress?')) {
                    if (this.callbacks.onNewGame) {
                        this.callbacks.onNewGame();
                    } else {
                        this.startIntroSequence();
                    }
                }
            } else {
                if (this.callbacks.onNewGame) {
                    this.callbacks.onNewGame();
                } else {
                    this.startIntroSequence();
                }
            }
        };
        menuBtns.appendChild(newGameBtn);

        const settingsBtn = document.createElement('button');
        settingsBtn.className = 'rodbra-btn';
        settingsBtn.textContent = 'SETTINGS';
        settingsBtn.onclick = () => {
            audio.playUIConfirm();
            this.openSettingsModal();
        };
        menuBtns.appendChild(settingsBtn);

        const accessBtn = document.createElement('button');
        accessBtn.className = 'rodbra-btn';
        accessBtn.textContent = 'ACCESSIBILITY';
        accessBtn.onclick = () => {
            audio.playUIConfirm();
            this.openAccessibilityModal();
        };
        menuBtns.appendChild(accessBtn);

        const creditsBtn = document.createElement('button');
        creditsBtn.className = 'rodbra-btn';
        creditsBtn.textContent = 'CREDITS';
        creditsBtn.onclick = () => {
            audio.playUIConfirm();
            this.openCredits();
        };
        menuBtns.appendChild(creditsBtn);

        this.titleScreenRoot.appendChild(menuBtns);
        this.container.appendChild(this.titleScreenRoot);
    }

    // =========================================================================
    // IN-ENGINE INTRODUCTION SEQUENCE (35-45 seconds, skippable)
    // =========================================================================

    private buildIntroOverlay(): void {
        this.introRoot = document.createElement('div');
        this.introRoot.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: none; pointer-events: none;';

        // Initial black fade curtain (fades out in 0.8s)
        const curtain = document.createElement('div');
        curtain.id = 'rodbra-intro-curtain';
        curtain.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #000000; pointer-events: none; opacity: 1; transition: opacity 0.8s ease; z-index: 1;';
        this.introRoot.appendChild(curtain);

        // Cinematic top letterbox bar
        const topBar = document.createElement('div');
        topBar.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 11vh; background: linear-gradient(180deg, rgba(8,7,6,0.96) 0%, rgba(8,7,6,0.85) 80%, rgba(8,7,6,0) 100%); display: flex; align-items: center; justify-content: space-between; padding: 0 48px; box-sizing: border-box; z-index: 2;';
        const brandTitle = document.createElement('div');
        brandTitle.style.cssText = 'font-size: 16px; letter-spacing: 5px; color: #E8E2D8; font-weight: 700;';
        brandTitle.innerHTML = 'RÖDBRÅ <span style="color:#C71A1A; font-weight:normal; font-size:12px; margin-left:8px;">BENEATH THE BELL</span>';
        const chapterTitle = document.createElement('div');
        chapterTitle.style.cssText = 'font-size: 13px; letter-spacing: 3px; color: #8A8278; text-transform: uppercase;';
        chapterTitle.textContent = 'Winter 1893 — Vargdal';
        topBar.appendChild(brandTitle);
        topBar.appendChild(chapterTitle);
        this.introRoot.appendChild(topBar);

        // Cinematic bottom letterbox bar
        const bottomBar = document.createElement('div');
        bottomBar.style.cssText = 'position: absolute; bottom: 0; left: 0; width: 100%; height: 20vh; background: linear-gradient(0deg, rgba(8,7,6,0.96) 0%, rgba(8,7,6,0.85) 75%, rgba(8,7,6,0) 100%); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 48px; box-sizing: border-box; z-index: 2;';

        const introText = document.createElement('div');
        introText.id = 'rodbra-intro-text';
        introText.style.cssText = 'font-size: 21px; letter-spacing: 2px; max-width: 820px; text-align: center; line-height: 1.6; color: #E8E2D8; text-shadow: 0 2px 10px rgba(0,0,0,0.95); font-style: italic; transition: opacity 0.8s ease; opacity: 0;';
        bottomBar.appendChild(introText);

        const skipHint = document.createElement('div');
        skipHint.style.cssText = 'position: absolute; bottom: 16px; right: 40px; font-size: 12px; color: #7A7268; letter-spacing: 1px; cursor: pointer; pointer-events: auto;';
        skipHint.innerHTML = 'Press <span class="rodbra-key-hint">ANY KEY / CLICK</span> to Skip';
        skipHint.onclick = () => this.finishIntro();
        bottomBar.appendChild(skipHint);

        this.introRoot.appendChild(bottomBar);
        this.container.appendChild(this.introRoot);
    }

    public startIntroSequence(): void {
        this.currentScreen = 'intro';
        this.titleScreenRoot.style.display = 'none';
        this.introRoot.style.display = 'block';
        this.isIntroPlaying = true;
        this.introIndex = 0;

        const curtain = this.introRoot.querySelector('#rodbra-intro-curtain') as HTMLElement;
        if (curtain) {
            curtain.style.opacity = '1';
            setTimeout(() => {
                curtain.style.opacity = '0';
            }, 300);
        }

        audio.init();
        audio.setMusicMode('exploration');
        audio.playBellToll('distant');

        this.playNextIntroLine();
    }

    private playNextIntroLine(): void {
        if (!this.isIntroPlaying) return;
        if (this.introIndex >= NARRATION_LINES.length) {
            this.finishIntro();
            return;
        }

        const line = NARRATION_LINES[this.introIndex]!;
        const textElem = this.introRoot.querySelector('#rodbra-intro-text') as HTMLElement;
        if (textElem) {
            textElem.style.opacity = '0';
            setTimeout(() => {
                textElem.textContent = line.text;
                textElem.style.opacity = '1';
                audio.playFootstep('snow');
            }, 600);
        }

        this.introTimer = window.setTimeout(() => {
            this.introIndex++;
            this.playNextIntroLine();
        }, line.duration * 1000);
    }

    public finishIntro(): void {
        if (!this.isIntroPlaying) return;
        this.isIntroPlaying = false;
        clearTimeout(this.introTimer);

        // Immediately transition screen and start gameplay callbacks
        this.showGameplay();
        this.callbacks.onStartGame();

        // Fade out intro root
        this.introRoot.style.transition = 'opacity 0.4s ease';
        this.introRoot.style.opacity = '0';
        setTimeout(() => {
            this.introRoot.style.display = 'none';
            this.introRoot.style.opacity = '1';
        }, 400);
    }

    public showGameplay(): void {
        this.currentScreen = 'gameplay';
        this.titleScreenRoot.style.display = 'none';
        this.introRoot.style.display = 'none';
        this.pauseRoot.style.display = 'none';
        this.modalRoot.style.display = 'none';
        this.deathRoot.style.display = 'none';
        this.choiceRoot.style.display = 'none';
        this.creditsRoot.style.display = 'none';
        this.activeModal = 'none';
        this.hudRoot.style.display = 'block';
    }

    public isIntroActive(): boolean {
        return this.isIntroPlaying;
    }

    // =========================================================================
    // PAUSE MENU
    // =========================================================================

    private buildPauseMenu(): void {
        this.pauseRoot = document.createElement('div');
        this.pauseRoot.className = 'interactive-panel';
        this.pauseRoot.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(8,7,6,0.88); display: none; justify-content: center; align-items: center;';

        const pauseCard = document.createElement('div');
        pauseCard.style.cssText = 'width: 320px; text-align: center;';

        const pauseHeader = document.createElement('h2');
        pauseHeader.style.cssText = 'font-size: 28px; letter-spacing: 5px; color: #FFFFFF; margin-bottom: 28px;';
        pauseHeader.textContent = 'PAUSED';
        pauseCard.appendChild(pauseHeader);

        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'rodbra-btn';
        resumeBtn.textContent = 'RESUME';
        resumeBtn.onclick = () => {
            audio.playUIConfirm();
            this.closePauseMenu();
        };
        pauseCard.appendChild(resumeBtn);

        const restartCpBtn = document.createElement('button');
        restartCpBtn.className = 'rodbra-btn';
        restartCpBtn.textContent = 'RESTART CHECKPOINT';
        restartCpBtn.onclick = () => {
            audio.playUIConfirm();
            this.closePauseMenu();
            this.callbacks.onRestartCheckpoint();
        };
        pauseCard.appendChild(restartCpBtn);

        const settingsBtn = document.createElement('button');
        settingsBtn.className = 'rodbra-btn';
        settingsBtn.textContent = 'SETTINGS';
        settingsBtn.onclick = () => {
            audio.playUIConfirm();
            this.openSettingsModal();
        };
        pauseCard.appendChild(settingsBtn);

        const accessBtn = document.createElement('button');
        accessBtn.className = 'rodbra-btn';
        accessBtn.textContent = 'ACCESSIBILITY';
        accessBtn.onclick = () => {
            audio.playUIConfirm();
            this.openAccessibilityModal();
        };
        pauseCard.appendChild(accessBtn);

        const quitBtn = document.createElement('button');
        quitBtn.className = 'rodbra-btn';
        quitBtn.textContent = 'QUIT TO TITLE';
        quitBtn.onclick = () => {
            audio.playUIBack();
            this.closePauseMenu();
            this.returnToTitle();
        };
        pauseCard.appendChild(quitBtn);

        this.pauseRoot.appendChild(pauseCard);
        this.container.appendChild(this.pauseRoot);
    }

    public togglePause(): void {
        if (this.currentScreen === 'gameplay') {
            this.currentScreen = 'pause';
            this.pauseRoot.style.display = 'flex';
        } else if (this.currentScreen === 'pause') {
            this.closePauseMenu();
        }
    }

    public closePauseMenu(): void {
        this.pauseRoot.style.display = 'none';
        this.currentScreen = 'gameplay';
    }

    // =========================================================================
    // SETTINGS & ACCESSIBILITY MODALS
    // =========================================================================

    private buildModals(): void {
        this.modalRoot = document.createElement('div');
        this.modalRoot.className = 'interactive-panel';
        this.modalRoot.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(8,7,6,0.92); display: none; justify-content: center; align-items: center; z-index: 10000;';

        const modalBox = document.createElement('div');
        modalBox.id = 'rodbra-modal-content';
        modalBox.style.cssText = 'width: 520px; max-height: 85vh; overflow-y: auto; background: #12100F; border: 1px solid #332822; padding: 32px; box-shadow: 0 10px 40px rgba(0,0,0,0.9);';
        this.modalRoot.appendChild(modalBox);

        this.container.appendChild(this.modalRoot);
    }

    public openSettingsModal(): void {
        const box = this.modalRoot.querySelector('#rodbra-modal-content') as HTMLElement;
        box.innerHTML = `
            <h2 style="margin:0 0 20px; font-size:24px; letter-spacing:3px; color:#FFF;">SETTINGS</h2>
            
            <div style="margin-bottom:16px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:4px;">MASTER VOLUME: <span id="val-master">${Math.round(this.settings.masterVolume * 100)}%</span></label>
                <input type="range" min="0" max="100" value="${this.settings.masterVolume * 100}" id="input-master" style="width:100%;">
            </div>

            <div style="margin-bottom:16px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:4px;">MUSIC VOLUME: <span id="val-music">${Math.round(this.settings.musicVolume * 100)}%</span></label>
                <input type="range" min="0" max="100" value="${this.settings.musicVolume * 100}" id="input-music" style="width:100%;">
            </div>

            <div style="margin-bottom:16px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:4px;">SFX VOLUME: <span id="val-sfx">${Math.round(this.settings.sfxVolume * 100)}%</span></label>
                <input type="range" min="0" max="100" value="${this.settings.sfxVolume * 100}" id="input-sfx" style="width:100%;">
            </div>

            <div style="margin-bottom:16px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:4px;">CAMERA SHAKE: <span id="val-shake">${Math.round(this.settings.cameraShake * 100)}%</span></label>
                <input type="range" min="0" max="100" value="${this.settings.cameraShake * 100}" id="input-shake" style="width:100%;">
            </div>

            <div style="margin-bottom:24px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:6px;">STYLIZED GORE LEVEL</label>
                <select id="select-gore" style="width:100%; padding:8px; background:#1C1816; color:#FFF; border:1px solid #3A2F2B; font-family:inherit;">
                    <option value="full" ${this.settings.gore === 'full' ? 'selected' : ''}>FULL (Decals, spray, execution dismemberment)</option>
                    <option value="reduced" ${this.settings.gore === 'reduced' ? 'selected' : ''}>REDUCED (Light spray, no dismemberment)</option>
                    <option value="off" ${this.settings.gore === 'off' ? 'selected' : ''}>OFF (Replaced with black ash, no dismemberment)</option>
                </select>
            </div>

            <button class="rodbra-btn" id="modal-close-btn">SAVE & RETURN</button>
        `;

        this.activeModal = 'settings';
        this.modalRoot.style.display = 'flex';

        // Connect inputs
        const inMaster = box.querySelector('#input-master') as HTMLInputElement;
        inMaster.oninput = () => {
            this.settings.masterVolume = parseInt(inMaster.value) / 100;
            (box.querySelector('#val-master') as HTMLElement).textContent = `${inMaster.value}%`;
            audio.setVolumes(this.settings.masterVolume, this.settings.musicVolume, this.settings.sfxVolume, this.settings.voiceVolume);
        };

        const inMusic = box.querySelector('#input-music') as HTMLInputElement;
        inMusic.oninput = () => {
            this.settings.musicVolume = parseInt(inMusic.value) / 100;
            (box.querySelector('#val-music') as HTMLElement).textContent = `${inMusic.value}%`;
            audio.setVolumes(this.settings.masterVolume, this.settings.musicVolume, this.settings.sfxVolume, this.settings.voiceVolume);
        };

        const inSfx = box.querySelector('#input-sfx') as HTMLInputElement;
        inSfx.oninput = () => {
            this.settings.sfxVolume = parseInt(inSfx.value) / 100;
            (box.querySelector('#val-sfx') as HTMLElement).textContent = `${inSfx.value}%`;
            audio.setVolumes(this.settings.masterVolume, this.settings.musicVolume, this.settings.sfxVolume, this.settings.voiceVolume);
        };

        const inShake = box.querySelector('#input-shake') as HTMLInputElement;
        inShake.oninput = () => {
            this.settings.cameraShake = parseInt(inShake.value) / 100;
            (box.querySelector('#val-shake') as HTMLElement).textContent = `${inShake.value}%`;
        };

        const selGore = box.querySelector('#select-gore') as HTMLSelectElement;
        selGore.onchange = () => {
            this.settings.gore = selGore.value as GoreLevel;
        };

        const closeBtn = box.querySelector('#modal-close-btn') as HTMLElement;
        closeBtn.onclick = () => {
            audio.playUIConfirm();
            this.saveSettingsToStorage();
            this.callbacks.onApplySettings(this.settings);
            this.closeModals();
        };
    }

    public openAccessibilityModal(): void {
        const box = this.modalRoot.querySelector('#rodbra-modal-content') as HTMLElement;
        box.innerHTML = `
            <h2 style="margin:0 0 20px; font-size:24px; letter-spacing:3px; color:#FFF;">ACCESSIBILITY</h2>

            <div style="margin-bottom:16px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:6px;">SUBTITLES</label>
                <select id="select-subs" style="width:100%; padding:8px; background:#1C1816; color:#FFF; border:1px solid #3A2F2B; font-family:inherit;">
                    <option value="true" ${this.settings.subtitles ? 'selected' : ''}>ON (Includes speaker names)</option>
                    <option value="false" ${!this.settings.subtitles ? 'selected' : ''}>OFF</option>
                </select>
            </div>

            <div style="margin-bottom:16px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:6px;">COMBAT DIFFICULTY</label>
                <select id="select-diff" style="width:100%; padding:8px; background:#1C1816; color:#FFF; border:1px solid #3A2F2B; font-family:inherit;">
                    <option value="story" ${this.settings.difficulty === 'story' ? 'selected' : ''}>STORY (Relaxed timings, +50% player resilience)</option>
                    <option value="standard" ${this.settings.difficulty === 'standard' ? 'selected' : ''}>STANDARD (Intended dark fantasy challenge)</option>
                    <option value="hard" ${this.settings.difficulty === 'hard' ? 'selected' : ''}>HARD (Punishing enemy attacks, tighter parry window)</option>
                </select>
            </div>

            <div style="margin-bottom:16px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:6px;">SPRINT BEHAVIOR</label>
                <select id="select-sprint" style="width:100%; padding:8px; background:#1C1816; color:#FFF; border:1px solid #3A2F2B; font-family:inherit;">
                    <option value="false" ${!this.settings.sprintToggle ? 'selected' : ''}>HOLD SPRINT</option>
                    <option value="true" ${this.settings.sprintToggle ? 'selected' : ''}>TOGGLE SPRINT</option>
                </select>
            </div>

            <div style="margin-bottom:24px;">
                <label style="display:block; font-size:13px; color:#8A8278; margin-bottom:6px;">REDUCE SCREEN FLASHES</label>
                <select id="select-flashes" style="width:100%; padding:8px; background:#1C1816; color:#FFF; border:1px solid #3A2F2B; font-family:inherit;">
                    <option value="false" ${!this.settings.reduceFlashes ? 'selected' : ''}>NORMAL (Standard combat flashes)</option>
                    <option value="true" ${this.settings.reduceFlashes ? 'selected' : ''}>REDUCED (Muted white flashes)</option>
                </select>
            </div>

            <button class="rodbra-btn" id="access-close-btn">SAVE & RETURN</button>
        `;

        this.activeModal = 'accessibility';
        this.modalRoot.style.display = 'flex';

        const selSubs = box.querySelector('#select-subs') as HTMLSelectElement;
        selSubs.onchange = () => { this.settings.subtitles = selSubs.value === 'true'; };

        const selDiff = box.querySelector('#select-diff') as HTMLSelectElement;
        selDiff.onchange = () => { this.settings.difficulty = selDiff.value as any; };

        const selSprint = box.querySelector('#select-sprint') as HTMLSelectElement;
        selSprint.onchange = () => { this.settings.sprintToggle = selSprint.value === 'true'; };

        const selFlashes = box.querySelector('#select-flashes') as HTMLSelectElement;
        selFlashes.onchange = () => { this.settings.reduceFlashes = selFlashes.value === 'true'; };

        const closeBtn = box.querySelector('#access-close-btn') as HTMLElement;
        closeBtn.onclick = () => {
            audio.playUIConfirm();
            this.saveSettingsToStorage();
            this.callbacks.onApplySettings(this.settings);
            this.closeModals();
        };
    }

    // =========================================================================
    // CHECKPOINT / SHRINE PRAYER UPGRADE MODAL
    // =========================================================================

    public openCheckpointUpgradeModal(): void {
        const box = this.modalRoot.querySelector('#rodbra-modal-content') as HTMLElement;
        const u = this.stats.upgrades;

        box.innerHTML = `
            <h2 style="margin:0 0 6px; font-size:24px; letter-spacing:3px; color:#FFF;">IRON PRAYER POST</h2>
            <div style="font-size:14px; font-style:italic; color:#8A8278; margin-bottom:20px;">Health restored. Vitality vial refilled. Progress saved.</div>
            
            <div style="font-size:15px; color:#E8E2D8; margin-bottom:16px;">
                AVAILABLE IRON NAILS: <span style="font-weight:bold; color:#F4BE5D;">${this.stats.ironNails}</span>
            </div>

            <div style="margin-bottom:14px; padding:12px; border:1px solid #332822; background:#181514;">
                <div style="font-weight:bold; color:#FFF; margin-bottom:4px;">TEMPERED EDGE (+15% Sword Damage)</div>
                <div style="font-size:13px; color:#8A8278; margin-bottom:8px;">Hone the seax blade against church stones. (Cost: 4 Nails)</div>
                <button class="rodbra-btn" id="btn-up-edge" ${u.temperedEdge || this.stats.ironNails < 4 ? 'disabled' : ''}>
                    ${u.temperedEdge ? 'FORGED' : 'FORGE (4 NAILS)'}
                </button>
            </div>

            <div style="margin-bottom:14px; padding:12px; border:1px solid #332822; background:#181514;">
                <div style="font-weight:bold; color:#FFF; margin-bottom:4px;">WOVEN CHARM (+20% Max Health)</div>
                <div style="font-size:13px; color:#8A8278; margin-bottom:8px;">Knot raven hair into the crimson sash. (Cost: 4 Nails)</div>
                <button class="rodbra-btn" id="btn-up-charm" ${u.wovenCharm || this.stats.ironNails < 4 ? 'disabled' : ''}>
                    ${u.wovenCharm ? 'WOVEN' : 'WEAVE (4 NAILS)'}
                </button>
            </div>

            <div style="margin-bottom:20px; padding:12px; border:1px solid #332822; background:#181514;">
                <div style="font-weight:bold; color:#FFF; margin-bottom:4px;">QUICKENED WARD (-20% Ward Recharge)</div>
                <div style="font-size:13px; color:#8A8278; margin-bottom:8px;">Etch solar runes upon the iron talisman. (Cost: 4 Nails)</div>
                <button class="rodbra-btn" id="btn-up-ward" ${u.quickenedWard || this.stats.ironNails < 4 ? 'disabled' : ''}>
                    ${u.quickenedWard ? 'QUICKENED' : 'ETCH (4 NAILS)'}
                </button>
            </div>

            <button class="rodbra-btn" id="btn-cp-close">RISE & CONTINUE</button>
        `;

        this.activeModal = 'checkpoint';
        this.modalRoot.style.display = 'flex';

        const btnEdge = box.querySelector('#btn-up-edge') as HTMLButtonElement;
        if (btnEdge && !u.temperedEdge) {
            btnEdge.onclick = () => {
                this.stats.ironNails -= 4;
                this.stats.upgrades.temperedEdge = true;
                this.callbacks.onUpgradePurchased?.();
                audio.playArmorImpact();
                this.openCheckpointUpgradeModal(); // refresh
            };
        }

        const btnCharm = box.querySelector('#btn-up-charm') as HTMLButtonElement;
        if (btnCharm && !u.wovenCharm) {
            btnCharm.onclick = () => {
                this.stats.ironNails -= 4;
                this.stats.upgrades.wovenCharm = true;
                this.stats.currentHealth = this.stats.baseMaxHealth * 1.2;
                this.callbacks.onUpgradePurchased?.();
                audio.playHealFlask();
                this.openCheckpointUpgradeModal();
            };
        }

        const btnWard = box.querySelector('#btn-up-ward') as HTMLButtonElement;
        if (btnWard && !u.quickenedWard) {
            btnWard.onclick = () => {
                this.stats.ironNails -= 4;
                this.stats.upgrades.quickenedWard = true;
                this.callbacks.onUpgradePurchased?.();
                audio.playWardRecharged();
                this.openCheckpointUpgradeModal();
            };
        }

        const btnClose = box.querySelector('#btn-cp-close') as HTMLElement;
        btnClose.onclick = () => {
            audio.playUIConfirm();
            this.closeModals();
        };
    }

    public isAnyModalOpen(): boolean {
        return this.activeModal !== 'none';
    }

    public closeModals(): void {
        this.modalRoot.style.display = 'none';
        this.activeModal = 'none';
    }

    // =========================================================================
    // DEATH OVERLAY ("THE BELL REMEMBERS")
    // =========================================================================

    private buildDeathOverlay(): void {
        this.deathRoot = document.createElement('div');
        this.deathRoot.className = 'interactive-panel';
        this.deathRoot.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #060505; display: none; flex-direction: column; justify-content: center; align-items: center; z-index: 10001; opacity: 0; transition: opacity 1.2s ease;';

        const epitaph = document.createElement('h1');
        epitaph.style.cssText = 'font-size: 44px; letter-spacing: 6px; color: #8F1919; text-shadow: 0 0 20px rgba(143,25,25,0.8); margin-bottom: 30px;';
        epitaph.textContent = 'THE BELL REMEMBERS';
        this.deathRoot.appendChild(epitaph);

        const respawnBtn = document.createElement('button');
        respawnBtn.className = 'rodbra-btn';
        respawnBtn.style.cssText = 'width: 260px;';
        respawnBtn.textContent = 'RESPAWN';
        respawnBtn.onclick = () => {
            audio.playUIConfirm();
            this.hideDeathOverlay();
            this.callbacks.onRestartCheckpoint();
        };
        this.deathRoot.appendChild(respawnBtn);

        this.container.appendChild(this.deathRoot);
    }

    public showDeathOverlay(): void {
        this.currentScreen = 'death';
        this.deathRoot.style.display = 'flex';
        setTimeout(() => {
            this.deathRoot.style.opacity = '1';
        }, 50);
    }

    public hideDeathOverlay(): void {
        this.deathRoot.style.opacity = '0';
        setTimeout(() => {
            this.deathRoot.style.display = 'none';
            this.currentScreen = 'gameplay';
        }, 600);
    }

    // =========================================================================
    // FINAL CHOICE MODAL & DAWN ENDINGS
    // =========================================================================

    private buildChoiceModal(): void {
        this.choiceRoot = document.createElement('div');
        this.choiceRoot.className = 'interactive-panel';
        this.choiceRoot.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(8,6,5,0.92); display: none; flex-direction: column; justify-content: center; align-items: center; z-index: 10002;';

        const choiceBox = document.createElement('div');
        choiceBox.style.cssText = 'width: 620px; background: #120F0E; border: 2px solid #3D2D24; padding: 40px; text-align: center; box-shadow: 0 10px 50px rgba(0,0,0,0.95);';

        const choiceHeader = document.createElement('h2');
        choiceHeader.style.cssText = 'font-size: 28px; letter-spacing: 4px; color: #FFFFFF; margin-bottom: 12px;';
        choiceHeader.textContent = 'THE VOICES OF VARGDAL';
        choiceBox.appendChild(choiceHeader);

        const choiceDesc = document.createElement('p');
        choiceDesc.style.cssText = 'font-size: 16px; color: #D6CBBF; line-height: 1.7; margin-bottom: 32px; font-style: italic;';
        choiceDesc.textContent = 'Elin breathes upon the root-woven altar. The Bell Mother is slain, yet the roots tremor in silence. The seal demands a living voice, or the frost shall claim the valley forever.';
        choiceBox.appendChild(choiceDesc);

        const btnChoiceA = document.createElement('button');
        btnChoiceA.className = 'rodbra-btn';
        btnChoiceA.innerHTML = '<strong>SEVER THE ROOTS</strong><br><span style="font-size:12px; text-transform:none; color:#AAA;">Break the ancient seal, save Elin, and let Vargdal awaken in silence.</span>';
        btnChoiceA.onclick = () => {
            audio.playUIConfirm();
            this.choiceRoot.style.display = 'none';
            this.callbacks.onFinalChoice('break_seal');
        };
        choiceBox.appendChild(btnChoiceA);

        const btnChoiceB = document.createElement('button');
        btnChoiceB.className = 'rodbra-btn';
        btnChoiceB.style.cssText = 'border-color: #8C1C1C;';
        btnChoiceB.innerHTML = '<strong>THE RAVN RITE</strong><br><span style="font-size:12px; text-transform:none; color:#AAA;">Offer Liv\'s blood to replace Elin as the eternal sentinel beneath the bell.</span>';
        btnChoiceB.onclick = () => {
            audio.playUIConfirm();
            this.choiceRoot.style.display = 'none';
            this.callbacks.onFinalChoice('offer_blood');
        };
        choiceBox.appendChild(btnChoiceB);

        this.choiceRoot.appendChild(choiceBox);
        this.container.appendChild(this.choiceRoot);
    }

    public openFinalChoiceModal(): void {
        this.currentScreen = 'choice';
        this.choiceRoot.style.display = 'flex';
        audio.setMusicMode('ending');
    }

    // =========================================================================
    // CREDITS SCREEN
    // =========================================================================

    private buildCreditsScreen(): void {
        this.creditsRoot = document.createElement('div');
        this.creditsRoot.className = 'interactive-panel';
        this.creditsRoot.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #060505; display: none; flex-direction: column; justify-content: center; align-items: center; z-index: 10003;';

        const scrollBox = document.createElement('div');
        scrollBox.style.cssText = 'width: 560px; text-align: center;';

        const title = document.createElement('h1');
        title.style.cssText = 'font-size: 38px; letter-spacing: 6px; color: #FFFFFF; margin-bottom: 8px;';
        title.textContent = 'RÖDBRÅ';
        scrollBox.appendChild(title);

        const sub = document.createElement('div');
        sub.style.cssText = 'font-size: 16px; letter-spacing: 3px; color: #8A8278; margin-bottom: 36px;';
        sub.textContent = 'BENEATH THE BELL';
        scrollBox.appendChild(sub);

        const creditsList = document.createElement('div');
        creditsList.style.cssText = 'margin-bottom: 36px; line-height: 2.2;';
        CREDITS_DATA.forEach(c => {
            const row = document.createElement('div');
            row.innerHTML = `<span style="color:#C71A1A; font-weight:bold;">${c.title}</span> — <span style="color:#D8D2C7;">${c.role}</span>`;
            creditsList.appendChild(row);
        });
        scrollBox.appendChild(creditsList);

        const returnBtn = document.createElement('button');
        returnBtn.className = 'rodbra-btn';
        returnBtn.style.cssText = 'width: 240px; margin: 0 auto;';
        returnBtn.textContent = 'RETURN TO TITLE';
        returnBtn.onclick = () => {
            audio.playUIConfirm();
            this.creditsRoot.style.display = 'none';
            this.returnToTitle();
        };
        scrollBox.appendChild(returnBtn);

        this.creditsRoot.appendChild(scrollBox);
        this.container.appendChild(this.creditsRoot);
    }

    public openCredits(): void {
        this.currentScreen = 'credits';
        this.creditsRoot.style.display = 'flex';
        audio.setMusicMode('ending');
    }

    public returnToTitle(): void {
        this.currentScreen = 'title';
        this.hudRoot.style.display = 'none';
        this.pauseRoot.style.display = 'none';
        this.creditsRoot.style.display = 'none';
        this.modalRoot.style.display = 'none';
        this.deathRoot.style.display = 'none';
        this.choiceRoot.style.display = 'none';
        this.activeModal = 'none';
        this.titleScreenRoot.style.display = 'flex';
        this.refreshTitleScreenSaveState();
        audio.setMusicMode('menu');
        this.callbacks.onQuitToTitle();
    }

    public refreshTitleScreenSaveState(): void {
        if (this.continueBtn) {
            this.continueBtn.disabled = !SaveGameService.hasSave();
        }
    }

    // =========================================================================
    // STORAGE & INPUT
    // =========================================================================

    private saveSettingsToStorage(): void {
        try {
            localStorage.setItem('rodbra_settings_v1', JSON.stringify(this.settings));
        } catch (_) {}
    }

    private loadSettingsFromStorage(): void {
        try {
            const raw = localStorage.getItem('rodbra_settings_v1');
            if (raw) {
                const parsed = JSON.parse(raw);
                this.settings = { ...this.settings, ...parsed };
                audio.setVolumes(this.settings.masterVolume, this.settings.musicVolume, this.settings.sfxVolume, this.settings.voiceVolume);
            }
        } catch (_) {}
    }

    private setupInputDetection(): void {
        window.addEventListener('gamepadconnected', () => {
            this.isGamepadConnected = true;
            this.promptKey.textContent = 'X';
        });
        window.addEventListener('gamepaddisconnected', () => {
            this.isGamepadConnected = false;
            this.promptKey.textContent = 'E';
        });
        window.addEventListener('keydown', () => {
            if (this.isIntroPlaying) {
                this.finishIntro();
            }
        });
        window.addEventListener('mousedown', () => {
            if (this.isIntroPlaying) {
                this.finishIntro();
            }
        });
    }

    public dispose(): void {
        if (this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }
    }
}
