import fs from 'node:fs';
import path from 'node:path';
import { scanVault } from './scan.mjs';
import { VaultSearchIndex } from './retrieve.mjs';

export function buildVaultIndex(vaultPath) {
  const resolved = path.resolve(vaultPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`知识库目录不存在: ${resolved}`);
  }
  return new VaultSearchIndex(scanVault(resolved));
}

export { VaultSearchIndex } from './retrieve.mjs';
export { scanVault, parseFrontmatter, markdownToPlain, walkMarkdown } from './scan.mjs';
