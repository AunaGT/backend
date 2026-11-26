const fail = (status, code, message, fields) => Object.assign(new Error(message), { status, code, ...(fields ? { fields } : {}) })
module.exports = { fail }
