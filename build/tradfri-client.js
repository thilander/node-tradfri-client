"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
// load external modules
const events_1 = require("events");
const node_coap_client_1 = require("node-coap-client");
// load internal modules
const accessory_1 = require("./lib/accessory");
const array_extensions_1 = require("./lib/array-extensions");
const defer_promise_1 = require("./lib/defer-promise");
const endpoints_1 = require("./lib/endpoints");
const group_1 = require("./lib/group");
const logger_1 = require("./lib/logger");
const object_polyfill_1 = require("./lib/object-polyfill");
const promises_1 = require("./lib/promises");
const scene_1 = require("./lib/scene");
const tradfri_error_1 = require("./lib/tradfri-error");
const watcher_1 = require("./lib/watcher");
class TradfriClient extends events_1.EventEmitter {
    // tslint:enable:unified-signatures
    constructor(hostname, optionsOrLogger) {
        super();
        this.hostname = hostname;
        /** dictionary of CoAP observers */
        this.observedPaths = [];
        /** dictionary of known devices */
        this.devices = {};
        /** dictionary of known groups */
        this.groups = {};
        /** Options regarding IPSO objects and serialization */
        this.ipsoOptions = {};
        /** A dictionary of the observer callbacks. Used to restore it after a soft reset */
        this.rememberedObserveCallbacks = new Map();
        this.requestBase = `coaps://${hostname}:5684/`;
        if (typeof optionsOrLogger === "function") {
            // Legacy version: 2nd parameter is a logger
            logger_1.setCustomLogger(optionsOrLogger);
        }
        else if (typeof optionsOrLogger === "object") {
            if (optionsOrLogger.customLogger != null)
                logger_1.setCustomLogger(optionsOrLogger.customLogger);
            if (optionsOrLogger.useRawCoAPValues === true)
                this.ipsoOptions.skipValueSerializers = true;
            if (optionsOrLogger.watchConnection != null && optionsOrLogger.watchConnection !== false) {
                // true simply means "use default options" => don't pass a 2nd argument
                const watcherOptions = optionsOrLogger.watchConnection === true ? undefined : optionsOrLogger.watchConnection;
                this.watcher = new watcher_1.ConnectionWatcher(this, watcherOptions);
                // in the first iteration of this feature, just pass all events through
                const eventNames = [
                    "ping succeeded", "ping failed",
                    "connection alive", "connection lost",
                    "gateway offline",
                    "reconnecting",
                    "give up",
                ];
                for (const event of eventNames) {
                    this.watcher.on(event, (...args) => this.emit(event, ...args));
                }
            }
        }
    }
    /**
     * Connect to the gateway
     * @param identity A previously negotiated identity.
     * @param psk The pre-shared key belonging to the identity.
     */
    connect(identity, psk) {
        return __awaiter(this, void 0, void 0, function* () {
            const maxAttempts = (this.watcher != null && this.watcher.options.reconnectionEnabled) ?
                this.watcher.options.maximumConnectionAttempts :
                1;
            const interval = this.watcher != null && this.watcher.options.connectionInterval;
            const backoffFactor = this.watcher != null && this.watcher.options.failedConnectionBackoffFactor;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                if (attempt > 0) {
                    const nextTimeout = Math.round(interval * Math.pow(backoffFactor, Math.min(5, attempt - 1)));
                    logger_1.log(`retrying connection in ${nextTimeout} ms`, "debug");
                    yield promises_1.wait(nextTimeout);
                }
                switch (yield this.tryToConnect(identity, psk)) {
                    case true: {
                        // start connection watching
                        if (this.watcher != null)
                            this.watcher.start();
                        return true;
                    }
                    case "auth failed": throw new tradfri_error_1.TradfriError("The provided credentials are not valid. Please re-authenticate!", tradfri_error_1.TradfriErrorCodes.AuthenticationFailed);
                    case "timeout": {
                        // retry if allowed
                        this.emit("connection failed", attempt + 1, maxAttempts);
                        continue;
                    }
                    case "error": throw new tradfri_error_1.TradfriError("An unknown error occured while connecting to the gateway", tradfri_error_1.TradfriErrorCodes.ConnectionFailed);
                }
            }
            throw new tradfri_error_1.TradfriError(`The gateway did not respond ${maxAttempts === 1 ? "in time" : `after ${maxAttempts} tries`}.`, tradfri_error_1.TradfriErrorCodes.ConnectionTimedOut);
        });
    }
    /**
     * Try to establish a connection to the configured gateway.
     * @param identity The DTLS identity to use
     * @param psk The pre-shared key to use
     * @returns true if the connection attempt was successful, otherwise false.
     */
    tryToConnect(identity, psk) {
        return __awaiter(this, void 0, void 0, function* () {
            // initialize CoAP client
            node_coap_client_1.CoapClient.reset();
            node_coap_client_1.CoapClient.setSecurityParams(this.hostname, {
                psk: { [identity]: psk },
            });
            logger_1.log(`Attempting connection. Identity = ${identity}, psk = ${psk}`, "debug");
            const result = yield node_coap_client_1.CoapClient.tryToConnect(this.requestBase);
            if (result === true) {
                logger_1.log("Connection successful", "debug");
            }
            else {
                logger_1.log("Connection failed. Reason: " + result, "debug");
            }
            return result;
        });
    }
    /**
     * Negotiates a new identity and psk with the gateway to use for connections
     * @param securityCode The security code that is printed on the gateway
     * @returns The identity and psk to use for future connections. Store these!
     * @throws TradfriError
     */
    authenticate(securityCode) {
        return __awaiter(this, void 0, void 0, function* () {
            // first, check try to connect with the security code
            logger_1.log("authenticate() > trying to connect with the security code", "debug");
            switch (yield this.tryToConnect("Client_identity", securityCode)) {
                case true: break; // all good
                case "auth failed": throw new tradfri_error_1.TradfriError("The security code is wrong", tradfri_error_1.TradfriErrorCodes.AuthenticationFailed);
                case "timeout": throw new tradfri_error_1.TradfriError("The gateway did not respond in time.", tradfri_error_1.TradfriErrorCodes.ConnectionTimedOut);
                case "error": throw new tradfri_error_1.TradfriError("An unknown error occured while connecting to the gateway", tradfri_error_1.TradfriErrorCodes.ConnectionFailed);
            }
            // generate a new identity
            const identity = `tradfri_${Date.now()}`;
            logger_1.log(`authenticating with identity "${identity}"`, "debug");
            // request creation of new PSK
            let payload = JSON.stringify({ 9090: identity });
            payload = Buffer.from(payload);
            const response = yield this.swallowInternalCoapRejections(node_coap_client_1.CoapClient.request(`${this.requestBase}${endpoints_1.endpoints.authentication}`, "post", payload));
            // check the response
            if (response.code.toString() !== "2.01") {
                // that didn't work, so the code is wrong
                throw new tradfri_error_1.TradfriError(`unexpected response (${response.code.toString()}) to getPSK().`, tradfri_error_1.TradfriErrorCodes.AuthenticationFailed);
            }
            // the response is a buffer containing a JSON object as a string
            const pskResponse = JSON.parse(response.payload.toString("utf8"));
            const psk = pskResponse["9091"];
            return { identity, psk };
        });
    }
    /**
     * Observes a resource at the given url and calls the callback when the information is updated.
     * Prefer the specialized versions if possible.
     * @param path The path of the resource
     * @param callback The callback to be invoked when the resource updates
     * @returns true if the observer was set up, false otherwise (e.g. if it already exists)
     */
    observeResource(path, callback) {
        return __awaiter(this, void 0, void 0, function* () {
            // check if we are already observing this resource
            const observerUrl = this.getObserverUrl(path);
            if (this.observedPaths.indexOf(observerUrl) > -1)
                return false;
            // start observing
            this.observedPaths.push(observerUrl);
            // and remember the callback to restore it after a soft-reset
            this.rememberedObserveCallbacks.set(observerUrl, callback);
            yield this.swallowInternalCoapRejections(node_coap_client_1.CoapClient.observe(observerUrl, "get", callback));
            return true;
        });
    }
    getObserverUrl(path) {
        path = normalizeResourcePath(path);
        return path.startsWith(this.requestBase) ? path : `${this.requestBase}${path}`;
    }
    /**
     * Checks if a resource is currently being observed
     * @param path The path of the resource
     */
    isObserving(path) {
        const observerUrl = this.getObserverUrl(path);
        return this.observedPaths.indexOf(observerUrl) > -1;
    }
    /**
     * Stops observing a resource that is being observed through `observeResource`
     * Use the specialized version of this method for observers that were set up with the specialized versions of `observeResource`
     * @param path The path of the resource
     */
    stopObservingResource(path) {
        // remove observer
        const observerUrl = this.getObserverUrl(path);
        const index = this.observedPaths.indexOf(observerUrl);
        if (index === -1)
            return;
        node_coap_client_1.CoapClient.stopObserving(observerUrl);
        this.observedPaths.splice(index, 1);
        this.rememberedObserveCallbacks.delete(observerUrl);
    }
    /**
     * Resets the underlying CoAP client and clears all observers.
     * @param preserveObservers Whether the active observers should be remembered to restore them later
     */
    reset(preserveObservers = false) {
        node_coap_client_1.CoapClient.reset();
        this.clearObservers();
        if (!preserveObservers)
            this.rememberedObserveCallbacks.clear();
    }
    /**
     * Closes the underlying CoAP client and clears all observers.
     */
    destroy() {
        if (this.watcher != null)
            this.watcher.stop();
        this.reset();
    }
    /**
     * Clears the list of observers after a network reset
     * This does not stop observing the resources if the observers are still active
     */
    clearObservers() {
        this.observedPaths = [];
    }
    /**
     * Restores all previously remembered observers with their original callbacks
     * Call this AFTER a dead connection was restored
     */
    restoreObservers() {
        return __awaiter(this, void 0, void 0, function* () {
            logger_1.log("restoring previously used observers", "debug");
            let devicesRestored = false;
            const devicesPath = this.getObserverUrl(endpoints_1.endpoints.devices);
            let groupsAndScenesRestored = false;
            const groupsPath = this.getObserverUrl(endpoints_1.endpoints.groups);
            const scenesPath = this.getObserverUrl(endpoints_1.endpoints.scenes);
            for (const [path, callback] of this.rememberedObserveCallbacks.entries()) {
                if (path.indexOf(devicesPath) > -1) {
                    if (!devicesRestored) {
                        // restore all device observers (with a new callback)
                        logger_1.log("restoring device observers", "debug");
                        yield this.observeDevices();
                        devicesRestored = true;
                    }
                }
                else if (path.indexOf(groupsPath) > -1 || path.indexOf(scenesPath) > -1) {
                    if (!groupsAndScenesRestored) {
                        // restore all group and scene observers (with a new callback)
                        logger_1.log("restoring groups and scene observers", "debug");
                        yield this.observeGroupsAndScenes;
                        groupsAndScenesRestored = true;
                    }
                }
                else {
                    // restore all custom observers with the old callback
                    logger_1.log(`restoring custom observer for path "${path}"`, "debug");
                    yield this.observeResource(path, callback);
                }
            }
        });
    }
    /**
     * Sets up an observer for all devices
     * @returns A promise that resolves when the information about all devices has been received.
     */
    observeDevices() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.isObserving(endpoints_1.endpoints.devices))
                return;
            this.observeDevicesPromise = defer_promise_1.createDeferredPromise();
            // although we return another promise, await the observeResource promise
            // so errors don't fall through the gaps
            yield this.observeResource(endpoints_1.endpoints.devices, (resp) => this.observeDevices_callback(resp));
            return this.observeDevicesPromise;
        });
    }
    observeDevices_callback(response) {
        return __awaiter(this, void 0, void 0, function* () {
            // check response code
            if (response.code.toString() !== "2.05") {
                if (!this.handleNonSuccessfulResponse(response, `observeDevices()`, false))
                    return;
            }
            const newDevices = parsePayload(response);
            logger_1.log(`got all devices: ${JSON.stringify(newDevices)}`);
            // get old keys as int array
            const oldKeys = Object.keys(this.devices).map(k => +k).sort();
            // get new keys as int array
            const newKeys = newDevices.sort();
            // translate that into added and removed devices
            const addedKeys = array_extensions_1.except(newKeys, oldKeys);
            logger_1.log(`adding devices with keys ${JSON.stringify(addedKeys)}`, "debug");
            const observeDevicePromises = newKeys.map(id => {
                const handleResponse = (resp) => {
                    // first, try to parse the device information
                    const result = this.observeDevice_callback(id, resp);
                    // if we are still waiting to confirm the `observeDevices` call,
                    // check if we have received information about all devices
                    if (this.observeDevicesPromise != null) {
                        if (result) {
                            if (newKeys.every(k => k in this.devices)) {
                                this.observeDevicesPromise.resolve();
                                this.observeDevicesPromise = null;
                            }
                        }
                        else {
                            this.observeDevicesPromise.reject(`The device with the id ${id} could not be observed`);
                            this.observeDevicesPromise = null;
                        }
                    }
                };
                return this.observeResource(`${endpoints_1.endpoints.devices}/${id}`, handleResponse);
            });
            yield Promise.all(observeDevicePromises);
            const removedKeys = array_extensions_1.except(oldKeys, newKeys);
            logger_1.log(`removing devices with keys ${JSON.stringify(removedKeys)}`, "debug");
            for (const id of removedKeys) {
                // remove device from dictionary
                delete this.devices[id];
                // remove observer
                this.stopObservingResource(`${endpoints_1.endpoints.devices}/${id}`);
                // and notify all listeners about the removal
                this.emit("device removed", id);
            }
        });
    }
    stopObservingDevices() {
        const pathPrefix = `${this.requestBase}${endpoints_1.endpoints.devices}`;
        // remove all observers pointing to a device related endpoint
        this.observedPaths
            .filter(p => p.startsWith(pathPrefix))
            .forEach(p => this.stopObservingResource(p));
    }
    // gets called whenever "get /15001/<instanceId>" updates
    // returns true when the device was received successfully
    observeDevice_callback(instanceId, response) {
        // check response code
        if (response.code.toString() !== "2.05") {
            if (!this.handleNonSuccessfulResponse(response, `observeDevice(${instanceId})`))
                return false;
        }
        const result = parsePayload(response);
        logger_1.log(`observeDevice > ` + JSON.stringify(result), "debug");
        // parse device info
        const accessory = new accessory_1.Accessory(this.ipsoOptions)
            .parse(result)
            .fixBuggedProperties()
            .createProxy();
        // remember the device object, so we can later use it as a reference for updates
        // store a clone, so we don't have to care what the calling library does
        this.devices[instanceId] = accessory.clone();
        // and notify all listeners about the update
        this.emit("device updated", accessory.link(this));
        return true;
    }
    /**
     * Sets up an observer for all groups and scenes
     * @returns A promise that resolves when the information about all groups and scenes has been received.
     */
    observeGroupsAndScenes() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.isObserving(endpoints_1.endpoints.groups))
                return;
            this.observeGroupsPromise = defer_promise_1.createDeferredPromise();
            // although we return another promise, await the observeResource promise
            // so errors don't fall through the gaps
            yield this.observeResource(endpoints_1.endpoints.groups, (resp) => this.observeGroups_callback(resp));
            return this.observeGroupsPromise;
        });
    }
    // gets called whenever "get /15004" updates
    observeGroups_callback(response) {
        return __awaiter(this, void 0, void 0, function* () {
            // check response code
            if (response.code.toString() !== "2.05") {
                if (!this.handleNonSuccessfulResponse(response, `observeGroups()`, false))
                    return;
            }
            const newGroups = parsePayload(response);
            logger_1.log(`got all groups: ${JSON.stringify(newGroups)}`);
            // get old keys as int array
            const oldKeys = Object.keys(this.groups).map(k => +k).sort();
            // get new keys as int array
            const newKeys = newGroups.sort();
            // translate that into added and removed devices
            const addedKeys = array_extensions_1.except(newKeys, oldKeys);
            logger_1.log(`adding groups with keys ${JSON.stringify(addedKeys)}`, "debug");
            // create a deferred promise for each group, so we can wait for them to be fulfilled
            if (this.observeScenesPromises == null) {
                this.observeScenesPromises = new Map(newKeys.map(id => [id, defer_promise_1.createDeferredPromise()]));
            }
            const observeGroupPromises = newKeys.map(id => {
                const handleResponse = (resp) => {
                    // first, try to parse the device information
                    const result = this.observeGroup_callback(id, resp);
                    // if we are still waiting to confirm the `observeDevices` call,
                    // check if we have received information about all devices
                    if (this.observeGroupsPromise != null) {
                        if (result) {
                            if (newKeys.every(k => k in this.groups)) {
                                // once we have all groups, wait for all scenes to be received
                                Promise
                                    .all(this.observeScenesPromises.values())
                                    .then(() => {
                                    this.observeGroupsPromise.resolve();
                                    this.observeGroupsPromise = null;
                                    this.observeScenesPromises = null;
                                })
                                    .catch(reason => {
                                    // in some cases, the promises can be null here
                                    if (this.observeGroupsPromise != null) {
                                        this.observeGroupsPromise.reject(reason);
                                    }
                                    this.observeGroupsPromise = null;
                                    this.observeScenesPromises = null;
                                });
                            }
                        }
                        else {
                            this.observeGroupsPromise.reject(`The group with the id ${id} could not be observed`);
                            this.observeGroupsPromise = null;
                        }
                    }
                };
                return this.observeResource(`${endpoints_1.endpoints.groups}/${id}`, handleResponse);
            });
            yield Promise.all(observeGroupPromises);
            const removedKeys = array_extensions_1.except(oldKeys, newKeys);
            logger_1.log(`removing groups with keys ${JSON.stringify(removedKeys)}`, "debug");
            removedKeys.forEach((id) => {
                // remove group from dictionary
                delete this.groups[id];
                // remove observers
                this.stopObservingGroup(id);
                // and notify all listeners about the removal
                this.emit("group removed", id);
            });
        });
    }
    stopObservingGroups() {
        for (const id of Object.keys(this.groups)) {
            this.stopObservingGroup(+id);
        }
    }
    stopObservingGroup(instanceId) {
        this.stopObservingResource(`${endpoints_1.endpoints.groups}/${instanceId}`);
        const scenesPrefix = `${endpoints_1.endpoints.scenes}/${instanceId}`;
        for (const path of this.observedPaths) {
            if (path.startsWith(scenesPrefix)) {
                this.stopObservingResource(path);
            }
        }
    }
    // gets called whenever "get /15004/<instanceId>" updates
    observeGroup_callback(instanceId, response) {
        // check response code
        if (response.code.toString() !== "2.05") {
            if (!this.handleNonSuccessfulResponse(response, `observeGroup(${instanceId})`))
                return false;
        }
        const result = parsePayload(response);
        // parse group info
        const group = new group_1.Group(this.ipsoOptions)
            .parse(result)
            .fixBuggedProperties()
            .createProxy();
        // remember the group object, so we can later use it as a reference for updates
        let groupInfo;
        if (!(instanceId in this.groups)) {
            // if there's none, create one
            this.groups[instanceId] = {
                group: null,
                scenes: {},
            };
        }
        groupInfo = this.groups[instanceId];
        // remember the group object, so we can later use it as a reference for updates
        // store a clone, so we don't have to care what the calling library does
        groupInfo.group = group.clone();
        // notify all listeners about the update
        this.emit("group updated", group.link(this));
        // load scene information
        this.observeResource(`${endpoints_1.endpoints.scenes}/${instanceId}`, (resp) => this.observeScenes_callback(instanceId, resp));
        return true;
    }
    // gets called whenever "get /15005/<groupId>" updates
    observeScenes_callback(groupId, response) {
        return __awaiter(this, void 0, void 0, function* () {
            // check response code
            if (response.code.toString() !== "2.05") {
                if (!this.handleNonSuccessfulResponse(response, `observeScenes(${groupId})`, false))
                    return;
            }
            const groupInfo = this.groups[groupId];
            const newScenes = parsePayload(response);
            logger_1.log(`got all scenes in group ${groupId}: ${JSON.stringify(newScenes)}`);
            // get old keys as int array
            const oldKeys = Object.keys(groupInfo.scenes).map(k => +k).sort();
            // get new keys as int array
            const newKeys = newScenes.sort();
            // translate that into added and removed devices
            const addedKeys = array_extensions_1.except(newKeys, oldKeys);
            logger_1.log(`adding scenes with keys ${JSON.stringify(addedKeys)} to group ${groupId}`, "debug");
            const observeScenePromises = newKeys.map(id => {
                const handleResponse = (resp) => {
                    // first, try to parse the device information
                    const result = this.observeScene_callback(groupId, id, resp);
                    // if we are still waiting to confirm the `observeDevices` call,
                    // check if we have received information about all devices
                    if (this.observeScenesPromises != null) {
                        const scenePromise = this.observeScenesPromises.get(groupId);
                        if (result) {
                            if (newKeys.every(k => k in groupInfo.scenes)) {
                                scenePromise.resolve();
                            }
                        }
                        else {
                            scenePromise.reject(`The scene with the id ${id} could not be observed`);
                        }
                    }
                };
                return this.observeResource(`${endpoints_1.endpoints.scenes}/${groupId}/${id}`, handleResponse);
            });
            yield Promise.all(observeScenePromises);
            const removedKeys = array_extensions_1.except(oldKeys, newKeys);
            logger_1.log(`removing scenes with keys ${JSON.stringify(removedKeys)} from group ${groupId}`, "debug");
            removedKeys.forEach(id => {
                // remove scene from dictionary
                delete groupInfo.scenes[id];
                // remove observers
                this.stopObservingResource(`${endpoints_1.endpoints.scenes}/${groupId}/${id}`);
                // and notify all listeners about the removal
                this.emit("scene removed", groupId, id);
            });
        });
    }
    // gets called whenever "get /15005/<groupId>/<instanceId>" updates
    observeScene_callback(groupId, instanceId, response) {
        // check response code
        if (response.code.toString() !== "2.05") {
            if (!this.handleNonSuccessfulResponse(response, `observeScene(${groupId}, ${instanceId})`))
                return false;
        }
        const result = parsePayload(response);
        // parse scene info
        const scene = new scene_1.Scene(this.ipsoOptions)
            .parse(result)
            .fixBuggedProperties()
            .createProxy();
        // remember the scene object, so we can later use it as a reference for updates
        // store a clone, so we don't have to care what the calling library does
        this.groups[groupId].scenes[instanceId] = scene.clone();
        // and notify all listeners about the update
        this.emit("scene updated", groupId, scene.link(this));
        return true;
    }
    /**
     * Handles a non-successful response, e.g. by error logging
     * @param resp The response with a code that indicates an unsuccessful request
     * @param context Some logging context to identify where the error comes from
     * @returns true if the calling method may proceed, false if it should break
     */
    handleNonSuccessfulResponse(resp, context, ignore404 = true) {
        // check response code
        const code = resp.code.toString();
        const payload = parsePayload(resp) || "";
        if (code === "4.04" && ignore404) {
            // not found
            // An observed resource has been deleted - all good
            // The observer will be removed soon
            return false;
        }
        else {
            this.emit("error", new Error(`unexpected response (${code}) to ${context}: ${payload}`));
            return false;
        }
    }
    /**
     * Pings the gateway to check if it is alive
     * @param timeout - (optional) Timeout in ms, after which the ping is deemed unanswered. Default: 5000ms
     */
    ping(timeout) {
        return node_coap_client_1.CoapClient.ping(this.requestBase, timeout);
    }
    /**
     * Updates a device object on the gateway
     * @param accessory The device to be changed
     * @returns true if a request was sent, false otherwise
     */
    updateDevice(accessory) {
        // retrieve the original as a reference for serialization
        if (!(accessory.instanceId in this.devices)) {
            throw new Error(`The device with id ${accessory.instanceId} is not known and cannot be update!`);
        }
        const original = this.devices[accessory.instanceId];
        return this.updateResource(`${endpoints_1.endpoints.devices}/${accessory.instanceId}`, accessory, original);
    }
    /**
     * Updates a group object on the gateway
     * @param group The group to be changed
     * @returns true if a request was sent, false otherwise
     */
    updateGroup(group) {
        // retrieve the original as a reference for serialization
        if (!(group.instanceId in this.groups)) {
            throw new Error(`The group with id ${group.instanceId} is not known and cannot be update!`);
        }
        const original = this.groups[group.instanceId].group;
        return this.updateResource(`${endpoints_1.endpoints.groups}/${group.instanceId}`, group, original);
    }
    /**
     * Updates a generic resource on the gateway
     * @param path The path where the resource is located
     * @param newObj The new object for the resource
     * @param reference The reference value to calculate the diff
     * @returns true if a request was sent, false otherwise
     */
    updateResource(path, newObj, reference) {
        return __awaiter(this, void 0, void 0, function* () {
            // ensure the ipso options were not lost on the user side
            newObj.options = this.ipsoOptions;
            logger_1.log(`updateResource(${path}) > comparing ${JSON.stringify(newObj)} with the reference ${JSON.stringify(reference)}`, "debug");
            const serializedObj = newObj.serialize(reference);
            // If the serialized object contains no properties, we don't need to send anything
            if (!serializedObj || Object.keys(serializedObj).length === 0) {
                logger_1.log(`updateResource(${path}) > empty object, not sending any payload`, "debug");
                return false;
            }
            // get the payload
            let payload = JSON.stringify(serializedObj);
            logger_1.log(`updateResource(${path}) > sending payload: ${payload}`, "debug");
            payload = Buffer.from(payload);
            yield this.swallowInternalCoapRejections(node_coap_client_1.CoapClient.request(`${this.requestBase}${path}`, "put", payload));
            return true;
        });
    }
    /**
     * Sets some properties on a group
     * @param group The group to be updated
     * @param operation The properties to be set
     * @param force If the provided properties must be sent in any case
     * @returns true if a request was sent, false otherwise
     */
    operateGroup(group, operation, force = false) {
        const newGroup = group.clone().merge(operation, true /* all props */);
        const reference = group.clone();
        if (force) {
            // to force the properties being sent, we need to reset them on the reference
            const inverseOperation = object_polyfill_1.composeObject(object_polyfill_1.entries(operation)
                .map(([key, value]) => {
                switch (typeof value) {
                    case "number": return [key, Number.NaN];
                    case "boolean": return [key, !value];
                    default: return [key, null];
                }
            }));
            reference.merge(inverseOperation, true);
        }
        return this.updateResource(`${endpoints_1.endpoints.groups}/${group.instanceId}`, newGroup, reference);
    }
    /**
     * Sets some properties on a lightbulb
     * @param accessory The parent accessory of the lightbulb
     * @param operation The properties to be set
     * @returns true if a request was sent, false otherwise
     */
    operateLight(accessory, operation) {
        if (accessory.type !== accessory_1.AccessoryTypes.lightbulb) {
            throw new Error("The parameter accessory must be a lightbulb!");
        }
        const reference = accessory.clone();
        const newAccessory = reference.clone();
        newAccessory.lightList[0].merge(operation);
        return this.updateResource(`${endpoints_1.endpoints.devices}/${accessory.instanceId}`, newAccessory, reference);
    }
    /**
     * Sends a custom request to a resource
     * @param path The path of the resource
     * @param method The method of the request
     * @param payload The optional payload as a JSON object
     */
    request(path, method, payload) {
        return __awaiter(this, void 0, void 0, function* () {
            // create actual payload
            let jsonPayload;
            if (payload != null) {
                jsonPayload = JSON.stringify(payload);
                logger_1.log("sending custom payload: " + jsonPayload, "debug");
                jsonPayload = Buffer.from(jsonPayload);
            }
            // wait for the CoAP response and respond to the message
            const resp = yield this.swallowInternalCoapRejections(node_coap_client_1.CoapClient.request(`${this.requestBase}${path}`, method, jsonPayload));
            return {
                code: resp.code.toString(),
                payload: parsePayload(resp),
            };
        });
    }
    swallowInternalCoapRejections(promise) {
        // We use the conventional promise pattern here so we can opt to never
        // resolve the promise in case we want to redirect it into an emitted error event
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            try {
                // try to resolve the promise normally
                resolve(yield promise);
            }
            catch (e) {
                if (/coap\s?client was reset/i.test(e.message)) {
                    // The CoAP client was reset. This happens when the user
                    // resets the CoAP client while connections or requests
                    // are still pending. It's not an error per se, so just
                    // inform the user about what happened.
                    this.emit("error", new tradfri_error_1.TradfriError("The network stack was reset. Pending promises will not be fulfilled.", tradfri_error_1.TradfriErrorCodes.NetworkReset));
                }
                else if (/dtls handshake timed out/i.test(e.message)) {
                    // The DTLS layer did not complete a handshake in time.
                    this.emit("error", new tradfri_error_1.TradfriError("Could not establish a secure connection in time. Pending promises will not be fulfilled.", tradfri_error_1.TradfriErrorCodes.ConnectionTimedOut));
                }
                else {
                    reject(e);
                }
            }
        }));
    }
}
exports.TradfriClient = TradfriClient;
/** Normalizes the path to a resource, so it can be used for storing the observer */
function normalizeResourcePath(path) {
    path = path || "";
    while (path.startsWith("/"))
        path = path.slice(1);
    while (path.endsWith("/"))
        path = path.slice(0, -1);
    return path;
}
function parsePayload(response) {
    if (response.payload == null)
        return null;
    switch (response.format) {
        case 0: // text/plain
        case null:// assume text/plain
            return response.payload.toString("utf-8");
        case 50:// application/json
            const json = response.payload.toString("utf-8");
            return JSON.parse(json);
        default:
            // dunno how to parse this
            logger_1.log(`unknown CoAP response format ${response.format}`, "warn");
            return response.payload;
    }
}
