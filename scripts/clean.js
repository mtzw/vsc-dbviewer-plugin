const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

for (const target of [
  path.join(root, "out"),
  path.join(root, "java-helper", "build", "classes"),
  path.join(root, "java-helper", "build", "test-classes")
]) {
  fs.rmSync(target, { force: true, recursive: true });
}
