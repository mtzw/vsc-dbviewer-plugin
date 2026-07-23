const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mainSources = ["JdbcDialect.java", "JdbcHelper.java"].map((file) =>
  path.join(root, "java-helper", "src", "main", "java", "com", "example", "dbviewer", file)
);
const dialectTestSource = path.join(root, "java-helper", "src", "test", "java", "com", "example", "dbviewer", "JdbcDialectTest.java");
const h2TestSource = path.join(root, "java-helper", "src", "test", "java", "com", "example", "dbviewer", "JdbcHelperH2Test.java");
const classes = path.join(root, "java-helper", "build", "classes");
const testClasses = path.join(root, "java-helper", "build", "test-classes");

fs.mkdirSync(classes, { recursive: true });
fs.mkdirSync(testClasses, { recursive: true });

run("javac", ["--release", "17", "-d", classes, ...mainSources]);
run("javac", ["--release", "17", "-cp", classes, "-d", testClasses, dialectTestSource]);
run("java", ["-cp", [testClasses, classes].join(path.delimiter), "com.example.dbviewer.JdbcDialectTest"]);

const h2Jar = process.env.H2_JAR;
if (!h2Jar) {
  console.log("H2_JAR is not set; skipping Java helper H2 integration test.");
  process.exit(0);
}
if (!fs.existsSync(h2Jar)) {
  console.error(`H2_JAR does not exist: ${h2Jar}`);
  process.exit(1);
}

run("javac", ["--release", "17", "-cp", [classes, h2Jar].join(path.delimiter), "-d", testClasses, h2TestSource]);
run("java", ["-cp", [testClasses, classes, h2Jar].join(path.delimiter), "com.example.dbviewer.JdbcHelperH2Test"]);

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
