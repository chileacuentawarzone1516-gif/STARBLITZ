/**
 * Historial de deshacer/rehacer basado en comandos reversibles.
 * Agrupa ediciones rápidas consecutivas (p. ej. teclear) en un solo paso.
 */
export interface Command {
  label: string;
  /** Clave para fusionar cambios seguidos sobre el mismo objeto. */
  mergeKey?: string;
  apply: () => Promise<void> | void;
  revert: () => Promise<void> | void;
}

interface Entry extends Command { at: number }

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<() => void>();

  constructor(private limit = 200, private mergeWindowMs = 1200) {}

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label ?? ''; }
  get redoLabel() { return this.redoStack.at(-1)?.label ?? ''; }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() { this.listeners.forEach((fn) => fn()); }

  /** Registra un comando ya aplicado (el estado ya refleja el cambio). */
  push(cmd: Command): void {
    const now = Date.now();
    const last = this.undoStack.at(-1);
    if (last && cmd.mergeKey && last.mergeKey === cmd.mergeKey && now - last.at < this.mergeWindowMs) {
      // Se conserva el estado original del primer cambio y el final del último.
      this.undoStack[this.undoStack.length - 1] = { ...cmd, revert: last.revert, at: now };
    } else {
      this.undoStack.push({ ...cmd, at: now });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
    this.emit();
  }

  async undo(): Promise<void> {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    await cmd.revert();
    this.redoStack.push(cmd);
    this.emit();
  }

  async redo(): Promise<void> {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    await cmd.apply();
    this.undoStack.push({ ...cmd, at: 0 });
    this.emit();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }
}
