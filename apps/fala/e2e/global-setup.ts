import { rmSync } from 'node:fs';
import path from 'node:path';
import { readCatalogueSpec, stageFromSpec } from '../server/mediaIndex.ts';
import { E2E_MEDIA_DIR, REPO_ROOT } from './fixture';

/*
 * Stages the published catalogue (media/catalogue.json) exactly as the publish script
 * does, but with symlinks into a temp dir: no copies of the renders, nothing downloaded.
 * FALA_E2E_RENDERS_ROOT overrides where `renders/...` sources are looked up.
 */
export default async function globalSetup() {
  if (process.env.FALA_E2E_MEDIA_DIR) return; // opt-in large-file run brings its own directory
  rmSync(E2E_MEDIA_DIR, { recursive: true, force: true });
  const spec = await readCatalogueSpec(path.join(REPO_ROOT, 'media/catalogue.json'));
  await stageFromSpec(spec, process.env.FALA_E2E_RENDERS_ROOT ?? REPO_ROOT, E2E_MEDIA_DIR);
}
