/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import nls = require('vs/nls');
import { readFile } from 'vs/base/node/pfs';
import * as semver from 'semver';
import * as path from 'path';
import Event, { Emitter, chain } from 'vs/base/common/event';
import { index } from 'vs/base/common/arrays';
import { assign } from 'vs/base/common/objects';
import { ThrottledDelayer } from 'vs/base/common/async';
import { isPromiseCanceledError } from 'vs/base/common/errors';
import { TPromise } from 'vs/base/common/winjs.base';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IPager, mapPager, singlePagePager } from 'vs/base/common/paging';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import {
	IExtensionManagementService, IExtensionGalleryService, ILocalExtension, IGalleryExtension, IQueryOptions, IExtensionManifest,
	InstallExtensionEvent, DidInstallExtensionEvent, LocalExtensionType, DidUninstallExtensionEvent, IExtensionEnablementService, IExtensionTipsService, IExtensionIdentifier
} from 'vs/platform/extensionManagement/common/extensionManagement';
import { getGalleryExtensionIdFromLocal, getGalleryExtensionTelemetryData, getLocalExtensionTelemetryData, areSameExtensions } from 'vs/platform/extensionManagement/common/extensionManagementUtil';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { IChoiceService, IMessageService } from 'vs/platform/message/common/message';
import Severity from 'vs/base/common/severity';
import URI from 'vs/base/common/uri';
import { IExtension, IExtensionDependencies, ExtensionState, IExtensionsWorkbenchService, AutoUpdateConfigurationKey } from 'vs/workbench/parts/extensions/common/extensions';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IURLService } from 'vs/platform/url/common/url';
import { ExtensionsInput } from 'vs/workbench/parts/extensions/common/extensionsInput';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import product from 'vs/platform/node/product';

interface IExtensionStateProvider {
	(extension: Extension): ExtensionState;
}

class Extension implements IExtension {

	public disabledGlobally = false;
	public disabledForWorkspace = false;

	constructor(
		private galleryService: IExtensionGalleryService,
		private stateProvider: IExtensionStateProvider,
		public local: ILocalExtension,
		public gallery: IGalleryExtension,
		private telemetryService: ITelemetryService
	) { }

	get type(): LocalExtensionType {
		return this.local ? this.local.type : null;
	}

	get name(): string {
		return this.gallery ? this.gallery.name : this.local.manifest.name;
	}

	get displayName(): string {
		if (this.gallery) {
			return this.gallery.displayName || this.gallery.name;
		}

		return this.local.manifest.displayName || this.local.manifest.name;
	}

	get id(): string {
		if (this.gallery) {
			return this.gallery.identifier.id;
		}
		return getGalleryExtensionIdFromLocal(this.local);
	}

	get uuid(): string {
		return this.gallery ? this.gallery.identifier.uuid : this.local.identifier.uuid;
	}

	get publisher(): string {
		return this.gallery ? this.gallery.publisher : this.local.manifest.publisher;
	}

	get publisherDisplayName(): string {
		if (this.gallery) {
			return this.gallery.publisherDisplayName || this.gallery.publisher;
		}

		if (this.local.metadata && this.local.metadata.publisherDisplayName) {
			return this.local.metadata.publisherDisplayName;
		}

		return this.local.manifest.publisher;
	}

	get version(): string {
		return this.local ? this.local.manifest.version : this.gallery.version;
	}

	get latestVersion(): string {
		return this.gallery ? this.gallery.version : this.local.manifest.version;
	}

	get description(): string {
		return this.gallery ? this.gallery.description : this.local.manifest.description;
	}

	get url(): string {
		if (!product.extensionsGallery) {
			return null;
		}

		return `${product.extensionsGallery.itemUrl}?itemName=${this.publisher}.${this.name}`;
	}

	get iconUrl(): string {
		return this.galleryIconUrl || this.localIconUrl || this.defaultIconUrl;
	}

	get iconUrlFallback(): string {
		return this.galleryIconUrlFallback || this.localIconUrl || this.defaultIconUrl;
	}

	private get localIconUrl(): string {
		return this.local && this.local.manifest.icon
			&& URI.file(path.join(this.local.path, this.local.manifest.icon)).toString();
	}

	private get galleryIconUrl(): string {
		return this.gallery && this.gallery.assets.icon.uri;
	}

	private get galleryIconUrlFallback(): string {
		return this.gallery && this.gallery.assets.icon.fallbackUri;
	}

	private get defaultIconUrl(): string {
		return require.toUrl('../browser/media/defaultIcon.png');
	}

	get licenseUrl(): string {
		return this.gallery && this.gallery.assets.license && this.gallery.assets.license.uri;
	}

	get state(): ExtensionState {
		return this.stateProvider(this);
	}

	get installCount(): number {
		return this.gallery ? this.gallery.installCount : null;
	}

	get rating(): number {
		return this.gallery ? this.gallery.rating : null;
	}

	get ratingCount(): number {
		return this.gallery ? this.gallery.ratingCount : null;
	}

	get outdated(): boolean {
		return !!this.gallery && this.type === LocalExtensionType.User && semver.gt(this.latestVersion, this.version);
	}

	get telemetryData(): any {
		const { local, gallery } = this;

		if (gallery) {
			return getGalleryExtensionTelemetryData(gallery);
		} else {
			return getLocalExtensionTelemetryData(local);
		}
	}

	getManifest(): TPromise<IExtensionManifest> {
		if (this.gallery) {
			return this.galleryService.getManifest(this.gallery);
		}

		return TPromise.as(this.local.manifest);
	}

	getReadme(): TPromise<string> {
		if (this.gallery) {
			if (this.gallery.assets.readme) {
				return this.galleryService.getReadme(this.gallery);
			}
			this.telemetryService.publicLog('extensions:NotFoundReadMe', this.telemetryData); // TODO: Sandy - check for such extensions
		}

		if (this.local && this.local.readmeUrl) {
			const uri = URI.parse(this.local.readmeUrl);
			return readFile(uri.fsPath, 'utf8');
		}

		return TPromise.wrapError<string>(new Error('not available'));
	}

	getChangelog(): TPromise<string> {
		if (this.gallery && this.gallery.assets.changelog) {
			return this.galleryService.getChangelog(this.gallery);
		}

		const changelogUrl = this.local && this.local.changelogUrl;

		if (!changelogUrl) {
			return TPromise.wrapError<string>(new Error('not available'));
		}

		const uri = URI.parse(changelogUrl);

		if (uri.scheme === 'file') {
			return readFile(uri.fsPath, 'utf8');
		}

		return TPromise.wrapError<string>(new Error('not available'));
	}

	get dependencies(): string[] {
		const { local, gallery } = this;
		if (local && local.manifest.extensionDependencies) {
			return local.manifest.extensionDependencies;
		}
		if (gallery) {
			return gallery.properties.dependencies;
		}
		return [];
	}
}

class ExtensionDependencies implements IExtensionDependencies {

	private _hasDependencies: boolean = null;

	constructor(private _extension: IExtension, private _identifier: string, private _map: Map<string, IExtension>, private _dependent: IExtensionDependencies = null) { }

	get hasDependencies(): boolean {
		if (this._hasDependencies === null) {
			this._hasDependencies = this.computeHasDependencies();
		}
		return this._hasDependencies;
	}

	get extension(): IExtension {
		return this._extension;
	}

	get identifier(): string {
		return this._identifier;
	}

	get dependent(): IExtensionDependencies {
		return this._dependent;
	}

	get dependencies(): IExtensionDependencies[] {
		if (!this.hasDependencies) {
			return [];
		}
		return this._extension.dependencies.map(d => new ExtensionDependencies(this._map.get(d), d, this._map, this));
	}

	private computeHasDependencies(): boolean {
		if (this._extension && this._extension.dependencies.length > 0) {
			let dependent = this._dependent;
			while (dependent !== null) {
				if (dependent.identifier === this.identifier) {
					return false;
				}
				dependent = dependent.dependent;
			}
			return true;
		}
		return false;
	}
}

enum Operation {
	Installing,
	Updating,
	Uninstalling
}

interface IActiveExtension {
	operation: Operation;
	extension: Extension;
	start: Date;
}

function toTelemetryEventName(operation: Operation) {
	switch (operation) {
		case Operation.Installing: return 'extensionGallery:install';
		case Operation.Updating: return 'extensionGallery:update';
		case Operation.Uninstalling: return 'extensionGallery:uninstall';
	}

	return '';
}

export class ExtensionsWorkbenchService implements IExtensionsWorkbenchService {

	private static SyncPeriod = 1000 * 60 * 60 * 12; // 12 hours

	_serviceBrand: any;
	private stateProvider: IExtensionStateProvider;
	private installing: IActiveExtension[] = [];
	private uninstalling: IActiveExtension[] = [];
	private installed: Extension[] = [];
	private syncDelayer: ThrottledDelayer<void>;
	private autoUpdateDelayer: ThrottledDelayer<void>;
	private disposables: IDisposable[] = [];

	private _onChange: Emitter<void> = new Emitter<void>();
	get onChange(): Event<void> { return this._onChange.event; }

	private _extensionAllowedBadgeProviders: string[];

	constructor(
		@IInstantiationService private instantiationService: IInstantiationService,
		@IWorkbenchEditorService private editorService: IWorkbenchEditorService,
		@IExtensionManagementService private extensionService: IExtensionManagementService,
		@IExtensionGalleryService private galleryService: IExtensionGalleryService,
		@IConfigurationService private configurationService: IConfigurationService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IMessageService private messageService: IMessageService,
		@IChoiceService private choiceService: IChoiceService,
		@IURLService urlService: IURLService,
		@IExtensionEnablementService private extensionEnablementService: IExtensionEnablementService,
		@IExtensionTipsService private tipsService: IExtensionTipsService,
		@IWorkspaceContextService private workspaceContextService: IWorkspaceContextService,
		@IWindowService private windowService: IWindowService
	) {
		this.stateProvider = ext => this.getExtensionState(ext);

		extensionService.onInstallExtension(this.onInstallExtension, this, this.disposables);
		extensionService.onDidInstallExtension(this.onDidInstallExtension, this, this.disposables);
		extensionService.onUninstallExtension(this.onUninstallExtension, this, this.disposables);
		extensionService.onDidUninstallExtension(this.onDidUninstallExtension, this, this.disposables);
		extensionEnablementService.onEnablementChanged(this.onEnablementChanged, this, this.disposables);

		this.syncDelayer = new ThrottledDelayer<void>(ExtensionsWorkbenchService.SyncPeriod);
		this.autoUpdateDelayer = new ThrottledDelayer<void>(1000);

		chain(urlService.onOpenURL)
			.filter(uri => /^extension/.test(uri.path))
			.on(this.onOpenExtensionUrl, this, this.disposables);

		this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AutoUpdateConfigurationKey)) {
				if (this.isAutoUpdateEnabled()) {
					this.checkForUpdates();
				}
			}
		}, this, this.disposables);

		this.queryLocal().done(() => this.eventuallySyncWithGallery(true));
	}

	get local(): IExtension[] {
		const installing = this.installing
			.filter(e => !this.installed.some(installed => installed.id === e.extension.id))
			.map(e => e.extension);

		return [...this.installed, ...installing];
	}

	queryLocal(): TPromise<IExtension[]> {
		return this.extensionService.getInstalled().then(result => {
			const installedById = index(this.installed, e => e.local.identifier.id);
			const globallyDisabledExtensions = this.extensionEnablementService.getGloballyDisabledExtensions();
			const workspaceDisabledExtensions = this.extensionEnablementService.getWorkspaceDisabledExtensions();
			this.installed = result.map(local => {
				const extension = installedById[local.identifier.id] || new Extension(this.galleryService, this.stateProvider, local, null, this.telemetryService);
				extension.local = local;
				extension.disabledGlobally = globallyDisabledExtensions.some(d => areSameExtensions(d, extension));
				extension.disabledForWorkspace = workspaceDisabledExtensions.some(d => areSameExtensions(d, extension));
				return extension;
			});

			this._onChange.fire();
			return this.local;
		});
	}

	queryGallery(options: IQueryOptions = {}): TPromise<IPager<IExtension>> {
		return this.galleryService.query(options)
			.then(result => mapPager(result, gallery => this.fromGallery(gallery)))
			.then(null, err => {
				if (/No extension gallery service configured/.test(err.message)) {
					return TPromise.as(singlePagePager([]));
				}

				return TPromise.wrapError<IPager<IExtension>>(err);
			});
	}

	loadDependencies(extension: IExtension): TPromise<IExtensionDependencies> {
		if (!extension.dependencies.length) {
			return TPromise.wrap<IExtensionDependencies>(null);
		}

		return this.galleryService.getAllDependencies((<Extension>extension).gallery)
			.then(galleryExtensions => galleryExtensions.map(galleryExtension => this.fromGallery(galleryExtension)))
			.then(extensions => [...this.local, ...extensions])
			.then(extensions => {
				const map = new Map<string, IExtension>();
				for (const extension of extensions) {
					map.set(extension.id, extension);
				}
				return new ExtensionDependencies(extension, extension.id, map);
			});
	}

	loadCompanions(extension: IExtension): TPromise<IExtension[]> {
		let allCompanions = {
			'alexiv.vscode-angular2-files': [
				'infinity1207.angular2-switcher',
				'natewallace.angular2-inline'
			],
			'trixnz.vscode-lua': [
				'gccfeli.vscode-lua',
				'xxxg0001.lua-for-vscode',
				'dcr30.lualinter'
			],
			'hvyindustries.crane': [
				'neilbrayfield.php-docblocker',
				'linyang95.php-symbols',
				'kasik96.format-indent'
			],
			'alanwalk.markdown-toc': [
				'yzane.markdown-pdf',
				'mdickin.markdown-shortcuts'
			],
			'miguel-savignano.ruby-symbols': [
				'otoniel-isidoro.vscode-ruby-ctags',
				'hoovercj.ruby-linter'
			],
			'timothymclane.react-redux-es6-snippets': [
				'taichi.react-beautify'
			],
			'steoates.autoimport': [
				'angular.ng-template',
				'eg2.tslint',
				'vsmobile.cordova-tools'
			],
			'lukehoban.go': [
				'peterjausovec.vscode-docker'
			],
			'vortizhe.simple-ruby-erb': [
				'otoniel-isidoro.vscode-ruby-ctags'
			],
			'jbenden.c-cpp-flylint': [
				'ajshort.include-autocomplete'
			],
			'salesforce.salesforcedx-vscode-lightning': [
				'salesforce.salesforcedx-vscode-apex',
				'salesforce.salesforcedx-vscode-core'
			],
			'angulardoc.angulardoc-vscode': [
				'ng-42.ng-fortytwo-vscode-extension'
			],
			'sfodje.perltidy': [
				'kaktus.perltidy-more',
				'henriiik.vscode-perl'
			],
			'formulahendry.auto-rename-tag': [
				'formulahendry.auto-close-tag',
				'christian-kohler.path-intellisense',
				'ecmel.vscode-html-css'
			],
			'bschulte.php-autocomplete': [
				'linyang95.php-symbols'
			],
			'chuckjonas.apex-autocomplete': [
				'davidhelmer.mavensmate',
				'johnaaronnelson.visualforce',
				'johnaaronnelson.apex'
			],
			'ramonitor.meteorhelper': [
				'vuhrmeister.vscode-meteor'
			],
			'salesforce.salesforcedx-vscode-core': [
				'salesforce.salesforcedx-vscode-lightning',
				'salesforce.salesforcedx-vscode-apex'
			],
			'faustinoaq.javac-linter': [
				'dsnake.java-debug',
				'georgewfraser.vscode-javac'
			],
			'jeppeandersen.vstsbuildstatus': [
				'jeppeandersen.vstsservicestatus'
			],
			'mikey.vscode-fileheader': [
				'mkxml.vscode-filesize'
			],
			'neilbrayfield.php-docblocker': [
				'bmewburn.vscode-intelephense-client',
				'hvyindustries.crane',
				'linyang95.php-symbols'
			],
			'lukazakrajsek.react-utils': [
				'bookworms.code-react-instyle',
				'joshjg.generate-react-component'
			],
			'eg2.tslint': [
				'dbaeumer.vscode-eslint',
				'editorconfig.editorconfig',
				'eg2.vscode-npm-script'
			],
			'bitzl.vscode-puppet': [
				'jpogran.puppet-vscode',
				'borke.puppet'
			],
			'wayou.vscode-todo-highlight': [
				'shan.code-settings-sync',
				'naumovs.color-highlight',
				'cssho.vscode-svgviewer'
			],
			'sbrink.elm': [
				'abadi199.elm-format'
			],
			'ng-42.ng-fortytwo-vscode-extension': [
				'angulardoc.angulardoc-vscode'
			],
			'johnaaronnelson.forcecode': [
				'johnaaronnelson.visualforce',
				'johnaaronnelson.apex',
				'chuckjonas.apex-autocomplete'
			],
			'silverbulleters.gherkin-autocomplete': [
				'stevejpurves.cucumber'
			],
			'junstyle.php-cs-fixer': [
				'neilbrayfield.php-docblocker',
				'linyang95.php-symbols'
			],
			'esbenp.prettier-vscode': [
				'dbaeumer.vscode-eslint',
				'christian-kohler.path-intellisense',
				'flowtype.flow-for-vscode'
			],
			'dcr30.lualinter': [
				'xxxg0001.lua-for-vscode',
				'gccfeli.vscode-lua',
				'trixnz.vscode-lua'
			],
			'hookyqr.createmodule': [
				'gegeke.node-modules-navigation'
			],
			'ms-vscode.cpptools': [
				'donjayamanne.python',
				'austin.code-gnu-global',
				'ms-vscode.csharp'
			],
			'chrmarti.regex': [
				'bierner.color-info'
			],
			'castwide.solargraph': [
				'otoniel-isidoro.vscode-ruby-ctags'
			],
			'ionic-preview.ionic-preview': [
				'danielehrhardt.ionic3-vs-ionview-snippets',
				'siteslave.ionic3-snippets',
				'oudzy.ionic2-snippets'
			],
			'cake-build.cake-vscode': [
				'wk-j.cake-runner'
			],
			'infinity1207.angular2-switcher': [
				'krizzdewizz.refactorix',
				'natewallace.angular2-inline',
				'alexiv.vscode-angular2-files'
			],
			'mkloubert.vs-script-commands': [
				'mkloubert.vs-cron',
				'mkloubert.vs-rest-api',
				'mkloubert.vs-deploy'
			],
			'ajshort.msg': [
				'ajshort.ros'
			],
			'alefragnani.project-manager': [
				'eamodio.gitlens',
				'shan.code-settings-sync',
				'christian-kohler.path-intellisense'
			],
			'thavarajan.ionic2': [
				'danielehrhardt.ionic3-vs-ionview-snippets',
				'vsmobile.cordova-tools',
				'oudzy.ionic2-snippets'
			],
			'samverschueren.yo': [
				'azuresdkteam.azurenodeessentials',
				'visualstudioonlineapplicationinsights.application-insights',
				'vsciot-vscode.azure-iot-toolkit'
			],
			'alexkrechik.cucumberautocomplete': [
				'stevejpurves.cucumber'
			],
			'nadako.vshaxe': [
				'wiggin77.codedox',
				'openfl.lime-vscode-extension'
			],
			'k--kato.docomment': [
				'jchannon.csharpextensions'
			],
			'avli.clojure': [
				'shaunlebron.vscode-parinfer',
				'clptn.code-paredit',
				'stiansivertsen.visualclojure'
			],
			'jpogran.puppet-vscode': [
				'bitzl.vscode-puppet'
			],
			'schroeter.prettier-vscode-space-parenthesis': [
				'bysabi.prettier-vscode-standard',
				'bysabi.prettier-vscode-semistandard'
			],
			'yzane.markdown-pdf': [
				'alanwalk.markdown-toc'
			],
			'ajshort.ros': [
				'ajshort.msg'
			],
			'vstirbu.vscode-mermaid-preview': [
				'bierner.markdown-mermaid'
			],
			'mrmlnc.vscode-less': [
				'mrcrowl.easy-less'
			],
			'jakethashi.vscode-angular2-emmet': [
				'natewallace.angular2-inline',
				'infinity1207.angular2-switcher',
				'angular.ng-template'
			],
			'kisstkondoros.vscode-codemetrics': [
				'wix.vscode-import-cost'
			],
			'joshjg.vscode-credo': [
				'iampeterbanjo.elixirlinter',
				'jameshrisho.vscode-exfmt',
				'mjmcloug.vscode-elixir'
			],
			'dbaeumer.jshint': [
				'hookyqr.beautify',
				'christian-kohler.npm-intellisense',
				'eg2.vscode-npm-script'
			],
			'matthewferreira.cppcheck': [
				'ajshort.include-autocomplete'
			],
			'hookyqr.beautify': [
				'dbaeumer.vscode-eslint',
				'robertohuertasm.vscode-icons',
				'christian-kohler.path-intellisense'
			],
			'waderyan.gitblame': [
				'eamodio.gitlens',
				'editorconfig.editorconfig'
			],
			'jakebecker.elixir-ls': [
				'ptd.vscode-elixirc-mix-linter',
				'jameshrisho.vscode-exfmt',
				'iampeterbanjo.elixirlinter'
			],
			'jcanero.hoogle-vscode': [
				'vans.haskero',
				'justusadam.language-haskell',
				'hoovercj.haskell-linter'
			],
			'mike-zhou.component-creator': [
				'onixie.angular-component-extension',
				'mf.ng-utils',
				'qinxch.vscode-add-angular2-files'
			],
			'dsnake.java-debug': [
				'georgewfraser.vscode-javac',
				'faustinoaq.javac-linter'
			],
			'ms-azuretools.vscode-azureappservice': [
				'ms-vscode.azure-account',
				'ms-azuretools.vscode-cosmosdb'
			],
			'onixie.angular-component-extension': [
				'mike-zhou.component-creator',
				'mf.ng-utils',
				'sanderledegen.angular-follow-selector'
			],
			'mkloubert.vs-deploy': [
				'mkloubert.vs-cron',
				'mkloubert.vs-rest-api',
				'mkloubert.vs-script-commands'
			],
			'linyang95.php-symbols': [
				'neilbrayfield.php-docblocker',
				'hvyindustries.crane',
				'bmewburn.vscode-intelephense-client'
			],
			'rebornix.ruby': [
				'misogi.ruby-rubocop',
				'hoovercj.ruby-linter'
			],
			'2gua.rainbow-brackets': [
				'oderwat.indent-rainbow',
				'naumovs.color-highlight'
			],
			'wiggin77.codedox': [
				'nadako.vshaxe',
				'openfl.lime-vscode-extension',
				'jarrio.hxmanager'
			],
			'johnpapa.azure-functions-tools': [
				'bradygaster.azuretoolsforvscode',
				'msazurermtools.azurerm-vscode-tools',
				'visualstudioonlineapplicationinsights.application-insights'
			],
			'rbbit.typescript-hero': [
				'angular.ng-template',
				'eg2.tslint',
				'pmneo.tsimporter'
			],
			'tomiturtiainen.rf-intellisense': [
				'keith.robotframework',
				'kmk-labs.robotf-extension'
			],
			'joelday.docthis': [
				'formulahendry.auto-rename-tag',
				'christian-kohler.path-intellisense',
				'christian-kohler.npm-intellisense'
			],
			'azuresdkteam.azurenodeessentials': [
				'samverschueren.yo',
				'vsciot-vscode.azure-iot-toolkit',
				'visualstudioonlineapplicationinsights.application-insights'
			],
			'yuzukwok.eggjs-dev-tools': [
				'atian25.eggjs'
			],
			'juanblanco.solidity': [
				'beaugunderson.solidity-extended'
			],
			'ionide.ionide-fsharp': [
				'ionide.ionide-paket'
			],
			'hyesun.py-paste-indent': [
				'linw1995.python-traceback-jumper',
				'nils-ballmann.python-coding-tools'
			],
			'rust-lang.rust': [
				'kalitaalexey.vscode-rust',
				'bungcip.better-toml',
				'saviorisdead.rustycode'
			],
			'ikuyadeu.r': [
				'grapecity.gc-excelviewer'
			],
			'joshjg.generate-react-component': [
				'lukazakrajsek.react-utils'
			],
			'bmewburn.vscode-intelephense-client': [
				'neilbrayfield.php-docblocker',
				'linyang95.php-symbols',
				'hvyindustries.crane'
			],
			'eliean.vscode-svn': [
				'fantasytyx.tortoise-svn'
			],
			'misogi.ruby-rubocop': [
				'rebornix.ruby',
				'hoovercj.ruby-linter'
			],
			'kube.clangcomplete': [
				'l3dg3r.jlang-clang',
				'ajshort.include-autocomplete',
				'xaver.clang-format'
			],
			'pmneo.tsimporter': [
				'dskwrk.vscode-generate-getter-setter',
				'krizzdewizz.refactorix',
				'infinity1207.angular2-switcher'
			],
			'borke.puppet': [
				'jgreat.puppetlinter',
				'bitzl.vscode-puppet'
			],
			'mkloubert.vs-cron': [
				'mkloubert.vs-rest-api',
				'mkloubert.vs-script-commands',
				'mkloubert.vs-deploy'
			],
			'silverbulleters.sonarqube-inject': [
				'sonarsource.sonarlint-vscode'
			],
			'kangping.luaide': [
				'gccfeli.vscode-lua'
			],
			'webfreak.debug': [
				'platformio.platformio-ide'
			],
			'shakram02.bash-beautify': [
				'foxundermoon.shell-format'
			],
			'bierner.markdown-checkbox': [
				'bierner.markdown-emoji'
			],
			'hackwaly.ocaml': [
				'freebroccolo.reasonml',
				'muchtrix.ocaml-tuareg-master'
			],
			'oudzy.ionic2-snippets': [
				'thavarajan.ionic2',
				'danielehrhardt.ionic3-vs-ionview-snippets',
				'ionic-preview.ionic-preview'
			],
			'ritwickdey.live-sass': [
				'ritwickdey.liveserver'
			],
			'xaver.clang-format': [
				'mitaki28.vscode-clang',
				'kube.clangcomplete'
			],
			'vscjava.vscode-java-debug': [
				'redhat.java'
			],
			'gegeke.node-modules-navigation': [
				'hookyqr.createmodule',
				'sqlprovider.node-dependencies-view'
			],
			'ms-azuretools.vscode-cosmosdb': [
				'ms-vscode.azure-account',
				'ms-azuretools.vscode-azureappservice'
			],
			'foxundermoon.shell-format': [
				'shakram02.bash-beautify'
			],
			'msazurermtools.azurerm-vscode-tools': [
				'johnpapa.azure-functions-tools',
				'bradygaster.azuretoolsforvscode',
				'visualstudioonlineapplicationinsights.application-insights'
			],
			'lonefy.vscode-js-css-html-formatter': [
				'ecmel.vscode-html-css',
				'zignd.html-css-class-completion',
				'hookyqr.beautify'
			],
			'mkloubert.vs-rest-api': [
				'mkloubert.vs-cron',
				'mkloubert.vs-script-commands',
				'mkloubert.vs-deploy'
			],
			'acrolinx.vscode-sidebar': [
				'microsoft.gauntlet'
			],
			'aaronphy.scss-scan': [
				'lukazakrajsek.scss-refactoring'
			],
			'vsmobile.cordova-tools': [
				'thavarajan.ionic2',
				'danielehrhardt.ionic3-vs-ionview-snippets',
				'steoates.autoimport'
			],
			'pranaygp.vscode-css-peek': [
				'bierner.color-info'
			],
			'nils-ballmann.python-coding-tools': [
				'hyesun.py-paste-indent',
				'linw1995.python-traceback-jumper'
			],
			'octref.vetur': [
				'formulahendry.auto-rename-tag',
				'ecmel.vscode-html-css',
				'formulahendry.auto-close-tag'
			],
			'austin.code-gnu-global': [
				'mitaki28.vscode-clang',
				'ms-vscode.cpptools'
			],
			'telerik.nativescript': [
				'joshdsommer.vscode-add-angular-native-files'
			],
			'eamodio.gitlens': [
				'alefragnani.project-manager',
				'christian-kohler.path-intellisense',
				'dbaeumer.vscode-eslint'
			],
			'hoovercj.ruby-linter': [
				'misogi.ruby-rubocop',
				'miguel-savignano.ruby-symbols',
				'otoniel-isidoro.vscode-ruby-ctags'
			],
			'xxxg0001.lua-for-vscode': [
				'dcr30.lualinter',
				'gccfeli.vscode-lua',
				'trixnz.vscode-lua'
			],
			'noku.rails-run-spec-vscode': [
				'sporto.rails-go-to-spec'
			],
			'jchannon.csharpextensions': [
				'k--kato.docomment',
				'schneiderpat.aspnet-helper'
			],
			'ikappas.phpcs': [
				'neilbrayfield.php-docblocker',
				'hvyindustries.crane',
				'felixfbecker.php-intellisense'
			],
			'bagonaut.mongogo': [
				'ms-vscode-devlab.vscode-mongodb'
			],
			'hangxingliu.vscode-nginx-conf-hint': [
				'shanoor.vscode-nginx',
				'jiejie.lua-nginx-snippets'
			],
			'michelemelluso.code-beautifier': [
				'ecmel.vscode-html-css'
			],
			'ptd.vscode-elixirc-mix-linter': [
				'jakebecker.elixir-ls',
				'jameshrisho.vscode-exfmt',
				'mjmcloug.vscode-elixir'
			],
			'saviorisdead.rustycode': [
				'kalitaalexey.vscode-rust',
				'rust-lang.rust'
			],
			'peterjausovec.vscode-docker': [
				'dbaeumer.vscode-eslint',
				'eg2.vscode-npm-script',
				'editorconfig.editorconfig'
			],
			'siteslave.ionic3-snippets': [
				'danielehrhardt.ionic3-vs-ionview-snippets',
				'ionic-preview.ionic-preview',
				'oudzy.ionic2-snippets'
			],
			'krizzdewizz.refactorix': [
				'infinity1207.angular2-switcher',
				'dskwrk.vscode-generate-getter-setter',
				'pmneo.tsimporter'
			],
			'bookworms.code-react-instyle': [
				'lukazakrajsek.react-utils'
			],
			'visualstudioonlineapplicationinsights.application-insights': [
				'vsciot-vscode.azure-iot-toolkit',
				'johnpapa.azure-functions-tools',
				'bradygaster.azuretoolsforvscode'
			],
			'formulahendry.azure-iot-toolkit': [
				'vsciot-vscode.azure-iot-toolkit',
				'visualstudioonlineapplicationinsights.application-insights'
			],
			'danielehrhardt.ionic3-vs-ionview-snippets': [
				'thavarajan.ionic2',
				'vsmobile.cordova-tools',
				'oudzy.ionic2-snippets'
			],
			'alefragnani.pascal': [
				'idleberg.innosetup'
			],
			'kasik96.format-indent': [
				'hvyindustries.crane'
			],
			'vuhrmeister.vscode-meteor': [
				'ramonitor.meteorhelper'
			],
			'naumovs.vscode-fuse-syntax': [
				'ign97.fuse-vscode'
			],
			'alefragnani.bookmarks': [
				'alefragnani.project-manager',
				'shan.code-settings-sync'
			],
			'gccfeli.vscode-lua': [
				'trixnz.vscode-lua',
				'dcr30.lualinter',
				'xxxg0001.lua-for-vscode'
			],
			'grapecity.gc-excelviewer': [
				'ikuyadeu.r'
			],
			'freebroccolo.reasonml': [
				'hackwaly.ocaml'
			],
			'donjayamanne.python': [
				'tht13.python',
				'ms-vscode.cpptools',
				'peterjausovec.vscode-docker'
			],
			'ms-vscode.azure-account': [
				'ms-azuretools.vscode-azureappservice',
				'ms-azuretools.vscode-cosmosdb',
				'formulahendry.azure-storage-explorer'
			],
			'coenraads.bracket-pair-colorizer': [
				'natewallace.angular2-inline',
				'angular.ng-template',
				'christian-kohler.path-intellisense'
			],
			'justusadam.language-haskell': [
				'jcanero.hoogle-vscode',
				'vans.haskero',
				'hoovercj.haskell-linter'
			],
			'mkaufman.htmlhint': [
				'ecmel.vscode-html-css'
			],
			'qnsolutions.swaggitor': [
				'arjun.swagger-viewer'
			],
			'iampeterbanjo.elixirlinter': [
				'mjmcloug.vscode-elixir',
				'joshjg.vscode-credo',
				'jameshrisho.vscode-exfmt'
			],
			'angular.ng-template': [
				'natewallace.angular2-inline',
				'coenraads.bracket-pair-colorizer',
				'steoates.autoimport'
			],
			'bungcip.better-toml': [
				'rust-lang.rust',
				'kalitaalexey.vscode-rust'
			],
			'bierner.markdown-emoji': [
				'bierner.markdown-checkbox'
			],
			'ciena-blueplanet.ember-addon-snippets': [
				'max-david.vs-ember-helper'
			],
			'schneiderpat.aspnet-helper': [
				'jchannon.csharpextensions'
			],
			'vector-of-bool.cmake-tools': [
				'twxs.cmake',
				'maddouri.cmake-tools-helper'
			],
			'mitaki28.vscode-clang': [
				'austin.code-gnu-global',
				'xaver.clang-format'
			],
			'natewallace.angular2-inline': [
				'angular.ng-template',
				'coenraads.bracket-pair-colorizer',
				'infinity1207.angular2-switcher'
			],
			'ms-vscode.csharp': [
				'eg2.tslint',
				'robertohuertasm.vscode-icons',
				'ms-vscode.cpptools'
			],
			'yahya-gilany.vscode-pomodoro': [
				'ecodes.vscode-phpmd'
			],
			'twxs.cmake': [
				'vector-of-bool.cmake-tools',
				'maddouri.cmake-tools-helper'
			],
			'georgewfraser.vscode-javac': [
				'dsnake.java-debug',
				'faustinoaq.javac-linter'
			],
			'lukazakrajsek.scss-refactoring': [
				'aaronphy.scss-scan'
			],
			'taichi.react-beautify': [
				'timothymclane.react-redux-es6-snippets',
				'vsmobile.vscode-react-native'
			],
			'mdickin.markdown-shortcuts': [
				'alanwalk.markdown-toc'
			],
			'felixfbecker.php-intellisense': [
				'neilbrayfield.php-docblocker',
				'hvyindustries.crane',
				'ikappas.phpcs'
			],
			'felixrieseberg.vsc-ember-cli': [
				'emberjs.vscode-ember'
			],
			'formulahendry.auto-close-tag': [
				'formulahendry.auto-rename-tag',
				'christian-kohler.path-intellisense',
				'ecmel.vscode-html-css'
			],
			'zignd.html-css-class-completion': [
				'ecmel.vscode-html-css',
				'christian-kohler.path-intellisense',
				'formulahendry.auto-close-tag'
			],
			'vsmobile.vscode-react-native': [
				'dbaeumer.vscode-eslint',
				'formulahendry.auto-close-tag',
				'esbenp.prettier-vscode'
			],
			'otoniel-isidoro.vscode-ruby-ctags': [
				'miguel-savignano.ruby-symbols',
				'hoovercj.ruby-linter',
				'castwide.solargraph'
			],
			'flet.vscode-semistandard': [
				'homerjam.vscode-semistandard-format'
			],
			'ms-vscode-devlab.vscode-mongodb': [
				'bagonaut.mongogo'
			],
			'abadi199.elm-format': [
				'sbrink.elm',
				'joeandaverde.vscode-elm-jump'
			],
			'mkxml.vscode-filesize': [
				'mikey.vscode-fileheader'
			],
			'ajshort.include-autocomplete': [
				'jbenden.c-cpp-flylint',
				'kube.clangcomplete',
				'matthewferreira.cppcheck'
			],
			'equinusocio.vsc-material-theme': [
				'pkief.material-icon-theme'
			],
			'ecodes.vscode-phpmd': [
				'yahya-gilany.vscode-pomodoro'
			],
			'sonarsource.sonarlint-vscode': [
				'silverbulleters.sonarqube-inject'
			],
			'cssho.vscode-svgviewer': [
				'wayou.vscode-todo-highlight'
			],
			'sophisticode.php-formatter': [
				'felixfbecker.php-intellisense',
				'hvyindustries.crane',
				'linyang95.php-symbols'
			],
			'joshdsommer.vscode-add-angular-native-files': [
				'telerik.nativescript',
				'alexrainman.vscode-add-nativescript-files'
			],
			'ionide.ionide-paket': [
				'ionide.ionide-fake',
				'ionide.ionide-fsharp'
			],
			'sanderledegen.angular-follow-selector': [
				'onixie.angular-component-extension'
			],
			'vans.haskero': [
				'jcanero.hoogle-vscode',
				'justusadam.language-haskell',
				'hoovercj.haskell-linter'
			],
			'mjmcloug.vscode-elixir': [
				'iampeterbanjo.elixirlinter',
				'joshjg.vscode-credo',
				'ptd.vscode-elixirc-mix-linter'
			],
			'leizongmin.node-module-intellisense': [
				'christian-kohler.npm-intellisense'
			],
			'eg2.vscode-npm-script': [
				'christian-kohler.npm-intellisense',
				'dbaeumer.vscode-eslint',
				'christian-kohler.path-intellisense'
			],
			'shanoor.vscode-nginx': [
				'hangxingliu.vscode-nginx-conf-hint',
				'jiejie.lua-nginx-snippets'
			],
			'platformio.platformio-ide': [
				'webfreak.debug'
			],
			'stevejpurves.cucumber': [
				'alexkrechik.cucumberautocomplete',
				'silverbulleters.gherkin-autocomplete'
			],
			'dskwrk.vscode-generate-getter-setter': [
				'pmneo.tsimporter',
				'krizzdewizz.refactorix',
				'infinity1207.angular2-switcher'
			],
			'arjun.swagger-viewer': [
				'qnsolutions.swaggitor'
			],
			'yuce.erlang-otp': [
				'nigelrook.vscode-linter-erlc',
				'prokopiy.vscode-erlang-workbench'
			],
			'stringham.angular-template-formatter': [
				'mf.ng-utils'
			],
			'christian-kohler.path-intellisense': [
				'christian-kohler.npm-intellisense',
				'formulahendry.auto-rename-tag',
				'dbaeumer.vscode-eslint'
			],
			'bierner.color-info': [
				'chrmarti.regex',
				'pranaygp.vscode-css-peek'
			],
			'nwolverson.language-purescript': [
				'nwolverson.ide-purescript'
			],
			'johnaaronnelson.visualforce': [
				'johnaaronnelson.apex',
				'johnaaronnelson.forcecode',
				'chuckjonas.apex-autocomplete'
			],
			'alexrainman.vscode-add-nativescript-files': [
				'codertonyb.vscode-nativescript-generator',
				'joshdsommer.vscode-add-angular-native-files'
			],
			'flowtype.flow-for-vscode': [
				'esbenp.prettier-vscode',
				'vsmobile.vscode-react-native'
			],
			'shan.code-settings-sync': [
				'alefragnani.project-manager',
				'christian-kohler.path-intellisense',
				'christian-kohler.npm-intellisense'
			],
			'pkief.material-icon-theme': [
				'christian-kohler.path-intellisense',
				'equinusocio.vsc-material-theme',
				'editorconfig.editorconfig'
			],
			'hoovercj.vscode-ghc-mod': [
				'hoovercj.haskell-linter',
				'justusadam.language-haskell',
				'ucl.haskelly'
			],
			'wix.vscode-import-cost': [
				'kisstkondoros.vscode-codemetrics',
				'shan.code-settings-sync'
			],
			'emberjs.vscode-ember': [
				'felixrieseberg.vsc-ember-cli'
			],
			'wk-j.cake-runner': [
				'cake-build.cake-vscode'
			],
			'ucl.haskelly': [
				'justusadam.language-haskell',
				'hoovercj.vscode-ghc-mod',
				'hoovercj.haskell-linter'
			],
			'acidic9.p5js-snippets': [
				'garrit.p5canvas'
			],
			'mrcrowl.easy-less': [
				'mrmlnc.vscode-less'
			],
			'beaugunderson.solidity-extended': [
				'juanblanco.solidity'
			],
			'naumovs.color-highlight': [
				'formulahendry.auto-rename-tag',
				'2gua.rainbow-brackets',
				'formulahendry.auto-close-tag'
			],
			'tht13.python': [
				'donjayamanne.python'
			],
			'maddouri.cmake-tools-helper': [
				'vector-of-bool.cmake-tools',
				'twxs.cmake'
			],
			'bierner.markdown-mermaid': [
				'vstirbu.vscode-mermaid-preview'
			],
			'bradygaster.azuretoolsforvscode': [
				'johnpapa.azure-functions-tools',
				'msazurermtools.azurerm-vscode-tools',
				'visualstudioonlineapplicationinsights.application-insights'
			],
			'salesforce.salesforcedx-vscode-apex': [
				'salesforce.salesforcedx-vscode-lightning',
				'salesforce.salesforcedx-vscode-core'
			],
			'editorconfig.editorconfig': [
				'christian-kohler.path-intellisense',
				'eg2.tslint',
				'dbaeumer.vscode-eslint'
			],
			'fantasytyx.tortoise-svn': [
				'eliean.vscode-svn'
			],
			'davidhelmer.mavensmate': [
				'chuckjonas.apex-autocomplete',
				'johnaaronnelson.visualforce',
				'johnaaronnelson.apex'
			],
			'hoovercj.haskell-linter': [
				'hoovercj.vscode-ghc-mod',
				'justusadam.language-haskell',
				'vigoo.stylish-haskell'
			],
			'kalitaalexey.vscode-rust': [
				'rust-lang.rust',
				'bungcip.better-toml',
				'saviorisdead.rustycode'
			],
			'oderwat.indent-rainbow': [
				'2gua.rainbow-brackets'
			],
			'dbaeumer.vscode-eslint': [
				'hookyqr.beautify',
				'christian-kohler.path-intellisense',
				'eg2.tslint'
			],
			'christian-kohler.npm-intellisense': [
				'eg2.vscode-npm-script',
				'christian-kohler.path-intellisense',
				'dbaeumer.vscode-eslint'
			],
			'vsciot-vscode.azure-iot-toolkit': [
				'visualstudioonlineapplicationinsights.application-insights',
				'johnpapa.azure-functions-tools',
				'bradygaster.azuretoolsforvscode'
			],
			'ritwickdey.liveserver': [
				'ritwickdey.live-sass'
			],
			'linw1995.python-traceback-jumper': [
				'hyesun.py-paste-indent',
				'nils-ballmann.python-coding-tools'
			],
			'redhat.java': [
				'vscjava.vscode-java-debug'
			],
			'johnaaronnelson.apex': [
				'johnaaronnelson.visualforce',
				'johnaaronnelson.forcecode',
				'chuckjonas.apex-autocomplete'
			],
			'robertohuertasm.vscode-icons': [
				'hookyqr.beautify',
				'dbaeumer.vscode-eslint',
				'christian-kohler.path-intellisense'
			],
			'henriiik.vscode-perl': [
				'sfodje.perltidy',
				'sfodje.perlcritic',
				'kaktus.perltidy-more'
			],
			'hookyqr.githubissues': [
				'dt.ghlink'
			],
			'ecmel.vscode-html-css': [
				'formulahendry.auto-rename-tag',
				'zignd.html-css-class-completion',
				'formulahendry.auto-close-tag'
			]
		};


		let companions: string[] = allCompanions[extension.id.toLowerCase()];
		if (!companions || companions.length === 0) {
			return TPromise.as([]);
		}

		let options: IQueryOptions = {
			names: companions,
			source: 'companions'
		};
		companions = companions.map(x => x.toLowerCase());

		return this.queryGallery(options).then(pager => {
			let newFirstPage = new Array(pager.firstPage.length);
			for (let i = 0; i < pager.firstPage.length; i++) {
				let index = companions.indexOf(pager.firstPage[i].id.toLowerCase());
				if (index === -1) {
					break; // Something went wrong, Abort! Abort!
				}
				newFirstPage[index] = pager.firstPage[i];
			}
			return newFirstPage;
		});

	}

	open(extension: IExtension, sideByside: boolean = false): TPromise<any> {
		/* __GDPR__
			"extensionGallery:open" : {
				"${include}": [
					"${GalleryExtensionTelemetryData}"
				]
			}
		*/
		this.telemetryService.publicLog('extensionGallery:open', extension.telemetryData);
		return this.editorService.openEditor(this.instantiationService.createInstance(ExtensionsInput, extension), null, sideByside);
	}

	private fromGallery(gallery: IGalleryExtension): Extension {
		const installed = this.getInstalledExtensionMatchingGallery(gallery);

		if (installed) {
			// Loading the compatible version only there is an engine property
			// Otherwise falling back to old way so that we will not make many roundtrips
			if (gallery.properties.engine) {
				this.galleryService.loadCompatibleVersion(gallery).then(compatible => this.syncLocalWithGalleryExtension(installed, compatible));
			} else {
				this.syncLocalWithGalleryExtension(installed, gallery);
			}
			return installed;
		}

		return new Extension(this.galleryService, this.stateProvider, null, gallery, this.telemetryService);
	}

	private getInstalledExtensionMatchingGallery(gallery: IGalleryExtension): Extension {
		for (const installed of this.installed) {
			if (installed.uuid) { // Installed from Gallery
				if (installed.uuid === gallery.identifier.uuid) {
					return installed;
				}
			} else {
				if (installed.id === gallery.identifier.id) { // Installed from other sources
					return installed;
				}
			}
		}
		return null;
	}

	private syncLocalWithGalleryExtension(local: Extension, gallery: IGalleryExtension) {
		local.gallery = gallery;
		this._onChange.fire();
		this.eventuallyAutoUpdateExtensions();
	}

	checkForUpdates(): TPromise<void> {
		return this.syncDelayer.trigger(() => this.syncWithGallery(), 0);
	}

	private isAutoUpdateEnabled(): boolean {
		return this.configurationService.getValue(AutoUpdateConfigurationKey);
	}

	private eventuallySyncWithGallery(immediate = false): void {
		const loop = () => this.syncWithGallery().then(() => this.eventuallySyncWithGallery());
		const delay = immediate ? 0 : ExtensionsWorkbenchService.SyncPeriod;

		this.syncDelayer.trigger(loop, delay)
			.done(null, err => null);
	}

	private syncWithGallery(): TPromise<void> {
		const ids = [], names = [];
		for (const installed of this.installed) {
			if (installed.type === LocalExtensionType.User) {
				if (installed.uuid) {
					ids.push(installed.uuid);
				} else {
					names.push(installed.id);
				}
			}
		}

		const promises = [];
		if (ids.length) {
			promises.push(this.queryGallery({ ids, pageSize: ids.length }));
		}
		if (names.length) {
			promises.push(this.queryGallery({ names, pageSize: names.length }));
		}

		return TPromise.join(promises) as TPromise<any>;
	}

	private eventuallyAutoUpdateExtensions(): void {
		this.autoUpdateDelayer.trigger(() => this.autoUpdateExtensions())
			.done(null, err => null);
	}

	private autoUpdateExtensions(): TPromise<any> {
		if (!this.isAutoUpdateEnabled()) {
			return TPromise.as(null);
		}

		const toUpdate = this.local.filter(e => e.outdated && (e.state !== ExtensionState.Installing));
		return TPromise.join(toUpdate.map(e => this.install(e)));
	}

	canInstall(extension: IExtension): boolean {
		if (!(extension instanceof Extension)) {
			return false;
		}

		return !!(extension as Extension).gallery;
	}

	install(extension: string | IExtension): TPromise<void> {
		if (typeof extension === 'string') {
			return this.extensionService.install(extension);
		}

		if (!(extension instanceof Extension)) {
			return undefined;
		}

		const ext = extension as Extension;
		const gallery = ext.gallery;

		if (!gallery) {
			return TPromise.wrapError<void>(new Error('Missing gallery'));
		}

		return this.extensionService.installFromGallery(gallery);
	}

	setEnablement(extension: IExtension, enable: boolean, workspace: boolean = false): TPromise<void> {
		if (extension.type === LocalExtensionType.System) {
			return TPromise.wrap<void>(void 0);
		}

		return this.promptAndSetEnablement(extension, enable, workspace).then(reload => {
			/* __GDPR__
				"extension:enable" : {
					"${include}": [
						"${GalleryExtensionTelemetryData}"
					]
				}
			*/
			/* __GDPR__
				"extension:disable" : {
					"${include}": [
						"${GalleryExtensionTelemetryData}"
					]
				}
			*/
			this.telemetryService.publicLog(enable ? 'extension:enable' : 'extension:disable', extension.telemetryData);
		});
	}

	uninstall(extension: IExtension): TPromise<void> {
		if (!(extension instanceof Extension)) {
			return undefined;
		}

		const ext = extension as Extension;
		const local = ext.local || this.installed.filter(e => e.id === extension.id)[0].local;

		if (!local) {
			return TPromise.wrapError<void>(new Error('Missing local'));
		}

		return this.extensionService.uninstall(local);

	}

	private promptAndSetEnablement(extension: IExtension, enable: boolean, workspace: boolean): TPromise<any> {
		const allDependencies = this.getDependenciesRecursively(extension, this.local, enable, workspace, []);
		if (allDependencies.length > 0) {
			if (enable) {
				return this.promptForDependenciesAndEnable(extension, allDependencies, workspace);
			} else {
				return this.promptForDependenciesAndDisable(extension, allDependencies, workspace);
			}
		}
		return this.checkAndSetEnablement(extension, [], enable, workspace);
	}

	private promptForDependenciesAndEnable(extension: IExtension, dependencies: IExtension[], workspace: boolean): TPromise<any> {
		const message = nls.localize('enableDependeciesConfirmation', "Enabling '{0}' also enable its dependencies. Would you like to continue?", extension.displayName);
		const options = [
			nls.localize('enable', "Yes"),
			nls.localize('doNotEnable', "No")
		];
		return this.choiceService.choose(Severity.Info, message, options, 1, true)
			.then<void>(value => {
				if (value === 0) {
					return this.checkAndSetEnablement(extension, dependencies, true, workspace);
				}
				return TPromise.as(null);
			});
	}

	private promptForDependenciesAndDisable(extension: IExtension, dependencies: IExtension[], workspace: boolean): TPromise<void> {
		const message = nls.localize('disableDependeciesConfirmation', "Would you like to disable '{0}' only or its dependencies also?", extension.displayName);
		const options = [
			nls.localize('disableOnly', "Only"),
			nls.localize('disableAll', "All"),
			nls.localize('cancel', "Cancel")
		];
		return this.choiceService.choose(Severity.Info, message, options, 2, true)
			.then<void>(value => {
				if (value === 0) {
					return this.checkAndSetEnablement(extension, [], false, workspace);
				}
				if (value === 1) {
					return this.checkAndSetEnablement(extension, dependencies, false, workspace);
				}
				return TPromise.as(null);
			});
	}

	private checkAndSetEnablement(extension: IExtension, dependencies: IExtension[], enable: boolean, workspace: boolean): TPromise<any> {
		if (!enable) {
			let dependents = this.getDependentsAfterDisablement(extension, dependencies, this.local, workspace);
			if (dependents.length) {
				return TPromise.wrapError<void>(new Error(this.getDependentsErrorMessage(extension, dependents)));
			}
		}
		return TPromise.join([extension, ...dependencies].map(e => this.doSetEnablement(e, enable, workspace)));
	}

	private getDependenciesRecursively(extension: IExtension, installed: IExtension[], enable: boolean, workspace: boolean, checked: IExtension[]): IExtension[] {
		if (checked.indexOf(extension) !== -1) {
			return [];
		}
		checked.push(extension);
		if (!extension.dependencies || extension.dependencies.length === 0) {
			return [];
		}
		const dependenciesToDisable = installed.filter(i => {
			// Do not include extensions which are already disabled and request is to disable
			if (!enable && (workspace ? i.disabledForWorkspace : i.disabledGlobally)) {
				return false;
			}
			return i.type === LocalExtensionType.User && extension.dependencies.indexOf(i.id) !== -1;
		});
		const depsOfDeps = [];
		for (const dep of dependenciesToDisable) {
			depsOfDeps.push(...this.getDependenciesRecursively(dep, installed, enable, workspace, checked));
		}
		return [...dependenciesToDisable, ...depsOfDeps];
	}

	private getDependentsAfterDisablement(extension: IExtension, dependencies: IExtension[], installed: IExtension[], workspace: boolean): IExtension[] {
		return installed.filter(i => {
			if (i.dependencies.length === 0) {
				return false;
			}
			if (i === extension) {
				return false;
			}
			const disabled = workspace ? i.disabledForWorkspace : i.disabledGlobally;
			if (disabled) {
				return false;
			}
			if (dependencies.indexOf(i) !== -1) {
				return false;
			}
			return i.dependencies.some(dep => {
				if (extension.id === dep) {
					return true;
				}
				return dependencies.some(d => d.id === dep);
			});
		});
	}

	private getDependentsErrorMessage(extension: IExtension, dependents: IExtension[]): string {
		if (dependents.length === 1) {
			return nls.localize('singleDependentError', "Cannot disable extension '{0}'. Extension '{1}' depends on this.", extension.displayName, dependents[0].displayName);
		}
		if (dependents.length === 2) {
			return nls.localize('twoDependentsError', "Cannot disable extension '{0}'. Extensions '{1}' and '{2}' depend on this.",
				extension.displayName, dependents[0].displayName, dependents[1].displayName);
		}
		return nls.localize('multipleDependentsError', "Cannot disable extension '{0}'. Extensions '{1}', '{2}' and others depend on this.",
			extension.displayName, dependents[0].displayName, dependents[1].displayName);
	}

	private doSetEnablement(extension: IExtension, enable: boolean, workspace: boolean): TPromise<boolean> {
		if (workspace) {
			return this.extensionEnablementService.setEnablement(extension, enable, workspace);
		}

		const globalElablement = this.extensionEnablementService.setEnablement(extension, enable, false);
		if (enable && this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			const workspaceEnablement = this.extensionEnablementService.setEnablement(extension, enable, true);
			return TPromise.join([globalElablement, workspaceEnablement]).then(values => values[0] || values[1]);
		}
		return globalElablement;
	}

	get allowedBadgeProviders(): string[] {
		if (!this._extensionAllowedBadgeProviders) {
			this._extensionAllowedBadgeProviders = (product.extensionAllowedBadgeProviders || []).map(s => s.toLowerCase());
		}
		return this._extensionAllowedBadgeProviders;
	}

	private onInstallExtension(event: InstallExtensionEvent): void {
		const { gallery } = event;

		if (!gallery) {
			return;
		}

		let extension = this.installed.filter(e => areSameExtensions(e, gallery.identifier))[0];

		if (!extension) {
			extension = new Extension(this.galleryService, this.stateProvider, null, gallery, this.telemetryService);
		}

		extension.gallery = gallery;

		const start = new Date();
		const operation = Operation.Installing;
		this.installing.push({ operation, extension, start });

		this._onChange.fire();
	}

	private onDidInstallExtension(event: DidInstallExtensionEvent): void {
		const { local, zipPath, error, gallery } = event;
		const installing = gallery ? this.installing.filter(e => areSameExtensions(e.extension, gallery.identifier))[0] : null;
		const extension: Extension = installing ? installing.extension : zipPath ? new Extension(this.galleryService, this.stateProvider, null, null, this.telemetryService) : null;
		if (extension) {
			this.installing = installing ? this.installing.filter(e => e !== installing) : this.installing;

			if (!error) {
				extension.local = local;

				const installed = this.installed.filter(e => e.id === extension.id)[0];
				if (installed) {
					if (installing) {
						installing.operation = Operation.Updating;
					}
					installed.local = local;
				} else {
					this.installed.push(extension);
				}
			}
			if (extension.gallery) {
				// Report telemetry only for gallery extensions
				this.reportTelemetry(installing, error);
			}
		}
		this._onChange.fire();
	}

	private onUninstallExtension({ id }: IExtensionIdentifier): void {
		const extension = this.installed.filter(e => e.local.identifier.id === id)[0];
		const newLength = this.installed.filter(e => e.local.identifier.id !== id).length;
		// TODO: Ask @Joao why is this?
		if (newLength === this.installed.length) {
			return;
		}

		const start = new Date();
		const operation = Operation.Uninstalling;
		const uninstalling = this.uninstalling.filter(e => e.extension.local.identifier.id === id)[0] || { id, operation, extension, start };
		this.uninstalling = [uninstalling, ...this.uninstalling.filter(e => e.extension.local.identifier.id !== id)];

		this._onChange.fire();
	}

	private onDidUninstallExtension({ identifier, error }: DidUninstallExtensionEvent): void {
		const id = identifier.id;
		if (!error) {
			this.installed = this.installed.filter(e => e.local.identifier.id !== id);
		}

		const uninstalling = this.uninstalling.filter(e => e.extension.local.identifier.id === id)[0];
		this.uninstalling = this.uninstalling.filter(e => e.extension.local.identifier.id !== id);
		if (!uninstalling) {
			return;
		}

		if (!error) {
			this.reportTelemetry(uninstalling);
		}

		this._onChange.fire();
	}

	private onEnablementChanged(extensionIdentifier: IExtensionIdentifier) {
		const [extension] = this.local.filter(e => areSameExtensions(e, extensionIdentifier));
		if (extension) {
			const globallyDisabledExtensions = this.extensionEnablementService.getGloballyDisabledExtensions();
			const workspaceDisabledExtensions = this.extensionEnablementService.getWorkspaceDisabledExtensions();
			extension.disabledGlobally = globallyDisabledExtensions.some(disabled => areSameExtensions(disabled, extension));
			extension.disabledForWorkspace = workspaceDisabledExtensions.some(disabled => areSameExtensions(disabled, extension));
			this._onChange.fire();
		}
	}

	private getExtensionState(extension: Extension): ExtensionState {
		if (extension.gallery && this.installing.some(e => e.extension.gallery && areSameExtensions(e.extension.gallery.identifier, extension.gallery.identifier))) {
			return ExtensionState.Installing;
		}

		if (this.uninstalling.some(e => e.extension.id === extension.id)) {
			return ExtensionState.Uninstalling;
		}

		const local = this.installed.filter(e => e === extension || (e.gallery && extension.gallery && areSameExtensions(e.gallery.identifier, extension.gallery.identifier)))[0];
		return local ? ExtensionState.Installed : ExtensionState.Uninstalled;
	}

	private reportTelemetry(active: IActiveExtension, errorcode?: string): void {
		const data = active.extension.telemetryData;
		const duration = new Date().getTime() - active.start.getTime();
		const eventName = toTelemetryEventName(active.operation);

		/* __GDPR__
			"extensionGallery:install" : {
				"success": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"duration" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"errorcode": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"${include}": [
					"${GalleryExtensionTelemetryData}"
				]
			}
		*/
		/* __GDPR__
			"extensionGallery:update" : {
				"success": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"duration" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"errorcode": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"${include}": [
					"${GalleryExtensionTelemetryData}"
				]
			}
		*/
		/* __GDPR__
			"extensionGallery:uninstall" : {
				"success": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"duration" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"errorcode": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth" },
				"${include}": [
					"${GalleryExtensionTelemetryData}"
				]
			}
		*/
		this.telemetryService.publicLog(eventName, assign(data, { success: !errorcode, duration, errorcode }));
	}

	private onError(err: any): void {
		if (isPromiseCanceledError(err)) {
			return;
		}

		const message = err && err.message || '';

		if (/getaddrinfo ENOTFOUND|getaddrinfo ENOENT|connect EACCES|connect ECONNREFUSED/.test(message)) {
			return;
		}

		this.messageService.show(Severity.Error, err);
	}

	private onOpenExtensionUrl(uri: URI): void {
		const match = /^extension\/([^/]+)$/.exec(uri.path);

		if (!match) {
			return;
		}

		const extensionId = match[1];

		this.queryLocal().then(local => {
			if (local.some(local => local.id === extensionId)) {
				return TPromise.as(null);
			}

			return this.queryGallery({ names: [extensionId], source: 'uri' }).then(result => {
				if (result.total < 1) {
					return TPromise.as(null);
				}

				const extension = result.firstPage[0];

				return this.windowService.show().then(() => {
					return this.open(extension).then(() => {
						const message = nls.localize('installConfirmation', "Would you like to install the '{0}' extension?", extension.displayName, extension.publisher);
						const options = [
							nls.localize('install', "Install"),
							nls.localize('cancel', "Cancel")
						];
						return this.choiceService.choose(Severity.Info, message, options, 2, false).then(value => {
							if (value !== 0) {
								return TPromise.as(null);
							}

							return this.install(extension);
						});
					});
				});
			});
		}).done(undefined, error => this.onError(error));
	}

	dispose(): void {
		this.syncDelayer.cancel();
		this.disposables = dispose(this.disposables);
	}
}