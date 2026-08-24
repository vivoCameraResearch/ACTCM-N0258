#!/usr/bin/env node
// Copyright 2025-2026 维沃移动通信有限公司 (vivo Mobile Communication Co., Ltd.)
// SPDX-License-Identifier: Apache-2.0
/**
 * 构建可分发静态包到 dist/：
 * - 打包 ES module 为 IIFE（可 file:// 打开，无需 Python/服务器）
 * - 内嵌 cow 示例图与元数据
 * - 仅拷贝运行所需文件（不含 40MB+ 测试素材）
 */
import { mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = join(ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'uwa-color'), { recursive: true });

// 1) 内嵌 test.avif，保证 file:// 双击 dist/index.html 可加载（约 16MB）
const testAvifPath = join(ROOT, 'data/test.avif');
if (!existsSync(testAvifPath)) throw new Error('missing data/test.avif');
mkdirSync(join(DIST, 'data'), { recursive: true });
cpSync(testAvifPath, join(DIST, 'data/test.avif'));
const testAvifB64 = readFileSync(testAvifPath).toString('base64');
writeFileSync(
  join(DIST, 'sample-embedded.js'),
  `window.__GAINCURVE_SAMPLE__=${JSON.stringify({ avifBase64: testAvifB64 })};\n`
);

// 2) 打包业务代码为 IIFE（npx esbuild，无需本地安装）
execSync(
  `npx --yes esbuild ${JSON.stringify(join(ROOT, 'src/main.js'))} --bundle --format=iife --platform=browser --outfile=${JSON.stringify(join(DIST, 'app.js'))}`,
  { stdio: 'inherit', cwd: ROOT }
);

// 3) uwa-color 底层库 + 样式（全局脚本，保持原样）
const kUwaColorScripts = [
  'uwa-transfer.js',
  'uwa-chromaticity.js',
  'uwa-hermite-curve.js',
  'uwa-headroom-adapt.js',
  'uwa-tonemap-gl.js',
];
for (const f of kUwaColorScripts) {
  cpSync(join(ROOT, 'uwa-color', f), join(DIST, 'uwa-color', f));
}
cpSync(join(ROOT, 'styles.css'), join(DIST, 'styles.css'));

// 4) 入口 HTML：跟开发版同步，只改脚本加载方式
const scripts = ['<!-- bundled entry -->', '<script src="sample-embedded.js"></script>']
  .concat(kUwaColorScripts.map((f) => `<script src="uwa-color/${f}"></script>`))
  .concat(['<script src="app.js"></script>'])
  .join('\n');

let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
html = html.replace(
  /<script src="uwa-color\/[\s\S]*?<script type="module" src="src\/main\.js"><\/script>/,
  scripts
);
if (!html.includes('src="app.js"')) {
  throw new Error('build-dist: failed to rewrite index.html script tags');
}
writeFileSync(join(DIST, 'index.html'), html);

// 5) macOS 双击入口 + 简短说明
writeFileSync(
  join(DIST, 'Open-Demo.command'),
  `#!/bin/bash
cd "$(dirname "$0")"
open index.html
`
);
writeFileSync(
  join(DIST, 'README.txt'),
  `gainCurve Web Demo
==================
Double-click index.html (or Open-Demo.command on macOS).
Default image test.avif is embedded — works offline via file://.

Dev (no rebuild):
  cd web-demo && python3 serve.py
  open http://127.0.0.1:8765/

Rebuild:  cd web-demo && node build-dist.mjs
`
);
if (process.platform !== 'win32') {
  try {
    execSync(`chmod +x "${join(DIST, 'Open-Demo.command')}"`, { stdio: 'ignore' });
  } catch (_) {}
}

// 6) 可选：打成 zip 便于分发（需要系统提供 zip 命令，缺失时静默跳过）
console.log(`\n✓ dist/ 已生成`);
const zipLocal = join(ROOT, 'gainCurve-web-demo.zip');
try {
  if (existsSync(zipLocal)) rmSync(zipLocal);
  execSync(`zip -qr "${zipLocal}" .`, { cwd: DIST, stdio: 'ignore' });
  const sizeMB = (readFileSync(zipLocal).length / 1024 / 1024).toFixed(2);
  console.log(`✓ ${zipLocal} (${sizeMB} MB)`);
} catch (_) {
  console.log('· 未找到 zip 命令，已跳过打包步骤（dist/ 可直接分发）');
}
console.log(`  分发：解压后双击 index.html（已内嵌 test.avif，支持 file://）`);
