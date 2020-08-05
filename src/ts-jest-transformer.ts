import type { CacheKeyOptions, TransformOptions, TransformedSource, Transformer } from '@jest/transform'
import type { Config } from '@jest/types'
import type { Logger } from 'bs-logger'
import { inspect } from 'util'

import { ConfigSet } from './config/config-set'
import { JS_JSX_REGEX, TS_TSX_REGEX } from './constants'
import type { TsJestGlobalOptions } from './types'
import { stringify } from './util/json'
import { JsonableValue } from './util/jsonable-value'
import { rootLogger } from './util/logger'
import { Errors, interpolate } from './util/messages'
import { sha1 } from './util/sha1'

const INSPECT_CUSTOM = inspect.custom || 'inspect'

interface ConfigSetIndexItem {
  configSet: ConfigSet
  jestConfig: JsonableValue<Config.ProjectConfig>
}

export class TsJestTransformer implements Transformer {
  /**
   * @internal
   */
  private static readonly _configSetsIndex: ConfigSetIndexItem[] = []
  /**
   * @internal
   */
  private static _lastTransformerId = 0
  /**
   * @internal
   */
  private static get _nextTransformerId() {
    return ++TsJestTransformer._lastTransformerId
  }
  private readonly logger: Logger
  private readonly id: number
  private readonly options: TsJestGlobalOptions

  constructor(baseOptions: TsJestGlobalOptions = {}) {
    this.options = { ...baseOptions }
    this.id = TsJestTransformer._nextTransformerId
    this.logger = rootLogger.child({
      transformerId: this.id,
      namespace: 'jest-transformer',
    })
    this.logger.debug({ baseOptions }, 'created new transformer')
  }

  /**
   * @internal
   */
  /* istanbul ignore next */
  [INSPECT_CUSTOM](): string {
    return `[object TsJestTransformer<#${this.id}>]`
  }

  /**
   * Use by e2e, don't mark as internal
   */
  configsFor(jestConfig: Config.ProjectConfig): ConfigSet {
    let csi: ConfigSetIndexItem | undefined = TsJestTransformer._configSetsIndex.find(
      (cs) => cs.jestConfig.value === jestConfig,
    )
    if (csi) return csi.configSet
    // try to look-it up by stringified version
    const serialized = stringify(jestConfig)
    csi = TsJestTransformer._configSetsIndex.find((cs) => cs.jestConfig.serialized === serialized)
    if (csi) {
      // update the object so that we can find it later
      // this happens because jest first calls getCacheKey with stringified version of
      // the config, and then it calls the transformer with the proper object
      csi.jestConfig.value = jestConfig

      return csi.configSet
    }
    const jestConfigObj: Config.ProjectConfig = jestConfig

    // create the new record in the index
    this.logger.info('no matching config-set found, creating a new one')

    const configSet = new ConfigSet(jestConfigObj, this.options, this.logger)
    TsJestTransformer._configSetsIndex.push({
      jestConfig: new JsonableValue(jestConfigObj),
      configSet,
    })

    return configSet
  }

  process(
    input: string,
    filePath: Config.Path,
    jestConfig: Config.ProjectConfig,
    transformOptions?: TransformOptions,
  ): TransformedSource | string {
    this.logger.debug({ fileName: filePath, transformOptions }, 'processing', filePath)

    let result: string | TransformedSource
    const source: string = input
    const configs = this.configsFor(jestConfig)
    const { hooks } = configs
    const shouldStringifyContent = configs.shouldStringifyContent(filePath)
    const babelJest = shouldStringifyContent ? undefined : configs.babelJestTransformer
    const isDefinitionFile = filePath.endsWith('.d.ts')
    const isJsFile = JS_JSX_REGEX.test(filePath)
    const isTsFile = !isDefinitionFile && TS_TSX_REGEX.test(filePath)
    if (shouldStringifyContent) {
      // handles here what we should simply stringify
      result = `module.exports=${stringify(source)}`
    } else if (isDefinitionFile) {
      // do not try to compile declaration files
      result = ''
    } else if (!configs.parsedTsConfig.options.allowJs && isJsFile) {
      // we've got a '.js' but the compiler option `allowJs` is not set or set to false
      this.logger.warn({ fileName: filePath }, interpolate(Errors.GotJsFileButAllowJsFalse, { path: filePath }))

      result = source
    } else if (isJsFile || isTsFile) {
      // transpile TS code (source maps are included)
      /* istanbul ignore if */
      result = configs.tsCompiler.compile(source, filePath)
    } else {
      // we should not get called for files with other extension than js[x], ts[x] and d.ts,
      // TypeScript will bail if we try to compile, and if it was to call babel, users can
      // define the transform value with `babel-jest` for this extension instead
      const message = babelJest ? Errors.GotUnknownFileTypeWithBabel : Errors.GotUnknownFileTypeWithoutBabel

      this.logger.warn({ fileName: filePath }, interpolate(message, { path: filePath }))

      result = source
    }
    // calling babel-jest transformer
    if (babelJest) {
      this.logger.debug({ fileName: filePath }, 'calling babel-jest processor')

      // do not instrument here, jest will do it anyway afterwards
      result = babelJest.process(result, filePath, jestConfig, { ...transformOptions, instrument: false })
    }
    // allows hooks (useful for testing)
    if (hooks.afterProcess) {
      this.logger.debug({ fileName: filePath, hookName: 'afterProcess' }, 'calling afterProcess hook')

      const newResult = hooks.afterProcess([input, filePath, jestConfig, transformOptions], result)
      if (newResult !== undefined) {
        return newResult
      }
    }

    return result
  }

  /**
   * Jest uses this to cache the compiled version of a file
   *
   * @see https://github.com/facebook/jest/blob/v23.5.0/packages/jest-runtime/src/script_transformer.js#L61-L90
   * @param fileContent The content of the file
   * @param filePath The full path to the file
   * @param _jestConfigStr The JSON-encoded version of jest config
   * @param transformOptions
   * @param transformOptions.instrument Whether the content will be instrumented by our transformer (always false)
   * @param transformOptions.rootDir Jest current rootDir
   */
  getCacheKey(
    fileContent: string,
    filePath: string,
    _jestConfigStr: string,
    transformOptions: CacheKeyOptions,
  ): string {
    this.logger.debug({ fileName: filePath, transformOptions }, 'computing cache key for', filePath)

    const configs = this.configsFor(transformOptions.config)
    // we do not instrument, ensure it is false all the time
    const { instrument = false, rootDir = configs.rootDir } = transformOptions

    return sha1(
      configs.cacheKey,
      '\x00',
      rootDir,
      '\x00',
      `instrument:${instrument ? 'on' : 'off'}`,
      '\x00',
      fileContent,
      '\x00',
      filePath,
    )
  }
}
