import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// One bot process owns this file. Mount its directory as a Docker volume.
// Selections and interaction tokens are intentionally never written to disk.
export function createPortraitStore(directory, scope, filename = 'portrait-state.json') {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, filename);
  return {
    load() {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (data.version !== 1 || data.scope !== scope) throw new Error('Portrait state belongs to a different channel or version.');
        if (!Array.isArray(data.seen) || !data.seen.every(id => /^\d{17,20}$/.test(id))) throw new Error('Invalid portrait rotation state.');
        if (data.active && (!/^\d{17,20}$/.test(data.active.channel) ||
          (data.active.message && !/^\d{17,20}$/.test(data.active.message)))) throw new Error('Invalid portrait recovery state.');
        return data;
      } catch (error) {
        if (error.code === 'ENOENT') return { seen: [], active: null };
        throw error;
      }
    },
    save(data) {
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...data, version: 1, scope }), { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}
