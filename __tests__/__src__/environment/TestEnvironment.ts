/*
* This program and the accompanying materials are made available under the terms of the *
* Eclipse Public License v2.0 which accompanies this distribution, and is available at *
* https://www.eclipse.org/legal/epl-v20.html                                      *
*                                                                                 *
* SPDX-License-Identifier: EPL-2.0                                                *
*                                                                                 *
* Copyright Contributors to the Zowe Project.                                     *
*                                                                                 *
*/

import { ISetupEnvironmentParms } from "./doc/parms/ISetupEnvironmentParms";
import { ImperativeError, ImperativeExpect, IO, Logger, TextUtils } from "@zowe/imperative";
import * as nodePath from "path";
import { mkdirpSync } from "fs-extra";
import { ITestEnvironment } from "./doc/response/ITestEnvironment";
import * as fs from "fs";
import { TempTestProfiles } from "./TempTestProfiles";
import { TemporaryScripts } from "./TemporaryScripts";
import { runCliScript } from "../TestUtils";
import { ITestPropertiesSchema } from "./doc/ITestPropertiesSchema";
import { TEST_RESULT_DATA_DIR } from "../TestConstants";

const uuidv4 = require("uuid");
const yaml = require("js-yaml");

/**
 * Use the utility methods here to setup the test environment for running APIs
 * and CLIs. Imperative will always touch the filesystem in some capacity
 * and these utilties help contanerize the tests.
 * @export
 */
export class TestEnvironment {
    public static readonly ERROR_TAG: string = "Setup Test Environment Error:";
    public static readonly HOME_ENV_KEY = "ZOWE_CLI_HOME";

    /**
     * Integration tests (tests that will perform an Imperative init, use the filesystem, etc) should invoke this method
     * as part of the Jest describes "beforeAll()" method. This method creates a unique test environment to enable
     * parallel execution of tests and to provide an isolated working directory for any filesystem manipulation that
     * needs to occur.
     * @param  params - See the interface for parameter details.
     */
    public static async setUp(params: ISetupEnvironmentParms): Promise<ITestEnvironment> {
        // Validate the input parameters
        ImperativeExpect.toNotBeNullOrUndefined(params,
            `${TestEnvironment.ERROR_TAG} createTestEnv(): No parameters supplied.`);
        ImperativeExpect.keysToBeDefinedAndNonBlank(params, ["testName"],
            `${TestEnvironment.ERROR_TAG} createTestEnv(): You must supply the name of the test. ` +
            `Used to append to the data directory for ease of identification.`);

        // Get a unique test data area
        const testDirectory: string = TestEnvironment.createUniqueTestDataDir(params.testName);

        const systemProps = TestEnvironment.loadSystemTestProperties(undefined, testDirectory);

        // set the env variables to be used for executing
        // scripts in the test environment
        const env: { [key: string]: string } = {};
        env[this.HOME_ENV_KEY] = testDirectory;

        const result: ITestEnvironment = {
            workingDir: testDirectory,
            systemTestProperties: systemProps,
            env
        };

        if (params.installPlugin) {
            await this.installPlugin(result);
            result.pluginInstalled = true;
        }

        // the result of the test environment setup so far is used to create profiles
        result.tempProfiles = await TempTestProfiles.createProfiles(result, params.tempProfileTypes);


        // Return the test environment including working directory that the tests should be using
        return result;
    }

    /**
     * Clean up your test environment.
     * Deletes any temporary profiles that have been created
     * @params {ITestEnvironment} testEnvironment - the test environment returned by createTestEnv
     *
     * @returns promise fulfilled when cleanup is complete
     * @throws {ImperativeError} profiles fail to delete
     */
    public static async cleanUp(testEnvironment: ITestEnvironment) {
        if (testEnvironment.tempProfiles != null) {
            await TempTestProfiles.deleteProfiles(testEnvironment);
        }
        if (testEnvironment.pluginInstalled) {
            const pluginDir = testEnvironment.workingDir + "/plugins";
            require("rimraf").sync(pluginDir);
        }
    }

    /**
     * Creates a unique test data directory for a test to work with in isolation.
     * @param testName - Adds the test name to the directory name for ease of identification.
     * @returns  - The unique directory (within the results/data/ area).
     */
    public static createUniqueTestDataDir(testName: string): string {
        const app = uuidv4() + "_" + testName + "/";
        const path = nodePath.resolve(TEST_RESULT_DATA_DIR + "/" + app);
        mkdirpSync(path);
        return path;
    }

    private static readonly DEFAULT_PROPERTIES = "custom_properties.yaml";
    private static readonly DEFAULT_PROPERTIES_LOCATION = nodePath.resolve(__dirname + "/../../__resources__/properties/") + "/";

    /**
     *  Load the properties file specified with system test configuration information.
     *  @param filePath - Specify the filePath of the properties file. Leave empty to use the properties
     *   file specified in the process.env (see gulp tasks for more information).
     *  @returns  The parsed test properties.
     */
    private static loadSystemTestProperties(filePath: string = null,
                                            workingDir: string = process.cwd()): ITestPropertiesSchema {
        const logger: Logger = this.getMockFileLogger(workingDir);
        // For now, I'm leaving the option for env specified properties in code. This will not be documented.
        const propfilename: string = process.env.propfile || TestEnvironment.DEFAULT_PROPERTIES;
        const propfiledir: string = process.env.propdirectory || TestEnvironment.DEFAULT_PROPERTIES_LOCATION;
        const propfile: string = propfiledir + propfilename;
        /**
         * Extract the properties file location from the mocha cli args
         */
        let properties: ITestPropertiesSchema;

        /**
         * Parse the yaml file
         */
        try {
            logger.info("Reading yaml configuration file: " + propfile + "...");
            properties = yaml.safeLoad(fs.readFileSync(propfile, "utf8"));
            logger.info("Properties file read.");
            // injectCliProps(properties);
            // console.log(properties);
        } catch (error) {
            logger.error("Error reading test properties yaml configuration file. Tests cannot continue. " +
                "Additional details:" + error);
            throw new Error(error);
        }
        logger.info("Loaded configuration properties file.");

        return properties;
    }

    /**
     * Installs the plug-in into the working directory created for the test environment,
     * so that commands exposed through this plug-in can be issued in tests.
     * @param {ITestEnvironment} testEnvironment the test environment so far
     * @returns {Promise<void>} - promise that resolves on completion of the install
     */
    private static async installPlugin(testEnvironment: ITestEnvironment) {
        let installScript: string = TemporaryScripts.SHEBANG;
        installScript += "bright plugins install ../../../../\n"; // install plugin from root of project
        installScript += "bright plugins validate @zowe/cics";
        installScript += "zowe cics --help\n"; // check that the plugin help is available
        const scriptPath = testEnvironment.workingDir + "/install_plugin.sh";
        IO.writeFile(scriptPath, Buffer.from(installScript));

        const output = runCliScript(scriptPath, testEnvironment, []);
        if (output.status !== 0) {
            throw new ImperativeError({
                msg: "Install of 'cics' plugin failed! You should delete the script: \n'" + scriptPath + "' " +
                "after reviewing it to check for possible errors.\n Output of the plugin install command:\n" + output.stderr.toString() +
                output.stdout.toString() +
                TempTestProfiles.GLOBAL_INSTALL_NOTE
            });
        }
        IO.deleteFile(scriptPath);
    }

    /**
     * Get a mocked version of the logger interface for logging test environment debug info
     * @param {string} workingDir - the working directory to log to
     * @returns {Logger} - a logger that can be used for test environment clean up and set up
     */
    private static getMockFileLogger(workingDir: string): Logger {
        const logFile = workingDir += "/TestEnvironment.log";
        const logFn = (tag: string, message: string, ...args: any[]) => {
            message = TextUtils.formatMessage(message, ...args);
            fs.appendFileSync(logFile, tag + " " + message + "\n");
        };
        return {
            mJsLogger: undefined,
            getCallerFileAndLineTag: undefined,
            level: undefined,
            logService: undefined,
            simple: (message: string, ...args: any[]) => {
                logFn("[SIMPLE]", message, ...args);
            },
            trace: (message: string, ...args: any[]) => {
                logFn("[TRACE]", message, ...args);
            },
            debug: (message: string, ...args: any[]) => {
                logFn("[DEBUG]", message, ...args);
            },
            info: (message: string, ...args: any[]) => {
                logFn("[INFO]", message, ...args);
            },
            warn: (message: string, ...args: any[]) => {
                logFn("[WARN]", message, ...args);
            },
            error: (message: string, ...args: any[]) => {
                logFn("[ERROR]", message, ...args);
            },
            fatal: (message: string, ...args: any[]) => {
                logFn("[FATAL]", message, ...args);
            },
            logError: (error: ImperativeError) => {
                logFn("[ERROR]", "Error:\n" + require("util").inspect(error));
            }
        } as any;

    }

}
