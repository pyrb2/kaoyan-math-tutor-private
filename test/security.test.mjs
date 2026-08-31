import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { boundedText, isInside, normalizeVaultPath, resolveInside, safeDisplayText } from '../src/security.mjs';

const ROOT = path.resolve(import.meta.dirname, 'sandbox-root');

test('resolveInside accepts only paths contained by the configured root', () => {
  assert.equal(resolveInside(ROOT, 'notes/chapter.md'), path.join(ROOT, 'notes', 'chapter.md'));
  assert.equal(resolveInside(ROOT, 'notes/../chapter.md'), path.join(ROOT, 'chapter.md'));
  assert.throws(() => resolveInside(ROOT, '../secret.txt'), /越出允许范围/);
  assert.throws(() => resolveInside(ROOT, '..\\secret.txt'), /越出允许范围/);
  assert.throws(() => resolveInside(ROOT, 'C:\\Windows\\win.ini'), /不允许绝对路径/);
  assert.throws(() => resolveInside(ROOT, '/etc/passwd'), /不允许绝对路径/);
  assert.throws(() => resolveInside(ROOT, '\0bad'), /路径参数无效/);
  assert.throws(() => resolveInside(ROOT, ''), /路径参数无效/);
});

test('isInside does not confuse sibling path prefixes', () => {
  assert.equal(isInside(ROOT, ROOT), true);
  assert.equal(isInside(ROOT, path.join(ROOT, 'nested', 'file.md')), true);
  assert.equal(isInside(ROOT, `${ROOT}-other`), false);
  assert.equal(isInside(ROOT, path.resolve(ROOT, '..', 'outside.md')), false);
});

test('vault paths normalize to portable forward slashes', () => {
  const absolute = path.join(ROOT, '01-课程笔记', '高等数学.md');
  assert.equal(normalizeVaultPath(ROOT, absolute), '01-课程笔记/高等数学.md');
  assert.throws(() => normalizeVaultPath(ROOT, path.resolve(ROOT, '..', 'outside.md')), /不在知识库内/);
});

test('display and input helpers remove unsafe display marks and enforce limits', () => {
  assert.equal(safeDisplayText('a—b–c\0d'), 'a-b-cd');
  assert.equal(boundedText('  问题  ', 10, '问题'), '问题');
  assert.throws(() => boundedText('', 10, '问题'), /不能为空/);
  assert.throws(() => boundedText('12345', 4, '问题'), /不能超过 4 个字符/);
  assert.throws(() => boundedText(123, 10, '问题'), /必须是字符串/);
});

