export interface ILogger {
  debug(context: string, message: string): void;
  info(context: string, message: string): void;
  warn(context: string, message: string): void;
  error(context: string, message: string, detail?: unknown): void;
}

export class ConsoleLogger implements ILogger {
  debug(context: string, message: string): void {
    console.error(`[DEBUG] [${context}] ${message}`);
  }

  info(context: string, message: string): void {
    console.error(`[INFO] [${context}] ${message}`);
  }

  warn(context: string, message: string): void {
    console.error(`[WARN] [${context}] ${message}`);
  }

  error(context: string, message: string, detail?: unknown): void {
    console.error(`[ERROR] [${context}] ${message}`, detail ?? '');
  }
}
