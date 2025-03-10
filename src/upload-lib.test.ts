import * as fs from "fs";
import * as path from "path";

import test from "ava";

import { getRunnerLogger, Logger } from "./logging";
import { setupTests } from "./testing-utils";
import * as uploadLib from "./upload-lib";
import { pruneInvalidResults } from "./upload-lib";
import {
  GitHubVariant,
  GitHubVersion,
  initializeEnvironment,
  Mode,
  SarifFile,
  withTmpDir,
} from "./util";

setupTests(test);

test.beforeEach(() => {
  initializeEnvironment(Mode.actions, "1.2.3");
});

test("validateSarifFileSchema - valid", (t) => {
  const inputFile = `${__dirname}/../src/testdata/valid-sarif.sarif`;
  t.notThrows(() =>
    uploadLib.validateSarifFileSchema(inputFile, getRunnerLogger(true))
  );
});

test("validateSarifFileSchema - invalid", (t) => {
  const inputFile = `${__dirname}/../src/testdata/invalid-sarif.sarif`;
  t.throws(() =>
    uploadLib.validateSarifFileSchema(inputFile, getRunnerLogger(true))
  );
});

test("validate correct payload used per version", async (t) => {
  const newVersions: GitHubVersion[] = [
    { type: GitHubVariant.DOTCOM },
    { type: GitHubVariant.GHES, version: "3.1.0" },
  ];
  const oldVersions: GitHubVersion[] = [
    { type: GitHubVariant.GHES, version: "2.22.1" },
    { type: GitHubVariant.GHES, version: "3.0.0" },
  ];
  const allVersions = newVersions.concat(oldVersions);

  process.env["GITHUB_EVENT_NAME"] = "push";
  for (const version of allVersions) {
    const payload: any = uploadLib.buildPayload(
      "commit",
      "refs/heads/master",
      "key",
      undefined,
      "",
      undefined,
      "/opt/src",
      undefined,
      ["CodeQL", "eslint"],
      version,
      "mergeBaseCommit"
    );
    // Not triggered by a pull request
    t.falsy(payload.base_ref);
    t.falsy(payload.base_sha);
  }

  process.env["GITHUB_EVENT_NAME"] = "pull_request";
  process.env["GITHUB_SHA"] = "commit";
  process.env["GITHUB_BASE_REF"] = "master";
  process.env[
    "GITHUB_EVENT_PATH"
  ] = `${__dirname}/../src/testdata/pull_request.json`;
  for (const version of newVersions) {
    const payload: any = uploadLib.buildPayload(
      "commit",
      "refs/pull/123/merge",
      "key",
      undefined,
      "",
      undefined,
      "/opt/src",
      undefined,
      ["CodeQL", "eslint"],
      version,
      "mergeBaseCommit"
    );
    // Uploads for a merge commit use the merge base
    t.deepEqual(payload.base_ref, "refs/heads/master");
    t.deepEqual(payload.base_sha, "mergeBaseCommit");
  }

  for (const version of newVersions) {
    const payload: any = uploadLib.buildPayload(
      "headCommit",
      "refs/pull/123/head",
      "key",
      undefined,
      "",
      undefined,
      "/opt/src",
      undefined,
      ["CodeQL", "eslint"],
      version,
      "mergeBaseCommit"
    );
    // Uploads for the head use the PR base
    t.deepEqual(payload.base_ref, "refs/heads/master");
    t.deepEqual(payload.base_sha, "f95f852bd8fca8fcc58a9a2d6c842781e32a215e");
  }

  for (const version of oldVersions) {
    const payload: any = uploadLib.buildPayload(
      "commit",
      "refs/pull/123/merge",
      "key",
      undefined,
      "",
      undefined,
      "/opt/src",
      undefined,
      ["CodeQL", "eslint"],
      version,
      "mergeBaseCommit"
    );
    // These older versions won't expect these values
    t.falsy(payload.base_ref);
    t.falsy(payload.base_sha);
  }
});

test("finding SARIF files", async (t) => {
  await withTmpDir(async (tmpDir) => {
    // include a couple of sarif files
    fs.writeFileSync(path.join(tmpDir, "a.sarif"), "");
    fs.writeFileSync(path.join(tmpDir, "b.sarif"), "");

    // other random files shouldn't be returned
    fs.writeFileSync(path.join(tmpDir, "c.foo"), "");

    // we should recursively look in subdirectories
    fs.mkdirSync(path.join(tmpDir, "dir1"));
    fs.writeFileSync(path.join(tmpDir, "dir1", "d.sarif"), "");
    fs.mkdirSync(path.join(tmpDir, "dir1", "dir2"));
    fs.writeFileSync(path.join(tmpDir, "dir1", "dir2", "e.sarif"), "");

    // we should ignore symlinks
    fs.mkdirSync(path.join(tmpDir, "dir3"));
    fs.symlinkSync(tmpDir, path.join(tmpDir, "dir3", "symlink1"), "dir");
    fs.symlinkSync(
      path.join(tmpDir, "a.sarif"),
      path.join(tmpDir, "dir3", "symlink2.sarif"),
      "file"
    );

    const sarifFiles = uploadLib.findSarifFilesInDir(tmpDir);

    t.deepEqual(sarifFiles, [
      path.join(tmpDir, "a.sarif"),
      path.join(tmpDir, "b.sarif"),
      path.join(tmpDir, "dir1", "d.sarif"),
      path.join(tmpDir, "dir1", "dir2", "e.sarif"),
    ]);
  });
});

test("populateRunAutomationDetails", (t) => {
  let sarif = {
    runs: [{}],
  };
  const analysisKey = ".github/workflows/codeql-analysis.yml:analyze";

  let expectedSarif = {
    runs: [{ automationDetails: { id: "language:javascript/os:linux/" } }],
  };

  // Category has priority over analysis_key/environment
  let modifiedSarif = uploadLib.populateRunAutomationDetails(
    sarif,
    "language:javascript/os:linux",
    analysisKey,
    '{"language": "other", "os": "other"}'
  );
  t.deepEqual(modifiedSarif, expectedSarif);

  // It doesn't matter if the category has a slash at the end or not
  modifiedSarif = uploadLib.populateRunAutomationDetails(
    sarif,
    "language:javascript/os:linux/",
    analysisKey,
    ""
  );
  t.deepEqual(modifiedSarif, expectedSarif);

  // check that the automation details doesn't get overwritten
  sarif = { runs: [{ automationDetails: { id: "my_id" } }] };
  expectedSarif = { runs: [{ automationDetails: { id: "my_id" } }] };
  modifiedSarif = uploadLib.populateRunAutomationDetails(
    sarif,
    undefined,
    analysisKey,
    '{"os": "linux", "language": "javascript"}'
  );
  t.deepEqual(modifiedSarif, expectedSarif);

  // check multiple runs
  sarif = { runs: [{ automationDetails: { id: "my_id" } }, {}] };
  expectedSarif = {
    runs: [
      { automationDetails: { id: "my_id" } },
      {
        automationDetails: {
          id: ".github/workflows/codeql-analysis.yml:analyze/language:javascript/os:linux/",
        },
      },
    ],
  };
  modifiedSarif = uploadLib.populateRunAutomationDetails(
    sarif,
    undefined,
    analysisKey,
    '{"os": "linux", "language": "javascript"}'
  );
  t.deepEqual(modifiedSarif, expectedSarif);
});

test("validateUniqueCategory when empty", (t) => {
  t.notThrows(() => uploadLib.validateUniqueCategory(createMockSarif()));
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif()));
});

test("validateUniqueCategory for automation details id", (t) => {
  t.notThrows(() => uploadLib.validateUniqueCategory(createMockSarif("abc")));
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif("abc")));
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif("AbC")));

  t.notThrows(() => uploadLib.validateUniqueCategory(createMockSarif("def")));
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif("def")));

  // Our category sanitization is not perfect. Here are some examples
  // of where we see false clashes
  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif("abc/def"))
  );
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif("abc@def")));
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif("abc_def")));
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif("abc def")));

  // this one is fine
  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif("abc_ def"))
  );
});

test("validateUniqueCategory for tool name", (t) => {
  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "abc"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "abc"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "AbC"))
  );

  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "def"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "def"))
  );

  // Our category sanitization is not perfect. Here are some examples
  // of where we see false clashes
  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "abc/def"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "abc@def"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "abc_def"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif(undefined, "abc def"))
  );

  // this one is fine
  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif("abc_ def"))
  );
});

test("validateUniqueCategory for automation details id and tool name", (t) => {
  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif("abc", "abc"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif("abc", "abc"))
  );

  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif("abc_", "def"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif("abc_", "def"))
  );

  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif("ghi", "_jkl"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif("ghi", "_jkl"))
  );

  // Our category sanitization is not perfect. Here are some examples
  // of where we see false clashes
  t.notThrows(() => uploadLib.validateUniqueCategory(createMockSarif("abc")));
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif("abc", "_")));

  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif("abc", "def__"))
  );
  t.throws(() => uploadLib.validateUniqueCategory(createMockSarif("abc_def")));

  t.notThrows(() =>
    uploadLib.validateUniqueCategory(createMockSarif("mno_", "pqr"))
  );
  t.throws(() =>
    uploadLib.validateUniqueCategory(createMockSarif("mno", "_pqr"))
  );
});

test("validateUniqueCategory for multiple runs", (t) => {
  const sarif1 = createMockSarif("abc", "def");
  const sarif2 = createMockSarif("ghi", "jkl");

  // duplicate categories are allowed within the same sarif file
  const multiSarif = { runs: [sarif1.runs[0], sarif1.runs[0], sarif2.runs[0]] };
  t.notThrows(() => uploadLib.validateUniqueCategory(multiSarif));

  // should throw if there are duplicate categories in separate validations
  t.throws(() => uploadLib.validateUniqueCategory(sarif1));
  t.throws(() => uploadLib.validateUniqueCategory(sarif2));
});

test("pruneInvalidResults", (t) => {
  const loggedMessages: string[] = [];
  const mockLogger = {
    info: (message: string) => {
      loggedMessages.push(message);
    },
  } as Logger;

  const sarif: SarifFile = {
    runs: [
      {
        tool: otherTool,
        results: [resultWithBadMessage1, resultWithGoodMessage],
      },
      {
        tool: affectedCodeQLVersion,
        results: [
          resultWithOtherRuleId,
          resultWithBadMessage1,
          resultWithBadMessage2,
          resultWithGoodMessage,
        ],
      },
      {
        tool: unaffectedCodeQLVersion,
        results: [resultWithBadMessage1, resultWithGoodMessage],
      },
    ],
  };
  const result = pruneInvalidResults(sarif, mockLogger);

  const expected: SarifFile = {
    runs: [
      {
        tool: otherTool,
        results: [resultWithBadMessage1, resultWithGoodMessage],
      },
      {
        tool: affectedCodeQLVersion,
        results: [resultWithOtherRuleId, resultWithGoodMessage],
      },
      {
        tool: unaffectedCodeQLVersion,
        results: [resultWithBadMessage1, resultWithGoodMessage],
      },
    ],
  };

  t.deepEqual(result, expected);
  t.deepEqual(loggedMessages.length, 1);
  t.assert(loggedMessages[0].includes("Pruned 2 results"));
});

const affectedCodeQLVersion = {
  driver: {
    name: "CodeQL",
    semanticVersion: "2.11.2",
  },
};

const unaffectedCodeQLVersion = {
  driver: {
    name: "CodeQL",
    semanticVersion: "2.11.3",
  },
};

const otherTool = {
  driver: {
    name: "Some other tool",
    semanticVersion: "2.11.2",
  },
};

const resultWithOtherRuleId = {
  ruleId: "doNotPrune",
  message: {
    text: "should not be pruned even though it says MD5 in it",
  },
  locations: [],
  partialFingerprints: {},
};

const resultWithGoodMessage = {
  ruleId: "rb/weak-cryptographic-algorithm",
  message: {
    text: "should not be pruned SHA128 is not a FP",
  },
  locations: [],
  partialFingerprints: {},
};

const resultWithBadMessage1 = {
  ruleId: "rb/weak-cryptographic-algorithm",
  message: {
    text: "should be pruned MD5 is a FP",
  },
  locations: [],
  partialFingerprints: {},
};

const resultWithBadMessage2 = {
  ruleId: "rb/weak-cryptographic-algorithm",
  message: {
    text: "should be pruned SHA1 is a FP",
  },
  locations: [],
  partialFingerprints: {},
};

function createMockSarif(id?: string, tool?: string) {
  return {
    runs: [
      {
        automationDetails: {
          id,
        },
        tool: {
          driver: {
            name: tool,
          },
        },
      },
    ],
  };
}
