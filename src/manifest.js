const fs = require('fs');
const path = require('path');

class Manifest {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.data = { exportedDailyBriefings: {} };
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.exportedDailyBriefings) {
        this.data = parsed;
      }
    } catch (err) {
      throw new Error(`Failed to parse manifest at ${this.filePath}: ${err.message}`);
    }
  }

  has(url) {
    return Boolean(this.data.exportedDailyBriefings[url]);
  }

  get(url) {
    return this.data.exportedDailyBriefings[url];
  }

  record(url, meta) {
    this.data.exportedDailyBriefings[url] = {
      ...meta,
      exportedAt: new Date().toISOString(),
    };
    this._save();
  }

  remove(url) {
    delete this.data.exportedDailyBriefings[url];
    this._save();
  }

  count() {
    return Object.keys(this.data.exportedDailyBriefings).length;
  }

  _save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { Manifest };
