"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BubbleWrapper = void 0;
const TwaGenerator_1 = require("@bubblewrap/core/dist/lib/TwaGenerator");
const TwaManifest_1 = require("@bubblewrap/core/dist/lib/TwaManifest");
const util_1 = require("@bubblewrap/core/dist/lib/util");
const Config_1 = require("@bubblewrap/core/dist/lib/Config");
const AndroidSdkTools_1 = require("@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools");
const JdkHelper_1 = require("@bubblewrap/core/dist/lib/jdk/JdkHelper");
const GradleWrapper_1 = require("@bubblewrap/core/dist/lib/GradleWrapper");
const DigitalAssetLinks_1 = require("@bubblewrap/core/dist/lib/DigitalAssetLinks");
const fs_extra_1 = __importDefault(require("fs-extra"));
const KeyTool_1 = require("@bubblewrap/core/dist/lib/jdk/KeyTool");
/*
 * Wraps Google's bubblewrap to build a signed APK from a PWA.
 * https://github.com/GoogleChromeLabs/bubblewrap/tree/master/packages/core
 */
class BubbleWrapper {
    /**
     *
     * @param apkSettings The settings for the APK generation.
     * @param projectDirectory The directory where to generate the project files and signed APK.
     * @param signingKeyInfo Information about the signing key.
     */
    constructor(apkSettings, projectDirectory, signingKeyInfo) {
        this.apkSettings = apkSettings;
        this.projectDirectory = projectDirectory;
        this.signingKeyInfo = signingKeyInfo;
        this.javaConfig = new Config_1.Config(process.env.JDK8PATH, process.env.ANDROIDTOOLSPATH);
        this.jdkHelper = new JdkHelper_1.JdkHelper(process, this.javaConfig);
        this.androidSdkTools = new AndroidSdkTools_1.AndroidSdkTools(process, this.javaConfig, this.jdkHelper);
    }
    /**
     * Generates a signed APK from the PWA.
     */
    async generateApk() {
        // Create an optimized APK.      
        await this.generateTwaProject();
        const apkPath = await this.buildApk();
        const optimizedApkPath = await this.optimizeApk(apkPath);
        // Do we have signing info? If so, sign it and generate digital asset links.
        if (this.apkSettings.signingMode !== "none" && this.signingKeyInfo) {
            const signedApkPath = await this.signApk(optimizedApkPath, this.signingKeyInfo);
            const assetLinksPath = await this.tryGenerateAssetLinks(this.signingKeyInfo);
            return {
                filePath: signedApkPath,
                signingInfo: this.signingKeyInfo,
                assetLinkPath: assetLinksPath
            };
        }
        // We generated an unsigned APK, so there will be no signing info nor asset links.
        return {
            filePath: optimizedApkPath,
            signingInfo: this.signingKeyInfo,
            assetLinkPath: null
        };
    }
    async generateTwaProject() {
        const twaGenerator = new TwaGenerator_1.TwaGenerator();
        const twaManifest = this.createTwaManifest(this.apkSettings);
        await twaGenerator.createTwaProject(this.projectDirectory, twaManifest);
        return twaManifest;
    }
    async createSigningKey(signingInfo) {
        const keyTool = new KeyTool_1.KeyTool(this.jdkHelper);
        const overwriteExisting = true;
        const keyOptions = {
            path: signingInfo.keyFilePath,
            password: signingInfo.storePassword,
            keypassword: signingInfo.keyPassword,
            alias: signingInfo.alias,
            fullName: signingInfo.fullName,
            organization: signingInfo.organization,
            organizationalUnit: signingInfo.organizationalUnit,
            country: signingInfo.countryCode
        };
        await keyTool.createSigningKey(keyOptions, overwriteExisting);
    }
    async buildApk() {
        const gradleWrapper = new GradleWrapper_1.GradleWrapper(process, this.androidSdkTools, this.projectDirectory);
        await gradleWrapper.assembleRelease();
        return `${this.projectDirectory}/app/build/outputs/apk/release/app-release-unsigned.apk`;
    }
    async optimizeApk(apkFilePath) {
        console.info("Optimizing the APK...");
        const optimizedApkPath = `${this.projectDirectory}/app-release-unsigned-aligned.apk`;
        await this.androidSdkTools.zipalign(apkFilePath, // input file
        optimizedApkPath);
        return optimizedApkPath;
    }
    async signApk(apkFilePath, signingInfo) {
        // Create a new signing key if necessary.
        if (this.apkSettings.signingMode === "new") {
            await this.createSigningKey(signingInfo);
        }
        const outputFile = `${this.projectDirectory}/app-release-signed.apk`;
        console.info("Signing the APK...");
        await this.androidSdkTools.apksigner(signingInfo.keyFilePath, signingInfo.storePassword, signingInfo.alias, signingInfo.keyPassword, apkFilePath, outputFile);
        return outputFile;
    }
    async tryGenerateAssetLinks(signingInfo) {
        try {
            const result = await this.generateAssetLinks(signingInfo);
            return result;
        }
        catch (error) {
            console.warn("Asset links couldn't be generated. Proceeding without asset links.", error);
            return null;
        }
    }
    async generateAssetLinks(signingInfo) {
        console.info("Generating asset links...");
        const keyTool = new KeyTool_1.KeyTool(this.jdkHelper);
        const assetLinksFilePath = `${this.projectDirectory}/app/build/outputs/apk/release/assetlinks.json`;
        const keyInfo = await keyTool.keyInfo({
            path: signingInfo.keyFilePath,
            alias: signingInfo.alias,
            keypassword: signingInfo.keyPassword,
            password: signingInfo.storePassword,
        });
        const sha256Fingerprint = keyInfo.fingerprints.get('SHA256');
        if (!sha256Fingerprint) {
            throw new Error("Couldn't find SHA256 fingerprint.");
        }
        const assetLinks = DigitalAssetLinks_1.DigitalAssetLinks.generateAssetLinks(this.apkSettings.packageId, sha256Fingerprint);
        await fs_extra_1.default.promises.writeFile(assetLinksFilePath, assetLinks);
        console.info(`Digital Asset Links file generated at ${assetLinksFilePath}`);
        return assetLinksFilePath;
    }
    createTwaManifest(pwaSettings) {
        // Bubblewrap expects a TwaManifest object.
        // We create one using our ApkSettings and signing key info.
        var _a, _b;
        // Host without HTTPS: this is needed because the current version of Bubblewrap doesn't handle
        // a host with protocol specified. Remove the protocol here. See https://github.com/GoogleChromeLabs/bubblewrap/issues/227
        const hostWithoutHttps = new URL(pwaSettings.host).host;
        const signingKey = {
            path: ((_a = this.signingKeyInfo) === null || _a === void 0 ? void 0 : _a.keyFilePath) || "",
            alias: ((_b = this.signingKeyInfo) === null || _b === void 0 ? void 0 : _b.alias) || ""
        };
        const manifestJson = {
            ...pwaSettings,
            host: hostWithoutHttps,
            shortcuts: this.createShortcuts(pwaSettings.shortcuts, pwaSettings.webManifestUrl),
            signingKey: signingKey,
            generatorApp: "PWABuilder"
        };
        const twaManifest = new TwaManifest_1.TwaManifest(manifestJson);
        console.info("TWA manifest created", twaManifest);
        return twaManifest;
    }
    createShortcuts(shortcutsJson, manifestUrl) {
        if (!manifestUrl) {
            console.warn("Skipping app shortcuts due to empty manifest URL", manifestUrl);
            return [];
        }
        const maxShortcuts = 4;
        return shortcutsJson
            .filter(s => this.isValidShortcut(s))
            .map(s => this.createShortcut(s, manifestUrl))
            .slice(0, 4);
    }
    createShortcut(shortcut, manifestUrl) {
        const shortNameMaxSize = 12;
        const name = shortcut.name || shortcut.short_name;
        const shortName = shortcut.short_name || shortcut.name.substring(0, shortNameMaxSize);
        const url = new URL(shortcut.url, manifestUrl).toString();
        const suitableIcon = util_1.findSuitableIcon(shortcut.icons, "any");
        const iconUrl = new URL(suitableIcon.src, manifestUrl).toString();
        return new TwaManifest_1.ShortcutInfo(name, shortName, url, iconUrl);
    }
    isValidShortcut(shortcut) {
        if (!shortcut) {
            console.warn("Shortcut is invalid due to being null or undefined", shortcut);
            return false;
        }
        if (!shortcut.icons) {
            console.warn("Shorcut is invalid due to not having any icons specified", shortcut);
            return false;
        }
        if (!shortcut.url) {
            console.warn("Shortcut is invalid due to not having a URL", shortcut);
            return false;
        }
        if (!shortcut.name && !shortcut.short_name) {
            console.warn("Shortcut is invalid due to having neither a name nor short_name", shortcut);
            return false;
        }
        if (!util_1.findSuitableIcon(shortcut.icons, 'any')) {
            console.warn("Shortcut is invalid due to not finding a suitable icon", shortcut.icons);
            return false;
        }
        return true;
    }
}
exports.BubbleWrapper = BubbleWrapper;
//# sourceMappingURL=bubbleWrapper.js.map