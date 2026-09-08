// Optional: refresh the double-click preview after editing slides.md.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('./', import.meta.url);
const markdown = readFileSync(new URL('slides.md', root), 'utf8');
writeFileSync(new URL('embedded.js', root), 'window.DEFAULT_MARKDOWN = ' + JSON.stringify(markdown) + ';\n');
