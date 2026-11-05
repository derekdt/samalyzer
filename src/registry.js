const fs = require('fs');
const path = require('path');

class Registry {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.data = { discoveredAt: null, articles: [] };
    this._index = new Set();
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.articles)) {
        this.data = {
          discoveredAt: parsed.discoveredAt || null,
          articles: parsed.articles,
        };
        this._rebuildIndex();
      }
    } catch (err) {
      throw new Error(`Failed to parse registry at ${this.filePath}: ${err.message}`);
    }
  }

  _rebuildIndex() {
    this._index = new Set(this.data.articles.map((a) => a.url));
  }

  _save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  has(url) {
    return this._index.has(url);
  }

  articles() {
    return this.data.articles;
  }

  count() {
    return this.data.articles.length;
  }

  replace(allArticles) {
    this.data.articles = Array.isArray(allArticles) ? allArticles.slice() : [];
    this.data.discoveredAt = new Date().toISOString();
    this._rebuildIndex();
    this._save();
  }
}

module.exports = { Registry };
