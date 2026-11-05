const fs = require('fs');
const path = require('path');

// Which articles are already exported, worked out from the briefing folders on
// disk instead of a stored file. A briefing counts as exported only when its
// folder has all three of export.pdf, source/index.html and metadata.json;
// anything less is re-exported (into the same folder) on the next run.
class Manifest {
  constructor(outputDir) {
    this.outputDir = path.resolve(outputDir);
    this.exported = new Map(); // url -> { publishedDate, exportPath, exportedAt }
    this.incomplete = []; // folder names missing one of the three files
    this._scan();
  }

  _scan() {
    if (!fs.existsSync(this.outputDir)) return;
    for (const entry of fs.readdirSync(this.outputDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.outputDir, entry.name);
      const metadataPath = path.join(dir, 'metadata.json');
      const complete =
        fs.existsSync(metadataPath) &&
        fs.existsSync(path.join(dir, 'export.pdf')) &&
        fs.existsSync(path.join(dir, 'source', 'index.html'));
      if (!complete) {
        this.incomplete.push(entry.name);
        continue;
      }
      let metadata;
      try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch {
        this.incomplete.push(entry.name);
        continue;
      }
      if (!metadata.url) {
        this.incomplete.push(entry.name);
        continue;
      }
      this.exported.set(metadata.url, {
        publishedDate: metadata.publishedDate || null,
        exportPath: entry.name,
        exportedAt: metadata.exportedAt || null,
      });
    }
  }

  has(url) {
    return this.exported.has(url);
  }

  get(url) {
    return this.exported.get(url);
  }

  // Note an export made during this run (the folder itself is the record).
  record(url, meta) {
    this.exported.set(url, { ...meta, exportedAt: new Date().toISOString() });
  }

  count() {
    return this.exported.size;
  }
}

module.exports = { Manifest };
