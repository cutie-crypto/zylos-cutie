/**
 * 同步 PATH 查找——用于 post-install 探测时不能用 await。
 * 避免依赖 npm `which` 包，减少安装期不必要的依赖。
 */

import fs from 'node:fs';
import path from 'node:path';

export function whichSync(cmd: string): string | null {
  if (!cmd || cmd.includes('/')) {
    return fs.existsSync(cmd) ? cmd : null;
  }
  const PATH = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) {
        return candidate;
      }
    } catch {
      // try next dir
    }
  }
  return null;
}
