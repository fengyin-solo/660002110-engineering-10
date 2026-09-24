#!/usr/bin/env node
/**
 * 依赖安装守门员
 *
 * 把「装依赖」变成一步看得见结果的操作：
 *   1. 安装前校验 node_modules 实际装到的版本与 package-lock.json 清单是否一致；
 *   2. 装不上时说明是哪个包、卡在哪一步、怎么修；
 *   3. 中途失败/被中断后重试，不会把上次装了一半的文件算进去（先清场再装）；
 *   4. 装完把本次装到的版本清单写入 .install-manifest.json，下次直接复用。
 *
 * 用法：
 *   node scripts/install.mjs           安装（能复用则复用，不一致则干净重装）
 *   node scripts/install.mjs --force   强制清场重装
 *   node scripts/install.mjs --check   只校验不安装（predev / prebuild 钩子用）
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_JSON = path.join(ROOT, 'package.json');
const LOCK_FILE = path.join(ROOT, 'package-lock.json');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const MANIFEST_FILE = path.join(ROOT, '.install-manifest.json');
const MARKER_FILE = path.join(ROOT, '.installing');
const ERROR_LOG = path.join(ROOT, 'install-error.log');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const FORCE = args.has('--force');

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const MAX_REPORT = 10; // 校验问题最多逐条列几个，超出折叠

// ---------- 小工具 ----------

const ok = (msg) => console.log(`  ✓ ${msg}`);
const info = (msg) => console.log(`  ${msg}`);
const step = (i, total, msg) => console.log(`\n[${i}/${total}] ${msg}`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 结构化报错并退出：哪个包、卡在哪一步、怎么修 */
function fail({ stage, pkg, detail, hints }) {
  console.error('\n✗ 依赖安装失败');
  console.error(`  卡在步骤：${stage}`);
  if (pkg) console.error(`  涉及包：${pkg}`);
  if (detail) console.error(`  原因：${detail}`);
  if (hints?.length) {
    console.error('  怎么修：');
    for (const h of hints) console.error(`    - ${h}`);
  }
  console.error('  修好后重跑 npm run setup 即可：会从头干净重装，不残留半成品。');
  process.exit(1);
}

// ---------- 校验 ----------

/** 校验 package.json 与 package-lock.json 是否同步，返回不同步的依赖列表 */
function checkLockInSync(pkg, lock) {
  const problems = [];
  const rootDeps = lock.packages?.[''] ?? {};
  for (const field of ['dependencies', 'devDependencies']) {
    const declared = pkg[field] ?? {};
    const locked = rootDeps[field] ?? {};
    for (const [name, spec] of Object.entries(declared)) {
      if (locked[name] !== spec) {
        problems.push(`${name}: package.json 要 ${spec}，清单里记的是 ${locked[name] ?? '（缺失）'}`);
      }
    }
    for (const name of Object.keys(locked)) {
      if (!(name in declared)) problems.push(`${name}: 清单里有，package.json 里已删除`);
    }
  }
  return problems;
}

/** 该包在当前平台上是否会被 npm 安装（os/cpu/libc 不匹配的 optional 包会被跳过） */
function appliesToThisPlatform(info) {
  if (info.os && !info.os.includes(process.platform)) return false;
  if (info.cpu && !info.cpu.includes(process.arch)) return false;
  if (info.libc && process.platform === 'linux') {
    // 有 glibcVersionRuntime 即为 glibc 系，否则按 musl（如 Alpine）处理
    let libc = 'musl';
    try {
      if (process.report?.getReport?.().header?.glibcVersionRuntime) libc = 'glibc';
    } catch { /* 检测失败就按 musl 处理 */ }
    if (!info.libc.includes(libc)) return false;
  }
  return true;
}

/**
 * 校验 node_modules 实际装到的版本与清单是否一致。
 * 能识别三种「半成品/不一致」：目录缺失、目录在但 package.json 缺失或损坏（解压一半）、版本对不上。
 */
function verifyInstalled(lock) {
  const problems = [];
  for (const [key, info] of Object.entries(lock.packages)) {
    if (key === '') continue; // 根条目不是真实包
    if (!appliesToThisPlatform(info)) continue; // 其它平台的 optional 包本就不会装
    const name = key.replace(/^node_modules\//, '');
    const dir = path.join(ROOT, key);
    if (!fs.existsSync(dir)) {
      problems.push({ pkg: name, kind: '缺失', detail: `应装 ${info.version}，目录不存在` });
      continue;
    }
    const installed = readJson(path.join(dir, 'package.json'));
    if (!installed) {
      problems.push({ pkg: name, kind: '损坏', detail: 'package.json 缺失或不可读，疑似上次解压到一半' });
      continue;
    }
    if (installed.version !== info.version) {
      problems.push({ pkg: name, kind: '版本不符', detail: `清单要 ${info.version}，实际装的是 ${installed.version}` });
    }
  }
  return problems;
}

function printProblems(problems) {
  const shown = problems.slice(0, MAX_REPORT);
  for (const p of shown) info(`✗ ${p.pkg}（${p.kind}）：${p.detail}`);
  if (problems.length > shown.length) info(`  ……共 ${problems.length} 个问题，其余从略`);
}

// ---------- 失败诊断 ----------

/** 从 tarball URL 里还原包名：.../@vue/shared/-/shared-3.4.5.tgz → @vue/shared */
function pkgNameFromUrl(url) {
  const before = url.split('/-/')[0];
  return before?.replace(/^https?:\/\/[^/]+\//, '') || null;
}

/** 从 npm 输出里诊断：哪个包、卡在哪一步 */
function diagnose(output) {
  let m;
  if ((m = output.match(/Invalid: lock file's (\S+) does not satisfy (\S+)/))) {
    return {
      stage: '清单同步校验',
      pkg: m[1],
      detail: `package-lock.json 里的版本不满足 package.json 声明的 ${m[2]}`,
      hints: ['运行 npm install --package-lock-only 重新生成清单', '把更新后的 package-lock.json 提交进仓库'],
    };
  }
  if (output.includes('npm error code ETARGET')) {
    m = output.match(/No matching version found for (\S+)/);
    return {
      stage: '解析版本',
      pkg: m?.[1],
      detail: '清单要求的版本在 registry 上不存在',
      hints: ['核对 package-lock.json 中的版本号是否写错', '确认当前 registry/镜像里有这个版本'],
    };
  }
  if (output.includes('npm error code EINTEGRITY')) {
    m = output.match(/Verification failed while extracting (\S+)/);
    const url = output.match(/npm error network request to (\S+)/)?.[1];
    return {
      stage: '下载后完整性校验',
      pkg: m?.[1] ?? (url && pkgNameFromUrl(url)),
      detail: '下载到的文件与清单记录的哈希不一致，文件可能损坏或被篡改',
      hints: ['运行 npm cache clean --force 清掉损坏的缓存后重试', '若走了代理/镜像，确认其没有改写包内容'],
    };
  }
  if (/npm error code (ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)/.test(output)
      || output.includes('npm error network')) {
    m = output.match(/npm error network request to (\S+) failed/);
    const reason = output.match(/failed, reason: (.+)/)?.[1];
    return {
      stage: '下载依赖包',
      pkg: m ? pkgNameFromUrl(m[1]) : null,
      detail: `网络请求失败${reason ? `：${reason}` : ''}`,
      hints: ['检查网络连接 / 代理设置', '公司内网可切换 registry 镜像后重试'],
    };
  }
  if (output.includes('npm error command failed')) {
    m = output.match(/node_modules[\/\\](@[^\/\\\s]+[\/\\][^\/\\\s]+|[^\/\\\s]+)/);
    return {
      stage: '执行安装脚本（postinstall 等）',
      pkg: m?.[1],
      detail: '该包自带的安装脚本执行失败',
      hints: ['查看上方日志中该包自己打印的错误', '确认其需要的系统环境（如编译工具链）已就绪'],
    };
  }
  return {
    stage: '未知',
    pkg: null,
    detail: 'npm 报错但未能自动归类，完整输出见下方日志文件',
    hints: [`查看 ${path.relative(process.cwd(), ERROR_LOG)} 定位具体原因`],
  };
}

// ---------- 安装 ----------

function cleanNodeModules() {
  fs.rmSync(NODE_MODULES, { recursive: true, force: true });
}

function runNpmCi() {
  const started = Date.now();
  const res = spawnSync(NPM, ['ci', '--no-audit', '--no-fund'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  return { res, output, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

function writeManifest(lock, lockHash, npmVersion) {
  const packages = {};
  for (const [key, info] of Object.entries(lock.packages)) {
    if (key !== '' && appliesToThisPlatform(info)) packages[key] = info.version;
  }
  const manifest = {
    lockfileHash: lockHash,
    installedAt: new Date().toISOString(),
    node: process.version,
    npm: npmVersion,
    packageCount: Object.keys(packages).length,
    packages,
  };
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ---------- 主流程 ----------

function main() {
  // [1] 环境检查
  step(1, 5, '环境检查');
  const npmRes = spawnSync(NPM, ['--version'], { encoding: 'utf8', shell: false });
  if (npmRes.status !== 0) {
    fail({ stage: '环境检查', detail: '找不到 npm 命令', hints: ['请先安装 Node.js（自带 npm）'] });
  }
  const npmVersion = npmRes.stdout.trim();
  ok(`node ${process.version}，npm ${npmVersion}`);

  // [2] 依赖清单检查：清单必须存在且与 package.json 同步，否则两台机器装出来的版本可能不同
  step(2, 5, '校验依赖清单（package-lock.json）');
  if (!fs.existsSync(LOCK_FILE)) {
    fail({
      stage: '校验依赖清单',
      detail: '缺少 package-lock.json，无法保证每次装到的版本一致',
      hints: ['运行 npm install --package-lock-only 生成清单', '把 package-lock.json 提交进仓库（注意 .gitignore 不要忽略它）'],
    });
  }
  const pkg = readJson(PKG_JSON);
  const lock = readJson(LOCK_FILE);
  if (!pkg || !lock?.packages) {
    fail({ stage: '校验依赖清单', detail: 'package.json 或 package-lock.json 不是合法的 JSON' });
  }
  const syncProblems = checkLockInSync(pkg, lock);
  if (syncProblems.length > 0) {
    fail({
      stage: '校验依赖清单',
      detail: `package.json 与清单不同步：\n    - ${syncProblems.join('\n    - ')}`,
      hints: ['运行 npm install --package-lock-only 重新生成清单并提交'],
    });
  }
  const lockHash = sha256File(LOCK_FILE);
  ok(`清单有效，共锁定 ${Object.keys(lock.packages).length - 1} 个包`);

  // [3] 复用判断：清单没变且实际安装校验通过，就直接复用
  step(3, 5, '检查能否复用现有安装');
  const interrupted = fs.existsSync(MARKER_FILE);
  const manifest = readJson(MANIFEST_FILE);
  const hasNodeModules = fs.existsSync(NODE_MODULES);

  if (interrupted) {
    info('发现上次安装被中断的标记，node_modules 不可信，需要重装');
  }

  if (CHECK_ONLY) {
    // 只校验不安装：dev/build 前的守门
    if (interrupted) {
      fail({ stage: '复用检查', detail: '上次安装被中断，依赖处于半成品状态', hints: ['运行 npm run setup 重新安装'] });
    }
    if (!hasNodeModules || !manifest) {
      fail({ stage: '复用检查', detail: '依赖尚未安装', hints: ['运行 npm run setup 安装'] });
    }
    if (manifest.lockfileHash !== lockHash) {
      fail({ stage: '复用检查', detail: '依赖清单已变更，现有安装不是最新', hints: ['运行 npm run setup 重新安装'] });
    }
    const problems = verifyInstalled(lock);
    if (problems.length > 0) {
      printProblems(problems);
      fail({ stage: '复用检查', detail: `现有安装与清单不一致（${problems.length} 个问题）`, hints: ['运行 npm run setup 修复'] });
    }
    ok(`依赖已就绪，复用 ${manifest.installedAt} 的安装（${manifest.packageCount} 个包）`);
    return;
  }

  if (!FORCE && !interrupted && hasNodeModules) {
    const problems = verifyInstalled(lock);
    if (problems.length === 0) {
      if (manifest?.lockfileHash === lockHash) {
        ok(`与清单一致，复用 ${manifest.installedAt} 的安装（${manifest.packageCount} 个包），无需重装`);
      } else {
        ok('与清单一致，补登记安装清单后复用，无需重装');
        writeManifest(lock, lockHash, npmVersion);
      }
      return;
    }
    info(`现有安装与清单不一致（${problems.length} 个问题）：`);
    printProblems(problems);
    info('将清场后干净重装');
  } else if (FORCE) {
    info('指定了 --force，强制重装');
  } else if (!hasNodeModules) {
    info('尚未安装依赖，开始安装');
  }

  // [4] 干净安装：先清场再装，失败不留半成品
  step(4, 5, '干净安装（npm ci）');
  fs.writeFileSync(MARKER_FILE, `${new Date().toISOString()}\n`); // 中断标记：装完才删
  cleanNodeModules();
  const { res, output, seconds } = runNpmCi();
  if (res.status !== 0) {
    fs.writeFileSync(ERROR_LOG, output);
    cleanNodeModules(); // 不留半成品
    fs.rmSync(MARKER_FILE, { force: true });
    console.error(`\nnpm 原始报错（完整版见 ${path.relative(process.cwd(), ERROR_LOG)}）：`);
    console.error(output.split('\n').filter((l) => l.includes('npm error')).slice(0, 15).join('\n'));
    fail(diagnose(output));
  }
  const added = output.match(/added (\d+) packages/)?.[1];
  ok(`安装完成（${added ?? '?'} 个包，耗时 ${seconds}s）`);

  // [5] 安装后校验 + 登记清单
  step(5, 5, '安装后校验并登记清单');
  const problems = verifyInstalled(lock);
  if (problems.length > 0) {
    printProblems(problems);
    cleanNodeModules();
    fs.rmSync(MARKER_FILE, { force: true });
    fail({
      stage: '安装后校验',
      detail: `装完的结果与清单不一致（${problems.length} 个问题），已清场`,
      hints: ['重跑 npm run setup', '若反复失败，检查 registry/镜像是否篡改了包'],
    });
  }
  const written = writeManifest(lock, lockHash, npmVersion);
  fs.rmSync(MARKER_FILE, { force: true });
  ok(`已校验 ${written.packageCount} 个包，版本清单已写入 ${path.basename(MANIFEST_FILE)}，下次可直接复用`);
  console.log('\n✓ 依赖安装完成');
}

main();
