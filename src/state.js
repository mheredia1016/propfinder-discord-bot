import fs from "node:fs/promises";
import path from "node:path";

export class StateStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "state.json");
    this.state = { posted: {}, lastRunAt: null };
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      this.state = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      await this.save();
    }
    return this.state;
  }

  hasPosted(key) {
    return Boolean(this.state.posted?.[key]);
  }

  async markPosted(key, details = {}) {
    this.state.posted ||= {};
    this.state.posted[key] = {
      postedAt: new Date().toISOString(),
      ...details,
    };
    await this.save();
  }

  async markRun() {
    this.state.lastRunAt = new Date().toISOString();
    await this.save();
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.file);
  }
}
