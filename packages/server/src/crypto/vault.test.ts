import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { Vault, maskSecret } from './vault.js';

describe('maskSecret', () => {
  it('空字符串返回空字符串', () => {
    assert.equal(maskSecret(''), '');
  });

  it('长度 <= 8 的短密钥一律脱敏为 ****，绝不回显明文', () => {
    for (const secret of ['a', 'ab', 'abc', 'abcd', '12345', '1234567', '12345678']) {
      assert.equal(maskSecret(secret), '****', `短密钥 "${secret}" 必须返回 ****`);
    }
  });

  it('长度 9–10 仅保留前 2 后 2 位', () => {
    assert.equal(maskSecret('123456789'), '12…89');
    assert.equal(maskSecret('1234567890'), '12…90');
  });

  it('长度 > 10 保留前 6 后 4 位', () => {
    assert.equal(maskSecret('sk-abcdef1234567890wxyz'), 'sk-abc…wxyz');
  });
});

describe('Vault', () => {
  it('AES-256-GCM 往返加解密与防篡改校验', () => {
    const vault = new Vault(randomBytes(32));
    const enc = vault.encrypt('super-secret-value');
    assert.ok(enc.startsWith('v1:'));
    assert.equal(vault.decrypt(enc), 'super-secret-value');

    const tampered = `${enc.slice(0, -2)}AA`;
    assert.throws(() => vault.decrypt(tampered));

    assert.equal(vault.encryptOptional(''), '');
    assert.equal(vault.encryptOptional(null), '');
    assert.equal(vault.decryptOptional(''), '');
  });
});
