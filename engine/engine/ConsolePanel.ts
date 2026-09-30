// Console panel UI component with toggle button and expandable panel

import { ConsoleCapture } from 'engine/ConsoleCapture.js';
import type { CapturedMessage } from 'engine/ConsoleCapture.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import { collectNewErrors } from 'engine/RuntimeErrorForwarder.js';

const STORAGE_KEY = 'consolePanel.height';
const MIN_HEIGHT = 100;
const MAX_HEIGHT_PERCENT = 0.8;
const DEFAULT_HEIGHT = 200;

/**
 * Console panel UI component that shows captured warnings and errors.
 * Features a toggle button (visible when there are messages) and a resizable panel.
 */
export class ConsolePanel {
    private button: HTMLButtonElement | null = null;
    private panel: HTMLDivElement | null = null;
    private contentArea: HTMLDivElement | null = null;
    private countBadge: HTMLSpanElement | null = null;
    private errorBadge: HTMLSpanElement | null = null;
    private fixButton: HTMLButtonElement | null = null;
    private isOpen = false;
    private isFixingErrors = false;
    private boundMessageHandler: (event: MessageEvent) => void;
    private capture: ConsoleCapture;
    private panelHeight = DEFAULT_HEIGHT;
    private isDragging = false;
    private dragStartY = 0;
    private dragStartHeight = 0;
    private boundOnDrag: (e: MouseEvent) => void;
    private boundStopDrag: () => void;
    private lastErrorCount = 0;  // Track error count for auto-open

    constructor() {
        this.capture = ConsoleCapture.getInstance();
        this.boundOnDrag = this.onDrag.bind(this);
        this.boundStopDrag = this.stopDrag.bind(this);
        this.boundMessageHandler = this.handleMessage.bind(this);
        this.lastErrorCount = this.capture.getErrorCount();
        this.restoreHeight();
        this.createButton();
        this.createPanel();
        this.capture.addListener(() => this.onNewMessage());
        this.update();

        // Listen for messages from parent frame
        window.addEventListener('message', this.boundMessageHandler);

        // Debug: Press Ctrl+Shift+E to trigger a test error
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'E') {
                console.error('Test error from ConsolePanel');
            }
        });
    }

    /**
     * Called when a new message is captured.
     * Auto-opens the panel if a new error occurred.
     */
    private onNewMessage(): void {
        const currentErrorCount = this.capture.getErrorCount();

        // Auto-open if new errors occurred and panel is closed
        if (currentErrorCount > this.lastErrorCount && !this.isOpen) {
            this.isOpen = true;
        }

        this.lastErrorCount = currentErrorCount;
        this.update();
    }

    private restoreHeight(): void {
        try {
            const stored = sessionStorage.getItem(STORAGE_KEY);
            if (stored) {
                const height = parseInt(stored, 10);
                if (!isNaN(height) && height >= MIN_HEIGHT) {
                    this.panelHeight = Math.min(height, window.innerHeight * MAX_HEIGHT_PERCENT);
                }
            }
        } catch {
            // sessionStorage not available
        }
    }

    private saveHeight(): void {
        try {
            sessionStorage.setItem(STORAGE_KEY, String(this.panelHeight));
        } catch {
            // sessionStorage not available
        }
    }

    private createButton(): void {
        this.button = document.createElement('button');
        this.button.id = 'console-toggle-button';
        this.button.innerHTML = `
            <span style="font-family: monospace; margin-right: 6px;">&gt;_</span>
            <span>Console</span>
        `;
        // Sized to fit the HUD's reserved bottom-right band (see
        // hudBaseStyles.ts): published games put the Bitmagic watermark there
        // (bottom 12px, 20px tall — top edge 32px), and this dev-only button
        // takes the same slot in creator mode. Keep the button's top edge at
        // or below 32px so bottom-right HUD elements (ammo counter etc.),
        // which start at 40px, clear it in both environments.
        this.button.style.cssText = `
            position: fixed;
            bottom: 8px;
            right: 16px;
            background: #1e2433;
            color: #9ca3af;
            border: 1px solid #374151;
            border-radius: 6px;
            padding: 2px 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            font-size: 12px;
            line-height: 18px;
            cursor: pointer;
            z-index: 10001;
            display: none;
            align-items: center;
            transition: background 0.2s, border-color 0.2s;
        `;

        this.button.addEventListener('mouseenter', () => {
            if (this.button) {
                this.button.style.background = '#2a3444';
                this.button.style.borderColor = '#4b5563';
            }
        });

        this.button.addEventListener('mouseleave', () => {
            if (this.button) {
                this.button.style.background = '#1e2433';
                this.button.style.borderColor = '#374151';
            }
        });

        this.button.addEventListener('click', () => this.toggle());

        document.body.appendChild(this.button);
    }

    private createPanel(): void {
        this.panel = document.createElement('div');
        this.panel.id = 'console-panel';
        this.panel.style.cssText = `
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: ${this.panelHeight}px;
            background: rgba(26, 32, 44, 0.98);
            border-top: 3px solid;
            border-image: linear-gradient(90deg, #06b6d4, #3b82f6) 1;
            z-index: 10001;
            display: none;
            flex-direction: column;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        `;

        // Drag handle
        const dragHandle = document.createElement('div');
        dragHandle.style.cssText = `
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: ns-resize;
            flex-shrink: 0;
        `;

        const handleBar = document.createElement('div');
        handleBar.style.cssText = `
            width: 40px;
            height: 4px;
            background: #4b5563;
            border-radius: 2px;
        `;
        dragHandle.appendChild(handleBar);

        dragHandle.addEventListener('mousedown', (e) => this.startDrag(e));

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            align-items: center;
            padding: 8px 16px;
            border-bottom: 1px solid #374151;
            flex-shrink: 0;
        `;

        // Title
        const title = document.createElement('span');
        title.textContent = 'CONSOLE';
        title.style.cssText = `
            color: #9ca3af;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.5px;
            margin-right: 10px;
        `;

        // Count badge
        this.countBadge = document.createElement('span');
        this.countBadge.style.cssText = `
            background: #374151;
            color: #9ca3af;
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 10px;
            margin-right: 8px;
        `;

        // Error badge
        this.errorBadge = document.createElement('span');
        this.errorBadge.style.cssText = `
            background: #7f1d1d;
            color: #fecaca;
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 4px;
        `;

        // Fix with AI button
        this.fixButton = document.createElement('button');
        this.fixButton.textContent = 'Fix with AI';
        this.fixButton.style.cssText = `
            background: #1e3a5f;
            color: #93c5fd;
            border: 1px solid #3b82f6;
            border-radius: 4px;
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            margin-left: 12px;
            transition: background 0.2s, border-color 0.2s;
            display: none;
        `;
        this.fixButton.addEventListener('mouseenter', () => {
            if (this.fixButton) {
                this.fixButton.style.background = '#1e4976';
                this.fixButton.style.borderColor = '#60a5fa';
            }
        });
        this.fixButton.addEventListener('mouseleave', () => {
            if (this.fixButton) {
                this.fixButton.style.background = '#1e3a5f';
                this.fixButton.style.borderColor = '#3b82f6';
            }
        });
        this.fixButton.addEventListener('click', () => this.sendErrorsToAI());

        // Spacer
        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        // Hide button
        const hideButton = document.createElement('button');
        hideButton.textContent = 'Hide';
        hideButton.style.cssText = `
            background: #374151;
            color: #d1d5db;
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s;
        `;
        hideButton.addEventListener('mouseenter', () => {
            hideButton.style.background = '#4b5563';
        });
        hideButton.addEventListener('mouseleave', () => {
            hideButton.style.background = '#374151';
        });
        hideButton.addEventListener('click', () => this.toggle());

        header.appendChild(title);
        header.appendChild(this.countBadge);
        header.appendChild(this.errorBadge);
        header.appendChild(this.fixButton);
        header.appendChild(spacer);
        header.appendChild(hideButton);

        // Content area
        this.contentArea = document.createElement('div');
        this.contentArea.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 12px 16px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 12px;
            line-height: 1.6;
        `;

        this.panel.appendChild(dragHandle);
        this.panel.appendChild(header);
        this.panel.appendChild(this.contentArea);

        document.body.appendChild(this.panel);
    }

    private startDrag(e: MouseEvent): void {
        e.preventDefault();
        this.isDragging = true;
        this.dragStartY = e.clientY;
        this.dragStartHeight = this.panelHeight;

        document.addEventListener('mousemove', this.boundOnDrag);
        document.addEventListener('mouseup', this.boundStopDrag);
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
    }

    private onDrag(e: MouseEvent): void {
        if (!this.isDragging || !this.panel) return;

        const deltaY = this.dragStartY - e.clientY;
        const maxHeight = window.innerHeight * MAX_HEIGHT_PERCENT;
        this.panelHeight = Math.max(MIN_HEIGHT, Math.min(maxHeight, this.dragStartHeight + deltaY));
        this.panel.style.height = `${this.panelHeight}px`;
    }

    private stopDrag(): void {
        if (!this.isDragging) return;

        this.isDragging = false;
        document.removeEventListener('mousemove', this.boundOnDrag);
        document.removeEventListener('mouseup', this.boundStopDrag);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        this.saveHeight();
    }

    private toggle(): void {
        this.isOpen = !this.isOpen;
        this.updateVisibility();
    }

    private update(): void {
        this.updateCounts();
        this.updateVisibility();
        if (this.isOpen) {
            this.renderMessages();
        }
    }

    private updateCounts(): void {
        const errorCount = this.capture.getErrorCount();
        const warningCount = this.capture.getWarningCount();
        const totalCount = errorCount + warningCount;

        if (this.countBadge) {
            this.countBadge.textContent = String(totalCount);
        }

        if (this.errorBadge) {
            this.errorBadge.textContent = `${errorCount} error${errorCount !== 1 ? 's' : ''}`;
        }
    }

    private updateVisibility(): void {
        const hasMessages = this.capture.getErrorCount() + this.capture.getWarningCount() > 0;
        const hasErrors = this.capture.getErrorCount() > 0;

        if (this.button) {
            // Show button only when there are messages and panel is closed
            this.button.style.display = hasMessages && !this.isOpen ? 'flex' : 'none';
        }

        if (this.panel) {
            this.panel.style.display = this.isOpen ? 'flex' : 'none';
            if (this.isOpen) {
                this.renderMessages();
            }
        }

        // Show fix button only when there are errors
        if (this.fixButton) {
            this.fixButton.style.display = hasErrors ? 'inline-block' : 'none';
        }
    }

    /**
     * Send errors to AI for fixing via parent frame message.
     */
    private sendErrorsToAI(): void {
        if (this.isFixingErrors) return;

        // Same shape as GAME_RUNTIME_ERRORS, so the Creator sends it as the same
        // dedicated fix prompt as its error chip's "Fix with AI".
        const errors = collectNewErrors(this.capture.getMessages(), new Map());
        if (errors.length === 0) return;

        // Disable button while processing
        this.isFixingErrors = true;
        this.updateFixButtonState();

        safePostMessageToCreator({
            type: 'FIX_ERRORS_WITH_AI',
            data: { errors }
        });
    }

    /**
     * Handle messages from parent frame.
     */
    private handleMessage(event: MessageEvent): void {
        const { type } = event.data || {};
        if (type === 'FIX_ERRORS_COMPLETE') {
            this.isFixingErrors = false;
            this.updateFixButtonState();
        }
    }

    /**
     * Update the fix button's enabled/disabled state.
     */
    private updateFixButtonState(): void {
        if (!this.fixButton) return;

        if (this.isFixingErrors) {
            this.fixButton.disabled = true;
            this.fixButton.textContent = 'Fixing...';
            this.fixButton.style.opacity = '0.6';
            this.fixButton.style.cursor = 'not-allowed';
        } else {
            this.fixButton.disabled = false;
            this.fixButton.textContent = 'Fix with AI';
            this.fixButton.style.opacity = '1';
            this.fixButton.style.cursor = 'pointer';
        }
    }

    private renderMessages(): void {
        if (!this.contentArea) return;

        const messages = this.capture.getMessages();

        if (messages.length === 0) {
            this.contentArea.innerHTML = `
                <span style="color: #6b7280; font-style: italic;">No logs yet.</span>
            `;
            return;
        }

        const html = messages.map(msg => this.formatMessage(msg)).join('');
        this.contentArea.innerHTML = html;

        // Auto-scroll to bottom
        this.contentArea.scrollTop = this.contentArea.scrollHeight;
    }

    private formatMessage(msg: CapturedMessage): string {
        const time = this.formatTime(msg.timestamp);
        const color = msg.type === 'error' ? '#ef4444' : '#fbbf24';
        const typeLabel = msg.type === 'error' ? 'ERROR' : 'WARN';

        // Escape HTML in message
        const escapedMessage = this.escapeHtml(msg.message);

        // Show count badge if message occurred multiple times
        const countBadge = msg.count > 1
            ? `<span style="background: ${color}; color: #000; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 10px; margin-left: 6px;">${msg.count}</span>`
            : '';

        let html = `
            <div style="margin-bottom: 8px; word-break: break-word;">
                <span style="color: #6b7280;">[${time}]</span>
                <span style="color: ${color}; font-weight: 600; margin: 0 6px;">${typeLabel}</span>
                <span style="color: #e5e7eb;">${escapedMessage}</span>${countBadge}
            </div>
        `;

        // Add stack trace if available
        if (msg.stack) {
            const escapedStack = this.escapeHtml(msg.stack);
            html += `
                <div style="margin-left: 16px; margin-bottom: 12px; color: #9ca3af; font-size: 11px; white-space: pre-wrap;">
                    ${escapedStack}
                </div>
            `;
        }

        return html;
    }

    private formatTime(timestamp: number): string {
        const date = new Date(timestamp);
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    dispose(): void {
        this.stopDrag();

        window.removeEventListener('message', this.boundMessageHandler);

        if (this.button && this.button.parentElement) {
            this.button.parentElement.removeChild(this.button);
        }

        if (this.panel && this.panel.parentElement) {
            this.panel.parentElement.removeChild(this.panel);
        }

        this.button = null;
        this.panel = null;
        this.contentArea = null;
        this.countBadge = null;
        this.errorBadge = null;
        this.fixButton = null;
    }
}
