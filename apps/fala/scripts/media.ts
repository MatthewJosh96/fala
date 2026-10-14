/*
 * Media catalogue CLI (plain Node, run with --experimental-strip-types):
 *   stage --catalogue <media/catalogue.json> --root <repo> --out <dir> [--copy]
 *       symlinks (or copies) the published renders into <dir> and writes their sidecars
 *   index <dir> [--out <file>] [--strict] [--verify-sha] [--catalogue <media/catalogue.json>]
 *       writes media/index.json from the files and sidecars in <dir>; with --catalogue,
 *       fails unless <dir> holds exactly the files the catalogue lists
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildIndex, compareWithCatalogue, readCatalogueSpec, stageFromSpec } from '../server/mediaIndex.ts';

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  if (cmd === 'stage') {
    const catalogue = opt(args, '--catalogue');
    const root = opt(args, '--root');
    const out = opt(args, '--out');
    if (!catalogue || !root || !out) throw new Error('usage: stage --catalogue <file> --root <dir> --out <dir> [--copy]');
    const sidecars = await stageFromSpec(await readCatalogueSpec(catalogue), root, out, { copy: args.includes('--copy') });
    for (const s of sidecars) console.log(`${s.file}\t${s.size} B\t${s.duration_s} s\t${s.sha256}`);
    return;
  }
  if (cmd === 'index') {
    const dir = args[0];
    if (!dir || dir.startsWith('--')) {
      throw new Error('usage: index <dir> [--out <file>] [--strict] [--verify-sha] [--catalogue <file>]');
    }
    const index = await buildIndex(dir, { strict: args.includes('--strict'), verifySha: args.includes('--verify-sha') });
    if (index.tracks.length === 0) throw new Error(`no tracks found in ${dir}`);
    const catalogue = opt(args, '--catalogue');
    if (catalogue) {
      const { missing, unexpected } = compareWithCatalogue(index, await readCatalogueSpec(catalogue));
      if (missing.length || unexpected.length) {
        throw new Error(`${dir} does not match ${catalogue}: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`);
      }
    }
    const out = opt(args, '--out') ?? path.join(dir, 'index.json');
    await fs.writeFile(out, `${JSON.stringify(index, null, 2)}\n`);
    console.log(`${out}: ${index.tracks.length} tracks, ${index.tracks.reduce((n, t) => n + t.variants.length, 0)} files`);
    return;
  }
  throw new Error('commands: stage, index');
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
