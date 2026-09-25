import { DeterministicRng } from "../rng.mjs";

export const SAVE_SCHEMA_VERSION = 1;

export class EventLog {
  constructor(entries = []) {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.nextId = this.entries.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0) + 1;
  }

  record(atMinute, type, data = {}) {
    const event = { id: this.nextId++, atMinute, type, data: structuredClone(data) };
    this.entries.push(event);
    return event;
  }
}

export class SimulationClock {
  constructor(minute = 0) {
    this.minute = minute;
    this.queue = [];
    this.nextEventId = 1;
  }

  get day() {
    return Math.floor(this.minute / 1440) + 1;
  }

  schedule(atMinute, type, payload = {}) {
    if (!Number.isFinite(atMinute) || atMinute < this.minute) throw new Error("Scheduled time must not be in the past");
    const event = { id: this.nextEventId++, atMinute, type, payload: structuredClone(payload) };
    this.queue.push(event);
    this.queue.sort((a, b) => a.atMinute - b.atMinute || a.id - b.id);
    return event.id;
  }

  advance(minutes, dispatch) {
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error("Clock advance must be non-negative");
    const target = this.minute + minutes;
    while (this.queue.length && this.queue[0].atMinute <= target) {
      const event = this.queue.shift();
      this.minute = event.atMinute;
      dispatch?.(event);
    }
    this.minute = target;
  }
}

export class Ledger {
  constructor(openingCash = 0, entries = [], commitments = []) {
    this.openingCash = openingCash;
    this.entries = entries.map((entry) => ({ ...entry }));
    this.commitments = new Map(commitments.map((item) => [item.id, { ...item }]));
    this.nextEntryId = this.entries.reduce((max, entry) => Math.max(max, entry.id ?? 0), 0) + 1;
  }

  get cash() {
    return this.openingCash + this.entries.reduce((sum, entry) => sum + entry.amount, 0);
  }

  get committed() {
    return [...this.commitments.values()].reduce((sum, item) => sum + item.remaining, 0);
  }

  get availableCash() {
    return this.cash - this.committed;
  }

  post({ atMinute, amount, category, reference, memo = "" }) {
    if (!Number.isFinite(amount) || amount === 0) throw new Error("Ledger amount must be a non-zero finite number");
    if (amount < 0 && this.cash + amount < -1e-6) throw new Error(`Insufficient cash for ${category}`);
    const entry = { id: this.nextEntryId++, atMinute, amount, category, reference, memo };
    this.entries.push(entry);
    return entry;
  }

  commit({ id, atMinute, amount, category, reference }) {
    if (this.commitments.has(id)) throw new Error(`Commitment ${id} already exists`);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Commitment amount must be positive");
    if (amount > this.availableCash + 1e-6) throw new Error(`Insufficient available cash for ${category}`);
    const item = { id, atMinute, original: amount, remaining: amount, category, reference };
    this.commitments.set(id, item);
    return item;
  }

  settle(id, amount, atMinute, memo = "") {
    const item = this.commitments.get(id);
    if (!item) throw new Error(`Unknown commitment ${id}`);
    if (amount <= 0 || amount > item.remaining + 1e-6) throw new Error(`Invalid settlement for ${id}`);
    const entry = this.post({ atMinute, amount: -amount, category: item.category, reference: item.reference, memo });
    item.remaining -= amount;
    if (item.remaining <= 1e-6) this.commitments.delete(id);
    return entry;
  }

  release(id) {
    return this.commitments.delete(id);
  }

  assertInvariant() {
    if (!Number.isFinite(this.cash)) throw new Error("Ledger cash is not finite");
    if ([...this.commitments.values()].some((item) => item.remaining < 0)) throw new Error("Negative commitment");
    return true;
  }
}

export class CommandHandler {
  constructor(context, snapshot, restore) {
    this.context = context;
    this.snapshot = snapshot;
    this.restore = restore;
    this.handlers = new Map();
  }

  register(type, handler) {
    if (this.handlers.has(type)) throw new Error(`Command ${type} already registered`);
    this.handlers.set(type, handler);
  }

  execute(command) {
    const handler = this.handlers.get(command.type);
    if (!handler) throw new Error(`Unknown command ${command.type}`);
    const before = this.snapshot(this.context);
    try {
      return handler(this.context, structuredClone(command.payload ?? {}));
    } catch (error) {
      this.restore(this.context, before);
      throw error;
    }
  }
}

export function encodeSave(payload) {
  return JSON.stringify({ schemaVersion: SAVE_SCHEMA_VERSION, savedAt: new Date().toISOString(), payload });
}

export function decodeSave(text) {
  const save = JSON.parse(text);
  if (save.schemaVersion !== SAVE_SCHEMA_VERSION) {
    throw new Error(`Unsupported save schema ${save.schemaVersion}; expected ${SAVE_SCHEMA_VERSION}`);
  }
  return save.payload;
}

export function makeRng(seedOrState, restored = false) {
  const rng = new DeterministicRng(restored ? 1 : seedOrState);
  if (restored) rng.restore(seedOrState);
  return rng;
}
