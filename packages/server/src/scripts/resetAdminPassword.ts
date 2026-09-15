/**
 * 重置管理员账号的用户名与密码。
 *
 * 存在的理由：本系统不提供注册入口，管理员账号只在首次启动时创建一次。
 * 对单人部署来说，"忘记密码" 等于 "永久失去访问"，而唯一的数据恢复手段
 * 是删掉数据库 —— 那会连同交易所凭据与全部交易历史一起丢掉。
 * 一个能重设凭据的入口，比让人去删库安全得多。
 *
 * 凭据来源：环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（即 `.env`）。
 * 未设置时随机生成并打印，与首次启动的行为一致。
 *
 * 用法（在容器内，或本地）：
 *   node node_modules/tsx/dist/cli.mjs packages/server/src/scripts/resetAdminPassword.ts
 */

import { closeDb, initDb } from '../db/index.js';
import { dbPath, env } from '../env.js';
import { generatePassword, generateUsername } from '../api/auth.js';
import { hashPassword } from '../crypto/vault.js';
import { users } from '../store/repositories.js';
import { createLogger } from '../logger.js';

const log = createLogger('reset-admin');

const OWNER_ROLE = 'owner';

function main(): void {
  initDb(dbPath);

  const username = env.adminUsername || generateUsername();
  const password = env.adminPassword || generatePassword();

  // 优先改现有的 owner，而不是新建 —— 新建会留下一个无法登录的旧账号，
  // 也可能撞上 users.username 的 UNIQUE 约束。
  const existing = users.findByUsername(username);
  const owner =
    existing ??
    // .env 里的用户名可能和库里现有的不同（用户改过名），此时取第一个 owner
    (() => {
      const byRole = users.listOwners()[0];
      return byRole ? users.findByUsername(byRole.username) : undefined;
    })();

  if (owner) {
    if (owner.username !== username) {
      users.updateUsername(owner.id, username);
    }
    users.updatePassword(owner.id, hashPassword(password));
    log.warn(`已重置管理员账号：${owner.username} → ${username}`);
  } else {
    users.create(username, hashPassword(password), OWNER_ROLE);
    log.warn(`未找到任何管理员账号，已新建：${username}`);
  }

  // 供部署脚本抓取，格式与首次启动日志保持一致
  process.stdout.write(`RESET_CREDENTIALS username=${username} password=${password}\n`);

  closeDb();
}

main();
