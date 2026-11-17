/**
 * 把插件装进 Claude Code 的插件体系。
 *
 * ## 为什么不是"把 hooks 抄进 settings.json"
 *
 * 那种做法能用，但用户会在 `/plugin` 里看不到它、没法开关、升级了就忘。
 * 装成真插件要写三处登记，缺一处 Claude Code 就不认：
 *
 *   1. `~/.claude/plugins/feibi-breaker/`        ← 插件本体（含 .claude-plugin/plugin.json）
 *   2. `~/.claude/plugins/known_marketplaces.json` ← 这个插件来自哪个市场（本地目录源）
 *   3. `~/.claude/plugins/installed_plugins.json`  ← 装了什么、装在哪、什么版本
 *   4. `~/.claude/settings.json` 的 `enabledPlugins` ← 允不允许它跑
 *
 * 第 4 步是关键：装而不启用 = hooks 一条都不跑，用户以为插件坏了。
 *
 * @module feibi-breaker-cc/plugin-install
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 项目根（marketplace 就在这儿）。 */
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 插件名 / 市场名。市场名和插件名一样，所以启用键是 `feibi-breaker@feibi-breaker`。 */
export const PLUGIN_NAME = 'feibi-breaker'
export const MARKETPLACE_NAME = 'feibi-breaker'

/** 插件自带的 output style 名（`output-styles/feibi.json` 里的 name）。 */
export const OUTPUT_STYLE_NAME = 'feibi'

/** 读/写共用的 feibi 配置，用来记住"接管前的 output style"。 */
function readFeibiConfig(paths) {
  return readJson(path.join(paths.feibiHome, 'config.json'), {})
}

function writeFeibiConfig(paths, value) {
  writeJson(path.join(paths.feibiHome, 'config.json'), value)
}

/** 用户家目录（测试用 FEIBI_USERHOME 覆盖）。 */
function userHome() {
  const fromEnv = process.env.FEIBI_USERHOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return os.homedir()
}

/** Claude 配置目录。 */
function claudeDir() {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(userHome(), '.claude')
}

/** 安装相关的全部路径。 */
export function pluginPaths() {
  const claude = claudeDir()
  const plugins = path.join(claude, 'plugins')
  return {
    claude,
    plugins,
    install: path.join(plugins, PLUGIN_NAME),
    source: path.join(PROJECT_ROOT, 'plugin'),
    known: path.join(plugins, 'known_marketplaces.json'),
    installed: path.join(plugins, 'installed_plugins.json'),
    settings: path.join(claude, 'settings.json'),
    marketplace: PROJECT_ROOT,
    feibiHome: path.join(claude, 'feibi'),
  }
}

/** 读 JSON 文件，坏了给兜底值。 */
function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** 原子写。 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** 插件版本，从 plugin.json 读。 */
function pluginVersion(sourceDir) {
  const manifest = readJson(path.join(sourceDir, '.claude-plugin', 'plugin.json'), {})
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/**
 * 装插件。
 *
 * @param {{home?: string, sourceRoot?: string}} [options] - 可选覆盖。
 * @returns {object} 结果。
 */
export function installPlugin(options = {}) {
  const paths = pluginPaths()
  const source = options.sourceRoot ?? paths.source
  if (!fs.existsSync(path.join(source, '.claude-plugin', 'plugin.json'))) {
    return { ok: false, error: `插件源不完整：${source} 下没有 .claude-plugin/plugin.json` }
  }

  const version = pluginVersion(source)

  // 1. 插件本体（先清干净再拷，避免旧版本残留的 hook 继续跑）
  try {
    fs.rmSync(paths.install, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(paths.install), { recursive: true })
    fs.cpSync(source, paths.install, { recursive: true })
  } catch (error) {
    return { ok: false, error: `拷贝插件失败：${error instanceof Error ? error.message : String(error)}` }
  }

  // 1c. 把 /feibi 命令里的兜底路径换成真实路径。
  //
  // 命令正文里那句 `node "__FEIBI_BIN__" show` 是给"feibi-cc 不在 PATH 上"准备的
  // 兜底；插件被拷到 ~/.claude/plugins 之后，源目录的绝对路径只有安装器知道，
  // 所以在拷贝时替换掉占位符，而不是让用户自己填。
  try {
    const commandFile = path.join(paths.install, 'commands', 'feibi.md')
    const binFile = path.join(PROJECT_ROOT, 'bin', 'feibi-cc.mjs')
    if (fs.existsSync(commandFile)) {
      const text = fs.readFileSync(commandFile, 'utf8')
      if (text.includes('__FEIBI_BIN__')) {
        fs.writeFileSync(commandFile, text.split('__FEIBI_BIN__').join(binFile.split('\\').join('\\\\')), 'utf8')
      }
    }
  } catch {
    // 替换失败只是兜底路径不对，主路径 feibi-cc 还在。
  }

  // 2. 市场登记
  const known = readJson(paths.known, {})
  known[MARKETPLACE_NAME] = {
    source: { source: 'directory', path: paths.marketplace },
    installLocation: paths.marketplace,
    lastUpdated: new Date().toISOString(),
  }
  writeJson(paths.known, known)

  // 3. 已装登记
  const installed = readJson(paths.installed, { version: 2, plugins: {} })
  installed.version = 2
  installed.plugins = installed.plugins ?? {}
  const now = new Date().toISOString()
  const entry = installed.plugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]
  installed.plugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`] = [{
    scope: 'user',
    installPath: paths.install,
    version,
    installedAt: Array.isArray(entry) && entry[0]?.installedAt ? entry[0].installedAt : now,
    lastUpdated: now,
  }]
  writeJson(paths.installed, installed)

  // 4. 允许它跑（这一步漏了，前面三步全白做）
  const settings = readJson(paths.settings, {})
  settings.enabledPlugins = settings.enabledPlugins ?? {}
  const wasEnabled = settings.enabledPlugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`] === true
  settings.enabledPlugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`] = true

  // 4b. 把 output style 切成插件自带的那份。
  //
  // 这是整个插件形态里最强的一个入口：output style 的 prompt 进的是**系统提示词**，
  // 而 hooks 的 additionalContext 进的是用户侧上下文。同一段 payload，走系统提示词
  // 时模型直接照做，走上下文时模型会先答身份再补一句"我不会照着扮演"——
  // 实测差别就在这儿。所以安装时直接把它设成默认，用户不用记命令。
  const previousStyle = typeof settings.outputStyle === 'string' ? settings.outputStyle : null
  const styleFile = path.join(paths.install, 'output-styles', 'feibi.json')
  const styleAvailable = fs.existsSync(styleFile)
  /**
   * output style 这一路**不自动启用**。
   *
   * 本来想用它：style 的 prompt 进的是系统提示词，比 hooks 的 additionalContext
   * 强一档。但实测这个版本（CLI 2.1.325）**根本不读 `settings.outputStyle`**：
   * 把名字写成 `zzz-not-a-style` 也照样跑、不报错、不生效。
   *
   * 所以自动设它是有害的：早期实现里 hook 看到 `outputStyle=feibi` 就跳过注入，
   * 结果"style 没生效 + hook 主动让路" = 一条都没注进去（实测确认过）。
   * 现在反过来处理：值如果还留着，清掉；风格文件保留在插件里，
   * 哪天版本支持了或者用户在 UI 里手动选了，它就在那儿。
   */
  if (settings.outputStyle === OUTPUT_STYLE_NAME) {
    const previous = (() => {
      try { return readFeibiConfig(paths).previousOutputStyle ?? null } catch { return null }
    })()
    if (typeof previous === 'string' && previous.length > 0) settings.outputStyle = previous
    else delete settings.outputStyle
  }

  writeJson(paths.settings, settings)

  // 5. 把提示词种成用户可编辑的那份（和代理版共用同一个文件）
  let seeded = 'kept'
  try {
    fs.mkdirSync(paths.feibiHome, { recursive: true })
    const target = path.join(paths.feibiHome, 'prompt.md')
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(source, 'prompts', 'feibi.md'), target)
      seeded = 'created'
    }
  } catch {
    seeded = 'failed'
  }

  return {
    ok: true,
    version,
    installPath: paths.install,
    marketplace: paths.marketplace,
    settings: paths.settings,
    promptFile: path.join(paths.feibiHome, 'prompt.md'),
    promptSeeded: seeded,
    alreadyEnabled: wasEnabled,
    enabledKey: `${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    outputStyle: styleAvailable ? OUTPUT_STYLE_NAME : null,
    previousOutputStyle: previousStyle,
  }
}

/**
 * 卸插件。
 *
 * 只是"停止运行 + 注销登记"，**不删** `~/.claude/feibi/`（提示词在那儿，
 * 用户改过的东西不该在卸载时消失）。
 *
 * @returns {object} 结果。
 */
export function uninstallPlugin() {
  const paths = pluginPaths()
  const known = readJson(paths.known, {})
  delete known[MARKETPLACE_NAME]
  writeJson(paths.known, known)

  const installed = readJson(paths.installed, { version: 2, plugins: {} })
  if (installed.plugins) delete installed.plugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]
  writeJson(paths.installed, installed)

  const settings = readJson(paths.settings, {})
  if (settings.enabledPlugins) delete settings.enabledPlugins[`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]
  // 还回接管前的 output style；没记过就删掉这个键，回到默认。
  if (settings.outputStyle === OUTPUT_STYLE_NAME) {
    let previous = null
    try {
      previous = readFeibiConfig(paths).previousOutputStyle ?? null
    } catch {
      previous = null
    }
    if (typeof previous === 'string' && previous.length > 0) settings.outputStyle = previous
    else delete settings.outputStyle
  }
  writeJson(paths.settings, settings)

  try {
    fs.rmSync(paths.install, { recursive: true, force: true })
  } catch {
    // 删不掉（文件被占用）也不影响：登记已经注销，hooks 不会再被调用。
  }

  return { ok: true, removed: paths.install }
}

/**
 * 读插件当前的安装状态，给 `feibi-cc plugin status` 用。
 *
 * @returns {object} 状态。
 */
export function pluginStatus() {
  const paths = pluginPaths()
  const manifest = readJson(path.join(paths.install, '.claude-plugin', 'plugin.json'), null)
  const known = readJson(paths.known, {})
  const installed = readJson(paths.installed, { version: 2, plugins: {} })
  const settings = readJson(paths.settings, {})
  const key = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
  const entry = installed.plugins?.[key]?.[0] ?? null

  return {
    installed: manifest !== null && entry !== null,
    enabled: settings.enabledPlugins?.[key] === true,
    version: manifest?.version ?? entry?.version ?? null,
    installPath: paths.install,
    marketplaceKnown: known[MARKETPLACE_NAME] !== undefined,
    sourceExists: fs.existsSync(path.join(paths.source, 'hooks', 'hooks.json')),
    hooksPresent: fs.existsSync(path.join(paths.install, 'hooks', 'hooks.json')),
    key,
  }
}
