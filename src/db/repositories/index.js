'use strict';

const { createAnalysesRepo } = require('./analyses');
const { createCodeFindingsRepo } = require('./code-findings');
const { createCodeSessionsRepo } = require('./code-sessions');
const { createAiResponsesRepo } = require('./ai-responses');
const { createSettingsRepo } = require('./settings');

/** Собрать все репозитории поверх одного подключения. */
function createRepos(db) {
  return {
    analyses: createAnalysesRepo(db),
    codeFindings: createCodeFindingsRepo(db),
    codeSessions: createCodeSessionsRepo(db),
    aiResponses: createAiResponsesRepo(db),
    settings: createSettingsRepo(db),
  };
}

module.exports = { createRepos };
