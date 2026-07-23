const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const classes = path.join(root, "java-helper", "build", "classes");
const testClasses = path.join(root, "java-helper", "build", "test-classes");
const mainSources = ["JdbcDialect.java", "JdbcHelper.java"].map((file) =>
  path.join(root, "java-helper", "src", "main", "java", "com", "example", "dbviewer", file)
);
const testSource = path.join(root, "java-helper", "src", "test", "java", "com", "example", "dbviewer", "JdbcHelperSqlServerTest.java");
const driverJar = process.env.MSSQL_JDBC_JAR
  ?? path.join(root, ".drivers", "mssql-jdbc-13.4.0.jre11.jar");

if (!fs.existsSync(driverJar)) {
  console.error(`Microsoft JDBC Driver does not exist: ${driverJar}`);
  console.error("Set MSSQL_JDBC_JAR to the mssql-jdbc jre11 JAR path.");
  process.exit(1);
}

fs.mkdirSync(classes, { recursive: true });
fs.mkdirSync(testClasses, { recursive: true });

let managedContainer;
try {
  run("javac", ["--release", "17", "-d", classes, ...mainSources]);
  run("javac", [
    "--release", "17",
    "-cp", [classes, driverJar].join(path.delimiter),
    "-d", testClasses,
    testSource
  ]);

  const testEnvironment = process.env.MSSQL_JDBC_URL
    ? externalTestEnvironment()
    : startManagedSqlServer();
  managedContainer = testEnvironment.containerName;

  run("java", [
    "-cp", [testClasses, classes, driverJar].join(path.delimiter),
    "com.example.dbviewer.JdbcHelperSqlServerTest"
  ], { env: { ...process.env, ...testEnvironment.environment } });
} catch (error) {
  if (managedContainer) {
    runBestEffort("docker", ["logs", "--tail", "200", managedContainer]);
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (managedContainer) {
    runBestEffort("docker", ["rm", "-f", managedContainer]);
  }
}

function externalTestEnvironment() {
  if (!process.env.MSSQL_PASSWORD) {
    throw new Error("MSSQL_PASSWORD is required when MSSQL_JDBC_URL is set.");
  }
  return {
    environment: {
      MSSQL_JDBC_URL: process.env.MSSQL_JDBC_URL,
      MSSQL_ADMIN_JDBC_URL: process.env.MSSQL_ADMIN_JDBC_URL ?? process.env.MSSQL_JDBC_URL,
      MSSQL_USERNAME: process.env.MSSQL_USERNAME ?? "sa",
      MSSQL_PASSWORD: process.env.MSSQL_PASSWORD,
      MSSQL_CREATE_DATABASE: process.env.MSSQL_CREATE_DATABASE ?? "false",
      MSSQL_TEST_SCHEMA: process.env.MSSQL_TEST_SCHEMA ?? `dbviewer_it_${process.pid}`
    }
  };
}

function startManagedSqlServer() {
  const containerName = `vsc-dbviewer-sqlserver-test-${process.pid}`;
  const password = process.env.MSSQL_PASSWORD ?? "DbViewer!Integration2026";
  const image = process.env.MSSQL_DOCKER_IMAGE ?? "mcr.microsoft.com/mssql/server:2022-latest";

  run("docker", [
    "run", "-d",
    "--name", containerName,
    "-e", "ACCEPT_EULA=Y",
    "-e", `MSSQL_SA_PASSWORD=${password}`,
    "-e", "MSSQL_PID=Developer",
    "-p", "127.0.0.1::1433",
    image
  ]);
  managedContainer = containerName;

  const portOutput = run("docker", ["port", containerName, "1433/tcp"], { capture: true }).stdout.trim();
  const port = portOutput.match(/:(\d+)$/)?.[1];
  if (!port) {
    throw new Error(`Could not determine SQL Server host port from: ${portOutput}`);
  }
  const common = `jdbc:sqlserver://127.0.0.1:${port};encrypt=true;trustServerCertificate=true;loginTimeout=5`;
  return {
    containerName,
    environment: {
      MSSQL_ADMIN_JDBC_URL: `${common};databaseName=master`,
      MSSQL_JDBC_URL: `${common};databaseName=DbViewerTest`,
      MSSQL_USERNAME: "sa",
      MSSQL_PASSWORD: password,
      MSSQL_CREATE_DATABASE: "true",
      MSSQL_TEST_SCHEMA: `dbviewer_it_${process.pid}`
    }
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.capture ? "utf8" : undefined,
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} exited with code ${result.status}.${detail ? ` ${detail}` : ""}`);
  }
  return result;
}

function runBestEffort(command, args) {
  spawnSync(command, args, { cwd: root, stdio: "inherit" });
}
