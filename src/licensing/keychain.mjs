import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const LICENSING_KEYCHAIN_SERVICE = 'com.aipro.licensing';

const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9.-]{1,79}$/;

class KeychainError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'KeychainError';
    this.code = code;
  }
}

function validateAccount(account) {
  if (typeof account !== 'string' || !ACCOUNT_PATTERN.test(account)) {
    throw new KeychainError('Licensing Keychain account is invalid.', 'invalid_keychain_account');
  }
}

function missingItem(error) {
  const summary = `${error?.message || ''}\n${error?.stderr || ''}`;
  return /could not be found|item not found|SecKeychainSearchCopyNext/i.test(summary);
}

export class KeychainSecretStore {
  constructor({
    runner = (file, args) => execFileAsync(file, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    }),
    service = LICENSING_KEYCHAIN_SERVICE,
  } = {}) {
    this.runner = runner;
    this.service = service;
  }

  async get(account) {
    validateAccount(account);
    try {
      const { stdout = '' } = await this.runner('/usr/bin/security', [
        'find-generic-password', '-w', '-a', account, '-s', this.service,
      ]);
      const value = String(stdout).replace(/[\r\n]+$/, '');
      if (!value) throw new KeychainError('Licensing Keychain value is empty.', 'corrupt_keychain_secret');
      return value;
    } catch (error) {
      if (error instanceof KeychainError) throw error;
      if (missingItem(error)) return null;
      throw new KeychainError('Licensing Keychain value could not be read.', 'keychain_read_failed');
    }
  }

  async put(account, value) {
    validateAccount(account);
    if (typeof value !== 'string' || value.length === 0 || value.length > 64 * 1024) {
      throw new KeychainError('Licensing Keychain value is invalid.', 'invalid_keychain_secret');
    }
    try {
      await this.runner('/usr/bin/security', [
        'add-generic-password', '-U', '-a', account, '-s', this.service, '-w', value,
      ]);
    } catch {
      throw new KeychainError('Licensing Keychain value could not be stored.', 'keychain_write_failed');
    }
  }

  async remove(account) {
    validateAccount(account);
    try {
      await this.runner('/usr/bin/security', [
        'delete-generic-password', '-a', account, '-s', this.service,
      ]);
    } catch (error) {
      if (!missingItem(error)) {
        throw new KeychainError('Licensing Keychain value could not be removed.', 'keychain_delete_failed');
      }
    }
  }
}
