/**
 * Simple console logger for game service
 * Uses native console methods for logging
 * Works in both browser and Node.js environments
 */

// Type declaration for Node.js process (only used when available)
declare const process: {
  env: Record<string, string | undefined>;
  versions: { node?: string };
} | undefined;

// Check if we're in a browser or Node.js environment
const isBrowser = typeof window !== 'undefined';
const isNode = typeof process !== 'undefined' && process && process.versions && process.versions.node !== undefined;

// Environment detection
function getProcessEnv(key: string): string | undefined {
  if (isNode && typeof process !== 'undefined' && process && process.env) {
    return process.env[key];
  }
  return undefined;
}

const isDev = isNode ? getProcessEnv('NODE_ENV') !== 'production' : true;
const service = 'game';

// Logger interface
interface Logger {
  info: (message: string, data?: any) => void;
  error: (message: string, data?: any) => void;
  warn: (message: string, data?: any) => void;
  debug: (message: string, data?: any) => void;
  log: (message: string, data?: any) => void;
  child: (bindings: any) => Logger;
}

// Format timestamp
function getTime(): string {
  const now = new Date();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  const milliseconds = now.getMilliseconds().toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

// Create a logger with optional context
function createConsoleLogger(context: string = ''): Logger {
  const formatMessage = (level: string, message: string) => {
    const time = getTime();
    const levelStr = level.toUpperCase().padEnd(5);
    const contextPrefix = context ? `[${context}] ` : '';
    return `[${time}] ${levelStr} (${service}): ${contextPrefix}${message}`;
  };

  return {
    info: (message: string, data?: any) => {
      const formatted = formatMessage('info', message);
      if (data !== undefined && data !== null && Object.keys(data).length > 0) {
        console.log(formatted, data);
      } else {
        console.log(formatted);
      }
    },
    error: (message: string, data?: any) => {
      const formatted = formatMessage('error', message);
      if (data !== undefined) {
        if (data instanceof Error) {
          console.error(formatted, data);
        } else if (data !== null && Object.keys(data).length > 0) {
          console.error(formatted, data);
        } else {
          console.error(formatted);
        }
      } else {
        console.error(formatted);
      }
    },
    warn: (message: string, data?: any) => {
      const formatted = formatMessage('warn', message);
      if (data !== undefined && data !== null && Object.keys(data).length > 0) {
        console.warn(formatted, data);
      } else {
        console.warn(formatted);
      }
    },
    debug: (message: string, data?: any) => {
      if (!isDev) return; // Skip debug logs in production
      const formatted = formatMessage('debug', message);
      if (data !== undefined && data !== null && Object.keys(data).length > 0) {
        console.debug(formatted, data);
      } else {
        console.debug(formatted);
      }
    },
    log: (message: string, data?: any) => {
      const formatted = formatMessage('info', message);
      if (data !== undefined && data !== null && Object.keys(data).length > 0) {
        console.log(formatted, data);
      } else {
        console.log(formatted);
      }
    },
    child: (bindings: any) => {
      const childContext = bindings.context || context;
      return createConsoleLogger(childContext);
    },
  };
}

const logger = createConsoleLogger();

/**
 * Create a child logger with additional context
 */
export function createLogger(context: string): Logger {
  return createConsoleLogger(context);
}

// Export default logger
export const defaultLogger = logger;
export default logger;
