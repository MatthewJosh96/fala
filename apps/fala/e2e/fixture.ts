import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_MEDIA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.fixtures', 'media');
export const FIXTURE = { id: 'e2e-tone', title: 'Ton testowy e2e', file: 'e2e-tone.m4a', durationS: 600 };
