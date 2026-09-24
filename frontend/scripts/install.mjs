#!/usr/bin/env node
/*
 * 受守护的依赖安装：让"装依赖"成为看得见结果的一步。
 *
 *  - 安装前先校验 node_modules 实际装到的版本与 package-lock.json 是否一致，
 *    一致则直接复用，不重复安装；
 *  - 安装在与 node_modules 隔离的临时目录中进行，全部装完并校验通过后
 *    才原子切换生效；中途失败/中断不会留下半成品，修复后直接重跑即可；
 *  - 失败时明确指出卡在哪一步、涉及哪个包，并保留完整日志；
 *  - 成功后把本次实际装到的版本清单写入 package-lock.json（应提交到仓库），
 *    并在 node_modules/.install-stamp.json 记录本次安装信息，下次启动直接复用。
 *
 * 用法:
 *   node scripts/install.mjs                校验 → (必要时)安装 → 校验 → 生效
 *   node scripts/install.mjs --verify-only  只校验不安装（dev/build 前自动调用）
 *   node scripts/install.mjs --force        即使一致也强制重装
 *   node scripts/install.mjs --update       按 package.json 重新解析版本并更新清单
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_JSON = path.join(ROOT, 'package.json');
const LOCKFILE = path.join(ROOT, 'package-lock.json');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const STAMP_FILE = path.join(NODE_MODULES, '.install-stamp.json');
const LOG_DIR = path.join(ROOT, 'logs');
// 隔离安装目录与换下的旧目录：与 node_modules 同级，保证 rename 是同一文件系统上的原子操作
const STAGING = path.join(ROOT, `.install-staging-${process.pid}`);
const TRASH = path.join(ROOT, `.install-trash-${process.pid}`);
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const args = new Set(process.argv.slice(2));
const VERIFY_ONLY = args.has('--verify-only');
const FORCE = args.has('--force');
const UPDATE = args.has('--update');

const ok = (msg) => console.log(`✔ ${msg}`);
const info = (msg) => console.log(`  ${msg}`);
const warn = (msg) => console.warn(`⚠ ${msg}`);

let currentStep = '准备阶段';
function step(n, label) {
  currentStep = `[${n}/5] ${label}`;
  console.log(`\n▶ ${currentStep}`);
}

/** 读取 package-lock.json，不存在或格式不支持时返回 null / 抛错 */
function readLockfile(file = LOCKFILE) {
  if (!fs.existsSync(file)) return null;
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new Error(`${path.basename(file)} 缺少 packages 字段（lockfileVersion 过旧？），请删除后重新运行 npm run setup`);
  }
  return lock;
}

/** 检测当前运行时的 libc（npm 对可选包按 os/cpu/libc 过滤）；结果缓存，避免重复生成 report */
let cachedLibc;
function detectLibc() {
  if (cachedLibc !== undefined) return cachedLibc;
  cachedLibc = null;
  if (process.platform === 'linux') {
    try {
      cachedLibc = process.report?.getReport?.()?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
    } catch {
      cachedLibc = null;
    }
  }
  return cachedLibc;
}

/** 该条目是否面向其他平台（如 @esbuild/darwin-arm64 之于 linux），此类包本就不会安装 */
function isForOtherPlatform(key, entry) {
  if (Array.isArray(entry.os) && !entry.os.includes(process.platform)) return true;
  if (Array.isArray(entry.cpu) && !entry.cpu.includes(process.arch)) return true;
  if (Array.isArray(entry.libc)) {
    const libc = detectLibc();
    if (libc && !entry.libc.includes(libc)) return true;
  }
  // lockfile 不记录 libc 字段，gnu/musl 双变体的原生可选包（rollup/swc 等）只能靠名称后缀区分
  if (entry.optional) {
    const libc = detectLibc();
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (libc === 'glibc' && name.endsWith('-musl')) return true;
    if (libc === 'musl' && name.endsWith('-gnu')) return true;
  }
  return false;
}

/**
 * 逐个比对 dir 下实际安装的包与清单是否一致。
 * 返回 { total, problems: [{ pkg, expected, actual }] }
 */
function verifyInstall(dir, lock) {
  const problems = [];
  let total = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue; // 根包自身
    if (isForOtherPlatform(key, entry)) continue; // 其他平台的可选包本就不会安装
    total += 1;
    const pkgPath = path.join(dir, key);
    if (entry.link) {
      if (!fs.existsSync(pkgPath)) problems.push({ pkg: key, expected: '链接存在', actual: '缺失' });
      continue;
    }
    let actual = '缺失';
    try {
      actual = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf8')).version ?? '未知';
    } catch {
      /* 缺失或损坏，保持 actual 原值 */
    }
    if (actual !== entry.version) {
      problems.push({ pkg: key.replace(/^node_modules\//, ''), expected: entry.version, actual });
    }
  }
  return { total, problems };
}

function printProblems(problems, limit = 10) {
  for (const p of problems.slice(0, limit)) {
    info(`- ${p.pkg}: 期望 ${p.expected}，实际 ${p.actual}`);
  }
  if (problems.length > limit) info(`… 以及另外 ${problems.length - limit} 个`);
}

/** 清理本次运行的临时目录；若切换窗口内崩溃导致 node_modules 缺失，则把旧目录换回去 */
function cleanup() {
  try {
    fs.rmSync(STAGING, { recursive: true, force: true });
  } catch { /* 忽略 */ }
  try {
    if (fs.existsSync(TRASH)) {
      if (!fs.existsSync(NODE_MODULES)) fs.renameSync(TRASH, NODE_MODULES);
      else fs.rmSync(TRASH, { recursive: true, force: true });
    }
  } catch { /* 忽略 */ }
}

/** 清扫上一次崩溃遗留的隔离目录/旧目录，保证不会把半成品算进本次安装 */
function sweepStale() {
  for (const name of fs.readdirSync(ROOT)) {
    const full = path.join(ROOT, name);
    if (name.startsWith('.install-staging-') && full !== STAGING) {
      fs.rmSync(full, { recursive: true, force: true });
      info(`已清理上次中断遗留的半成品目录 ${name}`);
    } else if (name.startsWith('.install-trash-') && full !== TRASH) {
      if (!fs.existsSync(NODE_MODULES)) {
        fs.renameSync(full, NODE_MODULES);
        info(`已从 ${name} 恢复上次切换中断前的 node_modules`);
      } else {
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
  }
}

/** 运行 npm，实时透传输出并同时写入日志文件 */
function runNpm(npmArgs, cwd, logFile) {
  return new Promise((resolve) => {
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`$ ${NPM} ${npmArgs.join(' ')}  (cwd: ${cwd})\n\n`);
    let output = '';
    const child = spawn(NPM, npmArgs, { cwd, env: process.env });
    const onData = (chunk) => {
      output += chunk.toString();
      logStream.write(chunk);
    };
    child.stdout.on('data', (c) => { process.stdout.write(c); onData(c); });
    child.stderr.on('data', (c) => { process.stderr.write(c); onData(c); });
    child.on('error', (err) => { output += String(err); logStream.end(`\n${err}\n`); resolve({ code: 1, output }); });
    child.on('close', (code) => { logStream.end(); resolve({ code: code ?? 1, output }); });
  });
}

/** 从 npm 输出中识别失败原因与涉及的包（npm 旧版打 "npm ERR!"，新版打 "npm error"） */
function parseNpmError(output) {
  const isErrLine = (l) => /^npm (?:ERR!|error)\b/.test(l.trim());
  const errLines = [...new Set(output.split('\n').filter(isErrLine).map((l) => l.trim()))];
  const pkgs = new Set();
  const patterns = [
    /No matching version found for ([^\s]+)/,          // 版本不存在
    /'((?:@[\w.-]+\/)?[\w.-]+@[^']*)' is not in/,      // 包不在 registry
    /404\s+Not Found.*?'\/?((?:@[\w.-]+\/)?[\w.-]+)'/, // 404
    /peer\s+((?:@[\w.-]+\/)?[\w.-]+@[^\s]*)/,          // peer 依赖冲突
  ];
  for (const line of errLines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m) pkgs.add(m[1]);
    }
    const pathMatch = line.match(/npm (?:ERR!|error) path (.+)/); // 生命周期脚本失败的包路径
    if (pathMatch) pkgs.add(path.basename(pathMatch[1].trim()));
  }
  return {
    code: (output.match(/npm (?:ERR!|error) code (\S+)/) || [])[1],
    pkgs: [...pkgs],
    network: /npm (?:ERR!|error) network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|fetch failed|socket hang up/i.test(output),
    errLines: errLines.slice(0, 12),
  };
}

function fail({ detail, pkgs = [], errLines = [], network = false, logFile }) {
  console.error(`\n✗ 依赖安装失败`);
  console.error(`  卡在步骤: ${currentStep}`);
  if (detail) console.error(`  说明:     ${detail}`);
  if (pkgs.length) console.error(`  涉及包:   ${pkgs.join(', ')}`);
  if (errLines.length) {
    console.error(`  错误摘要:`);
    for (const l of errLines) console.error(`    ${l}`);
  }
  if (network) console.error(`  提示:     检测到网络错误，请检查网络/代理或 registry 配置后重试`);
  if (logFile) console.error(`  完整日志: ${path.relative(ROOT, logFile)}`);
  console.error(`  半成品:   隔离目录已清理，现有 node_modules 未受影响`);
  console.error(`  重试:     修复后重新运行 npm run setup（从头安装，不沿用半成品）`);
  cleanup();
  process.exit(1);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function npmVersion() {
  try {
    return spawnSync(NPM, ['--version'], { encoding: 'utf8' }).stdout.trim() || '未知';
  } catch {
    return '未知';
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// ---------- 只校验模式（npm run dev / build 前自动调用） ----------
if (VERIFY_ONLY) {
  if (!fs.existsSync(LOCKFILE)) {
    console.error('✗ 缺少版本清单 package-lock.json，请先运行 npm run setup');
    process.exit(1);
  }
  if (!fs.existsSync(NODE_MODULES)) {
    console.error('✗ 尚未安装依赖（node_modules 不存在），请先运行 npm run setup');
    process.exit(1);
  }
  const { total, problems } = verifyInstall(ROOT, readLockfile());
  if (problems.length === 0) {
    ok(`依赖校验通过：${total} 个包与 package-lock.json 一致，直接复用`);
    process.exit(0);
  }
  console.error(`✗ 已安装的依赖与 package-lock.json 不一致（${problems.length}/${total} 个包有问题）:`);
  printProblems(problems);
  console.error('  请运行 npm run setup 修复');
  process.exit(1);
}

// ---------- 安装模式 ----------
const startedAt = Date.now();
sweepStale();

// [1/5] 安装前校验：已装版本与清单一致则直接复用
step(1, '校验现有安装与版本清单是否一致');
const lock = readLockfile();
if (!lock) {
  info('尚无 package-lock.json，本次安装后将生成版本清单');
} else if (FORCE || UPDATE) {
  info(UPDATE ? '已指定 --update，将按 package.json 重新解析版本' : '已指定 --force，跳过复用检查');
} else if (!fs.existsSync(NODE_MODULES)) {
  info('node_modules 不存在，需要完整安装');
} else {
  const { total, problems } = verifyInstall(ROOT, lock);
  if (problems.length === 0) {
    ok(`现有 node_modules 与清单一致（${total} 个包），无需重新安装`);
    info(`清单: package-lock.json (sha256: ${sha256(LOCKFILE).slice(0, 12)}…)`);
    info('如需强制重装: npm run setup -- --force');
    process.exit(0);
  }
  warn(`发现 ${problems.length}/${total} 个包与清单不一致，将重新安装:`);
  printProblems(problems);
}

// [2/5] 准备隔离安装目录（半成品只会出现在这里，不污染 node_modules）
step(2, '准备隔离安装目录');
fs.mkdirSync(STAGING, { recursive: true });
fs.copyFileSync(PKG_JSON, path.join(STAGING, 'package.json'));
if (lock) fs.copyFileSync(LOCKFILE, path.join(STAGING, 'package-lock.json'));
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `install-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
info(`隔离目录: ${path.relative(ROOT, STAGING)}`);
info(`安装日志: ${path.relative(ROOT, logFile)}`);

// [3/5] 在隔离目录中安装；有清单用 npm ci 严格复现，否则用 npm install 生成清单
const useCi = lock && !UPDATE;
step(3, `安装依赖（${useCi ? 'npm ci，严格按清单复现' : 'npm install，按 package.json 解析并更新清单'}）`);
const npmArgs = [useCi ? 'ci' : 'install', '--no-audit', '--no-fund'];
const { code, output } = await runNpm(npmArgs, STAGING, logFile);
if (code !== 0) {
  const parsed = parseNpmError(output);
  fail({
    detail: `npm 退出码 ${code}${parsed.code ? `（${parsed.code}）` : ''}`,
    pkgs: parsed.pkgs,
    errLines: parsed.errLines,
    network: parsed.network,
    logFile,
  });
}

// [4/5] 校验隔离目录中实际装到的版本与清单一致，通过才允许生效
step(4, '校验新安装的版本与清单一致');
const stagingLock = readLockfile(path.join(STAGING, 'package-lock.json'));
const { total, problems } = verifyInstall(STAGING, stagingLock);
if (problems.length > 0) {
  console.error(`✗ ${problems.length}/${total} 个包与清单不一致:`);
  printProblems(problems);
  fail({ detail: '安装结果校验未通过', logFile });
}
ok(`${total} 个包全部与清单一致`);

// [5/5] 原子切换生效，并把本次装到的版本清单落到本地文件
step(5, '切换生效并记录版本清单');
try {
  if (fs.existsSync(NODE_MODULES)) fs.renameSync(NODE_MODULES, TRASH);
  fs.renameSync(path.join(STAGING, 'node_modules'), NODE_MODULES);
} catch (err) {
  fail({ detail: `切换目录失败: ${err.message}`, logFile });
}
// 清单有变化（首次生成 / --update）时写回项目根目录，供提交与复用
const stagingLockFile = path.join(STAGING, 'package-lock.json');
const lockChanged = fs.existsSync(stagingLockFile)
  && (!fs.existsSync(LOCKFILE) || sha256(stagingLockFile) !== sha256(LOCKFILE));
if (lockChanged) {
  fs.copyFileSync(stagingLockFile, LOCKFILE);
  ok('已把本次实际装到的版本清单写入 package-lock.json（请提交到仓库，供其他机器复用）');
}
const stamp = {
  installedAt: new Date().toISOString(),
  node: process.version,
  npm: npmVersion(),
  lockfileSha256: sha256(LOCKFILE),
  packages: total,
};
fs.writeFileSync(STAMP_FILE, `${JSON.stringify(stamp, null, 2)}\n`);
cleanup(); // 删除换下的旧目录与隔离目录残留

console.log(`\n✔ 依赖安装完成（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);
info(`包数量: ${total}`);
info(`版本清单: package-lock.json (sha256: ${stamp.lockfileSha256.slice(0, 12)}…)`);
info(`安装记录: node_modules/.install-stamp.json`);
info('下次启动将校验并直接复用，无需重复安装');
