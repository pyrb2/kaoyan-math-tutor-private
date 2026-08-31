import path from 'node:path';

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveInside(root, requested) {
  if (typeof requested !== 'string' || !requested.trim() || requested.includes('\0')) {
    throw new Error('路径参数无效');
  }
  const normalized = requested.replaceAll('\\', '/');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) {
    throw new Error('不允许绝对路径');
  }
  const candidate = path.resolve(root, ...normalized.split('/'));
  if (!isInside(root, candidate)) throw new Error('路径越出允许范围');
  return candidate;
}

export function normalizeVaultPath(root, absolutePath) {
  if (!isInside(root, absolutePath)) throw new Error('文件不在知识库内');
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

export function safeDisplayText(value) {
  return String(value ?? '').replace(/[—–]/g, '-').replace(/\u0000/g, '');
}

export function boundedText(value, maxLength, name = '文本') {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name}不能为空`);
  if (normalized.length > maxLength) throw new Error(`${name}不能超过 ${maxLength} 个字符`);
  return normalized;
}
