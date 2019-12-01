'use strict'

import path from 'path'

import camelize from 'camelize'
import minimist from 'minimist'
import LRU from 'nanolru'
import { Options } from 'prettier'
import resolve from 'resolve'
import winston from 'winston'

const prettierCache = new LRU<CacheInstance>(10)
const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.splat(),
    winston.format.simple(),
  ),
  transports: [
    new winston.transports.File({ filename: '/tmp/prettier_d.log' }),
  ],
})

logger.debug('hello? %j', process.argv)

function createCache(cwd: string) {
  let prettierPath
  try {
    prettierPath = resolve.sync('prettier', { basedir: cwd })
  } catch (e) {
    // module not found
    prettierPath = resolve.sync('prettier')
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prettier: CacheInstance['prettier'] = require(prettierPath)
  const configPath = prettier.resolveConfigFile.sync(cwd)
  const ignorePath = path.join(cwd, '.prettierignore')
  const options =
    prettier.resolveConfig.sync(cwd, {
      useCache: false,
      editorconfig: true,
    }) || {}

  const cacheInstance: CacheInstance = {
    prettier,
    options,
    ignorePath,
    hasConfig: Boolean(configPath),
  }

  return prettierCache.set(cwd, cacheInstance)
}

function clearRequireCache(cwd: string) {
  Object.keys(require.cache)
    .filter((key) => key.startsWith(cwd))
    .forEach((key) => {
      delete require.cache[key]
    })
}

function parseArguments(args: string[]) {
  const parsedOptions = camelize(
    minimist(args, {
      boolean: [
        'use-tabs',
        'semi',
        'single-quote',
        'jsx-single-quote',
        'bracket-spacing',
        'jsx-bracket-same-line',
        'require-pragma',
        'insert-pragma',
        'vue-indent-script-and-style',
        'config',
        'editorconfig',

        // Added by prettier_d.
        'color',
        'stdin',
      ],
      default: {
        editorconfig: true,
        config: true,
        'print-width': 80,
        'tab-width': 2,
        'use-tabs': false,
        semi: true,
        'single-quote': false,
        'quote-props': 'as-needed',
        'jsx-single-quote': false,
        'trailing-comma': 'none',
        'bracket-spacing': true,
        'jsx-bracket-same-line': false,
        'arrow-parens': 'avoid',
        'range-start': 0,
        'range-end': Infinity,
        'require-pragma': false,
        'insert-pragma': false,
        'prose-wrap': 'preserve',
        'html-whitespace-sensitivity': 'css',
        'vue-indent-script-and-style': false,
        'end-of-line': 'auto',
      },
    }),
  )

  if (parsedOptions.stdinFilepath) {
    parsedOptions.filepath = parsedOptions.stdinFilepath
  }

  if (parsedOptions.configPrecedence == null) {
    parsedOptions.configPrecedence = 'file-override'
  }

  return parsedOptions
}

declare module 'prettier' {
  interface FileInfoOptions {
    pluginSearchDirs?: string[]
  }
}

/**
 * The core_d service entry point.
 */
export const invoke = function(
  cwd: string,
  args: string[],
  text: string,
  mtime: number,
) {
  process.chdir(cwd)

  let cache = prettierCache.get(cwd)
  if (!cache) {
    cache = createCache(cwd)
  } else if (mtime > (cache.lastRun || 0)) {
    clearRequireCache(cwd)
    cache = createCache(cwd)
  }
  cache.lastRun = Date.now()

  logger.debug('args: %j', args)
  logger.debug('cache.options: %j', cache.options)
  logger.debug('hasConfig: %j', cache.hasConfig)

  // Skip if there is no prettier config.
  if (!cache.hasConfig) {
    return text
  }

  const parsedOptions = parseArguments(args)
  logger.debug('parsedOptions: %j', parsedOptions)

  const filePath = parsedOptions.filepath

  const fileInfo = cache.prettier.getFileInfo.sync(filePath, {
    ignorePath: cache.ignorePath,
    pluginSearchDirs: parsedOptions.pluginSearchDir,
    plugins: parsedOptions.plugin,
  })

  logger.debug('fileInfo: %j', fileInfo)

  // Skip if file is ignored.
  if (fileInfo.ignored) {
    return text
  }

  let options: Options = {}
  switch (parsedOptions.configPrecedence) {
    case 'cli-override':
      options = Object.assign({}, cache.options, parsedOptions)
      break
    case 'file-override':
      options = Object.assign({}, parsedOptions, cache.options)
      break
  }

  if (parsedOptions.stdin && parsedOptions.filepath) {
    options.filepath = parsedOptions.filepath
  }

  logger.debug('formatting %s with %j', filePath, options)

  return cache.prettier.format(parsedOptions.text || text, options)
}

export const cache = prettierCache

/**
 * The core_d status hook.
 */
export const getStatus = function() {
  const { keys } = prettierCache
  if (keys.length === 0) {
    return 'No instances cached.'
  }
  if (keys.length === 1) {
    return 'One instance cached.'
  }
  return `${keys.length} instances cached.`
}

export interface CacheInstance {
  hasConfig: boolean
  ignorePath: string
  options: Options
  prettier: typeof import('prettier')
  lastRun?: number
}