import { sanitizeProject } from './state.js';

const STORAGE_KEY = 'intersection-studio.project.v1';

const snapshot = (value) => JSON.stringify(sanitizeProject(value));

export function loadLocalProject() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? sanitizeProject(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

export function saveLocalProject(value) {
  try {
    localStorage.setItem(STORAGE_KEY, snapshot(value));
    return true;
  } catch {
    return false;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class ProjectHistory {
  constructor(initialValue, limit = 60) {
    this.limit = limit;
    this.entries = [snapshot(initialValue)];
    this.index = 0;
    this.lastKey = '';
    this.lastTime = 0;
  }

  record(value, key = '') {
    const next = snapshot(value);
    if (next === this.entries[this.index]) return false;

    const now = Date.now();
    const shouldCoalesce = key && key === this.lastKey && now - this.lastTime < 350 && this.index > 0;
    if (shouldCoalesce) {
      this.entries[this.index] = next;
    } else {
      this.entries.splice(this.index + 1);
      this.entries.push(next);
      if (this.entries.length > this.limit) this.entries.shift();
      this.index = this.entries.length - 1;
    }
    this.lastKey = key;
    this.lastTime = now;
    return true;
  }

  reset(value) {
    this.entries = [snapshot(value)];
    this.index = 0;
    this.lastKey = '';
    this.lastTime = 0;
  }

  undo() {
    if (!this.canUndo) return null;
    this.index -= 1;
    this.lastKey = '';
    return JSON.parse(this.entries[this.index]);
  }

  redo() {
    if (!this.canRedo) return null;
    this.index += 1;
    this.lastKey = '';
    return JSON.parse(this.entries[this.index]);
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.entries.length - 1;
  }
}
