import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readCatalogueSpec, stageFromSpec } from '../server/mediaIndex.ts';
import { E2E_MEDIA_DIR, REPO_ROOT, TONE } from './fixture';

/*
 * Stages the published catalogue (media/catalogue.json) exactly as the publish script
 * does, but with symlinks into a temp dir: no copies of the renders, nothing downloaded.
 * FALA_E2E_RENDERS_ROOT overrides where `renders/...` sources are looked up.
 * Adds a short generated tone without modes for the Pobrane -> Odtwórz path.
 */
export default async function globalSetup() {
  if (process.env.FALA_E2E_MEDIA_DIR) return; // opt-in large-file run brings its own directory
  rmSync(E2E_MEDIA_DIR, { recursive: true, force: true });
  const spec = await readCatalogueSpec(path.join(REPO_ROOT, 'media/catalogue.json'));
  await stageFromSpec(spec, process.env.FALA_E2E_RENDERS_ROOT ?? REPO_ROOT, E2E_MEDIA_DIR);

  const file = path.join(E2E_MEDIA_DIR, TONE.file);
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${TONE.durationS}`,
      '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', file,
    ],
    { stdio: 'inherit' },
  );
  writeFileSync(
    path.join(E2E_MEDIA_DIR, TONE.file.replace(/\.m4a$/, '.json')),
    JSON.stringify({
      format: 'e2e-fixture',
      id: TONE.id,
      title: TONE.title,
      order: 99,
      file: TONE.file,
      content_type: 'audio/mp4',
      duration_s: TONE.durationS,
      size: statSync(file).size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    }),
  );
}
