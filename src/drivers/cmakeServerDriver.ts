import { CMakeExecutable } from '@cmt/cmake/cmakeExecutable';
import { InputFileSet } from '@cmt/dirty';
import { ConfigureTrigger } from '@cmt/cmakeTools';
import * as path from 'path';
import * as vscode from 'vscode';
import * as api from '@cmt/api';
import { CacheEntryProperties, ExecutableTarget, RichTarget } from '@cmt/api';
import * as cache from '@cmt/cache';
import * as cms from '@cmt/drivers/cmakeServerClient';
import { CMakeDriver, CMakePreconditionProblemSolver } from '@cmt/drivers/cmakeDriver';
import { Kit, CMakeGenerator } from '@cmt/kit';
import { createLogger } from '@cmt/logging';
import * as proc from '@cmt/proc';
import rollbar from '@cmt/rollbar';
import { ConfigurationReader } from '@cmt/config';
import { errorToString } from '@cmt/util';
import * as nls from 'vscode-nls';
import * as ext from '@cmt/extension';
import { BuildPreset, ConfigurePreset, TestPreset } from '@cmt/preset';
import { CodeModelConfiguration, CodeModelContent, CodeModelFileGroup, CodeModelProject, CodeModelTarget } from '@cmt/drivers/codeModel';
import { VariantManager } from '@cmt/variant';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const log = createLogger('cms-driver');

export class NoGeneratorError extends Error {
    message: string = localize('no.usable.generator.found', 'No usable generator found.');
}

export class CMakeServerDriver extends CMakeDriver {

    get isCacheConfigSupported(): boolean {
        return false;
    }

    async doCacheConfigure(): Promise<number> {
        throw new Error('Method not implemented.');
    }

    private constructor(
        cmake: CMakeExecutable,
        readonly config: ConfigurationReader,
        workspaceFolder: string | null,
        preconditionHandler: CMakePreconditionProblemSolver,
        variantManager: VariantManager | null) {
        super(cmake, config, workspaceFolder, preconditionHandler, variantManager);
        this.config.onChange('environment', () => this._restartClient());
        this.config.onChange('configureEnvironment', () => this._restartClient());
    }

    private _cmsClient: Promise<cms.CMakeServerClient | null> = Promise.resolve(null);
    private _clientChangeInProgress: Promise<void> = Promise.resolve();
    private _globalSettings!: cms.GlobalSettingsContent;
    private _cacheEntries = new Map<string, cache.Entry>();
    private _cmakeInputFileSet = InputFileSet.createEmpty();

    private readonly _progressEmitter = new vscode.EventEmitter<cms.ProgressMessage>();
    get onProgress() {
        return this._progressEmitter.event;
    }

    /**
     * The previous configuration environment. Used to detect when we need to
     * restart cmake-server
     */
    private _prevConfigureEnv = 'null';

    private codeModel: CodeModelContent | null = null;
    private convertServerCodeModel(serverCodeModel: null | cms.ServerCodeModelContent): CodeModelContent | null {
        if (serverCodeModel) {
            const codeModel: CodeModelContent = { configurations: [] };
            for (const config of serverCodeModel.configurations) {
                const newConfig: CodeModelConfiguration = { name: config.name, projects: [] };
                for (const project of config.projects) {
                    const newProject: CodeModelProject = {
                        name: project.name,
                        sourceDirectory: project.sourceDirectory,
                        hasInstallRule: project.hasInstallRule,
                        targets: []
                    };
                    for (const target of project.targets) {
                        const newTarget: CodeModelTarget = {
                            name: target.name,
                            type: target.type,
                            sourceDirectory: target.sourceDirectory,
                            fullName: target.fullName,
                            artifacts: target.artifacts,
                            sysroot: target.sysroot,
                            fileGroups: []
                        };
                        const linkLanguageFlags: string | undefined = target.linkLanguageFlags;
                        if (target.fileGroups) {
                            newTarget.fileGroups = [];
                            for (const group of target.fileGroups) {
                                const newGroup: CodeModelFileGroup = {
                                    sources: group.sources,
                                    language: group.language,
                                    includePath: group.includePath,
                                    defines: group.defines,
                                    isGenerated: group.isGenerated,
                                    compileCommandFragments: group.compileFlags ? [group.compileFlags] : (linkLanguageFlags ? [linkLanguageFlags] : [])
                                };
                                newTarget.fileGroups.push(newGroup);
                            }
                        }
                        newProject.targets.push(newTarget);
                    }
                    newConfig.projects.push(newProject);
                }
                codeModel.configurations.push(newConfig);
            }
            return codeModel;
        }
        return null;
    }

    private readonly _codeModelChanged = new vscode.EventEmitter<null | CodeModelContent>();
    get onCodeModelChanged() {
        return this._codeModelChanged.event;
    }

    async asyncDispose() {
        this._codeModelChanged.dispose();
        this._progressEmitter.dispose();

        await this.shutdownClient();
    }

    private async shutdownClient() {
        const cl = await this._cmsClient;
        if (cl) {
            await cl.shutdownAsync();
        }
    }

    private async getClient(): Promise<cms.CMakeServerClient> {
        if (!(await this._cmsClient)) {
            this._cmsClient = this._startNewClient();
        }

        const client_started = await this._cmsClient;
        if (!(client_started)) {
            throw Error('Unable to start cms client');
        } else {
            return client_started;
        }
    }

    protected async doPreCleanConfigure(): Promise<void> {
        const old_cl = await this._cmsClient;
        this._cmsClient = (async () => {
            // Stop the server before we try to rip out any old files
            if (old_cl) {
                await old_cl.shutdownAsync();
            }
            await this._cleanPriorConfiguration();
            return this._startNewClient();
        })();
    }

    protected async doConfigure(args: string[], consumer?: proc.OutputConsumer, showCommandOnly?: boolean) {
        await this._clientChangeInProgress;
        const cl = await this.getClient();
        const sub = this.onMessage(msg => {
            if (consumer) {
                for (const line of msg.split('\n')) {
                    consumer.output(line);
                }
            }
        });

        if (showCommandOnly) {
            log.showChannel();
            log.info(proc.buildCmdStr(this.cmake.path, args));
        } else {
            try {
                this._hadConfigurationChanged = false;
                await cl.configure({ cacheArguments: args });
                await cl.compute();
            } catch (e) {
                if (e instanceof cms.ServerError) {
                    log.error(localize('cmake.configure.error', 'Error during CMake configure: {0}', errorToString(e)));
                    return 1;
                } else {
                    throw e;
                }
            } finally {
                sub.dispose();
            }
            await this._refreshPostConfigure();
        }
        return 0;
    }

    protected async doPreBuild(): Promise<boolean> {
        return true;
    }

    protected async doPostBuild(): Promise<boolean> {
        await this._refreshPostConfigure();
        return true;
    }

    async _refreshPostConfigure(): Promise<void> {
        const client = await this.getClient();
        const cmake_inputs = await client.cmakeInputs();  // <-- 1. This line generates the error
        // Scan all the CMake inputs and capture their mtime so we can check for
        // out-of-dateness later
        this._cmakeInputFileSet = await InputFileSet.create(cmake_inputs);
        const clcache = await client.getCMakeCacheContent();
        this._cacheEntries = clcache.cache.reduce((acc, el) => {
            const entry_map: { [key: string]: api.CacheEntryType | undefined } = {
                BOOL: api.CacheEntryType.Bool,
                STRING: api.CacheEntryType.String,
                PATH: api.CacheEntryType.Path,
                FILEPATH: api.CacheEntryType.FilePath,
                INTERNAL: api.CacheEntryType.Internal,
                UNINITIALIZED: api.CacheEntryType.Uninitialized,
                STATIC: api.CacheEntryType.Static
            };
            const type = entry_map[el.type];
            if (type === undefined) {
                rollbar.error(localize('unknown.cache.entry.type', 'Unknown cache entry type {0}', el.type));
                return acc;
            }
            acc.set(el.key,
                new cache.Entry(el.key, el.value, type, el.properties.HELPSTRING, el.properties.ADVANCED === '1'));
            return acc;
        }, new Map<string, cache.Entry>());
        // Convert ServerCodeModel to general CodeModel.
        this.codeModel = this.convertServerCodeModel(await client.codemodel());
        this._codeModelChanged.fire(this.codeModel);
    }

    async doRefreshExpansions(cb: () => Promise<void>): Promise<void> {
        log.debug('Run doRefreshExpansions');
        const bindir_before = this.binaryDir;
        const srcdir_before = this.sourceDir;
        await cb();
        if (!bindir_before.length || !srcdir_before.length) {
            return;
        }
        const new_env = JSON.stringify(await this.getConfigureEnvironment());
        if (bindir_before !== this.binaryDir || srcdir_before !== this.sourceDir || new_env !== this._prevConfigureEnv) {
            // Directories changed. We need to restart the driver
            await this._restartClient();
        }
        this._prevConfigureEnv = new_env;
    }

    get targets(): RichTarget[] {
        if (!this.codeModel) {
            return [];
        }
        const build_config = this.codeModel.configurations.find(conf => conf.name === this.currentBuildType);
        if (!build_config) {
            log.error(localize('found.no.matching.code.model', 'Found no matching code model for the current build type. This shouldn\'t be possible'));
            return [];
        }
        const metaTargets = [{
            type: 'rich' as 'rich',
            name: this.allTargetName,
            filepath: localize('build.all.target', 'A special target to build all available targets'),
            targetType: 'META'
        }];
        if (build_config.projects.some(project => (project.hasInstallRule) ? project.hasInstallRule : false)) {
            metaTargets.push({
                type: 'rich' as 'rich',
                name: 'install',
                filepath: localize('install.all.target', 'A special target to install all available targets'),
                targetType: 'META'
            });
        }
        return build_config.projects.reduce<RichTarget[]>(
            (acc, project) => acc.concat(project.targets.map(t => ({
                type: 'rich' as 'rich',
                name: t.name,
                filepath: t.artifacts && t.artifacts.length
                    ? path.normalize(t.artifacts[0])
                    : localize('utility.target', 'Utility target'),
                targetType: t.type
            }))),
            metaTargets);
    }

    get executableTargets(): ExecutableTarget[] {
        return this.targets.filter(t => t.targetType === 'EXECUTABLE')
            .reduce(targetReducer, [])
            .map(t => ({ name: t.name, path: t.filepath }));
    }

    get uniqueTargets(): api.Target[] {
        return this.targets.reduce(targetReducer, []);
    }

    get cmakeFiles(): string[] {
        return this._cmakeInputFileSet.inputFiles.map(file => file.filePath);
    }

    get generatorName(): string | null {
        return this._globalSettings ? this._globalSettings.generator : null;
    }

    /**
     * Track if the user changes the settings of the configure via settings.json
     */
    private _hadConfigurationChanged = true;
    protected doConfigureSettingsChange() {
        this._hadConfigurationChanged = true;
    }

    async checkNeedsReconfigure(): Promise<boolean> {
        if (this._hadConfigurationChanged) {
            return this._hadConfigurationChanged;
        }
        // If we have no input files, we probably haven't configured yet
        if (this._cmakeInputFileSet.inputFiles.length === 0) {
            return true;
        }
        return this._cmakeInputFileSet.checkOutOfDate();
    }

    get cmakeCacheEntries(): Map<string, CacheEntryProperties> {
        return this._cacheEntries;
    }

    private async _setKitAndRestart(need_clean: boolean, cb: () => Promise<void>) {
        this._cmakeInputFileSet = InputFileSet.createEmpty();
        const client = await this._cmsClient;
        if (client) {
            await client.shutdownAsync();
        }
        if (need_clean) {
            await this._cleanPriorConfiguration();
        }
        await cb();
        if (!this.generator) {
            throw new NoGeneratorError();
        }

        await this._restartClient();
    }

    doSetKit(cb: () => Promise<void>): Promise<void> {
        this._clientChangeInProgress = this._setKitAndRestart(false, cb);
        return this._clientChangeInProgress;
    }

    doSetConfigurePreset(need_clean: boolean, cb: () => Promise<void>): Promise<void> {
        this._clientChangeInProgress = this._setKitAndRestart(need_clean, cb);
        return this._clientChangeInProgress;
    }

    doSetBuildPreset(cb: () => Promise<void>): Promise<void> {
        return cb();
    }

    doSetTestPreset(cb: () => Promise<void>): Promise<void> {
        return cb();
    }

    private async _restartClient(): Promise<void> {
        this._cmsClient = this._doRestartClient();
        const client = await this.getClient();
        this._globalSettings = await client.getGlobalSettings();
    }

    private async _doRestartClient(): Promise<cms.CMakeServerClient> {
        const old_client = await this._cmsClient;
        if (old_client) {
            await old_client.shutdownAsync();
        }
        return this._startNewClient();
    }

    private async _startNewClient() {
        if (!this.generator) {
            throw new NoGeneratorError();
        }

        return cms.CMakeServerClient.start({
            tmpdir: path.join(this.workspaceFolder!, '.vscode'),
            binaryDir: this.binaryDir,
            sourceDir: this.sourceDir,
            cmakePath: this.cmake.path,
            environment: await this.getConfigureEnvironment(),
            onDirty: async () => {
                // cmake-server has dirty check issues, so we implement our own dirty
                // checking. Maybe in the future this can be useful for auto-configuring
                // on file changes?
            },
            onOtherOutput: async msg => this._onMessageEmitter.fire(msg),
            onMessage: async msg => {
                this._onMessageEmitter.fire(msg.message);
            },
            onProgress: async prog => {
                this._progressEmitter.fire(prog);
            },
            generator: this.generator
        });
    }

    private readonly _onMessageEmitter = new vscode.EventEmitter<string>();
    get onMessage() {
        return this._onMessageEmitter.event;
    }

    async onStop(): Promise<void> {
        const client = await this._cmsClient;
        if (client) {
            await client.shutdownAsync();
            this._cmsClient = Promise.resolve(null);
        }
    }

    protected async doInit(): Promise<void> {
        await this._restartClient();

        this.config.onChange('sourceDirectory', async () => {
            // The configure process can determine correctly whether the features set activation
            // should be full or partial, so there is no need to proactively enable full here,
            // unless the automatic configure is disabled.
            // If there is a configure or a build in progress, we should avoid setting full activation here,
            // even if cmake.configureOnEdit is true, because this may overwrite a different decision
            // that was done earlier by that ongoing configure process.
            if (!this.configOrBuildInProgress()) {
                if (this.config.configureOnEdit) {
                    log.debug(localize('cmakelists.save.trigger.reconfigure', "Detected 'cmake.sourceDirectory' setting update, attempting automatic reconfigure..."));
                    await this.configure(ConfigureTrigger.sourceDirectoryChange, []);
                }

                // Evaluate for this folder (whose sourceDirectory setting just changed)
                // if the new value points to a valid CMakeLists.txt.
                if (this.workspaceFolder) {
                    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.workspaceFolder));
                    if (folder) {
                        await ext.updateFullFeatureSetForFolder(folder);
                    }
                }
            }
        });
    }

    get codeModelContent(): cms.ServerCodeModelContent | null {
        return null;
    }

    static async create(cmake: CMakeExecutable,
        config: ConfigurationReader,
        useCMakePresets: boolean,
        kit: Kit | null,
        configurePreset: ConfigurePreset | null,
        buildPreset: BuildPreset | null,
        testPreset: TestPreset | null,
        workspaceFolder: string | null,
        preconditionHandler: CMakePreconditionProblemSolver,
        preferredGenerators: CMakeGenerator[],
        variantManager: VariantManager | null): Promise<CMakeServerDriver> {
        return this.createDerived(new CMakeServerDriver(cmake, config, workspaceFolder, preconditionHandler, variantManager),
            useCMakePresets,
            kit,
            configurePreset,
            buildPreset,
            testPreset,
            preferredGenerators);
    }

}

/**
 * Helper function for Array.reduce
 *
 * @param set the accumulator
 * @t the RichTarget currently being examined.
 */
function targetReducer(set: RichTarget[], t: RichTarget): RichTarget[] {
    if (!set.find(t2 => t.name === t2.name && t.filepath === t2.filepath && t.targetType === t2.targetType)) {
        set.push(t);
    }
    return set;
}
