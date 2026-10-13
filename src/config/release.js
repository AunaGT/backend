const { version } = require('../../package.json')

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getReleaseInfo(env = process.env) {
  const commit = clean(
    env.VERCEL_GIT_COMMIT_SHA || env.GIT_COMMIT_SHA || env.COMMIT_SHA
  )

  return {
    version: clean(env.APP_VERSION) || version,
    commit: commit ? commit.slice(0, 12) : null,
    branch: clean(env.VERCEL_GIT_COMMIT_REF || env.GIT_BRANCH),
  }
}

module.exports = { getReleaseInfo }
