import * as fs from "fs";
import * as path from "path";

import { Command } from "commander";
import del from "del";

import { runFinalize, runQueries } from "./analyze";
import { determineAutobuildLanguages, runAutobuild } from "./autobuild";
import { CodeQL, CODEQL_VERSION_NEW_TRACING, getCodeQL } from "./codeql";
import { Config, getConfig } from "./config-utils";
import { initCodeQL, initConfig, injectWindowsTracer, runInit } from "./init";
import { Language, parseLanguage } from "./languages";
import { getRunnerLogger } from "./logging";
import { parseRepositoryNwo } from "./repository";
import { createFeatures } from "./testing-utils";
import * as upload_lib from "./upload-lib";
import {
  checkGitHubVersionInRange,
  getAddSnippetsFlag,
  getGitHubVersion,
  getMemoryFlag,
  getThreadsFlag,
  parseGitHubUrl,
  getGitHubAuth,
  initializeEnvironment,
  Mode,
  codeQlVersionAbove,
  enrichEnvironment,
  getMemoryFlagValue,
  getThreadsFlagValue,
} from "./util";

// eslint-disable-next-line import/no-commonjs
const pkg = require("../package.json");

const program = new Command();
program.version(pkg.version).hook("preAction", () => {
  initializeEnvironment(Mode.runner, pkg.version);
});

function getTempDir(userInput: string | undefined): string {
  const tempDir = path.join(userInput || process.cwd(), "codeql-runner");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

const codeqlEnvJsonFilename = "codeql-env.json";

function loadTracerEnvironment(config: Config): { [name: string]: string } {
  const jsonEnvFile = path.join(config.tempDir, codeqlEnvJsonFilename);
  return JSON.parse(fs.readFileSync(jsonEnvFile).toString("utf-8"));
}

// Imports the environment from codeqlEnvJsonFilename if not already present
function importTracerEnvironment(config: Config) {
  if (!("ODASA_TRACER_CONFIGURATION" in process.env)) {
    const env = loadTracerEnvironment(config);
    for (const key of Object.keys(env)) {
      process.env[key] = env[key];
    }
  }
}

// Allow the user to specify refs in full refs/heads/branch format
// or just the short branch name and prepend "refs/heads/" to it.
function parseRef(userInput: string): string {
  if (userInput.startsWith("refs/")) {
    return userInput;
  } else {
    return `refs/heads/${userInput}`;
  }
}

// Parses the --trace-process-name arg from process.argv, or returns undefined
function parseTraceProcessName(): string | undefined {
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === "--trace-process-name") {
      return process.argv[i + 1];
    }
  }
  return undefined;
}

// Parses the --trace-process-level arg from process.argv, or returns undefined
function parseTraceProcessLevel(): number | undefined {
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === "--trace-process-level") {
      const v = parseInt(process.argv[i + 1], 10);
      return isNaN(v) ? undefined : v;
    }
  }
  return undefined;
}

interface InitArgs {
  languages: string | undefined;
  queries: string | undefined;
  packs: string | undefined;
  configFile: string | undefined;
  codeqlPath: string | undefined;
  tempDir: string | undefined;
  toolsDir: string | undefined;
  checkoutPath: string | undefined;
  repository: string;
  githubUrl: string;
  githubAuth: string;
  githubAuthStdin: boolean;
  debug: boolean;
  ram: string | undefined;
  threads: string | undefined;
}

program
  .command("init")
  .description("Initializes CodeQL")
  .requiredOption("--repository <repository>", "Repository name. (Required)")
  .requiredOption("--github-url <url>", "URL of GitHub instance. (Required)")
  .option(
    "--github-auth <auth>",
    "GitHub Apps token or personal access token. This option is insecure and deprecated, please use `--github-auth-stdin` instead."
  )
  .option(
    "--github-auth-stdin",
    "Read GitHub Apps token or personal access token from stdin."
  )
  .option(
    "--languages <languages>",
    "Comma-separated list of languages to analyze. Otherwise detects and analyzes all supported languages from the repo."
  )
  .option(
    "--queries <queries>",
    "Comma-separated list of additional queries to run. This overrides the same setting in a configuration file."
  )
  .option(
    "--packs <packs>",
    `[Experimental] Comma-separated list of packs to run. Reference a pack in the format scope/name[@version]. If version is not
    specified, then the latest version of the pack is used. By default, this overrides the same setting in a
    configuration file; prefix with "+" to use both sets of packs.

    This option is only available in single-language analyses. To use packs in multi-language
    analyses, you must specify packs in the codeql-config.yml file.`
  )
  .option("--config-file <file>", "Path to config file.")
  .option(
    "--codeql-path <path>",
    "Path to a copy of the CodeQL CLI executable to use. Otherwise downloads a copy."
  )
  .option(
    "--temp-dir <dir>",
    'Directory to use for temporary files. Default is "./codeql-runner".'
  )
  .option(
    "--tools-dir <dir>",
    "Directory to use for CodeQL tools and other files to store between runs. Default is a subdirectory of the home directory."
  )
  .option(
    "--checkout-path <path>",
    "Checkout path. Default is the current working directory."
  )
  .option("--debug", "Print more verbose output", false)
  .option(
    "--trace-process-name <string>",
    "(Advanced, windows-only) Inject a windows tracer of this process into a process with the given process name."
  )
  .option(
    "--trace-process-level <number>",
    "(Advanced, windows-only) Inject a windows tracer of this process into a parent process <number> levels up."
  )
  .option(
    "--ram <number>",
    "The amount of memory in MB that can be used by CodeQL extractors. " +
      "By default, CodeQL extractors will use most of the memory available in the system. " +
      'This input also sets the amount of memory that can later be used by the "analyze" command.'
  )
  .option(
    "--threads <number>",
    "The number of threads that can be used by CodeQL extractors. " +
      "By default, CodeQL extractors will use all the hardware threads available in the system. " +
      'This input also sets the number of threads that can later be used by the "analyze" command.'
  )
  .action(async (cmd: InitArgs) => {
    const logger = getRunnerLogger(cmd.debug);

    try {
      const tempDir = getTempDir(cmd.tempDir);
      const checkoutPath = cmd.checkoutPath || process.cwd();

      // Wipe the temp dir
      logger.info(`Cleaning temp directory ${tempDir}`);
      await del(tempDir, { force: true });
      fs.mkdirSync(tempDir, { recursive: true });

      const auth = await getGitHubAuth(
        logger,
        cmd.githubAuth,
        cmd.githubAuthStdin
      );

      const apiDetails = {
        auth,
        externalRepoAuth: auth,
        url: parseGitHubUrl(cmd.githubUrl),
        apiURL: undefined,
      };

      const gitHubVersion = await getGitHubVersion(apiDetails);
      checkGitHubVersionInRange(gitHubVersion, logger, Mode.runner);

      // Limit RAM and threads for extractors. When running extractors, the CodeQL CLI obeys the
      // CODEQL_RAM and CODEQL_THREADS environment variables to decide how much RAM and how many
      // threads it would ask extractors to use. See help text for the "--ram" and "--threads"
      // options at https://codeql.github.com/docs/codeql-cli/manual/database-trace-command/
      // for details.
      process.env["CODEQL_RAM"] = getMemoryFlagValue(cmd.ram).toString();
      process.env["CODEQL_THREADS"] = getThreadsFlagValue(
        cmd.threads,
        logger
      ).toString();

      let codeql: CodeQL;
      if (cmd.codeqlPath !== undefined) {
        codeql = await getCodeQL(cmd.codeqlPath);
      } else {
        codeql = (
          await initCodeQL(
            undefined,
            apiDetails,
            tempDir,
            gitHubVersion.type,
            createFeatures([]),
            logger
          )
        ).codeql;
      }
      await enrichEnvironment(Mode.runner, codeql);
      const workspacePath = checkoutPath;
      const config = await initConfig(
        cmd.languages,
        cmd.queries,
        cmd.packs,
        undefined, // we won't support registries in the runner
        cmd.configFile,
        undefined,
        false,
        false,
        "",
        "",
        parseRepositoryNwo(cmd.repository),
        tempDir,
        codeql,
        workspacePath,
        gitHubVersion,
        apiDetails,
        createFeatures([]),
        logger
      );

      const sourceRoot = checkoutPath;
      const tracerConfig = await runInit(
        codeql,
        config,
        sourceRoot,
        parseTraceProcessName(),
        parseTraceProcessLevel(),
        createFeatures([]),
        logger
      );
      if (tracerConfig === undefined) {
        return;
      }

      if (
        process.platform === "win32" &&
        !(await codeQlVersionAbove(codeql, CODEQL_VERSION_NEW_TRACING))
      ) {
        await injectWindowsTracer(
          parseTraceProcessName(),
          parseTraceProcessLevel(),
          config,
          codeql,
          tracerConfig
        );
      }

      // Always output a json file of the env that can be consumed programmatically
      const jsonEnvFile = path.join(config.tempDir, codeqlEnvJsonFilename);
      fs.writeFileSync(jsonEnvFile, JSON.stringify(tracerConfig.env));

      if (process.platform === "win32") {
        const batEnvFile = path.join(config.tempDir, "codeql-env.bat");
        const batEnvFileContents = Object.entries(tracerConfig.env)
          .map(([key, value]) => `Set ${key}=${value}`)
          .join("\n");
        fs.writeFileSync(batEnvFile, batEnvFileContents);

        const powershellEnvFile = path.join(config.tempDir, "codeql-env.sh");
        const powershellEnvFileContents = Object.entries(tracerConfig.env)
          .map(([key, value]) => `$env:${key}="${value}"`)
          .join("\n");
        fs.writeFileSync(powershellEnvFile, powershellEnvFileContents);

        logger.info(
          `\nCodeQL environment output to "${jsonEnvFile}", "${batEnvFile}" and "${powershellEnvFile}". ` +
            `Please export these variables to future processes so that CodeQL can monitor the build. ` +
            `If using cmd/batch run "call ${batEnvFile}" ` +
            `or if using PowerShell run "cat ${powershellEnvFile} | Invoke-Expression".`
        );
      } else {
        // Assume that anything that's not windows is using a unix-style shell
        const shEnvFile = path.join(config.tempDir, "codeql-env.sh");
        const shEnvFileContents = Object.entries(tracerConfig.env)
          // Some vars contain ${LIB} that we do not want to be expanded when executing this script
          .map(
            ([key, value]) =>
              `export ${key}='${value.replace(/'/g, "'\"'\"'")}'`
          )
          .join("\n");
        fs.writeFileSync(shEnvFile, shEnvFileContents);

        logger.info(
          `\nCodeQL environment output to "${jsonEnvFile}" and "${shEnvFile}". ` +
            `Please export these variables to future processes so that CodeQL can monitor the build, ` +
            `for example by running ". ${shEnvFile}".`
        );
      }
    } catch (e) {
      logger.error("Init failed");
      logger.error(e instanceof Error ? e : new Error(String(e)));
      process.exitCode = 1;
    }
  });

interface AutobuildArgs {
  language: string;
  tempDir: string | undefined;
  debug: boolean;
}

program
  .command("autobuild")
  .description("Attempts to automatically build code")
  .option(
    "--language <language>",
    "The language to build. Otherwise will detect the dominant compiled language."
  )
  .option(
    "--temp-dir <dir>",
    'Directory to use for temporary files. Default is "./codeql-runner".'
  )
  .option("--debug", "Print more verbose output", false)
  .action(async (cmd: AutobuildArgs) => {
    const logger = getRunnerLogger(cmd.debug);
    try {
      const config = await getConfig(getTempDir(cmd.tempDir), logger);
      if (config === undefined) {
        throw new Error(
          "Config file could not be found at expected location. " +
            "Was the 'init' command run with the same '--temp-dir' argument as this command."
        );
      }
      await enrichEnvironment(Mode.runner, await getCodeQL(config.codeQLCmd));
      importTracerEnvironment(config);
      let languages: Language[] | undefined = undefined;
      if (cmd.language !== undefined) {
        const language = parseLanguage(cmd.language);
        if (language === undefined || !config.languages.includes(language)) {
          throw new Error(
            `"${cmd.language}" is not a recognised language. ` +
              `Known languages in this project are ${config.languages.join(
                ", "
              )}.`
          );
        }
        languages = [language];
      } else {
        languages = await determineAutobuildLanguages(
          config,
          createFeatures([]),
          logger
        );
      }
      if (languages !== undefined) {
        for (const language of languages) {
          await runAutobuild(language, config, logger);
        }
      }
    } catch (e) {
      logger.error("Autobuild failed");
      logger.error(e instanceof Error ? e : new Error(String(e)));
      process.exitCode = 1;
    }
  });

interface AnalyzeArgs {
  repository: string;
  commit: string;
  ref: string;
  category: string | undefined;
  githubUrl: string;
  githubAuth: string;
  githubAuthStdin: boolean;
  checkoutPath: string | undefined;
  upload: boolean;
  outputDir: string | undefined;
  ram: string | undefined;
  addSnippets: boolean;
  threads: string | undefined;
  tempDir: string | undefined;
  debug: boolean;
}

program
  .command("analyze")
  .description("Finishes extracting code and runs CodeQL queries")
  .requiredOption("--repository <repository>", "Repository name. (Required)")
  .requiredOption(
    "--commit <commit>",
    "SHA of commit that was analyzed. (Required)"
  )
  .requiredOption("--ref <ref>", "Name of ref that was analyzed. (Required)")
  .requiredOption("--github-url <url>", "URL of GitHub instance. (Required)")
  .option(
    "--github-auth <auth>",
    "GitHub Apps token or personal access token. This option is insecure and deprecated, please use `--github-auth-stdin` instead."
  )
  .option(
    "--github-auth-stdin",
    "Read GitHub Apps token or personal access token from stdin."
  )
  .option(
    "--checkout-path <path>",
    "Checkout path. Default is the current working directory."
  )
  .option("--no-upload", "Do not upload results after analysis.")
  .option(
    "--output-dir <dir>",
    "Directory to output SARIF files to. Default is in the temp directory."
  )
  .option(
    "--ram <ram>",
    "The amount of memory in MB that can be used by CodeQL for database finalization and query execution. " +
      'By default, this command will use the same amount of memory as previously set in the "init" command. ' +
      'If the "init" command also does not have an explicit "ram" flag, this command will use most of the ' +
      "memory available in the system."
  )
  .option(
    "--no-add-snippets",
    "Specify whether to include code snippets in the sarif output."
  )
  .option(
    "--threads <threads>",
    "The number of threads that can be used by CodeQL for database finalization and query execution. " +
      'By default, this command will use the same number of threads as previously set in the "init" command. ' +
      'If the "init" command also does not have an explicit "threads" flag, this command will use all the ' +
      "hardware threads available in the system."
  )
  .option(
    "--temp-dir <dir>",
    'Directory to use for temporary files. Default is "./codeql-runner".'
  )
  .option(
    "--category <category>",
    "String used by Code Scanning for matching the analyses."
  )
  .option("--debug", "Print more verbose output", false)
  .action(async (cmd: AnalyzeArgs) => {
    const logger = getRunnerLogger(cmd.debug);
    try {
      const config = await getConfig(getTempDir(cmd.tempDir), logger);
      if (config === undefined) {
        throw new Error(
          "Config file could not be found at expected location. " +
            "Was the 'init' command run with the same '--temp-dir' argument as this command."
        );
      }
      await enrichEnvironment(Mode.runner, await getCodeQL(config.codeQLCmd));

      const auth = await getGitHubAuth(
        logger,
        cmd.githubAuth,
        cmd.githubAuthStdin
      );

      const apiDetails = {
        auth,
        url: parseGitHubUrl(cmd.githubUrl),
        apiURL: undefined,
      };

      const outputDir =
        cmd.outputDir || path.join(config.tempDir, "codeql-sarif");
      let initEnv: { [name: string]: string } = {};
      try {
        initEnv = loadTracerEnvironment(config);
      } catch (err) {
        // The init command did not generate a tracer environment file
      }
      const threads = getThreadsFlag(
        cmd.threads || initEnv["CODEQL_THREADS"],
        logger
      );
      const memory = getMemoryFlag(cmd.ram || initEnv["CODEQL_RAM"]);
      await runFinalize(
        outputDir,
        threads,
        memory,
        config,
        logger,
        createFeatures([])
      );
      await runQueries(
        outputDir,
        memory,
        getAddSnippetsFlag(cmd.addSnippets),
        threads,
        cmd.category,
        config,
        logger,
        createFeatures([])
      );

      if (!cmd.upload) {
        logger.info("Not uploading results");
        return;
      }
      const sourceRoot = cmd.checkoutPath || process.cwd();
      await upload_lib.uploadFromRunner(
        outputDir,
        parseRepositoryNwo(cmd.repository),
        cmd.commit,
        parseRef(cmd.ref),
        cmd.category,
        sourceRoot,
        config.gitHubVersion,
        apiDetails,
        logger
      );
    } catch (e) {
      logger.error("Analyze failed");
      logger.error(e instanceof Error ? e : new Error(String(e)));
      process.exitCode = 1;
    }
  });

interface UploadArgs {
  sarifFile: string;
  repository: string;
  commit: string;
  ref: string;
  category: string | undefined;
  githubUrl: string;
  githubAuthStdin: boolean;
  githubAuth: string;
  checkoutPath: string | undefined;
  debug: boolean;
}

program
  .command("upload")
  .description(
    "Uploads a SARIF file, or all SARIF files from a directory, to code scanning"
  )
  .requiredOption(
    "--sarif-file <file>",
    "SARIF file to upload, or a directory containing multiple SARIF files. (Required)"
  )
  .requiredOption("--repository <repository>", "Repository name. (Required)")
  .requiredOption(
    "--commit <commit>",
    "SHA of commit that was analyzed. (Required)"
  )
  .requiredOption("--ref <ref>", "Name of ref that was analyzed. (Required)")
  .requiredOption("--github-url <url>", "URL of GitHub instance. (Required)")
  .option(
    "--github-auth <auth>",
    "GitHub Apps token or personal access token. This option is insecure and deprecated, please use `--github-auth-stdin` instead."
  )
  .option(
    "--github-auth-stdin",
    "Read GitHub Apps token or personal access token from stdin."
  )
  .option(
    "--checkout-path <path>",
    "Checkout path. Default is the current working directory."
  )
  .option(
    "--category <category>",
    "String used by Code Scanning for matching the analyses."
  )
  .option("--debug", "Print more verbose output", false)
  .action(async (cmd: UploadArgs) => {
    const logger = getRunnerLogger(cmd.debug);
    const auth = await getGitHubAuth(
      logger,
      cmd.githubAuth,
      cmd.githubAuthStdin
    );
    const apiDetails = {
      auth,
      url: parseGitHubUrl(cmd.githubUrl),
      apiURL: undefined,
    };
    try {
      const gitHubVersion = await getGitHubVersion(apiDetails);
      const sourceRoot = cmd.checkoutPath || process.cwd();
      await upload_lib.uploadFromRunner(
        cmd.sarifFile,
        parseRepositoryNwo(cmd.repository),
        cmd.commit,
        parseRef(cmd.ref),
        cmd.category,
        sourceRoot,
        gitHubVersion,
        apiDetails,
        logger
      );
    } catch (e) {
      logger.error("Upload failed");
      logger.error(e instanceof Error ? e : new Error(String(e)));
      process.exitCode = 1;
    }
  });

program.parse(process.argv);
