const test = require("node:test"),
  assert = require("node:assert/strict");
test("portal permissions never inherit from invoice design access or a consolidated branch", () => {
  const {
    authorize,
  } = require("../src/modules/config/customerPages/permissions");
  assert.throws(
    () =>
      authorize({
        companyId: "A",
        actorId: "U",
        permissions: ["document_templates.manage"],
        isConsolidated: true,
      }),
    (e) => e.status === 403,
  );
  assert.doesNotThrow(() =>
    authorize({
      companyId: "A",
      actorId: "U",
      permissions: ["customer_pages.publish"],
    }),
  );
  assert.throws(
    () =>
      authorize(
        {
          companyId: "A",
          actorId: "U",
          permissions: ["customer_pages.manage"],
        },
        "publish",
      ),
    (e) => e.status === 403,
  );
});
