// Copies /shared into the extension (Chrome can't load files outside the extension folder).
import { cpSync, mkdirSync } from 'node:fs';

const dest = 'extension/lib/shared';
mkdirSync(dest, { recursive: true });
cpSync('shared', dest, { recursive: true });
console.log(`synced shared/ → ${dest}/`);
