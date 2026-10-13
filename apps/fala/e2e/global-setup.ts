import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { E2E_MEDIA_DIR, FIXTURE } from './fixture';

/*
 * A 10-minute AAC file (~9.6 MB): long enough to span several 2 MiB storage chunks,
 * short enough to download in a second. Generated, not committed.
 */
export default function globalSetup() {
  mkdirSync(E2E_MEDIA_DIR, { recursive: true });
  const file = path.join(E2E_MEDIA_DIR, FIXTURE.file);
  if (!existsSync(file)) {
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${FIXTURE.durationS}`,
        '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:duration=${FIXTURE.durationS}:seed=1`,
        '-filter_complex', 'amix=inputs=2:normalize=0,volume=0.5',
        '-ac', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', file,
      ],
      { stdio: 'inherit' },
    );
  }
  const bytes = readFileSync(file);
  writeFileSync(
    path.join(E2E_MEDIA_DIR, FIXTURE.file.replace(/\.m4a$/, '.json')),
    JSON.stringify({
      format: 'e2e-fixture',
      id: FIXTURE.id,
      title: FIXTURE.title,
      file: FIXTURE.file,
      content_type: 'audio/mp4',
      duration_s: FIXTURE.durationS,
      size: statSync(file).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }),
  );
}
