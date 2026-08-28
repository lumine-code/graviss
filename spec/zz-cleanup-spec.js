const GravissView = require("../lib/graviss-view");

afterAll(async () => {
  if (lumine.packages.getActivePackage("graviss")) {
    await lumine.packages.deactivatePackage("graviss");
  }

  const closures = [];
  for (const item of lumine.workspace.getPaneItems()) {
    if (!(item instanceof GravissView)) continue;
    const pane = lumine.workspace.paneForItem(item);
    if (pane) closures.push(pane.destroyItem(item, true));
    else item.destroy();
  }
  await Promise.all(closures);
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(lumine.packages.getActivePackage("graviss")).toBeUndefined();
  expect(lumine.workspace.getPaneItems().some((item) => item instanceof GravissView)).toBe(false);
});
