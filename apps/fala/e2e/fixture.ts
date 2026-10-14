import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = '/fala/';
export const PORT = 4317;
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** Temporary site media: symlinks to the two published renders plus generated sidecars. */
export const E2E_MEDIA_DIR = path.join(tmpdir(), 'fala-e2e-media');
export const TRACKS = {
  morning: { id: 'poranne-swiatlo', title: 'Poranne światło', file: 'poranne-swiatlo.m4a' },
  pulse: { id: 'miekki-puls', title: 'Miękki puls', file: 'miekki-puls.m4a' },
} as const;
/** Generated tone without modes: listed in Pobrane with "Odtwórz", like the diagnostic files. */
export const TONE = { id: 'e2e-tone', title: 'Ton testowy e2e', file: 'e2e-tone.m4a', durationS: 20 } as const;
