// Console capture utility for intercepting console messages and exceptions

const MAX_MESSAGES = 500;
const LISTENER_THROTTLE_MS = 100;

// Messages matching these substrings are silently ignored (still logged to real console)
const IGNORED_MESSAGES = [
    'using deprecated parameters for the initialization function; pass a single object instead',
    // Browser pointer-lock rejections are benign (racy re-lock, unfocused document, lock throttle)
    // and never indicate a game defect - PointerLockManager already warns instead of erroring for
    // the known wordings, this is the backstop for any it does not yet recognise
    'PointerLockManager: Failed to request pointer lock',
];

export interface CapturedMessage {
    type: 'warn' | 'error';
    message: string;
    timestamp: number;
    stack?: string;
    count: number;  // For deduplication - how many times this message occurred
}

/**
 * Singleton utility that captures console.warn, console.error, and exceptions.
 * Preserves original console behavior while storing messages for display.
 *
 * Features:
 * - Deduplicates identical consecutive messages (shows count instead)
 * - Limits stored messages to prevent memory issues
 * - Throttles listener notifications for performance
 */
export class ConsoleCapture {
    private static instance: ConsoleCapture;
    private messages: CapturedMessage[] = [];
    private listeners: Set<() => void> = new Set();
    private originalWarn!: typeof console.warn;
    private originalError!: typeof console.error;
    private started = false;
    private listenerTimeout: number | null = null;
    private pendingNotify = false;

    private constructor() {
        // Private constructor for singleton
    }

    static getInstance(): ConsoleCapture {
        if (!ConsoleCapture.instance) {
            ConsoleCapture.instance = new ConsoleCapture();
        }
        return ConsoleCapture.instance;
    }

    /**
     * Start capturing console messages and exceptions.
     * Safe to call multiple times - will only start once.
     */
    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;

        // Store original console methods
        this.originalWarn = console.warn.bind(console);
        this.originalError = console.error.bind(console);

        // Override console.warn
        console.warn = (...args: unknown[]) => {
            this.originalWarn(...args);
            this.addMessage('warn', args);
        };

        // Override console.error
        console.error = (...args: unknown[]) => {
            this.originalError(...args);
            this.addMessage('error', args);
        };

        // Capture uncaught exceptions
        window.onerror = (message, source, lineno, colno, error) => {
            const errorMessage = typeof message === 'string' ? message : 'Unknown error';
            const location = source ? ` at ${source}:${lineno}:${colno}` : '';
            this.addMessage('error', [`${errorMessage}${location}`], error?.stack);
            return false; // Allow default handling
        };

        // Capture unhandled promise rejections
        window.onunhandledrejection = (event: PromiseRejectionEvent) => {
            const reason = event.reason;
            let message: string;
            let stack: string | undefined;

            if (reason instanceof Error) {
                message = `Unhandled Promise Rejection: ${reason.message}`;
                stack = reason.stack;
            } else if (typeof reason === 'string') {
                message = `Unhandled Promise Rejection: ${reason}`;
            } else {
                message = `Unhandled Promise Rejection: ${this.formatValue(reason)}`;
            }

            this.addMessage('error', [message], stack);
        };
    }

    private addMessage(type: 'warn' | 'error', args: unknown[], stack?: string): void {
        const message = args.map(arg => this.formatValue(arg)).join(' ');

        // Skip known noise from third-party libraries
        if (IGNORED_MESSAGES.some(ignored => message.includes(ignored))) {
            return;
        }

        // Check if this is a duplicate of the last message (deduplication)
        const lastMessage = this.messages[this.messages.length - 1];
        if (lastMessage && lastMessage.type === type && lastMessage.message === message) {
            // Increment count instead of adding new message
            lastMessage.count++;
            lastMessage.timestamp = Date.now();  // Update timestamp to latest
            this.notifyListenersThrottled();
            return;
        }

        // Add new message
        this.messages.push({
            type,
            message,
            timestamp: Date.now(),
            stack,
            count: 1
        });

        // Enforce max message limit
        if (this.messages.length > MAX_MESSAGES) {
            this.messages.shift();  // Remove oldest message
        }

        this.notifyListenersThrottled();
    }

    private notifyListenersThrottled(): void {
        // If already scheduled, just mark that we need another update
        if (this.listenerTimeout !== null) {
            this.pendingNotify = true;
            return;
        }

        // Notify immediately
        this.notifyListeners();

        // Set throttle timeout
        this.listenerTimeout = window.setTimeout(() => {
            this.listenerTimeout = null;
            if (this.pendingNotify) {
                this.pendingNotify = false;
                this.notifyListeners();
            }
        }, LISTENER_THROTTLE_MS);
    }

    private notifyListeners(): void {
        this.listeners.forEach(listener => listener());
    }

    private formatValue(value: unknown): string {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (typeof value === 'string') return value;
        if (value instanceof Error) return value.message;

        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    getMessages(): CapturedMessage[] {
        return [...this.messages];
    }

    getErrorCount(): number {
        // Sum up all error counts (including duplicates)
        return this.messages
            .filter(m => m.type === 'error')
            .reduce((sum, m) => sum + m.count, 0);
    }

    getWarningCount(): number {
        // Sum up all warning counts (including duplicates)
        return this.messages
            .filter(m => m.type === 'warn')
            .reduce((sum, m) => sum + m.count, 0);
    }

    addListener(callback: () => void): void {
        this.listeners.add(callback);
    }

    removeListener(callback: () => void): void {
        this.listeners.delete(callback);
    }
}
